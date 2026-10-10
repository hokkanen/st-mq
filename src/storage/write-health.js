// Runtime evidence must remain readable when the database cannot accept writes.
// Never retain SQLite messages: they can contain private paths or input values.
import { createWriteHealthHistory } from './write-health-history.js';

export function storageFailureCode(error) {
  if (error?.code === 'STORAGE_QUEUE_FULL') return 'write-queue-full';
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return 'disk-full';
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return ({ 5: 'database-busy', 6: 'database-busy', 8: 'database-read-only',
    10: 'database-io', 11: 'database-corrupt', 13: 'disk-full', 14: 'database-unavailable',
    26: 'database-corrupt' })[code] ?? null;
}

export function createWriteHealth(clock = Date.now, queueStatus = null, { monotonic = () => performance.now() } = {}) {
  const seen = new WeakSet();
  const followupsSeen = new WeakSet();
  const history = createWriteHealthHistory({ clock, monotonic });
  function postCommitFailure(error) {
    if (error && typeof error === 'object') {
      if (followupsSeen.has(error)) return;
      followupsSeen.add(error);
    }
    history.postCommitFailure();
  }
  const state = { startedAt: clock(), lastWriteAt: null, lastFailureAt: null,
    errorCode: null, failures: 0, failing: false };
  const recent = [], limit = 128;
  let transactionCount = 0, committedCount = 0, lastTransactionAt = null;
  const timings = () => ({ count: transactionCount, committed: committedCount, lastAt: lastTransactionAt,
    sampleCount: recent.length, sampleLimit: limit,
    ...Object.fromEntries(['beginMs', 'bodyMs', 'commitMs', 'totalMs'].map(key => {
      const values = recent.map(row => row[key]).sort((a, b) => a - b);
      return [key, { last: recent.at(-1)?.[key] ?? null, max: values.at(-1) ?? null,
        p99: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.99))] : null }];
    })) });
  return {
    success() { state.lastWriteAt = clock(); state.failing = false; },
    failure(error) {
      if (error?.committed === true) { postCommitFailure(error); return; }
      const code = storageFailureCode(error);
      if (!code) return;
      if (error && typeof error === 'object') {
        if (seen.has(error)) return;
        seen.add(error);
      }
      state.lastFailureAt = clock(); state.errorCode = code;
      state.failures++; state.failing = true;
      history.failure(code);
    },
    transaction(value) {
      if (typeof value?.committed !== 'boolean'
        || ['beginMs', 'bodyMs', 'commitMs', 'totalMs'].some(key => !Number.isFinite(value[key]) || value[key] < 0)) return;
      transactionCount++; committedCount += Number(value.committed); lastTransactionAt = clock();
      recent.push({ ...value }); if (recent.length > limit) recent.shift();
      history.transaction(value);
    },
    queue(event) { history.queue(event); },
    postCommitFailure,
    status() {
      const queue = queueStatus?.();
      return { ...state, transactions: timings(), ...(queue ? { queue } : {}), history: history.status(queue) };
    },
  };
}
