import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptVehicleReading, bmwDisconnectEvent, bmwReconnectEvent } from '../src/charging/vehicle.js';

const START = Date.parse('2026-09-22T09:00:00Z'), MINUTE = 60_000;
const match = { id: 'bmw', connectedAt: START, matchedAt: START + MINUTE };
const options = now => ({ match, connectedAt: START, now });
function plug(previous, value, measuredAt, { now = measuredAt, retained = false, readingId = `plug-${value}-${measuredAt}` } = {}) {
  return acceptVehicleReading(previous, { provider: 'bmw-cardata', pluggedIn: value,
    fields: { pluggedIn: { measuredAt, readingId } } }, { now, retained, association: 'example/vehicles/bmw' });
}
function disconnected() {
  const previous = plug(null, true, START).reading;
  const at = START + 2 * MINUTE;
  const reading = plug(previous, false, at, { now: at + 1000 }).reading;
  const boundary = bmwDisconnectEvent(previous, reading, options(at + 1000));
  return { previous, reading, boundary, at };
}

test('a known BMW live unplug dates only its matched connection with original source and receipt clocks', () => {
  const { previous, reading, boundary, at } = disconnected();
  assert.deepEqual(boundary, { source: 'bmw-cardata', readingId: `plug-false-${at}`,
    measuredAt: at, receivedAt: at + 1000, endedConnectedAt: START });
  const before = structuredClone({ previous, reading });
  bmwDisconnectEvent(previous, reading, options(at + 2000));
  assert.deepEqual({ previous, reading }, before, 'Boundary extraction does not mutate accepted readings');
  for (const override of [{ match: null }, { match: { ...match, id: 'tesla' } },
    { match: { ...match, connectedAt: START - 1 } }, { connectedAt: START + 1 },
    { match: { ...match, matchedAt: at + 1001 } }, { match: { ...match, matchedAt: null } }]) {
    assert.equal(bmwDisconnectEvent(previous, reading, { ...options(at + 2000), ...override }), null);
  }
  assert.equal(bmwDisconnectEvent({ ...previous, provider: 'other' }, reading, options(at + 1000)), null);
  assert.equal(bmwDisconnectEvent(previous, { ...reading, association: 'example/changed' }, options(at + 1000)), null);
});

test('retained, duplicate, unknown and unchanged false reports cannot create a BMW disconnect boundary', () => {
  const { previous, reading, at } = disconnected();
  const retained = plug(previous, false, at, { retained: true }).reading;
  assert.equal(bmwDisconnectEvent(previous, retained, options(at)), null);
  const replay = plug(reading, false, at, { now: at + MINUTE });
  assert.equal(replay.accepted, false);
  assert.equal(bmwDisconnectEvent(reading, replay.reading, options(at + MINUTE)), null);
  const repeated = plug(reading, false, at + MINUTE).reading;
  assert.equal(bmwDisconnectEvent(reading, repeated, options(at + MINUTE)), null);
  assert.equal(bmwDisconnectEvent(previous, repeated, options(at + MINUTE)), null,
    'An old negative event carried by a newer unchanged false report is not a new transition');
  const unknown = plug(previous, null, null, { now: at, readingId: 'plug-unknown' }).reading;
  assert.equal(bmwDisconnectEvent(previous, unknown, options(at)), null);
  assert.equal(bmwDisconnectEvent(unknown, plug(unknown, false, at + MINUTE).reading, options(at + MINUTE)), null);
});

test('BMW disconnect boundaries reject stale, future and non-increasing source measurements', () => {
  const { previous, reading, at } = disconnected();
  assert.notEqual(bmwDisconnectEvent(previous, reading, options(at + 15 * MINUTE)), null);
  assert.equal(bmwDisconnectEvent(previous, reading, options(at + 15 * MINUTE + 1)), null);
  const late = plug(previous, false, at, { now: at + 15 * MINUTE + 1 }).reading;
  assert.equal(bmwDisconnectEvent(previous, late, options(at + 15 * MINUTE + 1)), null,
    'A late receipt cannot refresh an expired source event');
  const future = plug(previous, false, at + MINUTE, { now: at }).reading;
  assert.equal(bmwDisconnectEvent(previous, future, options(at)), null);
  const sameClock = plug(previous, false, START, { now: at, readingId: 'same-source-clock' }).reading;
  assert.equal(sameClock.pluggedIn, false, 'Conservative source validation may withdraw a positive at the same clock');
  assert.equal(bmwDisconnectEvent(previous, sameClock, options(at)), null);
  const older = plug(previous, false, START - 1, { now: at, readingId: 'older-source-clock' });
  assert.equal(older.accepted, false);
  assert.equal(bmwDisconnectEvent(previous, older.reading, options(at)), null);
});

test('late unplug delivery preserves source order while matching uses its original receipt', () => {
  const previous = plug(null, true, START - 60_000).reading;
  const measuredAt = START - 30_000, receivedAt = START + 2 * MINUTE;
  const reading = plug(previous, false, measuredAt, { now: receivedAt }).reading;
  assert.equal(bmwDisconnectEvent(previous, reading, options(receivedAt)).measuredAt, measuredAt,
    'The source unplug can precede the charger poll and receipt-time match');
  assert.equal(bmwDisconnectEvent(previous, reading, { ...options(receivedAt + MINUTE),
    match: { ...match, matchedAt: receivedAt + 1 } }), null);
  assert.equal(bmwDisconnectEvent(previous, reading, options(receivedAt - 1)), null,
    'A future receipt is never usable evidence');
  const replayedId = structuredClone(reading);
  replayedId.fields.pluggedIn.readingId = previous.fields.pluggedIn.readingId;
  replayedId.fields.pluggedIn.negativeEvent.readingId = previous.fields.pluggedIn.readingId;
  assert.equal(bmwDisconnectEvent(previous, replayedId, options(receivedAt)), null);
});

test('a later live BMW plug supplies reconnect evidence without granting vehicle identity or changing clocks', () => {
  const { reading, boundary, at } = disconnected();
  const replugAt = at + 16_000, receivedAt = replugAt + 1000;
  const replug = plug(reading, true, replugAt, { now: receivedAt }).reading;
  const before = structuredClone({ boundary, replug });
  const event = bmwReconnectEvent(boundary, replug, { now: receivedAt + MINUTE });
  assert.deepEqual(event, { readingId: `plug-true-${replugAt}`, measuredAt: replugAt, receivedAt, retained: false });
  assert.deepEqual({ boundary, replug }, before);
  const refresh = plug(replug, true, replugAt + MINUTE).reading;
  assert.deepEqual(bmwReconnectEvent(boundary, refresh, { now: replugAt + MINUTE }), event,
    'Unchanged true reports preserve the original reconnect event');
  assert.equal(bmwReconnectEvent(boundary, { ...replug, provider: 'other' }, { now: receivedAt }), null);
  assert.equal(bmwReconnectEvent(boundary, reading, { now: receivedAt }), null);
  assert.equal(bmwReconnectEvent(null, replug, { now: receivedAt }), null);
});

test('retained, replayed, same-clock, stale and future BMW positives cannot reconnect a prior boundary', () => {
  const { previous, reading, boundary, at } = disconnected();
  const later = at + MINUTE;
  const retained = plug(reading, true, later, { retained: true }).reading;
  assert.equal(bmwReconnectEvent(boundary, retained, { now: later }), null);
  assert.equal(bmwReconnectEvent(boundary, plug(retained, true, later, { now: later + 1000 }).reading,
    { now: later + 1000 }), null, 'Republishing a retained event live cannot upgrade its provenance');
  assert.equal(bmwReconnectEvent(boundary, previous, { now: later }), null, 'The original connection is not a reconnect');
  const sameClock = plug(reading, true, at, { now: later, readingId: 'same-clock-positive' }).reading;
  assert.equal(bmwReconnectEvent(boundary, sameClock, { now: later }), null);
  const sameReceipt = plug(reading, true, later, { now: boundary.receivedAt }).reading;
  assert.equal(bmwReconnectEvent(boundary, sameReceipt, { now: later }), null);
  const future = plug(reading, true, later + MINUTE, { now: later }).reading;
  assert.equal(bmwReconnectEvent(boundary, future, { now: later }), null);
  const replug = plug(reading, true, later).reading;
  for (const change of [{ measuredAt: boundary.measuredAt }, { receivedAt: boundary.receivedAt },
    { measuredAt: later + 1 }, { receivedAt: later + 1 }, { readingId: boundary.readingId }]) {
    const changed = structuredClone(replug);
    Object.assign(changed.fields.pluggedIn.positiveEvent, change);
    assert.equal(bmwReconnectEvent(boundary, changed, { now: later }), null);
  }
  assert.equal(bmwReconnectEvent(boundary, replug, { now: later + 15 * MINUTE + 1 }), null);
  assert.equal(bmwReconnectEvent(boundary, plug(reading, true, at + 16 * MINUTE).reading,
    { now: at + 16 * MINUTE }), null, 'An expired departure cannot transfer its old charger association');
});
