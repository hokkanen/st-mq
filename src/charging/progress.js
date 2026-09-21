import { CHARGING_EFFICIENCY } from '../domain/charging-energy.js';

const finite = Number.isFinite;
const observedTime = value => finite(value) && value >= 0 ? value : null;

export function restoreChargingProgress(previous) {
  return previous?.version === 2 && typeof previous.reference?.key === 'string' ? structuredClone(previous) : null;
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
  const connectionAt = previous?.connected !== false ? previous?.connectionAt ?? now : now;
  const reference = same || connected === null && previous?.reference ? { ...previous.reference } : { key, at: Math.max(connectionAt, Math.min(now,
    automatic ? measuredAt ?? receivedAt ?? now : now)), soc: soc.value };
  const state = { version: 2, reference, connected, connectionAt, creditKwh: reference.key === previous?.reference?.key ? previous.creditKwh ?? 0 : 0 };
  let energy = null;
  if (connected !== false) {
    energy = readEnergy({ id: charger.id, start: reference.at, end: now });
    if (finite(energy?.gridKwh)) state.creditKwh = Math.max(state.creditKwh, energy.gridKwh);
  } else { state.reference = null; state.creditKwh = 0; }
  const capacity = charger.values.capacityKwh.value, efficiency = CHARGING_EFFICIENCY;
  const estimatedSoc = Math.min(100, reference.soc + state.creditKwh * efficiency / capacity * 100);
  const rawRequiredGridKwh = Math.max(0, charger.requiredGridKwh ?? 0);
  const remainingGridKwh = Math.max(0, capacity * (charger.values.minimumSoc.value - estimatedSoc) / 100 / efficiency);
  return { state, estimatedSoc, hasEnergyEstimate: state.creditKwh > .00001,
    connectionAt,
    estimatedSocSource: automatic ? 'vehicle' : 'starting-charge', anchorAt: reference.at,
    deliveredGridKwh: state.creditKwh, remainingGridKwh,
    basis: { source: state.creditKwh > 0 ? 'recorded-charger-energy' : 'soc',
      status: connected === false ? 'not-connected' : connected === null ? 'connection-unknown'
        : energy?.coveredMs > 0 ? 'tracking' : 'awaiting-recorded-energy',
      rawRequiredGridKwh, creditedGridKwh: state.creditKwh, referenceAt: reference.at,
      lastMeasuredAt: energy?.lastMeasuredAt ?? null, continuousSince: energy?.continuousSince ?? null,
      energyCoverageIncomplete: energy?.incomplete ?? false } };
}
