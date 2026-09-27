import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { ocppInstallation } from '../src/acquisition/easee-ocpp-setup.js';
import { ocppHandoverHooks, probeOcppListener } from '../src/pairing/ocpp.js';

const configuration = () => ({ topology: 'pair', pair: { token: 'synthetic-ocpp-pair-token-0123456789',
  vip: { address: '192.0.2.81' } }, connections: { easee: { charger_id: 'SYNTHETIC-CHARGER',
  local_ocpp: { enabled: true, host: '0.0.0.0', port: 9001, authorization_tags: ['synthetic-tag'] } } } });
const setupState = config => ({ version: 1, scope: ocppInstallation(config).scope, ownedFingerprint: 'a'.repeat(64),
  appliedFingerprint: 'a'.repeat(64), adoptionFingerprint: null, intent: null, lastAppliedAt: 10,
  lastSuccessAt: 20, nextAttemptAt: 30, failures: 0 });

test('OCPP pairing hooks require matching derived credentials and probe before accepting readiness', async () => {
  const sourceConfig = configuration(), state = setupState(sourceConfig);
  const source = ocppHandoverHooks({ configuration: () => sourceConfig, store: () => ({ getState: key => {
    assert.equal(key, 'easee:ocpp-setup'); return state;
  } }) });
  const requirements = source.handoverRequirements();
  assert.match(requirements.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(requirements), /SYNTHETIC|192\.0\.2|synthetic/);
  let probes = 0;
  const targetConfig = configuration();
  const target = ocppHandoverHooks({ configuration: () => targetConfig, store: () => null, probe: async () => { probes++; } });
  await target.prepareHandover(requirements); assert.equal(probes, 1);
  targetConfig.pair.token += 'different';
  await assert.rejects(target.prepareHandover(requirements), { code: 'ocpp_handover_not_ready' });
  assert.equal(probes, 1, 'incompatible credentials are rejected before binding');
  await assert.rejects(target.prepareHandover(null), { code: 'ocpp_handover_not_ready' });
});

test('OCPP staged verification reads final setup state and rejects invalid state without mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'stmq-pair-ocpp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = configuration(), store = new Store(join(root, 'final.sqlite'));
  t.after(() => store.close());
  const hooks = ocppHandoverHooks({ configuration: () => config, store: () => store, probe: async () => {} });
  const requirements = hooks.handoverRequirements();
  const current = setupState(config), ledger = { activeId: 19, nextId: 20 };
  store.setState('easee:ocpp-setup', current); store.setState('easee:ocpp', ledger);
  hooks.verifyHandover({ dbPath: store.path, requirements });
  assert.deepEqual(store.getState('easee:ocpp'), ledger);
  const changed = { ...current, scope: 'b'.repeat(64) };
  store.setState('easee:ocpp-setup', changed);
  assert.throws(() => hooks.verifyHandover({ dbPath: store.path, requirements }), { code: 'ocpp_handover_not_ready' });
  assert.deepEqual(store.getState('easee:ocpp-setup'), changed);
  assert.throws(() => hooks.handoverRequirements(), { code: 'ocpp_handover_not_ready' });
});

test('pairing without local OCPP has no listener probe and rejects an unexpected descriptor', async () => {
  let probes = 0;
  const hooks = ocppHandoverHooks({ configuration: () => ({ connections: {} }), store: () => null,
    probe: async () => { probes++; } });
  assert.equal(hooks.handoverRequirements(), null);
  await hooks.prepareHandover(null); assert.equal(probes, 0);
  await assert.rejects(hooks.prepareHandover({ version: 1, digest: 'a'.repeat(64) }), { code: 'ocpp_handover_not_ready' });
});

test('standby port preflight catches a conflicting listener then releases its own probe', async t => {
  const server = createServer(socket => socket.destroy());
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  t.after(() => { if (server.listening) server.close(); });
  const config = configuration(), local = config.connections.easee.local_ocpp;
  local.port = server.address().port;
  local.host = config.pair.vip.address;
  await assert.rejects(probeOcppListener(config), { code: 'ocpp_handover_not_ready' });
  await new Promise(resolve => server.close(resolve));
  await probeOcppListener(config);
  server.listen(local.port, '0.0.0.0'); await once(server, 'listening');
  assert.equal(server.address().port, local.port);
});

test('disabled OCPP with outstanding restoration still probes its future peer listener', async () => {
  const config = configuration(); config.connections.easee.local_ocpp.enabled = false;
  const current = setupState(config);
  const source = ocppHandoverHooks({ configuration: () => config, store: () => ({ getState: () => current }) });
  const requirements = source.handoverRequirements();
  assert.match(requirements.digest, /^[a-f0-9]{64}$/);
  let probes = 0;
  const peerConfig = structuredClone(config);
  const peer = ocppHandoverHooks({ configuration: () => peerConfig, store: () => null, probe: async () => { probes++; } });
  await peer.prepareHandover(requirements); assert.equal(probes, 1);
  peerConfig.connections.easee.local_ocpp.port++;
  await assert.rejects(peer.prepareHandover(requirements), { code: 'ocpp_handover_not_ready' });
  assert.equal(probes, 1);
});
