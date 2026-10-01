import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBmwControlledPause, matchBmwSession, pendingBmwControlledPause } from '../src/charging/vehicle.js';

const START = Date.parse('2026-09-22T10:08:00Z'), MINUTE = 60_000;
const event = (readingId, measuredAt, retained = false) => ({ readingId, measuredAt, receivedAt: measuredAt + 5000, retained });
function fixture() {
  const start = { ...event('bmw-start', START + 4000), value: true },
    stop = { ...event('bmw-stop', START + 3 * MINUTE + 32_000), value: false };
  const reading = { provider: 'bmw-cardata', atHome: true, pluggedIn: true, charging: false,
    fields: { atHome: event('home-context', START - MINUTE, true),
      pluggedIn: { ...event('plug-context', START - 60 * MINUTE, true),
        positiveEvent: event('plug-context', START - 60 * MINUTE, true) },
      charging: { ...stop, positiveEvent: start, negativeEvent: stop, history: [start, stop], historyOverflowAt: null } } };
  const options = { connectedAt: START, lastDisconnectedAt: START - 86_000, chargingAt: START - 4000,
    stoppedAt: START + 3 * MINUTE + 14_000, now: START + 4 * MINUTE,
    pause: { connectedAt: START, requestedAt: START + 3 * MINUTE, confirmedAt: START + 3 * MINUTE + 1000,
      startAt: START + 60 * MINUTE, stoppedAt: START + 3 * MINUTE + 14_000 } };
  return { reading, options };
}

test('pre-connection charging evidence with unchanged inlet context requires a verified owned pause', () => {
  const { reading, options } = fixture(), original = structuredClone(reading);
  assert.equal(matchBmwSession(reading, options), false, 'Without a new plug edge, a start before the physical connection needs controlled-pause proof');
  assert.deepEqual(matchBmwControlledPause(reading, options), {
    chargingReadingId: 'bmw-start', stopReadingId: 'bmw-stop', confirmedAt: options.pause.confirmedAt,
  });
  assert.deepEqual(reading, original);
});

test('retained, stale, future, and unknown charging events cannot establish a controlled response', () => {
  for (const key of ['positiveEvent', 'negativeEvent']) {
    for (const override of [{ retained: true }, { retained: undefined }, { measuredAt: null },
      { receivedAt: null }, { measuredAt: START + 5 * MINUTE }, { receivedAt: START + 5 * MINUTE },
      { measuredAt: START - 91_000 }, { receivedAt: START - 91_000 }, { readingId: '' }]) {
      const { reading, options } = fixture(); Object.assign(reading.fields.charging[key], override);
      assert.equal(matchBmwControlledPause(reading, options), null, `${key}: ${JSON.stringify(override)}`);
    }
  }
  const { reading, options } = fixture();
  assert.ok(matchBmwControlledPause(reading, { ...options, now: START + 16 * MINUTE }));
});

test('home and inlet context may be retained with original valid clocks; history is independent of current charging state', () => {
  for (const key of ['atHome', 'pluggedIn']) {
    for (const value of [false, null, undefined]) {
      const { reading, options } = fixture(); reading[key] = value;
      assert.equal(matchBmwControlledPause(reading, options), null);
    }
    for (const measuredAt of [null, -1, START + 5 * MINUTE]) {
      const { reading, options } = fixture(); reading.fields[key].measuredAt = measuredAt;
      assert.equal(matchBmwControlledPause(reading, options), null);
    }
  }
  for (const override of [{ provider: 'other' }, { provider: undefined }]) {
    const { reading, options } = fixture();
    assert.equal(matchBmwControlledPause({ ...reading, ...override }, options), null);
  }
});

test('missing, unconfirmed and foreign-session pause witnesses do not identify BMW', () => {
  for (const override of [{ connectedAt: null }, { connectedAt: START - 1 }, { requestedAt: null },
    { stoppedAt: null }, { stoppedAt: START + 5 * MINUTE }, { confirmedAt: null },
    { startAt: START + 3 * MINUTE }, { startAt: null }]) {
    const { reading, options } = fixture();
    assert.equal(matchBmwControlledPause(reading, { ...options, pause: { ...options.pause, ...override } }), null,
      JSON.stringify(override));
  }
  const { reading, options } = fixture();
  assert.equal(matchBmwControlledPause(reading, { ...options, pause: null }), null);
});

test('ownership confirmation must bracket both starts and stops within the physical connection', () => {
  const { reading, options } = fixture();
  for (const confirmedAt of [START - 1, options.chargingAt, reading.fields.charging.positiveEvent.measuredAt, options.now + 1])
    assert.equal(matchBmwControlledPause(reading, { ...options, pause: { ...options.pause, confirmedAt } }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options, connectedAt: null }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options, connectedAt: options.now + 1 }), null);
});

test('a later replan request cannot retrospectively claim the earlier stop', () => {
  const { reading, options } = fixture();
  assert.ok(matchBmwControlledPause(reading, options));
  assert.equal(matchBmwControlledPause(reading, { ...options,
    pause: { ...options.pause, requestedAt: START + 5 * MINUTE, confirmedAt: START + 5 * MINUTE }, now: START + 6 * MINUTE }), null);
});

test('an explicit guarded request witness permits the response before delayed confirmation without inventing a send time', () => {
  const { reading, options } = fixture();
  const confirmedAt = reading.fields.charging.negativeEvent.measuredAt + 3000;
  const pause = { ...options.pause, confirmedAt, requestedAt: START + 3 * MINUTE };
  assert.deepEqual(matchBmwControlledPause(reading, { ...options, pause }), {
    chargingReadingId: 'bmw-start', stopReadingId: 'bmw-stop', confirmedAt,
  });
  assert.equal(pendingBmwControlledPause(reading, { ...options, pause }), false);
  for (const requestedAt of [undefined, null])
    assert.equal(matchBmwControlledPause(reading, { ...options, pause: { ...pause, requestedAt } }), null,
      'Without a request witness, a confirmation time cannot substitute for request evidence');
});

test('the guarded request witness stays inside the connection and before confirmation and both stop edges', () => {
  const { reading, options } = fixture();
  const pause = { ...options.pause, confirmedAt: options.now - 1, requestedAt: START + 3 * MINUTE };
  for (const requestedAt of [NaN, 'unknown', START - 1, options.now,
    reading.fields.charging.positiveEvent.measuredAt, options.stoppedAt,
    reading.fields.charging.negativeEvent.measuredAt])
    assert.equal(matchBmwControlledPause(reading, { ...options, pause: { ...pause, requestedAt } }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options,
    pause: { ...pause, stoppedAt: pause.requestedAt } }), null,
  'Even a nearby schedule reason cannot precede or equal the guarded request');
  assert.equal(matchBmwControlledPause(reading, { ...options,
    pause: { ...pause, requestedAt: START + 5 * MINUTE, confirmedAt: START + 5 * MINUTE + 1000 },
    now: START + 6 * MINUTE }), null, 'A later replan request cannot claim an earlier stop');
});

test('each source edge pair and the scheduling reason must independently agree within thirty seconds', () => {
  const { reading, options } = fixture();
  options.now += MINUTE;
  const start = reading.fields.charging.positiveEvent.measuredAt;
  const stop = reading.fields.charging.negativeEvent.measuredAt;
  assert.ok(matchBmwControlledPause(reading, { ...options, chargingAt: start + 30_000,
    stoppedAt: stop + 30_000, pause: { ...options.pause, stoppedAt: stop + 30_000 } }));
  assert.equal(matchBmwControlledPause(reading, { ...options, chargingAt: start + 30_001 }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options, stoppedAt: stop + 30_001 }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options,
    pause: { ...options.pause, stoppedAt: options.stoppedAt + 30_001 } }), null);
  assert.ok(matchBmwControlledPause(reading, { ...options,
    chargingAt: [null, start + 31_000, options.chargingAt], stoppedAt: [null, options.stoppedAt] }));
});

test('disconnect and consumed-start boundaries survive persisted replay without relying on the old plug ID', () => {
  const { reading, options } = fixture();
  assert.equal(matchBmwControlledPause(reading, { ...options, consumedChargingId: 'bmw-start' }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options, lastDisconnectedAt: options.chargingAt }), null);
  assert.equal(matchBmwControlledPause(reading, { ...options, connectedAt: START + 2 * MINUTE }), null);
  const saved = JSON.parse(JSON.stringify({ reading, options: { ...options, consumedChargingId: 'bmw-start' } }));
  assert.equal(matchBmwControlledPause(saved.reading, saved.options), null);
});

test('late stops remain attributable throughout the same physical connection even after pause release', () => {
  const { reading, options } = fixture();
  assert.ok(matchBmwControlledPause(reading, { ...options, now: START + 11 * MINUTE }));
  const lateStop = START + 10 * MINUTE + 1;
  reading.fields.charging.negativeEvent = { ...event('late-stop', lateStop), value: false };
  reading.fields.charging.history[1] = reading.fields.charging.negativeEvent;
  assert.ok(matchBmwControlledPause(reading, { ...options, stoppedAt: lateStop, now: START + 11 * MINUTE,
    pause: { ...options.pause, stoppedAt: lateStop } }));
  assert.ok(matchBmwControlledPause(reading, { ...options, stoppedAt: lateStop, now: START + 120 * MINUTE,
    pause: { ...options.pause, stoppedAt: lateStop } }));
});

test('a fresh tightly matched start with unchanged inlet context remains pending without assigning identity', () => {
  const { reading, options } = fixture();
  reading.charging = true; delete reading.fields.charging.negativeEvent; reading.fields.charging.history.pop();
  const candidate = { ...options, stoppedAt: null, pause: null }, original = structuredClone(reading);
  assert.equal(pendingBmwControlledPause(reading, candidate), true);
  assert.equal(matchBmwControlledPause(reading, candidate), null);
  assert.deepEqual(reading, original);
});

test('pending remains until both vehicle stop and confirmed owned pause evidence establish a match', () => {
  const { reading, options } = fixture();
  assert.equal(pendingBmwControlledPause(reading, { ...options, pause: null }), true);
  assert.equal(pendingBmwControlledPause(reading, { ...options, stoppedAt: null }), true);
  assert.equal(pendingBmwControlledPause(reading, options), false);
  const missingStop = structuredClone(reading); delete missingStop.fields.charging.negativeEvent; missingStop.fields.charging.history.pop();
  assert.equal(pendingBmwControlledPause(missingStop, options), true);
});

test('controlled-pause pending remains for the connection and cannot cross a disconnect or consumed start', () => {
  const { reading, options } = fixture();
  const candidate = { ...options, pause: null };
  assert.equal(pendingBmwControlledPause(reading, { ...candidate, now: reading.fields.charging.positiveEvent.measuredAt + 10 * MINUTE - 1 }), true);
  for (const override of [{ now: START - 1 },
    { connectedAt: START + 2 * MINUTE }, { lastDisconnectedAt: options.chargingAt }, { consumedChargingId: 'bmw-start' }])
    assert.equal(pendingBmwControlledPause(reading, { ...candidate, ...override }), false);
  const saved = JSON.parse(JSON.stringify({ reading, options: candidate }));
  assert.equal(pendingBmwControlledPause(saved.reading, { ...saved.options, now: reading.fields.charging.positiveEvent.measuredAt + 120 * MINUTE }), true);
});

test('pending context must remain valid and does not bypass a missing or retained charging start', () => {
  for (const override of [{ provider: 'other' }, { atHome: false }, { atHome: null },
    { pluggedIn: false }, { pluggedIn: null }]) {
    const { reading, options } = fixture();
    assert.equal(pendingBmwControlledPause({ ...reading, ...override }, { ...options, pause: null }), false);
  }
  for (const key of ['atHome', 'pluggedIn']) {
    const { reading, options } = fixture(); reading.fields[key].measuredAt = START - 24 * 60 * MINUTE;
    assert.equal(pendingBmwControlledPause(reading, { ...options, pause: null }), true);
  }
  for (const override of [{ retained: true }, { measuredAt: START + 5 * MINUTE },
    { receivedAt: START + 5 * MINUTE }, { measuredAt: START - 91_000 }, { receivedAt: null }]) {
    const { reading, options } = fixture(); Object.assign(reading.fields.charging.positiveEvent, override);
    assert.equal(pendingBmwControlledPause(reading, { ...options, pause: null }), false);
  }
  const { reading, options } = fixture(); delete reading.fields.charging.positiveEvent; reading.fields.charging.history.shift();
  assert.equal(pendingBmwControlledPause(reading, { ...options, pause: null }), false);
});

test('pending requires the same thirty-second start pairing as final controlled identification', () => {
  const { reading, options } = fixture(), startAt = reading.fields.charging.positiveEvent.measuredAt;
  const candidate = { ...options, pause: null };
  assert.equal(pendingBmwControlledPause(reading, { ...candidate, chargingAt: startAt + 30_000 }), true);
  for (const chargingAt of [null, [], startAt + 30_001, options.now + 1])
    assert.equal(pendingBmwControlledPause(reading, { ...candidate, chargingAt }), false);
  assert.equal(pendingBmwControlledPause(reading, { ...candidate,
    chargingAt: [null, startAt + 30_001, options.chargingAt] }), true);
});

test('a consumed charging start cannot be reused by switching to the fresh-plug matching path', () => {
  const { reading, options } = fixture();
  reading.fields.pluggedIn = { ...event('new-plug', START), positiveEvent: event('new-plug', START) };
  assert.equal(matchBmwSession(reading, options), true);
  assert.ok(matchBmwControlledPause(reading, options));
  const consumed = { ...options, consumedChargingId: reading.fields.charging.positiveEvent.readingId };
  assert.equal(matchBmwSession(reading, consumed), false);
  assert.equal(matchBmwControlledPause(reading, consumed), null);
});

test('a vehicle departure fences both BMW paths even when charger polling misses the unplug', () => {
  for (const key of ['pluggedIn', 'atHome']) {
    const { reading, options } = fixture();
    reading.fields.pluggedIn = { ...event('new-plug', START + 2000), positiveEvent: event('new-plug', START + 2000) };
    reading.fields[key].negativeEvent = event('vehicle-departure', START + 1000);
    assert.equal(matchBmwSession(reading, options), false, key);
    assert.equal(matchBmwControlledPause(reading, options), null, key);
    // Valid returned-home context and independent post-departure charging
    // restore eligibility without reusing evidence from before departure.
    if (key === 'atHome') Object.assign(reading.fields.atHome, event('returned-home', START + 2000));
    const fresh = { ...options, chargingAt: START + 3000 };
    assert.equal(matchBmwSession(reading, fresh), true, key);
    assert.ok(matchBmwControlledPause(reading, fresh), key);
  }
});
