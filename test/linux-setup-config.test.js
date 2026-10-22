import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, lstatSync, chmodSync, renameSync,
  symlinkSync, unlinkSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupDefaults, cleanSetupEnvironment, setupEnvironment, environmentText, minimalConfiguration,
  parseSetupConfiguration, validateSetupConfiguration, reviewSetupChanges, patchSetupConfiguration,
  requireExternalPath, privateDirectory, snapshotPrivate, unchangedPrivate, writePrivate, saveReviewedPrivate } from '../scripts/lib/linux-setup-config.js';
import { parseEnvironment } from '../scripts/lib/linux-deployment.js';

const syntheticSecret = 'synthetic-private-token-12345678901234567890';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'st-mq-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), directory = join(root, 'private config');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 });
  const defaults = setupDefaults({ home: root, env: { XDG_CONFIG_HOME: directory }, nodePath: process.execPath, user: 'operator' });
  const secrets = join(directory, 'secrets.json'), data = join(root, 'application data');
  const connection = { ...defaults.connection, environment_file: join(directory, 'linux-runtime.env') };
  const environment = setupEnvironment({ secrets, data, topology: 'standalone' });
  return { root, source, directory, connection, secrets, data, environment, draft: join(directory, 'draft.json') };
}
function rejectionWithoutSecret(action, pattern) {
  assert.throws(action, error => (!pattern || pattern.test(error.message)) && !error.message.includes(syntheticSecret));
}

test('defaults use the actual account home and honor a private XDG config path with spaces', () => {
  const settings = setupDefaults({ home: '/home/operator', env: {}, user: 'operator', nodePath: '/usr/bin/node' });
  assert.equal(settings.secrets, '/home/operator/.config/st-mq/secrets.json');
  assert.equal(settings.connectionPath, '/home/operator/.config/st-mq/linux-deploy.json');
  assert.equal(settings.data, '/home/operator/.local/share/st-mq');
  assert.equal(settings.connection.runtime_dir, '/home/operator/.local/share/st-mq-runtime');
  assert.equal(settings.connection.service_scope, 'system'); assert.equal(settings.connection.service_user, 'operator');
  assert.equal(settings.connection.service_name, 'st-mq.service');
  const custom = setupDefaults({ home: '/srv/application account', env: { XDG_CONFIG_HOME: '/srv/private config' }, user: 'operator' });
  assert.equal(custom.secrets, '/srv/private config/st-mq/secrets.json');
  assert.equal(custom.data, '/srv/application account/.local/share/st-mq');
});
test('minimal skeletons are sparse current overrides and never expand public defaults', () => {
  const standalone = minimalConfiguration(); assert.deepEqual(standalone, {});
  const paired = minimalConfiguration('pair');
  assert.deepEqual(paired, { controller: { topology: 'pair', input: 'providers' }, mqtt: { address: 'mqtt://127.0.0.1' } });
  assert.equal(paired.pair, undefined); assert.equal(paired.charging, undefined); assert.equal(standalone.controller, undefined);
  paired.controller.input = 'offline'; assert.equal(minimalConfiguration('pair').controller.input, 'providers');
});
test('configuration parsing accepts one complete sparse file and preserves private values', () => {
  const options = { mqtt: { address: 'mqtt://127.0.0.1', user: 'synthetic-device', pw: syntheticSecret },
    controller: { input: 'providers', web_token: syntheticSecret }, charts: { cache_days: 3 } };
  assert.deepEqual(parseSetupConfiguration(JSON.stringify(options)), options);
  assert.deepEqual(parseSetupConfiguration('{}'), {});
});
test('malformed and unsupported configuration inputs expose no credential values or arbitrary field names', () => {
  for (const text of [syntheticSecret, `{"mqtt":{"pw":"${syntheticSecret}",}}`, 'null', '[]', '12', '"text"',
    JSON.stringify({ [syntheticSecret]: true }), JSON.stringify({ options: { mqtt: { pw: syntheticSecret } } }),
    JSON.stringify({ controller: { role: syntheticSecret } }), JSON.stringify({ pair: { enabled: true } }),
    JSON.stringify({ charts: { cache_days: syntheticSecret } }), '{"__proto__":{"polluted":true}}'])
    rejectionWithoutSecret(() => parseSetupConfiguration(text), /private draft/);
  assert.equal({}.polluted, undefined);
  rejectionWithoutSecret(() => parseSetupConfiguration(' '.repeat(1048577)), /size limit/);
});
test('review redacts credentials and text while exposing engineering settings and current topology choices', () => {
  const before = { mqtt: { user: 'synthetic-before', pw: syntheticSecret }, controller: { topology: 'standalone' }, charts: { cache_days: 2 } };
  const after = { mqtt: { user: 'synthetic-after', pw: syntheticSecret + '-changed' }, controller: { topology: 'pair' }, charts: { cache_days: 3 } };
  const changes = reviewSetupChanges(before, after);
  assert.ok(!JSON.stringify(changes).includes(syntheticSecret)); assert.ok(!JSON.stringify(changes).includes('synthetic-before'));
  assert.deepEqual(changes.find(change => change.path === 'mqtt.pw'), { path: 'mqtt.pw', before: '[redacted]', after: '[redacted]', redacted: true });
  assert.deepEqual(changes.find(change => change.path === 'controller.topology'), { path: 'controller.topology', before: 'standalone', after: 'pair', redacted: false });
  assert.deepEqual(changes.find(change => change.path === 'charts.cache_days'), { path: 'charts.cache_days', before: 2, after: 3, redacted: false });
});
test('reviewed patches preserve all unrelated sparse values without mutating the source', () => {
  const original = { controller: { input: 'providers', web_token: syntheticSecret }, mqtt: { address: 'mqtt://127.0.0.1', pw: syntheticSecret }, charts: { cache_days: 3 } };
  const snapshot = structuredClone(original);
  const result = patchSetupConfiguration(original, { controller: { topology: 'pair' }, mqtt: { user: 'synthetic-device' } });
  assert.deepEqual(original, snapshot); assert.equal(result.controller.web_token, syntheticSecret);
  assert.equal(result.mqtt.pw, syntheticSecret); assert.equal(result.mqtt.address, original.mqtt.address);
  assert.deepEqual(result.charts, original.charts); assert.equal(result.controller.max_drop_c, undefined);
  assert.throws(() => patchSetupConfiguration(original, JSON.parse('{"__proto__":{}}')), /unsupported/);
});

test('environment generation round-trips paths with spaces and keeps standalone free of pair directory overrides', () => {
  const standalone = setupEnvironment({ secrets: '/srv/private config/secrets.json', data: '/srv/application data', topology: 'standalone' });
  assert.deepEqual(parseEnvironment(environmentText(standalone)), standalone);
  assert.equal(standalone.STMQ_DATABASE_DIR, '/srv/application data'); assert.equal(standalone.STMQ_PAIR_DIR, undefined);
  const pair = setupEnvironment({ secrets: '/srv/private config/secrets.json', data: '/srv/application data',
    database: '/srv/database folder', pairing: '/srv/pair folder', topology: 'pair', port: 4321 });
  assert.equal(pair.STMQ_PAIR_DIR, '/srv/pair folder'); assert.equal(pair.STMQ_PORT, '4321');
  assert.deepEqual(parseEnvironment(environmentText(pair)), pair);
});
test('environment output rejects invalid names, quotes, line breaks and non-string values', () => {
  for (const environment of [{ bad_name: 'text' }, { STMQ_CONFIG: 'one\ntwo' }, { STMQ_CONFIG: 'one\rtwo' },
    { STMQ_CONFIG: 'one\0two' }, { STMQ_CONFIG: "one'two" }, { STMQ_PORT: 1234 }])
    rejectionWithoutSecret(() => environmentText(environment), /paths cannot contain/);
});
test('setup clears inherited application overrides before building the reviewed candidate', () => {
  assert.deepEqual(cleanSetupEnvironment({ PATH: '/usr/bin', HOME: '/home/operator', LANG: 'C.UTF-8',
    STMQ_CONFIG: '/unreviewed/private.json', STMQ_ROLE: 'master', STMQ_ADDON: '1', STMQ_INPUT: 'mqtt', NODE_OPTIONS: '--eval arbitrary' }),
  { PATH: '/usr/bin', HOME: '/home/operator', LANG: 'C.UTF-8' });
});

test('private external paths reject relative, unnormalized, source and runtime descendants including symlink aliases', t => {
  const f = fixture(t), runtime = f.connection.runtime_dir;
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const path of ['relative', f.root + '/private/../candidate', f.source, join(f.source, 'new-private-file'), runtime, join(runtime, 'data')])
    rejectionWithoutSecret(() => requireExternalPath(path, [f.source, runtime]), /absolute normalized|outside source/);
  symlinkSync(f.source, join(f.root, 'source-alias'));
  rejectionWithoutSecret(() => requireExternalPath(join(f.root, 'source-alias/new-private-file'), [f.source, runtime]), /outside source/);
  assert.equal(requireExternalPath(f.secrets, [f.source, runtime]), f.secrets);
});
test('private directories are created owned and mode 0700; unsafe files, permissive directories and symlinks fail', t => {
  const f = fixture(t), directory = join(f.root, 'new directory');
  privateDirectory(directory); assert.equal(lstatSync(directory).mode & 0o777, 0o700); assert.equal(lstatSync(directory).uid, process.getuid());
  const permissive = join(f.root, 'public'); mkdirSync(permissive, { mode: 0o755 }); chmodSync(permissive, 0o755);
  rejectionWithoutSecret(() => privateDirectory(permissive), /owned private directory/);
  const file = join(f.root, 'regular-file'); writeFileSync(file, '', { mode: 0o600 });
  assert.throws(() => privateDirectory(file));
  const alias = join(f.root, 'directory-link'); symlinkSync(directory, alias);
  rejectionWithoutSecret(() => privateDirectory(alias), /owned private directory/);
});
test('private snapshots reject public modes, foreign ownership, directories and both present and dangling links', t => {
  const f = fixture(t);
  writeFileSync(f.secrets, syntheticSecret, { mode: 0o600 });
  assert.deepEqual(snapshotPrivate(f.secrets).bytes, Buffer.from(syntheticSecret));
  chmodSync(f.secrets, 0o644); rejectionWithoutSecret(() => snapshotPrivate(f.secrets), /owned regular files/); chmodSync(f.secrets, 0o600);
  rejectionWithoutSecret(() => snapshotPrivate(f.directory), /owned regular files/);
  if (process.getuid() !== 0) rejectionWithoutSecret(() => snapshotPrivate(process.execPath), /owned regular files/);
  const alias = join(f.directory, 'link.json'); symlinkSync(f.secrets, alias);
  rejectionWithoutSecret(() => snapshotPrivate(alias), /could not be read safely/);
  const dangling = join(f.directory, 'dangling.json'); symlinkSync(join(f.directory, 'missing.json'), dangling);
  rejectionWithoutSecret(() => snapshotPrivate(dangling, { optional: true }), /could not be read safely/);
  assert.equal(snapshotPrivate(join(f.directory, 'absent.json'), { optional: true }), null);
});
test('oversized private files are rejected before their contents can become diagnostic output', t => {
  const f = fixture(t); writeFileSync(f.secrets, syntheticSecret + ' '.repeat(1048576), { mode: 0o600 });
  rejectionWithoutSecret(() => snapshotPrivate(f.secrets), /1 MiB/);
});
test('writes are private and atomic and never follow a destination symlink', t => {
  const f = fixture(t); writePrivate(f.secrets, syntheticSecret);
  assert.equal(lstatSync(f.secrets).mode & 0o777, 0o600); assert.equal(readFileSync(f.secrets, 'utf8'), syntheticSecret);
  const before = lstatSync(f.secrets).ino; writePrivate(f.secrets, syntheticSecret + '-changed');
  assert.notEqual(lstatSync(f.secrets).ino, before); assert.equal(lstatSync(f.secrets).mode & 0o777, 0o600);
  const alias = join(f.directory, 'alias.json'); symlinkSync(f.secrets, alias);
  rejectionWithoutSecret(() => writePrivate(alias, 'replacement'), /unsafe private path/);
  assert.equal(readFileSync(f.secrets, 'utf8'), syntheticSecret + '-changed');
  const dangling = join(f.directory, 'dangling.json'); symlinkSync(join(f.directory, 'absent.json'), dangling);
  rejectionWithoutSecret(() => writePrivate(dangling, 'replacement'), /unsafe private path/);
  assert.ok(lstatSync(dangling).isSymbolicLink());
});
test('review snapshots reject content changes, inode replacement, deletion and new-file races', t => {
  const f = fixture(t);
  for (const change of ['content', 'inode', 'delete']) {
    writePrivate(f.secrets, syntheticSecret); const before = snapshotPrivate(f.secrets);
    if (change === 'content') writeFileSync(f.secrets, syntheticSecret + '-changed');
    if (change === 'inode') { const replacement = join(f.directory, 'replacement.json'); writeFileSync(replacement, syntheticSecret, { mode: 0o600 }); renameSync(replacement, f.secrets); }
    if (change === 'delete') unlinkSync(f.secrets);
    rejectionWithoutSecret(() => unchangedPrivate(f.secrets, before), /changed after review/);
    if (existsSync(f.secrets)) unlinkSync(f.secrets);
  }
  unchangedPrivate(f.secrets, null); writePrivate(f.secrets, syntheticSecret);
  rejectionWithoutSecret(() => unchangedPrivate(f.secrets, null), /changed after review/);
});
test('reviewed writes preserve original bytes in a private backup and save only the reviewed replacement', t => {
  const f = fixture(t), backupDirectory = join(f.directory, 'backups');
  const original = '{\n  "mqtt": { "pw": "' + syntheticSecret + '" },\n  "charts": { "cache_days": 3 }\n}\n';
  const replacement = JSON.stringify(patchSetupConfiguration(parseSetupConfiguration(original), { controller: { input: 'providers' } }), null, 2) + '\n';
  writePrivate(f.secrets, original); const before = snapshotPrivate(f.secrets);
  const backup = saveReviewedPrivate(f.secrets, replacement, before, backupDirectory);
  assert.equal(readFileSync(backup, 'utf8'), original); assert.equal(readFileSync(f.secrets, 'utf8'), replacement);
  assert.equal(lstatSync(backup).mode & 0o777, 0o600); assert.equal(lstatSync(backupDirectory).mode & 0o777, 0o700);
  assert.equal(parseSetupConfiguration(readFileSync(f.secrets, 'utf8')).mqtt.pw, syntheticSecret);
  assert.deepEqual(readdirSync(f.directory).sort(), ['backups', 'secrets.json']);
});
test('unchanged reviewed files keep their inode and need no backup; fresh writes create no false history', t => {
  const f = fixture(t), backupDirectory = join(f.directory, 'backups');
  assert.equal(saveReviewedPrivate(f.secrets, '{}\n', null, backupDirectory), null); assert.equal(existsSync(backupDirectory), false);
  const before = snapshotPrivate(f.secrets), inode = lstatSync(f.secrets).ino;
  assert.equal(saveReviewedPrivate(f.secrets, '{}\n', before, backupDirectory), null); assert.equal(lstatSync(f.secrets).ino, inode);
  assert.equal(existsSync(backupDirectory), false);
});
test('a stale reviewed write never overwrites the new file or creates misleading backup history', t => {
  const f = fixture(t), backupDirectory = join(f.directory, 'backups');
  writePrivate(f.secrets, '{}\n'); const before = snapshotPrivate(f.secrets);
  writePrivate(f.secrets, JSON.stringify({ mqtt: { pw: syntheticSecret } }));
  rejectionWithoutSecret(() => saveReviewedPrivate(f.secrets, '{"charts":{"cache_days":3}}\n', before, backupDirectory), /changed after review/);
  assert.equal(parseSetupConfiguration(readFileSync(f.secrets, 'utf8')).mqtt.pw, syntheticSecret); assert.equal(existsSync(backupDirectory), false);
});

test('candidate validation uses the real current loader without starting application or touching state', t => {
  const f = fixture(t), original = { controller: { input: 'providers', web_token: syntheticSecret }, charts: { cache_days: 3 } };
  const previous = structuredClone(original);
  const config = validateSetupConfiguration(original, f);
  assert.equal(config.input, 'providers'); assert.equal(config.topology, 'standalone'); assert.equal(config.token, syntheticSecret);
  assert.equal(config.dataDir, f.data); assert.equal(config.databaseDir, f.data); assert.equal(config.dbPath, join(f.data, 'st-mq.sqlite'));
  assert.deepEqual(original, previous); assert.equal(existsSync(f.data), false); assert.equal(existsSync(config.pair.directory ?? join(f.data, 'pairing')), false);
  assert.equal(lstatSync(f.draft).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(readFileSync(f.draft, 'utf8')), original);
});
test('standalone empty skeleton retains the current simulated default and creates no data', t => {
  const f = fixture(t); const config = validateSetupConfiguration(minimalConfiguration(), f);
  assert.equal(config.input, 'simulated'); assert.equal(config.dbPath, join(f.data, 'simulation.sqlite')); assert.equal(existsSync(f.data), false);
});
test('a complete paired candidate is read-only and always begins with slave role', t => {
  const f = fixture(t); f.environment = setupEnvironment({ secrets: f.secrets, data: f.data, topology: 'pair' });
  const options = patchSetupConfiguration(minimalConfiguration('pair'), { pair: { pair_id: 'synthetic-pair', token: syntheticSecret,
    peer_url: 'http://192.0.2.10:1244', vip_interface: 'eth0', vip_address: '192.0.2.30', vip_prefix: 24 } });
  const config = validateSetupConfiguration(options, f);
  assert.equal(config.topology, 'pair'); assert.equal(config.role, 'slave'); assert.equal(config.pair.pairId, 'synthetic-pair');
  assert.equal(config.pair.vip.socketPath, '/run/st-mq-vip/socket'); assert.equal(existsSync(f.data), false);
});
test('loader validation failures retain only the private draft and never leak invalid values', t => {
  const f = fixture(t); f.environment = setupEnvironment({ secrets: f.secrets, data: f.data, topology: 'pair' });
  const options = patchSetupConfiguration(minimalConfiguration('pair'), { pair: { pair_id: 'synthetic-pair', token: syntheticSecret,
    peer_url: syntheticSecret, vip_interface: 'eth0', vip_address: '192.0.2.30' } });
  rejectionWithoutSecret(() => validateSetupConfiguration(options, f), /pair\.peer_url/);
  assert.equal(JSON.parse(readFileSync(f.draft, 'utf8')).pair.peer_url, syntheticSecret); assert.equal(existsSync(f.data), false);
  rejectionWithoutSecret(() => validateSetupConfiguration({ [syntheticSecret]: 'unsupported' }, f), /private draft/);
});
