import test from 'node:test';
import assert from 'node:assert/strict';
import { PairManager } from '../src/pairing/manager.js';
import { PairPeer } from '../src/pairing/peer.js';

const localManager = hooks => ({ closed: false, stopping: false,
  state: { invalid: false, value: { reset: null } }, hooks });

test('web certificate peer operations have independent node hooks and reject unexpected metadata', async () => {
  let received;
  const manager = localManager({
    webCertificateStatus: () => ({ enabled: true, ownerId: 'owner-node' }),
    webCertificateGet: () => ({ hostname: 'example.example-tailnet.ts.net', generation: 3 }),
    webCertificateReceive: value => { received = value; return { installed: true }; },
  });
  const handle = (op, body = {}) => PairManager.prototype.handlePeer.call(manager, op, body);
  assert.deepEqual(await handle('https-status'), { enabled: true, ownerId: 'owner-node' });
  assert.equal((await handle('https-get')).generation, 3);
  const envelope = { pairId: 'fixture-pair', ownerId: 'owner-node', generation: 4 };
  assert.deepEqual(await handle('https-receive', envelope), { installed: true });
  assert.equal(received, envelope);
  await assert.rejects(handle('https-get', { url: 'https://unapproved.invalid' }), { code: 'peer_protocol_failed' });
  manager.state.invalid = true;
  assert.equal((await handle('https-status')).enabled, true);
  await assert.rejects(handle('https-receive', envelope), { code: 'protected_history' });
});

test('certificate material travels only in the existing authenticated encrypted pair envelope', async t => {
  const privateFixture = 'synthetic-private-certificate-key-not-a-real-key';
  const server = new PairPeer({ token: 'synthetic-pair-secret-at-least-thirty-two-characters', pairId: 'https-fixture',
    listenHost: '127.0.0.1', port: 0,
    handler: async (operation, body) => {
      assert.equal(operation, 'https-receive');
      assert.equal(body.certificate.key, privateFixture);
      return { generation: body.generation };
    } });
  await server.start();
  t.after(() => server.close());
  let encrypted;
  const client = new PairPeer({ token: 'synthetic-pair-secret-at-least-thirty-two-characters', pairId: 'https-fixture',
    peerUrl: `http://127.0.0.1:${server.server.address().port}`,
    fetchImpl: (url, options) => { encrypted = options.body; return fetch(url, options); } });
  t.after(() => client.close());
  const result = await client.request('https-receive', { generation: 2, certificate: { key: privateFixture } });
  assert.equal(result.generation, 2);
  assert.equal(encrypted.includes(privateFixture), false);
  assert.equal(encrypted.includes('https-receive'), false);
});
