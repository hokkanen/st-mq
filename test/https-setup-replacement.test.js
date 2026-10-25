import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { assertHelperStopped } from '../src/https/helper.js';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, rename, symlink, chmod, chown, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { atomicJson } from '../src/https/storage.js';
import { reviewSetupReplacement, startSetupReplacement, resumeSetupReplacement, readSetupReplacement } from '../src/https/setup-replacement.js';

const freshState = { version: 1, enabled: false, machineName: 'fixture-fresh-machine' };
const approvalToken = createHash('sha256').update('fixture-reviewed-semantic-state').digest('hex');
const managed = ['state.json', 'runtime', 'certificates', 'snapshots', 'helper-process.json', 'manager.lock', 'manager.claim'];
async function fixture(t, { sibling = false } = {}) {
  const parent = await mkdtemp(resolve(tmpdir(), 'stmq-https-setup-replacement-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = resolve(parent, 'https'); await mkdir(directory, { mode: 0o700 });
  const identityDirectory = sibling ? resolve(parent, '.https-https-helper') : resolve(directory, 'identity');
  await mkdir(identityDirectory, { mode: 0o700 });
  for (const name of managed) {
    if (['runtime', 'certificates', 'snapshots', 'manager.claim'].includes(name)) {
      await mkdir(resolve(directory, name), { mode: 0o700 });
      await writeFile(resolve(directory, name, 'fixture-data'), `fixture-saved-${name}`, { mode: 0o600 });
    } else await writeFile(resolve(directory, name), `fixture-saved-${name}`, { mode: 0o600 });
  }
  await writeFile(resolve(identityDirectory, 'tailscaled.state'), 'fixture-saved-native-identity', { mode: 0o600 });
  await writeFile(resolve(directory, 'unrelated-private-file'), 'fixture-untouched', { mode: 0o600 });
  return { directory, identityDirectory, identityUid: process.getuid() };
}
async function accepted(options, extra = {}) {
  const { token } = await reviewSetupReplacement(options);
  return startSetupReplacement({ ...options, token, approvalToken, freshState, ...extra });
}
async function verifyArchive(options, receipt) {
  const archive = resolve(options.directory, receipt.archive);
  assert.equal((await lstat(archive)).mode & 0o777, 0o700);
  for (const name of managed) {
    const file = ['runtime', 'certificates', 'snapshots', 'manager.claim'].includes(name) ? resolve(archive, name, 'fixture-data') : resolve(archive, name);
    assert.equal(await readFile(file, 'utf8'), `fixture-saved-${name}`);
  }
  assert.equal(await readFile(resolve(archive, 'helper-identity', 'tailscaled.state'), 'utf8'), 'fixture-saved-native-identity');
  assert.equal(await readFile(resolve(options.directory, 'unrelated-private-file'), 'utf8'), 'fixture-untouched');
  assert.deepEqual(JSON.parse(await readFile(resolve(options.directory, 'state.json'), 'utf8')), freshState);
  await assert.rejects(lstat(options.identityDirectory), { code: 'ENOENT' });
}
for (const sibling of [false, true]) test(`explicit replacement preserves all managed bytes and root inode with ${sibling ? 'root sibling' : 'nested'} identity`, async t => {
  const options = await fixture(t, { sibling }); const original = await lstat(options.directory);
  const reviewed = await reviewSetupReplacement(options); assert.equal(reviewed.hasState, true);
  const receipt = await accepted(options);
  assert.equal(receipt.state, 'completed'); assert.equal(receipt.approvalToken, approvalToken);
  assert.equal((await lstat(options.directory)).ino, original.ino);
  await verifyArchive(options, receipt);
  assert.deepEqual(await readSetupReplacement(options), { pending: false, id: receipt.id, approvalToken, receipt });
});

const boundaries = ['accepted', ...managed.flatMap(name => [`renamed:${name}`, `archived:${name}`]), 'renamed:helper-identity', 'archived:helper-identity', 'publishing', 'published', 'complete'];
for (const boundary of boundaries) test(`restart resumes exactly once after ${boundary}`, async t => {
  const options = await fixture(t); let interrupted = false;
  await assert.rejects(accepted(options, { checkpoint: stage => {
    if (stage === boundary) { interrupted = true; throw new Error('fixture-interrupted-operation'); }
  } }), /fixture-interrupted-operation/);
  assert.equal(interrupted, true);
  const receipt = await resumeSetupReplacement(options); assert.equal(receipt.state, 'completed');
  await verifyArchive(options, receipt);
  assert.deepEqual(await resumeSetupReplacement(options), receipt);
  assert.deepEqual(await readdir(resolve(options.directory, 'setup-archives')), [receipt.id]);
});

test('completed restart and duplicate approval never overwrite later setup state', async t => {
  const options = await fixture(t), { token } = await reviewSetupReplacement(options);
  const receipt = await startSetupReplacement({ ...options, token, approvalToken, freshState });
  const later = { ...freshState, enabled: true, fixture: 'new-enrollment' };
  await atomicJson(resolve(options.directory, 'state.json'), later);
  assert.deepEqual(await resumeSetupReplacement(options), receipt);
  assert.deepEqual(await startSetupReplacement({ ...options, token, approvalToken, freshState }), receipt);
  assert.deepEqual(JSON.parse(await readFile(resolve(options.directory, 'state.json'), 'utf8')), later);
});

test('a later explicit replacement creates its own archive and preserves earlier archives', async t => {
  const options = await fixture(t), first = await accepted(options);
  const second = await accepted(options);
  assert.notEqual(first.id, second.id);
  assert.deepEqual((await readdir(resolve(options.directory, 'setup-archives'))).sort(), [first.id, second.id].sort());
  assert.equal(await readFile(resolve(options.directory, first.archive, 'helper-identity', 'tailscaled.state'), 'utf8'), 'fixture-saved-native-identity');
  assert.deepEqual(JSON.parse(await readFile(resolve(options.directory, second.archive, 'state.json'), 'utf8')), freshState);
});

for (const change of ['same-size-write', 'replace-inode', 'new-managed-file', 'nested-file']) test(`stale source review rejects ${change} before moving files`, async t => {
  const options = await fixture(t), { token } = await reviewSetupReplacement(options);
  if (change === 'same-size-write') await writeFile(resolve(options.directory, 'state.json'), 'x'.repeat('fixture-saved-state.json'.length), { mode: 0o600 });
  if (change === 'replace-inode') { await rename(resolve(options.directory, 'state.json'), resolve(options.directory, 'saved-outside-plan')); await writeFile(resolve(options.directory, 'state.json'), 'fixture-replacement', { mode: 0o600 }); }
  if (change === 'new-managed-file') await writeFile(resolve(options.directory, 'runtime', 'added'), 'fixture-new', { mode: 0o600 });
  if (change === 'nested-file') await writeFile(resolve(options.identityDirectory, 'tailscaled.state'), 'fixture-changed-native-identity', { mode: 0o600 });
  await assert.rejects(startSetupReplacement({ ...options, token, approvalToken, freshState }), { code: 'https_setup_replacement_changed' });
  await assert.rejects(lstat(resolve(options.directory, 'setup-replacement.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(resolve(options.directory, 'setup-archives')), { code: 'ENOENT' });
});

test('replaced pending sources are rejected before any further archival', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'accepted') throw new Error('fixture-pause'); } }), /fixture-pause/);
  await rename(resolve(options.directory, 'runtime'), resolve(options.directory, 'original-runtime'));
  await mkdir(resolve(options.directory, 'runtime'), { mode: 0o700 });
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_changed' });
  assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
});

test('changed archived material is rejected without publishing a replacement', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'archived:state.json') throw new Error('fixture-pause'); } }), /fixture-pause/);
  const { receipt } = await readSetupReplacement(options);
  await writeFile(resolve(options.directory, receipt.archive, 'state.json'), 'fixture-replaced-archive', { mode: 0o600 });
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_changed' });
  await assert.rejects(lstat(resolve(options.directory, 'state.json')), { code: 'ENOENT' });
});

test('unexpected current state after publication is preserved', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'published') throw new Error('fixture-pause'); } }), /fixture-pause/);
  const unexpected = { version: 1, fixture: 'concurrent-publisher' };
  await atomicJson(resolve(options.directory, 'state.json'), unexpected);
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_changed' });
  assert.deepEqual(JSON.parse(await readFile(resolve(options.directory, 'state.json'), 'utf8')), unexpected);
});

for (const target of ['root', 'managed-entry', 'nested-entry', 'identity', 'archives']) test(`unsafe ${target} symlink is rejected without following or moving it`, async t => {
  const options = await fixture(t); const external = resolve(dirname(options.directory), 'external'); await mkdir(external, { mode: 0o700 });
  await writeFile(resolve(external, 'untouched'), 'fixture-external', { mode: 0o600 });
  let path = { root: options.directory, 'managed-entry': resolve(options.directory, 'runtime'), 'nested-entry': resolve(options.directory, 'runtime', 'fixture-data'), identity: options.identityDirectory, archives: resolve(options.directory, 'setup-archives') }[target];
  await rm(path, { recursive: true, force: true }); await symlink(external, path);
  await assert.rejects(reviewSetupReplacement(options), error => ['https_directory_unsafe', 'https_setup_replacement_unsafe'].includes(error.code));
  assert.equal(await readFile(resolve(external, 'untouched'), 'utf8'), 'fixture-external');
});

test('unsafe root permissions are rejected unchanged', async t => {
  const options = await fixture(t); await chmod(options.directory, 0o755);
  await assert.rejects(reviewSetupReplacement(options), { code: 'https_directory_unsafe' });
  assert.equal((await lstat(options.directory)).mode & 0o777, 0o755);
});

for (const field of ['version', 'stage', 'identityDirectory', 'manager', 'entries', 'freshState', 'freshStateHash', 'approvalToken']) test(`unsupported or tampered journal ${field} fails closed`, async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'accepted') throw new Error('fixture-pause'); } }), /fixture-pause/);
  const path = resolve(options.directory, 'setup-replacement.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  journal[field] = { version: 999, stage: 'invented', identityDirectory: resolve(options.directory, 'unrelated'), manager: ['wrong'], entries: [{ name: '../private', signature: 'f'.repeat(64) }], freshState: null, freshStateHash: 'f'.repeat(64), approvalToken: 'fixture-unapproved' }[field];
  await atomicJson(path, journal);
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_invalid' });
  assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
});

test('missing journal lookup and resume do not create storage or archives', async t => {
  const options = await fixture(t);
  assert.equal(await readSetupReplacement(options), null); assert.equal(await resumeSetupReplacement(options), null);
  await assert.rejects(lstat(resolve(options.directory, 'setup-archives')), { code: 'ENOENT' });
  const missing = { ...options, directory: resolve(dirname(options.directory), 'absent') };
  assert.equal(await readSetupReplacement(missing), null);
});

test('pending replacement cannot be silently superseded by another approval', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'accepted') throw new Error('fixture-pause'); } }), /fixture-pause/);
  await assert.rejects(startSetupReplacement({ ...options, token: 'f'.repeat(64), approvalToken, freshState }), { code: 'https_setup_replacement_pending' });
});

for (const boundary of ['accepted', 'renamed:helper-identity', 'published']) test(`actual process death resumes ${boundary}`, { timeout: 15000 }, async t => {
  const options = await fixture(t), module = new URL('../src/https/setup-replacement.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { reviewSetupReplacement, startSetupReplacement } from ${JSON.stringify(module)};
    const options = JSON.parse(process.argv[1]);
    const { token } = await reviewSetupReplacement(options);
    await startSetupReplacement({ ...options, token, freshState: ${JSON.stringify(freshState)}, checkpoint(stage) {
      if (stage === process.argv[2]) process.kill(process.pid, 'SIGKILL');
    } });
  `, JSON.stringify(options), boundary], { stdio: ['ignore', 'ignore', 'pipe'] });
  const completion = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  const [code, signal] = await completion;
  assert.equal(code, null, errors); assert.equal(signal, 'SIGKILL');
  const receipt = await resumeSetupReplacement(options);
  assert.equal(receipt.state, 'completed'); await verifyArchive(options, receipt);
});

test('failed durable acceptance preserves all current material without an archive', { skip: process.getuid() === 0 && 'root bypasses write permissions' }, async t => {
  const options = await fixture(t);
  await chmod(options.directory, 0o500);
  try {
    const { token } = await reviewSetupReplacement(options);
    await assert.rejects(startSetupReplacement({ ...options, token, approvalToken, freshState }), { code: 'EACCES' });
    assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
    await assert.rejects(lstat(resolve(options.directory, 'setup-archives')), { code: 'ENOENT' });
  } finally { await chmod(options.directory, 0o700); }
});

test('a failed fresh-state write retains its durable publication journal and resumes', { skip: process.getuid() === 0 && 'root bypasses write permissions' }, async t => {
  const options = await fixture(t);
  try {
    await assert.rejects(accepted(options, { checkpoint: async stage => {
      if (stage === 'publishing') await chmod(options.directory, 0o500);
    } }), { code: 'EACCES' });
  } finally { await chmod(options.directory, 0o700); }
  assert.equal((await readSetupReplacement(options)).pending, true);
  const receipt = await resumeSetupReplacement(options);
  await verifyArchive(options, receipt);
});

test('native stopped proof rejects a live saved PID without signaling it', async t => {
  const options = await fixture(t), record = resolve(options.directory, 'helper-process.json');
  const text = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const start = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  await atomicJson(record, { version: 1, pid: process.pid, start, token: 'fixture-process-proof' });
  await assert.rejects(assertHelperStopped(options.identityDirectory, record), { code: 'helper_already_running' });
  process.kill(process.pid, 0);
});

test('native stopped proof refuses a responding helper socket even without saved PID metadata', async t => {
  const options = await fixture(t), record = resolve(options.directory, 'helper-process.json');
  await rm(record);
  const socketDirectory = resolve(tmpdir(), `stmq-h-${createHash('sha256').update(options.identityDirectory).digest('hex').slice(0, 16)}`);
  await mkdir(socketDirectory, { mode: 0o700 });
  t.after(() => rm(socketDirectory, { recursive: true, force: true }));
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(resolve(socketDirectory, 's'), ready); });
  t.after(() => new Promise(done => server.close(done)));
  if (process.getuid() === 0) { await chown(socketDirectory, 65534, 65534); await chown(resolve(socketDirectory, 's'), 65534, 65534); }
  await assert.rejects(assertHelperStopped(options.identityDirectory, record), { code: 'helper_already_running' });
});

test('native stopped proof accepts a genuinely absent process and socket without editing saved metadata', async t => {
  const options = await fixture(t), record = resolve(options.directory, 'helper-process.json');
  const saved = { version: 1, pid: 999999999, start: '1', token: 'fixture-stale-process' };
  await atomicJson(record, saved);
  await assertHelperStopped(options.identityDirectory, record);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), saved);
});

test('publication resume revalidates archived inode trees before initializing fresh state', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'publishing') throw new Error('fixture-pause'); } }), /fixture-pause/);
  const { receipt } = await readSetupReplacement(options);
  await writeFile(resolve(options.directory, receipt.archive, 'runtime', 'fixture-data'), 'fixture-changed-after-archival', { mode: 0o600 });
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_changed' });
  await assert.rejects(lstat(resolve(options.directory, 'state.json')), { code: 'ENOENT' });
});

test('publication resume refuses a new managed writer without replacing its material', async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'publishing') throw new Error('fixture-pause'); } }), /fixture-pause/);
  await mkdir(resolve(options.directory, 'runtime'), { mode: 0o700 });
  await writeFile(resolve(options.directory, 'runtime', 'fixture-new-writer'), 'fixture-preserved', { mode: 0o600 });
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_changed' });
  assert.equal(await readFile(resolve(options.directory, 'runtime', 'fixture-new-writer'), 'utf8'), 'fixture-preserved');
});

for (const contents of ['fixture-incomplete-json{', '{"version":999,"fixture":"unsupported"}', '{"version":1,"stage":"invented"}']) test(`explicit replacement preserves an opaque unsupported journal (${contents.slice(0, 20)})`, async t => {
  const options = await fixture(t), path = resolve(options.directory, 'setup-replacement.json');
  await writeFile(path, contents, { mode: 0o600 });
  await assert.rejects(readSetupReplacement(options), { code: 'https_setup_replacement_invalid' });
  await assert.rejects(resumeSetupReplacement(options), { code: 'https_setup_replacement_invalid' });
  assert.equal(await readFile(path, 'utf8'), contents);
  const receipt = await accepted(options);
  assert.equal(await readFile(resolve(options.directory, receipt.archive, 'previous-setup-replacement.json'), 'utf8'), contents);
  await verifyArchive(options, receipt);
});

for (const boundary of ['previous-journal-preserved', 'accepted', 'publishing', 'published']) test(`unsupported journal replacement survives ${boundary}`, async t => {
  const options = await fixture(t), path = resolve(options.directory, 'setup-replacement.json'), original = '{fixture-old-unsupported-journal';
  await writeFile(path, original, { mode: 0o600 });
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === boundary) throw new Error('fixture-pause'); } }), /fixture-pause/);
  let receipt;
  if (boundary === 'previous-journal-preserved') {
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
    receipt = await accepted(options);
  } else receipt = await resumeSetupReplacement(options);
  assert.equal(await readFile(resolve(options.directory, receipt.archive, 'previous-setup-replacement.json'), 'utf8'), original);
  await verifyArchive(options, receipt);
});

test('unsupported journal source changes invalidate the reviewed replacement', async t => {
  const options = await fixture(t), path = resolve(options.directory, 'setup-replacement.json');
  await writeFile(path, 'fixture-old-bad-journal', { mode: 0o600 });
  const { token } = await reviewSetupReplacement(options);
  await writeFile(path, 'fixture-new-bad-journal', { mode: 0o600 });
  await assert.rejects(startSetupReplacement({ ...options, token, approvalToken, freshState }), { code: 'https_setup_replacement_changed' });
  await assert.rejects(lstat(resolve(options.directory, 'setup-archives')), { code: 'ENOENT' });
});

test('an opaque journal changed while preserving is never overwritten', async t => {
  const options = await fixture(t), path = resolve(options.directory, 'setup-replacement.json');
  await writeFile(path, 'fixture-old-bad-journal', { mode: 0o600 });
  await assert.rejects(accepted(options, { checkpoint: async stage => {
    if (stage === 'previous-journal-preserved') await writeFile(path, 'fixture-new-bad-journal', { mode: 0o600 });
  } }), { code: 'https_setup_replacement_changed' });
  assert.equal(await readFile(path, 'utf8'), 'fixture-new-bad-journal');
  assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
});

for (const shape of ['symlink', 'directory', 'public-permissions', 'oversize']) test(`unsafe ${shape} journal cannot be preserved as trusted replacement metadata`, async t => {
  const options = await fixture(t), path = resolve(options.directory, 'setup-replacement.json');
  if (shape === 'directory') await mkdir(path, { mode: 0o700 });
  else if (shape === 'symlink') await symlink(resolve(options.directory, 'state.json'), path);
  else await writeFile(path, shape === 'oversize' ? 'x'.repeat(512 * 1024 + 1) : 'fixture-bad-journal', { mode: shape === 'public-permissions' ? 0o644 : 0o600 });
  await assert.rejects(reviewSetupReplacement(options), { code: 'https_setup_replacement_unsafe' });
  assert.equal(await readFile(resolve(options.directory, 'state.json'), 'utf8'), 'fixture-saved-state.json');
});

for (const shape of ['symlink', 'public-directory', 'file']) test(`native stopped proof refuses an unsafe ${shape} socket parent`, async t => {
  const options = await fixture(t), record = resolve(options.directory, 'helper-process.json');
  const socketDirectory = resolve(tmpdir(), `stmq-h-${createHash('sha256').update(options.identityDirectory).digest('hex').slice(0, 16)}`);
  t.after(() => rm(socketDirectory, { recursive: true, force: true }));
  if (shape === 'symlink') await symlink(options.directory, socketDirectory);
  else if (shape === 'public-directory') await mkdir(socketDirectory, { mode: 0o755 });
  else await writeFile(socketDirectory, 'fixture-unsafe-socket-location', { mode: 0o600 });
  await assert.rejects(assertHelperStopped(options.identityDirectory, record), { code: 'helper_socket_directory_unsafe' });
});

test('native stopped proof admits a stale socket only after its process has actually exited', { timeout: 15000 }, async t => {
  const options = await fixture(t), record = resolve(options.directory, 'helper-process.json');
  const socketDirectory = resolve(tmpdir(), `stmq-h-${createHash('sha256').update(options.identityDirectory).digest('hex').slice(0, 16)}`);
  await mkdir(socketDirectory, { mode: 0o700 });
  t.after(() => rm(socketDirectory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { createServer } from 'node:http';
    createServer((_req, res) => { res.writeHead(200); res.end('{}'); }).listen(process.argv[1], () => process.stdout.write('ready'));
  `, resolve(socketDirectory, 's')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const completion = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data', { signal: t.signal });
  if (process.getuid() === 0) { await chown(socketDirectory, 65534, 65534); await chown(resolve(socketDirectory, 's'), 65534, 65534); }
  await assert.rejects(assertHelperStopped(options.identityDirectory, record), { code: 'helper_already_running' });
  child.kill('SIGKILL'); await completion;
  assert.equal((await lstat(resolve(socketDirectory, 's'))).isSocket(), true);
  await assertHelperStopped(options.identityDirectory, record);
});

for (const method of ['copy', 'move']) test(`a current completed receipt survives installation ${method} without replaying state or rebinding paths`, async t => {
  const options = await fixture(t), receipt = await accepted(options);
  const destination = resolve(dirname(options.directory), 'restored-https');
  if (method === 'copy') await cp(options.directory, destination, { recursive: true, preserveTimestamps: true });
  else await rename(options.directory, destination);
  const restored = { ...options, directory: destination, identityDirectory: resolve(destination, 'identity') };
  const active = { ...freshState, enabled: true, fixture: 'later-current-installation-state' };
  await atomicJson(resolve(destination, 'state.json'), active);
  const journalBytes = await readFile(resolve(destination, 'setup-replacement.json'));
  assert.deepEqual(await readSetupReplacement(restored), { pending: false, id: receipt.id, approvalToken, receipt });
  assert.deepEqual(await resumeSetupReplacement(restored), receipt);
  assert.deepEqual(JSON.parse(await readFile(resolve(destination, 'state.json'), 'utf8')), active);
  assert.deepEqual(await readFile(resolve(destination, 'setup-replacement.json')), journalBytes);
  assert.deepEqual(await readdir(resolve(destination, 'setup-archives')), [receipt.id]);
});

for (const method of ['copy', 'move']) test(`a pending current operation cannot automatically resume after installation ${method}`, async t => {
  const options = await fixture(t);
  await assert.rejects(accepted(options, { checkpoint: stage => { if (stage === 'accepted') throw new Error('fixture-pause'); } }), /fixture-pause/);
  const destination = resolve(dirname(options.directory), 'restored-https');
  if (method === 'copy') await cp(options.directory, destination, { recursive: true, preserveTimestamps: true });
  else await rename(options.directory, destination);
  const restored = { ...options, directory: destination, identityDirectory: resolve(destination, 'identity') };
  const journalBytes = await readFile(resolve(destination, 'setup-replacement.json'));
  await assert.rejects(readSetupReplacement(restored), { code: 'https_setup_replacement_invalid' });
  await assert.rejects(resumeSetupReplacement(restored), { code: 'https_setup_replacement_invalid' });
  assert.equal(await readFile(resolve(destination, 'state.json'), 'utf8'), 'fixture-saved-state.json');
  assert.deepEqual(await readFile(resolve(destination, 'setup-replacement.json')), journalBytes);
  const replacement = await accepted(restored);
  assert.deepEqual(await readFile(resolve(destination, replacement.archive, 'previous-setup-replacement.json')), journalBytes);
  await verifyArchive(restored, replacement);
});

for (const mutation of ['frozen-state', 'saved-token', 'saved-manager', 'saved-path', 'unsupported-field']) test(`restored completed receipts reject ${mutation} without changing current state`, async t => {
  const options = await fixture(t); await accepted(options);
  const destination = resolve(dirname(options.directory), 'restored-https');
  await cp(options.directory, destination, { recursive: true, preserveTimestamps: true });
  const restored = { ...options, directory: destination, identityDirectory: resolve(destination, 'identity') };
  const path = resolve(destination, 'setup-replacement.json'), journal = JSON.parse(await readFile(path, 'utf8'));
  if (mutation === 'frozen-state') journal.freshState.enabled = true;
  if (mutation === 'saved-token') journal.token = 'a'.repeat(64);
  if (mutation === 'saved-manager') journal.manager[1] = '123456';
  if (mutation === 'saved-path') journal.identityDirectory = '/fixture-unreviewed-identity';
  if (mutation === 'unsupported-field') journal.retiredFormat = true;
  await atomicJson(path, journal);
  await assert.rejects(readSetupReplacement(restored), { code: 'https_setup_replacement_invalid' });
  await assert.rejects(resumeSetupReplacement(restored), { code: 'https_setup_replacement_invalid' });
  assert.deepEqual(JSON.parse(await readFile(resolve(destination, 'state.json'), 'utf8')), freshState);
});

test('a restored completed receipt allows a newly approved operation bound to the current installation', async t => {
  const options = await fixture(t), first = await accepted(options);
  const destination = resolve(dirname(options.directory), 'restored-https');
  await cp(options.directory, destination, { recursive: true, preserveTimestamps: true });
  const restored = { ...options, directory: destination, identityDirectory: resolve(destination, 'identity') };
  const second = await accepted(restored);
  assert.notEqual(second.id, first.id);
  const journal = JSON.parse(await readFile(resolve(destination, 'setup-replacement.json'), 'utf8'));
  assert.equal(journal.identityDirectory, restored.identityDirectory);
  assert.equal(journal.manager[1], String((await lstat(destination)).ino));
  assert.equal(journal.previousJournal, null, 'A valid current receipt is not an unsupported format');
  assert.deepEqual((await readdir(resolve(destination, 'setup-archives'))).sort(), [first.id, second.id].sort());
});
