const finite = Number.isFinite;
export const GARAGE_DOOR_SIGNALS = Object.freeze(['garage_door1_open', 'garage_door2_open']);
export const isGarageDoorSignal = signal => GARAGE_DOOR_SIGNALS.includes(signal);
export const GARAGE_COLD_DOOR_LIMIT_C = 2;

/** Admission only. An opening during OFF invokes normal pipe reassessment;
 * it does not impose an unrelated air-temperature cutoff or reset reserve. */
export function garagePauseStartReason(observation) {
  if (!finite(observation?.outdoorC)) return 'outdoor-temperature-unavailable';
  const doors = Object.values(observation?.doors ?? {}).filter(door => door.required === true);
  if (doors.some(door => typeof door.open !== 'boolean')
    || observation?.doorEvidenceRequired === true && typeof observation.doorFront !== 'boolean')
    return 'garage-door-state-unknown';
  if (observation.outdoorC < GARAGE_COLD_DOOR_LIMIT_C
    && (doors.some(door => door.open) || observation?.doorFront === true)) return 'garage-door-open-below-2c';
  return null;
}

/** A source state and its live transport confirmation use different clocks.
 * Confirmation may restore an old contact report without inventing a new one. */
export function confirmedGarageDoor(observation, now) {
  return isGarageDoorSignal(observation?.signal) && observation.source === 'mqtt-equipment'
    && [0, 1].includes(observation.value) && observation.raw?.availabilityConfirmed === true
    && !observation.raw?.retained && !observation.raw?.auditOnly
    && finite(observation.sourceTime) && finite(observation.receivedAt) && finite(observation.raw.confirmedAt)
    && observation.sourceTime <= observation.receivedAt && observation.receivedAt <= observation.raw.confirmedAt
    && observation.raw.confirmedAt <= now && (observation.quality ?? []).every(flag => flag === 'good');
}

/** Bounded live continuity, committed later with each resolved learning sample.
 * An outage, opening or process restart ends the known-closed span. Recovery
 * starts at confirmation, even when the source's old closed timestamp survives. */
export function garageDoorContinuity(previous, observation, now) {
  const confirmed = confirmedGarageDoor(observation, now);
  const sameSource = previous?.source === observation.source && previous?.device === observation.device;
  const at = confirmed ? observation.raw.confirmedAt : observation.receivedAt;
  return { source: observation.source, device: observation.device, confirmed,
    confirmedAt: confirmed ? at : null,
    availableSince: confirmed ? sameSource && previous.confirmed ? previous.availableSince : at : null,
    closedSince: confirmed && observation.value === 0
      ? sameSource && previous.confirmed && finite(previous.closedSince) ? previous.closedSince : at : null };
}

/** Optional historical/imported door inputs keep their original interpretation.
 * Configured event feeds need uninterrupted closed evidence across the interval. */
export function garageDoorIntervalUnknown(current, previous, from = previous?.rearAt ?? previous?.at) {
  if (current?.doorEvidenceRequired !== true && previous?.doorEvidenceRequired !== true) return false;
  return current?.doorEvidenceRequired !== true || previous?.doorEvidenceRequired !== true
    || current.doorFront !== false || previous.doorFront !== false
    || !finite(from) || !finite(current.doorClosedSince) || current.doorClosedSince > from;
}
