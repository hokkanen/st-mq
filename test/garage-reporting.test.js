import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { createChartService } from '../src/app/chart-service.js';
import { getGarageModelBenefit, getGarageTimingBenefit, buildHeatingSavings, combineSavings } from '../src/app/garage-reporting.js';

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
function cycle(store, id, changes = {}, input = 'providers') {
  const { assessment, ...extra } = changes;
  const row = { id, status: 'completed', startedAt: range.from - HOUR, endedAt: range.from + HOUR,
    ...extra, assessment: { basis: 'garage-frozen-normal-reference', profitCents: 125, uncertaintyCents: 25,
      referenceCostCents: 200, actualCostCents: 75, includesGarageOnly: true, provisional: true, ...assessment } };
  store.cycle(`garage:${input}`, row); return row;
}

test('garage completed money keeps completion boundaries, frozen qualifications, negative and zero outcomes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  cycle(store, 'included'); cycle(store, 'future', { endedAt: range.to });
  cycle(store, 'unfinished', { status: 'active', endedAt: null });
  cycle(store, 'wrong-basis', { assessment: { basis: 'EUR/cycle' } });
  cycle(store, 'mixed-scope', { assessment: { includesGarageOnly: false } });
  cycle(store, 'negative', { assessment: { profitCents: -125 } });
  cycle(store, 'simulation', {}, 'simulated');
  const result = getGarageModelBenefit({ store, input: 'providers', range, now });
  assert.equal(result.valueEuro, 0); assert.equal(result.provisional, true);
  assert.deepEqual(result.counts, { assessed: 2, completed: 4, unassessed: 2, incomplete: 0, active: 1, startedBeforeSelection: 2 });
  assert.equal(result.selectionBasis, 'cycles-completed-in-range');
  assert.equal(getGarageModelBenefit({ store, input: 'providers', range, now: range.from }).valueEuro, null);
  assert.equal(getGarageModelBenefit({ store, input: 'offline', range, now }).valueEuro, null);
  assert(!JSON.stringify(result).includes('mixed-scope'), 'Device and episode identifiers remain private');
});

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
});

function report(changes = {}) {
  return buildHeatingSavings({ range, now,
    homeModel: { status: 'estimated', valueEuro: 4, counts: { assessed: 2 } },
    garageModel: { status: 'estimated', valueEuro: -1, provisional: true, counts: { assessed: 1 } },
    homeTiming: { value: 0.5, energyKwh: 3, coverage: 1, coverageDetails: { elapsedMs: 24 * HOUR, includedMs: 24 * HOUR } },
    garageTiming: { value: -0.2, energyKwh: 1, coverage: 0.5, provisional: true, coverageDetails: { elapsedMs: 24 * HOUR, includedMs: 12 * HOUR } }, ...changes });
}

test('Home/Garage/Total sums matching period money by method and inherits missing and provisional status', () => {
  const full = report(); assert.equal(full.total.model.valueEuro, 3); near(full.total.timing.value, 0.3);
  assert.equal(full.total.model.counts.assessed, 3); assert.equal(full.total.model.provisional, true);
  assert.equal(full.total.timing.coverage, 0.75); assert.equal(full.total.timing.energyKwh, 4);
  const partial = report({ garageModel: { status: 'unavailable', valueEuro: null } });
  assert.equal(partial.total.model.valueEuro, 4); assert.equal(partial.total.model.status, 'partial');
  assert.deepEqual(partial.total.model.missingScopes, ['garage']);
  const empty = report({ homeModel: {}, garageModel: {} });
  assert.equal(empty.total.model.valueEuro, null); assert.equal(empty.total.model.status, 'unavailable');
  const zero = report({ garageModel: { status: 'estimated', valueEuro: 0 } });
  assert.equal(zero.total.model.valueEuro, 4); assert.equal(zero.total.model.partial, false);
});

test('overlap, different periods, currency, stage and €/cycle cannot be added', () => {
  for (const modification of [{ sourceScopes: ['home-heat-pump'] }, { range: { ...range, from: range.from - HOUR } },
    { currency: 'USD' }, { method: 'timing' }, { sourceScopes: ['unknown-property-feed'] }, { unit: 'EUR/cycle' }, { stage: 'forecast' }, { aggregationBasis: 'cycle-average' }]) {
    const { home, garage } = report();
    const result = combineSavings(home.model, { ...garage.model, ...modification }, 'model');
    assert.equal(result.valueEuro, null); assert.equal(result.status, 'unavailable');
  }
});

test('chart resolution cannot alter garage savings and historical caches follow assessment corrections', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'garage-reporting-'));
  const store = new Store(join(directory, 'example.sqlite')), service = createChartService({ store });
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = cycle(store, 'example-cycle');
  const args = { input: 'providers', now, startDate: range.startDate };
  const before = store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  for (const points of [100, 2000]) {
    const result = getChartData({ ...args, store, points });
    assert.equal(result.heatingSavings.garage.model.valueEuro, 1.25);
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, before);
  assert.equal((await service.query(args)).heatingSavings.garage.model.valueEuro, 1.25);
  assert.equal((await service.query(args)).meta.cacheHit, true);
  store.cycle('garage:providers', { ...saved, assessment: { ...saved.assessment, profitCents: -50 } });
  const changed = await service.query(args);
  assert.notEqual(changed.meta.cacheHit, true); assert.equal(changed.heatingSavings.garage.model.valueEuro, -0.5);
});


test('unavailable numeric placeholders cannot enter totals and two unsupported matching bases do not become compatible', () => {
  const partial = report({ garageModel: { status: 'unavailable', valueEuro: 999 } });
  assert.equal(partial.total.model.valueEuro, 4);
  assert.deepEqual(partial.total.model.missingScopes, ['garage']);
  const both = report({ homeModel: { status: 'estimated', valueEuro: 1, unit: 'EUR/cycle', aggregationBasis: 'cycle-average' },
    garageModel: { status: 'estimated', valueEuro: 2, unit: 'EUR/cycle', aggregationBasis: 'cycle-average' } });
  assert.equal(both.total.model.valueEuro, null);
  const currency = report({ homeModel: { status: 'estimated', valueEuro: 1, currency: 'USD' },
    garageModel: { status: 'estimated', valueEuro: 2, currency: 'USD' } });
  assert.equal(currency.total.model.valueEuro, null);
});
