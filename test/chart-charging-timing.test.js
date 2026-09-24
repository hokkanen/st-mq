import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyTimingBenchmark, chartRange } from '../src/app/chart-data.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const day = chartRange({ startDate: '2026-09-08', now: Date.parse('2026-09-10T00:00:00Z') });
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const prices = [{ start: day.from, end: day.to, totalCtPerKwh: 20, assumedPrice: true }];

test('charger snapshots exclude zero, standby and exactly 100 W while heating keeps the same observations', () => {
  const range = { from: day.from, to: day.from + 2 * HOUR };
  const timing = new DailyTimingBenchmark(range, range.to, prices);
  for (const name of ['charger1', 'heatPump']) {
    for (const [index, kw] of [0, 0.05, 0.1, 0.1001].entries())
      timing.add(name, day.from + index * 30 * MINUTE, kw, { key: index < 3 ? 'recorded' : 'currents' });
  }
  const { charger1: charger, heatPump } = timing.result();
  assert.equal(charger.coverageDetails.coverageBasis, 'elapsed-time');
  assert.equal(charger.coverageDetails.minimumPowerKw, 0.1);
  assert.equal(charger.coverageDetails.chargingMs, 30 * MINUTE);
  assert.equal(charger.coverageDetails.idleMs, 90 * MINUTE);
  assert.equal(charger.coverageDetails.powerMs, 2 * HOUR);
  assert.equal(charger.coverageDetails.missingPowerMs, 0);
  assert.equal(charger.coverageDetails.firstPowerAt, day.from + 90 * MINUTE);
  assert.equal(charger.coverageDetails.lastPowerAt, day.from + 90 * MINUTE);
  assert.equal(charger.coverage, 0.25);
  assert.equal(charger.provisional, false);
  near(charger.energyKwh, 0.1001 / 2);
  assert.deepEqual(charger.evidence.sources.map(source => [source.key, source.share]), [['currents', 1]]);
  assert.equal(charger.priceAssumptions.durationMs, 30 * MINUTE);
  assert.equal(charger.priceAssumptions.firstAt, day.from + 90 * MINUTE);
  assert.equal(charger.priceAssumptions.lastAt, range.to);
  assert.equal(charger.priceAssumptions.share, 1);
  assert.equal(heatPump.coverageDetails.includedMs, 2 * HOUR);
  assert.equal(heatPump.coverageDetails.firstPowerAt, day.from);
  assert.equal(heatPump.coverage, 1);
  near(heatPump.energyKwh, (0.05 + 0.1 + 0.1001) / 2);
  assert.deepEqual(heatPump.evidence.sources.map(source => [source.key, source.share]), [['recorded', 0.75], ['currents', 0.25]]);
  assert.equal(heatPump.priceAssumptions.durationMs, 2 * HOUR);
});

test('fully observed idle charging is unavailable rather than zero savings, even without prices', () => {
  const range = { from: day.from, to: day.from + 90 * MINUTE };
  for (const priceRows of [prices, []]) {
    const timing = new DailyTimingBenchmark(range, range.to, priceRows);
    for (const [index, kw] of [0, 0.05, 0.1].entries())
      timing.add('charger1', day.from + index * 30 * MINUTE, kw, { key: 'recorded' });
    const result = timing.result().charger1;
    for (const key of ['value', 'energyKwh', 'actualCostEuro', 'uniformCostEuro']) assert.equal(result[key], null);
    assert.equal(result.coverage, 0);
    assert.equal(result.provisional, false, 'Known idle time needs no timing prices');
    assert.equal(result.coverageDetails.chargingMs, 0);
    assert.equal(result.coverageDetails.idleMs, 90 * MINUTE);
    assert.equal(result.coverageDetails.missingPowerMs, 0);
    assert.equal(result.coverageDetails.incompletePriceMs, 0);
    assert.equal(result.coverageDetails.firstPowerAt, null);
    assert.equal(result.coverageDetails.lastPowerAt, null);
    assert.deepEqual(result.evidence.sources, []);
    assert.equal(result.priceAssumptions.durationMs, 0);
    assert.equal(result.assumedPrices, false);
  }
});

test('the same included duration gives heating and charging the same elapsed-time percentage', () => {
  const timing = new DailyTimingBenchmark(day, day.to, prices);
  for (const name of ['heatPump', 'charger1'])
    timing.addEnergy(name, day.from, day.from + HOUR, 6, { key: 'recorded' });
  timing.addEnergy('charger1', day.from + HOUR, day.to, 0, { key: 'recorded' });
  const { heatPump, charger1: charger } = timing.result();
  for (const result of [heatPump, charger]) {
    assert.equal(result.coverageDetails.coverageBasis, 'elapsed-time');
    assert.equal(result.coverageDetails.elapsedMs, 24 * HOUR);
    assert.equal(result.coverageDetails.includedMs, HOUR);
    assert.equal(result.coverage, 1 / 24);
    assert.equal(result.evidence.sources[0].share, 1, 'Source shares still describe only the included time');
    assert.equal(result.priceAssumptions.share, 1, 'Rate assumptions still describe only the included time');
  }
  assert.equal(heatPump.provisional, true, 'Missing history makes the heating result partial');
  assert.equal(charger.provisional, false, 'Known idle time alone does not make the charging result partial');
});

test('both percentages count only elapsed selected time and exclude the future', () => {
  const now = day.from + 2 * HOUR;
  const timing = new DailyTimingBenchmark(day, now, prices);
  for (const name of ['heatPump', 'charger1']) {
    timing.addEnergy(name, day.from - HOUR, day.from + HOUR, 12, { key: 'recorded' });
    timing.addEnergy(name, day.from + HOUR, day.to, 0, { key: 'recorded' });
  }
  const result = timing.result();
  for (const name of ['heatPump', 'charger1']) {
    assert.equal(result[name].coverageDetails.elapsedMs, 2 * HOUR);
    assert.equal(result[name].coverageDetails.to, now);
    assert.equal(result[name].coverageDetails.powerMs, 2 * HOUR);
    assert.equal(result[name].energyKwh, 6, 'Energy before and after the elapsed selection is excluded');
    assert.equal(result[name].provisional, true, 'A current period remains in progress');
  }
  assert.equal(result.heatPump.coverage, 1);
  assert.equal(result.charger1.coverage, 0.5);
  assert.equal(result.charger1.coverageDetails.idleMs, HOUR);

  const future = new DailyTimingBenchmark(day, day.from - HOUR, prices).result();
  for (const name of ['heatPump', 'charger1']) {
    assert.equal(future[name].coverageDetails.elapsedMs, 0);
    assert.equal(future[name].coverageDetails.includedMs, 0);
    assert.equal(future[name].coverage, 0);
  }
});

test('unknown history and idle remain separate while coverage includes both in elapsed time', () => {
  const range = { from: day.from, to: day.from + 3 * HOUR };
  const timing = new DailyTimingBenchmark(range, range.to, prices);
  for (const [minutes, kw, key] of [[0, 6, 'recorded'], [30, 0, 'recorded'], [60, 0.05, 'recorded'],
    [90, 2, 'currents'], [120, 2, 'currents'], [150, null, 'unknown']])
    timing.add('charger1', day.from + minutes * MINUTE, kw, { key });
  const result = timing.result().charger1, details = result.coverageDetails;
  assert.equal(details.chargingMs, 90 * MINUTE);
  assert.equal(details.includedMs, 90 * MINUTE);
  assert.equal(details.idleMs, HOUR);
  assert.equal(details.missingPowerMs, 30 * MINUTE);
  assert.equal(details.powerMs, 150 * MINUTE);
  assert.equal(details.incompletePriceMs, 0);
  assert.equal(details.includedMs + details.idleMs + details.missingPowerMs + details.incompletePriceMs, details.elapsedMs);
  assert.equal(result.coverage, 0.5);
  assert.equal(result.provisional, true, 'Unknown time remains missing data, even when all charging has prices');
  near(result.energyKwh, 5);
  assert.deepEqual(result.evidence.sources.map(source => [source.key, source.share]), [['recorded', 1 / 3], ['currents', 2 / 3]]);
  assert.equal(result.evidence.sources[0].lastAt, day.from, 'Idle readings cannot extend active evidence dates');
  assert.deepEqual(timing.result().charger1, result, 'Repeated reads do not accumulate time');

  const unknown = new DailyTimingBenchmark(range, range.to, prices).result().charger1;
  assert.equal(unknown.coverageDetails.idleMs, 0);
  assert.equal(unknown.coverageDetails.missingPowerMs, 3 * HOUR);
  assert.equal(unknown.provisional, true);
  const gap = new DailyTimingBenchmark(range, range.to, prices);
  gap.add('charger1', day.from, 0);
  const gapResult = gap.result().charger1;
  assert.equal(gapResult.coverageDetails.idleMs, 30 * MINUTE, 'An idle snapshot still expires after the normal hold');
  assert.equal(gapResult.coverageDetails.missingPowerMs, 150 * MINUTE);
});

test('missing whole-day prices exclude only active time, including gaps outside the charging hours', () => {
  const range = { from: day.from, to: day.to + 24 * HOUR };
  const timing = new DailyTimingBenchmark(range, range.to, [
    ...prices, { start: day.to, end: range.to - 15 * MINUTE, totalCtPerKwh: 30 },
  ]);
  timing.addEnergy('charger1', day.from, day.from + HOUR, 6, { key: 'recorded' });
  timing.addEnergy('charger1', day.from + HOUR, day.to, 0, { key: 'recorded' });
  timing.addEnergy('charger1', day.to, day.to + 2 * HOUR, 12, { key: 'recorded' });
  timing.addEnergy('charger1', day.to + 2 * HOUR, range.to, 0.02, { key: 'recorded' });
  const result = timing.result().charger1, details = result.coverageDetails;
  assert.equal(details.chargingMs, 3 * HOUR);
  assert.equal(details.includedMs, HOUR);
  assert.equal(details.idleMs, 45 * HOUR);
  assert.equal(details.incompletePriceMs, 2 * HOUR);
  assert.equal(details.missingPowerMs, 0);
  assert.equal(details.powerMs, 48 * HOUR);
  assert.equal(result.coverage, 1 / 48);
  assert.equal(result.provisional, true);
  assert.equal(result.energyKwh, 6);
  assert.equal(result.evidence.sources[0].durationMs, HOUR);
  assert.equal(result.evidence.sources[0].lastAt, day.from + HOUR);
  assert.equal(result.priceAssumptions.durationMs, HOUR);
});

test('idle recorded intervals cannot make active legacy charging appear to use recorded energy', () => {
  const range = { from: day.from, to: day.from + 2 * HOUR };
  const timing = new DailyTimingBenchmark(range, range.to, prices);
  timing.add('charger1', day.from, 6, { key: 'currents' });
  timing.add('charger1', day.from + 30 * MINUTE, null);
  timing.addEnergy('charger1', day.from + 30 * MINUTE, range.to, 0.15, { key: 'recorded' });
  const result = timing.result().charger1;
  assert.equal(result.coverageDetails.chargingMs, 30 * MINUTE);
  assert.equal(result.coverageDetails.idleMs, 90 * MINUTE);
  assert.equal(result.evidence.energyBasis, 'power-snapshots');
  assert.equal(result.evidence.timeBasis, 'power-sample-time');
  assert.deepEqual(result.evidence.sources.map(source => source.key), ['currents']);
  assert.equal(result.energyKwh, 3);
});
