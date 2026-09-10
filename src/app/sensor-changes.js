import { appendLearningRecord } from './committed-learning.js';
import { sensorChangeEvents } from './sensor-inputs.js';
import { TEMPERATURE_SENSORS, SENSOR_SETTLING_MS, indoorWeights } from '../domain/indoor-sensors.js';

const INPUTS = new Set(['mqtt', 'providers', 'simulated']);
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

export function sensorChangesView(store, input, { now = Date.now(), config = {}, readOnly = false, observedSignals = [] } = {}) {
  const weights = indoorWeights(config);
  const events = sensorChangeEvents(store, input, { at: now }).map(({ requestId: _requestId, ...event }) => event);
  return { available: INPUTS.has(input) && !readOnly, readOnly,
    revision: events[0]?.id ?? 0, events, settlingMinutes: SENSOR_SETTLING_MS / 60_000,
    sensors: Object.entries(TEMPERATURE_SENSORS).map(([signal, label]) => ({ signal, label,
      configured: Object.hasOwn(weights, signal) || observedSignals.includes(signal) || signal === 'outdoor_temperature' })) };
}
