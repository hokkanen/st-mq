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
// intact: an unchanged current on a confirmed live feed does not expire here.
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

/** Join changing total/contribution observations before subtracting them. There
 * is no Equalizer response timer: while reports are incomplete we retain at
 * most the confirmed setting and previous ceiling, never claim new headroom.
 * State is one previous triplet, scoped to this physical/feed connection. */
export function createShellyCurrentLimiter() {
  let previous = null, key = null, transitions = null;
  const reset = () => { previous = null; key = null; transitions = null; };
  const ownConfirmedAt = input => Number.isFinite(input.shelly.confirmedAt)
    ? input.shelly.confirmedAt : Math.min(...input.shelly.times);
  return { reset, evaluate(input, scope) {
    const { property, easee, shelly, now, config } = input;
    const healthy = [property, easee].every(feed => feedUsable(feed, now)) && measured(shelly, now);
    const scoped = scope?.authorized === true && scope.connected === true && typeof scope.association === 'string'
      && typeof scope.sessionId === 'string' && Number.isFinite(scope.connectedAt) && scope.connectedAt <= now
      && scope.generation != null;
    if (!healthy || !scoped) { reset(); return shellyCurrentLimit(input); }
    const nextKey = JSON.stringify([scope.association, scope.sessionId, scope.connectedAt, scope.generation,
      ...[property, easee].map(feed => [feed.evidence.source, feed.evidence.epoch]), config.mainFuseA, config.marginA]);
    if (key !== nextKey) { reset(); key = nextKey; }
    let aligned = true;
    if (previous) {
      const old = previous.input;
      const own = Math.min(...shelly.currents), oldOwn = Math.min(...old.shelly.currents);
      transitions ??= { peer: [null, null, null], own: null };
      if (own === oldOwn) transitions.own = null;
      else if (transitions.own?.value !== own)
        transitions.own = { value: own, at: Math.max(...shelly.times) };
      for (let phase = 0; phase < 3; phase++) {
        const peerChanged = easee.currents[phase] !== old.easee.currents[phase];
        const ownChanged = own !== oldOwn;
        const propertyChanged = property.currents[phase] !== old.property.currents[phase];
        if (!peerChanged) transitions.peer[phase] = null;
        else if (transitions.peer[phase]?.value !== easee.currents[phase])
          transitions.peer[phase] = { value: easee.currents[phase], at: easee.times[phase] };
        const base = property.currents[phase] - easee.currents[phase] - own;
        // Matching contributions leave the validated household unchanged, even
        // when a later periodic sample brackets an earlier property change.
        if (base === previous.result.baseCurrentA[phase]) continue;
        // Freeze the first changed-value clock; subsequent unchanged samples
        // must not move the point the property observation has to cover.
        if (peerChanged && property.times[phase] < transitions.peer[phase].at
          || ownChanged && property.times[phase] < transitions.own.at) aligned = false;
        // OCPP reports periodic measurements. A later report can confirm an
        // unchanged peer. Cloud streams instead explicitly admit held current
        // state on their healthy synchronized connection; no new value clock is
        // required. Neither transport provides an atomic site-wide snapshot.
        if ((propertyChanged || peerChanged || ownChanged)
          && (easee.evidence.source !== 'easee-stream' && easee.times[phase] < property.times[phase]
            || ownConfirmedAt(input) < property.times[phase])) aligned = false;
      }
    }
    if (!aligned) {
      const last = previous.input;
      const retained = shellyCurrentLimit({ ...input, property: last.property, easee: last.easee, shelly: last.shelly });
      const setting = input.currentSetting;
      if (!setting?.confirmed || !Number.isFinite(setting.currentA)) { reset(); return shellyCurrentLimit({ ...input, shelly: null }); }
      const currentA = Math.min(retained.currentA, previous.result.currentA, setting.currentA);
      return { ...retained, currentA, pause: currentA === 0,
        loadCurrentA: Math.min(retained.loadCurrentA, previous.result.loadCurrentA, setting.currentA),
        pauseReason: currentA === 0 ? 'below-minimum-current' : null,
        reason: 'measurement-pair-pending', loadReason: 'measurement-pair-pending',
        modelAvailable: false, measurementPending: true };
    }
    const result = shellyCurrentLimit(input);
    if (!result.fallback) {
      previous = { input: structuredClone({ property, easee, shelly }), result };
      transitions = null;
    }
    return result;
  } };
}
