const MAX_GAP_MS = 120_000, HOUR = 3_600_000;
const finite = Number.isFinite;
const field = (charger, name) => charger.values?.[name] ?? {};
const observedTime = value => finite(value) && value >= 0 ? value : null;

function referenceFor(charger, now) {
  const soc = field(charger, 'soc'), measuredAt = observedTime(soc.measuredAt);
  const receivedAt = measuredAt === null ? observedTime(soc.receivedAt) : null;
  return {
    key: JSON.stringify([charger.id, soc.source, soc.readingId ?? null, soc.value,
      measuredAt, receivedAt, field(charger, 'capacityKwh').value,
      field(charger, 'minimumSoc').value, charger.configuration?.efficiency]),
    // A receipt timestamp bounds which later energy we can attribute. It is
    // never presented as the time the battery itself was measured.
    at: measuredAt ?? receivedAt ?? now,
  };
}

/** Keep earned credit on restart, but never integrate through an unobserved
 * process gap. Runtime restoration must use this before accepting new samples. */
export function restoreChargingProgress(previous) {
  if (!previous || typeof previous.reference?.key !== 'string') return null;
  return { reference: { key: previous.reference.key, at: observedTime(previous.reference.at) },
    creditKwh: finite(previous.creditKwh) && previous.creditKwh >= 0 ? previous.creditKwh : 0,
    lastSample: null, connected: typeof previous.connected === 'boolean' ? previous.connected : null };
}

/** Estimate delivered grid energy only between adjacent, fresh, attributable
 * power measurements. The SoC reading and its original clocks stay untouched.
 * State stays bounded: one reference, accumulated credit, and one power sample. */
export function updateChargingProgress(previous, charger, now) {
  if (!charger?.id || !finite(now)) throw new Error('Charging progress requires a charger and numeric UTC time');
  const rawRequiredGridKwh = finite(charger.requiredGridKwh) && charger.requiredGridKwh >= 0 ? charger.requiredGridKwh : 0;
  const connection = field(charger, 'connected');
  const connected = connection.available === true && typeof connection.value === 'boolean'
    && charger.telemetry?.providerConnected !== false ? connection.value : null;
  const reference = referenceFor(charger, now);
  const sameReference = previous?.reference?.key === reference.key;
  const state = { reference: sameReference ? { ...previous.reference } : reference,
    creditKwh: sameReference && finite(previous.creditKwh) ? Math.max(0, Math.min(rawRequiredGridKwh, previous.creditKwh)) : 0,
    lastSample: sameReference && previous.lastSample ? { ...previous.lastSample } : null, connected };
  const result = status => ({ state, remainingGridKwh: Math.max(0, rawRequiredGridKwh - state.creditKwh),
    basis: { source: state.creditKwh > 0 ? 'integrated-measured-power' : 'soc', status,
      rawRequiredGridKwh, creditedGridKwh: state.creditKwh,
      referenceAt: state.reference?.at ?? null, lastMeasuredAt: state.lastSample?.measuredAt ?? null,
      continuousSince: state.lastSample?.continuousSince ?? null } });
  if (connected === false) {
    state.reference = null; state.creditKwh = 0; state.lastSample = null;
    return result('not-connected');
  }
  if (connected !== true) { state.lastSample = null; return result('connection-unknown'); }
  const power = field(charger, 'powerKw'), measuredAt = observedTime(power.measuredAt);
  if (power.available !== true || power.assumed === true || !finite(power.value) || power.value < 0
    || power.value > 1000 || measuredAt === null || typeof power.source !== 'string' || !power.source) {
    state.lastSample = null;
    return result('power-measurement-unavailable');
  }
  if (measuredAt > now || now - measuredAt > MAX_GAP_MS) {
    state.lastSample = null;
    return result('power-measurement-not-current');
  }
  const sample = { measuredAt, powerKw: power.value, source: power.source, observedAt: now,
    continuousSince: Math.max(measuredAt, state.reference.at ?? measuredAt) };
  const last = state.lastSample;
  if (last && last.source === sample.source && measuredAt <= last.measuredAt) {
    // Duplicate and reordered deliveries never earn energy or refresh clocks.
    // Conflicting values for the same measurement revoke continuity entirely.
    if (measuredAt === last.measuredAt && sample.powerKw !== last.powerKw) state.lastSample = null;
    return result('awaiting-new-power-measurement');
  }
  state.lastSample = sample;
  if (!last || last.source !== sample.source || previous?.connected !== true)
    return result(sameReference ? 'awaiting-next-power-measurement' : 'reference-established');
  const duration = measuredAt - last.measuredAt;
  if (!(duration > 0) || duration > MAX_GAP_MS || !finite(last.observedAt)
    || now < last.observedAt || now - last.observedAt > MAX_GAP_MS)
    return result('measurement-gap');
  // Coverage distinguishes a fully observed zero-energy period from a period
  // with no usable measurements. Both have zero credit, but only the former is
  // evidence that the planned energy was not delivered.
  sample.continuousSince = Math.max(last.continuousSince ?? last.measuredAt, state.reference.at ?? 0);
  const start = Math.max(last.measuredAt, state.reference.at ?? now);
  if (start >= measuredAt) return result('awaiting-post-reference-measurement');
  const initialPower = last.powerKw + (power.value - last.powerKw) * (start - last.measuredAt) / duration;
  const energy = (initialPower + power.value) / 2 * (measuredAt - start) / HOUR;
  state.creditKwh = Math.min(rawRequiredGridKwh, state.creditKwh + energy);
  return result('tracking');
}
