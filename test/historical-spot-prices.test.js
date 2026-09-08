import test from 'node:test';
import assert from 'node:assert/strict';
import moment from 'moment-timezone';
import { Store } from '../src/storage/store.js';
import { historicalSpotIntervals } from '../src/app/historical-spot-prices.js';

const QUARTER_HOUR = 15 * 60_000;
const from = Date.parse('2026-01-15T00:00:00+02:00');
function put(store, at, value, extra = {}) {
  return store.observation({ source: 'test-fixture', device: 'synthetic-house', signal: 'spot_price',
    unit: 'c/kWh_ex_vat', sourceTime: at, receivedAt: at, value, ...extra });
}
function imported(store, status = 'complete', kind = 'stmq') {
  return Number(store.db.prepare(`INSERT INTO imports (kind,sha256,path,status,started_at)
    VALUES (?,lower(hex(randomblob(32))),'synthetic.csv',?,?)`).run(kind, status, from).lastInsertRowid);
}

test('recorded quarter-hour prices cover exact Finnish days despite logging jitter, including DST', () => {
  for (const [date, count] of [['2026-01-15', 96], ['2026-03-29', 92], ['2026-10-25', 100]]) {
    const store = new Store(':memory:');
    try {
      const day = moment.tz(date, 'YYYY-MM-DD', 'Europe/Helsinki');
      const range = { from: day.valueOf(), to: day.clone().add(1, 'day').valueOf() };
      for (let index = 0; index < count; index++) put(store, range.from + index * QUARTER_HOUR + 13_000, index - 20);
      const result = historicalSpotIntervals(store, range, range.to);
      assert.equal(result.length, count);
      assert.equal(result[0].start, range.from);
      assert.equal(result.at(-1).end, range.to);
      assert.equal(result.reduce((sum, row) => sum + row.end - row.start, 0), range.to - range.from);
      for (let index = 0; index < count; index++) {
        assert.deepEqual(result[index], { start: range.from + index * QUARTER_HOUR,
          end: range.from + (index + 1) * QUARTER_HOUR, spotCtPerKwh: index - 20,
          unit: 'c/kWh', vatIncluded: false, source: 'historical-spot', intervalBasis: 'recorded-quarter-hour' });
      }
    } finally { store.close(); }
  }
});

test('missing slots and authoritative invalid readings remain gaps without extending isolated prices', () => {
  const store = new Store(':memory:');
  try {
    put(store, from, -4);
    put(store, from + QUARTER_HOUR, 8);
    put(store, from + QUARTER_HOUR + 1, null);
    put(store, from + 3 * QUARTER_HOUR, 8, { quality: ['invalid_value'] });
    put(store, from + 4 * QUARTER_HOUR, 8, { unit: 'EUR/MWh' });
    const malformed = put(store, from + 5 * QUARTER_HOUR, 8);
    store.db.prepare("UPDATE observations SET quality='invalid-json' WHERE id=?").run(malformed);
    const result = historicalSpotIntervals(store, { from, to: from + 6 * QUARTER_HOUR }, from + 6 * QUARTER_HOUR);
    assert.deepEqual(result.map(row => [row.start, row.end, row.spotCtPerKwh]), [[from, from + QUARTER_HOUR, -4]]);
  } finally { store.close(); }
});

test('native observations override imports and same-priority timestamp and duplicate precedence is stable', () => {
  const store = new Store(':memory:');
  try {
    const first = imported(store), second = imported(store);
    const csv = (importId, rowNumber) => ({ source: 'csv:stmq', provenance: { importId, rowNumber } });
    put(store, from + 2_000, 7);
    put(store, from + 3_000, 90, csv(second, 1));
    put(store, from + 1_000, 8); // Later ingestion cannot override a newer source timestamp.
    put(store, from + 2_000, 9); // Newest duplicate wins within the native source.
    put(store, from + QUARTER_HOUR, 20, csv(second, 2));
    put(store, from + QUARTER_HOUR, 10, csv(first, 2));
    put(store, from + QUARTER_HOUR, 21, csv(second, 3));
    put(store, from + 2 * QUARTER_HOUR, 30, csv(second, 4));
    put(store, from + 2 * QUARTER_HOUR + 1, 31, csv(first, 3));
    put(store, from + 3 * QUARTER_HOUR, null);
    put(store, from + 3 * QUARTER_HOUR + 1, 40, csv(second, 5));
    put(store, from + 4 * QUARTER_HOUR, 50, csv(second, 6));
    put(store, from + 4 * QUARTER_HOUR + 1, null, csv(first, 4));
    const range = { from, to: from + 5 * QUARTER_HOUR };
    assert.deepEqual(historicalSpotIntervals(store, range, range.to).map(row => row.spotCtPerKwh), [9, 21, 31]);
  } finally { store.close(); }
});

test('reconstruction excludes incomplete imports, simulated and future samples, and private metadata', () => {
  const store = new Store(':memory:');
  try {
    for (const [index, status, kind] of [[0, 'importing', 'stmq'], [1, 'failed', 'stmq'], [2, 'complete', 'easee']]) {
      put(store, from + index * QUARTER_HOUR, 1, { provenance: { importId: imported(store, status, kind), rowNumber: 1 } });
    }
    put(store, from + 3 * QUARTER_HOUR, 2, { source: 'simulation' });
    put(store, from + 4 * QUARTER_HOUR, 3, { source: 'controller-estimate', device: 'simulated' });
    put(store, from + 5 * QUARTER_HOUR, 4, { source: 'synthetic-source', device: 'synthetic-private-device',
      raw: { fixturePrivate: 'synthetic-private-value' } });
    put(store, from + 6 * QUARTER_HOUR, 5);
    const range = { from, to: from + 7 * QUARTER_HOUR };
    const result = historicalSpotIntervals(store, range, from + 5 * QUARTER_HOUR);
    assert.equal(result.length, 1);
    assert.equal(result[0].spotCtPerKwh, 4);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|fixturePrivate|synthetic-source/);
    assert.equal(historicalSpotIntervals(store, { from: range.to, to: range.to + QUARTER_HOUR }, range.to).length, 0);
  } finally { store.close(); }
});
