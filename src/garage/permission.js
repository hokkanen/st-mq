// One polling schedule; freshness and permission deadlines share the original
// temperature evidence clock, never the arrival of an unrelated heartbeat.
export const GARAGE_TEMPERATURE_POLL_MS = 30_000;
export const GARAGE_TEMPERATURE_MAX_AGE_MS = 4 * GARAGE_TEMPERATURE_POLL_MS;
export const GARAGE_REVALIDATE_MS = 2 * GARAGE_TEMPERATURE_POLL_MS;
export const GARAGE_MAX_PERMISSION_MS = GARAGE_TEMPERATURE_MAX_AGE_MS;
const finite = Number.isFinite;

/** Bound a new authorization by both temperature evidence and thermal reserve.
 * A maximum lease is a ceiling, not a mandatory cooling allowance. */
export function garagePausePermission({ now, observation, protection, heatingDelayMs, maxLeaseMs = GARAGE_MAX_PERMISSION_MS } = {}) {
  const times = ['rear', 'front'].map(location => observation?.[`${location}At`]);
  const evidenceAt = times.every(finite) ? Math.min(...times) : null;
  if (!finite(now) || !finite(evidenceAt) || times.some(at => at > now) || now - evidenceAt >= GARAGE_TEMPERATURE_MAX_AGE_MS
    || ['rear', 'front'].some(location => observation?.[`${location}Held`] === true)
    || protection?.requiredFresh !== true || protection?.safeToPause !== true)
    return { allowed: false, reason: 'fresh-temperature-reserve-required', evidenceAt, expiresAt: null };
  if (!finite(heatingDelayMs) || heatingDelayMs < 0 || !finite(maxLeaseMs) || maxLeaseMs <= 0)
    return { allowed: false, reason: 'heating-response-bound-unavailable', evidenceAt, expiresAt: null };
  // Integer device deadlines must precede exhaustion, rather than land exactly
  // on the boundary that the next safety assessment correctly rejects.
  const thermalDeadline = finite(protection.interventionAt) ? Math.ceil(protection.interventionAt - heatingDelayMs) - 1 : Infinity;
  const expiresAt = Math.floor(Math.min(evidenceAt + GARAGE_MAX_PERMISSION_MS, now + maxLeaseMs, thermalDeadline));
  // A new lease must cover the next scheduled revalidation. Safety ticks can
  // release it sooner; they never manufacture a renewal from cached reports.
  return { allowed: expiresAt > now + GARAGE_REVALIDATE_MS,
    reason: expiresAt > now + GARAGE_REVALIDATE_MS ? null : 'restoration-margin-exhausted', evidenceAt, expiresAt };
}
