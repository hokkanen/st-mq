/** Bounded, chronological empirical learning. These estimates are not metered savings. */
import { fireplaceAffectsLearning } from '../domain/fireplace.js';
export const MAX_SAMPLES = 768;
const HOUR = 3_600_000;
const finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

export function goodQuality(quality) {
  const flags = Array.isArray(quality) ? quality : quality ? [quality] : [];
  return flags.every(flag => ['good', 'simulated', 'historical', 'corrected_price', 'converted_fahrenheit', 'requested_not_observed'].includes(flag));
}

function validReference(reference) {
  return reference?.version === 3 && finite(reference.targetC) && reference.targetC >= 12 && reference.targetC <= 28
    && ['sustained-cool-weather-proxy', 'verified-space-heating-activity'].includes(reference.heatingEvidence?.kind)
    && finite(instant(reference.establishedAt)) && finite(instant(reference.updatedAt));
}

function heatingEvidence(samples) {
  let totalHours = 0, outdoorDegreeHours = 0, gapDegreeHours = 0;
  let verifiedHours = 0, activeHours = 0;
  const activeTimes = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const previous = samples[i], next = samples[i + 1];
    // Completed windows describe the interval ending at their timestamp.
    // Direct thermometer observations describe the interval starting there.
    const sample = next.windowStart === instant(previous.timestamp) ? next : previous;
    const hours = (instant(next.timestamp) - instant(previous.timestamp)) / HOUR;
    totalHours += hours;
    outdoorDegreeHours += sample.outdoorC * hours;
    gapDegreeHours += (sample.indoorC - sample.outdoorC) * hours;
    const heating = sample.heating;
    if (heating?.verified === true && typeof heating.compressorActive === 'boolean'
      && ['space-heating', 'dhw', 'idle'].includes(heating.route) && goodQuality(heating.quality)) {
      verifiedHours += hours;
      const measuredDuty = sample.thermalCompressorDuty ?? heating.compressorDuty
        ?? sample.compressorDuty;
      const duty = finite(measuredDuty) ? Math.min(1, Math.max(0, measuredDuty))
        : sample.windowStart !== undefined || sample.inputSegments ? 0 : Number(heating.compressorActive);
      if (duty > 0 && heating.route === 'space-heating') {
        activeHours += hours * duty;
        activeTimes.push(instant(sample.timestamp));
      }
    }
  }
  const summary = { hours: totalHours, meanOutdoorC: outdoorDegreeHours / totalHours,
    meanIndoorOutdoorGapC: gapDegreeHours / totalHours, verifiedHours, spaceHeatingHours: activeHours };
  if (verifiedHours >= 6) {
    // Repeated space heating is useful evidence; compressor activity routed to DHW is not.
    if (activeHours >= 2 && activeTimes.at(-1) - activeTimes[0] >= 6 * HOUR)
      return { ...summary, kind: 'verified-space-heating-activity' };
    return null;
  }
  // In the absence of plant telemetry this is only a provisional heating-demand proxy.
  // Sustained cool weather excludes warm nights/daytime solar plateaus without requiring a meter.
  if (samples.every(sample => sample.outdoorC <= 15 && sample.indoorC - sample.outdoorC >= 8)
    && summary.meanOutdoorC <= 10 && summary.meanIndoorOutdoorGapC >= 10)
    return { ...summary, kind: 'sustained-cool-weather-proxy' };
  return null;
}

const normalReferenceSample = sample => validSample(sample) && sample.action === 'normal'
  && sample.regime === 'occupied' && sample.preheat !== true && sample.recovering !== true
  && !(sample.roomBoostC > 0) && !fireplaceAffectsLearning(sample)
  && (!sample.inputSegments || sample.inputSegments.every(segment => segment.phase === 'normal'
    && segment.regime === 'occupied' && !(segment.roomBoostC > 0)));

function validAdaptation(value) {
  return value && ['candidateC', 'minimumC', 'maximumC', 'evidenceHours', 'appliedHours'].every(key => finite(value[key]))
    && value.minimumC >= 12 && value.maximumC <= 28 && value.maximumC - value.minimumC <= 0.300000001
    && value.candidateC >= value.minimumC && value.candidateC <= value.maximumC
    && value.evidenceHours >= 0 && value.appliedHours >= 0 && value.appliedHours <= value.evidenceHours
    && finite(instant(value.firstWindowStart)) && finite(instant(value.lastWindowEnd))
    && instant(value.lastWindowEnd) >= instant(value.firstWindowStart);
}

/** Learn achieved household temperature; normal controller cycles never redefine it.
 * Later knob changes require repeated clean plateaus across days in either direction.
 * Only newly covered plateau time earns adjustment, independently of polling frequency.
 */
export function inferComfortReference(previous, samples, { now = Date.now() } = {}) {
  const retained = validReference(previous) ? structuredClone(previous) : null;
  const sorted = normalizedRecords(samples).filter(sample => instant(sample.timestamp) <= instant(now)).slice(-MAX_SAMPLES);
  const last = sorted.at(-1);
  if (!last || instant(now) - instant(last.timestamp) > 2 * HOUR) return retained;
  if (retained?.adaptation && (!validAdaptation(retained.adaptation)
    || sorted.some(sample => instant(sample.timestamp) > instant(retained.adaptation.lastWindowEnd)
      && (!validSample(sample) || sample.regime !== 'occupied' || fireplaceAffectsLearning(sample)))))
    retained.adaptation = null;
  const normalHours = retained ? 8 : 24, plateauHours = retained ? 6 : 12;
  const uninterrupted = [];
  let nextTime = instant(last.timestamp);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const sample = sorted[i], time = instant(sample.timestamp);
    if (!normalReferenceSample(sample) || nextTime - time > 2 * HOUR) break;
    uninterrupted.unshift(sample);
    nextTime = time;
    if (instant(last.timestamp) - time >= normalHours * HOUR) break;
  }
  if (uninterrupted.length < normalHours / 2 + 1
    || instant(last.timestamp) - instant(uninterrupted[0].timestamp) < normalHours * HOUR) return retained;
  const plateau = uninterrupted.filter(sample => instant(last.timestamp) - instant(sample.timestamp) <= plateauHours * HOUR);
  const values = plateau.map(sample => sample.indoorC).sort((a, b) => a - b);
  if (plateau.length < plateauHours / 2 + 1 || values.at(-1) - values[0] > 0.4) return retained;
  const midpoint = Math.floor(plateau.length / 2);
  if (Math.abs(mean(plateau.slice(0, midpoint).map(sample => sample.indoorC))
    - mean(plateau.slice(midpoint).map(sample => sample.indoorC))) > 0.15) return retained;
  const evidence = heatingEvidence(uninterrupted);
  if (!evidence) return retained;
  const candidateC = Math.round(values[Math.floor((values.length - 1) * 0.75)] * 10) / 10;
  if (candidateC < 12 || candidateC > 28) return retained;
  let targetC = candidateC, adaptation = null;
  if (retained) {
    // Do not reuse evidence from initial establishment, duplicate windows, a
    // long acquisition interruption, or a materially different new plateau.
    const end = instant(last.timestamp), start = Math.max(instant(plateau[0].timestamp), instant(retained.establishedAt));
    if (end <= start) return retained;
    const old = validAdaptation(retained.adaptation) ? retained.adaptation : null;
    if (old && end <= instant(old.lastWindowEnd)) return retained;
    const minimumC = Math.min(old?.minimumC ?? candidateC, candidateC), maximumC = Math.max(old?.maximumC ?? candidateC, candidateC);
    const continuing = old && end - instant(old.lastWindowEnd) <= 48 * HOUR && maximumC - minimumC <= 0.300000001;
    const from = continuing ? Math.max(start, instant(old.lastWindowEnd)) : start;
    adaptation = { candidateC, minimumC: continuing ? minimumC : candidateC, maximumC: continuing ? maximumC : candidateC,
      firstWindowStart: continuing ? old.firstWindowStart : new Date(start).toISOString(), lastWindowEnd: last.timestamp,
      evidenceHours: (continuing ? old.evidenceHours : 0) + Math.max(0, end - from) / HOUR,
      appliedHours: continuing ? old.appliedHours : 0 };
    targetC = retained.targetC;
    if (adaptation.evidenceHours >= 24 && end - instant(adaptation.firstWindowStart) >= 48 * HOUR) {
      const earnedHours = Math.min(24, adaptation.evidenceHours - adaptation.appliedHours);
      const difference = candidateC - targetC;
      targetC = Math.round((targetC + Math.sign(difference) * Math.min(Math.abs(difference), earnedHours * 0.2 / 24)) * 1e10) / 1e10;
      // Consume all prior credit, including any first-qualification excess.
      // Reprocessing these rows cannot turn a capped step into a sudden jump.
      adaptation.appliedHours = adaptation.evidenceHours;
    }
    if (targetC === retained.targetC) return { ...retained, adaptation };
  }
  return { version: 3, targetC, establishedAt: retained?.establishedAt ?? last.timestamp,
    updatedAt: last.timestamp, source: 'sustained-occupied-normal-temperature-plateau',
    confidence: evidence.kind === 'verified-space-heating-activity' ? 'observed-heating-baseline' : 'provisional-heating-demand-baseline',
    heatingEvidence: evidence, windowStart: uninterrupted[0].timestamp,
    windowEnd: last.timestamp, samples: uninterrupted.length, adaptation,
    semantics: 'temperature achieved by native household settings; normal request does not prove continuous compressor runtime' };
}

function validSample(sample) {
  return sample && finite(instant(sample.timestamp)) && finite(sample.indoorC)
    && sample.indoorC > 2 && sample.indoorC < 40 && finite(sample.outdoorC)
    && sample.outdoorC >= -60 && sample.outdoorC <= 50
    && ['normal', 'reduction'].includes(sample.action)
    && goodQuality(sample.quality);
}

function normalizedRecords(samples) {
  const byTime = new Map();
  for (const sample of samples) {
    const time = instant(sample?.timestamp);
    if (!finite(time)) continue;
    const timestamp = new Date(time).toISOString();
    // Preserve uncertainty as a timestamped barrier. Dropping it would invent uninterrupted history.
    const normalized = validSample(sample) ? { ...sample, timestamp }
      : { timestamp, kind: 'continuity-barrier', quality: ['invalid-observation'] };
    const prior = byTime.get(time);
    if (!prior || normalized.kind === 'continuity-barrier') byTime.set(time, normalized);
  }
  return [...byTime.values()].sort((a, b) => instant(a.timestamp) - instant(b.timestamp));
}
