import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceTimePending } from '../src/acquisition/source-time-pending.js';

function fixture(options = {}) {
  let now = 100_000, elapsed = 0;
  const ready = [], rejected = [], timers = new Map();
  let sequence = 0;
  const queue = createSourceTimePending({ clock: () => now, monotonicClock: () => elapsed,
    setTimeoutFn: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimeoutFn: id => timers.delete(id), onReady: (value, receivedAt, admittedAt) => ready.push({ value, receivedAt, admittedAt }),
    onReject: (value, reason) => rejected.push({ value, reason }), ...options });
  return { queue, ready, rejected, timers, at(value, mono = value - 100_000) { now = value; elapsed = mono; } };
}

test('source lead boundary and delayed admission retain exact original clocks', () => {
  const f = fixture();
  for (const lead of [1, 4, 400, 1000])
    assert.equal(f.queue.defer(lead, lead, { sourceTime: 100_000 + lead, receivedAt: 100_000 }), true);
  for (const sourceTime of [101_001, NaN, null, -1])
    assert.equal(f.queue.defer(String(sourceTime), null, { sourceTime, receivedAt: 100_000 }), false);
  f.at(100_000); f.queue.drain(); assert.equal(f.ready.length, 0);
  f.at(101_000); f.queue.drain();
  assert.deepEqual(f.ready.map(row => row.value), [1, 4, 400, 1000]);
  assert(f.ready.every(row => row.receivedAt === 100_000 && row.admittedAt === 101_000));
  f.queue.clear();
});

test('ordered packets preserve short transitions while independent groups continue', () => {
  const f = fixture({ ordered: value => value.device });
  f.queue.defer(1, { device: 'first', edge: 'stop' }, { sourceTime: 100_400, receivedAt: 100_000 });
  f.queue.defer(2, { device: 'first', edge: 'start' }, { sourceTime: 100_000, receivedAt: 100_000 });
  f.queue.defer(3, { device: 'other', edge: 'stop' }, { sourceTime: 100_004, receivedAt: 100_000 });
  f.at(100_004); f.queue.drain();
  assert.deepEqual(f.ready.map(row => row.value.device), ['other']);
  f.at(100_400); f.queue.drain();
  assert.deepEqual(f.ready.slice(1).map(row => row.value.edge), ['stop', 'start']);
  f.queue.clear();
});

test('clock rollback, monotonic expiry, duplicate delivery and reconnect cannot renew pending authority', () => {
  const f = fixture();
  f.queue.defer(1, 'old', { sourceTime: 100_400, receivedAt: 100_000 });
  const checkpoint = f.queue.checkpoint();
  f.at(100_000, 4999);
  f.queue.defer(1, 'duplicate', { sourceTime: 100_400, receivedAt: 100_000 });
  f.at(100_300, 5000); f.queue.drain();
  assert.equal(f.ready.length, 0); assert.deepEqual(f.rejected, [{ value: 'old', reason: 'expired' }]);
  f.queue.clear(); f.queue.restore(checkpoint); assert.equal(f.queue.size, 0);
  f.at(100_000, 6000); f.queue.defer(2, 'rollback', { sourceTime: 100_004, receivedAt: 100_000 });
  f.at(99_999, 6001); f.queue.drain();
  assert.equal(f.queue.size, 0); assert.equal(f.ready.length, 0);
  assert.equal(f.rejected.at(-1).reason, 'future-receipt-time');
});

test('writer delay cannot expire an already source-ready packet or renew its original clocks', () => {
  const f = fixture({ ordered: true });
  f.queue.defer('first', 'stop', { sourceTime: 100_801, receivedAt: 100_000 });
  f.queue.defer('second', 'start', { sourceTime: 100_500, receivedAt: 100_500 });
  f.at(105_400, 5400);
  f.queue.defer('first', 'changed duplicate', { sourceTime: 105_800, receivedAt: 105_400 });
  f.queue.drain();
  assert.deepEqual(f.ready, [
    { value: 'stop', receivedAt: 100_000, admittedAt: 105_400 },
    { value: 'start', receivedAt: 100_500, admittedAt: 105_400 },
  ]);
  assert.deepEqual(f.rejected, []);
  assert.equal(f.queue.size, 0);
});

test('delayed ready admission still respects rollback, generation cancellation and invalid receipt time', () => {
  let fail = true;
  const ready = [];
  const f = fixture({ onReady(value, receivedAt, admittedAt) {
    if (fail) { fail = false; throw new Error('synthetic commit failure'); }
    ready.push({ value, receivedAt, admittedAt });
  } });
  f.queue.defer('packet', 'original', { sourceTime: 100_801, receivedAt: 100_000 });
  const checkpoint = f.queue.checkpoint();
  f.at(105_400, 5400);
  assert.throws(() => f.queue.drain(), /commit failure/);
  assert.equal(f.queue.size, 1);
  f.queue.drain();
  assert.deepEqual(ready, [{ value: 'original', receivedAt: 100_000, admittedAt: 105_400 }]);
  f.queue.clear(); f.queue.restore(checkpoint);
  assert.equal(f.queue.size, 0, 'A ready report from a ended generation cannot be restored');
  f.at(106_000, 6000);
  f.queue.defer('future', 'rollback', { sourceTime: 106_400, receivedAt: 106_000 });
  f.at(105_999, 12000); f.queue.drain();
  assert.equal(f.rejected.at(-1).reason, 'future-receipt-time');
  assert.equal(ready.length, 1);
});

test('bounded overflow retains an ordered head and failed admission retries before later packets', () => {
  const calls = []; let fail = true;
  const f = fixture({ ordered: true, limit: 2, onReady(value) {
    if (fail) { fail = false; throw new Error('synthetic storage failure'); } calls.push(value);
  } });
  f.queue.defer(1, 'first', { sourceTime: 100_004, receivedAt: 100_000 });
  f.queue.defer(2, 'second', { sourceTime: 100_005, receivedAt: 100_000 });
  f.queue.defer(3, 'overflow', { sourceTime: 100_006, receivedAt: 100_000 });
  assert.equal(f.queue.size, 2); assert.equal(f.rejected[0].reason, 'overflow');
  f.at(100_010); assert.throws(() => f.queue.drain(), /storage/);
  assert.equal(f.queue.size, 2); f.queue.drain();
  assert.deepEqual(calls, ['first', 'second']);
  f.queue.clear();
});

test('repeated ahead reports keep advancing while duplicate keys cannot postpone admission', () => {
  const f = fixture({ ordered: row => row.device });
  for (let elapsed = 0; elapsed <= 1000; elapsed += 100) {
    f.at(100_000 + elapsed); f.queue.drain();
    f.queue.defer(elapsed, { device: 'sensor', sourceTime: 100_400 + elapsed },
      { sourceTime: 100_400 + elapsed, receivedAt: 100_000 + elapsed });
  }
  assert.deepEqual(f.ready.map(row => row.value.sourceTime), [100_400, 100_500, 100_600, 100_700, 100_800, 100_900, 101_000]);
  f.queue.clear();
  f.at(102_000); f.queue.defer('packet', 'first', { sourceTime: 102_400, receivedAt: 102_000 });
  f.at(102_100); f.queue.defer('packet', 'changed duplicate', { sourceTime: 102_500, receivedAt: 102_100 });
  f.at(102_400); f.queue.drain();
  assert.equal(f.ready.at(-1).value, 'first'); assert.equal(f.queue.size, 0);
});
