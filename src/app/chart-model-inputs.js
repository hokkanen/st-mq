import { MODEL_INPUT_INFO } from '../domain/history-series.js';
import { goodQuality } from '../control/learning.js';

const WINDOW = 15 * 60_000;
const PHASES = ['normal', 'preheat', 'reduction', 'recovery'];
const finite = Number.isFinite;
const sources = { simulated: 'Simulation', history: 'Imported history', mqtt: 'Recorded MQTT inputs', providers: 'Recorded provider inputs' };
const fields = {
  model_outdoor_temperature: 'outdoorC', model_solar_radiation: 'solarRadiationWm2',
  model_compressor_duty: 'thermalCompressorDuty', model_auxiliary_power: 'thermalAuxKw',
  model_room_boost: 'roomBoostC', model_target_temperature: 'targetC',
};

/** Project immutable learning inputs. Do not rerun today's learner, read mutable
 * configuration, or expose journal payloads / source identifiers to the browser. */
export function addModelInputs({ store, range, now, input, envelopes }) {
  const selected = Object.keys(MODEL_INPUT_INFO).filter(key => envelopes[key]);
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
      if (end >= range.from && end <= Math.min(range.to, now)) {
        if (lastEnd.has(key) && start > lastEnd.get(key)) line.add(start - 1, null);
        line.add(end, value, metadata); lastEnd.set(key, end);
      }
      return;
    }
    const a = Math.max(start, range.from), b = Math.min(end, range.to, now);
    if (b <= a) return;
    if (lastEnd.has(key) && a > lastEnd.get(key)) line.add(lastEnd.get(key), null);
    line.add(a, value, metadata); line.add(b - 1, value, metadata);
    lastEnd.set(key, b);
  };
  const accept = row => {
    let sample;
    try { sample = JSON.parse(row.payload)?.value; } catch { return; }
    if (!sample) return;
    const end = finite(sample.windowEnd) ? sample.windowEnd : row.at;
    const start = finite(sample.windowStart) ? sample.windowStart : end - WINDOW;
    if (!finite(start) || end <= start || end - start > WINDOW || end > now) return;
    stats.records++;
    const usable = sample.valid !== false && goodQuality(sample.quality);
    const common = { modelInput: true, journalId: row.id, algorithmVersion: row.algorithm_version,
      inputSource: sources[row.input], intervalStart: start, intervalEnd: end };
    if (selected.includes('model_indoor_temperature'))
      project('model_indoor_temperature', start, end, usable && finite(sample.indoorC) ? sample.indoorC : null, common, true);
    // Older entries retain their saved interval interpretation. They are never
    // filled from current sensor readings, model predictions, or contract state.
    const legacy = sample.intervalInputs;
    const segments = Array.isArray(sample.inputSegments) ? sample.inputSegments : [{
      start, end, ...(legacy ?? {}),
      thermalCompressorDuty: legacy?.compressorDuty,
      thermalAuxKw: legacy?.auxKw,
    }];
    for (const segment of segments) {
      const a = segment.start, b = segment.end;
      if (!finite(a) || !finite(b) || a < start || b > end || b <= a) continue;
      const valid = usable && goodQuality(segment.quality);
      if (!valid) stats.rejectedIntervals++;
      const metadata = { ...common, intervalStart: a, intervalEnd: b };
      for (const key of selected) {
        if (key === 'model_indoor_temperature') continue;
        let value = key === 'model_controller_phase' ? PHASES.indexOf(segment.phase) : segment[fields[key]];
        if (key === 'model_controller_phase' && value < 0) value = null;
        if (key === 'model_compressor_duty' && finite(value)) value *= 100;
        project(key, a, b, valid && finite(value) ? value : null, metadata);
      }
    }
  };
  // A live journal supersedes imported reconstruction at the same timestamp;
  // the selected physical input wins if both provider modes recorded a window.
  let pending;
  const priority = row => row.input === input ? 2 : row.input === 'history' ? 0 : 1;
  for (const row of query.iterate(...inputs, range.from, Math.min(now, range.to + WINDOW))) {
    if (pending && pending.at !== row.at) { accept(pending); pending = null; }
    if (!pending || priority(row) >= priority(pending)) pending = row;
  }
  if (pending) accept(pending);
  for (const [key, end] of lastEnd) if (key !== 'model_indoor_temperature') envelopes[key].add(end, null);
  return stats;
}
