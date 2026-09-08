import { randomUUID } from 'node:crypto';
import { evaluateCycle, phaseAt } from '../control/planner.js';
import { CONTROL_DEFAULTS } from './config.js';

const HOUR = 3600000;
const number = Number.isFinite;
const dateKey = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const mean = rows => rows.length ? rows.reduce((sum, x) => sum + x, 0) / rows.length : null;
const summary = result => { const { trajectory, ...values } = result ?? {}; return values; };
const recoveryTotals = (trajectory, observations) => {
  let costCents = 0, energyKwh = 0, auxiliaryKwh = 0;
  for (const step of trajectory) {
    const start = step.at - step.durationHours * HOUR;
    for (const observed of observations) if (observed.phase === 'recovery') {
      const hours = Math.max(0, Math.min(step.at, observed.end) - Math.max(start, observed.start)) / HOUR;
      if (!hours) continue;
      energyKwh += step.powerKw * hours;
      auxiliaryKwh += step.auxiliaryKw * hours;
      costCents += step.costCents * hours / step.durationHours;
    }
  }
  return { costCents, energyKwh, auxiliaryKwh };
};

export class CycleTracker {
  constructor({ store, input, config = {} }) {
    this.store = store; this.input = input; this.config = { ...CONTROL_DEFAULTS, ...config };
    this.key = `cycle:active:${input}`;
  }
  active() { return this.store.getState(this.key); }
  save(cycle) { this.store.cycle(this.input, cycle); this.store.setState(this.key, cycle.status === 'completed' || cycle.status === 'incomplete' ? null : cycle); }
  budget(now) {
    const state = this.store.getState(`trials:${this.input}`);
    return Math.max(0, this.config.trialBudgetCentsPerDay - (state?.date === dateKey(now) ? state.reservedCents : 0));
  }
  start(plan, sample, now, { executed = false } = {}) {
    if (this.active()) return this.active();
    plan = structuredClone({ ...plan, prediction: summary(plan.prediction), referencePrediction: summary(plan.referencePrediction) });
    const common = { intervals: plan.intervals, model: plan.model, initialState: plan.initialState, targetC: plan.targetC,
      occupancy: plan.occupancy, maxDropC: plan.maxDropC, config: this.config, equipment: plan.equipment ?? {} };
    plan.prediction = summary(evaluateCycle({ ...common, schedule: plan.schedule }));
    plan.referencePrediction = summary(evaluateCycle({ ...common, schedule: plan.reference }));
    const cycle = { id: `${this.input}:${randomUUID()}`, startedAt: now, status: 'active', plan,
      executionBasis: executed ? 'live-commanded' : 'simulated', modelConfig: { ...this.config }, observations: [], lastSample: sample,
      actual: { costCents: 0, electricityKwh: 0, recoveryCostCents: 0, recoveryEnergyKwh: 0,
        compressorKwh: 0, compressorRunHours: 0, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
        compressorActivityObserved: true, auxiliarySpaceObserved: false, auxiliaryObserved: true, recoveryAuxKwh: 0, auxiliaryRouteKnown: true, metered: true, coveredHours: 0, missingHours: 0 },
      originalPrediction: { costCents: plan.prediction.costCents, recoveryCostCents: plan.prediction.recoveryCostCents,
        electricityKwh: plan.prediction.electricityKwh }, stableSince: null };
    if (plan.trial) {
      const old = this.store.getState(`trials:${this.input}`);
      this.store.setState(`trials:${this.input}`, { date: dateKey(now), reservedCents: (old?.date === dateKey(now) ? old.reservedCents : 0) + plan.trialAllowanceCents });
    }
    this.save(cycle);
    this.store.event('cycle-started', { id: cycle.id, input: this.input, trial: plan.trial, reference: plan.referenceLabel }, now);
    return cycle;
  }
  cancel(now, reason) {
    const cycle = this.active(); if (!cycle) return;
    cycle.status = 'incomplete'; cycle.endedAt = now; cycle.incompleteReason = reason;
    this.save(cycle); this.store.event('cycle-incomplete', { id: cycle.id, reason }, now);
  }
  shorten(now, reason) {
    const cycle = this.active(); if (!cycle) return;
    // Original prediction/reference stays immutable. Only actual requested execution changes.
    cycle.executionSchedule ??= { ...cycle.plan.schedule };
    cycle.executionSchedule.preheatEnd = Math.min(cycle.executionSchedule.preheatEnd, now);
    cycle.executionSchedule.reductionStart = Math.min(cycle.executionSchedule.reductionStart, now);
    cycle.executionSchedule.reductionEnd = Math.min(cycle.executionSchedule.reductionEnd, now);
    cycle.adjustments ??= []; cycle.adjustments.push({ at: now, reason });
    this.save(cycle);
  }
  record(sample, now, { thermalState, equipment = {} } = {}) {
    const cycle = this.active(); if (!cycle) return null;
    const previous = cycle.lastSample, dt = (now - previous.timestamp) / HOUR;
    if (dt <= 0) return null;
    const schedule = cycle.executionSchedule ?? cycle.plan.schedule;
    if (!number(dt) || dt > 0.5) { this.cancel(now, 'cycle-observation-gap'); return null; }
    const a = cycle.actual;
    const phase = previous.phase ?? phaseAt(schedule, previous.timestamp);
    let cursor = previous.timestamp;
    while (cursor < now) {
      const frozen = cycle.plan.intervals.find(i => i.start <= cursor && i.end > cursor);
      const currentQuote = number(previous.priceCents) && number(previous.priceStart) && number(previous.priceEnd)
        && previous.priceStart <= cursor && previous.priceEnd > cursor;
      const price = currentQuote ? previous.priceCents : frozen?.price;
      const end = Math.min(now, currentQuote ? previous.priceEnd : frozen?.end ?? now);
      const hours = (end - cursor) / HOUR;
      const eligible = number(previous.indoorC) && number(sample.indoorC) && number(previous.powerKw)
        && previous.powerKw >= 0 && number(price);
      if (eligible) {
      const energy = previous.powerKw * hours, cents = energy * price;
      a.electricityKwh += energy; a.costCents += cents; a.coveredHours += hours;
      if (phase === 'recovery') { a.recoveryEnergyKwh += energy; a.recoveryCostCents += cents; }
      if (number(previous.compressorDuty)) {
        a.compressorRunHours += previous.compressorDuty * hours;
        a.compressorKwh += (previous.compressorPowerKw ?? cycle.modelConfig?.heatPumpCompressorKw ?? this.config.heatPumpCompressorKw) * previous.compressorDuty * hours;
      }
      if (previous.compressorActivityObserved !== true) a.compressorActivityObserved = false;
      if (previous.auxiliaryObserved !== true) a.auxiliaryObserved = false;
      if (phase === 'recovery' && number(previous.auxKw)) a.recoveryAuxKwh += previous.auxKw * hours;
      if (previous.auxiliaryRouteKnown !== true && !(previous.auxiliaryObserved === true && previous.auxKw === 0)) a.auxiliaryRouteKnown = false;
      if (previous.auxRoute === 'space' && previous.auxKw > 0) {
        a.spaceHeatingAuxKwh += previous.auxKw * hours;
        if (phase === 'recovery' && previous.auxiliaryObserved === true) a.auxiliarySpaceObserved = true;
      } else if (previous.auxRoute === 'dhw' && previous.auxKw > 0) a.dhwAuxKwh += previous.auxKw * hours;
      if (previous.energyBasis !== 'measured') a.metered = false;
      } else { a.missingHours += hours; a.compressorActivityObserved = false; a.auxiliaryObserved = false; a.auxiliaryRouteKnown = false; a.metered = false; }
      cycle.observations.push({ start: cursor, end, outdoorC: previous.outdoorC,
        solarRadiationWm2: previous.solarRadiationWm2, price: price ?? null,
        priceBasis: currentQuote ? 'applicable-observed-quote' : frozen ? 'frozen-published-price' : 'missing',
        phase, indoorC: sample.indoorC, powerKw: previous.powerKw, eligible });
      cursor = end;
    }
    cycle.lastSample = sample;
    if (cycle.observations.length > 3000) { this.cancel(now, 'cycle-observation-limit'); return null; }
    if (now - cycle.startedAt > this.config.recoveryTimeoutHours * HOUR) {
      this.cancel(now, 'recovery-not-established-before-timeout'); return null;
    }
    if (now < schedule.reductionEnd) { this.save(cycle); return null; }
    const intervals = cycle.observations.map(o => ({ start: o.start, end: o.end,
      outdoorC: o.outdoorC, solarRadiationWm2: o.solarRadiationWm2, price: o.price }));
    if (intervals.some(i => !number(i.outdoorC) || !number(i.price))) { this.save(cycle); return null; }
    const reference = evaluateCycle({ schedule: cycle.plan.reference, intervals, model: cycle.plan.model,
      initialState: cycle.plan.initialState, targetC: cycle.plan.targetC, config: cycle.modelConfig ?? this.config,
      occupancy: cycle.plan.occupancy, maxDropC: cycle.plan.maxDropC,
      equipment: cycle.plan.equipment ?? {}, includeTail: false });
    const reserve = thermalState?.reserveC;
    const settled = sample.indoorC >= reference.endState.indoorC - 0.2
      && number(reserve) && reserve >= reference.endState.reserveC - 0.25
      && (sample.indoorTrendCPerHour ?? 0) >= -0.15
      && (!number(equipment.integral) || !number(cycle.plan.initialState.integral) || equipment.integral >= cycle.plan.initialState.integral - 60);
    cycle.stableSince = settled ? cycle.stableSince ?? now : null;
    if (cycle.stableSince !== null && now - cycle.stableSince >= HOUR && now - schedule.reductionEnd >= HOUR) {
      if (a.missingHours > 0.05) { this.cancel(now, 'insufficient-cycle-energy-coverage'); return null; }
      cycle.status = 'completed'; cycle.endedAt = now;
      // Assess the executed recovery under the frozen model and original settings,
      // rather than comparing a short observed episode to a 48-hour forecast total.
      const originalCoverage = intervals.every(i => cycle.plan.intervals.some(x => x.start <= i.start && x.end >= i.end));
      const predictionIntervals = originalCoverage ? intervals.map(i => {
        const original = cycle.plan.intervals.find(x => x.start <= i.start && x.end > i.start);
        return { ...i, outdoorC: original.outdoorC, solarRadiationWm2: original.solarRadiationWm2, price: original.price };
      }) : null;
      const common = { model: cycle.plan.model, initialState: cycle.plan.initialState, targetC: cycle.plan.targetC,
        config: cycle.modelConfig ?? this.config, occupancy: cycle.plan.occupancy, maxDropC: cycle.plan.maxDropC,
        equipment: cycle.plan.equipment ?? {}, includeTail: false };
      const predicted = predictionIntervals && !cycle.adjustments?.length
        ? evaluateCycle({ ...common, schedule: cycle.plan.schedule, intervals: predictionIntervals }) : null;
      // Parameter calibration uses the actually executed actions and the same
      // contemporaneous weather/solar estimates as the assessment. A shortened
      // action is not falsely labelled an error in the original prediction.
      const calibration = evaluateCycle({ ...common, schedule, intervals });
      const originalRecovery = predicted ? recoveryTotals(predicted.trajectory, cycle.observations) : null;
      const calibratedRecovery = recoveryTotals(calibration.trajectory, cycle.observations);
      cycle.assessment = { profitCents: reference.costCents - a.costCents,
        referenceCostCents: reference.costCents, actualCostCents: a.costCents,
        recoveryErrorCents: originalRecovery ? Math.abs(originalRecovery.costCents - a.recoveryCostCents) : null,
        uncertaintyCents: Math.max(5, reference.uncertaintyCents + (a.metered ? 0 : Math.abs(a.costCents) * 0.35)),
        basis: a.metered ? 'metered-execution-modelled-reference' : 'estimated-execution-and-reference',
        recoveryPredictionBasis: originalRecovery ? 'Frozen model and original forecast over the observed recovery period'
          : cycle.adjustments?.length ? 'Unavailable: executed schedule changed' : 'Unavailable: original forecast did not cover the complete cycle',
        calibrationBasis: 'Executed actions and contemporaneous weather estimates; frozen model',
        recoveryBasis: 'Comparable room temperature and modelled heat reserve held for one hour',
        referenceLabel: cycle.plan.referenceLabel, assessedAt: now };
      this.save(cycle);
      this.store.event('cycle-completed', { id: cycle.id, assessment: cycle.assessment }, now);
      return { id: cycle.id, complete: true, recoveryComplete: true, endedAt: now,
        energyBasis: a.metered ? 'measured' : 'estimated', compressorKwh: a.compressorKwh,
        compressorRunHours: a.compressorRunHours, recoveryHours: (now - schedule.reductionEnd) / HOUR,
        recoveryEnergyKwh: a.recoveryEnergyKwh, spaceHeatingAuxKwh: a.spaceHeatingAuxKwh,
        dhwAuxKwh: a.dhwAuxKwh, predictedEnergyKwh: calibration.electricityKwh,
        actualEnergyKwh: a.electricityKwh,
        predictedRecoveryEnergyKwh: calibratedRecovery.energyKwh,
        predictedRecoveryAuxKwh: calibratedRecovery.auxiliaryKwh,
        predictedSpaceHeatingAuxKwh: calibration.auxiliaryKwh,
        recoveryAuxKwh: a.recoveryAuxKwh, compressorActivityObserved: a.compressorActivityObserved, auxiliaryObserved: a.auxiliaryObserved, auxiliaryRouteKnown: a.auxiliaryRouteKnown,
        frozenRecoveryMultiplier: cycle.plan.model.energy.recoveryMultiplier,
        frozenAuxiliaryRiskScale: cycle.plan.model.energy.auxiliaryRiskScale ?? 1 };
    }
    this.save(cycle); return null;
  }
  metrics(baselineC) {
    const cycles = this.store.cycles({ input: this.input, completedOnly: true, limit: 30 });
    const aux = cycles.filter(c => c.actual.auxiliarySpaceObserved);
    const metric = (rows, field) => { rows = rows.filter(c => number(c.assessment[field])); return { value: mean(rows.map(c => c.assessment[field] / 100)), count: rows.length,
      basis: 'Estimated €/completed cycle; latest 30 completed cycles',
      uncertainty: mean(rows.map(c => c.assessment.uncertaintyCents / 100)) }; };
    return { profit: metric(cycles, 'profitCents'), auxProfit: metric(aux, 'profitCents'),
      recoveryError: metric(cycles, 'recoveryErrorCents'),
      indoorTemperature: { value: number(baselineC) ? baselineC : null, count: number(baselineC) ? 1 : 0,
        basis: 'Learned normal occupied indoor temperature; held through preheat and recovery' } };
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
