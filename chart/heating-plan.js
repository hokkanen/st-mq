import { isReadOnlyReplica } from './replica-status.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' });
const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'short' });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: 'numeric', day: 'numeric' });
const plannedTime = (at, now) => day.format(at) === day.format(now) ? clock.format(at) : `${date.format(at)}, ${clock.format(at)}`;

/** Show the next scheduled action, never permission status or a candidate plan. */
export function homePlannedChange(status = {}) {
  const { now, decision = {} } = status;
  const display = (label, value, detail, at = null) => ({ label, value, detail, at });
  if (isReadOnlyReplica(status)) {
    const saved = status.lastDecision?.payload ?? status.lastDecision ?? decision;
    const phase = { normal: 'Normal heating', reduction: 'Reduced heating', preheat: 'Preheat', recovery: 'Recovery' }[saved.phase ?? saved.action];
    return display('Recorded plan', phase ?? 'Unavailable', 'Saved decision from local history. This cannot establish the master’s current plan or the equipment’s current state.');
  }
  if (status.input === 'offline') return display('Recorded plan', 'Recorded history only',
    'No live device connection is open.');

  const simulated = status.input === 'simulated';
  const planLabel = simulated ? 'Simulated actions' : 'Planned actions';
  const provenance = simulated ? 'Simulation only; no commands are sent to the home.'
    : 'The controller rechecks the plan as conditions change.';
  if (!Number.isFinite(now)) return display(planLabel, 'Waiting for a plan',
    'The controller has not reported a current heating plan.');

  // Manual preheat and resuming Automatic have independent deadlines. Show the
  // first action even while automatic heating is paused or has no chosen plan.
  const hold = decision.manualHold;
  const manualPreheatEnd = hold?.phase === 'preheat' && Number.isFinite(hold.until) && hold.until > now ? hold.until : null;
  const pauseUntil = Number.isFinite(status.override?.expiresAt) && status.override.expiresAt > now ? status.override.expiresAt : null;
  if (manualPreheatEnd !== null && (pauseUntil === null || manualPreheatEnd <= pauseUntil)) return display(planLabel,
    `End preheat at ${plannedTime(manualPreheatEnd, now)}`,
    `The manual preheat boost is scheduled to end and its settings to be restored. ${pauseUntil !== null ? `Resume automatic at ${plannedTime(pauseUntil, now)}. ` : ''}${provenance}`, manualPreheatEnd);
  if (pauseUntil !== null) return display(planLabel, `Resume automatic at ${plannedTime(pauseUntil, now)}`,
    `Automatic heating will reassess the plan when it resumes. ${provenance}`, pauseUntil);
  if (status.automation?.home?.enabled === false) return display(planLabel, 'No actions scheduled',
    `Automatic heating is paused with no resume time. Explore possible heating plans without enabling them. ${provenance}`);
  if (!decision.phase) return display(planLabel, 'Waiting for a plan',
    'The controller has not reported a current heating plan.');

  if (decision.phase === 'recovery') return display(planLabel, 'Next action after recovery',
    `Normal heating demand has resumed while warmth recovers; recovery has no fixed end time. ${provenance}`);

  const schedule = decision.plan?.schedule;
  if (!schedule) return display(planLabel, decision.phase === 'normal' ? 'No actions scheduled' : 'Next action unavailable',
    `${decision.phase === 'normal' ? 'No upcoming heating change is scheduled.' : 'The controller has not reported the next heating action.'} ${provenance}`);
  const { preheatStart, preheatEnd, reductionStart, reductionEnd } = schedule;
  if (![preheatStart, preheatEnd, reductionStart, reductionEnd].every(Number.isFinite)
    || preheatStart > preheatEnd || preheatEnd > reductionStart || reductionStart >= reductionEnd) {
    return display(planLabel, 'Plan timing unavailable', 'The controller has not reported a usable schedule.');
  }

  let next;
  if (decision.phase === 'normal') {
    if (preheatStart > now && preheatEnd > preheatStart) next = { phase: 'Preheat', at: preheatStart };
    else if (reductionStart > now) next = { phase: 'Reduce heating', at: reductionStart };
  } else if (decision.phase === 'preheat') {
    // A gap after preheat returns to normal until the selected reduction starts.
    if (preheatEnd > now && preheatEnd < reductionStart) next = { phase: 'Normal heating', at: preheatEnd };
    else if (reductionStart > now) next = { phase: 'Reduce heating', at: reductionStart };
  } else if (decision.phase === 'reduction') {
    // The active expiry follows the execution schedule, which may have shortened.
    const at = Number.isFinite(decision.expiresAt) ? decision.expiresAt : reductionEnd;
    if (at > now) next = { phase: 'Recovery', at };
  }
  if (!next) return display(planLabel, 'Awaiting plan update',
    `The previous schedule has no upcoming change. ${provenance}`);
  return display(planLabel, `${next.phase} at ${plannedTime(next.at, now)}`,
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
  row.title = `${display.label}: ${display.value}. ${display.detail}`;
  row.setAttribute('aria-label', `${display.label}: ${display.value}. ${display.detail} Explore the heating plan and its limits`);
}
