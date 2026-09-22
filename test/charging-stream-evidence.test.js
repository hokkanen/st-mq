import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptEaseeTransition } from '../src/charging/stream-evidence.js';

const START = Date.parse('2026-09-22T10:00:00Z'), MINUTE = 60_000;
const event = (id, value, at, previousValue, previousAt = at - 1, receivedAt = at) =>
  ({ id, value, measuredAt: at, receivedAt, previousValue, previousMeasuredAt: previousAt });
const apply = (previous, value, options = {}) => acceptEaseeTransition(previous, value,
  { now: value.receivedAt, connectedAt: START, ...options });

test('only fresh validated live changes advance compact per-field watermarks', () => {
  const value = event(109, 3, START + 1000, 2);
  const first = apply(null, value);
  assert.deepEqual(first.evidence.chargingTimes, [value.measuredAt]);
  for (const change of [{ id: 120 }, { value: 9 }, { value: '3' }, { previousValue: undefined },
    { previousValue: 3 }, { previousMeasuredAt: value.measuredAt }, { measuredAt: NaN },
    { measuredAt: value.receivedAt + 1 }, { receivedAt: value.receivedAt + 1 }])
    assert.equal(acceptEaseeTransition(null, { ...value, ...change }, { now: value.receivedAt }), null);
  assert.equal(apply(null, value, { now: value.receivedAt + 15 * MINUTE + 1 }), null);
  assert.equal(apply(first.evidence, value), null);
  assert.equal(apply(first.evidence, event(109, 2, START + 999, 3)), null);
  assert.equal(apply(null, event(31, 2, START + 1000, false)), null);
  assert.equal(apply(null, event(31, 1, START + 1000, true)), null);
  assert.equal(apply(null, event(96, Infinity, START + 1000, 0)), null);
  assert.equal(apply(null, event(100, 'E', START + 1000, 'B')), null);
  for (const value of [event(31, false, START + 1000, true), event(96, 54, START + 1000, 0),
    event(250, false, START + 1000, true), event(31, 1, START + 1000, 0), event(250, 0, START + 1000, 1)]) {
    const result = apply(null, value);
    assert.equal(result.evidence.watermarks[value.id], value.measuredAt);
    assert.equal(result.evidence.connection, null);
    assert.deepEqual(result.evidence.chargingTimes, []);
    assert.equal(result.boundary, undefined);
  }
});

test('pilot and mode connection semantics match charger normalization without treating errors as starts or stops', () => {
  const at = START + MINUTE;
  assert.equal(apply(null, event(100, 'D', at, 'A')).evidence.connection.value, true);
  for (const mode of [2, 3, 4, 6, 7, 8]) {
    const result = apply(null, event(109, mode, at, 1));
    assert.equal(result.evidence.connection.value, true);
    if (mode !== 3) assert.deepEqual(apply(null, event(109, mode, at, 3)).evidence.stoppedTimes, [at]);
  }
  for (const mode of [0, 5]) {
    const result = apply(null, event(109, mode, at, 3));
    assert.equal(result.evidence.watermarks[109], at);
    assert.equal(result.evidence.connection, null);
    assert.deepEqual(result.evidence.chargingTimes, []);
    assert.deepEqual(result.evidence.stoppedTimes, []);
    assert.equal(apply(result.evidence, event(109, 1, at + 1000, mode, at)).boundary.measuredAt, at + 1000);
  }
});

test('one-second and sixteen-second unplug gaps retain the original boundary and reconnect clocks', () => {
  for (const gap of [1000, 16_000]) {
    const at = START + MINUTE, disconnected = apply(null, event(100, 'A', at, 'C'));
    assert.deepEqual(disconnected.boundary, { source: 'easee-stream', readingId: `easee-stream:100:${at}`,
      measuredAt: at, receivedAt: at, endedConnectedAt: START });
    const prior = structuredClone(disconnected.evidence);
    const connected = apply(disconnected.evidence, event(100, 'B', at + gap, 'A', at, at + gap + 100), { connectedAt: null });
    assert.deepEqual(disconnected.evidence, prior);
    assert.equal(connected.boundary.readingId, disconnected.boundary.readingId);
    assert.deepEqual(connected.boundary.reconnected, { readingId: `easee-stream:connected:${at + gap}`,
      measuredAt: at + gap, receivedAt: at + gap + 100, retained: false });
    assert.deepEqual(connected.evidence.chargingTimes, [], 'A reconnect alone is not a charging start');
  }
});

test('late cross-field negatives recover a missed gap without replacing a later positive with false', () => {
  const at = START + MINUTE, positive = apply(null, event(109, 3, at + 16_000, 2));
  const negative = apply(positive.evidence, event(100, 'A', at, 'C', at - 1000, at + 20_000));
  assert.equal(negative.evidence.connection.value, true);
  assert.equal(negative.evidence.disconnectedAt, at);
  assert.equal(negative.boundary.reconnected.measuredAt, at + 16_000);
  assert.equal(negative.boundary.reconnected.receivedAt, at + 16_000,
    'Out-of-order delivery does not manufacture a later reconnect receipt');
  assert.deepEqual(negative.evidence.chargingTimes, [at + 16_000]);
  assert.equal(apply(negative.evidence, event(109, 1, at - 1, 3, at - 2, at + 21_000)), null);
});

test('pilot and mode reports coalesce a disconnect while a newer physical cycle can replace the pending boundary', () => {
  const at = START + MINUTE;
  const first = apply(null, event(100, 'A', at, 'C'));
  const duplicate = apply(first.evidence, event(109, 1, at + 1, 3));
  assert.deepEqual(duplicate.boundary, first.boundary);
  assert.equal(duplicate.evidence.disconnectedAt, at + 1);
  const positive = apply(duplicate.evidence, event(100, 'B', at + 1000, 'A', at), { connectedAt: null });
  const duplicateLate = apply(positive.evidence, event(109, 1, at + 2, 2, at + 1, at + 1001), { connectedAt: null });
  assert.deepEqual(duplicateLate.boundary, positive.boundary);
  const next = apply(duplicateLate.evidence, event(100, 'A', at + 2000, 'B', at + 1000), { connectedAt: null });
  assert.equal(next.boundary.endedConnectedAt, START);
  assert.equal(next.boundary.measuredAt, at + 2000);
  assert.equal(next.boundary.reconnected, undefined);
  assert.equal(next.evidence.connection.value, false);
});

test('later positive mode changes do not move the reconnect past an out-of-order second unplug', () => {
  const at = START + MINUTE;
  let result = apply(null, event(100, 'A', at, 'C'));
  result = apply(result.evidence, event(100, 'B', at + 1000, 'A', at), { connectedAt: null });
  result = apply(result.evidence, event(109, 3, at + 3000, 2), { connectedAt: null });
  assert.equal(result.boundary.reconnected.measuredAt, at + 1000);
  result = apply(result.evidence, event(100, 'A', at + 2000, 'B', at + 1000, at + 4000), { connectedAt: null });
  assert.equal(result.boundary.measuredAt, at + 2000);
  assert.equal(result.boundary.reconnected.measuredAt, at + 3000);
  assert.equal(result.boundary.reconnected.receivedAt, at + 3000);
  assert.deepEqual(result.evidence.chargingTimes, [at + 3000]);
  const before = structuredClone(result.evidence);
  assert.equal(apply(result.evidence, event(109, 3, at + 5000, 3, at + 3000), { connectedAt: null }), null);
  assert.deepEqual(result.evidence, before, 'Unchanged positive republication does not refresh evidence');
});

test('disconnect without a known session advances provenance without inventing cleanup ownership', () => {
  const at = START + MINUTE;
  const charging = apply(null, event(109, 3, at - 1000, 2), { connectedAt: null });
  const result = apply(charging.evidence, event(109, 1, at, 3, at - 1000), { connectedAt: null });
  assert.equal(result.boundary, undefined);
  assert.equal(result.evidence.disconnectedAt, at);
  assert.deepEqual(result.evidence.chargingTimes, []);
  assert.equal(apply(null, event(109, 1, at, 3), { lastDisconnectedAt: at }), null);
  assert.equal(apply(null, event(109, 1, at, 3), { connectedAt: at + 1000, now: at + 1000 }).boundary, undefined,
    'An old negative cannot end a connection established after that event');
});

test('charging start-stop-start edges survive coalesced wakes and filter events before a disconnect', () => {
  const at = START + MINUTE;
  let result = apply(null, event(109, 3, at, 2));
  result = apply(result.evidence, event(109, 2, at + 1000, 3, at));
  result = apply(result.evidence, event(109, 3, at + 2000, 2, at + 1000));
  assert.deepEqual(result.evidence.chargingTimes, [at, at + 2000]);
  assert.deepEqual(result.evidence.stoppedTimes, [at + 1000]);
  result = apply(result.evidence, event(100, 'A', at + 1500, 'C', at - 1, at + 2100));
  assert.deepEqual(result.evidence.chargingTimes, [at + 2000]);
  assert.deepEqual(result.evidence.stoppedTimes, []);
  const oldStop = apply(result.evidence, event(109, 4, at + 3000, 3, at));
  assert.deepEqual(oldStop.evidence.stoppedTimes, [], 'A stop cannot borrow its prior charging state from before the disconnect');
});

test('charging histories are sorted, unique, age bounded and capped independently', () => {
  const now = START + 20 * MINUTE;
  const previous = { watermarks: {}, chargingTimes: [START, now - 1, now - 1,
    ...Array.from({ length: 50 }, (_, i) => now - 100 - i)],
  stoppedTimes: [START, ...Array.from({ length: 50 }, (_, i) => now - 200 - i)] };
  const before = structuredClone(previous);
  const result = apply(previous, event(96, 54, now, 0), { now });
  for (const key of ['chargingTimes', 'stoppedTimes']) {
    assert.equal(result.evidence[key].length, 32);
    assert.deepEqual(result.evidence[key], [...new Set(result.evidence[key])].sort((a, b) => a - b));
    assert.ok(result.evidence[key].every(at => now - at <= 15 * MINUTE));
  }
  assert.deepEqual(previous, before);
});
