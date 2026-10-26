import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createEventLogService } from '../src/app/event-log-service.js';
import { eventLogQuery } from '../src/app/event-log.js';

const NOW = Date.parse('2026-10-26T00:00:00Z');
const args = (area = 'all', extra = {}) => ({ input: 'mqtt', now: NOW, checkedAt: NOW,
  query: eventLogQuery(new URL(`http://fixture/api/events?area=${area}`)), ...extra });
function fixture(t, options = {}) {
  const workers = [];
  class ControlledWorker extends EventEmitter {
    constructor(url, { workerData }) {
      super(); this.sent = []; this.cancelled = new Int32Array(workerData.requestSignal); workers.push(this);
    }
    unref() {}
    postMessage(message) { this.sent.push(message); }
    complete(result = { checkedAt: NOW }) { this.emit('message', { id: this.sent.at(-1).id, result }); }
    async terminate() { await this.exitGate; this.emit('exit', 0); return 0; }
  }
  const service = createEventLogService({ store: { db: {}, path: '/synthetic/events.sqlite', runStorageTask: fn => fn() },
    WorkerClass: ControlledWorker, ...options });
  t.after(() => service.close());
  return { service, workers };
}

test('matching concurrent live reads share one check and keep its original clock without caching a completed page', async t => {
  const { service, workers } = fixture(t);
  const one = service.query(args()), two = service.query(args('all', { now: NOW + 1, checkedAt: NOW + 1 }));
  assert.equal(workers.length, 1); assert.equal(workers[0].sent.length, 1);
  workers[0].complete();
  assert.deepEqual(await Promise.all([one, two]), [{ checkedAt: NOW }, { checkedAt: NOW }]);
  const next = service.query(args()); assert.equal(workers[0].sent.length, 2);
  workers[0].complete(); await next;
});

test('snapshot checkpoint, source clock, filters and visible membership keep separate flights', async t => {
  const { service, workers } = fixture(t);
  const base = args('all', { scope: 'snapshot', snapshotAt: NOW, checkpoint: { databaseId: 'synthetic', sequence: 1, hash: 'one' } });
  const requests = [base,
    { ...base, checkpoint: { ...base.checkpoint, sequence: 2, hash: 'two' } },
    { ...base, now: NOW - 1, snapshotAt: NOW - 1 }, args('home'),
    { ...base, query: { ...base.query, visible: ['event:0000000000000001'] } },
  ].map(value => service.query(value));
  for (let index = 0; index < requests.length; index++) {
    assert.equal(workers[0].sent.length, index + 1);
    workers[0].complete({ index }); assert.deepEqual(await requests[index], { index });
  }
});

test('one subscriber can cancel a shared read without cancelling its remaining subscriber', async t => {
  const { service, workers } = fixture(t), abort = new AbortController();
  const cancelled = service.query(args(), { signal: abort.signal }), retained = service.query(args());
  const checked = assert.rejects(cancelled, { name: 'AbortError' });
  abort.abort(); await checked;
  assert.equal(Atomics.load(workers[0].cancelled, 0), 0);
  workers[0].complete(); assert.deepEqual(await retained, { checkedAt: NOW });
});

test('queued cancellation removes work and the last active cancellation waits for native cleanup', async t => {
  const { service, workers } = fixture(t), activeAbort = new AbortController(), queuedAbort = new AbortController();
  let settled = false;
  const active = service.query(args(), { signal: activeAbort.signal }).finally(() => { settled = true; });
  const queued = service.query(args('home'), { signal: queuedAbort.signal });
  const activeChecked = assert.rejects(active, { name: 'AbortError' }), queuedChecked = assert.rejects(queued, { name: 'AbortError' });
  queuedAbort.abort(); await queuedChecked;
  assert.equal(workers[0].sent.length, 1);
  activeAbort.abort(); await delay(1);
  assert.equal(Atomics.load(workers[0].cancelled, 0), 1); assert.equal(settled, false);
  const fresh = service.query(args());
  workers[0].complete(); await activeChecked;
  assert.equal(workers[0].sent.length, 2); assert.equal(Atomics.load(workers[0].cancelled, 0), 0);
  workers[0].complete(); await fresh;
});

test('queue and subscribers are bounded while duplicates do not consume extra queued flights', async t => {
  const { service, workers } = fixture(t);
  const requests = [service.query(args()), ...['home', 'charging', 'garage', 'system'].map(area => service.query(args(area)))];
  await assert.rejects(service.query(args('caravan')), { code: 'event_log_unavailable' });
  const duplicate = service.query(args());
  workers[0].complete(); await requests[0]; await duplicate;
  for (const pending of requests.slice(1)) { workers[0].complete(); await pending; }
  const shared = Array.from({ length: 64 }, () => service.query(args()));
  await assert.rejects(service.query(args()), { code: 'event_log_unavailable' });
  workers[0].complete(); await Promise.all(shared);
});

test('queued deadlines expire during worker retirement and active callers wait for its exit', async t => {
  const { service, workers } = fixture(t, { requestTimeoutMs: 20 });
  let releaseExit;
  const first = service.query(args()); workers[0].exitGate = new Promise(resolve => { releaseExit = resolve; });
  let activeSettled = false;
  const activeChecked = assert.rejects(first.finally(() => { activeSettled = true; }), { code: 'event_log_unavailable' });
  const queuedChecked = assert.rejects(service.query(args('home')), { code: 'event_log_unavailable' });
  try {
    await delay(60); await queuedChecked;
    assert.equal(activeSettled, false); assert.equal(workers.length, 1); assert.equal(workers[0].sent.length, 1);
  } finally { releaseExit(); }
  await activeChecked;
});
