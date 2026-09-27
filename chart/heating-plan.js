import { isReadOnlyReplica } from './replica-status.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'numeric', day: 'numeric' });
const plannedTime = (at, now) => day.format(at) === day.format(now) ? clock.format(at) : `${date.format(at)}, ${clock.format(at)}`;

/** Describe the chosen plan, never a candidate or an assumed end to recovery. */
export function homePlannedChange(status = {}) {
  const { now, decision = {} } = status;
  const display = (label, value, detail, at = null) => ({ label, value, detail, at });
  if (isReadOnlyReplica(status)) return display('Heating plan', 'Current plan unavailable',
    'Recorded history cannot establish the primary controller’s current plan.');
  if (status.input === 'offline') return display('Heating plan', 'Recorded history only',
    'No live device connection is open.');
  if (!Number.isFinite(now) || !decision.phase) return display('Heating plan', 'Waiting for a plan',
    'The controller has not reported a current heating plan.');

  const pauseUntil = status.override?.expiresAt;
  if (Number.isFinite(pauseUntil) && pauseUntil > now) return display('Price control paused', `Until ${plannedTime(pauseUntil, now)}`,
    'The controller will reassess the heating plan when the pause ends. Temporary heating selections return to their previous settings.', pauseUntil);
  if (status.mode === 'monitoring') return display('Heating plan', 'Monitoring only',
    'Automatic heating control is disabled.');

  const simulated = status.input === 'simulated';
  const shadow = !simulated && status.liveWrites !== true;
  const planLabel = simulated ? 'Simulation plan' : shadow ? 'Shadow plan' : 'Heating plan';
  const nextLabel = simulated ? 'Next simulated change' : shadow ? 'Next shadow change' : 'Next planned change';
  const provenance = simulated ? 'Simulation only; no commands are sent to the home.'
    : shadow ? 'This operating mode sends no automatic commands.'
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
