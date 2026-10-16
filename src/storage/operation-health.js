/** Process-local observations of existing storage owners. This is deliberately
 * passive: no timers, I/O, admission rules, retries or persisted identifiers. */
export const STORAGE_OPERATION_KINDS = Object.freeze([
  'backup', 'backup-download', 'verification', 'backup-catalog', 'backup-inspection',
  'learning-rebuild', 'learning-publication', 'checkpoint-cache', 'recovery',
  'journal-maintenance', 'replication', 'replication-worker', 'peer-transfer', 'pairing-snapshot', 'reset-archive',
  'history-query', 'storage-inventory', 'csv-import', 'csv-export', 'local-publication',
]);
const kinds = new Set(STORAGE_OPERATION_KINDS);
const outcomes = ['completed', 'failed', 'cancelled', 'superseded', 'unconfirmed'];
const stages = new Set(['queued', 'starting', 'reading', 'copying', 'verifying', 'rebuilding', 'publishing', 'cleanup', 'running']);
const scopes = new Set(['runtime', 'history', 'standby', 'shared']);
const reasons = new Set(['operation-failed', 'cancelled', 'superseded', 'capacity', 'worker-lost', 'cleanup-failed',
  'durability-unconfirmed', 'committed-followup-failed', 'stale', 'observation-limit']);
const BUCKET_MS = 5 * 60_000, DAY_MS = 86400_000, RETENTION_MS = 7 * DAY_MS, MAX_ACTIVE = 128;
const empty = () => ({ completed: 0, failed: 0, cancelled: 0, superseded: 0, unconfirmed: 0, refused: 0,
  committed: 0, durationSamples: 0, elapsedMs: 0, runningMs: 0, queueMs: 0, maxElapsedMs: 0 });
// Fixed fields keep dense seven-day summaries cheap on the controller thread.
function addCounters(target, source) {
  target.completed += source.completed; target.failed += source.failed;
  target.cancelled += source.cancelled; target.superseded += source.superseded;
  target.unconfirmed += source.unconfirmed; target.refused += source.refused;
  target.committed += source.committed; target.durationSamples += source.durationSamples;
  target.elapsedMs += source.elapsedMs; target.runningMs += source.runningMs;
  target.queueMs += source.queueMs;
  target.maxElapsedMs = Math.max(target.maxElapsedMs, source.maxElapsedMs);
}
const inert = Object.freeze({ start() {}, progress() {}, finish() {}, discard() {} });
const nonnegative = value => Number.isFinite(value) ? Math.max(0, value) : 0;

export function createStorageOperationHealth({ clock = Date.now, monotonic = () => performance.now() } = {}) {
  const startedAt = clock(), startTick = monotonic(), families = new Map(), active = new Map(), buckets = new Map();
  const live = new Map();
  let nextId = 0, observationsDropped = 0;
  const elapsed = () => nonnegative(monotonic() - startTick);
  const trim = now => { for (const at of buckets.keys()) if (at < now - RETENTION_MS) buckets.delete(at); };
  const register = kind => {
    if (!kinds.has(kind)) return false;
    if (!families.has(kind)) families.set(kind, { monitoredSince: clock(), sinceTick: elapsed(), lastResult: null });
    return true;
  };
  const record = (kind, values) => {
    const now = elapsed(); trim(now);
    const at = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    if (!buckets.has(at)) buckets.set(at, new Map());
    const bucket = buckets.get(at);
    if (!bucket.has(kind)) bucket.set(kind, empty());
    const aggregate = bucket.get(kind);
    for (const [key, value] of Object.entries(values))
      if (key === 'maxElapsedMs') aggregate[key] = Math.max(aggregate[key], value);
      else aggregate[key] += value;
  };
  const begin = (kind, { queued = false, scope = 'runtime' } = {}) => {
    if (!register(kind)) return inert;
    const id = ++nextId, at = clock(), tick = monotonic();
    const job = { kind, scope: scopes.has(scope) ? scope : 'runtime', queuedAt: at,
      startedAt: queued ? null : at, stage: queued ? 'queued' : 'running', tick, runTick: queued ? null : tick };
    let finished = false;
    if (!live.has(kind)) live.set(kind, { queued: 0, running: 0 });
    const counts = live.get(kind); counts[queued ? 'queued' : 'running']++;
    if (active.size < MAX_ACTIVE) active.set(id, job); else observationsDropped++;
    return {
      start() { if (finished || job.startedAt !== null) return; counts.queued--; counts.running++; job.startedAt = clock(); job.runTick = monotonic(); job.stage = 'running'; },
      progress(stage) { if (!finished && stages.has(stage)) job.stage = stage; },
      discard() {
        if (finished) return; finished = true; active.delete(id); counts[job.startedAt === null ? 'queued' : 'running']--;
      },
      finish(outcome, { reason = null, committed = null } = {}) {
        if (finished) return;
        finished = true; active.delete(id); counts[job.startedAt === null ? 'queued' : 'running']--;
        const finishedAt = clock(), ended = monotonic(), elapsedMs = nonnegative(ended - tick);
        const runningMs = job.runTick === null ? 0 : nonnegative(ended - job.runTick), queueMs = Math.max(0, elapsedMs - runningMs);
        outcome = outcomes.includes(outcome) ? outcome : 'unconfirmed';
        const result = { scope: job.scope, queuedAt: job.queuedAt, startedAt: job.startedAt, finishedAt,
          outcome, reason: reasons.has(reason) ? reason : null, committed: typeof committed === 'boolean' ? committed : null,
          elapsedMs, runningMs, queueMs };
        families.get(kind).lastResult = result; families.get(kind).lastFinishedTick = elapsed();
        record(kind, { [outcome]: 1, committed: Number(committed === true), durationSamples: 1, elapsedMs, runningMs, queueMs, maxElapsedMs: elapsedMs });
      },
    };
  };
  const refuse = kind => { if (register(kind)) record(kind, { refused: 1 }); };
  const status = () => {
    const observedAt = clock(), nowTick = monotonic(), now = nonnegative(nowTick - startTick); trim(now);
    for (const family of families.values()) if (now - family.lastFinishedTick > RETENTION_MS) family.lastResult = null;
    const window = (kind, interval) => {
      const monitoredMs = Math.min(interval, Math.max(0, now - (kind ? families.get(kind)?.sinceTick ?? now : 0)));
      const retainedStart = Math.ceil(Math.max(0, now - interval) / BUCKET_MS) * BUCKET_MS;
      return { ...empty(), requestedMs: interval, monitoredMs, coveredMs: Math.min(monitoredMs, Math.max(0, now - retainedStart)) };
    };
    const summaries = new Map(STORAGE_OPERATION_KINDS.map(kind => [kind,
      { day: window(kind, DAY_MS), week: window(kind, RETENTION_MS), active: [] }]));
    // Visit each retained observation aggregate once. Parent/stage families
    // remain separate; the global fields summarize observations, not unique jobs.
    for (const [at, bucket] of buckets) {
      const includeDay = at >= now - DAY_MS;
      for (const [kind, counters] of bucket) {
        const summary = summaries.get(kind);
        addCounters(summary.week, counters);
        if (includeDay) addCounters(summary.day, counters);
      }
    }
    for (const job of active.values()) summaries.get(job.kind).active.push({
      scope: job.scope, queuedAt: job.queuedAt, startedAt: job.startedAt, stage: job.stage,
      elapsedMs: nonnegative(nowTick - job.tick),
    });
    const day = window(null, DAY_MS), week = window(null, RETENTION_MS);
    const coverage = STORAGE_OPERATION_KINDS.map(kind => {
      const owner = families.get(kind), summary = summaries.get(kind);
      addCounters(day, summary.day); addCounters(week, summary.week);
      return { kind, monitored: Boolean(owner), monitoredSince: owner?.monitoredSince ?? null,
        queued: live.get(kind)?.queued ?? 0, running: live.get(kind)?.running ?? 0,
        activeDetailsOmitted: Math.max(0, (live.get(kind)?.queued ?? 0) + (live.get(kind)?.running ?? 0) - summary.active.length),
        active: summary.active,
        lastResult: owner?.lastResult ? { ...owner.lastResult } : null,
        day: summary.day, week: summary.week };
    });
    return { version: 1, scope: 'local-node', period: 'application-run', startedAt, observedAt,
      bucketMs: BUCKET_MS, retentionMs: RETENTION_MS, observationsDropped,
      queued: coverage.reduce((sum, row) => sum + row.queued, 0), running: coverage.reduce((sum, row) => sum + row.running, 0),
      day, week, coverage };
  };
  // Observability must never change storage, control or cleanup outcomes.
  const bestEffort = (fn, fallback) => (...args) => { try { return fn(...args); } catch { return fallback; } };
  return { register: bestEffort(register, false), begin: bestEffort((...args) => {
    const token = begin(...args);
    return Object.fromEntries(Object.entries(token).map(([key, method]) => [key, bestEffort(method, undefined)]));
  }, inert), refuse: bestEffort(refuse, undefined), status: bestEffort(status, null) };
}
export const storageOperationHealth = createStorageOperationHealth();

/** Completion belongs outside the owner's existing cleanup/join block. */
export async function observeStorageOperation(kind, work, options = {}) {
  let operation;
  try { operation = storageOperationHealth.begin(kind, options); } catch { operation = inert; }
  const finish = (...args) => { try { operation?.finish(...args); } catch {} };
  let result;
  try { result = await work(operation); }
  catch (error) {
    const cancelled = options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
    const unconfirmed = error?.code === 'database_publication_unconfirmed' || error?.durability === 'unknown';
    finish(unconfirmed ? 'unconfirmed' : cancelled ? 'cancelled' : 'failed', {
      reason: unconfirmed ? 'durability-unconfirmed' : error?.committed === true ? 'committed-followup-failed'
        : cancelled ? 'cancelled' : 'operation-failed', committed: error?.committed === true ? true : null });
    throw error;
  }
  finish('completed');
  return result;
}
