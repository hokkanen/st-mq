import { actionReceiptRecent } from './action-receipts.js';
const failed = result => ['failed', 'unconfirmed'].includes(result?.status) || Boolean(result?.error);
const unexpired = (until, now) => until === null || Number.isFinite(until) && until > now;

/** Current device evidence wins over a prior request when choosing the active button. */
export function heatingModeSelection(status = {}) {
  const actual = status.observations?.actual;
  if (actual?.verified === true && actual.stale !== true) return { phase: actual.phase ?? actual.mode, confirmed: true };
  const requested = actual?.requestedPhase ?? (actual?.source === 'mqtt-request' && actual.stale !== true ? actual.phase ?? actual.mode : null);
  return { phase: requested, confirmed: false };
}

/** A receipt lasts one day, independently from ownership of the heating mode. */
export function heatingRequestResult(status = {}, result = status.heatingTests?.lastResult) {
  const now = status.now ?? Date.now();
  if (!result || !actionReceiptRecent(result.at, now)) return null;
  const restorationPending = Boolean(status.execution?.restorationPending || status.h66?.restorationPending || status.preheatValves?.restorationPending);
  if (result.command === 'circulation') {
    const dhwr = status.dhwr ?? {}, superseded = dhwr.requestedAt > result.at;
    const active = dhwr.active === true && !superseded;
    return { ...result, active, superseded, confirmed: active && dhwr.confirmed === true,
      lifecycle: superseded ? 'superseded' : active ? 'active' : failed(result) ? 'failed' : 'completed' };
  }
  const actual = status.observations?.actual ?? {}, observedAt = actual.observedAt ?? actual.receivedAt;
  const fresh = actual.verified === true && actual.stale === false && Number.isFinite(observedAt)
    && observedAt >= (result.requestedAt ?? result.at) && observedAt <= now;
  const observedPhase = fresh ? actual.phase ?? actual.mode : null;
  const hold = status.decision?.manualHold, pause = status.override;
  const sameHold = hold?.phase === result.command && unexpired(hold.until, now)
    && (!(pause?.createdAt > result.at));
  const owned = sameHold || result.expiresAt > now && (!actual.requestedPhase || actual.requestedPhase === result.command);
  const superseded = Boolean(!sameHold && (fresh && observedPhase !== result.command
    || actual.requestedPhase && actual.requestedPhase !== result.command)
    || hold && hold.phase !== result.command || pause?.createdAt > result.at);
  const active = (!failed(result) || fresh && observedPhase === result.command) && !superseded && !restorationPending && owned
    && (result.command !== 'preheat' || !status.h66 || Boolean(status.h66.manualPreheat));
  return { ...result, active, superseded, restorationPending, observedPhase,
    evidenceAt: fresh ? observedAt : null,
    confirmed: fresh ? observedPhase === result.command : result.confirmed === true,
    holdUntil: sameHold ? hold.until : result.holdUntil,
    indefinite: active && sameHold && hold.until === null,
    lifecycle: superseded ? 'superseded' : active ? 'active' : failed(result) ? 'failed' : 'completed' };
}

export function h66RequestResult(status = {}) {
  const h66 = status.h66 ?? {}, result = h66.lastManual, now = status.now ?? Date.now();
  if (!result || result.scope !== 'native-setting' || !actionReceiptRecent(result.at, now)) return null;
  const reading = h66.readings?.[result.register], observedAt = reading?.observedAt ?? reading?.receivedAt ?? reading?.at;
  const fresh = reading?.available === true && reading.stale === false && Number.isFinite(observedAt)
    && observedAt >= (result.requestedAt ?? result.at) && observedAt <= now;
  return { ...result, confirmed: fresh ? reading.value === result.value : result.confirmed === true,
    observedValue: fresh ? reading.value : null, evidenceAt: fresh ? observedAt : null,
    superseded: fresh && reading.value !== result.value };
}

/** Restoration remains visible until resolved, independently from receipt age. */
export function circulationStopPending(status = {}, requestedAt) {
  const dhwr = status.dhwr ?? {}, now = status.now ?? Date.now();
  return Number.isFinite(requestedAt) && !dhwr.active && !(dhwr.requestedAt > requestedAt)
    && (dhwr.restorationPending || dhwr.confirmed !== true && dhwr.feedback?.stateConfigured !== false
      && actionReceiptRecent(requestedAt, now));
}
