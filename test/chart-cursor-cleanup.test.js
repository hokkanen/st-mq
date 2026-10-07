import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addRecordedEnergy } from '../src/app/chart-energy.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { ENERGY_SIGNALS, HISTORY_AXIS_BY_KEY } from '../src/domain/history-series.js';

const MINUTE = 60_000;
const day = chartRange({ startDate: '2026-01-15', now: Date.parse('2026-01-16T00:00:00Z') });

/** Keep real SQLite statements/iterators underneath the injected failures so
 * this proves that error unwinding closes active database cursors. */
function trackedDatabase(db, accepts, failure, originalError, cleanupFailure = true, failureAt = 3) {
  let prepared = 0, opened = 0, closed = 0;
  const pending = new Set();
  const facade = { prepare(sql) {
    if (!accepts(sql)) return db.prepare(sql);
    const ordinal = ++prepared;
    if (failure === 'prepare' && ordinal === failureAt) throw originalError;
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
            if (!primed && failure === 'prime' && ordinal === failureAt) throw originalError;
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

for (const recent of [true, false]) for (const failure of ['prepare', 'prime', 'projection']) test(`${recent ? 'recent' : 'historical'} energy cursors close after ${failure} failure without masking it`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const prefix of ['ev1', 'ev2', 'property']) for (const phase of [1, 2, 3]) for (const minute of [1, 2])
    store.observation({ source: 'easee', device: `invented-${prefix}`, signal: `${prefix}_energy_l${phase}`,
      value: 0.1, unit: 'kWh', sourceTime: day.from + minute * MINUTE, receivedAt: day.from + minute * MINUTE,
      quality: ['estimated'], raw: { intervalStart: day.from + (minute - 1) * MINUTE, intervalEnd: day.from + minute * MINUTE } });
  for (const [source, signal] of [['mqtt-equipment', 'caravan_energy']])
    for (const minute of [1, 2]) store.observation({ source, device: `invented-${signal}`, signal,
    value: 0.1, unit: 'kWh', sourceTime: day.from + minute * MINUTE, receivedAt: day.from + minute * MINUTE,
    quality: ['estimated'], raw: { intervalStart: day.from + (minute - 1) * MINUTE, intervalEnd: day.from + minute * MINUTE } });
  const originalError = new Error(`Synthetic energy ${failure} failure`);
  const tracker = trackedDatabase(store.db, sql => sql.includes('SELECT id,source,device,signal,value,unit,source_time,received_at,quality,raw')
    && sql.includes('FROM observations INDEXED BY'), failure, originalError, true, 1);
  assert.throws(() => addRecordedEnergy({ store: { db: tracker.facade }, range: day, now: day.to + (recent ? 0 : 60 * 24 * 60 * MINUTE),
    input: 'providers', envelopes: { charger_power: { add() { throw originalError; } } }, timing: { addEnergy() {} } }),
  error => error === originalError);
  assert.equal(tracker.pending.size, 0);
  assert.equal(tracker.counts().opened, failure === 'prepare' ? 0 : 1);
  assert.equal(tracker.counts().closed, tracker.counts().opened);
});

for (const failure of ['prepare', 'prime', 'processing']) test(`scalar cursors close through CSV and coverage merges after ${failure} failure`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  // Exercise real recorder channels, regardless of which derived temperatures
  // the chart currently shares on its right axis.
  for (const signal of HISTORY_AXIS_BY_KEY.temperatures.signals)
    store.observation({ source: 'fixture-temperature', device: 'invented-house', signal,
      value: 20, unit: 'degC', sourceTime: day.from, receivedAt: day.from, quality: [] });
  // Keep the surrounding merge cursors active while a native scalar fails.
  // The imported row and coverage transition follow the first native reading.
  const importId = Number(store.db.prepare(`INSERT INTO imports(kind,sha256,path,status,started_at,completed_at)
    VALUES('stmq','cursor-cleanup-fixture','/invented/chart.csv','complete',?,?)`).run(day.from,day.from).lastInsertRowid);
  const importedAt = day.from + MINUTE;
  store.db.prepare("INSERT INTO import_rows(import_id,row_number,source_time,raw,quality,canonical) VALUES(?,1,?,?,?,'[]')")
    .run(importId, importedAt, `${importedAt / 1000},8,60,21,12,0`, '[]');
  store.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,samples)
    VALUES('fixture-temperature','invented-house','indoor_temperature','failed',?,?,1)`)
    .run(day.from + 2 * MINUTE, day.from + 3 * MINUTE);
  const originalError = new Error(`Synthetic scalar ${failure} failure`);
  const tracker = trackedDatabase(store.db, sql => sql.includes('FROM observations o INDEXED BY observations_signal_time')
    && sql.includes('WHERE o.signal=? AND o.source_time>=?'), failure, originalError);
  const imports = trackedDatabase(tracker.facade, sql => sql.includes('SELECT r.canonical,r.source_time,r.row_number,i.id,i.kind,i.started_at')
    && sql.includes('FROM active_import_rows r JOIN active_imports'), 'observe', originalError, false);
  const coverage = trackedDatabase(imports.facade, sql => sql.includes('FROM transitions t LEFT JOIN active_observations'), 'observe', originalError, false);
  assert.throws(() => getChartData({ store: { db: coverage.facade }, input: 'offline',
    now: day.to, startDate: '2026-01-01', endDate: '2026-01-15', left: 'indoor_temperature' }), error => error === originalError);
  for (const stream of [tracker, imports, coverage]) assert.equal(stream.pending.size, 0);
  assert(tracker.counts().closed >= (failure === 'prepare' ? 2 : 3));
  assert.ok(imports.counts().opened >= 1, 'The CSV merge is exercised alongside native scalar acquisition');
  assert.equal(imports.counts().closed, 1, 'Error unwinding closes the active CSV cursor');
  // Preparation/priming fail before the outer merge can prime coverage.
  const coverageOpened = failure === 'processing' ? 1 : 0;
  assert.equal(coverage.counts().opened, coverageOpened);
  assert.equal(coverage.counts().closed, coverageOpened, 'Processing failure closes the active coverage cursor');
});
