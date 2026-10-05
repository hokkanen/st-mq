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

test('balanced live allocation retains a running turn below two valid pilots', async t => {
  const f = await fixture(t, { budgetA: 11 });
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 16; f.cars.charger2.demandA = 16;
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.priority('charger2'); await f.plan();
  assert.equal(f.fields.current_limit.value, 11);
  f.advance(5000); await f.priority('balanced');
  const commands = f.commands.length;
  for (let sample = 0; sample < 3; sample++) {
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.fields.current_limit.value, 11);
    assert.equal(f.fields.start_charging.value, true);
    assert.deepEqual(f.runtime.allocationContext().easee.currents, [0, 0, 0]);
  }
  assert.equal(f.commands.slice(commands).some(row => row.role === 'start_charging'), false);
});

test('balanced live allocation does not reserve an idle peer merely because it is connected', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
  await f.priority('charger2'); await f.plan();
  f.advance(5000); await f.priority('balanced');
  assert.equal(f.runtime.allocationContext().peerDemandA, null);
  assert.equal(f.fields.current_limit.value, 16);
  assert.equal(f.fields.start_charging.value, true);
});

for (const feedsSynchronized of [false, true])
  test(`unscheduled Charger 1 priority ignores an economic cap with no peer demand; synchronized feeds ${feedsSynchronized}`, async t => {
    const f = await fixture(t, { budgetA: 25, feedsSynchronized });
    await f.connect('charger1'); await f.connect('charger2');
    f.cars.charger1.demandA = 0; f.cars.charger2.demandA = 16;
    await f.runtime.chargeNow('charger2', f.scope('charger2'));
    await f.priority('charger1'); await f.plan();
    f.runtime.coordination.allocations = [{ start: f.now, end: f.now + MINUTE,
      chargers: { charger2: { currentA: 7, currentLimitA: 7 } } }];
    f.advance(5000); await f.runtime.reconcileShellyObservation();
    assert.equal(f.runtime.allocationContext().peerDemandA, null);
    assert.equal(f.fields.current_limit.value, feedsSynchronized ? 16 : 12);
    assert.equal(f.fields.start_charging.value, true);
    assert.equal(f.view('charger2').control.limiter.fallback, !feedsSynchronized);
  });
