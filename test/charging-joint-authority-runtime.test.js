import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

test('Shelly retains an intermediate open period, follows its pause, and releases the final period', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger2');
  const adapter = f.runtime.chargers.charger2.adapter;
  await f.runtime.close(); // Transfer this offline device to one test controller.
  const controller = adapter.createController({ clock: () => f.now, canControl: () => true });
  t.after(() => controller.close());
  const beginning = f.now;
  const plan = { id: 'synthetic-multiple-periods', deadlineAt: beginning + 2 * HOUR, feasible: true,
    periods: [{ startAt: beginning, endAt: beginning + 15 * MINUTE }, { startAt: beginning + HOUR, endAt: null }] };
  await controller.update({ enabled: true, plan });
  assert.equal(controller.status().phase, 'active');
  assert.equal(controller.status().released, false, 'An intermediate period does not discard its planned pause');
  assert.deepEqual(controller.status().execution.periods, plan.periods);
  f.advance(15 * MINUTE); await controller.update({ enabled: true, plan });
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(controller.status().phase, 'waiting');
  f.advance(HOUR); await controller.update({ enabled: true, plan });
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(controller.status().phase, 'released');
  assert.equal(controller.status().released, true);
});

test('a fractional current-allocation handoff still schedules an immediate boundary wakeup', async t => {
  const f = await fixture(t);
  const end = f.now + 15 * MINUTE + .125;
  // Exercise the timer interface with the continuous-time completion boundary
  // emitted by the allocator, independently of its schedule-search choices.
  f.runtime.coordination = { allocations: [{ start: f.now, end, chargers: {} }] };
  f.runtime.scheduleWakeup(f.now);
  assert.equal(f.runtime.boundaryAt, Math.ceil(end));
});

test('a native Charger 2 timer retains authority during peer priority and Charge now changes', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  f.advance(1000); f.schedules.jobs = [{ id: 1, enable: true, timespec: '0 0 4 * * *', calls: [] }];
  await f.settle();
  const baseline = f.commands.length;
  await f.priority('charger2');
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  assert.equal(f.view('charger2').control.snapshot.nativeScheduleActive, true);
  assert.ok(['schedule', 'native-schedule'].includes(f.view('charger2').control.manual?.kind));
  assert.equal(f.view('charger2').control.execution, null, 'Native takeover withdraws the old application execution');
  assert.equal(f.commands.slice(baseline).filter(command => command.chargerId === 'charger2'
    && command.role === 'start_charging' && command.value === true).length, 0, 'Peer changes never bypass the native timer');
});

test('independent BMW evidence and a verified Tesla minimum-current response retain both identities through overlapping charging and unplug', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger1');
  f.bmw({ atHome: true, pluggedIn: true, charging: true, soc: 20, chargeLimitSoc: 80, usableCapacityKwh: 10 });
  await f.settle();
  f.advance(2000); f.cars.charger1.allows = false; await f.settle();
  f.advance(2000); f.bmw({ charging: false }); await f.settle();
  assert.equal(f.view('charger1').vehicle.id, 'bmw');
  const bmwRequest = structuredClone(f.view('charger1').request);

  f.advance(1000); f.cars.charger1.allows = true; await f.settle();
  f.bmw({ charging: true }); await f.settle();
  f.advance(3 * MINUTE); await f.connect('charger2');
  f.tesla({ charger_actual_current: 8, charger_phases: 3 }); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, null, 'Similar power and start timing cannot identify the second connected car');
  assert.equal(f.fields.current_limit.value, 6, 'The scoped comparison uses the verified minimum with economic limiting disabled');
  f.advance(6000); f.tesla({ charger_actual_current: 6, charger_phases: 3 }); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, null, 'A first current sample must settle and remain consistent');
  f.advance(6000); await f.settle();
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.equal(f.fields.current_limit.value, 16, 'Identification restores the previous native current setting');
  const teslaRequest = structuredClone(f.view('charger2').request);
  assert.equal(f.view('charger1').vehicle.id, 'bmw');
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.equal(f.view('charger1').values.charging.value, true);
  assert.equal(f.view('charger2').values.charging.value, true);
  assert.deepEqual(f.view('charger1').request, bmwRequest);
  assert.deepEqual(f.view('charger2').request, teslaRequest);

  await f.disconnect('charger1');
  assert.equal(f.view('charger1').vehicle.state, 'disconnected');
  assert.equal(f.view('charger1').request, null);
  assert.equal(f.view('charger2').vehicle.id, 'tesla');
  assert.deepEqual(f.view('charger2').request, teslaRequest);
});

test('simultaneous indistinguishable power cannot assign one Tesla to either physical charger', async t => {
  const f = await fixture(t, { limiter: false });
  await f.connect('charger1'); await f.connect('charger2'); f.tesla(); await f.settle();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).vehicle.state, 'identifying');
    assert.equal(f.view(id).vehicle.id, null);
    assert.equal(f.runtime.chargers[id].vehicleConflict, null, 'Weak coincident power does not manufacture a saved identity conflict');
    assert.equal(f.view(id).values.connected.value, true, 'Ambiguous identity does not erase the real connection');
  }
});
