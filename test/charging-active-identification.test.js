import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceIdentification, validateIdentificationState, prepareActiveBmwCandidate,
  matchActiveBmwPause } from '../src/charging/identification.js';

const START = Date.parse('2026-09-25T10:00:00Z'), MINUTE = 60_000;
const input = overrides => ({ connectedAt: START, now: START, ...overrides });
const event = (readingId, measuredAt, overrides = {}) => ({ readingId, measuredAt,
  receivedAt: measuredAt + 1000, retained: false, ...overrides });
function fixture() {
  const start = event('charging-start', START + 1000);
  const reading = { provider: 'bmw-cardata', association: 'test-bmw-feed', atHome: true,
    pluggedIn: true, charging: true, fields: {
      atHome: event('home', START - MINUTE, { retained: true }),
      pluggedIn: event('plug', START - MINUTE, { retained: true }),
      charging: { ...start, positiveEvent: start, negativeEvent: null },
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
  const stop = event('charging-stop', START + 6500);
  reading.charging = false;
  reading.fields.charging = { ...stop, positiveEvent: reading.fields.charging.positiveEvent, negativeEvent: stop };
  return { reading, state, pause, now: START + 9000 };
}

test('a scheduled vehicle remains pending indefinitely without spending its one attempt', () => {
  let state = advanceIdentification(null, input());
  assert.equal(state.phase, 'waiting'); assert.equal(state.action, 'allow');
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now: START + 24 * 60 * MINUTE }));
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
  const start = event('same-millisecond-start', options.now, { receivedAt: options.now });
  reading.fields.charging = { ...start, positiveEvent: start, negativeEvent: null };
  const candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  assert.equal(state.phase, 'charging'); assert.equal(state.action, 'allow');
  assert.equal(state.pauseUntil, null);
  state = advanceIdentification(state, input({ now: options.now + 1, charging: true, candidate }));
  assert.equal(state.phase, 'pausing'); assert.equal(state.action, 'pause');
});

test('time and delivered-energy limits end a test without another automatic attempt', () => {
  for (const override of [{ now: START + MINUTE }, { now: START + 10_000, energyKwh: 2.151 }]) {
    let state = advanceIdentification(null, input({ charging: true, energyKwh: 2 }));
    state = advanceIdentification(state, input({ charging: true, ...override }));
    assert.equal(state.phase, 'inconclusive'); assert.equal(state.action, null);
    const restarted = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now: START + 3 * MINUTE, charging: true }));
    assert.equal(restarted.phase, 'inconclusive'); assert.equal(restarted.attempt, 1);
    assert.equal(restarted.completedAt, state.completedAt);
    validateIdentificationState(restarted);
  }
});

test('power integration enforces energy budget without a session-energy meter', () => {
  let state = advanceIdentification(null, input({ charging: true, powerKw: 22 }));
  state = advanceIdentification(state, input({ now: START + 26_000, charging: true, powerKw: 22 }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'charge-energy-limit');
  assert.ok(state.chargeUsedKwh >= .15);
});

test('session meter resets and observation outages cannot reset a running deadline', () => {
  let state = advanceIdentification(null, input({ charging: true, energyKwh: 10 }));
  state = advanceIdentification(state, input({ now: START + 30_000, energyKwh: 0, available: false }));
  assert.equal(state.action, null); assert.equal(state.chargeDeadlineAt, START + MINUTE);
  state = advanceIdentification(state, input({ now: START + MINUTE, available: false }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'charge-time-limit');
});

test('backwards clock adjustments and restarting during a pause never extend its recovery deadline', () => {
  const { state } = pausedFixture();
  let resumed = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now: START + 4000 }));
  assert.equal(resumed.lastAt, state.lastAt); assert.equal(resumed.pauseUntil, state.pauseUntil);
  resumed = advanceIdentification(resumed, input({ now: state.pauseUntil }));
  assert.equal(resumed.phase, 'inconclusive'); assert.equal(resumed.reason, 'pause-timeout');
  assert.deepEqual(resumed.pause, state.pause);
});

test('a requested pause which does not physically stop cannot extend active charging beyond sixty seconds', () => {
  const { reading, options } = fixture(), candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  state = advanceIdentification(state, input({ now: state.chargeDeadlineAt, charging: true }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'charge-time-limit');
  assert.equal(state.pause, null);
});

test('unknown charging telemetry cannot extend an unconfirmed pause beyond its charge budget', () => {
  const { reading, options } = fixture(), candidate = prepareActiveBmwCandidate(reading, options);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  state = advanceIdentification(state, input({ now: state.chargeDeadlineAt, available: false }));
  assert.equal(state.phase, 'inconclusive'); assert.equal(state.reason, 'charge-time-limit');
});

test('proof of a physical stop bounds power integration at the real stop time', () => {
  const { state } = pausedFixture();
  assert.ok(state.chargeUsedKwh < .01);
  const later = advanceIdentification(state, input({ now: START + MINUTE, charging: false, powerKw: 0 }));
  assert.equal(later.phase, 'pausing'); assert.equal(later.chargeUsedKwh, state.chargeUsedKwh);
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
  reading.fields.charging = { ...ongoing, positiveEvent: event('old-start', START - 60 * MINUTE, { retained: true }) };
  const candidate = prepareActiveBmwCandidate(reading, { ...options, chargingAt: [], lastDisconnectedAt: null });
  assert.equal(candidate.kind, 'ongoing'); assert.equal(candidate.readingId, 'ongoing-live');
  assert.equal(candidate.measuredAt, ongoing.measuredAt);
  let state = advanceIdentification(null, input({ now: options.now, charging: true, candidate }));
  const pause = { connectedAt: START, requestedAt: START + 4000, confirmedAt: START + 7000,
    stoppedAt: START + 6000, startAt: state.pauseUntil };
  state = advanceIdentification(state, input({ now: START + 8000, pause }));
  const stop = event('new-stop', START + 6500); reading.charging = false;
  reading.fields.charging.negativeEvent = stop;
  assert.equal(matchActiveBmwPause(reading, { state, now: START + 9000 }).chargingReadingId, 'ongoing-live');
});

test('retained and stale true values never become live baselines through fresh delivery alone', () => {
  for (const override of [{ retained: true }, { retained: undefined }, { measuredAt: START - 5 * MINUTE },
    { receivedAt: START - MINUTE }, { measuredAt: START + MINUTE }, { receivedAt: START + MINUTE },
    { measuredAt: null }, { readingId: '' }]) {
    const { reading, options } = fixture();
    reading.fields.charging = { ...reading.fields.charging, positiveEvent: null, ...override };
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

test('late reports identify after pause expiry only from the saved original stop window', () => {
  let { reading, state } = pausedFixture();
  const now = state.pauseUntil + 3 * MINUTE;
  state = advanceIdentification(JSON.parse(JSON.stringify(state)), input({ now }));
  assert.equal(state.phase, 'inconclusive');
  reading.fields.charging.negativeEvent.receivedAt = now;
  assert.ok(matchActiveBmwPause(reading, { state, now }));
  assert.equal(matchActiveBmwPause(reading, { state, now: now + 15 * MINUTE }), null);
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
  const stop = event('retry-stop', now + 2500); reading.charging = false;
  reading.fields.charging.negativeEvent = stop;
  assert.ok(matchActiveBmwPause(reading, { state, now: now + 4000 }));
});
