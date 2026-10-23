import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSetupHA, prepareConfigurationForHost, savedOptionsProgram, promotionProgram, pairBrokerPort, HASetupError, HASetupUnavailableError } from '../scripts/lib/linux-setup-ha.js';
import { DeploymentTransportError } from '../scripts/lib/ha-deploy-transport.js';

const app = { slug: 'synthetic_st-mq', repository: 'synthetic', version: '0.9.5-dev.4', state: 'started',
  options: { controller: { input: 'mqtt', topology: 'pair' }, mqtt: { address: 'mqtt://core-mosquitto', user: 'synthetic-user', pw: 'synthetic-private-secret' },
    pair: { pair_id: 'synthetic-pair', token: 'synthetic-pair-token-12345678901234567890' } } };
const pair = { nodeId: '11111111-1111-4111-8111-111111111111', pairId: 'synthetic-pair', bootstrapPending: true, canControl: false,
  role: 'slave', busy: false, phase: null, error: null, actions: { promote: true }, vip: { owned: false }, peer: { role: 'slave' } };

function fixture({ state = app.state, raw = app.options, broker = true, brokerNetwork, fail, afterInfo, runtimePair = pair, lockExitCode = 0, cleanupExitCode = 0 } = {}) {
  let remote = { ...structuredClone(app), state }, options = structuredClone(raw), closed = 0, now = 0;
  let installedBroker = broker, brokerInfo = { slug: 'core_mosquitto', state: 'stopped', options: { logins: [], unrelated: 'retain' },
    network: brokerNetwork ?? { '1883/tcp': broker ? 1885 : 1883, '8883/tcp': 8883, '1884/tcp': null } };
  const calls = [], shell = [], submitted = [];
  const ssh = { close: async () => { closed++; }, run: async (script, request = {}) => {
    shell.push({ script, ...request });
    if (fail?.({ script, request })) throw new DeploymentTransportError('synthetic-private-network-detail');
    if (script === 'docker exec -i hassio_supervisor python3 -') {
      const program = request.input.toString();
      if (program.includes("directory=Path('/data/st-mq-setup-backups')")) {
        const id = program.match(/directory=Path\('\/data\/st-mq-setup-backups'\)\/"([a-f0-9-]+)"/)[1];
        return { exitCode: 0, output: JSON.stringify({ ok: true, backupPath: '/data/st-mq-setup-backups/' + id }) };
      }
      return { exitCode: 0, output: JSON.stringify({ ok: true, options: program.includes('state[\'user\']["core_mosquitto"]') ? brokerInfo.options : options }) };
    }
    if (script.startsWith('docker container ls')) return { exitCode: 0, output: '' };
    if (script.startsWith('docker exec -i ')) return { exitCode: 0, output: '{"submitted":true}' };
    if (script.includes('if mkdir') && script.includes('.lock')) return { exitCode: lockExitCode, output: 'synthetic-private-command-detail' };
    if (script.startsWith('rmdir ')) return { exitCode: cleanupExitCode, output: 'synthetic-private-command-detail' };
    if (script.startsWith('umask 077')) return { exitCode: 0, output: '' };
    throw new Error('unexpected shell command');
  } };
  const api = async (path, method = 'get', timeout, body) => {
    calls.push({ path, method, timeout, body: structuredClone(body) });
    if (fail?.({ path, method, body })) throw new DeploymentTransportError('synthetic-private-api-detail');
    if (path === '/addons') return { addons: [{ slug: app.slug }, ...(installedBroker ? [{ slug: 'core_mosquitto' }] : [])] };
    if (path === `/addons/${app.slug}/info`) { const value = { ...structuredClone(remote), options: structuredClone(options) }; return afterInfo?.(value, calls) ?? value; }
    if (path === '/network/info') return { interfaces: [{ interface: 'eth0', enabled: true, connected: true, primary: true,
      ipv4: { address: ['192.0.2.10/24'] } }, { interface: 'lo', enabled: true, connected: false }] };
    if (path === '/addons/core_mosquitto/info') return structuredClone(brokerInfo);
    if (path.endsWith('/options/validate')) return { valid: true };
    if (method === 'post') {
      submitted.push(path);
      if (path === `/addons/${app.slug}/stop`) remote.state = 'stopped';
      else if (path === `/addons/${app.slug}/start`) remote.state = 'started';
      else if (path === `/addons/${app.slug}/options`) options = structuredClone(body.options);
      else if (path === '/store/addons/core_mosquitto/install') installedBroker = true;
      else if (path === '/addons/core_mosquitto/options') { brokerInfo.options = structuredClone(body.options); if (body.network) brokerInfo.network = structuredClone(body.network); }
      else if (path === '/addons/core_mosquitto/start' || path === '/addons/core_mosquitto/restart') brokerInfo.state = 'started';
      else throw new Error('unexpected mutation');
      return {};
    }
    throw new Error('unexpected API request');
  };
  const deps = { connect: async () => ssh, supervisor: () => api,
    readRuntime: async () => ({ pair: structuredClone(runtimePair), container: 'a'.repeat(64), observedAt: now }),
    clock: () => now, sleep: async ms => { now += ms; } };
  return { deps, calls, shell, submitted, get options() { return options; }, get broker() { return brokerInfo; },
    get closed() { return closed; }, connect: extra => connectSetupHA({ ssh_host: 'synthetic-ha' }, { ...deps, ...extra }) };
}

test('configuration copying retains sparse provider settings while resetting host-local paths and proof', () => {
  const source = { controller: { input: 'mqtt', h66_verification_file: '/ha/private-proof.json' }, web: { https_directory: '/ha/https' },
    recording: { backup_directory: '/ha/backups' }, mqtt: { address: 'mqtt://core-mosquitto', user: 'synthetic-user', pw: 'synthetic-private-secret' },
    pair: { pair_id: 'synthetic-pair', directory: '/ha/pair', snapshot_directory: '/ha/snapshots', vip_socket: '/ha/socket', vip_interface: 'end0' },
    mirror: { directory: '/ha/mirror' } };
  const original = structuredClone(source);
  const result = prepareConfigurationForHost(source, { destination: 'linux',
    existing: { pair: { directory: '/linux/pair' } },
    mqtt: { address: 'mqtt://127.0.0.1', ha: { address: 'mqtt://192.0.2.10', user: 'synthetic-ha', pw: 'synthetic-password' } },
    pair: { vip_socket: '/run/st-mq-vip/socket', vip_interface: 'eth0', peer_url: 'http://192.0.2.10:1244' } });
  assert.deepEqual(source, original);
  assert.equal(result.options.mqtt.pw, source.mqtt.pw);
  assert.equal(result.options.pair.directory, '/linux/pair');
  assert.equal(result.options.pair.snapshot_directory, undefined);
  assert.equal(result.options.controller.h66_verification_file, undefined);
  assert.equal(result.options.web.https_directory, undefined);
  assert.equal(result.options.recording.backup_directory, undefined);
  assert.equal(result.options.mirror, undefined);
  assert.deepEqual(result.options.mqtt.ha, { address: 'mqtt://192.0.2.10', user: 'synthetic-ha', pw: 'synthetic-password' });
  assert.equal(result.options.controller.max_drop_c, undefined, 'does not expand public defaults');
  assert(result.localFieldsReset.includes('controller.h66_verification_file'));
  assert(result.localFieldsReset.includes('mirror'));
});

test('HA adaptation preserves destination storage and explicitly clears Linux-only socket and secondary broker', () => {
  const source = { mqtt: { address: 'mqtt://127.0.0.1', ha: { address: 'mqtt://192.0.2.10', user: 'synthetic', pw: 'synthetic-secret' } },
    pair: { directory: '/linux/pair', snapshot_directory: '/linux/snapshots', vip_socket: '/run/st-mq-vip/socket' } };
  const result = prepareConfigurationForHost(source, { destination: 'ha', existing: { pair: { directory: '/ha/existing-pair' } },
    mqtt: { address: 'mqtt://core-mosquitto' }, pair: { vip_interface: 'end0' } });
  assert.equal(result.options.pair.directory, '/ha/existing-pair');
  assert.equal(result.options.pair.snapshot_directory, undefined);
  assert.equal(result.options.pair.vip_socket, '');
  assert.deepEqual(result.options.mqtt.ha, { address: '', user: '', pw: '' });
  assert.equal(result.options.mqtt.address, 'mqtt://core-mosquitto');
});

test('Linux import refuses unresolved HA secret references rather than transporting unusable credentials', () => {
  assert.throws(() => prepareConfigurationForHost({ mqtt: { pw: '!secret synthetic_password' } }, { destination: 'linux' }), error =>
    error instanceof HASetupError && /actual values/.test(error.message) && !error.message.includes('synthetic_password'));
});

test('HA discovery uses raw saved options and observes current pair identity without mutations', async () => {
  const f = fixture({ raw: { controller: { topology: 'pair' } } }); const session = await f.connect();
  assert.deepEqual(session.options, { controller: { topology: 'pair' } });
  assert.equal(session.initialRuntime.pair.nodeId, pair.nodeId);
  assert.deepEqual(session.interfaces, [{ name: 'eth0', primary: true, addresses: ['192.0.2.10/24'] }]);
  assert.equal(session.mqtt.installed, true); assert.equal(f.submitted.length, 0);
  assert.equal(session.mqtt.port, 1885);
  assert(f.shell[0].input.toString().includes('FILE_HASSIO_APPS'));
  await session.close(); assert.equal(f.closed, 1);
});

test('unavailable SSH permits local-only setup but malformed HA configuration never degrades silently', async () => {
  await assert.rejects(connectSetupHA({ ssh_host: 'synthetic-ha' }, { connect: async () => { throw new DeploymentTransportError('private'); } }),
    error => error instanceof HASetupUnavailableError && !error.message.includes('private'));
  const f = fixture({ raw: { retired: 'synthetic-private-value' } });
  await assert.rejects(f.connect({ schema: { controller: {} } }), error => error instanceof HASetupError
    && !(error instanceof HASetupUnavailableError) && !error.message.includes('synthetic-private-value'));
  assert.equal(f.closed, 1); assert.equal(f.submitted.length, 0);
});

test('reviewed HA configuration is backed up, stopped, saved and explicitly started once', async () => {
  const f = fixture(); const session = await f.connect();
  const next = structuredClone(app.options); next.pair.peer_url = 'http://192.0.2.20:1244';
  const result = await session.backupAndApply({ options: next });
  assert.match(result.backupPath, /^\/data\/st-mq-setup-backups\/[a-f0-9-]{36}$/);
  assert.equal(result.restartRequired, true);
  assert.deepEqual(f.submitted, [`/addons/${app.slug}/stop`, `/addons/${app.slug}/options`]);
  assert.deepEqual(f.options, next); assert.equal(f.options.mqtt.pw, app.options.mqtt.pw);
  assert(f.shell.find(call => call.input?.toString().includes("directory=Path('/data/st-mq-setup-backups')")));
  assert(f.shell.find(call => call.script.startsWith('docker container ls')));
  await session.start(); await session.start();
  assert.deepEqual(f.submitted, [`/addons/${app.slug}/stop`, `/addons/${app.slug}/options`, `/addons/${app.slug}/start`]);
  await session.close(); assert(f.shell.at(-1).script.startsWith('rmdir '));
});

test('unchanged HA configuration leaves the running app uninterrupted', async () => {
  const f = fixture(); const session = await f.connect();
  assert.deepEqual(await session.backupAndApply({ options: session.options }), { changed: false, restartRequired: false, backupPath: null });
  assert.deepEqual(await session.start(), { changed: false });
  assert.deepEqual(f.submitted, []); await session.close();
});

test('Supervisor validation failure does not stop the app or expose its private response', async () => {
  const f = fixture(); const api = f.deps.supervisor();
  const session = await f.connect({ supervisor: () => async (...args) => args[0].endsWith('/options/validate')
    ? { valid: false, message: 'synthetic-private-validation' } : api(...args) });
  await assert.rejects(session.backupAndApply({ options: {} }), error => /rejected/.test(error.message) && !error.message.includes('synthetic-private-validation'));
  assert.deepEqual(f.submitted, []); assert(!f.shell.some(call => call.script.includes('mkdir'))); await session.close();
});

test('app version change after review prevents all remote mutations', async () => {
  const f = fixture({ afterInfo: (value, calls) => calls.filter(c => c.path.endsWith('/info') && c.path.includes(app.slug)).length > 1
    ? { ...value, version: '0.0.0' } : value }); const session = await f.connect();
  await assert.rejects(session.backupAndApply({ options: {} }), /identity, version or settings changed/);
  assert.deepEqual(f.submitted, []); await session.close();
});

test('lost Stop, Save and Start replies are uncertain and never replayed or cleaned up', async () => {
  for (const operation of ['stop', 'options', 'start']) {
    const f = fixture({ state: operation === 'start' ? 'stopped' : 'started', fail: ({ path, method }) => method === 'post' && path === `/addons/${app.slug}/${operation}` });
    const session = await f.connect();
    await assert.rejects(operation === 'start' ? session.start() : session.backupAndApply({ options: {} }), error =>
      error instanceof HASetupError && error.changed && error.uncertain && !error.message.includes('synthetic-private'));
    const count = f.calls.filter(call => call.method === 'post' && call.path === `/addons/${app.slug}/${operation}`).length;
    assert.equal(count, 1);
    await assert.rejects(session.start(), /session has failed/);
    await session.close(); assert(!f.shell.some(call => call.script.startsWith('rmdir ')));
  }
});

test('missing HA Mosquitto is installed and reviewed settings preserve unrelated broker options', async () => {
  const f = fixture({ broker: false }); const session = await f.connect();
  await session.backupAndApply({ options: app.options, installBroker: true, brokerOptions: { logins: [{ username: 'synthetic', password: 'synthetic-private-broker' }] } });
  assert.deepEqual(f.submitted.slice(0, 4), [`/addons/${app.slug}/stop`, '/store/addons/core_mosquitto/install', '/addons/core_mosquitto/options', '/addons/core_mosquitto/start']);
  assert.equal(f.broker.options.unrelated, 'retain');
  assert.deepEqual(f.broker.network, { '1883/tcp': 1885, '8883/tcp': 8883, '1884/tcp': null });
  assert.equal(f.broker.options.logins[0].username, 'synthetic'); await session.close();
});

test('existing HA broker host port conflict fails before any configuration or lifecycle changes', async () => {
  const f = fixture({ brokerNetwork: { '1883/tcp': 1883, '8883/tcp': 8883 } });
  await assert.rejects(f.connect(), error => /host port 1883 conflicts/.test(error.message) && !(error instanceof HASetupUnavailableError));
  assert.deepEqual(f.submitted, []); assert.equal(f.closed, 1);
  for (const network of [undefined, {}, { '1883/tcp': '1885' }, { '1883/tcp': 65536 }, { '1883/tcp': 1885, '8883/tcp': 1883 }])
    assert.throws(() => pairBrokerPort({ network }), /network settings|host port 1883/);
  assert.equal(pairBrokerPort({ network: { '1883/tcp': 1886 } }), 1886);
  assert.equal(pairBrokerPort({ network: { '1883/tcp': null } }), null, 'an explicitly disabled fixed port does not occupy VIP:1883');
});

test('new HA broker network mapping is reviewed separately and existing mappings cannot be silently changed', async () => {
  const f = fixture(); const existing = await f.connect();
  await assert.rejects(existing.backupAndApply({ options: app.options, brokerNetwork: { '1883/tcp': 1886 } }), /newly installed/);
  assert.deepEqual(f.submitted, []); await existing.close();
  const g = fixture({ broker: false }); const fresh = await g.connect();
  await fresh.backupAndApply({ options: app.options, installBroker: true, brokerOptions: { logins: [] }, brokerNetwork: { '1883/tcp': 1886 } });
  assert.deepEqual(g.broker.network, { '1883/tcp': 1886, '8883/tcp': 8883, '1884/tcp': null }); await fresh.close();
});

test('broker account updates preserve other existing device accounts', async () => {
  const f = fixture(); f.broker.options.logins = [{ username: 'retain-device', password: 'synthetic-old-password' },
    { username: 'setup-device', password: 'synthetic-before' }];
  const session = await f.connect();
  await session.backupAndApply({ options: app.options, brokerOptions: { logins: [{ username: 'setup-device', password: 'synthetic-after' }] } });
  assert.deepEqual(f.broker.options.logins, [{ username: 'retain-device', password: 'synthetic-old-password' },
    { username: 'setup-device', password: 'synthetic-after' }]);
  await session.close();
});

test('reviewed Start of an existing HA broker preserves configuration and never restarts an active broker', async () => {
  for (const active of [false, true]) {
    const f = fixture(); if (active) f.broker.state = 'started';
    const before = structuredClone(f.broker); const session = await f.connect();
    await session.backupAndApply({ options: app.options, startBroker: true });
    assert.deepEqual(f.broker.options, before.options); assert.deepEqual(f.broker.network, before.network);
    assert.equal(f.broker.state, 'started');
    assert.equal(f.submitted.filter(path => path === '/addons/core_mosquitto/start').length, active ? 0 : 1);
    assert(!f.submitted.includes('/addons/core_mosquitto/restart'));
    assert(!f.submitted.includes('/addons/core_mosquitto/options'));
    assert(f.submitted.indexOf(`/addons/${app.slug}/stop`) < f.submitted.indexOf('/addons/core_mosquitto/start') || active);
    await session.close();
  }
});

test('initial installed version mismatch fails before reading private configuration or mutation', async () => {
  const f = fixture();
  await assert.rejects(f.connect({ expectedVersion: '0.0.0' }), /versions differ/);
  assert.equal(f.shell.length, 0); assert.deepEqual(f.submitted, []);
});

test('authority drift after review refuses Stop and settings mutation', async () => {
  const f = fixture(); let reads = 0;
  const session = await f.connect({ readRuntime: async () => ({ pair: { ...pair, role: ++reads === 1 ? 'slave' : 'master' }, container: 'a'.repeat(64) }) });
  await assert.rejects(session.backupAndApply({ options: {} }), /authority or operation state changed/);
  assert.deepEqual(f.submitted, []); assert(!f.shell.some(call => call.script.includes('mkdir'))); await session.close();
});

test('cancellation immediately closes HA SSH and prohibits later setup operations', async () => {
  const f = fixture(), abort = new AbortController(); const session = await f.connect({ signal: abort.signal });
  abort.abort(); assert.equal(f.closed, 1);
  const before = f.shell.length;
  await assert.rejects(session.start(), /cancelled/);
  await assert.rejects(session.backupAndApply({ options: {} }), /cancelled/);
  await assert.rejects(session.promote({}), /cancelled/);
  assert.equal(f.shell.length, before); assert.deepEqual(f.submitted, []); await session.close();
});

test('initial promotion needs explicit confirmation and fresh matching bootstrap identity', async () => {
  const f = fixture(); const session = await f.connect(); const expectedIdentity = { nodeId: pair.nodeId, pairId: pair.pairId };
  await assert.rejects(session.promote({ expectedIdentity }), /explicit confirmation/);
  await assert.rejects(session.promote({ confirmed: true, expectedIdentity: { ...expectedIdentity, nodeId: 'other' } }), /no longer qualifies/);
  const result = await session.promote({ confirmed: true, expectedIdentity }); assert.deepEqual(result, { submitted: true });
  const submitted = f.shell.filter(call => call.script.startsWith('docker exec -i ') && call.script.includes('node --input-type=module'));
  assert.equal(submitted.length, 1); assert(!submitted[0].input.toString().includes(app.options.mqtt.pw));
  assert(submitted[0].input.toString().includes('ownsApplicationListener'));
  await session.close();
  const protectedPair = fixture({ runtimePair: { ...pair, bootstrapPending: false } }); const established = await protectedPair.connect();
  await assert.rejects(established.promote({ confirmed: true, expectedIdentity }), /no longer qualifies/); await established.close();
});

test('protected initial promotion supports retained standalone history without granting established pairs a conversion path', async () => {
  const currentPair = { ...pair, role: 'protected', bootstrapPending: false };
  const f = fixture({ raw: { controller: { topology: 'standalone' } }, runtimePair: currentPair });
  const session = await f.connect(); assert.equal(session.initialRuntime, null);
  const input = { confirmed: true, expectedIdentity: { nodeId: pair.nodeId, pairId: pair.pairId }, mode: 'protected-initial' };
  assert.deepEqual(await session.promote(input), { submitted: true }); await session.close();
  const establishedFixture = fixture({ runtimePair: currentPair }); const established = await establishedFixture.connect();
  await assert.rejects(established.promote(input), /eligible setup mode/); await established.close();
  const unavailable = fixture({ raw: { controller: { topology: 'standalone' } }, runtimePair: { ...currentPair, actions: { promote: false } } });
  const blocked = await unavailable.connect(); await assert.rejects(blocked.promote(input), /no longer qualifies/); await blocked.close();
});

test('promotion probe runs against an authenticated live disposable listener and rechecks authority before submitting', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'setup-ha-promotion-'));
  mkdirSync(join(directory, 'src/app'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'src/app/config.js'), 'export function loadConfig(){return{port:Number(process.env.SYNTHETIC_PORT),host:"127.0.0.1",token:process.env.SYNTHETIC_TOKEN,pair:{pairId:"synthetic-pair"}}}');
  writeFileSync(join(directory, 'src/main.js'), `import{createServer}from'node:http';
let count=0;const server=createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+process.env.SYNTHETIC_TOKEN){res.writeHead(401);res.end('{}');return;}
 if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(process.env.SYNTHETIC_PAIR);return;}
 let bytes='';for await(const chunk of req)bytes+=chunk;const action=JSON.parse(bytes),pair=JSON.parse(process.env.SYNTHETIC_PAIR);
 if(action.nodeId!==pair.nodeId||!Object.keys(action).every(key=>['action','nodeId','requestId','confirmed'].includes(key))){res.writeHead(409);res.end('{}');return;}
 if(action.action==='promote'&&action.confirmed===true)count++;
 res.writeHead(202);res.end('{}');console.log(JSON.stringify({submitted:count}));
});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  const env = { ...process.env, SYNTHETIC_TOKEN: 'synthetic-private-auth-token', SYNTHETIC_PAIR: JSON.stringify(pair) };
  const child = spawn(process.execPath, ['src/main.js'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); rmSync(directory, { recursive: true, force: true }); });
  let output = '';
  const port = await new Promise((resolve, reject) => { child.on('error', reject); child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0]).port); }); });
  const run = (expectedIdentity, patch = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module'], {
    input: promotionProgram({ expectedIdentity, requestId: '00000000-0000-4000-8000-000000000000' }, { directory, pid: child.pid }),
    cwd: directory, env: { ...env, SYNTHETIC_PORT: String(port), ...patch }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
  }));
  const expectedIdentity = { nodeId: pair.nodeId, pairId: pair.pairId };
  assert.deepEqual(run({ ...expectedIdentity, nodeId: 'other' }), { submitted: false });
  assert.deepEqual(run(expectedIdentity, { SYNTHETIC_TOKEN: 'synthetic-wrong-auth' }), { submitted: false });
  assert.deepEqual(run(expectedIdentity), { submitted: true });
});

test('emitted Supervisor snapshot reads sparse raw overrides and fails on malformed source without leaking values', t => {
  const directory = mkdtempSync(join(tmpdir(), 'linux-setup-ha-source-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'supervisor')); writeFileSync(join(directory, 'supervisor/__init__.py'), '');
  const statePath = join(directory, 'apps.json');
  writeFileSync(join(directory, 'supervisor/const.py'), `FILE_HASSIO_APPS=${JSON.stringify(statePath)}\n`);
  writeFileSync(statePath, JSON.stringify({ user: { [app.slug]: { options: { mqtt: { pw: 'synthetic-private-value' } } } } }));
  const run = program => execFileSync('python3', ['-c', program], { encoding: 'utf8', cwd: directory, env: { ...process.env, PYTHONPATH: directory } });
  const value = JSON.parse(run(savedOptionsProgram(app.slug))); assert.deepEqual(value, { ok: true, options: { mqtt: { pw: 'synthetic-private-value' } } });
  writeFileSync(statePath, 'synthetic-private-invalid-json'); assert.equal(run(savedOptionsProgram(app.slug)).trim(), '{"ok": false}');
});

test('snapshot code validates reviewed settings before writing private exclusive backups', t => {
  const directory = mkdtempSync(join(tmpdir(), 'linux-setup-ha-backup-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'supervisor')); writeFileSync(join(directory, 'supervisor/__init__.py'), '');
  const statePath = join(directory, 'apps.json'), backupRoot = join(directory, 'backups'), id = '00000000-0000-4000-8000-000000000000';
  writeFileSync(join(directory, 'supervisor/const.py'), `FILE_HASSIO_APPS=${JSON.stringify(statePath)}\n`);
  const options = { mqtt: { pw: 'synthetic-private-value' }, scalar: 0.0000001, unicode: 'synthetic-ä' };
  writeFileSync(statePath, JSON.stringify({ user: { [app.slug]: { options, boot: 'auto' } } }));
  const program = savedOptionsProgram(app.slug, { backupId: id, expectedOptions: options }).replace("'/data/st-mq-setup-backups'", JSON.stringify(backupRoot))
    .replace('st_uid==0', `st_uid==${process.getuid()}`);
  const run = code => execFileSync('python3', ['-c', code], { encoding: 'utf8', cwd: directory, env: { ...process.env, PYTHONPATH: directory } });
  assert.equal(JSON.parse(run(program)).ok, true);
  assert.equal(statSync(join(backupRoot, id)).mode & 0o777, 0o700);
  assert.equal(statSync(join(backupRoot, id, 'supervisor-options.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(backupRoot, id, 'supervisor-user.json'))), { options, boot: 'auto' });
  assert.equal(JSON.parse(run(program)).ok, false, 'exclusive backups are never overwritten');
  const changed = savedOptionsProgram(app.slug, { backupId: id, expectedOptions: { changed: true } }).replace("'/data/st-mq-setup-backups'", JSON.stringify(backupRoot));
  assert.equal(JSON.parse(run(changed)).ok, false, 'changed review options prevent backup');
});

test('saved installed schema must match this checkout before configuration or pairing changes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'linux-setup-ha-schema-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'supervisor')); writeFileSync(join(directory, 'supervisor/__init__.py'), '');
  const statePath = join(directory, 'apps.json');
  writeFileSync(join(directory, 'supervisor/const.py'), `FILE_HASSIO_APPS=${JSON.stringify(statePath)}\n`);
  writeFileSync(statePath, JSON.stringify({ user: { [app.slug]: { options: {} } }, system: { [app.slug]: { schema: { controller: { topology: 'str?' } } } } }));
  const run = schema => JSON.parse(execFileSync('python3', ['-c', savedOptionsProgram(app.slug, { expectedSchema: schema })],
    { encoding: 'utf8', cwd: directory, env: { ...process.env, PYTHONPATH: directory } }));
  assert.deepEqual(run({ controller: { topology: 'str?' } }), { ok: true, options: {} });
  assert.deepEqual(run({ controller: { topology: 'str' } }), { ok: false });
});

for (const lockExitCode of [73, 74]) test(`HA setup preserves actionable lock refusal ${lockExitCode} before changing app settings`, async () => {
  const f = fixture({ lockExitCode }), session = await f.connect();
  await assert.rejects(session.backupAndApply({ options: {} }), error => {
    assert(error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')));
    assert.match(error.message, /on HA in the SSH app/);
    assert.match(error.message, lockExitCode === 73 ? /lock already exists/ : /Could not create/);
    assert.equal(error.uncertain, false); assert.equal(error.changed, false);
    assert.doesNotMatch(error.message, /synthetic-private-command-detail|did not confirm a submitted operation/); return true;
  });
  assert.deepEqual(f.submitted, []); await session.close();
  assert(!f.shell.some(call => call.script.startsWith('rmdir ')));
});

test('HA setup lost lock and cleanup responses retain the exact location without replaying or exposing SSH details', async () => {
  for (const stage of ['acquire', 'cleanup']) {
    const f = fixture({ fail: ({ script }) => stage === 'acquire' ? script?.includes('if mkdir') : script?.startsWith('rmdir ') });
    const session = await f.connect();
    if (stage === 'cleanup') await session.backupAndApply({ options: {} });
    await assert.rejects(stage === 'acquire' ? session.backupAndApply({ options: {} }) : session.close(), error => {
      assert(error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')));
      assert.match(error.message, /not confirmed/); assert.equal(error.uncertain, true);
      assert.doesNotMatch(error.message, /synthetic-private-network-detail/); return true;
    });
    if (stage === 'acquire') await session.close();
    assert.equal(f.shell.filter(call => stage === 'acquire' ? call.script.includes('if mkdir') : call.script.startsWith('rmdir ')).length, 1);
  }
});

test('HA setup confirmed cleanup failure names its SSH-app lock and closes the session', async () => {
  const f = fixture({ cleanupExitCode: 1 }), session = await f.connect();
  await session.backupAndApply({ options: {} });
  await assert.rejects(session.close(), error => error.message.includes(JSON.stringify('/tmp/st-mq-deploy-synthetic_st-mq.lock')) && /could not be removed/.test(error.message));
  assert.equal(f.closed, 1);
});
