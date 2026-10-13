import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { ChargingAllowanceHistory } from '../src/charging/allowance-history.js';

const start = Date.parse('2026-10-13T08:00:00Z');
const status = (offset = 0, allowanceA = 16) => ({
  mode: allowanceA === 16 ? 'unrestricted' : 'limited', allowanceA,
  maximumCurrentA: 16, reportedAllowanceA: null, reason: 'property-headroom',
  source: 'st-mq-load-balancing', measuredAt: start + offset - 100,
  receivedAt: start + offset, sourceTimes: [], sourceEpoch: 'fixture:1',
  limiter: { mode: allowanceA === 16 ? 'unrestricted' : 'limited', allowanceA,
    loadAllowanceA: allowanceA, reason: 'property-headroom', appliedCurrentA: 16, applicationStatus: 'confirmed' },
});
function fixture(t) {
  const store = new Store(':memory:');
  // Exercise the production admission/history methods without starting unrelated
  // planners or physical controllers. Acquisition supplies synthetic statuses.
  const runtime = Object.create(ChargingRuntime.prototype);
  let now = start, authority = true, admissions = 0;
  const values = { charger1: status(), charger2: status() };
  Object.assign(runtime, { store, clock: () => now, canControl: () => authority, closed: false,
    writeAbort: new AbortController(), limiterHistoryPending: 0, limiterHistorySequence: 0, vehicleFeeds: {},
    config: { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-easee' } } },
    configuration: { chargers: { charger2: { enabled: true } } },
    chargers: { charger1: { association: 'a'.repeat(64) }, charger2: { association: 'b'.repeat(64) } },
    controlStatus: id => values[id], allowanceStatus: (_id, value) => value,
    preserveWriteState: () => {}, limiterHistory: new ChargingAllowanceHistory({ store, input: 'mqtt' }) });
  const runWrite = store.runWrite.bind(store);
  store.runWrite = (...args) => { admissions++; return runWrite(...args); };
  t.after(() => { runtime.beginShutdown(); store.close(); });
  return { runtime, store, values, set: (offset, allowanceA = 16) => {
    now = start + offset; values.charger1 = status(offset); values.charger2 = status(offset, allowanceA);
  }, authority: value => { authority = value; }, admissions: () => admissions,
  coverage: () => store.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(),
  rows: () => store.observations({ signal: 'charger2_current_allowance' }),
  transactions: () => store.writeHealth.status().transactions.committed };
}
async function holdWriter(t, store) {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const flight = store.runPublication(async () => { entered(); await held; });
  t.after(() => release());
  await ready;
  return { release: async () => { release(); await flight; } };
}

test('runtime confirmations avoid outer admission until either charger coverage is due', async t => {
  const f = fixture(t), before = f.transactions();
  for (let offset = 0; offset <= 120_000; offset += 100) {
    f.set(offset); await f.runtime.recordLimiterHistory();
  }
  assert.equal(f.admissions(), 25, '1,201 callbacks for both chargers use one initial save and 24 five-second admissions');
  assert.equal(f.transactions() - before, 25);
  assert.equal(f.store.observations().length, 2);
  assert(f.coverage().every(row => row.samples === 1201 && row.end_at === start + 120_000));
  assert.equal(f.runtime.limiterHistoryPending, 0);
});

test('same-stack role callbacks release a successfully committed guard before later unchanged reports', async t => {
  const f = fixture(t), flights = [];
  for (let offset = 0; offset <= 120_000; offset += 100) {
    f.set(offset); flights.push(f.runtime.recordLimiterHistory());
  }
  await Promise.all(flights);
  assert.equal(f.admissions(), 25);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert(f.coverage().every(row => row.samples === 1201 && row.end_at === start + 120_000));
});

test('a delayed writer retains captured A to B to A and prevents a newer RAM confirmation overtaking B', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store);
  f.set(1000, 8); const b = f.runtime.recordLimiterHistory();
  f.set(2000); const a = f.runtime.recordLimiterHistory();
  assert.equal(f.runtime.limiterHistoryPending, 2);
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start);
  // Mutating the acquisition object after submission must not rewrite B's evidence.
  f.values.charger2.allowanceA = 3;
  f.set(60_000, 4);
  await held.release(); await Promise.all([b, a]);
  assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value, row.sourceTime - start]),
    [[0, 16, -100], [1000, 8, 900], [2000, 16, 1900]]);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  const coverage = f.coverage().filter(row => row.signal === 'charger2_current_allowance');
  assert.deepEqual(coverage.map(row => [row.start_at - start, row.end_at - start, row.source_time - start]),
    [[0, 1000, -100], [1000, 2000, 900], [2000, 2000, 1900]]);
});

test('an enclosing transaction also queues its captured callback behind an older allowance transition', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store);
  f.set(1000, 8); const b = f.runtime.recordLimiterHistory();
  let a;
  f.set(2000); f.store.transaction(() => { a = f.runtime.recordLimiterHistory(); });
  // Store transactions cannot return asynchronous work, so obtain the child
  // promise without returning it from the synchronous transaction callback.
  await held.release(); await Promise.all([b, a]);
  assert.deepEqual(f.rows().map(row => row.value), [16, 8, 16]);
  assert.equal(f.runtime.limiterHistoryPending, 0);
});

test('configured suspension flushes its confirmed tail without extending to the disable callback', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(1000); await f.runtime.recordLimiterHistory();
  f.runtime.config.connections.easee.charger_id = '';
  f.runtime.configuration.chargers.charger2.enabled = false;
  f.set(20_000); await f.runtime.recordLimiterHistory();
  assert(f.coverage().every(row => row.end_at === start + 1000 && row.source_time === start + 900 && row.samples === 2));
  assert.equal(f.runtime.limiterHistory.previous.size, 0);
  assert.equal(f.admissions(), 2);
});

test('lost authority rejects captured history without flushing old coverage or creating new observations', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(1000); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store);
  f.set(2000, 8); const queued = f.runtime.recordLimiterHistory();
  f.authority(false); await held.release(); await queued;
  assert.deepEqual(f.rows().map(row => row.value), [16]);
  assert(f.coverage().every(row => row.end_at === start));
  assert.equal(f.runtime.limiterHistory.previous.size, 0);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.flushLimiterHistory(), 0);
  const admissions = f.admissions(); f.set(5000); await f.runtime.recordLimiterHistory();
  assert.equal(f.admissions(), admissions);
});

test('shutdown cancels queued edges while preserving the last confirmed RAM tail for an authorized final flush', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(1000); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store);
  f.set(2000, 8); const queued = f.runtime.recordLimiterHistory();
  f.runtime.beginShutdown(); await queued; await held.release();
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.limiterHistoryError, null);
  f.set(600_000, 4); await f.runtime.recordLimiterHistory();
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start + 1000);
  assert.throws(() => f.runtime.flushLimiterHistory(), /authorized storage transaction/);
  assert.equal(f.store.transaction(() => f.runtime.flushLimiterHistory()), 2);
  assert.deepEqual(f.rows().map(row => row.value), [16]);
  assert(f.coverage().every(row => row.end_at === start + 1000 && row.samples === 2));
  assert.equal(f.store.transaction(() => f.runtime.flushLimiterHistory()), 0);
  assert.equal(f.runtime.writeAbort.signal.aborted, true, 'Final history flushing never reopens command admission');
});

test('a failed admitted save decrements the pending count and breaks continuity without recursively flushing', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(1000); await f.runtime.recordLimiterHistory();
  const exec = f.store.db.exec.bind(f.store.db); let failed = false;
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('Synthetic commit failure'); }
    return exec(sql);
  };
  f.set(2000, 8); await f.runtime.recordLimiterHistory();
  f.store.db.exec = exec;
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.limiterHistory.previous.size, 0);
  assert.match(f.runtime.limiterHistoryError, /could not be saved/);
  assert.deepEqual(f.rows().map(row => row.value), [16]);
  assert(f.coverage().every(row => row.end_at === start));
  f.set(3000); await f.runtime.recordLimiterHistory();
  assert.deepEqual(f.rows().map(row => row.receivedAt - start), [0, 3000]);
  assert.equal(f.runtime.limiterHistoryError, null);
});

test('a failed queued commit breaks its span before the next queued success and cannot erase that success later', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(500); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store);
  f.set(1000, 8); const b = f.runtime.recordLimiterHistory();
  f.set(2000); const a = f.runtime.recordLimiterHistory();
  const exec = f.store.db.exec.bind(f.store.db); let failed = false;
  f.store.db.exec = sql => {
    if (sql === 'COMMIT' && !failed) { failed = true; throw new Error('Synthetic queued commit failure'); }
    return exec(sql);
  };
  await held.release(); await Promise.all([b, a]); f.store.db.exec = exec;
  assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value]), [[0, 16], [2000, 16]]);
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start + 2000);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.limiterHistoryError, null);
  assert.deepEqual(f.coverage().filter(row => row.signal === 'charger2_current_allowance')
    .map(row => [row.start_at - start, row.end_at - start]), [[0, 0], [2000, 2000]]);
});

for (const failure of ['fatal BEGIN', 'busy retry'])
  test(`${failure} before body entry preserves honest spans and the later queued observation`, async t => {
    const f = fixture(t); await f.runtime.recordLimiterHistory();
    f.set(500); await f.runtime.recordLimiterHistory();
    const held = await holdWriter(t, f.store);
    f.set(1000, 8); const b = f.runtime.recordLimiterHistory();
    f.set(2000); const a = f.runtime.recordLimiterHistory();
    const exec = f.store.db.exec.bind(f.store.db); let failed = false;
    f.store.db.exec = sql => {
      if (sql === 'BEGIN IMMEDIATE' && !failed) {
        failed = true;
        throw Object.assign(new Error(`Synthetic ${failure}`), { code: 'ERR_SQLITE_ERROR', errcode: failure === 'fatal BEGIN' ? 10 : 5 });
      }
      return exec(sql);
    };
    await held.release(); await Promise.all([b, a]); f.store.db.exec = exec;
    assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start + 2000);
    assert.equal(f.runtime.limiterHistoryPending, 0);
    assert.equal(f.runtime.limiterHistoryError, null);
    const coverage = f.coverage().filter(row => row.signal === 'charger2_current_allowance');
    if (failure === 'fatal BEGIN') {
      assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value]), [[0, 16], [2000, 16]]);
      assert.deepEqual(coverage.map(row => [row.start_at - start, row.end_at - start]), [[0, 0], [2000, 2000]]);
    } else {
      assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value]), [[0, 16], [1000, 8], [2000, 16]]);
      assert.deepEqual(coverage.map(row => [row.start_at - start, row.end_at - start]), [[0, 1000], [1000, 2000], [2000, 2000]]);
      assert.equal(coverage[0].samples, 3, 'A transient lock does not discard the buffered unchanged confirmation');
      assert.equal(coverage[0].source_time, start + 400);
    }
  });

test('queue rejection before preadmission reports the missed save and breaks prior continuity', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(500); await f.runtime.recordLimiterHistory();
  const held = await holdWriter(t, f.store), queued = [];
  const capacity = f.store.writeQueueStatus().limit;
  for (let i = 1; i < capacity; i++) queued.push(f.store.runWrite(() => {}));
  f.set(1000, 8); await f.runtime.recordLimiterHistory();
  assert.match(f.runtime.limiterHistoryError, /could not be saved/);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.limiterHistory.previous.size, 0);
  await held.release(); await Promise.all(queued);
  f.set(2000); await f.runtime.recordLimiterHistory();
  assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value]), [[0, 16], [2000, 16]]);
});

test('an immediately admitted A after unattempted queue rejection of B cannot bridge the missed edge before its catch', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(500); await f.runtime.recordLimiterHistory();
  const runWrite = f.store.runWrite.bind(f.store); let rejected = false;
  f.store.runWrite = (...args) => {
    if (!rejected) {
      rejected = true;
      return Promise.reject(Object.assign(new Error('Synthetic queue capacity rejection'), { code: 'STORAGE_QUEUE_FULL' }));
    }
    return runWrite(...args);
  };
  f.set(1000, 8); const b = f.runtime.recordLimiterHistory();
  // No await: A's uncontended transaction runs before B's rejection microtask.
  f.set(2000); const a = f.runtime.recordLimiterHistory();
  assert.deepEqual(f.rows().map(row => [row.receivedAt - start, row.value]), [[0, 16], [2000, 16]]);
  await Promise.all([b, a]);
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start + 2000);
  assert.equal(f.runtime.limiterHistoryPending, 0);
  assert.equal(f.runtime.limiterHistoryError, null);
  f.store.transaction(() => f.runtime.flushLimiterHistory());
  assert.deepEqual(f.coverage().filter(row => row.signal === 'charger2_current_allowance')
    .map(row => [row.start_at - start, row.end_at - start]), [[0, 0], [2000, 2000]]);
});

test('an optional final tail failure rolls back independently and permits measured accounting to commit', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(1000); await f.runtime.recordLimiterHistory(); f.runtime.beginShutdown();
  const extend = f.runtime.limiterHistory.extend.bind(f.runtime.limiterHistory);
  f.runtime.limiterHistory.extend = (...args) => { extend(...args); throw new Error('Synthetic allowance tail failure'); };
  f.store.transaction(() => {
    assert.equal(f.runtime.flushLimiterHistory(), 0);
    f.store.setState('synthetic:measured-accounting', { observedAt: start + 1000, energyKwh: 1 });
  });
  assert.equal(f.store.getState('synthetic:measured-accounting').energyKwh, 1);
  assert(f.coverage().every(row => row.end_at === start));
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').pendingSamples, 1);
  assert.match(f.runtime.limiterHistoryError, /could not be saved/);
});

test('out-of-order callbacks cannot move the buffered endpoint backward or create a late semantic row', async t => {
  const f = fixture(t); await f.runtime.recordLimiterHistory();
  f.set(2000); await f.runtime.recordLimiterHistory();
  f.set(1000, 8); await f.runtime.recordLimiterHistory();
  assert.equal(f.admissions(), 1);
  assert.deepEqual(f.rows().map(row => row.value), [16]);
  assert.equal(f.runtime.limiterHistory.previous.get('charger2').at, start + 2000);
  f.store.transaction(() => f.runtime.flushLimiterHistory());
  assert(f.coverage().every(row => row.end_at === start + 2000 && row.samples === 2));
});
