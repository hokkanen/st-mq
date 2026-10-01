import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptVehicleReading, bmwChargingEvents, bmwHomeContext, bmwIdentityContextValid,
  bmwSessionMatchDetails, validateBmwChargingHistory, pendingBmwSession, matchBmwSession, matchBmwControlledPause } from '../src/charging/vehicle.js';

const START = Date.parse('2026-10-01T00:00:00Z'), MINUTE = 60_000;
function receive(previous, values, at, { now = at + 1000, retained = false,
  association = 'synthetic-bmw', evidenceSince = null, tag = '' } = {}) {
  const payload = { provider: 'bmw-cardata', ...values,
    fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      { measuredAt: value === null ? null : at, readingId: `${key}:${at}:${tag}` }])) };
  const result = acceptVehicleReading(previous, payload, { now, retained, association, evidenceSince });
  assert.ok(result.reading);
  return result.reading;
}
function initial() {
  const homeAt = START - 14 * 24 * 60 * MINUTE;
  const parked = receive(null, { atHome: true, pluggedIn: false, charging: false }, homeAt, { retained: true });
  return receive(parked, { atHome: null, pluggedIn: true, charging: true }, START);
}

test('a 78-minute charging episode identifies using two-week-old remembered home and original source clocks', () => {
  const start = initial(), stopAt = START + 78 * MINUTE;
  const stopped = receive(start, { charging: false }, stopAt, { now: stopAt + 7000 });
  const options = { connectedAt: START, chargingAt: START - 18_000,
    stoppedAt: stopAt - 5000, now: stopAt + 7000 };
  assert.equal(matchBmwSession(stopped, options), true);
  assert.equal(bmwHomeContext(stopped, options.now).measuredAt, START - 14 * 24 * 60 * MINUTE);
  assert.equal(bmwIdentityContextValid(stopped, START + 14 * 24 * 60 * MINUTE), true);
  assert.deepEqual(bmwSessionMatchDetails(JSON.parse(JSON.stringify(stopped)), {
    ...options, now: START + 14 * 24 * 60 * MINUTE,
  }), { chargingReadingId: `charging:${START}:`, stopReadingId: `charging:${stopAt}:`,
    plugReadingId: `pluggedIn:${START}:` });
  assert.equal(matchBmwSession(stopped, { ...options, stoppedAt: stopAt - 30_001 }), false);
});

test('late stop delivered after resume identifies its historical pause without rolling current charging backward', () => {
  const started = initial(), stopAt = START + MINUTE, resumedAt = START + 2 * MINUTE;
  const resumed = receive(started, { charging: true }, resumedAt);
  const deliveredAt = START + 120 * MINUTE;
  const stopped = receive(resumed, { charging: false }, stopAt, { now: deliveredAt });
  assert.equal(stopped.charging, true);
  assert.equal(stopped.fields.charging.measuredAt, resumedAt);
  assert.equal(stopped.fields.charging.receivedAt, resumedAt + 1000);
  assert.deepEqual(bmwChargingEvents(stopped).map(event => [event.value, event.measuredAt]),
    [[true, START], [false, stopAt], [true, resumedAt]]);
  const options = { connectedAt: START, chargingAt: [START, resumedAt], stoppedAt: stopAt,
    now: deliveredAt, pause: { connectedAt: START, requestedAt: stopAt - 10_000,
      confirmedAt: stopAt + 5000, stoppedAt: stopAt, startAt: resumedAt } };
  assert.deepEqual(matchBmwControlledPause(stopped, options), {
    chargingReadingId: `charging:${START}:`, stopReadingId: `charging:${stopAt}:`, confirmedAt: stopAt + 5000,
  });
  assert.equal(matchBmwSession(stopped, options), true);
  assert.equal(matchBmwSession(stopped, { ...options, consumedChargingId: `charging:${START}:` }), false);
  assert.equal(matchBmwControlledPause(stopped, { ...options, lastDisconnectedAt: stopAt }), null);
});

test('stop-before-start delivery reconstructs the measured episode with each original receipt timestamp', () => {
  const parked = receive(null, { atHome: true, pluggedIn: true, charging: false }, START);
  const startAt = START + MINUTE, stopAt = START + 2 * MINUTE;
  const stopFirst = receive(parked, { charging: false }, stopAt);
  const startLater = receive(stopFirst, { charging: true }, startAt, { now: START + 60 * MINUTE });
  assert.equal(startLater.charging, false);
  assert.equal(startLater.fields.charging.measuredAt, stopAt);
  const edges = bmwChargingEvents(startLater);
  assert.equal(edges[0].receivedAt, START + 60 * MINUTE);
  assert.equal(edges[1].receivedAt, stopAt + 1000);
  assert.equal(matchBmwSession(startLater, { connectedAt: START, chargingAt: startAt,
    stoppedAt: stopAt, now: START + 60 * MINUTE }), true);
});

test('a later stop cannot be borrowed from another BMW or physical charging episode', () => {
  let reading = initial();
  const stopAt = START + MINUTE, resumedAt = START + 2 * MINUTE, secondStop = START + 3 * MINUTE;
  reading = receive(reading, { charging: false }, stopAt);
  reading = receive(reading, { charging: true }, resumedAt);
  reading = receive(reading, { charging: false }, secondStop);
  const options = { connectedAt: START, now: secondStop + 1000 };
  assert.equal(matchBmwSession(reading, { ...options, chargingAt: START, stoppedAt: secondStop }), false);
  assert.equal(matchBmwSession(reading, { ...options, chargingAt: resumedAt, stoppedAt: [stopAt, secondStop] }), true);
  assert.equal(matchBmwSession(reading, { ...options, chargingAt: START,
    stoppedAt: [START + 35_000, stopAt] }), true,
  'Several physical observations near the same stop can corroborate it');
});

test('history survives unknown and duplicate reports, with retained provenance never upgraded to live', () => {
  let reading = initial();
  const before = structuredClone(reading.fields.charging.history);
  reading = receive(reading, { charging: null }, START + MINUTE);
  reading = receive(reading, { charging: true }, START, { now: START + 2 * MINUTE });
  assert.deepEqual(reading.fields.charging.history, before);
  const retained = receive(null, { atHome: true, pluggedIn: true, charging: true }, START, { retained: true });
  const replay = receive(retained, { charging: true }, START, { now: START + MINUTE, tag: 'live-replay' });
  assert.equal(bmwChargingEvents(replay)[0].retained, true);
  assert.equal(bmwChargingEvents(replay)[0].receivedAt, START + 1000);
});

test('connection pruning retains only a pre-connection baseline and cannot turn a repeated value into a start', () => {
  let reading = initial();
  const boundary = START + 60 * MINUTE;
  reading = receive(reading, { charging: true }, boundary + 1000, { evidenceSince: boundary });
  assert.equal(reading.fields.charging.history.length, 2);
  assert.equal(bmwChargingEvents(reading)[0].measuredAt, START);
  assert.equal(bmwChargingEvents(reading).length, 1);
  assert.equal(matchBmwSession(reading, { connectedAt: boundary, chargingAt: boundary + 1000,
    stoppedAt: boundary + MINUTE, now: boundary + 2 * MINUTE }), false);
  const replaced = receive(reading, { charging: true }, boundary + 2000,
    { association: 'synthetic-replacement', evidenceSince: boundary });
  assert.equal(bmwHomeContext(replaced, boundary + MINUTE), null);
  assert.equal(replaced.fields.charging.history.length, 1);
});

test('history capacity overflow and malformed ordering fail closed without discarding a useful early start', () => {
  const reading = initial(), baseline = reading.fields.charging.history[0];
  reading.fields.charging.history = Array.from({ length: 4096 }, (_, index) => ({ ...baseline,
    value: index % 2 === 0, measuredAt: START + index, receivedAt: START + index + 1, readingId: `source-${index}` }));
  const overflow = receive(reading, { charging: false }, START + 5000);
  assert.equal(overflow.fields.charging.history[0].readingId, 'source-0');
  assert.equal(overflow.fields.charging.historyOverflowAt, START + 5000);
  assert.deepEqual(bmwChargingEvents(overflow), []);
  const newConnection = receive(overflow, { charging: true }, START + 60_000,
    { evidenceSince: START + 59_000 });
  assert.equal(newConnection.fields.charging.historyOverflowAt, null);
  assert.equal(newConnection.fields.charging.history.length, 2);
  const malformed = initial(); malformed.fields.charging.history.reverse();
  assert.deepEqual(bmwChargingEvents(malformed), []);
});


test('persisted history rejects malformed shapes and unknown fields before they can authorize matching', () => {
  const reading = initial();
  validateBmwChargingHistory(JSON.parse(JSON.stringify(reading)));
  for (const history of [null, {}, [{ ...reading.fields.charging.history[0], legacyAt: START }],
    [{ ...reading.fields.charging.history[0], retained: undefined }],
    [reading.fields.charging.history[0], reading.fields.charging.history[0]],
    [...reading.fields.charging.history].reverse()]) {
    const changed = structuredClone(reading); changed.fields.charging.history = history;
    assert.throws(() => validateBmwChargingHistory(changed), /fresh development database/);
    assert.deepEqual(bmwChargingEvents(changed), []);
  }
  const absent = structuredClone(reading);
  delete absent.fields.charging.history; delete absent.fields.charging.historyOverflowAt;
  validateBmwChargingHistory(absent);
  assert.deepEqual(bmwChargingEvents(absent), [], 'Missing new history does not reconstruct an old start');
});


function unchangedInlet(startAt = START + 1000) {
  const parked = receive(null, { atHome: true, pluggedIn: true, charging: false },
    START - 14 * 24 * 60 * MINUTE, { retained: true });
  return receive(parked, { atHome: null, charging: true }, startAt);
}

test('old retained inlet and two-week remembered home permit independent start-stop identification without a fresh plug event', () => {
  const startAt = START + 1000, stopAt = START + MINUTE, receipt = START + 78 * MINUTE;
  const reading = unchangedInlet(startAt);
  const options = { connectedAt: START, chargingAt: START + 2000, stoppedAt: stopAt + 1000, now: receipt };
  assert.equal(pendingBmwSession(reading, options), true);
  const stopped = receive(reading, { charging: false }, stopAt, { now: receipt });
  assert.deepEqual(bmwSessionMatchDetails(stopped, options), { chargingReadingId: `charging:${startAt}:`,
    stopReadingId: `charging:${stopAt}:`, plugReadingId: null });
  assert.equal(pendingBmwSession(stopped, options), false);
  assert.equal(matchBmwSession(stopped, { ...options,
    consumedPlugId: reading.fields.pluggedIn.positiveEvent.readingId }), true,
  'An old inlet observation is only context; a genuinely new charge episode supplies identity evidence');
  assert.equal(matchBmwSession(stopped, { ...options, consumedChargingId: `charging:${startAt}:` }), false);
});

test('without a fresh plug event both independent start clocks must be inside the actual connection', () => {
  const stopAt = START + MINUTE, options = { connectedAt: START, stoppedAt: stopAt, now: START + 2 * MINUTE };
  for (const [bmwStart, physicalStart, expected] of [[START - 1, START + 1000, false],
    [START + 1000, START - 1, false], [START, START, true]]) {
    const reading = receive(unchangedInlet(bmwStart), { charging: false }, stopAt);
    assert.equal(matchBmwSession(reading, { ...options, chargingAt: physicalStart }), expected);
  }
});

test('unchanged-inlet matching rejects invalid current context, departure, new connection and feed replacement', () => {
  const startAt = START + 1000, stopAt = START + MINUTE;
  const reading = receive(unchangedInlet(startAt), { charging: false }, stopAt);
  const options = { connectedAt: START, chargingAt: startAt, stoppedAt: stopAt, now: START + 2 * MINUTE };
  for (const patch of [{ readingId: '' }, { retained: undefined }, { measuredAt: null },
    { measuredAt: options.now + 1 }, { receivedAt: null }, { receivedAt: options.now + 1 }]) {
    const changed = structuredClone(reading); Object.assign(changed.fields.pluggedIn, patch);
    assert.equal(matchBmwSession(changed, options), false);
  }
  for (const key of ['pluggedIn', 'atHome']) {
    const departed = receive(reading, { [key]: false }, stopAt + 1000);
    assert.equal(matchBmwSession(departed, options), false);
  }
  assert.equal(matchBmwSession(reading, { ...options, connectedAt: stopAt + 1 }), false);
  assert.equal(matchBmwSession(reading, { ...options, lastDisconnectedAt: startAt }), false);
  const replaced = receive(reading, { charging: false }, stopAt, { association: 'new-bmw-feed' });
  assert.equal(matchBmwSession(replaced, options), false);
});

test('manual retry accepts delayed pair delivery only when both starts follow the attempt boundary', () => {
  const retryAt = START + 10 * MINUTE, startAt = retryAt + 1000, stopAt = retryAt + MINUTE;
  let reading = receive(unchangedInlet(), { charging: false }, START + MINUTE);
  const old = { connectedAt: START, chargingAt: START + 1000, stoppedAt: START + MINUTE,
    now: START + 2 * MINUTE };
  assert.equal(matchBmwSession(reading, old), true);
  assert.equal(matchBmwSession(reading, { ...old, now: retryAt, matchingSince: retryAt }), false);
  reading = receive(reading, { charging: false }, stopAt, { now: START + 120 * MINUTE });
  reading = receive(reading, { charging: true }, startAt, { now: START + 120 * MINUTE + 1000 });
  const options = { ...old, now: START + 120 * MINUTE + 1000, matchingSince: retryAt,
    chargingAt: [START + 1000, startAt], stoppedAt: [START + MINUTE, stopAt] };
  assert.equal(reading.charging, false);
  assert.deepEqual(bmwSessionMatchDetails(reading, options), {
    chargingReadingId: `charging:${startAt}:`, stopReadingId: `charging:${stopAt}:`, plugReadingId: null,
  });
  assert.equal(matchBmwSession(reading, { ...options, chargingAt: retryAt - 1 }), false);
  assert.equal(matchBmwSession(reading, { ...options, matchingSince: startAt + 1 }), false);
  assert.equal(matchBmwSession(reading, { ...options, matchingSince: 'invalid' }), false);
});
