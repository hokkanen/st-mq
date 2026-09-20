import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRates, finnishDateTime, homePolicyValues, rateRows, temporaryValues } from '../chart/home-controls.js';

test('date controls display Finnish wall time across winter, summer and midnight', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(finnishDateTime('2026-01-12T12:30:00Z'), '2026-01-12T14:30');
    assert.equal(finnishDateTime('2026-09-07T12:30:00Z'), '2026-09-07T15:30');
    assert.equal(finnishDateTime('2026-09-07T21:00:00Z'), '2026-09-08T00:00');
    assert.equal(finnishDateTime('2026-10-25T00:30:00Z'), '2026-10-25T03:30');
    assert.equal(finnishDateTime('2026-10-25T01:30:00Z'), '2026-10-25T03:30');
    assert.equal(finnishDateTime(null), '');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('saved controls show only unexpired away and pause deadlines', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const status = { now, settings: { occupancy: { mode: 'away', returnAt: '2026-09-07T13:00:00Z' } },
    override: { expiresAt: now + 7200_000 } };
  assert.deepEqual(temporaryValues(status), { awayUntilLocal: '2026-09-07T16:00', pauseUntilLocal: '2026-09-07T17:00' });
  assert.deepEqual(temporaryValues({ ...status, now: now + 7200_000 }), { awayUntilLocal: '', pauseUntilLocal: '' });
});

test('rate report selects the active dated snapshot instead of future or configured rates', () => {
  const previous = { from: 0, to: 100, marginCtPerKwh: 0.4 };
  const current = { from: 100, to: 200, marginCtPerKwh: 0.33 };
  const future = { from: 200, marginCtPerKwh: 0.6 };
  const status = { now: 150, contract: { periods: [previous, current, future] }, configuredPrices: future };
  assert.equal(activeRates(status), current);
  assert.equal(activeRates({ ...status, now: 200 }), future);
  assert.equal(activeRates({ ...status, now: -1 }), null);
});

test('rate table applies VAT once to new ex-VAT and legacy VAT-inclusive transfer snapshots', () => {
  const common = { marginCtPerKwh: 0.33, taxCtPerKwh: 2.325, vatRate: 0.255, tariff: 'day-night' };
  const rows = rateRows({ ...common, transferRates: { vatIncluded: false, dayCtPerKwh: 2, nightCtPerKwh: 1 } });
  assert.equal(rows[0].includingVat.toFixed(5), '0.41415');
  assert.equal(new Intl.NumberFormat('en-GB', { maximumFractionDigits: 5 }).format(rows[1].includingVat), '2.91788');
  assert.equal(rows[2].includingVat, 2.51);
  assert.equal(rows[3].includingVat, 1.255);
  const legacy = rateRows({ ...common, transferRates: { vatIncluded: true, dayCtPerKwh: 3.34, nightCtPerKwh: 1.96 } });
  assert.equal(legacy[2].includingVat, 3.34);
  assert.ok(Math.abs(legacy[2].excludingVat * 1.255 - 3.34) < 1e-10);
  const seasonal = rateRows({ ...common, tariff: 'seasonal', transferRates: { vatIncluded: false, winterDayCtPerKwh: 4, otherCtPerKwh: 2 } });
  assert.deepEqual(seasonal.slice(2).map(row => row.name), ['Winter day transfer', 'Other times transfer']);
});


test('Home policy displays saved fixed settings without creating defaults for missing snapshots', () => {
  assert.deepEqual(homePolicyValues({ settings: { savingsAggressiveness: 0, preheatRoomSettingC: 25,
    comfort: { maxRiseC: 1 } } }), { aggressiveness: '0 / 100', preheat: '25 °C ROOM', maximumRise: '1 °C' });
  assert.deepEqual(homePolicyValues({}), { aggressiveness: 'Unavailable', preheat: 'Unavailable', maximumRise: 'Unavailable' });
});
