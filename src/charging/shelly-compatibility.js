const time = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function validShellyDeviceHold(value) {
  return value == null || typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).filter(key => key !== 'admittedAt').sort().join(',') === 'connectedAt,eventAt,receivedAt,sessionId'
    && token(value.sessionId) && time(value.connectedAt) && time(value.eventAt)
    && value.eventAt >= value.connectedAt && validateAdmittedSourceTime({ sourceTime: value.eventAt,
      receivedAt: value.receivedAt, admittedAt: value.admittedAt });
}

/** SYS describes native provenance, not an actor or permission for another
 * Start. Preview without consuming events so status cannot miss a transient
 * permission release or invent an application-owned identification pause. */
export function shellyDevicePermission({ hold, sessionId, ownedPause, pending, lastStart, cursor = 0,
  snapshot, now, maxAgeMs }) {
  const session = snapshot.session, field = snapshot.fields?.start_charging;
  const currentSession = session?.connected === true && token(session.sessionId) && time(session.connectedAt);
  const matches = value => value?.sessionId === session?.sessionId && value.connectedAt === session?.connectedAt;
  const fresh = value => value && value.invalidatedAt === undefined && value.retained !== true
    && validateAdmittedSourceTime({ sourceTime: value.measuredAt, receivedAt: value.receivedAt, admittedAt: value.admittedAt, now })
    && now - value.receivedAt <= maxAgeMs;
  let next = hold ?? null;
  if (session?.connected === false || currentSession && next && !matches(next)) next = null;
  if (!currentSession) return { hold: next, held: false, pauseBroken: false };
  let paused = ownedPause === true && lastStart === false && sessionId === session.sessionId;
  let previous = sessionId === session.sessionId ? lastStart : undefined;
  let pauseBroken = false, lastOn = null, seen = false;
  const keepFalse = observation => {
    // An initial already-false setting is normal with native Auto charge OFF.
    // A later SYS Stop also fences a dispatched Start whose effect is unknown;
    // acknowledgement or a lost reply cannot authorize replacing that Stop.
    const afterStart = pending?.role === 'start_charging' && pending.value === true
      && time(pending.dispatchedAt) && observation.eventAt >= pending.dispatchedAt;
    if ((!paused || afterStart) && (previous === true || next || pauseBroken || afterStart) && (!next || observation.eventAt >= next.eventAt))
      next = { sessionId: session.sessionId, connectedAt: session.connectedAt,
        eventAt: observation.eventAt, receivedAt: observation.receivedAt,
        ...(observation.admittedAt === undefined ? {} : { admittedAt: observation.admittedAt }) };
  };
  for (const event of snapshot.permissionEvents ?? []) {
    if (event.sequence <= cursor || !matches(event) || event.eventAt < session.connectedAt
      || !validateAdmittedSourceTime({ sourceTime: event.eventAt, receivedAt: event.receivedAt, admittedAt: event.admittedAt, now })) continue;
    // Admission already validated these durable source events. Age cannot
    // erase a recorded interruption after an outage. They revoke old proof or
    // retain a Stop; only a fresh native query below can release a held Stop.
    seen = true;
    if (event.commandSource !== 'sys' || typeof event.value !== 'boolean') {
      // Other instructions retain their independent controller authority.
      // A pending application Start is already awaiting its own readback and
      // cannot turn the old false scalar into an independent native Stop while
      // its value-only notification is still being resolved.
      const pendingStart = pending?.role === 'start_charging' && pending.value === true
        && event.value === true && event.commandSource === 'rpc' && time(pending.dispatchedAt)
        && event.receivedAt >= pending.dispatchedAt
        && Math.floor(event.eventAt / 1000) >= Math.floor(pending.dispatchedAt / 1000);
      if (event.value !== false && !pendingStart) { pauseBroken ||= paused; paused = false; }
      lastOn = null;
      previous = event.value;
      continue;
    }
    if (event.value) {
      pauseBroken ||= paused || pending?.owned && event.eventAt >= pending.dispatchedAt;
      paused = false;
      lastOn = event;
    } else {
      keepFalse(event);
      lastOn = null;
    }
    previous = event.value;
  }
  if (fresh(field) && field.commandSource === 'sys') {
    if (field.value === true) {
      pauseBroken ||= paused;
      // A cached matching true is insufficient, including after restart. The
      // query must follow the last observed transition/held Stop receipt.
      const after = Math.max(lastOn?.receivedAt ?? 0, next?.receivedAt ?? 0);
      const eventAt = Math.max(lastOn?.eventAt ?? 0, next?.eventAt ?? 0);
      if (snapshot.controlReady === true && field.readback?.requestedAt >= after && field.readback.receivedAt >= field.readback.requestedAt
        && field.readback.receivedAt <= now && field.measuredAt >= Math.floor(eventAt / 1000) * 1000) next = null;
    } else if (!seen && field.value === false && field.measuredAt >= session.connectedAt
      && (!next || field.measuredAt > next.eventAt)) {
      keepFalse({ eventAt: field.measuredAt, receivedAt: field.receivedAt, admittedAt: field.admittedAt });
    }
  }
  return { hold: next, held: next !== null && matches(next), pauseBroken };
}
import { validateAdmittedSourceTime } from '../domain/time-evidence.js';

// Shelly native-permission compatibility. These policies never publish commands.
// Removal boundaries and qualification requirements: docs/charging/shelly-compatibility.md.
export const SHELLY_RETRY_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000]);
// Permission-transition reconciliation of a known ACK through subsequent SYS
// readback. Generic command correlation/freshness is supplied by the controller;
// an absent reply or older SYS Stop never establishes this result.
export function compatibilityAcknowledgedStart({ pending, field, correlated, held }) {
  return pending?.stage === 'accepted' && time(pending.acceptedAt) && correlated === true
    && (field.value === true || held && field.measuredAt > pending.dispatchedAt);
}
const ACTIVE = new Set(['waiting', 'verifying']);
const ORIGINS = new Set(['scheduled', 'charge-now']);
const CODES = new Set(['shelly-sys-off', 'shelly-sys-on', 'shelly-permission-restored',
  'shelly-recovery-waiting', 'shelly-recovery-attempt', 'shelly-recovery-restored',
  'shelly-recovery-exhausted', 'shelly-recovery-cancelled', 'shelly-readback-reconciled', 'shelly-pause-interrupted']);
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const count = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
export function validShellyCompatibility(value) {
  if (value == null) return true; // Genuinely absent new state, never an older decoder.
  return fields(value, ['sessionId', 'connectedAt', 'sequence', 'scheduledRetries', 'requestAt', 'chargeNowRetries', 'start', 'incident', 'events'])
    && token(value.sessionId) && time(value.connectedAt) && count(value.sequence, Number.MAX_SAFE_INTEGER)
    && count(value.scheduledRetries, 6) && (value.requestAt === null || time(value.requestAt)) && count(value.chargeNowRetries, 3)
    && (value.start === null || fields(value.start, ['at', 'acceptedAt', 'origin', 'requestAt', 'currentA'])
      && time(value.start.at) && time(value.start.acceptedAt) && value.start.acceptedAt >= value.start.at
      && ORIGINS.has(value.start.origin) && (value.start.requestAt === null || time(value.start.requestAt))
      && Number.isFinite(value.start.currentA) && value.start.currentA >= 0 && value.start.currentA <= 1000)
    && (value.incident === null || fields(value.incident, ['origin', 'requestAt', 'firstAt', 'deadlineAt', 'attempts', 'nextAt', 'status', 'positiveSince', 'lastPhysicalAt'])
      && ORIGINS.has(value.incident.origin) && (value.incident.requestAt === null || time(value.incident.requestAt))
      && time(value.incident.firstAt) && value.incident.deadlineAt === value.incident.firstAt + 300_000
      && count(value.incident.attempts, 3) && (value.incident.nextAt === null || time(value.incident.nextAt))
      && ['waiting', 'verifying', 'recovered', 'exhausted', 'cancelled'].includes(value.incident.status)
      && (value.incident.positiveSince === null || time(value.incident.positiveSince))
      && (value.incident.lastPhysicalAt === null || time(value.incident.lastPhysicalAt)))
    && Array.isArray(value.events) && value.events.length <= 128 && value.events.every((event, index) =>
      fields(event, ['sequence', 'at', 'code', 'sourceAt', 'receivedAt', 'origin', 'attempt', 'currentA', 'startAt', 'acceptedAt', 'policy', 'model', 'firmware'])
      && count(event.sequence, value.sequence) && event.sequence > 0 && time(event.at) && CODES.has(event.code)
      && (event.sourceAt === undefined || time(event.sourceAt)) && (event.receivedAt === undefined || time(event.receivedAt))
      && ['startAt', 'acceptedAt'].every(key => event[key] === undefined || time(event[key]))
      && (event.origin === undefined || ORIGINS.has(event.origin)) && (event.attempt === undefined || count(event.attempt, 3))
      && (event.currentA === undefined || Number.isFinite(event.currentA) && event.currentA >= 0 && event.currentA <= 1000)
      && (event.policy === undefined || ['permission-transition', 'startup-retry'].includes(event.policy))
      && ['model', 'firmware'].every(key => event[key] === undefined || typeof event[key] === 'string' && /^[\w .:+/-]{1,128}$/.test(event[key]))
      && (!index || event.sequence > value.events[index - 1].sequence));
}
export function compatibilityScope(value, session) {
  if (!session?.connected || !token(session.sessionId) || !time(session.connectedAt)) return null;
  return value?.sessionId === session.sessionId && value.connectedAt === session.connectedAt ? value
    : { sessionId: session.sessionId, connectedAt: session.connectedAt, sequence: 0,
      scheduledRetries: 0, requestAt: null, chargeNowRetries: 0, start: null, incident: null, events: [] };
}
export function compatibilityEvent(state, code, now, detail = {}) {
  if (!state) return;
  state.events.push({ sequence: ++state.sequence, at: now, code, ...detail });
  // The runtime drains these into immutable report events at each ownership save.
  // Retain a bounded replay tail for a failed report write or restart.
  state.events = state.events.slice(-128);
}
function finish(state, status, now) {
  state.incident.status = status; state.incident.nextAt = null;
  compatibilityEvent(state, `shelly-recovery-${status === 'recovered' ? 'restored' : status}`, now,
    { policy: 'startup-retry', origin: state.incident.origin, attempt: state.incident.attempts });
}
function schedule(state, now) {
  const incident = state.incident;
  if (incident.attempts >= 3 || incident.origin === 'scheduled' && state.scheduledRetries >= 6 || incident.origin === 'charge-now' && state.chargeNowRetries >= 3
    || now >= incident.deadlineAt) { finish(state, 'exhausted', now); return; }
  incident.status = 'waiting'; incident.positiveSince = null; incident.lastPhysicalAt = null;
  incident.nextAt = now + SHELLY_RETRY_DELAYS_MS[incident.attempts];
  compatibilityEvent(state, 'shelly-recovery-waiting', now,
    { policy: 'startup-retry', origin: incident.origin, attempt: incident.attempts + 1 });
}
export function compatibilityPermission(state, event, now, metadata = {}) {
  if (!state || event.commandSource !== 'sys' || typeof event.value !== 'boolean') return;
  const detail = { policy: 'permission-transition', sourceAt: event.eventAt, receivedAt: event.receivedAt };
  for (const key of ['model', 'firmware']) if (typeof metadata?.[key] === 'string' && /^[\w .:+/-]{1,128}$/.test(metadata[key])) detail[key] = metadata[key];
  if (state.start) Object.assign(detail, { startAt: state.start.at, acceptedAt: state.start.acceptedAt, currentA: state.start.currentA });
  compatibilityEvent(state, event.value ? 'shelly-sys-on' : 'shelly-sys-off', now, detail);
  const start = state.start;
  if (event.value || !start || event.receivedAt < start.acceptedAt || event.receivedAt - start.at > 60_000) return;
  const incident = state.incident;
  if (incident && ACTIVE.has(incident.status) && incident.origin === start.origin && incident.requestAt === start.requestAt) {
    // Repeated false refreshes cannot renew a timer or recharge the budget.
    if (incident.status === 'verifying') schedule(state, now);
    return;
  }
  if (incident?.status === 'exhausted' && incident.origin === start.origin && incident.requestAt === start.requestAt) return;
  state.incident = { origin: start.origin, requestAt: start.requestAt, firstAt: now, deadlineAt: now + 300_000,
    attempts: 0, nextAt: null, status: 'waiting', positiveSince: null, lastPhysicalAt: null };
  schedule(state, now);
}
export function compatibilityStart(state, { at, acceptedAt, origin, requestAt = null, currentA }) {
  if (!state || !ORIGINS.has(origin)) return;
  state.start = { at, acceptedAt, origin, requestAt, currentA };
  if (state.incident && ACTIVE.has(state.incident.status)) {
    state.incident.status = 'verifying'; state.incident.nextAt = null;
  }
}
/** Evaluate only admitted evidence. Caller retains all dispatch fences and owns
 * debiting the selected retry durably immediately before native publication. */
export function compatibilityRecovery(state, { now, origin, requestAt = null, eligible, permitted, physicalAt, charging,
  held, hold, currentA, pending, blocked = false, newRequest = false }) {
  if (!state) return { retry: false, failed: false };
  if (origin === 'charge-now' && (state.requestAt !== requestAt || newRequest)) {
    if (state.incident && ACTIVE.has(state.incident.status)) finish(state, 'cancelled', now);
    state.requestAt = requestAt; state.chargeNowRetries = 0;
    if (newRequest) state.incident = null;
  }
  let incident = state.incident;
  if (incident && ACTIVE.has(incident.status) && (incident.origin !== origin || incident.requestAt !== requestAt || !eligible)) {
    finish(state, 'cancelled', now);
  }
  // Normal OFF returns to Automatic. An actual open scheduled period may use
  // its independent budget for a recent acknowledged immediate-start failure.
  if (origin === 'scheduled' && eligible && held && hold && state.start?.origin === 'charge-now'
    && state.incident?.origin === 'charge-now' && ['exhausted', 'cancelled'].includes(state.incident.status)
    && now - state.start.at <= 60_000) {
    state.incident = { origin, requestAt: null, firstAt: now, deadlineAt: now + 300_000,
      attempts: 0, nextAt: null, status: 'waiting', positiveSince: null, lastPhysicalAt: null };
    schedule(state, now); incident = state.incident;
  }
  incident = state.incident;
  if (!incident || !ACTIVE.has(incident.status)) return { retry: false,
    failed: Boolean(!blocked && origin === 'charge-now' && incident?.origin === origin && incident.requestAt === requestAt && incident.status === 'exhausted') };
  if (permitted && charging && time(physicalAt) && physicalAt >= (state.start?.acceptedAt ?? Infinity) && physicalAt <= now) {
    // Across an unobserved gap, establish a new sustained-draw interval.
    if (incident.lastPhysicalAt === null || physicalAt - incident.lastPhysicalAt > 30_000) incident.positiveSince = physicalAt;
    incident.lastPhysicalAt = physicalAt;
    if (physicalAt - incident.positiveSince >= 60_000) finish(state, 'recovered', now);
  } else { incident.positiveSince = null; incident.lastPhysicalAt = null; }
  if (now >= incident.deadlineAt && held && !pending && !blocked) finish(state, 'exhausted', now);
  const retry = Boolean(ACTIVE.has(incident.status) && incident.status === 'waiting' && incident.nextAt <= now
    && now < incident.deadlineAt && eligible && held && !pending && !blocked);
  return { retry, failed: !blocked && incident.status === 'exhausted' && origin === 'charge-now', currentA };
}
export function compatibilityDebit(state, now, currentA) {
  const incident = state.incident;
  if (!incident || incident.status !== 'waiting' || now < incident.nextAt || now >= incident.deadlineAt
    || incident.attempts >= 3 || incident.origin === 'scheduled' && state.scheduledRetries >= 6 || incident.origin === 'charge-now' && state.chargeNowRetries >= 3) return false;
  incident.attempts++;
  if (incident.origin === 'scheduled') state.scheduledRetries++; else state.chargeNowRetries++;
  incident.status = 'verifying'; incident.nextAt = null;
  compatibilityEvent(state, 'shelly-recovery-attempt', now,
    { policy: 'startup-retry', origin: incident.origin, attempt: incident.attempts, currentA });
  return true;
}
