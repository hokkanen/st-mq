import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';
import { getGarageTimingBenefit, buildHeatingSavings, combineSavings } from '../src/app/garage-reporting.js';

const HOUR = 3_600_000, MINUTE = 60_000;
const range = chartRange({ startDate: '2026-09-08' }), now = range.to + HOUR;
const price = [{ start: range.from, end: range.to, totalCtPerKwh: 20 }];
const near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
function energy(store, start, end, value = 0.25, changes = {}) {
  const { raw: extraRaw, ...extra } = changes;
  store.observation({ source: 'garage-adapter', device: 'garage_heat_pump', signal: 'garage_energy',
    value, unit: 'kWh', sourceTime: end, receivedAt: end, quality: ['provisional-contract'], ...extra,
    raw: { intervalStart: start, intervalEnd: end, coveredMs: end - start, timingEligible: true,
      meterScope: 'garage-heat-pump-only', energyBasis: 'counter-delta', accuracyVerified: false, provisional: true,
      ...extraRaw } });
}
test('garage same-energy timing integrates original intervals across Finnish 23/24/25-hour days', t => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-09-08', 24], ['2026-10-25', 25]]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    const selected = chartRange({ startDate: date }); assert.equal(selected.to - selected.from, hours * HOUR);
    const prices = [{ start: selected.from, end: selected.from + HOUR, totalCtPerKwh: 40 },
      { start: selected.from + HOUR, end: selected.to, totalCtPerKwh: 10 }];
    for (let at = selected.from; at < selected.to; at += 15 * MINUTE)
      energy(store, at, at + 15 * MINUTE, at < selected.from + HOUR ? 0.25 : 0);
    const result = getGarageTimingBenefit({ store, range: selected, now: selected.to, prices });
    near(result.energyKwh, 1); near(result.value, (40 + (hours - 1) * 10) / hours / 100 - 0.4);
    assert.equal(result.coverageDetails.includedMs, hours * HOUR); assert.equal(result.coverage, 1);
    assert.equal(result.provisional, true, 'Complete coverage does not verify native electrical accuracy');
    assert.equal(result.sourceQuality, 'provisional-electrical');
    const constant = getGarageTimingBenefit({ store, range: selected, now: selected.to,
      prices: [{ start: selected.from, end: selected.to, totalCtPerKwh: -12 }] });
    near(constant.value, 0);
  }
});

test('raw, coarse, partial, overlapping and non-dedicated electrical evidence never creates timing', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const at = range.from;
  energy(store, at, at + 15 * MINUTE, 1, { raw: { timingEligible: false } });
  energy(store, at + HOUR, at + 2 * HOUR, 1);
  energy(store, at + 2 * HOUR, at + 2 * HOUR + 15 * MINUTE, 1, { raw: { coveredMs: MINUTE } });
  energy(store, at + 3 * HOUR, at + 3 * HOUR + 15 * MINUTE, 1, { unit: 'Wh' });
  energy(store, at + 4 * HOUR, at + 4 * HOUR + 15 * MINUTE, 1, { raw: { meterScope: 'whole-property' } });
  energy(store, at + 5 * HOUR, at + 5 * HOUR + 15 * MINUTE, 1, { quality: ['unverified-scaling'] });
  // Three nested endpoints catch the case where one-item lookahead prematurely
  // accepts an interval before a larger later interval is seen.
  energy(store, at + 6 * HOUR, at + 6 * HOUR + MINUTE, 1);
  energy(store, at + 6 * HOUR + MINUTE, at + 6 * HOUR + 2 * MINUTE, 1);
  energy(store, at + 6 * HOUR, at + 6 * HOUR + 3 * MINUTE, 1, { device: 'another-source' });
  const result = getGarageTimingBenefit({ store, range, now, prices: price });
  assert.equal(result.value, null); assert.equal(result.intervalCounts.accepted, 0);
  assert.equal(result.reason, 'overlapping-electrical-sources');
  assert.equal(result.intervalCounts.overlap, 3); assert.equal(result.intervalCounts.rejected, 6);
  assert.equal(result.coverageDetails.missingPowerMs, 24 * HOUR);
});

test('zero energy is known, future arrivals and gaps are unknown, and incomplete daily prices cannot extrapolate', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  energy(store, range.from, range.from + 15 * MINUTE, 0, { raw: { accuracyVerified: true, provisional: false } });
  energy(store, range.from + HOUR, range.from + HOUR + 15 * MINUTE, 1, { receivedAt: now + HOUR });
  const result = getGarageTimingBenefit({ store, range, now, prices: price });
  assert.equal(result.value, 0); assert.equal(result.energyKwh, 0);
  assert.equal(result.intervalCounts.accepted, 1); assert.equal(result.sourceQuality, 'verified-electrical');
  assert.equal(result.provisional, true, 'Missing time remains provisional even for checked meters');
  assert.equal(result.coverageDetails.missingPowerMs, 24 * HOUR - 15 * MINUTE);
  const missingPrices = getGarageTimingBenefit({ store, range, now, prices: [{ ...price[0], end: range.to - MINUTE }] });
  assert.equal(missingPrices.value, null); assert.equal(missingPrices.coverageDetails.incompletePriceMs, 15 * MINUTE);
  assert.equal(missingPrices.intervalCounts.accepted, 1);
  assert.equal(missingPrices.reason, 'incomplete-daily-prices');
  assert.equal(getGarageTimingBenefit({ store, range, now: range.from, prices: price }).reason, 'no-elapsed-time');
  assert.equal(getGarageTimingBenefit({ store, input: 'simulated', range, now, prices: price }).reason, 'no-qualified-electrical-intervals');
});

function report(changes = {}) {
  return buildHeatingSavings({ range, now,
    homeModel: { status: 'estimated', valueEuro: 4, counts: { assessed: 2 } },
    homeTiming: { value: 0.5, energyKwh: 3, coverage: 1, coverageDetails: { elapsedMs: 24 * HOUR, includedMs: 24 * HOUR } },
    garageTiming: { value: -0.2, energyKwh: 1, coverage: 0.5, provisional: true, coverageDetails: { elapsedMs: 24 * HOUR, includedMs: 12 * HOUR } }, ...changes });
}

test('Home keeps its model estimate and Garage/Total contain only electrical timing comparisons', () => {
  const full = report(); near(full.total.timing.value, 0.3);
  assert.equal(full.home.model.valueEuro, 4);
  assert.equal(full.garage.model, undefined); assert.equal(full.total.model, undefined);
  assert.equal(full.total.timing.coverage, 0.75); assert.equal(full.total.timing.energyKwh, 4);
  const partial = report({ garageTiming: { status: 'unavailable', value: 999 } });
  assert.equal(partial.total.timing.value, 0.5); assert.equal(partial.total.timing.status, 'partial');
  assert.deepEqual(partial.total.timing.missingScopes, ['garage']);
});

test('Heating Total preserves assumed-rate system-time and affected dates across overlapping scopes', () => {
  const timing = (includedMs, durationMs, firstAt = null, lastAt = null) => ({ value: 0.25,
    coverageDetails: { elapsedMs: 24 * HOUR, includedMs }, assumedPrices: durationMs > 0,
    priceAssumptions: { durationMs, share: durationMs / includedMs, firstAt, lastAt, timeBasis: 'included-period' } });
  const homeTiming = timing(24 * HOUR, 24 * HOUR, range.from, range.to);
  const garageTiming = timing(15 * MINUTE, 15 * MINUTE, range.from + HOUR, range.from + HOUR + 15 * MINUTE);
  const full = report({ homeTiming, garageTiming }).total.timing;
  assert.equal(full.value, 0.5);
  assert.deepEqual(full.priceAssumptions, { durationMs: 24 * HOUR + 15 * MINUTE, share: 1,
    firstAt: range.from, lastAt: range.to, timeBasis: 'included-system-time' });
  assert.equal(full.coverageDetails.coverageBasis, 'combined-system-time');
  assert.equal(full.coverageDetails.includedMs, 24 * HOUR + 15 * MINUTE,
    'Simultaneous Home and Garage intervals contribute separate system-time');
  const mixed = report({ homeTiming, garageTiming: timing(12 * HOUR, 0) }).total.timing;
  assert.equal(mixed.priceAssumptions.share, 2 / 3);
  assert.equal(mixed.priceAssumptions.durationMs, 24 * HOUR);
  const partial = report({ homeTiming, garageTiming: { value: null,
    coverageDetails: { elapsedMs: 24 * HOUR, includedMs: 0 } } }).total.timing;
  assert.equal(partial.value, 0.25); assert.equal(partial.status, 'partial');
  assert.equal(partial.priceAssumptions.share, 1, 'Assumed share uses included time, not both systems’ elapsed time');
  assert.equal(partial.priceAssumptions.firstAt, range.from);
  assert.equal(partial.priceAssumptions.lastAt, range.to);
  const known = report({ homeTiming: timing(24 * HOUR, 0), garageTiming: timing(12 * HOUR, 0) }).total.timing;
  assert.deepEqual(known.priceAssumptions, { durationMs: 0, share: 0, firstAt: null, lastAt: null, timeBasis: 'included-system-time' });
  assert.equal(known.assumedPrices, false);
});

test('overlap, different periods, currency, stage and incompatible units cannot be added', () => {
  for (const modification of [{ sourceScopes: ['home-heat-pump'] }, { range: { ...range, from: range.from - HOUR } },
    { currency: 'USD' }, { method: 'model' }, { sourceScopes: ['unknown-property-feed'] }, { unit: 'EUR/cycle' }, { stage: 'forecast' }, { aggregationBasis: 'cycle-average' }]) {
    const { home, garage } = report();
    const result = combineSavings(home.timing, { ...garage.timing, ...modification }, 'timing');
    assert.equal(result.value, null); assert.equal(result.status, 'unavailable');
  }
});

test('chart resolution and read-only worker preserve observed garage timing without model reporting', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'garage-reporting-'));
  const store = new Store(join(directory, 'example.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  energy(store, range.from, range.from + MINUTE);
  const args = { input: 'providers', now, startDate: range.startDate };
  const before = store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  const results = [100, 2000].map(points => getChartData({ ...args, store, points }));
  assert.deepEqual(results[0].heatingSavings.garage, results[1].heatingSavings.garage);
  assert.equal(results[0].heatingSavings.garage.model, undefined);
  assert.equal(results[0].meta.garageHistory, undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, before);
  assert.deepEqual((await service.query(args)).heatingSavings.garage, results[0].heatingSavings.garage);
  assert.equal((await service.query(args)).meta.cacheHit, true);
});
