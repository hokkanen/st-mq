import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';

const MINUTE = 60_000;
const day = chartRange({ startDate: '2026-01-15', now: Date.parse('2026-01-16T00:00:00Z') });

/** Keep real SQLite statements/iterators underneath the injected failures so
 * this proves that error unwinding closes active database cursors. */
function trackedDatabase(db, accepts, failure, originalError, cleanupFailure = true) {
  let prepared = 0, opened = 0, closed = 0;
  const pending = new Set();
  const facade = { prepare(sql) {
    if (!accepts(sql)) return db.prepare(sql);
    const ordinal = ++prepared;
    if (failure === 'prepare' && ordinal === 3) throw originalError;
    const statement = db.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key !== 'iterate') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
      return (...parameters) => {
        const actual = target.iterate(...parameters);
        assert.equal(typeof actual.return, 'function', 'SQLite supports explicit iterator closure');
        let primed = false;
        const iterator = {
          [Symbol.iterator]() { return this; },
          next() {
            if (!primed && failure === 'prime' && ordinal === 3) throw originalError;
            primed = true;
            const item = actual.next();
            if (item.done) pending.delete(iterator);
            else if (failure === 'processing' && ordinal === 1) Object.defineProperty(item.value, 'value', { get() { throw originalError; } });
            return item;
          },
          return() {
            const item = actual.return(); pending.delete(iterator); closed++;
            if (cleanupFailure && closed === 1) throw new Error('Synthetic cleanup failure must not replace the original error');
            return item;
          },
        };
        opened++; pending.add(iterator); return iterator;
      };
    } });
  } };
  return { facade, pending, counts: () => ({ prepared, opened, closed }) };
}

for (const failure of ['prepare', 'prime', 'projection']) test(`energy cursors close after ${failure} failure without masking it`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const prefix of ['ev1', 'property']) for (const phase of [1, 2, 3]) for (const minute of [1, 2])
    store.observation({ source: 'easee', device: `invented-${prefix}`, signal: `${prefix}_energy_l${phase}`,
      value: 0.1, unit: 'kWh', sourceTime: day.from + minute * MINUTE, receivedAt: day.from + minute * MINUTE,
      quality: ['estimated'], raw: { intervalStart: day.from + (minute - 1) * MINUTE, intervalEnd: day.from + minute * MINUTE } });
  for (const minute of [1, 2]) store.observation({ source: 'teslamate', device: 'invented-car', signal: 'ev2_energy',
    value: 0.1, unit: 'kWh', sourceTime: day.from + minute * MINUTE, receivedAt: day.from + minute * MINUTE,
    quality: ['estimated'], raw: { intervalStart: day.from + (minute - 1) * MINUTE, intervalEnd: day.from + minute * MINUTE } });
  const originalError = new Error(`Synthetic energy ${failure} failure`);
  const tracker = trackedDatabase(store.db, sql => sql.includes('FROM observations INDEXED BY observations_signal_time')
    && sql.includes('source_time>=?'), failure, originalError);
  assert.throws(() => addRecordedEnergy({ store: { db: tracker.facade }, range: day, now: day.to,
    input: 'providers', envelopes: { charger_power: { add() { throw originalError; } } }, timing: { addEnergy() {} } }),
  error => error === originalError);
  assert.equal(tracker.pending.size, 0);
  assert.equal(tracker.counts().opened, failure === 'prepare' ? 2 : failure === 'prime' ? 3 : 7);
  assert.equal(tracker.counts().closed, tracker.counts().opened);
});

for (const failure of ['prepare', 'prime', 'processing']) test(`scalar cursors close through CSV and coverage merges after ${failure} failure`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const signal of ['indoor_temperature', 'garage_temperature', 'outdoor_temperature'])
    store.observation({ source: 'fixture-temperature', device: 'invented-house', signal,
      value: 20, unit: 'degC', sourceTime: day.from, receivedAt: day.from, quality: [] });
  const originalError = new Error(`Synthetic scalar ${failure} failure`);
  const tracker = trackedDatabase(store.db, sql => sql.includes('FROM observations o INDEXED BY observations_signal_time')
    && sql.includes('WHERE o.signal=? AND o.source_time>=?'), failure, originalError);
  assert.throws(() => getChartData({ store: { db: tracker.facade }, input: 'offline',
    now: day.to, startDate: '2026-01-01', endDate: '2026-01-15', left: 'indoor_temperature' }), error => error === originalError);
  assert.equal(tracker.pending.size, 0);
  assert(tracker.counts().closed >= (failure === 'prepare' ? 2 : 3));
});
