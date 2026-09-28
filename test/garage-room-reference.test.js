import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { createGarageModel, updateGarageModel, garageModelSummary, forecastGarage, replayGarageModel } from '../src/garage/model.js';
import { appendGarageEntry, applyGarageEntry, replayGarageJournal, garageDigest } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';

const HOUR = 3_600_000, START = Date.parse('2026-01-01T00:00:00Z');
const settings = garageSettings({ maxSensorAgeMs: HOUR });
const sample = (hour, extra = {}) => ({ at: START + hour * HOUR,
  rearC: 7, frontC: 6.5, outdoorC: 0, available: true, roomTargetC: 5,
  baselineAccepted: true, powerKw: .3, powerQuality: 'verified', ...extra });

test('normal warmth starts from the selected room setting and rejects the retired configured baseline', () => {
  for (const roomTargetC of [5, 5.5, 7, 16, 30.5, 31]) {
    const summary = garageModelSummary(createGarageModel({ seedAt: START, roomTargetC }));
    assert.equal(summary.normalReference.rearC, roomTargetC);
    assert.equal(summary.normalReference.frontC, roomTargetC);
    assert.equal(summary.normalReference.roomTargetC, roomTargetC);
    assert.equal(summary.normalReference.basis, 'selected-room-setting-not-measured-temperature');
    assert.equal(summary.normalReference.initialized, false);
  }
  assert.throws(() => createGarageModel({ baselineC: 10 }), /Unknown Garage seed option/);
  for (const roomTargetC of [undefined, NaN, Infinity, '7', -50, 4.5, 31.5, 65, 7.25])
    assert.throws(() => createGarageModel({ roomTargetC }), /valid selected room setting/);
});

test('sample and journal context room targets reject values outside the current half-degree setting contract', () => {
  const store = new Store(':memory:');
  try {
    const entry = appendGarageEntry(store, 'mqtt', 'context', { roomTargetC: 5 }, settings, START, { key: 'known-room-setting' });
    const checkpoint = applyGarageEntry(null, entry);
    for (const roomTargetC of [undefined, NaN, Infinity, '7', -50, 4.5, 31.5, 65, 7.25]) {
      assert.throws(() => updateGarageModel(checkpoint.model, sample(1, { roomTargetC }), settings), /valid selected room setting/);
      assert.throws(() => applyGarageEntry(checkpoint, { ...entry, id: entry.id + 1, at: START + HOUR,
        payload: { ...entry.payload, value: { roomTargetC } } }), /valid selected room setting/);
    }
    assert.equal(checkpoint.model.normalReference.roomTargetC, 5);
    assert.deepEqual(replayGarageJournal(store, 'mqtt'), checkpoint);
  } finally { store.close(); }
});

test('initial warmth remains the setting until observations qualify distinct learned front and rear references', () => {
  let model = createGarageModel({ seedAt: START, roomTargetC: 5 });
  for (let i = 0; i <= 38; i++) model = updateGarageModel(model, sample(i / 4), settings);
  assert.ok(model.normalReference.qualifiedHours > 0 && model.normalReference.qualifiedHours < 2);
  assert.equal(model.normalReference.interceptC, 5); assert.equal(model.normalReference.frontC, 5);
  for (let i = 39; i <= 48; i++) model = updateGarageModel(model, sample(i / 4), settings);
  assert.equal(model.normalReference.initialized, true);
  assert.equal(model.normalReference.interceptC, 7); assert.equal(model.normalReference.frontC, 6.5);
  assert.equal(model.normalReference.roomTargetC, 5);
  assert.equal(garageModelSummary(model).normalReference.basis, 'continuously-available-achieved-reference');
});

test('missing room intent stays unknown without fabricating recovery temperatures or blocking observed OFF cooling', () => {
  let model = createGarageModel({ seedAt: START });
  for (let i = 0; i <= 48; i++) model = updateGarageModel(model, sample(i / 4, { roomTargetC: null }), settings);
  const summary = garageModelSummary(model);
  assert.equal(summary.normalReference.rearC, null); assert.equal(summary.normalReference.frontC, null);
  assert.equal(summary.normalReference.basis, 'room-setting-unavailable');
  assert.equal(summary.normalReference.initialized, false);
  const steps = [false, true, true, false].map((available, i) => ({ start: START + i * HOUR,
    end: START + (i + 1) * HOUR, outdoorC: 0, available }));
  const forecast = forecastGarage(model, { now: START, steps });
  assert.ok(forecast.points[0].rearC > 0 && forecast.points[0].rearC < 7);
  for (const point of forecast.points.slice(1)) {
    assert.equal(point.rearC, null); assert.equal(point.frontC, null);
    assert.equal(point.rearLowerC, null); assert.equal(point.frontLowerC, null);
    assert.equal(point.state.differenceC, null);
  }
  for (let i = 49; i <= 60; i++) model = updateGarageModel(model,
    sample(i / 4, { roomTargetC: null, available: false, rearC: 7 * Math.exp(-.03 * (i - 48) / 4) }), settings);
  assert.ok(model.rear.samples > 0);
  assert.equal(model.validation.active.clean, false);
});

test('sample room changes reset normal service and validation while retaining measured cooling, with exact replay', () => {
  const seed = createGarageModel({ seedAt: START, roomTargetC: 5 });
  seed.rear.values[0] = .06; seed.front.values[0] = .08;
  const entries = Array.from({ length: 60 }, (_, i) => ({ observation: sample(i / 4), settings }));
  let model = replayGarageModel(seed, entries);
  assert.equal(model.normalReference.initialized, true); assert.equal(model.native.active[0], true);
  const cooled = { rear: structuredClone(model.rear), front: structuredClone(model.front) };
  const changed = { observation: sample(15, { roomTargetC: 9 }), settings };
  model = updateGarageModel(model, changed.observation, settings);
  assert.equal(model.normalReference.interceptC, 9); assert.equal(model.normalReference.frontC, 9);
  assert.equal(model.normalReference.initialized, false); assert.equal(model.native.active[0], false);
  assert.equal(model.native.hours, 0); assert.equal(model.heldOut.native.hours, 0);
  assert.deepEqual(model.rear, cooled.rear); assert.deepEqual(model.front, cooled.front);
  assert.deepEqual(model.validation.episodes, []); assert.equal(model.validation.active, null);
  assert.deepEqual(replayGarageModel(seed, [...entries, changed]), model);
  const unknown = updateGarageModel(model, sample(15.25, { roomTargetC: null }), settings);
  assert.equal(unknown.normalReference.interceptC, null); assert.equal(unknown.normalReference.frontC, null);
  assert.throws(() => updateGarageModel({ ...model, algorithm: 'committed-garage-v6-source-clocks' }, sample(16), settings), /Unsupported/);
});

test('journaled room changes, same-version restart and sensor/reference resets retain the selected setting exactly', () => {
  const store = new Store(':memory:');
  const changes = [{ id: 1, signal: 'garage_temperature', at: START + 2 * HOUR, settleUntil: START + 2 * HOUR, revertedAt: null }];
  const context = { changes, revision: garageDigest(changes) };
  let checkpoint = null;
  const append = (kind, value, hour) => {
    const entry = appendGarageEntry(store, 'mqtt', kind, value, settings, START + hour * HOUR, { key: `entry-${hour}` });
    checkpoint = applyGarageEntry(checkpoint, entry, context);
    return entry;
  };
  try {
    const first = append('context', { roomTargetC: 5 }, 0);
    assert.equal(first.payload.seed.normalReference.roomTargetC, 5);
    append('sample', sample(.25), .25);
    append('context', { normalReferenceReset: true, roomTargetC: 9 }, 1);
    assert.equal(checkpoint.model.normalReference.interceptC, 9);
    const restart = JSON.parse(JSON.stringify(checkpoint));
    assert.deepEqual(replayGarageJournal(store, 'mqtt', { context }), restart);
    const sensor = append('context', { sensorChangeId: 1 }, 2);
    assert.equal(checkpoint.model.normalReference.interceptC, 9); assert.equal(checkpoint.model.normalReference.frontC, 9);
    assert.deepEqual(applyGarageEntry(restart, sensor, context), checkpoint);
    append('context', { normalReferenceReset: true }, 3);
    assert.equal(checkpoint.model.normalReference.roomTargetC, 9);
    assert.equal(checkpoint.model.normalReference.interceptC, 9);
    assert.deepEqual(replayGarageJournal(store, 'mqtt', { context }), checkpoint);
    append('context', { roomTargetC: null }, 4);
    assert.equal(checkpoint.model.normalReference.interceptC, null);
    assert.deepEqual(replayGarageJournal(store, 'mqtt', { context }), checkpoint);
  } finally { store.close(); }
});

test('7 to 10 to 7 retains cooling evidence without restoring earlier target-specific warmth or cycle validation', () => {
  const store = new Store(':memory:');
  const seed = assignGaragePlanningEvidence(createGarageModel({ seedAt: START, roomTargetC: 7 }));
  seed.normalReference.interceptC = 7.4; seed.normalReference.frontC = 6.8;
  seed.rear.values[0] = .06; seed.front.values[0] = .08; seed.native.values[0] = .3;
  const cooling = model => ({ rear: model.rear, front: model.front,
    heldOut: Object.fromEntries(Object.entries(model.heldOut).filter(([key]) => key !== 'native')) });
  let checkpoint = null;
  try {
    for (const [index, roomTargetC] of [7, 10, 7].entries()) {
      const entry = appendGarageEntry(store, 'mqtt', 'context', { roomTargetC }, settings, START + index * HOUR,
        { key: `room-roundtrip-${index}`, seed });
      checkpoint = applyGarageEntry(checkpoint, entry);
      assert.deepEqual(cooling(checkpoint.model), cooling(seed));
      if (index > 0) {
        assert.equal(checkpoint.model.normalReference.interceptC, roomTargetC);
        assert.equal(checkpoint.model.normalReference.frontC, roomTargetC);
        assert.equal(checkpoint.model.normalReference.initialized, false);
        assert.equal(checkpoint.model.native.active[0], false);
        assert.equal(checkpoint.model.heldOut.native.hours, 0);
        assert.deepEqual(checkpoint.model.validation.episodes, []);
      }
    }
    assert.deepEqual(replayGarageJournal(store, 'mqtt'), checkpoint);
  } finally { store.close(); }
});

test('an unrelated configuration change preserves a learned reference established from the pump setting', async () => {
  const store = new Store(':memory:');
  const seed = createGarageModel({ seedAt: START, roomTargetC: 7 });
  seed.normalReference.initialized = true;
  seed.normalReference.interceptC = 7.4; seed.normalReference.frontC = 6.8;
  const entry = appendGarageEntry(store, 'mqtt', 'context', { roomTargetC: 7 }, settings, START,
    { key: 'known-native-room-setting', seed });
  const checkpoint = applyGarageEntry(null, entry);
  store.setState('garage:checkpoint:mqtt', checkpoint);
  store.setState('garage:configuration:mqtt', settings);
  let runtime;
  try {
    runtime = new GarageRuntime({ store, engine: { latest: {}, automationEnabled: () => false },
      config: { input: 'mqtt', garage: { ...settings, savingsStrategy: 'gentle' } }, clock: () => START + HOUR });
    assert.equal(runtime.status().learning.normalReference.roomTargetC, 7);
    assert.equal(runtime.status().learning.normalReference.rearC, 7.4);
    assert.equal(runtime.status().learning.normalReference.frontC, 6.8);
    assert.equal(runtime.status().learning.normalReference.initialized, true);
    assert.deepEqual(replayGarageJournal(store, 'mqtt').model, runtime.checkpoint.model);
  } finally { await runtime?.close({ restore: false }); store.close(); }
});
