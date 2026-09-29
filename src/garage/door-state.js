const finite = Number.isFinite;
export const GARAGE_DOOR_SIGNALS = Object.freeze(['garage_door1_open', 'garage_door2_open']);
export const isGarageDoorSignal = signal => GARAGE_DOOR_SIGNALS.includes(signal);
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
