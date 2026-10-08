/** Small source-clock leads are admission delays, never permission to use future
 * evidence. This bound is shared by device adapters; it is not a command lease,
 * historical as-of allowance, peer-authentication window or browser tolerance. */
export const MAX_SOURCE_AHEAD_MS = 1000;
export const evidenceTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

export function classifySourceTime({ sourceTime, receivedAt, now, maxAgeMs = Infinity }) {
  const result = (status, reason = null, delayMs = 0) => ({ status, reason, delayMs });
  if (![sourceTime, receivedAt, now].every(evidenceTime)
    || !(maxAgeMs === Infinity || Number.isFinite(maxAgeMs) && maxAgeMs >= 0))
    return result('invalid', 'invalid-time');
  if (receivedAt > now) return result('invalid', 'future-receipt-time');
  if (sourceTime - receivedAt > MAX_SOURCE_AHEAD_MS) return result('invalid', 'future-source-time');
  // Waiting cannot extend the lifetime originally available at receipt.
  if (now - Math.min(sourceTime, receivedAt) > maxAgeMs) return result('stale', 'source-expired');
  if (sourceTime > now) return result('pending', 'source-clock-pending', sourceTime - now);
  return result('ready');
}

/** Persisted native evidence must explicitly prove delayed admission when its
 * source clock led the original receipt. Missing metadata is only the ordinary
 * current representation, never an alias for an older permissive format. */
export function validateAdmittedSourceTime({ sourceTime, receivedAt, admittedAt, now = Infinity }) {
  if (![sourceTime, receivedAt].every(evidenceTime) || !(now === Infinity || evidenceTime(now))
    || receivedAt > now || sourceTime > now || sourceTime - receivedAt > MAX_SOURCE_AHEAD_MS) return false;
  if (admittedAt === undefined) return sourceTime <= receivedAt;
  return evidenceTime(admittedAt) && admittedAt >= Math.max(sourceTime, receivedAt) && admittedAt <= now;
}

/** Stamp only a genuinely deferred report, after its source time arrives. An
 * ordinary-clock report can also wait behind an ordered pending transition.
 * The exact original clocks prevent borrowing proof from another sample. */
export function sourceTimeAdmission({ sourceTime, receivedAt, now, deferred = false }) {
  if (sourceTime <= receivedAt && !deferred || classifySourceTime({ sourceTime, receivedAt, now }).status !== 'ready') return undefined;
  return { sourceTime, receivedAt, admittedAt: now };
}

export function observationTimeAdmitted(observation, now = Infinity) {
  if (!observation) return false;
  const { sourceTime, receivedAt } = observation, proof = observation.raw?.timeAdmission;
  if (proof !== undefined && (!proof || typeof proof !== 'object' || Array.isArray(proof)
    || Object.keys(proof).sort().join(',') !== 'admittedAt,receivedAt,sourceTime'
    || proof.sourceTime !== sourceTime || proof.receivedAt !== receivedAt)) return false;
  return validateAdmittedSourceTime({ sourceTime, receivedAt, admittedAt: proof?.admittedAt, now });
}

/** The first instant this evidence may participate in decisions/coverage.
 * Source and receipt clocks remain available separately and are never clamped. */
export function observationAvailableAt(observation) {
  return observationTimeAdmitted(observation)
    ? Math.max(observation.sourceTime, observation.receivedAt, observation.raw?.timeAdmission?.admittedAt ?? 0) : null;
}
