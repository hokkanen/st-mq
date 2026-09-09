const instant = value => Number.isSafeInteger(value) && value >= 0;
const duration = value => Number.isFinite(value) && value > 0;
const fresh = (at, now, maximum) => instant(at) && at <= now && now - at <= maximum;

function confirmedTelemetry(snapshot, now, maximum) {
  return snapshot.telemetryConfirmed === true
    && fresh(snapshot.telemetryAt, now, maximum)
    && snapshot.sourceTime <= snapshot.telemetryAt
    && snapshot.telemetryAt <= snapshot.receivedAt;
}

/** Compare the same supported held power accepted by electricity acquisition.
 * HTTP receipts alone cannot renew stale power; telemetryConfirmed must come
 * from the acquisition's device-telemetry validation, not a cached online flag.
 * This helper neither mutates measurement timestamps nor retains any state. */
export function comparableElectricitySnapshot(snapshot, now, {
  maxAgeMs = 60_000, maxTelemetryAgeMs = 17 * 60_000,
} = {}) {
  if (!instant(now) || !duration(maxAgeMs) || !duration(maxTelemetryAgeMs)
    || !snapshot || !Number.isFinite(snapshot.powerKw) || snapshot.powerKw < 0
    || snapshot.connected === false || !instant(snapshot.sourceTime)
    || snapshot.sourceTime > now || !fresh(snapshot.receivedAt, now, maxAgeMs)
    || snapshot.sourceTime > snapshot.receivedAt) return false;
  return fresh(snapshot.sourceTime, now, maxAgeMs)
    || confirmedTelemetry(snapshot, now, maxTelemetryAgeMs);
}

/** A new power measurement must follow the Tesla ramp's normal settling time.
 * Unchanged device-confirmed power needs a later successful poll after a longer
 * grace period, so a pre-ramp reading does not immediately imply impossibility.
 * Poll receipt permits comparison; it never becomes the source measurement time. */
export function settledElectricitySnapshot(snapshot, now, changedAt, {
  settleMs = 5_000, heldSettleMs = 20_000,
  maxAgeMs = 60_000, maxTelemetryAgeMs = 17 * 60_000,
} = {}) {
  if (!instant(changedAt) || changedAt > now || !duration(settleMs) || !duration(heldSettleMs)
    || !comparableElectricitySnapshot(snapshot, now, { maxAgeMs, maxTelemetryAgeMs })) return false;
  if (snapshot.sourceTime >= changedAt + settleMs) return true;
  return confirmedTelemetry(snapshot, now, maxTelemetryAgeMs)
    && snapshot.receivedAt >= changedAt + Math.max(settleMs, heldSettleMs);
}
