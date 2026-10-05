import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { recordedChargingEnergy } from '../src/charging/energy.js';
import { compareRecordedChargingEnergy } from '../src/acquisition/recorded-charging-energy.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { Envelope } from '../src/app/chart-data.js';

const HOUR = 3_600_000, START = Date.parse('2026-09-01T00:00:00Z');
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close()); return store;
}
function save(store, from, to, { prefix = 'ev2', device = 'invented-charger', source = 'shelly-evse',
  energies = [1, 2, 0], gap = false, quality = gap ? ['missing', 'mqtt-disconnected'] : [],
  basis = gap ? 'availability-gap' : 'native-meter-counter-phase-allocation', phases = [1, 2, 3], received = to } = {}) {
  for (const phase of prefix === 'caravan' ? [1] : phases) store.observation({ source, device,
    signal: prefix === 'caravan' ? 'caravan_energy' : `${prefix}_energy_l${phase}`, unit: 'kWh',
    value: gap ? null : energies[phase - 1], sourceTime: START + to * HOUR, receivedAt: START + received * HOUR, quality,
    raw: { basis, intervalStart: START + from * HOUR, intervalEnd: START + to * HOUR } });
}
function groups(store, extra = {}) {
  return [...recordedEnergyGroups(store, { from: START, to: START + 10 * HOUR, now: START + 10 * HOUR,
    input: 'providers', prefix: 'ev2', ...extra })];
}
const summary = rows => rows.map(row => [(row.start - START) / HOUR, (row.end - START) / HOUR,
  row.conflict ? 'conflict' : row.values.every(Number.isFinite) ? row.values.reduce((a, b) => a + b, 0) : 'unknown']);

test('explicit outages retain only uncovered unknown spans around complete measurements without altering observations', t => {
  for (const device of ['invented-charger', 'invented-other-route']) {
    const store = fixture(t);
    save(store, 0, 6, { gap: true, device });
    save(store, 1, 2);
    save(store, 3, 4, { energies: [0, 0, 0] });
    const before = store.db.prepare('SELECT * FROM observations ORDER BY id').all();
    assert.deepEqual(summary(groups(store)), [[0, 1, 'unknown'], [1, 2, 3], [2, 3, 'unknown'], [3, 4, 0], [4, 6, 'unknown']]);
    assert.deepEqual(store.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
    const credit = recordedChargingEnergy(store, { id: 'charger2', start: START, end: START + 6 * HOUR });
    assert.equal(credit.gridKwh, 3); assert.equal(credit.coveredMs, 2 * HOUR); assert.equal(credit.incomplete, true);
    assert.deepEqual(compareRecordedChargingEnergy(store, { source: 'shelly-evse', device: 'invented-charger',
      prefix: 'ev2', start: START + HOUR, end: START + 2 * HOUR, now: START + 6 * HOUR }),
    { estimatedKwh: 3, edgeEstimated: false });
  }
});

test('outage overlaps do not bridge separate measured conflict clusters or hide incomplete phases', t => {
  const store = fixture(t);
  save(store, 0, 10, { gap: true });
  save(store, 1, 3);
  save(store, 2, 4, { device: 'invented-other-route' });
  save(store, 5, 6, { phases: [1, 2] });
  save(store, 7, 8);
  assert.deepEqual(summary(groups(store)), [[0, 1, 'unknown'], [1, 4, 'conflict'], [4, 5, 'unknown'],
    [5, 6, 'unknown'], [6, 7, 'unknown'], [7, 8, 3], [8, 10, 'unknown']]);
  const energy = recordedChargingEnergy(store, { id: 'charger2', start: START, end: START + 10 * HOUR });
  assert.equal(energy.gridKwh, 3); assert.equal(energy.coveredMs, HOUR);
});

test('an outage and measurement with identical source and bounds remain separate evidence', t => {
  for (const gapFirst of [true, false]) {
    const store = fixture(t);
    save(store, 1, 2, { gap: gapFirst }); save(store, 1, 2, { gap: !gapFirst });
    assert.deepEqual(summary(groups(store)), [[1, 2, 3]]);
    assert.equal(store.observations().length, 6, 'Neither source record is deleted');
  }
});

test('nested, repeated and adjacent outage records never become conflicting energy', t => {
  const store = fixture(t);
  for (const [from, to, device] of [[0, 7, 'a'], [0, 7, 'a'], [1, 2, 'b'], [3, 5, 'b'], [7, 9, 'c']])
    save(store, from, to, { gap: true, device });
  save(store, 2, 3); save(store, 5, 8);
  const rows = groups(store);
  assert.ok(rows.every(row => !row.conflict));
  assert.deepEqual(rows.filter(row => row.values.every(Number.isFinite)).map(row => [row.start, row.end, row.values]),
    [[START + 2 * HOUR, START + 3 * HOUR, [1, 2, 0]], [START + 5 * HOUR, START + 8 * HOUR, [1, 2, 0]]]);
  assert.equal(rows.filter(row => row.availabilityGap).reduce((sum, row) => sum + row.end - row.start, 0), 5 * HOUR);
});

test('invalid, retained and unmarked null cohorts remain conservative overlap evidence', t => {
  for (const other of [{ quality: ['retained'] }, { quality: ['invalid-numeric'] },
    { gap: true, basis: 'unknown' }, { gap: true, quality: ['missing', 'retained'] },
    { gap: true, quality: ['missing', 'invalid-value'] }]) {
    const store = fixture(t);
    save(store, 0, 3, { device: 'invented-other-route', ...other }); save(store, 1, 2);
    assert.deepEqual(summary(groups(store)), [[0, 3, 'conflict']]);
  }
});

test('source, receipt cutoff and simulation scope cannot borrow another stream to fill an outage', t => {
  const store = fixture(t);
  save(store, 0, 3, { gap: true });
  save(store, 1, 2, { device: 'invented-other-route', received: 4 });
  save(store, 0, 3, { source: 'simulation' });
  assert.deepEqual(summary(groups(store, { now: START + 3 * HOUR })), [[0, 3, 'unknown']]);
  assert.deepEqual(summary(groups(store, { device: 'invented-charger' })), [[0, 3, 'unknown']]);
  assert.deepEqual(summary(groups(store, { input: 'simulated' })), [[0, 3, 3]]);
  assert.deepEqual(summary(groups(store)), [[0, 1, 'unknown'], [1, 2, 3], [2, 3, 'unknown']]);
});

test('pending intervals and independent physical channels resolve against outages using the same rules', t => {
  const store = fixture(t), recorder = new Recorder(store);
  for (const prefix of ['ev1', 'ev2', 'property', 'caravan']) {
    save(store, 0, 4, { prefix, gap: true, source: prefix === 'ev2' ? 'shelly-evse' : 'easee', device: 'outage-route' });
    for (let hour = 1; hour < 3; hour++) recorder.recordEnergy({ prefix, source: prefix === 'ev2' ? 'shelly-evse' : 'easee',
      device: 'live-route', start: START + hour * HOUR, end: START + (hour + 1) * HOUR,
      powers: prefix === 'caravan' ? [2] : [1, 2, 0], energies: prefix === 'caravan' ? [2] : [1, 2, 0] });
    const rows = groups(store, { prefix });
    assert.deepEqual(summary(rows), [[0, 1, 'unknown'], [1, 2, prefix === 'caravan' ? 2 : 3],
      [2, 3, prefix === 'caravan' ? 2 : 3], [3, 4, 'unknown']]);
    assert.equal(rows[2].pending, true);
  }
});

test('chart projects recovered coverage and actual outage residuals without changing measured interval bounds', t => {
  const store = fixture(t); save(store, 0, 3, { gap: true }); save(store, 1, 2);
  const range = { from: START, to: START + 3 * HOUR }, line = new Envelope(range.from, range.to, 100), credits = [];
  addRecordedEnergy({ store, range, now: range.to, input: 'providers', envelopes: { charger2_power: line },
    timing: { addEnergy(...args) { credits.push(args); } } });
  assert.deepEqual(credits.map(row => row.slice(0, 4)), [['charger2', START + HOUR, START + 2 * HOUR, 3]]);
  const points = line.values();
  assert.ok(points.some(row => row.x === START && row.y === null));
  assert.ok(points.some(row => row.x === START + HOUR && row.y === 3));
  assert.ok(points.some(row => row.x === START + 2 * HOUR && row.y === null));
});
