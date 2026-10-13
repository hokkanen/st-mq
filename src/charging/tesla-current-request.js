import { confirmedIdentityPause } from './identity-evidence.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const current = value => Number.isFinite(value) && value >= 0 && value <= 100;
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const requestKeys = ['value', 'receivedAt', 'sequence', 'retained', 'eligible', 'reflected', 'offered'];
const limitKeys = ['value', 'receivedAt', 'sequence', 'retained', 'maximumA', 'maximumReceivedAt'];

// A dormant proven constraint can reduce permitted/assumed current. Its source
// field remains unavailable; this never turns a retained setting into live draw.
export function vehicleCurrentConstraint(signal) {
  const value = signal?.available === false ? signal.knownLimitA : signal?.value;
  return current(value) ? value : null;
}

export function validateTeslaCurrentRequest(value) {
  if (value == null) return;
  const request = value.request, limit = value.limit;
  if (!keys(value, ['vehicleAssociation', 'request', 'limit'])
    || typeof value.vehicleAssociation !== 'string' || !value.vehicleAssociation.length || value.vehicleAssociation.length > 128
    || !keys(request, requestKeys) || !(request.value === null || current(request.value))
    || !time(request.receivedAt) || !Number.isSafeInteger(request.sequence) || request.sequence < 1
    || ['retained', 'eligible', 'reflected'].some(key => typeof request[key] !== 'boolean')
    || request.eligible && request.reflected
    || request.offered !== null && (!keys(request.offered, ['value', 'receivedAt', 'measuredAt', 'source'])
      || !current(request.offered.value) || !time(request.offered.receivedAt)
      || !(request.offered.measuredAt === null ? request.offered.receivedAt <= request.receivedAt
        : time(request.offered.measuredAt) && request.offered.measuredAt <= request.receivedAt)
      || typeof request.offered.source !== 'string' || !request.offered.source.length || request.offered.source.length > 128)
    || request.eligible && (!request.offered || request.value === null || request.value >= request.offered.value)
    || limit !== null && (!keys(limit, limitKeys) || !current(limit.value) || !current(limit.maximumA)
      || limit.value >= limit.maximumA || !time(limit.receivedAt) || !time(limit.maximumReceivedAt)
      || !Number.isSafeInteger(limit.sequence) || limit.sequence < 1 || limit.sequence > request.sequence
      || limit.receivedAt > request.receivedAt || typeof limit.retained !== 'boolean'))
    throw new Error('Unsupported saved Tesla current request; start a fresh development database');
}

const usable = (field, now) => Boolean(field && current(field.value) && time(field.receivedAt)
  && field.receivedAt <= now && field.measuredAt === null && field.timeBasis === 'receipt-only'
  && Number.isSafeInteger(field.sequence) && field.sequence >= 1 && typeof field.retained === 'boolean');

/** A physical session owns a qualified constraint, never charging permission.
 * Capture supply context once per request. Later pilot reports cannot invent
 * independence for an earlier request which followed that pilot. */
export function updateTeslaCurrentRequest(previous, snapshot, { now, nativeCurrent, control } = {}) {
  validateTeslaCurrentRequest(previous);
  if (!snapshot?.association || snapshot.connected !== true || snapshot.healthy !== true) return previous ?? null;
  if (previous?.vehicleAssociation !== snapshot.association) previous = null;
  const request = snapshot.fields?.charge_current_request;
  if (!request || !time(request.receivedAt) || request.receivedAt > now
    || !Number.isSafeInteger(request.sequence) || request.sequence < 1 || typeof request.retained !== 'boolean'
    || request.measuredAt !== null || request.timeBasis !== 'receipt-only') return previous;
  if (time(control?.session?.connectedAt) && request.receivedAt < control.session.connectedAt) return previous;
  const maximum = snapshot.fields?.charge_current_request_max;
  const maximumUsable = usable(maximum, now);
  let next = previous;
  if (!previous || previous.request.sequence !== request.sequence || previous.request.receivedAt !== request.receivedAt) {
    const valid = usable(request, now);
    // A correlated later native read can confirm an unchanged source value.
    // Keep its actual receipt clock; only its original admitted measurement
    // clock can place that offered pilot before the Tesla request.
    const pilotKnown = nativeCurrent?.available === true && current(nativeCurrent.value)
      && time(nativeCurrent.receivedAt) && nativeCurrent.receivedAt <= now
      && time(nativeCurrent.measuredAt) && nativeCurrent.measuredAt <= request.receivedAt;
    const permission = control?.permissionCommand;
    const stoppedFields = ['start_charging', 'work_state', 'phase_info'].map(key => control?.snapshot?.fields?.[key]);
    const shellyStopAcknowledged = permission?.value === false
      && permission.sessionId === control.session?.sessionId && time(permission.acceptedAt)
      && permission.acceptedAt <= request.receivedAt && control.snapshot?.fields?.start_charging?.value === false
      && (control.ownedPause === true || control.ownsInstruction === true || control.pauseConfirmed === true);
    const shellyStopped = shellyStopAcknowledged && control.pauseConfirmed === true
      && stoppedFields.every(field => time(field?.measuredAt) && field.measuredAt <= request.receivedAt);
    const pause = confirmedIdentityPause(control, now);
    const owned = control?.owned, physical = control?.snapshot, session = control?.session;
    const ocppStopAcknowledged = physical?.transport === 'ocpp' && control.ownsInstruction === true
      && session?.connected === true && time(session.connectedAt) && physical.transactionConfirmed === true
      && owned?.transactionId === session.transactionId && owned.transactionId === physical.transactionId
      && time(owned.requestedAt) && owned.requestedAt >= session.connectedAt
      && time(owned.pauseRequestedAt) && owned.pauseRequestedAt >= owned.requestedAt && owned.pauseRequestedAt <= request.receivedAt
      && time(owned.confirmedAt) && owned.confirmedAt >= owned.requestedAt && owned.confirmedAt <= request.receivedAt
      && time(owned.startAt) && owned.startAt > request.receivedAt;
    const scopedPause = Boolean(pause && pause.connectedAt === session?.connectedAt
      && pause.requestedAt <= request.receivedAt && pause.confirmedAt <= request.receivedAt);
    const stopAcknowledged = shellyStopAcknowledged || ocppStopAcknowledged || Boolean(scopedPause);
    const stopped = shellyStopped || scopedPause && pause.stoppedAt <= request.receivedAt
      && (physical.transport !== 'ocpp' || physical.powerAt <= request.receivedAt);
    const normalPending = control?.pending?.role === 'current_limit';
    const pending = normalPending ? control.pending : control?.currentTest?.pending;
    const pendingSession = normalPending ? pending.sessionId : control?.currentTest?.sessionId;
    const uncertainPilot = request.value > 0 && pending?.value === request.value && pendingSession === control?.session?.sessionId
      && time(pending.dispatchedAt) && pending.dispatchedAt <= request.receivedAt;
    const test = control?.currentTest;
    const sameTest = test?.sessionId === session?.sessionId && test?.connectedAt === session?.connectedAt
      && time(test?.confirmedAt) && test.confirmedAt <= request.receivedAt && request.value === test.appliedCurrentA;
    // Identity can settle only after restoration. A held test-era request does
    // not become independent because the current read now shows the restored
    // pilot. Whole-second source timestamps cannot order a later readback and
    // the request within that second; no clock is rounded forward to decide it.
    const higherPilotBeforeRequest = pilotKnown && nativeCurrent.value > request.value
      && (nativeCurrent.receivedAt <= request.receivedAt || nativeCurrent.measuredAt % 1000 !== 0
        || nativeCurrent.measuredAt < Math.floor(request.receivedAt / 1000) * 1000);
    const uncertainTest = sameTest && !higherPilotBeforeRequest
      && (['active', 'restoring', 'uncertain', 'superseded'].includes(test.phase) && request.receivedAt <= test.expiresAt
        || test.phase === 'restored' && time(test.permissionAt)
          && test.permissionAt >= Math.floor(request.receivedAt / 1000) * 1000);
    const stoppedReflection = stopped && snapshot.charging === false && request.value === 5;
    const uncertainStop = stopAcknowledged && !stoppedReflection && snapshot.charging === false && request.value === 5;
    const reflected = valid && request.value > 0 && (pilotKnown && request.value === nativeCurrent.value || stoppedReflection);
    const eligible = valid && !reflected && !uncertainPilot && !uncertainStop && !uncertainTest
      && (pilotKnown ? request.value < nativeCurrent.value
        : maximumUsable && maximum.receivedAt <= request.receivedAt && request.value < maximum.value);
    const offered = pilotKnown ? { value: nativeCurrent.value, receivedAt: nativeCurrent.receivedAt,
      measuredAt: nativeCurrent.measuredAt, source: nativeCurrent.source ?? 'native-pilot' }
      : maximumUsable && maximum.receivedAt <= request.receivedAt ? { value: maximum.value,
        receivedAt: maximum.receivedAt, measuredAt: null, source: 'teslamate' } : null;
    // A genuinely new higher request retires an earlier lower choice. A
    // reflected stop/test or uncertain command does not erase known evidence.
    const testReflection = reflected && control?.currentTest?.phase === 'active'
      && control.currentTest.sessionId === control.session?.sessionId
      && control.currentTest.connectedAt === control.session?.connectedAt
      && control.currentTest.appliedCurrentA === request.value && time(control.currentTest.confirmedAt)
      && control.currentTest.confirmedAt <= request.receivedAt;
    const limit = !valid || stoppedReflection || testReflection || uncertainPilot || uncertainStop || uncertainTest
      || request.value <= (previous?.limit?.value ?? -1)
      ? previous?.limit ?? null : null;
    next = { vehicleAssociation: snapshot.association,
      request: { value: valid ? request.value : null, receivedAt: request.receivedAt,
        sequence: request.sequence, retained: request.retained, eligible, reflected }, limit };
    next.request.offered = offered;
  }
  if (next.request.eligible && maximumUsable && next.request.value < maximum.value && next.limit?.sequence !== next.request.sequence)
    next = { ...next, limit: { value: next.request.value, receivedAt: next.request.receivedAt,
      sequence: next.request.sequence, retained: next.request.retained,
      maximumA: maximum.value, maximumReceivedAt: maximum.receivedAt } };
  validateTeslaCurrentRequest(next);
  return next;
}

