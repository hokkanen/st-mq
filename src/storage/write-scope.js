const cancelled = () => Object.assign(new Error('The pending save was cancelled with its owning runtime.'), { code: 'STORAGE_WRITE_CANCELLED' });

/** Cancel one runtime's queued saves without closing the shared database.
 * Restorative shutdown permits bounded storage waits; demotion cancels at once.
 * Only admission is cancelled. An already running synchronous transaction ends
 * normally, and physical obligations already committed to SQLite remain intact.
 */
export function createWriteScope({ runWrite, closeTimeoutMs = 5000, clock = () => performance.now() }) {
  if (typeof runWrite !== 'function' || !Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0)
    throw new TypeError('A writer and positive shutdown admission timeout are required');
  const controller = new AbortController(), pending = new Set();
  let closing = false, timer = null;
  const close = () => { clearTimeout(timer); timer = null; controller.abort(); };
  const schedule = () => {
    clearTimeout(timer); timer = null;
    if (!closing || controller.signal.aborted || !pending.size) return;
    const left = Math.min(...[...pending].map(job => job.at + closeTimeoutMs - clock()));
    if (left <= 0) { close(); return; }
    timer = setTimeout(schedule, left);
    timer.unref?.();
  };
  return {
    signal: controller.signal,
    async run(operation, options = {}) {
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      if (signal.aborted) throw cancelled();
      const job = { at: clock() };
      pending.add(job); schedule();
      try {
        return await runWrite(() => {
          if (signal.aborted) throw cancelled();
          return operation();
        }, { ...options, signal });
      } finally { pending.delete(job); schedule(); }
    },
    beginShutdown({ restore = true } = {}) {
      closing = true;
      if (!restore) close(); else schedule();
    },
    close,
  };
}
