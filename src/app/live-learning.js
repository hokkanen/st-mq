import { Worker } from 'node:worker_threads';
import { attachStorageAdmission } from '../storage/worker-admission.js';
import { takeImmutableValue } from '../domain/immutable.js';

const failed = () => Object.assign(new Error('Live learning calculation failed; the previous model remains available.'),
  { code: 'LIVE_LEARNING_FAILED' });
const cancelled = () => Object.assign(new Error('Live learning calculation was cancelled.'), { code: 'STORAGE_WRITE_CANCELLED' });

/** One calculation at a time. The Engine serializes its staged update, and the
 * worker owns no writer reservation while it fits or evaluates a model. */
export class LiveLearning {
  constructor({ store, input }) {
    this.store = store; this.input = input; this.sequence = 0; this.closed = false;
    this.worker = null; this.active = null; this.digest = undefined;
  }
  start() {
    if (this.worker) return;
    const storageSignal = new Int32Array(new SharedArrayBuffer(4));
    const worker = this.worker = new Worker(new URL('./live-learning-worker.js', import.meta.url), {
      workerData: { dbPath: this.store.path, input: this.input,
        databaseId: this.store.checkpoint().databaseId, storageSignal: storageSignal.buffer },
    });
    attachStorageAdmission(worker, storageSignal, operation => this.store.runStorageTask(operation, { kind: 'live-learning' }));
    worker.on('message', message => {
      if (worker !== this.worker || this.closed) return;
      if (message?.type === 'ready') { this.ready = true; this.send(); return; }
      if (message?.type === 'failed') { this.fail(worker); return; }
      if (message?.type !== 'result' || message.id !== this.active?.id) return;
      const job = this.active; this.active = null;
      try {
        if (!message.ok) throw failed();
        if (job.operation === 'replay') {
          this.digest = message.result?.checkpointDigest ?? null;
          // postMessage transferred a detached, private graph; freeze it once
          // without cloning every fitting sample a second time on the main thread.
          job.resolve(job.checkpoint?.checkpointDigest && job.checkpoint.checkpointDigest === message.result?.checkpointDigest
            ? job.checkpoint : takeImmutableValue(message.result));
        } else job.resolve(message.result);
      } catch { this.digest = undefined; job.reject(failed()); }
      worker.unref();
    });
    worker.on('error', () => this.fail(worker));
    worker.on('exit', () => { if (this.worker === worker) this.fail(worker); });
  }
  calculate(operation, options = {}, checkpoint = null) {
    if (this.closed) return Promise.reject(cancelled());
    if (this.active) return Promise.reject(new Error('A live learning calculation is already pending'));
    return new Promise((resolve, reject) => {
      this.active = { id: ++this.sequence, operation, options, checkpoint, resolve, reject };
      try { this.start(); this.worker.ref(); this.send(); }
      catch { this.fail(this.worker); }
    });
  }
  send() {
    const job = this.active;
    if (!this.ready || !job || job.sent) return;
    job.sent = true;
    const digest = job.checkpoint?.checkpointDigest ?? null;
    const message = { type: 'calculate', id: job.id, operation: job.operation, options: job.options };
    if (job.operation === 'replay') {
      message.digest = digest;
      if (this.digest !== digest) message.checkpoint = job.checkpoint;
    }
    try { this.worker.postMessage(message); } catch { this.fail(this.worker); }
  }
  fail(worker) {
    if (worker !== this.worker) return;
    this.active?.reject(this.closed ? cancelled() : failed()); this.active = null;
    this.worker = null; this.ready = false; this.digest = undefined;
    this.stopping = Promise.all([this.stopping, worker?.terminate().catch(() => {})]);
  }
  beginShutdown() {
    if (this.closed) return;
    this.closed = true; this.fail(this.worker);
  }
  async close() { this.beginShutdown(); await this.stopping; }
}
