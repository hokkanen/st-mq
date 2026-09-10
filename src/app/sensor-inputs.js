import { indoorWeights } from '../domain/indoor-sensors.js';

/** The compact source event lives once in the immutable learning journal.
 * Queries select only events already effective at the requested model time. */
export function sensorChangeEvents(store, input, { at = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
  return store.db.prepare(`SELECT id,at,json_extract(payload,'$.value.sensorChange') AS change
    FROM learning_journal WHERE input=? AND kind='context' AND at<=?
      AND json_type(payload,'$.value.sensorChange')='object' ORDER BY at DESC,id DESC LIMIT ?`)
    .all(input, at, limit).map(row => ({ ...JSON.parse(row.change), id: row.id, at: row.at }));
}

export function sensorBoundaries(store, input, at) {
  const rows = store.db.prepare(`SELECT json_extract(payload,'$.value.sensorChange.signal') AS signal,
      MAX(at) AS at FROM learning_journal WHERE input=? AND kind='context' AND at<=?
      AND json_type(payload,'$.value.sensorChange')='object' GROUP BY signal`).all(input, at);
  return Object.fromEntries(rows.map(row => [row.signal, row.at]));
}

export function affectsThermalLearning(signal, config) {
  return signal === 'outdoor_temperature' || Object.hasOwn(indoorWeights(config), signal);
}
