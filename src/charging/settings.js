import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';

const chargerDefaults = capacityKwh => Object.freeze({
  enabled: false, readyBy: '06:00', capacityKwh, minimumSoc: 80, manualSoc: 40,
});

/** Durable user preferences only. Connections and conversion assumptions belong
 * to application configuration; electrical limits are provider observations. */
export const DEFAULT_CHARGING_SETTINGS = Object.freeze({ chargers: Object.freeze({
  charger1: chargerDefaults(74), charger2: chargerDefaults(57),
}) });

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

export function chargingSettings(input = {}) {
  object(input, 'Charging settings'); knownKeys(input, DEFAULT_CHARGING_SETTINGS, 'charging setting');
  if (input.chargers !== undefined) object(input.chargers, 'Charging chargers');
  knownKeys(input.chargers ?? {}, DEFAULT_CHARGING_SETTINGS.chargers, 'charger');
  const result = { chargers: {} };
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
  return chargingSettings({ ...previous, ...patch, chargers });
}

/** Retain user choices while discarding the removed installation/connection
 * controls. Saved overrides never retain priority over automatic readings. */
export function migrateChargingSettings(saved = {}) {
  object(saved, 'Charging settings');
  const chargers = {};
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_SETTINGS.chargers)) {
    const before = saved.chargers?.[id] ?? (id === 'charger1' ? { ...saved, capacityKwh: saved.capacity1Kwh }
      : { capacityKwh: saved.capacity2Kwh });
    chargers[id] = Object.fromEntries(Object.keys(defaults).filter(key => before[key] !== undefined).map(key => [key, before[key]]));
  }
  return chargingSettings({ chargers });
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
