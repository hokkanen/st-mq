const MAX_PENDING = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
const RETRY_MS = 10;
const failure = (code, message) => Object.assign(new Error(message), { code });
export const sqliteContention = error => Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff);

/** Admission only: a callback runs exactly once, after its SQLite writer lock
 * is held. Retrying an operation after it starts could repeat commands or RAM
 * mutations, even if SQLite rolled its writes back. */
export class WriteQueue {
  constructor({ transaction, asyncTransaction = null, onFailure = () => {}, onHealth = () => {}, clock = Date.now,
    monotonic = () => performance.now() }) {
    Object.assign(this, { transaction, asyncTransaction, onFailure, onHealth, clock, monotonic });
    this.queues = { control: [], normal: [], background: [] };
    this.bytes = 0; this.running = false; this.closed = false; this.timer = null;
    this.waitingSince = null; this.overflows = 0; this.controlStreak = 0; this.foregroundStreak = 0;
    this.pendingLength = 0;
    this.shutdown = new AbortController();
    this.idleListeners = new Set();
  }
  status() {
    const jobs = Object.values(this.queues).flat();
    const queued = jobs.filter(job => !job.started);
    return { pending: jobs.length, bytes: this.bytes, waitingSince: this.waitingSince,
      oldestAt: jobs.length ? Math.min(...jobs.map(job => job.at)) : null,
      queued: queued.length, activeJobs: jobs.length - queued.length,
      oldestPendingMs: queued.length ? Math.max(0, this.monotonic() - Math.min(...queued.map(job => job.monotonicAt))) : null,
      overflows: this.overflows, limit: MAX_PENDING, byteLimit: MAX_BYTES };
  }
  health(event) { try { this.onHealth(event); } catch { /* Diagnostics never change admission or saved outcomes. */ } }
  waiting(value) {
    if (value) {
      if (this.waitingSince === null) { this.waitingSince = this.clock(); this.health({ type: 'waiting' }); }
    } else {
      if (this.waitingSince !== null) this.health({ type: 'ready' });
      this.waitingSince = null;
    }
  }
  completed(job) { if(job.priority!=='background') this.health({ type: 'completed', priority: job.priority, delayMs: job.delayMs }); }
  failed(job,error) { if(job.priority!=='background') this.onFailure(error); }
  start(job) {
    job.started = true; this.pendingLength--;
    this.health({ type: 'pending', pending: this.pendingLength });
  }
  rejected(error) {
    this.health({ type: ['STORAGE_WRITE_CANCELLED', 'STORAGE_WRITE_STALE', 'STORAGE_CLOSED'].includes(error?.code)
      ? 'cancelled' : 'failed' });
  }
  run(fn, { signal, isCurrent = () => true, priority = 'normal', bytes = 0 } = {}) {
    return this.enqueue(fn, { signal, isCurrent, priority, bytes }, false);
  }
  // Reserve admission while a worker owns an atomic publication. No SQLite
  // transaction spans this await; the owner must join the worker and adopt its
  // committed process state before resolving, including an uncertain outcome.
  exclusive(fn, options = {}) { return this.enqueue(fn, options, true); }
  enqueue(fn, { signal, isCurrent = () => true, priority = 'normal', bytes = 0 } = {}, external) {
    if (typeof fn !== 'function' || typeof isCurrent !== 'function' || !Object.hasOwn(this.queues, priority)
      || !Number.isSafeInteger(bytes) || bytes < 0)
      return Promise.reject(new TypeError('Invalid database write admission'));
    if (!external && fn.constructor?.name === 'AsyncFunction') return Promise.reject(new TypeError('SQLite transaction callback must be synchronous'));
    if (this.closed) return Promise.reject(failure('STORAGE_CLOSED', 'Recording storage is closed.'));
    if (signal?.aborted) return Promise.reject(failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.'));
    if (Object.values(this.queues).reduce((count, queue) => count + queue.length, 0) >= MAX_PENDING || this.bytes + bytes > MAX_BYTES) {
      this.overflows++;
      this.health({ type: 'rejected' });
      const error = failure('STORAGE_QUEUE_FULL', 'Recording is delayed and the pending save queue is full. This save was not accepted.');
      if(priority!=='background')this.onFailure(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job = { fn, signal, isCurrent, priority, bytes, external, at: this.clock(),
        monotonicAt: this.monotonic(), resolve, reject };
      job.abort = () => {
        if (job.started || job.admitting) return;
        if (!this.remove(job)) return;
        this.health({ type: 'cancelled' });
        reject(failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.'));
        this.schedule(0);
      };
      this.queues[priority].push(job); this.bytes += bytes;
      this.pendingLength++;
      this.health({ type: 'accepted' });
      this.health({ type: 'pending', pending: this.pendingLength });
      signal?.addEventListener('abort', job.abort, { once: true });
      // The uncontended path still runs before returning its Promise. An outer
      // caller may use existing synchronous state transitions without a new gap.
      if (!this.running && !this.timer) this.pump();
    });
  }
  remove(job) {
    const queue = this.queues[job.priority], index = queue.indexOf(job);
    if (index < 0) return false;
    queue.splice(index, 1); this.bytes -= job.bytes;
    if (!job.started) this.pendingLength--;
    this.health({ type: 'pending', pending: this.pendingLength });
    job.signal?.removeEventListener('abort', job.abort);
    return true;
  }
  schedule(delay) {
    if (this.closed || this.timer) return;
    if (!Object.values(this.queues).some(queue => queue.length)) { this.waiting(false); return; }
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
  }
  pump() {
    if (this.running || this.closed) return;
    if (this.asyncTransaction) { this.pumpAsync(); return; }
    this.running = true;
    const started = performance.now();
    let completed = 0, contended = false, external = false;
    try {
      while (!this.closed && completed < 8 && performance.now() - started < 8) {
        // Control is urgent, but cannot permanently starve retained observations.
        const priority = this.nextPriority();
        const job = this.queues[priority][0];
        if (!job) break;
        let invoked = false;
        try {
          if (job.signal?.aborted) throw failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.');
          if (!job.isCurrent()) throw failure('STORAGE_WRITE_STALE', 'The pending save no longer belongs to the current operation.');
          if (job.external) {
            this.start(job); external = true; this.waiting(false);
            Promise.resolve().then(() => {
              job.delayMs = Math.max(0, this.monotonic() - job.monotonicAt); return job.fn();
            }).then(result => { this.completed(job); job.resolve(result); }, error => {
              if (error?.committed === true) this.completed(job); else this.rejected(error);
              this.failed(job,error); job.reject(error);
            }).finally(() => {
              this.remove(job); this.running = false; this.waiting(false);
              this.controlStreak = priority === 'control' ? this.controlStreak + 1 : 0;
              this.foregroundStreak = priority === 'background' ? 0 : this.foregroundStreak + 1;
              this.notifyIdle();
              this.schedule(0);
            });
            return;
          }
          const result = this.transaction(() => {
            invoked = true;
            this.waiting(false);
            if (job.signal?.aborted) throw failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.');
            if (!job.isCurrent()) throw failure('STORAGE_WRITE_STALE', 'The pending save no longer belongs to the current operation.');
            this.start(job);
            job.delayMs = Math.max(0, this.monotonic() - job.monotonicAt);
            return job.fn();
          });
          this.completed(job); this.remove(job); job.resolve(result); this.waiting(false);
        } catch (error) {
          if (!invoked && sqliteContention(error)) {
            this.waiting(true); contended = true; break;
          }
          if (error?.committed === true) this.completed(job); else this.rejected(error);
          this.remove(job); this.failed(job,error); job.reject(error);
        }
        this.controlStreak = priority === 'control' ? this.controlStreak + 1 : 0;
        this.foregroundStreak = priority === 'background' ? 0 : this.foregroundStreak + 1;
        completed++;
      }
    } finally { if (!external) {this.running = false;this.notifyIdle();} }
    this.schedule(contended ? RETRY_MS : 0);
  }
  // The writer connection is reserved from asynchronous BEGIN through durable
  // settlement. The callback still runs once, synchronously, after admission.
  nextPriority() {
    // Sustained ingestion must not indefinitely prevent WAL maintenance or
    // mirroring. An explicitly urgent control save still precedes this turn.
    if(!this.queues.control.length&&this.queues.background.length&&this.foregroundStreak>=32)return 'background';
    if (this.queues.control.length && (this.controlStreak < 8 || !this.queues.normal.length)) return 'control';
    return this.queues.normal.length ? 'normal' : 'background';
  }
  pumpAsync() {
    const priority = this.nextPriority();
    const job = this.queues[priority][0];
    if (!job) { this.notifyIdle(); return; }
    this.running = true; job.admitting = true;
    let invoked = false, contended = false;
    const current = () => {
      if (this.closed) throw failure('STORAGE_CLOSED', 'Recording storage is closed.');
      if (job.signal?.aborted) throw failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.');
      if (!job.isCurrent()) throw failure('STORAGE_WRITE_STALE', 'The pending save no longer belongs to the current operation.');
    };
    Promise.resolve().then(() => {
      current();
      const invoke = () => {
        current(); invoked = true; this.start(job); this.waiting(false);
        job.delayMs = Math.max(0, this.monotonic() - job.monotonicAt);
        return job.fn();
      };
      return job.external ? invoke() : this.asyncTransaction(invoke);
    }).then(result => {
      this.completed(job); this.remove(job); job.resolve(result); this.waiting(false);
    }, error => {
      if (!invoked && !this.closed && !job.signal?.aborted && sqliteContention(error)) {
        contended = true; this.waiting(true); return;
      }
      if (error?.committed === true) this.completed(job); else this.rejected(error);
      this.remove(job); this.failed(job,error); job.reject(error);
    }).finally(() => {
      job.admitting = false; this.running = false;
      if (!contended) this.controlStreak = priority === 'control' ? this.controlStreak + 1 : 0;
      if (!contended) this.foregroundStreak = priority === 'background' ? 0 : this.foregroundStreak + 1;
      this.notifyIdle(); this.schedule(contended ? RETRY_MS : 0);
    });
  }
  idle() {
    if (!this.running) return Promise.resolve();
    return new Promise(resolve => this.idleListeners.add(resolve));
  }
  notifyIdle() {
    if (this.running) return;
    for (const resolve of this.idleListeners) resolve();
    this.idleListeners.clear();
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    this.shutdown.abort();
    for (const job of Object.values(this.queues).flat()) {
      if (job.started || job.admitting) continue;
      this.remove(job); this.health({ type: 'cancelled' });
      job.reject(failure('STORAGE_CLOSED', 'Recording storage closed before the pending save could commit.'));
    }
    this.waiting(false);
  }
}
