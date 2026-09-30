import { isReadOnlyReplica } from './replica-status.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'numeric', day: 'numeric' });
const plannedTime = (at, now) => day.format(at) === day.format(now) ? clock.format(at) : `${date.format(at)}, ${clock.format(at)}`;

/** Describe the chosen plan, never a candidate or an assumed end to recovery. */
export function homePlannedChange(status = {}) {
  const { now, decision = {} } = status;
  const display = (label, value, detail, at = null) => ({ label, value, detail, at });
  if (isReadOnlyReplica(status)) {
    const saved = status.lastDecision?.payload ?? status.lastDecision ?? decision;
    const phase = { normal: 'Normal heating', reduction: 'Reduced heating', preheat: 'Preheat', recovery: 'Recovery' }[saved.phase ?? saved.action];
    return display('Recorded plan', phase ?? 'Unavailable', 'Saved decision from local history. This cannot establish the master’s current plan or the equipment’s current state.');
  }
  if (status.input === 'offline') return display('Heating plan', 'Recorded history only',
    'No live device connection is open.');
  if (!Number.isFinite(now) || !decision.phase) return display('Heating plan', 'Waiting for a plan',
    'The controller has not reported a current heating plan.');

  const pauseUntil = status.override?.expiresAt;
  if (Number.isFinite(pauseUntil) && pauseUntil > now) return display('Heating paused', `Until ${plannedTime(pauseUntil, now)}`,
    'Automatic heating resumes at this time. Manual Preheat keeps its own earlier lease deadline.', pauseUntil);
  if (status.automation?.home?.enabled === false) return display('Heating paused', 'Until you select Automatic',
    'Manual Normal and Reduced stay selected during the pause. Preheat ends at its lease deadline. Monitoring and learning continue.');
  const hold = decision.manualHold;
  if (hold?.phase === 'preheat' && hold.until > now) return display('Manual Preheat', `Ends at ${plannedTime(hold.until, now)}`,
    'Preheat is held until its original lease deadline. ROOM is restored at that deadline even if floor restoration needs a retry.', hold.until);

  const simulated = status.input === 'simulated';
  const planLabel = simulated ? 'Simulation plan' : 'Heating plan';
  const nextLabel = simulated ? 'Next simulated change' : 'Next planned change';
  const provenance = simulated ? 'Simulation only; no commands are sent to the home.'
    : 'The controller rechecks the plan as conditions change.';
  if (decision.phase === 'recovery') return display(planLabel, 'Recovery in progress',
    `Recovery ends when the house has recovered; there is no fixed end time. ${provenance}`);

  const schedule = decision.plan?.schedule;
  if (!schedule) return display(planLabel, decision.phase === 'normal' ? 'No change planned' : 'Next change unavailable',
    `No upcoming heating change is scheduled. ${provenance}`);
  const { preheatStart, preheatEnd, reductionStart, reductionEnd } = schedule;
  if (![preheatStart, preheatEnd, reductionStart, reductionEnd].every(Number.isFinite)
    || preheatStart > preheatEnd || preheatEnd > reductionStart || reductionStart >= reductionEnd) {
    return display(planLabel, 'Plan timing unavailable', 'The controller has not reported a usable schedule.');
  }

  let next;
  if (decision.phase === 'normal') {
    if (preheatStart > now && preheatEnd > preheatStart) next = { phase: 'Preheat', at: preheatStart };
    else if (reductionStart > now) next = { phase: 'Reduction', at: reductionStart };
  } else if (decision.phase === 'preheat') {
    // A gap after preheat returns to normal until the selected reduction starts.
    if (preheatEnd > now && preheatEnd < reductionStart) next = { phase: 'Normal heating', at: preheatEnd };
    else if (reductionStart > now) next = { phase: 'Reduction', at: reductionStart };
  } else if (decision.phase === 'reduction') {
    // The active expiry follows the execution schedule, which may have shortened.
    const at = Number.isFinite(decision.expiresAt) ? decision.expiresAt : reductionEnd;
    if (at > now) next = { phase: 'Recovery', at };
  }
  if (!next) return display(planLabel, 'Awaiting plan update',
    `The previous schedule has no upcoming change. ${provenance}`);
  return display(nextLabel, `${next.phase} at ${plannedTime(next.at, now)}`,
    `${decision.plan.trial ? 'A bounded learning trial is planned. ' : ''}${provenance}`, next.at);
}

export function renderHomePlannedChange(document, status) {
  const row = document.getElementById('home-planned-change');
  if (!row) return;
  const display = homePlannedChange(status);
  for (const key of ['label', 'value']) {
    const node = document.getElementById(`home-plan-${key}`);
    if (node.textContent !== display[key]) node.textContent = display[key];
  }
  row.title = display.detail;
}
