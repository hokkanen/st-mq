import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { applyExplorerOverrides, validateExplorerOverrides } from '../control/heating-explorer.js';

const PREVIEW_MS = 5 * 60_000;
const INPUT_MAX_AGE_MS = 2 * 60_000;
const ACTIVE = new Set(['pending', 'running']);
const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function validTrial(trial) {
  const keys = ['version', 'id', 'approvedAt', 'latestStartAt', 'expiresAt', 'limits', 'snapshotAt', 'basis', 'status',
    'binding', 'scopeBinding', 'plan', 'cycleId', 'startedAt', 'reason', 'endedAt', 'outcome'];
  if (!trial || trial.version !== 1 || !uuid(trial.id)
    || Object.keys(trial).some(key => !keys.includes(key)) || !trial.limits
    || !['pending', 'running', 'completed', 'cancelled', 'expired', 'interrupted', 'rejected'].includes(trial.status)
    || !Number.isSafeInteger(trial.approvedAt) || !Number.isSafeInteger(trial.snapshotAt)
    || trial.basis !== 'admin-approved-one-cycle-scenario' || !Number.isFinite(trial.latestStartAt)
    || !Number.isFinite(trial.expiresAt) || trial.latestStartAt < trial.approvedAt - INPUT_MAX_AGE_MS
    || trial.expiresAt <= trial.latestStartAt || trial.expiresAt - trial.approvedAt > 200 * 3_600_000
    || !/^[a-f0-9]{64}$/.test(trial.binding) || !/^[a-f0-9]{64}$/.test(trial.scopeBinding)) return false;
  try { validateExplorerOverrides(trial.limits); } catch { return false; }
  if (ACTIVE.has(trial.status) && (!trial.plan?.schedule || trial.plan.userTrial?.id !== trial.id
    || !Number.isFinite(trial.plan.schedule.reductionEnd))) return false;
  if (trial.status === 'running' && typeof trial.cycleId !== 'string') return false;
  return true;
}
export function validateHeatingTrialState(trial) {
  if (trial != null && !validTrial(trial)) throw new Error('Unsupported heating trial state; start a fresh development database.');
}
function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)))
    throw failure('Unsupported heating explorer request.', 400);
}

/** One bounded worker per installation; hypothetical work never receives a store or actuator. */
export class HeatingExplorerWorker {
  constructor() { this.active = null; this.queue = []; this.closed = false; }
  run(input, overrides) {
    if (this.closed) return Promise.reject(failure('The heating explorer is shutting down.', 503));
    if (this.queue.length >= 2) return Promise.reject(failure('The heating explorer is busy. Retry shortly.', 429));
    return new Promise((resolve, reject) => { this.queue.push({ input, overrides, resolve, reject }); this.next(); });
  }
  next() {
    if (this.active || this.closed || !this.queue.length) return;
    const job = this.queue.shift();
    const worker = new Worker(new URL('../control/heating-explorer-worker.js', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); this.active = null;
      void worker.terminate();
      if (error) job.reject(error); else job.resolve(result);
      this.next();
    };
    const timer = setTimeout(() => finish(failure('The heating comparison timed out. Try fewer changes.', 503)), 30_000);
    this.active = { worker, finish };
    worker.once('error', () => finish(failure('The heating comparison could not finish.', 503)));
    worker.once('exit', code => { if (!done) finish(failure(`The heating comparison stopped (${code}).`, 503)); });
    worker.once('message', message => message.error ? finish(failure(message.error.message ?? message.error, 400)) : finish(null, message.result));
    worker.postMessage({ id: 1, input: job.input, overrides: job.overrides, options: { includePlan: true } });
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(failure('The heating explorer is shutting down.', 503));
    const active = this.active;
    active?.finish(failure('The heating explorer is shutting down.', 503));
    if (active) await active.worker.terminate();
  }
}

/** Explicit one-cycle intent is separate from configured defaults and physical restoration. */
export class HeatingExplorer {
  constructor(engine, { worker = new HeatingExplorerWorker() } = {}) {
    this.engine = engine; this.worker = worker; this.snapshots = new Map(); this.previews = new Map();
    this.key = `heating-explorer:trial:${engine.config.input}`;
    const trial = this.trial();
    validateHeatingTrialState(trial);
    // Native executor restoration already owns restart. Never turn copied intent into fresh permission.
    if (trial && ACTIVE.has(trial.status)) {
      if (engine.cycles.active()?.plan.userTrial?.id === trial.id) engine.cycles.shorten(engine.clock(), 'scenario-approval-ended-on-restart');
      this.finish('interrupted', 'Application restarted; review a fresh comparison before another trial.');
    }
  }
  trial() { return this.engine.store.getState(this.key); }
  publicTrial() {
    const trial = this.trial();
    if (!trial) return null;
    const { binding, scopeBinding, plan, version, ...visible } = trial;
    return visible;
  }
  binding() {
    const e = this.engine, checkpoint = e.checkpoint, native = e.h66Status?.();
    return digest({ configuration: e.config, settings: e.settings, target: e.automationTarget('home'),
      journalCursor: checkpoint?.journalCursor, model: checkpoint?.model,
      measurementEpochAt: checkpoint?.measurementEpochAt ?? null, sensorEpochs: checkpoint?.sensorEpochs ?? {},
      fireplaceRevision: checkpoint?.fireplaceRevision ?? 0, sensorRevision: checkpoint?.sensorRevision ?? 0,
      rebuild: e.store.getState(`fireplace:rebuild:${e.config.input}`)?.status,
      market: e.store.getState('provider:market'), weather: e.store.getState('provider:weather'),
      observations: Object.fromEntries(Object.entries(e.latest ?? {}).filter(([signal]) =>
        /temperature|room_setting|compressor|auxiliary|dhw_routing|alarm|operating_mode|integral|valve/.test(signal))
        .map(([signal, row]) => [signal, { value: row.value, quality: row.quality, source: row.source, device: row.device }])),
      native: native ? { available: native.available, connected: native.connected, controlsReady: native.controlsReady,
        phase: native.phase, externalChangeRevision: native.externalChangeRevision,
        controls: native.controls, readings: Object.fromEntries(Object.entries(native.readings ?? {}).map(([key, row]) =>
          [key, { value: row.value, available: row.available }])) } : null,
      nativeRevision: native?.externalChangeRevision ?? this.input?.equipment?.externalChangeRevision ?? 0 });
  }
  capture(input, decision, blockedReason = null) {
    this.input = { ...input, checkpoint: { model: input.checkpoint?.model, baselineC: input.checkpoint?.baselineC,
      health: input.checkpoint?.health }, currentPlan: decision.plan, currentDecision: { action: decision.action,
      phase: decision.phase, reasons: decision.reasons }, blockedReason };
  }
  availableReason() {
    const e = this.engine;
    if (!e.canControl() || e.suspended || e.config.input === 'offline') return 'The active controller is required to apply a trial.';
    if (!e.automationEnabled('home')) return 'Enable Home automation before applying a trial.';
    if (e.cycles.active()) return 'Wait for the current cycle and recovery to finish.';
    if (ACTIVE.has(this.trial()?.status)) return 'A one-cycle scenario is already approved. Cancel it before selecting another.';
    if (e.dispatchPending || e.heatingTestBusy || e.automationChangePending) return 'Wait for the current heating operation to finish.';
    if (this.input?.blockedReason) return `Current heating is held: ${this.input.blockedReason}.`;
    const executor = e.executor.status();
    if (executor.restorationPending || executor.manualRequested || executor.manualPause)
      return 'Finish manual heating and pending restoration before applying a trial.';
    return null;
  }
  snapshot() {
    const now = this.engine.clock();
    if (!this.input || now - this.input.now > INPUT_MAX_AGE_MS || this.input.now > now)
      throw failure('Waiting for a fresh heating planning snapshot.', 503);
    for (const [id, value] of this.snapshots) if (value.expiresAt <= now) this.snapshots.delete(id);
    for (const [id, value] of this.previews) if (value.expiresAt <= now) this.previews.delete(id);
    while (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value);
    const id = randomUUID(), value = { id, input: structuredClone(this.input), binding: this.binding(),
      expiresAt: Math.min(now + PREVIEW_MS, this.input.now + PREVIEW_MS), cache: new Map() };
    this.snapshots.set(id, value); return value;
  }
  async view() { return this.calculate(this.snapshot(), {}, false); }
  async simulate(payload) {
    object(payload, ['snapshotId', 'limits']);
    if (typeof payload.snapshotId !== 'string') throw failure('A snapshotId is required.', 400);
    const snapshot = this.snapshots.get(payload.snapshotId);
    if (!snapshot || snapshot.expiresAt <= this.engine.clock()) throw failure('This snapshot expired. Refresh the plan before comparing again.', 410);
    validateExplorerOverrides(payload.limits ?? {});
    return this.calculate(snapshot, payload.limits ?? {}, true);
  }
  async calculate(snapshot, limits, preview) {
    const normalized = validateExplorerOverrides(limits);
    const key = JSON.stringify(normalized);
    let task = snapshot.cache.get(key);
    if (!task) {
      if (snapshot.cache.size >= 8) snapshot.cache.delete(snapshot.cache.keys().next().value);
      task = this.worker.run(snapshot.input, normalized);
      snapshot.cache.set(key, task);
      task.catch(() => snapshot.cache.delete(key));
    }
    const result = await task;
    const { executablePlan, ...visible } = result;
    const scope = this.approvalScope(executablePlan);
    const changed = Object.keys(normalized).length > 0 && JSON.stringify(applyExplorerOverrides(snapshot.input, normalized).settings) !== JSON.stringify(snapshot.input.settings)
      || Object.keys(normalized).some(key => normalized[key] !== snapshot.input.config?.[key] && !['maxDropC', 'maxRiseC', 'savingsStrategy'].includes(key));
    const reason = this.availableReason() ?? (snapshot.binding !== this.binding() ? 'Configuration or source evidence changed. Refresh the plan.' : null)
      ?? (!preview ? 'Compare a scenario before applying it.' : null)
      ?? (!changed ? 'Choose at least one different limit before applying a scenario.' : null)
      ?? (!executablePlan ? 'This comparison has no executable cycle within current safety and evidence limits.' : null)
      ?? scope.reason
      ?? (snapshot.expiresAt <= this.engine.clock() ? 'This preview expired. Refresh the plan.' : null);
    const previewId = preview ? randomUUID() : null;
    if (preview) {
      while (this.previews.size >= 16) this.previews.delete(this.previews.keys().next().value);
      this.previews.set(previewId, { snapshot, plan: executablePlan, limits: normalized,
        expiresAt: snapshot.expiresAt, allowed: !reason });
    }
    return { ...visible, snapshotId: snapshot.id, expiresAt: snapshot.expiresAt, previewId,
      application: { allowed: !reason, reason, latestStartAt: scope.latestStartAt, expiresAt: scope.expiresAt }, activeTrial: this.publicTrial() };
  }
  approvalScope(plan) {
    if (!plan?.schedule) return { reason: null, latestStartAt: null, expiresAt: null };
    const now = this.engine.clock(), firstActionAt = Math.min(plan.schedule.preheatStart, plan.schedule.reductionStart);
    return { latestStartAt: firstActionAt + PREVIEW_MS,
      expiresAt: plan.schedule.reductionEnd + this.engine.control.recoveryTimeoutHours * 3_600_000,
      reason: firstActionAt < now - INPUT_MAX_AGE_MS || firstActionAt > now + 6 * 3_600_000
        ? 'The proposed start is outside the approval window. Refresh the plan.' : null };
  }
  apply(payload) {
    object(payload, ['previewId']);
    const preview = this.previews.get(payload.previewId);
    const now = this.engine.clock();
    if (!preview || preview.expiresAt <= now) throw failure('This preview expired. Refresh and simulate before applying.', 410);
    if (preview.snapshot.binding !== this.binding()) throw failure('Configuration or source evidence changed. Refresh the plan.');
    const unavailable = this.availableReason();
    if (unavailable) throw failure(unavailable);
    if (!preview.allowed || !preview.plan) throw failure('This scenario cannot be applied within current safety and evidence limits.');
    if (!this.input || now - this.input.now > INPUT_MAX_AGE_MS) throw failure('A fresh controller snapshot is required.');
    const { reason, latestStartAt, expiresAt } = this.approvalScope(preview.plan);
    if (reason) throw failure(reason);
    const id = randomUUID();
    const context = { id, approvedAt: now, latestStartAt, expiresAt, limits: preview.limits,
      snapshotAt: preview.snapshot.input.now, basis: 'admin-approved-one-cycle-scenario' };
    const plan = structuredClone({ ...preview.plan, userTrial: context });
    const trial = { version: 1, ...context, status: 'pending', binding: preview.snapshot.binding,
      scopeBinding: this.scopeBinding(), plan };
    this.engine.store.transaction(() => {
      this.engine.store.setState(this.key, trial);
      this.engine.store.setState(`pending-plan:${this.engine.config.input}`, plan);
      this.engine.store.event('heating-scenario-approved', context, now);
    });
    this.engine.pendingPlan = plan;
    this.previews.clear();
    return { activeTrial: this.publicTrial() };
  }
  finish(status, reason, additions = {}) {
    const trial = this.trial();
    if (!trial || !ACTIVE.has(trial.status)) return;
    const now = this.engine.clock();
    const next = { ...trial, status, reason, endedAt: now, ...additions };
    delete next.plan;
    this.engine.store.transaction(() => {
      this.engine.store.setState(this.key, next);
      this.engine.store.event(`heating-scenario-${status}`, { id: trial.id, reason, cycleId: trial.cycleId ?? null }, now);
      if (this.engine.pendingPlan?.userTrial?.id === trial.id) this.engine.store.setState(`pending-plan:${this.engine.config.input}`, null);
    });
    if (this.engine.pendingPlan?.userTrial?.id === trial.id) this.engine.pendingPlan = null;
  }
  cancel(payload) {
    object(payload, []);
    const trial = this.trial();
    if (trial && ACTIVE.has(trial.status)) {
      if (this.engine.cycles.active()?.plan.userTrial?.id === trial.id) this.engine.cycles.shorten(this.engine.clock(), 'admin-cancelled-scenario');
      this.finish('cancelled', 'Cancelled by admin; ordinary restoration and recovery remain active.');
    }
    return { activeTrial: this.publicTrial() };
  }
  reconcile(now) {
    const trial = this.trial();
    if (!trial || !ACTIVE.has(trial.status)) return null;
    const active = this.engine.cycles.active();
    if (trial.status === 'running' && active?.id !== trial.cycleId) {
      const row = this.engine.store.db.prepare('SELECT payload FROM active_learning_cycles AS learning_cycles WHERE id=?').get(trial.cycleId);
      const cycle = row ? JSON.parse(row.payload) : null;
      this.finish(cycle?.status === 'completed' ? 'completed' : 'interrupted', cycle?.incompleteReason ?? 'Cycle and recovery ended.',
        { outcome: cycle?.assessment ?? null });
      return null;
    }
    const reason = now >= trial.expiresAt ? 'One-cycle scenario expired.'
      : trial.status === 'pending' && now > trial.latestStartAt ? 'The approved start window expired.'
        : this.scopeBinding() !== trial.scopeBinding ? 'Configuration or source evidence changed.'
          : !this.engine.automationEnabled('home') ? 'Home automation or control authority is unavailable.' : null;
    if (reason) {
      if (active?.plan.userTrial?.id === trial.id) this.engine.cycles.shorten(now, 'scenario-scope-ended');
      this.finish(reason.includes('expired') ? 'expired' : 'interrupted', reason); return null;
    }
    if (trial.status === 'pending' && !this.engine.pendingPlan && !active && !this.engine.dispatchPending)
      this.engine.pendingPlan = structuredClone(trial.plan);
    return trial;
  }
  scopeBinding() {
    const e = this.engine, checkpoint = e.checkpoint;
    return digest({ configuration: e.config, settings: e.settings, target: e.automationTarget('home'),
      measurementEpochAt: checkpoint?.measurementEpochAt ?? null, sensorEpochs: checkpoint?.sensorEpochs ?? {},
      fireplaceRevision: checkpoint?.fireplaceRevision ?? 0, sensorRevision: checkpoint?.sensorRevision ?? 0,
      rebuild: e.store.getState(`fireplace:rebuild:${e.config.input}`)?.status });
  }
  started(cycle) {
    const trial = this.trial();
    if (!cycle.plan.userTrial) return;
    if (trial?.status !== 'pending' || cycle.plan.userTrial.id !== trial.id) {
      this.engine.cycles.shorten(this.engine.clock(), 'scenario-approval-ended-before-confirmation');
      return;
    }
    this.engine.store.setState(this.key, { ...trial, status: 'running', cycleId: cycle.id, startedAt: cycle.startedAt });
  }
  reject(reason) { this.finish('rejected', reason); }
  close() { return this.worker.close(); }
}
