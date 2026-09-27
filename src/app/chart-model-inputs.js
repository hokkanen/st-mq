import { MODEL_INPUT_INFO } from '../domain/history-series.js';
import { FIREPLACE_INPUT_NAMES } from './chart-fireplace.js';
import { goodQuality } from '../control/learning.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { LEARNING_ALGORITHM, assertCurrentLearningSample } from './committed-learning.js';

const WINDOW = 15 * 60_000;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const finite = Number.isFinite;
const sources = { simulated: 'Simulation', history: 'Imported history', mqtt: 'Recorded MQTT inputs', providers: 'Recorded provider inputs' };
const fields = {
  model_outdoor_temperature: 'outdoorC', model_solar_radiation: 'solarRadiationWm2',
  model_compressor_duty: 'thermalCompressorDuty', model_auxiliary_power: 'thermalAuxKw',
  model_hydronic_heat: 'hydronicHeatKw', model_valve_override: 'floorOverrideMode',
  model_room_boost: 'roomBoostC', model_target_temperature: 'targetC',
};

function indoorEndpointMetadata(sample, usable) {
  const sensors = INDOOR_SIGNALS.flatMap(signal => {
    const sensor = sample.indoorSensors?.[signal];
    if (!sensor || !Number.isFinite(sensor.observedAt) || !sensor.held && !sensor.needsAttention) return [];
    const reasons = Array.isArray(sensor.attentionReasons)
      ? [...new Set(sensor.attentionReasons.filter(reason => ['old-reading', 'disconnected', 'invalid-reading', 'missing-report'].includes(reason)))] : [];
    return [{ signal, observedAt: sensor.observedAt, reasons }];
  });
  return { savedIndoorAverage: true, learningUsable: usable,
    held: INDOOR_SIGNALS.some(signal => sample.indoorSensors?.[signal]?.held === true),
    needsAttention: INDOOR_SIGNALS.some(signal => sample.indoorSensors?.[signal]?.needsAttention === true),
    ...(sensors.length ? { attentionSensors: sensors } : {}) };
}

/** Project inputs as originally supplied, including original sensor exclusions.
 * Correction replay may restore preserved measurements behind these gaps; its
 * changed assessments belong in the coefficient chart. Do not rerun today's
 * learner, read mutable configuration or expose private source identifiers. */
export function addModelInputs({ store, range, now, input, envelopes, indoorLine }) {
  const selected = Object.keys(MODEL_INPUT_INFO).filter(key => envelopes[key] && !FIREPLACE_INPUT_NAMES.includes(key));
  const stats = { records: 0, rejectedIntervals: 0, basis: 'immutable-learning-journal' };
  if (!selected.length) return stats;
  const inputs = input === 'simulated' ? ['simulated'] : ['history', 'providers', 'mqtt'];
  const query = store.db.prepare(`SELECT id,input,at,algorithm_version,payload FROM learning_journal
    WHERE kind='sample' AND input IN (${inputs.map(() => '?').join(',')}) AND at>=? AND at<=?
    ORDER BY at,id`);
  const lastEnd = new Map();
  const project = (key, start, end, value, metadata, endpoint = false) => {
    const line = envelopes[key];
    if (endpoint) {
      // A narrow zoom can lie entirely between two saved endpoints. Reuse the
      // scalar display clipping without adding a reading or extending live data.
      if (indoorLine) {
        if (lastEnd.has(key) && start > lastEnd.get(key)) indoorLine.add(start - 1, null);
        indoorLine.add(end, value, metadata); lastEnd.set(key, end);
        return;
      }
      if (end >= range.from && end <= Math.min(range.to, now)) {
        if (lastEnd.has(key) && start > lastEnd.get(key)) line.add(start - 1, null);
        line.add(end, value, metadata); lastEnd.set(key, end);
      }
      return;
    }
    // Temperature detail retains bounded original interval knots on either
    // side; clipping a saved interval first would turn its cubic into a hold.
    const a = Math.max(start, line.contextFrom ?? range.from), b = Math.min(end, line.contextTo ?? range.to, now);
    if (b <= a) return;
    if (lastEnd.has(key) && a > lastEnd.get(key)) line.add(lastEnd.get(key), null);
    line.add(a, value, metadata); line.add(b - 1, value, metadata);
    lastEnd.set(key, b);
  };
  const accept = row => {
    let sample;
    try { sample = JSON.parse(row.payload)?.value; } catch { return; }
    if (row.algorithm_version !== LEARNING_ALGORITHM) { stats.rejectedIntervals++; return; }
    try { assertCurrentLearningSample(sample); } catch { stats.rejectedIntervals++; return; }
    const end = finite(sample.windowEnd) ? sample.windowEnd : row.at;
    const start = finite(sample.windowStart) ? sample.windowStart : end - WINDOW;
    if (!finite(start) || end <= start || end - start > WINDOW || end > now) return;
    stats.records++;
    const usable = sample.valid !== false && goodQuality(sample.quality);
    const common = { modelInput: true, journalId: row.id, algorithmVersion: row.algorithm_version,
      inputSource: sources[row.input], learningUsable: usable, intervalStart: start, intervalEnd: end };
    if (selected.includes('model_indoor_temperature')) {
      project('model_indoor_temperature', start, end, finite(sample.indoorC) ? sample.indoorC : null,
        { ...common, ...indoorEndpointMetadata(sample, usable) }, true);
    }
    const segments = sample.inputSegments;
    for (const segment of segments) {
      const a = segment.start, b = segment.end;
      if (!finite(a) || !finite(b) || a < start || b > end || b <= a) continue;
      const valid = usable && goodQuality(segment.quality);
      if (!valid) stats.rejectedIntervals++;
      const metadata = { ...common, learningUsable: valid, intervalStart: a, intervalEnd: b };
      for (const key of selected) {
        if (key === 'model_indoor_temperature') continue;
        let value = key === 'model_controller_phase' ? PHASES.indexOf(segment.phase) : segment[fields[key]];
        if (key === 'model_controller_phase' && value < 0) value = null;
        if (key === 'model_valve_override') value = ({ off: 0, on: 1, partial: 2, unknown: 3 })[value] ?? null;
        if (key === 'model_compressor_duty' && finite(value)) value *= 100;
        project(key, a, b, valid && finite(value) ? value : null, metadata);
      }
    }
  };
  // A live journal supersedes imported reconstruction at the same timestamp;
  // the selected physical input wins if both provider modes recorded a window.
  let pending;
  const priority = row => row.input === input ? 2 : row.input === 'history' ? 0 : 1;
  const queryFrom = Math.min(range.from - (indoorLine ? WINDOW : 0),
    ...selected.map(key => envelopes[key].contextFrom ?? range.from));
  const queryTo = Math.min(now, Math.max(range.to + WINDOW,
    ...selected.map(key => envelopes[key].contextTo ?? range.to)));
  for (const row of query.iterate(...inputs, queryFrom, queryTo)) {
    if (pending && pending.at !== row.at) { accept(pending); pending = null; }
    if (!pending || priority(row) >= priority(pending)) pending = row;
  }
  if (pending) accept(pending);
  for (const [key, end] of lastEnd) if (key !== 'model_indoor_temperature') envelopes[key].add(end, null);
  return stats;
}
