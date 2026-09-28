import { GARAGE_TEMPERATURE_MAX_AGE_MS } from './permission.js';

const signals = new Set(['garage_temperature', 'garage_temperature_2']);
const transportFailures = new Set(['device-offline', 'mqtt-disconnected']);
const transportQuality = new Set([...transportFailures, 'missing', 'unavailable']);
const goodQuality = new Set(['good', 'simulated', 'converted_fahrenheit']);
const finite = Number.isFinite;
const identity = observation => JSON.stringify([observation.source, observation.device,
  observation.raw?.temperatureRouteSignature ?? null]);
const valid = (observation, now) => finite(observation.value) && observation.value >= -60 && observation.value <= 70
  && ['degC', '°C'].includes(observation.unit) && finite(observation.sourceTime) && observation.sourceTime >= 0
  && finite(observation.receivedAt) && observation.sourceTime <= observation.receivedAt && observation.receivedAt <= now
  && observation.raw?.usableForControl !== false && observation.raw?.timeBasis !== 'availability-transition'
  && (observation.quality ?? []).every(flag => goodQuality.has(flag));
const transportOnly = observation => observation.value === null && observation.raw?.timeBasis === 'availability-transition'
  && (observation.quality ?? []).some(flag => transportFailures.has(flag))
  && observation.quality.every(flag => transportQuality.has(flag));

/** Live-process control evidence only. Nothing here repairs latest observations,
 * report coverage or learning history, and this cache must never be persisted. */
export function rememberGarageTemperature(cache, observation, now) {
  if (!signals.has(observation?.signal) || !finite(now) || observation.raw?.auditOnly
    || observation.raw?.retained || observation.quality?.includes('retained')) return;
  const previous = cache[observation.signal];
  const receivedAt = finite(observation.receivedAt) ? Math.min(now, observation.receivedAt) : now;
  if (previous && receivedAt < previous.attemptAt) return;
  const route = identity(observation);
  const sameSource = !previous || previous.identity === route;
  // Repeated runtime reads of latest must not undo an outage or invalid report.
  // Likewise, a delayed invalid packet must not invalidate a newer measurement.
  if (sameSource && previous?.observation && finite(observation.sourceTime)
    && observation.sourceTime < previous.observation.sourceTime) return;
  const state = previous ?? { observation: null, identity: route, attemptAt: -Infinity,
    sourceFloor: -Infinity, recoveryAt: -Infinity, held: false, blocked: false, reason: 'temperature-unavailable' };
  if (transportOnly(observation) && sameSource && finite(observation.receivedAt) && observation.receivedAt <= now
    && (observation.sourceTime === null || finite(observation.sourceTime) && observation.sourceTime <= observation.receivedAt)) {
    state.attemptAt = receivedAt;
    state.recoveryAt = Math.max(state.recoveryAt, receivedAt);
    state.held = Boolean(state.observation) && !state.blocked;
    if (!state.blocked) state.reason = observation.quality.find(flag => transportFailures.has(flag));
    cache[observation.signal] = state;
    return;
  }
  if (valid(observation, now) && observation.sourceTime > state.sourceFloor
    && observation.sourceTime >= state.recoveryAt
    && (!state.observation || observation.sourceTime > state.observation.sourceTime)) {
    cache[observation.signal] = { observation, identity: route, attemptAt: receivedAt,
      sourceFloor: state.sourceFloor, recoveryAt: state.recoveryAt, held: false, blocked: false, reason: null };
    return;
  }
  if (valid(observation, now) && sameSource) return;
  state.attemptAt = receivedAt;
  state.identity = route;
  state.sourceFloor = Math.max(state.sourceFloor, state.observation?.sourceTime ?? -Infinity);
  state.recoveryAt = Math.max(state.recoveryAt, receivedAt);
  state.held = false;
  state.blocked = true;
  state.reason = sameSource ? 'invalid-temperature' : 'temperature-source-changed';
  cache[observation.signal] = state;
}

/** The only grace is the unused part of the original measurement's 120 seconds.
 * notBefore fences an explicit sensor change, including after its correction is
 * reverted: observing a new measurement is still required for live authority. */
export function garageTemperatureEvidence(cache, signal, now, { notBefore = -Infinity } = {}) {
  const state = cache?.[signal], observation = state?.observation ?? null;
  if (state && finite(notBefore) && observation && observation.sourceTime < notBefore) {
    state.blocked = true;
    state.held = false;
    state.reason = 'sensor-change';
    state.sourceFloor = Math.max(state.sourceFloor, observation.sourceTime);
    state.recoveryAt = Math.max(state.recoveryAt, notBefore);
  }
  const expiresAt = observation ? observation.sourceTime + GARAGE_TEMPERATURE_MAX_AGE_MS : null;
  const usable = Boolean(observation && !state.blocked && finite(now)
    && observation.sourceTime <= now && now < expiresAt);
  return { observation, usable, held: usable && state.held, expiresAt,
    reason: !observation ? 'temperature-unavailable' : state.blocked ? state.reason
      : !usable ? 'temperature-expired' : state.reason };
}
