const ROLES = ['garage', 'heat_savings', 'caravan'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const number = (value, fallback, min, max) => {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error('Shelly numeric setting is outside supported bounds');
  return result;
};

export function shellyConfiguration(input = {}) {
  if (!plain(input) || Object.keys(input).some(key => ![...ROLES, 'poll_seconds', 'max_age_seconds'].includes(key)))
    throw new Error('Shelly configuration must contain supported device roles');
  const pollIntervalMs = Math.round(number(input.poll_seconds, 30, 5, 300) * 1000);
  const maxAgeMs = Math.round(number(input.max_age_seconds, 120, 30, 900) * 1000);
  if (maxAgeMs < pollIntervalMs * 2) throw new Error('Shelly maximum age must allow at least two polls');
  const devices = [];
  for (const role of ROLES) {
    const value = input[role] ?? {};
    if (!plain(value) || Object.keys(value).some(key => !['enabled', 'generation', 'topic_prefix', 'switch_id', 'temperature_id',
      'controls_heat', 'reduction_on', 'nominal_voltage'].includes(key))) throw new Error('Invalid Shelly device setting');
    if (value.enabled != null && typeof value.enabled !== 'boolean') throw new Error('Shelly enabled must be a boolean');
    if (!value.enabled) continue;
    const prefix = value.topic_prefix;
    if (typeof prefix !== 'string' || !prefix.trim() || prefix !== prefix.trim() || prefix.length > 200
      || /[+#\u0000\s]/.test(prefix) || prefix.startsWith('/') || prefix.endsWith('/')) throw new Error('Shelly requires an exact MQTT topic prefix');
    const generation = value.generation ?? 2;
    if (![1, 2, 3, 4].includes(generation)) throw new Error('Shelly generation must be 1, 2, 3 or 4');
    for (const key of ['controls_heat', 'reduction_on'])
      if (value[key] != null && typeof value[key] !== 'boolean') throw new Error('Shelly relay settings must be booleans');
    const switchId = number(value.switch_id, 0, 0, 3), temperatureId = number(value.temperature_id, generation === 1 ? 0 : 100, 0, 255);
    if (!Number.isInteger(switchId) || !Number.isInteger(temperatureId)) throw new Error('Shelly component IDs must be integers');
    const controlsHeat = value.controls_heat ?? role === 'heat_savings';
    if (role === 'caravan' && controlsHeat) throw new Error('The Caravan plug cannot control heating');
    devices.push({ role, prefix, generation, switchId, temperatureId, controlsHeat,
      reductionOn: value.reduction_on ?? true, nominalVoltage: number(value.nominal_voltage, 230, 100, 260) });
  }
  if (devices.some((device, i) => devices.some((other, j) => i !== j
    && (other.prefix === device.prefix || other.prefix.startsWith(`${device.prefix}/`)))))
    throw new Error('Shelly device topic prefixes must be distinct and non-overlapping');
  return { devices, pollIntervalMs, maxAgeMs };
}
