import { createHash } from 'node:crypto';
import { createGarageModel, updateGarageModel, garageModelSummary, GARAGE_ALGORITHM_VERSION } from './model.js';
import { garageSettings } from './settings.js';

const HOUR = 3_600_000, finite = Number.isFinite;
const signals = ['garage_temperature', 'outdoor_temperature', 'ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3', 'ev2_energy'];
const invalid = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'implausible_temperature', 'negative_current',
  'implausible_current', 'conflicting_duplicate', 'retained', 'stale', 'future_source_time', 'invalid-value',
  'invalid_value', 'unverified-scaling', 'integration_gap', 'partial-coverage']);
function checked(options) {
  const config = { from: 0, to: Date.now(), asOf: Date.now(), maxSamples: 100_000,
    outdoorMaxAgeMs: 3 * HOUR, evActivityMaxAgeMs: 30 * 60_000, includeRecordedEvActivity: true, ...options };
  if (![config.from, config.to, config.asOf].every(finite) || config.from < 0 || config.to <= config.from)
    throw new Error('Garage historical reconstruction requires a valid numeric UTC range');
  if (!Number.isSafeInteger(config.maxSamples) || config.maxSamples < 1 || config.maxSamples > 1_000_000)
    throw new Error('Garage historical maxSamples must be 1..1000000');
  for (const key of ['outdoorMaxAgeMs', 'evActivityMaxAgeMs']) if (!finite(config[key]) || config[key] <= 0 || config[key] > 4 * HOUR)
    throw new Error(`Garage historical ${key} must be greater than zero and at most four hours`);
  if (typeof config.includeRecordedEvActivity !== 'boolean') throw new Error('Historical EV activity selection must be boolean');
  return config;
}
function decode(row) {
  let quality, raw;
  try { quality = JSON.parse(row.quality); raw = row.raw == null ? {} : JSON.parse(row.raw); } catch { return null; }
  if (!Array.isArray(quality) || quality.some(flag => invalid.has(flag)) || !finite(row.value)) return null;
  if (row.signal.endsWith('_temperature') && (!['degC', '°C'].includes(row.unit) || row.value < -60 || row.value > 65)) return null;
  if (row.signal.startsWith('ev1_current_') && (row.unit !== 'A' || row.value < 0 || row.value > 100)) return null;
  return { ...row, quality, raw };
}
// Same scalar import precedence as the existing chart: later completed import,
// then later row within that import. Originals are never edited or deduplicated.
function preferred(previous, current) {
  if (!previous) return current;
  if (current.import_id === null && previous.import_id !== null) return current;
  if (previous.import_id === null && current.import_id !== null) return previous;
  if (current.import_id !== null) return current.import_id > previous.import_id
    || current.import_id === previous.import_id && current.row_number >= previous.row_number ? current : previous;
  return current.id > previous.id ? current : previous;
}
function currentActivity(latest, at, age) {
  const currents = ['ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3'].map(signal => latest.get(signal))
    .filter(row => row && at - row.source_time <= age);
  if (currents.some(row => row.value > .5)) return true;
  const cohort = row => row.import_id !== null ? `${row.import_id}:${row.row_number}` : `${row.source}:${row.received_at}`;
  return currents.length === 3 && currents.every(row => cohort(row) === cohort(currents[0])) ? false : null;
}
function secondActivity(row, at, age) {
  if (!row || at - row.source_time > age || row.unit !== 'kWh' || row.value < 0) return null;
  const raw = row.raw;
  if (!finite(raw.intervalStart) || raw.intervalEnd !== row.source_time || raw.intervalEnd <= raw.intervalStart
    || raw.intervalEnd - raw.intervalStart > age) return null;
  return row.value > 0;
}

/** Explicit retrospective input projection. Imported rear remains rear; native
 * availability, power and front remain unknown. No database/journal mutations. */
export function* garageHistoricalObservations(store, options = {}) {
  const config = checked(options), latest = new Map(), atRows = new Map();
  const placeholders = signals.map(() => '?').join(',');
  const query = store.db.prepare(`SELECT o.id,o.signal,o.value,o.unit,o.quality,o.raw,o.source,o.source_time,
      o.received_at,o.import_id,o.row_number
    FROM observations o INDEXED BY observations_time LEFT JOIN imports i ON i.id=o.import_id
    WHERE o.source_time>=? AND o.source_time<? AND o.received_at<=? AND o.signal IN (${placeholders})
      AND o.source<>'simulation' AND (o.import_id IS NULL OR i.status='complete')
      AND ((o.signal IN ('garage_temperature','outdoor_temperature') AND o.import_id IS NOT NULL)
        OR (o.signal LIKE 'ev1_current_%' AND (o.import_id IS NOT NULL OR ?))
        OR (o.signal='ev2_energy' AND ?))
    ORDER BY o.source_time,o.id`);
  let at = null, count = 0, priorRearAt = null;
  const flush = () => {
    for (const [signal, row] of atRows) latest.set(signal, row);
    const rear = atRows.get('garage_temperature');
    if (!rear) return null;
    const outdoor = latest.get('outdoor_temperature');
    const usableOutdoor = outdoor && at - outdoor.source_time <= config.outdoorMaxAgeMs;
    const value = { at, rearAt: at, rearC: rear.value, rearUsable: true,
      frontC: null, frontAt: null, frontUsable: false, outdoorC: usableOutdoor ? outdoor.value : null,
      outdoorAt: usableOutdoor ? outdoor.source_time : null, available: null, baselineVerified: false,
      powerKw: null, powerQuality: 'unknown', activity: null, ev1Kw: null, ev2Kw: null,
      ev1Active: currentActivity(latest, at, config.evActivityMaxAgeMs),
      ev2Active: secondActivity(latest.get('ev2_energy'), at, config.evActivityMaxAgeMs),
      rearGap: finite(priorRearAt) && at - priorRearAt > 2 * HOUR,
      provenance: { kind: 'garage-imported-rear-context', source: rear.source,
        rearObservationId: rear.id, rearImportId: rear.import_id, rearRow: rear.row_number,
        outdoorObservationId: usableOutdoor ? outdoor.id : null,
        evObservationIds: signals.filter(s => s.startsWith('ev')).map(s => latest.get(s))
          .filter(row => row && at - row.source_time <= config.evActivityMaxAgeMs).map(row => row.id),
        inputScope: 'historical-context-only', nativeAndFront: 'not-recorded' } };
    priorRearAt = at; return value;
  };
  for (const raw of query.iterate(config.from, config.to, config.asOf, ...signals,
    Number(config.includeRecordedEvActivity), Number(config.includeRecordedEvActivity))) {
    if (at !== null && raw.source_time !== at) {
      const value = flush();
      if (value) { yield value; if (++count >= config.maxSamples) return; }
      atRows.clear();
    }
    at = raw.source_time;
    const row = decode(raw);
    if (row) atRows.set(row.signal, preferred(atRows.get(row.signal), row));
  }
  if (at !== null && count < config.maxSamples) {
    const value = flush(); if (value) yield value;
  }
}

/** Compact reproducible assessment of imported context, explicitly separate from
 * today's live seed. No actuation, background mutation, or inferred native OFF. */
export function reconstructGarageHistory(store, options = {}) {
  const config = checked(options), settings = garageSettings(options.settings ?? {});
  const hash = createHash('sha256');
  let model = null, samples = 0, firstAt = null, lastAt = null, rearOnly = 0;
  for (const observation of garageHistoricalObservations(store, config)) {
    model ??= createGarageModel({ seedAt: observation.at });
    model = updateGarageModel(model, observation, settings);
    hash.update(JSON.stringify(observation)); hash.update('\n');
    samples++; firstAt ??= observation.at; lastAt = observation.at;
    if (observation.frontC === null) rearOnly++;
  }
  const digest = createHash('sha256').update(JSON.stringify({ algorithm: GARAGE_ALGORITHM_VERSION,
    configuration: settings, inputDigest: hash.digest('hex'), model })).digest('hex');
  return { scope: 'garage:historical-context', status: samples ? 'rear-context-only' : 'unavailable',
    algorithm: GARAGE_ALGORITHM_VERSION, samples, firstAt, lastAt, rearOnly,
    bounded: samples >= config.maxSamples, requestedRange: { from: config.from, to: config.to },
    checksum: digest, model, summary: model ? garageModelSummary(model) : null,
    limitations: ['Imported rear is not an average or a front measurement.',
      'Native heating availability and electricity are unrecorded and unidentifiable from these CSV columns.',
      'EV current/activity is never converted to measured watts.',
      'This historical observer context is not automatically installed as a live learning seed.'] };
}
