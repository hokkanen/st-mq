import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const signal = value => ({ value, available: true, measuredAt: NOW - 1000 });

function fixture() {
  const control = { snapshot: { online: true }, execution: { periods: [{ startAt: NOW - 300_000, endAt: NOW + 600_000 }] } };
  const item = { definition: { id: 'charger1' }, controls: { enabled: true } };
  const peer = { definition: { id: 'charger2' }, controller: { status: () => control },
    controls: { enabled: true }, request: {}, plan: { feasible: true, periods: control.execution.periods },
    vehicleEvidence: { chargingTimes: [NOW - 300_000], stoppedTimes: [] } };
  const physical = { providerConnected: true, connected: signal(true), charging: signal(true), powerKw: signal(11) };
  const runtime = Object.assign(Object.create(ChargingRuntime.prototype), {
    chargers: { charger1: item, charger2: peer }, configuration: { chargers: {} }, config: {}, clock: () => NOW,
  });
  return { runtime, item, peer, control, physical,
    available: () => runtime.identificationPauseAvailable(item, { charger2: physical }, NOW) };
}

test('a BMW pause waits after the other charger stops instead of reusing one overlapping BMW episode', () => {
  const f = fixture();
  f.physical.charging = signal(false); f.physical.powerKw = signal(0);
  f.control.execution.periods = [{ startAt: NOW + 600_000, endAt: NOW + 1_200_000 }];
  for (const delay of [3000, 29_000, 59_000]) {
    f.peer.vehicleEvidence.stoppedTimes = [NOW - delay];
    assert.equal(f.available(), false, `A peer stop ${delay / 1000} seconds earlier can overlap the BMW correlation`);
  }
  f.peer.vehicleEvidence.stoppedTimes = [NOW - 61_000];
  assert.equal(f.available(), true, 'A settled stopped peer with no approaching start permits one pause');
});

test('a BMW pause waits while either a peer start or stop is approaching', () => {
  for (const charging of [true, false]) {
    for (const delay of [1000, 90_000, 119_000, 120_000]) {
      const f = fixture();
      f.physical.charging = signal(charging); f.physical.powerKw = signal(charging ? 11 : 0);
      f.control.execution.periods = charging
        ? [{ startAt: NOW - 300_000, endAt: NOW + delay }]
        : [{ startAt: NOW + delay, endAt: NOW + 600_000 }];
      assert.equal(f.available(), false, `${charging ? 'Stopping' : 'Starting'} within the observation window defers the pause`);
    }
  }
  assert.equal(fixture().available(), true, 'A settled running peer with a long accepted period permits the pause');
  const f = fixture();
  f.control.execution.periods[0].endAt = NOW + 121_000;
  assert.equal(f.available(), true, 'A later boundary need not block identification indefinitely');
});

test('recent peer starts and mismatched execution remain unsettled', () => {
  const f = fixture();
  f.peer.vehicleEvidence.chargingTimes = [NOW - 3000];
  assert.equal(f.available(), false);
  f.peer.vehicleEvidence.chargingTimes = [NOW - 61_000];
  assert.equal(f.available(), true);
  f.control.execution.periods = [{ startAt: NOW + 600_000, endAt: NOW + 1_200_000 }];
  assert.equal(f.available(), false, 'A running peer still being stopped by its economic schedule is not quiet');
});

test('confirmed stable provisional charging permits a BMW pause without changing the peer plan', () => {
  for (const plan of [{ feasible: false }, { provisional: true }]) {
    const f = fixture();
    Object.assign(f.peer.plan, plan);
    f.control.phase = 'provisional'; f.control.provisional = true;
    f.control.execution = null;
    f.peer.plan.periods = [{ startAt: NOW - 300_000, endAt: null }];
    const before = structuredClone(f.peer.plan);
    assert.equal(f.available(), true, 'Missing economics alone do not create a physical peer transition');
    assert.deepEqual(f.peer.plan, before, 'Identification has no authority to change peer economics');
    f.peer.plan.periods[0].endAt = NOW + 90_000;
    assert.equal(f.available(), false, 'Even provisional charging must respect an approaching transition');
    f.peer.plan.periods[0].endAt = null;
    f.peer.vehicleEvidence.chargingTimes = [NOW - 30_000];
    assert.equal(f.available(), false, 'The provisional release must first settle physically');
  }
});

test('a settled native manual stop permits the other charger to identify without resuming the peer', () => {
  for (const transport of ['ocpp', 'shelly-evse', 'easee-cloud']) {
    const f = fixture();
    f.control.manual = { kind: 'stop' };
    f.control.snapshot = { online: true, transport, readAt: NOW,
      ...(transport === 'ocpp' ? { appControl: { stopped: true, controlKnown: true, readAt: NOW, schedule: { enabled: 'none' } } }
        : transport === 'shelly-evse' ? { nativeScheduleActive: false, controlReady: true,
          fields: { start_charging: { value: false, measuredAt: NOW - 300_000 } } }
          : { manualStop: true, schedule: { enabled: 'none' } }) };
    f.physical.charging = signal(false); f.physical.powerKw = signal(0);
    f.peer.vehicleEvidence.stoppedTimes = [NOW - 61_000];
    f.control.execution = null; f.peer.plan = null;
    const before = structuredClone(f.control);
    assert.equal(f.available(), true, 'Fresh native stop readback and a settled physical zero give independent evidence');
    assert.deepEqual(f.control, before, 'The manual stop remains owned by its native instruction');
    const scheduleOwner = transport === 'ocpp' ? f.control.snapshot.appControl : f.control.snapshot;
    if (transport === 'shelly-evse') scheduleOwner.nativeScheduleActive = true;
    else scheduleOwner.schedule = { enabled: 'delayed' };
    assert.equal(f.available(), false, 'An unknown future native resume cannot be treated as quiet');
    if (transport === 'shelly-evse') delete scheduleOwner.nativeScheduleActive;
    else scheduleOwner.schedule = null;
    assert.equal(f.available(), false, 'Missing native schedule evidence does not establish a quiet horizon');
    if (transport === 'shelly-evse') {
      scheduleOwner.nativeScheduleActive = false; scheduleOwner.controlReady = false;
      assert.equal(f.available(), false, 'An unavailable Shelly controller cannot establish absence of native transitions');
      scheduleOwner.controlReady = true;
    } else scheduleOwner.schedule = { enabled: 'none' };
    f.peer.vehicleEvidence.stoppedTimes = [NOW - 30_000];
    assert.equal(f.available(), false, 'A recent manual stop can still overlap BMW evidence');
    f.peer.vehicleEvidence.stoppedTimes = [NOW - 61_000];
    f.control.snapshot.readAt = NOW - 61_000;
    assert.equal(f.available(), false, 'Old stop status cannot establish current native permission');
    if (transport === 'ocpp') {
      f.control.snapshot.readAt = NOW;
      f.control.snapshot.appControl.readAt = NOW - 61_000;
      assert.equal(f.available(), false, 'Fresh local status cannot refresh an old native cloud stop');
    }
  }
});

test('unknown, offline, manual, pending or competing peer control cannot establish an isolated pause', async t => {
  const changes = {
    'unknown connection': f => { f.physical.connected.available = false; },
    'unknown power': f => { f.physical.powerKw.available = false; },
    'unknown charging': f => { f.physical.charging.available = false; },
    'stale power': f => { f.physical.powerKw.measuredAt = NOW - 61_000; },
    'future power': f => { f.physical.powerKw.measuredAt = NOW + 1; },
    'offline provider': f => { f.physical.providerConnected = false; },
    'offline charger': f => { f.control.snapshot.online = false; },
    'manual instruction': f => { f.control.manual = { kind: 'stop' }; },
    'pending command': f => { f.control.pending = { role: 'start_charging' }; },
    'fault': f => { f.control.snapshot.faulted = true; },
    'authorization blocked': f => { f.control.snapshot.authorizationBlocked = true; },
    'provisional economics': f => { f.peer.plan.provisional = true; },
    'infeasible economics': f => { f.peer.plan.feasible = false; },
    'no accepted or proposed periods': f => { f.control.execution = null; f.peer.plan = null; },
    'peer pause': f => { f.peer.identification = { phase: 'pausing' }; },
    'peer charging probe': f => { f.peer.identification = { probe: { endedAt: null } }; },
    'peer current test': f => { f.control.currentTest = { phase: 'active' }; },
    'peer current restoration': f => { f.control.currentTest = { phase: 'restoring' }; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const f = fixture(); change(f); assert.equal(f.available(), false);
  });
});

test('a confirmed disconnected or unconfigured peer does not block the only charging point', () => {
  const f = fixture();
  f.physical.connected = signal(false);
  f.physical.powerKw.available = false; f.physical.charging.available = false;
  assert.equal(f.available(), true);
  f.physical.connected.available = false;
  delete f.peer.controller;
  assert.equal(f.available(), true, 'An absent integration is not an observed alternative charger');
  f.runtime.configuration.chargers.charger2 = { enabled: true };
  assert.equal(f.available(), false, 'A configured but unreadable charger stays unknown');
});

test('Automatic off and Charge now preserve peer authority without requiring an economic plan', () => {
  for (const mode of ['off', 'charge-now']) {
    const f = fixture();
    if (mode === 'off') f.peer.controls.enabled = false;
    else f.peer.request.chargeNow = true;
    f.control.execution = null; f.peer.plan = null;
    assert.equal(f.available(), true, 'Stable independent charging does not need economic periods');
    f.control.manual = { kind: 'stop' };
    assert.equal(f.available(), false, 'Explicit manual instructions still prevent an isolated test');
    f.control.manual = null; f.control.snapshot.faulted = true;
    assert.equal(f.available(), false, 'Charging permission cannot override a device fault');
  }
});

test('a live probe keeps its original return through its own provisional forecast and release feedback', () => {
  const f = fixture(), returnStartAt = NOW + 600_000;
  f.peer.identification = { probe: { startedAt: NOW - 10_000, deadlineAt: NOW + 60_000, returnStartAt, endedAt: null } };
  f.peer.plan = { provisional: true, feasible: false, startAt: NOW - 1000, periods: [{ startAt: NOW - 1000, endAt: null }] };
  f.control.released = true;
  assert.deepEqual(f.runtime.identificationChargingChoice(f.peer, NOW), { normalCharging: false, probeReturnAt: returnStartAt });
  assert.deepEqual(f.runtime.identificationChargingChoice(f.peer, returnStartAt), { normalCharging: true },
    'The captured return still ends the temporary economic wait');
  f.peer.identification.probe.endedAt = NOW;
  assert.deepEqual(f.runtime.identificationChargingChoice(f.peer, NOW), { normalCharging: true });
});

test('Automatic off and Charge now remain independent of an active probe return', () => {
  for (const mode of ['off', 'charge-now']) {
    const f = fixture();
    f.peer.identification = { probe: { returnStartAt: NOW + 600_000, endedAt: null } };
    if (mode === 'off') f.peer.controls.enabled = false;
    else f.peer.request.chargeNow = true;
    assert.deepEqual(f.runtime.identificationChargingChoice(f.peer, NOW), { normalCharging: true });
  }
});

test('passive identification cannot override economics while bounded tests retain scoped commands', () => {
  const f = fixture();
  let minimumCurrent = false, available = true;
  Object.assign(f.runtime, { telemetry() {}, persist() {}, scheduleWakeup() {},
    identificationAvailable: () => available, identificationTurn: () => true,
    minimumCurrentIdentification: () => minimumCurrent });
  f.item.identification = { id: 'synthetic-attempt', connectedAt: NOW - 300_000, phase: 'charging', action: 'allow', probe: null };
  const control = () => f.runtime.identificationControl(f.item, { transport: 'ocpp' });
  assert.equal(control(), null, 'Ordinary charging observation has no charging permission override');
  minimumCurrent = true;
  assert.equal(control().minimumCurrent, true);
  minimumCurrent = false;
  f.item.identification.probe = { deadlineAt: NOW + 30_000, returnStartAt: NOW + 600_000, endedAt: null };
  assert.deepEqual(control(), { id: 'synthetic-attempt', connectedAt: NOW - 300_000, phase: 'charging',
    mode: 'probe', probeUntil: NOW + 30_000, returnStartAt: NOW + 600_000 });
  f.item.identification.probe.endedAt = NOW;
  assert.equal(control(), null, 'A used charging allowance cannot continue issuing allow commands');
  f.item.identification.phase = 'pausing'; f.item.identification.action = 'pause';
  f.item.identification.pauseUntil = NOW + 90_000;
  assert.equal(control().pauseUntil, NOW + 90_000, 'The single bounded pause keeps its existing restoration contract');
  available = false;
  assert.equal(control(), null, 'An unsafe or unavailable device never receives an identification command');
});
