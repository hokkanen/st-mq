// The fixture vocabulary is isolated from the separately implemented Pill
// contract; selecting a production driver never accepts fixture messages.
export const GARAGE_FIXTURE_CONTRACT = 'stmq-garage-fixture/v1';
export const SHELLY_CN105_CONTRACT = 'shelly-cn105/v1';
export const GARAGE_CONTRACT_STATUS = 'provisional-fixture-only';
export function validateSavedGaragePauseContract(persisted) {
  if (persisted?.episode && Object.hasOwn(persisted.episode, 'purpose'))
    throw new Error('Unsupported saved Garage pause contract; start a fresh development database after resolving physical restoration');
}
export function validateSavedGarageHeatingHandover(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key =>
    !['version', 'id', 'adapterKey', 'targetIdentity', 'startedAt', 'targetC', 'phase', 'native', 'restorationAt'].includes(key))
    || value.version !== 2
    || !['clearing', 'off', 'restoring'].includes(value.phase)
    || typeof value.adapterKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.adapterKey)
    || typeof value.targetIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(value.targetIdentity)
    || typeof value.id !== 'string' || !value.id
    || !value.native || typeof value.native !== 'object' || Array.isArray(value.native)
    || Object.keys(value.native).some(key => !['mode', 'targetC', 'fan', 'vane', 'wideVane'].includes(key))
    || !(value.targetC === null || Number.isFinite(value.targetC)) || !finiteTime(value.startedAt)
    || value.restorationAt !== undefined && !finiteTime(value.restorationAt))
    throw new Error('Unsupported saved Garage heating handover; start a fresh development database after resolving physical restoration');
}
export const GARAGE_FIELDS = Object.freeze({
  indoorTemperature: { signal: 'garage_native_indoor_temperature', unit: 'degC', min: -60, max: 70 },
  outdoorTemperature: { signal: 'garage_native_outdoor_temperature', unit: 'degC', min: -80, max: 70 },
  power: { signal: 'garage_power', unit: 'W', min: 0, max: 20_000 },
  energy: { signal: 'garage_native_energy', unit: 'kWh', min: 0, max: 1e9 },
  compressorFrequency: { signal: 'garage_compressor_frequency', unit: 'Hz', min: 0, max: 300 },
  compressorActive: { signal: 'garage_compressor_active', unit: 'boolean', boolean: true },
  defrost: { signal: 'garage_native_defrost', unit: 'boolean', boolean: true },
  preheat: { signal: 'garage_native_preheat', unit: 'boolean', boolean: true },
  standby: { signal: 'garage_native_standby', unit: 'boolean', boolean: true },
  actualFan: { signal: 'garage_native_actual_fan', unit: 'stage', min: 0, max: 6 },
  energyCounterRaw: { signal: 'garage_native_energy_raw', unit: 'count', min: 0, max: 65_535 },
  faultRaw: { signal: 'garage_native_fault_raw', unit: null, string: true },
});
const topic = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[+#\u0000]/.test(value);
export function garageAdapterSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Garage adapter settings must be an object');
  const allowed = new Set(['driver', 'stateTopic', 'telemetryTopic', 'commandTopic', 'maxAgeMs', 'electricalSource']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('Unsupported garage adapter setting');
  const result = { driver: 'fixture', stateTopic: '', telemetryTopic: '', commandTopic: '', maxAgeMs: 120_000, electricalSource: 'none', ...input };
  if (!['fixture', 'shelly-cn105'].includes(result.driver)) throw new TypeError('Unsupported garage adapter driver');
  const topics = ['stateTopic', 'telemetryTopic', 'commandTopic'].map(key => {
    if (result[key] !== '' && !topic(result[key])) throw new TypeError(`Garage ${key} must be an exact MQTT topic`);
    return result[key];
  }).filter(Boolean);
  if (new Set(topics).size !== topics.length) throw new TypeError('Garage state, telemetry and command topics must differ');
  if (result.commandTopic && result.driver !== 'shelly-cn105') throw new TypeError('Unsupported command topic for fixture driver');
  if (result.commandTopic && !result.stateTopic) throw new TypeError('Garage command topic requires a state topic');
  if (!Number.isSafeInteger(result.maxAgeMs) || result.maxAgeMs < 1000 || result.maxAgeMs > 600_000) throw new RangeError('Garage adapter maximum age must be between 1 and 600 seconds');
  if (!['none', 'native-counter', 'native-power'].includes(result.electricalSource)) throw new TypeError('Unsupported garage electrical source');
  return result;
}
export const finiteTime = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
export function decodeGarageEnvelope(payload, { receivedAt, schema = GARAGE_FIXTURE_CONTRACT } = {}) {
  if (Buffer.byteLength(payload instanceof Uint8Array ? payload : String(payload ?? '')) > 32_768) return null;
  let value;
  try { value = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  value.timeBasis = 'source-measured';
  if (value.observedAt == null && finiteTime(value.observedAgeMs) && finiteTime(receivedAt)
    && value.observedAgeMs <= receivedAt) {
    value.observedAt = receivedAt - value.observedAgeMs;
    value.timeBasis = 'receipt-minus-source-age';
  }
  if (value.schema !== schema
    || !identity(value.deviceId) || !identity(value.bootId) || !finiteTime(value.observedAt)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  return value;
}
export function decodeGarageField(field, definition, { receivedAt, retained = false, maxAgeMs, bootId, schema = GARAGE_FIXTURE_CONTRACT }) {
  let timeBasis = 'source-measured';
  if (field?.measuredAt == null && finiteTime(field?.ageMs) && field.ageMs <= receivedAt) {
    field = { ...field, measuredAt: receivedAt - field.ageMs };
    timeBasis = 'receipt-minus-source-age';
  }
  const quality = schema === GARAGE_FIXTURE_CONTRACT ? ['provisional-contract'] : [];
  if (['unknown', 'observed-unverified', 'unsupported', 'invalid', 'stale'].includes(field?.quality)) quality.push(field.quality);
  if (timeBasis !== 'source-measured') quality.push('reconstructed-source-time');
  const supported = field?.supported === true;
  if (!supported) quality.push('unsupported');
  if (field?.decodeVerified !== true) quality.push('decoding-unverified');
  // The current publisher uses 'boolean' for actual true/false reports and
  // null only for absent boolean values. Missing data never implies false.
  const expectedUnit = definition.boolean && schema === SHELLY_CN105_CONTRACT && field?.value === null ? null : definition.unit;
  if (field?.unit !== expectedUnit) quality.push('units-unverified');
  if (!finiteTime(field?.measuredAt)) quality.push('source-time-unknown');
  else if (field.measuredAt > receivedAt) quality.push('future-source-time');
  else if (receivedAt - field.measuredAt >= maxAgeMs) quality.push('stale');
  if (retained) quality.push('retained');
  const validNumber = definition.string ? typeof field?.value === 'string' && /^[0-9a-f]{1,128}$/i.test(field.value)
    : definition.boolean ? typeof field?.value === 'boolean'
    : Number.isFinite(field?.value) && field.value >= definition.min && field.value <= definition.max;
  if (!validNumber) quality.push('invalid-value');
  // Reviewed decoder output may be displayed and charted without claiming
  // installed accuracy or promoting it to control/learning evidence.
  const diagnosticAvailable = !['unknown', 'unsupported', 'invalid', 'stale'].includes(field?.quality)
    && supported && field?.decodeVerified === true && field?.unit === expectedUnit && validNumber
    && finiteTime(field.measuredAt) && field.measuredAt <= receivedAt && receivedAt - field.measuredAt < maxAgeMs && !retained;
  return { signal: definition.signal, value: validNumber && supported && field?.unit === expectedUnit ? field.value : null,
    unit: definition.unit, sourceTime: finiteTime(field?.measuredAt) ? field.measuredAt : null, receivedAt,
    quality, supported, diagnosticAvailable, usable: diagnosticAvailable && field?.quality !== 'observed-unverified',
    bootId, timeBasis, accuracyVerified: field?.accuracyVerified === true,
    // Counter cadence must describe independent counter updates, not packet frequency.
    updateIntervalMs: Number.isSafeInteger(field?.updateIntervalMs) && field.updateIntervalMs > 0 ? field.updateIntervalMs : null,
    resolution: Number.isFinite(field?.resolution) && field.resolution > 0 ? field.resolution : null,
    counterEpoch: identity(field?.counterEpoch) ? field.counterEpoch : null,
    meterScope: field?.meterScope === 'garage-heat-pump-only' ? field.meterScope : 'unverified' };
}
export function freshField(field, now, maxAgeMs) {
  return field && finiteTime(field.measuredAt) && field.measuredAt <= now && now - field.measuredAt < maxAgeMs;
}
export function validFixtureState(value) {
  return identity(value.sessionId) && ['monitoring', 'commissioning', 'ready', 'maintenance'].includes(value.mode)
    && value.health && typeof value.health === 'object' && value.native && typeof value.native === 'object';
}
