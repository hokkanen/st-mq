import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { DailyTimingBenchmark, Envelope, chartRange, getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';
import { importCsv } from '../src/storage/history.js';
import { historySeriesAt } from '../chart/history-model.js';
import { recordHeatPumpConfiguration } from '../src/app/chart-heat-pump.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const from = Date.parse('2026-01-15T00:00:00+02:00');
const now = from + 12 * HOUR;
const date = '2026-01-15';
function put(store, signal, value, at, extra = {}) {
  store.observation({ source: 'test-fixture', device: 'house', signal, value,
    unit: signal.includes('current') ? 'A' : signal === 'spot_price' ? 'c/kWh_ex_vat' : 'degC',
    sourceTime: at, receivedAt: at, ...extra });
}
// These fixtures request present retrospective history after any synthetic import publication.
function get(store, extra = {}) { const options = { store, now, startDate: date, endDate: date, ...extra };
  options.now = Math.max(options.now, store.db.prepare("SELECT MAX(completed_at) AS at FROM imports WHERE status='complete'").get().at ?? -Infinity);
  return getChartData(options); }
function currentPower(store, value, at, extra = {}) {
  for (let phase=1;phase<=3;phase++) put(store, `ev1_current_l${phase}`, value/3/0.23, at, { ...extra, unit: 'A' });
}
function csvRequest(store, value, at, extra = {}) {
  let row=store.db.prepare("SELECT id FROM imports WHERE sha256='synthetic-request-fixture'").get();
  if(!row)row={id:Number(store.db.prepare("INSERT INTO imports(kind,sha256,path,status,started_at,completed_at) VALUES('stmq','synthetic-request-fixture','synthetic.csv','complete',?,?)").run(from-HOUR,from-HOUR).lastInsertRowid)};
  put(store,'requested_heat_mode',value,at,{...extra,source:'csv:stmq',unit:'legacy_command',provenance:{importId:row.id,rowNumber:at}});
}
const contract = { periods: [{ from: from - 10 * HOUR, marginCtPerKwh: 0.4, taxCtPerKwh: 2.2, transferRates: { vatIncluded: true, dayCtPerKwh: 3.34, nightCtPerKwh: 1.96, winterDayCtPerKwh: 4.17, otherCtPerKwh: 2.07 }, vatRate: 0.255, tariff: 'day-night' }] };
const interval = (start, end, value) => ({ start, end, spotCtPerKwh: value, unit: 'c/kWh', vatIncluded: false, source: 'fixture' });

test('daily timing comparison uses exact local-day duration, including both DST changes', () => {
  for (const [date, hours] of [['2026-01-15', 24], ['2026-03-29', 23], ['2026-10-25', 25]]) {
    const range = chartRange({ startDate: date, now });
    const prices = [{ start: range.from, end: range.from + HOUR, totalCtPerKwh: -10 },
      { start: range.from + HOUR, end: range.to, totalCtPerKwh: 20 }];
    const timing = new DailyTimingBenchmark(range, range.to, prices);
    for (let at = range.from; at <= range.to; at += 30 * MINUTE) timing.add('charger1', at, at < range.from + HOUR ? 2 : 0);
    const result = timing.result();
    const average = (-10 + (hours - 1) * 20) / hours;
    assert.equal(result.charger1.energyKwh, 2);
    assert.equal(result.charger1.actualCostEuro, -0.2);
    assert(Math.abs(result.charger1.value - (2 * average / 100 + 0.2)) < 1e-10);
    assert.equal(result.charger1.coverage, 1 / hours);
    assert.equal(result.charger1.coverageDetails.elapsedMs, hours * HOUR);
    assert.equal(result.charger1.coverageDetails.includedMs, HOUR);
    assert.equal(result.charger1.coverageDetails.chargingMs, HOUR);
    assert.equal(result.charger1.coverageDetails.idleMs, (hours - 1) * HOUR);
    assert.equal(result.charger1.coverageDetails.missingPowerMs, 0);
    assert.equal(result.charger1.evidence.sources[0].share, 1);
    assert.equal(result.charger1.provisional, false);
    assert.equal(result.heatPump.value, null, 'No property-minus-charger proxy for heat pump energy');
  }
});

test('partial energy, missing prices and telemetry gaps never become a full-day zero-saving claim', () => {
  const range = chartRange({ startDate: date, now });
  const prices = [{ start: from, end: from + HOUR, totalCtPerKwh: 0 },
    { start: from + HOUR, end: range.to, totalCtPerKwh: 24 }];
  const partial = new DailyTimingBenchmark(range, from + HOUR, prices);
  partial.add('heatPump', from, 2); partial.add('heatPump', from + HOUR, 0);
  const result = partial.result().heatPump;
  assert.equal(result.energyKwh, 1, 'Power held for at most 30 minutes across an unknown gap');
  assert.equal(result.coverage, 0.5);
  assert.equal(result.provisional, true);
  assert.equal(result.value, 0.23, 'Partial observed energy uses the full day’s price, not the partial hour average');
  const missingPrice = new DailyTimingBenchmark(range, range.to, prices.slice(0, 1));
  missingPrice.add('charger1', from, 2);
  assert.equal(missingPrice.result().charger1.value, null, 'Whole-day price coverage is required');
  const unknown = new DailyTimingBenchmark(range, from + HOUR, prices);
  unknown.add('charger1', from, null);
  assert.equal(unknown.result().charger1.energyKwh, null);
});

test('learning histories retain the estimate known at each assessment and preserve unknown auxiliary evidence', () => {
  const store = new Store(':memory:');
  try {
    const extra = { source: 'controller-learning', device: 'offline', unit: 'EUR/cycle', quality: ['estimated'], raw: { count: 3, basis: 'Estimated completed cycles', modelVersion: 1 } };
    put(store, 'learning_profit', 1.25, from - 5 * 24 * HOUR, extra);
    put(store, 'learning_profit', -0.75, from + HOUR, { ...extra, raw: { ...extra.raw, count: 4 } });
    put(store, 'learning_profit', 99, from + 2 * HOUR, { ...extra, device: 'simulated' });
    put(store, 'learning_aux_profit', null, from + HOUR, { ...extra, quality: ['missing'], raw: { count: 0 } });
    const result = get(store, { left: 'learning_profit' });
    assert.equal(result.series.learning_profit[0].x, from);
    assert.equal(result.series.learning_profit[0].y, 1.25);
    assert.equal(result.series.learning_profit.find(p => p.x === from + HOUR).y, -0.75);
    assert.equal(result.series.learning_profit.at(-1).y, -0.75);
    assert.equal(result.meta.learning.learning_profit.count, 4);
    assert(!result.series.learning_profit.some(p => p.y === 99));
    assert(get(store, { left: 'learning_aux_profit' }).series.learning_aux_profit.every(p => p.y === null));
    assert.deepEqual(get(store, { left: 'learning_recovery_error' }).series.learning_recovery_error, []);
  } finally { store.close(); }
});

test('controller estimates remain isolated and reduction requests end at their recorded expiry', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'auxiliary_power', 6, from + HOUR, { source: 'controller-estimate', device: 'simulated', unit: 'kW', quality: ['estimated'] });
    put(store, 'controller_phase', 2, from - 4 * HOUR, { source: 'controller', device: 'simulated', unit: 'state', quality: ['requested'], raw: { expiresAt: from + 2 * HOUR } });
    put(store, 'dhwr_request', 1, from + HOUR, { source: 'controller', device: 'simulated', unit: 'state', quality: ['requested'], raw: { expiresAt: from + HOUR + 10 * MINUTE } });
    csvRequest(store, 15, from + HOUR, { source: 'simulation', unit: 'legacy_command' });
    const simulated = get(store, { input: 'simulated' });
    assert(simulated.series.auxiliary_power.some(p => p.y === 6));
    assert.deepEqual(simulated.shading.heatOff, [{ start: from, end: from + 2 * HOUR }]);
    assert.deepEqual(simulated.shading.dhwr, [{ start: from + HOUR, end: from + HOUR + 10 * MINUTE }], 'The following normal request does not erase a separate pulse');
    const household = get(store);
    assert.deepEqual(household.series.auxiliary_power, []);
    assert.deepEqual(household.shading.heatOff, []);
  } finally { store.close(); }
});

test('auxiliary power uses documented percentage with installed capacity and expires instead of carrying indefinitely', () => {
  const store = new Store(':memory:');
  try {
    const extra = { source: 'husdata-h66', unit: '%', raw: { verified: 'installed', usableForControl: true, ratedPowerKw: 9 } };
    put(store, 'auxiliary_output', 33, from + HOUR, extra);
    put(store, 'auxiliary_output', 67, from + HOUR + MINUTE, extra);
    put(store, 'auxiliary_output', 100, from + HOUR + 2 * MINUTE, extra);
    put(store, 'auxiliary_output', 100, from + 2 * HOUR, { ...extra, raw: { verified: 'installed' } });
    const result = get(store);
    assert.deepEqual(result.series.auxiliary_power.slice(0, 3).map(p => p.y), [3, 6, 9]);
    assert.equal(result.series.auxiliary_power.find(p => p.x === from + HOUR + 7 * MINUTE).y, 9);
    assert(result.series.auxiliary_power.some(p => p.y === null));
    assert.equal(historySeriesAt(result).auxiliary_power.at(-1).y, null);
  } finally { store.close(); }
});

test('timing estimates are independent of the selected axis and display decimation', () => {
  const store = new Store(':memory:');
  try {
    const market = { fetchedAt: from, intervals: [interval(from, from + 4 * HOUR, 0), interval(from + 4 * HOUR, from + 24 * HOUR, 20)] };
    recordHeatPumpConfiguration(store, 'mqtt', { heatPumpCompressorKw: 3, circulationKw: 0, auxRatedKw: 9 }, from);
    for (let at = from; at <= now; at += 5 * MINUTE) {
      const raw = { verified: true, usableForControl: true };
      put(store, 'compressor_active', at < from + 4 * HOUR ? 1 : 0, at, { source: 'husdata-h66', unit: 'state', raw });
      put(store, 'auxiliary_output', 0, at, { source: 'husdata-h66', unit: '%', raw });
      currentPower(store, at < from + 2 * HOUR ? 6 : 0, at, { unit: 'kW', quality: ['estimated'] });
    }
    const baseline = get(store, { market, contract, points: 100 }).timingBenefit;
    for (const left of ['power', 'integral', 'solar_radiation', 'learning_profit'])
      assert.deepEqual(get(store, { market, contract, points: 2000, left }).timingBenefit, baseline);
    assert(baseline.heatPump.value > 0);
    assert.equal(baseline.heatPump.coverage, 1);
    assert.equal(baseline.heatPump.energyKwh, 12);
  } finally { store.close(); }
});

test('charger timing uses coherent current acquisitions on every axis', () => {
  const store = new Store(':memory:');
  try {
    const market = { fetchedAt: from, intervals: [interval(from, from + HOUR, 0), interval(from + HOUR, from + 24 * HOUR, 20)] };
    for (const at of [from, from + 30 * MINUTE]) for (let phase = 1; phase <= 3; phase++)
      put(store, `ev1_current_l${phase}`, 10, at);
    currentPower(store, 2, from + HOUR, { unit: 'kW' });
    currentPower(store, 0, from + HOUR + 30 * MINUTE, { unit: 'kW' });
    const power = get(store, { market, contract }).timingBenefit;
    assert(Math.abs(power.charger1.energyKwh - 7.9) < 1e-10);
    assert.deepEqual(get(store, { market, contract, left: 'integral' }).timingBenefit, power);
    assert.deepEqual(get(store, { market, contract, left: 'learning_aux_profit' }).timingBenefit, power);
  } finally { store.close(); }
});

test('old charger timing uses current known rates and historical spot without changing control prices or history', () => {
  const store = new Store(':memory:');
  try {
    const current = from + 60 * 24 * HOUR;
    const currentContract = { periods: [{ ...contract.periods[0], from: current }] };
    const market = { fetchedAt: current, intervals: [interval(from, from + HOUR, -10), interval(from + HOUR, from + 24 * HOUR, 20)] };
    for (const at of [from, from + 30 * MINUTE]) for (let phase = 1; phase <= 3; phase++)
      put(store, `ev1_current_l${phase}`, 10, at);
    for (let phase = 1; phase <= 3; phase++) put(store, `ev1_current_l${phase}`, 0, from + HOUR);
    const before = store.db.prepare('SELECT count(*) count FROM observations').get().count;
    const savedContract = JSON.stringify(currentContract);
    const result = get(store, { market, contract: currentContract, now: current });
    const verified = get(store, { market, contract, now: current });
    assert(result.timingBenefit.charger1.value > 0);
    assert.equal(result.timingBenefit.charger1.value, verified.timingBenefit.charger1.value);
    assert.equal(result.timingBenefit.charger1.assumedPrices, true);
    assert.equal(result.timingBenefit.charger1.priceAssumptions.share, 1,
      'Historical included time all uses assumed rates');
    assert.equal(result.timingBenefit.charger1.priceAssumptions.firstAt, from);
    assert.equal(result.timingBenefit.charger1.priceAssumptions.lastAt, from + HOUR);
    assert.equal(verified.timingBenefit.charger1.assumedPrices, false);
    assert.equal(result.timingBenefit.heatPump.value, null);
    assert.equal(result.timingBenefit.heatPump.assumedPrices, false);
    assert.equal(result.meta.priceAssumptions.used, true);
    assert.equal(JSON.stringify(currentContract), savedContract);
    assert.equal(store.db.prepare('SELECT count(*) count FROM observations').get().count, before);
    const noContract = get(store, { market, now: current });
    assert.equal(noContract.timingBenefit.charger1.value, null);
    assert.equal(noContract.meta.priceAssumptions.used, false);
  } finally { store.close(); }
});

test('timing evidence follows each held sample, weights time rather than sample count, and includes zero power', () => {
  const range = chartRange({ startDate: date, now });
  const timing = new DailyTimingBenchmark(range, from + 2 * HOUR, [
    { start: from, end: range.to, totalCtPerKwh: 20 },
  ]);
  timing.add('heatPump', from - 10 * MINUTE, 1, { key: 'recorded' });
  timing.add('heatPump', from + 10 * MINUTE, 2, { key: 'observed', auxiliaryAssumed: true });
  timing.add('heatPump', from + 40 * MINUTE, 0, { key: 'currents' });
  timing.add('heatPump', from + 45 * MINUTE, 0, { key: 'currents' });
  timing.add('heatPump', from + 50 * MINUTE, 0, { key: 'currents' });
  timing.add('heatPump', from + 60 * MINUTE, 3, { key: 'unknown', auxiliaryUnknown: true });
  timing.add('heatPump', from + 110 * MINUTE, null);
  const result = timing.result().heatPump;
  assert.deepEqual(result.coverageDetails, { elapsedMs: 120 * MINUTE, includedMs: 90 * MINUTE, coverageBasis: 'elapsed-time',
    powerMs: 90 * MINUTE, missingPowerMs: 30 * MINUTE, incompletePriceMs: 0,
    from, to: from + 2 * HOUR, firstPowerAt: from - 10 * MINUTE, lastPowerAt: from + HOUR });
  const sources = Object.fromEntries(result.evidence.sources.map(source => [source.key, source]));
  assert.equal(sources.recorded.durationMs, 10 * MINUTE, 'A carried-in sample counts only its selected overlap');
  assert.equal(sources.recorded.firstAt, from - 10 * MINUTE, 'Show the captured sample time, not the clipped boundary');
  assert.equal(sources.observed.durationMs, 30 * MINUTE);
  assert.equal(sources.currents.durationMs, 20 * MINUTE);
  assert.equal(sources.currents.energyKwh, 0, 'Zero is still evidence coverage');
  assert.equal(sources.currents.firstAt, from + 40 * MINUTE);
  assert.equal(sources.currents.lastAt, from + 50 * MINUTE);
  assert.equal(sources.unknown.durationMs, 30 * MINUTE, 'Missing data after the 30-minute hold is excluded');
  assert.equal(result.evidence.auxiliaryAssumedShare, 1 / 3);
  assert.equal(result.evidence.auxiliaryUnknownShare, 1 / 3);
  assert(Math.abs(result.evidence.sources.reduce((sum, source) => sum + source.share, 0) - 1) < 1e-12);
  assert(Math.abs(result.evidence.sources.reduce((sum, source) => sum + source.energyKwh, 0) - result.energyKwh) < 1e-12);
  assert.deepEqual(timing.result().heatPump, result, 'Reading results again cannot double count the final hold');
});

test('coverage explains missing power separately from incomplete full-day prices and clips future time', () => {
  const range = chartRange({ startDate: date, endDate: '2026-01-16', now });
  const next = from + 24 * HOUR;
  const timing = new DailyTimingBenchmark(range, next + HOUR, [
    { start: from, end: next, totalCtPerKwh: 10 },
    { start: next, end: range.to - 15 * MINUTE, totalCtPerKwh: 20 },
  ]);
  timing.add('heatPump', from, 0, { key: 'recorded' });
  timing.add('heatPump', from + 30 * MINUTE, null);
  timing.add('heatPump', next, 1, { key: 'currents' });
  timing.add('heatPump', next + 30 * MINUTE, null);
  const result = timing.result().heatPump, details = result.coverageDetails;
  assert.equal(details.elapsedMs, 25 * HOUR);
  assert.equal(details.includedMs, 30 * MINUTE);
  assert.equal(details.powerMs, HOUR);
  assert.equal(details.incompletePriceMs, 30 * MINUTE, 'A missing future price slot excludes this whole day');
  assert.equal(details.missingPowerMs, 24 * HOUR);
  assert.equal(details.includedMs + details.incompletePriceMs + details.missingPowerMs, details.elapsedMs);
  assert.deepEqual(result.evidence.sources.map(source => source.key), ['recorded'], 'Excluded values are not part of the included evidence mix');
  const future = new DailyTimingBenchmark(range, from - HOUR).result().heatPump;
  assert.equal(future.coverageDetails.elapsedMs, 0);
  assert.equal(future.coverageDetails.to, from);
  assert.deepEqual(future.evidence.sources, []);
});

test('legacy heat-pump estimates do not replace missing original equipment and dated power assumptions', () => {
  const store = new Store(':memory:');
  try {
    const market = { fetchedAt: from, intervals: [interval(from, from + 24 * HOUR, 10)] };
    const metadata = [
      { basis: 'measured', compressorObserved: false, auxiliaryObserved: false },
      { basis: 'estimated', compressorObserved: true, auxiliaryObserved: false },
      { basis: 'estimated', compressorObserved: false, auxiliaryObserved: true },
      { basis: 'estimated' },
    ];
    for (let index = 0; index < metadata.length; index++) put(store, 'heat_pump_power', index ? 0 : 2,
      from + index * 30 * MINUTE, { unit: 'kW', quality: ['estimated'], raw: metadata[index] });
    // A later sensor reading cannot retroactively supply missing auxiliary data or dated powers.
    put(store, 'compressor_active', 1, from + HOUR, { source: 'husdata-h66', unit: 'state', raw: { usableForControl: true } });
    const result = get(store, { market, contract, now: from + 2 * HOUR }).timingBenefit.heatPump;
    assert.deepEqual(result.evidence.sources, []);
    assert.equal(result.evidence.energyBasis, 'reconstructed-equipment', 'Unavailable explanations still identify required original history');
    assert.equal(result.evidence.timeBasis, 'recorded-interval-time');
    assert.equal(result.coverageDetails.powerMs, 0);
    assert.equal(result.coverageDetails.missingPowerMs, 2 * HOUR);
    assert.equal(result.coverage, 0);
    assert.equal(result.energyKwh, null);
  } finally { store.close(); }
});

test('current charger evidence retains its electrical basis and missing prices still report available power', () => {
  const store = new Store(':memory:');
  try {
    for (let phase = 1; phase <= 3; phase++) put(store, `ev1_current_l${phase}`, 3, from);
    currentPower(store, 1, from + 30 * MINUTE, { unit: 'kW', raw: {
      basis: 'Three coherent phase currents × nominal 230 V; not an energy meter',
    } });
    currentPower(store, 1, from + HOUR, { unit: 'kW' });
    const market = { fetchedAt: from, intervals: [interval(from, from + 24 * HOUR, 10)] };
    const included = get(store, { market, contract, now: from + 90 * MINUTE }).timingBenefit.charger1;
    assert.equal(included.coverage, 1);
    assert(included.value > 0, 'Charging uses the cheaper night transfer rate');
    assert.deepEqual(included.evidence.sources.map(source => [source.key, source.durationMs]),
      [['currents', 90 * MINUTE]]);
    const excluded = get(store, { contract, now: from + 90 * MINUTE }).timingBenefit.charger1;
    assert.equal(excluded.value, null);
    assert.equal(excluded.coverageDetails.powerMs, 90 * MINUTE, 'Historical phase values count even with no prices at all');
    assert.equal(excluded.coverageDetails.incompletePriceMs, 90 * MINUTE);
    assert.equal(excluded.coverageDetails.missingPowerMs, 0);
    assert.deepEqual(excluded.evidence.sources, []);
  } finally { store.close(); }
});

test('simulated timing evidence cannot inherit a physical-meter claim or enter household results', () => {
  const store = new Store(':memory:');
  try {
    const prices = [{ start: from, end: from + 24 * HOUR, allInCentsPerKWh: 10 }];
    put(store, 'heat_pump_power', 2, from, { source: 'controller-estimate', device: 'simulated', unit: 'kW',
      raw: { basis: 'measured', powerBasis: 'measured', auxiliaryObserved: false } });
    recordHeatPumpConfiguration(store, 'simulated', { heatPumpCompressorKw: 3, circulationKw: 0, auxRatedKw: 9 }, from);
    for (let minute = 0; minute < 30; minute += 5) {
      for (const [signal, value, unit] of [['compressor_active', 0.5, 'state'], ['auxiliary_output', 0, '%']])
        put(store, signal, value, from + minute * MINUTE, { source: 'simulation', device: 'synthetic-plant', unit, quality: ['simulated'] });
    }
    const simulated = get(store, { input: 'simulated', simulated: { prices }, now: from + 30 * MINUTE }).timingBenefit.heatPump;
    assert.equal(simulated.evidence.sources[0].key, 'simulated');
    assert.equal(simulated.evidence.sources[0].share, 1);
    assert.equal(simulated.evidence.auxiliaryAssumedShare, 0);
    assert.equal(simulated.energyKwh, 0.75, 'The old scalar meter claim cannot replace recorded simulated operation');
    const household = get(store, { market: { fetchedAt: from, intervals: [interval(from, from + 24 * HOUR, 10)] }, contract }).timingBenefit.heatPump;
    assert.equal(household.value, null);
    assert.equal(household.coverageDetails.powerMs, 0);
  } finally { store.close(); }
});

test('legacy CSV spot slots enable charger timing on short and compact ranges without provider snapshots', async () => {
  const store = new Store(':memory:'), directory = mkdtempSync(join(tmpdir(), 'stmq-timing-'));
  try {
    const file = join(directory, 'synthetic-prices.csv');
    const rows = ['unix_time,price,heat_on,temp_in,temp_ga,temp_out'];
    // The old logger timestamps readings after processing, a few seconds into each slot.
    for (let slot = 0; slot < 96; slot++) rows.push(`${(from + slot * 15 * MINUTE) / 1000 + 7},${slot < 4 ? -10 : 20},15,21,10,-5`);
    writeFileSync(file, rows.join('\n'));
    await importCsv(store, file, { kind: 'stmq' });
    const evFile = join(directory, 'synthetic-charger.csv');
    writeFileSync(evFile, ['unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3',
      `${from / 1000},10,10,10,12,12,12`, `${(from + 30 * MINUTE) / 1000},10,10,10,12,12,12`,
      `${(from + HOUR) / 1000},0,0,0,2,2,2`].join('\n'));
    await importCsv(store, evFile, { kind: 'easee' });
    const current = from + 60 * 24 * HOUR;
    const currentContract = { periods: [{ ...contract.periods[0], from: current }] };
    const result = get(store, { now: current, contract: currentContract });
    const benefit = result.timingBenefit.charger1;
    assert(Math.abs(benefit.energyKwh - 6.9) < 1e-10);
    const expectedAverage = ((-10 + 23 * 20) / 24 + 0.4 + 2.2) * 1.255 + (9 * 1.96 + 15 * 3.34) / 24;
    const expectedActualPrice = (-10 + 0.4 + 2.2) * 1.255 + 1.96;
    assert(Math.abs(benefit.value - 6.9 * (expectedAverage - expectedActualPrice) / 100) < 1e-10);
    assert.equal(benefit.assumedPrices, true);
    assert.equal(result.timingBenefit.heatPump.value, null);
    for (const left of ['power', 'integral', 'learning_aux_profit']) {
      const compact = get(store, { now: current, contract: currentContract, startDate: '2026-01-08', left, points: 100 });
      assert.equal(compact.timingBenefit.charger1.value, benefit.value);
      assert.equal(compact.timingBenefit.charger1.energyKwh, benefit.energyKwh);
      assert.equal(compact.timingBenefit.charger1.assumedPrices, true);
    }
    // An authoritative missing slot is still missing even with known contract rates.
    put(store, 'spot_price', null, from + 8 * HOUR + 10 * 1000);
    const incomplete = get(store, { now: current, contract: currentContract });
    assert.equal(incomplete.timingBenefit.charger1.value, null);
    assert.equal(incomplete.timingBenefit.charger1.assumedPrices, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('rate assumptions in the daily baseline are flagged even when charging has dated rates', () => {
  const store = new Store(':memory:');
  try {
    const partialContract = { periods: [{ ...contract.periods[0], from: from + HOUR }] };
    const market = { fetchedAt: from, intervals: [interval(from, from + HOUR, -10), interval(from + HOUR, from + 24 * HOUR, 20)] };
    currentPower(store, 2, from + HOUR, { unit: 'kW' });
    currentPower(store, 0, from + HOUR + 30 * MINUTE, { unit: 'kW' });
    const result = get(store, { market, contract: partialContract });
    assert(Number.isFinite(result.timingBenefit.charger1.value));
    assert.equal(result.timingBenefit.charger1.assumedPrices, true);
    assert.equal(result.timingBenefit.charger1.priceAssumptions.share, 1,
      'Assumed full-day baseline affects even the energy that has known rates');
    assert.equal(result.timingBenefit.charger1.priceAssumptions.firstAt, from + HOUR);
    assert.equal(result.timingBenefit.charger1.priceAssumptions.lastAt, from + 90 * MINUTE);
    const verified = get(store, { market, contract });
    assert.equal(verified.timingBenefit.charger1.assumedPrices, false);
    assert.equal(result.timingBenefit.charger1.value, verified.timingBenefit.charger1.value);
  } finally { store.close(); }
});

test('archived solar forecast remains separate from future forecast and is never filled into unknown history', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'solar_radiation', 300, now - 10 * MINUTE, { unit: 'W/m²', source: 'fmi', quality: ['forecast'] });
    const weather = { fetchedAt: now, forecast: [{ start: now, end: now + HOUR, outdoorC: 1, solarRadiationWm2: 450, issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now }] };
    const result = get(store, { left: 'solar_radiation', weather });
    assert.equal(result.series.solar_radiation[0].x, now - 10 * MINUTE);
    assert.equal(result.series.solar_forecast[0].x, now);
    assert.equal(result.series.solar_forecast[0].y, 450);
    assert.match(result.meta.warnings.join(' '), /forecast.*not measured/);
  } finally { store.close(); }
});

test('mixed solar providers retain their own provenance through chart points and archived holds', () => {
  const store = new Store(':memory:');
  try {
    const fetchedAt = now - 5 * MINUTE;
    put(store, 'solar_radiation', 300, now - 10 * MINUTE, { unit: 'W/m²', source: 'controller-estimate', quality: ['estimated'],
      raw: { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt, intervalBasis: 'preceding-hour-mean', private: 'not-for-display' } });
    const weather = { source: 'fmi', fetchedAt: now, forecast: [{ start: now, end: now + HOUR, outdoorC: 1,
      solarRadiationWm2: 450, source: 'fmi', issuedAt: now - HOUR, fetchedAt: now,
      solar: { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt, intervalBasis: 'preceding-hour-mean', private: 'not-for-display' } }] };
    const result = get(store, { left: 'solar_radiation', weather });
    for (const key of ['solar_radiation', 'solar_forecast']) {
      for (const point of result.series[key].filter(point => Number.isFinite(point.y))) {
        assert.equal(point.source, 'openmeteo');
        assert.equal(point.issuedAt, null);
        assert.equal(point.issuedAtBasis, 'fetched-snapshot');
        assert.equal(point.fetchedAt, fetchedAt);
        assert.equal(point.intervalBasis, 'preceding-hour-mean');
      }
    }
    assert.equal(result.series.outdoor_forecast[0].source, 'fmi');
    assert.match(result.meta.warnings.join(' '), /FMI forecasts with Open-Meteo as backup/);
    assert.doesNotMatch(JSON.stringify(result), /not-for-display/);
  } finally { store.close(); }
});

test('historical outdoor readings identify sources without turning model estimates into sensor readings', () => {
  const store = new Store(':memory:');
  try {
    for (const [source, minutes] of [['mqtt-temperature', 4], ['husdata-h66', 3], ['fmi', 2], ['openmeteo', 1]])
      put(store, 'outdoor_temperature', -minutes, now - minutes * MINUTE, { source });
    const result = get(store);
    assert.deepEqual(result.series.outdoor_temperature.map(point => point.source), ['mqtt-temperature', 'husdata-h66', 'fmi', 'openmeteo']);
    assert.equal(historySeriesAt(result, now).outdoor_temperature.at(-1).source, 'openmeteo');
    put(store, 'outdoor_temperature', 0, now, { source: 'https://synthetic.invalid/?token=private-fixture' });
    assert.doesNotMatch(JSON.stringify(get(store)), /private-fixture|synthetic\.invalid/);
  } finally { store.close(); }
});

test('Finnish inclusive calendar dates preserve 23/25-hour days and reject invalid ranges', () => {
  assert.equal(chartRange({ startDate: '2026-03-29', now }).to - chartRange({ startDate: '2026-03-29', now }).from, 23 * HOUR);
  assert.equal(chartRange({ startDate: '2026-10-25', now }).to - chartRange({ startDate: '2026-10-25', now }).from, 25 * HOUR);
  assert.equal(chartRange({ startDate: '2026-01-15', endDate: '2026-01-16', now }).to - from, 48 * HOUR);
  assert.equal(chartRange({ now: Date.parse('2026-01-14T22:30:00Z') }).startDate, date);
  assert.throws(() => chartRange({ startDate: '2026-02-30', now }), /Invalid/);
  assert.throws(() => chartRange({ startDate: '2026-01-16', endDate: date, now }), /End date/);
  assert.throws(() => chartRange({ startDate: '2000-01-01', endDate: date, now }), /ten years/);
});

test('combined power requires all three phases from the same timestamp and acquisition', () => {
  const store = new Store(':memory:');
  try {
    for (let phase = 1; phase <= 3; phase++) put(store, `property_current_l${phase}`, phase * 10, from);
    put(store, 'property_current_l1', 10, from + MINUTE);
    put(store, 'property_current_l2', 20, from + MINUTE);
    put(store, 'property_current_l3', 30, from + MINUTE + 1);
    for (let phase = 1; phase <= 3; phase++) put(store, `ev1_current_l${phase}`, 6, from + 2 * MINUTE,
      { receivedAt: from + 2 * MINUTE + phase });
    const result = get(store);
    assert.equal(result.series.property_power[0].y, 13.8);
    assert(result.series.property_power.some(point => point.x === from + MINUTE && point.y === null));
    assert(result.series.charger_power.every(point => point.y === null));
    assert.match(result.meta.powerEstimate, /Phase allocation and energy integration are estimates/);
    assert(!Object.hasOwn(result.series, 'property_current_l1'));
    const phaseView = get(store, { left: 'phases' });
    assert.equal(phaseView.series.property_current_l1[0].y, 10);
    assert(!Object.hasOwn(phaseView.series, 'property_power'));
  } finally { store.close(); }
});

test('Easee power combines one acquisition with independent phase event timestamps', () => {
  const store = new Store(':memory:');
  try {
    const receivedAt = from + MINUTE;
    const timestamps = [from - 4 * HOUR, from - 45 * MINUTE, from + 1300];
    for (let phase = 1; phase <= 3; phase++) {
      put(store, `property_current_l${phase}`, phase * 10, timestamps[phase - 1], {
        source: 'easee', device: 'fixture-equalizer', receivedAt,
        // Older adapter versions flagged both devices when only the idle
        // charger's timestamps lagged. The chart rechecks each device itself.
        quality: ['current_snapshot_not_energy', 'asynchronous_snapshot'],
      });
      put(store, `ev1_current_l${phase}`, 0, from - 2 * HOUR, {
        source: 'easee', device: 'fixture-charger', receivedAt,
        quality: ['current_snapshot_not_energy', 'stale', 'asynchronous_snapshot'],
      });
    }
    put(store, 'indoor_temperature', 21, from + 500);
    const result = get(store);
    assert.deepEqual(result.series.property_power, [{ x: timestamps[2], y: 13.8 }]);
    assert.deepEqual(result.meta.lastReadings.property_power, { x: timestamps[2], y: 13.8 });
    assert.equal(historySeriesAt(result).property_power.at(-1).y, 13.8);
    assert.equal(historySeriesAt(result).charger_power.at(-1).y, 0);
    assert.equal(result.series.indoor_temperature[0].y, 21);
    const phaseView = get(store, { left: 'phases' });
    for (let phase = 1; phase <= 3; phase++)
      assert.equal(phaseView.meta.lastReadings[`property_current_l${phase}`].x, timestamps[phase - 1]);
  } finally { store.close(); }
});

test('Easee total power accepts independent event clocks but rejects missing phases and mixed devices or acquisitions', () => {
  const store = new Store(':memory:');
  try {
    const phase = (number, at, extra = {}) => put(store, `property_current_l${number}`, 10, at, {
      source: 'easee', device: 'fixture-equalizer', receivedAt: from + MINUTE, ...extra,
    });
    phase(1, from); phase(2, from + 100); phase(3, from + 30_000);
    phase(1, from + MINUTE, { receivedAt: from + 2 * MINUTE });
    phase(2, from + MINUTE + 100, { receivedAt: from + 2 * MINUTE });
    phase(3, from + MINUTE + 30_001, { receivedAt: from + 2 * MINUTE });
    phase(1, from + 2 * MINUTE, { receivedAt: from + 3 * MINUTE });
    phase(2, from + 2 * MINUTE + 100, { receivedAt: from + 3 * MINUTE });
    phase(3, from + 2 * MINUTE + 200, { receivedAt: from + 3 * MINUTE + 1 });
    phase(1, from + 3 * MINUTE, { receivedAt: from + 4 * MINUTE });
    phase(2, from + 3 * MINUTE + 100, { receivedAt: from + 4 * MINUTE });
    phase(3, from + 3 * MINUTE + 200, { receivedAt: from + 4 * MINUTE, device: 'other-fixture-equalizer' });
    phase(1, from + 4 * MINUTE, { receivedAt: from + 5 * MINUTE });
    phase(2, from + 4 * MINUTE + 100, { receivedAt: from + 5 * MINUTE });
    const result = get(store);
    assert.deepEqual(result.series.property_power.filter(point => point.y !== null), [
      { x: from + 30_000, y: 6.9 }, { x: from + MINUTE + 30_001, y: 6.9 },
    ]);
    assert.equal(result.meta.lastReadings.property_power.y, null);
    assert.equal(historySeriesAt(result).property_power.at(-1).y, null, 'A missing latest phase cannot revive an earlier total');
  } finally { store.close(); }
});

test('Easee power loads unchanged phases outside historical scan bounds without joining other polls', () => {
  const store = new Store(':memory:');
  try {
    const receivedAt = from + HOUR;
    const timestamps = [from - 5 * 24 * HOUR, from - 4 * HOUR, from + MINUTE];
    for (const [i, at] of timestamps.entries()) put(store, `property_current_l${i + 1}`, 10, at, {
      source: 'easee', device: 'fixture-equalizer', receivedAt, quality: ['asynchronous_snapshot', 'stale'],
    });
    const count = store.db.prepare('SELECT count(*) AS total FROM observations').get().total;
    for (const chartNow of [now, now + 2 * 24 * HOUR]) {
      const result = get(store, { now: chartNow });
      assert.deepEqual(result.series.property_power, [{ x: from + MINUTE, y: 6.9 }]);
      assert.deepEqual(result.meta.lastReadings.property_power, { x: from + MINUTE, y: 6.9 });
    }
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM observations').get().total, count);
  } finally { store.close(); }
});

test('Easee power keeps missing or unknown-time phases invalid after a complete older poll', () => {
  for (const invalid of [{ value: null }, { sourceTime: null }, { sourceTime: now + MINUTE, quality: ['future_source_time'] }]) {
    const store = new Store(':memory:');
    try {
      const putPhase = (phase, at, extra = {}) => store.observation({ source: 'easee', device: 'fixture-equalizer',
        signal: `property_current_l${phase}`, value: 10, unit: 'A', sourceTime: at, receivedAt: at, ...extra });
      for (const phase of [1, 2, 3]) putPhase(phase, from);
      putPhase(1, from + MINUTE);
      putPhase(2, from - HOUR, { receivedAt: from + MINUTE });
      putPhase(3, from - 2 * HOUR, { receivedAt: from + MINUTE, ...invalid });
      const result = get(store);
      assert.equal(result.meta.lastReadings.property_power.y, null);
      assert.equal(historySeriesAt(result).property_power.at(-1).y, null);
    } finally { store.close(); }
  }
});

test('a newer invalid Easee poll supersedes a complete poll with the same source timestamps', () => {
  const store = new Store(':memory:');
  try {
    for (const receivedAt of [from + MINUTE, from + 2 * MINUTE]) {
      for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`,
        phase === 3 && receivedAt === from + 2 * MINUTE ? null : 10, from, {
          source: 'easee', device: 'fixture-equalizer', receivedAt,
        });
    }
    const result = get(store);
    assert.deepEqual(result.series.property_power, [{ x: from, y: null }]);
    assert.equal(historySeriesAt(result).property_power.at(-1).y, null);
  } finally { store.close(); }
});

test('all right-axis history stays present; bad readings and long gaps remain breaks, absence remains visible', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 20, from, { quality: ['absence_heating_off_approximate', 'excluded_occupied_training'] });
    put(store, 'indoor_temperature', 0, from + HOUR, { quality: ['suspect_zero_indoor'] });
    put(store, 'indoor_temperature', 21, from + 8 * HOUR);
    put(store, 'garage_temperature', 12, from + 10 * HOUR);
    put(store, 'outdoor_temperature', -4, from + 10 * HOUR);
    put(store, 'heating_integral', -200, from + HOUR, { unit: 'degree-minutes' });
    put(store, 'indoor_temperature', 98, now + MINUTE);
    const result = get(store, { left: 'integral' });
    assert.equal(result.series.indoor_temperature[0].y, 20);
    assert(result.series.indoor_temperature.some(point => point.y === null));
    assert(!result.series.indoor_temperature.some(point => point.y === 98));
    assert.equal(result.series.garage_temperature[0].y, 12);
    assert.equal(result.series.outdoor_temperature[0].y, -4);
    assert.equal(result.series.heating_integral[0].y, -200);
  } finally { store.close(); }
});

test('shading respects bounded requests, DHWR pulses and separately verified compressor routing', () => {
  const store = new Store(':memory:');
  try {
    csvRequest(store, 0, from - 5 * MINUTE, { quality: ['requested_not_observed'], unit: 'legacy_command' });
    csvRequest(store, 15, from + 10 * MINUTE);
    csvRequest(store, 60, from + HOUR);
    csvRequest(store, 15, from + 2 * HOUR);
    csvRequest(store, 0, from + 4 * HOUR);
    const aux = { source: 'husdata-h66', unit: '%', raw: { verified: 'Installed fixture verification', usableForControl: true } };
    put(store, 'auxiliary_output', 50, from + HOUR, aux);
    put(store, 'auxiliary_output', 0, from + HOUR + 2 * MINUTE, aux);
    put(store, 'auxiliary_output', 100, from + 3 * HOUR, { ...aux, raw: { verified: null } });
    put(store, 'compressor_active', 1, from + HOUR, { ...aux, unit: 'state' });
    put(store, 'dhw_routing', 0, from + HOUR, { ...aux, unit: 'state' });
    put(store, 'operating_mode', 1, from + HOUR, { ...aux, unit: 'state' });
    put(store, 'dhw_routing', 1, from + HOUR + 2 * MINUTE, { ...aux, unit: 'state' });
    store.counter({ signal: 'auxiliary_3kw_hours', value: 500, observedDate: date });
    store.event('decision', { input: 'offline', action: 'reduction', commands: ['reduction'], execution: 'shadow' }, from + 6 * HOUR);
    const result = get(store);
    assert.deepEqual(result.shading.heatOff, [{ start: from, end: from + 10 * MINUTE }, { start: from + 4 * HOUR, end: from + 4 * HOUR + 30 * MINUTE }]);
    assert.deepEqual(result.shading.dhwr, [{ start: from + HOUR, end: from + HOUR + 10 * MINUTE }]);
    assert.equal(result.shading.auxHeat, undefined);
    assert.deepEqual(result.shading.compressorSpace, [{ start: from + HOUR, end: from + HOUR + 2 * MINUTE }]);
    assert.deepEqual(result.shading.compressorDhw, [{ start: from + HOUR + 2 * MINUTE, end: from + HOUR + 5 * MINUTE }]);
    assert.deepEqual(result.operatingModes, [{ start: from + HOUR, end: from + HOUR + 5 * MINUTE, value: 1 }]);
  } finally { store.close(); }
});

test('all-in history uses nearest dated rates with an explicit assumption and still requires a contract', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'spot_price', -4, from);
    put(store, 'spot_price', 8, from + 8 * HOUR);
    const unconfigured = get(store);
    assert.equal(unconfigured.series.spot_price[0].y, -4);
    assert.deepEqual(unconfigured.series.all_in_price, []);
    const priced = get(store, { contract });
    assert(Math.abs(priced.series.all_in_price[0].y - ((-4 + 0.4 + 2.2) * 1.255 + 1.96)) < 1e-10);
    assert(Math.abs(priced.series.all_in_price.at(-1).y - ((8 + 0.4 + 2.2) * 1.255 + 3.34)) < 1e-10);
    const futureRates = { periods: [{ ...contract.periods[0], from: from + 7 * HOUR }] };
    const partial = get(store, { contract: futureRates });
    assert.equal(partial.series.all_in_price[0].y, priced.series.all_in_price[0].y);
    assert.equal(partial.series.all_in_price[0].assumedPrice, true);
    assert(partial.series.all_in_price.at(-1).y > 0);
    assert.equal(partial.series.all_in_price.at(-1).assumedPrice, false);
    assert.equal(partial.meta.priceAssumptions.used, true);
    assert.equal(priced.meta.priceAssumptions.used, false);
  } finally { store.close(); }
});

test('stored market snapshots preserve old prices and latest differently partitioned revisions win', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'spot_price', 99, from);
    store.snapshot({ kind: 'market', source: 'fixture', fetchedAt: from - HOUR,
      payload: { intervals: [interval(from, from + HOUR, 1)] } });
    store.snapshot({ kind: 'market', source: 'fixture', fetchedAt: from,
      payload: { intervals: [interval(from + 15 * MINUTE, from + 30 * MINUTE, 2)] } });
    const result = get(store, { contract });
    assert.equal(result.series.spot_price[0].y, 1);
    assert.equal(result.series.spot_price.find(point => point.x === from + 15 * MINUTE).y, 2);
    assert.equal(result.series.spot_price.find(point => point.x === from + 30 * MINUTE).y, 1);
    assert(!result.series.spot_price.some(point => point.y === 99));
    const oldView = get(store, { now: from + 20 * 24 * HOUR });
    assert(oldView.series.spot_price.some(point => point.y === 2));
  } finally { store.close(); }
});

test('provider intervals override reconstructed spot slots across partial and missing slots without overlap', () => {
  const store = new Store(':memory:');
  try {
    for (let slot = 0; slot < 96; slot++)
      put(store, 'spot_price', slot === 1 ? null : 10, from + slot * 15 * MINUTE + 7000);
    currentPower(store, 2, from, { unit: 'kW' });
    currentPower(store, 2, from + 30 * MINUTE, { unit: 'kW' });
    currentPower(store, 0, from + HOUR, { unit: 'kW' });
    const override = interval(from + 5 * MINUTE, from + 35 * MINUTE, -10);
    const market = { fetchedAt: from, intervals: [override] };
    const result = get(store, { contract, market, now: from + 24 * HOUR });
    const explicit = get(store, { contract, now: from + 24 * HOUR, market: { ...market, intervals: [
      interval(from, override.start, 10), override, interval(override.end, from + 24 * HOUR, 10)] } });
    assert(Number.isFinite(result.timingBenefit.charger1.value));
    for (const key of ['value', 'actualCostEuro', 'uniformCostEuro', 'energyKwh', 'coverage'])
      assert(Math.abs(result.timingBenefit.charger[key] - explicit.timingBenefit.charger[key]) < 1e-10, key);
    assert.equal(result.series.spot_price.find(point => point.x === override.start).y, -10);
    assert.equal(result.series.spot_price.find(point => point.x === override.end).y, 10);
  } finally { store.close(); }
});

test('weather and future prices are clipped to selected days and stale forecasts stay absent', () => {
  const store = new Store(':memory:');
  try {
    const market = { fetchedAt: now, intervals: [interval(from, from + 24 * HOUR, 5), interval(from + 24 * HOUR, from + 48 * HOUR, 5)] };
    const forecast = [{ start: from, end: from + 48 * HOUR, outdoorC: -5, issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now }];
    const weather = { fetchedAt: now, forecast };
    const result = get(store, { market, weather });
    assert(result.series.spot_price.every(point => point.x >= from && point.x < from + 24 * HOUR));
    assert.equal(result.series.outdoor_forecast[0].x, now);
    assert(result.series.outdoor_forecast.every(point => point.x < from + 24 * HOUR));
    const tomorrow = get(store, { market, weather, startDate: '2026-01-16', endDate: '2026-01-16' });
    assert.equal(tomorrow.range.from, from + 24 * HOUR);
    assert.equal(tomorrow.series.outdoor_forecast[0].x, from + 24 * HOUR);
    assert.deepEqual(get(store, { weather: { fetchedAt: now - 7 * HOUR, forecast } }).series.outdoor_forecast, []);
  } finally { store.close(); }
});

test('simulation remains isolated and only the supplied known synthetic outlook is shown', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 21, from, { source: 'simulation' });
    put(store, 'indoor_temperature', 18, from);
    const simulated = { prices: [{ start: now, end: now + HOUR, allInCentsPerKWh: 7 }],
      forecast: [{ start: now, end: now + HOUR, outdoorC: -2 }] };
    const result = get(store, { input: 'simulated', simulated });
    assert.equal(result.series.indoor_temperature[0].y, 21);
    assert.equal(result.series.all_in_price[0].x, now);
    assert.equal(result.series.all_in_price.at(-1).x, now + HOUR - 1);
    assert.equal(get(store).series.indoor_temperature[0].y, 18);
  } finally { store.close(); }
});

test('pixel envelope retains peaks, endpoints and missing-data breaks within a bounded response', () => {
  const envelope = new Envelope(0, 100_000, 100);
  for (let x = 0; x < 100_000; x++) envelope.add(x, x === 12345 ? 999 : x === 56789 ? -999 : x === 100 ? null : Math.sin(x));
  const result = envelope.values();
  assert(result.length <= 700);
  assert.equal(result[0].x, 0);
  assert.equal(result.at(-1).x, 99999);
  assert(result.some(point => point.y === 999));
  assert(result.some(point => point.y === -999));
  assert(result.some(point => point.x === 100 && point.y === null));
});

test('combined history scans beyond old 5000-row limit and retains both date-range ends', () => {
  const store = new Store(':memory:');
  try {
    store.transaction(() => {
      for (let index = 0; index < 12_000; index++) put(store, 'indoor_temperature', index === 8000 ? 30 : 20, from + index * 1000);
    });
    const result = get(store, { points: 100 });
    assert.equal(result.meta.rawRows, 12_000);
    assert.equal(result.series.indoor_temperature[0].x, from);
    assert.equal(result.series.indoor_temperature.at(-1).x, from + 11_999_000);
    assert(result.series.indoor_temperature.some(point => point.y === 30));
    assert(result.series.indoor_temperature.length <= 700);
  } finally { store.close(); }
});

test('compact original-row queries match expanded observations for duplicates, missing phases, gaps and source precedence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-import-'));
  const store = new Store(':memory:');
  try {
    const stmqPath = join(directory, 'stmq.csv'), easeePath = join(directory, 'easee.csv');
    writeFileSync(stmqPath, 'unix_time,price,heat_on,temp_in,temp_ga,temp_out\n' + [
      [from - HOUR, 2, 0, 20, 11, -2], [from, 3, 0, 20, 11, -2],
      [from + HOUR, -4, 60, 21, '', -3], [from + HOUR, -3, 60, 22, 12, -3],
      [from + 6 * HOUR, 2, 15, 0, 11, -2], [from + 8 * HOUR, 3, 0, 20, 11, -2],
    ].map(([at, ...values]) => [at / 1000, ...values].join(',')).join('\n'));
    writeFileSync(easeePath, 'unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n' + [
      [from, 2, 2, 2, 4, 5, 6], [from + HOUR, 2, '', 2, 4, 5, 6],
      [from + HOUR, 3, 3, 3, 5, 6, 7], [from + 8 * HOUR, 2, 2, 2, 4, 5, 6],
    ].map(([at, ...values]) => [at / 1000, ...values].join(',')).join('\n'));
    await importCsv(store, stmqPath, { kind: 'stmq' });
    await importCsv(store, easeePath, { kind: 'easee' });
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 10, from + HOUR);
    put(store, 'indoor_temperature', 23, from + HOUR);
    for (const left of ['power', 'phases', 'integral']) {
      const single = get(store, { left, contract, points: 2000 });
      const long = get(store, { left, contract, points: 2000, endDate: '2026-01-24' });
      assert.deepEqual(long.series, single.series, `${left}: compact and expanded points must agree`);
      assert.deepEqual(long.shading, single.shading, `${left}: shading must agree`);
      assert.equal(long.meta.invalidRows, single.meta.invalidRows);
      assert.equal(long.meta.rawRows, single.meta.rawRows);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('worker cache invalidates on new observations; aborts release the bounded queue and shutdown rejects work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-test-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const service = createChartService({ store, maxQueue: 1 });
  const args = { now, startDate: date, endDate: date };
  try {
    put(store, 'indoor_temperature', 20, from);
    const cancellation = new AbortController();
    const first = service.query(args, { signal: cancellation.signal });
    await assert.rejects(service.query(args), /Too many pending/);
    cancellation.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal((await service.query(args)).series.indoor_temperature[0].y, 20);
    assert.equal((await service.query(args)).meta.cacheHit, true);
    store.setState('synthetic-recorder-checkpoint',{polls:2});
    assert.equal((await service.query(args)).meta.cacheHit,true,'Unrelated checkpoint writes retain the history cache');
    put(store, 'indoor_temperature', 22, from + HOUR);
    const refreshed = await service.query(args);
    assert.equal(refreshed.series.indoor_temperature.at(-1).y, 22);
    assert.notEqual(refreshed.meta.cacheHit, true);
    await service.close();
    await assert.rejects(service.query(args), /closed/);
  } finally { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native scalar readings remain authoritative when CSV history is imported later, for every date-range path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-precedence-'));
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 21, from);
    put(store, 'indoor_temperature', 23, from);
    put(store, 'spot_price', 9, from);
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 10 + phase, from);
    const stmqPath = join(directory, 'stmq.csv'), easeePath = join(directory, 'easee.csv');
    writeFileSync(stmqPath, `unix_time,price,heat_on,temp_in,temp_ga,temp_out\n${from / 1000},2,15,18,11,-2\n${from / 1000},3,15,19,12,-3\n`);
    writeFileSync(easeePath, `unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n${from / 1000},2,2,2,4,5,6\n${from / 1000},3,3,3,5,6,7\n`);
    await importCsv(store, stmqPath, { kind: 'stmq' });
    await importCsv(store, easeePath, { kind: 'easee' });
    for (const left of ['power', 'phases', 'integral']) {
      const single = get(store, { left, contract, points: 2000 });
      const long = get(store, { left, contract, points: 2000, endDate: '2026-01-24' });
      assert.equal(single.series.indoor_temperature[0].y, 23, `${left}: newest native temperature wins`);
      assert.equal(single.series.spot_price[0].y, 9, `${left}: native spot price wins`);
      assert.equal(single.series.garage_temperature[0].y, 12, `${left}: newest imported row wins without native data`);
      assert.deepEqual(single.series.model_indoor_temperature, [], 'CSV temperatures stay raw until their original model inputs are committed');
      if (left === 'phases') assert.equal(single.series.property_current_l1[0].y, 11);
      assert.deepEqual(long.series, single.series, `${left}: range length cannot change source precedence`);
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('live charts recover old unchanged readings and expose original timestamps for display-only tails', () => {
  const store = new Store(':memory:');
  try {
    const recordedAt = from - 2 * 24 * HOUR;
    for (const [signal, value] of [['indoor_temperature', 21], ['downstairs_temperature', 20], ['bedroom_temperature', 19], ['garage_temperature', 12], ['outdoor_temperature', -4]])
      put(store, signal, value, recordedAt);
    for (const phase of [1, 2, 3]) {
      put(store, `property_current_l${phase}`, phase, recordedAt);
      put(store, `ev1_current_l${phase}`, 0, recordedAt);
    }
    // An update before the visible day must supersede an older seed without
    // inserting an artificial missing marker at the start of the day.
    put(store, 'garage_temperature', 13, from - HOUR);
    put(store, 'heating_integral', -200, recordedAt, { unit: 'degree-minutes' });
    const count = store.db.prepare('SELECT count(*) AS total FROM observations').get().total;
    for (const left of ['power', 'phases', 'integral']) {
      const result = get(store, { left });
      const projected = historySeriesAt(result, now);
      for (const key of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature',
        ...(left === 'power' ? ['property_power', 'charger_power'] : left === 'phases'
          ? ['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)) : ['heating_integral'])]) {
        assert.equal(projected[key][0].x, from, `${key} starts at the chosen day`);
        assert.equal(projected[key].at(-1).x, now, `${key} reaches now`);
        assert.equal(projected[key].at(-1).observedAt, key === 'garage_temperature' ? from - HOUR : recordedAt);
        assert.equal(result.series[key].length, 0, 'The API still describes actual recorded history');
      }
      assert.equal(projected.garage_temperature.at(-1).y, 13);
      assert.deepEqual(result.series.spot_price, []);
    }
    assert.equal(store.db.prepare('SELECT count(*) AS total FROM observations').get().total, count, 'Projection never appends observations');
    assert.deepEqual(get(store, { now: now + 3 * 24 * HOUR }).series.indoor_temperature, [], 'Historical selections stay unchanged');
  } finally { store.close(); }
});

test('raw indoor location history preserves independent values and missing optional sensors', () => {
  const store = new Store(':memory:');
  try {
    put(store, 'indoor_temperature', 23, from);
    let result = get(store);
    assert.deepEqual(result.series.downstairs_temperature, []);
    assert.deepEqual(result.series.bedroom_temperature, []);
    put(store, 'downstairs_temperature', 20, from);
    put(store, 'bedroom_temperature', 19, from);
    put(store, 'downstairs_temperature', null, from + HOUR, { quality: ['missing'] });
    result = get(store);
    assert.equal(result.series.indoor_temperature[0].y, 23);
    assert.equal(result.series.downstairs_temperature[0].y, 20);
    assert.equal(result.series.bedroom_temperature[0].y, 19);
    assert(result.series.downstairs_temperature.some(point => point.y === null));
    assert.equal(result.meta.lastReadings.downstairs_temperature.y, null);
    assert.equal(result.meta.lastReadings.bedroom_temperature.y, 19);
  } finally { store.close(); }
});

test('latest invalid readings and incomplete current acquisitions cannot revive old carried-forward values', () => {
  const store = new Store(':memory:');
  try {
    const old = from - 2 * 24 * HOUR;
    put(store, 'indoor_temperature', 21, old);
    put(store, 'indoor_temperature', 0, old + HOUR, { quality: ['suspect_zero_indoor'] });
    for (const phase of [1, 2, 3]) put(store, `property_current_l${phase}`, 5, old);
    put(store, 'property_current_l1', 6, old + HOUR);
    put(store, 'garage_temperature', 14, old, { source: 'simulation' });
    const result = get(store);
    assert.equal(result.meta.lastReadings.indoor_temperature.y, null);
    assert.equal(result.meta.lastReadings.property_power.y, null);
    const projected = historySeriesAt(result);
    assert.deepEqual(projected.indoor_temperature, []);
    assert.deepEqual(projected.property_power, []);
    assert.deepEqual(projected.garage_temperature, [], 'Non-simulation charts cannot seed from synthetic readings');
    assert.equal(historySeriesAt(get(store, { input: 'simulated' })).garage_temperature.at(-1).y, 14);
  } finally { store.close(); }
});
