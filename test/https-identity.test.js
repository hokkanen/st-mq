import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { installationBinding, helperLocations, restrictedEnvironment } from '../src/https/helper.js';

const machineId = '1234567890abcdef1234567890abcdef';
const otherMachineId = 'abcdef1234567890abcdef1234567890';
const environment = { SUPERVISOR_TOKEN: 'synthetic-supervisor-identity-token' };
const missingFiles = async () => { throw Object.assign(Error('Synthetic missing file'), { code: 'ENOENT' }); };
const supervisorResponse = id => new Response(JSON.stringify({ result: 'ok', data: { machine_id: id } }));

test('available local machine evidence retains its exact binding and never calls Supervisor', async () => {
  const paths = ['/sys/class/dmi/id/product_uuid', '/sys/firmware/devicetree/base/serial-number', '/etc/machine-id'];
  for (const [index, available] of paths.entries()) {
    const bytes = Buffer.from(index === 1 ? 'synthetic-board-serial\0' : 'synthetic-machine-identity\n');
    const reads = [];
    const digest = await installationBinding({ addon: true, environment,
      readIdentity: async path => { reads.push(path); if (path === available) return bytes; return missingFiles(); },
      fetchImpl: async () => assert.fail('Readable local evidence must not contact Supervisor') });
    assert.equal(digest, createHash('sha256').update(available).update('\0').update(bytes).digest('hex'));
    assert.deepEqual(reads, paths.slice(0, index + 1));
  }
});

test('an add-on with inaccessible machine files uses authenticated, source-tagged host identity', async () => {
  let requests = 0;
  const options = { addon: true, environment, readIdentity: missingFiles, fetchImpl: async (url, request) => {
    requests++;
    assert.equal(url, 'http://supervisor/info'); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${environment.SUPERVISOR_TOKEN}`);
    assert.ok(request.signal instanceof AbortSignal); assert.equal(request.signal.aborted, false);
    return supervisorResponse(machineId.toUpperCase());
  } };
  const first = await installationBinding(options);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, createHash('sha256').update('home-assistant:supervisor:machine_id').update('\0').update(machineId).digest('hex'));
  assert.equal(await installationBinding(options), first, 'Same host evidence survives a new lookup');
  assert.notEqual(await installationBinding({ ...options, fetchImpl: async () => supervisorResponse(otherMachineId) }), first);
  assert.equal(requests, 2);
  const helperEnv = restrictedEnvironment('/synthetic/helper');
  assert.equal('SUPERVISOR_TOKEN' in helperEnv, false);
  assert.equal(JSON.stringify(helperEnv).includes(machineId), false);
});

test('standalone and unauthenticated add-ons cannot manufacture an installation identity', async () => {
  for (const options of [{ addon: false, environment }, { addon: true, environment: {} }]) {
    await assert.rejects(installationBinding({ ...options, readIdentity: missingFiles,
      fetchImpl: async () => assert.fail('Supervisor is not authorized in this environment') }),
    { code: 'helper_installation_binding_unavailable' });
  }
});

test('invalid or unavailable Supervisor evidence fails closed without exposing response details', async t => {
  const cases = [
    ['null machine ID', () => supervisorResponse(null)],
    ['empty machine ID', () => supervisorResponse('')],
    ['zero machine ID', () => supervisorResponse('0'.repeat(32))],
    ['unknown machine ID shape', () => supervisorResponse('synthetic-hostname')],
    ['missing machine ID', () => new Response(JSON.stringify({ result: 'ok', data: {} }))],
    ['error envelope', () => new Response(JSON.stringify({ result: 'error', data: { machine_id: machineId } }))],
    ['scalar response', () => new Response('null')],
    ['invalid JSON', () => new Response('synthetic invalid JSON')],
    ['permission denied', () => new Response(environment.SUPERVISOR_TOKEN, { status: 403 })],
    ['redirect', () => new Response('', { status: 302, headers: { Location: 'https://example.invalid/' } })],
    ['transport unavailable', () => { throw Error(environment.SUPERVISOR_TOKEN); }],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    await assert.rejects(installationBinding({ addon: true, environment, readIdentity: missingFiles, fetchImpl: async () => response() }),
      error => error.code === 'helper_installation_binding_unavailable' && error.message === error.code);
  });
});

test('Supervisor response size is bounded while streaming and overflowing bodies are cancelled', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(installationBinding({ addon: true, environment, readIdentity: missingFiles, fetchImpl: async () => response }),
    { code: 'helper_installation_binding_unavailable' });
  assert.equal(cancelled, true);
});

test('manager cancellation reaches the authenticated identity request', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installationBinding({ addon: true, environment, signal: controller.signal, readIdentity: missingFiles,
    fetchImpl: async (_url, request) => { assert.equal(request.signal.aborted, true); request.signal.throwIfAborted(); } }),
  { code: 'helper_installation_binding_unavailable' });
});

test('the Supervisor deadline also bounds a response that stalls after its headers', { timeout: 10000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"result":"ok","data":');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/info`;
  await assert.rejects(installationBinding({ addon: true, environment, readIdentity: missingFiles,
    fetchImpl: (_url, options) => fetch(endpoint, options) }), { code: 'helper_installation_binding_unavailable' });
});

test('Supervisor-backed identity preserves marker bytes during loss, restart and changed-host fencing', async t => {
  const directory = await mkdtemp('/var/tmp/stmq-supervisor-identity-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const managerDirectory = resolve(directory, 'https'); const dataDir = resolve(directory, 'controller');
  await mkdir(managerDirectory, { mode: 0o700 });
  let id = machineId;
  const getInstallationBinding = options => installationBinding({ ...options, environment, readIdentity: missingFiles,
    fetchImpl: async () => supervisorResponse(id) });
  const options = { addon: true, getInstallationBinding };
  const locations = await helperLocations(dataDir, managerDirectory, options);
  t.after(() => rm(locations.socketDirectory, { recursive: true, force: true }));
  const marker = resolve(locations.identity, 'stmq-owner.json');
  const saved = await readFile(marker, 'utf8');
  assert.equal(JSON.stringify(locations).includes(machineId), false);
  assert.equal(JSON.stringify(locations).includes(environment.SUPERVISOR_TOKEN), false);
  await helperLocations(dataDir, managerDirectory, options); assert.equal(await readFile(marker, 'utf8'), saved);
  await assert.rejects(helperLocations(dataDir, managerDirectory, { addon: true,
    getInstallationBinding: settings => installationBinding({ ...settings, environment,
      readIdentity: async () => Buffer.from('synthetic-reappearing-local-source'), fetchImpl: async () => assert.fail('Local source takes precedence') }) }),
  { code: 'identity_restore_required' });
  assert.equal(await readFile(marker, 'utf8'), saved, 'A newly readable source cannot silently rebind the saved identity');
  id = null;
  await assert.rejects(helperLocations(dataDir, managerDirectory, { ...options, restoreFenced: true }),
    { code: 'helper_installation_binding_unavailable' });
  assert.equal(await readFile(marker, 'utf8'), saved, 'Fencing cannot replace missing host evidence');
  id = otherMachineId;
  await assert.rejects(helperLocations(dataDir, managerDirectory, options), { code: 'identity_restore_required' });
  assert.equal(await readFile(marker, 'utf8'), saved, 'Changed host retains the original marker until explicit restoration');
  await helperLocations(dataDir, managerDirectory, { ...options, restoreFenced: true });
  assert.ok(JSON.parse(await readFile(marker, 'utf8')).fencedRestoreConfirmedAt > 0);
  const missingDirectory = resolve(directory, 'absent', 'https'); id = null;
  await assert.rejects(helperLocations(dataDir, missingDirectory, options), { code: 'helper_installation_binding_unavailable' });
  await assert.rejects(lstat(dirname(missingDirectory)), { code: 'ENOENT' });
});
