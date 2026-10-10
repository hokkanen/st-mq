import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { getChartData } from '../src/app/chart-data.js';
import { seedVoltage } from './voltage-fixture.js';

const start = Date.parse('2026-10-05T06:00:00Z'), MINUTE = 60_000;
const query = (store, extra = {}) => getChartData({ store, input: 'providers', now: start + 60 * MINUTE,
  startDate: '2026-10-05', endDate: '2026-10-05', view: 'charging_currents', ...extra });
function energy(store, from, end, currents, extra = {}) {
  for (const [phase, current] of currents.entries()) store.observation({ source: 'easee', device: 'synthetic-property',
    signal: `property_energy_l${phase + 1}`, value: current === null ? null : current * 230 / 1000 * (end - from) / 3600_000,
    unit: 'kWh', sourceTime: end, receivedAt: end, quality: current === null ? ['missing'] : ['estimated'],
    raw: { intervalStart: from, intervalEnd: end, durationMs: end - from, basis: 'integrated-power-phase-allocation' }, ...extra });
}
const span = (from, end, phases) => ({ start: from, end, value: phases[0], phases });

test('highest-phase spans follow original voltage segments, exact ties and missing evidence', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  seedVoltage(store, start, [230, 230, 230]);
  seedVoltage(store, start + MINUTE / 2, [250, 230, 230]);
  energy(store, start, start + MINUTE, [10, 9.5, 6]);
  energy(store, start + MINUTE, start + 2 * MINUTE, [5, 12, 12]);
  energy(store, start + 2 * MINUTE, start + 3 * MINUTE, [5, null, 15]);
  energy(store, start + 4 * MINUTE, start + 5 * MINUTE, [5, 5, 12]);
  const before = store.observations({ limit: 100 });
  const chart = query(store);
  assert.deepEqual(chart.shading.propertyHighestPhase, [
    span(start, start + MINUTE / 2, [1]), span(start + MINUTE / 2, start + MINUTE, [2]),
    span(start + MINUTE, start + 2 * MINUTE, [2, 3]), span(start + 4 * MINUTE, start + 5 * MINUTE, [3]),
  ]);
  assert.deepEqual(chart.series.property_current_max.find(point => point.x === start + MINUTE).phases, [2, 3]);
  assert.deepEqual(chart.meta.propertyHighestPhase, { truncated: false });
  assert.deepEqual(store.observations({ limit: 100 }), before, 'Derived phase identity never writes more history');
  const detail = query(store, { viewFrom: start + 20_000, viewTo: start + 50_000 });
  assert.deepEqual(detail.shading.propertyHighestPhase, [span(start + 20_000, start + 30_000, [1]),
    span(start + 30_000, start + 50_000, [2])]);
});

test('phase identity never fills absent voltages, conflicting scopes or unavailable source receipts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  energy(store, start, start + MINUTE, [5, 10, 12]);
  assert.deepEqual(query(store).shading.propertyHighestPhase, []);
  seedVoltage(store, start, [230, 230, 230]);
  energy(store, start, start + MINUTE, [12, 10, 5], { device: 'conflicting-property' });
  energy(store, start + 2 * MINUTE, start + 3 * MINUTE, [5, 12, 10], { receivedAt: start + 4 * MINUTE });
  assert.deepEqual(query(store, { now: start + 3 * MINUTE }).shading.propertyHighestPhase, []);
  assert.deepEqual(query(store).shading.propertyHighestPhase, [span(start + 2 * MINUTE, start + 3 * MINUTE, [2])]);
});

test('dense phase changes retain bounded exact recent spans with an explicit zoom warning', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seedVoltage(store, start);
  for (let index = 0; index < 500; index++) {
    const currents = [2, 3, 4]; currents[index % 3] = 12;
    energy(store, start + index * 1000, start + (index + 1) * 1000, currents);
  }
  const chart = query(store, { points: 100 }), rows = chart.shading.propertyHighestPhase;
  assert.equal(rows.length, 200); assert.equal(rows[0].start, start + 300_000);
  assert.equal(chart.meta.propertyHighestPhase.truncated, true);
  assert(chart.meta.warnings.some(warning => /highest-phase detail.*Zoom in/.test(warning)));
  for (const row of rows) {
    const index = (row.start - start) / 1000;
    assert.deepEqual(row, span(start + index * 1000, start + (index + 1) * 1000, [index % 3 + 1]));
  }
  const detail = query(store, { points: 100, viewFrom: start + 100_100, viewTo: start + 102_500 });
  assert.equal(detail.meta.propertyHighestPhase.truncated, false);
  assert.deepEqual(detail.shading.propertyHighestPhase, [span(start + 100_100, start + 101_000, [2]),
    span(start + 101_000, start + 102_000, [3]), span(start + 102_000, start + 102_500, [1])]);
});

test('equal-phase intervals coalesce without losing tie metadata or concealing gaps', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); seedVoltage(store, start);
  energy(store, start, start + MINUTE, [10, 10, 10]);
  energy(store, start + MINUTE, start + 2 * MINUTE, [12, 12, 12]);
  energy(store, start + 2 * MINUTE, start + 3 * MINUTE, [12, 12 + 1e-7, 5]);
  energy(store, start + 4 * MINUTE, start + 5 * MINUTE, [5, 12, 5]);
  assert.deepEqual(query(store).shading.propertyHighestPhase, [span(start, start + 2 * MINUTE, [1, 2, 3]),
    span(start + 2 * MINUTE, start + 3 * MINUTE, [2]), span(start + 4 * MINUTE, start + 5 * MINUTE, [2])]);
});

test('supported CSV snapshots retain phase identity in compact queries and stop at unavailable history', async t => {
  const store = new Store(':memory:'), directory = mkdtempSync(join(tmpdir(), 'property-phase-csv-'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'easee.csv');
  writeFileSync(path, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
    `${start / 1000},0,0,0,12,5,5`, `${(start + MINUTE) / 1000},0,0,0,5,12,12`,
    `${(start + 2 * MINUTE) / 1000},0,0,0,5,5,12`, `${(start + 40 * MINUTE) / 1000},0,0,0,12,5,5`,
    `${(start + 41 * MINUTE) / 1000},0,0,0,5,,12`, `${(start + 42 * MINUTE) / 1000},0,0,0,5,5,12`,
  ].join('\n'));
  await importCsv(store, path, { kind: 'easee' });
  const now = Date.now(), expected = [span(start, start + MINUTE, [1]), span(start + MINUTE, start + 2 * MINUTE, [2, 3])];
  assert.deepEqual(query(store, { now }).shading.propertyHighestPhase, expected);
  assert.deepEqual(query(store, { now, startDate: '2026-09-01' }).shading.propertyHighestPhase, expected);
  const detail = query(store, { now, viewFrom: start + 20_000, viewTo: start + 90_000 });
  assert.deepEqual(detail.shading.propertyHighestPhase, [span(start + 20_000, start + MINUTE, [1]),
    span(start + MINUTE, start + 90_000, [2, 3])]);
});

test('the original snapshot phase ends exactly where recorded energy takes over', async t => {
  const store = new Store(':memory:'), directory = mkdtempSync(join(tmpdir(), 'property-phase-handover-'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'easee.csv');
  writeFileSync(path, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
    `${start / 1000},0,0,0,12,5,5`, `${(start + MINUTE) / 1000},0,0,0,5,12,5`,
    `${(start + 3 * MINUTE) / 1000},0,0,0,12,5,5`,
  ].join('\n'));
  await importCsv(store, path, { kind: 'easee' }); seedVoltage(store, start);
  energy(store, start + 2 * MINUTE, start + 4 * MINUTE, [5, 5, 12]);
  assert.deepEqual(query(store, { now: Date.now() }).shading.propertyHighestPhase, [span(start, start + MINUTE, [1]),
    span(start + MINUTE, start + 2 * MINUTE, [2]), span(start + 2 * MINUTE, start + 4 * MINUTE, [3])]);
});
