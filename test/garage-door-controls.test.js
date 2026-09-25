import test from 'node:test';
import assert from 'node:assert/strict';
import { garageDoorControl, garageDoorDevices } from '../chart/garage-doors.js';

const now = Date.parse('2026-09-24T12:00:00Z');
const door = (value = 0, extra = {}) => ({
  id: 'side_entrance', label: 'Side entrance', area: 'garage', kind: 'door', available: true,
  controls: { cover: { open: true, close: true, stop: false } },
  cover: { available: true, state: null, operation: null },
  readings: { side_entrance_open: { value, unit: 'state', stale: false, observedAt: now - 1000 } },
  ...extra,
});
const status = device => ({ role: 'primary', now, equipment: { devices: [device] } });
const operation = (device, action, state, requestedAt = now) => {
  device.cover.operation = { action, status: state, requestedAt };
  return device;
};

test('each door exposes the opposite action from its reported contact without relying on configured IDs', () => {
  for (const [value, state, action, label] of [[0, 'Closed', 'open', 'Open'], [1, 'Open', 'close', 'Close']]) {
    const device = door(value), view = garageDoorControl(status(device), device);
    assert.equal(view.state, state);
    assert.equal(view.action, action);
    assert.equal(view.label, label);
    assert.equal(view.disabled, false);
    assert.equal(view.feedback, '');
  }
  const device = door(1);
  device.cover.state = 'closed';
  assert.equal(garageDoorControl(status(device), device).action, 'close', 'The shortcut follows the independent reported contact');
});

test('live reported movement exposes only configured Stop, including motion without a local command', () => {
  for (const [motion, state] of [['opening', 'Opening'], ['closing', 'Closing']]) {
    const device = door(1);
    device.readings.side_entrance_open.coverState = motion;
    const moving = garageDoorControl(status(device), device);
    assert.equal(moving.state, state);
    assert.equal(moving.moving, true);
    assert.equal(moving.action, null);
    assert.equal(moving.label, `${state}…`);
    assert.equal(moving.disabled, true);
    assert.equal(device.cover.operation, null);
    device.controls.cover.stop = true;
    const stopping = garageDoorControl(status(device), device);
    assert.equal(stopping.action, 'stop');
    assert.equal(stopping.label, 'Stop');
    assert.equal(stopping.disabled, false);
  }
});

test('sending and broker acknowledgement retain the observed state and block repeat movement requests', () => {
  const device = door(), current = status(device);
  const sending = garageDoorControl(current, device, { busy: true, actionKind: 'cover', actionDeviceId: device.id });
  assert.equal(sending.state, 'Closed');
  assert.equal(sending.label, 'Sending…');
  assert.equal(sending.sending, true);
  assert.equal(sending.disabled, true);
  for (const phase of ['publishing', 'published']) {
    operation(device, 'open', phase);
    const view = garageDoorControl(current, device);
    assert.equal(view.state, 'Closed');
    assert.equal(view.moving, false);
    assert.equal(view.label, 'Waiting…');
    assert.equal(view.action, null);
    assert.equal(view.disabled, true);
    assert.match(view.feedback, /Open requested/);
    assert.doesNotMatch(view.feedback, /Opening/);
  }
});

test('supported Stop remains available while the last movement request awaits physical confirmation', () => {
  const device = operation(door(), 'open', 'published');
  device.controls.cover.stop = true;
  const view = garageDoorControl(status(device), device);
  assert.equal(view.state, 'Closed');
  assert.equal(view.action, 'stop');
  assert.equal(view.disabled, false);
  assert.match(view.feedback, /position unconfirmed/);
  assert.equal(garageDoorControl(status(device), device, { busy: true }).disabled, true, 'Request delivery is still serialized');
});

test('an observed terminal state changes the action and clears the request receipt', () => {
  const device = operation(door(1), 'open', 'observed');
  device.readings.side_entrance_open.coverState = 'open';
  device.readings.side_entrance_open.observedAt = now + 1000;
  const view = garageDoorControl({ ...status(device), now: now + 1000 }, device);
  assert.equal(view.state, 'Open');
  assert.equal(view.action, 'close');
  assert.equal(view.disabled, false);
  assert.equal(view.feedback, '');
});

test('failed or unconfirmed movement offers a retry based on retained contact state with explicit feedback', () => {
  for (const phase of ['failed', 'unconfirmed']) {
    const device = operation(door(), 'open', phase), view = garageDoorControl(status(device), device);
    assert.equal(view.state, 'Closed');
    assert.equal(view.action, 'open');
    assert.equal(view.disabled, false);
    assert.equal(view.failed, true);
    assert.match(view.feedback, phase === 'failed' ? /could not send/ : /no new position report/);
  }
});

test('local sending and failure feedback belong only to the requested door', () => {
  const device = door(), other = door(1, { id: 'rear_entrance' });
  const snapshot = { actionKind: 'cover', actionDeviceId: device.id, error: true, message: 'Could not confirm the control request.' };
  const own = garageDoorControl(status(device), device, snapshot);
  assert.equal(own.feedback, snapshot.message);
  assert.equal(own.failed, true);
  const unrelated = garageDoorControl(status(other), other, snapshot);
  assert.equal(unrelated.feedback, '');
  assert.equal(unrelated.failed, false);
  const blocked = garageDoorControl(status(other), other, { ...snapshot, busy: true, error: false });
  assert.equal(blocked.label, 'Close');
  assert.equal(blocked.sending, false);
  assert.equal(blocked.disabled, true);
});

test('expired command receipts release the shortcut without changing the retained state', () => {
  const device = operation(door(), 'open', 'published', now - 59_999);
  assert.equal(garageDoorControl(status(device), device).disabled, true);
  const expired = garageDoorControl({ ...status(device), now: now + 1 }, device);
  assert.equal(expired.state, 'Closed');
  assert.equal(expired.action, 'open');
  assert.equal(expired.disabled, false);
  assert.equal(expired.feedback, '');
  operation(device, 'open', 'publishing', now - 60_000);
  assert.equal(garageDoorControl(status(device), device).disabled, true, 'An active publication does not expire in presentation');
});

test('a newer live terminal report supersedes failed or unconfirmed feedback', () => {
  for (const phase of ['failed', 'unconfirmed']) {
    const device = operation(door(1), 'close', phase, now - 2000);
    device.readings.side_entrance_open.coverState = 'open';
    const view = garageDoorControl(status(device), device);
    assert.equal(view.action, 'close');
    assert.equal(view.feedback, '');
    assert.equal(view.failed, false);
  }
});

test('unknown, stale, absent or ambiguous contacts never produce a movement shortcut', () => {
  const cases = [
    door(null), door(2), door(0, { readings: {} }),
    door(0, { readings: { side_entrance_open: { value: 0, unit: 'state', stale: true, observedAt: now } } }),
    door(0, { readings: { side_entrance_open: { value: null, unit: 'state', stale: false, coverState: 'opening', observedAt: now } } }),
    door(0, { readings: {
      left_open: { value: 0, unit: 'state', stale: false, observedAt: now },
      right_open: { value: 1, unit: 'state', stale: false, observedAt: now },
    } }),
  ];
  for (const device of cases) {
    const view = garageDoorControl(status(device), device);
    assert.equal(view.state, 'Unknown');
    assert.equal(view.action, null);
    assert.equal(view.disabled, true);
    assert.equal(view.tone, 'unknown');
    assert.match(view.feedback, /current door report/);
  }
});

test('a shortcut requires available contact evidence with a finite timestamp no later than the current status', () => {
  const unavailable = door(0, { available: false });
  const cases = [unavailable, ...[undefined, null, NaN, Infinity, now + 1].map(observedAt =>
    door(0, { readings: { side_entrance_open: { value: 0, unit: 'state', stale: false, observedAt } } }))];
  for (const device of cases) {
    const view = garageDoorControl(status(device), device);
    assert.equal(view.disabled, true);
    assert.equal(view.action, null);
    assert.equal(view.tone, 'unknown');
  }
  const quiet = door(0, { readings: { side_entrance_open: { value: 0, unit: 'state', stale: false, observedAt: now - 86_400_000 } } });
  assert.equal(garageDoorControl(status(quiet), quiet).disabled, false, 'Acquisition owns freshness; quiet doors get no browser age timeout');
});

test('the shortcut respects configured capabilities, connection availability and device enablement', () => {
  for (const value of [0, 1]) {
    const device = door(value);
    device.controls.cover[value === 0 ? 'open' : 'close'] = false;
    const view = garageDoorControl(status(device), device);
    assert.equal(view.disabled, true);
    assert.match(view.feedback, /control is not configured/);
  }
  for (const update of [{ cover: { available: false } }, { cover: null }, { controls: {} }, { enabled: false }, { kind: 'switch' }]) {
    const device = door(0, update);
    assert.equal(garageDoorControl(status(device), device).disabled, true);
  }
  const device = door();
  assert.equal(garageDoorControl(status(device), device, { blocked: true }).disabled, true);
});

test('replica, transition and protected authority cannot operate doors even with advertised controls', () => {
  const device = door(), current = status(device);
  for (const update of [{ role: 'replica' }, { role: 'transition' }, { role: 'protected' },
    { instance: { role: 'replica' } }, { controlAuthority: { state: 'protected' } },
    { pairing: { enabled: true, role: 'primary', canControl: false } }]) {
    const view = garageDoorControl({ ...current, ...update }, device);
    assert.equal(view.disabled, true);
    assert.match(view.feedback, /primary computer/);
  }
});

test('garage door discovery uses configured devices and signals without hard-coded IDs or mutation', () => {
  const devices = [
    door(), door(1, { id: 'unassigned', area: undefined }),
    door(0, { id: 'sensor_mapped', area: 'home', readings: { garage_door7_open: { value: 0, stale: false } } }),
    door(0, { id: 'outside', area: 'garden' }), door(0, { id: 'disabled', enabled: false }),
    door(0, { id: 'switch', kind: 'switch' }),
  ];
  const current = { role: 'primary', now, equipment: { devices } }, before = structuredClone(current);
  const selected = garageDoorDevices(current);
  assert.deepEqual(selected.map(device => device.id), ['side_entrance', 'unassigned', 'sensor_mapped']);
  assert.equal(selected[0], devices[0], 'Configured identity is preserved');
  for (const device of selected) garageDoorControl(current, device);
  assert.deepEqual(current, before, 'Rendering never rewrites readings, capabilities or operations');
  assert.deepEqual(garageDoorDevices(), []);
  assert.deepEqual(garageDoorDevices({}), []);
});
