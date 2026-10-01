/** The bounded recorder tail is durable measured energy, not extrapolation.
 * Historical queries may use it only after both measurement and receipt. */
export function pendingEnergyObservations(store, { now, input, prefix, source, device } = {}) {
  if (!Number.isSafeInteger(now)) throw new TypeError('Pending energy requires an explicit receipt cutoff');
  const rows = [];
  for (const row of store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%'").iterate()) {
    let identity, state;
    try { identity = JSON.parse(row.key.slice('recorder:energy:'.length)); state = JSON.parse(row.value); } catch { continue; }
    if (!Array.isArray(identity) || identity.length !== 3
      || identity.some(value => typeof value !== 'string' || !value.trim() || value.length > 1024)) continue;
    const [s, d, p] = identity, pending = state?.pending;
    if (source !== undefined && s !== source || device != null && d !== device || prefix !== undefined && p !== prefix
      || input !== undefined && (input === 'simulated') !== (s === 'simulation')) continue;
    const signalPrefix = p === 'ev2-phase' ? 'ev2' : p;
    const signals = ['ev2', 'caravan'].includes(p) ? [`${p}_energy`]
      : ['ev1', 'property', 'ev2-phase'].includes(p) ? [1, 2, 3].map(n => `${signalPrefix}_energy_l${n}`) : null;
    if (!signals || !pending || !Number.isSafeInteger(pending.start) || !Number.isSafeInteger(pending.end)
      || pending.end <= pending.start || pending.end > now || !Number.isSafeInteger(pending.receivedAt)
      || pending.receivedAt < pending.end || pending.receivedAt > now || !Array.isArray(pending.energies) || pending.energies.length !== signals.length
      || pending.energies.some(value => !Number.isFinite(value) || value < 0) || !Array.isArray(pending.quality)
      || pending.quality.some(value => typeof value !== 'string')) continue;
    const basis = p === 'ev2' ? 'native-meter-counter-delta' : p === 'caravan' ? 'meter-counter-delta'
      : p === 'ev2-phase' ? 'native-meter-counter-phase-allocation' : 'integrated-power-phase-allocation';
    for (let i = 0; i < signals.length; i++) rows.push({ source: s, device: d, signal: signals[i],
      value: pending.energies[i], unit: 'kWh', source_time: pending.end, received_at: pending.receivedAt,
      quality: JSON.stringify(pending.quality), raw: JSON.stringify({ intervalStart: pending.start, intervalEnd: pending.end,
        durationMs: pending.end - pending.start, basis, pending: true,
        ...(['cloud','ocpp'].includes(pending.transport) ? {transport:pending.transport} : {}),
        ...(p === 'caravan' ? { learningRole: 'history-only' } : {}) }) });
  }
  return rows;
}
