import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendLearningRecord } from './committed-learning.js';
import { evaluateCycle, phaseAt, trialCostScenarios } from '../control/planner.js';
import { advanceReference, observedState, rebuildCycleWorking, assessCycle,
  initialTrialCostPrefix, advanceTrialCostPrefix } from './cycle-evaluation.js';
import { fireplaceEpisodeAffected } from './fireplace-inputs.js';
import { CONTROL_DEFAULTS } from './config.js';
import { sealCycleWorking, validateCycleWorking, cycleWorkingIntact } from '../domain/cycle-working-state.js';

const HOUR = 3600000;
const number = Number.isFinite;
const dateKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const mean = rows => rows.length ? rows.reduce((sum, x) => sum + x, 0) / rows.length : null;
const summary = result => { const { trajectory, ...values } = result ?? {}; return values; };
const sampleEndpoint = sample => Object.fromEntries(['timestamp','windowStart','windowEnd','phase','indoorC','indoorEstimated','indoorTrendCPerHour',
  'priceCents','priceStart','priceEnd'].filter(key => Object.hasOwn(sample,key)).map(key => [key,sample[key]]));

export class CycleTracker {
  constructor({ store, input, config = {} }) {
    this.store = store; this.input = input; this.config = { ...CONTROL_DEFAULTS, ...config };
    this.key = `cycle:active:${input}`;
  }
  active() {
    const pointer = this.store.getState(this.key);
    return pointer ? this.store.cycleById({ id: pointer.id, input: this.input }) : null;
  }
  workingKey(cycle) { return `cycle:working:${cycle.id}`; }
  readWorking(cycle) {
    const value = this.store.getState(this.workingKey(cycle));
    if (value === null) return null;
    validateCycleWorking(value,cycle.id);
    return cycleWorkingIntact(value) ? value : null;
  }
  saveWorking(cycle,value) {
    const saved = sealCycleWorking({ ...value, id: cycle.id, revision: this.fireplaceContext?.fireplaceRevision ?? 0 });
    this.store.setState(this.workingKey(cycle), saved);
    return saved;
  }
  rememberTrialPrefix(prefix, digest) {
    this.trialCostPrefix = prefix && { ...prefix, digest, revision: this.fireplaceContext?.fireplaceRevision ?? 0 };
    this.store.afterRollback?.(() => { this.trialCostPrefix = null; });
  }
  trialPrefixMatches(cycle, saved) {
    const prefix = this.trialCostPrefix;
    return prefix?.id === cycle.id && prefix.count === cycle.observationCount
      && prefix.through === cycle.lastSample.timestamp && prefix.digest === saved?.digest
      && prefix.revision === (this.fireplaceContext?.fireplaceRevision ?? 0);
  }
  trialExposureContext(now) {
    const cycle = this.active();
    if (!cycle?.plan.trial || cycle.lastSample.timestamp !== now || cycle.actual.missingHours > 0
      || cycle.actual.routeMissingHours > 0 || cycle.actual.temperatureMissingHours > 0) return null;
    const saved = this.readWorking(cycle);
    if (!this.trialPrefixMatches(cycle, saved) || !this.trialCostPrefix.available
      || !Array.isArray(this.trialCostPrefix.scenarios) || this.trialCostPrefix.scenarios.length !== 3
      || cycle.observationCount > 0 && this.trialCostPrefix.scenarios.some(item => !item.reference?.continuation)) return null;
    const definitions = trialCostScenarios({ model: cycle.plan.model, initialState: cycle.plan.initialState,
      config: cycle.modelConfig, equipment: cycle.plan.equipment });
    return { through: now, scenarios: this.trialCostPrefix.scenarios.map((item, index) => ({
      direction: item.direction, actualState: item.actualState,
      referenceState: item.reference?.continuation.state ?? definitions[index].initialState,
      actualCostCents: item.actualCostCents, referenceCostCents: item.reference?.continuation.totals.costCents ?? 0,
      foregoneIncomeCents: item.foregoneIncomeCents,
      electricalScale: definitions[index].config.scenarioElectricalScale,
      auxiliaryScale: definitions[index].config.scenarioAuxScale })) };
  }
  events(cycle) { return this.fireplaceContext?.fireplaceEvents ?? cycle.plan.equipment?.fireplaceEvents ?? []; }
  workingJob() {
    const cycle = this.active(); if (!cycle) return null;
    const saved = this.readWorking(cycle);
    if (saved?.count === cycle.observationCount && (!cycle.plan.trial || this.trialPrefixMatches(cycle, saved))
      && saved.revision === (this.fireplaceContext?.fireplaceRevision ?? 0)
      && isDeepStrictEqual(saved.observer,cycle.observerState)
      && isDeepStrictEqual(saved.reference?.continuation?.state ?? null,cycle.referenceState ?? null)
      && (!saved.reference?.continuation || (cycle.observationCount === 0
        ? saved.reference.continuation.origin === null && saved.reference.continuation.previousEnd === null
        : saved.reference.continuation.origin === cycle.startedAt
          && saved.reference.continuation.previousEnd === cycle.lastSample?.timestamp
          && Math.abs(saved.reference.continuation.elapsed-(cycle.lastSample.timestamp-cycle.startedAt)/HOUR)
            <= Math.max(1,Math.abs(saved.reference.continuation.elapsed))*1e-10))) {
      // A known cache can be intact but stale under different frozen inputs.
      // The shared evaluator checks its binding without replaying any interval.
      try { advanceReference(cycle,[],this.events(cycle),saved.reference); return null; }
      catch (error) { if (!(error instanceof TypeError)) throw error; }
    }
    return { id: cycle.id, count: cycle.observationCount, fireplaceEvents: this.events(cycle) };
  }
  adoptWorking(result) {
    return this.store.transaction(() => {
      const cycle = this.active();
      if (!cycle || result.id !== cycle.id || result.count !== cycle.observationCount) throw new Error('Cycle reconstruction became stale');
      const reference = result.reference?.continuation?.state ?? null;
      if (!isDeepStrictEqual(cycle.observerState,result.observer)
        || !isDeepStrictEqual(cycle.referenceState ?? null,reference)) cycle.stableSince = null;
      cycle.observerState = result.observer; cycle.referenceState = reference;
      const saved = this.saveWorking(cycle,result); this.save(cycle);
      this.rememberTrialPrefix(result.trialCostPrefix ?? null, saved.digest);
    });
  }
  correctFireplace(context, now) {
    if (context.fireplaceExcludedRanges?.length) this.store.transaction(() => {
      const from = Math.min(...context.fireplaceExcludedRanges.map(range => range.start));
      const to = Math.max(...context.fireplaceExcludedRanges.map(range => range.end));
      for (const { id } of this.store.db.prepare('SELECT id FROM active_learning_cycles WHERE input=? AND started_at<? AND COALESCE(ended_at,?)>?')
        .iterate(this.input,to,now,from)) {
        const cycle = this.store.cycleById({ id, input: this.input });
        if (!fireplaceEpisodeAffected({ ...cycle, endedAt: cycle.endedAt ?? now },context)) continue;
        cycle.fireplaceCorrectionRevision = context.fireplaceRevision;
        if (cycle.assessment) cycle.assessment = { ...cycle.assessment, profitCents: null, recoveryErrorCents: null,
          basis: 'unassessed-corrected-fireplace-history' };
        if (cycle.status === 'active') {
          cycle.observerState = null; cycle.stableSince = null;
          this.store.setState(this.workingKey(cycle),null);
        }
        this.store.cycle(this.input,cycle);
      }
    });
    this.fireplaceContext = context;
    // Isolated synchronous fixtures share the same bounded reconstruction.
    // File-backed live operation yields this work to the admitted worker.
    if (this.store.path === ':memory:') {
      const job = this.workingJob(); if (job) this.adoptWorking(rebuildCycleWorking(this.store,job));
    }
  }
  save(cycle) {
    return this.store.transaction(() => {
    this.store.cycle(this.input,cycle);
    const pointer = ['completed','incomplete'].includes(cycle.status) ? null : { id: cycle.id };
    if ((this.store.getState(this.key)?.id ?? null) !== (pointer?.id ?? null)) this.store.setState(this.key,pointer);
    if (!pointer) this.store.db.prepare('DELETE FROM state WHERE key=?').run(this.workingKey(cycle));
    });
  }
  budget(now) {
    const previous=this.store.cycleSummaries({input:this.input,limit:1})[0];
    if (previous && !number(previous.endedAt)) return 0;
    const state = this.store.getState(`trials:${this.input}`);
    if (state && (!number(state.reservedCents) || state.reservedCents < 0)) return null;
    return Math.max(0, this.config.trialBudgetCentsPerDay - (state?.date === dateKey(now) ? state.reservedCents : 0));
  }
  /** Keep the original forecast immutable and reserve the highest comparable
   * full-cycle estimate. Forecast oscillations never spend the same cap twice. */
  reserveTrialExposure(exposureCents) {
    const cycle = this.active(), budget = cycle?.trialBudget;
    const cap = cycle?.plan.config?.maxTrialCostCents ?? this.config.maxTrialCostCents;
    if (!cycle?.plan.trial || !budget || ![exposureCents, cap, budget.reservedCents, budget.lastExposureCents]
      .every(value => number(value) && value >= 0)) return false;
    const additional = Math.max(0, exposureCents - budget.reservedCents);
    const reservedCents = budget.reservedCents + additional;
    if (reservedCents > cap) return false;
    const automatic = cycle.plan.userTrial?.limits?.maxTrialCostCents === undefined;
    const ledger = automatic ? this.store.getState(`trials:${this.input}`) : null;
    if (automatic && (!ledger || ledger.date !== dateKey(cycle.startedAt)
      || !number(ledger.reservedCents) || ledger.reservedCents < budget.reservedCents
      || ledger.reservedCents + additional > this.config.trialBudgetCentsPerDay)) return false;
    if (exposureCents === budget.lastExposureCents) return true;
    this.store.transaction(() => {
      if (automatic && additional > 0) this.store.setState(`trials:${this.input}`, {
        ...ledger, reservedCents: ledger.reservedCents + additional });
      cycle.trialBudget = { reservedCents, lastExposureCents: exposureCents };
      this.save(cycle);
    });
    return true;
  }
  trialProgress(now) {
    // A Finnish day is at most 25 hours. Seek a bounded recent suffix instead
    // of repeatedly extracting fields from large old recovery-cycle payloads.
    const rows = this.store.cycleSummaries({ input: this.input, limit: 100, since: now - 26 * HOUR });
    const date = dateKey(now), today = rows.filter(row => row.trial && row.startedAt <= now && dateKey(row.startedAt) === date);
    return { date, target: this.config.learningTrialTargetPerDay, attempted: today.length,
      completed: today.filter(row => row.status === 'completed').length,
      incomplete: today.filter(row => row.status === 'incomplete').length,
      assessed: today.filter(row => number(row.profitCents)).length,
      observedCompressorRunHours: today.reduce((sum, row) => sum + (row.compressorRunHours ?? 0), 0),
      remainingCents: this.budget(now),
      basis: 'Actual recorded trials today in Europe/Helsinki; completion and comparable assessment do not establish model acceptance.' };
  }
  start(plan, sample, now, { executed = false } = {}) {
    if (this.active()) return this.active();
    if (!Number.isSafeInteger(now) || sample?.timestamp !== now) throw new TypeError('A cycle requires its actual acknowledged start sample.');
    plan = structuredClone({ ...plan, prediction: summary(plan.prediction), referencePrediction: summary(plan.referencePrediction) });
    const common = { intervals: plan.intervals, model: plan.model, initialState: plan.initialState, targetC: plan.targetC,
      occupancy: plan.occupancy, maxDropC: plan.maxDropC, maxRiseC: plan.maxRiseC,
      config: plan.config ?? this.config, equipment: plan.equipment ?? {} };
    plan.prediction = summary(evaluateCycle({ ...common, schedule: plan.schedule }));
    plan.referencePrediction = summary(evaluateCycle({ ...common, schedule: plan.reference }));
    const cycle = { id: `${this.input}:${randomUUID()}`, startedAt: now, status: 'active', treatmentKey: plan.schedule.treatmentKey ?? 'native', plan,
      executionBasis: executed ? 'live-commanded' : 'simulated', modelConfig: { ...(plan.config ?? this.config) }, observationCount: 0, phases: [], lastSample: sampleEndpoint(sample), lastForecastVersion: sample.provenance?.forecastVersion ?? null,
      observerState: { ...plan.initialState }, referenceState: null, estimatedIndoorUsed: plan.equipment?.indoorEstimated === true,
      actual: { costCents: 0, electricityKwh: 0, recoveryCostCents: 0, recoveryEnergyKwh: 0,
        compressorKwh: 0, compressorRunHours: 0, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
        compressorActivityObserved: true, auxiliarySpaceObserved: false, auxiliaryObserved: true, recoveryAuxKwh: 0, auxiliaryRouteKnown: true, metered: true, coveredHours: 0, missingHours: 0,
        temperatureMissingHours: 0,
        spaceHeatingCostCents:0,spaceHeatingKwh:0,spaceHeatingRecoveryCostCents:0,spaceHeatingRecoveryKwh:0,
        dhwCostCents:0,dhwKwh:0,routeCoveredHours:0,routeMissingHours:0 },
      originalPrediction: { costCents: plan.prediction.costCents, recoveryCostCents: plan.prediction.recoveryCostCents,
        electricityKwh: plan.prediction.electricityKwh }, stableSince: null };
    if (plan.trial) cycle.trialBudget = { reservedCents: plan.trialAllowanceCents,
      lastExposureCents: plan.trialSafety?.costExposureCents ?? plan.trialAllowanceCents };
    this.store.transaction(() => {
      if (plan.trial && plan.userTrial?.limits?.maxTrialCostCents === undefined) {
        const old = this.store.getState(`trials:${this.input}`);
        this.store.setState(`trials:${this.input}`, { date: dateKey(now), reservedCents: (old?.date === dateKey(now) ? old.reservedCents : 0) + plan.trialAllowanceCents });
      }
      this.save(cycle);
      const saved = this.saveWorking(cycle,{ count: 0, observer: cycle.observerState, reference: null });
      this.rememberTrialPrefix(plan.trial ? initialTrialCostPrefix(cycle) : null, saved.digest);
      this.store.event('cycle-started', { id: cycle.id, input: this.input, trial: plan.trial, reference: plan.referenceLabel }, now);
    });
    return cycle;
  }
  cancel(now, reason) {
    const cycle = this.active(); if (!cycle) return;
    cycle.status = 'incomplete'; cycle.endedAt = now; cycle.incompleteReason = reason;
    this.store.transaction(() => {
      this.save(cycle);
      const phases = cycle.phases;
      if (phases.length && now > cycle.startedAt) appendLearningRecord(this.store, this.input, 'episode', {
        id: cycle.id, startedAt: cycle.startedAt, endedAt: now, phases,
        treatmentKey: cycle.treatmentKey ?? 'native', responseComplete: true,
        complete: false, recoveryComplete: false, origin: 'interrupted-cycle',
      }, { config: this.config, seed: this.learningSeed?.() ?? null });
      this.store.event('cycle-incomplete', { id: cycle.id, reason }, now);
    });
  }
  shorten(now, reason) {
    const cycle = this.active(); if (!cycle) return;
    if ((cycle.executionSchedule ?? cycle.plan.schedule).reductionEnd <= now) return;
    // Original prediction/reference stays immutable. Only actual requested execution changes.
    cycle.executionSchedule ??= { ...cycle.plan.schedule };
    cycle.executionSchedule.preheatEnd = Math.min(cycle.executionSchedule.preheatEnd, now);
    cycle.executionSchedule.reductionStart = Math.min(cycle.executionSchedule.reductionStart, now);
    cycle.executionSchedule.reductionEnd = Math.min(cycle.executionSchedule.reductionEnd, now);
    cycle.adjustments ??= []; cycle.adjustments.push({ at: now, reason });
    this.save(cycle);
  }
  record(sample,now,options = {}) {
    return this.store.transaction(() => this.#recordSample(sample,now,options));
  }
  #recordSample(sample, now, { thermalState, equipment = {}, controlIndoor = null } = {}) {
    const cycle = this.active(); if (!cycle) return null;
    const pending = this.workingJob();
    if (pending) {
      if (this.store.path !== ':memory:') throw new Error('Cycle reconstruction must precede live recording');
      this.adoptWorking(rebuildCycleWorking(this.store,pending));
      const rebuilt = this.active();
      cycle.observerState = rebuilt.observerState; cycle.referenceState = rebuilt.referenceState; cycle.stableSince = rebuilt.stableSince;
    }
    const working = this.readWorking(cycle);
    const rows = [];
    const previous = cycle.lastSample, dt = (now - previous.timestamp) / HOUR;
    if (dt <= 0) return null;
    const schedule = cycle.executionSchedule ?? cycle.plan.schedule;
    if (!number(dt) || dt > 0.5) { this.cancel(now, 'cycle-observation-gap'); return null; }
    const a = cycle.actual;
    cycle.estimatedIndoorUsed ||= controlIndoor?.estimated === true;
    let cursor = previous.timestamp;
    while (cursor < now) {
      // The sample describes the completed interval ending now. Its power must
      // never be projected into the following interval or the following tariff.
      const segment = sample.inputSegments?.find(s => s.start <= cursor && s.end > cursor);
      const values = segment ? { ...sample,...segment } : sample;
      const phase = ['normal','preheat','reduction','recovery'].includes(values.phase)
        ? values.phase : phaseAt(schedule,cursor);
      const frozen = cycle.plan.intervals.find(i => i.start <= cursor && i.end > cursor);
      const quote = sample.priceIntervals?.find(i => i.start <= cursor && i.end > cursor && number(i.price));
      const pointQuote = [sample,previous].find(s => number(s.priceCents) && number(s.priceStart) && number(s.priceEnd)
        && s.priceStart <= cursor && s.priceEnd > cursor);
      const currentQuote = quote ?? (pointQuote ? {price:pointQuote.priceCents,end:pointQuote.priceEnd}:null);
      const price = currentQuote?.price ?? frozen?.price;
      const boundaries = [schedule.preheatStart,schedule.preheatEnd,schedule.reductionStart,schedule.reductionEnd,
        ...(sample.inputSegments??[]).flatMap(s => [s.start,s.end]),
        ...(sample.priceIntervals??[]).filter(i => number(i.price)).flatMap(i => [i.start,i.end]),
        ...[sample,previous].filter(s => number(s.priceCents)).flatMap(s => [s.priceStart,s.priceEnd]),
        ...cycle.plan.intervals.flatMap(i => [i.start,i.end])].filter(t => number(t) && t > cursor);
      const end = Math.min(now, segment?.end ?? now, currentQuote?.end ?? frozen?.end ?? now,...boundaries);
      const hours = (end - cursor) / HOUR;
      // Meter/equipment coverage remains useful when a temperature is missing.
      // Temperature gaps separately prevent calibration and outcome validation.
      if (!number(previous.indoorC) || !number(sample.indoorC) || sample.indoorEstimated || previous.indoorEstimated)
        a.temperatureMissingHours = (a.temperatureMissingHours ?? 0) + hours;
      const eligible = number(values.powerKw)
        && values.powerKw >= 0 && number(price) && (!sample.inputSegments || Boolean(segment))
        && (!number(sample.windowStart) || cursor >= sample.windowStart);
      if (eligible) {
      const energy = values.powerKw * hours, cents = energy * price;
      a.electricityKwh += energy; a.costCents += cents; a.coveredHours += hours;
      if (phase === 'recovery') { a.recoveryEnergyKwh += energy; a.recoveryCostCents += cents; }
      if (number(values.compressorDuty)) {
        a.compressorRunHours += values.compressorDuty * hours;
        a.compressorKwh += (values.compressorPowerKw ?? cycle.modelConfig?.heatPumpCompressorKw ?? this.config.heatPumpCompressorKw) * values.compressorDuty * hours;
      }
      if (values.compressorActivityObserved !== true) a.compressorActivityObserved = false;
      if (values.auxiliaryObserved !== true) a.auxiliaryObserved = false;
      if (phase === 'recovery' && number(values.thermalAuxKw)) a.recoveryAuxKwh += values.thermalAuxKw * hours;
      if (values.auxiliaryRouteKnown !== true && !(values.auxiliaryObserved === true && values.auxKw === 0)) a.auxiliaryRouteKnown = false;
      if (values.auxRoute === 'space' && values.auxKw > 0) {
        a.spaceHeatingAuxKwh += values.auxKw * hours;
        if (phase === 'recovery' && values.auxiliaryObserved === true) a.auxiliarySpaceObserved = true;
      } else if (values.auxRoute === 'dhw' && values.auxKw > 0) a.dhwAuxKwh += values.auxKw * hours;
      const routed = number(values.thermalCompressorDuty) && number(values.thermalAuxKw);
      if (routed) {
        const spaceKw=((values.compressorPowerKw??cycle.modelConfig.heatPumpCompressorKw)
          +(values.circulationKw??cycle.modelConfig.circulationKw))*values.thermalCompressorDuty+values.thermalAuxKw;
        const spaceKwh=spaceKw*hours, spaceCents=spaceKwh*price;
        a.spaceHeatingKwh+=spaceKwh;a.spaceHeatingCostCents+=spaceCents;a.routeCoveredHours+=hours;
        a.dhwKwh+=Math.max(0,energy-spaceKwh);a.dhwCostCents+=Math.max(0,energy-spaceKwh)*price;
        if (phase==='recovery') {a.spaceHeatingRecoveryKwh+=spaceKwh;a.spaceHeatingRecoveryCostCents+=spaceCents;}
      } else {a.routeMissingHours+=hours;cycle.observerState=null;}
      if (values.energyBasis !== 'measured') a.metered = false;
      } else { a.missingHours += hours; a.compressorActivityObserved = false; a.auxiliaryObserved = false;
        a.auxiliaryRouteKnown = false; a.metered = false; cycle.observerState=null; }
      rows.push({ start: cursor, end, ...(end !== now ? { indoorEndpoint: false } : {}), outdoorC: values.outdoorC,
        solarRadiationWm2: values.solarRadiationWm2, supplyC: values.supplyC ?? null, brineC: values.brineC ?? null,
        floorOverrideMode: values.floorOverrideMode ?? null, treatmentKey: values.treatmentKey ?? null, price: price ?? null,
        priceBasis: currentQuote ? 'applicable-observed-quote' : frozen ? 'frozen-published-price' : 'missing',
        phase, indoorC: sample.indoorEstimated ? null : sample.indoorC, powerKw: values.powerKw, eligible,
        ...(controlIndoor?.estimated ? { indoorControlEstimate: { value: controlIndoor.value, uncertaintyC: controlIndoor.uncertaintyC,
          anchorAt: controlIndoor.anchorAt, estimatedSensor: controlIndoor.estimatedSensor } } : {}),
        thermalCompressorDuty:values.thermalCompressorDuty??null,thermalAuxKw:values.thermalAuxKw??null,
        compressorDuty:values.compressorDuty??null,auxKw:values.auxKw??null,
        roomBoostC: values.roomBoostC ?? 0,
        compressorPowerKw: values.compressorPowerKw ?? null, circulationKw: values.circulationKw ?? null,
        compressorActivityObserved: values.compressorActivityObserved ?? null, auxiliaryObserved: values.auxiliaryObserved ?? null,
        auxiliaryRouteKnown: values.auxiliaryRouteKnown ?? null, auxRoute: values.auxRoute ?? null, energyBasis: values.energyBasis ?? null });
      cycle.observerState = observedState(cycle,cycle.observerState,rows.at(-1),this.events(cycle));
      cursor = end;
    }
    const previousPrefix = this.trialPrefixMatches(cycle,working) ? this.trialCostPrefix : null;
    cycle.lastSample = sampleEndpoint(sample);
    cycle.lastForecastVersion = sample.provenance?.forecastVersion ?? null;
    cycle.observationCount += rows.length;
    cycle.phases = [...new Set([...cycle.phases,...rows.map(row => row.phase)])];
    const referenceState = advanceReference(cycle,rows,this.events(cycle),working.reference);
    cycle.referenceState = referenceState.continuation?.state ?? null;
    if (referenceState.unavailable) cycle.stableSince = null;
    this.store.transaction(() => {
      this.store.appendCycleEvidence(this.input,cycle,rows,{ sampleAt: now, provenance: sample.provenance ?? null,
        context: { controlIndoor, integral: equipment.integral ?? null, fireplaceRevision: this.fireplaceContext?.fireplaceRevision ?? 0 } });
      const saved = this.saveWorking(cycle,{ count: cycle.observationCount, observer: cycle.observerState, reference: referenceState });
      if (cycle.plan.trial) this.rememberTrialPrefix(advanceTrialCostPrefix(cycle, rows, this.events(cycle), previousPrefix), saved.digest);
    });
    if (now - schedule.reductionEnd > this.config.recoveryTimeoutHours * HOUR) {
      this.cancel(now,'recovery-not-established-before-timeout'); return null;
    }
    if (now < schedule.reductionEnd || referenceState.unavailable) return null;
    const reference = { endState: referenceState.continuation.state };
    const reserve = cycle.observerState?.reserveC;
    const recoveryIndoor = number(sample.indoorC) && !sample.indoorEstimated ? sample.indoorC
      : controlIndoor && !controlIndoor.stale ? controlIndoor.value : null;
    const sourceUncertainty = controlIndoor?.estimated ? controlIndoor.uncertaintyC : 0;
    const settled = number(recoveryIndoor) && number(sourceUncertainty)
      && (!controlIndoor?.estimated || now <= controlIndoor.validUntil)
      && recoveryIndoor - sourceUncertainty >= reference.endState.indoorC - 0.2
      && number(reserve) && reserve - sourceUncertainty >= reference.endState.reserveC - 0.25
      && (!cycle.plan.model.floor?.enabled || number(cycle.observerState?.slabC)
        && cycle.observerState.slabC - sourceUncertainty >= reference.endState.slabC - 0.25)
      && (sample.indoorTrendCPerHour ?? 0) >= -0.15
      && (!number(equipment.integral) || !number(cycle.plan.initialState.integral) || equipment.integral >= cycle.plan.initialState.integral - 60);
    cycle.stableSince = settled ? cycle.stableSince ?? now : null;
    if (cycle.stableSince !== null && now - cycle.stableSince >= HOUR && now - schedule.reductionEnd >= HOUR
      && now >= (cycle.recoveryHoldUntil ?? schedule.recoveryHoldUntil ?? schedule.reductionEnd)) {
      if (a.missingHours > 0.05) { this.cancel(now, 'insufficient-cycle-energy-coverage'); return null; }
      if (cycle.estimatedIndoorUsed || (a.temperatureMissingHours ?? 0) > 0) {
        // The control operation ended conservatively. An inferred endpoint or
        // unobserved trajectory cannot establish measured recovery or savings.
        cycle.status = 'completed'; cycle.endedAt = now;
        cycle.assessment = { profitCents: null, recoveryErrorCents: null, actualCostCents: a.costCents,
          basis: 'unassessed-indoor-observation-gap', recoveryBasis: 'Conservative control estimate; physical recovery not validated',
          referenceLabel: cycle.plan.referenceLabel, assessedAt: now };
        cycle.completionBasis = 'control-recovery-only';
        this.store.transaction(() => {
          this.save(cycle);
          this.store.event('cycle-completed', { id: cycle.id, assessment: cycle.assessment }, now);
        });
        return { id: cycle.id, complete: false, recoveryComplete: false };
      }
      this.save(cycle);
      const job = { id: cycle.id, count: cycle.observationCount, now, fireplaceEvents: this.events(cycle) };
      return this.store.path === ':memory:' ? this.complete(job,assessCycle(this.store,job)) : { assessmentJob: job };
    }
    this.save(cycle); return null;
  }
  complete(job,result) {
    const cycle = this.active();
    if (!cycle || cycle.id !== job.id || cycle.observationCount !== job.count) throw new Error('Cycle assessment became stale');
    cycle.status = 'completed'; cycle.endedAt = job.now; cycle.assessment = result.assessment;
    this.store.transaction(() => {
      this.save(cycle);
      appendLearningRecord(this.store,this.input,'episode',result.episode,
        { config: this.config, seed: this.learningSeed?.() ?? null });
      this.store.event('cycle-completed',{ id: cycle.id, assessment: cycle.assessment },job.now);
    });
    return result.episode;
  }
  metrics(baselineC) {
    const cycles = this.store.cycleSummaries({ input: this.input, completedOnly: true, limit: 30 });
    const aux = cycles.filter(c => c.auxiliarySpaceObserved);
    const metric = (rows, field) => { rows = rows.filter(c => number(c[field])); return { value: mean(rows.map(c => c[field] / 100)), count: rows.length,
      basis: 'Estimated space-heating €/assessed completed cycle; latest 30 completed cycles. DHW service excluded.',
      uncertainty: mean(rows.map(c => c.uncertaintyCents / 100)) }; };
    return { profit: metric(cycles, 'profitCents'), auxProfit: metric(aux, 'profitCents'),
      recoveryError: metric(cycles, 'recoveryErrorCents'),
      indoorTemperature: { value: number(baselineC) ? baselineC : null, count: number(baselineC) ? 1 : 0,
        basis: 'Learned normal occupied indoor temperature; held through preheat and recovery' } };
  }
  outcomes() {
    const rows=this.store.cycleSummaries({input:this.input,limit:100});
    return {attempted:rows.length,completed:rows.filter(c=>c.status==='completed').length,
      incomplete:rows.filter(c=>c.status==='incomplete').length,inProgress:rows.filter(c=>c.status==='active').length,
      assessed:rows.filter(c=>number(c.profitCents)).length,
      observedCostCents:rows.reduce((sum,c)=>sum+(c.actualCostCents??0),0),
      missingHours:rows.reduce((sum,c)=>sum+(c.missingHours??0),0),
      basis:'Latest 100 attempts, including incomplete cycles. Observed covered costs use nominal power unless metered; unknown periods excluded.'};
  }
  snapshot(metrics, now, modelVersion) {
    const old = this.store.getState(`learning:metrics:${this.input}`);
    if (JSON.stringify(old?.metrics) === JSON.stringify(metrics)) return;
    this.store.transaction(() => {
      for (const [name, signal, unit] of [['profit','learning_profit','EUR/cycle'],['auxProfit','learning_aux_profit','EUR/cycle'],
        ['recoveryError','learning_recovery_error','EUR/cycle'],['indoorTemperature','learning_indoor_temperature','degC']]) {
        const metric = metrics[name];
        this.store.observation({ source: 'controller-learning', device: this.input, signal, value: metric.value,
          unit, sourceTime: now, receivedAt: now, quality: metric.value === null ? ['missing'] : ['estimated'],
          raw: { ...metric, modelVersion, assessedAt: now } });
      }
      this.store.setState(`learning:metrics:${this.input}`, { at: now, metrics });
    });
  }
}
