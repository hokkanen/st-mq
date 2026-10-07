import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRecoveryHistoryReader } from '../src/app/history-recovery-reader.js';

function fixture(t) {
  const workers = []; let now = 1000;
  class Worker extends EventEmitter {
    constructor() { super(); this.messages = []; workers.push(this); }
    postMessage(value) { this.messages.push(value); }
    terminate() { this.terminated = true; return Promise.resolve(); }
  }
  const reader = createRecoveryHistoryReader({ path: '/synthetic/current.sqlite' }, { WorkerClass: Worker, clock: () => now });
  t.after(() => reader.close());
  return { reader, workers, advance: () => { now += 1000; },
    complete(index, rows, worker = workers[0]) { worker.emit('message', { id: worker.messages[index].id, rows }); } };
}
const options = { limit: 50 };

test('history pages never wait for counts, duplicate polls share work and invalidated reads cannot replace current history', async t => {
  const f = fixture(t);
  for (let poll = 0; poll < 100; poll++) assert.deepEqual(f.reader.snapshot('mqtt', options), { rows: [], loading: true, error: null });
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].messages.length, 1);
  const original = [{ id: 'synthetic-recovery', active: true }];
  f.complete(0, original);
  assert.deepEqual(f.reader.snapshot('mqtt', options), { rows: original, loading: false, error: null });
  f.advance();
  assert.deepEqual(f.reader.snapshot('mqtt', options).rows, original, 'a slow refresh leaves the bounded previous page visible');
  f.reader.invalidate();
  assert.equal(f.reader.snapshot('mqtt', options).loading, true);
  f.complete(1, original);
  assert.equal(f.reader.snapshot('mqtt', options).loading, true, 'the old generation is discarded');
  const revised = [{ id: 'synthetic-recovery', active: false }];
  f.complete(2, revised);
  assert.deepEqual(f.reader.snapshot('mqtt', options).rows, revised);
});

test('reader failures are explicit and sanitized, and a later refresh retries with a new worker', async t => {
  const f = fixture(t);
  f.reader.snapshot('mqtt', options);
  f.workers[0].emit('error', new Error('/private/synthetic-database.sqlite'));
  const failed = f.reader.snapshot('mqtt', options);
  assert.equal(failed.loading, false); assert.match(failed.error, /unavailable.*Refresh/);
  assert.doesNotMatch(failed.error, /private|sqlite/);
  f.advance(); f.reader.snapshot('mqtt', options);
  assert.equal(f.workers.length, 2);
  f.complete(0, [], f.workers[1]);
  assert.deepEqual(f.reader.snapshot('mqtt', options), { rows: [], loading: false, error: null });
  await f.reader.close();
  assert(f.workers.every(worker => worker.terminated));
  assert.equal(f.reader.snapshot('mqtt', options).loading, false);
});

test('history query validation precedes allocation and concurrent page requests remain bounded', async t => {
  const f = fixture(t);
  for (const [input, page] of [['retired-input', options], ['mqtt', { limit: 101 }], ['mqtt', { limit: 50, before: 'invalid' }],
    ['mqtt', { limit: 50, before: '999999999999999999999:a' }], ['mqtt', { limit: 50, arbitrary: true }]]) {
    assert.throws(() => f.reader.snapshot(input, page), error => error.statusCode === 400);
  }
  assert.equal(f.workers.length, 0);
  for (let page = 0; page < 8; page++) assert.equal(f.reader.snapshot('mqtt', { limit: 50, before: `${page}:synthetic` }).loading, true);
  assert.equal(f.reader.snapshot('mqtt', { limit: 50, before: '9:synthetic' }).loading, false);
  assert.equal(f.workers[0].messages.length, 8);
});

test('shutdown awaits a failed reader still releasing its database handle', async t => {
  const f = fixture(t);
  f.reader.snapshot('mqtt', options);
  let terminated;
  f.workers[0].terminate = () => new Promise(resolve => { terminated = resolve; });
  f.workers[0].emit('error', new Error('synthetic reader failure'));
  let closed = false;
  const closing = f.reader.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  terminated(); await closing;
  assert.equal(closed, true);
});
