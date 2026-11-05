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
    return createHash('sha256').update(JSON.stringify({
      config: input.config, settings: input.settings, model: input.checkpoint?.model,
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
      capability: [input.equipment?.h66Available, input.equipment?.preheatAvailable,
        input.equipment?.floorOverrideAvailable, input.equipment?.nativeAuxAllowed],
    })).digest('hex');
    const waiting = () => incumbentPlan
      ? { ...normal('waiting-for-scheduled-cycle'), plan: incumbentPlan }
      : !this.pending && this.lastNormal?.scope === refreshScope && this.lastNormal.sources === sources
        ? normal(this.lastNormal.reason) : normal('heating-planning-in-progress');
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
      || Math.abs(input.checkpoint?.baselineC - previous.baselineC) >= .25);
    const due = !previous || elapsed < 0 || elapsed >= REFRESH_MS
      || (changed || saved && input.now-saved.at > MAX_RESULT_AGE_MS) && elapsed >= MIN_SEARCH_INTERVAL_MS;
    if (due && !this.pending) {
      const request = { scope, sources, at: input.now, generation: ++this.generation };
      this.pending = request;
      this.completed = null;
      this.lastSearch = { at: input.now, scope: refreshScope, sources, indoorC: input.observations.indoor.value,
        baselineC: input.checkpoint?.baselineC };
      request.promise = this.service.request({ ...input, incumbentPlan }).then(result => {
        if (this.closed || this.pending !== request || request.generation !== this.generation) return;
        this.pending = null;
        if (!result) return;
        this.completed = { scope, sources, at: request.at, result };
        // The regular controller timer consumes this result. Worker completion
        // cannot execute commands or bypass a paused/suspended runtime.
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
