import { indoorWeights } from '../domain/indoor-sensors.js';

const bound = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid sensor correction revision');
  return value;
};

// Materialize only corrections before applying ID order/bounds. Otherwise
// SQLite can prefer the journal's ID index and walk all accumulated samples
// looking for rare context rows, even after the correlated scan is removed.
const sensorReversals = `WITH sensor_reversals AS MATERIALIZED (
  SELECT id,at,json_extract(payload,'$.value.sensorRevert.id') target
  FROM learning_journal WHERE input=? AND kind='context'
    AND json_type(payload,'$.value.sensorRevert')='object')`;

// Additions are consumed in journal order. Only a retrospective correction
// invalidates an already replayed prefix.
export function sensorRevision(store, input) {
  return store.db.prepare(`${sensorReversals}
    SELECT COALESCE(MAX(id),0) revision FROM sensor_reversals`).get(input).revision;
}

export function sensorLearningContext(store, input, revision = sensorRevision(store, input)) {
  bound(revision);
  const rows = store.db.prepare(`${sensorReversals}
    SELECT id,target FROM sensor_reversals WHERE id<=? ORDER BY id`).all(input, revision);
  return { sensorRevision: rows.at(-1)?.id ?? 0, revertedSensorChanges: [...new Set(rows.map(row => row.target))] };
}

/** Display the original events even after reversal. The revision selects the
 * corrected interpretation, while at bounds the original measurement time. */
export function sensorChangeEvents(store, input, { at = Number.MAX_SAFE_INTEGER, limit = -1, revision } = {}) {
  revision ??= sensorRevision(store, input);
  const reversals = store.db.prepare(`${sensorReversals}
    SELECT target,MIN(at) at FROM sensor_reversals WHERE id<=? GROUP BY target`).all(input, bound(revision));
  const reverted = new Map(reversals.map(row => [row.target, row.at]));
  return store.db.prepare(`SELECT id,at,algorithm_version,json_extract(payload,'$.configuration') AS configuration,json_extract(payload,'$.value.sensorChange') AS change
    FROM learning_journal WHERE input=? AND kind='context' AND at<=?
      AND json_type(payload,'$.value.sensorChange')='object' ORDER BY at DESC,id DESC LIMIT ?`)
    .all(input, at, limit).map(row => {
      const change = JSON.parse(row.change);
      return { ...change, id: row.id, at: row.at, algorithmVersion: row.algorithm_version,
        affectsLearning: affectsThermalLearning(change.signal, JSON.parse(row.configuration) ?? {}), revertedAt: reverted.get(row.id) ?? null };
    });
}

export function sensorBoundaries(store, input, at, { revision = sensorRevision(store, input) } = {}) {
  // Resolve reversals once within this input/epoch. A correlated lookup through
  // the journal view can choose the global row-ID index and scan every older
  // sample (including other inputs) for each context during every status poll.
  const reverted = new Set(sensorLearningContext(store, input, revision).revertedSensorChanges);
  const rows = store.db.prepare(`SELECT id,at,json_extract(payload,'$.value.sensorChange.signal') signal
    FROM learning_journal WHERE input=? AND kind='context' AND at<=?
      AND json_type(payload,'$.value.sensorChange')='object'`).all(input, at);
  const boundaries = new Map();
  for (const row of rows) if (!reverted.has(row.id))
    boundaries.set(row.signal, Math.max(boundaries.get(row.signal) ?? -Infinity, row.at));
  return Object.fromEntries(boundaries);
}

export function affectsThermalLearning(signal, config) {
  return signal === 'outdoor_temperature' || Object.hasOwn(indoorWeights(config), signal);
}
