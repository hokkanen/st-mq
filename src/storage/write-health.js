// Runtime evidence must remain readable when the database cannot accept writes.
// Never retain SQLite messages: they can contain private paths or input values.
export function storageFailureCode(error) {
  if (error?.code === 'STORAGE_QUEUE_FULL') return 'write-queue-full';
  if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') return 'disk-full';
  const code = Number.isInteger(error?.errcode) ? error.errcode & 0xff : null;
  return ({ 5: 'database-busy', 6: 'database-busy', 8: 'database-read-only',
    10: 'database-io', 11: 'database-corrupt', 13: 'disk-full', 14: 'database-unavailable',
    26: 'database-corrupt' })[code] ?? null;
}

export function createWriteHealth(clock = Date.now, queueStatus = null) {
  const seen = new WeakSet();
  const state = { startedAt: clock(), lastWriteAt: null, lastFailureAt: null,
    errorCode: null, failures: 0, failing: false };
  return {
    success() { state.lastWriteAt = clock(); state.failing = false; },
    failure(error) {
      const code = storageFailureCode(error);
      if (!code) return;
      if (error && typeof error === 'object') {
        if (seen.has(error)) return;
        seen.add(error);
      }
      state.lastFailureAt = clock(); state.errorCode = code;
      state.failures++; state.failing = true;
    },
    status() { return { ...state, ...(queueStatus ? { queue: queueStatus() } : {}) }; },
  };
}
