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
// Feed adapters own connection and report health. Change-only clocks are kept
// intact: use the latest valid current on each healthy feed independently.
// Source timestamp ordering never gates subtraction; asynchronous reports can
// temporarily overestimate or underestimate headroom (owner-approved policy).
const measured = (input, now) => input?.healthy === true && vector(input.currents) && times(input, now);
const feedUsable = (input, now) => measured(input, now)
  && input.evidence?.connected === true && input.evidence.online === true
  && input.evidence.synchronized === true && input.evidence.epoch != null;

/** Household headroom and planned entitlement are independent of the current
 * drawn by Charger 1. Equalizer may remove all of its draw; neither its response
 * time nor its reported allowance changes Shelly's entitlement. */
export function shellyCurrentLimit({ config, property, easee, shelly, now, priority,
  reservationA = 0, vehicleCurrentA = null, nativeCurrentA = null, allocationA = null, allocateCurrent = null } = {}) {
  // Priority for Shelly owns the available household headroom. Equalizer yields
  // Charger 1; the joint forecast is not a live reservation against this right.
  if (priority === 'charger2') { allocationA = null; reservationA = 0; }
  const valid = value => Number.isFinite(value) && value >= 0;
  const usable = [feedUsable(property, now), feedUsable(easee, now), measured(shelly, now)];
  let fallbackReason = !usable[2] ? 'shelly-current-unavailable'
    : ![property, easee].every(feed => feed?.evidence?.synchronized === true) ? 'feed-unsynchronized'
      : !usable.every(Boolean) ? 'feed-unavailable' : null;
  let base = null, headroom = null;
  if (usable.every(Boolean)) {
    // Phase correspondence with the property meter is not commissioned. Only
    // the minimum Shelly draw is known to be present on every property phase.
    const common = Math.min(...shelly.currents);
    base = property.currents.map((value, phase) => value - easee.currents[phase] - common);
    if (base.some(value => value < -.25)) fallbackReason = 'non-additive-currents';
    else headroom = base.map((value, phase) => config.mainFuseA[phase] - config.marginA[phase] - Math.max(0, value));
  }
  if (headroom && priority !== 'charger2' && typeof allocateCurrent === 'function')
    ({ allocationA = null, reservationA = 0 } = allocateCurrent(headroom.map(value => Math.max(0, value))));
  const fallback = fallbackReason !== null;
  let loadCeiling = config.maximumCurrentA, loadReason = 'hardware-restriction';
  const restrictLoad = (value, reason) => {
    if (value < loadCeiling) { loadCeiling = value; loadReason = reason; }
  };
  if (headroom) {
    restrictLoad(Math.min(...headroom), 'fuse-limit');
    // Reserve an assigned right, never the peer's instantaneous consumption.
    if (valid(reservationA) && reservationA > 0)
      restrictLoad(Math.min(...headroom) - reservationA, 'priority-allocation');
  }
  if (valid(allocationA)) restrictLoad(allocationA, 'priority-allocation');
  if (fallback) restrictLoad(config.fallbackCurrentA, 'telemetry-fallback');
  let ceiling = loadCeiling, reason = loadReason;
  for (const [value, restriction] of [[nativeCurrentA, 'native-current-limit'],
    [vehiclePilotLimit(vehicleCurrentA, config.minimumCurrentA), 'vehicle-current-limit']]) {
    if (valid(value) && value < ceiling) { ceiling = value; reason = restriction; }
  }
  const round = value => {
    const stepped = Math.max(0, Math.floor((value + 1e-9) / config.currentStepA) * config.currentStepA);
    return stepped < config.minimumCurrentA ? 0 : stepped;
  };
  const currentA = round(ceiling);
  return { currentA, pause: currentA === 0,
    priority: ['balanced', 'charger1', 'charger2'].includes(priority) ? priority : null,
    evaluatedAt: Number.isSafeInteger(now) && now >= 0 ? now : null,
    reason, fallbackReason, loadCurrentA: round(loadCeiling), loadReason,
    pauseReason: currentA === 0 ? 'below-minimum-current' : null,
    fallback, guaranteedProtection: false, modelAvailable: !fallback, controllerLossFallback: 'unverified',
    baseCurrentA: base, phaseHeadroomA: headroom,
    missing: ['property', 'easee', 'shelly'].filter((_, index) => !usable[index]) };
}
