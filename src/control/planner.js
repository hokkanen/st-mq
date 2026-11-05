import { initialAdaptiveModel, THERMAL_PARAMETER_BOUNDS, predictThermalStep, predictEquipmentDuty, thermalEvidenceReady, actionEvidenceReady, thermalUncertaintyC, fireplaceEvidenceReady, fireplaceGainUncertainty, equipmentResponseEstimate, forecastEvidence } from './adaptive-learning.js';
import { estimateHeatPumpPerformance, hydronicGain, planningSupplyC } from '../domain/heat-pump-performance.js';
import { heatingStrategy, heatingEconomics } from '../domain/heating-strategy.js';
import { CONTROL_DEFAULTS } from '../app/config.js';
import { fireplaceInfluence, fireplaceRate } from '../domain/fireplace.js';
import { trialOpportunity, trialInformation } from './heating-trials.js';
import { LEARNING_ALGORITHM } from '../domain/learning-contract.js';
import { homePlanningState } from '../domain/home-model.js';

const HOUR = 3600000, STEP = 900000;
const number = Number.isFinite;
const at = value => typeof value === 'number' ? value : Date.parse(value);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const settledAgainst = (state, reference, sourceUncertaintyC) => number(sourceUncertaintyC)
  && state.indoorC - sourceUncertaintyC >= reference.indoorC - 0.15
  && state.reserveC - sourceUncertaintyC >= reference.reserveC - 0.15
  && (!number(state.slabC) || !number(reference.slabC) || state.slabC - sourceUncertaintyC >= reference.slabC - 0.15);
export const phaseAt = (schedule, now) => !schedule ? 'normal' : now >= schedule.preheatStart && now < schedule.preheatEnd ? 'preheat'
  : now >= schedule.reductionStart && now < schedule.reductionEnd ? 'reduction'
    : now >= schedule.reductionEnd ? 'recovery' : 'normal';

// An explicitly estimated input without a finite uncertainty cannot certify a
// comfort bound. Ordinary measured inputs have no additional source allowance.
export function indoorUncertaintyAt(equipment = {}, hours = 0, at = null) {
  const initial = number(equipment.indoorUncertaintyC) && equipment.indoorUncertaintyC >= 0
    ? equipment.indoorUncertaintyC : equipment.indoorEstimated === true ? null : 0;
  const growth = equipment.indoorUncertaintyGrowthCPerHour ?? 0;
  if (initial === null || !number(growth) || growth < 0 || number(at) && number(equipment.indoorEstimateValidUntil)
    && at > equipment.indoorEstimateValidUntil) return null;
  return initial + Math.max(0, hours) * growth;
}

export function learningReadiness(checkpoint, config = {}, equipment = {}) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model;
  const thermalValidated = thermalEvidenceReady(model);
  const treatmentKey = equipmentResponseEstimate(model, 'reduction')?.treatmentKey
    ?? model?.forecastValidation?.treatmentKey ?? 'reduction-only-v1';
  const responseValidated = actionEvidenceReady(model, 'reduction', null, treatmentKey);
  const advanceValidated = forecastEvidence(model, { treatmentKey }).accepted === true;
  const fireplaceValidated = fireplaceEvidenceReady(model);
  const fireplacePending = (equipment.fireplaceRelevant ?? equipment.fireplaceActive) === true && !fireplaceValidated;
  const actionValidated = responseValidated && advanceValidated && !fireplacePending;
  const initialReady = model?.version === 4 && Object.entries(THERMAL_PARAMETER_BOUNDS)
    .every(([key, bounds]) => number(model.parameters?.[key]) && model.parameters[key] >= bounds[0] && model.parameters[key] <= bounds[1]);
  const trialReady = c.learningTrials && initialReady
    && number(equipment.compressorOn) && number(equipment.dhwRouting)
    && equipment.indoorEstimated !== true
    && (!number(equipment.trialBudgetRemainingCents)||equipment.trialBudgetRemainingCents>=0);
  return { thermalValidated, responseValidated, advanceValidated, fireplaceValidated, actionValidated, initialReady, trialReady,
    reasons: [!thermalValidated && 'awaiting-held-out-thermal-trajectories',
      !responseValidated && 'awaiting-held-out-tariff-response',
      !advanceValidated && 'awaiting-frozen-advance-cycle-predictions',
      fireplacePending && 'awaiting-fireplace-response-evidence',
      !trialReady && 'trials-require-enabled-budget-and-observed-equipment'].filter(Boolean),
    basis: 'Thermal and equipment-response checks are separate; counterfactual savings remain estimates.' };
}

export function recoveryPolicy({ now, reductionEnd, indoorC, targetC, indoorTrendCPerHour,
  occupancy = { mode: 'occupied' }, equipment = {}, config = {}, forced = false, fallbackAt = null, holdUntil = null }) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  const recoveryHoldUntil = number(holdUntil) ? holdUntil : reductionEnd + c.recoveryHoldMinutes * 60_000;
  const recoveryHoldActive = now >= reductionEnd && now < recoveryHoldUntil;
  const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && at(occupancy.returnAt) <= now + HOUR;
  const uncertaintyC = indoorUncertaintyAt(equipment, 0, now);
  const conservativeIndoorC = indoorC - uncertaintyC;
  const reason = !recoveryHoldActive ? 'recovery-hold-ended'
    : !c.recoveryCompressorOnly ? 'native-recovery-configured' : forced ? 'control-or-comfort-fallback'
    : fallbackAt !== null ? 'native-recovery-fallback-latched'
      : !equipment.h66Available ? 'native-settings-unavailable'
        : !number(indoorC) || !number(targetC) || uncertaintyC === null ? 'missing-recovery-temperature'
            : occupied && (conservativeIndoorC <= targetC - c.recoveryComfortMarginC
              || number(indoorTrendCPerHour) && conservativeIndoorC + Math.min(0, indoorTrendCPerHour) * 0.5 <= targetC - c.recoveryComfortMarginC)
              ? 'recovery-comfort-margin' : null;
  return { recoveryHoldActive, recoveryHoldUntil, recoveryCompressorOnly: reason === null, recoveryFallbackReason: reason };
}

export function preheatRoomRequest(equipment = {}, config = {}) {
  const baselineC = equipment.roomSettingC;
  const maximumC = Math.min(35, equipment.roomSettingMaximumC ?? 35);
  let boostC = number(baselineC) ? Math.max(0, Math.min(config.preheatRoomBoostC ?? CONTROL_DEFAULTS.preheatRoomBoostC, maximumC - baselineC)) : null;
  const supplyC=planningSupplyC(equipment);
  if(number(boostC)&&number(supplyC)&&(!number(equipment.maximumSupplyC)||equipment.maximumSupplyC>50)){
    // Use a smaller supported ROOM increase when the configured increase would
    // push the projected water temperature beyond the available source map.
    // A reported native ceiling at or below 50 C already bounds that projection.
    boostC=Math.min(boostC,Math.max(0,Math.floor((50-supplyC)/3)));
  }
  return { roomSettingC: number(boostC) ? baselineC + boostC : null, roomBoostC: boostC };
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

/** One coverage contract for admission, active continuation and trial exposure.
 * Two complete recovery hours are the minimum assessment window. */
export function cycleForecastCovered(intervals, schedule, from = intervals?.[0]?.start) {
  const until = schedule?.reductionEnd + 2 * HOUR;
  if (!number(from) || !number(until) || until <= from) return false;
  let cursor = from;
  for (const interval of intervals ?? []) {
    if (interval.end <= cursor) continue;
    if (interval.start > cursor || !number(interval.price) || !number(interval.outdoorC)
      || !number(interval.end) || interval.end <= interval.start) return false;
    cursor = interval.end;
    if (cursor >= until) return true;
  }
  return false;
}

export function auxiliaryThreshold(config = {}) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  return c.a2Basis === 'offset'
    ? number(c.compressorIntegralA1) ? c.compressorIntegralA1 + c.auxIntegralA2 : null
    : c.auxIntegralA2;
}

/** Same thermal predictor is used in fitting, dispatch and frozen-reference evaluation. */
export function evaluateCycle({ schedule = null, intervals, model, initialState, targetC,
  occupancy = { mode: 'occupied' }, maxDropC = 1.5, maxRiseC = 1.5, config = {}, equipment = {}, includeTail = true }) {
  const c = { ...CONTROL_DEFAULTS, ...config };
  model ??= initialAdaptiveModel(c);
  if (!Array.isArray(intervals) || !number(initialState?.indoorC) || !number(targetC))
    throw new TypeError('A cycle requires intervals, indoor temperature and a target');
  let state = { indoorC: initialState.indoorC, reserveC: initialState.reserveC ?? initialState.indoorC, slabC: initialState.slabC ?? initialState.reserveC ?? initialState.indoorC };
  let nativeState = { ...state };
  const normalSupplyC = planningSupplyC(equipment);
  const initialIntegral = number(initialState.integral) ? initialState.integral : null;
  const threshold = auxiliaryThreshold(c);
  let costCents = 0, electricityKwh = 0, auxiliaryKwh = 0, recoveryCostCents = 0, preheatCostCents = 0;
  let absoluteCostCents = 0, recoveryEnergyKwh = 0, recoveryAuxKwh = 0, spaceHeatingCostCents=0, spaceHeatingKwh=0;
  let penalty = 0, severe = false, uncertaintyC = 0, elapsed = 0;
  const discomfort = { cold: 0, hot: 0 };
  // Keep one worst occurrence per boundary. These facts explain the same
  // safety checks used by dispatch; they do not change admission or training.
  const violations = new Map();
  const violation = (code, at, value, limit, excess = 0) => {
    const key = code, previous = violations.get(key);
    if ((!previous || excess > previous.excess) && (previous || violations.size < 24))
      violations.set(key, { code, at, value: number(value) ? value : null, limit, unit: '°C', excess });
  };
  let recoverySettledHours = 0, recoveredAt = null, previousEnd = null, recoveryFallbackAt=null, indoorTrendCPerHour=null;
  const normalHistory=equipment.heatingDemand;
  const normalAuxiliaryKw=number(normalHistory?.normalAuxiliaryKw)&&number(normalHistory.observedThrough)
    &&normalHistory.observedThrough<=intervals[0].start&&intervals[0].start-normalHistory.observedThrough<=2*HOUR
    ?Math.max(0,normalHistory.normalAuxiliaryKw):0;
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
    const stepStart = intervals[0].start + elapsed * HOUR;
    const phaseStart=phase==='preheat'?schedule?.preheatStart:phase==='reduction'?schedule?.reductionStart:schedule?.reductionEnd;
    const inputs = { outdoorC: interval.outdoorC, solarRadiationWm2: interval.solarRadiationWm2,
      phase, roomBoostC: boost, targetC,
      phaseHours:phase==='normal'?0:Math.max(0,(stepStart+dt*HOUR-(phaseStart??intervals[0].start))/HOUR),
      supplyC: planningSupplyC({...equipment,normalSupplyC},phase==='preheat'?boost:0),
      brineC: equipment.brineC, floorOverrideMode: !native && phase === 'preheat' && schedule?.floorOverride ? 'on' : 'off',
      treatmentKey: !native && schedule ? schedule.treatmentKey ?? 'reduction-only-v1' : 'normal',
      fireplaceKgPerHour: fireplaceRate(equipment.fireplaceEvents ?? [], stepStart, stepStart + dt * HOUR),
      responseRatio: phase === 'reduction' && number(c.scenarioReductionScale) ? c.scenarioReductionScale : null };
    // Current native integral/target readings describe the currently applied
    // phase only. They are not evidence about an unexecuted tariff threshold.
    const nativeCompressorDemand = equipment.observedPhase === phase ? projected.nativeCompressorDemand : null;
    const duty = predictEquipmentDuty(model, before, { ...inputs, nativeCompressorDemand }, dt);
    inputs.compressorDuty = clamp(duty.compressorDuty + (c.scenarioDutyShift ?? 0), 0, 1);
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
      : phase === 'preheat' ? clamp(boost * 0.025, 0, 0.2) : 0;
    const projectedAt=intervals[0].start+elapsed*HOUR;
    const policy=!native&&phase==='recovery'?recoveryPolicy({
      now:projectedAt,reductionEnd:schedule.reductionEnd,indoorC:before.indoorC,targetC,
      indoorTrendCPerHour,occupancy,equipment:{...equipment,
        indoorUncertaintyC:indoorUncertaintyAt(equipment,elapsed,projectedAt)},config:c,fallbackAt:recoveryFallbackAt,
      holdUntil:schedule.recoveryHoldUntil}):null;
    if (policy&&!policy.recoveryCompressorOnly) recoveryFallbackAt??=projectedAt;
    const compressorRecovery=policy?.recoveryCompressorOnly??false;
    const blocked = equipment.nativeAuxAllowed === false || !native && phase === 'reduction' && equipment.h66Available || compressorRecovery;
    const risk = blocked ? 0 : Math.max(thresholdRisk, hysteresisRisk, capacityRisk, priorRisk);
    const observedNormalAuxKw=!blocked&&phase==='normal'&&preliminary.compressorDuty>=.01?normalAuxiliaryKw:0;
    const auxKw = Math.min(c.auxRatedKw, Math.max(observedNormalAuxKw,
      c.auxRatedKw*risk*(model.energy?.auxiliaryRiskScale??1))*(c.scenarioAuxScale??1));
    return { ...predictThermalStep(model, before, { ...inputs, auxKw }, dt), auxKw,
      auxiliaryRisk:Math.max(risk,observedNormalAuxKw/c.auxRatedKw),
      source: estimateHeatPumpPerformance({ ...model.performance, supplyC: inputs.supplyC, brineC: inputs.brineC }),
      equipmentBasis: duty.basis, uncertaintyDuty: duty.uncertaintyDuty, recoveryCompressorOnly: compressorRecovery,
      recoveryHoldActive:policy?.recoveryHoldActive ?? false, recoveryHoldUntil:policy?.recoveryHoldUntil ?? null };
  };
  for (const interval of intervals) {
    if (!number(interval.start) || !number(interval.end) || interval.end <= interval.start
      || !number(interval.outdoorC) || !number(interval.price)
      || previousEnd !== null && interval.start !== previousEnd) throw new TypeError('Cycle intervals must be valid and continuous');
    previousEnd = interval.end;
    let time = interval.start;
    while (time < interval.end) {
      const boundaries = schedule ? [schedule.preheatStart, schedule.preheatEnd, schedule.reductionStart, schedule.reductionEnd,
        schedule.recoveryHoldUntil ?? schedule.reductionEnd + c.recoveryHoldMinutes * 60_000] : [];
      const returnAt = at(occupancy.returnAt);
      if (number(returnAt)) boundaries.push(returnAt);
      const end = Math.min(interval.end, time + STEP, ...boundaries.filter(v => v > time));
      const dt = (end - time) / HOUR;
      const requestedPhase = phaseAt(schedule, time);
      const holdEnded = !schedule || time >= (schedule.recoveryHoldUntil ?? schedule.reductionEnd + c.recoveryHoldMinutes * 60_000);
      const phase = requestedPhase === 'recovery' && recoveredAt !== null && holdEnded ? 'normal' : requestedPhase;
      const roomBoostC = phase === 'preheat' ? schedule.roomBoostC : 0;
      const projected = projection(elapsed + dt);
      const native = predict(nativeState, 'normal', 0, interval, dt, projected, true);
      nativeState = { indoorC: native.indoorC, reserveC: native.reserveC, slabC: native.slabC ?? null };
      const prediction = schedule ? predict(state, phase, roomBoostC, interval, dt, projected) : native;
      indoorTrendCPerHour=(prediction.indoorC-state.indoorC)/dt;
      state = { indoorC: prediction.indoorC, reserveC: prediction.reserveC, slabC: prediction.slabC ?? null };
      elapsed += dt;
      const sourceUncertaintyC = indoorUncertaintyAt(equipment,elapsed,end);
      const actionHours = schedule ? Math.max(0, (end - Math.max(intervals[0].start, schedule.preheatStart)) / HOUR) : elapsed;
      uncertaintyC = sourceUncertaintyC === null ? null : sourceUncertaintyC + thermalUncertaintyC(model, actionHours, { phase,
        roomBoostC,phaseHours:phase==='normal'?0:Math.max(0,(end-
          (phase==='preheat'?schedule.preheatStart:phase==='reduction'?schedule.reductionStart:schedule.reductionEnd))/HOUR),
        supplyC: prediction.source?.supplyC, brineC: equipment.brineC,
        floorOverrideMode: phase === 'preheat' && schedule?.floorOverride ? 'on' : 'off',
        treatmentKey: schedule?.treatmentKey ?? 'normal', solarRadiationWm2: interval.solarRadiationWm2,
        fireplaceKgPerHour: fireplaceRate(equipment.fireplaceEvents ?? [], intervals[0].start, end) });
      const duty = prediction.compressorDuty, auxKw = prediction.auxKw;
      const source = prediction.source;
      // Manufacturer electrical input already includes its test-boundary pumps.
      // DHW production and recirculation are outside this space-heating cost boundary.
      const kw = source.electricalKw * duty * (c.scenarioElectricalScale ?? 1) + auxKw
        + (source.pumpsIncluded ? 0 : c.circulationKw * duty);
      const kwh = kw * dt, cents = kwh * interval.price;
      const spaceHeatingPowerKw = kw;
      spaceHeatingKwh+=spaceHeatingPowerKw*dt;spaceHeatingCostCents+=spaceHeatingPowerKw*dt*interval.price;
      costCents += cents; electricityKwh += kwh; auxiliaryKwh += auxKw * dt;
      absoluteCostCents += Math.abs(cents);
      if (phase === 'recovery') { recoveryCostCents += cents; recoveryEnergyKwh += kwh; recoveryAuxKwh += auxKw * dt; }
      if (phase === 'preheat') preheatCostCents += cents;
      const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && end >= at(occupancy.returnAt);
      if (occupied) {
        const delta = state.indoorC - targetC, cost = delta * delta * dt;
        discomfort[delta > 0 ? 'hot' : 'cold'] += cost;
        penalty += cost;
        if (schedule && phase !== 'normal' && uncertaintyC !== null) {
          const lower = targetC - maxDropC, upper = targetC + maxRiseC;
          if (state.indoorC - uncertaintyC < lower) {
            severe = true; violation('indoor-drop-limit', end, state.indoorC - uncertaintyC, lower, lower - state.indoorC + uncertaintyC);
          }
          if (state.indoorC + uncertaintyC > upper) {
            severe = true; violation('indoor-rise-limit', end, state.indoorC + uncertaintyC, upper, state.indoorC + uncertaintyC - upper);
          }
        }
      }
      if (schedule && phase !== 'normal' && uncertaintyC === null) {
        severe = true;
        violation(number(equipment.indoorEstimateValidUntil) && end > equipment.indoorEstimateValidUntil
          ? 'indoor-estimate-expired' : 'indoor-uncertainty-unavailable', end, null, null);
      }
      if (phase === 'preheat' && (!source.withinPlanningRange || !number(equipment.supplyC))) {
        severe = true; violation('preheat-source-range', end, source.supplyC, null);
      }
      trajectory.push({ at: end, phase, requestedPhase, ...state, integral: projected.integral,
        supplyShortfallC: projected.supplyShortfallC, nativeCompressorDemand: projected.nativeCompressorDemand,
        sourceEstimate: prediction.source, auxiliaryRisk: prediction.auxiliaryRisk, powerKw: kw, spaceHeatingPowerKw, auxiliaryKw: auxKw,
        equipmentBasis: prediction.equipmentBasis, uncertaintyDuty: prediction.uncertaintyDuty,
        recoveryCompressorOnly: prediction.recoveryCompressorOnly,
        recoveryHoldActive: prediction.recoveryHoldActive, recoveryHoldUntil: prediction.recoveryHoldUntil,
        compressorDuty: duty, durationHours: dt, electricityKwh: kwh, costCents: cents, uncertaintyC });
      if (phase === 'recovery') {
        recoverySettledHours = settledAgainst(state, nativeState, sourceUncertaintyC) ? recoverySettledHours + dt : 0;
        if (recoverySettledHours >= 1) recoveredAt = end;
      }
      time = end;
    }
  }
  // Explicitly price an unsettled thermal tail; this is not evidence that recovery completed.
  const reserveCapacity = model.floor?.enabled ? model.floor.nativeCapacityKwhPerC
    : model.parameters.memoryExchangePerHour * model.parameters.reserveTimeHours / hydronicGain(model);
  const deficitKwh = schedule ? Math.max(0, nativeState.indoorC - state.indoorC) / hydronicGain(model)
    + reserveCapacity * Math.max(0, nativeState.reserveC - state.reserveC) : 0;
  const terminalSource = estimateHeatPumpPerformance({ ...model.performance, supplyC: normalSupplyC, brineC: equipment.brineC });
  const slabDebtKwh = (model.floor?.capacityKwhPerC ?? 0) * Math.max(0, (nativeState.slabC ?? 0) - (state.slabC ?? 0));
  const terminalKwh = includeTail ? (deficitKwh + slabDebtKwh) / Math.max(1, terminalSource.cop)
    * (c.scenarioElectricalScale ?? 1) : 0;
  // Remaining thermal debt belongs beyond the forecast boundary. Value it at
  // the last available quote, equally for every compared path. Charging it at
  // an earlier peak can erase the very benefit of recovering after that peak.
  // This remains an explicit estimate, not a future quote or realized saving.
  const terminalPrice = Math.max(0, intervals.at(-1)?.price ?? 0);
  const terminalCostCents = terminalKwh * terminalPrice;
  costCents += terminalCostCents;
  const uncertaintyCents = Math.max(5, (absoluteCostCents + Math.abs(terminalCostCents)) * (model.energy?.relativeUncertainty ?? 0.5)
    + (equipment.h66Available ? 0 : auxiliaryKwh * terminalPrice * 0.5));
  return { costCents, electricityKwh, auxiliaryKwh, recoveryCostCents, recoveryEnergyKwh, recoveryAuxKwh, preheatCostCents,
    penalty, discomfort, score: costCents + penalty * 17.5, severe, endState: state, terminalKwh, terminalCostCents,spaceHeatingCostCents,spaceHeatingKwh,
    uncertaintyCents, trajectory, recoveredAt, nativeEndState: nativeState,
    violations: [...violations.values()].map(({ excess, ...entry }) => entry),
    integralBasis: 'At most one hour of measured-trend projection; later native integral unknown',
    auxiliaryBasis: 'Estimated space-heating auxiliary risk; DHW costs need separate observed attribution',
    basis: 'estimated-space-heating-only; matched DHW service is not established', completeRecoveryPredicted: schedule === null || recoveredAt !== null };
}

/** Shared selection, pending-plan and continuation comparison. Scenarios use
 * the same physical error on both independently simulated action paths. */
export function economicAdmission({ prediction, referencePrediction, args, schedule, reference = null, settings = {}, continuing = false }) {
  heatingStrategy(settings.savingsStrategy);
  const policy = heatingEconomics(args.config);
  const benefitCents = referencePrediction.costCents - prediction.costCents;
  let lowerBenefitCents = benefitCents;
  let unsafe = prediction.severe;
  for (const direction of [-1, 1]) {
    const source = estimateHeatPumpPerformance({ ...args.model.performance, supplyC: args.equipment?.supplyC, brineC: args.equipment?.brineC });
    const scenario = { ...args,
      model: { ...args.model, parameters: { ...args.model.parameters,
        hydronicCPerKwh: clamp(hydronicGain(args.model) * (1 - direction * .15), ...THERMAL_PARAMETER_BOUNDS.hydronicCPerKwh),
        lossPerHour: clamp(args.model.parameters.lossPerHour * (1 + direction * .15), ...THERMAL_PARAMETER_BOUNDS.lossPerHour) } },
      initialState: { ...args.initialState, reserveC: args.initialState.reserveC + direction * .5,
        slabC: (args.initialState.slabC ?? args.initialState.reserveC) + direction * .5 },
      config: { ...args.config, scenarioElectricalScale: 1 + direction * source.relativeUncertainty,
        scenarioAuxScale: 1 + direction * .5, scenarioDutyShift: direction * .08 } };
    const action = evaluateCycle({ ...scenario, schedule }), normal = evaluateCycle({ ...scenario, schedule: reference });
    lowerBenefitCents = Math.min(lowerBenefitCents, normal.costCents - action.costCents);
    unsafe ||= action.severe;
  }
  // A floor remains for unrepresented effects; this is a scenario envelope,
  // not a probabilistic confidence bound or a promise of metered savings.
  const uncertaintyCents = Math.max(policy.economicUncertaintyFloorCents, benefitCents - lowerBenefitCents);
  lowerBenefitCents = benefitCents - uncertaintyCents;
  const discomfort = Object.entries(prediction.discomfort).reduce((sum, [direction, value]) =>
    sum + Math.max(0, value - referencePrediction.discomfort[direction]), 0);
  const activeHours = plan => plan ? Math.max(0, plan.reductionEnd - Math.max(args.intervals[0].start, plan.preheatStart)) / HOUR : 0;
  const extraHours = Math.max(0, activeHours(schedule) - activeHours(reference));
  const minimumCents = continuing ? Math.min(0,policy.minimumHomeBenefitCents) : policy.minimumHomeBenefitCents;
  const discomfortCents = discomfort * policy.homeDiscomfortCentsPerDegreeSquaredHour;
  const burdenCents = policy.cycleHourCostCents * extraHours + (!continuing && schedule && !reference ? policy.cycleStartCostCents : 0);
  const hurdleCents = minimumCents + discomfortCents + burdenCents;
  return { admitted: !unsafe && lowerBenefitCents > hurdleCents, benefitCents, lowerBenefitCents,
    uncertaintyCents, minimumCents, discomfortCents, burdenCents, hurdleCents, unsafe,
    basis: 'Paired physical stress scenarios; estimated space-heating costs, not measured whole-house savings.' };
}

export function validatedReductionHours(model, schedule = null) {
  const treatmentKey = schedule?.treatmentKey ?? equipmentResponseEstimate(model, 'reduction')?.treatmentKey
    ?? model?.forecastValidation?.treatmentKey ?? 'reduction-only-v1';
  const phase = equipmentResponseEstimate(model, 'reduction', treatmentKey)?.validation
    ?? model?.equipmentResponse?.validation?.phases?.reduction;
  const advance = forecastEvidence(model, { treatmentKey, roomBoostC: schedule?.roomBoostC ?? 0,
    preheatHours: schedule ? (schedule.preheatEnd-schedule.preheatStart)/HOUR : 0 });
  return actionEvidenceReady(model, 'reduction', 0, treatmentKey) && advance.accepted
    && number(phase?.maxDurationHours) && number(advance.maxReductionHours)
    ? Math.min(phase.maxDurationHours, advance.maxReductionHours) : 0;
}

function validatedRoomBoost(model) {
  return actionEvidenceReady(model,'preheat')
    ? model.equipmentResponse.validation.phases.preheat.maxRoomBoostC??0 : 0;
}

function preheatEvidenceReady(model, schedule) {
  const durationHours = (schedule.preheatEnd - schedule.preheatStart) / HOUR;
  return actionEvidenceReady(model, 'preheat', durationHours, schedule.treatmentKey,schedule.roomBoostC)
    && number(schedule.roomBoostC) && schedule.roomBoostC >= 0;
}

function selectedReadiness(readiness, model, schedule) {
  const duration = (schedule.reductionEnd-schedule.reductionStart)/HOUR;
  const responseValidated = actionEvidenceReady(model, 'reduction', duration, schedule.treatmentKey);
  const advance = forecastEvidence(model, { treatmentKey: schedule.treatmentKey, roomBoostC: schedule.roomBoostC ?? 0,
    preheatHours: (schedule.preheatEnd-schedule.preheatStart)/HOUR });
  const advanceValidated = advance.accepted === true && duration <= advance.maxReductionHours;
  const actionValidated = responseValidated && advanceValidated
    && (readiness.fireplaceValidated || !readiness.reasons.includes('awaiting-fireplace-response-evidence'))
    && (schedule.preheatEnd === schedule.preheatStart || preheatEvidenceReady(model, schedule));
  const reasons = readiness.reasons.filter(reason => !['awaiting-held-out-tariff-response',
    'awaiting-frozen-advance-cycle-predictions', 'awaiting-held-out-matching-treatment'].includes(reason));
  if (!responseValidated) reasons.push('awaiting-held-out-tariff-response');
  if (!advanceValidated) reasons.push('awaiting-frozen-advance-cycle-predictions');
  if (!actionValidated) reasons.push('awaiting-held-out-matching-treatment');
  return { ...readiness, responseValidated, advanceValidated, actionValidated, reasons };
}

export function trialEnvelope({ schedule, initialState, targetC, intervals, model, config = {}, occupancy = {}, maxDropC = 1.5,
  maxRiseC = 1.5, equipment = {}, assessCost = true }) {
  config = { ...CONTROL_DEFAULTS, ...config };
  if (!cycleForecastCovered(intervals, schedule)) return { available: false, reason: 'forecast-coverage-lost',
    comfortSafe: false, coldSafe: false, hotSafe: false, costExposureCents: null };
  const normalSupplyC = planningSupplyC(equipment);
  const duration = Math.max(0,(schedule.reductionEnd - schedule.reductionStart)/HOUR);
  const weather = intervals.filter(i => i.end > schedule.reductionStart && i.start < schedule.reductionEnd);
  const coldest = Math.min(...weather.map(i => i.outdoorC));
  // A stress scenario, not a confidence interval: no compressor/solar heat during
  // reduction and at least twice the fitted heat loss (bounded by the prior).
  const coolingRate = Math.max(0.04, 2 * (model.parameters?.lossPerHour ?? 0.018))
    * Math.max(0, initialState.indoorC-coldest);
  const sourceUncertaintyC = indoorUncertaintyAt(equipment,(schedule.reductionEnd-intervals[0].start)/HOUR,schedule.reductionEnd);
  const floorC = sourceUncertaintyC === null ? null : initialState.indoorC-coolingRate*duration-0.15-sourceUncertaintyC;
  const occupied = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && at(occupancy.returnAt) <= schedule.reductionEnd + 2*HOUR;
  // Away leaves the minimum temperature to native pump protection. Occupied
  // comfort returns at the declared return time, including the recovery window.
  const coldSafe = number(floorC) && weather.length > 0 && (!occupied || floorC >= targetC-maxDropC);
  const preheatHours=Math.max(0,(schedule.preheatEnd-schedule.preheatStart)/HOUR);
  let hotSafe = true, hotPeakC = initialState.indoorC, hotPeakAt = intervals[0]?.start ?? null,
    hotStressHours = 0, hotStressReason = null;
  const hasPreheat = preheatHours > 0 || schedule.floorOverride === true || schedule.roomBoostC > 0;
  if (hasPreheat) {
    const start = intervals[0]?.start;
    const invalidFloor = schedule.floorOverride && (!model.floor?.enabled || model.floor.capacityBudgetExceeded
      || !['capacityKwhPerC', 'nativeCapacityKwhPerC', 'exchangeKwPerC'].every(key => number(model.floor[key]) && model.floor[key] > 0)
      || ['partial', 'unknown'].includes(equipment.floorOverrideMode)
      || equipment.floorOverrideAvailable !== true);
    if (invalidFloor || !number(start)) {
      hotSafe = false; hotStressReason = invalidFloor ? 'unavailable-or-uncertain-floor-treatment' : 'missing-hot-stress-weather';
    } else {
      let stressed = { ...initialState, reserveC: initialState.reserveC ?? initialState.indoorC,
        slabC: initialState.slabC ?? initialState.indoorC };
      let native = { ...stressed }, cursor = start, lastExcess = 0, decliningHours = 0;
      const minimumEnd = Math.max(start, schedule.reductionEnd) + 2 * HOUR;
      const slowHours = Math.max(model.parameters.reserveTimeHours,
        model.floor?.enabled ? model.floor.capacityKwhPerC / model.floor.exchangeKwPerC : 0);
      const endLimit = Math.max(minimumEnd, Math.max(start, schedule.preheatEnd) + Math.min(48, Math.max(2, 2 * slowHours)) * HOUR);
      const initialSourceUncertaintyC = indoorUncertaintyAt(equipment,0,start);
      if (occupancy.mode !== 'away' && (!number(initialState.indoorC) || initialSourceUncertaintyC === null
        || initialState.indoorC + 0.15 + initialSourceUncertaintyC > targetC + maxRiseC)) {
        hotSafe = false; hotStressReason = 'preheat-stress-indoor-upper-limit';
      }
      for (const interval of intervals) {
        if (interval.start !== cursor || !number(interval.outdoorC)) break;
        const end = Math.min(interval.end, endLimit);
        while (cursor < end) {
          const stepEnd = Math.min(end, cursor + STEP,
            ...[schedule.preheatStart, schedule.preheatEnd].filter(boundary => boundary > cursor));
          const dt = (stepEnd - cursor) / HOUR, charging = cursor >= schedule.preheatStart && cursor < schedule.preheatEnd;
          const supplyC = planningSupplyC({...equipment,normalSupplyC},charging?schedule.roomBoostC??0:0);
          const source = estimateHeatPumpPerformance({ ...model.performance, supplyC, brineC: equipment.brineC });
          if (charging && !source.withinPlanningRange) { hotSafe = false; hotStressReason = 'unsupported-preheat-source-temperature'; }
          const inputs = { outdoorC: interval.outdoorC, solarRadiationWm2: interval.solarRadiationWm2,
            fireplaceKgPerHour: fireplaceRate(equipment.fireplaceEvents ?? [], cursor, stepEnd),
            targetC, phase: 'normal', supplyC, brineC: equipment.brineC,
            floorOverrideMode: charging && schedule.floorOverride ? 'on' : 'off', treatmentKey: 'normal',
            ...(charging ? { compressorDuty: 1, auxKw: equipment.nativeAuxAllowed === false ? 0 : config.auxRatedKw }
              : { auxKw: 0 }) };
          // Normal demand after release avoids inventing continuous maximum heat.
          // The charged states persist, allowing their delayed indoor peak to emerge.
          const previousIndoorC = stressed.indoorC;
          stressed = predictThermalStep(model, stressed, inputs, dt);
          native = predictThermalStep(model, native, { ...inputs, supplyC: normalSupplyC,
            compressorDuty: undefined, auxKw: 0, floorOverrideMode: 'off' }, dt);
          hotStressHours += dt;
          const excess = stressed.indoorC - native.indoorC;
          decliningHours = !charging && excess <= lastExcess + 0.001
            && stressed.indoorC <= previousIndoorC + 0.001 ? decliningHours + dt : 0;
          lastExcess = excess;
          if (stressed.indoorC > hotPeakC) { hotPeakC = stressed.indoorC; hotPeakAt = stepEnd; }
          const occupiedAt = occupancy.mode !== 'away' || number(at(occupancy.returnAt)) && at(occupancy.returnAt) <= stepEnd;
          const hotSourceUncertaintyC = indoorUncertaintyAt(equipment,hotStressHours,stepEnd);
          if (hotSourceUncertaintyC === null) {
            hotSafe = false; hotStressReason = 'preheat-stress-indoor-estimate-unavailable';
          } else if (occupiedAt && (!number(stressed.indoorC)
            || stressed.indoorC + 0.15 + hotSourceUncertaintyC > targetC + maxRiseC)) {
            hotSafe = false; hotStressReason = 'preheat-stress-indoor-upper-limit';
          }
          cursor = stepEnd;
          // A peak is covered only after at least two post-reduction hours and
          // one full hour without increasing extra warmth relative to native.
          if (cursor >= minimumEnd && decliningHours >= 1) break;
        }
        if (cursor >= endLimit || cursor >= minimumEnd && decliningHours >= 1) break;
      }
      if (cursor < minimumEnd || decliningHours < 1) {
        hotSafe = false; hotStressReason ??= 'delayed-preheat-peak-not-covered';
      }
    }
  }
  const cost = assessCost && coldSafe && hotSafe ? trialCostExposure({ schedule, initialState, targetC, intervals, model, config,
    occupancy, maxDropC, maxRiseC, equipment }) : { costExposureCents: null, foregoneIncomeCents: null };
  return { available: true, comfortSafe: coldSafe && hotSafe, coldSafe, hotSafe, floorC, ...cost,
    hotPeakC, hotPeakAt, hotStressHours, hotStressReason,
    basis: 'No-heat cold stress plus full compressor/rated permitted AUX during preheat and native demand afterward; weighted indoor limits include source uncertainty, and delayed peaks and fixed slab routing remain estimated.' };
}

/** Complete-cycle incremental exposure. Every physical scenario is applied to
 * both alternatives; ordinary heating is not charged again as trial spending.
 * Unknown reduction response spans unchanged demand through complete suppression.
 * These are engineering scenarios, never calibrated confidence bounds. */
export function trialCostExposure(args) {
  const floor = args.model.floor;
  if (floor?.enabled && (floor.capacityBudgetExceeded
    || !['capacityKwhPerC', 'nativeCapacityKwhPerC', 'exchangeKwPerC'].every(key => number(floor[key]) && floor[key] > 0)
    || !number(floor.groundLossKwPerC) || floor.groundLossKwPerC < 0))
    return { costExposureCents: null, foregoneIncomeCents: null, costBasis: 'Unavailable: invalid physical floor model.' };
  let costExposureCents = 0, foregoneIncomeCents = 0;
  for (const direction of [-1, 0, 1]) {
    const source = estimateHeatPumpPerformance({ ...args.model.performance,
      supplyC: args.equipment?.supplyC, brineC: args.equipment?.brineC });
    const scenario = { ...args,
      model: { ...args.model, parameters: { ...args.model.parameters,
        hydronicCPerKwh: clamp(hydronicGain(args.model) * (1 - direction * .15), ...THERMAL_PARAMETER_BOUNDS.hydronicCPerKwh),
        lossPerHour: clamp(args.model.parameters.lossPerHour * (1 + direction * .15), ...THERMAL_PARAMETER_BOUNDS.lossPerHour) } },
      initialState: { ...args.initialState, reserveC: (args.initialState.reserveC ?? args.initialState.indoorC) + direction * .5,
        slabC: number(args.initialState.slabC) ? args.initialState.slabC + direction * .5 : null },
      config: { ...args.config, scenarioElectricalScale: 1 + direction * source.relativeUncertainty,
        scenarioAuxScale: 1 + direction * .5 } };
    const reference = evaluateCycle({ ...scenario, schedule: null });
    for (const scale of [0, 1]) {
      const action = evaluateCycle({ ...scenario, config: { ...scenario.config, scenarioReductionScale: scale } });
      costExposureCents = Math.max(costExposureCents, action.costCents - reference.costCents);
      const lost = reference.trajectory.reduce((sum, row) => {
        // Evaluate on each trajectory's real boundaries: schedule and recovery
        // transitions need not align with a market interval or the reference.
        const start = Math.max(row.at - row.durationHours * HOUR, args.schedule.reductionStart);
        const end = Math.min(row.at, args.schedule.reductionEnd);
        if (end <= start) return sum;
        const quote = args.intervals.find(interval => interval.start <= start && interval.end > start);
        if (!quote || quote.price >= 0) return sum;
        const actionKwh = action.trajectory.reduce((energy, step) => energy + step.powerKw
          * Math.max(0, Math.min(step.at, end) - Math.max(step.at - step.durationHours * HOUR, start)) / HOUR, 0);
        return sum + Math.max(0, row.powerKw * (end - start) / HOUR - actionKwh) * -quote.price;
      }, 0);
      foregoneIncomeCents = Math.max(foregoneIncomeCents, lost);
    }
  }
  return { costExposureCents: Math.max(costExposureCents, foregoneIncomeCents), foregoneIncomeCents,
    costBasis: 'Maximum additional space-heating cycle cost across paired physical/reduction-response scenarios, including priced thermal debt; not predicted spending.' };
}

/** Recheck the exact promised schedule using current evidence before commanding it. */
export function revalidatePlan({ plan, now, observations, prices, forecast, checkpoint, settings,
  config = {}, thermalState, equipment = {}, trialBudgetRemainingCents = 0 }) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model;
  const rejected = reason => ({ valid:false, reason });
  if (!plan?.schedule || plan.schedule.reductionEnd <= now) return rejected('scheduled-cycle-expired');
  if (Array.isArray(equipment.fireplaceEvents)) equipment = { ...equipment,
    fireplaceRelevant: fireplaceInfluence(equipment.fireplaceEvents, now, {
      gainCPerKg: model?.parameters?.fireplaceCPerKg, gainUncertaintyCPerKg: fireplaceGainUncertainty(model) }).relevant };
  if ((equipment.externalChangeRevision??0)!==(plan.equipment?.externalChangeRevision??0))
    return rejected('scheduled-cycle-native-settings-changed');
  if (!number(observations.indoor?.value) || observations.indoor.stale
    || !number(observations.indoor.observedAt) || observations.indoor.observedAt > now)
    return rejected('scheduled-cycle-observations-stale');
  const targetC = settings.comfort.targetC ?? checkpoint.baselineC ?? plan.targetC;
  if (!number(targetC)) return rejected('scheduled-cycle-target-unavailable');
  const readiness = learningReadiness(checkpoint,c,equipment), duration = (plan.schedule.reductionEnd-plan.schedule.reductionStart)/HOUR;
  const configuredMaximum = equipment.h66Available ? settings.occupancy.mode === 'away' ? c.maxAwayReductionHours : c.maxReductionHours : c.maxUnobservedReductionHours;
  const requestedRoom = preheatRoomRequest(equipment, c);
  if (duration > configuredMaximum || plan.schedule.preheatEnd - plan.schedule.preheatStart > c.maxPreheatHours * HOUR
    || plan.schedule.roomSettingC != null
    && (plan.schedule.roomSettingC !== requestedRoom.roomSettingC || plan.schedule.roomBoostC !== requestedRoom.roomBoostC))
    return rejected('scheduled-cycle-outside-current-limits');
  const initialPlanning = readiness.initialReady;
  const preheatTrial = plan.trial && readiness.trialReady
    && plan.schedule.preheatEnd-plan.schedule.preheatStart<=c.maxPreheatHours*HOUR;
  if (plan.schedule.preheatEnd > plan.schedule.preheatStart && (!equipment.preheatAvailable || plan.schedule.floorOverride && !equipment.floorOverrideAvailable || !preheatTrial
    && !initialPlanning && !preheatEvidenceReady(model, plan.schedule)))
    return rejected('scheduled-preheat-evidence-unavailable');
  if (!plan.trial && !initialPlanning && (!readiness.actionValidated || duration > validatedReductionHours(model)
    || !actionEvidenceReady(model, 'reduction', duration, plan.schedule.treatmentKey)))
    return rejected('scheduled-cycle-response-evidence-unavailable');
  const intervals = forecastIntervals(prices,forecast,now);
  if (!cycleForecastCovered(intervals, plan.schedule, now))
    return rejected('scheduled-cycle-forecast-coverage-lost');
  const initialState = { ...homePlanningState(model, observations.indoor.value, intervals[0]?.outdoorC, intervals[0]?.solarRadiationWm2,thermalState),
    integral:equipment.integral };
  const args = { intervals, model, initialState, targetC, occupancy:settings.occupancy,
    maxDropC:settings.comfort.maxDropC, maxRiseC:settings.comfort.maxRiseC ?? 1.5, config:c, equipment };
  const prediction = evaluateCycle({...args,schedule:plan.schedule}), referencePrediction=evaluateCycle({...args,schedule:plan.reference});
  const benefit = referencePrediction.costCents-prediction.costCents;
  const economics = economicAdmission({ prediction, referencePrediction, args, schedule: plan.schedule, reference: plan.reference, settings });
  const risk = economics.uncertaintyCents;
  const trialSafety=plan.trial?trialEnvelope({...args,schedule:plan.schedule}):null;
  if(plan.trial&&plan.trialOpportunityCostCents!=null&&(!number(plan.trialOpportunityCostCents)||plan.trialOpportunityCostCents<0))
    return rejected('scheduled-cycle-invalid-trial-allowance');
  const preheatSafety = !plan.trial && plan.schedule.preheatEnd > plan.schedule.preheatStart
    ? trialEnvelope({ ...args, schedule: plan.schedule, assessCost: false }) : null;
  if (preheatSafety && !preheatSafety.hotSafe) return rejected('scheduled-preheat-comfort-uncertain');
  const allowance=plan.trial?Math.max(0,-benefit,trialSafety.costExposureCents,plan.trialOpportunityCostCents??0):0;
  const opportunity = trialOpportunity({ schedule: plan.schedule, baseline: referencePrediction, equipment, initialState, intervals });
  if (plan.trial ? prediction.severe || !readiness.trialReady || duration > configuredMaximum || !opportunity.useful
    || !trialSafety.comfortSafe || !number(trialSafety.costExposureCents) || allowance > Math.min(c.maxTrialCostCents,trialBudgetRemainingCents)
    : !economics.admitted)
    return rejected('scheduled-cycle-no-longer-admissible');
  return {valid:true,plan:{...plan,...args,generatedAt:now,prediction,referencePrediction,
    readiness:selectedReadiness(readiness,model,plan.schedule),
    trialSafety:plan.trial?trialSafety:null,trialAllowanceCents:plan.trial?allowance:0,
    trialOpportunity:plan.trial?opportunity:null,
    estimatedBenefitCents:benefit,uncertaintyCents:risk,economics}};
}

export function chooseCycle({ now, observations, prices, forecast, checkpoint, settings, config = {}, thermalState,
  equipment = {}, trialBudgetRemainingCents = 0, incumbentPlan = null }) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model ?? initialAdaptiveModel(c);
  const startupTarget = equipment.observedPhase === 'normal' && settings.occupancy.mode === 'occupied'
    && !(equipment.fireplaceRelevant ?? equipment.fireplaceActive) ? observations.indoor?.value : null;
  const targetC = settings.comfort.targetC ?? checkpoint?.baselineC ?? startupTarget;
  const maxDropC = settings.comfort.maxDropC;
  const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null,
    comfort: { targetC: targetC ?? null, maxDropC, maxDropApplies: settings.occupancy.mode !== 'away' } });
  if (!number(observations.indoor?.value) || !number(observations.indoor.observedAt)
    || observations.indoor.observedAt > now) return normal('missing-or-stale-indoor');
  if (observations.indoor.stale === true) return normal('missing-or-stale-indoor');
  if (!number(targetC)) return normal('awaiting-normal-temperature-reference');
  if (Array.isArray(equipment.fireplaceEvents)) equipment = { ...equipment,
    fireplaceRelevant: fireplaceInfluence(equipment.fireplaceEvents, now, {
      gainCPerKg: model.parameters?.fireplaceCPerKg, gainUncertaintyCPerKg: fireplaceGainUncertainty(model) }).relevant };
  const intervals = forecastIntervals(prices, forecast, now);
  if (!intervals.length || intervals.at(-1).end - now < 4 * HOUR) return normal('missing-or-incomplete-price-weather-horizon');
  const initialState = { ...homePlanningState(model, observations.indoor.value, intervals[0]?.outdoorC, intervals[0]?.solarRadiationWm2,thermalState),
    integral: equipment.integral };
  const evaluation = schedule => evaluateCycle({ schedule, intervals, model, initialState, targetC,
    occupancy: settings.occupancy, maxDropC, maxRiseC: settings.comfort.maxRiseC ?? 1.5, config: c, equipment });
  const baseline = evaluation(null), candidates = [];
  const away = settings.occupancy.mode === 'away';
  const readiness = learningReadiness(checkpoint, c, equipment);
  const targetReached = (equipment.learningTrialsToday ?? 0) >= c.learningTrialTargetPerDay;
  const canTrial = readiness.trialReady && trialBudgetRemainingCents >= 0;
  const configuredMaximum = equipment.h66Available ? (away ? c.maxAwayReductionHours : c.maxReductionHours) : c.maxUnobservedReductionHours;
  const testedMaximum = validatedReductionHours(model);
  const economicMaximum = readiness.initialReady ? configuredMaximum : readiness.actionValidated ? Math.min(configuredMaximum, testedMaximum) : 0;
  const trialMaximum = configuredMaximum;
  if (!economicMaximum && !canTrial)
    return { ...normal('awaiting-tariff-response-evidence'), readiness };
  const maxReduction = Math.max(economicMaximum, canTrial ? trialMaximum : 0);
  const durations = [...new Set([0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 18, 24, economicMaximum, maxReduction])]
    .filter(d => d > 0 && d <= maxReduction).sort((a,b) => a-b);
  // Published price changes define useful starts without assuming hourly tariffs.
  const preheatTrialReady=canTrial;
  const trialPreheat=c.maxPreheatHours;
  const trialPreheatDurations=[.25,.5,.75,1,1.5,2,3,4,6,c.maxPreheatHours].filter(d=>d<=c.maxPreheatHours);
  const changes = intervals.filter((row, i) => i && row.price !== intervals[i-1].price
    && row.start <= now + 36 * HOUR && row.start < intervals.at(-1).end - 2 * HOUR);
  const priceWindows=[...new Set([.25,.5,1,2,maxReduction])].filter(hours=>hours<=maxReduction);
  const priceAverage=(start,hours)=>intervals.reduce((sum,x)=>sum+x.price
    *Math.max(0,Math.min(x.end,start+hours*HOUR)-Math.max(x.start,start))/HOUR,0)/hours;
  const rankings=priceWindows.flatMap(hours=>[false,true].map(contrast=>changes.map(row=>({at:row.start,
    value:priceAverage(row.start,hours)-(contrast?priceAverage(row.start+hours*HOUR,2):0)}))
    .sort((a,b)=>b.value-a.value)));
  const highestPrice=changes.map(row=>({at:row.start,value:priceAverage(row.start,4)}))
    .sort((a,b)=>b.value-a.value).slice(0,24).map(row=>row.at);
  // Keep the largest price windows and a complementary set of short peaks and
  // recovery contrasts. Spread initial slots across hours, then fill unused
  // slots from adjacent changes; this is search allocation, not a control hold.
  const diverseStarts=[];
  for(const separated of [true,false])for(let rank=0;rank<changes.length&&diverseStarts.length<24;rank++)for(const ranking of rankings){
    const candidate=ranking[rank];
    if(candidate&&!diverseStarts.includes(candidate.at)
      &&(!separated||diverseStarts.every(t=>Math.abs(t-candidate.at)>=HOUR)))diverseStarts.push(candidate.at);
    if(diverseStarts.length===24)break;
  }
  const starts = [...new Set([now,...(preheatTrialReady?trialPreheatDurations.map(d=>now+d*HOUR):[]),
    ...highestPrice,...diverseStarts])].sort((a,b)=>a-b);
  const preheatOptions=[];
  let evaluatedCandidates=0, forecastRejected=0, comfortRejected=0;
  const rejectedExamples = new Map();
  const addCandidate=(schedule,duration)=>{
    const result=evaluation(schedule);evaluatedCandidates++;
    const trialSafety=trialEnvelope({schedule,initialState,targetC,intervals,model,config:c,
      occupancy:settings.occupancy,maxDropC,maxRiseC:settings.comfort.maxRiseC ?? 1.5,equipment,assessCost:false});
    const option={schedule,result,duration,trialSafety,firstActionAt:schedule.preheatStart};
    if (!result.severe)candidates.push(option);
    else {
      comfortRejected++;
      for (const entry of result.violations) {
        const key = entry.code;
        if (!rejectedExamples.has(key) && rejectedExamples.size < 12)
          rejectedExamples.set(key, { ...entry, reductionHours: duration });
      }
    }
    return option;
  };
  // A still-valid pending automatic schedule participates in the same fresh
  // economic and trial-opportunity comparison, even outside the bounded grid.
  let incumbent = null;
  if (incumbentPlan && !incumbentPlan.trial && !incumbentPlan.userTrial
    && Math.min(incumbentPlan.schedule?.preheatStart, incumbentPlan.schedule?.reductionStart) > now) {
    const checked = revalidatePlan({ plan: incumbentPlan, now, observations, prices, forecast,
      checkpoint, settings, config: c, thermalState, equipment, trialBudgetRemainingCents });
    if (checked.valid) incumbent = addCandidate(checked.plan.schedule,
      (checked.plan.schedule.reductionEnd-checked.plan.schedule.reductionStart)/HOUR);
  }
  // Evaluate every reduction first. Expand preheat around promising reductions
  // rather than multiplying the entire grid by every duration/boost combination.
  for (const reductionStart of starts) for (const duration of durations) {
    const reductionEnd=reductionStart+duration*HOUR,delay=(reductionStart-now)/HOUR;
    if (!cycleForecastCovered(intervals, { reductionEnd }, now)) { forecastRejected++; continue; }
    const option=addCandidate({preheatStart:reductionStart,preheatEnd:reductionStart,
      reductionStart,reductionEnd,roomBoostC:0,treatmentKey:'reduction-only-v1'},duration);
    const demandWindow=baseline.trajectory.filter(step=>step.at>reductionStart&&step.at<=reductionEnd+2*HOUR);
    const demandHours=demandWindow.reduce((sum,step)=>sum+step.durationHours,0);
    const continuingDemand=demandHours>0
      &&demandWindow.reduce((sum,step)=>sum+step.compressorDuty*step.durationHours,0)/demandHours>.1
      &&demandWindow.reduce((sum,step)=>sum+(step.compressorDuty>.05?step.durationHours:0),0)>=demandHours*.5;
    if (equipment.preheatAvailable && (!equipment.floorOverrideAvailable || model.floor?.enabled && !model.floor.capacityBudgetExceeded) && (readiness.initialReady||actionEvidenceReady(model,'preheat')||preheatTrialReady)&&delay>0&&continuingDemand)
      preheatOptions.push({...option,delay});
  }
  const ranked=[...preheatOptions].sort((a,b)=>a.result.costCents+Math.min(a.result.penalty,50)
    -b.result.costCents-Math.min(b.result.penalty,50));
  const bestByDuration=new Map(),bestByStart=new Map();
  for(const option of ranked){
    if(!bestByDuration.has(option.duration))bestByDuration.set(option.duration,option);
    if(!bestByStart.has(option.schedule.reductionStart)&&bestByStart.size<8)bestByStart.set(option.schedule.reductionStart,option);
  }
  const expansions=[...new Set([...ranked.slice(0,8),...bestByDuration.values(),...bestByStart.values(),...preheatOptions.filter(o=>
    trialPreheatDurations.some(d=>o.schedule.reductionStart===now+d*HOUR)&&o.duration<=trialMaximum).slice(0,4)])];
  for (const option of expansions) {
    const preheats=[...new Set([...(readiness.initialReady||actionEvidenceReady(model,'preheat')?[.25,.5,.75,1,1.5,2,3,4,6,c.maxPreheatHours]:[]),
      ...(preheatTrialReady?[trialPreheat]:[])])].filter(d=>d<=option.delay&&d<=c.maxPreheatHours);
    const requestedRoom = preheatRoomRequest(equipment, c);
    if (!number(requestedRoom.roomBoostC)||requestedRoom.roomBoostC<=0) continue;
    for (const preheat of preheats) addCandidate({...option.schedule,
      preheatStart:option.schedule.reductionStart-preheat*HOUR,...requestedRoom,
      floorOverride:equipment.floorOverrideAvailable === true,treatmentKey:equipment.floorOverrideAvailable ? 'room-boost-floor-v1' : 'room-boost-v1'},option.duration);
  }
  const search={method:'reduction-grid-room-boost-preheat-paired-scenario-shortlist',evaluatedCandidates,
    preheatExpansions:expansions.length,limitation:'Bounded candidate search; not a proof of a global optimum.'};
  const diagnostics = { configuredMaximumHours: configuredMaximum, validatedMaximumHours: testedMaximum,
    economicMaximumHours: economicMaximum, trialMaximumHours: trialMaximum,
    forecastRejected, comfortRejected, violations: [...rejectedExamples.values()] };
  const args = { intervals, model, initialState, targetC, occupancy: settings.occupancy,
    maxDropC, maxRiseC: settings.comfort.maxRiseC ?? 1.5, config: c, equipment };
  for (const option of candidates) {
    option.benefit = baseline.costCents - option.result.costCents;
    option.risk = 5;
  }
  const qualified = candidates.filter(o => o.duration <= economicMaximum && !o.result.severe
    && (o.schedule.preheatEnd === o.schedule.preheatStart || o.trialSafety.hotSafe)
    && (readiness.initialReady || actionEvidenceReady(model, 'reduction', o.duration, o.schedule.treatmentKey))
    && (readiness.initialReady || o.schedule.preheatEnd === o.schedule.preheatStart || preheatEvidenceReady(model, o.schedule)))
    .sort((a,b) => b.benefit - a.benefit);
  // Each action family gets space: nominal reduction candidates must not crowd
  // out a preheat cycle with a better result under the paired physical stress.
  // The same bounded shortlist is used for every savings strategy.
  const economicShortlist=[...qualified.filter(o=>o.schedule.roomBoostC===0).slice(0,16),
    ...qualified.filter(o=>o.schedule.roomBoostC>0).slice(0,16)];
  if (incumbent && qualified.includes(incumbent) && !economicShortlist.includes(incumbent)) economicShortlist.push(incumbent);
  const assessed = economicShortlist.map(option => {
    option.economics = economicAdmission({ prediction: option.result, referencePrediction: baseline, args, schedule: option.schedule, settings });
    option.risk = option.economics.uncertaintyCents;
    return option;
  }).filter(option => option.economics.admitted);
  diagnostics.evidenceRejected = candidates.length - qualified.length;
  diagnostics.economicsAssessed = economicShortlist.length;
  diagnostics.economicsRejected = diagnostics.economicsAssessed - assessed.length;
  diagnostics.economicsAdmitted = assessed.length;
  const best = assessed.length?Math.max(...assessed.map(o => o.economics.lowerBenefitCents)):0;
  const retainedFraction = heatingStrategy(settings.savingsStrategy).retainedBenefitFraction;
  const retainedBenefit=best>=0?best*retainedFraction:best-Math.abs(best)*(1-retainedFraction);
  let chosen = assessed.filter(o => o.economics.lowerBenefitCents >= retainedBenefit)
    .sort((a,b) => a.economics.discomfortCents - b.economics.discomfortCents
      || (a.duration + (a.schedule.preheatEnd-a.schedule.preheatStart)/HOUR)
      - (b.duration + (b.schedule.preheatEnd-b.schedule.preheatStart)/HOUR))[0];
  let trial = false;
  if (canTrial) {
    const cheapLearning=intervals[0].price<=c.learningPriorityPriceCents;
    const economicStart=chosen?Math.min(chosen.schedule.preheatStart,chosen.schedule.reductionStart):null;
    const expensiveOpportunity=chosen&&intervals.some(row=>row.end>chosen.schedule.reductionStart
      &&row.start<chosen.schedule.reductionEnd&&row.price>c.learningPriorityPriceCents);
    const small = candidates.filter(o => o.firstActionAt === now && o.duration <= trialMaximum

      && (!o.schedule.roomBoostC || o.schedule.preheatEnd-o.schedule.preheatStart<=trialPreheat*HOUR)
      && o.trialSafety.comfortSafe && !o.result.severe);
    for (const option of small) {
      option.opportunity = trialOpportunity({ schedule: option.schedule,baseline, equipment, initialState, intervals });
      option.information=trialInformation({schedule:option.schedule,prediction:option.result,baseline,opportunity:option.opportunity,
        noiseC:thermalUncertaintyC(model,6)});
      const phase=option.schedule.roomBoostC>0?'preheat':'reduction';
      option.responseEpisodes=equipmentResponseEstimate(model,phase,option.schedule.treatmentKey)?.trainingEpisodes??0;
    }
    const useful = small.filter(option => option.opportunity.useful)
      .sort((a, b) => {
        const need=option=>option.responseEpisodes-(option.schedule.roomBoostC>0&&option.responseEpisodes===0?.25:0);
        return need(a)-need(b)||b.information.score-a.information.score||a.result.score-b.result.score||a.duration-b.duration;
      });
    const expanding = economicMaximum > 0 ? useful.filter(option => option.duration > economicMaximum
      || option.schedule.roomBoostC > validatedRoomBoost(model)) : [];
    const trialOptions = [...expanding, ...useful.filter(option => !expanding.includes(option))]
      .filter(option=>!chosen||option.benefit>=chosen.benefit||cheapLearning
        &&(!expensiveOpportunity||number(option.result.recoveredAt)&&option.result.recoveredAt<=economicStart));
    diagnostics.trialCandidates = small.length;
    diagnostics.usefulTrialCandidates = useful.length;
    diagnostics.trialCostAssessed = 0;
    let selectedTrial;
    // Cost scenarios run only for a bounded immediate shortlist, never for the
    // entire schedule grid. The shared rule also owns dispatch and continuation.
    for (const option of trialOptions.slice(0, 16)) {
      option.trialSafety = { ...option.trialSafety, ...trialCostExposure({ ...args, schedule: option.schedule }) };
      diagnostics.trialCostAssessed++;
      const fitsBefore=chosen&&number(option.result.recoveredAt)&&option.result.recoveredAt<=economicStart;
      option.opportunityCostCents=chosen&&!fitsBefore?Math.max(0,chosen.benefit-option.benefit):0;
      if (number(option.trialSafety.costExposureCents) && Math.max(option.trialSafety.costExposureCents, -option.benefit,option.opportunityCostCents)
        <= Math.min(c.maxTrialCostCents, trialBudgetRemainingCents)) { selectedTrial = option; break; }
    }
    diagnostics.trialBlockedReason = !small.length ? 'trial-comfort-or-forecast-limited'
      : !useful.length ? 'no-useful-space-heating-window'
        : !selectedTrial ? 'trial-incremental-cost-exceeds-allowance' : null;
    const learningUrgent=!readiness.actionValidated;
    if (selectedTrial && (!chosen || selectedTrial.benefit>=chosen.benefit
      ||cheapLearning&&(!targetReached||learningUrgent))) {chosen=selectedTrial;trial=true;}
  }
  if (!chosen) return { ...normal(diagnostics.trialBlockedReason ?? 'normal-operation-preferred'), readiness,
    diagnostics, evaluation: { baselineCostCents: baseline.costCents, candidates: candidates.length, search } };
  const reference = null, referenceResult = baseline;
  const phase = phaseAt(chosen.schedule, now);
  return { action: phase === 'reduction' ? 'reduction' : 'normal', phase,
    reasons: [trial ? 'bounded-learning-trial' : chosen.economics.lowerBenefitCents<0?'reviewed-experimental-cycle':'predicted-full-cycle-benefit'],
    comfort: { targetC, maxDropC, maxDropApplies: !away }, diagnostics,
    plan: { algorithmVersion: LEARNING_ALGORITHM, generatedAt: now, horizonEnd: intervals.at(-1).end, schedule: chosen.schedule, reference,
      referenceLabel: 'continuous normal operation',
      initialState, targetC, model, intervals, equipment, config: c, occupancy: { ...settings.occupancy },
      maxDropC, maxRiseC: settings.comfort.maxRiseC ?? 1.5,
      savingsStrategy: settings.savingsStrategy,
      trial, trialAllowanceCents: trial ? Math.max(0, -chosen.benefit, chosen.trialSafety.costExposureCents,chosen.opportunityCostCents??0) : 0,
      trialOpportunityCostCents:trial?chosen.opportunityCostCents??0:0,
      trialInformation:trial?chosen.information:null,
      trialSafety: trial ? chosen.trialSafety : null, readiness:selectedReadiness(readiness,model,chosen.schedule),
      search, diagnostics, economics: chosen.economics ?? null,
      trialOpportunity: trial ? chosen.opportunity : null,
      prediction: chosen.result, referencePrediction: referenceResult,
      estimatedBenefitCents: referenceResult.costCents - chosen.result.costCents,
      uncertaintyCents: chosen.risk, evidence: 'Estimated complete-cycle comparison; unexecuted reference is modelled.' } };
}
