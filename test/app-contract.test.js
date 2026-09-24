import test from 'node:test';
import assert from 'node:assert/strict';
import { contractWithPeriod, assembleOutlook, configuredPriceSettings, reconcileConfiguredContract } from '../src/app/contract.js';
import { allInPrice } from '../src/domain/prices.js';

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
  assert.ok(Math.abs(priced.prices[0].allInCentsPerKWh - (-5 + .5 + 2 + 2.66) * 1.25) < 0.000001);
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

test('configuration defaults use exact ex-VAT day and night rates', () => {
  const settings = configuredPriceSettings();
  assert.equal(settings.transferRates.dayCtPerKwh, 2.66);
  assert.equal(settings.transferRates.nightCtPerKwh, 1.56);
  assert.equal(settings.marginCtPerKwh, 0.33);
  assert.equal(settings.taxCtPerKwh, 2.325);
  assert.equal(settings.vatRate, 0.255);
  assert.equal(settings.transferRates.vatIncluded, false);
  const now = Date.parse('2026-09-07T12:00:00Z');
  const contract = reconcileConfiguredContract(null, settings, now);
  assert.equal(contract.periods[0].from, Date.parse('2026-09-06T21:00:00Z'));
  const price = allInPrice(now, 10, contract);
  assert.ok(Math.abs(price.totalCtPerKwh - (12.55 + 0.41415 + 2.917875 + 3.3383)) < 1e-10);
  assert.ok(Math.abs(price.transferIncludingVatCtPerKwh - 3.3383) < 1e-10);
  for (const invalid of [{ vat_percent: '25.5' }, { vat_percent: 101 }, { margin_ct_per_kwh_ex_vat: '0.33' },
    { tax_ct_per_kwh_ex_vat: -1 }, { day_transfer_ct_per_kwh_ex_vat: -1 }, { effective_date: '2026-02-31' }]) {
    assert.throws(() => configuredPriceSettings(invalid));
  }
});

test('configured rate changes snapshot transfers and VAT without repricing saved historical periods', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const original = contractWithPeriod(null, { ...rates,
    transferRates: { vatIncluded: true, dayCtPerKwh: 3.34, nightCtPerKwh: 1.96, winterDayCtPerKwh: 4.17, otherCtPerKwh: 2.07 } });
  const before = allInPrice(now - 1000, 10, original);
  const configured = reconcileConfiguredContract(original, configuredPriceSettings(), now);
  assert.equal(configured.periods.length, 2);
  assert.equal(configured.periods[0].transferRates.vatIncluded, true);
  assert.equal(configured.periods[1].transferRates.vatIncluded, false);
  assert.equal(configured.periods[0].to, now);
  assert.equal(original.periods[0].to, undefined);
  assert.equal(allInPrice(now - 1000, 10, configured).totalCtPerKwh, before.totalCtPerKwh);
  const restarted = reconcileConfiguredContract(configured, configuredPriceSettings(), now + 3600000);
  assert.equal(restarted.periods.length, 2);
  const revised = reconcileConfiguredContract(restarted, configuredPriceSettings({ vat_percent: 20,
    day_transfer_ct_per_kwh_ex_vat: 4 }), now + 3600000);
  assert.equal(revised.periods.length, 3);
  assert.ok(Math.abs(allInPrice(now + 3600000, 10, revised).transferIncludingVatCtPerKwh - 4.8) < 1e-10);
  assert.ok(Math.abs(allInPrice(now, 10, revised).transferIncludingVatCtPerKwh - 3.3383) < 1e-10);
  assert.throws(() => reconcileConfiguredContract(revised, configuredPriceSettings({ effective_date: '2026-09-06' }), now + 7200000), /last saved period/);
});

test('explicit configuration effective dates retain Finnish DST boundaries and do not fill uncovered history', () => {
  const settings = configuredPriceSettings({ effective_date: '2026-10-25', transfer_tariff: 'seasonal' });
  const contract = reconcileConfiguredContract(null, settings, Date.parse('2026-09-07T12:00:00Z'));
  assert.equal(contract.periods[0].from, Date.parse('2026-10-24T21:00:00Z'));
  assert.throws(() => allInPrice('2026-10-24T20:00:00Z', 5, contract), /historical/);
  assert.ok(Math.abs(allInPrice('2026-11-02T12:00:00Z', 5, contract).transferIncludingVatCtPerKwh - 4.1666) < 1e-10);
  assert.ok(Math.abs(allInPrice('2026-11-01T12:00:00Z', 5, contract).transferIncludingVatCtPerKwh - 2.07075) < 1e-10);
});

test('configuration application is byte-stable on the first and later ordinary restarts', () => {
  const now = Date.parse('2026-09-07T12:00:00Z'), settings = configuredPriceSettings();
  const initial = reconcileConfiguredContract(null, settings, now);
  assert.equal(initial.periods.at(-1).to, null);
  assert.equal(JSON.stringify(reconcileConfiguredContract(initial, settings, now + 1000)), JSON.stringify(initial));
  const changedSettings = configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.4 });
  const changed = reconcileConfiguredContract(initial, changedSettings, now + 1000);
  assert.equal(JSON.stringify(reconcileConfiguredContract(changed, changedSettings, now + 2000)), JSON.stringify(changed));
});

test('unstarted configured rate changes can be corrected, moved and cancelled without rewriting active prices', () => {
  const now = Date.parse('2026-09-07T12:00:00Z'), settings = configuredPriceSettings();
  const active = reconcileConfiguredContract(null, settings, now);
  const upcomingSettings = configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.8, effective_date: '2026-10-01' });
  const scheduled = reconcileConfiguredContract(active, upcomingSettings, now + 1000);
  assert.equal(scheduled.periods.length, 2);
  assert.equal(scheduled.periods[0].to, scheduled.periods[1].from);
  assert.equal(JSON.stringify(reconcileConfiguredContract(scheduled, upcomingSettings, now + 2000)), JSON.stringify(scheduled));
  const correctedSettings = configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.6, effective_date: '2026-10-01' });
  const corrected = reconcileConfiguredContract(scheduled, correctedSettings, now + 2000);
  assert.equal(corrected.periods.length, 2);
  assert.equal(corrected.periods[1].marginCtPerKwh, 0.6);
  assert.equal(allInPrice(now, 10, corrected).totalCtPerKwh, allInPrice(now, 10, active).totalCtPerKwh);
  const movedSettings = { ...correctedSettings, effectiveDate: '2026-11-01' };
  const moved = reconcileConfiguredContract(corrected, movedSettings, now + 3000);
  assert.equal(moved.periods.length, 2);
  assert.equal(moved.periods[1].from, Date.parse('2026-10-31T22:00:00Z'));
  assert.equal(moved.periods[0].to, moved.periods[1].from);
  assert.equal(JSON.stringify(reconcileConfiguredContract(moved, movedSettings, now + 4000)), JSON.stringify(moved));
  const cancelled = reconcileConfiguredContract(moved, settings, now + 4000);
  assert.deepEqual(cancelled, active);
  const appliedNow = reconcileConfiguredContract(moved, { ...correctedSettings, effectiveDate: undefined }, now + 5000);
  assert.equal(appliedNow.periods[1].from, now + 5000);
  assert.equal(appliedNow.periods[1].marginCtPerKwh, 0.6);
  assert.equal(appliedNow.periods[0].to, now + 5000);
});

test('scheduled correction preserves existing coverage gaps and never removes non-configured future periods', () => {
  const now = Date.parse('2026-09-07T12:00:00Z'), settings = configuredPriceSettings();
  const active = reconcileConfiguredContract(null, settings, now);
  const end = Date.parse('2026-09-15T21:00:00Z');
  active.periods[0].to = end;
  const scheduled = reconcileConfiguredContract(active, configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.8,
    effective_date: '2026-10-01' }), now + 1000);
  const revised = reconcileConfiguredContract(scheduled, configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.6,
    effective_date: '2026-10-02' }), now + 2000);
  assert.equal(revised.periods[0].to, end);
  assert.throws(() => allInPrice('2026-09-20T12:00:00Z', 10, revised), /cover/);
  assert.deepEqual(reconcileConfiguredContract(revised, settings, now + 3000), active);
  const early = reconcileConfiguredContract(active, configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.8,
    effective_date: '2026-09-10' }), now + 1000);
  assert.equal(early.periods[0].to, Date.parse('2026-09-09T21:00:00Z'));
  assert.deepEqual(reconcileConfiguredContract(early, settings, now + 3000), active);
  const manual = contractWithPeriod(active, { ...rates, effectiveDate: '2026-11-01' });
  assert.throws(() => reconcileConfiguredContract(manual, settings, now + 1000), /last saved period/);
});

test('once a configured period has begun, a rate correction can only append now or later', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const settings = configuredPriceSettings({ effective_date: '2026-09-01' });
  const active = reconcileConfiguredContract(null, settings, now);
  assert.throws(() => reconcileConfiguredContract(active, configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.8,
    effective_date: '2026-09-05' }), now + 1000), /elapsed history/);
  const changed = reconcileConfiguredContract(active, configuredPriceSettings({ margin_ct_per_kwh_ex_vat: 0.8 }), now + 1000);
  assert.equal(changed.periods[0].from, active.periods[0].from);
  assert.equal(changed.periods[0].marginCtPerKwh, active.periods[0].marginCtPerKwh);
  assert.equal(changed.periods[1].from, now + 1000);
});
