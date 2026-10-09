import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const signal = value => ({ value, available: true, measuredAt: NOW - 1000 });

function fixture(chargerId = 'charger1') {
  const peerId = chargerId === 'charger1' ? 'charger2' : 'charger1';
  const control = { snapshot: { online: true }, execution: { periods: [{ startAt: NOW - 300_000, endAt: NOW + 600_000 }] } };
  const item = { definition: { id: chargerId }, controls: { enabled: true } };
  const peer = { definition: { id: peerId }, controller: { status: () => control },
    controls: { enabled: true }, request: {}, plan: { feasible: true, periods: control.execution.periods },
    vehicleEvidence: { chargingTimes: [NOW - 300_000], stoppedTimes: [] } };
  const physical = { providerConnected: true, connected: signal(true), charging: signal(true), powerKw: signal(11) };
  const runtime = Object.assign(Object.create(ChargingRuntime.prototype), {
    chargers: { [chargerId]: item, [peerId]: peer }, configuration: { chargers: {} }, config: {}, clock: () => NOW,
  });
  return { runtime, item, peer, control, physical,
    available: () => runtime.identificationPauseAvailable(item, { [peerId]: physical }, NOW) };
}

function offlinePeerFixture(chargerId) {
  const f = fixture(chargerId);
  f.control.snapshot.online = false;
  f.physical.providerConnected = false;
  for (const key of ['connected', 'charging', 'powerKw'])
    f.physical[key] = { value: null, available: false, measuredAt: NOW - 600_000 };
  return f;
}

function idlePeerFixture(transport = 'shelly-evse') {
  const f = fixture();
  const permission = { controlKnown: true, enabled: true, stopped: false,
    faulted: false, authorizationBlocked: false, schedule: { enabled: 'none' } };
  f.control.snapshot = { online: true, transport, readAt: NOW,
    ...(transport === 'ocpp' ? { appControl: { ...permission, readAt: NOW } }
      : transport === 'shelly-evse' ? { nativeScheduleActive: false, controlReady: true,
        fields: { start_charging: { value: true, measuredAt: NOW - 300_000 } } }
        : { ...permission, manualStop: false }) };
  f.physical.charging = signal(false); f.physical.powerKw = signal(0);
  f.peer.vehicleEvidence.stoppedTimes = [NOW - 61_000];
  return f;
}

test('a settled connected car drawing zero does not block the other charger despite permission to charge', () => {
  for (const transport of ['ocpp', 'shelly-evse', 'easee-cloud']) {
    const f = idlePeerFixture(transport);
    const before = structuredClone({ control: f.control, plan: f.peer.plan, evidence: f.peer.vehicleEvidence });
    assert.equal(f.available(), true, `${transport} can confirm an idle peer without knowing its battery state`);
    assert.deepEqual({ control: f.control, plan: f.peer.plan, evidence: f.peer.vehicleEvidence }, before,
      'A quiet-peer check does not change permission, economics or vehicle evidence');
    f.peer.controls.enabled = false;
    assert.equal(f.available(), true, 'Automatic off remains independent of physical idle evidence');
    f.peer.controls.enabled = true; f.peer.request.chargeNow = true;
    assert.equal(f.available(), true, 'Charge now does not require the vehicle to accept energy');
  }
});

test('an allowed idle peer needs fresh native permission and absence of native schedules', async t => {
  for (const transport of ['ocpp', 'shelly-evse', 'easee-cloud']) {
    const changes = {
      'missing readback clock': f => { delete f.control.snapshot.readAt; },
      'stale readback': f => { f.control.snapshot.readAt = NOW - 61_000; },
      'future readback': f => { f.control.snapshot.readAt = NOW + 1; },
      'active native schedule': f => {
        if (transport === 'shelly-evse') f.control.snapshot.nativeScheduleActive = true;
        else (f.control.snapshot.appControl ?? f.control.snapshot).schedule.enabled = 'delayed';
      },
      'missing native schedule': f => {
        if (transport === 'shelly-evse') delete f.control.snapshot.nativeScheduleActive;
        else delete (f.control.snapshot.appControl ?? f.control.snapshot).schedule;
      },
      'missing native permission': f => {
        if (transport === 'shelly-evse') delete f.control.snapshot.fields.start_charging;
        else delete (f.control.snapshot.appControl ?? f.control.snapshot).enabled;
      },
      'native permission denied': f => {
        if (transport === 'shelly-evse') f.control.snapshot.fields.start_charging.value = false;
        else (f.control.snapshot.appControl ?? f.control.snapshot).enabled = false;
      },
      ...(transport === 'shelly-evse' ? {
        'controller not ready': f => { f.control.snapshot.controlReady = false; },
        'missing permission clock': f => { delete f.control.snapshot.fields.start_charging.measuredAt; },
        'future permission clock': f => { f.control.snapshot.fields.start_charging.measuredAt = NOW + 1; },
      } : {
        'unknown native control': f => { (f.control.snapshot.appControl ?? f.control.snapshot).controlKnown = false; },
        'unknown native stop': f => { delete (f.control.snapshot.appControl ?? f.control.snapshot).stopped; },
        'native stop': f => { (f.control.snapshot.appControl ?? f.control.snapshot).stopped = true; },
      }),
      ...(transport === 'ocpp' ? {
        'local zero profile remains': f => { f.control.owned = { action: 'pause', confirmedAt: NOW - 1000 }; },
        'local instruction remains owned': f => { f.control.ownsInstruction = true; },
        'missing native readback clock': f => { delete f.control.snapshot.appControl.readAt; },
        'stale native readback': f => { f.control.snapshot.appControl.readAt = NOW - 61_000; },
        'future native readback': f => { f.control.snapshot.appControl.readAt = NOW + 1; },
        'native fault': f => { f.control.snapshot.appControl.faulted = true; },
        'native authorization blocked': f => { f.control.snapshot.appControl.authorizationBlocked = true; },
      } : {}),
    };
    for (const [name, change] of Object.entries(changes)) await t.test(`${transport}: ${name}`, () => {
      const f = idlePeerFixture(transport); change(f);
      assert.equal(f.available(), false, 'Idle draw alone cannot establish a quiet native-control horizon');
    });
  }
});

test('a quiet full-car permission hold permits peer identification without releasing the hold', () => {
  const f = idlePeerFixture();
  f.control.devicePermissionHeld = true;
  f.control.snapshot.fields.start_charging.value = false;
  const before = structuredClone(f.control);
  assert.equal(f.available(), true, 'A confirmed device Stop with settled zero remains quiet during an allowed period');
  assert.deepEqual(f.control, before, 'Identification does not resume the peer or change a system hold into a manual instruction');
  f.control.devicePermissionHeld = false;
  assert.equal(f.available(), false, 'An unresolved ordinary permission mismatch still blocks');
  f.control.devicePermissionHeld = true;
  f.control.snapshot.fields.start_charging.value = true;
  assert.equal(f.available(), false, 'Contradictory permission cannot establish a quiet held peer');
  delete f.control.snapshot.fields.start_charging;
  assert.equal(f.available(), false, 'A saved hold alone cannot replace current native Stop evidence');
});

test('expired untouched preparation yields while dispatched or unresolved current work retains exclusivity', () => {
  const f = idlePeerFixture();
  f.peer.controller.supportsIdentification = true;
  f.runtime.minimumCurrentIdentification = () => false;
  f.control.currentTest = { phase: 'proposed', startedAt: NOW - 120_000, expiresAt: NOW - 30_000, pending: null };
  const original = structuredClone(f.control.currentTest);
  assert.equal(f.runtime.identificationTurn(f.item), true);
  assert.equal(f.available(), true);
  assert.deepEqual(f.control.currentTest, original, 'Yielding the turn does not forge restoration or change saved attempt limits');
  for (const phase of ['applying', 'active', 'restoring', 'uncertain']) {
    f.control.currentTest.phase = phase;
    assert.equal(f.runtime.identificationTurn(f.item), false, `${phase} retains its physical duty after expiry`);
    assert.equal(f.available(), false);
  }
  f.control.currentTest.phase = 'proposed'; f.control.currentTest.pending = { value: 6 };
  assert.equal(f.runtime.identificationTurn(f.item), false, 'A pending write cannot be treated as untouched preparation');
  f.control.currentTest.pending = null; f.control.currentTest.expiresAt = NOW + 1000;
  assert.equal(f.runtime.identificationTurn(f.item), false, 'Unexpired preparation still owns the slot');
});

test('idle peer admission still waits for physical settling and approaching economic transitions', async t => {
  const changes = {
    'recent stop': f => { f.peer.vehicleEvidence.stoppedTimes = [NOW - 30_000]; },
    'recent start': f => { f.peer.vehicleEvidence.chargingTimes = [NOW - 30_000]; },
    'approaching stop': f => { f.control.execution.periods[0].endAt = NOW + 90_000; },
    'approaching start': f => { f.control.execution.periods = [{ startAt: NOW + 90_000, endAt: NOW + 600_000 }]; },
    'pending start': f => { f.control.pending = { role: 'start_charging', value: true }; },
    'pending stop': f => { f.control.pending = { role: 'start_charging', value: false }; },
    'peer current test': f => { f.control.currentTest = { phase: 'active' }; },
    'peer current restoration': f => { f.control.currentTest = { phase: 'restoring' }; },
    'positive power below charging threshold': f => { f.physical.powerKw = signal(.2); },
    'charging-state contradiction': f => { f.physical.charging = signal(true); },
    'power-state contradiction': f => { f.physical.powerKw = signal(11); },
    'stale physical zero': f => { f.physical.powerKw.measuredAt = NOW - 61_000; },
    'charging while disallowed': f => {
      f.physical.charging = signal(true); f.physical.powerKw = signal(11);
      f.control.execution.periods = [{ startAt: NOW + 600_000, endAt: NOW + 1_200_000 }];
    },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const f = idlePeerFixture(); change(f); assert.equal(f.available(), false);
  });
  const f = idlePeerFixture();
  f.control.execution.periods[0].endAt = NOW + 121_000;
  assert.equal(f.available(), true, 'A settled idle peer does not need to block beyond the observation horizon');
});

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

test('unknown, inconsistent, manual, pending or competing online peer control cannot establish an isolated pause', async t => {
  const changes = {
    'unknown connection': f => { f.physical.connected.available = false; },
    'unknown power': f => { f.physical.powerKw.available = false; },
    'unknown charging': f => { f.physical.charging.available = false; },
    'stale power': f => { f.physical.powerKw.measuredAt = NOW - 61_000; },
    'future power': f => { f.physical.powerKw.measuredAt = NOW + 1; },
    'offline provider': f => { f.physical.providerConnected = false; },
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

test('either charger may admit one identification pause with an explicitly unreachable peer and no known competing transition', () => {
  for (const chargerId of ['charger1', 'charger2']) {
    const f = offlinePeerFixture(chargerId);
    f.control.execution = null; f.peer.plan = null;
    f.control.manual = { kind: 'stop' };
    const before = structuredClone({ control: f.control, physical: f.physical, evidence: f.peer.vehicleEvidence });
    assert.equal(f.available(), true, `${chargerId}: offline peer evidence need not prove an unplugged or stopped car`);
    assert.equal(f.runtime.identificationPauseAvailable(f.item, {}, NOW), true,
      'Explicit offline status also admits a peer with no physical readings');
    assert.deepEqual({ control: f.control, physical: f.physical, evidence: f.peer.vehicleEvidence }, before,
      'Admission neither invents peer observations nor changes its native instructions');
    assert.equal(f.peer.vehicleMatch, undefined, 'Admission alone does not assign a vehicle to either charger');
    assert.equal(f.item.vehicleMatch, undefined);
  }
});

test('an offline peer still blocks a competing action, known source edge or imminent schedule boundary', async t => {
  const changes = {
    'backend transition': f => { f.peer.backendTransition = true; },
    'pending start': f => { f.control.pending = { role: 'start_charging', value: true }; },
    'pending stop': f => { f.control.pending = { role: 'start_charging', value: false }; },
    'pending takeover': f => { f.control.takeoverPending = { requestedAt: NOW - 1000 }; },
    'identification pause': f => { f.peer.identification = { phase: 'pausing' }; },
    'identification probe': f => { f.peer.identification = { phase: 'charging', probe: { endedAt: null } }; },
    'owned identification instruction': f => { f.control.owned = { purpose: 'identification', startAt: NOW + 600_000 }; },
    'current test applying': f => { f.control.currentTest = { phase: 'applying' }; },
    'current test active': f => { f.control.currentTest = { phase: 'active' }; },
    'current test restoring': f => { f.control.currentTest = { phase: 'restoring', expiresAt: NOW - 1000 }; },
    'current test uncertain': f => { f.control.currentTest = { phase: 'uncertain', expiresAt: NOW - 1000 }; },
    'pending current preparation': f => {
      f.control.currentTest = { phase: 'proposed', expiresAt: NOW - 1000, pending: { value: 6 } };
    },
    'recent charging edge': f => { f.peer.vehicleEvidence.chargingTimes = [NOW - 1000]; },
    'recent stop edge': f => { f.peer.vehicleEvidence.stoppedTimes = [NOW - 59_999]; },
    'recent stream charging edge': f => { f.peer.streamEvidence = { chargingTimes: [NOW - 1000], stoppedTimes: [] }; },
    'recent stream stop edge': f => { f.peer.streamEvidence = { chargingTimes: [], stoppedTimes: [NOW - 59_999] }; },
    'Shelly native schedule': f => { Object.assign(f.control.snapshot, { transport: 'shelly-evse', nativeScheduleActive: true }); },
    'OCPP known native schedule': f => { Object.assign(f.control.snapshot, { transport: 'ocpp', appControl: { schedule: { enabled: 'delayed' } } }); },
    'cloud native schedule': f => { Object.assign(f.control.snapshot, { transport: 'easee-cloud', schedule: { enabled: 'weekly' } }); },
    'accepted stop inside pause': f => { f.control.execution.periods[0].endAt = NOW + 30_000; },
    'accepted stop at correlation boundary': f => { f.control.execution.periods[0].endAt = NOW + 120_000; },
    'accepted start at correlation boundary': f => { f.control.execution.periods = [{ startAt: NOW + 120_000, endAt: null }]; },
    'owned start at correlation boundary': f => { f.control.owned = { purpose: 'schedule', startAt: NOW + 120_000 }; },
    'accepted stop just passed': f => { f.control.execution.periods[0].endAt = NOW - 1000; },
    'accepted start just passed': f => { f.control.execution.periods = [{ startAt: NOW - 59_999, endAt: null }]; },
    'owned start just passed': f => { f.control.owned = { purpose: 'schedule', startAt: NOW - 1000 }; },
    'accepted stop at current instant': f => { f.control.execution.periods[0].endAt = NOW; },
    'accepted start at current instant': f => { f.control.execution.periods = [{ startAt: NOW, endAt: null }]; },
    'owned start at current instant': f => { f.control.owned = { purpose: 'schedule', startAt: NOW }; },
  };
  for (const chargerId of ['charger1', 'charger2']) for (const [name, change] of Object.entries(changes))
    await t.test(`${chargerId}: ${name}`, () => {
      const f = offlinePeerFixture(chargerId); change(f);
      assert.equal(f.available(), false, 'Losing communication cannot erase a known competing transition or restoration duty');
    });
});

test('offline admission preserves existing settling, completed-work and observation-horizon bounds', () => {
  for (const chargerId of ['charger1', 'charger2']) {
    const f = offlinePeerFixture(chargerId);
    f.peer.vehicleEvidence = { chargingTimes: [NOW - 60_000], stoppedTimes: [NOW - 61_000] };
    f.peer.streamEvidence = { chargingTimes: [NOW - 60_000], stoppedTimes: [NOW - 61_000] };
    f.peer.identification = { phase: 'complete', probe: { endedAt: NOW - 60_000 } };
    f.control.currentTest = { phase: 'proposed', expiresAt: NOW - 1000, pending: null };
    f.control.execution.periods[0].endAt = NOW + 120_001;
    f.control.owned = { purpose: 'schedule', startAt: NOW - 60_000 };
    assert.equal(f.available(), true, `${chargerId}: old settled evidence and untouched expired preparation do not reserve a pause`);
  }
});

test('unavailable measurements or a malformed online state cannot claim the explicit offline exception', async t => {
  const changes = {
    'missing online state': f => { delete f.control.snapshot.online; },
    'unknown online state': f => { f.control.snapshot.online = null; },
    'string offline state': f => { f.control.snapshot.online = 'false'; },
    'numeric offline state': f => { f.control.snapshot.online = 0; },
    'online with unavailable physical evidence': f => { f.control.snapshot.online = true; },
    'missing snapshot': f => { delete f.control.snapshot; },
    'missing controller': f => {
      delete f.peer.controller;
      f.runtime.configuration.chargers[f.peer.definition.id] = { enabled: true };
    },
  };
  for (const chargerId of ['charger1', 'charger2']) for (const [name, change] of Object.entries(changes))
    await t.test(`${chargerId}: ${name}`, () => {
      const f = offlinePeerFixture(chargerId); change(f); assert.equal(f.available(), false);
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

test('a retained probe return is bounded by connection, original time and deliberate supersession', () => {
  const f = fixture(), connectedAt = NOW - 300_000, returnStartAt = NOW + 600_000;
  f.peer.identification = { id: 'synthetic-return', connectedAt, phase: 'inconclusive', lastAt: NOW,
    probe: { startedAt: NOW - 100_000, deadlineAt: NOW - 20_000, returnStartAt, endedAt: NOW - 10_000 } };
  f.peer.request = { scope: `synthetic:${connectedAt}`, deadlineAt: returnStartAt + 600_000 };
  f.control.session = { connected: true, connectedAt };
  const proposed = { id: 'synthetic-shortfall', feasible: false, provisional: true, startAt: NOW,
    periods: [{ startAt: NOW, endAt: null }] };
  const retained = f.runtime.controlPlan(f.peer, proposed, NOW);
  assert.equal(retained.startAt, returnStartAt);
  assert.equal(f.runtime.controlPlan(f.peer, null, NOW).startAt, returnStartAt, 'Restart before prices arrive still owes the captured return');
  assert.equal(f.runtime.controlPlan(f.peer, proposed, returnStartAt), proposed);
  f.control.session.connectedAt++;
  assert.equal(f.runtime.controlPlan(f.peer, proposed, NOW), proposed, 'A new physical connection inherits no old return');
  f.control.session.connectedAt = connectedAt;
  f.control.manual = { kind: 'charge-now' };
  assert.equal(f.runtime.controlPlan(f.peer, proposed, NOW), proposed, 'A newer native instruction retains priority');
  f.control.manual = null;
  f.runtime.supersedeProbeReturn(f.peer, NOW);
  assert.equal(f.peer.identification.probe.returnSupersededAt, NOW);
  assert.equal(f.runtime.controlPlan(f.peer, proposed, NOW), proposed);
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
  const control = () => f.runtime.identificationState(f.item, { transport: 'ocpp' });
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
