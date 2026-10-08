import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { PairPeer, openEnvelope, sealEnvelope } from '../src/pairing/peer.js';

const options = { token: 'synthetic-pair-test-token-0123456789abcdef', pairId: 'test-pair', listenHost: '127.0.0.1', port: 0 };

test('paired transport encrypts household values and authenticates request-bound responses', async t => {
  const server = new PairPeer({ ...options, handler: (operation, body) => ({ operation, reading: body.reading }) });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual(await client.request('check', { reading: 21.375 }), { operation: 'check', reading: 21.375 });
  const key = createHash('sha256').update('fixture').digest();
  const encrypted = sealEnvelope({ household: 'invented-reading' }, key);
  assert.equal(encrypted.includes('invented-reading'), false);
  assert.deepEqual(openEnvelope(encrypted, key), { household: 'invented-reading' });
  assert.throws(() => openEnvelope(encrypted, key, 'different-response'), { code: 'peer_authentication_failed' });
  assert.throws(() => openEnvelope(JSON.stringify({ ...JSON.parse(encrypted), version: 1 }), key),
    { code: 'peer_authentication_failed' });
});

test('wrong key, replayed requests, plaintext routes and redirects are rejected', async t => {
  let handled = 0;
  const server = new PairPeer({ ...options, handler: () => ++handled });
  const address = await server.start(), origin = `http://127.0.0.1:${address.port}`;
  const wrong = new PairPeer({ ...options, token: 'different-synthetic-token-0123456789abcdef', peerUrl: origin });
  t.after(async () => { await wrong.close(); await server.close(); });
  await assert.rejects(wrong.request('status'), { code: 'peer_authentication_failed' });
  const key = createHash('sha256').update('st-mq paired transport\0').update(options.token).digest();
  const body = sealEnvelope({ id: 'one-use', pairId: options.pairId, at: Date.now(), operation: 'status' }, key);
  assert.equal((await fetch(`${origin}/v1/pair`, { method: 'POST', body })).status, 404);
  assert.equal((await fetch(`${origin}/v2/pair`, { method: 'POST', body })).status, 200);
  assert.equal((await fetch(`${origin}/v2/pair`, { method: 'POST', body })).status, 401);
  assert.equal((await fetch(`${origin}/v2/pair`)).status, 404);
  assert.equal((await fetch(`${origin}/v2/pair`, { method: 'POST', body: JSON.stringify({ token: options.token }) })).status, 401);
  assert.equal(handled, 1);
});

test('equipment contract mismatch crosses the peer boundary without private details', async t => {
  const server = new PairPeer({ ...options, handler: () => {
    throw Object.assign(new Error('private synthetic device details'), { code: 'mqtt_source_contract_mismatch' });
  } });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await client.close(); await server.close(); });
  await assert.rejects(client.request('handover-prepare'),
    { code: 'mqtt_source_contract_mismatch', message: 'mqtt_source_contract_mismatch' });
});

test('peer error output contains only fixed public codes', async t => {
  const server = new PairPeer({ ...options, handler: () => { throw new Error('private-device-example'); } });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await client.close(); await server.close(); });
  await assert.rejects(client.request('status'), { message: 'peer_protocol_failed', code: 'peer_protocol_failed' });
});

test('database compatibility and integrity errors cross encrypted transport without private details', async t => {
  let code;
  const server = new PairPeer({ ...options, handler: () => {
    throw Object.assign(Error('private synthetic database path and household record'), {
      code, privatePath: '/private/synthetic.sqlite', actualAlgorithm: 'private synthetic payload',
    });
  } });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await client.close(); await server.close(); });
  for (code of ['database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch',
    'database_state_incompatible', 'database_integrity_failed']) {
    await assert.rejects(client.request('snapshot'), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      assert.equal(error.privatePath, undefined);
      assert.equal(error.actualAlgorithm, undefined);
      return true;
    });
  }
});

test('encrypted operations use their explicit deadline and reuse connections after delayed replies', async t => {
  const server = new PairPeer({ ...options, handler: async operation => {
    if (operation === 'verify-checkpoint') await delay(100);
    return { checked: true };
  } });
  const address = await server.start();
  let connections = 0;
  server.server.on('connection', () => connections++);
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 25 });
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual(await client.request('verify-checkpoint', {}, { timeoutMs: 2000 }), { checked: true });
  assert.deepEqual(await client.request('status', {}, { timeoutMs: 2000 }), { checked: true });
  assert.equal(connections, 1, 'Completed replies return the socket to the scoped keep-alive agent');
  await assert.rejects(client.request('verify-checkpoint'), { code: 'peer_unavailable' });
});

test('cancelling a delayed response body releases the connection without waiting for the peer', async t => {
  let responseStarted, responseClosed;
  const started = new Promise(resolve => { responseStarted = resolve; });
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    response.once('close', responseClosed);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"version":');
    responseStarted();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController();
  const rejected = assert.rejects(client.request('verify-checkpoint', {}, { signal: controller.signal }),
    error => ['peer_unavailable', 'peer_protocol_failed'].includes(error.code));
  await started;
  controller.abort();
  await rejected;
  await closed;
  assert.equal(client.closed, false, 'Cancelling one request does not close the peer client');
});

test('peer close aborts a request awaiting response headers', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const server = new PairPeer({ ...options, handler: async () => { entered(); await held; return {}; } });
  const address = await server.start();
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${address.port}` });
  t.after(async () => { release(); await client.close(); await server.close(); });
  const rejected = assert.rejects(client.request('verify-checkpoint'), { code: 'stopped' });
  await started;
  await client.close();
  await rejected;
  await assert.rejects(client.request('status'), { code: 'stopped' });
});

test('native peer transport refuses redirects and bounds response bodies', async t => {
  let requests = 0, large = false;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    if (large) { response.writeHead(200); response.end('x'.repeat(2 * 1024 * 1024 + 1)); }
    else { response.writeHead(302, { Location: '/must-not-follow' }); response.end('ignored'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new PairPeer({ ...options, peerUrl: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(client.request('status'), { code: 'peer_protocol_failed' });
  assert.equal(requests, 1, 'The encrypted request must never follow a redirect');
  large = true;
  await assert.rejects(client.request('verify-checkpoint'), { code: 'peer_message_too_large' });
});
