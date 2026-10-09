export const BACKGROUND_PLAN_SETTLING_MS = 30_000;
const processing = new Set(['evse-input-persistence-pending', 'evse-source-time-pending']);

/** A short, fixed window for background forecasts, never a lease on evidence or
 * command permission. Explicit edits bypass it in the runtime. Only an already
 * accepted, feasible future waiting program can bridge the window. */
export function backgroundPlanDeadline({ now, previous, key, chargers, plans, coordination }) {
  const until = previous?.at + BACKGROUND_PLAN_SETTLING_MS;
  if (!previous || previous.key !== key || !Number.isSafeInteger(previous.at)
    || now < previous.at || now >= until || coordination?.proposed?.feasible !== true
    || coordination?.adopted?.feasible !== true) return null;
  let waiting = false;
  const near = at => Number.isFinite(at) && at > now && at <= now + BACKGROUND_PLAN_SETTLING_MS;
  for (const charger of chargers) {
    const connected = charger.values?.connected;
    if (connected?.available && connected.value === false) continue;
    // An unconfigured/inactive slot has no program to retain. A new connection
    // or request changes the comparison key before it can participate.
    if (!charger.settings?.enabled && !charger.request?.sessionId && !plans[charger.id]?.periods?.length) continue;
    const control = charger.control ?? {}, snapshot = control.snapshot ?? {}, plan = plans[charger.id];
    const observationReady = snapshot.transport === 'shelly-evse'
      ? snapshot.observationReady === true && (snapshot.controlReady === true || processing.has(snapshot.commandBlockReason))
      : snapshot.transport === 'ocpp' && snapshot.transactionConfirmed === true
        && Number.isSafeInteger(snapshot.readAt) && snapshot.readAt <= now && now - snapshot.readAt <= 60_000
        && !['Unavailable', 'Faulted', 'Reserved'].includes(snapshot.connectorStatus);
    const waitingControl = control.phase === 'waiting'
      || control.phase === 'paused' && control.pauseConfirmed === true && control.ownsInstruction === true;
    if (!connected?.available || connected.value !== true || !charger.settings?.enabled
      || charger.request?.chargeNow || control.manual || control.pending || control.errorCode
      || control.devicePermissionHeld || snapshot.online !== true || snapshot.faulted || snapshot.authorizationBlocked
      || snapshot.nativeScheduleActive || snapshot.stopped || snapshot.manualStop
      || charger.capabilities?.currentControl && snapshot.currentObservationReady !== true
      || !observationReady || charger.identification?.action || charger.identification?.probe?.endedAt === null
      || ['charging', 'pausing'].includes(charger.identification?.phase)
      || ['proposed', 'applying', 'active', 'restoring', 'uncertain'].includes(control.currentTest?.phase)
      || !waitingControl || !plan || plan.state !== 'waiting' || plan.feasible !== true || plan.provisional
      || !plan.periods?.length || !control.execution?.periods?.length || control.execution.planId !== plan.id
      || !Number.isSafeInteger(plan.deadlineAt) || plan.deadlineAt <= now || near(plan.deadlineAt)
      || [...plan.periods, ...control.execution.periods].some(row => row.startAt <= now && (row.endAt === null || row.endAt > now)
        || near(row.startAt) || near(row.endAt))) return null;
    waiting = true;
  }
  if (!waiting || (coordination.allocations ?? []).some(row => near(row.start) || near(row.end))) return null;
  return until;
}
