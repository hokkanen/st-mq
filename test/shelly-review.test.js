import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';

const HOUR = 3_600_000, start = Date.parse('2026-09-10T12:00:00Z');
const KEY = 'shelly:caravan-energy:v2';
const near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`);
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const recorder = new Recorder(store);
  const energy = createCaravanEnergy({ store, recorder, device: 'invented-plug', maxGapMs: 120_000 });
  return { store, recorder, energy, measured: () => store.observations({ signal: 'caravan_energy' }).filter(row => Number.isFinite(row.value)) };
}

test('Caravan adaptive archive reduces steady measurements and reacts to load changes without losing energy', t => {
  const { recorder, energy, measured } = fixture(t);
  energy.receive(10, start);
  for (let index = 1; index <= 10; index++) energy.receive(10 + index * 0.005, start + index * 30_000);
  assert(measured().length < 10, 'Steady meter reports are compacted by the common adaptive recorder');
  const count = measured().length;
  energy.receive(10.075, start + 330_000);
  assert(measured().length > count, 'A changed measured interval power commits promptly');
  recorder.flush(start + 330_000, { force: true });
  near(measured().reduce((sum, row) => sum + row.value, 0), 0.075);
  near(energy.status(start + 330_000).dailyKwh, 0.075);
  assert(measured().every(row => row.raw.basis === 'meter-counter-delta' && row.raw.learningRole === 'history-only'));
});

test('a rolled-back counter update can be retried without losing or doubling Caravan energy', t => {
  const { store, energy, measured } = fixture(t);
  energy.receive(10, start - 30_000);
  const saved = store.getState(KEY), original = store.setState.bind(store);
  let fail = true;
  store.setState = (key, value) => {
    if (key === KEY && fail) { fail = false; throw new Error('Synthetic transaction rollback'); }
    return original(key, value);
  };
  assert.throws(() => energy.receive(10.01, start + 30_000), /Synthetic/);
  assert.deepEqual(store.getState(KEY), saved);
  assert.equal(measured().length, 0);
  energy.receive(10.01, start + 30_000);
  assert.equal(measured().length, 1);
  near(measured()[0].value, 0.01);
  near(energy.status(start + 30_000).dailyKwh, 0.01);
  assert.equal(store.getState(KEY).previous.at, start + 30_000);
});

test('a rolled-back expiry flush retains pending energy and the exact outage boundary', t => {
  const { store, energy, measured } = fixture(t);
  energy.receive(10, start); energy.receive(10.005, start + 30_000); energy.receive(10.01, start + 60_000);
  const original = store.setState.bind(store), before = measured();
  let fail = true;
  store.setState = (key, value) => {
    if (key === KEY && fail) { fail = false; throw new Error('Synthetic transaction rollback'); }
    return original(key, value);
  };
  assert.throws(() => energy.tick(start + 180_000), /Synthetic/);
  assert.deepEqual(measured(), before);
  energy.tick(start + 180_000);
  near(measured().reduce((sum, row) => sum + row.value, 0), 0.01);
  assert.equal(measured().at(-1).raw.intervalEnd, start + 60_000);
  assert(store.observations({ signal: 'caravan_energy' }).some(row => row.value === null));
});

test('even a brief explicit outage creates a new counter baseline instead of spreading missing energy', t => {
  const { energy, measured, recorder } = fixture(t);
  energy.receive(10, start); energy.receive(10.005, start + 30_000);
  energy.unavailable(start + 31_000, 'mqtt-disconnected');
  energy.receive(10.02, start + 60_000);
  energy.receive(10.025, start + 90_000);
  recorder.flush(start + 90_000, { force: true });
  near(measured().reduce((sum, row) => sum + row.value, 0), 0.01);
  assert(!measured().some(row => row.raw.intervalStart < start + 60_000 && row.raw.intervalEnd > start + 30_000));
});

test('Caravan daily coverage follows Helsinki daylight-saving day boundaries', t => {
  const { energy } = fixture(t);
  const midnight = Date.parse('2026-10-25T22:00:00Z');
  energy.receive(1, midnight - 30_000); energy.receive(1.01, midnight + 30_000);
  near(energy.status(midnight + 30_000).dailyKwh, 0.005);
  assert.equal(energy.status(midnight + 30_000).day, '2026-10-26');
  assert.equal(energy.status(midnight + 30_000).coveredMs, 30_000);
  energy.tick(midnight + HOUR);
  assert.equal(energy.status(midnight + HOUR).partial, true);
});
