import { predictGarageStep, GARAGE_ALGORITHM_VERSION, GARAGE_MODEL_ASSUMPTIONS,
  qualifiedGaragePower, garageChargingClean } from './model.js';
import { garageDoorIntervalUnknown } from './door-state.js';

const HOUR = 3_600_000, finite = Number.isFinite;
/** Compact frozen counterfactual accounting, separate from dispatch's pure timing
 * objective. Both branches receive the same observed weather and EV assumptions. */
export function startGarageAssessment(model, observation) {
  const initial = { ...model.state, rearC: observation.rearC, frontC: observation.frontC,
    differenceC: observation.frontC - observation.rearC };
  return { algorithmVersion: GARAGE_ALGORITHM_VERSION, at: observation.at, previous: structuredClone(observation),
    actualState: structuredClone(initial), referenceState: structuredClone(initial),
    actualCostCents: 0, referenceCostCents: 0, actualKwh: 0, referenceKwh: 0, uncertaintyCents: 0,
    coveredMs: 0, missingMs: 0, recordedMs: 0, steps: 0, qualified: true, provisional: true,
    recoveryAllowanceKwh: 0, recoveryAccountedKwh: 0, recoveryHours: 0 };
}
export function updateGarageAssessment(previous, model, observation, { recordedKwh = null, priceCtPerKwh = null, priceSegments = null } = {}) {
  const next = structuredClone(previous), duration = observation.at - next.at;
  if (duration <= 0) return next;
  const actual = next.previous;
  // A door disturbance or reporting gap cannot establish comparable service.
  // Keep measured costs and the restoration obligation while withholding the
  // savings claim; a recovered endpoint cannot undo the earlier uncertainty.
  if (garageDoorIntervalUnknown(observation, actual, actual.at)) next.qualified = false;
  if ([actual, observation].some(row => !garageChargingClean(row) || row.inputDisturbed === true
    || (Object.hasOwn(row, 'baselineAccepted') || Object.hasOwn(row, 'baselineVerified'))
      && row.baselineAccepted !== true && row.baselineVerified !== true)
    || actual.sourceEpoch != null && observation.sourceEpoch !== actual.sourceEpoch) next.qualified = false;
  const recorded = finite(recordedKwh) && recordedKwh >= 0;
  const segments = priceSegments ?? [{ start: next.at, end: observation.at, priceCtPerKwh }];
  let cursor = next.at;
  const coveredPrices = segments.length > 0 && segments.every(segment => {
    const valid = segment.start === cursor && segment.end > segment.start && segment.end <= observation.at && finite(segment.priceCtPerKwh);
    cursor = segment.end; return valid;
  }) && cursor === observation.at;
  if (duration > 15 * 60_000 || !finite(actual.outdoorC) || !finite(actual.rearC) || !finite(actual.frontC)
    || typeof actual.available !== 'boolean' || !coveredPrices) {
    next.qualified = false; next.missingMs += duration;
  } else {
    const shared = { outdoorC: actual.outdoorC, ev1Kw: actual.ev1Kw, ev2Kw: actual.ev2Kw,
      ev1Active: actual.ev1Active, ev2Active: actual.ev2Active };
    for (const segment of segments) {
      const hours = (segment.end - segment.start) / HOUR;
      const reference = predictGarageStep(model, next.referenceState, { ...shared, available: true }, hours);
      const execution = predictGarageStep(model, next.actualState, { ...shared, available: actual.available,
        powerKw: actual.powerKw, powerQuality: actual.powerQuality, activity: actual.activity,
        restart: actual.restart === true }, hours, { conditional: true });
      // Qualifying short electrical intervals are allocated by elapsed time;
      // their counter totals never become an arrival-time energy spike.
      const observed = recorded || qualifiedGaragePower(actual);
      let energy = recorded ? recordedKwh * (segment.end - segment.start) / duration : execution.electricityKwh;
      if (actual.available === false) {
        next.recoveryAllowanceKwh += Math.max(0, reference.electricityKwh - energy) * GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor;
      } else {
        const repayment = Math.min(Math.max(0, next.recoveryAllowanceKwh - next.recoveryAccountedKwh),
          next.recoveryAllowanceKwh * hours / GARAGE_MODEL_ASSUMPTIONS.recoveryTimeHours);
        next.recoveryHours += hours; next.recoveryAccountedKwh += repayment;
        // Qualified actual input already includes recovery. Unmetered costs
        // explicitly repay the same allowance used when selecting the pause.
        if (!observed) energy += repayment;
      }
      next.actualKwh += energy; next.referenceKwh += reference.electricityKwh;
      next.actualCostCents += energy * segment.priceCtPerKwh;
      next.referenceCostCents += reference.electricityKwh * segment.priceCtPerKwh;
      next.uncertaintyCents += (reference.uncertaintyKwh + (recorded ? 0 : execution.uncertaintyKwh)) * Math.abs(segment.priceCtPerKwh);
      next.referenceState = reference.state; next.actualState = execution.state;
    }
    // Actual external sensors anchor each local air state independently.
    next.actualState = { ...next.actualState,
      ...(finite(observation.rearC) ? { rearC: observation.rearC } : {}),
      ...(finite(observation.frontC) ? { frontC: observation.frontC } : {}),
      ...(finite(observation.frontC) && finite(observation.rearC) ? { differenceC: observation.frontC - observation.rearC } : {}) };
    next.coveredMs += duration; if (recorded) next.recordedMs += duration; next.steps++;
  }
  next.at = observation.at; next.previous = structuredClone(observation);
  return next;
}
export function garageRecoveryDebt(assessment) {
  return Object.fromEntries(['rearC', 'frontC'].map(key => [key,
    finite(assessment?.referenceState?.[key]) && finite(assessment?.actualState?.[key])
      ? Math.max(0, assessment.referenceState[key] - assessment.actualState[key]) : null]));
}
export function completeGarageAssessment(assessment) {
  const debt = garageRecoveryDebt(assessment);
  if (!assessment.qualified || !assessment.steps || Object.values(debt).some(value => !finite(value) || value > .25)
    || (assessment.recoveryAllowanceKwh ?? 0) - (assessment.recoveryAccountedKwh ?? 0) > .000001) return null;
  return { basis: 'garage-frozen-normal-reference', algorithmVersion: assessment.algorithmVersion,
    profitCents: assessment.referenceCostCents - assessment.actualCostCents,
    uncertaintyCents: assessment.uncertaintyCents, referenceCostCents: assessment.referenceCostCents,
    actualCostCents: assessment.actualCostCents, includesGarageOnly: true, sourceScope: 'dedicated-garage',
    provisional: true, residualDebt: debt, coveredMs: assessment.coveredMs,
    electricityBasis: assessment.recordedMs === assessment.coveredMs ? 'qualified-recorded-electricity'
      : assessment.recordedMs ? 'recorded-and-modeled-electricity' : 'modeled-native-electricity',
    serviceBasis: 'both external locations recovered within 0.25 C of frozen normal reference; runtime requires sustained normal heating and pipe reserve recovery',
    recoveryEnergyBasis: 'observed-electricity-when-qualified-otherwise-fixed-recovery-allowance',
    stage: 'completed', selectionBasis: 'cycles-completed-in-range' };
}
