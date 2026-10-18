import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChartSourceCache } from '../src/app/chart-source-cache.js';
const DAY = 86400000, NOW = Date.parse('2026-10-18T08:00:00+03:00');
function fixture(t, options = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const changes = [], cache = new ChartSourceCache(store.db, { ...options, onChange: value => changes.push(value) });
  const put = (at, extra = {}) => store.observation({ source: 'synthetic', device: 'sensor', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: {}, ...extra });
  const warm = (now = NOW) => { for (let n = 0; n < 100; n++) if (cache.maintain(now, 2).complete) return; assert.fail('Cache failed to catch up'); };
  const rows = (from = NOW - DAY, to = NOW, now = NOW) => [...cache.iterate({ from, to, now, input: 'providers' })];
  return { store, cache, changes, put, warm, rows };
}
test('resident source window fills in bounded batches and catches up only new committed IDs', t => {
  const f = fixture(t); for (let i = 0; i < 5; i++) f.put(NOW - (i + 1) * 60000);
  assert.equal(f.cache.maintain(NOW, 2).complete, false); assert.equal(f.cache.rows, 2);
  assert.equal(f.cache.covers(NOW - DAY, NOW, NOW), false); f.warm(); assert.equal(f.cache.rows, 5);
  assert.equal(f.cache.covers(NOW - DAY, NOW, NOW), true);
  const before = f.cache.sequence; f.put(NOW - 1000); f.warm(); assert.equal(f.cache.rows, 6);
  assert.equal(f.changes.at(-1).rows.length, 1); assert(f.cache.sequence > before);
  assert.deepEqual(f.rows().map(row => row.source_time), f.rows().map(row => row.source_time).toSorted((a, b) => a - b));
});
test('source and receipt cutoffs survive future, late and simulated rows', t => {
  const f = fixture(t); f.put(NOW - 1000); f.put(NOW - 2000, { receivedAt: NOW + DAY });
  f.put(NOW - 3000, { source: 'simulation' }); f.warm();
  assert.equal(f.rows().length, 1); assert.equal(f.rows(NOW - DAY, NOW, NOW + DAY).length, 2);
});
test('calendar advance retains existing rows and catches up late rows without duplicates', t => {
  const f = fixture(t); f.put(NOW - 1000); f.put(NOW + DAY); f.warm();
  const resetCount = () => f.changes.filter(value => value.reset).length;
  const before = resetCount(); f.put(NOW - 2000); f.warm(NOW + DAY);
  assert.equal(resetCount(), before); assert.equal(f.cache.rows, 3);
  assert.equal(new Set(f.rows(NOW - DAY, NOW + DAY + 1, NOW + DAY + 1).map(row => row.id)).size, 3);
});
test('capacity, configuration disable and old ranges never pretend to be resident', t => {
  const f = fixture(t, { maxBytes: 1000 }); f.put(NOW - DAY); f.put(NOW - 1000); f.warm();
  assert(f.cache.bytes <= 1000); assert.equal(f.cache.covers(NOW - 10 * DAY, NOW, NOW), false);
  f.cache.configure({ days: 0, maxBytes: 1000 }); assert.equal(f.cache.rows, 0); assert(f.cache.maintain(NOW).complete);
});

test('a capacity-shortened window converges instead of restarting its initial scan', t => {
  const f = fixture(t, { maxBytes: 600 });
  for (let day = 6; day >= 0; day--) f.put(NOW - day * DAY - 1000);
  f.warm(); assert(f.cache.ready); assert(f.cache.bytes <= 600);
  const resets = f.changes.filter(value => value.reset).length;
  f.warm(); assert.equal(f.changes.filter(value => value.reset).length, resets);
  assert.equal(f.cache.covers(NOW - 7 * DAY, NOW, NOW), false);
});

test('a changed history selection or import revision cannot reuse a resident snapshot before maintenance', t => {
 const f=fixture(t); f.put(NOW-1000); f.warm();
 assert(f.cache.covers(NOW-DAY,NOW,NOW,f.cache.head,f.cache.revision));
 assert.equal(f.cache.covers(NOW-DAY,NOW,NOW,f.cache.head,JSON.stringify([999,0])),false);
 assert.equal(f.cache.covers(NOW-DAY,NOW,NOW,f.cache.head,JSON.stringify([0,999])),false);
});

test('a long forward clock jump loads only the requested new window', t => {
 const f=fixture(t); f.put(NOW-1000); f.warm();
 for(let day=1;day<=30;day++)f.put(NOW+day*DAY);
 const next=NOW+30*DAY; f.warm(next);
 assert(f.cache.ready); assert(f.cache.rows<=9); assert(f.rows(next-DAY,next+1,next+1).length);
});
