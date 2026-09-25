import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';

export const DEFAULT_CHARGING_DEFAULTS = Object.freeze({
  readyBy: '06:00', manualSoc: 20, minimumSoc: 80, capacityKwh: 74,
});
const chargerDefaults = Object.freeze({ enabled: false, ...DEFAULT_CHARGING_DEFAULTS });

// Validated runtime values derived from configuration, never a separate saved
// preference source. Both unidentified charging points use the same defaults.
export const DEFAULT_CHARGING_SETTINGS = Object.freeze({ priority: 'balanced', vehicles: Object.freeze({
  tesla: Object.freeze({ ...DEFAULT_CHARGING_DEFAULTS, capacityKwh: 57 }),
  bmw: Object.freeze({ ...DEFAULT_CHARGING_DEFAULTS, capacityKwh: 74 }),
}), chargers: Object.freeze({ charger1: chargerDefaults, charger2: chargerDefaults }) });

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function knownKeys(value, defaults, label) {
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown ${label}: ${key}`);
}
function range(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Charging ${name} must be between ${min} and ${max}`);
}
const validReadyBy = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function chargingDefaults(input = {}, { partial = false } = {}) {
  object(input, 'Charging defaults'); knownKeys(input, DEFAULT_CHARGING_DEFAULTS, 'charging default');
  const value = partial ? { ...input } : { ...DEFAULT_CHARGING_DEFAULTS, ...input };
  if (Object.hasOwn(value, 'readyBy') && !validReadyBy(value.readyBy)) throw new Error('Charging readyBy must be HH:mm');
  for (const key of ['manualSoc', 'minimumSoc', 'capacityKwh']) if (Object.hasOwn(value, key))
    range(value[key], key, key === 'capacityKwh' ? 1 : 0, key === 'capacityKwh' ? 300 : 100);
  return value;
}

/** Resolve the config-owned baseline. Vehicle identity and session overrides
 * are applied by the runtime, with observations retaining their provenance. */
export function chargingSettingsFromConfiguration(configuration) {
  const defaults = chargingDefaults(configuration.defaults);
  return chargingSettings({
    priority: configuration.priority,
    vehicles: Object.fromEntries(Object.entries(configuration.vehicles).map(([id, vehicle]) =>
      [id, { ...defaults, ...vehicle.defaults }])),
    chargers: Object.fromEntries(Object.entries(configuration.chargers).map(([id, charger]) =>
      [id, { enabled: charger.schedulingEnabled, ...defaults }])),
  });
}

export function chargingSettings(input = {}) {
  object(input, 'Charging settings'); knownKeys(input, DEFAULT_CHARGING_SETTINGS, 'charging setting');
  if (input.chargers !== undefined) object(input.chargers, 'Charging chargers');
  knownKeys(input.chargers ?? {}, DEFAULT_CHARGING_SETTINGS.chargers, 'charger');
  if (!['balanced', 'charger1', 'charger2'].includes(input.priority ?? 'balanced')) throw new Error('Invalid charging priority');
  object(input.vehicles ?? {}, 'Vehicle profiles'); knownKeys(input.vehicles ?? {}, DEFAULT_CHARGING_SETTINGS.vehicles, 'vehicle');
  const vehicles = {};
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_SETTINGS.vehicles)) {
    const supplied = input.vehicles?.[id] ?? {}; object(supplied, 'Vehicle profile'); knownKeys(supplied, defaults, 'vehicle profile setting');
    vehicles[id] = chargingDefaults({ ...defaults, ...supplied });
  }
  const result = { priority: input.priority ?? 'balanced', vehicles, chargers: {} };
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_SETTINGS.chargers)) {
    const supplied = input.chargers?.[id] ?? {};
    object(supplied, `Charging ${id}`); knownKeys(supplied, defaults, `charging ${id} setting`);
    const value = { ...defaults, ...supplied };
    if (typeof value.enabled !== 'boolean') throw new Error(`Charging ${id} enabled must be boolean`);
    if (!validReadyBy(value.readyBy)) throw new Error(`Charging ${id} readyBy must be HH:mm`);
    range(value.minimumSoc, `${id} minimumSoc`, 0, 100);
    range(value.manualSoc, `${id} manualSoc`, 0, 100);
    range(value.capacityKwh, `${id} capacityKwh`, 1, 300);
    result.chargers[id] = value;
  }
  return result;
}

export function mergeChargingSettings(previous, patch) {
  object(patch, 'Charging settings');
  if (patch.chargers !== undefined) object(patch.chargers, 'Charging chargers');
  const chargers = { ...previous.chargers };
  for (const [id, item] of Object.entries(patch.chargers ?? {})) {
    object(item, `Charging ${id}`); chargers[id] = { ...chargers[id], ...item };
  }
  const vehicles = Object.fromEntries(Object.entries(previous.vehicles).map(([id, value]) => [id, { ...value, ...patch.vehicles?.[id] }]));
  for (const id of Object.keys(patch.vehicles ?? {})) if (!Object.hasOwn(vehicles, id)) throw new Error('Unknown vehicle profile');
  return chargingSettings({ ...previous, ...patch, vehicles, chargers });
}

/** Concrete next ready-by occurrence in ST-MQ's local timezone. Pure callers
 * may specify a timezone when checking DST behavior. */
export function resolveChargingDeadline(now, readyBy = '06:00', timezone = TIME_ZONE) {
  if (!Number.isFinite(now)) throw new Error('Charging deadline requires numeric UTC time');
  if (!validReadyBy(readyBy) || !moment.tz.zone(timezone)) throw new Error('Invalid charging deadline time or timezone');
  const day = moment.tz(now, timezone).startOf('day');
  const occurrence = date => moment.tz(`${date.format('YYYY-MM-DD')} ${readyBy}`, 'YYYY-MM-DD HH:mm', true, timezone).valueOf();
  let result = occurrence(day);
  if (result <= now) result = occurrence(day.add(1, 'day'));
  return result;
}
