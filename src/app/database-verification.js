import { fullVerificationActivity, verifyDatabase } from '../storage/full-verifier.js';

const failure = () => Object.assign(new Error('Database verification is unavailable. Wait for storage to be ready.'), { statusCode: 409 });

/** Read-only maintenance has its own lifecycle; it never enters a recovery or
 * replication transaction. A completed run schedules the next optional check. */
export function createDatabaseVerification({ acquire, getIntervalMs = () => 0, available = () => true,
  verify = verifyDatabase, activity = fullVerificationActivity,
  clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = { state: 'idle', lastResult: null }, running, cancellation, timer, closed = false, started = false;
  let interval = 0, nextAt = null;
  const status = () => ({ ...state, intervalMs: interval, nextAt, activity: activity() });
  function schedule() {
    clearTimer(timer); timer = null;
    if (!started || closed || !interval || running) return;
    nextAt ??= clock() + interval;
    timer = setTimer(() => {
      timer = null;
      if (clock() < nextAt) { schedule(); return; }
      if (!available()) { scheduleLater(); return; }
      try { start('scheduled'); } catch { scheduleLater(); }
    }, Math.max(1, Math.min(60_000, nextAt - clock())));
    timer?.unref?.();
  }
  function scheduleLater() {
    if (closed || !interval) return;
    timer = setTimer(schedule, 60_000); timer?.unref?.();
  }
  function configure() {
    const next = getIntervalMs();
    if (!Number.isSafeInteger(next) || next < 0) throw new TypeError('Invalid verification interval');
    if (next !== interval) { interval = next; nextAt = interval ? clock() + interval : null; }
    schedule();
  }
  function start(origin = 'manual') {
    if (closed || !available()) throw failure();
    if (running) return status();
    clearTimer(timer); timer = null; nextAt = null;
    cancellation = new AbortController();
    state = { ...state, state: 'running', origin, startedAt: clock(), finishedAt: null, error: null,
      progress: { phase: 'preparing', processed: 0 } };
    const signal = cancellation.signal;
    running = (async () => {
      const source = await acquire();
      try {
        signal.throwIfAborted();
        if (!source?.dbPath || source.dbPath === ':memory:') throw failure();
        const result = await verify({ dbPath: source.dbPath, signal, origin,
          onProgress: progress => { state = { ...state, state: progress.phase === 'queued' ? 'queued' : 'running', progress }; } });
        state = { ...state, state: 'complete', finishedAt: clock(), progress: null, lastResult: result };
      } finally { await source?.release?.(); }
    })().catch(error => {
      state = { ...state, state: signal.aborted ? 'interrupted' : 'error', finishedAt: clock(), progress: null,
        error: ['database_schema_mismatch', 'database_schema_invalid', 'database_algorithm_mismatch', 'database_state_incompatible',
          'database_integrity_failed', 'database_journal_invalid', 'full_verification_checkpoint_mismatch', 'full_verification_content_mismatch',
          'full_verification_busy'].includes(error?.code)
          ? error.code : 'full_verification_failed' };
    }).finally(() => { running = null; cancellation = null; nextAt = interval ? clock() + interval : null; schedule(); });
    return status();
  }
  return { status, start, configure,
    enable() { started = true; configure(); },
    async settled() { await running; },
    async close() { closed = true; clearTimer(timer); cancellation?.abort(); await running; },
  };
}
