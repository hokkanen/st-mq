import { indoorWeights } from '../domain/indoor-sensors.js';

const bound = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid sensor correction revision');
  return value;
};

const selected = alias => `(${alias}.epoch=? OR EXISTS(SELECT 1 FROM learning_epoch_segments g
  WHERE g.epoch=? AND g.input=${alias}.input AND g.source_epoch=${alias}.epoch
    AND ${alias}.id>g.after_id AND ${alias}.id<=g.through_id))`;

/** Ordinary controller contexts are not sensor changes. Start from the sparse
 * sensor source index, then resolve only their selected ordering references. */
function sensorEntries(store, input, epoch) {
  epoch ??= store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
  return store.db.prepare(`WITH sensor_sources AS MATERIALIZED (
    SELECT id,input,epoch,at,algorithm_version,payload FROM learning_journal_entries INDEXED BY learning_sensor_contexts
    WHERE input=? AND kind='context' AND (json_type(payload,'$.value.sensorChange')='object'
      OR json_type(payload,'$.value.sensorRevert')='object'))
    SELECT s.id,s.at,s.algorithm_version,s.payload FROM sensor_sources s WHERE ${selected('s')}
    UNION ALL SELECT e.id,e.at,e.algorithm_version,s.payload FROM sensor_sources s
      JOIN learning_journal_entries e INDEXED BY recovery_learning_source ON e.source_entry_id=s.id AND e.input=s.input
      WHERE e.payload IS NULL AND ${selected('e')} ORDER BY id`)
    .all(input, epoch, epoch, epoch, epoch).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
}
const reversals = (store, input, epoch) => sensorEntries(store, input, epoch)
  .filter(row => row.payload.value.sensorRevert).map(row => ({ id: row.id, at: row.at, target: row.payload.value.sensorRevert.id }));

// Additions are consumed in journal order. Only a retrospective correction
// invalidates an already replayed prefix.
export function sensorRevision(store, input) {
  return reversals(store, input).at(-1)?.id ?? 0;
}

export function sensorLearningContext(store, input, revision = sensorRevision(store, input), { epoch } = {}) {
  bound(revision);
  const rows = reversals(store, input, epoch).filter(row => row.id <= revision);
  return { sensorRevision: rows.at(-1)?.id ?? 0, revertedSensorChanges: [...new Set(rows.map(row => row.target))] };
}

/** Display the original events even after reversal. The revision selects the
 * corrected interpretation, while at bounds the original measurement time. */
export function sensorChangeEvents(store, input, { at = Number.MAX_SAFE_INTEGER, limit = -1, revision } = {}) {
  revision ??= sensorRevision(store, input);
  bound(revision);
  const entries = sensorEntries(store, input), reverted = new Map();
  for (const row of entries) {
    const reversal = row.payload.value.sensorRevert;
    if (reversal && row.id <= revision) reverted.set(reversal.id, Math.min(reverted.get(reversal.id) ?? Infinity, row.at));
  }
  const changes = entries.filter(row => row.payload.value.sensorChange && row.at <= at)
    .sort((a, b) => b.at - a.at || b.id - a.id);
  return (limit < 0 ? changes : changes.slice(0, limit)).map(row => {
    const change = row.payload.value.sensorChange;
    return { ...change, id: row.id, at: row.at, algorithmVersion: row.algorithm_version,
      affectsLearning: affectsThermalLearning(change.signal, row.payload.configuration ?? {}), revertedAt: reverted.get(row.id) ?? null };
  });
}

export function sensorBoundaries(store, input, at, { revision = sensorRevision(store, input) } = {}) {
  // Resolve reversals once within this input/epoch. A correlated lookup through
  // the journal view can choose the global row-ID index and scan every older
  // sample (including other inputs) for each context during every status poll.
  const reverted = new Set(sensorLearningContext(store, input, revision).revertedSensorChanges);
  const rows = sensorEntries(store, input).filter(row => row.payload.value.sensorChange && row.at <= at)
    .map(row => ({ id: row.id, at: row.at, signal: row.payload.value.sensorChange.signal }));
  const boundaries = new Map();
  for (const row of rows) if (!reverted.has(row.id))
    boundaries.set(row.signal, Math.max(boundaries.get(row.signal) ?? -Infinity, row.at));
  return Object.fromEntries(boundaries);
}

export function affectsThermalLearning(signal, config) {
  return signal === 'outdoor_temperature' || Object.hasOwn(indoorWeights(config), signal);
}
