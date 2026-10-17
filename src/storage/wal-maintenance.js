/** One bounded request at a time. The queue gives controller writes first turn;
 * the owning worker checks the actual uncheckpointed frame count before I/O. */
export class WalMaintenance {
  constructor(store) {
    this.store = store; this.closed = false; this.pending = null;
    this.runs = 0; this.samples = [];
    this.timer = setInterval(() => this.poll(), 250); this.timer.unref();
  }
  poll() {
    if (this.closed || this.pending || this.store.writerFailed || this.store.writer?.failed) return;
    this.pending = this.store.runStorageTask(() => this.store.writer.request('checkpoint'), { kind: 'checkpoint' })
      .then(result => {
        this.last = result;
        if(result.ran) {
          this.runs++; this.lastRun={...result,at:Date.now()};this.samples.push(this.lastRun);
          if(this.samples.length>64)this.samples.shift();
        }
      }, () => { this.failures = (this.failures ?? 0) + 1; })
      .finally(() => { this.pending = null; });
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
