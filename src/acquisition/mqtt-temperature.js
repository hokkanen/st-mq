import { createHash } from 'node:crypto';
import { temperatureReportMaxAge } from '../domain/temperature-reports.js';
import { sourceTimeAdmission, validateAdmittedSourceTime } from '../domain/time-evidence.js';


// The digest binds a persisted room report to its exact decoder and broker route.
// Credentials and concrete broker/topic details never enter observation metadata.
export function temperatureRouteSignature({ brokerIdentity, topic, statePath = null, timestampPath = null, mappings = [] }) {
  return createHash('sha256').update(JSON.stringify({ decoder: 'mqtt-temperature-v2',
    broker: { address: brokerIdentity?.address ?? null, username: brokerIdentity?.username ?? null },
    topic, statePath, timestampPath,
    mappings: mappings.map(mapping => ({ topic: mapping.topic ?? null, path: mapping.path ?? null,
      unit: mapping.unit ?? null, scale: mapping.scale ?? 1, offset: mapping.offset ?? 0 })) })).digest('hex');
}

// Alternative indoor/garage sensors publish a number in Celsius, or
// {value, unit:'C'|'F', timestamp:<ISO UTC or epoch milliseconds>}.
export function decodeMqttTemperature({ signal, payload, receivedAt, admittedAt, retained = false,
  reportIntervalMs = null, reportGraceMs = 0, timestampRequired = false, scale = 1, offset = 0 }) {
  if (!['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'].includes(signal)) return null;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  if (text.length > 512) return null;
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input };
  let value = typeof object.value === 'number' && Number.isFinite(object.value) ? object.value : null;
  const unit = object.unit ?? 'C', quality = [];
  if (!['C', 'degC', '°C', 'F'].includes(unit)) { value = null; quality.push('invalid_unit'); }
  if (unit === 'F' && value !== null) { value = (value - 32) * 5 / 9; quality.push('converted_fahrenheit'); }
  if (value !== null) value = value * scale + offset;
  if (!Number.isFinite(value)) value = null;
  if (value !== null && (value < -60 || value > 70)) { value = null; quality.push('implausible_temperature'); }
  let sourceTime = typeof object.timestamp === 'number' && Number.isSafeInteger(object.timestamp) ? object.timestamp
    : typeof object.timestamp === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(object.timestamp) ? Date.parse(object.timestamp) : null;
  if (!Number.isFinite(sourceTime) || sourceTime < 0) sourceTime = null;
  const timestampPresent = Object.hasOwn(object, 'timestamp');
  if (sourceTime === null && !retained && !timestampRequired && !timestampPresent) sourceTime = receivedAt;
  if (sourceTime === null) quality.push('source_time_unknown');
  if (sourceTime > receivedAt && !validateAdmittedSourceTime({ sourceTime, receivedAt, admittedAt,
    now: admittedAt ?? receivedAt })) quality.push('future_source_time');
  const timeAdmission = sourceTimeAdmission({ sourceTime, receivedAt, now: admittedAt ?? receivedAt, deferred: admittedAt !== undefined });
  const raw = { timeBasis: !timestampRequired && !timestampPresent ? 'mqtt-received' : 'source-measured', retained,
    ...(timeAdmission ? { timeAdmission } : {}),
    ...(reportIntervalMs !== null ? { reportIntervalMs, reportGraceMs } : {}) };
  const reportAge = temperatureReportMaxAge({ raw });
  if (reportAge !== null && Number.isFinite(sourceTime) && receivedAt - sourceTime >= reportAge) quality.push('stale');
  if (signal === 'outdoor_temperature' && Number.isFinite(sourceTime) && receivedAt - sourceTime > 300_000) quality.push('stale');
  if (retained) quality.push('retained');
  if (value === null) quality.push('missing');
  return { source: 'mqtt-temperature', device: signal, signal, value, unit: 'degC', sourceTime, receivedAt, quality,
    raw };
}
