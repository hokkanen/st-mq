import { teslamateConfiguration } from '../app/config.js';
import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
import { compareEaseeSessionEnergy } from './easee-session-checks.js';

const HOUR = 3_600_000;
const FIELDS = new Set(['charger_power', 'charge_energy_added', 'charging_state', 'state', 'since', 'geofence', 'healthy']);
const positive = value => Number.isFinite(value) && value >= 0;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const unique = values => [...new Set(values)];

// TeslaMate publishes individual changing fields, without sensor timestamps.
// The cache is bounded and stays in memory: it is not a polling/history table.
export function decodeTeslaMateField(field, payload) {
  if (!FIELDS.has(field)) return undefined;
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
  if (text.length > 200) return undefined;
  if (['charger_power', 'charge_energy_added'].includes(field)) {
    if (!/^\d+(?:\.\d+)?$/.test(text.trim())) return null;
    const value = Number(text);
    return positive(value) && value <= (field === 'charger_power' ? 350 : 500) ? value : null;
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
  // A restart can recover the audit accumulator, never the old live power.
  if (state.session) {
    state.session.complete = false;
    state.session.quality = unique([...state.session.quality, 'disconnected']);
  }
  const save = () => store.setState(checkpointKey, state);
  const transaction = run => {
    const before = structuredClone({ state, cache, connected, healthyAt, evidenceAt, powerChangedAt, livePowerAt, liveStartAt, sawIdle, lastGapReason, messageSequence });
    try { return store.transaction(() => { const result = run(); save(); return result; }); }
    catch (error) {
      ({ state, cache, connected, healthyAt, evidenceAt, powerChangedAt, livePowerAt, liveStartAt, sawIdle, lastGapReason, messageSequence } = before);
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
    if (lastGapReason !== reason && state.cursor !== null) engine.recorder.energyGap({ source: 'teslamate', device, prefix: 'ev2',
      start: Math.min(state.cursor, now), end: now, quality: [reason] });
    lastGapReason = reason; state.cursor = now;
  }
  function finish(now) {
    const session = state.session;
    if (!session) return;
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
    recordChargingSessionCheck(store, { source: 'teslamate', sessionKey: session.key, start: session.start, end,
      estimatedKwh: session.estimatedKwh, referenceKwh: session.referenceKwh,
      complete: session.complete && session.referenceKwh !== null && session.referenceAt >= end - 5000,
      quality: unique(session.quality) });
    state.finalizedSince = session.since;
    state.session = null;
  }
  function sourceSnapshot(group, now) {
    const snapshot = engine.electricitySnapshot?.[group];
    if (!snapshot || !positive(snapshot.powerKw) || !recent(snapshot.sourceTime, now, config.propertyMaxAgeMs)
      || !recent(snapshot.receivedAt, now, config.propertyMaxAgeMs)) return null;
    return snapshot;
  }
  function propertyComparable(now) {
    const property = sourceSnapshot('property', now);
    return property && powerChangedAt !== null && property.sourceTime >= powerChangedAt + config.settleMs;
  }
  function limitViolation(now) {
    if (!positive(power()) || power() === 0 || powerChangedAt === null) return null;
    const property = sourceSnapshot('property', now);
    // Do not compare a new charging ramp with a preceding grid measurement.
    if (!property || property.sourceTime < powerChangedAt + config.settleMs) return null;
    if (power() > property.powerKw + config.powerToleranceKw) return 'property-power-impossible';
    if (config.chargerAssignment === 'easee') return null;
    const easee = sourceSnapshot('charger', now);
    if (!easee || easee.sourceTime < powerChangedAt - config.settleMs || easee.powerKw <= 0) return null;
    if (power() + easee.powerKw <= property.powerKw + config.powerToleranceKw) return null;
    return Math.abs(power() - easee.powerKw) <= config.powerToleranceKw ? 'duplicate-suspected' : 'assignment-uncertain';
  }
  function tickInside(now, { allowStart = true, allowFinalize = true } = {}) {
    if (!validTime(now)) throw new TypeError('TeslaMate capture requires a UTC millisecond timestamp');
    if (state.cursor !== null && now < state.cursor) {
      markIncomplete('out-of-order'); return;
    }
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
    if (state.session && isCharging() && validTime(incomingSince) && state.session.since !== null
      && incomingSince !== state.session.since && incomingSince > state.session.start) {
      markIncomplete('missing-end'); state.session.end = Math.min(now, incomingSince); finish(now);
      state.cursor = now;
    }
    const charging = isCharging(), home = atHome();
    const violation = connected && charging && home ? limitViolation(now) : null;
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
    }
    if (state.cursor === null) state.cursor = now;
    state.session.lastEvidenceAt = evidenceAt;
    if (config.chargerAssignment === 'easee') {
      gap(now, 'assigned-to-easee'); return;
    }
    if (now > state.cursor) {
      if (now - state.cursor > config.maxAgeMs) { markIncomplete('stale'); gap(now, 'teslamate-gap'); return; }
      const kwh = power() * (now - state.cursor) / HOUR;
      const result = engine.recorder.recordEnergy({ source: 'teslamate', device, prefix: 'ev2', start: state.cursor, end: now,
        energies: [kwh], powers: [power()], quality: ['estimated', 'reported_active_power', 'mqtt_receive_time', 'held_source_values'], receivedAt: now });
      if (result.reason !== 'duplicate-interval') state.session.estimatedKwh += kwh;
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
      if (field === 'charger_power' && value !== previous?.value) powerChangedAt = now;
      if (!retained) {
        if (field === 'healthy' && value === true) healthyAt = now;
        if (field === 'charger_power' && positive(value)) { livePowerAt = now; evidenceAt = now; powerChangedAt ??= now; }
        if (field === 'charge_energy_added' && positive(value) && (positive(previous?.value) && value > previous.value
          || previous == null && liveStartAt !== null && value > 0)) evidenceAt = now;
        if ((field === 'charging_state' && value === 'Charging' || field === 'state' && value === 'charging') && value !== previous?.value) {
          if (state.session?.end != null) {
            if (now - state.session.end < 45_000) markIncomplete('incomplete-coverage');
            finish(now);
          }
          liveStartAt = now;
          // The last run's retained cumulative value is not the new baseline.
          // Wait for this run's counter before opening another session.
          if (cache.charge_energy_added?.at < now && cache.charge_energy_added.value > 0) delete cache.charge_energy_added;
        }
        if (field === 'charging_state' && ['Complete', 'Stopped', 'Disconnected', 'NoPower'].includes(value)) {
          sawIdle = true;
          if (state.session && state.session.end == null) state.session.end = now;
          state.suppression = null;
        }
        if (field === 'state' && ['online', 'asleep', 'offline', 'driving'].includes(value)) {
          sawIdle = true;
          if (state.session && previous?.value === 'charging') {
            if (value === 'offline') markIncomplete('missing-end');
            state.session.end ??= now;
          }
        }
      }
      if (field === 'charge_energy_added' && positive(value) && state.session && !retained) {
        if (state.session.referenceKwh !== null && value < state.session.referenceKwh) {
          if (value === 0 && state.session.end != null) state.session.referenceAt = now;
          else {
            state.session.pendingReset ??= { at: now, value };
            state.session.pendingReset.value = value;
            state.session.referenceAt = now;
          }
        } else {
          if (state.session.pendingReset) { markIncomplete('counter-reset'); delete state.session.pendingReset; }
          state.session.referenceKwh = value; state.session.referenceAt = now;
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
  return { topic: `${root}#`, receive, tick, setConnected,
    close: () => setConnected(false),
    status: () => ({ connected, charging: isCharging(), home: atHome(), suppressed: state.suppression?.reason ?? null,
      recording: connected && lastGapReason === null && Boolean(state.session), sessionOpen: Boolean(state.session) }) };
}
