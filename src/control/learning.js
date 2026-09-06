/** Bounded, chronological empirical learning. These estimates are not metered savings. */
export const CHECKPOINT_VERSION = 2;
export const MAX_SAMPLES = 768;
const HOUR = 3_600_000;
const finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

export function goodQuality(quality) {
  const flags = Array.isArray(quality) ? quality : quality ? [quality] : [];
  return flags.every(flag => ['good', 'simulated', 'historical', 'corrected_price', 'converted_fahrenheit'].includes(flag));
}

export function emptyCheckpoint() {
  return { version: CHECKPOINT_VERSION, processedThrough: null, samples: [], model: null,
    previousModel: null, thermalState: null, comfortReference: null,
    health: { status: 'collecting', accepted: 0, rejected: 0 } };
}

function validReference(reference) {
  return reference?.version === 2 && finite(reference.targetC) && reference.targetC >= 12 && reference.targetC <= 28
    && ['sustained-cool-weather-proxy', 'verified-space-heating-activity'].includes(reference.heatingEvidence?.kind)
    && finite(instant(reference.establishedAt)) && finite(instant(reference.updatedAt));
}

function heatingEvidence(samples) {
  let totalHours = 0, outdoorDegreeHours = 0, gapDegreeHours = 0;
  let verifiedHours = 0, activeHours = 0;
  const activeTimes = [];
  for (let i = 0; i < samples.length - 1; i++) {
    const sample = samples[i], hours = (instant(samples[i + 1].timestamp) - instant(sample.timestamp)) / HOUR;
    totalHours += hours;
    outdoorDegreeHours += sample.outdoorC * hours;
    gapDegreeHours += (sample.indoorC - sample.outdoorC) * hours;
    const heating = sample.heating;
    if (heating?.verified === true && typeof heating.compressorActive === 'boolean'
      && ['space-heating', 'dhw', 'idle'].includes(heating.route) && goodQuality(heating.quality)) {
      verifiedHours += hours;
      if (heating.compressorActive && heating.route === 'space-heating') {
        activeHours += hours;
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

/** Infer the room temperature produced by household knobs under sustained normal mode.
 * A stored reference never follows a falling temperature. Deliberate knob changes can reset it explicitly.
 */
export function inferComfortReference(previous, samples, { now = Date.now() } = {}) {
  const retained = validReference(previous) ? structuredClone(previous) : null;
  const sorted = samples.filter(sample => sample && finite(instant(sample.timestamp)) && instant(sample.timestamp) <= instant(now))
    .sort((a, b) => instant(a.timestamp) - instant(b.timestamp)).slice(-MAX_SAMPLES);
  const last = sorted.at(-1);
  if (!last || instant(now) - instant(last.timestamp) > 2 * HOUR) return retained;
  const uninterrupted = [];
  let nextTime = instant(last.timestamp);
  for (let i = sorted.length - 1; i >= 0; i--) {
    const sample = sorted[i], time = instant(sample.timestamp);
    if (!validSample(sample) || sample.action !== 'normal' || sample.regime !== 'occupied' || sample.preheat === true
      || sample.recovering === true || nextTime - time > 2 * HOUR) break;
    uninterrupted.unshift(sample);
    nextTime = time;
    if (instant(last.timestamp) - time >= 24 * HOUR) break;
  }
  if (uninterrupted.length < 13 || instant(last.timestamp) - instant(uninterrupted[0].timestamp) < 24 * HOUR) return retained;
  const plateau = uninterrupted.filter(sample => instant(last.timestamp) - instant(sample.timestamp) <= 12 * HOUR);
  const values = plateau.map(sample => sample.indoorC).sort((a, b) => a - b);
  if (plateau.length < 7 || values.at(-1) - values[0] > 0.4) return retained;
  const midpoint = Math.floor(plateau.length / 2);
  if (Math.abs(mean(plateau.slice(0, midpoint).map(sample => sample.indoorC))
    - mean(plateau.slice(midpoint).map(sample => sample.indoorC))) > 0.15) return retained;
  const evidence = heatingEvidence(uninterrupted);
  if (!evidence) return retained;
  const targetC = Math.round(values[Math.floor((values.length - 1) * 0.75)] * 10) / 10;
  if (targetC < 12 || targetC > 28 || (retained && targetC <= retained.targetC + 0.1)) return retained;
  return { version: 2, targetC, establishedAt: retained?.establishedAt ?? last.timestamp,
    updatedAt: last.timestamp, source: 'sustained-occupied-normal-temperature-plateau',
    confidence: evidence.kind === 'verified-space-heating-activity' ? 'observed-heating-baseline' : 'provisional-heating-demand-baseline',
    heatingEvidence: evidence, windowStart: uninterrupted[0].timestamp,
    windowEnd: last.timestamp, samples: uninterrupted.length,
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

export function validateModel(model) {
  const p = model?.parameters;
  const v = model?.validation;
  if (!p || !v || model.version !== 1 || !finite(instant(model.trainedAt))) return false;
  return finite(p.lossPerHour) && p.lossPerHour > 0 && p.lossPerHour <= 0.2
    && finite(p.normalHeatCPerHour) && p.normalHeatCPerHour > 0 && p.normalHeatCPerHour <= 6
    && finite(p.reducedHeatCPerHour) && p.reducedHeatCPerHour >= 0
    && p.reducedHeatCPerHour < p.normalHeatCPerHour
    && finite(p.recoveryDegreeHoursPerHour) && p.recoveryDegreeHoursPerHour > 0
    && p.recoveryDegreeHoursPerHour <= 3
    && finite(p.uncertaintyCPerHour) && p.uncertaintyCPerHour >= 0.01 && p.uncertaintyCPerHour <= 1
    && finite(v.maeCPerHour) && v.maeCPerHour >= 0 && v.maeCPerHour <= 0.25
    && v.samples >= 12 && v.chronological === true && v.accepted === true;
}

function validEnergy(energy) {
  return energy?.verifiedMeter === true && energy.samples >= 24
    && finite(energy.normalKw) && energy.normalKw > 0 && energy.normalKw <= 20
    && finite(energy.reductionKw) && energy.reductionKw >= 0 && energy.reductionKw <= energy.normalKw
    && finite(energy.auxiliaryKw) && energy.auxiliaryKw >= 0 && energy.auxiliaryKw <= 20
    && finite(energy.recoveryMultiplier) && energy.recoveryMultiplier >= 1 && energy.recoveryMultiplier <= 4
    && finite(energy.relativeUncertainty) && energy.relativeUncertainty >= 0.05 && energy.relativeUncertainty <= 1;
}

export function hasValidatedEnergy(model) { return validEnergy(model?.energy); }

/** A corrupt checkpoint never delays normal operation. Model parameters and thermal state age separately. */
export function restoreCheckpoint(input, { now = Date.now(), thermalMaxAgeMs = HOUR } = {}) {
  if (input == null) return emptyCheckpoint();
  let checkpoint;
  try { checkpoint = typeof input === 'string' ? JSON.parse(input) : structuredClone(input); }
  catch { return { ...emptyCheckpoint(), health: { status: 'rebuilding', reason: 'corrupt-checkpoint' } }; }
  if (!checkpoint || checkpoint.version !== CHECKPOINT_VERSION || !Array.isArray(checkpoint.samples)) {
    return { ...emptyCheckpoint(), health: { status: 'rebuilding', reason: 'incompatible-checkpoint' } };
  }
  checkpoint.samples = normalizedRecords(checkpoint.samples).slice(-MAX_SAMPLES);
  if (!validReference(checkpoint.comfortReference)) checkpoint.comfortReference = null;
  if (checkpoint.model !== null && !validateModel(checkpoint.model)) {
    const fallback = validateModel(checkpoint.previousModel) ? checkpoint.previousModel : null;
    checkpoint.model = fallback;
    checkpoint.health = { status: fallback ? 'rolled-back' : 'rebuilding', reason: 'invalid-model' };
  }
  if (!finite(instant(checkpoint.processedThrough))) checkpoint.processedThrough = null;
  const stateAge = instant(now) - instant(checkpoint.thermalState?.observedAt);
  if (!checkpoint.thermalState || !finite(stateAge) || stateAge < 0 || stateAge > thermalMaxAgeMs
    || !finite(checkpoint.thermalState.indoorC)) checkpoint.thermalState = null;
  return checkpoint;
}

function solve(matrix, rhs) {
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-8) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const scale = a[i][i];
    for (let k = i; k < 4; k++) a[i][k] /= scale;
    for (let j = 0; j < 3; j++) if (j !== i) {
      const factor = a[j][i];
      for (let k = i; k < 4; k++) a[j][k] -= factor * a[i][k];
    }
  }
  return a.map(row => row[3]);
}

function transitions(samples) {
  const rows = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const duration = (instant(b.timestamp) - instant(a.timestamp)) / HOUR;
    // An action at a is a requested tariff mode, never a compressor-runtime label.
    if (!validSample(a) || !validSample(b) || duration < 1 / 12 || duration > 2 || a.regime !== 'occupied' || b.regime !== 'occupied') continue;
    const y = (b.indoorC - a.indoorC) / duration;
    if (Math.abs(y) > 2) continue;
    rows.push({ x: [a.outdoorC - a.indoorC, Number(a.action === 'normal'), Number(a.action === 'reduction')],
      y, start: a.timestamp, end: b.timestamp, action: a.action, sample: a });
  }
  return rows;
}

function predict(parameters, row) {
  return parameters.lossPerHour * row.x[0] + parameters.normalHeatCPerHour * row.x[1]
    + parameters.reducedHeatCPerHour * row.x[2];
}

function fitEnergy(rows) {
  const usable = rows.map(row => row.sample).filter(sample => sample.energyVerified === true
    && finite(sample.heatPumpElectricKw) && sample.heatPumpElectricKw >= 0 && sample.heatPumpElectricKw <= 20
    && finite(sample.auxiliaryElectricKw) && sample.auxiliaryElectricKw >= 0 && sample.auxiliaryElectricKw <= 20);
  const normal = usable.filter(sample => sample.action === 'normal');
  const reduction = usable.filter(sample => sample.action === 'reduction');
  if (usable.length < 24 || normal.length < 8 || reduction.length < 8) return null;
  const normalKw = mean(normal.map(sample => sample.heatPumpElectricKw));
  const reductionKw = mean(reduction.map(sample => sample.heatPumpElectricKw));
  const auxiliaryKw = mean(usable.map(sample => sample.auxiliaryElectricKw));
  // A conservative provisional recovery allowance is explicit, not learned from no auxiliary events.
  const energy = { verifiedMeter: true, samples: usable.length, normalKw, reductionKw, auxiliaryKw,
    recoveryMultiplier: 1.5, relativeUncertainty: 0.3,
    provenance: 'verified heat-pump meter only; provisional recovery allowance; auxiliary causes unresolved' };
  return validEnergy(energy) ? energy : null;
}

export function fitModel(samples, previousModel = null) {
  if (!Array.isArray(samples) || samples.some((sample, i) => !finite(instant(sample?.timestamp))
    || (i > 0 && instant(sample.timestamp) <= instant(samples[i - 1].timestamp))))
    return { accepted: false, reason: 'nonchronological-input' };
  const rows = transitions(samples);
  if (rows.length < 48) return { accepted: false, reason: 'insufficient-transitions' };
  const split = Math.floor(rows.length * 0.7);
  const training = rows.slice(0, split);
  // A full-day embargo reduces leakage from nearby observations and short recovery episodes.
  // Multi-day slab-memory effects still need separate trajectory validation.
  const validation = rows.slice(split).filter(row => instant(row.start) >= instant(training.at(-1).end) + 24 * HOUR);
  if (validation.length < 12) return { accepted: false, reason: 'insufficient-validation-window' };
  if (['normal', 'reduction'].some(action => training.filter(row => row.action === action).length < 8
    || validation.filter(row => row.action === action).length < 4)) return { accepted: false, reason: 'insufficient-action-coverage' };
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]), rhs = [0, 0, 0];
  for (const row of training) for (let i = 0; i < 3; i++) {
    rhs[i] += row.x[i] * row.y;
    for (let j = 0; j < 3; j++) matrix[i][j] += row.x[i] * row.x[j];
  }
  const coefficients = solve(matrix, rhs);
  if (!coefficients) return { accepted: false, reason: 'unidentifiable-model' };
  const parameters = { lossPerHour: coefficients[0], normalHeatCPerHour: coefficients[1],
    reducedHeatCPerHour: Math.max(0, coefficients[2]), recoveryDegreeHoursPerHour: 0.25,
    uncertaintyCPerHour: 0.01 };
  const mae = mean(validation.map(row => Math.abs(row.y - predict(parameters, row))));
  const persistenceMae = mean(validation.map(row => Math.abs(row.y)));
  const previousMae = validateModel(previousModel)
    ? mean(validation.map(row => Math.abs(row.y - predict(previousModel.parameters, row)))) : Infinity;
  parameters.uncertaintyCPerHour = Math.max(0.03, Math.min(1, mae * 2));
  const model = { version: 1, trainedAt: rows.at(-1).end, parameters,
    energy: fitEnergy(training), validation: { chronological: true, accepted: true, samples: validation.length,
      trainThrough: training.at(-1).end, validateFrom: validation[0].start, embargoHours: 24, maeCPerHour: mae,
      persistenceMaeCPerHour: persistenceMae, previousMaeCPerHour: finite(previousMae) ? previousMae : null },
    provenance: { method: 'bounded chronological three-coefficient temperature regression',
      samples: rows.length, start: rows[0].start, end: rows.at(-1).end,
      recovery: 'conservative provisional reserve model; not a measured effective slab capacity' } };
  if (!validateModel(model) || coefficients[2] < -0.03) return { accepted: false, reason: 'implausible-model' };
  if (mae > persistenceMae * 0.95 + 0.005 || mae > previousMae * 1.05 + 0.005)
    return { accepted: false, reason: 'holdout-degraded', validation: { ...model.validation, accepted: false } };
  return { accepted: true, model };
}

/** Call with a bounded page (<=512 rows). Persist returned checkpoint atomically in the application. */
export function updateLearning(input, incoming, { now = Date.now(), maxBatch = 512 } = {}) {
  if (!Array.isArray(incoming) || incoming.length > Math.min(512, maxBatch)) throw new RangeError('Learning requires a bounded batch of at most 512 rows');
  const checkpoint = restoreCheckpoint(input ?? emptyCheckpoint(), { now });
  const last = checkpoint.processedThrough === null ? -Infinity : instant(checkpoint.processedThrough);
  const samples = normalizedRecords(incoming).filter(sample => instant(sample.timestamp) > last && instant(sample.timestamp) <= instant(now));
  const seen = new Set(checkpoint.samples.map(sample => instant(sample.timestamp)));
  for (const sample of samples) if (!seen.has(instant(sample.timestamp))) {
    checkpoint.samples.push({ ...sample, timestamp: new Date(instant(sample.timestamp)).toISOString() });
    seen.add(instant(sample.timestamp));
  }
  checkpoint.samples = checkpoint.samples.slice(-MAX_SAMPLES);
  checkpoint.comfortReference = inferComfortReference(checkpoint.comfortReference, checkpoint.samples, { now });
  if (samples.length) {
    const lastSample = checkpoint.samples.at(-1);
    checkpoint.processedThrough = lastSample.timestamp;
    checkpoint.thermalState = validSample(lastSample) ? { observedAt: lastSample.timestamp, indoorC: lastSample.indoorC } : null;
  }
  // Refit only after a modest batch has accrued; ingestion and command work can continue between pages.
  const sinceFit = (checkpoint.samplesSinceFit ?? 0) + samples.length;
  checkpoint.samplesSinceFit = sinceFit;
  if (sinceFit < 24) return checkpoint;
  checkpoint.samplesSinceFit = 0;
  const result = fitModel(checkpoint.samples, checkpoint.model);
  const counts = { accepted: checkpoint.health?.accepted ?? 0, rejected: checkpoint.health?.rejected ?? 0 };
  if (result.accepted) {
    checkpoint.previousModel = checkpoint.model;
    checkpoint.model = result.model;
    checkpoint.health = { status: hasValidatedEnergy(result.model) ? 'validated-estimates' : 'thermal-only',
      ...counts, accepted: counts.accepted + 1, updatedAt: new Date(instant(now)).toISOString() };
  } else checkpoint.health = { status: checkpoint.model ? 'retained-previous' : 'collecting', ...counts,
    rejected: counts.rejected + 1, reason: result.reason, validation: result.validation ?? null };
  return checkpoint;
}
