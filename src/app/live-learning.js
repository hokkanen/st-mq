import { Worker } from 'node:worker_threads';
import { attachStorageAdmission, terminateStorageWorker } from '../storage/worker-admission.js';
import { takeImmutableValue } from '../domain/immutable.js';
import { readCoefficientCoverage, createCoefficientGeneration, appendCoefficientEvents, discardCoefficientGeneration } from '../storage/coefficient-history.js';

const failed = () => Object.assign(new Error('Live learning calculation failed; the previous model remains available.'),
  { code: 'LIVE_LEARNING_FAILED' });
const cancelled = () => Object.assign(new Error('Live learning calculation was cancelled.'), { code: 'STORAGE_WRITE_CANCELLED' });
const PAGE = 128;

/** One readonly calculation at a time. Large new coefficient tails are staged
 * by the owner in bounded writes and remain unselected until Engine publication. */
export class LiveLearning {
  constructor({ store, input }) {
    this.store = store; this.input = input; this.sequence = 0; this.closed = false;
    this.worker = null; this.active = null; this.digest = undefined;
    this.coefficientBatches = new WeakMap(); this.coefficientGenerations = new Set();
    this.stageKey = `live-learning:coefficient-stage:${input}`;
    const saved = store.getState(this.stageKey);
    if (saved !== null && saved !== undefined) {
      if (Object.keys(saved).join(',') !== 'generation'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(saved.generation ?? '')) throw failed();
      this.coefficientGenerations.add(saved.generation);
    }
  }
  async cleanupCoefficientGenerations() {
    for (const generation of [...this.coefficientGenerations]) {
      if (generation === this.active?.coefficientGeneration) continue;
      try {
        for (;;) {
          const result = await this.store.runWrite(() => {
            const result = discardCoefficientGeneration(this.store, generation, { limit: PAGE });
            if (result.complete || !result.removed) {
              if (this.store.getState(this.stageKey)?.generation === generation) this.store.setState(this.stageKey, null);
              this.store.afterCommit(() => this.coefficientGenerations.delete(generation));
            }
            return result;
          });
          if (result.complete || !result.removed) break;
          await new Promise(resolve => setImmediate(resolve));
        }
      } catch { /* The durable owner marker allows cleanup on a later startup. */ }
    }
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
      if (['coefficient-start', 'coefficient-page'].includes(message?.type)) { void this.stage(worker, message); return; }
      if (message?.type !== 'result' || message.id !== this.active?.id) return;
      const job = this.active; this.active = null;
      try {
        if (!message.ok || !job.isCurrent()) throw failed();
        if (job.operation === 'replay') {
          this.digest = message.result?.checkpointDigest ?? null;
          const checkpoint = job.checkpoint?.checkpointDigest && job.checkpoint.checkpointDigest === message.result?.checkpointDigest
            ? job.checkpoint : takeImmutableValue(message.result);
          if (message.coefficientBatch) this.coefficientBatches.set(checkpoint, message.coefficientBatch);
          job.resolve(checkpoint);
        } else job.resolve(message.result);
      } catch { this.digest = undefined; job.reject(failed()); void this.cleanupCoefficientGenerations(); }
      worker.unref();
    });
    worker.on('error', () => this.fail(worker));
    worker.on('exit', () => { if (this.worker === worker) this.fail(worker); });
  }
  async stage(worker, message) {
    const job = this.active;
    const current = () => worker === this.worker && this.active === job && !this.closed && job?.isCurrent();
    if (!current() || message.id !== job.id || job.operation !== 'replay') { this.fail(worker); return; }
    try {
      await this.store.runWrite(() => {
        if (!current()) throw cancelled();
        if (message.type === 'coefficient-start') {
          if (job.coefficientGeneration || message.epoch !== this.store.learningEpoch(this.input)
            || message.selection !== this.store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation) throw failed();
          const coverage = readCoefficientCoverage(this.store, { input: this.input });
          if ((coverage?.generation ?? null) !== message.baseGeneration || (coverage?.cursor ?? 0) !== message.prefixCursor) throw failed();
          const generation = createCoefficientGeneration(this.store, this.input, { epoch: message.epoch,
            selection: message.selection, fireplaceRevision: message.fireplaceRevision, sensorRevision: message.sensorRevision,
            prefixCursor: message.stagePrefixCursor, projection: message.projection,
            sourceGeneration: message.stagePrefixCursor ? message.baseGeneration : undefined });
          job.coefficientGeneration = generation;
          this.store.afterRollback(() => { job.coefficientGeneration = undefined; });
          this.store.setState(this.stageKey, { generation });
          this.store.afterCommit(() => this.coefficientGenerations.add(generation));
        } else {
          if (!job.coefficientGeneration || message.coefficientGeneration !== job.coefficientGeneration
            || !Array.isArray(message.events) || message.events.length > PAGE) throw failed();
          appendCoefficientEvents(this.store, job.coefficientGeneration, { events: message.events, projection: message.projection });
        }
        this.store.afterCommit(() => {
          if (current()) worker.postMessage({ type: 'coefficient-ack', requestId: message.requestId, generation: job.coefficientGeneration });
        });
      }, { isCurrent: current });
    } catch { if (worker === this.worker) this.fail(worker); }
  }
  calculate(operation, options = {}, checkpoint = null, { isCurrent = () => true } = {}) {
    if (this.closed) return Promise.reject(cancelled());
    if (this.active) return Promise.reject(new Error('A live learning calculation is already pending'));
    return new Promise((resolve, reject) => {
      const job = this.active = { id: ++this.sequence, operation, options, checkpoint, isCurrent, resolve, reject };
      void this.cleanupCoefficientGenerations().then(() => {
        if (this.closed || this.active !== job || !isCurrent()) { if (this.active === job) { this.active = null; reject(cancelled()); } return; }
        try { this.start(); this.worker.ref(); this.send(); }
        catch { this.fail(this.worker); }
      });
    });
  }
  takeCoefficientBatch(checkpoint) {
    const batch = this.coefficientBatches.get(checkpoint); this.coefficientBatches.delete(checkpoint); return batch;
  }
  commitCoefficientBatch(batch) {
    const generation = batch?.coefficientGeneration;
    if (!generation) return;
    if (this.store.getState(this.stageKey)?.generation === generation) this.store.setState(this.stageKey, null);
    this.store.afterCommit(() => this.coefficientGenerations.delete(generation));
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
    this.stopping = Promise.all([this.stopping, worker ? terminateStorageWorker(worker).catch(() => {}) : undefined]).then(() => this.cleanupCoefficientGenerations());
  }
  beginShutdown() {
    if (this.closed) return;
    this.closed = true; this.fail(this.worker);
  }
  async close() { this.beginShutdown(); await this.stopping; }
}
