import test from 'node:test';
import assert from 'node:assert/strict';
import { helsinkiCalendar, transferPrice, normalizePriceIntervals, allInPrice,
  priceIntervals, costForPower, validateContract } from '../src/domain/prices.js';

// Deliberately synthetic test contract, not verified Finnish tax rates.
const contract = { periods: [{ from: '2026-01-01T00:00:00Z', marginCtPerKwh: 0.5,
  taxCtPerKwh: 2.5, vatRate: 0.2, provenance: 'Synthetic unit-test fixture' }] };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('all-in price adds VAT once, transfer already has VAT; negative prices survive', () => {
  const p = allInPrice('2026-01-02T12:00:00Z', 10, contract);
  near(p.totalCtPerKwh, 18.94);
  near(p.vatCtPerKwh, 2.6);
  near(allInPrice('2026-01-02T12:00:00Z', -10, contract).totalCtPerKwh, -5.06);
  near(allInPrice('2026-01-02T23:00:00Z', 10, contract).totalCtPerKwh, 17.56);
});

test('day/night boundaries follow Helsinki in winter and summer', () => {
  for (const date of ['2026-01-02', '2026-07-02']) {
    const offset = date.includes('-01-') ? '+02:00' : '+03:00';
    assert.equal(transferPrice(`${date}T06:59:59${offset}`), 1.96);
    assert.equal(transferPrice(`${date}T07:00:00${offset}`), 3.34);
    assert.equal(transferPrice(`${date}T21:59:59${offset}`), 3.34);
    assert.equal(transferPrice(`${date}T22:00:00${offset}`), 1.96);
  }
});

test('seasonal tariff uses literal Monday-Saturday and November-March, including holidays', () => {
  assert.equal(transferPrice('2026-01-03T12:00:00+02:00', 'seasonal'), 4.17); // Saturday
  assert.equal(transferPrice('2026-01-04T12:00:00+02:00', 'seasonal'), 2.07); // Sunday
  assert.equal(transferPrice('2026-12-25T12:00:00+02:00', 'seasonal'), 4.17); // Friday holiday
  assert.equal(transferPrice('2026-03-31T21:59:59+03:00', 'seasonal'), 4.17);
  assert.equal(transferPrice('2026-04-01T12:00:00+03:00', 'seasonal'), 2.07);
  assert.equal(transferPrice('2026-10-31T12:00:00+02:00', 'seasonal'), 2.07);
  assert.equal(transferPrice('2026-11-02T07:00:00+02:00', 'seasonal'), 4.17);
  assert.equal(allInPrice('2027-11-02T12:00:00+02:00', 0, contract).tariff, 'day-night');
});

test('DST repeated and skipped hours retain distinct UTC instants', () => {
  assert.equal(helsinkiCalendar('2026-03-29T00:30:00Z').hour, 2);
  assert.equal(helsinkiCalendar('2026-03-29T01:30:00Z').hour, 4);
  assert.equal(helsinkiCalendar('2026-10-25T00:30:00Z').hour, 3);
  assert.equal(helsinkiCalendar('2026-10-25T01:30:00Z').hour, 3);
  for (const [start, end, hours] of [
    ['2026-03-29T00:00:00+02:00', '2026-03-30T00:00:00+03:00', 23],
    ['2026-10-25T00:00:00+03:00', '2026-10-26T00:00:00+02:00', 25],
  ]) {
    const priced = priceIntervals(normalizePriceIntervals([{ start, end, value: 0 }], {
      unit: 'c/kWh', vatIncluded: false, source: 'DST fixture',
    }), contract);
    assert.equal(priced.reduce((sum, p) => sum + p.durationHours, 0), hours);
    // Always exactly 15 daytime hours; DST adjustment happens during the night.
    near(costForPower(priced, 1), (15 * 6.94 + (hours - 15) * 5.56) / 100);
  }
});

test('normalization requires actual interval ends, explicit supported ex-VAT units and provenance', () => {
  const row = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:15:00Z', value: -40 };
  const options = { unit: 'EUR/MWh', vatIncluded: false, source: 'Synthetic provider' };
  assert.equal(normalizePriceIntervals([row], options)[0].spotCtPerKwh, -4);
  near(normalizePriceIntervals([{ ...row, value: 0.05 }], { ...options, unit: 'EUR/kWh' })[0].spotCtPerKwh, 5);
  assert.throws(() => normalizePriceIntervals([{ ...row, end: undefined }], options));
  assert.throws(() => normalizePriceIntervals([row], { ...options, unit: 'kWh' }));
  assert.throws(() => normalizePriceIntervals([row], { ...options, vatIncluded: true }));
  assert.throws(() => normalizePriceIntervals([row], { ...options, vatIncluded: undefined }));
  assert.throws(() => normalizePriceIntervals([row], { ...options, source: '' }));
  assert.throws(() => normalizePriceIntervals([row, row], options), /Overlapping/);
  assert.throws(() => normalizePriceIntervals([{ ...row, start: '2026-01-01T00:00:00' }], options), /offset/);
});

test('quarter-hour pricing and arbitrary boundary crossings use actual durations', () => {
  const priced = priceIntervals(normalizePriceIntervals([
    { start: '2026-01-02T06:45:00+02:00', end: '2026-01-02T07:15:00+02:00', value: 10 },
    { start: '2026-01-02T07:15:00+02:00', end: '2026-01-02T07:30:00+02:00', value: 110 },
  ], { unit: 'c/kWh', vatIncluded: false, source: 'Boundary fixture' }), contract);
  assert.equal(priced.length, 3);
  near(costForPower(priced, 2), 0.0878 + 0.0947 + 0.6947);
  assert.throws(() => costForPower(priced, -1), /Export/);
});

test('effective dates are mandatory for historical billing; scenarios are explicit', () => {
  assert.throws(() => allInPrice('2025-01-01T00:00:00Z', 10, contract), /historical/);
  assert.throws(() => validateContract({ periods: [{ ...contract.periods[0], taxCtPerKwh: undefined }] }), /tax/);
  assert.throws(() => validateContract({ periods: [{ ...contract.periods[0], vatRate: 25.5 }] }), /fraction/);
  assert.throws(() => validateContract({ periods: [...contract.periods, ...contract.periods] }), /Overlapping/);
  assert.throws(() => validateContract({ ...contract, demandCharge: { eurosPerKw: 4 } }), /dedicated/);
  const p = allInPrice('2025-01-01T00:00:00Z', 10, { ...contract, mode: 'scenario', scenarioAt: '2026-07-01T00:00:00Z' });
  assert.equal(p.mode, 'scenario');
  near(p.totalCtPerKwh, 17.56);
});

test('contract changes split intervals exactly and gaps are not silently filled', () => {
  const periods = [
    { ...contract.periods[0], to: '2026-01-02T12:15:00Z' },
    { ...contract.periods[0], from: '2026-01-02T12:15:00Z', vatRate: 0.1 },
  ];
  const normalized = normalizePriceIntervals([{ start: '2026-01-02T12:00:00Z', end: '2026-01-02T13:00:00Z', value: 10 }], {
    unit: 'c/kWh', vatIncluded: false, source: 'Dated fixture',
  });
  const priced = priceIntervals(normalized, { periods });
  assert.equal(priced.length, 2);
  assert.equal(priced[0].durationHours, 0.25);
  near(priced[1].totalCtPerKwh, 17.64);
  assert.throws(() => priceIntervals(normalized, { periods: [periods[0]] }), /cover/);
});
