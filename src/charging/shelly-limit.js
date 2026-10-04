const vector = values => Array.isArray(values) && values.length === 3 && values.every(v => Number.isFinite(v) && v >= 0 && v <= 1000);
/** The pilot advertises available current; a vehicle can choose a smaller
 * positive draw. Preserve a zero restriction, but do not turn a 1–5 A vehicle
 * setting into an EVSE stop merely because the smallest valid pilot is 6 A.
 * Electrical, native and shared-allocation ceilings are never rounded up. */
export function vehiclePilotLimit(vehicleCurrentA, minimumCurrentA) {
  return Number.isFinite(vehicleCurrentA) && vehicleCurrentA >= 0
    ? vehicleCurrentA === 0 ? 0 : Math.max(minimumCurrentA, vehicleCurrentA) : null;
}
const times = (input, now) => Array.isArray(input?.times) && input.times.length === 3
  && input.times.every(at => Number.isFinite(at) && at > 0 && at <= now);
// Stream fields are held state: their last-change clocks need not advance.
// Admission requires a synchronized current connection and the provider's online
// state, not a fresh timestamp manufactured by reading an old cache.
const feedUsable = (input, now) => input?.healthy === true && vector(input.currents) && times(input, now)
  && input.evidence?.connected === true && input.evidence.online === true && input.evidence.synchronized === true
  && input.evidence.epoch != null
  && (input.evidence.source !== 'easee-ocpp' || Number.isFinite(input.evidence.activityAt)
    && input.evidence.activityAt <= now && now - input.evidence.activityAt <= 120_000);
/** Conservative common Shelly current; no Shelly/Easee phase correspondence. */
export function shellyCurrentLimit({ config, property, easee, allowance, shelly, now, priority, liveUnscheduled = false, peerDemandA = null,
  reservationA = 0, vehicleCurrentA = null, nativeCurrentA = null, allocationA = null } = {}) {
  // Charger 1's Equalizer yields to Shelly in this priority. A forecast's
  // conservative household scenario or deadline reservation is not a native
  // restriction on Shelly's independently measured live entitlement.
  if (priority === 'charger2') { allocationA = null; reservationA = 0; }
  const shareLive = priority === 'balanced' && liveUnscheduled === true;
  const peerFirstLive = priority === 'charger1' && liveUnscheduled === true;
  if (shareLive || peerFirstLive) { allocationA = null; reservationA = 0; }
  const vehiclePilotA = vehiclePilotLimit(vehicleCurrentA, config.minimumCurrentA);
  const knownCeilings = [config.maximumCurrentA, vehiclePilotA, nativeCurrentA, allocationA].filter(v => Number.isFinite(v) && v >= 0);
  const known = Math.min(...knownCeilings);
  const shellyUsable = shelly?.healthy === true && vector(shelly.currents) && times(shelly, now)
    && shelly.times.every(at => now - at <= config.maxAgeMs);
  const propertyUsable = [property, easee].every(input => feedUsable(input, now)) && shellyUsable;
  const coherent = propertyUsable && feedUsable(allowance, now);
  let ceiling, reason, base = null, headroom = null, fallback = !coherent;
  let fallbackReason = !shellyUsable ? 'shelly-current-unavailable'
    : ![property, easee, allowance].every(input => input?.evidence?.synchronized === true) ? 'feed-unsynchronized'
      : !coherent ? 'feed-unavailable' : null;
  let loadCeiling = config.maximumCurrentA, loadReason = 'hardware-restriction';
  if (propertyUsable) {
    const common = Math.min(...shelly.currents);
    base = property.currents.map((p, i) => p - easee.currents[i] - common);
    // Negative residual is evidence against this model, not a free capacity grant.
    if (base.some(v => v < -.25)) { fallback = true; fallbackReason = 'non-additive-currents'; }
    else {
      headroom = base.map((b, i) => config.mainFuseA[i] - config.marginA[i] - Math.max(0, b));
      const disagreement = coherent && allowance.currents.some((a, i) => Math.abs(a - Math.max(0,
        config.mainFuseA[i] - property.currents[i] + easee.currents[i])) > config.agreementToleranceA);
      // Allow a small reserve/quantization difference. Larger discrepancies in
      // either direction can mean one held field missed a real load change.
      // Zero may be clipped after excess caused by Easee: it checks consistency,
      // not exact gross capacity, and does not double-count our safety margin.
      if (disagreement) { fallback = true; fallbackReason = 'allowance-disagreement'; }
      loadCeiling = Math.min(config.maximumCurrentA, ...headroom);
      loadReason = loadCeiling < config.maximumCurrentA ? 'fuse-limit' : 'hardware-restriction';
      if (Number.isFinite(allocationA) && allocationA >= 0 && allocationA < loadCeiling) {
        loadCeiling = allocationA; loadReason = 'priority-allocation';
      }
      ceiling = Math.min(known, loadCeiling);
      reason = ceiling < known ? loadReason : known === allocationA ? 'priority-allocation'
        : known === nativeCurrentA ? 'native-current-limit' : known === vehiclePilotA ? 'vehicle-current-limit' : loadReason;
      if (shareLive) {
        const shares = headroom.map((available, phase) => {
          const peer = Math.max(easee.currents[phase], Number.isFinite(peerDemandA) && peerDemandA > 0 ? peerDemandA : 0);
          // A confirmed open peer instruction can demand current even while
          // Equalizer is yielding all capacity to Shelly. With less than two
          // valid pilots, preserve the current peer's turn instead of cycling.
          return available < 2 * config.minimumCurrentA ? available - easee.currents[phase]
            : Math.max(available / 2, available - peer);
        });
        const shared = Math.min(ceiling, ...shares);
        if (Math.min(...shares) < loadCeiling) { loadCeiling = Math.min(...shares); loadReason = 'priority-allocation'; }
        if (shared < ceiling) { ceiling = shared; reason = 'priority-allocation'; }
      }
      if (peerFirstLive) {
        const remaining = Math.min(...headroom.map((available, phase) => available
          - Math.max(easee.currents[phase], Number.isFinite(peerDemandA) && peerDemandA > 0 ? peerDemandA : 0)));
        if (remaining < loadCeiling) { loadCeiling = remaining; loadReason = 'priority-allocation'; }
        if (remaining < ceiling) { ceiling = remaining; reason = 'priority-allocation'; }
      }
      if (Number.isFinite(reservationA) && reservationA > 0 && Math.min(...headroom) - reservationA < ceiling) {
        ceiling = Math.min(...headroom) - reservationA; reason = 'priority-allocation';
        loadCeiling = Math.min(loadCeiling, ceiling); loadReason = 'priority-allocation';
      }
    }
  }
  if (fallback) {
    ceiling = Math.min(known, config.fallbackCurrentA);
    // A valid independent property reading that establishes a tighter ceiling
    // still binds when the allowance feed disagrees. Fallback is never a floor.
    if (headroom) ceiling = Math.min(ceiling, loadCeiling);
    reason = 'telemetry-fallback'; loadCeiling = ceiling; loadReason = reason;
  }
  const currentA = Math.max(0, Math.floor((ceiling + 1e-9) / config.currentStepA) * config.currentStepA);
  const loadCurrentA = Math.max(0, Math.floor((loadCeiling + 1e-9) / config.currentStepA) * config.currentStepA);
  return { currentA: currentA < config.minimumCurrentA ? 0 : currentA, pause: currentA < config.minimumCurrentA,
    priority: ['balanced', 'charger1', 'charger2'].includes(priority) ? priority : null,
    evaluatedAt: Number.isSafeInteger(now) && now >= 0 ? now : null,
    reason, fallbackReason, loadCurrentA: loadCurrentA < config.minimumCurrentA ? 0 : loadCurrentA, loadReason,
    pauseReason: currentA < config.minimumCurrentA ? 'below-minimum-current' : null,
    fallback, guaranteedProtection: false, modelAvailable: !fallback, controllerLossFallback: 'unverified', baseCurrentA: base, phaseHeadroomA: headroom,
    missing: [property, easee, allowance, shelly].map((input, i) => !input?.healthy || !vector(input.currents)
      ? ['property', 'easee', 'allowance', 'shelly'][i] : null).filter(Boolean) };
}
