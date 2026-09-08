import { initialAdaptiveModel, predictThermalStep, predictEquipmentDuty, thermalEvidenceReady, actionEvidenceReady, thermalUncertaintyC } from './adaptive-learning.js';
import { comfortPenalty } from './index.js';
import { CONTROL_DEFAULTS } from '../app/config.js';

const HOUR = 3600000, STEP = 900000;
const number = Number.isFinite;
const at = value => typeof value === 'number' ? value : Date.parse(value);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const settledAgainst = (state, reference) => state.indoorC >= reference.indoorC - 0.15
  && state.reserveC >= reference.reserveC - 0.15;
export const phaseAt = (schedule, now) => !schedule ? 'normal' : now >= schedule.preheatStart && now < schedule.preheatEnd ? 'preheat'
  : now >= schedule.reductionStart && now < schedule.reductionEnd ? 'reduction'
    : now >= schedule.reductionEnd ? 'recovery' : 'normal';

export function learningReadiness(checkpoint, config = {}, equipment = {}) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model;
  const thermalValidated = thermalEvidenceReady(model), responseValidated = actionEvidenceReady(model, 'reduction');
  const advanceValidated = model?.forecastValidation?.accepted === true;
  const actionValidated = responseValidated && advanceValidated;
  const trialReady = c.learningTrials && (checkpoint?.health?.usableSamples ?? 0) >= 4
    && number(equipment.compressorOn) && number(equipment.dhwRouting)
    && (!number(equipment.trialBudgetRemainingCents)||equipment.trialBudgetRemainingCents>0);
  return { thermalValidated, responseValidated, advanceValidated, actionValidated, trialReady,
    reasons: [!thermalValidated && 'awaiting-held-out-thermal-trajectories',
      !actionValidated && 'awaiting-held-out-tariff-response',
      !advanceValidated && 'awaiting-frozen-advance-cycle-predictions',
      !trialReady && 'trials-require-enabled-budget-and-observed-equipment'].filter(Boolean),
    basis: 'Thermal and equipment-response checks are separate; counterfactual savings remain estimates.' };
}

export function recoveryPolicy({ now, reductionEnd, indoorC, targetC, indoorTrendCPerHour,
  occupancy = { mode: 'occupied' }, equipment = {}, config = {}, forced = false, fallbackAt = null }) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && at(occupancy.returnAt) <= now + HOUR;
  const reason = !c.recoveryCompressorOnly ? 'native-recovery-configured' : forced ? 'control-or-comfort-fallback'
    : fallbackAt !== null ? 'native-recovery-fallback-latched'
      : !equipment.h66Available ? 'native-settings-unavailable'
        : now - reductionEnd >= c.recoveryCompressorOnlyHours * HOUR ? 'compressor-recovery-time-limit'
          : !number(indoorC) || !number(targetC) ? 'missing-recovery-temperature'
            : occupied && (indoorC <= targetC - c.recoveryComfortMarginC
              || number(indoorTrendCPerHour) && indoorC + Math.min(0, indoorTrendCPerHour) * 0.5 <= targetC - c.recoveryComfortMarginC)
              ? 'recovery-comfort-margin' : null;
  return { recoveryCompressorOnly: reason === null, recoveryFallbackReason: reason };
}

export function forecastIntervals(prices = [], forecast = [], now, horizonHours = 48) {
  const result = [];
  let cursor = now;
  const endLimit = now + horizonHours * HOUR;
  const ordered = prices.filter(p => at(p.end) > now).sort((a, b) => at(a.start) - at(b.start));
  for (const p of ordered) {
    if (at(p.start) > cursor || !number(p.allInCentsPerKWh)) break;
    if (at(p.end) <= cursor) continue;
    while (cursor < Math.min(at(p.end), endLimit)) {
      const w = forecast.find(w => at(w.start) <= cursor && at(w.end) > cursor);
      const issued = w?.issuedAt == null && w?.issuedAtBasis === 'fetched-snapshot' ? at(w?.fetchedAt) : at(w?.issuedAt);
      if (!w || !number(w.outdoorC) || !number(issued) || issued > now || now - issued > 6 * HOUR) return result;
      const end = Math.min(at(p.end), at(w.end), cursor + STEP, endLimit);
      if (end <= cursor) return result;
      result.push({ start: cursor, end, outdoorC: w.outdoorC,
        solarRadiationWm2: number(w.solarRadiationWm2) ? w.solarRadiationWm2 : null,
        price: p.allInCentsPerKWh, forecastIssuedAt: issued });
      cursor = end;
      if (result.length >= 384 || cursor >= endLimit) return result;
    }
  }
  return result;
}

export function auxiliaryThreshold(config = {}) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  return c.a2Basis === 'offset'
    ? number(c.compressorIntegralA1) ? c.compressorIntegralA1 + c.auxIntegralA2 : null
    : c.auxIntegralA2;
}

/** Same thermal predictor is used in fitting, dispatch and frozen-reference evaluation. */
export function evaluateCycle({ schedule = null, intervals, model, initialState, targetC,
  occupancy = { mode: 'occupied' }, maxDropC = 1, config = {}, equipment = {}, includeTail = true }) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  model ??= initialAdaptiveModel(c);
  if (!Array.isArray(intervals) || !number(initialState?.indoorC) || !number(targetC))
    throw new TypeError('A cycle requires intervals, indoor temperature and a target');
  let state = { indoorC: initialState.indoorC, reserveC: initialState.reserveC ?? initialState.indoorC };
  let nativeState = { ...state };
  const initialIntegral = number(initialState.integral) ? initialState.integral : null;
  const threshold = auxiliaryThreshold(c);
  let costCents = 0, electricityKwh = 0, auxiliaryKwh = 0, recoveryCostCents = 0, preheatCostCents = 0;
  let absoluteCostCents = 0, recoveryEnergyKwh = 0, recoveryAuxKwh = 0, spaceHeatingCostCents=0, spaceHeatingKwh=0;
  let penalty = 0, severe = false, uncertaintyC = 0, elapsed = 0;
  let recoverySettledHours = 0, recoveredAt = null, previousEnd = null, recoveryFallbackAt=null, indoorTrendCPerHour=null;
  const trajectory = [];

  // Native integral/reset behaviour is not identified by room temperature. Use
  // measured trends only for the first hour; afterwards leave the projection
  // unknown and use the explicitly uncertain heat-demand prior.
  const projection = hours => {
    const integral = initialIntegral !== null && hours <= 1
      ? clamp(initialIntegral + (number(equipment.integralTrendPerHour) ? equipment.integralTrendPerHour : 0) * hours, -5000, 500) : null;
    const supplyShortfallC = number(equipment.supplyShortfallC) && hours <= 1
      ? equipment.supplyShortfallC + (number(equipment.supplyShortfallTrendPerHour) ? equipment.supplyShortfallTrendPerHour : 0) * hours : null;
    const compressorIntegralDemand = integral !== null && number(c.compressorIntegralA1)
      ? integral <= c.compressorIntegralA1 : null;
    const compressorHysteresisDemand = supplyShortfallC !== null && number(c.compressorHysteresisC)
      ? supplyShortfallC >= c.compressorHysteresisC : null;
    return { integral, supplyShortfallC,
      nativeCompressorDemand: compressorIntegralDemand === true || compressorHysteresisDemand === true ? true
        : compressorIntegralDemand === false && compressorHysteresisDemand === false ? false : null };
  };
  const predict = (before, phase, boost, interval, dt, projected, native = false) => {
    const inputs = { outdoorC: interval.outdoorC, solarRadiationWm2: interval.solarRadiationWm2,
      phase, roomBoostC: boost, targetC };
    // Current native integral/target readings describe the currently applied
    // phase only. They are not evidence about an unexecuted tariff threshold.
    const nativeCompressorDemand = equipment.observedPhase === phase ? projected.nativeCompressorDemand : null;
    const duty = predictEquipmentDuty(model, before, { ...inputs, nativeCompressorDemand }, dt);
    inputs.compressorDuty = duty.compressorDuty;
    const preliminary = predictThermalStep(model, before, inputs, dt);
    const shortage = Math.max(0, targetC - preliminary.indoorC);
    const reserveShortage = Math.max(0, targetC - preliminary.reserveC);
    const thresholdRisk = threshold !== null && projected.integral !== null
      ? clamp((threshold - projected.integral + 180) / 360, 0, 1) : 0;
    const hysteresisRisk = projected.supplyShortfallC !== null
      ? clamp((projected.supplyShortfallC - c.auxHysteresisC + 5) / 10, 0, 1) : 0;
    const capacityRisk = projected.nativeCompressorDemand === true
      ? Math.max(0, preliminary.compressorDuty - 0.85) * shortage : 0;
    // Do not hold cumulative historical deficit forever after it has recovered.
    const priorRisk = preliminary.compressorDuty < 0.01 ? 0 : phase === 'recovery' ? clamp(shortage * 0.3 + reserveShortage * 0.15, 0.03, 0.8)
      : phase === 'preheat' ? clamp(boost * 0.025, 0, 0.2) : 0.015;
    const projectedAt=intervals[0].start+elapsed*HOUR;
    const policy=!native&&phase==='recovery'?recoveryPolicy({
      now:projectedAt,reductionEnd:schedule.reductionEnd,indoorC:before.indoorC,targetC,
      indoorTrendCPerHour,occupancy,equipment,config:c,fallbackAt:recoveryFallbackAt}):null;
    if (policy&&!policy.recoveryCompressorOnly) recoveryFallbackAt??=projectedAt;
    const compressorRecovery=policy?.recoveryCompressorOnly??false;
    const blocked = equipment.nativeAuxAllowed === false || !native && phase === 'reduction' && equipment.h66Available || compressorRecovery;
    const risk = blocked ? 0 : Math.max(thresholdRisk, hysteresisRisk, capacityRisk, priorRisk);
    const auxKw = Math.min(c.auxRatedKw, c.auxRatedKw * risk * (model.energy?.auxiliaryRiskScale ?? 1));
    return { ...predictThermalStep(model, before, { ...inputs, auxKw }, dt), auxKw, auxiliaryRisk: risk,
      equipmentBasis: duty.basis, uncertaintyDuty: duty.uncertaintyDuty, recoveryCompressorOnly: compressorRecovery };
  };
  for (const interval of intervals) {
    if (!number(interval.start) || !number(interval.end) || interval.end <= interval.start
      || !number(interval.outdoorC) || !number(interval.price)
      || previousEnd !== null && interval.start !== previousEnd) throw new TypeError('Cycle intervals must be valid and continuous');
    previousEnd = interval.end;
    let time = interval.start;
    while (time < interval.end) {
      const boundaries = schedule ? [schedule.preheatStart, schedule.preheatEnd, schedule.reductionStart, schedule.reductionEnd] : [];
      const returnAt = at(occupancy.returnAt);
      if (number(returnAt)) boundaries.push(returnAt);
      const end = Math.min(interval.end, time + STEP, ...boundaries.filter(v => v > time));
      const dt = (end - time) / HOUR;
      const requestedPhase = phaseAt(schedule, time);
      const phase = requestedPhase === 'recovery' && recoveredAt !== null ? 'normal' : requestedPhase;
      const roomBoostC = phase === 'preheat' ? schedule.roomBoostC : 0;
      const projected = projection(elapsed + dt);
      const native = predict(nativeState, 'normal', 0, interval, dt, projected, true);
      nativeState = { indoorC: native.indoorC, reserveC: native.reserveC };
      const prediction = schedule ? predict(state, phase, roomBoostC, interval, dt, projected) : native;
      indoorTrendCPerHour=(prediction.indoorC-state.indoorC)/dt;
      state = { indoorC: prediction.indoorC, reserveC: prediction.reserveC };
      elapsed += dt;
      uncertaintyC = thermalUncertaintyC(model, elapsed, { phase,solarRadiationWm2: interval.solarRadiationWm2 });
      const duty = prediction.compressorDuty, auxKw = prediction.auxKw;
      const compressorKw = model.energy?.compressorKw ?? c.heatPumpCompressorKw;
      const recoveryMultiplier = phase === 'recovery' ? model.energy?.recoveryMultiplier ?? 1.15 : 1;
      // Higher supply demand and DHWR recharge add electrical cost to coupled preheat.
      const preheatMultiplier = phase === 'preheat' ? 1 + roomBoostC * 0.035 : 1;
      const kw = compressorKw * duty * recoveryMultiplier * preheatMultiplier + c.circulationKw * duty + auxKw
        + (phase === 'preheat' ? c.dhwrKw : 0);
      const kwh = kw * dt, cents = kwh * interval.price;
      const spaceHeatingPowerKw=kw-(phase==='preheat'?c.dhwrKw:0);
      spaceHeatingKwh+=spaceHeatingPowerKw*dt;spaceHeatingCostCents+=spaceHeatingPowerKw*dt*interval.price;
      costCents += cents; electricityKwh += kwh; auxiliaryKwh += auxKw * dt;
      absoluteCostCents += Math.abs(cents);
      if (phase === 'recovery') { recoveryCostCents += cents; recoveryEnergyKwh += kwh; recoveryAuxKwh += auxKw * dt; }
      if (phase === 'preheat') preheatCostCents += cents;
      const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && end >= at(occupancy.returnAt);
      if (occupied) {
        penalty += comfortPenalty(state.indoorC, targetC, maxDropC, dt);
        if (state.indoorC - uncertaintyC < targetC - 2) severe = true;
      }
      trajectory.push({ at: end, phase, requestedPhase, ...state, integral: projected.integral,
        supplyShortfallC: projected.supplyShortfallC, nativeCompressorDemand: projected.nativeCompressorDemand,
        auxiliaryRisk: prediction.auxiliaryRisk, powerKw: kw, spaceHeatingPowerKw, auxiliaryKw: auxKw,
        equipmentBasis: prediction.equipmentBasis, uncertaintyDuty: prediction.uncertaintyDuty,
        recoveryCompressorOnly: prediction.recoveryCompressorOnly,
        compressorDuty: duty, durationHours: dt, electricityKwh: kwh, costCents: cents, uncertaintyC });
      if (phase === 'recovery') {
        recoverySettledHours = settledAgainst(state, nativeState) ? recoverySettledHours + dt : 0;
        if (recoverySettledHours >= 1) recoveredAt = end;
      }
      time = end;
    }
  }
  // Explicitly price an unsettled thermal tail; this is not evidence that recovery completed.
  const deficit = schedule ? Math.max(0, nativeState.indoorC - state.indoorC)
    + model.parameters.memoryExchangePerHour * model.parameters.reserveTimeHours
      * Math.max(0, nativeState.reserveC - state.reserveC) : 0;
  const terminalKwh = includeTail ? deficit / model.parameters.normalHeatCPerHour
    * (model.energy?.compressorKw ?? c.heatPumpCompressorKw) * (model.energy?.recoveryMultiplier ?? 1.15) : 0;
  const terminalPrice = Math.max(0, ...intervals.map(i => i.price));
  const terminalCostCents = terminalKwh * terminalPrice;
  costCents += terminalCostCents;
  const uncertaintyCents = Math.max(5, (absoluteCostCents + Math.abs(terminalCostCents)) * (model.energy?.relativeUncertainty ?? 0.5)
    + (equipment.h66Available ? 0 : auxiliaryKwh * terminalPrice * 0.5));
  return { costCents, electricityKwh, auxiliaryKwh, recoveryCostCents, recoveryEnergyKwh, recoveryAuxKwh, preheatCostCents,
    penalty, score: costCents + penalty, severe, endState: state, terminalKwh, terminalCostCents,spaceHeatingCostCents,spaceHeatingKwh,
    uncertaintyCents, trajectory, recoveredAt, nativeEndState: nativeState,
    integralBasis: 'At most one hour of measured-trend projection; later native integral unknown',
    auxiliaryBasis: 'Estimated space-heating auxiliary risk; DHW costs need separate observed attribution',
    basis: 'estimated', completeRecoveryPredicted: schedule === null || recoveredAt !== null };
}

function validatedReductionHours(model) {
  const phase = model?.equipmentResponse?.validation?.phases?.reduction;
  return actionEvidenceReady(model, 'reduction') && model?.forecastValidation?.accepted
    && number(phase?.maxDurationHours) && number(model.forecastValidation.maxReductionHours)
    ? Math.min(phase.maxDurationHours,model.forecastValidation.maxReductionHours) : 0;
}

function validatedRoomBoost(model) {
  return actionEvidenceReady(model,'preheat')
    ? model.equipmentResponse.validation.phases.preheat.maxRoomBoostC??0 : 0;
}

function preheatTrialHours(model,config) {
  const demonstrated=actionEvidenceReady(model,'preheat')?model.equipmentResponse.validation.phases.preheat.maxDurationHours:0;
  // Coupled ten-minute pulses need slack for acknowledgement and tick latency.
  // A45-minute first trial can record at least30 minutes without a final partial pulse.
  return Math.min(config.maxPreheatHours,Math.max(.75,demonstrated*1.5+.25));
}

export function trialEnvelope({ schedule, initialState, targetC, intervals, model, config, occupancy, maxDropC }) {
  const duration = Math.max(0,(schedule.reductionEnd - schedule.reductionStart)/HOUR);
  const weather = intervals.filter(i => i.end > schedule.reductionStart && i.start < schedule.reductionEnd);
  const coldest = Math.min(...weather.map(i => i.outdoorC));
  // A stress scenario, not a confidence interval: no compressor/solar heat during
  // reduction and at least twice the fitted heat loss (bounded by the prior).
  const coolingRate = Math.max(0.04, 2 * (model.parameters?.lossPerHour ?? 0.018))
    * Math.max(0, initialState.indoorC-coldest);
  const floorC = initialState.indoorC-coolingRate*duration-0.15;
  const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && at(occupancy.returnAt) <= schedule.reductionEnd + 2*HOUR;
  const comfortSafe = weather.length > 0 && (occupied ? floorC >= targetC-Math.min(1,maxDropC) : floorC >= 16);
  const recoveryPrices = intervals.filter(i => i.end > schedule.reductionEnd && i.start < schedule.reductionEnd + 4*HOUR);
  const replacementPrice = Math.max(0, ...recoveryPrices.map(i => i.price));
  const preheatHours=Math.max(0,(schedule.preheatEnd-schedule.preheatStart)/HOUR);
  const preheatPrice=Math.max(0,...intervals.filter(i=>i.end>schedule.preheatStart&&i.start<schedule.preheatEnd).map(i=>i.price));
  const costExposureCents = Math.max(5, (duration * replacementPrice * 1.5 + preheatHours*preheatPrice)
    * (config.heatPumpCompressorKw + config.circulationKw + config.auxRatedKw));
  return { comfortSafe, floorC, costExposureCents,
    basis: 'No-heat cooling and rated-power recovery stress allowance; actual costs can exceed the allowance after a fallback.' };
}

/** Recheck the exact promised schedule using current evidence before commanding it. */
export function revalidatePlan({ plan, now, observations, prices, forecast, checkpoint, settings,
  config = {}, thermalState, equipment = {}, trialBudgetRemainingCents = 0 }) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model;
  const rejected = reason => ({ valid:false, reason });
  if (!plan?.schedule || plan.schedule.reductionEnd <= now) return rejected('scheduled-cycle-expired');
  if ((equipment.externalChangeRevision??0)!==(plan.equipment?.externalChangeRevision??0))
    return rejected('scheduled-cycle-native-settings-changed');
  if (!number(observations.indoor?.value) || observations.indoor.stale
    || observations.indoor.observedAt > now || now-observations.indoor.observedAt > c.observationMaxAgeMs)
    return rejected('scheduled-cycle-observations-stale');
  const targetC = settings.comfort.targetC ?? checkpoint.baselineC;
  if (!number(targetC)) return rejected('scheduled-cycle-target-unavailable');
  const readiness = learningReadiness(checkpoint,c,equipment), duration = (plan.schedule.reductionEnd-plan.schedule.reductionStart)/HOUR;
  const configuredMaximum = equipment.h66Available ? settings.occupancy.mode === 'away' ? c.maxAwayReductionHours : c.maxReductionHours : c.maxUnobservedReductionHours;
  if (duration > configuredMaximum || plan.schedule.roomBoostC > c.maxRoomBoostC) return rejected('scheduled-cycle-outside-current-limits');
  const preheatTrial = plan.trial && readiness.thermalValidated && actionEvidenceReady(model,'reduction')
    && plan.schedule.roomBoostC<=Math.min(c.maxRoomBoostC,validatedRoomBoost(model)+1)
    && plan.schedule.preheatEnd-plan.schedule.preheatStart<=preheatTrialHours(model,c)*HOUR;
  if (plan.schedule.roomBoostC && (!equipment.preheatAvailable || !preheatTrial
    && (!actionEvidenceReady(model,'preheat',(plan.schedule.preheatEnd-plan.schedule.preheatStart)/HOUR)
      || plan.schedule.roomBoostC>validatedRoomBoost(model))))
    return rejected('scheduled-preheat-evidence-unavailable');
  if (!plan.trial && (!readiness.actionValidated || duration > validatedReductionHours(model)))
    return rejected('scheduled-cycle-response-evidence-unavailable');
  const intervals = forecastIntervals(prices,forecast,now);
  if (!intervals.length || intervals.at(-1).end < plan.schedule.reductionEnd+2*HOUR)
    return rejected('scheduled-cycle-forecast-coverage-lost');
  const initialState = {indoorC:observations.indoor.value,reserveC:thermalState?.reserveC ?? observations.indoor.value,integral:equipment.integral};
  const args = { intervals, model, initialState, targetC, occupancy:settings.occupancy,
    maxDropC:settings.comfort.maxDropC, config:c, equipment };
  const prediction = evaluateCycle({...args,schedule:plan.schedule}), referencePrediction=evaluateCycle({...args,schedule:plan.reference});
  const benefit = referencePrediction.costCents-prediction.costCents;
  const risk = Math.max(5,Math.abs(benefit)*(model.energy?.relativeUncertainty ?? .6));
  const trialSafety=trialEnvelope({...args,schedule:plan.schedule});
  const allowance=Math.max(0,-benefit,trialSafety.costExposureCents);
  if (plan.trial ? !readiness.trialReady || duration > Math.max(.5,validatedReductionHours(model)*1.5)
    || !trialSafety.comfortSafe || allowance > Math.min(c.maxTrialCostCents,trialBudgetRemainingCents)
    : prediction.severe || benefit <= risk || prediction.score+risk >= referencePrediction.score)
    return rejected('scheduled-cycle-no-longer-admissible');
  return {valid:true,plan:{...plan,...args,generatedAt:now,prediction,referencePrediction,readiness,
    trialSafety:plan.trial?trialSafety:null,trialAllowanceCents:plan.trial?allowance:0,
    estimatedBenefitCents:benefit,uncertaintyCents:risk}};
}

export function chooseCycle({ now, observations, prices, forecast, checkpoint, settings, config = {}, thermalState,
  equipment = {}, trialBudgetRemainingCents = 0 }) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model ?? initialAdaptiveModel(c);
  const targetC = settings.comfort.targetC ?? checkpoint?.baselineC;
  const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null,
    comfort: { targetC: targetC ?? null, maxDropC: settings.comfort.maxDropC, maxDropApplies: settings.occupancy.mode !== 'away' } });
  if (!number(observations.indoor?.value) || now - observations.indoor.observedAt > c.observationMaxAgeMs
    || observations.indoor.observedAt > now) return normal('missing-or-stale-indoor');
  if (observations.indoor.stale === true) return normal('missing-or-stale-indoor');
  if (!number(targetC)) return normal('awaiting-normal-temperature-reference');
  const intervals = forecastIntervals(prices, forecast, now);
  if (!intervals.length || intervals.at(-1).end - now < 4 * HOUR) return normal('missing-or-incomplete-price-weather-horizon');
  const initialState = { indoorC: observations.indoor.value, reserveC: thermalState?.reserveC ?? observations.indoor.value,
    integral: equipment.integral };
  const evaluation = schedule => evaluateCycle({ schedule, intervals, model, initialState, targetC,
    occupancy: settings.occupancy, maxDropC: settings.comfort.maxDropC, config: c, equipment });
  const baseline = evaluation(null), candidates = [];
  const away = settings.occupancy.mode === 'away';
  const readiness = learningReadiness(checkpoint, c, equipment);
  const configuredMaximum = equipment.h66Available ? (away ? c.maxAwayReductionHours : c.maxReductionHours) : c.maxUnobservedReductionHours;
  const testedMaximum = validatedReductionHours(model);
  const economicMaximum = readiness.actionValidated ? Math.min(configuredMaximum, testedMaximum) : 0;
  const trialMaximum = Math.min(configuredMaximum, Math.max(0.5, economicMaximum * 1.5));
  if (!economicMaximum && !(readiness.trialReady && trialBudgetRemainingCents > 0))
    return { ...normal('awaiting-tariff-response-evidence'), readiness };
  const maxReduction = Math.max(economicMaximum, readiness.trialReady ? trialMaximum : 0);
  const durations = [...new Set([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 18, 24, economicMaximum, maxReduction])]
    .filter(d => d > 0 && d <= maxReduction).sort((a,b) => a-b);
  // Published price changes define useful starts without assuming hourly tariffs.
  const preheatTrialReady=readiness.trialReady&&readiness.thermalValidated&&actionEvidenceReady(model,'reduction');
  const trialPreheat=preheatTrialHours(model,c);
  const starts = [...new Set([now,...(preheatTrialReady?[now+trialPreheat*HOUR]:[]), ...intervals.filter((row, i) => i && row.price !== intervals[i-1].price)
    .map(row => row.start).filter(t => t <= now + 12 * HOUR)])].slice(0, 32);
  const preheatOptions=[];
  let evaluatedCandidates=0;
  const addCandidate=(schedule,duration)=>{
    const result=evaluation(schedule);evaluatedCandidates++;
    const trialSafety=trialEnvelope({schedule,initialState,targetC,intervals,model,config:c,
      occupancy:settings.occupancy,maxDropC:settings.comfort.maxDropC});
    const option={schedule,result,duration,trialSafety,firstActionAt:schedule.preheatStart};
    if (!result.severe||trialSafety.comfortSafe)candidates.push(option);
    return option;
  };
  // Evaluate every reduction first. Expand preheat around promising reductions
  // rather than multiplying the entire grid by every duration/boost combination.
  for (const reductionStart of starts) for (const duration of durations) {
    const reductionEnd=reductionStart+duration*HOUR,delay=(reductionStart-now)/HOUR;
    if (reductionEnd+2*HOUR>intervals.at(-1).end)continue;
    const option=addCandidate({preheatStart:reductionStart,preheatEnd:reductionStart,
      reductionStart,reductionEnd,roomBoostC:0},duration);
    const demandWindow=baseline.trajectory.filter(step=>step.at>reductionStart&&step.at<=reductionEnd+2*HOUR);
    const demandHours=demandWindow.reduce((sum,step)=>sum+step.durationHours,0);
    const continuingDemand=demandHours>0
      &&demandWindow.reduce((sum,step)=>sum+step.compressorDuty*step.durationHours,0)/demandHours>.1
      &&demandWindow.reduce((sum,step)=>sum+(step.compressorDuty>.05?step.durationHours:0),0)>=demandHours*.5;
    if (equipment.preheatAvailable&&(actionEvidenceReady(model,'preheat')||preheatTrialReady)&&delay>0&&continuingDemand)
      preheatOptions.push({...option,delay});
  }
  const ranked=[...preheatOptions].sort((a,b)=>a.result.costCents+Math.min(a.result.penalty,50)
    -b.result.costCents-Math.min(b.result.penalty,50));
  const expansions=[...new Set([...ranked.slice(0,8),...preheatOptions.filter(o=>
    o.schedule.reductionStart===now+trialPreheat*HOUR&&o.duration<=trialMaximum).slice(0,4)])];
  for (const option of expansions) {
    const preheats=[...new Set([...(actionEvidenceReady(model,'preheat')?[.5,1,1.5,2]:[]),
      ...(preheatTrialReady?[trialPreheat]:[])])].filter(d=>d<=option.delay&&d<=c.maxPreheatHours);
    const boosts=[1,2,3,4,5].filter(b=>b<=c.maxRoomBoostC&&b<=validatedRoomBoost(model)+(preheatTrialReady?1:0));
    for (const preheat of preheats) for (const boost of boosts) addCandidate({...option.schedule,
      preheatStart:option.schedule.reductionStart-preheat*HOUR,roomBoostC:boost},option.duration);
  }
  const search={method:'reduction-grid-with-bounded-preheat-expansion',evaluatedCandidates,
    preheatExpansions:expansions.length,limitation:'Bounded candidate search; not a proof of a global optimum.'};
  // Compare differences, not independent absolute-cost error bars which would block every modest action.
  for (const option of candidates) {
    option.benefit = baseline.costCents - option.result.costCents;
    option.risk = Math.max(5, Math.abs(option.benefit) * (model.energy?.relativeUncertainty ?? 0.5)
      + Math.max(0, option.result.auxiliaryKwh - baseline.auxiliaryKwh) * Math.max(0, ...intervals.map(i => i.price)) * 0.5);
  }
  let chosen = candidates.filter(o => o.duration <= economicMaximum && !o.result.severe
    && (!o.schedule.roomBoostC || actionEvidenceReady(model,'preheat',(o.schedule.preheatEnd-o.schedule.preheatStart)/HOUR))
    && o.schedule.roomBoostC<=validatedRoomBoost(model)
    && o.benefit > o.risk && o.result.score + o.risk < baseline.score)
    .sort((a,b) => a.result.score - b.result.score)[0];
  let trial = false;
  const explore=Boolean(chosen)&&economicMaximum>0&&(model.energy?.episodes??0)%4===3;
  if ((!chosen||explore) && readiness.trialReady && trialBudgetRemainingCents > 0) {
    const small = candidates.filter(o => o.firstActionAt === now && o.duration <= trialMaximum
      && o.schedule.roomBoostC <= Math.max(1,validatedRoomBoost(model)+1)
      && (!o.schedule.roomBoostC || o.schedule.preheatEnd-o.schedule.preheatStart<=trialPreheat*HOUR)
      && (!explore||o.duration>economicMaximum||o.schedule.roomBoostC>validatedRoomBoost(model)
        || o.schedule.roomBoostC&&(o.schedule.preheatEnd-o.schedule.preheatStart)/HOUR
          >(model.equipmentResponse?.validation?.phases?.preheat?.maxDurationHours??0))
      && o.trialSafety.comfortSafe && Math.max(o.trialSafety.costExposureCents, -o.benefit)
        <= Math.min(c.maxTrialCostCents, trialBudgetRemainingCents));
    // A trial must expose useful action coverage, not repeat an already well-sampled normal regime.
    const selectedTrial = small.sort((a,b) => a.result.score - b.result.score || b.duration-a.duration)[0];
    if (selectedTrial) {chosen=selectedTrial;trial=true;}
  }
  if (!chosen) return { ...normal('normal-operation-preferred'), readiness,
    evaluation: { baselineCostCents: baseline.costCents, candidates: candidates.length, search } };
  // A reference must itself be feasible within demonstrated control support.
  const alternativeFor=option=>candidates.filter(o=>o.duration<option.duration
    &&o.schedule.reductionStart===option.schedule.reductionStart&&o.firstActionAt>=option.firstActionAt
    &&!o.result.severe&&o.duration<=economicMaximum&&o.schedule.roomBoostC<=validatedRoomBoost(model)
    &&(!o.schedule.roomBoostC||actionEvidenceReady(model,'preheat',(o.schedule.preheatEnd-o.schedule.preheatStart)/HOUR)))
    .sort((a,b)=>a.result.score-b.result.score)[0];
  let shorter=alternativeFor(chosen);
  while (!trial) {
    const comparison=shorter?.result??baseline;
    if (comparison.costCents-chosen.result.costCents>chosen.risk&&chosen.result.score+chosen.risk<comparison.score)break;
    if (!shorter)return {...normal('normal-operation-preferred'),readiness,
      evaluation:{baselineCostCents:baseline.costCents,candidates:candidates.length,search}};
    chosen=shorter;shorter=alternativeFor(chosen);
  }
  const reference = shorter?.schedule ?? null, referenceResult = shorter?.result ?? baseline;
  const phase = phaseAt(chosen.schedule, now);
  return { action: phase === 'reduction' ? 'reduction' : 'normal', phase,
    reasons: [trial ? 'bounded-learning-trial' : 'predicted-full-cycle-benefit'],
    comfort: { targetC, maxDropC: settings.comfort.maxDropC, maxDropApplies: !away },
    plan: { generatedAt: now, horizonEnd: intervals.at(-1).end, schedule: chosen.schedule, reference,
      referenceLabel: shorter ? `${shorter.duration}-hour reduction` : 'continuous normal operation',
      initialState, targetC, model, intervals, equipment, occupancy: { ...settings.occupancy }, maxDropC: settings.comfort.maxDropC,
      trial, trialAllowanceCents: trial ? Math.max(0, -chosen.benefit, chosen.trialSafety.costExposureCents) : 0,
      trialSafety: trial ? chosen.trialSafety : null, readiness, search,
      prediction: chosen.result, referencePrediction: referenceResult,
      estimatedBenefitCents: referenceResult.costCents - chosen.result.costCents,
      uncertaintyCents: chosen.risk, evidence: 'Estimated complete-cycle comparison; unexecuted reference is modelled.' } };
}
