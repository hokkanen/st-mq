import { initialAdaptiveModel, predictThermalStep } from './adaptive-learning.js';
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
  let absoluteCostCents = 0, recoveryEnergyKwh = 0, recoveryAuxKwh = 0;
  let penalty = 0, severe = false, uncertaintyC = 0, elapsed = 0;
  let recoverySettledHours = 0, recoveredAt = null, previousEnd = null;
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
    const blocked = equipment.nativeAuxAllowed === false || !native && phase === 'reduction' && equipment.h66Available;
    const risk = blocked ? 0 : Math.max(thresholdRisk, hysteresisRisk, capacityRisk, priorRisk);
    const auxKw = Math.min(c.auxRatedKw, c.auxRatedKw * risk * (model.energy?.auxiliaryRiskScale ?? 1));
    return { ...predictThermalStep(model, before, { ...inputs, auxKw }, dt), auxKw, auxiliaryRisk: risk };
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
      state = { indoorC: prediction.indoorC, reserveC: prediction.reserveC };
      elapsed += dt;
      uncertaintyC = prediction.uncertaintyC / Math.sqrt(dt) * Math.sqrt(elapsed);
      const duty = prediction.compressorDuty, auxKw = prediction.auxKw;
      const compressorKw = model.energy?.compressorKw ?? c.heatPumpCompressorKw;
      const recoveryMultiplier = phase === 'recovery' ? model.energy?.recoveryMultiplier ?? 1.15 : 1;
      // Higher supply demand and DHWR recharge add electrical cost to coupled preheat.
      const preheatMultiplier = phase === 'preheat' ? 1 + roomBoostC * 0.035 : 1;
      const kw = compressorKw * duty * recoveryMultiplier * preheatMultiplier + c.circulationKw * duty + auxKw
        + (phase === 'preheat' ? c.dhwrKw : 0);
      const kwh = kw * dt, cents = kwh * interval.price;
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
        auxiliaryRisk: prediction.auxiliaryRisk, powerKw: kw, auxiliaryKw: auxKw,
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
    + 0.5 * Math.max(0, nativeState.reserveC - state.reserveC) : 0;
  const terminalKwh = includeTail ? deficit / model.parameters.normalHeatCPerHour
    * (model.energy?.compressorKw ?? c.heatPumpCompressorKw) * (model.energy?.recoveryMultiplier ?? 1.15) : 0;
  const terminalPrice = Math.max(0, ...intervals.map(i => i.price));
  const terminalCostCents = terminalKwh * terminalPrice;
  costCents += terminalCostCents;
  const uncertaintyCents = Math.max(5, (absoluteCostCents + Math.abs(terminalCostCents)) * (model.energy?.relativeUncertainty ?? 0.5)
    + (equipment.h66Available ? 0 : auxiliaryKwh * terminalPrice * 0.5));
  return { costCents, electricityKwh, auxiliaryKwh, recoveryCostCents, recoveryEnergyKwh, recoveryAuxKwh, preheatCostCents,
    penalty, score: costCents + penalty, severe, endState: state, terminalKwh, terminalCostCents,
    uncertaintyCents, trajectory, recoveredAt, nativeEndState: nativeState,
    integralBasis: 'At most one hour of measured-trend projection; later native integral unknown',
    auxiliaryBasis: 'Estimated space-heating auxiliary risk; DHW costs need separate observed attribution',
    basis: 'estimated', completeRecoveryPredicted: schedule === null || recoveredAt !== null };
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
  const maxReduction = equipment.h66Available ? (away ? c.maxAwayReductionHours : c.maxReductionHours) : c.maxUnobservedReductionHours;
  const durations = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12].filter(d => d <= maxReduction);
  // Forward start candidates expose the coming plan, while only due actions are executed.
  for (const delay of [0, 0.5, 1, 2, 4, 6, 8, 12]) {
    for (const duration of durations) {
      const reductionStart = now + delay * HOUR, reductionEnd = reductionStart + duration * HOUR;
      if (reductionEnd + 2 * HOUR > intervals.at(-1).end) continue;
      const demandWindow = baseline.trajectory.filter(step => step.at > reductionStart && step.at <= reductionEnd + 2 * HOUR);
      const demandHours = demandWindow.reduce((sum, step) => sum + step.durationHours, 0);
      const continuingDemand = demandHours > 0
        && demandWindow.reduce((sum, step) => sum + step.compressorDuty * step.durationHours, 0) / demandHours > 0.1
        && demandWindow.reduce((sum, step) => sum + (step.compressorDuty > 0.05 ? step.durationHours : 0), 0) >= demandHours * 0.5;
      const preheats = equipment.preheatAvailable && delay > 0 && continuingDemand
        ? [0, ...[0.5, 1, 2].filter(d => d <= delay && d <= c.maxPreheatHours)] : [0];
      for (const preheat of preheats) for (const boost of preheat ? [1, 2, 3, 5].filter(b => b <= c.maxRoomBoostC) : [0]) {
        const schedule = { preheatStart: reductionStart - preheat * HOUR, preheatEnd: reductionStart,
          reductionStart, reductionEnd, roomBoostC: boost };
        const result = evaluation(schedule);
        if (!result.severe) candidates.push({ schedule, result, duration, firstActionAt: preheat ? schedule.preheatStart : reductionStart });
      }
    }
  }
  // Compare differences, not independent absolute-cost error bars which would block every modest action.
  for (const option of candidates) {
    option.benefit = baseline.costCents - option.result.costCents;
    option.risk = Math.max(5, Math.abs(option.benefit) * (model.energy?.relativeUncertainty ?? 0.5)
      + Math.max(0, option.result.auxiliaryKwh - baseline.auxiliaryKwh) * Math.max(0, ...intervals.map(i => i.price)) * 0.5);
  }
  let chosen = candidates.filter(o => o.benefit > o.risk && o.result.score + o.risk < baseline.score)
    .sort((a,b) => a.result.score - b.result.score)[0];
  let trial = false;
  if (!chosen && c.learningTrials && trialBudgetRemainingCents > 0) {
    const small = candidates.filter(o => o.firstActionAt === now && o.duration <= 0.5 && o.schedule.roomBoostC <= 1
      && Math.max(0, -o.benefit) + o.risk <= Math.min(c.maxTrialCostCents, trialBudgetRemainingCents));
    // A trial must expose useful action coverage, not repeat an already well-sampled normal regime.
    chosen = small.sort((a,b) => a.result.score - b.result.score)[0];
    trial = Boolean(chosen);
  }
  if (!chosen) return { ...normal('normal-operation-preferred'), evaluation: { baselineCostCents: baseline.costCents, candidates: candidates.length } };
  // Freeze the best feasible strictly shorter alternative under the same information.
  const shorter = candidates.filter(o => o.duration < chosen.duration && o.schedule.reductionStart === chosen.schedule.reductionStart
    && o.firstActionAt >= chosen.firstActionAt)
    .sort((a,b) => a.result.score - b.result.score)[0];
  const reference = shorter?.schedule ?? null, referenceResult = shorter?.result ?? baseline;
  const phase = phaseAt(chosen.schedule, now);
  return { action: phase === 'reduction' ? 'reduction' : 'normal', phase,
    reasons: [trial ? 'bounded-learning-trial' : 'predicted-full-cycle-benefit'],
    comfort: { targetC, maxDropC: settings.comfort.maxDropC, maxDropApplies: !away },
    plan: { generatedAt: now, horizonEnd: intervals.at(-1).end, schedule: chosen.schedule, reference,
      referenceLabel: shorter ? `${shorter.duration}-hour reduction` : 'continuous normal operation',
      initialState, targetC, model, intervals, equipment, occupancy: { ...settings.occupancy }, maxDropC: settings.comfort.maxDropC,
      trial, trialAllowanceCents: trial ? Math.max(0, -chosen.benefit) + chosen.risk : 0,
      prediction: chosen.result, referencePrediction: referenceResult,
      estimatedBenefitCents: referenceResult.costCents - chosen.result.costCents,
      uncertaintyCents: chosen.risk, evidence: 'Estimated complete-cycle comparison; unexecuted reference is modelled.' } };
}
