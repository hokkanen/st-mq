const recent = (result, now) => Number.isFinite(result?.at) && result.at <= now && now - result.at < 60_000;
const failed = result => ['failed', 'unconfirmed'].includes(result?.status) || Boolean(result?.error);

/** Saved request records are history; only current manual ownership keeps a notice alive. */
export function heatingRequestResult(status = {}, result = status.heatingTests?.lastResult) {
  const now = status.now ?? Date.now();
  if (!result) return null;
  if (failed(result)) return recent(result, now) ? result : null;
  if (result.command === 'circulation') {
    const dhwr = status.dhwr ?? {};
    return dhwr.active && !(dhwr.requestedAt > result.at)
      ? { ...result, confirmed: dhwr.confirmed === true } : null;
  }
  if (status.execution?.restorationPending || status.h66?.restorationPending || status.preheatValves?.restorationPending) return null;
  if (result.command === 'preheat' && status.h66 && !status.h66.manualPreheat) return null;
  const actual = status.observations?.actual ?? {}, observedAt = actual.observedAt ?? actual.receivedAt;
  const confirmed = actual.verified === true && actual.stale === false
    && (actual.phase ?? actual.mode) === result.command && observedAt >= result.at && observedAt <= now;
  if (result.holdUntil != null) {
    const hold = status.decision?.manualHold, pause = status.override;
    if (!(hold?.until > now) || !(pause?.expiresAt > now) || hold.phase !== result.command
      || pause.createdAt > result.at) return null;
    return { ...result, confirmed, holdUntil: hold.until };
  }
  if (!(result.expiresAt > now)) return null;
  const phase = status.observations?.actual?.requestedPhase;
  return phase && phase !== result.command ? null : { ...result, confirmed };
}

export function h66RequestResult(status = {}) {
  const h66 = status.h66 ?? {}, result = h66.lastManual, now = status.now ?? Date.now();
  if (!result) return null;
  if (failed(result)) return recent(result, now) ? result : null;
  if (h66.restorationPending || !(h66.expiresAt > now) || !(result.expiresAt > now)
    || !['manual-pause', 'manual-temporary'].includes(h66.phase)
    || h66.requested?.[result.register] !== result.value) return null;
  if (result.pauseId != null && (h66.pauseId !== result.pauseId || !(status.override?.expiresAt > now)
    || status.override.id !== result.pauseId)) return null;
  const reading = h66.readings?.[result.register];
  if (reading?.available === true && reading.stale === false && reading.value !== result.value) return null;
  return result;
}

/** Stop acknowledgements yield to live OFF confirmation; unresolved feedback has its own status. */
export function circulationStopPending(status = {}, requestedAt) {
  const dhwr = status.dhwr ?? {}, now = status.now ?? Date.now();
  return Number.isFinite(requestedAt) && !dhwr.active && !(dhwr.requestedAt > requestedAt)
    && (dhwr.restorationPending || dhwr.confirmed !== true && dhwr.feedback?.stateConfigured !== false
      && now >= requestedAt && now - requestedAt < 60_000);
}
