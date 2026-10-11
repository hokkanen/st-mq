const DAY = 86_400_000;
const RESOLUTION = 5 * 60_000;
const RETENTION = 7 * DAY;
// Percentiles use the containing bucket's upper edge, bounded by the measured
// maximum. Means and maxima retain their measured values, without raw samples.
const EDGES = [0, .1, .25, .5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
  1000, 2000, 4000, 8000, 16000, 32000, 60000, 120000, 300000, 600000,
  1800000, 3600000, 10800000, DAY, RETENTION, Infinity];
const METRICS = ['queueDelay', 'controlQueueDelay', 'normalQueueDelay', 'transactionDuration', 'commitDuration'];
const COUNTERS = ['acceptedJobs', 'failedWrites', 'queueRejected', 'cancelledJobs', 'failedJobs',
  'postCommitFailures', 'transactionAttempts', 'committedTransactions', 'commandsNotSent'];
const CATEGORIES = new Set(['save-failed', 'queue-refused', 'command-not-sent', 'follow-up-failed']);
const CONTEXTS = new Set(['storage', 'mqtt-input', 'provider-input', 'charging-input',
  'heat-pump-command', 'switch-command', 'cover-command', 'garage-command']);
const REASONS = new Set(['write-queue-full', 'disk-full', 'database-busy', 'database-read-only',
  'database-io', 'database-corrupt', 'database-unavailable', 'recording-failed', 'recording-wait-expired', 'follow-up-failed']);
const OUTCOMES = new Set(['save-failed', 'not-retained-for-retry', 'retained-for-retry',
  'original-update-saved', 'queue-refused', 'command-not-sent', 'saved-follow-up-failed']);
const metric = () => ({ count: 0, total: 0, max: 0, histogram: new Float64Array(EDGES.length) });
const bucket = index => ({ index, peakPending: 0, episodes: 0, waitMs: 0, maxWaitMs: 0,
  leadingWaitMs: 0, trailingWaitMs: 0, leadingCarried: false,
  ...Object.fromEntries(COUNTERS.map(key => [key, 0])),
  ...Object.fromEntries(METRICS.map(key => [key, metric()])) });
function addMetric(target, value) {
  if (!Number.isFinite(value) || value < 0) return;
  target.count++; target.total += value; target.max = Math.max(target.max, value);
  target.histogram[EDGES.findIndex(edge => value <= edge)]++;
}
function describeMetric(value) {
  let cumulative = 0, p95 = null;
  if (value.count) for (let index = 0; index < EDGES.length; index++) {
    cumulative += value.histogram[index];
    if (cumulative >= Math.ceil(value.count * .95)) { p95 = Math.min(value.max, EDGES[index]); break; }
  }
  return { count: value.count, meanMs: value.count ? value.total / value.count : null,
    p95Ms: p95, maxMs: value.count ? value.max : null };
}

/** Local Store evidence only. No database access, timers, payloads or per-job
 * retention. Fixed-size five-minute aggregates expire by monotonic elapsed time.
 * Worker connections have their own independent lifetime and observations. */
export function createWriteHealthHistory({ clock = Date.now, monotonic = () => performance.now() } = {}) {
  const startedAt = clock(), origin = monotonic();
  let elapsed = 0, previousWall = startedAt, previousMono = origin, clockChanged = false;
  let pending = 0, waitingAt = null;
  const bins = new Map([[0, bucket(0)]]);
  // One latest incident per fixed category; tokens never contain operation data.
  const incidents = new Map();
  const describeIncidents = from => [...incidents.values()].filter(row => row.elapsed >= from)
    .sort((a, b) => b.elapsed - a.elapsed).map(row => ({ category: row.category, at: row.at,
      context: row.context, reason: row.reason, outcome: row.outcome, recoveredAt: row.recoveredAt }));

  function advance() {
    const mono = monotonic(), wall = clock();
    // A wall clock correction cannot expire diagnostics early or lengthen waits.
    if (Math.abs((wall - previousWall) - (mono - previousMono)) > 1000) clockChanged = true;
    previousWall = wall; previousMono = mono;
    const now = Math.max(elapsed, mono - origin), oldest = Math.max(0, Math.ceil((now - RETENTION) / RESOLUTION));
    for (const index of bins.keys()) { if (index < oldest) bins.delete(index); else break; }
    const first = Math.max(oldest, Math.floor(elapsed / RESOLUTION));
    const last = Math.floor(now / RESOLUTION);
    for (let index = first; index <= last; index++) {
      let bin = bins.get(index);
      if (!bin) { bin = bucket(index); bins.set(index, bin); }
      bin.peakPending = Math.max(bin.peakPending, pending);
      if (waitingAt !== null) {
        const start = index * RESOLUTION, end = Math.min(now, start + RESOLUTION);
        const from = Math.max(elapsed, start, waitingAt);
        if (end > from) {
          bin.waitMs += end - from;
          const length = end - Math.max(start, waitingAt);
          bin.maxWaitMs = Math.max(bin.maxWaitMs, length);
          bin.trailingWaitMs = length;
          if (waitingAt <= start) { bin.leadingWaitMs = length; bin.leadingCarried = waitingAt < start; }
        }
      }
    }
    elapsed = now;
    for (const [category, row] of incidents) if (row.elapsed < oldest * RESOLUTION) incidents.delete(category);
    return bins.get(last);
  }

  function window(requestedMs) {
    // Use only bins whose entire interval is inside the requested horizon. The
    // explicit observed coverage can be up to one bin shorter than that horizon.
    const from = Math.max(0, Math.ceil((elapsed - requestedMs) / RESOLUTION) * RESOLUTION);
    const result = { requestedMs, monitoredMs: Math.min(elapsed, requestedMs),
      coveredMs: elapsed - from, complete: elapsed - from === requestedMs,
      peakPending: 0, contention: { episodes: 0, totalMs: 0, maxMs: 0, active: waitingAt !== null },
      ...Object.fromEntries(COUNTERS.map(key => [key, 0])) };
    result.incidents = describeIncidents(from);
    const metrics = Object.fromEntries(METRICS.map(key => [key, metric()]));
    let carry = 0, first = true;
    for (const bin of bins.values()) {
      if (bin.index * RESOLUTION < from) continue;
      result.peakPending = Math.max(result.peakPending, bin.peakPending);
      result.contention.episodes += bin.episodes + Number(first && bin.leadingCarried && bin.leadingWaitMs > 0);
      result.contention.totalMs += bin.waitMs;
      const joined = (bin.leadingCarried ? carry : 0) + bin.leadingWaitMs;
      result.contention.maxMs = Math.max(result.contention.maxMs, bin.maxWaitMs, joined);
      const duration = Math.min(RESOLUTION, elapsed - bin.index * RESOLUTION);
      carry = bin.leadingWaitMs === duration && bin.trailingWaitMs === duration ? joined : bin.trailingWaitMs;
      first = false;
      for (const key of COUNTERS) result[key] += bin[key];
      for (const key of METRICS) {
        const target = metrics[key], source = bin[key];
        target.count += source.count; target.total += source.total; target.max = Math.max(target.max, source.max);
        for (let index = 0; index < EDGES.length; index++) target.histogram[index] += source.histogram[index];
      }
    }
    for (const key of METRICS) result[key] = describeMetric(metrics[key]);
    return result;
  }

  return {
    incident(value) {
      advance();
      if (!CATEGORIES.has(value?.category) || !CONTEXTS.has(value.context)
        || !REASONS.has(value.reason) || !OUTCOMES.has(value.outcome)) return null;
      const token = { category: value.category, at: previousWall, context: value.context,
        reason: value.reason, outcome: value.outcome, recoveredAt: null, elapsed };
      incidents.set(value.category, token);
      return token;
    },
    describeFailure(token, { context, outcome } = {}) {
      advance();
      if (!token || incidents.get(token.category) !== token) return;
      if (CONTEXTS.has(context)) token.context = context;
      if (OUTCOMES.has(outcome)) token.outcome = outcome;
    },
    recovered(token) {
      advance();
      if (!token || incidents.get(token.category) !== token || token.outcome !== 'retained-for-retry') return;
      token.outcome = 'original-update-saved'; token.recoveredAt = previousWall;
    },
    commandNotSent(context, reason) {
      if (!['heat-pump-command', 'switch-command', 'cover-command', 'garage-command'].includes(context)
        || !['recording-failed', 'recording-wait-expired'].includes(reason)) return;
      advance().commandsNotSent++;
      this.incident({ category: 'command-not-sent', context, reason, outcome: 'command-not-sent' });
    },
    queue(event) {
      const bin = advance();
      if (event.type === 'pending') { pending = event.pending; bin.peakPending = Math.max(bin.peakPending, pending); }
      else if (event.type === 'accepted') bin.acceptedJobs++;
      else if (event.type === 'rejected') bin.queueRejected++;
      else if (event.type === 'cancelled') bin.cancelledJobs++;
      else if (event.type === 'failed') bin.failedJobs++;
      else if (event.type === 'completed') {
        addMetric(bin.queueDelay, event.delayMs);
        addMetric(bin[event.priority === 'control' ? 'controlQueueDelay' : 'normalQueueDelay'], event.delayMs);
      } else if (event.type === 'waiting' && waitingAt === null) { waitingAt = elapsed; bin.episodes++; }
      else if (event.type === 'ready' && waitingAt !== null) { waitingAt = null; bin.trailingWaitMs = 0; }
    },
    failure(code) { if (code !== 'write-queue-full') advance().failedWrites++; },
    postCommitFailure() { advance().postCommitFailures++; },
    transaction(value) {
      const bin = advance(); bin.transactionAttempts++;
      if (value.committed) {
        bin.committedTransactions++;
        addMetric(bin.transactionDuration, value.totalMs); addMetric(bin.commitDuration, value.commitMs);
      }
    },
    status(queue = {}) {
      advance();
      return { version: 2, retentionMs: RETENTION, resolutionMs: RESOLUTION,
        percentileMethod: 'histogram-upper-bound', startedAt, elapsedMs: elapsed, checkedAt: previousWall, clockChanged,
        incidents: describeIncidents(0),
        current: { pending: queue.queued ?? queue.pending ?? 0, activeJobs: queue.activeJobs ?? 0,
          oldestPendingMs: queue.oldestPendingMs ?? null, waitingMs: waitingAt === null ? null : elapsed - waitingAt },
        windows: { day: window(DAY), week: window(RETENTION) } };
    },
  };
}
