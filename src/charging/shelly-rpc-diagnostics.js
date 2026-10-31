// Passive transport evidence. Expired request IDs remain in RAM only; neither
// late replies nor these statistics can complete a command or admit readback.
export const SHELLY_RPC_LATE_WINDOW_MS = 120_000;
export const SHELLY_RPC_LATE_LIMIT = 64;
const LIMITS = [100, 500, 1000, 2500, 5000];
const elapsed = (start, end) => Number.isFinite(start) && Number.isFinite(end) && end >= start
  ? Math.round((end - start) * 1000) / 1000 : null;
const empty = () => ({ replies: 0, successes: 0, errors: 0, timeouts: 0, lateReplies: 0,
  timedSamples: 0, minMs: null, maxMs: null, totalMs: 0, buckets: Array(LIMITS.length + 1).fill(0) });

// A normal or late transport reply needs one supported outcome. A malformed
// envelope is neither acknowledgement nor rejection and cannot end a deadline.
export function shellyRpcReplyOutcome(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)
    || Object.hasOwn(frame, 'result') === Object.hasOwn(frame, 'error')) return null;
  if (Object.hasOwn(frame, 'result')) return 'success';
  return frame.error && typeof frame.error === 'object' && !Array.isArray(frame.error)
    && Number.isSafeInteger(frame.error.code) ? 'error' : null;
}

export function createShellyRpcDiagnostics({ clock, monotonicClock, record }) {
  const startedAt = clock(), expired = new Map(), series = new Map();
  let expiredReferences = 0, evictedReferences = 0, seriesOverflowed = false;
  const prune = now => {
    for (const [id, trace] of expired) {
      const age = elapsed(trace.expiredMonotonic, now);
      if (age !== null && age >= SHELLY_RPC_LATE_WINDOW_MS) {
        expired.delete(id); expiredReferences++;
      }
    }
  };
  const stats = trace => {
    const key = JSON.stringify([trace.method, trace.role, trace.context.firmware ?? null]);
    if (!series.has(key)) {
      // The adapter supplies its fixed method/role allowlists. A hard cap also
      // protects diagnostics if future callers introduce additional series.
      if (series.size >= 64) { seriesOverflowed = true; return null; }
      series.set(key, { method: trace.method, role: trace.role, firmware: trace.context.firmware ?? null, ...empty() });
    }
    return series.get(key);
  };
  const publish = (code, trace, extra) => {
    try {
      record(code, { method: trace.method, role: trace.role, mutation: trace.mutation,
        requestedAt: trace.requestedAt, replyBudgetMs: trace.replyBudgetMs,
        ...trace.context, ...extra, statisticsStartedAt: startedAt, normalReplies: structuredClone(stats(trace)),
        tracking: { windowMs: SHELLY_RPC_LATE_WINDOW_MS, limit: SHELLY_RPC_LATE_LIMIT, expiredReferences, evictedReferences, seriesOverflowed } });
    } catch { /* Recording cannot change an RPC's result or deadline. */ }
  };
  return {
    request({ id, method, role, mutation, requestedAt, started, replyBudgetMs, context }) {
      prune(monotonicClock());
      return { id, method, role, mutation, requestedAt, started, replyBudgetMs,
        context: structuredClone(context), finished: false, expired: false };
    },
    timeout(trace, at, now) {
      if (trace.finished) return;
      trace.finished = trace.expired = true; trace.timedOutAt = at; trace.expiredMonotonic = now;
      prune(now);
      if (expired.size >= SHELLY_RPC_LATE_LIMIT) { expired.delete(expired.keys().next().value); evictedReferences++; }
      expired.set(trace.id, trace);
      const row = stats(trace); if (row) row.timeouts++;
      const elapsedMs = elapsed(trace.started, now);
      publish('shelly-rpc-timeout', trace, { at, timedOutAt: at, elapsedMs,
        timerOverrunMs: elapsedMs === null ? null : Math.max(0, elapsedMs - trace.replyBudgetMs) });
    },
    reply(trace, failed, now) {
      if (trace.finished) return;
      trace.finished = true;
      const row = stats(trace); if (!row) return;
      row.replies++; row[failed ? 'errors' : 'successes']++;
      const ms = elapsed(trace.started, now);
      if (ms !== null) {
        row.timedSamples++; row.minMs = row.minMs === null ? ms : Math.min(row.minMs, ms);
        row.maxMs = row.maxMs === null ? ms : Math.max(row.maxMs, ms); row.totalMs += ms;
        const bucket = LIMITS.findIndex(limit => ms <= limit);
        row.buckets[bucket < 0 ? LIMITS.length : bucket]++;
      }
    },
    late(id, frame, at, now, scope) {
      prune(now);
      const trace = expired.get(id);
      const outcome = shellyRpcReplyOutcome(frame);
      if (!trace || outcome === null) return false;
      expired.delete(id);
      const row = stats(trace); if (row) row.lateReplies++;
      publish('shelly-rpc-late-reply', trace, { at, receivedAt: at, timedOutAt: trace.timedOutAt,
        elapsedMs: elapsed(trace.started, now), afterTimeoutMs: elapsed(trace.expiredMonotonic, now),
        outcome,
        errorCode: Number.isSafeInteger(frame.error?.code) ? frame.error.code : null,
        sameConnection: scope.generation === trace.context.generation,
        sameBoot: scope.bootEpoch === null || trace.context.bootEpoch === null ? null : scope.bootEpoch === trace.context.bootEpoch,
        sameSession: scope.reportId === null || trace.context.reportId === null ? null : scope.reportId === trace.context.reportId });
      return true;
    },
    snapshot() {
      prune(monotonicClock());
      return { startedAt, bucketUpperBoundsMs: [...LIMITS, null], series: structuredClone([...series.values()]), seriesLimit: 64, seriesOverflowed,
        lateWindowMs: SHELLY_RPC_LATE_WINDOW_MS, lateLimit: SHELLY_RPC_LATE_LIMIT,
        retainedReferences: expired.size, expiredReferences, evictedReferences };
    },
    close() { expired.clear(); },
  };
}
