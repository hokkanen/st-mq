import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { createAppServer } from '../src/app/server.js';
import { createWebAccess } from '../src/app/web-access.js';

const firstToken = 'synthetic-first-web-access-token';
const secondToken = 'synthetic-second-web-access-token';
const authorization = token => ({ Authorization: `Bearer ${token}` });
const endpoint = server => `http://127.0.0.1:${server.address().port}`;
const configuration = changes => ({ addon: true, token: '', host: '127.0.0.1', port: 0,
  ingressHost: '127.0.0.1', ingressPort: 0, ...changes });

async function setup(t, config = configuration(), extra = {}) {
  const mutations = [];
  const engine = { status: () => ({ environment: 'history' }),
    setTemporary: input => { mutations.push(input); return { updated: true }; } };
  const access = createWebAccess({ config, engine, store: {},
    chartService: { overview: async () => ({ rows: [] }) }, ...extra });
  await access.start();
  t.after(() => access.close());
  return { access, config, mutations };
}

function simulateProxy(server, address = '172.30.32.2') {
  // The real ingress network is absent on a test host. Override only the
  // server-side socket identity, never a request header or production policy.
  server.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: address }));
}

test('add-on without a token starts only ingress, which rejects direct and spoofed proxy requests', async t => {
  const { access } = await setup(t);
  assert.equal(access.status().ingress.enabled, true);
  assert.equal(access.status().direct.enabled, false);
  assert.equal(access.server, access.ingressServer);
  for (const path of ['/', '/api/status']) {
    const response = await fetch(`${endpoint(access.ingressServer)}${path}`, { headers: {
      'X-Forwarded-For': '172.30.32.2', 'X-Real-IP': '172.30.32.2', 'X-Forwarded-Host': 'ha.invalid',
    } });
    assert.equal(response.status, 403);
  }
});

for (const address of ['172.30.32.2', '::ffff:172.30.32.2']) {
  test(`trusted ingress ${address} accepts HA origin without a ST-MQ token`, async t => {
    const { access } = await setup(t, configuration({ token: firstToken }));
    simulateProxy(access.ingressServer, address);
    const base = endpoint(access.ingressServer);
    const headers = { 'X-Forwarded-Host': 'ha.invalid:8123', Origin: 'http://ha.invalid:8123' };
    const response = await fetch(`${base}/api/status`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal((await response.json()).environment, 'history');
    assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: 'http://untrusted.invalid' } })).status, 403);
  });
}

test('direct access enables, rotates and disables live while ingress remains running', async t => {
  const { access, config } = await setup(t);
  const ingress = access.ingressServer;
  const ingressPort = ingress.address().port;
  await access.apply({ ...config, token: firstToken });
  const direct = access.server;
  const base = endpoint(direct);
  assert.equal(access.status().direct.enabled, true);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(firstToken) })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: {
    ...authorization(firstToken), Origin: 'http://spoofed.invalid', 'X-Forwarded-Host': 'spoofed.invalid',
  } })).status, 403);
  await access.apply({ ...config, token: secondToken });
  assert.equal(access.server, direct);
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(firstToken) })).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: authorization(secondToken) })).status, 200);
  await access.apply(config);
  assert.equal(access.status().direct.enabled, false);
  assert.equal(direct.listening, false);
  assert.equal(access.ingressServer, ingress);
  assert.equal(ingress.address().port, ingressPort);
});

test('token changes reject a slow mutation authorized with the previous token', async t => {
  const { access, config, mutations } = await setup(t, configuration({ token: firstToken }));
  const received = once(access.server, 'request');
  const outgoing = request(`${endpoint(access.server)}/api/temporary`, { method: 'POST',
    headers: { ...authorization(firstToken), 'Content-Type': 'application/json', 'Content-Length': '2' } });
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    outgoing.on('error', reject);
  });
  outgoing.write('{');
  await received;
  await access.apply({ ...config, token: secondToken });
  outgoing.end('}');
  assert.equal(await response, 401);
  assert.deepEqual(mutations, []);
});

test('JSON mutations preserve UTF-8 characters split across request chunks', async t => {
  const { access, mutations } = await setup(t, configuration({ token: firstToken }));
  const input = { label: 'Lämpö 🏠' };
  const payload = Buffer.from(JSON.stringify(input));
  const split = payload.indexOf(Buffer.from('ä')) + 1;
  const received = once(access.server, 'request');
  const outgoing = request(`${endpoint(access.server)}/api/temporary`, { method: 'POST',
    headers: { ...authorization(firstToken), 'Content-Type': 'application/json', 'Content-Length': payload.length } });
  t.after(() => outgoing.destroy());
  const response = new Promise((resolve, reject) => {
    outgoing.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    outgoing.on('error', reject);
  });
  outgoing.flushHeaders();
  const [incoming] = await received;
  const firstChunk = once(incoming, 'data');
  outgoing.write(payload.subarray(0, split));
  await firstChunk;
  outgoing.end(payload.subarray(split));
  assert.equal(await response, 200);
  assert.deepEqual(mutations, [input]);
});

test('a delayed read cannot return data after its token is revoked', async t => {
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  const { access, config } = await setup(t, configuration({ token: firstToken }), {
    chartService: { overview: () => { began(); return new Promise(resolve => { finish = resolve; }); } },
  });
  const response = fetch(`${endpoint(access.server)}/api/recording-overview`, { headers: authorization(firstToken) });
  await started;
  await access.apply({ ...config, token: secondToken });
  finish({ syntheticPrivateObservation: 123 });
  const result = await response;
  assert.equal(result.status, 401);
  assert.doesNotMatch(await result.text(), /syntheticPrivateObservation/);
});

test('a direct reload can remove its own token and complete without a close deadlock', async t => {
  let access;
  const config = configuration({ token: firstToken });
  ({ access } = await setup(t, config, { reloadSettings: async () => access.apply({ ...config, token: '' }) }));
  const direct = access.server;
  const response = await fetch(`${endpoint(direct)}/api/settings/reload`, {
    method: 'POST', headers: { ...authorization(firstToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewId: '00000000-0000-4000-8000-000000000000' }),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  assert.equal(access.status().direct.enabled, false);
  assert.equal(direct.listening, false);
});

test('preflight bind failure leaves ingress available; reservation denies access and can roll back', async t => {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => { if (blocker.listening) blocker.close(); });
  const port = blocker.address().port;
  const { access, config } = await setup(t, configuration({ port }));
  await assert.rejects(access.prepare({ ...config, token: firstToken }), { code: 'EADDRINUSE' });
  assert.equal(access.status().ingress.enabled, true);
  assert.equal(access.status().direct.enabled, false);
  await new Promise(resolve => blocker.close(resolve));
  const transaction = await access.prepare({ ...config, token: firstToken });
  const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: authorization(firstToken) });
  assert.equal(response.status, 503);
  await transaction.rollback();
  assert.equal(access.status().direct.enabled, false);
  await access.apply({ ...config, token: secondToken });
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`, { headers: authorization(secondToken) })).status, 200);
});

test('standalone loopback access remains token optional and accepts live token changes', async t => {
  const { access, config } = await setup(t, configuration({ addon: false }));
  const server = access.server;
  const base = endpoint(server);
  assert.equal(access.status().ingress.enabled, false);
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  await access.apply({ ...config, token: firstToken });
  assert.equal(access.server, server);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  await access.apply(config);
  assert.equal(access.server, server);
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
});

test('a reserved startup listener rejects API requests until the controller is ready', async t => {
  let starting = true, reads = 0;
  const { access, mutations } = await setup(t, configuration({ addon: false }), {
    settingsReloadStatus: () => ({ busy: starting }),
    getEngine: () => { reads++; assert.equal(starting, false); return { status: () => ({ environment: 'history' }) }; },
  });
  const base = endpoint(access.server);
  assert.equal((await fetch(`${base}/api/status`)).status, 503);
  assert.equal((await fetch(`${base}/api/temporary`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal(reads, 0);
  assert.deepEqual(mutations, []);
  starting = false;
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
  assert.ok(reads > 0);
});

test('an occupied ingress port identifies the ingress setting and leaves no direct listener', async t => {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const port = blocker.address().port;
  const access = createWebAccess({ config: configuration({ token: firstToken, ingressPort: port }),
    engine: { status: () => ({ environment: 'history' }) }, store: {},
    chartService: { overview: async () => ({ rows: [] }) } });
  t.after(() => access.close());
  await assert.rejects(access.start(), error => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.port, port);
    assert.match(error.message, /STMQ_INGRESS_PORT/);
    return true;
  });
  assert.equal(access.status().ingress.enabled, false);
  assert.equal(access.status().direct.enabled, false);
  assert.equal(blocker.listening, true);
});

test('invalid direct credentials and binding changes fail without changing active access', async t => {
  const { access, config } = await setup(t, configuration({ token: firstToken }));
  await assert.rejects(access.apply({ ...config, token: 'synthetic-short' }), /at least 24/);
  await assert.rejects(access.apply({ ...config, host: '0.0.0.0' }), /Restart/);
  assert.equal((await fetch(`${endpoint(access.server)}/api/status`, { headers: authorization(firstToken) })).status, 200);
  assert.throws(() => createWebAccess({ config: configuration({ addon: false, host: '0.0.0.0' }) }), /at least 24/);
});

test('standalone createAppServer remains compatible with a fixed token', async t => {
  const server = createAppServer({ token: firstToken, engine: { status: () => ({ environment: 'history' }) },
    chartService: { overview: async () => ({}) }, store: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  assert.equal((await fetch(`${endpoint(server)}/api/status`)).status, 401);
  assert.equal((await fetch(`${endpoint(server)}/api/status`, { headers: authorization(firstToken) })).status, 200);
});
