import { Worker } from 'node:worker_threads';
import { sensorRevision } from './sensor-inputs.js';
import { validLearningCheckpoint } from './committed-learning.js';

const failureMessage = 'Learning checkpoint cache could not be saved; committed learning remains available for replay.';
const sameFences = (left, right) => left && right
  && ['databaseId', 'epoch', 'selection', 'fireplaceRevision', 'sensorRevision'].every(key => left[key] === right[key]);

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
  fences() {
    return { databaseId: this.store.checkpoint().databaseId, epoch: this.store.learningEpoch(this.input),
      selection: this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation,
      fireplaceRevision: this.store.db.prepare('SELECT COALESCE(MAX(id),0) revision FROM active_fireplace_events WHERE input=?')
        .get(this.input).revision, sensorRevision: sensorRevision(this.store, this.input) };
  }
  fail(request = null) {
    // A delayed failure of an older save cannot undo independently confirmed
    // publication of that boundary or a newer interpretation. Requests made
    // after that confirmation still report their own failures.
    if (request && this.confirmation?.sequence >= request.id
      && (!sameFences(this.confirmation.fences, request.fences)
        || this.confirmation.journalCursor >= request.journalCursor)) {
      try { if (sameFences(this.fences(), this.confirmation.fences)) return; } catch {}
    }
    if (!sameFences(this.failure?.fences, request?.fences) || !(this.failure.journalCursor > request.journalCursor))
      this.failure = request;
    this.result = { ...this.result, status: 'failed', error: failureMessage, failed: this.result.failed + 1 };
  }
  confirm(fences, journalCursor) {
    if (!this.writable() || !Number.isSafeInteger(journalCursor) || journalCursor < 0
      || (journalCursor === 0 && this.store.learningJournalHead(this.input) !== 0)
      || !sameFences(this.fences(), fences)) return false;
    if (sameFences(this.confirmation?.fences, fences)) journalCursor = Math.max(journalCursor, this.confirmation.journalCursor);
    if (sameFences(this.failure?.fences, fences) && this.failure.journalCursor > journalCursor) return false;
    this.confirmation = { fences, journalCursor, sequence: this.sequence }; this.failure = null;
    this.result = { ...this.result, status: 'current', error: null, journalCursor };
    return true;
  }
  confirmCommitted(checkpoint) {
    if ((!this.result.error && !this.active && !this.pending) || !this.writable()) return;
    try {
      const fences = this.fences(), expected = { journalCursor: checkpoint?.journalCursor, digest: checkpoint?.checkpointDigest };
      if (checkpoint !== null && ((checkpoint?.fireplaceRevision ?? 0) !== fences.fireplaceRevision
        || (checkpoint?.sensorRevision ?? 0) !== fences.sensorRevision)) return;
      this.store.afterCommit(() => {
        try {
          if (!this.writable() || !sameFences(this.fences(), fences)) return;
          const saved = this.store.getState(`adaptive:${this.input}`);
          if (checkpoint === null) {
            if (saved === null && this.store.learningJournalHead(this.input) === 0) this.confirm(fences, 0);
            return;
          }
          if (saved?.journalCursor !== expected.journalCursor || saved?.checkpointDigest !== expected.digest
            || (saved?.fireplaceRevision ?? 0) !== fences.fireplaceRevision
            || (saved?.sensorRevision ?? 0) !== fences.sensorRevision) return;
          const last = this.store.learningJournal({ input: this.input, after: expected.journalCursor - 1, limit: 1 })[0];
          if (last && validLearningCheckpoint(saved, last)) this.confirm(fences, saved.journalCursor);
        } catch { /* Status confirmation cannot fail an already committed controller update. */ }
      });
    } catch { /* Preserve the original warning when confirmation is unavailable. */ }
  }
  save(checkpoint) {
    if (!this.writable()) return false;
    const request = { id: ++this.sequence, journalCursor: checkpoint?.journalCursor, fences: null };
    try {
      const fences = request.fences = this.fences();
      // Control can intentionally retain an older interpretation while a source
      // correction rebuilds. It must never overwrite that rebuild's publication.
      if ((checkpoint?.fireplaceRevision ?? 0) !== fences.fireplaceRevision
        || (checkpoint?.sensorRevision ?? 0) !== fences.sensorRevision) return false;
      const payload = JSON.stringify(checkpoint);
      if (typeof payload !== 'string' || this.store.path === ':memory:') { this.fail(request); return false; }
      const { id } = request;
      // Callbacks capture only an ID. Multiple saves inside one transaction do
      // not retain multiple large snapshots, including when that work rolls back.
      // A rolled-back replacement can omit an earlier optional pending cache;
      // the last durable cache and all committed replay inputs remain intact.
      this.pending = { payload, ...request, committed: false };
      this.store.afterRollback(() => {
        if (this.pending?.id === id) this.pending = null;
        this.idle();
      });
      this.store.afterCommit(() => {
        try {
          if (this.pending?.id !== id) return;
          this.pending.committed = true; this.pump();
        } catch { this.pending = null; this.fail(request); this.idle(); }
      });
      return true;
    } catch { this.fail(request); return false; }
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
          const request = this.active; this.active = null;
          if (['saved', 'current'].includes(message.status) && Number.isSafeInteger(message.journalCursor) && message.journalCursor > 0) {
            this.result = { ...this.result, status: this.result.error ? 'failed' : 'idle',
              saved: this.result.saved + Number(message.status === 'saved'),
              skipped: this.result.skipped + Number(message.status === 'current') };
            try { this.confirm(request.fences, message.journalCursor); } catch {}
          }
          else if (message.status === 'stale' || message.status === 'cancelled')
            this.result = { ...this.result, status: this.result.error ? 'failed' : 'idle', skipped: this.result.skipped + 1 };
          else this.fail(request);
          this.pump();
        });
      } catch { const request = this.pending; this.pending = null; this.fail(request); this.idle(); }
      return;
    }
    this.worker.ref();
    if (!this.ready) return;
    const job = this.pending; this.pending = null;
    this.active = { id: job.id, fences: job.fences, journalCursor: job.journalCursor };
    this.result = { ...this.result, status: 'saving' };
    try { this.worker.postMessage({ type: 'save', ...job }); }
    catch { this.workerFailed(this.worker); }
  }
  workerFailed(worker) {
    if (this.worker !== worker) return;
    const request = this.pending ?? this.active;
    this.active = null; this.pending = null;
    if (!this.closed) this.fail(request);
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
