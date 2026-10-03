import test from 'node:test';
import assert from 'node:assert/strict';
import { createFloorOverride } from '../src/control/floor-override.js';
import { FLOOR_PREHEAT_SIGNALS } from '../src/domain/floor-circuits.js';
import { SIGNAL_INFO, RECORDED_EVIDENCE_SIGNALS } from '../src/domain/history-series.js';
import { recordedSignalInfo, recordingPolicy } from '../src/domain/recording-policy.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

test('planned floor circuits create no electrical observations from connection state or retired readback', async t => {
  const store = new Store(':memory:'), recorder = new Recorder(store);
  t.after(() => store.close());
  const adapter = createFloorOverride({ store, publish: () => assert.fail('No floor protocol is implemented'),
    onObservation: observation => recorder.record(observation) });
  adapter.setConnected(true);
  adapter.ingest('fixture-floor/stmq/floor/status', JSON.stringify({ protocol: 'stmq-floor-v1',
    ready: true, clockOk: true, boot: 1, channels: [0, 1].map(id => ({ id, output: false })) }));
  await adapter.tick();
  await adapter.release();
  adapter.setConnected(false);
  await adapter.close();
  for (const signal of FLOOR_PREHEAT_SIGNALS) assert.deepEqual(store.observations({ signal }), []);
});

test('four circuit histories have new identities and describe pipe length separately from physical feedback', () => {
  assert.deepEqual(FLOOR_PREHEAT_SIGNALS, [1, 2, 3, 4].map(id => `floor_groundfloor_${id}_active`));
  const labels = ['Living 106 m', 'Living 62 m', 'Storage 38 m', 'Storage 80 m'];
  FLOOR_PREHEAT_SIGNALS.forEach((signal, index) => {
    assert(RECORDED_EVIDENCE_SIGNALS.includes(signal));
    assert.equal(recordedSignalInfo(signal).label, `${labels[index]} · floor circuit ${index + 1}`);
    assert.match(recordedSignalInfo(signal).basis, /does not prove valve position or water flow/);
    assert.equal(recordingPolicy({ signal, unit: 'state' }).id, 'change-only');
  });
  for (const group of ['storage', 'living']) for (const id of [0, 1]) {
    const signal = `floor_${group}_${id}_active`;
    assert.equal(Object.hasOwn(SIGNAL_INFO, signal), false, 'No alias reinterprets retired output history as SONOFF feedback');
    assert.equal(RECORDED_EVIDENCE_SIGNALS.includes(signal), false);
  }
});
