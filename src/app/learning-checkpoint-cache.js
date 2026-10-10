import { Worker } from 'node:worker_threads';
import { sensorRevision } from './sensor-inputs.js';

const failureMessage = 'Learning checkpoint cache could not be saved; committed learning remains available for replay.';

/** Ordinary learning caches may lag their immutable inputs. Keep at most one
 * worker write and the latest pending snapshot; source-correction publication
 * continues to use its separate exact-head transaction. */
export class LearningCheckpointCache {
  constructor({ store, input, canWrite = () => true }) {
    if (!store || !['mqtt', 'providers', 'simulated', 'offline'].includes(input) || typeof canWrite !== 'function')
      throw new TypeError('A current learning store, input and write-authority check are required');
    this.store = store; this.input = input; this.canWrite = canWrite;
    this.worker = null; this.ready = false; this.active = null; this.pending = null;
    this.closed = false; this.stopping = null; this.waiters = new Set(); this.sequence = 0;
    this.result = { status: 'idle', error: null, saved: 0, skipped: 0, failed: 0, journalCursor: null };
  }
  writable() {
    try { return !this.closed && !this.store.readOnly && this.canWrite(); } catch { return false; }
  }
  status() { return { ...this.result, active: Boolean(this.active), pending: Boolean(this.pending) }; }
  fail() { this.result = { ...this.result, status: 'failed', error: failureMessage, failed: this.result.failed + 1 }; }
  save(checkpoint) {
    if (!this.writable()) return false;
    try {
      const fences = { databaseId: this.store.checkpoint().databaseId, epoch: this.store.learningEpoch(this.input),
        selection: this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
        fireplaceRevision: this.store.db.prepare('SELECT COALESCE(MAX(id),0) revision FROM active_fireplace_events WHERE input=?')
          .get(this.input).revision, sensorRevision: sensorRevision(this.store, this.input) };
      // Control can intentionally retain an older interpretation while a source
      // correction rebuilds. It must never overwrite that rebuild's publication.
      if ((checkpoint?.fireplaceRevision ?? 0) !== fences.fireplaceRevision
        || (checkpoint?.sensorRevision ?? 0) !== fences.sensorRevision) return false;
      const payload = JSON.stringify(checkpoint);
      if (typeof payload !== 'string' || this.store.path === ':memory:') { this.fail(); return false; }
      const id = ++this.sequence;
      // Callbacks capture only an ID. Multiple saves inside one transaction do
      // not retain multiple large snapshots, including when that work rolls back.
      // A rolled-back replacement can omit an earlier optional pending cache;
      // the last durable cache and all committed replay inputs remain intact.
      this.pending = { id, payload, fences, committed: false };
      this.store.afterRollback(() => {
        if (this.pending?.id === id) this.pending = null;
        this.idle();
      });
      this.store.afterCommit(() => {
        try {
          if (this.pending?.id !== id) return;
          this.pending.committed = true; this.pump();
        } catch { this.pending = null; this.fail(); this.idle(); }
      });
      return true;
    } catch { this.fail(); return false; }
  }
  pump() {
    if (this.closed || this.stopping || this.active || !this.pending?.committed) { this.idle(); return; }
    if (!this.writable()) { this.pending = null; this.idle(); return; }
    if (!this.worker) {
      try {
        const cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
        const worker = new Worker(new URL('./learning-checkpoint-cache-worker.js', import.meta.url), {
          workerData: { dbPath: this.store.path, input: this.input, databaseId: this.pending.fences.databaseId,
            cancellation: cancellation.buffer },
        });
        this.worker = worker; this.cancellation = cancellation; this.ready = false;
        worker.on('error', () => this.workerFailed(worker));
        worker.on('exit', () => { if (this.worker === worker) this.workerFailed(worker); });
        worker.on('message', message => {
          if (this.worker !== worker || this.closed) return;
          if (message?.type === 'ready') { this.ready = true; this.pump(); return; }
          if (message?.type === 'failed') { this.workerFailed(worker); return; }
          if (message?.type !== 'result' || message.id !== this.active?.id) return;
          this.active = null;
          if (message.status === 'saved' && Number.isSafeInteger(message.journalCursor) && message.journalCursor > 0)
            this.result = { ...this.result, status: 'current', error: null,
            saved: this.result.saved + 1, journalCursor: message.journalCursor };
          else if (message.status === 'stale' || message.status === 'cancelled')
            this.result = { ...this.result, status: 'idle', skipped: this.result.skipped + 1 };
          else this.fail();
          this.pump();
        });
      } catch { this.pending = null; this.fail(); this.idle(); }
      return;
    }
    this.worker.ref();
    if (!this.ready) return;
    const job = this.pending; this.pending = null; this.active = { id: job.id };
    this.result = { ...this.result, status: 'saving' };
    try { this.worker.postMessage({ type: 'save', ...job }); }
    catch { this.workerFailed(this.worker); }
  }
  workerFailed(worker) {
    if (this.worker !== worker) return;
    this.active = null; this.pending = null;
    if (!this.closed) this.fail();
    this.stopWorker(worker);
  }
  stopWorker(worker = this.worker) {
    if (!worker) { this.idle(); return; }
    if (this.cancellation) Atomics.store(this.cancellation, 0, 1);
    this.worker = null; this.ready = false;
    worker.ref();
    this.stopping = Promise.resolve().then(() => worker.terminate()).catch(() => {}).finally(() => {
      this.stopping = null; this.active = null; this.pump(); this.idle();
    });
  }
  idle() {
    if (this.active || this.pending || this.stopping) return;
    // An unused cache connection cannot keep a stopped application or test
    // process alive. Queued writes ref it again; close still joins termination.
    this.worker?.unref();
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  flush() {
    this.pump();
    if (!this.active && !this.pending && !this.stopping) return Promise.resolve();
    return new Promise(resolve => this.waiters.add(resolve));
  }
  settled() { return this.flush(); }
  beginShutdown() {
    if (this.closed) return;
    this.closed = true; this.pending = null;
    this.result = { ...this.result, status: this.result.error ? 'failed' : 'idle' };
    this.stopWorker();
  }
  async close() { this.beginShutdown(); await this.settled(); }
}
