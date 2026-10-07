const MAX_PENDING = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
const RETRY_MS = 10;
const failure = (code, message) => Object.assign(new Error(message), { code });
export const sqliteContention = error => Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 0xff);

/** Admission only: a callback runs exactly once, after its SQLite writer lock
 * is held. Retrying an operation after it starts could repeat commands or RAM
 * mutations, even if SQLite rolled its writes back. */
export class WriteQueue {
  constructor({ transaction, onFailure = () => {}, clock = Date.now }) {
    Object.assign(this, { transaction, onFailure, clock });
    this.queues = { control: [], normal: [] };
    this.bytes = 0; this.running = false; this.closed = false; this.timer = null;
    this.waitingSince = null; this.overflows = 0; this.controlStreak = 0;
  }
  status() {
    const jobs = [...this.queues.control, ...this.queues.normal];
    return { pending: jobs.length, bytes: this.bytes, waitingSince: this.waitingSince,
      oldestAt: jobs.length ? Math.min(...jobs.map(job => job.at)) : null,
      overflows: this.overflows, limit: MAX_PENDING, byteLimit: MAX_BYTES };
  }
  run(fn, { signal, isCurrent = () => true, priority = 'normal', bytes = 0 } = {}) {
    if (typeof fn !== 'function' || typeof isCurrent !== 'function' || !Object.hasOwn(this.queues, priority)
      || !Number.isSafeInteger(bytes) || bytes < 0)
      return Promise.reject(new TypeError('Invalid database write admission'));
    if (fn.constructor?.name === 'AsyncFunction') return Promise.reject(new TypeError('SQLite transaction callback must be synchronous'));
    if (this.closed) return Promise.reject(failure('STORAGE_CLOSED', 'Recording storage is closed.'));
    if (signal?.aborted) return Promise.reject(failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.'));
    if (this.queues.control.length + this.queues.normal.length >= MAX_PENDING || this.bytes + bytes > MAX_BYTES) {
      this.overflows++;
      const error = failure('STORAGE_QUEUE_FULL', 'Recording is delayed and the pending save queue is full. This save was not accepted.');
      this.onFailure(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const job = { fn, signal, isCurrent, priority, bytes, at: this.clock(), resolve, reject };
      job.abort = () => {
        if (job.started) return;
        if (!this.remove(job)) return;
        reject(failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.'));
        this.schedule(0);
      };
      this.queues[priority].push(job); this.bytes += bytes;
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
    job.signal?.removeEventListener('abort', job.abort);
    return true;
  }
  schedule(delay) {
    if (this.closed || this.timer) return;
    if (!this.queues.control.length && !this.queues.normal.length) { this.waitingSince = null; return; }
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
  }
  pump() {
    if (this.running || this.closed) return;
    this.running = true;
    const started = performance.now();
    let completed = 0, contended = false;
    try {
      while (!this.closed && completed < 8 && performance.now() - started < 8) {
        // Control is urgent, but cannot permanently starve retained observations.
        const priority = this.queues.control.length && (this.controlStreak < 8 || !this.queues.normal.length) ? 'control' : 'normal';
        const job = this.queues[priority][0];
        if (!job) break;
        let invoked = false;
        try {
          if (job.signal?.aborted) throw failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.');
          if (!job.isCurrent()) throw failure('STORAGE_WRITE_STALE', 'The pending save no longer belongs to the current operation.');
          const result = this.transaction(() => {
            invoked = true;
            if (job.signal?.aborted) throw failure('STORAGE_WRITE_CANCELLED', 'The pending save was cancelled.');
            if (!job.isCurrent()) throw failure('STORAGE_WRITE_STALE', 'The pending save no longer belongs to the current operation.');
            job.started = true;
            return job.fn();
          });
          this.remove(job); job.resolve(result); this.waitingSince = null;
        } catch (error) {
          if (!invoked && sqliteContention(error)) {
            this.waitingSince ??= this.clock(); contended = true; break;
          }
          this.remove(job); this.onFailure(error); job.reject(error);
        }
        this.controlStreak = priority === 'control' ? this.controlStreak + 1 : 0;
        completed++;
      }
    } finally { this.running = false; }
    this.schedule(contended ? RETRY_MS : 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    for (const job of [...this.queues.control, ...this.queues.normal]) {
      if (job.started) continue;
      this.remove(job); job.reject(failure('STORAGE_CLOSED', 'Recording storage closed before the pending save could commit.'));
    }
    this.waitingSince = null;
  }
}
