import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { ElectricityAccumulator } from '../src/domain/electricity.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { DailyTimingBenchmark, Envelope, chartRange, getChartData } from '../src/app/chart-data.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const day = chartRange({ startDate: '2026-09-08', now: Date.parse('2026-09-10T00:00:00Z') });
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const rates = { periods: [{ from: day.from - 24 * HOUR, marginCtPerKwh: 0, taxCtPerKwh: 0, vatRate: 0, tariff: 'day-night',
  transferRates: { vatIncluded: false, dayCtPerKwh: 0, nightCtPerKwh: 0, winterDayCtPerKwh: 0, otherCtPerKwh: 0 } }] };

function interval(store, start, end, values, { prefix = 'ev1', quality = ['estimated', 'phase_allocation_estimated', 'reported_active_power'], unit = 'kWh',
  source = 'easee', device = `invented-${prefix}`, receivedAt = end } = {}) {
  store.transaction(() => values.forEach((value, phase) => store.observation({ source, device,
    signal: `${prefix}_energy_l${phase + 1}`, value, unit, sourceTime: end, receivedAt, quality,
    raw: { intervalStart: start, intervalEnd: end, durationMs: end - start, basis: 'integrated-power-phase-allocation' } })));
}

function project(store, range, now = day.to + HOUR, prices = [{ start: day.from, end: day.to, totalCtPerKwh: 20 }]) {
  const names = ['charger_power', 'property_power', ...['ev1', 'property'].flatMap(prefix => [1, 2, 3].flatMap(phase => [`${prefix}_current_l${phase}`, `${prefix}_energy_l${phase}`]))];
  const envelopes = Object.fromEntries(names.map(name => [name, new Envelope(range.from, range.to, 200)]));
  const timing = new DailyTimingBenchmark(range, now, prices);
  const meta = addRecordedEnergy({ store, range, now, input: 'providers', envelopes, timing });
  return { series: Object.fromEntries(names.map(name => [name, envelopes[name].values()])), timing: timing.result(), meta };
}

function liveElectricity(store, start) {
  const recorder = new Recorder(store), accumulator = new ElectricityAccumulator();
  const devices = [
    { prefix: 'property', power: 2.3, currents: [2, 3, 5] },
    { prefix: 'ev1', power: 4.6, currents: [4, 4, 2] },
  ];
  return { recorder, devices, poll(at, failed = false) {
    const rows = devices.flatMap(({ prefix, power, currents }) => [
      { signal: `${prefix}_active_power`, value: power, unit: 'kW', sourceTime: at },
      ...currents.map((value, index) => ({ signal: `${prefix}_current_l${index + 1}`, value, unit: 'A', sourceTime: start })),
    ].map(row => ({ ...row, source: 'easee', device: `invented-${prefix}`, receivedAt: at,
      quality: at - row.sourceTime > 5 * MINUTE ? ['stale'] : [],
      ...(failed ? { value: null, sourceTime: null, quality: ['provider_error'] } : {}),
    })));
    const result = accumulator.sample(rows, at);
    for (const row of rows) recorder.record(row);
    for (const gap of result.gaps) recorder.energyGap(gap);
    for (const interval of result.intervals) recorder.recordEnergy(interval);
    return result;
  } };
}

test('fresh Easee total power keeps stable old phase weights continuous through recorder coalescing', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, end = start + 20 * MINUTE;
    const { recorder, devices, poll } = liveElectricity(store, start);
    for (let at = start; at <= end; at += 15_000) {
      const result = poll(at);
      assert.equal(result.gaps.length, 0, 'Unchanged phase event clocks cannot discard freshly reported total power');
      assert.equal(result.intervals.length, at === start ? 0 : devices.length);
    }
    recorder.flush(end, { force: true });
    const recorded = store.observations().filter(row => /_energy_l[123]$/.test(row.signal));
    assert(recorded.length < 80 * devices.length * 3 / 2, 'Stable acquisitions must still coalesce into fewer stored energy intervals');
    assert(recorded.every(row => Number.isFinite(row.value)));
    assert(recorded.some(row => row.raw.durationMs >= 5 * MINUTE));
    const options = { store, input: 'providers', startDate: '2026-09-08', endDate: '2026-09-08', now: end + MINUTE };
    const power = getChartData({ ...options, left: 'power' }), phases = getChartData({ ...options, left: 'phases' });
    for (const { prefix, power: kw, currents } of devices) {
      const curves = [[power.series[prefix === 'property' ? 'property_power' : 'charger_power'], kw],
        ...currents.map((weight, index) => [phases.series[`${prefix}_current_l${index + 1}`], kw * weight / 10 / 0.23])];
      for (const [rows, expected] of curves) {
        assert.equal(rows[0].x, start);
        assert.equal(rows.at(-2).x, end - 1);
        assert.deepEqual(rows.at(-1), { x: end, y: null }, 'Recorded history ends at the last acquired interval');
        assert(rows.filter(row => row.x < end).every(row => Number.isFinite(row.y)), 'Constant intervals draw an unbroken line');
        for (const row of rows.filter(row => row.y !== null)) near(row.y, expected);
      }
    }
  } finally { store.close(); }
});

test('failed Easee acquisition still breaks derived power and currents until fresh total power recovers', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, failedAt = start + 10 * MINUTE, recoveredAt = failedAt + 2 * MINUTE;
    const end = recoveredAt + 5 * MINUTE, lastGoodAt = failedAt - 15_000;
    const { recorder, devices, poll } = liveElectricity(store, start);
    for (let at = start; at < failedAt; at += 15_000) poll(at);
    assert.equal(poll(failedAt, true).gaps.length, devices.length);
    for (let at = recoveredAt; at <= end; at += 15_000) poll(at);
    recorder.flush(end, { force: true });
    const options = { store, input: 'providers', startDate: '2026-09-08', endDate: '2026-09-08', now: end + MINUTE };
    const power = getChartData({ ...options, left: 'power' }), phases = getChartData({ ...options, left: 'phases' });
    for (const { prefix, power: kw } of devices) {
      const curves = [power.series[prefix === 'property' ? 'property_power' : 'charger_power'],
        ...[1, 2, 3].map(phase => phases.series[`${prefix}_current_l${phase}`])];
      for (const rows of curves) {
        assert(rows.some(row => row.y !== null && row.x < lastGoodAt));
        assert(rows.some(row => row.y === null && row.x >= lastGoodAt && row.x < recoveredAt));
        assert(!rows.some(row => row.y !== null && row.x >= lastGoodAt && row.x < recoveredAt), 'The chart cannot bridge failed acquisition');
        assert(rows.some(row => row.y !== null && row.x === recoveredAt), 'Fresh total power resumes the plot with the older phase weights');
        assert.equal(rows.at(-2).x, end - 1);
      }
      const l1 = store.observations().filter(row => row.signal === `${prefix}_energy_l1` && Number.isFinite(row.value));
      assert(l1.every(row => row.raw.intervalEnd <= lastGoodAt || row.raw.intervalStart >= recoveredAt));
      near(l1.reduce((sum, row) => sum + row.value, 0), kw * (prefix === 'property' ? 0.2 : 0.4) * (lastGoodAt - start + end - recoveredAt) / HOUR);
    }
  } finally { store.close(); }
});

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
    assert.equal(result.timing.charger.evidence.energyBasis, 'recorded-intervals');
    assert.equal(result.timing.charger.evidence.timeBasis, 'recorded-interval-time');
    const evidence = result.timing.charger.evidence.sources[0];
    assert.equal(evidence.key, 'recorded');
    assert.equal(evidence.durationMs, 5 * MINUTE);
    assert.equal(evidence.share, 1);
    assert.equal(evidence.firstAt, start);
    assert.equal(evidence.lastAt, end);
    assert.equal(result.timing.heatPump.energyKwh, null);
  } finally { store.close(); }
});

test('recorded standby and threshold power stay visible on charts but only charging enters timing costs', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, powers = [0.05, 0.1, 0.1001, 6, 0];
    for (const [index, kw] of powers.entries())
      interval(store, start + index * MINUTE, start + (index + 1) * MINUTE, [kw / 60, 0, 0]);
    const range = { from: start, to: start + 5 * MINUTE };
    const boundary = start + 3 * MINUTE;
    const result = project(store, range, range.to, [{ start: day.from, end: boundary, totalCtPerKwh: 10 },
      { start: boundary, end: day.to, totalCtPerKwh: 50 }]);
    const charging = result.timing.charger;
    near(charging.energyKwh, (0.1001 + 6) / 60);
    near(charging.actualCostEuro, 0.1001 / 60 * 0.1 + 6 / 60 * 0.5);
    assert.equal(charging.coverage, 2 / 5);
    assert.equal(charging.coverageDetails.includedMs, 2 * MINUTE);
    assert.equal(charging.coverageDetails.chargingMs, 2 * MINUTE);
    assert.equal(charging.coverageDetails.idleMs, 3 * MINUTE);
    assert.equal(charging.coverageDetails.powerMs, 5 * MINUTE);
    assert.equal(charging.coverageDetails.missingPowerMs, 0);
    assert.equal(charging.provisional, false);
    assert.equal(charging.evidence.sources[0].durationMs, 2 * MINUTE);
    assert.equal(charging.evidence.sources[0].share, 1);
    assert.equal(charging.evidence.sources[0].firstAt, start + 2 * MINUTE);
    assert.equal(charging.evidence.sources[0].lastAt, start + 4 * MINUTE);
    assert.equal(charging.evidence.energyBasis, 'recorded-intervals');
    assert.deepEqual(result.meta, { rows: 15, intervals: 5 });
    for (const [index, kw] of powers.entries())
      near(result.series.charger_power.find(row => row.x === start + index * MINUTE)?.y, kw);
    assert.equal(store.db.prepare('SELECT count(*) count FROM observations').get().count, 15);
  } finally { store.close(); }
});

test('exactly 100 W stays idle when uneven recorded durations round the reconstructed power upward', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, end = start + 7000, kwh = 0.1 * (end - start) / HOUR;
    interval(store, start, end, [kwh / 3, kwh / 3, kwh / 3]);
    const result = project(store, { from: start, to: end }, end);
    near(result.series.charger_power[0].y, 0.1);
    assert.equal(result.timing.charger.value, null);
    assert.equal(result.timing.charger.coverageDetails.idleMs, 7000);
    assert.equal(result.timing.charger.coverageDetails.chargingMs, 0);
    assert.equal(result.timing.charger.coverageDetails.missingPowerMs, 0);
    assert.equal(result.timing.charger.provisional, false);
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
    assert.equal(before.timingBenefit.charger.evidence.energyBasis, 'recorded-and-legacy');
    assert.equal(before.timingBenefit.charger.evidence.timeBasis, 'mixed-recorded-time');
    assert.deepEqual(before.timingBenefit.charger.evidence.sources.map(source => [source.key, source.share]),
      [['unknown', 0.5], ['recorded', 0.5]]);
    store.energyAudit({ source: 'easee', device: 'invented-ev1', signal: 'ev1_lifetime_energy_counter', sourceTime: start, receivedAt: start, value: 900 });
    store.energyAudit({ source: 'easee', device: 'invented-ev1', signal: 'ev1_lifetime_energy_counter', sourceTime: start + 5 * MINUTE, receivedAt: start + 5 * MINUTE, value: 1900 });
    const after = getChartData(options);
    assert.deepEqual(after.timingBenefit, before.timingBenefit);
    assert.deepEqual(after.series, before.series);
  } finally { store.close(); }
});

test('long recorded intervals retain original bounds, exact coverage and assumed-price evidence across hold-sized pieces', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, end = start + 90 * MINUTE;
    interval(store, start, end, [0.9, 0, 0]);
    const range = { from: start + MINUTE, to: end - MINUTE };
    const prices = [{ start: day.from, end: day.to, totalCtPerKwh: 20, assumedPrice: true }];
    const result = project(store, range, day.to, prices).timing.charger;
    near(result.energyKwh, 0.88);
    assert.equal(result.coverageDetails.includedMs, 88 * MINUTE);
    assert.equal(result.coverageDetails.powerMs, 88 * MINUTE);
    assert.equal(result.coverageDetails.missingPowerMs, 0);
    assert.equal(result.evidence.sources[0].durationMs, 88 * MINUTE);
    assert.equal(result.evidence.sources[0].firstAt, start);
    assert.equal(result.evidence.sources[0].lastAt, end);
    assert.equal(result.priceAssumptions.durationMs, 88 * MINUTE);
    assert.equal(result.priceAssumptions.firstAt, range.from);
    assert.equal(result.priceAssumptions.lastAt, range.to);
    assert.equal(result.priceAssumptions.share, 1);
    const missingPrices = project(store, range, day.to, []).timing.charger;
    assert.equal(missingPrices.value, null);
    assert.equal(missingPrices.coverageDetails.incompletePriceMs, 88 * MINUTE);
    assert.equal(missingPrices.coverageDetails.missingPowerMs, 0);
    assert.equal(missingPrices.evidence.energyBasis, 'recorded-intervals');
  } finally { store.close(); }
});

test('long ranges preserve original power peaks, interval provenance and gaps without stored summaries', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    for (let minute = 0; minute < 30; minute++) {
      if (minute === 20) continue;
      const power = minute < 7 ? 1 : minute < 15 ? 9 : 3;
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [power / 60, 0, 0]);
    }
    const raw = project(store, day), long = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR });
    assert.deepEqual(long.meta, { rows: 87, intervals: 29 });
    near(long.timing.charger.energyKwh, raw.timing.charger.energyKwh);
    near(long.timing.charger.actualCostEuro, raw.timing.charger.actualCostEuro);
    near(Math.max(...long.series.charger_power.map(row => row.y ?? -Infinity)), 9);
    assert(long.series.charger_power.filter(row => row.fromEnergy).every(row => row.intervalEnd - row.intervalStart === MINUTE));
    assert(long.series.charger_power.every(row => !Object.hasOwn(row, 'aggregated')));
    assert(long.series.charger_power.some(row => row.y === null && row.x >= start + 20 * MINUTE && row.x < start + 21 * MINUTE));
  } finally { store.close(); }
});

test('arbitrary tariff boundaries use original intervals for the same exact costs on every range', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, boundary = start + 7 * MINUTE;
    for (let minute = 0; minute < 30; minute++) {
      const power = minute < 7 ? 1 : minute < 15 ? 9 : 3;
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [power / 60, 0, 0]);
    }
    const prices = [{ start: day.from, end: boundary, totalCtPerKwh: 10 }, { start: boundary, end: day.to, totalCtPerKwh: 50 }];
    const raw = project(store, day, day.to, prices), long = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR }, day.to, prices);
    assert.deepEqual(long.meta, { rows: 90, intervals: 30 });
    near(long.timing.charger.actualCostEuro, raw.timing.charger.actualCostEuro);
    near(long.timing.charger.energyKwh, raw.timing.charger.energyKwh);
    near(long.timing.charger.actualCostEuro, 7 / 60 * 0.1 + (8 * 9 / 60 + 15 * 3 / 60) * 0.5);
  } finally { store.close(); }
});

test('mixed recording durations retain each original interval without double counting their shared boundary', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    interval(store, start, start + 15 * MINUTE, [0.1, 0.2, 0.2]);
    for (let minute = 15; minute < 30; minute++) interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.01, 0.02, 0.02]);
    const result = project(store, { from: day.from, to: day.to + 8 * 24 * HOUR });
    near(result.timing.charger.energyKwh, 0.5 + 15 * 0.05);
    assert.deepEqual(result.meta, { rows: 48, intervals: 16 });
    assert(result.series.charger_power.some(row => row.intervalStart === start && row.intervalEnd === start + 15 * MINUTE));
    assert(result.series.charger_power.some(row => row.intervalStart === start + 15 * MINUTE && row.intervalEnd === start + 16 * MINUTE));
  } finally { store.close(); }
});

test('partial selected edges clip drawing and cost while retaining the original energy interval provenance', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR;
    for (let minute = 0; minute < 30; minute++) interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.1, 0, 0]);
    const result = project(store, { from: start + 90_000, to: day.to + 8 * 24 * HOUR });
    assert.deepEqual(result.meta, { rows: 87, intervals: 29 });
    near(result.timing.charger.energyKwh, 2.85);
    assert.equal(result.series.charger_power[0].x, start + 90_000);
    assert.equal(result.series.charger_power[0].intervalStart, start + MINUTE);
    assert.equal(result.series.charger_power[0].intervalEnd, start + 2 * MINUTE);
  } finally { store.close(); }
});

test('energy index scans merge chronologically without a full-range SQL sort or mixing incomplete device cohorts', () => {
  const store = new Store(':memory:');
  try {
    const start = day.from + HOUR, now = start + 5 * MINUTE;
    // Insertion order differs from observation time and alternates the property
    // and charger cohorts. Index cursors must retain time/ID order together.
    for (const minute of [2, 0, 1]) {
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.3, 0.2, 0.1], { prefix: 'property' });
      interval(store, start + minute * MINUTE, start + (minute + 1) * MINUTE, [0.1, 0.02, 0.03]);
    }
    for (const [phase, device, source] of [[1, 'invented-other-a', 'easee'], [2, 'invented-other-b', 'easee'], [3, 'invented-other-b', 'other-source']]) {
      store.observation({ source, device, signal: `ev1_energy_l${phase}`, value: 10, unit: 'kWh',
        sourceTime: start + 4 * MINUTE, receivedAt: start + 4 * MINUTE, quality: ['estimated'],
        raw: { intervalStart: start + 3 * MINUTE, intervalEnd: start + 4 * MINUTE } });
    }
    interval(store, start, start + MINUTE, [99, 0, 0], { source: 'simulation' });
    interval(store, start, start + MINUTE, [99, 0, 0], { device: 'invented-late', receivedAt: now + MINUTE });
    const plans = [];
    const facade = { db: { prepare(sql) {
      const statement = store.db.prepare(sql);
      if (!sql.includes('source_time>=?')) return statement;
      return { iterate(...parameters) {
        plans.push(store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters));
        return statement.iterate(...parameters);
      } };
    } } };
    const result = project(facade, day, now);
    near(result.timing.charger.energyKwh, 0.45);
    near(result.timing.charger.actualCostEuro, 0.09);
    assert.equal(result.meta.rows, 21, 'Simulation and future receipt rows stay outside the physical query');
    assert(result.series.charger_power.some(row => row.x === start + 3 * MINUTE && row.y === null));
    assert(result.series.property_power.some(row => Math.abs(row.y - 36) < 1e-10));
    assert.equal(plans.length, 6);
    assert(plans.every(plan => plan.some(row => /SEARCH observations USING INDEX observations_signal_time/.test(row.detail))));
    assert(plans.every(plan => plan.every(row => !/TEMP B-TREE/.test(row.detail))), 'The default original-energy path must not sort all selected rows');
  } finally { store.close(); }
});
