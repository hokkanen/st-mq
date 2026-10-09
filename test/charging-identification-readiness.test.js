import test from 'node:test';
import assert from 'node:assert/strict';
import { identificationControlBlocker, identificationBlockerDetail } from '../src/charging/identification-readiness.js';

const now = 1_000_000;
const ready = () => ({ supported: true, transitioning: false, closed: false, canControl: true, input: 'mqtt', now,
  control: { session: { connected: true }, snapshot: { online: true, readAt: now, pluggedIn: true,
    transport: 'shelly-evse', identificationReady: true, enabled: true } } });

test('identification explains actual charger prerequisites while preserving their command restrictions', () => {
  assert.equal(identificationControlBlocker(ready()), null);
  const cases = [
    [{ online: false }, 'charger-offline'], [{ readAt: now - 60_001 }, 'charger-readback-stale'],
    [{ readAt: now + 1 }, 'charger-readback-stale'], [{ readAt: null }, 'charger-readback-stale'],
    [{ pluggedIn: false }, 'assignment-unresolved'], [{ faulted: true }, 'charger-fault'],
    [{ connectorStatus: 'Faulted' }, 'charger-fault'], [{ authorizationBlocked: true }, 'charging-authorization'],
    [{ enabled: false }, 'charger-disabled'], [{ connectorStatus: 'Reserved' }, 'connector-unavailable'],
    [{ nativeScheduleActive: true }, 'native-schedule'], [{ stopped: true }, 'other-instruction'],
    [{ identificationReady: false }, 'charger-confirmation-pending'],
  ];
  for (const [patch, reason] of cases) {
    const input = ready(); Object.assign(input.control.snapshot, patch);
    assert.equal(identificationControlBlocker(input), reason, JSON.stringify(patch));
    assert.equal(typeof identificationBlockerDetail(reason), 'string');
    assert.doesNotMatch(identificationBlockerDetail(reason), /prerequisites are unavailable/, reason);
  }
  assert.equal(identificationControlBlocker({ ...ready(), supported: false }), 'unsupported');
  assert.equal(identificationControlBlocker({ ...ready(), transitioning: true }), 'backend-changing');
  for (const patch of [{ closed: true }, { canControl: false }, { input: 'offline' }])
    assert.equal(identificationControlBlocker({ ...ready(), ...patch }), 'control-unavailable');
});

test('a device permission hold keeps its narrow exception without clearing other identification restrictions', () => {
  const input = ready(); input.control.devicePermissionHeld = true;
  Object.assign(input.control.snapshot, { stopped: true, manualStop: true });
  assert.equal(identificationControlBlocker(input), null);
  input.control.manual = { kind: 'stop' };
  assert.equal(identificationControlBlocker(input), 'other-instruction');
  delete input.control.manual; input.control.snapshot.authorizationBlocked = true;
  assert.equal(identificationControlBlocker(input), 'charging-authorization');
});

test('readiness preserves OCPP capabilities, exact readback age and unknown reason rejection', () => {
  const input = ready(); Object.assign(input.control.snapshot, { transport: 'ocpp', identificationReady: false,
    nativeScheduleActive: true, readAt: now - 60_000 });
  assert.equal(identificationControlBlocker(input), null);
  input.now = NaN;
  assert.equal(identificationControlBlocker(input), 'charger-readback-stale');
  for (const reason of ['constructor', '__proto__', 'invented-private-cause'])
    assert.equal(identificationBlockerDetail(reason), 'Identification prerequisites are unavailable. Review the charger and vehicle connection status.');
});
