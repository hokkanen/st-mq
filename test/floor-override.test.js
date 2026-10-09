import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorOverride, floorOverrideConfiguration } from '../src/control/floor-override.js';

const KEY = 'floor-override:v1';
function fixture(saved = null) {
  const publications = [], observations = [], writes = [];
  const store = { getState: key => key === KEY ? structuredClone(saved) : null,
    setState: (...args) => writes.push(args) };
  const adapter = createFloorOverride({ store,
    publish: (...args) => publications.push(args), onObservation: value => observations.push(value) });
  return { adapter, publications, observations, writes, store };
}

test('floor plan describes one SONOFF and four separately identified circuits without relay evidence', () => {
  const { adapter } = fixture(), status = adapter.status();
  assert.equal(status.integrationSupported, false);
  assert.equal(status.configured, false);
  assert.equal(status.available, false);
  assert.equal(status.enabled, false);
  assert.equal(status.commissioned, false);
  assert.equal(status.devices.length, 1);
  assert.equal(status.devices[0].model, 'SONOFF 4CH PRO R3');
  assert.equal(status.devices[0].group, 'groundfloor');
  assert.deepEqual(status.devices[0].channels, [
    { id: 1, label: 'Living', lengthM: 106, output: null },
    { id: 2, label: 'Living', lengthM: 62, output: null },
    { id: 3, label: 'Storage', lengthM: 38, output: null },
    { id: 4, label: 'Storage', lengthM: 80, output: null },
  ]);
});

test('unsupported activation and commissioning cannot be enabled through configuration', () => {
  assert.equal(floorOverrideConfiguration().devices.length, 1);
  for (const options of [{ enabled: true }, { commissioned: true }, { enabled: true, commissioned: true }])
    assert.throws(() => floorOverrideConfiguration(options), /supported floor-control integration is not available/);
  for (const options of [{ storage: {} }, { living: {} }, { device: { topic_prefix: 'fixture-floor' } }, { unknown: false }])
    assert.throws(() => floorOverrideConfiguration(options), /Unsupported floor override/);
});

test('connecting, requesting or receiving old readback cannot issue commands or establish SONOFF readiness', async () => {
  const f = fixture();
  f.adapter.setConnected(true);
  assert.deepEqual(f.adapter.topics, []);
  assert.equal(f.adapter.ingest('fixture-floor/stmq/floor/status', JSON.stringify({
    protocol: 'stmq-floor-v1', ready: true, clockOk: true, channels: [{ id: 0, output: true }, { id: 1, output: true }],
  })), false);
  await assert.rejects(f.adapter.lease({ owner: 'fixture-owner', until: Date.now() + 60_000 }), { code: 'FLOOR_UNSUPPORTED' });
  await f.adapter.tick();
  assert.equal(f.adapter.status().connected, false);
  assert.equal(f.adapter.status().active, false);
  assert.equal((await f.adapter.release()).released, true);
  await f.adapter.close();
  assert.deepEqual(f.publications, []);
  assert.deepEqual(f.observations, []);
  assert.deepEqual(f.writes, []);
});

test('an outstanding physical release survives shutdown and restart without writes or inferred confirmation', async () => {
  const saved = { version: 1, sequence: 7, outstanding: { owner: 'fixture-owner', leaseUntil: 1,
    brokerDigest: 'a'.repeat(64), devices: [{ topicPrefix: 'fixture-previous-device', channels: [0, 1] }] } };
  for (let restart = 0; restart < 2; restart++) {
    const f = fixture(saved);
    f.adapter.setConnected(true);
    assert.equal(f.adapter.status().restorationPending, true);
    assert.equal(f.adapter.status().devices.length, 1, 'A physical obligation is not another planned device');
    assert.equal(f.adapter.status().lastResult.status, 'release-pending');
    await assert.rejects(f.adapter.lease({ owner: 'fixture-new-owner' }), { code: 'FLOOR_PENDING' });
    for (const result of [await f.adapter.release(), await f.adapter.finishLease()]) {
      assert.equal(result.released, false);
      assert.equal(result.restorationPending, true);
    }
    await f.adapter.tick();
    await f.adapter.close({ restore: true });
    assert.deepEqual(f.store.getState(KEY), saved);
    assert.deepEqual(f.publications, []);
    assert.deepEqual(f.writes, []);
  }
});

test('unreadable obligation state remains uncertain and is never replaced with an empty state', async () => {
  for (const saved of [{}, { version: 99, outstanding: null }, 'invalid', [],
    ...[false, 0, '', []].map(outstanding => ({ version: 1, outstanding }))]) {
    const f = fixture(saved);
    assert.equal(f.adapter.status().stateUnknown, true);
    assert.equal(f.adapter.status().restorationPending, true);
    assert.equal((await f.adapter.release()).released, false);
    await assert.rejects(f.adapter.lease({ owner: 'fixture' }), { code: 'FLOOR_PENDING' });
    assert.deepEqual(f.writes, []);
  }
});

test('a failed durable-state read cannot report restoration complete', async () => {
  const adapter = createFloorOverride({ store: {
    getState() { throw new Error('fixture read failure'); }, setState() { assert.fail('State must remain untouched'); },
  } });
  assert.equal(adapter.status().stateUnknown, true);
  assert.equal(adapter.status().restorationPending, true);
  assert.equal((await adapter.release()).released, false);
  await assert.rejects(adapter.lease(), { code: 'FLOOR_PENDING' });
});
