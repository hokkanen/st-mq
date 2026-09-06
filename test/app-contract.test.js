import test from 'node:test';
import assert from 'node:assert/strict';
import { contractWithPeriod, assembleOutlook } from '../src/app/contract.js';

const rates = { effectiveDate: '2026-09-06', marginCtPerKwh: 0.5, taxCtPerKwh: 2, vatRate: 0.25, tariff: 'day-night' };
test('simple contract entry uses Finnish midnight, dated ex-VAT charges and preserves earlier rates', () => {
  const original = contractWithPeriod(null, rates);
  assert.equal(original.periods[0].from, Date.parse('2026-09-05T21:00:00Z'));
  const next = contractWithPeriod(original, { ...rates, effectiveDate: '2027-03-31', tariff: 'seasonal' });
  assert.equal(original.periods[0].to, undefined);
  assert.equal(next.periods[0].tariff, 'day-night');
  assert.equal(next.periods[0].to, next.periods[1].from);
  assert.equal(next.periods[1].tariff, 'seasonal');
  assert.throws(() => contractWithPeriod(original, rates), /preserved/);
  assert.throws(() => contractWithPeriod(null, { ...rates, taxCtPerKwh: undefined }));
  assert.throws(() => contractWithPeriod(null, { ...rates, effectiveDate: '2026-02-31' }));
});
test('rate effective dates obey the pre-transition offset at midnight on both DST change days', () => {
  assert.equal(contractWithPeriod(null, { ...rates, effectiveDate: '2026-03-29' }).periods[0].from, Date.parse('2026-03-28T22:00:00Z'));
  assert.equal(contractWithPeriod(null, { ...rates, effectiveDate: '2026-10-25' }).periods[0].from, Date.parse('2026-10-24T21:00:00Z'));
});
test('cached outlook never substitutes spot for all-in price or revives stale forecast', () => {
  const now = Date.parse('2026-09-06T10:00:00Z');
  const market = { fetchedAt: now, intervals: [{ start: now, end: now + 900000, spotCtPerKwh: -5, unit: 'c/kWh', vatIncluded: false, source: 'fixture' }] };
  const weather = { fetchedAt: now, forecast: [{ start: now, end: now + 3600000, outdoorC: -5, issuedAt: null, fetchedAt: now, issuedAtBasis: 'fetched-snapshot' }] };
  const unknown = assembleOutlook(market, weather, null, now);
  assert.equal(unknown.priceStatus, 'contract-not-configured');
  assert.equal(unknown.prices.length, 0);
  assert.equal(unknown.spot[0].spotCtPerKwh, -5);
  const priced = assembleOutlook(market, weather, contractWithPeriod(null, rates), now);
  assert.ok(Math.abs(priced.prices[0].allInCentsPerKWh - 0.215) < 0.000001);
  assert.equal(priced.forecast[0].issuedAt, null);
  const stale = assembleOutlook(market, weather, contractWithPeriod(null, rates), now + 37 * 3600000);
  assert.deepEqual(stale.prices, []);
  assert.deepEqual(stale.forecast, []);
  assert.equal(stale.weatherStatus, 'stale-forecast');
});

test('partial contract periods keep their covered portion and expose missing current rates', () => {
  const now = Date.parse('2026-09-05T20:00:00Z');
  const market = { fetchedAt: now, intervals: [{ start: now, end: now + 3 * 3600000, spotCtPerKwh: 10, unit: 'c/kWh', vatIncluded: false }] };
  const partial = assembleOutlook(market, null, contractWithPeriod(null, rates), now);
  assert.equal(partial.priceStatus, 'partial-contract-coverage');
  assert.equal(partial.prices[0].start, now + 3600000);
  assert.equal(partial.prices.at(-1).end, now + 3 * 3600000);
  const gap = assembleOutlook({ ...market, intervals: [{ ...market.intervals[0], start: now + 2 * 3600000 }] },
    { fetchedAt: now, forecast: [{ start: now + 3600000, end: now + 3 * 3600000, fetchedAt: now,
      issuedAt: null, issuedAtBasis: 'fetched-snapshot' }] }, contractWithPeriod(null, rates), now);
  assert.equal(gap.priceStatus, 'incomplete-market-coverage');
  assert.equal(gap.weatherStatus, 'partial-forecast-coverage');
});

test('composite forecast rows expire independently and refreshing its envelope cannot revive old weather', () => {
  const now = Date.parse('2026-09-06T12:00:00Z');
  const row = { start: now, end: now + 3_600_000, outdoorC: 5, issuedAt: null, issuedAtBasis: 'fetched-snapshot' };
  const weather = { fetchedAt: now, forecast: [{ ...row, fetchedAt: now - 7 * 3_600_000 },
    { ...row, start: now + 3_600_000, end: now + 2 * 3_600_000, fetchedAt: now }] };
  const result = assembleOutlook(null, weather, null, now);
  assert.equal(result.forecast.length, 1);
  assert.equal(result.forecast[0].start, now + 3_600_000);
  assert.equal(result.weatherStatus, 'partial-forecast-coverage');
  const stale = assembleOutlook(null, { ...weather, forecast: [weather.forecast[0]] }, null, now);
  assert.equal(stale.weatherStatus, 'stale-forecast');
  assert.deepEqual(stale.forecast, []);
});
