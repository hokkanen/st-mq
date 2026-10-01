import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { getChartData } from '../src/app/chart-data.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';
import { seedVoltage } from './voltage-fixture.js';

const HOUR = 3_600_000, MINUTE = 60_000, start = Date.parse('2026-09-08T08:00:00Z');
const base = { input: 'providers', now: start + 4 * HOUR, startDate: '2026-09-08', endDate: '2026-09-08' };
const pricing = {
  contract: { periods: [{ from: start - 24 * HOUR, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night',
    transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] },
  market: { fetchedAt: start, intervals: [{ start: start - 11 * HOUR, end: start + 13 * HOUR,
    spotCtPerKwh: 10, unit: 'c/kWh', vatIncluded: false, source: 'fixture' }] },
};
const query = (store, left, extra = {}) => getChartData({ store, ...base, left, ...extra });
const at = (rows, time) => rows.find(point => point.x === time)?.y;
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function energy(store, from = start, to = start + 2 * HOUR) {
  for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'easee', device: 'synthetic-charger',
    signal: `ev1_energy_l${phase}`, value: 2, unit: 'kWh', sourceTime: to, receivedAt: to, quality: ['estimated'],
    raw: { intervalStart: from, intervalEnd: to, durationMs: to - from, basis: 'integrated-power-phase-allocation' } });
}

test('energy stays available without voltage; equivalent currents split at historical phase-estimate changes', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); energy(store);
  const powerBefore = query(store, 'power'), unknown = query(store, 'phases');
  assert.equal(at(powerBefore.series.charger_power, start), 3);
  assert(unknown.series.ev1_current_l1.every(point => point.y === null));
  seedVoltage(store, start + HOUR / 2, [220, 225, 240]);
  seedVoltage(store, start + HOUR, [250, 225, 240]);
  const phases = query(store, 'phases');
  assert.equal(at(phases.series.ev1_current_l1, start), null, 'Future voltage never rewrites native energy history');
  near(at(phases.series.ev1_current_l1, start + HOUR / 2), 1000 / 220);
  assert.equal(at(phases.series.ev1_current_l1, start + HOUR), 4);
  near(at(phases.series.ev1_current_l2, start + HOUR), 1000 / 225);
  assert.deepEqual(query(store, 'power').series.charger_power, powerBefore.series.charger_power);
  assert.equal(query(store, 'phase_energy').series.ev1_energy_l1[0].y, 2);
  const point = phases.series.ev1_current_l1.find(point => point.x === start + HOUR);
  assert.equal(point.intervalStart, start); assert.equal(point.intervalEnd, start + 2 * HOUR);
  assert.equal(point.voltageV, 250); assert.equal(point.powerFactorAssumption, 1);
  const tooltip = historyTooltipLabel({ dataset: { key: 'ev1_current_l1', label: 'Charger 1 L1', unit: 'A' },
    parsed: { x: point.x, y: point.y }, raw: point });
  assert.match(tooltip, /unity power factor assumed/); assert.match(tooltip, /historical voltage estimate/);
  assert.match(tooltip, /250 V/);
});

test('CSV before voltage history uses the first mature estimates without changing imported currents', async t => {
  const store = new Store(':memory:'), directory = mkdtempSync(join(tmpdir(), 'voltage-csv-'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'easee.csv');
  writeFileSync(path, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
    `${start / 1000},10,10,10,12,12,12`, `${(start + 30 * MINUTE) / 1000},0,0,0,2,2,2`].join('\n'));
  await importCsv(store, path, { kind: 'easee' });
  const now = Date.now();
  const original = store.observations().filter(row => row.source === 'csv:easee');
  assert(query(store, 'power', { now }).series.charger_power.every(point => point.y === null));
  seedVoltage(store, start + HOUR, [205, 205, 205], { mature: false });
  seedVoltage(store, start + 2 * HOUR, [220, 225, 240]);
  seedVoltage(store, start + 3 * HOUR, [245, 245, 245]);
  const power = query(store, 'power', { now }).series.charger_power.find(point => point.x === start);
  assert.equal(power.y, 6.85); assert.equal(power.retrospectiveVoltage, true);
  assert.deepEqual(power.voltageV, [220, 225, 240]);
  assert.equal(query(store, 'phases', { now }).series.ev1_current_l1[0].y, 10);
  assert.deepEqual(store.observations().filter(row => row.source === 'csv:easee'), original);
  const compact = query(store, 'power', { now, startDate: '2026-08-01' });
  assert.equal(at(compact.series.charger_power, start), 6.85);
  store.snapshot({ kind: 'market', source: 'fixture', fetchedAt: start, payload: pricing.market });
  const timing = query(store, 'power', { ...pricing, now }).timingBenefit.charger1;
  near(timing.energyKwh, 3.425);
  assert.deepEqual(timing.evidence.sources.map(source => source.key), ['retrospective-currents']);
  const tooltip = historyTooltipLabel({ dataset: { key: 'charger_power', label: 'Charger 1', unit: 'kW' },
    parsed: { x: start, y: power.y }, raw: power });
  assert.match(tooltip, /retrospective voltage assumption: first established database estimate/);
  assert.match(tooltip, /unity power factor assumed/);
});

test('late receipt cannot revise a selected as-of voltage and simulated estimates stay separate', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); energy(store);
  seedVoltage(store, start - HOUR, [220, 225, 240], { receivedAt: start + 3 * HOUR });
  seedVoltage(store, start - HOUR, [250, 250, 250], { input: 'simulated' });
  const beforeReceipt = query(store, 'phases', { now: start + 2 * HOUR });
  assert(beforeReceipt.series.ev1_current_l1.every(point => point.y === null));
  assert(query(store, 'phases').series.ev1_current_l1.every(point => point.y === null),
    'Late voltage evidence was unavailable throughout the earlier native energy interval');
  const voltage = query(store, 'voltage_estimates');
  assert(voltage.series.voltage_estimate_l1.some(point => point.y === 220));
  assert(!voltage.series.voltage_estimate_l1.some(point => point.y === 250));
  assert(query(store, 'voltage_estimates', { input: 'simulated' }).series.voltage_estimate_l1.some(point => point.y === 250));
});

test('current-derived chart power and charging timing use the same voltage boundaries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  seedVoltage(store, start, [220, 220, 220]);
  seedVoltage(store, start + 15 * MINUTE, [250, 250, 250]);
  for (const [time, current] of [[start, 10], [start + 30 * MINUTE, 0]])
    for (let phase = 1; phase <= 3; phase++) store.observation({ source: 'synthetic-current', device: 'synthetic-charger',
      signal: `ev1_current_l${phase}`, value: current, unit: 'A', sourceTime: time, receivedAt: time, quality: [] });
  const result = query(store, 'power', pricing);
  assert.equal(at(result.series.charger_power, start), 6.6);
  assert.equal(at(result.series.charger_power, start + 15 * MINUTE), 7.5);
  assert.equal(at(result.series.charger_power, start + 30 * MINUTE), 0);
  near(result.timingBenefit.charger1.energyKwh, 3.525);
  assert.equal(result.series.charger_power.find(point => point.x === start + 15 * MINUTE).observedAt, start);
});
