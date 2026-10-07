import { createHash } from 'node:crypto';
import { createHeatingPlannerService } from '../control/planner-service.js';
import { phaseAt, revalidatePlan } from '../control/planner.js';

const MAX_RESULT_AGE_MS = 120_000;
const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null });

/** Background search has no authority. Adoption always uses current control inputs. */
export class HeatingPlanning {
  constructor(engine, service = createHeatingPlannerService()) {
    this.engine = engine;
    this.service = service;
    this.generation = 0;
    this.closed = false;
  }
  scope(input) {
    const e = this.engine;
    return createHash('sha256').update(JSON.stringify({
      config: input.config, settings: input.settings, model: input.checkpoint?.model,
      baselineC: input.checkpoint?.baselineC, authority: e.automation.features.home,
      target: e.automationTarget('home'), canControl: e.canControl(),
      measurementEpochAt: input.checkpoint?.measurementEpochAt,
      sensorEpochs: input.checkpoint?.sensorEpochs, sensorRevision: input.checkpoint?.sensorRevision,
      fireplaceRevision: input.checkpoint?.fireplaceRevision,
      nativeRevision: input.equipment?.externalChangeRevision,
      roomSettingC: input.equipment?.roomSettingC,
      roomSettingMaximumC: input.equipment?.roomSettingMaximumC,
    })).digest('hex');
  }
  invalidate() {
    this.generation++;
    this.pending = null;
    this.completed = null;
  }
  choose(input) {
    if (this.closed || this.engine.suspended || !this.engine.canControl()
      || !this.engine.automationEnabled('home')) {
      this.invalidate();
      return normal('heating-planning-unavailable');
    }
    const scope = this.scope(input), saved = this.completed;
    if (saved && saved.scope === scope && input.now >= saved.at
      && input.now - saved.at <= MAX_RESULT_AGE_MS) {
      if (!saved.result.plan) return structuredClone(saved.result);
      // Source freshness, prices, weather, current comfort, limits and trial
      // allowance are rechecked after search, before a result can be dispatched.
      const checked = revalidatePlan({ ...input, plan: saved.result.plan });
      this.completed = null;
      if (checked.valid) {
        const phase = phaseAt(checked.plan.schedule, input.now);
        return { ...saved.result, plan: checked.plan, phase,
          action: phase === 'reduction' ? 'reduction' : 'normal' };
      }
    }
    if (!this.pending || this.pending.scope !== scope) {
      const request = { scope, at: input.now, generation: ++this.generation };
      this.pending = request;
      this.completed = null;
      request.promise = this.service.request(input).then(result => {
        if (this.closed || this.pending !== request || request.generation !== this.generation) return;
        this.pending = null;
        if (!result) return;
        this.completed = { scope, at: request.at, result };
        // The regular controller timer consumes this result. Worker completion
        // cannot execute commands or bypass a paused/suspended runtime.
        this.engine.onTemporaryChange?.();
      }).catch(() => {
        if (this.closed || this.pending !== request) return;
        this.pending = null;
        this.completed = { scope, at: request.at, result: normal('heating-planning-unavailable') };
      });
    }
    return normal('heating-planning-in-progress');
  }
  async close() {
    this.closed = true;
    this.invalidate();
    await this.service.close();
  }
}
