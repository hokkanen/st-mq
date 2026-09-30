import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageDoorMotion } from '../chart/garage-door-motion.js';

const observation = (extra = {}) => ({ deviceId: 'fixture-left', state: 'Closed', position: 'closed', moving: false,
  durationSeconds: 18, now: 0, reportedAt: 1_700_000_000_000, ...extra });
const opening = (extra = {}) => observation({ state: 'Opening', position: 'open', moving: true, reportedAt: 1_700_000_000_001, ...extra });
const closing = (extra = {}) => observation({ state: 'Closing', position: 'open', moving: true, reportedAt: 1_700_000_000_002, ...extra });
const open = (extra = {}) => observation({ state: 'Open', position: 'open', reportedAt: 1_700_000_000_001, ...extra });
const stationary = (position, estimated = false) => ({ from: position, to: position, durationMs: 0, estimated });

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

test('a binary closed-to-open edge estimates opening until an actual terminal report arrives', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(open()), { from: 0, to: 1, durationMs: 18000, estimated: true });
  assert.deepEqual(motion.update(open({ now: 4500 })), { from: 0.25, to: 1, durationMs: 13500, estimated: true });
  assert.deepEqual(motion.update(open({ now: 5000, reportedAt: 1_700_000_000_002, coverState: 'open' })), stationary(1));
  assert.deepEqual(motion.update(observation({ now: 6000, reportedAt: 1_700_000_000_003 })), stationary(0));
});

test('explicit open/closed reports take precedence over estimated travel', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(open({ coverState: 'open' })), stationary(1));
  motion.update(closing({ now: 1000 }));
  assert.deepEqual(motion.update(observation({ now: 2000, reportedAt: 1_700_000_000_003 })), stationary(0));
});

test('actual normalized position can anchor motion and a later stationary partial position', () => {
  const motion = createGarageDoorMotion();
  assert.deepEqual(motion.update(opening({ position: 0.25 })), { from: 0.25, to: 1, durationMs: 13500, estimated: true });
  assert.deepEqual(motion.update(open({ position: 0.5, now: 4500, reportedAt: 1_700_000_000_002 })), stationary(0.5));
});

test('a new report ending motion without a terminal position holds the partial estimate', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  const stopped = open({ now: 4500, reportedAt: 1_700_000_000_002 });
  assert.deepEqual(motion.update(stopped), stationary(0.25, true));
  assert.deepEqual(motion.update({ ...stopped, now: 9000, reportedAt: 1_700_000_000_003 }), stationary(0.25, true));
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
  assert.deepEqual(motion.update(open({ now: 5000, reportedAt, coverState: 'open' })), stationary(1));
  assert.deepEqual(motion.update(observation({ now: 5500, reportedAt })), stationary(0));
});

test('command and acknowledgement fields alone cannot start or change visual motion', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation());
  assert.deepEqual(motion.update(observation({ now: 1000, sending: true, action: 'open' })), stationary(0));
  assert.deepEqual(motion.update(observation({ now: 2000, operation: { action: 'open', status: 'published' } })), stationary(0));
});

test('a changed configured duration preserves current position while changing future linear speed', () => {
  const motion = createGarageDoorMotion();
  motion.update(observation()); motion.update(opening());
  assert.deepEqual(motion.update(opening({ now: 4500, durationSeconds: 36 })),
    { from: 0.25, to: 1, durationMs: 27000, estimated: true });
  assert.deepEqual(motion.update(opening({ now: 13500, durationSeconds: 36 })),
    { from: 0.5, to: 1, durationMs: 18000, estimated: true });
});
