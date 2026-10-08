import { appendLearningRecord, LEARNING_ALGORITHM } from './committed-learning.js';
import { sensorChangeEvents, sensorRevision, affectsThermalLearning } from './sensor-inputs.js';
import { TEMPERATURE_SENSORS, SENSOR_SETTLING_MS, indoorWeights } from '../domain/indoor-sensors.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated']);
const jobKey = input => `fireplace:rebuild:${input}`;
const REASONS = new Set(['replacement', 'moved', 'calibration', 'other']);

export function addSensorChange(store, input, payload, now, { config = {}, seed = null } = {}) {
  if (!INPUTS.has(input)) throw new TypeError('Sensor changes are unavailable for this input');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['signal', 'reason', 'requestId'].includes(key))
    || !Object.hasOwn(TEMPERATURE_SENSORS, payload.signal) || !REASONS.has(payload.reason)
    || typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.requestId)
    || !Number.isSafeInteger(now) || now < 0) throw new TypeError('Choose a temperature sensor, change reason and valid request ID');
  return store.transaction(() => {
    const previous = store.db.prepare(`SELECT id,at,json_extract(payload,'$.value.sensorChange') AS change
      FROM learning_journal WHERE input=? AND kind='context'
      AND json_extract(payload,'$.value.sensorChange.requestId')=? LIMIT 1`).get(input, payload.requestId);
    if (previous) {
      const change = JSON.parse(previous.change);
      if (change.signal !== payload.signal || change.reason !== payload.reason)
        throw Object.assign(new Error('Conflicting sensor-change request ID'), { statusCode: 409 });
      return { id: previous.id, at: previous.at, ...change, repeated: true };
    }
    const sensorChange = { ...payload, settleUntil: now + SENSOR_SETTLING_MS };
    const id = appendLearningRecord(store, input, 'context', { timestamp: now, sensorChange }, { config, seed });
    return { id, at: now, ...sensorChange, repeated: false };
  });
}

/** Corrections never rewrite a source event or a saved learning input. */
export function revertSensorChange(store, input, payload, now, { config = {}, seed = null } = {}) {
  if (!INPUTS.has(input) || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['id', 'requestId'].includes(key))
    || !Number.isSafeInteger(payload.id) || payload.id <= 0
    || typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.requestId)
    || !Number.isSafeInteger(now) || now < 0) throw new TypeError('Choose a recorded sensor change and valid request ID');
  return store.transaction(() => {
    const target = store.db.prepare(`SELECT id,at,algorithm_version,json_extract(payload,'$.value.sensorChange') AS change
      FROM learning_journal WHERE input=? AND id=? AND kind='context'
      AND json_type(payload,'$.value.sensorChange')='object'`).get(input, payload.id);
    if (!target) throw new TypeError('Sensor change was not found for this input');
    if (target.algorithm_version !== LEARNING_ALGORITHM)
      throw Object.assign(new Error('This change belongs to an archived learning version and cannot be reverted by this version.'), { statusCode: 409 });
    const previous = store.db.prepare(`SELECT id,at,json_extract(payload,'$.value.sensorRevert.id') target
      FROM learning_journal WHERE input=? AND kind='context'
      AND json_extract(payload,'$.value.sensorRevert.requestId')=? LIMIT 1`).get(input, payload.requestId);
    if (previous && previous.target !== payload.id)
      throw Object.assign(new Error('Conflicting sensor-reversal request ID'), { statusCode: 409 });
    const first = previous ?? store.db.prepare(`SELECT id,at FROM learning_journal WHERE input=? AND kind='context'
      AND json_extract(payload,'$.value.sensorRevert.id')=? ORDER BY id LIMIT 1`).get(input, payload.id);
    const change = JSON.parse(target.change);
    if (first) return { id: target.id, signal: change.signal, at: target.at, revertedAt: first.at,
      revision: first.id, repeated: true, requiresRebuild: ['pending','running','ready','failed'].includes(store.getState(jobKey(input))?.status) };
    const revision = appendLearningRecord(store, input, 'context', { timestamp: now, sensorRevert: { ...payload } }, { config, seed });
    const previousJob = store.getState(jobKey(input));
    const pending = ['pending','running','ready','failed'].includes(previousJob?.status);
    const fireplaceRevision = store.db.prepare('SELECT COALESCE(MAX(id),0) revision FROM active_fireplace_events AS fireplace_events WHERE input=?').get(input).revision;
    const epoch = store.db.prepare('SELECT epoch FROM learning_epochs WHERE input=?').get(input)?.epoch ?? 'original';
    store.setState(jobKey(input), { status: 'pending', revision: fireplaceRevision, sensorRevision: revision, epoch,
      requestedAt: now, affectedAt: Math.min(target.at, pending ? previousJob?.affectedAt ?? target.at : target.at), requiresRebuild: true });
    return { id: target.id, signal: change.signal, at: target.at, revertedAt: now, revision, repeated: false, requiresRebuild: true };
  });
}

export function sensorChangesView(store, input, { now = Date.now(), config = {}, readOnly = false, observedSignals = [] } = {}) {
  const weights = indoorWeights(config), available = INPUTS.has(input) && !readOnly;
  const events = sensorChangeEvents(store, input, { at: now }).map(({ requestId: _requestId, ...event }) => ({ ...event,
    canRevert: available && event.revertedAt === null && event.algorithmVersion === LEARNING_ALGORITHM,
    ...(event.algorithmVersion !== LEARNING_ALGORITHM ? { unsupportedReason: 'Archived learning version' } : {}) }));
  const job = store.getState(jobKey(input));
  const rebuilding = ['pending','running','ready','failed'].includes(job?.status);
  const rebuild = { status: rebuilding ? job.status === 'ready' ? 'running' : job.status : 'idle',
    processed: job?.processed ?? 0, current: job?.status === 'current',
    ...(job?.status === 'failed' ? { error: 'Learning rebuild failed. The previous model remains active; retry to continue.' } : {}) };
  return { available, readOnly, revision: events.reduce((revision, event) => Math.max(revision, event.id), sensorRevision(store, input)), events,
    rebuild, canRetryRebuild: available && rebuild.status === 'failed', settlingMinutes: SENSOR_SETTLING_MS / 60_000,
    sensors: Object.entries(TEMPERATURE_SENSORS).map(([signal, label]) => ({ signal, label,
      affectsLearning: affectsThermalLearning(signal, config),
      configured: Object.hasOwn(weights, signal) || observedSignals.includes(signal) || signal === 'outdoor_temperature' })) };
}
