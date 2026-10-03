import { connectionEvidenceStart, bmwIdentityContextValid, bmwChargingEvents, bmwConsumedChargingAt } from './vehicle.js';

const MINUTE = 60_000;
export const IDENTIFICATION_CHARGE_LIMIT_MS = 5 * MINUTE;
export const IDENTIFICATION_ENERGY_LIMIT_KWH = .15;
export const IDENTIFICATION_PAUSE_WAIT_MS = 90_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const eventId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const phases = ['waiting', 'charging', 'pausing', 'observing', 'completed', 'inconclusive'];
const stateKeys = ['version', 'id', 'connectedAt', 'attempt', 'phase', 'action', 'startedAt', 'lastAt',
  'chargingStartedAt', 'chargeDeadlineAt', 'chargeEnergyKwh', 'chargeUsedKwh', 'chargePowerKw',
  'pauseUntil', 'candidate', 'pause', 'completedAt', 'reason'];
const candidateKeys = ['connectedAt', 'association', 'kind', 'readingId', 'measuredAt', 'receivedAt', 'physicalAt', 'capturedAt'];
const pauseKeys = ['connectedAt', 'requestedAt', 'confirmedAt', 'startAt', 'stoppedAt'];
const probeKeys = ['startedAt', 'deadlineAt', 'returnStartAt', 'endedAt'];
const reasons = ['identified', 'manual-stop', 'interrupted', 'pause-timeout',
  'awaiting-evidence', 'probe-energy-limit', 'probe-time-limit', 'telemetry-lost'];
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validCandidate = value => exactKeys(value, candidateKeys) && ['start', 'ongoing'].includes(value.kind)
  && (value.association === null || typeof value.association === 'string' && value.association.length > 0)
  && eventId(value.readingId) && ['connectedAt', 'measuredAt', 'receivedAt', 'physicalAt', 'capturedAt'].every(key => time(value[key]))
  && value.connectedAt <= value.capturedAt && value.measuredAt <= value.capturedAt
  && value.receivedAt <= value.capturedAt && value.physicalAt <= value.capturedAt;
const validPause = value => exactKeys(value, pauseKeys) && pauseKeys.every(key => time(value[key]))
  && value.requestedAt >= value.connectedAt && value.confirmedAt >= value.requestedAt
  && value.stoppedAt >= value.requestedAt && value.startAt > value.stoppedAt;
const validProbe = value => exactKeys(value, probeKeys) && ['startedAt', 'deadlineAt', 'returnStartAt'].every(key => time(value[key]))
  && value.deadlineAt > value.startedAt
  && value.deadlineAt <= value.startedAt + IDENTIFICATION_CHARGE_LIMIT_MS && value.returnStartAt > value.deadlineAt
  && (value.endedAt === null || time(value.endedAt) && value.endedAt >= value.startedAt);

/** Probe state is optional until this connection first needs extra charging.
 * Absence grants no probe permission or renewed budget. */
export function validateIdentificationState(state) {
  if (state == null) return;
  const keys = Object.hasOwn(state, 'probe') ? [...stateKeys, 'probe'] : stateKeys;
  if (!exactKeys(state, keys) || state.version !== 1 || !time(state.connectedAt)
    || !Number.isSafeInteger(state.attempt) || state.attempt < 1 || !phases.includes(state.phase)
    || ![null, 'allow', 'pause'].includes(state.action) || !time(state.startedAt) || !time(state.lastAt)
    || state.startedAt < state.connectedAt || state.lastAt < state.startedAt
    || state.id !== `${state.connectedAt}:${state.attempt}:${state.startedAt}`
    || ['chargingStartedAt', 'chargeDeadlineAt', 'pauseUntil', 'completedAt'].some(key => state[key] !== null && !time(state[key]))
    || state.chargeEnergyKwh !== null && (!Number.isFinite(state.chargeEnergyKwh) || state.chargeEnergyKwh < 0)
    || !Number.isFinite(state.chargeUsedKwh) || state.chargeUsedKwh < 0
    || state.chargePowerKw !== null && (!Number.isFinite(state.chargePowerKw) || state.chargePowerKw < 0)
    || state.reason !== null && !reasons.includes(state.reason)
    || state.probe != null && (!validProbe(state.probe) || state.probe.startedAt < state.startedAt
      || state.probe.startedAt > state.lastAt || state.probe.endedAt > state.lastAt)
    || state.candidate !== null && (!validCandidate(state.candidate) || state.candidate.connectedAt !== state.connectedAt
      || state.candidate.capturedAt < state.startedAt || state.candidate.capturedAt > state.lastAt || state.pauseUntil === null)
    || state.pause !== null && (!validPause(state.pause) || state.pause.connectedAt !== state.connectedAt
      || ![state.pauseUntil, state.probe?.returnStartAt].includes(state.pause.startAt)
      || state.pause.requestedAt < (state.candidate?.capturedAt ?? state.startedAt)
      || state.pause.confirmedAt > state.lastAt || state.pause.stoppedAt > state.lastAt)
    || state.chargingStartedAt !== null && (state.chargingStartedAt < state.startedAt || state.chargingStartedAt > state.lastAt)
    || state.chargeDeadlineAt !== null && (state.chargeDeadlineAt <= state.startedAt
      || state.chargeDeadlineAt > (state.probe?.startedAt ?? state.chargingStartedAt) + IDENTIFICATION_CHARGE_LIMIT_MS)
    || state.phase === 'charging' && state.chargingStartedAt === null
    || state.phase === 'pausing' && state.pauseUntil === null
    || ['completed', 'inconclusive'].includes(state.phase) && (state.completedAt === null || state.action !== null
      || state.completedAt < state.startedAt || state.completedAt > state.lastAt || state.reason === null)
    || state.phase === 'completed' && state.reason !== 'identified'
    || state.phase === 'inconclusive' && state.reason === 'identified'
    || ['waiting', 'charging', 'pausing', 'observing'].includes(state.phase) && state.completedAt !== null
    || state.action === 'allow' && !['waiting', 'charging'].includes(state.phase)
    || state.action === 'pause' && state.phase !== 'pausing'
    || state.phase === 'observing' && state.action !== null)
    throw new Error('Unsupported saved charging identification; start a fresh development database');
}

const finish = (state, phase, reason, now) => ({ ...state, phase, reason, action: null, completedAt: now,
  ...(state.probe ? { probe: { ...state.probe, endedAt: state.probe.endedAt ?? now } } : {}) });

/** Identification lasts for a connection. Only extra charging has a probe
 * budget. A BMW correlation pause retains its original bounded deadline after
 * physical confirmation so the vehicle can observe the stop. Independent BMW
 * evidence may also arrive later in the same connection. Exhaustion or
 * interruption ends active testing until an explicit retry or new connection;
 * passive evidence can still complete the saved attempt. */
export function advanceIdentification(previous, { connectedAt, now, connected = true, identified = false,
  manualRetry = false, manualStop = false, interrupted = false, available = true, charging = false, energyKwh = null, powerKw = null,
  normalCharging = true, probeAllowed = false, probeReturnAt = null, probeDurationMs = IDENTIFICATION_CHARGE_LIMIT_MS,
  physicalFresh = true, physicalStopped = false, candidate = null, pause = null } = {}) {
  validateIdentificationState(previous);
  if (!connected || !time(connectedAt) || !time(now) || connectedAt > now) return null;
  let state = previous?.connectedAt === connectedAt ? structuredClone(previous) : null;
  if (state) now = Math.max(now, state.lastAt);
  if (!state || manualRetry) {
    const attempt = state ? state.attempt + 1 : 1;
    state = { version: 1, id: `${connectedAt}:${attempt}:${now}`, connectedAt, attempt,
      phase: 'waiting', action: null, startedAt: now, lastAt: now, chargingStartedAt: null,
      chargeDeadlineAt: null, chargeEnergyKwh: null, chargeUsedKwh: 0, chargePowerKw: null,
      pauseUntil: null, candidate: null, pause: null, completedAt: null, reason: null, probe: null };
  }
  const previousAt = state.lastAt;
  state.lastAt = now;
  if (state.probe && state.probe.endedAt === null && !['completed', 'inconclusive'].includes(state.phase)) {
    const currentPower = Number.isFinite(powerKw) && powerKw >= 0 ? powerKw : null;
    const chargeUntil = validPause(pause) ? Math.min(now, pause.stoppedAt) : now;
    state.chargeUsedKwh += Math.max(state.chargePowerKw ?? 0, currentPower ?? 0)
      * Math.max(0, chargeUntil - previousAt) / 3_600_000;
    if (currentPower !== null) state.chargePowerKw = currentPower;
    if (Number.isFinite(energyKwh) && state.chargeEnergyKwh !== null)
      state.chargeUsedKwh = Math.max(state.chargeUsedKwh, energyKwh - state.chargeEnergyKwh);
  }
  if (identified && !manualRetry) return state.phase === 'completed' ? state : finish(state, 'completed', 'identified', now);
  if (['completed', 'inconclusive', 'observing'].includes(state.phase)) return state;
  if (interrupted) return finish(state, 'inconclusive', 'interrupted', now);
  if (manualStop) {
    state.action = null;
    return state.phase === 'waiting' && !state.probe ? state : finish(state, 'inconclusive', 'manual-stop', now);
  }
  if (state.phase === 'pausing' && validPause(pause) && pause.connectedAt === connectedAt
    && [state.pauseUntil, state.probe?.returnStartAt].includes(pause.startAt)
    && pause.requestedAt >= (state.candidate?.capturedAt ?? state.startedAt)
    && pause.confirmedAt <= now && pause.stoppedAt <= now && pause.stoppedAt < state.pauseUntil) {
    state.pause = structuredClone(pause);
    if (!state.candidate) return finish(state, 'inconclusive', state.reason ?? 'awaiting-evidence', now);
    if (state.probe) state.probe.endedAt ??= now;
    state.reason ??= 'awaiting-evidence';
  }
  if (state.phase === 'pausing' && state.probe?.endedAt === null && physicalStopped && physicalFresh
    && (state.chargeUsedKwh > 0 || state.chargingStartedAt !== null && state.chargingStartedAt >= state.probe.startedAt)) {
    // An independently observed stop may precede command confirmation.
    // Current zero/withholding evidence ends the extra charging, but cannot
    // manufacture the causal pause proof required by active vehicle matching.
    // A candidate still needs its already bounded observation window.
    if (!state.candidate) return finish(state, 'inconclusive', state.reason ?? 'awaiting-evidence', now);
    state.probe.endedAt = now;
  }
  if (normalCharging && state.probe && state.probe.endedAt === null && state.phase !== 'pausing')
    return finish(state, 'inconclusive', 'interrupted', now);
  const probeDuration = Math.min(IDENTIFICATION_CHARGE_LIMIT_MS, Math.max(1000, Math.floor(probeDurationMs)));
  if (!normalCharging && available && physicalFresh && probeAllowed && !state.probe && state.pauseUntil === null
    && time(probeReturnAt) && probeReturnAt > now + probeDuration) {
    state.probe = { startedAt: now, deadlineAt: Math.floor((now + probeDuration) / 1000) * 1000,
      returnStartAt: Math.ceil(probeReturnAt / 1000) * 1000, endedAt: null };
    state.chargeDeadlineAt = state.probe.deadlineAt;
    state.chargeEnergyKwh = Number.isFinite(energyKwh) && energyKwh >= 0 ? energyKwh : null;
    state.chargePowerKw = Number.isFinite(powerKw) && powerKw >= 0 ? powerKw : null;
  }
  if (state.phase === 'waiting' && charging && available) {
    state.phase = 'charging'; state.chargingStartedAt ??= now;
  }
  const probing = state.probe && state.probe.endedAt === null;
  let stopReason = null;
  if (probing && state.phase !== 'pausing') {
    // Reserve ten seconds of the last observed draw for dispatch/stop latency.
    const reserve = Math.max(state.chargePowerKw ?? 0, powerKw ?? 0) * 10 / 3600;
    if (state.chargeUsedKwh + reserve >= IDENTIFICATION_ENERGY_LIMIT_KWH) stopReason = 'probe-energy-limit';
    else if (now >= state.probe.deadlineAt) stopReason = 'probe-time-limit';
    else if (!physicalFresh || !available) stopReason = 'telemetry-lost';
  }
  const usable = state.phase === 'charging' && available && charging && validCandidate(candidate)
    && candidate.connectedAt === connectedAt && candidate.capturedAt >= state.startedAt
    && candidate.capturedAt <= now && now - candidate.capturedAt <= MINUTE && candidate.measuredAt < now;
  if (state.phase !== 'pausing' && (usable || stopReason)) {
    if (usable) state.candidate = structuredClone(candidate);
    state.reason = stopReason;
    state.phase = 'pausing';
    state.pauseUntil = Math.ceil((now + IDENTIFICATION_PAUSE_WAIT_MS) / 1000) * 1000;
  }
  if (state.phase === 'pausing') {
    if (now >= state.pauseUntil) return finish(state, 'inconclusive', 'pause-timeout', now);
    // Even a lost vehicle feed must not cancel an already-budgeted charger stop.
    state.action = 'pause';
  } else state.action = available && (probing || normalCharging) ? 'allow' : null;
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
export function prepareActiveBmwCandidate(reading, { connectedAt, lastDisconnectedAt, chargingAt = [], stoppedAt = [],
  physicalAt, now, consumedChargingId } = {}) {
  if (reading?.fields?.charging?.historyOverflowAt != null || !bmwIdentityContextValid(reading, now) || !time(connectedAt) || connectedAt > now
    || !time(physicalAt) || physicalAt > now || now - physicalAt > MINUTE) return null;
  const departure = departureAt(reading, lastDisconnectedAt);
  const boundary = connectionEvidenceStart(connectedAt, departure);
  const field = reading.fields?.charging;
  const consumedAt = bmwConsumedChargingAt(reading, consumedChargingId);
  const live = observed => observed?.retained === false && eventId(observed.readingId)
    && observed.readingId !== consumedChargingId && time(observed.measuredAt) && time(observed.receivedAt)
    && (consumedAt === null || observed.measuredAt > consumedAt)
    && observed.measuredAt > departure && observed.measuredAt <= now
    && observed.receivedAt >= boundary && observed.receivedAt <= now;
  const stops = (Array.isArray(stoppedAt) ? stoppedAt : [stoppedAt]).filter(at => time(at) && at <= now);
  const starts = (Array.isArray(chargingAt) ? chargingAt : [chargingAt])
    .filter(at => time(at) && at >= boundary && at > departure && at <= now && !stops.some(stop => stop > at));
  const events = bmwChargingEvents(reading);
  const edge = events.filter(row => row.value === true && live(row)
    && starts.some(at => Math.abs(at - row.measuredAt) <= 30_000)
    && !events.some(stop => stop.value === false && stop.measuredAt > row.measuredAt && stop.measuredAt <= now)).at(-1);
  let baseline, kind;
  if (edge) { baseline = edge; kind = 'start'; }
  else if (reading.charging === true && live(field) && now - field.measuredAt <= 5 * MINUTE
    && now - field.receivedAt <= MINUTE && physicalAt >= boundary && physicalAt > departure) {
    baseline = field; kind = 'ongoing';
  } else return null;
  return { connectedAt, association: reading.association ?? null, kind, readingId: baseline.readingId,
    measuredAt: baseline.measuredAt, receivedAt: baseline.receivedAt, physicalAt, capturedAt: now };
}

/** A saved physical stop keeps its historical meaning after resume. The
 * connection/feed and source-time pairing fence delayed vehicle events. */
export function matchActiveBmwPause(reading, { state, now, lastDisconnectedAt, consumedChargingId } = {}) {
  if (!state || !bmwIdentityContextValid(reading, now)) return null;
  const { candidate, pause, connectedAt } = state;
  const consumedAt = bmwConsumedChargingAt(reading, consumedChargingId);
  if (!validCandidate(candidate) || !validPause(pause) || candidate.connectedAt !== connectedAt
    || pause.connectedAt !== connectedAt || ![state.pauseUntil, state.probe?.returnStartAt].includes(pause.startAt)
    || candidate.association !== (reading.association ?? null) || candidate.readingId === consumedChargingId
    || consumedAt !== null && candidate.measuredAt <= consumedAt
    || candidate.capturedAt > pause.requestedAt || candidate.receivedAt > pause.requestedAt
    || candidate.measuredAt >= pause.requestedAt || candidate.physicalAt > pause.requestedAt
    || pause.requestedAt > pause.stoppedAt || pause.confirmedAt > now || pause.stoppedAt > now) return null;
  const departure = departureAt(reading, lastDisconnectedAt);
  if (candidate.measuredAt <= departure || candidate.physicalAt <= departure) return null;
  const events = bmwChargingEvents(reading);
  const stop = events.find(row => row.value === false && row.retained === false && eventId(row.readingId)
    && row.readingId !== candidate.readingId && time(row.measuredAt) && time(row.receivedAt)
    && row.measuredAt > pause.requestedAt && row.measuredAt <= now && row.measuredAt <= state.pauseUntil
    && row.receivedAt <= now && row.receivedAt >= row.measuredAt
    && Math.abs(row.measuredAt - pause.stoppedAt) <= 30_000
    && !events.some(other => other.value === false && other.measuredAt > candidate.measuredAt && other.measuredAt < row.measuredAt));
  if (!stop) return null;
  return { chargingReadingId: candidate.readingId, stopReadingId: stop.readingId, confirmedAt: pause.confirmedAt };
}
