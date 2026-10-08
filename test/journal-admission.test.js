import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/storage/store.js';
import { MAIN_JOURNAL_CAPTURE_BYTES, MAIN_JOURNAL_ROW_BYTES } from '../src/storage/journal-codec.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-journal-admission-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test('an oversized main-thread write rejects promptly and atomically before granting saved authority', async t => {
  const { store } = fixture(t);
  store.setState('synthetic-authority', { permitted: false });
  const checkpoint = store.checkpoint();
  // Keep the reproduced 48 MiB workload. The former accepted transaction
  // blocked this host for about 2.3 s; rejection must precede journal parsing.
  const value = 's'.repeat(48 * 1024 * 1024);
  let dispatched = false;
  const begin = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - begin), 1));
  await assert.rejects(store.runWrite(() => {
    store.setState('synthetic-authority', { permitted: true });
    store.setState('synthetic-large-document', { value });
  }).then(() => { dispatched = true; }), error => {
    assert.equal(error.code, 'journal_main_thread_transaction_too_large');
    assert.match(error.message, /storage worker/); return true;
  });
  const timerDelayMs = await timer;
  assert(timerDelayMs < 1000, `Oversized admission must stay below the runtime warning threshold (${timerDelayMs} ms)`);
  assert.equal(dispatched, false);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(store.getState('synthetic-authority'), { permitted: false });
  assert.equal(store.getState('synthetic-large-document'), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM journal_pending').get().n, 0);
  store.setState('synthetic-after-failure', { accepted: true });
  assert.equal(store.db.isTransaction, false);
  t.diagnostic(JSON.stringify({ rejectedBytes: value.length, timerDelayMs }));
});

test('cumulative main-thread capture is bounded and transaction rollback resets admission', t => {
  const { store } = fixture(t), checkpoint = store.checkpoint();
  const payload = JSON.stringify({ synthetic: 's'.repeat(MAIN_JOURNAL_ROW_BYTES / 4) });
  const insert = store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
  let attempted = 0;
  assert.throws(() => store.transaction(() => {
    for (; attempted < 100; attempted++) insert.run('synthetic-bulk', payload, attempted);
  }), { code: 'journal_main_thread_transaction_too_large' });
  assert(attempted < MAIN_JOURNAL_CAPTURE_BYTES / payload.length + 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  assert.deepEqual(store.checkpoint(), checkpoint);
  for (let i = 0; i < 12; i++) store.transaction(() => insert.run('synthetic-batched', payload, i));
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 12,
    'Separately committed bounded batches do not share a stale capture budget');
});

test('ordinary 256 KiB state edits remain admitted with exact durable values', t => {
  const { store } = fixture(t), value = 's'.repeat(256 * 1024);
  for (let revision = 0; revision < 32; revision++) store.setState('synthetic-model', { value, revision });
  assert.deepEqual(store.getState('synthetic-model'), { value, revision: 31 });
});

test('tiny repeated edits to a large document cannot evade the main-thread work bound', async t => {
  const { store } = fixture(t), value = 's'.repeat(1024 * 1024);
  store.setState('synthetic-repeated-document', { value, revision: 0 });
  const checkpoint = store.checkpoint();
  let attempted = 0;
  const begin = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - begin), 1));
  assert.throws(() => store.transaction(() => {
    for (let revision = 1; revision <= 128; revision++) {
      attempted++;
      store.setState('synthetic-repeated-document', { value, revision });
    }
  }), { code: 'journal_main_thread_transaction_too_large' });
  const timerDelayMs = await timer;
  assert(attempted <= 2, 'Raw capture work is bounded before parsing the next mostly unchanged document');
  assert(timerDelayMs < 1000, `Repeated small patches must remain below the runtime warning threshold (${timerDelayMs} ms)`);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(store.getState('synthetic-repeated-document'), { value, revision: 0 });
  t.diagnostic(JSON.stringify({ requestedEdits: 128, attempted, timerDelayMs }));
});

test('the same 48 MiB document remains supported in a storage worker while controller timers run', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-journal-worker-admission-'));
  const path = join(directory, 'synthetic.sqlite'), bytes = 48 * 1024 * 1024;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = new Worker(new URL('./helpers/journal-admission-worker.js', import.meta.url), { workerData: { path, bytes } });
  t.after(() => worker.terminate());
  let ticks = 0, maxHeartbeatMs = 0, last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxHeartbeatMs = Math.max(maxHeartbeatMs, now - last); last = now; ticks++; }, 10);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      let message;
      worker.once('message', value => { message = value; });
      worker.once('error', reject);
      worker.once('exit', code => code === 0 && message ? resolve(message) : reject(new Error(`Worker exited ${code}`)));
    });
  } finally { clearInterval(timer); }
  assert(result.ok); assert.equal(result.bytes, bytes);
  assert(ticks > 10, 'Large storage work must overlap real main-thread timers');
  assert(maxHeartbeatMs < 1000, `Worker work must not block controller timers (${maxHeartbeatMs} ms)`);
  // Verify the actual persisted value through a fresh read-only connection.
  // This explicit large read is after the responsiveness measurement.
  const reopened = new Store(path, { readOnly: true });
  try {
    const found = reopened.getState('synthetic-large-document');
    assert.equal(found.value.length, bytes);
    assert.equal(createHash('sha256').update(found.value).digest('hex'), result.digest);
    assert.deepEqual(reopened.checkpoint(), result.checkpoint);
  } finally { reopened.close(); }
  t.diagnostic(JSON.stringify({ workerBytes: bytes, ticks, maxHeartbeatMs }));
});
