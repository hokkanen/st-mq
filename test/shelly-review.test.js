import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Envelope } from '../src/app/chart-data.js';
import { addShellyEnergy } from '../src/app/chart-shelly.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';

const HOUR = 3_600_000, start = Date.parse('2026-09-10T12:00:00Z');
const KEY = 'shelly:caravan-energy:v1';
const near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`);
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
function hour(store, index, value) {
  store.observation({ source: 'shelly-mqtt', device: 'caravan', signal: 'caravan_energy', value, unit: 'kWh',
    sourceTime: start + (index + 1) * HOUR, receivedAt: start + (index + 1) * HOUR, quality: [],
    raw: { intervalStart: start + index * HOUR, intervalEnd: start + (index + 1) * HOUR, coveredMs: HOUR } });
}

test('adjacent Caravan hours retain their starting values while a missing hour remains a real chart gap', t => {
  const store = fixture(t);
  hour(store, 0, 1); hour(store, 1, 2); hour(store, 3, 3);
  const range = { from: start, to: start + 4 * HOUR };
  const envelope = new Envelope(range.from, range.to, 200);
  addShellyEnergy({ store, range, now: range.to, input: 'mqtt', envelopes: { caravan_energy: envelope } });
  const values = envelope.values();
  assert.equal(values.find(row => row.x === start + HOUR)?.y, 2,
    'A prior hour end marker must not mask the next hour start');
  assert(values.filter(row => row.x < start + 2 * HOUR).every(row => Number.isFinite(row.y)));
  assert.equal(values.find(row => row.x === start + 2 * HOUR)?.y, null);
  assert.equal(values.find(row => row.x === start + 3 * HOUR - 1)?.y, null);
  assert.equal(values.find(row => row.x === start + 3 * HOUR)?.y, 3);
  assert.equal(values.at(-1).x, range.to); assert.equal(values.at(-1).y, null);
});

test('a rolled-back boundary counter update can be retried without losing or doubling Caravan energy', t => {
  const store = fixture(t), energy = createCaravanEnergy({ store, device: 'invented-plug', maxGapMs: 120_000 });
  energy.receive(10, start - 30_000);
  const saved = store.getState(KEY), original = store.setState.bind(store);
  let fail = true;
  store.setState = (key, value) => {
    if (key === KEY && fail) { fail = false; throw new Error('Synthetic transaction rollback'); }
    return original(key, value);
  };
  assert.throws(() => energy.receive(10.01, start + 30_000), /Synthetic/);
  assert.deepEqual(store.getState(KEY), saved);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM observations WHERE signal='caravan_energy'").get().n, 0);
  energy.receive(10.01, start + 30_000);
  const rows = store.observations({ signal: 'caravan_energy' });
  assert.equal(rows.length, 1);
  near(rows[0].value, 0.005);
  near(energy.status(start + 30_000).dailyKwh, 0.01);
  assert.equal(store.getState(KEY).previous.at, start + 30_000);
});

test('a rolled-back hourly flush preserves the pending energy for the next maintenance tick', t => {
  const store = fixture(t), energy = createCaravanEnergy({ store, device: 'invented-plug', maxGapMs: 120_000 });
  energy.receive(10, start); energy.receive(10.01, start + 30_000);
  const original = store.setState.bind(store);
  let fail = true;
  store.setState = (key, value) => {
    if (key === KEY && fail) { fail = false; throw new Error('Synthetic transaction rollback'); }
    return original(key, value);
  };
  assert.throws(() => energy.tick(start + HOUR + 120_000), /Synthetic/);
  assert.equal(store.observations({ signal: 'caravan_energy' }).length, 0);
  energy.tick(start + HOUR + 120_000);
  const rows = store.observations({ signal: 'caravan_energy' });
  assert.equal(rows.length, 1); near(rows[0].value, 0.01);
  assert(rows[0].quality.includes('partial-coverage'));
});
