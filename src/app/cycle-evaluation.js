import { advanceCycleEvaluation } from '../control/planner.js';
import { predictThermalStep, fireplaceEvidenceReady } from '../control/adaptive-learning.js';
import { fireplaceRate, fireplaceAffectsLearning } from '../domain/fireplace.js';

const HOUR = 3600000, number = Number.isFinite;
export function evaluationInputs(cycle, fireplaceEvents) {
  return { model: cycle.plan.model, initialState: cycle.plan.initialState, targetC: cycle.plan.targetC,
    config: cycle.modelConfig, occupancy: cycle.plan.occupancy, maxDropC: cycle.plan.maxDropC,
    maxRiseC: cycle.plan.maxRiseC, equipment: { ...cycle.plan.equipment, fireplaceEvents }, includeTail: false };
}
export function observedState(cycle, state, row, fireplaceEvents) {
  if (!state || row.eligible === false || ![row.outdoorC, row.thermalCompressorDuty, row.thermalAuxKw].every(number)
    || ['partial', 'unknown'].includes(row.floorOverrideMode)
    || cycle.plan.schedule.floorOverride && !['on', 'off'].includes(row.floorOverrideMode)) return null;
  const next = predictThermalStep(cycle.plan.model, state, { outdoorC: row.outdoorC,
    solarRadiationWm2: row.solarRadiationWm2, phase: row.phase, targetC: cycle.plan.targetC,
    roomBoostC: row.roomBoostC ?? 0, compressorDuty: row.thermalCompressorDuty, auxKw: row.thermalAuxKw,
    supplyC: row.supplyC, brineC: row.brineC, floorOverrideMode: row.floorOverrideMode,
    treatmentKey: row.treatmentKey, fireplaceKgPerHour: fireplaceRate(fireplaceEvents, row.start, row.end) }, (row.end-row.start)/HOUR);
  if (row.indoorEndpoint !== false && number(row.indoorC)) next.indoorC = row.indoorC;
  return { indoorC: next.indoorC, reserveC: next.reserveC, ...(next.slabC === undefined ? {} : { slabC: next.slabC }) };
}
export function advanceReference(cycle, rows, fireplaceEvents, saved = null) {
  if (!rows.length && saved === null) return null;
  if (saved?.unavailable || rows.some(row => !number(row.outdoorC) || !number(row.price)))
    return { unavailable: true };
  const value = advanceCycleEvaluation({ ...evaluationInputs(cycle, fireplaceEvents), schedule: cycle.plan.reference,
    intervals: rows, captureTrajectory: false }, saved?.continuation ?? null);
  return { continuation: value.continuation };
}
/** Rebuild a replaceable cache from committed immutable source pages. The live
 * owner runs this in its admitted read-only worker, with no writer transaction. */
export function rebuildCycleWorking(store, { id, count, fireplaceEvents = [] }) {
  const cycle = store.cycleById({ id });
  if (!cycle || cycle.observationCount !== count) throw new Error('Cycle evidence changed during reconstruction');
  let observer = { ...cycle.plan.initialState }, reference = null;
  let after = -1;
  for (;;) {
    const page = store.cycleEvidencePage({ id, after, through: count });
    if (!page) throw new Error('The selected cycle is unavailable');
    for (const row of page.rows) observer = observedState(cycle, observer, row, fireplaceEvents);
    reference = advanceReference(cycle, page.rows, fireplaceEvents, reference);
    if (page.complete) break;
    after = page.next;
  }
  return { id, count, observer, reference };
}

const recoveryTotals = (target, trajectory, observations) => {
  for (const step of trajectory) {
    const start = step.at-step.durationHours*HOUR;
    for (const observed of observations) if (observed.phase === 'recovery') {
      const hours = Math.max(0, Math.min(step.at,observed.end)-Math.max(start,observed.start))/HOUR;
      if (!hours) continue;
      target.energyKwh += (step.spaceHeatingPowerKw ?? step.powerKw)*hours;
      target.auxiliaryKwh += step.auxiliaryKw*hours;
      target.costCents += step.costCents*hours/step.durationHours
        * (step.powerKw ? (step.spaceHeatingPowerKw ?? step.powerKw)/step.powerKw : 1);
    }
  }
  return target;
};

/** All historical traversal stays here. Peak memory is one evidence page and
 * its predictor steps, independent of cycle length. No evidence is truncated. */
export function assessCycle(store, { id, count, now, fireplaceEvents = [] }) {
  const cycle = store.cycleById({ id });
  if (!cycle || cycle.observationCount !== count || cycle.status !== 'active') throw new Error('Cycle assessment became stale');
  const a = cycle.actual, schedule = cycle.executionSchedule ?? cycle.plan.schedule;
  const common = evaluationInputs(cycle, fireplaceEvents);
  let referenceState = null, calibrationState = null, predictedState = null;
  let reference, calibration, predicted = null, originalCoverage = !cycle.adjustments?.length;
  const originalRecovery = { costCents: 0, energyKwh: 0, auxiliaryKwh: 0 };
  const calibratedRecovery = { costCents: 0, energyKwh: 0, auxiliaryKwh: 0 };
  let firePresent = false, floorTreatmentComparable = true, trajectoryHours = 0, temperatureErrorHours = 0;
  let predictedMinimum = Infinity, observedMinimum = Infinity;
  const phaseSet = new Set();
  let after = -1;
  for (;;) {
    const page = store.cycleEvidencePage({ id, after, through: count });
    if (!page) throw new Error('The selected cycle is unavailable');
    const rows = page.rows;
    const intervals = rows.map(({ start, end, outdoorC, solarRadiationWm2, price }) => ({ start, end, outdoorC, solarRadiationWm2, price }));
    if (intervals.some(row => !number(row.outdoorC) || !number(row.price))) throw new Error('Cycle forecast inputs are incomplete');
    const ref = advanceCycleEvaluation({ ...common, schedule: cycle.plan.reference, intervals, captureTrajectory: false }, referenceState);
    referenceState = ref.continuation; reference = ref.result;
    const cal = advanceCycleEvaluation({ ...common, schedule, intervals }, calibrationState);
    calibrationState = cal.continuation; calibration = cal.result;
    recoveryTotals(calibratedRecovery,calibration.trajectory,rows);
    const predictionIntervals = [];
    for (const row of rows) {
      phaseSet.add(row.phase);
      firePresent ||= fireplaceAffectsLearning({ fireplaceKgPerHour: fireplaceRate(fireplaceEvents,row.start,row.end) });
      if (cycle.plan.schedule.floorOverride && (row.treatmentKey !== cycle.treatmentKey
        || row.floorOverrideMode !== (row.phase === 'preheat' ? 'on' : 'off'))) floorTreatmentComparable = false;
      if (number(row.indoorC)) observedMinimum = Math.min(observedMinimum,row.indoorC);
      const original = cycle.plan.intervals.find(value => value.start <= row.start && value.end >= row.end);
      if (!original) originalCoverage = false;
      else predictionIntervals.push({ start: row.start, end: row.end, outdoorC: original.outdoorC,
        solarRadiationWm2: original.solarRadiationWm2, price: original.price });
    }
    if (originalCoverage) {
      const value = advanceCycleEvaluation({ ...common, equipment: cycle.plan.equipment ?? {},
        schedule: cycle.plan.schedule, intervals: predictionIntervals }, predictedState);
      predictedState = value.continuation; predicted = value.result;
      recoveryTotals(originalRecovery,predicted.trajectory,rows);
      for (const step of predicted.trajectory) predictedMinimum = Math.min(predictedMinimum,step.indoorC);
      for (const row of rows) {
        const step = predicted.trajectory.find(value => value.at >= row.end && value.at-value.durationHours*HOUR < row.end);
        if (step && number(row.indoorC)) {
          const hours = (row.end-row.start)/HOUR;
          trajectoryHours += hours; temperatureErrorHours += Math.abs(step.indoorC-row.indoorC)*hours;
        }
      }
    }
    if (page.complete) break;
    after = page.next;
  }
  if (!originalCoverage) predicted = null;
  const originalRecoveryAvailable = Boolean(predicted);
  const comparableSpace = floorTreatmentComparable && a.routeMissingHours <= 0.001 && a.routeCoveredHours > 0
    && !cycle.fireplaceCorrectionRevision && (!firePresent || fireplaceEvidenceReady(cycle.plan.model));
  const phases = [...phaseSet];
      cycle.assessment = { profitCents: comparableSpace ? reference.spaceHeatingCostCents - a.spaceHeatingCostCents : null,
        wholeCycleProfitCents:null, wholeCycleProfitReason:'DHW demand, delivery and tank recovery are not counterfactually modelled.',
        referenceCostCents: reference.spaceHeatingCostCents, actualCostCents: a.costCents,
        actualSpaceHeatingCostCents:a.spaceHeatingCostCents,dhwCostCents:a.dhwCostCents,
        recoveryErrorCents: originalRecoveryAvailable && comparableSpace ? Math.abs(originalRecovery.costCents - a.spaceHeatingRecoveryCostCents) : null,
        uncertaintyCents: Math.max(5, reference.uncertaintyCents + (a.metered ? 0 : Math.abs(a.costCents) * 0.35)),
        basis: comparableSpace ? 'estimated-space-heating-execution-and-reference'
          : !floorTreatmentComparable ? 'unassessed-floor-treatment-not-confirmed'
          : cycle.fireplaceCorrectionRevision ? 'unassessed-corrected-fireplace-history'
          : firePresent && !fireplaceEvidenceReady(cycle.plan.model) ? 'unassessed-fireplace-response' : 'unassessed-missing-space-heating-attribution',
        recoveryPredictionBasis: originalRecoveryAvailable ? 'Frozen model and original forecast over the observed recovery period'
          : cycle.adjustments?.length ? 'Unavailable: executed schedule changed' : 'Unavailable: original forecast did not cover the complete cycle',
        calibrationBasis: 'Executed actions and contemporaneous weather estimates; frozen model',
        recoveryBasis: 'Comparable room temperature and reserve reconstructed with the frozen cycle model, and selected slab when configured, held for one hour; DHW service excluded',
        referenceLabel: cycle.plan.referenceLabel, assessedAt: now };
      const episode = { id: cycle.id, treatmentKey: cycle.treatmentKey ?? 'native', complete: true, recoveryComplete: true, startedAt: cycle.startedAt, endedAt: now,
        ...(cycle.plan.userTrial ? { userTrial: cycle.plan.userTrial } : {}),
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
        forecastValidation:{roomBoostC:schedule.roomBoostC??0,preheatHours:(schedule.preheatEnd-schedule.preheatStart)/HOUR,
          eligible:Boolean(predicted && comparableSpace && trajectoryHours>0),
          temperatureMaeC:trajectoryHours?temperatureErrorHours/trajectoryHours:null,
          minimumTemperatureErrorC:predicted?Math.abs(predictedMinimum-observedMinimum):null,
          energyRelativeError:predicted && a.spaceHeatingKwh>=.1?Math.abs(predicted.spaceHeatingKwh-a.spaceHeatingKwh)/a.spaceHeatingKwh:null,
          costRelativeError:predicted?Math.abs(predicted.spaceHeatingCostCents-a.spaceHeatingCostCents)/Math.max(5,Math.abs(a.spaceHeatingCostCents)):null,
          costAbsoluteErrorCents:predicted?Math.abs(predicted.spaceHeatingCostCents-a.spaceHeatingCostCents):null,
          recoveryCostErrorCents:cycle.assessment.recoveryErrorCents,
          reductionHours:(schedule.reductionEnd-schedule.reductionStart)/HOUR,
          basis:'frozen-advance-forecast',adjusted:Boolean(cycle.adjustments?.length)},
        phases: phases,
        provenance: { basis: 'committed-history', forecastAlgorithm: cycle.plan.algorithmVersion ?? 'unversioned-frozen-forecast', forecastVersion: cycle.lastForecastVersion ?? null } };
      if (!floorTreatmentComparable
        || cycle.fireplaceCorrectionRevision || firePresent && !fireplaceEvidenceReady(cycle.plan.model)) {
        // Keep the attempt and actual observations, without letting assumed wood
        // heat calibrate recovery energy or certify advance control performance.
        episode.complete = false;
        episode.responseComplete = true;
      }

  return { assessment: cycle.assessment, episode };
}
