import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { DailyTimingBenchmark, Envelope, chartRange, getChartData } from '../src/app/chart-data.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const day = chartRange({ startDate: '2026-09-08', now: Date.parse('2026-09-10T00:00:00Z') });
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const rates = { periods: [{ from: day.from - 24 * HOUR, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night',
  transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] };

function interval(store, start, end, values, { prefix = 'ev1', quality = ['estimated', 'phase_allocation_estimated', 'reported_active_power'], unit = 'kWh' } = {}) {
  store.transaction(() => values.forEach((value, phase) => store.observation({ source: 'easee', device: `invented-${prefix}`,
    signal: `${prefix}_energy_l${phase + 1}`, value, unit, sourceTime: end, receivedAt: end, quality,
    raw: { intervalStart: start, intervalEnd: end, durationMs: end - start, basis: 'integrated-power-phase-allocation' } })));
}

function project(store, range, now = day.to + HOUR, prices = [{ start: day.from, end: day.to, totalCtPerKwh: 20 }]) {
  const names = ['charger_power', 'property_power', ...['ev1', 'property'].flatMap(prefix => [1, 2, 3].flatMap(phase => [`${prefix}_current_l${phase}`, `${prefix}_energy_l${phase}`]))];
  const envelopes = Object.fromEntries(names.map(name => [name, new Envelope(range.from, range.to, 200)]));
  const timing = new DailyTimingBenchmark(range, now, prices);
  const meta = addRecordedEnergy({ store, range, now, input: 'providers', envelopes, timing });
  return { series: Object.fromEntries(names.map(name => [name, envelopes[name].values()])), timing: timing.result(), meta };
}

test('phase kWh produces average real power without 230 V and explicitly equivalent chart currents', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, end = start + 5 * MINUTE;
    interval(store, start, end, [0.1, 0.2, 0.3]);
    const result = project(store, day);
    near(result.series.charger_power.find(row => row.y !== null).y, 7.2);
    near(result.series.ev1_current_l1.find(row => row.y !== null).y, 1.2 / 0.23);
    assert(result.series.ev1_current_l1.find(row => row.y !== null).equivalentCurrent);
    near(result.timing.charger.energyKwh, 0.6);
    assert.equal(result.timing.heatPump.energyKwh, null);
  } finally { store.close(); }
});

test('an interval crossing both selected boundaries is clipped for display and energy accounting', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    interval(store, start, start + 5 * MINUTE, [0.1, 0.2, 0.2]);
    const range = { from: start + MINUTE, to: start + 3 * MINUTE };
    const result = project(store, range);
    assert.equal(result.series.charger_power[0]?.x, range.from);
    near(result.series.charger_power[0]?.y, 6);
    near(result.timing.charger.energyKwh, 0.2);
    near(result.timing.charger.coverage, 1);
  } finally { store.close(); }
});

test('recorded intervals crossing Finnish midnight contribute to each selected day', () => {
  const store = new Store(':memory:');
  try {
    interval(store, day.to - 2 * MINUTE, day.to + 3 * MINUTE, [0.1, 0.2, 0.2]);
    const market = { fetchedAt: day.from, intervals: [{ start: day.from, end: day.to, spotCtPerKwh: 20, unit: 'c/kWh', vatIncluded: false }] };
    const result = getChartData({ store, now: day.to + HOUR, input: 'providers', startDate: '2026-09-08', endDate: '2026-09-08', left: 'power', contract: rates, market });
    near(result.timingBenefit.charger.energyKwh, 0.2);
    near(result.series.charger_power.find(row => row.y !== null)?.y, 6);
  } finally { store.close(); }
});

test('gaps, invalid units and incomplete phases contribute no invented total energy', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    interval(store, start, start + MINUTE, [0.1, 0, 0]);
    interval(store, start + MINUTE, start + 2 * MINUTE, [null, null, null], { quality: ['electricity_unavailable', 'missing'] });
    interval(store, start + 2 * MINUTE, start + 3 * MINUTE, [0.1, 0, 0], { unit: 'Wh' });
    interval(store, start + 3 * MINUTE, start + 4 * MINUTE, [0.1, 0]);
    interval(store, start + 5 * MINUTE, start + 6 * MINUTE, [0.1, 0, 0]);
    const result = project(store, day);
    near(result.timing.charger.energyKwh, 0.2);
    assert(result.series.charger_power.some(row => row.x === start + MINUTE && row.y === null));
    assert(result.series.charger_power.some(row => row.x >= start + 4 * MINUTE && row.x < start + 5 * MINUTE && row.y === null));
  } finally { store.close(); }
});

test('price boundary accounting uses all recorded intervals independently of display decimation', () => {
  const store = new Store(':memory:');
  try {
    const boundary = day.from + 2 * HOUR;
    interval(store, boundary - MINUTE, boundary + MINUTE, [0.1, 0.1, 0]);
    const result = project(store, day, day.to, [{ start: day.from, end: boundary, totalCtPerKwh: 10 },
      { start: boundary, end: day.to, totalCtPerKwh: 50 }]);
    near(result.timing.charger.energyKwh, 0.2);
    near(result.timing.charger.actualCostEuro, 0.06);
  } finally { store.close(); }
});

test('legacy power stops at recorded energy handover and audit counters cannot change chart totals', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    for (const [at, power] of [[start - 5 * MINUTE, 6], [start + MINUTE, 99]]) store.observation({ source: 'controller-estimate', device: 'providers',
      signal: 'charger_power', value: power, unit: 'kW', sourceTime: at, receivedAt: at, quality: ['estimated'] });
    interval(store, start, start + 5 * MINUTE, [0.1, 0.2, 0.2]);
    const market = { fetchedAt: day.from, intervals: [{ start: day.from, end: day.to, spotCtPerKwh: 20, unit: 'c/kWh', vatIncluded: false }] };
    const options = { store, now: day.to, input: 'providers', startDate: '2026-09-08', endDate: '2026-09-08', left: 'power', contract: rates, market };
    const before = getChartData(options);
    near(before.timingBenefit.charger.energyKwh, 1);
    store.energyAudit({ source: 'easee', device: 'invented-ev1', signal: 'ev1_lifetime_energy_counter', sourceTime: start, receivedAt: start, value: 900 });
    store.energyAudit({ source: 'easee', device: 'invented-ev1', signal: 'ev1_lifetime_energy_counter', sourceTime: start + 5 * MINUTE, receivedAt: start + 5 * MINUTE, value: 1900 });
    const after = getChartData(options);
    assert.deepEqual(after.timingBenefit, before.timingBenefit);
    assert.deepEqual(after.series, before.series);
  } finally { store.close(); }
});

test('long ranges use complete quarter-hour sums and fall back only for an incomplete bucket', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    for (let minute = 0; minute < 30; minute++) {
      if (minute === 20) continue;
      const power = minute < 7 ? 1 : minute < 15 ? 9 : 3;
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [power / 60, 0, 0]);
    }
    const raw = project(store, day), long = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR });
    assert.equal(long.meta.aggregated, true);
    assert.equal(long.meta.aggregationMinutes, 15);
    assert.equal(long.meta.rawFallbackBuckets, 1);
    assert.equal(long.meta.rollupRows, 6);
    near(long.timing.charger.energyKwh, raw.timing.charger.energyKwh);
    near(long.timing.charger.actualCostEuro, raw.timing.charger.actualCostEuro);
    near(long.series.charger_power.find(row => row.aggregated && row.y !== null).y, (7 + 8 * 9) / 15);
    assert(long.series.charger_power.some(row => row.y === null && row.x >= start + 20 * MINUTE && row.x < start + 21 * MINUTE));
    assert(long.meta.rows < 90, 'healthy quarter never scans its minute rows');
  } finally { store.close(); }
});

test('a tariff change inside a quarter uses original intervals for cost, other quarters remain aggregated', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, boundary = start + 7 * MINUTE;
    for (let minute = 0; minute < 30; minute++) {
      const power = minute < 7 ? 1 : minute < 15 ? 9 : 3;
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [power / 60, 0, 0]);
    }
    const prices = [{ start: day.from, end: boundary, totalCtPerKwh: 10 }, { start: boundary, end: day.to, totalCtPerKwh: 50 }];
    const raw = project(store, day, day.to, prices), long = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR }, day.to, prices);
    assert.equal(long.meta.aggregated, true); assert.equal(long.meta.rawFallbackBuckets, 1);
    near(long.timing.charger.actualCostEuro, raw.timing.charger.actualCostEuro);
    near(long.timing.charger.energyKwh, raw.timing.charger.energyKwh);
    near(long.timing.charger.actualCostEuro, 7 / 60 * 0.1 + (8 * 9 / 60 + 15 * 3 / 60) * 0.5);
  } finally { store.close(); }
});

test('legacy migration watermark retains old energy and avoids counting its first summarized neighbor twice', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    interval(store, start, start + 15 * MINUTE, [0.1, 0.2, 0.2]);
    store.db.exec('UPDATE chart_rollup_meta SET legacy_through=(SELECT MAX(id) FROM observations); DELETE FROM chart_rollups;');
    for (let minute = 15; minute < 30; minute++) interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.01, 0.02, 0.02]);
    const result = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR });
    assert(result.meta.aggregated);
    near(result.timing.charger.energyKwh, 0.5 + 15 * 0.05);
    assert.equal(result.meta.rollupRows, 3); assert.equal(result.meta.rawFallbackBuckets, 0);
  } finally { store.close(); }
});

test('partial selected edges fall back without losing or extrapolating recorded energy', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    for (let minute = 0; minute < 30; minute++) interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.1, 0, 0]);
    const result = project(store, { from: start + 90_000, to: day.to + 8 * 24 * HOUR });
    assert.equal(result.meta.rawFallbackBuckets, 1); assert(result.meta.aggregated);
    near(result.timing.charger.energyKwh, 2.85);
    assert.equal(result.series.charger_power[0].x, start + 90_000);
  } finally { store.close(); }
});
