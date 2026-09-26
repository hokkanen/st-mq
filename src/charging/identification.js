import { connectionEvidenceStart, bmwIdentityContextValid } from './vehicle.js';

const MINUTE = 60_000;
export const IDENTIFICATION_CHARGE_LIMIT_MS = MINUTE;
export const IDENTIFICATION_ENERGY_LIMIT_KWH = .15;
export const IDENTIFICATION_PAUSE_WAIT_MS = 90_000;
const LATE_EVIDENCE_MS = 15 * MINUTE;
const time = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const phases = ['waiting', 'charging', 'pausing', 'completed', 'inconclusive'];
const stateKeys = ['version', 'id', 'connectedAt', 'attempt', 'phase', 'action', 'startedAt', 'lastAt',
  'chargingStartedAt', 'chargeDeadlineAt', 'chargeEnergyKwh', 'chargeUsedKwh', 'chargePowerKw',
  'pauseUntil', 'candidate', 'pause', 'completedAt', 'reason'];
const candidateKeys = ['connectedAt', 'association', 'kind', 'readingId', 'measuredAt', 'receivedAt', 'physicalAt', 'capturedAt'];
const pauseKeys = ['connectedAt', 'requestedAt', 'confirmedAt', 'startAt', 'stoppedAt'];
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validCandidate = value => exactKeys(value, candidateKeys) && ['start', 'ongoing'].includes(value.kind)
  && (value.association === null || typeof value.association === 'string' && value.association.length > 0)
  && eventId(value.readingId) && ['connectedAt', 'measuredAt', 'receivedAt', 'physicalAt', 'capturedAt'].every(key => time(value[key]))
  && value.connectedAt <= value.capturedAt && value.measuredAt <= value.capturedAt
  && value.receivedAt <= value.capturedAt && value.physicalAt <= value.capturedAt;
const validPause = value => exactKeys(value, pauseKeys) && pauseKeys.every(key => time(value[key]))
  && value.requestedAt >= value.connectedAt && value.confirmedAt >= value.requestedAt
  && value.stoppedAt >= value.requestedAt && value.startAt > value.stoppedAt;

/** Missing state is a current empty session, not an older payload to translate. */
export function validateIdentificationState(state) {
  if (state == null) return;
  if (!exactKeys(state, stateKeys) || state.version !== 1 || !time(state.connectedAt)
    || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || !phases.includes(state.phase)
    || ![null, 'allow', 'pause'].includes(state.action) || !time(state.startedAt) || !time(state.lastAt)
    || state.startedAt < state.connectedAt || state.lastAt < state.startedAt
    || state.id !== `${state.connectedAt}:${state.attempt}:${state.startedAt}`
    || ['chargingStartedAt', 'chargeDeadlineAt', 'pauseUntil', 'completedAt'].some(key => state[key] !== null && !time(state[key]))
    || state.chargeEnergyKwh !== null && (!Number.isFinite(state.chargeEnergyKwh) || state.chargeEnergyKwh < 0)
    || !Number.isFinite(state.chargeUsedKwh) || state.chargeUsedKwh < 0
    || state.chargePowerKw !== null && (!Number.isFinite(state.chargePowerKw) || state.chargePowerKw < 0)
    || state.reason !== null && !['identified', 'manual-stop', 'charge-time-limit', 'charge-energy-limit', 'pause-timeout'].includes(state.reason)
    || state.candidate !== null && (!validCandidate(state.candidate) || state.candidate.connectedAt !== state.connectedAt
      || state.candidate.capturedAt < state.startedAt || state.candidate.capturedAt > state.lastAt || state.pauseUntil === null)
    || state.pause !== null && (!validPause(state.pause) || state.pause.connectedAt !== state.connectedAt
      || state.pause.startAt !== state.pauseUntil || state.candidate === null
      || state.pause.requestedAt < state.candidate.capturedAt || state.pause.confirmedAt > state.lastAt
      || state.pause.stoppedAt > state.lastAt)
    || state.chargingStartedAt !== null && (state.chargingStartedAt < state.startedAt
      || state.chargingStartedAt > state.lastAt
      || state.chargeDeadlineAt !== state.chargingStartedAt + IDENTIFICATION_CHARGE_LIMIT_MS)
    || state.chargingStartedAt === null && (state.chargeDeadlineAt !== null || state.chargeEnergyKwh !== null)
    || ['charging', 'pausing'].includes(state.phase) && state.chargingStartedAt === null
    || state.phase === 'pausing' && (state.candidate === null || state.pauseUntil === null)
    || ['completed', 'inconclusive'].includes(state.phase) && (state.completedAt === null || state.action !== null
      || state.completedAt < state.startedAt || state.completedAt > state.lastAt || state.reason === null)
    || state.phase === 'completed' && state.reason !== 'identified'
    || state.phase === 'inconclusive' && state.reason === 'identified'
    || ['waiting', 'charging', 'pausing'].includes(state.phase) && (state.completedAt !== null || state.reason !== null)
    || state.action === 'allow' && !['waiting', 'charging'].includes(state.phase)
    || state.action === 'pause' && state.phase !== 'pausing'
    || state.phase === 'waiting' && state.chargingStartedAt !== null)
    throw new Error('Unsupported saved charging identification; start a fresh development database');
}

const finish = (state, phase, reason, now) => ({ ...state, phase, reason, action: null, completedAt: now });

/** One attempt belongs to a physical connection. Only explicit manualRetry can
 * start another. Absolute persisted deadlines never renew after a restart,
 * telemetry outage, backwards wall-clock change, or an unsuccessful command.
 * The caller supplies control availability and physically verified pause proof;
 * this function never interprets an actuator acknowledgement as evidence. */
export function advanceIdentification(previous, { connectedAt, now, connected = true, identified = false,
  manualRetry = false, manualStop = false, available = true, charging = false, energyKwh = null, powerKw = null,
  candidate = null, pause = null } = {}) {
  validateIdentificationState(previous);
  if (!connected || !time(connectedAt) || !time(now) || connectedAt > now) return null;
  const sameConnection = previous?.connectedAt === connectedAt;
  let state = sameConnection ? structuredClone(previous) : null;
  if (state) now = Math.max(now, state.lastAt);
  if (!state || manualRetry) {
    const attempt = state ? state.attempt + 1 : 1;
    state = { version: 1, id: `${connectedAt}:${attempt}:${now}`, connectedAt, attempt,
      phase: 'waiting', action: null, startedAt: now, lastAt: now, chargingStartedAt: null,
      chargeDeadlineAt: null, chargeEnergyKwh: null, chargeUsedKwh: 0, chargePowerKw: null,
      pauseUntil: null, candidate: null, pause: null,
      completedAt: null, reason: null };
  }
  const previousAt = state.lastAt;
  state.lastAt = now;
  if (identified && !manualRetry) return state.phase === 'completed' ? state : finish(state, 'completed', 'identified', now);
  if (['completed', 'inconclusive'].includes(state.phase)) return state;
  if (manualStop) {
    if (state.phase !== 'waiting') return finish(state, 'inconclusive', 'manual-stop', now);
    state.action = null;
    return state;
  }
  if (state.phase === 'pausing' && validPause(pause) && pause.connectedAt === connectedAt
    && pause.startAt === state.pauseUntil && pause.requestedAt >= state.candidate.capturedAt
    && pause.confirmedAt <= now && pause.stoppedAt <= now && pause.stoppedAt < state.pauseUntil)
    state.pause = structuredClone(pause);
  if (state.phase === 'waiting' && charging && available) {
    state.phase = 'charging'; state.chargingStartedAt = now;
    state.chargeDeadlineAt = now + IDENTIFICATION_CHARGE_LIMIT_MS;
    state.chargeEnergyKwh = Number.isFinite(energyKwh) && energyKwh >= 0 ? energyKwh : null;
    state.chargePowerKw = Number.isFinite(powerKw) && powerKw >= 0 ? powerKw : null;
  } else if (['charging', 'pausing'].includes(state.phase)) {
    const currentPower = Number.isFinite(powerKw) && powerKw >= 0 ? powerKw : null;
    // Budget conservatively between readings; meter resets never give a test
    // another allowance, and missing meter energy still has a power/time bound.
    const chargeUntil = state.pause ? Math.min(now, state.pause.stoppedAt) : now;
    state.chargeUsedKwh += Math.max(state.chargePowerKw ?? 0, currentPower ?? 0)
      * Math.max(0, chargeUntil - previousAt) / 3_600_000;
    if (currentPower !== null) state.chargePowerKw = currentPower;
  }
  if (['charging', 'pausing'].includes(state.phase)) {
    if (state.chargeUsedKwh >= IDENTIFICATION_ENERGY_LIMIT_KWH
      || Number.isFinite(energyKwh) && state.chargeEnergyKwh !== null
        && energyKwh - state.chargeEnergyKwh >= IDENTIFICATION_ENERGY_LIMIT_KWH)
      return finish(state, 'inconclusive', 'charge-energy-limit', now);
    if ((state.phase === 'charging' || charging || !state.pause) && now >= state.chargeDeadlineAt)
      return finish(state, 'inconclusive', 'charge-time-limit', now);
  }
  if (state.phase === 'charging') {
    if (available && charging && validCandidate(candidate) && candidate.connectedAt === connectedAt
      && candidate.capturedAt >= state.startedAt && candidate.capturedAt <= now
      && now - candidate.capturedAt <= MINUTE && candidate.measuredAt < now) {
      state.candidate = structuredClone(candidate); state.phase = 'pausing';
      // Easee native expiry uses whole seconds. Shelly enforces the same
      // absolute deadline in the application, without a device-side timer.
      state.pauseUntil = Math.ceil((now + IDENTIFICATION_PAUSE_WAIT_MS) / 1000) * 1000;
    }
  }
  if (state.phase === 'pausing') {
    if (now >= state.pauseUntil) return finish(state, 'inconclusive', 'pause-timeout', now);
  }
  state.action = available ? state.phase === 'pausing' ? 'pause' : 'allow' : null;
  return state;
}

function departureAt(reading, lastDisconnectedAt) {
  return ['pluggedIn', 'atHome'].map(key => reading?.fields?.[key]?.negativeEvent?.measuredAt)
    .filter(time).reduce((latest, at) => Math.max(latest, at), time(lastDisconnectedAt) ? lastDisconnectedAt : -1);
}

/** A current live charging fact is also usable when startup did not observe its
 * original start. It is saved as a baseline, never manufactured into a start
 * edge. Identity still requires an independently observed response to our stop.
 * Retained delivery and unchanged old source timestamps cannot renew freshness. */
export function prepareActiveBmwCandidate(reading, { connectedAt, lastDisconnectedAt, chargingAt = [],
  physicalAt, now, consumedChargingId } = {}) {
  if (!bmwIdentityContextValid(reading, now) || reading.charging !== true || !time(connectedAt) || connectedAt > now
    || !time(physicalAt) || physicalAt > now || now - physicalAt > MINUTE) return null;
  const departure = departureAt(reading, lastDisconnectedAt);
  const boundary = connectionEvidenceStart(connectedAt, departure);
  const field = reading.fields?.charging;
  const live = (event, maxAge) => event?.retained === false && eventId(event.readingId)
    && event.readingId !== consumedChargingId && time(event.measuredAt) && time(event.receivedAt)
    && event.measuredAt > departure && event.measuredAt <= now && now - event.measuredAt <= maxAge
    && event.receivedAt >= boundary && event.receivedAt <= now && now - event.receivedAt <= MINUTE;
  const starts = (Array.isArray(chargingAt) ? chargingAt : [chargingAt])
    .filter(at => time(at) && at >= boundary && at > departure && at <= now);
  const edge = field?.positiveEvent;
  let baseline, kind;
  if (live(edge, MINUTE) && starts.some(at => Math.abs(at - edge.measuredAt) <= 30_000)) {
    baseline = edge; kind = 'start';
  } else if (live(field, 5 * MINUTE) && physicalAt >= boundary && physicalAt > departure) {
    baseline = field; kind = 'ongoing';
  } else return null;
  return { connectedAt, association: reading.association ?? null, kind, readingId: baseline.readingId,
    measuredAt: baseline.measuredAt, receivedAt: baseline.receivedAt, physicalAt, capturedAt: now };
}

/** Saved physical proof can accept a late report after temporary control ends.
 * Its source stop must still belong to that original bounded pause. Feed or
 * connection changes, departures, consumed observations, and retained stops
 * fence it out. A controller request/ack alone never supplies physical proof. */
export function matchActiveBmwPause(reading, { state, now, lastDisconnectedAt, consumedChargingId } = {}) {
  if (!state || !bmwIdentityContextValid(reading, now) || reading.charging !== false) return null;
  const { candidate, pause, connectedAt } = state;
  if (!validCandidate(candidate) || !validPause(pause) || candidate.connectedAt !== connectedAt
    || pause.connectedAt !== connectedAt || pause.startAt !== state.pauseUntil
    || candidate.association !== (reading.association ?? null) || candidate.readingId === consumedChargingId
    || candidate.capturedAt > pause.requestedAt || candidate.receivedAt > pause.requestedAt
    || candidate.measuredAt >= pause.requestedAt || candidate.physicalAt > pause.requestedAt
    || pause.requestedAt >= pause.stoppedAt || pause.confirmedAt > now || pause.stoppedAt > now
    || now - pause.stoppedAt > LATE_EVIDENCE_MS) return null;
  const departure = departureAt(reading, lastDisconnectedAt);
  if (candidate.measuredAt <= departure || candidate.physicalAt <= departure) return null;
  const stop = reading.fields?.charging?.negativeEvent;
  if (stop?.retained !== false || !eventId(stop.readingId) || stop.readingId === candidate.readingId
    || !time(stop.measuredAt) || !time(stop.receivedAt) || stop.measuredAt <= pause.requestedAt
    || stop.measuredAt > now || stop.measuredAt > state.pauseUntil || stop.receivedAt > now
    || stop.receivedAt < candidate.receivedAt || stop.receivedAt < pause.requestedAt
    || now - stop.measuredAt > LATE_EVIDENCE_MS || now - stop.receivedAt > LATE_EVIDENCE_MS
    || Math.abs(stop.measuredAt - pause.stoppedAt) > 30_000) return null;
  return { chargingReadingId: candidate.readingId, stopReadingId: stop.readingId, confirmedAt: pause.confirmedAt };
}
