import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceIdentification, validateIdentificationState, prepareActiveBmwCandidate,
  matchActiveBmwPause, IDENTIFICATION_CHARGE_LIMIT_MS } from '../src/charging/identification.js';
import { bmwChargingEvents, bmwConsumedChargingAt } from '../src/charging/vehicle.js';

const START = Date.parse('2026-09-25T10:00:00Z'), MINUTE = 60_000;
const input = overrides => ({ connectedAt: START, now: START, ...overrides });
const probeInput = overrides => input({ normalCharging: false, probeAllowed: true,
  probeReturnAt: START + 60 * MINUTE, ...overrides });
const event = (readingId, measuredAt, overrides = {}) => ({ readingId, measuredAt,
  receivedAt: measuredAt + 1000, retained: false, ...overrides });
function fixture() {
  const start = event('charging-start', START + 1000, { value: true });
  const reading = { provider: 'bmw-cardata', association: 'test-bmw-feed', atHome: true,
    pluggedIn: true, charging: true, fields: {
      atHome: event('home', START - MINUTE, { retained: true }),
      pluggedIn: event('plug', START - MINUTE, { retained: true }),
      charging: { ...start, positiveEvent: start, negativeEvent: null, history: [start], historyOverflowAt: null },
    } };
  const options = { connectedAt: START, lastDisconnectedAt: START - 2 * MINUTE,
    chargingAt: START + 1000, physicalAt: START + 2000, now: START + 3000 };
  return { reading, options };
}
function pausedFixture() {
  const { reading, options } = fixture();
  const candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate, powerKw: 11 }));
  const pause = { connectedAt: START, requestedAt: START + 4000, confirmedAt: START + 7000,
    stoppedAt: START + 6000, startAt: state.pauseUntil };
  state = advanceIdentification(state, input({ now: START + 8000, charging: false, powerKw: 0, pause }));
  const stop = event('charging-stop', START + 6500, { value: false });
  reading.charging = false;
  reading.fields.charging = { ...stop, positiveEvent: reading.fields.charging.positiveEvent, negativeEvent: stop,
    history: [...reading.fields.charging.history, stop], historyOverflowAt: null };
  return { reading, state, pause, now: START + 9000 };
}

test('a scheduled vehicle remains pending indefinitely without spending its one attempt', () => {
  let state = advanceIdentification(null, input({ normalCharging: false }));
  assert.equal(state.phase, 'waiting'); assert.equal(state.action, null);
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ normalCharging: false, now: START + 24 * 60 * MINUTE }));
  assert.equal(state.phase, 'waiting'); assert.equal(state.attempt, 1);
  assert.equal(state.chargeDeadlineAt, null); assert.equal(state.completedAt, null);
  validateIdentificationState(state);
});

test('unavailable telemetry and explicit stop withhold charging permission while waiting', () => {
  for (const overrides of [{ available: false }, { manualStop: true }]) {
    const state = advanceIdentification(null, input({ charging: true, ...overrides }));
    assert.equal(state.phase, 'waiting'); assert.equal(state.action, null);
  }
});

test('a fresh matched BMW start pauses immediately, with an absolute second-aligned recovery deadline', () => {
  const { reading, options } = fixture();
  const candidate = prepareActiveBmwCandidate(reading, options);
  const state = advanceIdentification(null, input({ now: options.now, candidate, charging: true }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
  assert.equal(state.pauseUntil % 1000, 0);
  assert.ok(state.pauseUntil - options.now >= 90_000 && state.pauseUntil - options.now < 91_000);
  assert.equal(state.candidate.kind, 'start');
  validateIdentificationState(state);
});

test('a vehicle source edge in the current millisecond waits until it strictly precedes the pause request', () => {
  const { reading, options } = fixture();
  const start = event('same-millisecond-start', options.now, { receivedAt: options.now, value: true });
  reading.fields.charging = { ...start, positiveEvent: start, negativeEvent: null, history: [start], historyOverflowAt: null };
  const candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  assert.equal(state.phase, 'charging'); assert.equal(state.action, 'allow');
  assert.equal(state.pauseUntil, null);
  state = advanceIdentification(state, input({ now: options.now + 1, charging: true, candidate }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
});

test('normal authorized charging has no probe time or energy allowance', () => {
  let state = advanceIdentification(null, input({ charging: true, energyKwh: 2, powerKw: 22 }));
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now: START + 78 * MINUTE,
    charging: true, energyKwh: 20, powerKw: 22 }));
  assert.equal(state.phase, 'charging'); assert.equal(state.action, 'allow');
  assert.equal(state.probe, null); assert.equal(state.chargeDeadlineAt, null);
  assert.equal(state.chargeUsedKwh, 0); assert.equal(state.completedAt, null);
  validateIdentificationState(state);
});

test('probe time and delivered-energy limits request a stop even without BMW evidence and never reset on restart', () => {
  for (const override of [{ now: START + IDENTIFICATION_CHARGE_LIMIT_MS, reason: 'probe-time-limit' },
    { now: START + 10_000, energyKwh: 2.151, reason: 'probe-energy-limit' }]) {
    let state = advanceIdentification(null, probeInput({ charging: true, energyKwh: 2 }));
    state = advanceIdentification(state, probeInput({ charging: true, ...override }));
    assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
    assert.equal(state.reason, override.reason); assert.equal(state.candidate, null);
    const pause = { connectedAt: START, requestedAt: override.now + 1000,
      stoppedAt: override.now + 2000, confirmedAt: override.now + 3000, startAt: state.probe.returnStartAt };
    state = advanceIdentification(state, probeInput({ now: override.now + 4000, pause, charging: false, powerKw: 0 }));
    assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
    assert.equal(state.completedAt, override.now + 4000); assert.ok(state.probe.endedAt);
    const restarted = advanceIdentification(JSON.parse(JSON.stringify(state)),
      probeInput({ now: START + 20 * MINUTE, charging: true }));
    assert.equal(restarted.phase, 'inconclusive'); assert.equal(restarted.attempt, 1);
    assert.equal(restarted.probe.startedAt, START); assert.equal(restarted.probe.endedAt, state.probe.endedAt);
    validateIdentificationState(restarted);
  }
});

test('power integration reserves stopping time within the extra-charge budget without a session meter', () => {
  let state = advanceIdentification(null, probeInput({ charging: true, powerKw: 4.14 }));
  state = advanceIdentification(state, probeInput({ now: START + 122_000, charging: true, powerKw: 4.14 }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.reason, 'probe-energy-limit');
  assert.ok(state.chargeUsedKwh > .13 && state.chargeUsedKwh < .15);
});

test('meter resets cannot renew a probe and missing physical telemetry requests a stop', () => {
  let state = advanceIdentification(null, probeInput({ charging: true, energyKwh: 10 }));
  const originalDeadline = state.chargeDeadlineAt;
  state = advanceIdentification(state, probeInput({ now: START + 30_000, energyKwh: 0,
    available: false, physicalFresh: false }));
  assert.equal(state.action, 'pause'); assert.equal(state.reason, 'telemetry-lost');
  assert.equal(state.chargeDeadlineAt, originalDeadline);
  validateIdentificationState(state);
});

test('backwards clock adjustments and restart preserve the confirmed pause and its original deadline', () => {
  const { state } = pausedFixture();
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
  let resumed = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now: START + 4000 }));
  assert.equal(resumed.lastAt, state.lastAt); assert.equal(resumed.pauseUntil, state.pauseUntil);
  assert.equal(resumed.phase, 'pausing'); assert.equal(resumed.action, 'pause');
  resumed = advanceIdentification(resumed, input({ now: state.pauseUntil + 120 * MINUTE }));
  assert.equal(resumed.phase, 'inconclusive'); assert.equal(resumed.completedAt, state.pauseUntil + 120 * MINUTE);
  assert.deepEqual(resumed.pause, state.pause);
  validateIdentificationState(resumed);
});

test('a requested pause has its own finite confirmation deadline while normal charging has no probe deadline', () => {
  const { reading, options } = fixture(), candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  assert.equal(state.chargeDeadlineAt, null);
  state = advanceIdentification(state, input({ now: state.pauseUntil, charging: true }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'pause-timeout');
  assert.equal(state.action, null); assert.equal(state.pause, null);
});

test('missing charging telemetry does not renew an unconfirmed pause', () => {
  const { reading, options } = fixture(), candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  state = advanceIdentification(state, input({ now: state.pauseUntil, available: false, physicalFresh: false }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'pause-timeout');
  assert.equal(state.action, null);
});

test('confirmed physical stop retains the bounded BMW observation pause until its original deadline', () => {
  const { state } = pausedFixture();
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
  const later = advanceIdentification(state, input({ now: START + MINUTE, charging: false, powerKw: 0 }));
  assert.equal(later.phase, 'pausing'); assert.equal(later.action, 'pause');
  assert.deepEqual(later.pause, state.pause);
  assert.equal(later.pauseUntil, state.pauseUntil);
  const expired = advanceIdentification(later, input({ now: state.pauseUntil, charging: false, powerKw: 0 }));
  assert.equal(expired.phase, 'inconclusive'); assert.equal(expired.action, null);
  assert.equal(expired.reason, 'pause-timeout');
});

test('BMW reports arriving during the bounded hold retain source clocks and release promptly after a positive match', () => {
  for (const delay of [30_000, 60_000]) {
    const { state, reading } = pausedFixture(), now = state.pause.stoppedAt + delay;
    const measuredAt = reading.fields.charging.negativeEvent.measuredAt;
    reading.fields.charging.negativeEvent.receivedAt = now;
    const held = advanceIdentification(state, input({ now, charging: false, powerKw: 0 }));
    assert.equal(held.phase, 'pausing');
    assert.ok(matchActiveBmwPause(reading, { state: held, now }));
    assert.equal(reading.fields.charging.negativeEvent.measuredAt, measuredAt);
    const completed = advanceIdentification(held, input({ now, identified: true }));
    assert.equal(completed.phase, 'completed'); assert.equal(completed.action, null);
    assert.ok(completed.completedAt < state.pauseUntil);
    assert.deepEqual(completed.pause, state.pause);
  }
});

test('a positive identity or explicit manual stop ends a held BMW pause without extending it', () => {
  for (const condition of [{ identified: true }, { manualStop: true }]) {
    const { state } = pausedFixture();
    const ended = advanceIdentification(state, input({ now: START + 10_000, ...condition }));
    assert.equal(ended.action, null);
    assert.equal(ended.phase, condition.identified ? 'completed' : 'inconclusive');
    assert.equal(ended.pauseUntil, state.pauseUntil);
  }
});

test('physical stop ends probe accounting but preserves its BMW pause and economic return across restart', () => {
  const { reading, options } = fixture(), candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, probeInput({ now: options.now, charging: true, candidate,
    energyKwh: 2, powerKw: 7 }));
  const deadline = state.pauseUntil, probe = structuredClone(state.probe);
  const pause = { connectedAt: START, requestedAt: START + 4000, confirmedAt: START + 7000,
    stoppedAt: START + 6000, startAt: probe.returnStartAt };
  state = advanceIdentification(state, probeInput({ now: START + 8000, charging: false, powerKw: 0, pause }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
  assert.equal(state.probe.endedAt, START + 8000);
  const usedKwh = state.chargeUsedKwh;
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: START + MINUTE,
    charging: false, powerKw: 0, energyKwh: 2.02, pause }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.pauseUntil, deadline);
  assert.equal(state.chargeUsedKwh, usedKwh); assert.equal(state.probe.returnStartAt, probe.returnStartAt);
  state = advanceIdentification(state, probeInput({ now: deadline, charging: false, powerKw: 0 }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
  assert.equal(state.probe.endedAt, START + 8000);
  validateIdentificationState(state);
});

test('a probe without physical draw still stops at its safety duration and retains the single allowance', () => {
  let state = advanceIdentification(null, probeInput());
  assert.equal(state.phase, 'waiting'); assert.equal(state.action, 'allow');
  state = advanceIdentification(state, probeInput({ now: START + IDENTIFICATION_CHARGE_LIMIT_MS }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.reason, 'probe-time-limit');
  state = advanceIdentification(state, probeInput({ now: state.pauseUntil }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
  const restart = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: START + 20 * MINUTE }));
  assert.equal(restart.probe.startedAt, START); assert.equal(restart.phase, 'inconclusive');
  validateIdentificationState(restart);
});

test('normal charging takes over from a used probe without reopening active identification', () => {
  let state = advanceIdentification(null, probeInput({ charging: true, energyKwh: 0 }));
  state = advanceIdentification(state, input({ now: START + MINUTE, charging: true,
    normalCharging: true, energyKwh: 1, powerKw: 11 }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
  assert.equal(state.reason, 'interrupted');
  assert.equal(state.probe.endedAt, START + MINUTE);
  const later = advanceIdentification(state, input({ now: START + 78 * MINUTE, charging: true, energyKwh: 20 }));
  assert.equal(later.phase, 'inconclusive'); assert.equal(later.action, null);
  validateIdentificationState(later);
});

test('manual retry works for completed identification while disconnect creates a new automatic attempt', () => {
  let state = advanceIdentification(null, input({ identified: true }));
  assert.equal(state.phase, 'completed');
  const previousId = state.id;
  state = advanceIdentification(state, input({ now: START + 5000, manualRetry: true, identified: true }));
  assert.equal(state.phase, 'waiting'); assert.equal(state.attempt, 2); assert.notEqual(state.id, previousId);
  assert.equal(advanceIdentification(state, input({ connected: false })), null);
  state = advanceIdentification(state, input({ connectedAt: START + 10_000, now: START + 10_000 }));
  assert.equal(state.attempt, 1); assert.equal(state.phase, 'waiting');
});

test('explicit manual stop interrupts an active attempt without spending another automatic attempt', () => {
  let state = advanceIdentification(null, input({ charging: true }));
  state = advanceIdentification(state, input({ now: START + 1000, manualStop: true }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'manual-stop');
  assert.equal(advanceIdentification(state, input({ now: START + 2000 })).phase, 'inconclusive');
});

test('persisted identification rejects unknown shape, impossible deadlines and foreign proof', () => {
  const { state } = pausedFixture();
  for (const patch of [{ oldState: true }, { version: 0 }, { attempt: 0 }, { phase: 'pending' },
    { id: 'foreign' }, { chargeDeadlineAt: state.chargeDeadlineAt + 1 },
    { candidate: { ...state.candidate, connectedAt: START + 1 } },
    { pause: { ...state.pause, startAt: state.pauseUntil + 1 } }])
    assert.throws(() => validateIdentificationState({ ...state, ...patch }), /fresh development database/);
});

test('ongoing charging at startup uses a live baseline without inventing an old start edge', () => {
  const { reading, options } = fixture();
  const ongoing = event('ongoing-live', START - 2 * MINUTE, { receivedAt: START + 2000 });
  const oldStart = event('old-start', START - 60 * MINUTE, { retained: true, value: true });
  reading.fields.charging = { ...ongoing, positiveEvent: oldStart,
    history: [oldStart, { ...ongoing, value: true }], historyOverflowAt: null };
  const candidate = prepareActiveBmwCandidate(reading, { ...options, chargingAt: [], lastDisconnectedAt: null });
  assert.equal(candidate.kind, 'ongoing'); assert.equal(candidate.readingId, 'ongoing-live');
  assert.equal(candidate.measuredAt, ongoing.measuredAt);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  const pause = { connectedAt: START, requestedAt: START + 4000, confirmedAt: START + 7000,
    stoppedAt: START + 6000, startAt: state.pauseUntil };
  state = advanceIdentification(state, input({ now: START + 8000, pause }));
  const stop = event('new-stop', START + 6500, { value: false }); reading.charging = false;
  reading.fields.charging.negativeEvent = stop; reading.fields.charging.history.push(stop);
  assert.equal(matchActiveBmwPause(reading, { state, now: START + 9000 }).chargingReadingId, 'ongoing-live');
});

test('retained and stale true values never become live baselines through fresh delivery alone', () => {
  for (const override of [{ retained: true }, { retained: undefined }, { measuredAt: START - 5 * MINUTE },
    { receivedAt: START - MINUTE }, { measuredAt: START + MINUTE }, { receivedAt: START + MINUTE },
    { measuredAt: null }, { readingId: '' }]) {
    const { reading, options } = fixture();
    reading.fields.charging = { ...reading.fields.charging, positiveEvent: null, history: [], ...override };
    assert.equal(prepareActiveBmwCandidate(reading, options), null, JSON.stringify(override));
  }
});

test('home, inlet, departure, consumed evidence and charger freshness fence candidates', () => {
  for (const key of ['atHome', 'pluggedIn']) {
    const { reading, options } = fixture(); reading[key] = false;
    assert.equal(prepareActiveBmwCandidate(reading, options), null);
  }
  const { reading, options } = fixture();
  for (const override of [{ consumedChargingId: 'charging-start' }, { lastDisconnectedAt: START + 1000 },
    { physicalAt: START - MINUTE }, { physicalAt: null }])
    assert.equal(prepareActiveBmwCandidate(reading, { ...options, ...override }), null);
  reading.fields.atHome.negativeEvent = event('departure', START + 1500);
  assert.equal(prepareActiveBmwCandidate(reading, options), null);
});

test('only a correlated live vehicle stop and saved physical pause proof identify the BMW', () => {
  const { reading, state, now } = pausedFixture();
  assert.deepEqual(matchActiveBmwPause(reading, { state, now }), {
    chargingReadingId: 'charging-start', stopReadingId: 'charging-stop', confirmedAt: START + 7000,
  });
  assert.equal(matchActiveBmwPause(reading, { state: { ...state, pause: null }, now }), null);
  for (const override of [{ retained: true }, { retained: undefined }, { measuredAt: state.pause.requestedAt },
    { measuredAt: state.pause.stoppedAt + 30_001 }, { measuredAt: state.pauseUntil + 1 },
    { receivedAt: state.pause.requestedAt - 1 }, { receivedAt: now + 1 }, { readingId: '' }]) {
    const changed = structuredClone(reading); Object.assign(changed.fields.charging.negativeEvent, override);
    assert.equal(matchActiveBmwPause(changed, { state, now }), null, JSON.stringify(override));
  }
});

test('a guarded request may share the physical baseline millisecond but not its vehicle source edge', () => {
  const { reading, state, now } = pausedFixture();
  state.candidate.capturedAt = state.pause.requestedAt;
  state.candidate.physicalAt = state.pause.requestedAt;
  assert.ok(matchActiveBmwPause(reading, { state, now }));
  state.candidate.measuredAt = state.pause.requestedAt;
  assert.equal(matchActiveBmwPause(reading, { state, now }), null);
});

test('late reports identify hours after pause release and restart only from the saved original stop window', () => {
  let { reading, state } = pausedFixture();
  const now = state.pauseUntil + 120 * MINUTE;
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now }));
  assert.equal(state.phase, 'inconclusive');
  reading.fields.charging.negativeEvent.receivedAt = now;
  assert.ok(matchActiveBmwPause(reading, { state, now }));
  assert.ok(matchActiveBmwPause(reading, { state, now: now + 15 * MINUTE }));
  reading.charging = true;
  reading.fields.charging.history.push(event('resumed-before-stop-delivery', now - MINUTE, { value: true }));
  assert.ok(matchActiveBmwPause(reading, { state, now }));
  const completed = advanceIdentification(state, input({ now, identified: true }));
  assert.equal(completed.phase, 'completed'); assert.equal(completed.action, null);
});

test('feed changes, vehicle departure, foreign connection and consumed baselines reject a saved test', () => {
  const { reading, state, now } = pausedFixture();
  assert.equal(matchActiveBmwPause(reading, { state, now, consumedChargingId: 'charging-start' }), null);
  assert.equal(matchActiveBmwPause(reading, { state, now, lastDisconnectedAt: START + 1500 }), null);
  assert.equal(matchActiveBmwPause({ ...reading, association: 'different-feed' }, { state, now }), null);
  assert.equal(matchActiveBmwPause(reading, { state: { ...state, connectedAt: START + 1 }, now }), null);
});

test('consuming an ongoing BMW baseline retires older and equal source episodes without hiding a newer report', () => {
  const { reading, state: oldState } = pausedFixture();
  const resumed = event('newer-charging-start', START + 10_000, { value: true });
  const consumed = event('consumed-ongoing-baseline', START + 11_000, { value: true });
  reading.charging = true;
  reading.fields.charging = { ...reading.fields.charging, ...consumed,
    history: [...reading.fields.charging.history, resumed, consumed] };
  assert.equal(bmwChargingEvents(reading).some(row => row.readingId === consumed.readingId), false,
    'An unchanged ongoing report is not a new charging transition');
  assert.equal(bmwConsumedChargingAt(reading, consumed.readingId), consumed.measuredAt);
  const options = { connectedAt: START, lastDisconnectedAt: null, chargingAt: [resumed.measuredAt],
    physicalAt: START + 13_000, now: START + 13_000, consumedChargingId: consumed.readingId };
  assert.ok(matchActiveBmwPause(reading, { state: oldState, now: options.now }),
    'The original saved pause would otherwise still match its historical episode');
  assert.equal(matchActiveBmwPause(reading, { state: oldState, now: options.now,
    consumedChargingId: consumed.readingId }), null);
  assert.equal(prepareActiveBmwCandidate(reading, options), null);
  const equal = event('equal-source-different-reading', consumed.measuredAt, { value: true });
  Object.assign(reading.fields.charging, equal); reading.fields.charging.history.push(equal);
  assert.equal(prepareActiveBmwCandidate(reading, options), null,
    'Another reading ID at the consumed source time cannot reopen the episode');

  const newer = event('genuinely-newer-ongoing', START + 12_000, { value: true });
  Object.assign(reading.fields.charging, newer); reading.fields.charging.history.push(newer);
  const candidate = prepareActiveBmwCandidate(reading, options);
  assert.equal(candidate.kind, 'ongoing'); assert.equal(candidate.readingId, newer.readingId);
  let state = advanceIdentification(oldState, input({ now: options.now, manualRetry: true,
    charging: true, candidate }));
  const pause = { connectedAt: START, requestedAt: START + 14_000, stoppedAt: START + 16_000,
    confirmedAt: START + 17_000, startAt: state.pauseUntil };
  state = advanceIdentification(state, input({ now: START + 18_000, pause }));
  const stopped = event('newer-correlated-stop', START + 16_500, { value: false });
  reading.charging = false; Object.assign(reading.fields.charging, stopped);
  reading.fields.charging.negativeEvent = stopped; reading.fields.charging.history.push(stopped);
  assert.equal(matchActiveBmwPause(reading, { state, now: START + 19_000,
    consumedChargingId: consumed.readingId }).chargingReadingId, newer.readingId);
});

test('manual retry can reuse the same live ongoing baseline but can never reuse its previous stop', () => {
  const { reading: oldReading, state: oldState } = pausedFixture();
  const { reading, options } = fixture();
  const now = START + 12_000;
  const candidate = prepareActiveBmwCandidate(reading, { ...options, now, physicalAt: now, chargingAt: [] });
  let state = advanceIdentification(oldState, input({ now, manualRetry: true, charging: true, candidate }));
  assert.equal(state.attempt, 2); assert.equal(state.pause, null);
  const pause = { connectedAt: START, requestedAt: now + 1000, stoppedAt: now + 2000,
    confirmedAt: now + 3000, startAt: state.pauseUntil };
  state = advanceIdentification(state, input({ now: now + 4000, pause }));
  assert.equal(matchActiveBmwPause(oldReading, { state, now: now + 4000 }), null);
  const stop = event('retry-stop', now + 2500, { value: false }); reading.charging = false;
  reading.fields.charging.negativeEvent = stop; reading.fields.charging.history.push(stop);
  assert.ok(matchActiveBmwPause(reading, { state, now: now + 4000 }));
});


test('manual Stop ends a waiting probe allowance before any physical charging starts', () => {
  let state = advanceIdentification(null, probeInput());
  assert.equal(state.phase, 'waiting'); assert.equal(state.probe.endedAt, null);
  state = advanceIdentification(state, probeInput({ now: START + 1000, manualStop: true }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
  assert.equal(state.reason, 'manual-stop'); assert.equal(state.probe.endedAt, START + 1000);
  const restarted = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: START + MINUTE }));
  assert.equal(restarted.phase, 'inconclusive'); assert.equal(restarted.action, null);
  assert.equal(restarted.probe.startedAt, START); assert.equal(restarted.probe.endedAt, START + 1000);
  validateIdentificationState(restarted);
});

test('overflowed BMW history cannot fall back to a current baseline and request a useless pause', () => {
  const { reading, options } = fixture();
  reading.fields.charging.historyOverflowAt = options.now - 1;
  const candidate = prepareActiveBmwCandidate(reading, options);
  assert.equal(candidate, null);
  const state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  assert.equal(state.phase, 'charging'); assert.equal(state.pauseUntil, null);
  assert.equal(state.action, 'allow');
});

test('fresh physical stop ends a drawing probe without inventing a causal identity pause', () => {
  let state = advanceIdentification(null, probeInput({ charging: true, powerKw: 4.14, probeDurationMs: 100_000 }));
  state = advanceIdentification(state, probeInput({ now: START + 100_000, charging: false, powerKw: 0,
    physicalStopped: true }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.pause, null);
  state = advanceIdentification(state, probeInput({ now: START + 101_000, charging: false, powerKw: 0,
    physicalStopped: true }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
  assert.equal(state.probe.endedAt, START + 101_000); assert.equal(state.pause, null);
  assert.equal(state.candidate, null, 'Physical stop alone cannot identify a vehicle');
  validateIdentificationState(state);
  const resumed = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: START + 2 * MINUTE }));
  assert.equal(resumed.phase, 'inconclusive'); assert.equal(resumed.probe.deadlineAt, START + 100_000);
});

test('physical-stop shortcut requires fresh zero evidence and previous probe draw', () => {
  for (const condition of ['stale', 'never-drew']) {
    let state = advanceIdentification(null, probeInput({ charging: condition !== 'never-drew',
      powerKw: condition === 'never-drew' ? 0 : 4.14, probeDurationMs: 100_000 }));
    state = advanceIdentification(state, probeInput({ now: START + 100_000, charging: false, powerKw: 0 }));
    state = advanceIdentification(state, probeInput({ now: START + 101_000, charging: false, powerKw: 0,
      physicalStopped: true, physicalFresh: condition !== 'stale' }));
    assert.equal(state.phase, 'pausing'); assert.equal(state.probe.endedAt, null); assert.equal(state.pause, null);
  }
});


test('immediate Tesla identification records the final extra-charge meter increment once and releases control', () => {
  let state = advanceIdentification(null, probeInput({ energyKwh: 2, powerKw: 0 }));
  state = advanceIdentification(state, probeInput({ now: START + 6000, charging: true,
    powerKw: 4.14, energyKwh: 2.01 }));
  assert.equal(state.phase, 'charging');
  const final = advanceIdentification(state, probeInput({ now: START + 10_000, charging: true,
    powerKw: 4.14, energyKwh: 2.018, identified: true }));
  assert.equal(final.phase, 'completed'); assert.equal(final.reason, 'identified');
  assert.equal(final.action, null); assert.equal(final.pauseUntil, null);
  assert.equal(final.probe.endedAt, START + 10_000);
  assert.ok(Math.abs(final.chargeUsedKwh - .018) < 1e-10,
    'The final meter increment belongs to the completed identification probe');
  const later = advanceIdentification(JSON.parse(JSON.stringify(final)), input({ now: START + 20 * MINUTE,
    charging: true, powerKw: 11, energyKwh: 5, identified: true }));
  assert.equal(later.chargeUsedKwh, final.chargeUsedKwh);
  assert.equal(later.probe.endedAt, final.probe.endedAt);
  validateIdentificationState(later);
});

test('the normal-current probe deadline survives restart without renewing its budget', () => {
  let state = advanceIdentification(null, probeInput({ probeDurationMs: 34_000 }));
  assert.equal(Object.hasOwn(state.probe, 'currentA'), false);
  validateIdentificationState(state);
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: START + 10_000,
    probeDurationMs: 108_000 }));
  assert.equal(state.probe.deadlineAt, START + 34_000);
  state = advanceIdentification(state, probeInput({ now: START + 34_000 }));
  assert.equal(state.phase, 'pausing');
  state = advanceIdentification(state, probeInput({ now: state.pauseUntil }));
  assert.equal(state.phase, 'inconclusive');
  validateIdentificationState(state);
});

test('saved probe state rejects retired current overrides', () => {
  const valid = advanceIdentification(null, probeInput());
  assert.throws(() => validateIdentificationState({ ...valid, probe: { ...valid.probe, currentA: 6 } }),
    /fresh development database/);
});

test('an economic probe waits for fresh physical power before spending its allowance', () => {
  let state = advanceIdentification(null, probeInput({ physicalFresh: false }));
  assert.equal(state.probe, null); assert.equal(state.action, null);
  state = advanceIdentification(state, probeInput({ now: START + 60_000, physicalFresh: true }));
  assert.equal(state.probe.startedAt, START + 60_000); assert.equal(state.action, 'allow');
});

test('interruption consumes active permission across restart and alternating economic choices', () => {
  const { reading, options } = fixture();
  for (const initial of [input({ charging: true }), probeInput(), probeInput({ charging: true })]) {
    let state = advanceIdentification(null, initial);
    state = advanceIdentification(state, input({ now: START + 1000, interrupted: true }));
    const finished = structuredClone(state);
    assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'interrupted');
    assert.equal(state.action, null); assert.equal(state.completedAt, START + 1000);
    for (let step = 1; step <= 8; step++) {
      const now = START + step * MINUTE;
      const candidate = prepareActiveBmwCandidate(reading, { ...options, now, physicalAt: now });
      state = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now,
        normalCharging: step % 2 === 0, charging: true, candidate }));
      assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
      assert.equal(state.id, finished.id); assert.equal(state.attempt, 1);
      assert.equal(state.completedAt, finished.completedAt); assert.equal(state.pauseUntil, null);
      assert.deepEqual(state.probe, finished.probe);
      validateIdentificationState(state);
    }
    const identified = advanceIdentification(state, input({ now: START + 10 * MINUTE, identified: true }));
    assert.equal(identified.phase, 'completed'); assert.equal(identified.action, null);
  }
});

test('an exhausted BMW pause cannot repeat after fresh charging or a planner transition', () => {
  let { state, reading } = pausedFixture();
  const originalPause = state.pauseUntil;
  state = advanceIdentification(state, input({ now: originalPause }));
  const endedAt = state.completedAt;
  for (let step = 1; step <= 4; step++) {
    const now = originalPause + step * MINUTE;
    const candidate = { ...state.candidate, physicalAt: now, capturedAt: now };
    state = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now,
      normalCharging: step % 2 === 0, charging: true, candidate }));
    assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
    assert.equal(state.pauseUntil, originalPause); assert.equal(state.completedAt, endedAt);
    assert.equal(state.probe, null); validateIdentificationState(state);
  }
  assert.ok(matchActiveBmwPause(reading, { state, now: state.lastAt }),
    'Exhaustion preserves the original evidence for passive matching');
  const retried = advanceIdentification(state, input({ now: state.lastAt + 1000, manualRetry: true }));
  assert.equal(retried.attempt, 2); assert.equal(retried.phase, 'waiting');
  assert.equal(retried.pauseUntil, null); assert.equal(retried.completedAt, null);
});

test('a conflict observation state remains passive even when normal charging resumes', () => {
  let state = advanceIdentification(null, input({ now: START, charging: true }));
  state = { ...state, phase: 'observing', action: null, reason: 'awaiting-evidence' };
  for (const normalCharging of [true, false, true]) {
    state = advanceIdentification(JSON.parse(JSON.stringify(state)), probeInput({ now: state.lastAt + MINUTE,
      charging: true, normalCharging }));
    assert.equal(state.phase, 'observing'); assert.equal(state.action, null);
    assert.equal(state.pauseUntil, null); assert.equal(state.probe, null);
  }
  validateIdentificationState(state);
  assert.equal(advanceIdentification(state, input({ now: state.lastAt + 1000, identified: true })).phase, 'completed');
});
