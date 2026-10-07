import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
