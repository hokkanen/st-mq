import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptVehicleReading, matchBmwSession, pendingBmwSession } from '../src/charging/vehicle.js';

const START = Date.parse('2026-09-20T10:00:00Z'), MINUTE = 60_000;
const options = { connectedAt: START, chargingAt: START, now: START + 4 * MINUTE };

function initial({ at = START, receivedAt = at, retained = false } = {}) {
  return acceptVehicleReading(null, { provider: 'bmw-cardata', pluggedIn: true, charging: true, atHome: true,
    fields: Object.fromEntries(['pluggedIn', 'charging', 'atHome'].map(key =>
      [key, { readingId: `${key}-${at}`, measuredAt: at }])) },
  { now: receivedAt, retained, association: 'test-bmw' }).reading;
}

function stopped(reading, at = START + 3 * MINUTE) {
  return acceptVehicleReading(reading, { provider: 'bmw-cardata', charging: false,
    fields: { charging: { readingId: `stop-${at}`, measuredAt: at } } },
  { now: at, retained: false, association: 'test-bmw' }).reading;
}

test('matching live starts remain pending after the initial observation without identifying or mutating the vehicle', () => {
  const reading = initial(), before = structuredClone(reading);
  assert.equal(pendingBmwSession(reading, options), true);
  assert.equal(matchBmwSession(reading, options), false);
  assert.deepEqual(reading, before);
});

test('pending status lasts for the connection and never begins before it', () => {
  const reading = initial();
  assert.equal(pendingBmwSession(reading, { ...options, now: START + 10 * MINUTE - 1 }), true);
  for (const now of [START + 10 * MINUTE, START + 120 * MINUTE])
    assert.equal(pendingBmwSession(reading, { ...options, now }), true);
  assert.equal(pendingBmwSession(reading, { ...options, now: START - 1 }), false);
  const beforeFirstPoll = initial({ at: START - 30_000 });
  assert.equal(pendingBmwSession(beforeFirstPoll,
    { ...options, chargingAt: START - 30_000, now: START - 1 }), false);
});

test('pending waits for either missing side of the stop and ends when both stops match', () => {
  const reading = initial(), stopAt = START + 3 * MINUTE, paused = stopped(reading, stopAt);
  assert.equal(pendingBmwSession(reading, { ...options, stoppedAt: stopAt }), true);
  assert.equal(pendingBmwSession(paused, options), true);
  assert.equal(pendingBmwSession(paused, { ...options, stoppedAt: stopAt }), false);
  assert.equal(matchBmwSession(paused, { ...options, stoppedAt: stopAt }), true);
  assert.equal(pendingBmwSession(paused, { ...options, stoppedAt: START + 1 }), true,
    'A mismatched stop is not a confirmed session');
  const late = { ...options, stoppedAt: stopAt, now: START + 11 * MINUTE };
  assert.equal(pendingBmwSession(paused, late), false);
  assert.equal(matchBmwSession(paused, late), true,
    'Historical correlation does not expire during the same connection');
});

test('pending requires the same current BMW, home and plug facts as identification', () => {
  const reading = initial();
  for (const override of [{ provider: undefined }, { provider: 'other' }, { atHome: false }, { atHome: null },
    { pluggedIn: false }, { pluggedIn: null }])
    assert.equal(pendingBmwSession({ ...reading, ...override }, options), false, JSON.stringify(override));
  assert.equal(pendingBmwSession(null, options), false);
  assert.equal(pendingBmwSession(reading, { ...options, connectedAt: null }), false);
  for (const measuredAt of [null, options.now + 1]) {
    const copy = structuredClone(reading); copy.fields.atHome.measuredAt = measuredAt;
    assert.equal(pendingBmwSession(copy, options), false);
  }
});

test('pending excludes retained charging starts while a retained inlet can supply context', () => {
  const retained = initial({ retained: true });
  assert.equal(pendingBmwSession(retained, options), false);
  for (const key of ['pluggedIn', 'charging']) {
    const reading = initial(); (key === 'charging' ? reading.fields.charging.history[0] : reading.fields[key].positiveEvent).retained = true;
    assert.equal(pendingBmwSession(reading, options), key === 'pluggedIn');
  }
  const repeated = acceptVehicleReading(retained, { provider: 'bmw-cardata', pluggedIn: true, charging: true,
    fields: Object.fromEntries(['pluggedIn', 'charging'].map(key =>
      [key, { readingId: `${key}-repeated`, measuredAt: START + MINUTE }])) },
  { now: START + MINUTE, retained: false, association: 'test-bmw' }).reading;
  assert.equal(pendingBmwSession(repeated, options), false,
    'A later live repetition cannot replace the retained event provenance');
});

test('pending requires a matching Easee start within the same connection window', () => {
  const reading = initial();
  for (const chargingAt of [null, [], START - 90_001, START + 2 * MINUTE + 1, options.now + 1])
    assert.equal(pendingBmwSession(reading, { ...options, chargingAt }), false);
  assert.equal(pendingBmwSession(reading, { ...options, chargingAt: [null, START + 2 * MINUTE + 1, START] }), true);
});

test('pending accepts bounded pre-poll events but rejects a known disconnect or consumed plug', () => {
  const at = START - 90_000, reading = initial({ at });
  const beforePoll = { ...options, chargingAt: at };
  assert.equal(pendingBmwSession(reading, beforePoll), true);
  assert.equal(pendingBmwSession(reading, { ...beforePoll, connectedAt: START + 1 }), false);
  assert.equal(pendingBmwSession(reading, { ...beforePoll, lastDisconnectedAt: at - 1 }), true);
  assert.equal(pendingBmwSession(reading, { ...beforePoll, lastDisconnectedAt: at }), false);
  assert.equal(pendingBmwSession(reading,
    { ...beforePoll, consumedPlugId: reading.fields.pluggedIn.positiveEvent.readingId }), false);
});

test('BMW charging evidence needs valid clocks; pre-poll starts also require valid vehicle plug evidence', () => {
  for (const key of ['pluggedIn', 'charging']) {
    for (const [clock, at] of [['measuredAt', null], ['receivedAt', null],
      ['measuredAt', START - 90_001], ['receivedAt', START - 90_001],
      ['measuredAt', options.now + 1], ['receivedAt', options.now + 1]]) {
      const reading = initial(); (key === 'charging' ? reading.fields.charging.history[0] : reading.fields[key].positiveEvent)[clock] = at;
      assert.equal(pendingBmwSession(reading, options), key === 'pluggedIn', `${key} ${clock}: ${at}`);
      const beforePoll = initial({ at: START - 30_000 });
      (key === 'charging' ? beforePoll.fields.charging.history[0] : beforePoll.fields[key].positiveEvent)[clock] = at;
      assert.equal(pendingBmwSession(beforePoll, { ...options, chargingAt: START - 30_000 }), false);
    }
  }
});

test('persisted pending evidence remains valid and cannot carry across reconnects', () => {
  const persisted = JSON.parse(JSON.stringify(initial()));
  assert.equal(pendingBmwSession(persisted, options), true);
  assert.equal(pendingBmwSession(persisted, { ...options, now: START + 120 * MINUTE }), true);
  assert.equal(pendingBmwSession(persisted, { ...options, connectedAt: START + 2 * MINUTE,
    lastDisconnectedAt: START + MINUTE, chargingAt: START + 2 * MINUTE }), false);
});
