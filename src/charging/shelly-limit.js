const vector = values => Array.isArray(values) && values.length === 3 && values.every(v => Number.isFinite(v) && v >= 0 && v <= 1000);
/** A phase-aligned additive model, admitted only after installation verification. */
export function shellyCurrentLimit({ config, property, easee, shelly, now, reservationA = 0, vehicleCurrentA = null, nativeCurrentA = null, allocationA = null } = {}) {
  const knownCeilings = [config.maximumCurrentA, vehicleCurrentA, nativeCurrentA, allocationA].filter(v => Number.isFinite(v) && v >= 0);
  const known = Math.min(...knownCeilings);
  const inputs = [property, easee, shelly];
  const clocks = inputs.flatMap(input => input?.times ?? []);
  const coherent = config.additiveCurrentVerified === true && inputs.every(input => input?.healthy === true && vector(input.currents)
    && Array.isArray(input.times) && input.times.length === 3 && input.times.every(at => Number.isFinite(at) && at <= now && now - at <= config.maxAgeMs))
    && Math.max(...clocks) - Math.min(...clocks) <= config.maxSkewMs;
  let ceiling, reason, base = null, headroom = null, fallback = !coherent;
  if (coherent) {
    base = property.currents.map((p, i) => p - easee.currents[i] - shelly.currents[i]);
    // Negative residual is evidence against this model, not a free capacity grant.
    if (base.some(v => v < -.25)) fallback = true;
    else {
      headroom = base.map((b, i) => config.mainFuseA[i] - config.marginA[i] - Math.max(0, b));
      ceiling = Math.min(known, ...headroom);
      reason = ceiling < known ? 'fuse-limit' : known === allocationA ? 'priority-allocation'
        : known === nativeCurrentA ? 'native-current-limit' : known === vehicleCurrentA ? 'vehicle-current-limit' : 'hardware-restriction';
      if (Number.isFinite(reservationA) && reservationA > 0 && Math.min(...headroom) - reservationA < ceiling) {
        ceiling = Math.min(...headroom) - reservationA; reason = 'priority-allocation';
      }
    }
  }
  if (fallback) { ceiling = Math.min(known, config.fallbackCurrentA); reason = 'telemetry-fallback'; }
  const currentA = Math.max(0, Math.floor((ceiling + 1e-9) / config.currentStepA) * config.currentStepA);
  return { currentA: currentA < config.minimumCurrentA ? 0 : currentA, pause: currentA < config.minimumCurrentA,
    reason, pauseReason: currentA < config.minimumCurrentA ? 'below-minimum-current' : null,
    fallback, guaranteedProtection: false, modelAvailable: !fallback, controllerLossFallback: 'unverified', baseCurrentA: base, phaseHeadroomA: headroom,
    missing: inputs.map((input, i) => !input?.healthy || !vector(input.currents) ? ['property', 'easee', 'shelly'][i] : null).filter(Boolean) };
}
