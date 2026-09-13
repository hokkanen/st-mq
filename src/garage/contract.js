// This is a host-side simulation vocabulary, NOT a published Pill protocol.
// Adding a real driver requires a separate reviewed contract implementation.
export const GARAGE_FIXTURE_CONTRACT = 'stmq-garage-fixture/v1';
export const GARAGE_CONTRACT_STATUS = 'provisional-fixture-only';
export const GARAGE_FIELDS = Object.freeze({
  indoorTemperature: { signal: 'garage_native_indoor_temperature', unit: 'degC', min: -60, max: 70 },
  outdoorTemperature: { signal: 'garage_native_outdoor_temperature', unit: 'degC', min: -80, max: 70 },
  power: { signal: 'garage_power', unit: 'W', min: 0, max: 20_000 },
  energy: { signal: 'garage_native_energy', unit: 'kWh', min: 0, max: 1e9 },
  compressorFrequency: { signal: 'garage_compressor_frequency', unit: 'Hz', min: 0, max: 300 },
  compressorActive: { signal: 'garage_compressor_active', unit: 'boolean', boolean: true },
  defrost: { signal: 'garage_native_defrost', unit: 'boolean', boolean: true },
});
const topic = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[+#\u0000]/.test(value);
export function garageAdapterSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Garage adapter settings must be an object');
  const allowed = new Set(['stateTopic', 'telemetryTopic', 'maxAgeMs', 'electricalSource']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError('Unsupported garage adapter setting; a real control contract is not installed');
  const result = { stateTopic: '', telemetryTopic: '', maxAgeMs: 120_000, electricalSource: 'none', ...input };
  for (const key of ['stateTopic', 'telemetryTopic']) if (result[key] !== '' && !topic(result[key])) throw new TypeError(`Garage ${key} must be an exact MQTT topic`);
  if (result.stateTopic && result.stateTopic === result.telemetryTopic) throw new TypeError('Garage state and telemetry topics must differ');
  if (!Number.isSafeInteger(result.maxAgeMs) || result.maxAgeMs < 1000 || result.maxAgeMs > 600_000) throw new RangeError('Garage adapter maximum age must be between 1 and 600 seconds');
  if (!['none', 'native-counter', 'native-power'].includes(result.electricalSource)) throw new TypeError('Unsupported garage electrical source');
  return result;
}
export const finiteTime = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value);
export function decodeGarageEnvelope(payload, { receivedAt } = {}) {
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
  if (value.schema !== GARAGE_FIXTURE_CONTRACT
    || !identity(value.deviceId) || !identity(value.bootId) || !finiteTime(value.observedAt)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  return value;
}
export function decodeGarageField(field, definition, { receivedAt, retained = false, maxAgeMs, bootId }) {
  let timeBasis = 'source-measured';
  if (field?.measuredAt == null && finiteTime(field?.ageMs) && field.ageMs <= receivedAt) {
    field = { ...field, measuredAt: receivedAt - field.ageMs };
    timeBasis = 'receipt-minus-source-age';
  }
  const quality = ['provisional-contract'];
  if (timeBasis !== 'source-measured') quality.push('reconstructed-source-time');
  const supported = field?.supported === true;
  if (!supported) quality.push('unsupported');
  if (field?.decodeVerified !== true) quality.push('decoding-unverified');
  if (field?.unit !== definition.unit) quality.push('units-unverified');
  if (!finiteTime(field?.measuredAt)) quality.push('source-time-unknown');
  else if (field.measuredAt > receivedAt) quality.push('future-source-time');
  else if (receivedAt - field.measuredAt >= maxAgeMs) quality.push('stale');
  if (retained) quality.push('retained');
  const validNumber = definition.boolean ? typeof field?.value === 'boolean'
    : Number.isFinite(field?.value) && field.value >= definition.min && field.value <= definition.max;
  if (!validNumber) quality.push('invalid-value');
  const usable = supported && field?.decodeVerified === true && field?.unit === definition.unit && validNumber
    && finiteTime(field.measuredAt) && field.measuredAt <= receivedAt && receivedAt - field.measuredAt < maxAgeMs && !retained;
  return { signal: definition.signal, value: validNumber && supported && field?.unit === definition.unit ? field.value : null,
    unit: definition.unit, sourceTime: finiteTime(field?.measuredAt) ? field.measuredAt : null, receivedAt,
    quality, supported, usable, bootId, timeBasis, accuracyVerified: field?.accuracyVerified === true,
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
  return identity(value.sessionId) && ['monitoring', 'commissioning', 'armed', 'maintenance'].includes(value.mode)
    && value.health && typeof value.health === 'object' && value.native && typeof value.native === 'object';
}
