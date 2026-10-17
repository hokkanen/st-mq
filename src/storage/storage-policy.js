// Execution and diagnostics share these values. They are runtime policy, not
// dashboard settings or a promise that a native storage call finishes on time.
export const STORAGE_QUEUE_POLICY = Object.freeze({
  limit: 2048, byteLimit: 8 * 1024 * 1024, controlBurst: 8, foregroundBurst: 32,
});
export const WAL_POLICY = Object.freeze({
  triggerFrames: 50, maxDirtyMs: 5000, pollMs: 250, fallbackPollMs: 1000,
});
export const STORAGE_TASK_KINDS = Object.freeze(['checkpoint', 'mirror', 'history', 'live-learning', 'learning-cache']);
export const storageTaskKind = value => STORAGE_TASK_KINDS.includes(value) ? value : 'other';

// Read once from the owning connection, never from a health request. A worker
// sends its own configuration; the parent's read connection cannot supply it.
export function storageConfiguration(db, { readOnly = false, managedCheckpoints = false } = {}) {
  const journalMode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const synchronous = ['off', 'normal', 'full', 'extra'][db.prepare('PRAGMA synchronous').get().synchronous] ?? 'unknown';
  const autoCheckpointFrames = db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;
  return { execution: readOnly ? 'read-only' : 'direct', journalMode, synchronous,
    checkpoint: { mode: readOnly ? 'not-owned' : journalMode !== 'wal' ? 'not-applicable'
      : managedCheckpoints ? 'managed' : 'automatic', autoCheckpointFrames } };
}
