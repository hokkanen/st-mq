import { randomUUID } from 'node:crypto';
import { appendLearningRecord } from './committed-learning.js';
import { evaluateCycle, phaseAt } from '../control/planner.js';
import { predictThermalStep } from '../control/adaptive-learning.js';
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
      energyKwh += (step.spaceHeatingPowerKw ?? step.powerKw) * hours;
      auxiliaryKwh += step.auxiliaryKw * hours;
      costCents += step.costCents * hours / step.durationHours
        * (step.powerKw ? (step.spaceHeatingPowerKw ?? step.powerKw)/step.powerKw : 1);
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
  controlHold(now) {
    const previous=this.store.cycleSummaries({input:this.input,limit:1})[0];
    return previous?.status==='incomplete'&&number(previous.endedAt)&&now-previous.endedAt<24*HOUR
      ? {until:previous.endedAt+24*HOUR,reason:previous.incompleteReason}:null;
  }
  budget(now) {
    const previous=this.store.cycleSummaries({input:this.input,limit:1})[0];
    const cooldown=previous?.status==='incomplete'?24:6;
    if (previous && (!previous.endedAt || now-previous.endedAt<cooldown*HOUR)) return 0;
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
      observerState: { ...plan.initialState },
      actual: { costCents: 0, electricityKwh: 0, recoveryCostCents: 0, recoveryEnergyKwh: 0,
        compressorKwh: 0, compressorRunHours: 0, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
        compressorActivityObserved: true, auxiliarySpaceObserved: false, auxiliaryObserved: true, recoveryAuxKwh: 0, auxiliaryRouteKnown: true, metered: true, coveredHours: 0, missingHours: 0,
        spaceHeatingCostCents:0,spaceHeatingKwh:0,spaceHeatingRecoveryCostCents:0,spaceHeatingRecoveryKwh:0,
        dhwCostCents:0,dhwKwh:0,routeCoveredHours:0,routeMissingHours:0 },
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
        ...(sample.inputSegments??[]).map(s => s.start)].filter(t => t > cursor);
      const end = Math.min(now, segment?.end ?? now, currentQuote?.end ?? frozen?.end ?? now,...boundaries);
      const hours = (end - cursor) / HOUR;
      const eligible = number(previous.indoorC) && number(sample.indoorC) && number(values.powerKw)
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
        if (cycle.observerState && number(values.outdoorC)) {
          const observer=predictThermalStep(cycle.plan.model,cycle.observerState,{outdoorC:values.outdoorC,
            solarRadiationWm2:values.solarRadiationWm2,phase,targetC:cycle.plan.targetC,roomBoostC:values.roomBoostC??0,
            compressorDuty:values.thermalCompressorDuty,auxKw:values.thermalAuxKw},hours);
          cycle.observerState={indoorC:observer.indoorC,reserveC:observer.reserveC};
        } else cycle.observerState=null;
      } else {a.routeMissingHours+=hours;cycle.observerState=null;}
      if (values.energyBasis !== 'measured') a.metered = false;
      } else { a.missingHours += hours; a.compressorActivityObserved = false; a.auxiliaryObserved = false;
        a.auxiliaryRouteKnown = false; a.metered = false; cycle.observerState=null; }
      cycle.observations.push({ start: cursor, end, outdoorC: values.outdoorC,
        solarRadiationWm2: values.solarRadiationWm2, price: price ?? null,
        priceBasis: currentQuote ? 'applicable-observed-quote' : frozen ? 'frozen-published-price' : 'missing',
        phase, indoorC: sample.indoorC, powerKw: values.powerKw, eligible,
        thermalCompressorDuty:values.thermalCompressorDuty??null,thermalAuxKw:values.thermalAuxKw??null,
        compressorDuty:values.compressorDuty??null,auxKw:values.auxKw??null,
        provenance: sample.provenance ?? null });
      cursor = end;
    }
    cycle.lastSample = sample;
    if (cycle.observerState && number(sample.indoorC)) cycle.observerState.indoorC=sample.indoorC;
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
    const reserve = cycle.observerState?.reserveC;
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
      const comparableSpace=a.routeMissingHours<=0.001 && a.routeCoveredHours>0;
      const trajectoryErrors = predicted ? cycle.observations.map(o => {
        const step=predicted.trajectory.find(row => row.at>=o.end && row.at-row.durationHours*HOUR<o.end);
        return step && number(o.indoorC) ? {error:Math.abs(step.indoorC-o.indoorC),hours:(o.end-o.start)/HOUR}:null;
      }).filter(Boolean):[];
      const trajectoryHours=trajectoryErrors.reduce((s,r)=>s+r.hours,0);
      cycle.assessment = { profitCents: comparableSpace ? reference.spaceHeatingCostCents - a.spaceHeatingCostCents : null,
        wholeCycleProfitCents:null, wholeCycleProfitReason:'DHW demand, delivery and tank recovery are not counterfactually modelled.',
        referenceCostCents: reference.spaceHeatingCostCents, actualCostCents: a.costCents,
        actualSpaceHeatingCostCents:a.spaceHeatingCostCents,dhwCostCents:a.dhwCostCents,
        recoveryErrorCents: originalRecovery && comparableSpace ? Math.abs(originalRecovery.costCents - a.spaceHeatingRecoveryCostCents) : null,
        uncertaintyCents: Math.max(5, reference.uncertaintyCents + (a.metered ? 0 : Math.abs(a.costCents) * 0.35)),
        basis: comparableSpace ? 'estimated-space-heating-execution-and-reference' : 'unassessed-missing-space-heating-attribution',
        recoveryPredictionBasis: originalRecovery ? 'Frozen model and original forecast over the observed recovery period'
          : cycle.adjustments?.length ? 'Unavailable: executed schedule changed' : 'Unavailable: original forecast did not cover the complete cycle',
        calibrationBasis: 'Executed actions and contemporaneous weather estimates; frozen model',
        recoveryBasis: 'Comparable room temperature and reserve reconstructed with the frozen cycle model, held for one hour; DHW service excluded',
        referenceLabel: cycle.plan.referenceLabel, assessedAt: now };
      const episode = { id: cycle.id, complete: true, recoveryComplete: true, startedAt: cycle.startedAt, endedAt: now,
        energyBasis: a.metered ? 'measured' : 'estimated', compressorKwh: a.compressorKwh,
        compressorRunHours: a.compressorRunHours, recoveryHours: (now - schedule.reductionEnd) / HOUR,
        recoveryEnergyKwh: a.spaceHeatingRecoveryKwh, spaceHeatingAuxKwh: a.spaceHeatingAuxKwh,
        dhwAuxKwh: a.dhwAuxKwh, predictedEnergyKwh: calibration.spaceHeatingKwh,
        actualEnergyKwh: a.spaceHeatingKwh,
        predictedRecoveryEnergyKwh: calibratedRecovery.energyKwh,
        predictedRecoveryAuxKwh: calibratedRecovery.auxiliaryKwh,
        predictedSpaceHeatingAuxKwh: calibration.auxiliaryKwh,
        recoveryAuxKwh: a.recoveryAuxKwh, compressorActivityObserved: a.compressorActivityObserved, auxiliaryObserved: a.auxiliaryObserved, auxiliaryRouteKnown: a.auxiliaryRouteKnown,
        frozenRecoveryMultiplier: cycle.plan.model.energy.recoveryMultiplier,
        frozenAuxiliaryRiskScale: cycle.plan.model.energy.auxiliaryRiskScale ?? 1,
        forecastValidation:{eligible:Boolean(predicted && comparableSpace && trajectoryHours>0),
          temperatureMaeC:trajectoryHours?trajectoryErrors.reduce((s,r)=>s+r.error*r.hours,0)/trajectoryHours:null,
          minimumTemperatureErrorC:predicted?Math.abs(Math.min(...predicted.trajectory.map(r=>r.indoorC))-Math.min(...cycle.observations.map(r=>r.indoorC))):null,
          energyRelativeError:predicted && a.spaceHeatingKwh>=.1?Math.abs(predicted.spaceHeatingKwh-a.spaceHeatingKwh)/a.spaceHeatingKwh:null,
          costRelativeError:predicted?Math.abs(predicted.spaceHeatingCostCents-a.spaceHeatingCostCents)/Math.max(5,Math.abs(a.spaceHeatingCostCents)):null,
          costAbsoluteErrorCents:predicted?Math.abs(predicted.spaceHeatingCostCents-a.spaceHeatingCostCents):null,
          recoveryCostErrorCents:cycle.assessment.recoveryErrorCents,
          reductionHours:(schedule.reductionEnd-schedule.reductionStart)/HOUR,
          basis:'frozen-advance-forecast',adjusted:Boolean(cycle.adjustments?.length)},
        phases: [...new Set(cycle.observations.map(row => row.phase))],
        provenance: { basis: 'committed-history', forecastVersion: cycle.lastSample.provenance?.forecastVersion ?? null } };
      // Completion and calibration are one durable operation. A crash after
      // this commit leaves an unapplied journal entry, not a lost episode.
      this.store.transaction(() => {
        this.save(cycle);
        appendLearningRecord(this.store, this.input, 'episode', episode, { config: this.config, seed: this.learningSeed?.() ?? null });
        this.store.event('cycle-completed', { id: cycle.id, assessment: cycle.assessment }, now);
      });
      return episode;
    }
    this.save(cycle); return null;
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
