import { predictGarageStep, GARAGE_ALGORITHM_VERSION } from './model.js';

const HOUR = 3_600_000, finite = Number.isFinite;
/** Compact frozen counterfactual accounting, separate from dispatch's pure timing
 * objective. Both branches receive the same observed weather and EV assumptions. */
export function startGarageAssessment(model, observation) {
  const initial = { ...model.state, rearC: observation.rearC, frontC: observation.frontC,
    differenceC: observation.frontC - observation.rearC };
  return { algorithmVersion: GARAGE_ALGORITHM_VERSION, at: observation.at, previous: structuredClone(observation),
    actualState: structuredClone(initial), referenceState: structuredClone(initial),
    actualCostCents: 0, referenceCostCents: 0, actualKwh: 0, referenceKwh: 0, uncertaintyCents: 0,
    coveredMs: 0, missingMs: 0, recordedMs: 0, steps: 0, qualified: true, provisional: true };
}
export function updateGarageAssessment(previous, model, observation, { recordedKwh = null, priceCtPerKwh = null, priceSegments = null } = {}) {
  const next = structuredClone(previous), duration = observation.at - next.at;
  if (duration <= 0) return next;
  const actual = next.previous;
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
      const energy = finite(recordedKwh) && recordedKwh >= 0 ? recordedKwh * (segment.end - segment.start) / duration : execution.electricityKwh;
      next.actualKwh += energy; next.referenceKwh += reference.electricityKwh;
      next.actualCostCents += energy * segment.priceCtPerKwh;
      next.referenceCostCents += reference.electricityKwh * segment.priceCtPerKwh;
      next.uncertaintyCents += (reference.uncertaintyKwh + (finite(recordedKwh) ? 0 : execution.uncertaintyKwh)) * Math.abs(segment.priceCtPerKwh);
      next.referenceState = reference.state; next.actualState = execution.state;
    }
    // Actual external sensors anchor local air; slow memory remains a modeled
    // state. A rear recovery cannot conceal a still-cold front.
    next.actualState = { ...next.actualState,
      ...(finite(observation.rearC) ? { rearC: observation.rearC } : {}),
      ...(finite(observation.frontC) ? { frontC: observation.frontC } : {}),
      ...(finite(observation.frontC) && finite(observation.rearC) ? { differenceC: observation.frontC - observation.rearC } : {}) };
    next.coveredMs += duration; if (finite(recordedKwh)) next.recordedMs += duration; next.steps++;
  }
  next.at = observation.at; next.previous = structuredClone(observation);
  return next;
}
export function garageRecoveryDebt(assessment) {
  return Object.fromEntries(['rearC', 'frontC', 'coreC'].map(key => [key,
    finite(assessment?.referenceState?.[key]) && finite(assessment?.actualState?.[key])
      ? Math.max(0, assessment.referenceState[key] - assessment.actualState[key]) : null]));
}
export function completeGarageAssessment(assessment) {
  const debt = garageRecoveryDebt(assessment);
  if (!assessment.qualified || !assessment.steps || Object.values(debt).some(value => !finite(value) || value > .25)) return null;
  return { basis: 'garage-frozen-normal-reference', algorithmVersion: assessment.algorithmVersion,
    profitCents: assessment.referenceCostCents - assessment.actualCostCents,
    uncertaintyCents: assessment.uncertaintyCents, referenceCostCents: assessment.referenceCostCents,
    actualCostCents: assessment.actualCostCents, includesGarageOnly: true, sourceScope: 'dedicated-garage',
    provisional: true, residualDebt: debt, coveredMs: assessment.coveredMs,
    electricityBasis: assessment.recordedMs === assessment.coveredMs ? 'qualified-recorded-electricity'
      : assessment.recordedMs ? 'recorded-and-modeled-electricity' : 'modeled-native-electricity',
    serviceBasis: 'both external locations and estimated building memory recovered within 0.25 C of frozen normal reference',
    stage: 'completed', selectionBasis: 'cycles-completed-in-range' };
}
