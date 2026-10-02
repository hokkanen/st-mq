import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
import { compareRecordedChargingEnergy } from '../acquisition/recorded-charging-energy.js';

const copy = value => structuredClone(value);
const addQuality = (session, flag) => { if (session && !session.quality.includes(flag)) session.quality.push(flag); };
const eventTime = event => event.orderAt ?? event.measuredAt;
const ordered = events => events.sort((a, b) => eventTime(a) - eventTime(b) || (a.kind === 'work' ? -1 : 1));

export const newShellySessionCheckState = () => ({ version: 1, active: null, pending: null, reference: null, zero: null });

function newNativeRuns(start, maxAgeMs, missingStart = false) {
  return { version: 1, base: { start, baselineDeadline: start + maxAgeMs * 2,
    committedAt: null, observedKwh: 0, runCount: 0, reference: null,
    runStart: start, runHasEnergy: false, runSawCharging: false, charging: null, stopAt: null,
    closedAt: null, resumedAt: null, quality: missingStart ? ['missing-start'] : [] }, events: [], lastReceivedAt: null };
}

function runFinal(state) {
  return state.runSawCharging && state.stopAt !== null && state.stopAt >= state.runStart
    && state.reference?.measuredAt >= state.stopAt;
}

function foldNative(state, event, end = null) {
  if (event.kind === 'work') {
    if (event.charging) {
      if (state.charging === false && state.runHasEnergy && state.stopAt !== null) state.resumedAt = event.measuredAt;
      state.runSawCharging = true;
    }
    else if (state.charging === true) state.stopAt = event.measuredAt;
    state.charging = event.charging;
    return;
  }
  if (state.closedAt !== null) return;
  const previous = state.reference;
  if (previous && event.measuredAt <= previous.measuredAt) return;
  if (!previous) {
    // An initial nonzero observation is a baseline, not permission to borrow
    // energy from before this physical connection or before acquisition began.
    const observedZero = event.value === 0 && event.receivedAt <= state.baselineDeadline
      && (event.measuredAt === state.start || state.charging === false && !state.runSawCharging);
    if (!observedZero) addQuality(state, 'missing-start');
    state.runHasEnergy = event.value > 0;
    if (state.runHasEnergy) state.runCount++;
  } else if (event.value < previous.value) {
    if (state.runHasEnergy && !runFinal(state)
      && !(end !== null && previous.measuredAt >= end)) addQuality(state, 'missing-final-reference');
    // The preceding subtotal remains accounted for. The new native cumulative
    // run starts at zero, even when its first delivered sample is positive.
    state.observedKwh += event.value;
    state.runStart = event.measuredAt;
    state.runHasEnergy = event.value > 0;
    state.runSawCharging = state.charging === true;
    state.stopAt = null;
    state.resumedAt = null;
    if (state.runHasEnergy) state.runCount++;
    // Once a post-unplug reset closes the last native run, later positive
    // values cannot be donated to the connection that has already ended.
    if (end !== null && event.measuredAt >= end) {
      state.observedKwh -= event.value;
      if (state.runHasEnergy) state.runCount--;
      state.runHasEnergy = false;
      state.closedAt = event.measuredAt;
    }
  } else {
    if (state.resumedAt !== null && event.measuredAt >= state.resumedAt) addQuality(state, 'reference-coverage-gap');
    const increment = event.value - previous.value;
    state.observedKwh += increment;
    if (event.value > 0 && !state.runHasEnergy) { state.runHasEnergy = true; state.runCount++; }
    // A counter that increases after a stopped final sample proves that the
    // previous stop did not bound all energy in this run.
    if (increment > 0 && state.stopAt !== null && previous.measuredAt >= state.stopAt
      && state.charging === true) state.stopAt = null;
  }
  state.reference = { value: event.value, measuredAt: event.measuredAt, receivedAt: event.receivedAt };
}

function observeNative(session, event, config) {
  const sameInitialZero = session && event.kind === 'reference' && event.value === 0 && event.correlated === true
    && event.measuredAt < session.start && event.receivedAt >= session.start
    && (session.nativeRuns?.base.reference?.measuredAt === event.measuredAt
      && session.nativeRuns.base.reference.value === 0 || session.nativeRuns?.events.some(previous =>
      previous.kind === 'reference' && previous.value === 0 && previous.measuredAt === event.measuredAt));
  const freshInitialZero = session && event.kind === 'reference' && event.value === 0
    && event.correlated === true && event.measuredAt < session.start && event.receivedAt >= session.start
    && event.receivedAt <= session.start + config.maxAgeMs * 2;
  if (!session || event.measuredAt < session.start && !freshInitialZero && !sameInitialZero
    || session.deadline !== null && event.receivedAt > session.deadline) return;
  // An unchanged zero keeps its native source clock. Its correlated receipt
  // can establish a baseline after plug-in only while native work-state
  // evidence still establishes that charging has not started.
  if (freshInitialZero || sameInitialZero) event = { ...event, orderAt: event.receivedAt };
  // This optional current state starts from new observations only. In particular,
  // an acquisition state that predates the feature has no earlier run evidence.
  if (!Object.hasOwn(session, 'nativeRuns')) session.nativeRuns = newNativeRuns(session.start, config.maxAgeMs, true);
  const accumulator = session.nativeRuns;
  if (!accumulator || accumulator.version !== 1) throw new Error('Unsupported Shelly native session accumulator');
  if (event.kind === 'reference') {
    if (accumulator.lastReceivedAt !== null && event.receivedAt - accumulator.lastReceivedAt > config.maxAgeMs * 2) {
      addQuality(accumulator.base, 'reference-coverage-gap');
    }
    accumulator.lastReceivedAt = Math.max(accumulator.lastReceivedAt ?? event.receivedAt, event.receivedAt);
    // Correlated unchanged reads prove acquisition continuity without donating
    // a new source timestamp or adding the same cumulative reading twice.
    if (accumulator.base.reference?.measuredAt === event.measuredAt) {
      if (accumulator.base.reference.value !== event.value) throw new Error('Conflicting Shelly native session observation');
      return;
    }
  }
  if (accumulator.base.committedAt !== null && eventTime(event) <= accumulator.base.committedAt) {
    addQuality(accumulator.base, 'assignment-uncertain'); return;
  }
  const duplicate = accumulator.events.find(previous => previous.kind === event.kind && previous.measuredAt === event.measuredAt);
  if (duplicate) {
    if (event.kind === 'reference' ? duplicate.value !== event.value : duplicate.charging !== event.charging) {
      throw new Error('Conflicting Shelly native session observation');
    }
    return;
  }
  accumulator.events.push(copy(event));
  ordered(accumulator.events);
  // Only a short, settling window needs role-order replay. Fold older native
  // evidence into a compact subtotal; no growing telemetry history is added.
  const latest = eventTime(accumulator.events.at(-1));
  while (accumulator.events.length > 1 && eventTime(accumulator.events[0]) < latest - config.maxAgeMs * 2) {
    const first = accumulator.events.shift();
    foldNative(accumulator.base, first, session.end);
    accumulator.base.committedAt = eventTime(first);
  }
}

function nativeSummary(session, { end = session?.end, nextStart = null } = {}) {
  if (!session) return null;
  const accumulator = session.nativeRuns;
  const result = { kind: 'plug-period-native-runs', observedKwh: null, runCount: 0, complete: false,
    quality: [], observedAt: null };
  if (!Object.hasOwn(session, 'nativeRuns')) { result.quality = ['missing-start', 'missing-final-reference']; return result; }
  if (!accumulator || accumulator.version !== 1) throw new Error('Unsupported Shelly native session accumulator');
  const state = copy(accumulator.base);
  if (nextStart !== null && state.committedAt !== null && state.committedAt >= nextStart
    || end !== null && state.runStart > end && state.closedAt === null) {
    result.quality = ['assignment-uncertain']; return result;
  }
  for (const event of accumulator.events) if (nextStart === null || eventTime(event) < nextStart) foldNative(state, event, end);
  result.observedKwh = state.reference ? state.observedKwh : null;
  result.runCount = state.runCount;
  result.observedAt = state.reference?.measuredAt ?? null;
  if (!state.reference) addQuality(state, 'missing-start');
  const final = state.reference && (state.runHasEnergy
    ? end !== null && (state.reference.measuredAt >= end || runFinal(state))
    : end !== null && (state.runCount > 0 || state.reference.measuredAt >= end));
  if (!final && end !== null) addQuality(state, 'missing-final-reference');
  if (session.quality.includes('session-reference-unverified')) addQuality(state, 'session-reference-unverified');
  if (session.quality.includes('assignment-uncertain')) addQuality(state, 'assignment-uncertain');
  result.quality = state.quality.sort();
  result.complete = !!final && result.quality.length === 0;
  return result;
}

/** Compact public observation, separate from the stored-phase comparison. */
export function shellySessionReference(state) {
  const session = state.active ?? state.pending;
  if (!session) return null;
  return { ...nativeSummary(session), phase: state.active ? 'active' : 'settling', start: session.start };
}

function finalize({ state, store, recorder, association, now, nextStart = null }) {
  const session = state.pending;
  if (!session) return;
  const native = nativeSummary(session, { nextStart });
  recorder.flush?.(now, { force: true, source: 'shelly-evse', device: association, prefix: 'ev2' });
  const compared = compareRecordedChargingEnergy(store, { source: 'shelly-evse', device: association,
    prefix: 'ev2', start: session.start, end: session.end, now });
  for (const flag of native.quality) addQuality(session, flag);
  if (!compared) addQuality(session, 'incomplete-coverage');
  else if (compared.edgeEstimated) addQuality(session, 'estimated-boundary');
  const { observedAt: _observedAt, ...referenceAggregation } = native;
  recordChargingSessionCheck(store, { source: 'shelly-evse', sessionKey: session.sessionKey,
    recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy',
    start: session.start, end: session.end, estimatedKwh: compared?.estimatedKwh ?? null,
    referenceKwh: native.complete ? native.observedKwh : null, referenceAggregation,
    complete: !!compared && native.complete && session.quality.every(flag => flag === 'estimated-boundary'),
    quality: session.quality });
  state.pending = null;
}

/** Native reset-delimited charging runs are summed within one physical plug
 * connection. Missing run finals preserve an observed subtotal but exclude an
 * exact comparison. No lifetime/recorded energy can fill native reference gaps.
 * The short settlement window allows independently delivered source-time work
 * states, references and recorded phases to arrive before the check is frozen.
 */
export function updateShellySessionChecks({ state, connection, role, field, config, store, recorder, association, now,
  recordingQuality = null, intervalStart = null }) {
  if (connection?.connected && state.active?.sessionKey !== connection.sessionId) {
    if (state.pending) finalize({ state, store, recorder, association, now, nextStart: connection.connectedAt });
    const zero = state.zero?.measuredAt >= connection.connectedAt
      && state.zero.measuredAt <= connection.connectedAt + config.maxAgeMs * 2 ? state.zero : null;
    state.active = { sessionKey: connection.sessionId, start: connection.connectedAt, end: null, deadline: null,
      zeroAt: zero?.measuredAt ?? null, reference: null, reset: null, nativeRuns: newNativeRuns(connection.connectedAt, config.maxAgeMs),
      quality: config.sessionEnergyVerified === true ? [] : ['session-reference-unverified'] };
    // These are current independently delivered start observations, never a
    // reconstruction of the absent accumulator of an existing session.
    for (const reference of [zero, state.reference]) if (reference) observeNative(state.active,
      { kind: 'reference', ...reference }, config);
  } else if (connection?.connected === false && state.active) {
    const end = connection.lastDisconnectedAt;
    if (end > state.active.start) state.pending = { ...state.active, end, deadline: now + config.maxAgeMs * 2 };
    state.active = null;
  }

  if (config.sessionEnergyVerified !== true) for (const session of [state.active, state.pending]) {
    addQuality(session, 'session-reference-unverified');
  }

  if (field && !field.retained) {
    let event = null;
    if (role === 'energy_charge') {
      const reference = { value: field.value, measuredAt: field.measuredAt, receivedAt: field.receivedAt,
        correlated: field.correlated === true };
      if (!state.reference || reference.measuredAt >= state.reference.measuredAt) {
        if (reference.value === 0) state.zero = { ...reference,
          positiveBeforeAt: state.reference?.value > 0 ? state.reference.measuredAt : state.zero?.positiveBeforeAt ?? null };
        state.reference = reference;
      }
      event = { kind: 'reference', ...reference };
    } else if (role === 'work_state') {
      const charging = config.chargingStates?.includes(field.value) ? true
        : [...(config.connectedStates ?? []), ...(config.disconnectedStates ?? [])].includes(field.value) ? false : null;
      if (charging !== null) event = { kind: 'work', charging, measuredAt: field.measuredAt, receivedAt: field.receivedAt };
    }
    if (event) for (const session of [state.active, state.pending]) {
      if (session && event.kind === 'reference' && event.measuredAt >= session.start) {
        if (event.value === 0 && session.zeroAt === null) session.zeroAt = event.measuredAt;
        if (session.reference && event.value < session.reference.value) session.reset = copy(event);
        session.reference = { value: event.value, measuredAt: event.measuredAt, receivedAt: event.receivedAt };
      }
      observeNative(session, event, config);
    }
  }
  if (recordingQuality) for (const session of [state.active, state.pending]) {
    if (session && field.measuredAt >= session.start && (session.end === null || intervalStart < session.end)) {
      addQuality(session, recordingQuality);
    }
  }
  if (state.pending && now >= state.pending.deadline) finalize({ state, store, recorder, association, now });
}
