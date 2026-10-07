import { randomUUID } from 'node:crypto';
import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';
import { chargingDiagnosticSessionId } from './session-diagnostics.js';
import { sharedChargingAssessment, advanceSharedAssessment, validSharedAssessment } from './shared-assessment.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, MAX_RUNS = 24;
const PROGRAMS = ['immediate', 'vehicle-schedule'];
const ACTIVE = ['armed', 'awaiting-vehicle-schedule', 'observing'];
const PHASES = [...ACTIVE, 'completed', 'finished', 'cancelled', 'interrupted'];
const finite = Number.isFinite;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => finite(value) && value >= 0 && value <= 100;
const targetPercent = value => percent(value) && value >= 1;
const capacity = value => finite(value) && value >= 1 && value <= 300;
const copy = value => structuredClone(value);
const allowed = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const active = run => ACTIVE.includes(run.phase);
const field = (charger, name) => charger?.values?.[name]?.available === true ? charger.values[name].value : null;
const connected = charger => field(charger, 'connected');
const feedAvailable = feed => (feed?.setup?.available ?? feed?.reception?.available) === true;
const fresh = (snapshot, now) => snapshot?.online === true && time(snapshot.readAt)
  && snapshot.readAt <= now && now - snapshot.readAt <= MINUTE;
const sample = (charger, name, since, now) => {
  const reading = charger?.values?.[name], at = reading?.measuredAt ?? reading?.receivedAt;
  return reading?.available === true && !reading.assumed && !reading.retained
    && ['bmw-cardata', 'teslamate'].includes(reading.source)
    && time(at) && at >= since && at <= now && now - at <= 10 * MINUTE ? reading : null;
};
const physicalSession = charger => charger?.request?.sessionId ?? null;
const backend = charger => charger?.control?.snapshot?.transport ?? charger?.provider ?? null;
const periods = charger => (charger?.plan?.periods ?? []).filter(row => time(row.startAt)
  && (row.endAt === null || time(row.endAt) && row.endAt > row.startAt))
  .map(row => ({ startAt: row.startAt, endAt: row.endAt }));
const planSummary = (charger, now) => ({ at: now, reason: charger.plan.reason ?? null,
  deadlineAt: charger.plan.deadlineAt ?? charger.request?.deadlineAt ?? charger.deadlineAt ?? null,
  periods: periods(charger), soc: field(charger, 'soc'), socSource: charger.values?.soc?.source ?? null,
  minimumSoc: field(charger, 'minimumSoc'), capacityKwh: field(charger, 'capacityKwh'),
  feasible: typeof charger.plan.feasible === 'boolean' ? charger.plan.feasible : null });

function validateInput(input, arming = false) {
  if (!object(input)) throw new Error('Guided test preparation must be an object.');
  const keys = ['chargerId', 'vehicleId', 'program', 'association', 'soc', 'nativeTargetSoc', 'capacityKwh', 'prepared', 'vehicleStartAt'];
  const unknown = Object.keys(input).find(key => !keys.includes(key));
  if (unknown !== undefined) throw new Error(`Unsupported guided test preparation field: ${unknown || '(empty)'}.`);
  if (!['charger1', 'charger2'].includes(input.chargerId)) throw new Error('Select a physical charger for this assessment.');
  if (!['bmw', 'tesla'].includes(input.vehicleId)) throw new Error('Select BMW or Tesla for this assessment.');
  if (!PROGRAMS.includes(input.program)) throw new Error('Choose Normal charging or Vehicle waits for its schedule.');
  if (input.association !== undefined && (typeof input.association !== 'string' || !input.association.length)
    || arming && !input.association) throw new Error('Select the current physical charger again before arming the assessment.');
  if (input.soc != null && !percent(input.soc)) throw new Error('Current battery percentage must be a number from 0 to 100%.');
  if (arming && input.soc == null) throw new Error('Enter the current battery percentage.');
  if (input.nativeTargetSoc != null && !targetPercent(input.nativeTargetSoc)) throw new Error('Vehicle charge target must be a number from 1 to 100%.');
  if (arming && input.nativeTargetSoc == null) throw new Error('Enter the charge target currently set in the vehicle.');
  if (input.capacityKwh != null && !capacity(input.capacityKwh)) throw new Error('Usable battery capacity must be a number from 1 to 300 kWh; decimal values are accepted.');
  if (arming && input.capacityKwh == null) throw new Error('Enter the usable battery capacity in kWh.');
  if (input.prepared !== undefined && typeof input.prepared !== 'boolean') throw new Error('Preparation confirmation must be true or false.');
  if (arming && input.prepared !== true) throw new Error('Confirm that you checked the vehicle settings and preparation values before arming.');
  if (input.vehicleStartAt != null && !time(input.vehicleStartAt)) throw new Error('The start time recorded from the vehicle must be a valid date and time.');
  if (input.program === 'immediate' && input.vehicleStartAt != null) throw new Error('Remove the vehicle start time for the Normal charging test, or choose Vehicle waits for its schedule.');
  if (arming && input.program === 'vehicle-schedule' && input.vehicleStartAt == null) throw new Error('Record the initial start time set in the vehicle before arming the delayed test.');
}

function headroom(input, charger) {
  const capacityKwh = input.capacityKwh;
  const forecastPower = charger?.forecast?.powerKw;
  const plannedVoltage = charger?.forecast?.voltageV;
  const voltage = plannedVoltage >= 200 && plannedVoltage <= 250 ? plannedVoltage
    : charger?.id === 'charger1' ? field(charger, 'voltageV') : null;
  const limits = ['maximumCurrentA', 'vehicleCurrentA', 'nativeCurrentA'].map(name => field(charger, name))
    .filter(value => finite(value) && value > 0);
  const powerKw = forecastPower > 0 ? forecastPower : limits.length && voltage >= 200 && voltage <= 250
    ? 3 * voltage * Math.min(...limits) / 1000 : null;
  const gridKwh = capacityKwh > 0 && percent(input.soc) && percent(input.nativeTargetSoc)
    ? capacityKwh * Math.max(0, input.nativeTargetSoc - input.soc) / 100 / CHARGING_EFFICIENCY : null;
  const minutes = gridKwh !== null && powerKw > 0 ? gridKwh / powerKw * 60 : null;
  const minimumMinutes = input.program === 'immediate' ? 30 : 60;
  return { capacityKwh: capacityKwh > 0 ? capacityKwh : null, powerKw, gridKwh, minutes, minimumMinutes,
    adequate: minutes === null ? null : minutes >= minimumMinutes, declaredSoc: percent(input.soc) ? input.soc : null,
    basis: 'accepted-capacity-and-expected-power' };
}

/** Use the ordinary session's remaining-energy model only within its original
 * connection and accepted target/capacity. Preparation remains a frozen record;
 * a missing or mismatched live model falls back to the accepted initial inputs. */
function remainingEstimate(run, charger, now) {
  const fallback = headroom({ ...run.expectations, program: run.program }, charger);
  const estimate = { ...fallback, powerKw: fallback.powerKw ?? run.headroom.powerKw,
    basis: 'accepted-preparation-inputs' };
  if (physicalSession(charger) !== run.sessionId || connected(charger) !== true
    || !fresh(charger.control?.snapshot, now)
    || field(charger, 'minimumSoc') !== run.expectations.nativeTargetSoc
    || field(charger, 'capacityKwh') !== run.expectations.capacityKwh) return estimate;
  const required = charger.requiredGridKwh, progress = charger.progress;
  const gridForSoc = soc => run.expectations.capacityKwh * Math.max(0, run.expectations.nativeTargetSoc - soc) / 100 / CHARGING_EFFICIENCY;
  const agrees = (a, b) => finite(a) && a >= 0 && finite(b) && Math.abs(a - b) <= 1e-6;
  if (progress) {
    // The normal progress model credits only recorded energy and retains its
    // reference clock across gaps. Partial coverage supplies partial credit;
    // it never gives energy to the unobserved portion of the connection.
    if (time(progress.connectionAt) && progress.connectionAt >= run.connectedAt && progress.connectionAt <= now
      && time(progress.anchorAt) && progress.anchorAt >= progress.connectionAt && progress.anchorAt <= now
      && ['tracking', 'awaiting-recorded-energy'].includes(progress.basis?.status)
      && ['soc', 'recorded-charger-energy'].includes(progress.basis?.source)
      && percent(progress.estimatedSoc) && agrees(progress.remainingGridKwh, gridForSoc(progress.estimatedSoc))
      && (required == null || agrees(required, progress.remainingGridKwh)))
      return { ...estimate, gridKwh: progress.remainingGridKwh, basis: 'current-session-progress' };
    // An explicitly inconsistent/stale progress object cannot be bypassed by
    // treating its companion requiredGridKwh scalar as independent evidence.
    return estimate;
  }
  const soc = charger.values?.soc, socAt = soc?.measuredAt ?? soc?.receivedAt;
  const applicableSoc = soc?.source === 'session-anchor' && socAt >= run.createdAt
    || ['bmw-cardata', 'teslamate'].includes(soc?.source) && socAt >= run.connectedAt
      && charger.vehicle?.state === 'identified' && charger.vehicle.id === run.vehicleId
      && charger.vehicle.sessionId === run.sessionId;
  if (soc?.available === true && !soc.assumed && !soc.retained && percent(soc.value)
    && time(socAt) && socAt <= now && applicableSoc && agrees(required, gridForSoc(soc.value)))
    return { ...estimate, gridKwh: required, basis: 'current-session-progress' };
  return estimate;
}

/** Recommend a user-operated timer from the production plan only. This helper
 * never calls the planner and never produces or installs a charger schedule. */
function expectedOpportunity(charger, estimate, startAt, deadlineAt) {
  let remaining = estimate?.gridKwh, finishAt = null;
  const used = [];
  if (!(remaining > 0) || !(estimate.powerKw > 0) || !time(deadlineAt))
    return { feasible: false, finishAt, used };
  const slices = charger.plan?.allocations;
  if (!Array.isArray(slices) || slices.some(row => !finite(row?.start) || !finite(row?.end)
    || row.end <= row.start || !finite(row.powerKw) || row.powerKw < 0)) return { feasible: false, finishAt, used };
  const ordered = [...slices].sort((a, b) => a.start - b.start);
  if (ordered.some((row, index) => index > 0 && row.start < ordered[index - 1].end))
    return { feasible: false, finishAt, used };
  for (const period of periods(charger)) {
    const start = Math.max(startAt, period.startAt), end = Math.min(period.endAt ?? deadlineAt, deadlineAt);
    if (end <= start) continue;
    // Exact shared allocation slices are the opportunity evidence. A broad
    // interval's peak or a whole-session average is not continuous power.
    const allocations = ordered.filter(row => row.end > start && row.start < end);
    const slots = allocations.map(row => ({ start: Math.max(start, row.start),
      end: Math.min(end, row.end), powerKw: row.powerKw }));
    for (const slot of slots.sort((a, b) => a.start - b.start)) {
      if (!(slot.powerKw > 0) || slot.end <= slot.start) continue;
      const duration = Math.min(slot.end - slot.start, remaining / slot.powerKw * HOUR);
      if (!used.includes(period.startAt)) used.push(period.startAt);
      remaining -= duration / HOUR * slot.powerKw;
      if (remaining <= 1e-6) { finishAt = Math.ceil(slot.start + duration); return { feasible: true, finishAt, used }; }
    }
  }
  return { feasible: false, finishAt, used };
}

function recommendation(charger, estimate, now) {
  const rows = periods(charger), deadlineAt = charger?.request?.deadlineAt ?? charger?.plan?.deadlineAt ?? null;
  const baselineStartAt = rows[0]?.startAt ?? null;
  const base = { state: 'waiting-for-plan', startAt: null, baselineStartAt, deadlineAt,
    estimatedFinishAt: null, readinessRisk: false, periodCount: rows.length, coverageOpportunities: [] };
  if (!rows.length) return { ...base, message: 'Connect with the vehicle timer already blocking immediate charging. A suggestion will use the real charging plan when it is available.' };
  if (estimate.basis === 'current-session-progress' && estimate.gridKwh === 0)
    return { ...base, state: 'unavailable', message: 'The current session estimates no charging remains to the accepted vehicle target. Keep the recorded schedule and wait for observed vehicle completion before unplugging.' };
  // Arrange the vehicle's native timer around existing economic periods. Prefer
  // leaving some initial charging before a real pause/resume, while preserving
  // enough planned opportunity for the declared native target. The normal
  // controller remains free to revise its plan after identification.
  const earliest = Math.ceil(Math.max(now + 15 * MINUTE, baselineStartAt + 15 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE;
  const knownTimer = field(charger, 'vehicleNotBefore');
  const incorporatedTimer = time(knownTimer) && knownTimer >= now + 5 * MINUTE && baselineStartAt >= knownTimer;
  const times = [...new Set([earliest, ...(incorporatedTimer ? [knownTimer] : []), ...rows.map(row => row.startAt),
    ...rows.filter(row => time(row.endAt)).map(row => Math.floor((row.endAt - 15 * MINUTE) / (5 * MINUTE)) * 5 * MINUTE)])]
    .filter(at => (at >= earliest || incorporatedTimer && at === knownTimer) && at <= now + 48 * HOUR);
  const candidates = times.map(startAt => ({ startAt, ...expectedOpportunity(charger, estimate, startAt, deadlineAt) }))
    .filter(row => row.feasible).sort((a, b) => b.used.length - a.used.length || a.finishAt - b.finishAt || a.startAt - b.startAt);
  if (!candidates.length) return { ...base, state: 'unavailable', readinessRisk: true,
    message: 'The real plan does not leave enough charging opportunity after a useful delay. Use the normal test or wait for a more suitable session; keep the charging plan and ready-by unchanged.' };
  const best = candidates[0];
  const coverageOpportunities = ['delayed-start', ...(charger.vehicle?.state !== 'identified' ? ['late-identification'] : []),
    ...(best.used.length > 1 ? ['pause-and-resume'] : []),
    ...(field(charger, 'soc') !== null && field(charger, 'soc') !== estimate.declaredSoc ? ['input-reassessment'] : [])];
  return { ...base, state: 'available', startAt: best.startAt, estimatedFinishAt: best.finishAt, coverageOpportunities,
    message: (incorporatedTimer && best.startAt === knownTimer
      ? 'The real plan already includes this reported vehicle timer. Keep it and confirm it here; an earlier unidentified plan was not established by this observation. '
      : 'Set the vehicle start to this time, then confirm it here. ')
      + (estimate.basis === 'current-session-progress'
        ? 'This uses the current session’s remaining-energy estimate. ' : 'This uses the accepted preparation battery values. ')
      + 'It leaves estimated room for the vehicle target within the real plan. The controller may revise that plan after identification; coverage and finish time are not guaranteed.' };
}

export function validateChargingPhysicalTestState(saved) {
  const keys = ['id', 'chargerId', 'vehicleId', 'program', 'association', 'backend', 'phase', 'createdAt', 'updatedAt',
    'expiresAt', 'endedAt', 'endReason', 'sessionId', 'connectedAt', 'expectations', 'headroom', 'recommendation', 'milestones',
    'findings', 'initialPlan', 'latestPlan', 'deadlineAt', 'schedule', 'target', 'restorationReminder', 'report', 'lastSeenAt', 'shared'];
  if (!allowed(saved, ['version', 'runs']) || saved.version !== 2 || !Array.isArray(saved.runs) || saved.runs.length > MAX_RUNS)
    throw new Error('Unsupported physical charging test state; start a fresh development database.');
  for (const run of saved.runs) {
    if (!allowed(run, keys) || typeof run.id !== 'string' || !run.id.length
      || !['charger1', 'charger2'].includes(run.chargerId) || !['bmw', 'tesla'].includes(run.vehicleId)
      || !PROGRAMS.includes(run.program) || !PHASES.includes(run.phase) || typeof run.association !== 'string'
      || !run.association.length || typeof run.backend !== 'string' || !time(run.createdAt) || !time(run.updatedAt)
      || !time(run.expiresAt) || run.expiresAt !== run.createdAt + 24 * HOUR
      || run.endedAt !== null && !time(run.endedAt) || run.sessionId !== null && typeof run.sessionId !== 'string'
      || run.connectedAt !== null && !time(run.connectedAt)
      || !allowed(run.expectations, ['soc', 'nativeTargetSoc', 'capacityKwh', 'vehicleStartAt'])
      || !percent(run.expectations.soc) || !targetPercent(run.expectations.nativeTargetSoc) || !capacity(run.expectations.capacityKwh)
      || run.expectations.vehicleStartAt !== null && !time(run.expectations.vehicleStartAt)
      || !allowed(run.schedule, ['startAt', 'confirmedAt', 'history'])
      || run.schedule.startAt !== null && !time(run.schedule.startAt)
      || run.schedule.confirmedAt !== null && !time(run.schedule.confirmedAt)
      || !Array.isArray(run.schedule.history) || run.schedule.history.length > 64
      || run.schedule.history.some(row => !allowed(row, ['startAt', 'confirmedAt', 'source'])
        || !time(row.startAt) || !time(row.confirmedAt) || row.source !== 'user-confirmed')
      || run.schedule.history.length > 0 && (run.schedule.history.at(-1).startAt !== run.schedule.startAt
        || run.schedule.history.at(-1).confirmedAt !== run.schedule.confirmedAt)
      || run.schedule.history.length === 0 && (run.schedule.confirmedAt !== null
        || run.schedule.startAt !== run.expectations.vehicleStartAt)
      || run.program === 'immediate' && (run.expectations.vehicleStartAt !== null || run.schedule.history.length > 0)
      || run.program === 'vehicle-schedule' && !time(run.expectations.vehicleStartAt)
      || !allowed(run.target, ['reportedSoc', 'reportedAt', 'source', 'revision', 'requiresConfirmation', 'history', 'verifications'])
      || run.target.reportedSoc !== null && !percent(run.target.reportedSoc)
      || run.target.reportedAt !== null && !time(run.target.reportedAt)
      || !Number.isSafeInteger(run.target.revision) || run.target.revision < 1
      || ![null, 'bmw-cardata', 'teslamate'].includes(run.target.source)
      || typeof run.target.requiresConfirmation !== 'boolean'
      || !Array.isArray(run.target.history) || !run.target.history.length || run.target.history.length > 64
      || run.target.history.some(row => !allowed(row, ['targetSoc', 'confirmedAt']) || !targetPercent(row.targetSoc) || !time(row.confirmedAt))
      || run.target.history.at(-1).targetSoc !== run.expectations.nativeTargetSoc
      || run.target.verifications !== undefined && (!Array.isArray(run.target.verifications) || run.target.verifications.length > 64
        || run.target.verifications.some(row => !allowed(row, ['targetSoc', 'reportedSoc', 'source', 'reportedAt', 'confirmedAt'])
          || !targetPercent(row.targetSoc) || row.targetSoc !== run.expectations.nativeTargetSoc
          || !percent(row.reportedSoc) || row.reportedSoc === row.targetSoc
          || !['bmw-cardata', 'teslamate'].includes(row.source)
          || row.reportedAt !== null && (!time(row.reportedAt) || row.reportedAt > row.confirmedAt)
          || !time(row.confirmedAt) || !run.sessionId || !time(run.connectedAt)
          || row.confirmedAt < run.connectedAt || row.confirmedAt > run.updatedAt
          || run.endedAt !== null && row.confirmedAt > run.endedAt))
      || run.shared !== undefined && !validSharedAssessment(run.shared)
      || !object(run.milestones) || !Array.isArray(run.findings) || run.findings.length > 32
      || !allowed(run.headroom, ['capacityKwh', 'powerKw', 'gridKwh', 'minutes', 'minimumMinutes', 'adequate', 'declaredSoc', 'basis'])
      || ![30, 60].includes(run.headroom.minimumMinutes)
      || ![true, false, null].includes(run.headroom.adequate)
      || ['capacityKwh', 'powerKw', 'gridKwh', 'minutes'].some(key => run.headroom[key] !== null && !(finite(run.headroom[key]) && run.headroom[key] >= 0))
      || !allowed(run.recommendation, ['state', 'startAt', 'baselineStartAt', 'deadlineAt', 'estimatedFinishAt', 'readinessRisk', 'periodCount', 'coverageOpportunities', 'message'])
      || !['waiting-for-plan', 'available', 'unavailable'].includes(run.recommendation.state)
      || !Array.isArray(run.recommendation.coverageOpportunities)
      || run.recommendation.coverageOpportunities.some(value => !['delayed-start', 'late-identification', 'pause-and-resume', 'input-reassessment'].includes(value))
      || !allowed(run.milestones, ['connection', 'identification', 'initialPlan', 'identifiedPlanningInputs', 'chargingStarted',
        'chargingAfterDelay', 'vehicleTarget', 'deadline', 'completion', 'vehicleSchedule'])
      || Object.values(run.milestones).some(row => !allowed(row, ['at', 'connectedAt', 'source', 'state', 'startAt', 'targetSoc']) || !time(row.at)
        || row.targetSoc !== undefined && !targetPercent(row.targetSoc))
      || run.findings.some(row => !allowed(row, ['code', 'at']) || typeof row.code !== 'string' || !time(row.at)))
      throw new Error('Unsupported physical charging test state; start a fresh development database.');
  }
  const running = saved.runs.filter(active);
  if (new Set(saved.runs.map(run => run.id)).size !== saved.runs.length
    || new Set(running.map(run => run.chargerId)).size !== running.length
    || new Set(running.map(run => run.vehicleId)).size !== running.length)
    throw new Error('Unsupported physical charging test state; start a fresh development database.');
}

/** Durable observer only: constructor accepts storage and a clock, never an
 * actuator, planner, runtime setter, vehicle capture or command callback. All
 * guided inputs remain assessment assumptions and never become charger settings,
 * production planning inputs, vehicle commands or identification evidence. */
export class ChargingPhysicalTests {
  constructor({ store, key = 'charging:physical-tests', clock = Date.now }) {
    Object.assign(this, { store, key, clock });
    const saved = store.getState(key);
    if (saved !== undefined && saved !== null) validateChargingPhysicalTestState(saved);
    this.state = saved == null ? { version: 2, runs: [] } : copy(saved);
  }

  status() { return copy(this.state); }

  transaction(work) {
    const before = copy(this.state);
    try {
      const result = work();
      if (JSON.stringify(before) !== JSON.stringify(this.state)) this.store.setState(this.key, copy(this.state));
      return copy(result);
    } catch (error) { this.state = before; throw error; }
  }

  preview(input, view) {
    validateInput(input);
    const now = this.clock(), charger = view.chargers?.find(row => row.id === input.chargerId);
    const feed = view.vehicleFeeds?.find(row => row.id === input.vehicleId), snapshot = charger?.control?.snapshot;
    const estimate = headroom(input, charger), gates = [];
    const gate = (code, ready, message) => gates.push({ code, state: ready ? 'ready' : 'blocked', message });
    gate('charger', Boolean(charger?.association) && (!input.association || input.association === charger.association), 'Select the current physical charger.');
    gate('unplugged', fresh(snapshot, now) && connected(charger) === false, 'Unplug the vehicle first so the test can follow one new connection.');
    gate('control-ready', fresh(snapshot, now) && charger?.capabilities?.scheduling === true
      && snapshot.controlReady !== false && !snapshot.faulted && !snapshot.authorizationBlocked
      && !['Faulted', 'Unavailable', 'Reserved'].includes(snapshot.connectorStatus), 'The charger must be online, ready and commissioned for control.');
    gate('automatic', charger?.controls?.enabled === true && !charger?.request?.chargeNow, 'Enable Automatic charging and turn Charge now off.');
    gate('native-restrictions', Boolean(charger) && !charger.control?.manual && !snapshot?.manualStop && !snapshot?.stopped
      && snapshot?.enabled !== false && !snapshot?.nativeScheduleActive
      && !(snapshot?.schedule?.enabled && !['none', 'disabled'].includes(snapshot.schedule.enabled)),
    'Remove a charger-side timer or manual Stop before the test. Vehicle timers are configured separately.');
    gate('vehicle-feed', feedAvailable(feed) && (!feed.usedByChargerId || feed.usedByChargerId === input.chargerId),
      'A live, healthy vehicle feed is needed to assess identification and battery readings.');
    gate('unused', !this.state.runs.some(run => active(run) && (run.chargerId === input.chargerId || run.vehicleId === input.vehicleId)),
      'End the existing guided test for this vehicle or charger first.');
    gate('declarations', percent(input.soc) && percent(input.nativeTargetSoc) && input.nativeTargetSoc > input.soc && capacity(input.capacityKwh),
      'Verify the current battery percentage, the higher charge target set in the vehicle, and usable battery capacity.');
    gate('headroom', estimate.adequate === true, estimate.minutes === null
      ? 'Charging headroom cannot be estimated until capacity, current and voltage are available.'
      : `Allow about ${estimate.minimumMinutes} minutes of active charging below the vehicle limit. Use a naturally suitable session; there is no need to charge to 100%.`);
    if (input.program === 'vehicle-schedule') gate('vehicle-timer', time(input.vehicleStartAt) && input.vehicleStartAt >= now + 15 * MINUTE
      && input.vehicleStartAt <= now + 48 * HOUR, 'Before plugging in, set a vehicle start at least 15 minutes ahead and within 48 hours. You can adjust it to the real plan after connecting.');
    return { chargerId: input.chargerId, vehicleId: input.vehicleId, program: input.program,
      eligible: gates.every(row => row.state === 'ready'), gates, headroom: estimate,
      recommendation: recommendation(charger, estimate, now) };
  }

  start(input, view) {
    validateInput(input, true);
    const preview = this.preview(input, view);
    if (!preview.eligible) throw new Error(preview.gates.filter(row => row.state === 'blocked').map(row => row.message).join(' '));
    const charger = view.chargers.find(row => row.id === input.chargerId), now = this.clock();
    return this.transaction(() => {
      const run = { id: randomUUID(), chargerId: input.chargerId, vehicleId: input.vehicleId, program: input.program,
        association: input.association, backend: backend(charger), phase: 'armed', createdAt: now, updatedAt: now,
        expiresAt: now + 24 * HOUR, endedAt: null, endReason: null, sessionId: null, connectedAt: null, lastSeenAt: null,
        expectations: { soc: input.soc, nativeTargetSoc: input.nativeTargetSoc, capacityKwh: input.capacityKwh,
          vehicleStartAt: input.program === 'vehicle-schedule' ? input.vehicleStartAt : null },
        headroom: preview.headroom, recommendation: preview.recommendation, milestones: {}, findings: [],
        initialPlan: null, latestPlan: null, deadlineAt: null, report: null,
        shared: advanceSharedAssessment(null, sharedChargingAssessment(view.chargers, view.coordination, now)),
        schedule: { startAt: input.program === 'vehicle-schedule' ? input.vehicleStartAt : null, confirmedAt: null, history: [] },
        target: { reportedSoc: null, reportedAt: null, source: null, revision: 1, requiresConfirmation: false,
          history: [{ targetSoc: input.nativeTargetSoc, confirmedAt: now }] },
        restorationReminder: input.program === 'vehicle-schedule'
          ? 'Restore or remove the temporary vehicle schedule yourself when the test ends. The controller cannot change it.' : null };
      const running = this.state.runs.filter(active), completed = this.state.runs.filter(row => !active(row));
      this.state.runs = [run, ...running, ...completed.slice(0, MAX_RUNS - running.length - 1)];
      return run;
    });
  }

  scoped(input, view, keys) {
    if (!allowed(input, keys) || typeof input.id !== 'string' || typeof input.association !== 'string')
      throw new Error('Invalid physical charging test action.');
    const run = this.state.runs.find(row => row.id === input.id);
    if (!run || !active(run) || run.association !== input.association)
      throw new Error('The guided test changed; refresh before continuing.');
    const charger = view.chargers?.find(row => row.id === run.chargerId);
    if (!charger || charger.association !== run.association || charger.control?.snapshot && backend(charger) !== run.backend)
      throw new Error('The charger changed; refresh before continuing.');
    return { run, charger };
  }

  confirmSchedule(input, view) {
    const { run, charger } = this.scoped(input, view, ['id', 'association', 'sessionId', 'startAt']);
    const now = this.clock();
    if (run.program !== 'vehicle-schedule' || !run.sessionId || input.sessionId !== run.sessionId
      || physicalSession(charger) !== run.sessionId || connected(charger) !== true || !fresh(charger.control?.snapshot, now))
      throw new Error('Connect the selected vehicle to the same charger before confirming its timer.');
    if (!time(input.startAt) || input.startAt < now + 5 * MINUTE || input.startAt > now + 48 * HOUR)
      throw new Error('Choose a future vehicle start within 48 hours.');
    const estimate = remainingEstimate(run, charger, now), proposed = recommendation(charger, estimate, now);
    if (estimate.basis === 'current-session-progress' && estimate.gridKwh === 0)
      throw new Error('No further vehicle timer adjustment is needed for the estimated remaining charge. Wait for observed vehicle completion, then unplug.');
    const knownTimer = field(charger, 'vehicleNotBefore');
    // Tesla can report the user-applied timer before the confirmation reaches
    // us. The production plan then legitimately starts at that same timer. Do
    // not demand another later start and create an endless adjustment loop.
    const incorporatedTimer = time(knownTimer) && knownTimer === input.startAt
      && proposed.baselineStartAt >= knownTimer;
    const originalStart = run.initialPlan?.periods?.[0]?.startAt;
    if (proposed.state !== 'available' || !incorporatedTimer
      && input.startAt <= (originalStart ?? proposed.baselineStartAt))
      throw new Error('Wait for a real charging plan, then choose a vehicle start later than its first period.');
    if (!expectedOpportunity(charger, estimate, input.startAt, run.deadlineAt).feasible)
      throw new Error('This vehicle start leaves insufficient charging opportunity in the real plan. Choose the suggested time or use a normal test.');
    return this.transaction(() => {
      run.schedule.startAt = input.startAt; run.schedule.confirmedAt = now;
      run.schedule.history = [...run.schedule.history, { startAt: input.startAt, confirmedAt: now, source: 'user-confirmed' }].slice(-64);
      run.phase = 'observing'; run.updatedAt = now;
      run.recommendation = proposed;
      run.milestones.vehicleSchedule = { at: now, startAt: input.startAt, source: 'user-confirmed' };
      return run;
    });
  }

  confirmTarget(input, view) {
    const { run, charger } = this.scoped(input, view, ['id', 'association', 'sessionId', 'targetRevision', 'nativeTargetSoc', 'verification']);
    const now = this.clock();
    if (!run.sessionId || input.sessionId !== run.sessionId || physicalSession(charger) !== run.sessionId
      || connected(charger) !== true || !fresh(charger.control?.snapshot, now)
      || !Number.isSafeInteger(input.targetRevision) || input.targetRevision !== run.target.revision)
      throw new Error('The assessment target or charging session changed; refresh before confirming the assessment assumption.');
    if (!targetPercent(input.nativeTargetSoc)) throw new Error('Vehicle charge target must be a number from 1 to 100%.');
    if (input.verification !== undefined && (!allowed(input.verification, ['reportedSoc', 'source'])
      || !percent(input.verification.reportedSoc) || !['bmw-cardata', 'teslamate'].includes(input.verification.source)))
      throw new Error('Explicit vehicle-target verification must identify the reported percentage and its vehicle source.');
    return this.transaction(() => {
      this.observeTarget(run, charger, view, now);
      if (input.verification && (input.verification.reportedSoc !== run.target.reportedSoc || input.verification.source !== run.target.source))
        throw new Error('The reported vehicle target changed. Review the new reading before verifying the setting in the car.');
      // These are explicit user verifications for the current target, not
      // device observations. Changing the target ends their scope, including
      // when a user later changes it back to a previously verified value.
      if (input.nativeTargetSoc !== run.expectations.nativeTargetSoc) delete run.target.verifications;
      run.expectations.nativeTargetSoc = input.nativeTargetSoc; run.target.revision++;
      run.target.history = [...run.target.history, { targetSoc: input.nativeTargetSoc, confirmedAt: now }].slice(-64);
      if (input.verification && input.nativeTargetSoc !== run.target.reportedSoc) {
        const verification = { targetSoc: input.nativeTargetSoc, reportedSoc: run.target.reportedSoc,
          source: run.target.source, reportedAt: run.target.reportedAt, confirmedAt: now };
        run.target.verifications = [...(run.target.verifications ?? []).filter(row => row.reportedSoc !== verification.reportedSoc
          || row.source !== verification.source), verification].slice(-64);
      }
      this.observeTarget(run, charger, view, now);
      if (run.program === 'vehicle-schedule') run.recommendation = recommendation(charger, remainingEstimate(run, charger, now), now);
      run.updatedAt = now;
      return run;
    });
  }

  cancel(input, view) {
    const { run } = this.scoped(input, view, ['id', 'association']);
    return this.transaction(() => { this.finish(run, 'cancelled', 'user-cancelled', this.clock()); return run; });
  }

  mark(run, name, at, detail = {}) {
    if (run.milestones[name]) return;
    run.milestones[name] = { at, ...detail }; run.updatedAt = at;
  }

  finding(run, code, at) {
    if (run.findings.some(row => row.code === code) || run.findings.length >= 32) return;
    run.findings.push({ code, at }); run.updatedAt = at;
  }

  finish(run, phase, reason, now) {
    run.phase = phase; run.endReason = reason; run.endedAt = now; run.updatedAt = now;
  }

  observeTarget(run, charger, view, now) {
    const feed = view.vehicleFeeds?.find(row => row.id === run.vehicleId);
    const reading = charger.values?.vehicleCeilingSoc;
    const observedAt = reading?.measuredAt ?? reading?.receivedAt;
    // A target is a held device setting: its original clock need not belong to
    // this connection, but only the independently identified vehicle's healthy
    // current feed can provide it. Missing evidence never clears a known conflict.
    if (charger.vehicle?.state === 'identified' && charger.vehicle.id === run.vehicleId
      && charger.vehicle.sessionId === run.sessionId && feedAvailable(feed)
      && reading?.available === true && !reading.assumed && percent(reading.value)
      && ['bmw-cardata', 'teslamate'].includes(reading.source)
      && (observedAt == null || time(observedAt) && observedAt <= now)) {
      run.target.reportedSoc = reading.value;
      run.target.reportedAt = observedAt ?? null;
      run.target.source = reading.source;
    }
    const reportedConflict = percent(run.target.reportedSoc) && run.target.reportedSoc !== run.expectations.nativeTargetSoc;
    // A known repeated report may remain contrary to the user's explicit check
    // in the car. Keep that raw report and clock visible without requesting the
    // same check again solely because the feed republishes it with a new clock.
    const verified = run.target.verifications?.some(row => row.targetSoc === run.expectations.nativeTargetSoc
      && row.reportedSoc === run.target.reportedSoc && row.source === run.target.source) === true;
    run.target.requiresConfirmation = reportedConflict && !verified;
    if (reportedConflict) this.finding(run, 'vehicle-limit-differs-from-preparation', now);
  }

  update(view, now = this.clock()) {
    if (!time(now)) throw new Error('Charging tests require a numeric UTC observation time.');
    return this.transaction(() => {
      for (const run of this.state.runs.filter(active)) {
        const charger = view.chargers?.find(row => row.id === run.chargerId);
        if (!charger || charger.association !== run.association) {
          this.finish(run, 'interrupted', 'equipment-changed', now); continue;
        }
        // At startup a controller may not yet exist. Missing readback is unknown,
        // never a disconnection or backend change and never grounds to attach a run.
        if (run.phase === 'armed' && now > run.expiresAt
          && !(connected(charger) === true && time(charger.control?.session?.connectedAt)
            && charger.control.session.connectedAt >= run.createdAt && charger.control.session.connectedAt <= run.expiresAt)) {
          this.finish(run, 'finished', 'preparation-expired', now); continue;
        }
        if (!fresh(charger.control?.snapshot, now)) continue;
        if (backend(charger) !== run.backend) { this.finish(run, 'interrupted', 'backend-changed', now); continue; }
        if (run.lastSeenAt !== null && now - run.lastSeenAt > 5 * MINUTE) this.finding(run, 'observation-gap', now);
        if (run.lastSeenAt === null || now - run.lastSeenAt >= MINUTE) run.lastSeenAt = now;
        const connection = connected(charger), sessionId = physicalSession(charger);
        if (run.phase === 'armed') {
          if (connection !== true || !sessionId) continue;
          const connectedAt = charger.control.session?.connectedAt;
          if (!time(connectedAt) || connectedAt < run.createdAt || connectedAt > now) {
            this.finish(run, 'interrupted', 'fresh-connection-not-observed', now); continue;
          }
          run.connectedAt = connectedAt; run.sessionId = sessionId;
          run.deadlineAt = charger.request?.deadlineAt ?? charger.deadlineAt ?? null;
          run.phase = run.program === 'vehicle-schedule' ? 'awaiting-vehicle-schedule' : 'observing';
          this.mark(run, 'connection', now, { connectedAt });
        }
        if (connection === false) { this.finish(run, 'finished', 'unplugged-before-completion', now); continue; }
        if (sessionId && sessionId !== run.sessionId) { this.finish(run, 'interrupted', 'physical-session-changed', now); continue; }
        if (connection !== true || sessionId !== run.sessionId) continue;
        this.observeRun(run, charger, view, now);
      }
      return this.state;
    });
  }

  observeRun(run, charger, view, now) {
    run.shared = advanceSharedAssessment(run.shared, sharedChargingAssessment(view.chargers, view.coordination, now));
    if (run.shared.current.priority === 'inconsistent') this.finding(run, 'shared-priority-mismatch', now);
    if ([run.shared.current.proposed.state, run.shared.current.adopted.state].includes('inconsistent'))
      this.finding(run, 'shared-allocation-inconsistent', now);
    if (run.shared.current.execution.state === 'inconsistent') this.finding(run, 'shared-current-mismatch', now);
    const identified = charger.vehicle?.state === 'identified' && charger.vehicle.sessionId === run.sessionId;
    if (identified && charger.vehicle.id !== run.vehicleId) this.finding(run, 'wrong-vehicle-identified', now);
    if (identified && charger.vehicle.id === run.vehicleId && !run.milestones.identification) {
      // Judge the first observed identity against the schedule recorded then.
      // A later timer adjustment cannot turn held identity into a new early
      // identification event or rewrite the original coverage outcome.
      this.mark(run, 'identification', now, { source: 'production-matcher',
        ...(run.program === 'vehicle-schedule' ? { startAt: run.schedule.startAt } : {}) });
      if (run.program === 'vehicle-schedule' && now < run.schedule.startAt)
        this.finding(run, 'identified-before-vehicle-start', now);
    }
    if (charger.identification?.phase === 'inconclusive') this.finding(run, 'identification-inconclusive', now);
    if (charger.controls?.enabled !== true || charger.request?.chargeNow || charger.control?.manual)
      this.finding(run, 'normal-controls-changed', now);
    if (time(run.deadlineAt) && time(charger.request?.deadlineAt) && charger.request.deadlineAt !== run.deadlineAt)
      this.finding(run, 'ready-by-changed', now);
    if (periods(charger).length) {
      const plan = planSummary(charger, now);
      if (!run.initialPlan) {
        run.initialPlan = plan; this.mark(run, 'initialPlan', now, { source: 'production-planner' });
      }
      const comparable = value => value ? JSON.stringify({ ...value, at: null }) : null;
      if (comparable(plan) !== comparable(run.latestPlan)) { run.latestPlan = plan; run.updatedAt = now; }
      // The live plan and input snapshot show reassessment; a different set of
      // periods is not required, and this does not prove commands took effect.
      if (identified && charger.vehicle.id === run.vehicleId
        && !['manual-fallback', 'session-anchor'].includes(plan.socSource))
        this.mark(run, 'identifiedPlanningInputs', now, { source: 'production-inputs' });
      if (run.program === 'vehicle-schedule')
        run.recommendation = recommendation(charger, remainingEstimate(run, charger, now), now);
    }
    const meter = charger.values?.powerKw, meterAt = meter?.measuredAt ?? meter?.receivedAt;
    const power = meter?.available === true && meter.assumed !== true && meter.retained !== true
      && finite(meter.value) && meter.value >= 0 && time(meterAt) && meterAt >= run.connectedAt
      && meterAt <= now && now - meterAt <= 2 * MINUTE ? meter.value : null;
    // Charger state-machine pulses are reported separately from actual draw.
    // Only fresh, measured power within this physical session can exercise a
    // charging milestone; polling a held or replayed value cannot refresh it.
    const charging = power !== null && power > .1;
    if (charging) {
      this.mark(run, 'chargingStarted', now, { source: 'physical-charger' });
      if (run.program === 'vehicle-schedule') {
        if (now < run.schedule.startAt) this.finding(run, 'charging-before-vehicle-start', now);
        else this.mark(run, 'chargingAfterDelay', now, { source: 'physical-charger' });
      }
    }
    const feed = view.vehicleFeeds?.find(row => row.id === run.vehicleId);
    const soc = identified && charger.vehicle.id === run.vehicleId && feedAvailable(feed)
      ? sample(charger, 'soc', run.connectedAt, now) : null;
    this.observeTarget(run, charger, view, now);
    if (soc && !run.target.requiresConfirmation && soc.value >= run.expectations.nativeTargetSoc
      && run.milestones.vehicleTarget?.targetSoc !== run.expectations.nativeTargetSoc) {
      run.milestones.vehicleTarget = { at: now, source: soc.source, targetSoc: run.expectations.nativeTargetSoc };
      run.updatedAt = now;
    }
    if (time(run.deadlineAt) && now >= run.deadlineAt) {
      const state = !run.target.requiresConfirmation && run.milestones.vehicleTarget?.at <= run.deadlineAt
        && run.milestones.vehicleTarget?.targetSoc === run.expectations.nativeTargetSoc
        ? 'target-observed-by-deadline' : 'not-confirmed-by-deadline';
      if (run.milestones.deadline?.targetSoc !== run.expectations.nativeTargetSoc)
        run.milestones.deadline = { at: now, state, targetSoc: run.expectations.nativeTargetSoc };
    }
    const entry = view.diagnostics?.chargers?.find(row => row.id === run.chargerId);
    const report = [entry?.current, ...(entry?.recent ?? [])].find(row => row?.id === chargingDiagnosticSessionId(charger));
    if (report) run.report = { id: report.id, behavior: report.behavior, outcome: copy(report.outcome), coverage: copy(report.coverage) };
    // Reaching the accepted vehicle target is never a stop instruction. A
    // different live limit must be reconciled explicitly, never silently used
    // as another assessment target.
    const stopped = power !== null && power <= .1;
    if (soc && soc.value >= run.expectations.nativeTargetSoc && !run.target.requiresConfirmation && stopped) {
      if (!run.milestones.chargingStarted) {
        this.finish(run, 'interrupted', 'target-without-observed-charging', now); return;
      }
      this.mark(run, 'completion', now, { source: 'vehicle-target-and-charger-stop', state: 'observed' });
      this.finish(run, 'completed', 'vehicle-target-and-stop-observed', now);
    }
  }
}
