import { instantMs } from './prices.js';

// Consulted 2026-09-06. Documentation identifies registers, not installed-device scaling.
export const H66_DOCUMENTATION = Object.freeze({
  mqtt: 'https://husdata.se/docs/h60-manual/home-assistant-integration/mqtt-specification/',
  controller: 'https://online.husdata.se/h-docs/C60.pdf',
  controllerRevision: '2025-10-03', inspectedAt: '2026-09-06',
  limitation: 'Hardware, firmware, register availability and wire scaling require installed-device verification.',
});

export const H66_REGISTERS = Object.freeze(Object.fromEntries([
  ['0001', 'return_temperature', '°C'], ['0002', 'supply_temperature', '°C'],
  ['0005', 'brine_in_temperature', '°C'], ['0006', 'brine_out_temperature', '°C'],
  ['0007', 'outdoor_temperature', '°C'], ['0008', 'indoor_temperature', '°C'],
  ['0009', 'dhw_temperature', '°C'], ['0107', 'heating_setpoint', '°C'],
  ['8105', 'integral', 'degree-minutes'], ['3104', 'auxiliary_output', '%'],
  ['6C60', 'compressor_hours', 'h'], ['6C63', 'auxiliary_3kw_hours', 'h'],
  ['6C66', 'auxiliary_6kw_hours', 'h'], ['6C64', 'dhw_hours', 'h'],
  ['1A01', 'compressor_active', 'state'], ['1A07', 'dhw_routing', 'state'],
  ['0203', 'room_setting', '°C'], ['2201', 'operating_mode', 'state'],
  ['1A20', 'alarm_active', 'state'], ['2A91', 'alarm_code', 'code'],
].map(([index, signal, unit]) => [index, Object.freeze({ index, signal, unit })])));

/** Read-only decoder: no MQTT connection, subscription side effects, or command encoding. */
export function createH66Decoder({ deviceId, verifiedRegisters = {}, maxAgeMs = 300_000,
  maxDuplicates = 512, duplicateWindowMs = 300_000 } = {}) {
  if (typeof deviceId !== 'string' || !deviceId || /[\/# +\u0000]/.test(deviceId)) throw new TypeError('Exact MQTT device identifier required');
  for (const [label, value] of Object.entries({ maxAgeMs, maxDuplicates, duplicateWindowMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  }
  if (!Number.isInteger(maxDuplicates)) throw new TypeError('maxDuplicates must be an integer');
  const verification = new Map();
  for (const [index, config] of Object.entries(verifiedRegisters)) {
    if (!H66_REGISTERS[index] || !config || !Number.isFinite(config.scale) || config.scale === 0 ||
      !Number.isFinite(config.offset ?? 0) || typeof config.evidence !== 'string' || !config.evidence.trim()) {
      throw new TypeError(`Invalid installed-device verification for ${index}`);
    }
    verification.set(index, { ...config, offset: config.offset ?? 0 });
  }
  const seen = new Map();
  function decode(message) {
    const { topic, payload, receivedAt, sourceAt = null, retained = false, dup = false, messageId = null } = message;
    if (typeof topic !== 'string' || !topic.startsWith(`${deviceId}/HP/`)) return null;
    const index = topic.slice(deviceId.length + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(index)) return null; // Excludes SET, CMD and status subtopics.
    const register = H66_REGISTERS[index.toUpperCase()];
    const received = instantMs(receivedAt), source = sourceAt == null ? null : instantMs(sourceAt);
    const raw = Buffer.isBuffer(payload) ? payload.toString('utf8') : typeof payload === 'string' ? payload : '';
    const issues = [];
    if (!register) issues.push('unknown-register');
    if (raw.length > 512 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) issues.push('invalid-payload');
    const rawNumeric = issues.includes('invalid-payload') ? null : Number(raw.trim());
    if (rawNumeric !== null && !Number.isFinite(rawNumeric)) issues.push('invalid-payload');
    const config = verification.get(index.toUpperCase());
    if (!config) issues.push('unverified-scaling');
    if (retained) issues.push('retained');
    let freshness = 'unknown';
    if (source == null) issues.push('unknown-source-time');
    else if (source > received) { freshness = 'invalid'; issues.push('future-source-time'); }
    else if (received - source > maxAgeMs) { freshness = 'stale'; issues.push('stale'); }
    else freshness = 'fresh';
    for (const [key, entry] of seen) if (received - entry.received > duplicateWindowMs) seen.delete(key);
    // Identical ordinary readings are legitimate. Only source identity or MQTT DUP identifies repeats.
    const key = source != null ? `${topic}\u0000${source}\u0000${raw.slice(0, 512)}` :
      messageId != null ? `${topic}\u0000mqtt:${messageId}\u0000${raw.slice(0, 512)}` : null;
    const previous = key == null ? null : seen.get(key);
    const duplicate = Boolean(previous && (source != null || dup));
    if (duplicate) issues.push('duplicate');
    if (key !== null) {
      seen.delete(key); seen.set(key, { received });
      while (seen.size > maxDuplicates) seen.delete(seen.keys().next().value);
    }
    let value = config && !issues.includes('invalid-payload') ? rawNumeric * config.scale + config.offset : null;
    if (value != null && (!Number.isFinite(value) || !validRange(register, value))) {
      issues.push('invalid-value'); value = null;
    }
    return { deviceId, source: 'husdata-h66', register: index.toUpperCase(),
      signal: register?.signal ?? 'unknown', unit: register?.unit ?? null,
      value, raw: raw.slice(0, 512), rawNumeric: Number.isFinite(rawNumeric) ? rawNumeric : null,
      receivedAt: received, sourceAt: source, retained: Boolean(retained), duplicate,
      freshness, quality: value != null && freshness === 'fresh' && !duplicate && !retained ? 'good' : 'uncertain',
      issues, verification: config?.evidence ?? null, provenance: H66_DOCUMENTATION.controller,
      usableForControl: value != null && freshness === 'fresh' && !duplicate && !retained };
  }
  return Object.freeze({ decode, subscriptionTopic: `${deviceId}/HP/+`,
    get duplicateCacheSize() { return seen.size; } });
}

function validRange(register, value) {
  if (register.unit === 'h') return value >= 0;
  if (register.unit === '%') return value >= 0 && value <= 100;
  if (register.unit === 'state') return Number.isInteger(value) && value >= 0 && value <= (register.index === '2201' ? 4 : 1);
  return true;
}
