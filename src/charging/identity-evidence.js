import { effectiveScheduleFingerprint, nextLocalOccurrence } from './easee.js';

export const IDENTIFYING_REASON = 'Identifying the connected vehicle from its initial charging telemetry. Automatic scheduling follows when identified or after the three-minute observation limit.';

const MAX_READ_AGE_MS = 60_000, STOP_CLOCK_TOLERANCE_MS = 30_000;
const time = value => Number.isSafeInteger(value) && value >= 0;
const transactionId = value => Number.isSafeInteger(value) && value > 0 && value < 2147483647;
const observed = (at, now) => time(at) && at <= now;
const fresh = (at, now) => observed(at, now) && now - at <= MAX_READ_AGE_MS;

function currentIdentitySession(control, now) {
  const snapshot = control?.snapshot, session = control?.session;
  return time(now) && snapshot && control.enabled === true && !control.errorCode
    && !control.pending && !control.manual && !control.released && !control.disconnected
    && !control.vehicleDisconnect?.awaitingConnection && !control.vehicleDisconnect?.cleanupPending
    && session?.connected === true && snapshot.pluggedIn === true && snapshot.online === true
    && fresh(snapshot.readAt, now) && observed(session.connectedAt, snapshot.readAt)
    && (session.lastDisconnectedAt == null || observed(session.lastDisconnectedAt, now)
      && session.lastDisconnectedAt < session.connectedAt);
}

const cloudAvailable = snapshot => snapshot.controlKnown === true && snapshot.enabled === true
  && !snapshot.faulted && !snapshot.manualStop && !snapshot.stopped && !snapshot.authorizationBlocked;
const currentTransaction = (snapshot, session, until) => snapshot.transactionConfirmed === true
  && transactionId(snapshot.transactionId) && snapshot.transactionId === session.transactionId
  && observed(snapshot.transactionStartedAt, until)
  && (session.lastDisconnectedAt == null || snapshot.transactionStartedAt > session.lastDisconnectedAt);

/** A bounded identification observation may defer a new economic restriction
 * only while the connected charger is already available without our command.
 * Existing ownership and foreign/manual restrictions retain their priority. */
export function identityObservationAvailable(control, now) {
  if (!currentIdentitySession(control, now) || control.owned) return false;
  const { snapshot, session } = control;
  if (snapshot.transport === 'ocpp') return !snapshot.nativeInstruction
    && currentTransaction(snapshot, session, snapshot.readAt)
    && ['Preparing', 'Charging', 'SuspendedEV'].includes(snapshot.connectorStatus)
    && observed(snapshot.statusAt, snapshot.readAt);
  if (snapshot.transport === undefined) return cloudAvailable(snapshot)
    && [2, 3, 4, 6].includes(snapshot.mode) && observed(snapshot.modeAt, snapshot.readAt)
    && snapshot.schedule?.enabled === 'none';
  return false;
}

/** Transport facts become one vehicle-independent, current-session pause proof.
 * Ownership alone never establishes that the requested physical stop occurred.
 * The caller must also match live vehicle/charger starts and stops around this
 * request; this proof does not identify a vehicle on its own. */
export function confirmedIdentityPause(control, now) {
  const snapshot = control?.snapshot, session = control?.session, owned = control?.owned;
  if (!currentIdentitySession(control, now) || !owned) return null;

  const { connectedAt } = session, { confirmedAt, startAt } = owned;
  const requestedAt = snapshot.transport === 'ocpp' ? owned.pauseRequestedAt : owned.requestedAt;
  if (!observed(requestedAt, snapshot.readAt)
    || requestedAt < connectedAt || !observed(confirmedAt, now) || confirmedAt < requestedAt
    || !time(startAt) || startAt <= now) return null;

  let stoppedAt;
  if (snapshot.transport === 'ocpp') {
    if (control.ownsInstruction !== true || control.pauseConfirmed !== true
      || !observed(owned.requestedAt, requestedAt)
      || !currentTransaction(snapshot, session, requestedAt) || snapshot.transactionId !== owned.transactionId
      || snapshot.connectorStatus !== 'SuspendedEVSE'
      || !fresh(snapshot.powerAt, now) || snapshot.powerAt > snapshot.readAt
      || snapshot.powerAt < requestedAt || snapshot.powerKw !== 0) return null;
    stoppedAt = snapshot.statusAt;
  } else if (snapshot.transport === undefined) {
    // Cloud snapshots deliberately retain their native schedule observations.
    // Inactive cached schedules do not affect ownership of the enabled delay.
    if (!cloudAvailable(snapshot) || ![2, 4, 6].includes(snapshot.mode) || snapshot.reason !== 54
      || snapshot.schedule?.enabled !== 'delayed'
      || !observed(snapshot.reasonAt, snapshot.readAt) || snapshot.reasonAt < requestedAt
      || Math.abs(snapshot.reasonAt - snapshot.modeAt) > STOP_CLOCK_TOLERANCE_MS) return null;
    try {
      if (owned.activeFingerprint !== effectiveScheduleFingerprint(snapshot.schedule)
        || startAt !== nextLocalOccurrence(snapshot.schedule.delayed.startTime, snapshot.schedule.delayed.timezone, now)) return null;
    } catch { return null; }
    stoppedAt = snapshot.modeAt;
  } else return null;

  // A device can report a stop in the same millisecond as the guarded request.
  // Matching a distinct live charging start before that request remains the
  // shared identity matcher's responsibility; earlier cached stops fail here.
  if (!observed(stoppedAt, snapshot.readAt) || stoppedAt < requestedAt) return null;
  return { connectedAt, requestedAt, confirmedAt, startAt, stoppedAt };
}
