import { temperatureReportMaxAge } from '../domain/temperature-reports.js';

// Alternative indoor/garage sensors publish a number in Celsius, or
// {value, unit:'C'|'F', timestamp:<ISO UTC or epoch milliseconds>}.
export function decodeMqttTemperature({ signal, payload, receivedAt, retained = false,
  reportIntervalMs = null, reportGraceMs = 0 }) {
  if (!['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature'].includes(signal)) return null;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  if (text.length > 512) return null;
  let input;
  try { input = JSON.parse(text); } catch { return null; }
  const object = input && typeof input === 'object' && !Array.isArray(input) ? input : { value: input };
  let value = typeof object.value === 'number' && Number.isFinite(object.value) ? object.value : null;
  const unit = object.unit ?? 'C', quality = [];
  if (!['C', 'degC', '°C', 'F'].includes(unit)) { value = null; quality.push('invalid_unit'); }
  if (unit === 'F' && value !== null) { value = (value - 32) * 5 / 9; quality.push('converted_fahrenheit'); }
  if (value !== null && (value < -60 || value > 70)) { value = null; quality.push('implausible_temperature'); }
  let sourceTime = typeof object.timestamp === 'number' && Number.isSafeInteger(object.timestamp) ? object.timestamp
    : typeof object.timestamp === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(object.timestamp) ? Date.parse(object.timestamp) : null;
  if (!Number.isFinite(sourceTime) || sourceTime < 0) sourceTime = null;
  if (sourceTime === null && !retained && object.timestamp == null) sourceTime = receivedAt;
  if (sourceTime === null) quality.push('source_time_unknown');
  if (sourceTime > receivedAt) quality.push('future_source_time');
  const raw = { timeBasis: object.timestamp == null ? 'mqtt-received' : 'source-measured', retained,
    ...(reportIntervalMs !== null ? { reportIntervalMs, reportGraceMs } : {}) };
  const reportAge = temperatureReportMaxAge({ raw });
  if (reportAge !== null && Number.isFinite(sourceTime) && receivedAt - sourceTime > reportAge) quality.push('stale');
  if (signal === 'outdoor_temperature' && Number.isFinite(sourceTime) && receivedAt - sourceTime > 300_000) quality.push('stale');
  if (retained) quality.push('retained');
  if (value === null) quality.push('missing');
  return { source: 'mqtt-temperature', device: signal, signal, value, unit: 'degC', sourceTime, receivedAt, quality,
    raw };
}

