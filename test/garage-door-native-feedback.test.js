import test from 'node:test';
import assert from 'node:assert/strict';
import { garageDoorControl } from '../chart/garage-doors.js';
import { createGarageDoorMotion } from '../chart/garage-door-motion.js';

const epoch = Date.parse('2026-11-09T10:00:00Z');
const operation = (action, extra = {}) => ({ action, acknowledgement: 'mqtt-write', status: action === 'open' ? 'observed' : 'published',
  requestedAt: epoch, dispatchedAt: epoch + 10, startingContact: action === 'open' ? 0 : 1,
  deviceReceipt: { action, executed: true, sourceTime: epoch, receivedAt: epoch + 100, admittedAt: epoch + 100 }, ...extra });
const device = (action, extra = {}) => ({ id: 'fixture-door', kind: 'door', available: true,
  controls: { cover: { open: true, close: true, stop: false } },
  readings: { fixture_open: { value: 1, stale: false, observedAt: epoch + 2000, receivedAt: epoch + 2050, coverState: 'open' } },
  cover: { available: true, operation: operation(action) }, ...extra });
const status = (door, elapsed) => ({ now: epoch + elapsed, role: 'master', garage: { doorTravelSeconds: 18 }, equipment: { devices: [door] } });
function render(motion, door, elapsed, browserNow = elapsed) {
  const s = status(door, elapsed), view = garageDoorControl(s, door);
  return { view, travel: motion.update({ ...view, state: view.reportedState, moving: view.reportedMoving,
    deviceId: door.id, durationSeconds: 18, operation: door.cover.operation, statusNow: s.now, now: browserNow }) };
}
function assertTravel(actual, from, to, duration) {
  assert(Math.abs(actual.from - from) < 1e-10); assert.equal(actual.to, to);
  assert(Math.abs(actual.durationMs - duration) < 1e-8); assert.equal(actual.estimated, true);
}

for (const action of ['open', 'close']) test(`first live view during native ${action} reconstructs remaining estimated travel`, () => {
  const door = device(action), motion = createGarageDoorMotion();
  const first = render(motion, door, 4600, 0);
  assertTravel(first.travel, action === 'open' ? 0.25 : 0.75, action === 'open' ? 1 : 0, 13500);
  assert.equal(first.view.state, action === 'open' ? 'Opening' : 'Closing');
  assert.equal(first.view.tone, 'moving'); assert.equal(first.view.disabled, true);
  // Repeated reports, opening the dialog, and a cached dashboard do not reset it.
  assertTravel(render(motion, door, 4600, 4500).travel, 0.5, action === 'open' ? 1 : 0, 9000);
});

test('native opening waits for both receipt and released contact in either arrival order', () => {
  for (const receiptFirst of [true, false]) {
    const door = device('open'), motion = createGarageDoorMotion();
    door.readings.fixture_open.value = 0; door.readings.fixture_open.coverState = 'closed';
    door.readings.fixture_open.observedAt = epoch; door.readings.fixture_open.receivedAt = epoch;
    door.cover.operation.status = 'published';
    const receipt = door.cover.operation.deviceReceipt; delete door.cover.operation.deviceReceipt;
    assert.equal(render(motion, door, 50).travel.from, 0);
    if (receiptFirst) door.cover.operation.deviceReceipt = receipt;
    else {
      Object.assign(door.readings.fixture_open, { value: 1, coverState: 'open', observedAt: epoch + 2000, receivedAt: epoch + 2050 });
      door.cover.operation.status = 'observed';
    }
    assert.equal(render(motion, door, 2100).travel.from, 0);
    door.cover.operation.deviceReceipt = receipt; door.cover.operation.status = 'observed';
    Object.assign(door.readings.fixture_open, { value: 1, coverState: 'open', observedAt: epoch + 2000, receivedAt: epoch + 2050 });
    assertTravel(render(motion, door, 4600).travel, 0.25, 1, 13500);
  }
});

test('fresh closed contact immediately overrides a native estimate, including before an opening receipt', () => {
  for (const action of ['open', 'close']) {
    const door = device(action), motion = createGarageDoorMotion(); render(motion, door, 4600);
    Object.assign(door.readings.fixture_open, { value: 0, coverState: 'closed', observedAt: epoch + 5000, receivedAt: epoch + 5001 });
    if (action === 'open') delete door.cover.operation.deviceReceipt;
    const next = render(motion, door, 5100);
    assert.equal(next.travel.from, 0); assert.equal(next.travel.to, 0); assert.equal(next.travel.durationMs, 0);
    assert.equal(next.view.tone, 'closed');
  }
});

test('opening completion releases controls using visual time, closing completion cannot supply green', () => {
  const opening = device('open'), closing = device('close');
  const s = status(opening, 4600);
  const ongoing = garageDoorControl(s, opening, { doorAnimationNow: epoch + 18099 });
  assert.equal(ongoing.state, 'Opening'); assert.equal(ongoing.disabled, true);
  const ended = garageDoorControl(s, opening, { doorAnimationNow: epoch + 18100 });
  assert.equal(ended.state, 'Open'); assert.equal(ended.action, 'close'); assert.equal(ended.disabled, false);
  const waiting = garageDoorControl(status(closing, 24000), closing);
  assert.equal(waiting.state, 'Closing'); assert.notEqual(waiting.tone, 'closed'); assert.equal(waiting.disabled, true);
});

for (const actions of [['open', 'open'], ['close', 'close'], ['open', 'close'], ['close', 'open']])
  test(`independent native clocks for ${actions.join(' / ')} survive staggered updates and one closed report`, () => {
    const doors = actions.map((action, i) => device(action, { id: `fixture-${i}` }));
    const motions = doors.map(() => createGarageDoorMotion());
    doors.forEach((door, i) => assertTravel(render(motions[i], door, 4600).travel,
      actions[i] === 'open' ? 0.25 : 0.75, actions[i] === 'open' ? 1 : 0, 13500));
    Object.assign(doors[0].readings.fixture_open, { value: 0, coverState: 'closed', observedAt: epoch + 5000, receivedAt: epoch + 5001 });
    assert.equal(render(motions[0], doors[0], 5100).travel.to, 0);
    const other = render(motions[1], doors[1], 9100);
    assertTravel(other.travel, 0.5, actions[1] === 'open' ? 1 : 0, 9000);
  });

test('failed, unavailable or replaced evidence cannot restart a native hydration estimate', () => {
  const door = device('open'), motion = createGarageDoorMotion(); render(motion, door, 4600);
  door.available = false; assert.equal(render(motion, door, 5100).travel.to, null);
  door.available = true;
  assert.equal(render(motion, door, 9100).travel.durationMs, 0);
  door.cover.operation.status = 'unconfirmed';
  assert.equal(garageDoorControl(status(door, 9100), door).state, 'Open');
  const replacement = device('close', { id: 'fixture-replacement' });
  delete replacement.cover.operation.startingContact;
  assert.equal(render(motion, replacement, 9100).travel.durationMs, 0);
});
