import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, MINUTE } from './helpers/charging-joint-fixture.js';

for (const mode of ['native', 'charge-now', 'automatic'])
  test(`live Shelly priority ignores conservative forecast caps during ${mode} charging`, async t => {
    const f = await fixture(t, { budgetA: 25 });
    await f.connect('charger1'); await f.connect('charger2'); await f.priority('charger2');
    if (mode === 'charge-now') await f.runtime.chargeNow('charger2', f.scope('charger2'));
    if (mode === 'automatic') {
      await f.automatic('charger2', true); await f.plan();
      const starts = f.view('charger2').plan.periods[0].startAt;
      if (starts > f.now) f.advance(starts - f.now);
      await f.settle();
    }
    await f.plan();
    f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
    f.household.currentA = 9;
    // A forecast can reserve capacity for a secondary deadline or assume a
    // higher household scenario. It is deliberately distinct from the live
    // property/peer/meter inputs above.
    f.runtime.coordination.allocations = [{ start: f.now, end: f.now + MINUTE,
      chargers: { charger1: { currentA: 8 }, charger2: { currentA: 8, currentLimitA: 8 } } }];
    f.advance(5000);
    await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.current_limit.value, 16);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.currentA, 16);
    assert.equal(f.runtime.allocationContext().allocationA, null);
    assert.equal(f.runtime.allocationContext().reservationA, 0);
  });

for (const chargeNow of [false, true])
  test(`directional priority changes real current allocation with Automatic off and Charge now ${chargeNow}`, async t => {
    const f = await fixture(t);
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
    if (chargeNow) await f.runtime.chargeNow('charger2', f.scope('charger2'));
    await f.priority('charger1'); await f.plan();
    assert.equal(f.fields.start_charging.value, false);
    assert.equal(f.view('charger1').values.actualCurrentA.value, 16);
    await f.priority('charger2'); await f.plan();
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.fields.current_limit.value, 16);
    assert.equal(f.view('charger1').values.actualCurrentA.value, 0, 'Native Equalizer yields the peer current');
    assert.equal(f.view('charger2').request.chargeNow === true, chargeNow);
  });

test('balanced live allocation resumes a priority-owned native pause without enabling Automatic', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.priority('charger1'); await f.plan();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.view('charger2').control.ownedPause, true);
  const stoppedAt = f.now;
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.fields.start_charging.value, true);
  assert.deepEqual(f.runtime.allocationContext().easee.currents, [8, 8, 8], 'Fresh source phases confirm Equalizer recovery');
  assert.equal(f.view('charger2').settings.enabled, false);
  assert.ok(f.commands.some(row => row.role === 'start_charging' && row.value === true && row.at > stoppedAt));
  f.advance(5000); f.fields.start_charging = { value: false, at: f.now, source: 'rpc' };
  await f.settle();
  await f.priority('charger1'); f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.start_charging.value, false, 'A later native Stop revokes the previous owned resume duty');
  assert.equal(f.view('charger2').control.manual.kind, 'stop');
});

test('balanced live allocation lets a confirmed open peer recover from zero Equalizer allowance', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.priority('charger2'); await f.plan();
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.view('charger1').values.actualCurrentA.value, 0);
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.fields.start_charging.value, true);
  assert.deepEqual(f.runtime.allocationContext().easee.currents, [8, 8, 8]);
  assert.equal(f.view('charger1').request.chargeNow, true);
});

test('balanced live allocation holds the selected planner turn below two valid pilots', async t => {
  const f = await fixture(t, { budgetA: 11 });
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.priority('charger2'); await f.plan();
  assert.equal(f.fields.current_limit.value, 11);
  f.advance(5000); await f.priority('balanced');
  const commands = f.commands.length, selectedStart = f.fields.start_charging.value;
  const selectedCurrent = f.view('charger2').control.limiter.currentA;
  for (let sample = 0; sample < 3; sample++) {
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.start_charging.value, selectedStart);
    assert.equal(f.view('charger2').control.limiter.currentA, selectedCurrent);
    assert.ok([0, 11].includes(selectedCurrent));
  }
  assert.equal(f.commands.slice(commands).some(row => row.role === 'start_charging'), false);
});

test('balanced live allocation preserves an open peer entitlement while its actual draw is zero', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
  await f.priority('charger2'); await f.plan();
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.runtime.allocationContext().allocateCurrent([16, 16, 16]).reservationA, 8);
  assert.equal(f.fields.current_limit.value, 8);
  assert.equal(f.fields.start_charging.value, true);
});

for (const feedsSynchronized of [false, true])
  test(`unscheduled Charger 1 priority respects its planned share despite zero measured peer draw; synchronized feeds ${feedsSynchronized}`, async t => {
    const f = await fixture(t, { budgetA: 25, feedsSynchronized });
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
    await f.runtime.chargeNow('charger2', f.scope('charger2'));
    await f.priority('charger1'); await f.plan();
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    const entitlement = f.runtime.allocationContext().allocateCurrent([25, 25, 25]);
    assert.equal(entitlement.reservationA, 16);
    assert.equal(entitlement.allocationA, 9);
    assert.equal(f.fields.current_limit.value, feedsSynchronized ? 9 : 12);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.fallback, !feedsSynchronized);
  });

for (const priority of ['balanced', 'charger1', 'charger2'])
  test(`live ${priority} entitlement does not follow a delayed Equalizer or the peer current`, async t => {
    const f = await fixture(t, { budgetA: 24 });
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
    await f.priority(priority); await f.plan();
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    const allocated = f.view('charger2').control.limiter.currentA;
    assert.ok(allocated >= 6);
    // Equalizer has enough controllable C1 current to remove this excess.
    // Its failure to respond must not start a competing Shelly control loop.
    f.cars.charger1.equalizerResponds = false;
    for (const peerCurrent of [16, 0, 16, 6, 16]) {
      f.cars.charger1.demandA = peerCurrent;
      f.advance(31_000);
      await f.settle();
      await f.plan();
      assert.equal(f.view('charger2').control.limiter.currentA, allocated);
      assert.equal(f.fields.current_limit.value, allocated);
      assert.equal(f.fields.start_charging.value, true);
      assert.equal(f.view('charger2').control.limiter.fallback, false);
    }
  });

for (const forecast of [false, true])
test(`live household headroom controls sharing with forecast slice ${forecast}`, async t => {
  const f = await fixture(t, { budgetA: 24 });
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  f.household.currentA = 8;
  // A missing plan or a forecast with less household load cannot reserve half
  // the gross 24 A budget. The actual 16 A remainder gives each request 8 A.
  t.mock.method(f.runtime, 'updatePlan', async () => {});
  f.runtime.coordination = forecast ? { priority: 'balanced', allocations: [{ start: f.now, end: f.now + MINUTE,
    chargers: { charger1: { currentA: 12 }, charger2: { currentA: 12, currentLimitA: 12 } } }] } : null;
  for (const current of [16, 0, 16]) {
    f.cars.charger1.demandA = current;
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.current_limit.value, 8);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.currentA, 8);
    assert.equal(f.view('charger2').control.limiter.fallback, false);
  }
});

test('single-pilot entitlement holds through progress without renewing its original deadline', async t => {
  const f = await fixture(t, { budgetA: 8 });
  await f.connect('charger1'); await f.connect('charger2');
  const remaining = { charger1: 4.14, charger2: 4.14 };
  const views = f.runtime.views.bind(f.runtime);
  t.mock.method(f.runtime, 'views', (...args) => views(...args).map(charger => ({ ...charger,
    requiredGridKwh: remaining[charger.id], referenceGridKwh: 4.14,
    sessionCost: { ...charger.sessionCost, recordedGridKwh: 4.14 - remaining[charger.id] } })));
  f.runtime.currentAllocationHold = null;
  const initial = f.runtime.allocationContext().allocateCurrent([8, 8, 8]);
  const winner = initial.allocationA === 8 ? 'charger2' : 'charger1';
  const other = winner === 'charger2' ? 'charger1' : 'charger2';
  const original = { ...f.runtime.currentAllocationHold };
  assert.equal(original.chargerId, winner);
  assert.equal(original.end - original.startedAt, 15 * MINUTE);
  remaining[winner] -= .1;
  for (let sample = 0; sample < 2; sample++) {
    f.advance(30_000); await f.settle();
    const selected = f.runtime.allocationContext().allocateCurrent([8, 8, 8]);
    assert.equal(selected.allocationA === 8 ? 'charger2' : 'charger1', winner);
    assert.equal(f.runtime.currentAllocationHold.end, original.end, 'Metered progress cannot extend the selected turn');
  }
  f.advance(original.end - f.now + 1); await f.settle();
  f.runtime.allocationContext().allocateCurrent([8, 8, 8]);
  assert.equal(f.runtime.currentAllocationHold.chargerId, other, 'The next turn reflects accepted delivery progress');
  await f.priority('charger1');
  f.runtime.allocationContext();
  assert.equal(f.runtime.currentAllocationHold, null, 'An explicit priority change releases the balanced hold');
});
