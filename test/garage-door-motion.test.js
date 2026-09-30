import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageDoorMotion } from '../chart/garage-door-motion.js';

const observation = (extra = {}) => ({ deviceId: 'fixture-left', state: 'Closed', position: 'closed', moving: false,
  durationSeconds: 18, now: 0, reportedAt: 1_700_000_000_000, ...extra });
const opening = (extra = {}) => observation({ state: 'Opening', position: 'open', moving: true, reportedAt: 1_700_000_000_001, ...extra });
const closing = (extra = {}) => observation({ state: 'Closing', position: 'open', moving: true, reportedAt: 1_700_000_000_002, ...extra });
const open = (extra = {}) => observation({ state: 'Open', position: 'open', reportedAt: 1_700_000_000_001, ...extra });
const stationary = (position, estimated = false) => ({ from: position, to: position, durationMs: 0, estimated });
const wallClock = 1_700_000_000_000;
const command = (action, extra = {}) => ({ action, status: 'published', requestedAt: wallClock + 900,
  acknowledgedAt: wallClock + 1000, ...extra });
const at = (now, extra = {}) => ({ now, statusNow: wallClock + now, ...extra });
const assertTravel = (actual, from, to, durationMs) => {
  assert.ok(Math.abs(actual.from - from) < 1e-10, `expected position ${from}, got ${actual.from}`);
  assert.equal(actual.to, to);
  assert.ok(Math.abs(actual.durationMs - durationMs) < 1e-7, `expected duration ${durationMs}, got ${actual.durationMs}`);
  assert.equal(actual.estimated, true);
};

test('hydration shows known endpoints and does not invent a starting position during movement', () => {
  for (const report of [observation(), open(), opening(), closing()]) {
    const motion = createGarageDoorMotion();
    assert.deepEqual(motion.update(report), stationary(report.moving ? null : report.state === 'Open' ? 1 : 0));
    assert.deepEqual(motion.update({ ...report, now: 9000 }), stationary(report.moving ? null : report.state === 'Open' ? 1 : 0));
  }
});

test('both doors and directions travel linearly at the configured full-stroke speed', () => {
  for (const deviceId of ['fixture-left', 'fixture-right']) for (const direction of ['opening', 'closing']) {
    const motion = createGarageDoorMotion(), upwards = direction === 'opening';
    motion.update(upwards ? observation({ deviceId }) : open({ deviceId, reportedAt: 1_700_000_000_000 }));
    const report = upwards ? opening({ deviceId }) : closing({ deviceId });
    assert.deepEqual(motion.update(report), { from: upwards ? 0 : 1, to: upwards ? 1 : 0, durationMs: 18000, estimated: true });
    assert.deepEqual(motion.update({ ...report, now: 4500 }), { from: upwards ? 0.25 : 0.75, to: upwards ? 1 : 0, durationMs: 13500, estimated: true });
    assert.deepEqual(motion.update({ ...report, now: 9000, reportedAt: report.reportedAt + 100 }),
      { from: 0.5, to: upwards ? 1 : 0, durationMs: 9000, estimated: true });
    assert.deepEqual(motion.update({ ...report, now: 18000, reportedAt: report.reportedAt + 100 }), stationary(upwards ? 1 : 0, true));
  }
});

test('reversals use the current estimated position and only the remaining travel distance', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  assert.deepEqual(motion.update(closing({ now: 4500 })), { from: 0.25, to: 0, durationMs: 4500, estimated: true });
  assert.deepEqual(motion.update(opening({ now: 6750, reportedAt: 1_700_000_000_003 })),
    { from: 0.125, to: 1, durationMs: 15750, estimated: true });
});

test('binary open reports keep estimated opening in progress until the closed endpoint is observed', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(open()), { from: 0, to: 1, durationMs: 18000, estimated: true });
  assert.deepEqual(motion.update(open({ now: 4500 })), { from: 0.25, to: 1, durationMs: 13500, estimated: true });
  assertTravel(motion.update(open({ now: 5000, reportedAt: 1_700_000_000_002, coverState: 'open' })), 5 / 18, 1, 13000);
  assert.deepEqual(motion.update(observation({ now: 6000, reportedAt: 1_700_000_000_003 })), stationary(0));
});

test('coverState open means the closed contact released, while closed is an authoritative endpoint', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(open({ coverState: 'open' })), { from: 0, to: 1, durationMs: 18000, estimated: true });
  motion.update(closing({ now: 1000 }));
  assert.deepEqual(motion.update(observation({ now: 2000, reportedAt: 1_700_000_000_003 })), stationary(0));
});

test('actual normalized position can anchor motion and a later stationary partial position', () => {
  const motion = createGarageDoorMotion();
  assert.deepEqual(motion.update(opening({ position: 0.25 })), { from: 0.25, to: 1, durationMs: 13500, estimated: true });
  assert.deepEqual(motion.update(open({ position: 0.5, now: 4500, reportedAt: 1_700_000_000_002 })), stationary(0.5));
});

test('opening followed by binary Open continues travel because the contact gives no stopping position', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  const released = open({ now: 4500, reportedAt: 1_700_000_000_002 });
  assert.deepEqual(motion.update(released), { from: 0.25, to: 1, durationMs: 13500, estimated: true });
  assert.deepEqual(motion.update({ ...released, now: 9000, reportedAt: 1_700_000_000_003 }),
    { from: 0.5, to: 1, durationMs: 9000, estimated: true });
});

test('unknown evidence cancels travel and recovery does not invent a new edge', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  assert.deepEqual(motion.update(opening({ state: 'Unknown', position: 'unknown', now: 4500 })), stationary(null));
  assert.deepEqual(motion.update(opening({ now: 5000 })), stationary(null));
  assert.deepEqual(motion.update(open({ now: 6000, reportedAt: 1_700_000_000_002 })), stationary(1));
});

test('replacement equipment cannot inherit the previous door travel', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  assert.deepEqual(motion.update(open({ deviceId: 'replacement', now: 4500 })), stationary(1));
});

test('accepted current motion and endpoints remain authoritative when source timestamps match', () => {
  const motion = createGarageDoorMotion();
  const reportedAt = observation().reportedAt;
  motion.update(observation());
  assert.deepEqual(motion.update(opening({ reportedAt })), { from: 0, to: 1, durationMs: 18000, estimated: true });
  assert.deepEqual(motion.update(closing({ now: 4500, reportedAt })), { from: 0.25, to: 0, durationMs: 4500, estimated: true });
  assert.deepEqual(motion.update(observation({ now: 5500, reportedAt })), stationary(0));
});

test('command and acknowledgement fields alone cannot start or change visual motion', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(observation({ now: 1000, sending: true, action: 'open' })), stationary(0));
  assert.deepEqual(motion.update(observation({ now: 2000, operation: { action: 'open', status: 'published' } })), stationary(0));
});

test('opening waits for the physical response then catches up from successful publication', () => {
  const motion = createGarageDoorMotion(), operation = command('open');
  motion.update(observation(at(0)));
  assert.deepEqual(motion.update(observation(at(1000, { operation }))), stationary(0));
  assert.deepEqual(motion.update(observation(at(3000, { operation }))), stationary(0));
  const response = open(at(4000, { coverState: 'open', reportedAt: wallClock + 4000,
    operation: { ...operation, status: 'observed' } }));
  assertTravel(motion.update(response), 1 / 6, 1, 15000);
  assertTravel(motion.update({ ...response, ...at(7000) }), 1 / 3, 1, 12000);
  assertTravel(motion.update({ ...response, ...at(10000), reportedAt: wallClock + 10000 }), 0.5, 1, 9000);
  assert.deepEqual(motion.update({ ...response, ...at(19000) }), stationary(1, true));
});

test('closing waits for Closing evidence and does not mistake unchanged Open for a response', () => {
  const motion = createGarageDoorMotion(), operation = command('close');
  motion.update(open(at(0, { reportedAt: wallClock })));
  assert.deepEqual(motion.update(open(at(1000, { operation }))), stationary(1));
  assert.deepEqual(motion.update(open(at(3000, { operation, reportedAt: wallClock + 3000 }))), stationary(1));
  const response = closing(at(4000, { operation, reportedAt: wallClock + 4000 }));
  assertTravel(motion.update(response), 5 / 6, 0, 15000);
  assertTravel(motion.update({ ...response, ...at(7000), reportedAt: wallClock + 7000 }), 2 / 3, 0, 12000);
  assert.deepEqual(motion.update(observation(at(8000, { operation, reportedAt: wallClock + 8000 }))), stationary(0));
});

test('successful-send time excludes the request publication delay', () => {
  const motion = createGarageDoorMotion();
  const publishing = command('open', { status: 'publishing', requestedAt: wallClock + 1000, acknowledgedAt: undefined });
  const operation = { ...publishing, status: 'published', acknowledgedAt: wallClock + 4000 };
  motion.update(observation(at(0)));
  assert.deepEqual(motion.update(observation(at(1000, { operation: publishing }))), stationary(0));
  assert.deepEqual(motion.update(observation(at(4000, { operation }))), stationary(0));
  assertTravel(motion.update(open(at(7000, { operation, coverState: 'open', reportedAt: wallClock + 7000 }))),
    1 / 6, 1, 15000);
});

test('a poll first receiving both successful send and response still catches up using the server clock', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation(at(0)));
  assertTravel(motion.update(open(at(4000, { operation: command('open'), reportedAt: wallClock + 4000 }))),
    1 / 6, 1, 15000);
});

test('the estimated animation uses browser elapsed time after confirmation without restarting on cached status', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation(at(0)));
  const response = open(at(4000, { operation: command('open'), reportedAt: wallClock + 4000 }));
  assertTravel(motion.update(response), 1 / 6, 1, 15000);
  assertTravel(motion.update({ ...response, now: 7000 }), 1 / 3, 1, 12000);
  assertTravel(motion.update({ ...response, now: 6000 }), 1 / 3, 1, 12000);
  assertTravel(motion.update({ ...response, ...at(10000) }), 0.5, 1, 9000);
});

test('failed sends and absent, future or invalid acknowledgements cannot supply a catch-up clock', () => {
  for (const operation of [
    command('open', { status: 'failed' }),
    command('open', { status: 'unconfirmed' }),
    command('open', { status: 'publishing', acknowledgedAt: undefined }),
    command('open', { acknowledgedAt: undefined }),
    command('open', { acknowledgedAt: wallClock + 5000 }),
    command('open', { acknowledgedAt: wallClock + 800 }),
  ]) {
    const motion = createGarageDoorMotion();
    motion.update(observation(at(0)));
    assert.deepEqual(motion.update(observation(at(1000, { operation }))), stationary(0));
    assertTravel(motion.update(open(at(4000, { operation, reportedAt: wallClock + 4000 }))), 0, 1, 18000);
  }
});

test('unchanged binary Open cannot confirm a reopen while the door is estimated to be closing', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation(at(0)));
  motion.update(opening(at(0)));
  assertTravel(motion.update(closing(at(9000, { reportedAt: wallClock + 9000 }))), 0.5, 0, 9000);
  assertTravel(motion.update(open(at(10000, { reportedAt: wallClock + 10000 }))), 4 / 9, 0, 8000);
  const operation = command('open', { requestedAt: wallClock + 10900, acknowledgedAt: wallClock + 11000 });
  assertTravel(motion.update(open(at(11000, { operation, reportedAt: wallClock + 10000 }))), 7 / 18, 0, 7000);
  assertTravel(motion.update(open(at(14000, { operation, reportedAt: wallClock + 14000 }))), 2 / 9, 0, 4000);
  assertTravel(motion.update(opening(at(14000, { operation, reportedAt: wallClock + 14000 }))), 5 / 9, 1, 8000);
});

test('a pre-request report cannot confirm a successfully sent command', () => {
  const motion = createGarageDoorMotion(), operation = command('open');
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation })));
  assertTravel(motion.update(open(at(4000, { operation, reportedAt: wallClock + 500 }))), 0, 1, 18000);
});

test('unknown evidence clears a pending command clock instead of resurrecting it on recovery', () => {
  const motion = createGarageDoorMotion(), operation = command('open');
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation })));
  assert.deepEqual(motion.update(observation(at(2000, { operation, state: 'Unknown', position: 'unknown' }))), stationary(null));
  assert.deepEqual(motion.update(observation(at(3000, { operation, reportedAt: wallClock + 3000 }))), stationary(0));
  assertTravel(motion.update(open(at(4000, { operation, reportedAt: wallClock + 4000 }))), 0, 1, 18000);
});

test('replacement equipment cannot inherit a pending command clock even if an old receipt remains', () => {
  const motion = createGarageDoorMotion(), operation = command('open');
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation })));
  assert.deepEqual(motion.update(observation(at(2000, { deviceId: 'replacement', operation }))), stationary(0));
  assertTravel(motion.update(open(at(4000, { deviceId: 'replacement', operation, reportedAt: wallClock + 4000 }))),
    0, 1, 18000);
});

test('new commands supersede earlier pending command clocks', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation: command('open') })));
  const operation = command('close', { requestedAt: wallClock + 1900, acknowledgedAt: wallClock + 2000 });
  motion.update(observation(at(2000, { operation })));
  assertTravel(motion.update(open(at(4000, { operation, reportedAt: wallClock + 4000 }))), 0, 1, 18000);
});

test('a confirmed reversal catches up from the estimated position at successful send', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation(at(0)));
  motion.update(open(at(4000, { operation: command('open'), reportedAt: wallClock + 4000 })));
  const operation = command('close', { requestedAt: wallClock + 6900, acknowledgedAt: wallClock + 7000 });
  assertTravel(motion.update(open(at(7000, { operation, reportedAt: wallClock + 4000 }))), 1 / 3, 1, 12000);
  assertTravel(motion.update(closing(at(10000, { operation, reportedAt: wallClock + 10000 }))), 1 / 6, 0, 3000);
  assert.deepEqual(motion.update(closing(at(13000, { operation, reportedAt: wallClock + 10000 }))), stationary(0, true));
});

test('a delayed acknowledgement can catch up a response already seen while publishing', () => {
  const motion = createGarageDoorMotion();
  const publishing = command('open', { status: 'publishing', acknowledgedAt: undefined });
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation: publishing })));
  const response = open(at(4000, { operation: publishing, reportedAt: wallClock + 4000 }));
  assertTravel(motion.update(response), 0, 1, 18000);
  assertTravel(motion.update({ ...response, ...at(5000), operation: command('open', { status: 'observed' }) }),
    2 / 9, 1, 14000);
});

test('a successful send arriving after the physical response preserves the progress already shown', () => {
  const motion = createGarageDoorMotion();
  const publishing = command('open', { status: 'publishing', acknowledgedAt: undefined });
  motion.update(observation(at(0)));
  motion.update(observation(at(1000, { operation: publishing })));
  const response = open(at(4000, { operation: publishing, reportedAt: wallClock + 4000 }));
  assertTravel(motion.update(response), 0, 1, 18000);
  assertTravel(motion.update({ ...response, ...at(5000),
    operation: command('open', { status: 'observed', acknowledgedAt: wallClock + 5000 }) }), 1 / 18, 1, 17000);
});

test('reopening a partly closed door waits for response and uses the remaining opening distance', () => {
  const motion = createGarageDoorMotion();
  const closeOperation = command('close');
  motion.update(open(at(0, { reportedAt: wallClock })));
  motion.update(closing(at(4000, { operation: closeOperation, reportedAt: wallClock + 4000 })));
  const operation = command('open', { requestedAt: wallClock + 6900, acknowledgedAt: wallClock + 7000 });
  assertTravel(motion.update(closing(at(7000, { operation, reportedAt: wallClock + 4000 }))), 2 / 3, 0, 12000);
  assertTravel(motion.update(opening(at(10000, { operation, reportedAt: wallClock + 10000 }))), 5 / 6, 1, 3000);
  assert.deepEqual(motion.update(opening(at(13000, { operation, reportedAt: wallClock + 10000 }))), stationary(1, true));
});

test('confirmation later than the configured stroke catches up to an estimated endpoint', () => {
  for (const action of ['open', 'close']) {
    const motion = createGarageDoorMotion(), upwards = action === 'open';
    const operation = command(action);
    motion.update(upwards ? observation(at(0)) : open(at(0, { reportedAt: wallClock })));
    motion.update(upwards ? observation(at(1000, { operation })) : open(at(1000, { operation })));
    const response = upwards ? opening(at(21000, { operation, reportedAt: wallClock + 21000 }))
      : closing(at(21000, { operation, reportedAt: wallClock + 21000 }));
    assert.deepEqual(motion.update(response), stationary(upwards ? 1 : 0, true));
  }
});

test('a changed configured duration preserves current position while changing future linear speed', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  assert.deepEqual(motion.update(opening({ now: 4500, durationSeconds: 36 })),
    { from: 0.25, to: 1, durationMs: 27000, estimated: true });
  assert.deepEqual(motion.update(opening({ now: 13500, durationSeconds: 36 })),
    { from: 0.5, to: 1, durationMs: 18000, estimated: true });
});
