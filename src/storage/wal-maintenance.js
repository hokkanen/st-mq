import { WAL_POLICY } from './storage-policy.js';

/** One request at a time. The queue gives controller writes first turn;
 * the owning worker checks the actual uncheckpointed frame count before I/O. */
export class WalMaintenance {
  constructor(store) {
    this.store = store; this.closed = false; this.pending = null;
    this.runs = 0; this.samples = []; this.running = false; this.failing = false;
    this.lastObserved = null; this.lastFailureAt = null;
    this.timer = setInterval(() => this.poll(), WAL_POLICY.pollMs); this.timer.unref();
  }
  poll() {
    if (this.closed || this.pending || this.store.writerFailed || this.store.writer?.failed) return;
    this.pending = this.store.runStorageTask(async () => {
      this.running = true;
      try { return await this.store.writer.request('checkpoint'); }
      finally { this.running = false; }
    }, { kind: 'checkpoint' })
      .then(result => {
        this.last = result;
        const at = Date.now();
        const observed = Number.isSafeInteger(result.log) && result.log >= 0
          && Number.isSafeInteger(result.checkpointed) && result.checkpointed >= 0 && result.checkpointed <= result.log;
        if (observed)
          this.lastObserved = { at, logFrames: result.log, copiedFrames: result.checkpointed,
            remainingFrames: result.log - result.checkpointed };
        // A throttled request proves neither recovery nor a new frame count.
        if (result.ran || observed && result.log === result.checkpointed) this.failing = false;
        if(result.ran) {
          this.runs++; this.lastRun={...result,at};this.samples.push(this.lastRun);
          if(this.samples.length>64)this.samples.shift();
          try { this.store.writeHealth.checkpoint(result); } catch { /* Diagnostics only. */ }
        }
      }, () => {
        this.failures = (this.failures ?? 0) + 1; this.failing = true; this.lastFailureAt = Date.now();
        try { this.store.writeHealth.checkpoint({ failed: true }); } catch { /* Diagnostics only. */ }
      })
      .finally(() => { this.pending = null; });
  }
  status() {
    return { state: this.store.writerFailed || this.store.writer?.failed ? 'unavailable'
      : this.closed ? 'stopped' : this.failing ? 'failed' : this.running ? 'running' : this.pending ? 'queued' : 'idle',
      frames: this.lastObserved && { ...this.lastObserved },
      lastRun: this.lastRun ? { at: this.lastRun.at, elapsedMs: this.lastRun.elapsedMs } : null,
      lastFailureAt: this.lastFailureAt };
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
