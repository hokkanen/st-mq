import { teslamateConfiguration } from '../app/config.js';
import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
import { compareEaseeSessionEnergy } from './easee-session-checks.js';
import { comparableElectricitySnapshot, settledElectricitySnapshot } from './electricity-comparison.js';

const HOUR = 3_600_000;
const FIELDS = new Set(['charger_power', 'charger_actual_current', 'charge_energy_added', 'charging_state', 'state', 'since', 'geofence', 'healthy']);
const positive = value => Number.isFinite(value) && value >= 0;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const unique = values => [...new Set(values)];

// TeslaMate publishes individual changing fields, without sensor timestamps.
// The cache is bounded and stays in memory: it is not a polling/history table.
export function decodeTeslaMateField(field, payload) {
  if (!FIELDS.has(field)) return undefined;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  if (text.length > 200) return undefined;
  if (['charger_power', 'charger_actual_current', 'charge_energy_added'].includes(field)) {
    if (!/^\d+(?:\.\d+)?$/.test(text.trim())) return null;
    const value = Number(text);
    return positive(value) && value <= (field === 'charger_power' ? 350 : field === 'charger_actual_current' ? 100 : 500) ? value : null;
  }
  if (field === 'healthy') return text === 'true' ? true : text === 'false' ? false : null;
  if (field === 'since') {
    const at = /(?:Z|[+-]\d\d:\d\d)$/.test(text) ? Date.parse(text) : NaN;
    return validTime(at) ? at : null;
  }
  if (field === 'charging_state') return ['Charging', 'Complete', 'Stopped', 'Disconnected', 'Starting', 'NoPower'].includes(text) ? text : null;
  if (field === 'state') return ['charging', 'online', 'offline', 'asleep', 'suspended', 'driving', 'updating'].includes(text) ? text : null;
  return text;
}

/** Receive-time estimates, with explicit gaps at loss of evidence. One durable
 * checkpoint and the scalar recorder increments commit together; session checks
 * are inserted once, after a short terminal-message settling period. */
export function createTeslaMateCapture({ engine, store, settings = {}, clock = () => engine.clock() }) {
  const config = teslamateConfiguration(settings), device = `car-${config.carId}`;
  const root = `teslamate/${config.namespace ? `${config.namespace}/` : ''}cars/${config.carId}/`;
  const checkpointKey = `teslamate:acquisition:${config.carId}`;
  let state = store.getState(checkpointKey);
  if (state?.version !== 1) state = { version: 1, cursor: null, session: null, finalizedSince: null, suppression: null, sequence: 0 };
  let cache = {}, connected = false, healthyAt = null, evidenceAt = null, powerChangedAt = null;
  let livePowerAt = null, liveStartAt = null, sawIdle = false, lastGapReason = null, messageSequence = 0;
  // Identification is deliberately absent from `state`: no command, verdict,
  // timer, sample buffer or pause bookkeeping survives in the database.
  let pendingEnergy = [], sessionAssignment = null, pauseSeen = false, resumedSince = null;
  let referenceOffset = 0, previousReference = null, pauseCounterReset = false, pauseZeroReference = null;
  const identificationEnabled = config.chargerIdentification && config.chargerAssignment === 'auto';
  const identification = () => identificationEnabled ? engine.chargerIdentification?.status() ?? {} : {};
  // A restart can recover the audit accumulator, never the old live power.
  if (state.session) {
    state.session.complete = false;
    state.session.quality = unique([...state.session.quality, 'disconnected']);
  }
  const save = () => store.setState(checkpointKey, state);
  const transaction = run => {
    const before = structuredClone({ state, cache, connected, healthyAt, evidenceAt, powerChangedAt, livePowerAt, liveStartAt, sawIdle, lastGapReason, messageSequence,
      pendingEnergy, sessionAssignment, pauseSeen, resumedSince, referenceOffset, previousReference, pauseCounterReset, pauseZeroReference });
    try { return store.transaction(() => { const result = run(); save(); return result; }); }
    catch (error) {
      ({ state, cache, connected, healthyAt, evidenceAt, powerChangedAt, livePowerAt, liveStartAt, sawIdle, lastGapReason, messageSequence,
        pendingEnergy, sessionAssignment, pauseSeen, resumedSince, referenceOffset, previousReference, pauseCounterReset, pauseZeroReference } = before);
      throw error;
    }
  };
  const markIncomplete = reason => {
    if (!state.session) return;
    state.session.complete = false;
    state.session.quality = unique([...state.session.quality, reason]);
  };
  const isCharging = () => {
    const generic = cache.state, charging = cache.charging_state;
    // A newer logger state leaving charging must beat a cached Charging field.
    // Both topics are change-only, so a contradictory old field cannot win by
    // hard-coded topic precedence or be revived by unrelated healthy messages.
    return generic && (!charging || generic.sequence > charging.sequence)
      ? generic.value === 'charging' : charging?.value === 'Charging';
  };
  const atHome = () => cache.geofence?.value === config.homeGeofence;
  const recent = (at, now, maximum = config.maxAgeMs) => validTime(at) && at <= now && now - at <= maximum;
  const power = () => cache.charger_power?.value;
  function gap(now, reason) {
    if (pendingEnergy.length) { pendingEnergy = []; markIncomplete('incomplete-coverage'); }
    if (lastGapReason !== reason && state.cursor !== null) engine.recorder.energyGap({ source: 'teslamate', device, prefix: 'ev2',
      start: Math.min(state.cursor, now), end: now, quality: [reason] });
    lastGapReason = reason; state.cursor = now;
  }
  function finish(now) {
    const session = state.session;
    if (!session) return;
    if (pendingEnergy.length) { pendingEnergy = []; markIncomplete('incomplete-coverage'); }
    const end = Math.max(session.start + 1, session.end ?? now);
    // Tesla can publish zero as the terminal counter. TeslaMate retains the
    // preceding maximum for that case; a decreasing nonzero counter is unknown.
    if (session.pendingReset && session.pendingReset.value !== 0) markIncomplete('counter-reset');
    engine.recorder.flush(now, { force: true });
    if (session.assignment === 'easee') {
      const comparison = session.referenceDevice ? compareEaseeSessionEnergy(store, { device: session.referenceDevice, start: session.start, end }) : null;
      session.estimatedKwh = comparison?.estimatedKwh ?? null;
      if (!comparison) markIncomplete('incomplete-coverage');
      else if (comparison.edgeEstimated) session.quality = unique([...session.quality, 'estimated-boundary']);
    }
    if (session.referenceKwh === null || !(session.referenceAt >= end - 5000)) markIncomplete('missing-final-reference');
    // A car on Charger 1 does not create another Charger 2 session comparison.
    // The normal Charger 1 provider session already supplies its reference.
    if (sessionAssignment !== 'easee') recordChargingSessionCheck(store, { source: 'teslamate', sessionKey: session.key, start: session.start, end,
      estimatedKwh: session.estimatedKwh, referenceKwh: session.referenceKwh,
      complete: session.complete && session.referenceKwh !== null && session.referenceAt >= end - 5000,
      quality: unique(session.quality) });
    state.finalizedSince = session.since;
    state.session = null;
    sessionAssignment = null; pauseSeen = false; resumedSince = null;
    referenceOffset = 0; previousReference = null; pauseCounterReset = false; pauseZeroReference = null;
  }
  function sourceSnapshot(group, now) {
    const snapshot = engine.electricitySnapshot?.[group];
    if (!comparableElectricitySnapshot(snapshot, now, { maxAgeMs: config.propertyMaxAgeMs })) return null;
    return snapshot;
  }
  function propertyComparable(now) {
    const property = sourceSnapshot('property', now);
    return settledElectricitySnapshot(property, now, powerChangedAt, { settleMs: config.settleMs });
  }
  function limitViolation(now) {
    if (!positive(power()) || power() === 0 || powerChangedAt === null) return null;
    const property = sourceSnapshot('property', now);
    // Do not compare a new charging ramp with a preceding grid measurement.
    if (!settledElectricitySnapshot(property, now, powerChangedAt, { settleMs: config.settleMs })) return null;
    if (power() > property.powerKw + config.powerToleranceKw) return 'property-power-impossible';
    if (config.chargerAssignment === 'easee') return null;
    const easee = sourceSnapshot('charger', now);
    if (!easee || easee.powerKw <= 0 || easee.sourceTime < powerChangedAt - config.settleMs
      && !settledElectricitySnapshot(easee, now, powerChangedAt, { settleMs: config.settleMs })) return null;
    if (power() + easee.powerKw <= property.powerKw + config.powerToleranceKw) return null;
    return Math.abs(power() - easee.powerKw) <= config.powerToleranceKw ? 'duplicate-suspected' : 'assignment-uncertain';
  }
  function tickInside(now, { allowStart = true, allowFinalize = true } = {}) {
    if (!validTime(now)) throw new TypeError('TeslaMate capture requires a UTC millisecond timestamp');
    if (state.cursor !== null && now < state.cursor) {
      markIncomplete('out-of-order'); return;
    }
    const check = identification();
    const preservePause = check.pauseExpected === true && connected && atHome();
    if (preservePause) {
      if (!pauseSeen) { pauseCounterReset = false; pauseZeroReference = null; }
      pauseSeen = true;
    }
    else if (pauseSeen) {
      if (state.session && !isCharging()) state.session.end ??= now;
      pauseSeen = false;
    }
    if (state.session && check.verdict) sessionAssignment = check.verdict;
    if (state.session?.end != null) {
      if (allowFinalize && now - state.session.end >= 45_000) finish(now);
      state.cursor = now; return;
    }
    if (state.session?.pendingReset) {
      const reset = state.session.pendingReset;
      gap(now, 'counter-reset-pending');
      // State and energy updates are separate packets. Give a terminal state
      // time to arrive before deciding that a lower counter starts another run.
      if (now - reset.at < 15_000) return;
      markIncomplete('counter-reset'); state.session.end = reset.at; finish(now);
      state.finalizedSince = null;
      return;
    }
    const incomingSince = cache.since?.value;
    if (preservePause && validTime(incomingSince)) resumedSince = incomingSince;
    if (state.session && isCharging() && validTime(incomingSince) && state.session.since !== null
      && incomingSince !== state.session.since && incomingSince !== resumedSince && !preservePause && incomingSince > state.session.start) {
      markIncomplete('missing-end'); state.session.end = Math.min(now, incomingSince); finish(now);
      state.cursor = now;
    }
    const charging = isCharging(), home = atHome();
    const charger = sourceSnapshot('charger', now);
    // The remembered session attribution is only for its final comparison.
    // Recording always uses the live verdict, which can be invalidated by a
    // connection change or a new explicit test.
    const assignment = check.verdict;
    const defer = identificationEnabled && !assignment
      && (check.assignmentPending || check.active || !charger || charger.powerKw > 0);
    // A known command transition must not turn independently delayed MQTT
    // fields into a permanent missing-end diagnosis. Unresolved energy stays
    // in RAM until it can be attributed; ordinary physical bounds still apply
    // to recording after the transition.
    const settling = check.active && Number.isFinite(check.settlingUntil) && now < check.settlingUntil;
    const violation = connected && charging && home && !defer && !settling && assignment !== 'easee' ? limitViolation(now) : null;
    if (assignment === 'easee' || defer || settling) state.suppression = null;
    if (violation && state.suppression?.reason !== violation) {
      state.suppression = { at: now, powerAt: livePowerAt, reason: violation };
      markIncomplete(violation === 'property-power-impossible' ? 'missing-end' : violation);
    }
    if (state.suppression) {
      // Household load recovering is not fresh Tesla charging evidence.
      if (!violation && livePowerAt !== null && livePowerAt > (state.suppression.powerAt ?? state.suppression.at)
        && propertyComparable(now)) state.suppression = null;
      else {
        gap(now, state.suppression.reason);
        // Keep the bounded session open: an impossible held value may mean a
        // current reduction, and a fresh compatible power can resume this same
        // physical session. Only terminal/new-session evidence finalizes it.
        return;
      }
    }
    if (!connected || !recent(healthyAt, now) || cache.healthy?.value !== true || !recent(evidenceAt, now)) {
      if (state.session) markIncomplete(connected ? 'stale' : 'disconnected');
      gap(now, connected ? 'teslamate-stale' : 'mqtt-disconnected');
      const lastEvidence = evidenceAt ?? state.session?.lastEvidenceAt ?? state.session?.start;
      if (state.session && validTime(lastEvidence) && now - lastEvidence > config.maxAgeMs * 2) {
        markIncomplete('missing-end'); state.session.end = now; finish(now);
      }
      return;
    }
    if (preservePause && (!charging || power() === 0)) {
      // Zero comes from observed power/state; never substitute the command as
      // a measurement. The pause remains within the physical charging session.
      state.cursor = now; return;
    }
    if (!charging || !home || !positive(power()) || power() === 0) {
      if (state.session && !home) { markIncomplete('assignment-uncertain'); state.session.end = now; }
      gap(now, !home ? 'away-or-unknown-location' : 'not-charging'); return;
    }
    if (!state.session) {
      if (!allowStart) { state.cursor = now; return; }
      const since = cache.since?.value;
      if (since !== null && since !== undefined && since === state.finalizedSince) { gap(now, 'session-already-finalized'); return; }
      const reference = cache.charge_energy_added?.value;
      if (!positive(reference)) { gap(now, 'awaiting-session-reference'); return; }
      const complete = sawIdle && liveStartAt !== null && positive(reference) && reference <= 0.01;
      state.sequence = (state.sequence ?? 0) + 1;
      state.session = { key: `${device}:${since ?? liveStartAt ?? now}:${state.sequence}`, since: since ?? null,
        start: now, estimatedKwh: 0, referenceKwh: positive(reference) ? reference : null,
        referenceAt: cache.charge_energy_added?.at ?? now, assignment: config.chargerAssignment,
        referenceDevice: config.chargerAssignment === 'easee' ? engine.electricitySnapshot?.charger?.device ?? null : null,
        lastEvidenceAt: evidenceAt,
        complete, quality: complete ? ['estimated-boundary'] : ['missing-start'] };
      state.cursor = now; sawIdle = false;
      sessionAssignment = check.verdict ?? null;
      previousReference = reference;
    }
    if (state.cursor === null) state.cursor = now;
    state.session.lastEvidenceAt = evidenceAt;
    if (config.chargerAssignment === 'easee') {
      gap(now, 'assigned-to-easee'); return;
    }
    if (assignment === 'easee') {
      pendingEnergy = [];
      // Charger 2 has no consumption in this connection. Do not archive the
      // identification decision as a gap reason or a session-quality flag.
      state.cursor = now; lastGapReason = 'not-charging'; return;
    }
    if (!defer && !settling && pendingEnergy.length) {
      if (assignment === 'other') {
        for (const interval of pendingEnergy) {
          const result = engine.recorder.recordEnergy({ ...interval, receivedAt: now });
          if (result.reason !== 'duplicate-interval') state.session.estimatedKwh += interval.energies[0];
        }
        pendingEnergy = [];
      } else {
        // Charger 1 becoming idle cannot identify where the car charged during
        // the preceding overlap. Never turn that ambiguous buffer into energy.
        gap(now, 'assignment-uncertain');
      }
    }
    if (now > state.cursor) {
      if (now - state.cursor > config.maxAgeMs) { markIncomplete('stale'); gap(now, 'teslamate-gap'); return; }
      const kwh = power() * (now - state.cursor) / HOUR;
      const interval = { source: 'teslamate', device, prefix: 'ev2', start: state.cursor, end: now,
        energies: [kwh], powers: [power()], quality: ['estimated', 'reported_active_power', 'mqtt_receive_time', 'held_source_values'], receivedAt: now };
      if (defer || settling) {
        pendingEnergy.push(interval);
        if (pendingEnergy.length > 1024 || now - pendingEnergy[0].start > 240_000) gap(now, 'assignment-uncertain');
      } else {
        const result = engine.recorder.recordEnergy(interval);
        if (result.reason !== 'duplicate-interval') state.session.estimatedKwh += kwh;
      }
    }
    state.cursor = now; lastGapReason = null;
  }
  const tick = (now = clock()) => transaction(() => tickInside(now));
  function receive(topic, payload, packet = {}, now = clock()) {
    if (!connected || !topic.startsWith(root)) return false;
    const field = topic.slice(root.length), value = decodeTeslaMateField(field, payload);
    if (value === undefined) return false;
    transaction(() => {
      // Integrate the previously held value up to receipt, never backdate a new
      // value to the preceding sample. All MQTT fields have independent arrivals.
      tickInside(now, { allowStart: false, allowFinalize: false });
      const previous = cache[field], retained = packet.retain === true;
      if (retained && previous && !previous.retained) return;
      cache[field] = { value, at: now, retained, sequence: ++messageSequence };
      const preservePause = identification().pauseExpected === true && connected && atHome();
      if (preservePause) pauseSeen = true;
      if (preservePause && field === 'since' && validTime(value)) resumedSince = value;
      if (field === 'charger_power' && value !== previous?.value) powerChangedAt = now;
      if (!retained) {
        if (field === 'healthy' && value === true) healthyAt = now;
        if (field === 'charger_power' && positive(value)) { livePowerAt = now; evidenceAt = now; powerChangedAt ??= now; }
        if (field === 'charge_energy_added' && positive(value) && (positive(previous?.value) && value > previous.value
          || previous == null && liveStartAt !== null && value > 0)) evidenceAt = now;
        if ((field === 'charging_state' && value === 'Charging' || field === 'state' && value === 'charging') && value !== previous?.value) {
          if (!preservePause && state.session?.end != null) {
            if (now - state.session.end < 45_000) markIncomplete('incomplete-coverage');
            finish(now);
          }
          if (!preservePause) liveStartAt = now;
          // The last run's retained cumulative value is not the new baseline.
          // Wait for this run's counter before opening another session.
          if (!preservePause && cache.charge_energy_added?.at < now && cache.charge_energy_added.value > 0) delete cache.charge_energy_added;
        }
        if (field === 'charging_state' && ['Complete', 'Stopped', 'Disconnected', 'NoPower'].includes(value)) {
          if (!preservePause || ['Complete', 'Disconnected'].includes(value)) {
            sawIdle = true; pauseSeen = false;
            if (state.session && state.session.end == null) state.session.end = now;
          }
          state.suppression = null;
        }
        if (field === 'state' && ['online', 'asleep', 'offline', 'driving'].includes(value)) {
          if (!preservePause || ['offline', 'driving'].includes(value)) sawIdle = true;
          if ((!preservePause || ['offline', 'driving'].includes(value)) && state.session && previous?.value === 'charging') {
            if (value === 'offline') markIncomplete('missing-end');
            state.session.end ??= now;
          }
        }
      }
      if (field === 'charge_energy_added' && positive(value) && state.session && !retained) {
        if (preservePause && value === 0 && previousReference > 0 && !pauseCounterReset) {
          // A stop may publish a transient zero and later return the continuing
          // counter. Wait for a positive value before deciding it restarted.
          pauseZeroReference = previousReference;
          state.session.referenceAt = now;
          return;
        }
        if (pauseZeroReference !== null && value > 0) {
          if (value >= pauseZeroReference) markIncomplete('counter-reset');
          pauseZeroReference = null;
        }
        if (preservePause && previousReference !== null && value < previousReference && !pauseCounterReset) {
          // Some cars reset the session counter across a pause. Combine those
          // normal segments once, in RAM, while retaining a single reference.
          referenceOffset = state.session.referenceKwh ?? 0;
          pauseCounterReset = true;
        }
        const reference = value + referenceOffset;
        previousReference = value;
        if (state.session.referenceKwh !== null && reference < state.session.referenceKwh) {
          if (value === 0 && state.session.end != null) state.session.referenceAt = now;
          else {
            state.session.pendingReset ??= { at: now, value };
            state.session.pendingReset.value = value;
            state.session.referenceAt = now;
          }
        } else {
          if (state.session.pendingReset) { markIncomplete('counter-reset'); delete state.session.pendingReset; }
          state.session.referenceKwh = reference; state.session.referenceAt = now;
        }
      }
      // Do not start or finalize on individual messages: the maintenance tick
      // lets a retained burst and terminal counter/state messages settle first.
    });
    return true;
  }
  function setConnected(value, now = clock()) {
    if (connected === value) return;
    transaction(() => {
      connected = value;
      if (!value) {
        markIncomplete('disconnected'); gap(now, 'mqtt-disconnected');
        cache = {}; healthyAt = evidenceAt = livePowerAt = powerChangedAt = liveStartAt = null; sawIdle = false;
      } else if (state.session && state.cursor !== null && now > state.cursor) gap(now, 'mqtt-disconnected');
      else state.cursor = now;
    });
  }
  function status(now = clock()) {
    const charging = Boolean(isCharging()), home = atHome(), check = identification();
    const healthy = cache.healthy?.value === true && recent(healthyAt, now);
    let status = 'ok', reason = 'awaiting-recording';
    const waiting = value => { status = 'waiting'; reason = value; };
    const degraded = value => { status = 'degraded'; reason = value; };
    if (!connected) { status = 'error'; reason = 'mqtt-disconnected'; }
    else if (cache.healthy?.value === false) degraded('teslamate-unhealthy');
    else if (typeof cache.state?.value !== 'string' && typeof cache.charging_state?.value !== 'string') waiting('awaiting-readings');
    // Idle/asleep and away cars legitimately hold unchanged MQTT power fields.
    // Fresh charging evidence is required only when recording home charging.
    else if (!charging) reason = 'not-charging';
    else if (!cache.geofence) waiting('awaiting-readings');
    else if (!home) reason = 'away-or-unknown-location';
    else if (config.chargerAssignment === 'easee' || check.verdict === 'easee') reason = 'assigned-to-easee';
    else if (state.suppression) degraded(state.suppression.reason);
    else if (!healthy) healthyAt === null ? waiting('awaiting-health') : degraded('teslamate-stale');
    else if (!recent(evidenceAt, now)) evidenceAt === null ? waiting('awaiting-charging-evidence') : degraded('teslamate-stale');
    else if (identificationEnabled && !check.verdict && (check.active || check.assignmentPending || pendingEnergy.length)) waiting('charger-identification-pending');
    else if (!positive(power()) || power() === 0) waiting('awaiting-charging-evidence');
    else if (!state.session && !positive(cache.charge_energy_added?.value)) waiting('awaiting-session-reference');
    else if (lastGapReason === null && !pendingEnergy.length && state.session && state.session.end == null) reason = 'recording';
    else waiting('awaiting-recording');
    const messageTimes = Object.values(cache).map(field => field.at).filter(validTime);
    const freshnessChecks = reason === 'teslamate-stale'
      ? [{ key: 'vehicle-health', at: healthyAt }, { key: 'charging-evidence', at: evidenceAt }]
        .filter(check => !recent(check.at, now)).map(check => ({ ...check, maxAgeMs: config.maxAgeMs })) : [];
    // Keep configuration, MQTT topics, raw fields and device identifiers private.
    // These descriptors are calculated on demand and never enter the checkpoint.
    return { status, reason, connected, charging, home, healthy,
      maxAgeMs: config.maxAgeMs, freshnessChecks,
      lastMessageAt: messageTimes.length ? Math.max(...messageTimes) : null,
      suppressed: state.suppression?.reason ?? null, recording: reason === 'recording', sessionOpen: Boolean(state.session) };
  }
  return { topic: `${root}#`, receive, tick, setConnected,
    identificationSnapshot: () => ({ connected, home: cache.geofence ? atHome() : undefined, charging: isCharging(),
      plugged: isCharging() ? true : cache.charging_state?.value === 'Disconnected' || cache.state?.value === 'driving' ? false : undefined,
      healthy: cache.healthy?.value === true, healthyAt,
      powerKw: power(), powerAt: cache.charger_power?.retained ? null : cache.charger_power?.at ?? null,
      currentA: cache.charger_actual_current?.value, currentAt: cache.charger_actual_current?.retained ? null : cache.charger_actual_current?.at ?? null,
      energyKwh: cache.charge_energy_added?.value, energyAt: cache.charge_energy_added?.retained ? null : cache.charge_energy_added?.at ?? null,
      sessionKey: cache.since?.value ?? null }),
    close: () => setConnected(false),
    status };
}
