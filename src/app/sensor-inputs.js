import { indoorWeights } from '../domain/indoor-sensors.js';

const bound = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid sensor correction revision');
  return value;
};

// Additions are consumed in journal order. Only a retrospective correction
// invalidates an already replayed prefix.
export function sensorRevision(store, input) {
  return store.db.prepare(`SELECT COALESCE(MAX(id),0) revision FROM learning_journal
    WHERE input=? AND kind='context' AND json_type(payload,'$.value.sensorRevert')='object'`).get(input).revision;
}

export function sensorLearningContext(store, input, revision = sensorRevision(store, input)) {
  bound(revision);
  const rows = store.db.prepare(`SELECT id,json_extract(payload,'$.value.sensorRevert.id') target
    FROM learning_journal WHERE input=? AND kind='context' AND id<=?
    AND json_type(payload,'$.value.sensorRevert')='object' ORDER BY id`).all(input, revision);
  return { sensorRevision: rows.at(-1)?.id ?? 0, revertedSensorChanges: [...new Set(rows.map(row => row.target))] };
}

/** Display the original events even after reversal. The revision selects the
 * corrected interpretation, while at bounds the original measurement time. */
export function sensorChangeEvents(store, input, { at = Number.MAX_SAFE_INTEGER, limit = -1, revision } = {}) {
  revision ??= sensorRevision(store, input);
  const reversals = store.db.prepare(`SELECT json_extract(payload,'$.value.sensorRevert.id') target,MIN(at) at
    FROM learning_journal WHERE input=? AND kind='context' AND id<=?
    AND json_type(payload,'$.value.sensorRevert')='object' GROUP BY target`).all(input, bound(revision));
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
  const rows = store.db.prepare(`SELECT json_extract(c.payload,'$.value.sensorChange.signal') signal,MAX(c.at) at
    FROM learning_journal c WHERE c.input=? AND c.kind='context' AND c.at<=?
      AND json_type(c.payload,'$.value.sensorChange')='object'
      AND NOT EXISTS (SELECT 1 FROM learning_journal r WHERE r.input=c.input AND r.kind='context'
        AND r.id<=? AND json_extract(r.payload,'$.value.sensorRevert.id')=c.id)
    GROUP BY signal`).all(input, at, bound(revision));
  return Object.fromEntries(rows.map(row => [row.signal, row.at]));
}

export function affectsThermalLearning(signal, config) {
  return signal === 'outdoor_temperature' || Object.hasOwn(indoorWeights(config), signal);
}
