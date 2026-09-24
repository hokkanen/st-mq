import { resolveChargingDeadline } from './settings.js';
import { TIME_ZONE } from '../domain/prices.js';
import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';
import { effectiveSoc } from './soc.js';

const automaticCapabilities = Object.freeze({ capacityKwh: false, soc: true, minimumSoc: false,
  connected: true, currentA: true, schedule: true });

/** Provider differences belong in declarations/adapters. Every downstream
 * consumer works with the same charger object and capability names. */
export const CHARGER_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'charger1', label: 'Charger 1', provider: 'easee',
    capabilities: Object.freeze({ scheduling: true, currentControl: false, externalLoadBalancing: true,
      automatic: automaticCapabilities }) }),
  Object.freeze({ id: 'charger2', label: 'Charger 2', provider: 'shelly-evse',
    capabilities: Object.freeze({ scheduling: true, currentControl: true, externalLoadBalancing: false,
      automatic: Object.freeze({ ...automaticCapabilities, minimumSoc: true }) }) }),
]);

const finite = Number.isFinite;
const validSoc = value => finite(value) && value >= 0 && value <= 100;
const time = value => finite(value) && value >= 0 ? value
  : typeof value === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value) && finite(Date.parse(value)) ? Date.parse(value) : null;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const unwrap = value => isObject(value) && Object.hasOwn(value, 'value') ? value.value : value;

/** Keep receipt and measurement clocks separate. Missing transport metadata
 * never turns into a fresh measurement just because a view was rebuilt. */
export function chargerValue(value, { source = 'unavailable', measuredAt = null, receivedAt = null, ...metadata } = {}) {
  return { value: value ?? null, source, measuredAt: time(measuredAt), receivedAt: time(receivedAt),
    available: value !== null && value !== undefined, assumed: false, ...metadata };
}

function automaticValue(telemetry, keys, source, valid) {
  for (const key of keys) {
    if (!Object.hasOwn(telemetry, key)) continue;
    const raw = telemetry[key], field = isObject(raw) && Object.hasOwn(raw, 'value') ? raw : {};
    const metadata = { ...(telemetry.fields?.[key] ?? {}), ...field };
    const value = unwrap(raw);
    // A canonical adapter field is authoritative, including unavailability.
    // Raw aliases retained for diagnostics must not revive an offline reading.
    if (metadata.available === false || !valid(value)) return chargerValue(null, {
      source: metadata.source ?? source, reason: metadata.reason ?? 'unavailable',
      measuredAt: metadata.measuredAt ?? metadata.sourceTime ?? null, receivedAt: metadata.receivedAt ?? null });
    return chargerValue(value, { ...metadata, source: metadata.source ?? source,
      measuredAt: metadata.measuredAt ?? metadata.sourceTime ?? null,
      receivedAt: metadata.receivedAt ?? null, available: true });
  }
  return chargerValue(null);
}
function withFallback(automatic, fallback) {
  return automatic.available ? automatic : chargerValue(fallback,
    { source: 'manual-fallback', assumed: true, automaticAvailable: false });
}
function maximumCurrent(telemetry, source) {
  if (telemetry.providerConnected === false) return chargerValue(null, { source, reason: 'provider-unavailable' });
  const supplied = automaticValue(telemetry, ['maximumCurrentA', 'maxCurrentA'], source, value => finite(value) && value >= 0 && value <= 200);
  const limits = ['chargerA', 'cableA', 'circuitA'].flatMap(key => {
    const limit = unwrap(telemetry.limits?.[key]);
    return Array.isArray(limit) && limit.length === 3 ? limit : [limit];
  }).filter(value => finite(value) && value >= 0 && value <= 200);
  if (supplied.available) limits.push(supplied.value);
  if (!limits.length) return chargerValue(null);
  return chargerValue(Math.min(...limits), { source, measuredAt: supplied.measuredAt,
    receivedAt: supplied.receivedAt ?? time(telemetry.readAt) });
}

export function buildCharger({ definition, settings, telemetry = {}, automaticSoc = null, targetSelection = null, configuration,
  now = Date.now(), control = null, deadlineAt, timezone = TIME_ZONE } = {}) {
  if (!definition?.id || !settings) throw new Error('A charger definition and its settings are required');
  const source = telemetry.source ?? definition.provider ?? 'charger';
  const capabilities = { ...definition.capabilities, ...telemetry.capabilities,
    automatic: { ...definition.capabilities?.automatic, ...telemetry.capabilities?.automatic } };
  const automatic = {
    capacityKwh: automaticValue(telemetry, ['capacityKwh', 'usableCapacityKwh'], source, value => finite(value) && value >= 1 && value <= 300),
    soc: automaticValue(telemetry, ['soc', 'batteryLevel'], source, validSoc),
    minimumSoc: automaticValue(telemetry, ['minimumSoc', 'chargeLimitSoc'], source, validSoc),
  };
  for (const [key, field, valid] of [['soc', 'soc', validSoc], ['capacityKwh', 'usableCapacityKwh', item => finite(item) && item >= 1 && item <= 300],
    ['minimumSoc', 'chargeLimitSoc', validSoc]]) if (valid(automaticSoc?.[field])) {
    const mqtt = chargerValue(automaticSoc[field], { ...automaticSoc, ...automaticSoc.fields?.[field],
      source: automaticSoc.source ?? 'mqtt' });
    const observedAt = item => item.measuredAt ?? item.receivedAt ?? -Infinity;
    if (!automatic[key].available || observedAt(mqtt) >= observedAt(automatic[key])) automatic[key] = mqtt;
    capabilities.automatic[key] = true;
  }
  for (const [key, field] of Object.entries(automatic)) if (field.available) capabilities.automatic[key] = true;
  const selectedSoc = effectiveSoc({ automatic: automatic.soc.available
    ? { ...automatic.soc, soc: automatic.soc.value } : null, fallbackSoc: settings.manualSoc });
  const values = {
    capacityKwh: withFallback(automatic.capacityKwh, telemetry.vehicleCapacityFallbackKwh ?? settings.capacityKwh),
    soc: chargerValue(selectedSoc.soc, { ...selectedSoc, automaticAvailable: automatic.soc.available }),
    minimumSoc: targetSelection?.selected ? chargerValue(targetSelection.selected.value, targetSelection.selected)
      : withFallback(automatic.minimumSoc, settings.minimumSoc),
    connected: automaticValue(telemetry, ['connected', 'pluggedIn'], source, value => typeof value === 'boolean'),
    currentA: automaticValue(telemetry, ['currentA', 'requestedCurrentA'], source, value => finite(value) && value >= 0 && value <= 200),
    availableCurrentA: automaticValue(telemetry, ['availableCurrentA'], source, value => finite(value) && value >= 0 && value <= 1000),
    actualCurrentA: automaticValue(telemetry, ['actualCurrentA'], source, value => finite(value) && value >= 0 && value <= 200),
    maximumCurrentA: maximumCurrent(telemetry, source),
    nativeCurrentA: chargerValue(control?.manualCurrentA ?? null, { source: 'evse-native-current' }),
    vehicleCurrentA: telemetry.vehicleCurrentA ?? chargerValue(null),
    vehicleNotBefore: telemetry.vehicleNotBefore ?? chargerValue(null),
    vehicleCeilingSoc: telemetry.vehicleCeilingSoc ?? chargerValue(null),
    phases: chargerValue(3, { source: 'installation-assumption', assumed: true }),
    voltageV: automaticValue(telemetry, ['voltageV'], source, value => finite(value) && value >= 200 && value <= 250),
    scheduledStartAt: automaticValue(telemetry, ['scheduledStartAt'], source, value => time(value) !== null),
    scheduledEndAt: automaticValue(telemetry, ['scheduledEndAt'], source, value => time(value) !== null),
    charging: automaticValue(telemetry, ['charging'], source, value => typeof value === 'boolean'),
    powerKw: automaticValue(telemetry, ['powerKw'], source, value => finite(value) && value >= 0 && value <= 1000),
  };
  for (const key of ['scheduledStartAt', 'scheduledEndAt']) if (values[key].available) values[key].value = time(values[key].value);
  // A vehicle observed away from this property cannot be counted as its load.
  if (unwrap(telemetry.atHome) === false) values.connected = chargerValue(false, { source,
    measuredAt: telemetry.fields?.atHome?.sourceTime, receivedAt: telemetry.fields?.atHome?.receivedAt });
  else if (Object.hasOwn(telemetry, 'atHome') && unwrap(telemetry.atHome) !== true && values.connected.value === true)
    values.connected = chargerValue(null, { reason: 'property-location-unknown' });
  const requiredGridKwh = values.capacityKwh.value * Math.max(0, values.minimumSoc.value - values.soc.value) / 100 / CHARGING_EFFICIENCY;
  return { id: definition.id, label: definition.label ?? definition.id, provider: definition.provider ?? source,
    capabilities, settings: structuredClone(settings), targetSelection, configuration: { efficiency: CHARGING_EFFICIENCY }, values, automatic, requiredGridKwh,
    deadlineAt: finite(deadlineAt) ? deadlineAt : resolveChargingDeadline(now, settings.readyBy, timezone),
    control, telemetry };
}
