import { createHash } from 'node:crypto';
import { createHeatingPlannerService } from '../control/planner-service.js';
import { phaseAt, revalidatePlan } from '../control/planner.js';

const MAX_RESULT_AGE_MS = 120_000;
const REFRESH_MS = 15 * 60_000;
const MIN_SEARCH_INTERVAL_MS = 60_000;
const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null });

/** Background search has no authority. Adoption always uses current control inputs. */
export class HeatingPlanning {
  constructor(engine, service = createHeatingPlannerService()) {
    this.engine = engine;
    this.service = service;
    this.generation = 0;
    this.closed = false;
  }
  scope(input, includeBaseline = true) {
    const e = this.engine;
    // The effective target also carries the continuously learned reference.
    // Only the owner's configured target belongs in the early-refresh identity.
    const settings = includeBaseline || !e.settings ? input.settings : { ...input.settings,
      comfort: { ...input.settings.comfort, targetC: e.settings.comfort.targetC } };
    return createHash('sha256').update(JSON.stringify({
      config: input.config, settings, model: input.checkpoint?.model,
      baselineC: includeBaseline ? input.checkpoint?.baselineC : undefined, authority: e.automation.features.home,
      target: e.automationTarget('home'), canControl: e.canControl(),
      measurementEpochAt: input.checkpoint?.measurementEpochAt,
      sensorEpochs: input.checkpoint?.sensorEpochs, sensorRevision: input.checkpoint?.sensorRevision,
      fireplaceRevision: input.checkpoint?.fireplaceRevision,
      nativeRevision: input.equipment?.externalChangeRevision,
      roomSettingC: input.equipment?.roomSettingC,
      roomSettingMaximumC: input.equipment?.roomSettingMaximumC,
      learningTrialsToday: input.equipment?.learningTrialsToday,
      learningTrialsDate: input.equipment?.learningTrialsDate,
    })).digest('hex');
  }
  invalidate() {
    this.generation++;
    this.pending = null;
    this.completed = null;
    this.lastSearch = null;
    this.lastNormal = null;
    this.continuation = null;
  }
  /** Continuation results can revise optional heat or prove a cheaper exit.
   * Missing results always retain intent. Dispatch rechecks the adopted phase. */
  continue(args, schedule, owner, preheatHours = 0) {
    if (this.closed || !this.engine.canControl()) return null;
    const binding = JSON.stringify([owner, schedule]);
    const scope = JSON.stringify([args.model, args.config, args.targetC, args.maxDropC, args.maxRiseC, args.trial,
      args.occupancy, args.equipment.externalChangeRevision, args.equipment.roomSettingC,
      args.equipment.roomSettingMaximumC]);
    const source = JSON.stringify(args.intervals.map(row => [row.end, row.price, row.outdoorC, row.solarRadiationWm2]));
    let job = this.continuation;
    if (job?.binding !== binding) job = this.continuation = null;
    const thermalChanged = job && ['indoorC', 'reserveC', ...(args.model.floor?.enabled ? ['slabC'] : [])]
      .some(key => !Number.isFinite(args.initialState[key]) || !Number.isFinite(job[key])
        || Math.abs(args.initialState[key] - job[key]) >= .25);
    if (job?.result && args.now >= job.at && args.now - job.at <= MAX_RESULT_AGE_MS && args.freshComparison
      && job.scope === scope && job.source === source && !thermalChanged) {
      const result = job.result; job.result = null;
      if (result.schedule.preheatStart < args.now && result.schedule.preheatStart > job.at)
        return null;
      if (!result.end) {
        // A worker can propose stopping at its calculation clock. Adoption
        // cannot rewrite the prefix executed while that calculation was pending.
        const executedUntil = Math.min(args.now, schedule.preheatEnd);
        if (schedule.preheatStart < executedUntil && result.schedule.preheatStart <= schedule.preheatStart
          && result.schedule.preheatEnd < executedUntil)
          result.schedule = { ...result.schedule, preheatEnd: executedUntil };
        const remainingMs = Math.max(0, args.config.maxPreheatHours - preheatHours) * 3_600_000;
        if (result.schedule.preheatEnd - Math.max(args.now, result.schedule.preheatStart) > remainingMs)
          result.schedule = { ...result.schedule,
            preheatStart: remainingMs ? result.schedule.preheatEnd - remainingMs : args.now,
            preheatEnd: remainingMs ? result.schedule.preheatEnd : args.now };
      }
      return result;
    }
    const changed = job && (job.source !== source || job.scope !== scope
      || thermalChanged);
    const due = !job || args.now < job.at || args.now - job.at >= REFRESH_MS || changed && args.now - job.at >= MIN_SEARCH_INTERVAL_MS;
    if (args.freshComparison && due && !job?.pending) {
      const request = { binding, at: args.now, source, scope, pending: true,
        indoorC: args.initialState.indoorC, reserveC: args.initialState.reserveC, slabC: args.initialState.slabC };
      this.continuation = request;
      request.promise = this.service.request({ continuation: { args, schedule, preheatHours } }).then(result => {
        if (this.closed || this.continuation !== request) return;
        request.pending = false; request.result = result?.continuation ?? null;
        this.engine.onTemporaryChange?.();
      }).catch(() => { if (this.continuation === request) request.pending = false; });
    }
    return null;
  }
  choose(input, incumbentPlan = null) {
    if (this.closed || this.engine.suspended || !this.engine.canControl()
      || !this.engine.automationEnabled('home')) {
      this.invalidate();
      return normal('heating-planning-unavailable');
    }
    const scope = this.scope(input), saved = this.completed;
    const refreshScope = this.scope(input, false);
    // Provider receipt/issue clocks and ordinary native water/counter updates
    // do not justify another full search. Numerical forecasts and tariffs do.
    const sources = createHash('sha256').update(JSON.stringify({
      prices: input.prices.map(row => [row.start, row.end, row.allInCentsPerKWh]),
      forecast: input.forecast.map(row => {
        const raw = row.issuedAt == null && row.issuedAtBasis === 'fetched-snapshot' ? row.fetchedAt : row.issuedAt;
        const issuedAt = typeof raw === 'number' ? raw : Date.parse(raw);
        return [row.start, row.end, row.outdoorC, row.solarRadiationWm2,
          Number.isFinite(issuedAt) && issuedAt <= input.now && input.now-issuedAt <= 6 * 3_600_000];
      }),
      referenceAvailable: Number.isFinite(input.checkpoint?.baselineC),
      capability: [input.equipment?.h66Available, input.equipment?.reductionTelemetryAvailable, input.equipment?.preheatAvailable,
        input.equipment?.floorOverrideAvailable, input.equipment?.nativeAuxAllowed],
    })).digest('hex');
    const incumbentDue = incumbentPlan
      && Math.min(incumbentPlan.schedule.preheatStart, incumbentPlan.schedule.reductionStart) <= input.now;
    const waiting = () => {
      if (incumbentPlan) {
        const phase = phaseAt(incumbentPlan.schedule, input.now);
        return { ...normal(phase === 'normal' ? 'waiting-for-scheduled-cycle' : 'revalidated-scheduled-cycle'),
          phase, action: phase === 'reduction' ? 'reduction' : 'normal', plan: incumbentPlan };
      }
      return !this.pending && this.lastNormal?.scope === refreshScope && this.lastNormal.sources === sources
        ? normal(this.lastNormal.reason) : normal('heating-planning-in-progress');
    };
    if (saved && saved.scope === scope && saved.sources === sources && input.now >= saved.at
      && input.now - saved.at <= MAX_RESULT_AGE_MS) {
      this.completed = null;
      if (!saved.result.plan) {
        // Retain only an idle explanation. Old search costs, candidate counts
        // and readiness must not be republished as a fresh evaluation.
        this.lastNormal = { scope: refreshScope, sources, reason: saved.result.reasons?.[0] ?? 'normal-operation-preferred' };
        return incumbentPlan ? waiting() : structuredClone(saved.result);
      }
      // Source freshness, prices, weather, current comfort, limits and trial
      // allowance are rechecked after search, before a result can be dispatched.
      const checked = revalidatePlan({ ...input, plan: saved.result.plan });
      if (checked.valid) {
        const phase = phaseAt(checked.plan.schedule, input.now);
        return { ...saved.result, plan: checked.plan, phase,
          action: phase === 'reduction' ? 'reduction' : 'normal' };
      }
    }
    const previous = this.lastSearch, elapsed = previous ? input.now - previous.at : Infinity;
    const changed = previous && (previous.scope !== refreshScope || previous.sources !== sources
      || Math.abs(input.observations.indoor.value - previous.indoorC) >= .25
      || Math.abs(input.settings.comfort.targetC - previous.targetC) >= .25);
    const due = !previous || elapsed < 0 || elapsed >= REFRESH_MS
      || (changed || saved && input.now-saved.at > MAX_RESULT_AGE_MS) && elapsed >= MIN_SEARCH_INTERVAL_MS;
    if (due && !this.pending && !incumbentDue) {
      const request = { scope, sources, at: input.now, generation: ++this.generation };
      this.pending = request;
      this.completed = null;
      this.lastSearch = { at: input.now, scope: refreshScope, sources, indoorC: input.observations.indoor.value,
        targetC: input.settings.comfort.targetC };
      request.promise = this.service.request({ ...input, incumbentPlan }).then(result => {
        if (this.closed || this.pending !== request || request.generation !== this.generation) return;
        this.pending = null;
        if (!result) return;
        this.completed = { scope, sources, at: request.at, result };
        // Request ordinary guarded adoption promptly; a completed background
        // search has no authority to dispatch equipment by itself.
        this.engine.requestUpdate?.();
        this.engine.onTemporaryChange?.();
      }).catch(() => {
        if (this.closed || this.pending !== request) return;
        this.pending = null;
        this.completed = { scope, sources, at: request.at, result: normal('heating-planning-unavailable') };
        // Retry a failed search at the bounded minimum cadence, not every tick.
        if (this.lastSearch?.at === request.at) this.lastSearch.sources = null;
      });
    }
    return waiting();
  }
  async close() {
    this.closed = true;
    this.invalidate();
    await this.service.close();
  }
}
