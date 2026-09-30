import { randomUUID } from 'node:crypto';
import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';
import { chargingDiagnosticSessionId } from './session-diagnostics.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, MAX_RUNS = 24;
const PROGRAMS = ['immediate', 'vehicle-schedule'];
const ACTIVE = ['armed', 'awaiting-vehicle-schedule', 'observing'];
const PHASES = [...ACTIVE, 'completed', 'cancelled', 'interrupted'];
const finite = Number.isFinite;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => finite(value) && value >= 0 && value <= 100;
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
  if (!allowed(input, ['chargerId', 'vehicleId', 'program', 'association', 'soc', 'nativeTargetSoc', 'prepared', 'vehicleStartAt'])
    || !['charger1', 'charger2'].includes(input.chargerId) || !['bmw', 'tesla'].includes(input.vehicleId)
    || !PROGRAMS.includes(input.program)
    || input.soc != null && !percent(input.soc) || input.nativeTargetSoc != null && !percent(input.nativeTargetSoc)
    || input.prepared !== undefined && typeof input.prepared !== 'boolean'
    || input.association !== undefined && (typeof input.association !== 'string' || !input.association.length)
    || input.vehicleStartAt != null && !time(input.vehicleStartAt)
    || input.program === 'immediate' && input.vehicleStartAt != null
    || arming && (!percent(input.soc) || !percent(input.nativeTargetSoc) || input.prepared !== true || !input.association))
    throw new Error('Select a vehicle, charger and program, and confirm the current battery percentage and vehicle charge limit.');
}

function headroom(input, charger, view) {
  const capacityKwh = view.settings?.vehicles?.[input.vehicleId]?.capacityKwh;
  const forecastPower = charger?.forecast?.powerKw;
  const voltage = field(charger, 'voltageV');
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
    basis: 'configured-capacity-and-expected-power' };
}

/** Recommend a user-operated timer from the production plan only. This helper
 * never calls the planner and never produces or installs a charger schedule. */
function expectedOpportunity(charger, estimate, startAt, deadlineAt) {
  let remaining = estimate?.gridKwh, finishAt = null;
  const used = [];
  if (!(remaining > 0) || !(estimate.powerKw > 0) || !time(deadlineAt))
    return { feasible: false, finishAt, used };
  for (const period of periods(charger)) {
    const start = Math.max(startAt, period.startAt), end = Math.min(period.endAt ?? deadlineAt, deadlineAt);
    if (end <= start) continue;
    // Prefer power from the production plan's resource intervals. Do not fill
    // gaps in published allocation evidence with a larger assumed allowance.
    const allocations = (charger.plan?.intervals ?? []).filter(row => finite(row.powerKw)
      && row.powerKw >= 0 && row.end > start && row.start < end);
    const slots = allocations.length ? allocations.map(row => ({ start: Math.max(start, row.start),
      end: Math.min(end, row.end), powerKw: Math.min(row.powerKw, estimate.powerKw) }))
      : [{ start, end, powerKw: estimate.powerKw }];
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
      + 'It leaves estimated room for the vehicle target within the real plan. The controller may revise that plan after identification; coverage and finish time are not guaranteed.' };
}

function validateSaved(saved) {
  const keys = ['id', 'chargerId', 'vehicleId', 'program', 'association', 'backend', 'phase', 'createdAt', 'updatedAt',
    'endedAt', 'endReason', 'sessionId', 'connectedAt', 'expectations', 'headroom', 'recommendation', 'milestones',
    'findings', 'initialPlan', 'latestPlan', 'deadlineAt', 'scheduleConfirmedAt', 'restorationReminder', 'report', 'lastSeenAt'];
  if (!allowed(saved, ['version', 'runs']) || saved.version !== 1 || !Array.isArray(saved.runs) || saved.runs.length > MAX_RUNS)
    throw new Error('Unsupported physical charging test state; start a fresh development database.');
  for (const run of saved.runs) {
    if (!allowed(run, keys) || typeof run.id !== 'string' || !run.id.length
      || !['charger1', 'charger2'].includes(run.chargerId) || !['bmw', 'tesla'].includes(run.vehicleId)
      || !PROGRAMS.includes(run.program) || !PHASES.includes(run.phase) || typeof run.association !== 'string'
      || !run.association.length || typeof run.backend !== 'string' || !time(run.createdAt) || !time(run.updatedAt)
      || run.endedAt !== null && !time(run.endedAt) || run.sessionId !== null && typeof run.sessionId !== 'string'
      || run.connectedAt !== null && !time(run.connectedAt)
      || !allowed(run.expectations, ['soc', 'nativeTargetSoc', 'vehicleStartAt'])
      || !percent(run.expectations.soc) || !percent(run.expectations.nativeTargetSoc)
      || run.expectations.vehicleStartAt !== null && !time(run.expectations.vehicleStartAt)
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
        'chargingAfterDelay', 'planningMinimum', 'vehicleTarget', 'deadline', 'completion', 'vehicleSchedule'])
      || Object.values(run.milestones).some(row => !allowed(row, ['at', 'connectedAt', 'source', 'state', 'startAt', 'targetSoc']) || !time(row.at)
        || row.targetSoc !== undefined && !percent(row.targetSoc))
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
 * actuator, planner, runtime setter, vehicle capture or command callback. User
 * declarations are private expectations and cannot become production inputs. */
export class ChargingPhysicalTests {
  constructor({ store, key = 'charging:physical-tests', clock = Date.now }) {
    Object.assign(this, { store, key, clock });
    const saved = store.getState(key);
    if (saved !== undefined && saved !== null) validateSaved(saved);
    this.state = saved == null ? { version: 1, runs: [] } : copy(saved);
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
    const estimate = headroom(input, charger, view), gates = [];
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
    gate('declarations', percent(input.soc) && percent(input.nativeTargetSoc) && input.nativeTargetSoc > input.soc,
      'Enter the current battery percentage and the actual higher charge limit set in the vehicle.');
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
        endedAt: null, endReason: null, sessionId: null, connectedAt: null, lastSeenAt: null,
        expectations: { soc: input.soc, nativeTargetSoc: input.nativeTargetSoc,
          vehicleStartAt: input.program === 'vehicle-schedule' ? input.vehicleStartAt : null },
        headroom: preview.headroom, recommendation: preview.recommendation, milestones: {}, findings: [],
        initialPlan: null, latestPlan: null, deadlineAt: null, scheduleConfirmedAt: null, report: null,
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
    const proposed = recommendation(charger, run.headroom, now);
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
    if (!expectedOpportunity(charger, run.headroom, input.startAt, run.deadlineAt).feasible)
      throw new Error('This vehicle start leaves insufficient charging opportunity in the real plan. Choose the suggested time or use a normal test.');
    return this.transaction(() => {
      run.expectations.vehicleStartAt = input.startAt;
      run.scheduleConfirmedAt = now; run.phase = 'observing'; run.updatedAt = now;
      run.recommendation = proposed;
      this.mark(run, 'vehicleSchedule', now, { startAt: input.startAt, source: 'user-confirmed' });
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
        if (!fresh(charger.control?.snapshot, now)) continue;
        if (backend(charger) !== run.backend) { this.finish(run, 'interrupted', 'backend-changed', now); continue; }
        if (run.lastSeenAt !== null && now - run.lastSeenAt > 5 * MINUTE) this.finding(run, 'observation-gap', now);
        if (run.lastSeenAt === null || now - run.lastSeenAt >= MINUTE) run.lastSeenAt = now;
        const connection = connected(charger), sessionId = physicalSession(charger);
        if (run.phase === 'armed') {
          if (connection !== true || !sessionId) continue;
          const connectedAt = charger.control.session?.connectedAt;
          if (!time(connectedAt) || connectedAt < run.createdAt) {
            this.finish(run, 'interrupted', 'fresh-connection-not-observed', now); continue;
          }
          run.connectedAt = connectedAt; run.sessionId = sessionId;
          run.deadlineAt = charger.request?.deadlineAt ?? charger.deadlineAt ?? null;
          run.phase = run.program === 'vehicle-schedule' ? 'awaiting-vehicle-schedule' : 'observing';
          this.mark(run, 'connection', now, { connectedAt });
        }
        if (connection === false) { this.finish(run, 'interrupted', 'unplugged-before-completion', now); continue; }
        if (sessionId && sessionId !== run.sessionId) { this.finish(run, 'interrupted', 'physical-session-changed', now); continue; }
        if (connection !== true || sessionId !== run.sessionId) continue;
        this.observeRun(run, charger, view, now);
      }
      return this.state;
    });
  }

  observeRun(run, charger, view, now) {
    const identified = charger.vehicle?.state === 'identified' && charger.vehicle.sessionId === run.sessionId;
    if (identified && charger.vehicle.id !== run.vehicleId) this.finding(run, 'wrong-vehicle-identified', now);
    if (identified && charger.vehicle.id === run.vehicleId) {
      this.mark(run, 'identification', now, { source: 'production-matcher' });
      if (run.program === 'vehicle-schedule' && now < run.expectations.vehicleStartAt)
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
      if (run.program === 'vehicle-schedule' && !run.scheduleConfirmedAt)
        run.recommendation = recommendation(charger, run.headroom, now);
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
        if (now < run.expectations.vehicleStartAt) this.finding(run, 'charging-before-vehicle-start', now);
        else this.mark(run, 'chargingAfterDelay', now, { source: 'physical-charger' });
      }
    }
    const feed = view.vehicleFeeds?.find(row => row.id === run.vehicleId);
    const soc = identified && charger.vehicle.id === run.vehicleId && feedAvailable(feed)
      ? sample(charger, 'soc', run.connectedAt, now) : null;
    const minimum = field(charger, 'minimumSoc');
    if (soc && percent(minimum) && soc.value >= minimum && run.milestones.planningMinimum?.targetSoc !== minimum) {
      // This milestone applies to the attained planning target. An earlier
      // default/edited lower target must not prove a later higher one at ready-by.
      run.milestones.planningMinimum = { at: now, source: soc.source, targetSoc: minimum }; run.updatedAt = now;
    }
    if (soc && soc.value >= run.expectations.nativeTargetSoc) this.mark(run, 'vehicleTarget', now, { source: soc.source });
    if (!run.milestones.deadline && time(run.deadlineAt) && now >= run.deadlineAt)
      this.mark(run, 'deadline', now, { state: run.milestones.planningMinimum?.at <= run.deadlineAt
        && run.milestones.planningMinimum?.targetSoc === minimum
        ? 'target-observed-by-deadline' : 'not-confirmed-by-deadline' });
    const entry = view.diagnostics?.chargers?.find(row => row.id === run.chargerId);
    const report = [entry?.current, ...(entry?.recent ?? [])].find(row => row?.id === chargingDiagnosticSessionId(charger));
    if (report) run.report = { id: report.id, behavior: report.behavior, outcome: copy(report.outcome), coverage: copy(report.coverage) };
    // The requested planning minimum is never a stop instruction. Finish only
    // after a fresh vehicle reading reaches the declared native limit and a
    // subsequent fresh charger observation shows charging has stopped.
    const stopped = power !== null && power <= .1;
    const observedCeiling = field(charger, 'vehicleCeilingSoc');
    if (percent(observedCeiling) && observedCeiling !== run.expectations.nativeTargetSoc)
      this.finding(run, 'vehicle-limit-differs-from-preparation', now);
    const nativeTarget = percent(observedCeiling) ? observedCeiling : run.expectations.nativeTargetSoc;
    if (soc && soc.value >= nativeTarget && stopped) {
      if (!run.milestones.chargingStarted) {
        this.finish(run, 'interrupted', 'target-without-observed-charging', now); return;
      }
      this.mark(run, 'completion', now, { source: 'vehicle-target-and-charger-stop', state: 'observed' });
      this.finish(run, 'completed', 'vehicle-target-and-stop-observed', now);
    }
  }
}
