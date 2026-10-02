import { recordChargingSessionCheck } from '../app/charging-session-checks.js';
import { compareRecordedChargingEnergy } from '../acquisition/recorded-charging-energy.js';

const copy = value => structuredClone(value);
const addQuality = (session, flag) => { if (session && !session.quality.includes(flag)) session.quality.push(flag); };

export const newShellySessionCheckState = () => ({ version: 1, active: null, pending: null, reference: null, zero: null });

function observeReference(session, reference, maxAgeMs) {
  if (!session || reference.measuredAt < session.start
    || session.deadline !== null && reference.receivedAt > session.deadline) return;
  if (session.reset) return;
  if (session.reference && reference.measuredAt > session.reference.measuredAt
    && reference.value < session.reference.value) {
    // The next connection's reset may precede its work-state notification.
    // Keep the prior candidate until the connection can establish ownership.
    session.reset = copy(reference); return;
  }
  if (reference.value === 0 && session.zeroAt === null && reference.measuredAt <= session.start + maxAgeMs * 2) {
    session.zeroAt = reference.measuredAt;
  }
  session.reference = copy(reference);
}

function finalize({ state, store, recorder, association, now, nextStart = null }) {
  const session = state.pending;
  if (!session) return;
  if (session.reset && !(nextStart !== null && session.end <= nextStart && nextStart <= session.reset.measuredAt)) addQuality(session, 'counter-reset');
  const reference = session.reference?.measuredAt >= session.end
    && (nextStart === null || session.reference.measuredAt < nextStart) ? session.reference : null;
  recorder.flush?.(now, { force: true, source: 'shelly-evse', device: association, prefix: 'ev2' });
  const compared = compareRecordedChargingEnergy(store, { source: 'shelly-evse', device: association,
    prefix: 'ev2', start: session.start, end: session.end, now });
  const baseline = session.zeroAt === session.start || session.zeroAt > session.start
    && compareRecordedChargingEnergy(store, { source: 'shelly-evse', device: association, prefix: 'ev2',
      start: session.start, end: session.zeroAt, now })?.estimatedKwh === 0;
  if (!baseline) addQuality(session, 'missing-start');
  if (!reference) addQuality(session, 'missing-final-reference');
  if (!compared) addQuality(session, 'incomplete-coverage');
  else if (compared.edgeEstimated) addQuality(session, 'estimated-boundary');
  recordChargingSessionCheck(store, { source: 'shelly-evse', sessionKey: session.sessionKey,
    recordingBasis: 'native-meter-counter-phase-allocation', referenceBasis: 'native-session-energy',
    start: session.start, end: session.end, estimatedKwh: compared?.estimatedKwh ?? null,
    referenceKwh: reference?.value ?? null,
    complete: !!compared && !!reference && session.quality.every(flag => flag === 'estimated-boundary'),
    quality: session.quality });
  state.pending = null;
}

/** One active and one settling physical session, persisted with acquisition.
 * Commissioning must establish that energy_charge resets at connection, spans
 * pauses and retains its final total after disconnection. A running value or a
 * lifetime-counter delta cannot substitute for that final native reference.
 * Allow two freshness windows for independently delivered end/reference/phase
 * reports before freezing a comparison. Never finalize in role arrival order.
 */
export function updateShellySessionChecks({ state, connection, role, field, config, store, recorder, association, now,
  recordingQuality = null, intervalStart = null }) {
  if (connection?.connected && state.active?.sessionKey !== connection.sessionId) {
    // A later physical connection bounds the previous reference's identity;
    // it cannot donate its reset counter or phase energy to the previous one.
    if (state.pending) finalize({ state, store, recorder, association, now, nextStart: connection.connectedAt });
    const zero = state.zero?.measuredAt >= connection.connectedAt
      && state.zero.measuredAt <= connection.connectedAt + config.maxAgeMs * 2 ? state.zero : null;
    state.active = { sessionKey: connection.sessionId, start: connection.connectedAt, end: null, deadline: null,
      zeroAt: zero?.measuredAt ?? null, reference: null, reset: null,
      quality: config.sessionEnergyVerified === true ? [] : ['session-reference-unverified'] };
    if (zero?.positiveBeforeAt >= connection.connectedAt) addQuality(state.active, 'counter-reset');
    if (state.reference) observeReference(state.active, state.reference, config.maxAgeMs);
  } else if (connection?.connected === false && state.active) {
    const end = connection.lastDisconnectedAt;
    if (end > state.active.start) {
      state.pending = { ...state.active, end, deadline: now + config.maxAgeMs * 2 };
    }
    state.active = null;
  }

  if (config.sessionEnergyVerified !== true) for (const session of [state.active, state.pending]) {
    addQuality(session, 'session-reference-unverified');
  }

  if (role === 'energy_charge' && field && !field.retained) {
    const reference = { value: field.value, measuredAt: field.measuredAt, receivedAt: field.receivedAt };
    if (reference.value === 0) state.zero = { ...reference,
      positiveBeforeAt: state.reference?.value > 0 ? state.reference.measuredAt : state.zero?.positiveBeforeAt ?? null };
    state.reference = reference;
    observeReference(state.active, reference, config.maxAgeMs);
    observeReference(state.pending, reference, config.maxAgeMs);
  }
  if (recordingQuality) for (const session of [state.active, state.pending]) {
    if (session && field.measuredAt >= session.start && (session.end === null || intervalStart < session.end)) {
      addQuality(session, recordingQuality);
    }
  }
  if (state.pending && now >= state.pending.deadline) finalize({ state, store, recorder, association, now });
}
