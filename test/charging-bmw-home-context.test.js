import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptVehicleReading, bmwHomeContext, bmwIdentityContextValid, BMW_LAST_HOME_MAX_AGE_MS,
  matchBmwSession, matchBmwControlledPause } from '../src/charging/vehicle.js';
import { advanceIdentification, prepareActiveBmwCandidate, matchActiveBmwPause } from '../src/charging/identification.js';

const START = Date.parse('2026-09-24T10:00:00Z'), MINUTE = 60_000, HOME = START - 35 * MINUTE;
const packet = (values, at, tag = '') => ({ provider: 'bmw-cardata', ...values,
  fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
    { measuredAt: value === null ? null : at, readingId: `${key}:${at}:${value}:${tag}` }])) });
const receive = (previous, values, at, { retained = false, now = at + 1000, association = 'synthetic-bmw', tag = '' } = {}) =>
  acceptVehicleReading(previous, packet(values, at, tag), { now, retained, association }).reading;
function fixture() {
  const parked = receive(null, { atHome: true, pluggedIn: false, charging: false }, HOME, { retained: true });
  const reading = receive(parked, { atHome: null, pluggedIn: true, charging: true }, START);
  const options = { connectedAt: START, lastDisconnectedAt: START - 1000,
    chargingAt: START + 1000, physicalAt: START + 2000, now: START + 3000 };
  return { reading, options };
}

test('unknown GPS uses the original home observation without changing current facts or provenance', () => {
  const { reading, options } = fixture(), before = structuredClone(reading);
  assert.deepEqual(bmwHomeContext(reading, options.now), {
    source: 'last-known', measuredAt: HOME, receivedAt: HOME + 1000,
    readingId: reading.fields.atHome.lastKnown.readingId,
  });
  assert.equal(bmwIdentityContextValid(reading, options.now), true);
  assert.equal(reading.atHome, null);
  assert.equal(reading.fields.atHome.measuredAt, null);
  assert.equal(reading.fields.atHome.lastKnown.retained, true);
  assert.deepEqual(reading, before);
});

test('repeated unknown reports and restart do not renew the two-hour source-age limit', () => {
  let { reading } = fixture();
  const original = structuredClone(reading.fields.atHome.lastKnown);
  for (let minute = 1; minute <= 80; minute++) {
    reading = receive(reading, { atHome: null }, START + minute * MINUTE);
    reading = JSON.parse(JSON.stringify(reading));
    assert.deepEqual(reading.fields.atHome.lastKnown, original);
  }
  assert.ok(bmwHomeContext(reading, HOME + BMW_LAST_HOME_MAX_AGE_MS));
  assert.equal(bmwHomeContext(reading, HOME + BMW_LAST_HOME_MAX_AGE_MS + 1), null);
});

test('observed true keeps its existing one-day bound; missing, false and malformed home context fail closed', () => {
  const known = receive(null, { atHome: true, pluggedIn: true }, HOME);
  assert.equal(bmwHomeContext(known, HOME + 24 * 60 * MINUTE).source, 'observed');
  assert.equal(bmwHomeContext(known, HOME + 24 * 60 * MINUTE + 1), null);
  const { reading, options } = fixture();
  for (const value of [undefined, false]) assert.equal(bmwHomeContext({ ...reading, atHome: value }, options.now), null);
  for (const patch of [{ value: false }, { measuredAt: null }, { measuredAt: options.now + 1 },
    { receivedAt: null }, { receivedAt: options.now + 1 }, { readingId: '' }, { retained: undefined }]) {
    const changed = structuredClone(reading); Object.assign(changed.fields.atHome.lastKnown, patch);
    assert.equal(bmwHomeContext(changed, options.now), null);
  }
  for (const pluggedIn of [null, false, undefined])
    assert.equal(bmwIdentityContextValid({ ...reading, pluggedIn }, options.now), false);
  const replaced = receive(reading, { atHome: null, pluggedIn: true }, START + MINUTE,
    { association: 'synthetic-replacement-feed' });
  assert.equal(bmwHomeContext(replaced, START + 2 * MINUTE), null);
});

test('explicit away followed by unknown cannot recover an older home position through replay', () => {
  const { reading } = fixture();
  const away = receive(reading, { atHome: false }, START + MINUTE);
  const unknown = receive(away, { atHome: null }, START + 2 * MINUTE);
  for (const retained of [true, false]) {
    const replayed = receive(unknown, { atHome: true }, HOME, { retained, now: START + 3 * MINUTE });
    assert.equal(replayed.atHome, null);
    assert.equal(replayed.fields.atHome.lastKnown.value, false);
    assert.equal(bmwHomeContext(replayed, START + 3 * MINUTE), null);
  }
});

test('a later BMW unplug invalidates fallback even after replug until a new home observation', () => {
  const { reading } = fixture();
  const unplugged = receive(reading, { pluggedIn: false }, START + MINUTE);
  const replugged = receive(unplugged, { pluggedIn: true }, START + 2 * MINUTE);
  assert.equal(bmwHomeContext(replugged, START + 3 * MINUTE), null);
  const refreshed = receive(replugged, { atHome: true }, START + 3 * MINUTE);
  const gap = receive(refreshed, { atHome: null }, START + 4 * MINUTE);
  assert.equal(bmwHomeContext(gap, START + 5 * MINUTE).measuredAt, START + 3 * MINUTE);
  const equalClock = structuredClone(gap);
  equalClock.fields.pluggedIn.negativeEvent.measuredAt = equalClock.fields.atHome.lastKnown.measuredAt;
  assert.equal(bmwHomeContext(equalClock, START + 5 * MINUTE), null);
});

test('a later live home-zone correction remains usable with its original GPS clock', () => {
  const home = receive(null, { atHome: true }, HOME);
  const away = receive(home, { atHome: false }, HOME, { now: START });
  const corrected = receive(away, { atHome: true }, HOME, { now: START + 1000, tag: 'corrected-zone' });
  const unknown = receive(corrected, { atHome: null }, START + 2000);
  assert.equal(bmwHomeContext(unknown, START + 3000).measuredAt, HOME);
  const retainedReplay = receive(unknown, { atHome: false }, HOME, { retained: true, now: START + 4000 });
  assert.equal(retainedReplay.atHome, null);
  assert.equal(bmwHomeContext(retainedReplay, START + 4000).receivedAt, START + 1000);
  assert.equal(bmwHomeContext(retainedReplay, HOME + BMW_LAST_HOME_MAX_AGE_MS + 1), null);
});

test('recent home context supports all BMW matchers only with live matching charging responses', () => {
  const { reading, options } = fixture();
  const candidate = prepareActiveBmwCandidate(reading, options);
  assert.ok(candidate);
  let state = advanceIdentification(null, { ...options, charging: true, candidate });
  const pause = { connectedAt: START, requestedAt: START + 10_000, confirmedAt: START + 21_000,
    stoppedAt: START + 20_000, startAt: state.pauseUntil };
  state = advanceIdentification(state, { ...options, now: START + 22_000, pause });
  const stopped = receive(reading, { charging: false }, START + 20_000);
  const matchedOptions = { ...options, now: START + 25_000, stoppedAt: START + 20_000, pause };
  const match = value => [Boolean(matchBmwSession(value, matchedOptions)),
    Boolean(matchBmwControlledPause(value, matchedOptions)),
    Boolean(matchActiveBmwPause(value, { state, now: matchedOptions.now }))];
  assert.deepEqual(match(stopped), [true, true, true]);
  assert.equal(stopped.atHome, null);
  for (const bad of [receive(reading, { charging: false }, START + 20_000, { retained: true }),
    receive(stopped, { atHome: false }, START + 23_000),
    receive(stopped, { pluggedIn: null }, START + 23_000)])
    assert.deepEqual(match(bad), [false, false, false]);
  const unavailableHome = structuredClone(stopped);
  delete unavailableHome.fields.atHome.lastKnown;
  assert.deepEqual(match(unavailableHome), [false, false, false]);
  assert.equal(matchBmwSession(stopped, { ...matchedOptions, stoppedAt: null }), false);
  assert.equal(matchBmwControlledPause(stopped, { ...matchedOptions, pause: null }), null);
  assert.equal(matchActiveBmwPause(stopped, { state: { ...state, pause: null }, now: matchedOptions.now }), null);
  assert.equal(prepareActiveBmwCandidate(reading, { ...options, consumedChargingId: candidate.readingId }), null);
});
