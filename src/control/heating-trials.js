import { fireplaceAffectsLearning } from '../domain/fireplace.js';

const HOUR = 3_600_000;
const finite = Number.isFinite;
const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;

/** A covered Normal suffix after recovery, reconstructed from committed inputs.
 * Compressor-off and DHW operation are normal service and may count. */
export function normalOperationHours(samples, now, after) {
  const spans = samples.slice(-12).flatMap(sample => {
    const at = typeof sample.timestamp === 'number' ? sample.timestamp : Date.parse(sample.timestamp);
    if (!finite(at) || at > now || !finite(sample.indoorC) || sample.indoorEstimated || sample.valid === false) return [];
    return (sample.inputSegments ?? []).filter(row => row.phase === 'normal' && !row.episodeId
      && !(row.quality ?? []).length && finite(row.outdoorC) && finite(row.powerKw))
      .map(row => ({ start: Math.max(row.start, after, now - HOUR), end: Math.min(row.end, now) }))
      .filter(row => row.end > row.start);
  }).sort((a, b) => b.end - a.end);
  let start = now;
  for (const row of spans) {
    if (row.end < start) break;
    start = Math.min(start, row.start);
  }
  return (now - start) / HOUR;
}

export function automaticTrialBlock(config, equipment) {
  if ((equipment.learningTrialsToday ?? 0) >= config.learningTrialTargetPerDay)
    return 'daily-learning-trial-target-reached';
  return equipment.learningTrialNormalReady === false ? 'learning-trial-needs-normal-hour' : null;
}

/** A bounded planning summary of committed Normal inputs, never new training
 * evidence. DHW, gaps, interventions and significant wood heat break cycles. */
export function heatingDemandHistory(samples = [], now) {
  const from = now - 48 * HOUR, spans = [];
  let coveredHours = 0, runHours = 0, gapHours = 0, observedThrough = null, segments = 0,
    auxiliaryHours=0,auxiliaryKwh=0;
  for (const sample of samples.slice(-194)) {
    const timestamp = typeof sample.timestamp === 'number' ? sample.timestamp : Date.parse(sample.timestamp);
    if (!finite(timestamp) || timestamp > now || timestamp <= from) continue;
    for (const row of sample.inputSegments ?? []) {
      if (++segments > 8192) return null;
      const start = Math.max(from, row.start), end = Math.min(now, row.end);
      if (!(end > start) || row.phase !== 'normal' || row.auxRoute !== 'space'
        || ![0, 1].includes(row.compressorDuty) || !finite(row.outdoorC) || !finite(sample.indoorC)
        || (row.quality ?? []).length || fireplaceAffectsLearning(row)) continue;
      const previous = spans.at(-1);
      if (previous && start < previous.end) continue;
      const hours = (end - start) / HOUR;
      coveredHours += hours; runHours += row.compressorDuty * hours;
      if(row.auxiliaryObserved===true&&finite(row.thermalAuxKw)&&row.thermalAuxKw>=0&&row.thermalAuxKw<=20){
        auxiliaryHours+=hours;auxiliaryKwh+=row.thermalAuxKw*hours;
      }
      gapHours += Math.max(0, sample.indoorC - row.outdoorC) * hours;
      observedThrough = end;
      if (previous && start === previous.end && row.compressorDuty === previous.duty) previous.end = end;
      else spans.push({ start, end, duty: row.compressorDuty });
    }
  }
  if (!(coveredHours > 0)) return null;
  const runs = [], cycles = [];
  for (let i = 1; i < spans.length - 1; i++) {
    const row = spans[i], before = spans[i - 1], after = spans[i + 1];
    if (row.duty !== 1 || before.duty !== 0 || after.duty !== 0
      || before.end !== row.start || row.end !== after.start) continue;
    runs.push((row.end - row.start) / HOUR);
    if (i > 1 && spans[i - 2].duty === 1 && spans[i - 2].end === before.start)
      cycles.push((row.end - before.start) / HOUR);
  }
  return { observedThrough, coveredHours, duty: runHours / coveredHours,
    normalAuxiliaryKw:auxiliaryHours>0?auxiliaryKwh/auxiliaryHours:null,auxiliaryCoveredHours:auxiliaryHours,
    indoorOutdoorGapC: gapHours / coveredHours, cycles: cycles.length,
    runHours: median(runs), cycleHours: median(cycles),
    basis: 'Recorded Normal space-heating coverage; DHW and gaps excluded.' };
}

/** Select windows that can contain heating, rather than treating elapsed wall
 * time as an experiment. Weather scaling is a planning estimate, not a new fit. */
export function trialOpportunity({ schedule, baseline, equipment = {}, initialState, intervals }) {
  const hours = (schedule.reductionEnd - schedule.reductionStart) / HOUR;
  const rows = baseline.trajectory.filter(row => row.at > schedule.reductionStart
    && row.at - row.durationHours * HOUR < schedule.reductionEnd);
  const observed = equipment.heatingDemand;
  const recent = observed && finite(observed.observedThrough) && observed.observedThrough <= intervals[0].start
    && intervals[0].start - observed.observedThrough <= 2 * HOUR;
  const weather = intervals.filter(row => row.end > schedule.reductionStart && row.start < schedule.reductionEnd);
  const gap = weather.reduce((sum, row) => sum + Math.max(0, initialState.indoorC - row.outdoorC)
    * (Math.min(row.end, schedule.reductionEnd) - Math.max(row.start, schedule.reductionStart)) / HOUR, 0) / hours;
  const forecastRunHours = rows.reduce((sum, row) => sum + row.compressorDuty
    * Math.max(0, Math.min(row.at, schedule.reductionEnd)
      - Math.max(row.at - row.durationHours * HOUR, schedule.reductionStart)) / HOUR, 0);
  const duty = recent && observed.indoorOutdoorGapC > 0
    ? Math.min(1, observed.duty * gap / observed.indoorOutdoorGapC) : forecastRunHours / hours;
  const requiredRunHours = recent && observed.cycles >= 3 && observed.runHours > 0 ? observed.runHours : .25;
  const running = equipment.compressorOn === 1 && equipment.dhwRouting === 0;
  // Starting during an observed run can expose its remaining response. Otherwise
  // span a representative demand cycle, adjusted for forecast heat loss.
  const minimumHours = running ? requiredRunHours : duty > 0 ? requiredRunHours / duty : Infinity;
  const expectedRunHours = Math.max(forecastRunHours, hours * duty);
  return { useful: hours + 1e-9 >= minimumHours && expectedRunHours + 1e-9 >= requiredRunHours,
    minimumHours: finite(minimumHours) ? minimumHours : null, requiredRunHours, expectedRunHours,
    basis: recent ? 'Recorded space-heating cycles adjusted for forecast indoor/outdoor difference.'
      : 'Unvalidated Normal-demand forecast; no recent qualified cycle history.' };
}

/** Forecast contrast only: useful experiment selection, never acquired evidence. */
export function trialInformation({schedule,prediction,baseline,opportunity,noiseC}) {
  const reference=new Map(baseline.trajectory.map(row=>[row.at,row]));
  let signalC=0,dutyContrastHours=0;
  for(const row of prediction.trajectory){
    const normal=reference.get(row.at);if(!normal)continue;
    if(row.at<=schedule.reductionEnd+6*HOUR)signalC=Math.max(signalC,Math.abs(row.indoorC-normal.indoorC));
    if(row.at>schedule.preheatStart&&row.at<=schedule.reductionEnd)
      dutyContrastHours+=Math.abs(row.compressorDuty-normal.compressorDuty)*row.durationHours;
  }
  return {signalC,dutyContrastHours,score:signalC/Math.max(.1,noiseC)
    +dutyContrastHours/Math.max(.05,opportunity.requiredRunHours),
    basis:'Predicted thermal and compressor contrast; not observed information gain or validated treatment response.'};
}
