import { initialAdaptiveModel, THERMAL_PARAMETER_BOUNDS, predictThermalStep, predictEquipmentDuty, thermalEvidenceReady, actionEvidenceReady, thermalUncertaintyC, fireplaceEvidenceReady, fireplaceGainUncertainty } from './adaptive-learning.js';
import { estimateHeatPumpPerformance, hydronicGain } from '../domain/heat-pump-performance.js';
import { heatingStrategy } from '../domain/heating-strategy.js';
import { CONTROL_DEFAULTS } from '../app/config.js';
import { fireplaceInfluence, fireplaceRate } from '../domain/fireplace.js';

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

/** A new normal-temperature estimate must not justify a deep occupied setback. */
export const effectiveComfortDropC = (maxDropC, equipment = {}) => equipment.comfortReferenceProvisional === true
  ? Math.min(maxDropC, 0.5) : maxDropC;

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
  const thermalValidated = thermalEvidenceReady(model), responseValidated = actionEvidenceReady(model, 'reduction');
  const advanceValidated = model?.forecastValidation?.accepted === true;
  const fireplaceValidated = fireplaceEvidenceReady(model);
  const fireplacePending = (equipment.fireplaceRelevant ?? equipment.fireplaceActive) === true && !fireplaceValidated;
  const actionValidated = responseValidated && advanceValidated && !fireplacePending;
  const trialReady = c.learningTrials && (checkpoint?.health?.usableSamples ?? 0) >= 4
    && number(equipment.compressorOn) && number(equipment.dhwRouting)
    && equipment.indoorEstimated !== true
    && !fireplacePending
    && (!number(equipment.trialBudgetRemainingCents)||equipment.trialBudgetRemainingCents>0);
  return { thermalValidated, responseValidated, advanceValidated, fireplaceValidated, actionValidated, trialReady,
    reasons: [!thermalValidated && 'awaiting-held-out-thermal-trajectories',
      !actionValidated && 'awaiting-held-out-tariff-response',
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
  const boostC = number(baselineC) ? Math.max(0, Math.min(config.preheatRoomBoostC ?? CONTROL_DEFAULTS.preheatRoomBoostC, maximumC - baselineC)) : null;
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
  maxDropC = effectiveComfortDropC(maxDropC, equipment);
  model ??= initialAdaptiveModel(c);
  if (!Array.isArray(intervals) || !number(initialState?.indoorC) || !number(targetC))
    throw new TypeError('A cycle requires intervals, indoor temperature and a target');
  let state = { indoorC: initialState.indoorC, reserveC: initialState.reserveC ?? initialState.indoorC, slabC: initialState.slabC ?? initialState.reserveC ?? initialState.indoorC };
  let nativeState = { ...state };
  const normalSupplyC = number(equipment.normalSupplyC) ? equipment.normalSupplyC : number(equipment.supplyC)
    ? equipment.supplyC - (equipment.observedPhase === 'preheat' ? 3 * (equipment.observedRoomBoostC ?? 0) : 0) : null;
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
    const inputs = { outdoorC: interval.outdoorC, solarRadiationWm2: interval.solarRadiationWm2,
      phase, roomBoostC: boost, targetC,
      supplyC: phase === 'preheat' ? (number(normalSupplyC) ? normalSupplyC : 35) + 3 * boost : normalSupplyC,
      brineC: equipment.brineC, floorOverrideMode: !native && phase === 'preheat' && schedule?.floorOverride ? 'on' : 'off',
      treatmentKey: !native && schedule ? schedule.treatmentKey ?? 'reduction-only-v1' : 'normal',
      fireplaceKgPerHour: fireplaceRate(equipment.fireplaceEvents ?? [], stepStart, stepStart + dt * HOUR) };
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
      : phase === 'preheat' ? clamp(boost * 0.025, 0, 0.2) : 0.015;
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
    const auxKw = Math.min(c.auxRatedKw, c.auxRatedKw * risk * (model.energy?.auxiliaryRiskScale ?? 1) * (c.scenarioAuxScale ?? 1));
    return { ...predictThermalStep(model, before, { ...inputs, auxKw }, dt), auxKw, auxiliaryRisk: risk,
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
      uncertaintyC = sourceUncertaintyC === null ? null : sourceUncertaintyC + thermalUncertaintyC(model, elapsed, { phase,
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
  const terminalPrice = Math.max(0, ...intervals.map(i => i.price));
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
  const strategy = heatingStrategy(settings.savingsStrategy);
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
  const uncertaintyCents = Math.max(5, benefitCents - lowerBenefitCents);
  lowerBenefitCents = benefitCents - uncertaintyCents;
  const discomfort = Object.entries(prediction.discomfort).reduce((sum, [direction, value]) =>
    sum + Math.max(0, value - referencePrediction.discomfort[direction]), 0);
  const activeHours = plan => plan ? Math.max(0, plan.reductionEnd - Math.max(args.intervals[0].start, plan.preheatStart)) / HOUR : 0;
  const extraHours = Math.max(0, activeHours(schedule) - activeHours(reference));
  const minimumCents = continuing ? 0 : strategy.minimumHomeBenefitCents;
  const discomfortCents = discomfort * strategy.homeDiscomfortCentsPerDegreeSquaredHour;
  const burdenCents = 2 * extraHours + (!continuing && schedule && !reference ? 2 : 0);
  const hurdleCents = minimumCents + discomfortCents + burdenCents;
  return { admitted: !unsafe && lowerBenefitCents > hurdleCents, benefitCents, lowerBenefitCents,
    uncertaintyCents, minimumCents, discomfortCents, burdenCents, hurdleCents, unsafe,
    basis: 'Paired physical stress scenarios; estimated space-heating costs, not measured whole-house savings.' };
}

export function validatedReductionHours(model) {
  const phase = model?.equipmentResponse?.validation?.phases?.reduction;
  return actionEvidenceReady(model, 'reduction') && model?.forecastValidation?.accepted
    && number(phase?.maxDurationHours) && number(model.forecastValidation.maxReductionHours)
    ? Math.min(phase.maxDurationHours,model.forecastValidation.maxReductionHours) : 0;
}

function validatedRoomBoost(model) {
  return actionEvidenceReady(model,'preheat')
    ? model.equipmentResponse.validation.phases.preheat.maxRoomBoostC??0 : 0;
}

function preheatEvidenceReady(model, schedule) {
  const durationHours = (schedule.preheatEnd - schedule.preheatStart) / HOUR;
  return actionEvidenceReady(model, 'preheat', durationHours, schedule.treatmentKey)
    && number(schedule.roomBoostC) && schedule.roomBoostC >= 0
    && schedule.roomBoostC <= validatedRoomBoost(model);
}

function preheatTrialHours(model,config) {
  const demonstrated=actionEvidenceReady(model,'preheat')?model.equipmentResponse.validation.phases.preheat.maxDurationHours:0;
  // Duration expands independently of circulation pulses; fixed ROOM is not swept.
  return Math.min(config.maxPreheatHours,Math.max(.75,demonstrated*1.5+.25));
}

export function trialEnvelope({ schedule, initialState, targetC, intervals, model, config = {}, occupancy = {}, maxDropC = 1.5,
  maxRiseC = 1.5, equipment = {} }) {
  config = { ...CONTROL_DEFAULTS, ...config };
  maxDropC = effectiveComfortDropC(maxDropC, equipment);
  if (!cycleForecastCovered(intervals, schedule)) return { available: false, reason: 'forecast-coverage-lost',
    comfortSafe: false, coldSafe: false, hotSafe: false, costExposureCents: null };
  const normalSupplyC = number(equipment.normalSupplyC) ? equipment.normalSupplyC : number(equipment.supplyC)
    ? equipment.supplyC - (equipment.observedPhase === 'preheat' ? 3 * (equipment.observedRoomBoostC ?? 0) : 0) : null;
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
  const coldSafe = number(floorC) && weather.length > 0 && (!occupied || floorC >= targetC-Math.min(1,maxDropC));
  const recoveryPrices = intervals.filter(i => i.end > schedule.reductionEnd && i.start < schedule.reductionEnd + 4*HOUR);
  const replacementPrice = Math.max(0, ...recoveryPrices.map(i => i.price));
  const preheatHours=Math.max(0,(schedule.preheatEnd-schedule.preheatStart)/HOUR);
  const preheatPrice=Math.max(0,...intervals.filter(i=>i.end>schedule.preheatStart&&i.start<schedule.preheatEnd).map(i=>i.price));
  const ratedKw = config.heatPumpCompressorKw + config.circulationKw + config.auxRatedKw;
  // A no-heat trial can also lose income from negative all-in electricity
  // prices. The unknown tariff response cannot establish that this loss is zero.
  const foregoneIncomeCents = weather.reduce((sum, interval) => sum + Math.max(0, -interval.price)
    * Math.max(0, Math.min(interval.end, schedule.reductionEnd) - Math.max(interval.start, schedule.reductionStart)) / HOUR, 0) * ratedKw;
  const costExposureCents = Math.max(5, (duration * replacementPrice * 1.5 + preheatHours*preheatPrice)
    * ratedKw + foregoneIncomeCents);
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
          const supplyC = number(normalSupplyC) ? normalSupplyC + (charging ? 3 * Math.max(0, schedule.roomBoostC ?? 0) : 0) : null;
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
  return { available: true, comfortSafe: coldSafe && hotSafe, coldSafe, hotSafe, floorC, costExposureCents, foregoneIncomeCents,
    hotPeakC, hotPeakAt, hotStressHours, hotStressReason,
    basis: 'No-heat cold stress plus full compressor/rated permitted AUX during preheat and native demand afterward; weighted indoor limits include source uncertainty, and delayed peaks and fixed slab routing remain estimated.' };
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
  if (!fireplaceEvidenceReady(model) && (equipment.fireplaceRelevant ?? equipment.fireplaceActive) === true)
    return rejected('awaiting-fireplace-response-evidence');
  if ((equipment.externalChangeRevision??0)!==(plan.equipment?.externalChangeRevision??0))
    return rejected('scheduled-cycle-native-settings-changed');
  if (!number(observations.indoor?.value) || observations.indoor.stale
    || !number(observations.indoor.observedAt) || observations.indoor.observedAt > now)
    return rejected('scheduled-cycle-observations-stale');
  const targetC = settings.comfort.targetC ?? checkpoint.baselineC;
  if (!number(targetC)) return rejected('scheduled-cycle-target-unavailable');
  const readiness = learningReadiness(checkpoint,c,equipment), duration = (plan.schedule.reductionEnd-plan.schedule.reductionStart)/HOUR;
  const configuredMaximum = equipment.h66Available ? settings.occupancy.mode === 'away' ? c.maxAwayReductionHours : c.maxReductionHours : c.maxUnobservedReductionHours;
  const requestedRoom = preheatRoomRequest(equipment, c);
  if (duration > configuredMaximum || plan.schedule.preheatEnd - plan.schedule.preheatStart > c.maxPreheatHours * HOUR
    || plan.schedule.roomSettingC != null
    && (plan.schedule.roomSettingC !== requestedRoom.roomSettingC || plan.schedule.roomBoostC !== requestedRoom.roomBoostC))
    return rejected('scheduled-cycle-outside-current-limits');
  const preheatTrial = plan.trial && readiness.thermalValidated && actionEvidenceReady(model,'reduction')
    && plan.schedule.preheatEnd-plan.schedule.preheatStart<=preheatTrialHours(model,c)*HOUR;
  if (plan.schedule.preheatEnd > plan.schedule.preheatStart && (!equipment.preheatAvailable || plan.schedule.floorOverride && !equipment.floorOverrideAvailable || !preheatTrial
    && !preheatEvidenceReady(model, plan.schedule)))
    return rejected('scheduled-preheat-evidence-unavailable');
  if (!plan.trial && (!readiness.actionValidated || duration > validatedReductionHours(model)
    || !actionEvidenceReady(model, 'reduction', duration, plan.schedule.treatmentKey)))
    return rejected('scheduled-cycle-response-evidence-unavailable');
  const intervals = forecastIntervals(prices,forecast,now);
  if (!cycleForecastCovered(intervals, plan.schedule, now))
    return rejected('scheduled-cycle-forecast-coverage-lost');
  const initialState = {indoorC:observations.indoor.value,reserveC:thermalState?.reserveC ?? observations.indoor.value,slabC:thermalState?.slabC ?? null,integral:equipment.integral};
  const args = { intervals, model, initialState, targetC, occupancy:settings.occupancy,
    maxDropC:effectiveComfortDropC(settings.comfort.maxDropC,equipment), maxRiseC:settings.comfort.maxRiseC ?? 1.5, config:c, equipment };
  const prediction = evaluateCycle({...args,schedule:plan.schedule}), referencePrediction=evaluateCycle({...args,schedule:plan.reference});
  const benefit = referencePrediction.costCents-prediction.costCents;
  const economics = economicAdmission({ prediction, referencePrediction, args, schedule: plan.schedule, reference: plan.reference, settings });
  const risk = economics.uncertaintyCents;
  const trialSafety=trialEnvelope({...args,schedule:plan.schedule});
  const allowance=Math.max(0,-benefit,trialSafety.costExposureCents);
  if (plan.trial ? prediction.severe || !readiness.trialReady || duration > Math.max(.5,validatedReductionHours(model)*1.5)
    || !trialSafety.comfortSafe || allowance > Math.min(c.maxTrialCostCents,trialBudgetRemainingCents)
    : !economics.admitted)
    return rejected('scheduled-cycle-no-longer-admissible');
  return {valid:true,plan:{...plan,...args,generatedAt:now,prediction,referencePrediction,readiness,
    trialSafety:plan.trial?trialSafety:null,trialAllowanceCents:plan.trial?allowance:0,
    estimatedBenefitCents:benefit,uncertaintyCents:risk,economics}};
}

export function chooseCycle({ now, observations, prices, forecast, checkpoint, settings, config = {}, thermalState,
  equipment = {}, trialBudgetRemainingCents = 0 }) {
  const c = { ...CONTROL_DEFAULTS, ...config }, model = checkpoint?.model ?? initialAdaptiveModel(c);
  const targetC = settings.comfort.targetC ?? checkpoint?.baselineC;
  const maxDropC = effectiveComfortDropC(settings.comfort.maxDropC, equipment);
  const normal = reason => ({ action: 'normal', phase: 'normal', reasons: [reason], plan: null,
    comfort: { targetC: targetC ?? null, maxDropC, maxDropApplies: settings.occupancy.mode !== 'away' } });
  if (!number(observations.indoor?.value) || !number(observations.indoor.observedAt)
    || observations.indoor.observedAt > now) return normal('missing-or-stale-indoor');
  if (observations.indoor.stale === true) return normal('missing-or-stale-indoor');
  if (!number(targetC)) return normal('awaiting-normal-temperature-reference');
  if (Array.isArray(equipment.fireplaceEvents)) equipment = { ...equipment,
    fireplaceRelevant: fireplaceInfluence(equipment.fireplaceEvents, now, {
      gainCPerKg: model.parameters?.fireplaceCPerKg, gainUncertaintyCPerKg: fireplaceGainUncertainty(model) }).relevant };
  if (!fireplaceEvidenceReady(model) && (equipment.fireplaceRelevant ?? equipment.fireplaceActive) === true)
    return normal('awaiting-fireplace-response-evidence');
  const intervals = forecastIntervals(prices, forecast, now);
  if (!intervals.length || intervals.at(-1).end - now < 4 * HOUR) return normal('missing-or-incomplete-price-weather-horizon');
  const initialState = { indoorC: observations.indoor.value, reserveC: thermalState?.reserveC ?? observations.indoor.value, slabC: thermalState?.slabC ?? null,
    integral: equipment.integral };
  const evaluation = schedule => evaluateCycle({ schedule, intervals, model, initialState, targetC,
    occupancy: settings.occupancy, maxDropC, maxRiseC: settings.comfort.maxRiseC ?? 1.5, config: c, equipment });
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
  let evaluatedCandidates=0, forecastRejected=0, comfortRejected=0;
  const rejectedExamples = new Map();
  const addCandidate=(schedule,duration)=>{
    const result=evaluation(schedule);evaluatedCandidates++;
    const trialSafety=trialEnvelope({schedule,initialState,targetC,intervals,model,config:c,
      occupancy:settings.occupancy,maxDropC,maxRiseC:settings.comfort.maxRiseC ?? 1.5,equipment});
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
    if (equipment.preheatAvailable && (!equipment.floorOverrideAvailable || model.floor?.enabled && !model.floor.capacityBudgetExceeded) && (actionEvidenceReady(model,'preheat')||preheatTrialReady)&&delay>0&&continuingDemand)
      preheatOptions.push({...option,delay});
  }
  const ranked=[...preheatOptions].sort((a,b)=>a.result.costCents+Math.min(a.result.penalty,50)
    -b.result.costCents-Math.min(b.result.penalty,50));
  const expansions=[...new Set([...ranked.slice(0,8),...preheatOptions.filter(o=>
    o.schedule.reductionStart===now+trialPreheat*HOUR&&o.duration<=trialMaximum).slice(0,4)])];
  for (const option of expansions) {
    const preheats=[...new Set([...(actionEvidenceReady(model,'preheat')?[.5,1,1.5,2,3,4,6,c.maxPreheatHours]:[]),
      ...(preheatTrialReady?[trialPreheat]:[])])].filter(d=>d<=option.delay&&d<=c.maxPreheatHours);
    const requestedRoom = preheatRoomRequest(equipment, c);
    if (!number(requestedRoom.roomBoostC)) continue;
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
    && actionEvidenceReady(model, 'reduction', o.duration, o.schedule.treatmentKey)
    && (o.schedule.preheatEnd === o.schedule.preheatStart || preheatEvidenceReady(model, o.schedule)))
    .sort((a,b) => b.benefit - a.benefit);
  // The same bounded shortlist is used for every savings strategy.
  const assessed = qualified.slice(0, 16).map(option => {
    option.economics = economicAdmission({ prediction: option.result, referencePrediction: baseline, args, schedule: option.schedule, settings });
    option.risk = option.economics.uncertaintyCents;
    return option;
  }).filter(option => option.economics.admitted);
  diagnostics.evidenceRejected = candidates.length - qualified.length;
  diagnostics.economicsAssessed = Math.min(qualified.length, 16);
  diagnostics.economicsRejected = diagnostics.economicsAssessed - assessed.length;
  diagnostics.economicsAdmitted = assessed.length;
  const best = Math.max(0, ...assessed.map(o => o.economics.lowerBenefitCents));
  const retainedFraction = heatingStrategy(settings.savingsStrategy).retainedBenefitFraction;
  let chosen = assessed.filter(o => o.economics.lowerBenefitCents >= best * retainedFraction)
    .sort((a,b) => a.economics.discomfortCents - b.economics.discomfortCents
      || (a.duration + (a.schedule.preheatEnd-a.schedule.preheatStart)/HOUR)
      - (b.duration + (b.schedule.preheatEnd-b.schedule.preheatStart)/HOUR))[0];
  let trial = false;
  const explore=Boolean(chosen)&&economicMaximum>0&&(model.energy?.episodes??0)%4===3;
  if ((!chosen||explore) && readiness.trialReady && trialBudgetRemainingCents > 0) {
    const small = candidates.filter(o => o.firstActionAt === now && o.duration <= trialMaximum

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
    diagnostics, evaluation: { baselineCostCents: baseline.costCents, candidates: candidates.length, search } };
  const reference = null, referenceResult = baseline;
  const phase = phaseAt(chosen.schedule, now);
  return { action: phase === 'reduction' ? 'reduction' : 'normal', phase,
    reasons: [trial ? 'bounded-learning-trial' : 'predicted-full-cycle-benefit'],
    comfort: { targetC, maxDropC, maxDropApplies: !away }, diagnostics,
    plan: { generatedAt: now, horizonEnd: intervals.at(-1).end, schedule: chosen.schedule, reference,
      referenceLabel: 'continuous normal operation',
      initialState, targetC, model, intervals, equipment, config: c, occupancy: { ...settings.occupancy },
      maxDropC, maxRiseC: settings.comfort.maxRiseC ?? 1.5,
      savingsStrategy: settings.savingsStrategy,
      trial, trialAllowanceCents: trial ? Math.max(0, -chosen.benefit, chosen.trialSafety.costExposureCents) : 0,
      trialSafety: trial ? chosen.trialSafety : null, readiness, search, diagnostics, economics: chosen.economics ?? null,
      prediction: chosen.result, referencePrediction: referenceResult,
      estimatedBenefitCents: referenceResult.costCents - chosen.result.costCents,
      uncertaintyCents: chosen.risk, evidence: 'Estimated complete-cycle comparison; unexecuted reference is modelled.' } };
}
