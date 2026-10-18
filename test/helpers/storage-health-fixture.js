// Synthetic current-contract storage evidence shared by DOM and browser checks.
export function storageHealthFixture(at) {
  return { version: 1, scope: 'local-store', writer: { state: 'ready' }, transactionPhase: null,
    configuration: { execution: 'worker', journalMode: 'wal', synchronous: 'full',
      checkpoint: { mode: 'queued-passive', autoCheckpointFrames: 0, triggerFrames: 1000,
        maxDirtyMs: 5000, pollMs: 250, fallbackPollMs: null } },
    queue: { pending: 0, queued: 0, activeJobs: 0, bytes: 0, waitingSince: null, oldestPendingMs: null, active: null,
      policy: { limit: 2048, byteLimit: 8388608, controlBurst: 8, foregroundBurst: 32, idleKinds: ['chart-cache'] },
      lanes: Object.fromEntries(['control', 'normal', 'background'].map(key => [key, { queued: 0, running: 0, oldestPendingMs: null }])) },
    checkpoint: { state: 'idle', frames: { at, logFrames: 82, copiedFrames: 70, remainingFrames: 12 },
      lastRun: { at, elapsedMs: 45 }, lastFailureAt: null } };
}
