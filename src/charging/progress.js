import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';

const finite = Number.isFinite;
const observedTime = value => finite(value) && value >= 0 ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const batterySources = new Set(['teslamate', 'bmw-cardata', 'bmw-target-filter']);

export function validateChargingProgress(previous) {
  if (previous == null) return;
  if (!object(previous) || previous.version !== 2
    || previous.reference !== null && (!object(previous.reference) || typeof previous.reference.key !== 'string'))
    throw new Error('Unsupported charging progress; start a fresh development database');
  const saved = previous.batteryInputs;
  if (saved === undefined || saved === null) return;
  const fieldValid = (field, key) => object(field)
    && Object.keys(field).sort().join(',') === 'measuredAt,receivedAt,source,value'
    && batterySources.has(field.source) && finite(field.value)
    && (key === 'minimumSoc' ? field.value >= 0 && field.value <= 100 : field.value >= 1 && field.value <= 300)
    && ['measuredAt', 'receivedAt'].every(key => field[key] === null || Number.isSafeInteger(field[key]) && field[key] >= 0);
  if (!object(saved) || typeof saved.scope !== 'string' || !saved.scope.length
    || Object.keys(saved).some(key => !['scope', 'minimumSoc', 'capacityKwh'].includes(key))
    || ['minimumSoc', 'capacityKwh'].some(key => saved[key] !== undefined && !fieldValid(saved[key], key)))
    throw new Error('Unsupported charging battery reference; start a fresh development database');
}

export function restoreChargingProgress(previous) {
  validateChargingProgress(previous);
  return previous == null ? null : structuredClone(previous);
}

// A saved vehicle setting is a scoped planning reference, never fresh vehicle
// telemetry or actuator authority. Retain target and capacity together with the
// charge anchor so feed loss cannot combine an observed 96% with a default 80%.
function sessionBatteryInputs(previous, charger, scope, connected) {
  const usable = scope !== null && connected !== false && previous?.connected !== false;
  const saved = usable && previous?.batteryInputs?.scope === scope ? previous.batteryInputs : null;
  const batteryInputs = scope !== null && connected !== false ? { scope } : null;
  const values = {};
  for (const key of ['minimumSoc', 'capacityKwh']) {
    const field = charger.values[key];
    const observed = batteryInputs && batterySources.has(field.source) && field.available !== false && !field.retainedForSession;
    const reference = observed ? { value: field.value, source: field.source,
      measuredAt: observedTime(field.measuredAt), receivedAt: observedTime(field.receivedAt) } : saved?.[key];
    if (reference && batteryInputs) batteryInputs[key] = { ...reference };
    values[key] = reference && (field.source === 'manual-fallback' || field.retainedForSession)
      ? { ...reference, available: true, assumed: true, retainedForSession: true } : field;
  }
  return { batteryInputs, values };
}

/** Keep the raw vehicle reading intact. A separate estimate advances from that
 * reading (or starting charge) using the recorder's existing grid energy.
 * Capacity and target changes preserve delivered energy. */
export function updateChargingProgress(previous, charger, now, readEnergy = () => null) {
  if (!charger?.id || !finite(now)) throw new Error('Charging progress requires a charger and numeric UTC time');
  const soc = charger.values.soc, connection = charger.values.connected;
  const connected = connection.available && typeof connection.value === 'boolean'
    && charger.telemetry?.providerConnected !== false ? connection.value : null;
  const automatic = soc.source !== 'manual-fallback';
  const measuredAt = observedTime(soc.measuredAt), receivedAt = observedTime(soc.receivedAt);
  // Receipt-only change feeds cannot establish a newer unchanged battery
  // measurement. A retained replay must not erase energy-based progress.
  const key = JSON.stringify([charger.id, soc.source, soc.value, measuredAt,
    measuredAt === null && soc.timeBasis !== 'receipt-only' ? soc.readingId ?? null : null]);
  const same = previous?.reference?.key === key && previous.connected !== false;
  const vehicle = charger.telemetry?.vehicle;
  const vehicleScope = vehicle?.state === 'identified' && vehicle.id && vehicle.sessionId
    ? `${vehicle.id}:${vehicle.sessionId}` : null;
  const battery = sessionBatteryInputs(previous, charger, vehicleScope, connected);
  // Losing a vehicle feed is not a new battery measurement. Keep this
  // identified connection's last anchor and measured energy until a new
  // reading or an explicit starting-charge edit replaces them. A remembered
  // manual default may otherwise falsely report the battery already full.
  const retainedVehicleReference = connected !== false && previous?.connected !== false
    && soc.source === 'manual-fallback' && vehicleScope !== null
    && previous?.reference?.vehicleScope === vehicleScope
    && previous.reference.source !== 'manual-fallback' && previous.reference.source !== 'session-anchor'
    && finite(charger.settings?.manualSoc) && previous.reference.fallbackSoc === charger.settings.manualSoc;
  const connectionAt = previous?.connected !== false ? previous?.connectionAt ?? now : now;
  const reference = same || retainedVehicleReference || connected === null && previous?.reference ? { ...previous.reference }
    : { key, at: Math.max(connectionAt, Math.min(now, automatic ? measuredAt ?? receivedAt ?? now : now)),
      soc: soc.value, source: soc.source, measuredAt, receivedAt, vehicleScope, fallbackSoc: charger.settings?.manualSoc };
  if (same && automatic) Object.assign(reference, { source: soc.source, measuredAt, receivedAt,
    vehicleScope, fallbackSoc: charger.settings?.manualSoc });
  const state = { version: 2, reference, connected, connectionAt, batteryInputs: battery.batteryInputs,
    creditKwh: reference.key === previous?.reference?.key ? previous.creditKwh ?? 0 : 0 };
  let energy = null;
  if (connected !== false) {
    energy = readEnergy({ id: charger.id, start: reference.at, end: now });
    if (finite(energy?.gridKwh)) state.creditKwh = Math.max(state.creditKwh, energy.gridKwh);
  } else { state.reference = null; state.creditKwh = 0; }
  const capacity = battery.values.capacityKwh.value, efficiency = CHARGING_EFFICIENCY;
  const estimatedSoc = Math.min(100, reference.soc + state.creditKwh * efficiency / capacity * 100);
  const rawRequiredGridKwh = Math.max(0, charger.requiredGridKwh ?? 0);
  const remainingGridKwh = Math.max(0, capacity * (battery.values.minimumSoc.value - estimatedSoc) / 100 / efficiency);
  return { state, estimatedSoc, hasEnergyEstimate: state.creditKwh > .00001,
    batteryValues: battery.values,
    retainedVehicleReference, referenceSoc: { value: reference.soc, source: reference.source,
      measuredAt: reference.measuredAt, receivedAt: reference.receivedAt },
    connectionAt,
    estimatedSocSource: ['manual-fallback', 'session-anchor'].includes(reference.source ?? soc.source) ? 'starting-charge' : 'vehicle', anchorAt: reference.at,
    deliveredGridKwh: state.creditKwh, remainingGridKwh,
    basis: { source: state.creditKwh > 0 ? 'recorded-charger-energy' : 'soc',
      status: connected === false ? 'not-connected' : connected === null ? 'connection-unknown'
        : energy?.coveredMs > 0 ? 'tracking' : 'awaiting-recorded-energy',
      rawRequiredGridKwh, creditedGridKwh: state.creditKwh, referenceAt: reference.at,
      lastMeasuredAt: energy?.lastMeasuredAt ?? null, continuousSince: energy?.continuousSince ?? null,
      energyCoverageIncomplete: energy?.incomplete ?? false } };
}
