// Test-only completion and synthetic performance budgets. These must never be
// used by application control, freshness, lock or equipment deadlines.
export function offlineTestProfile(name = process.env.STMQ_TEST_PROFILE ?? 'standard') {
  if (!['standard', 'ha-sd'].includes(name)) throw new Error('Unknown offline test profile; use standard or ha-sd.');
  return { name, concurrency: name === 'ha-sd' ? 2 : 4,
    caseTimeoutMs: name === 'ha-sd' ? 180_000 : 60_000,
    extendedCaseTimeoutMs: name === 'ha-sd' ? 900_000 : 180_000 };
}

// A single SD-card/internal storage stall may take several seconds. Keep exact
// correctness, bounded work, overlap and queue-order assertions independent of
// this wall-clock regression guard; report the original observed timings.
export function testLatencyLimit(standardMs, profile) {
  return offlineTestProfile(profile).name === 'ha-sd' ? Math.max(30_000, standardMs * 4) : standardMs;
}

export function testCompletionLimit(standardMs, profile) {
  return offlineTestProfile(profile).name === 'ha-sd' ? Math.max(30_000, standardMs * 5) : standardMs;
}
