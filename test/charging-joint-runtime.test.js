import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyController } from '../src/charging/shelly-evse.js';
import { chargerDisplay } from '../chart/charging.js';
import { fixture, START, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

test('Shelly startup validates adopted execution before reading or writing device state', async () => {
  const effects = [];
  const adapter = { association: 'synthetic-execution-association',
    snapshot: () => effects.push('snapshot'), refresh: () => effects.push('refresh'),
    rpc: () => effects.push('command') };
  const execution = { planId: 'synthetic-execution-plan',
    periods: [{ startAt: START, endAt: START + MINUTE }, { startAt: START + HOUR, endAt: null }],
    finalStartAt: START + HOUR, deadlineAt: START + 2 * HOUR };
  const create = value => createShellyController({ adapter,
    initialState: { version: 1, association: adapter.association, execution: value },
    saveState: () => effects.push('save') });
  for (const [label, invalid] of [
    ['unknown execution field', { ...execution, oldPlan: true }],
    ['missing deadline', { planId: execution.planId, periods: execution.periods, finalStartAt: execution.finalStartAt }],
    ['invalid plan ID', { ...execution, planId: 3 }],
    ['incorrect final start', { ...execution, finalStartAt: START }],
    ['overlapping periods', { ...execution, periods: [{ startAt: START, endAt: START + HOUR + MINUTE }, execution.periods[1]] }],
    ['reversed periods', { ...execution, periods: [...execution.periods].reverse() }],
    ['unknown period field', { ...execution, periods: [{ ...execution.periods[0], currentA: 8 }, execution.periods[1]] }],
    ['noninteger timestamp', { ...execution, periods: [{ startAt: START + .5, endAt: START + MINUTE }, execution.periods[1]] }],
    ['no final release', { ...execution, periods: [{ startAt: START, endAt: START + MINUTE }] }],
  ]) assert.throws(() => create(invalid), { code: 'unsupported-shelly-ownership' }, label);
  assert.deepEqual(effects, [], 'Rejected durable state must not reach device reads, commands or persistence');

  const reordered = { deadlineAt: execution.deadlineAt, finalStartAt: execution.finalStartAt,
    periods: execution.periods.map(({ startAt, endAt }) => ({ endAt, startAt })), planId: execution.planId };
  for (const valid of [execution, reordered, null, undefined]) await create(valid).close();
  assert.deepEqual(effects, [], 'Current records are accepted independently of JSON property insertion order');
});

test('Shelly schedules, takes over and starts with no TeslaMate or BMW evidence', async t => {
  const f = await fixture(t);
  await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
  let view = f.view('charger2');
  assert.equal(view.vehicle.id, null);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, false);
  assert.equal(view.control.reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false);
  assert.ok(view.plan.periods.length > 0);
  assert.ok(chargerDisplay(view, { now: f.now }).periodRows.length > 0, 'Missing vehicle feeds must not hide the plan');
  f.advance(1000);
  f.fields.start_charging = { value: false, at: f.now };
  await f.settle();
  view = f.view('charger2');
  assert.equal(view.control.manual.kind, 'stop');
  await f.runtime.useAutomatic('charger2', { ...f.scope('charger2'), controlRevision: view.controls.revision,
    takeoverToken: view.control.takeover.token });
  view = f.view('charger2');
  assert.equal(view.control.manual, null);
  assert.equal(view.control.reason, 'economic-wait');
  assert.equal(view.vehicle.id, null);
  f.advance(view.plan.periods[0].startAt - f.now);
  await f.settle();
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(f.view('charger2').vehicle.id, null, 'Charging permission must not fabricate a vehicle match');
});

test('editing a request updates the other charger through the real OCPP and Shelly controllers', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  assert.equal(f.view('charger1').plan.state, 'waiting'); assert.equal(f.view('charger2').plan.state, 'waiting');
  const peerBefore = f.reads.charger2, previous = structuredClone(f.view('charger2').plan.periods);
  await f.edit('charger1', { capacityKwh: 25, readyBy: '04:00' });
  assert.notDeepEqual(f.view('charger2').plan.periods, previous, 'The changed shared demand moves the peer schedule');
  assert.ok(f.reads.charger2 > peerBefore, 'The edited joint plan must reach the peer controller before the action finishes');
  assert.equal(f.view('charger2').control.reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false);
});

test('prices arriving after both connections still install the first automatic programs', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true);
  await f.connect('charger1'); await f.connect('charger2');
  await f.plan();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).plan?.state, 'waiting', `${id} must adopt its first plan after prices arrive`);
    assert.equal(f.view(id).plan?.feasible, true);
  }
  assert.equal(f.fields.start_charging.value, false);
});

test('Charge now and Automatic edits refresh peer control without changing its session request', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const request = structuredClone(f.view('charger2').request);
  for (const action of [() => f.runtime.chargeNow('charger1', f.scope('charger1')),
    () => f.automatic('charger1', false), () => f.automatic('charger1', true)]) {
    const reads = f.reads.charger2;
    await action();
    // The selected action owns its native result; join the peer work it queued
    // without initiating a new reconciliation that could hide a missed wakeup.
    await f.runtime.chargers.charger2.reconcileFlight;
    await new Promise(resolve => setImmediate(resolve));
    await f.runtime.chargers.charger2.reconcileFlight;
    assert.ok(f.reads.charger2 > reads, 'A shared load/permission change queues and reaches the peer');
    assert.deepEqual(f.view('charger2').request, request, 'Peer reconciliation cannot rewrite its user request');
  }
});

test('an edit on Charger 2 revokes a queued Charger 1 native write before dispatch', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const held = f.holdNextOcppWrite();
  const firstEdit = f.edit('charger1', { capacityKwh: 25, readyBy: '04:00' });
  let secondEdit;
  try {
    await Promise.race([held.started, firstEdit.then(() => assert.fail('Expected a queued native schedule replacement'))]);
    secondEdit = f.edit('charger2', { capacityKwh: 15 });
    // Both request edits persist before awaiting controller reconciliation.
    assert.equal(f.view('charger2').request.overrides.capacityKwh, 15);
  } finally { held.release(); }
  await Promise.all([firstEdit, secondEdit]);
  assert.equal(f.revokedOcppWrites, 1, 'The previous joint intent loses transport authority');
  assert.equal(f.view('charger1').control.pending?.accepted, false, 'A rejected queued write cannot be presented as applied');
  f.advance(31_000); await f.settle();
  const first = f.view('charger1');
  assert.equal(first.control.owned.startAt, first.plan.startAt, 'Only the current program remains installed');
  assert.equal(first.control.pending, null);
});

test('switching the shared priority preserves both requests and uses valid joint currents', async t => {
  const f = await fixture(t);
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  const requests = ['charger1', 'charger2'].map(id => structuredClone(f.view(id).request));
  for (const priority of ['charger1', 'charger2', 'balanced']) {
    const before = { ...f.reads };
    await f.priority(priority);
    assert.equal(f.runtime.status().coordination.priority, priority);
    for (const id of ['charger1', 'charger2']) assert.ok(f.reads[id] > before[id], `${priority} must reach ${id}`);
    assert.deepEqual(['charger1', 'charger2'].map(id => f.view(id).request), requests);
    const allocations = f.runtime.status().coordination.allocations;
    assert.ok(allocations.some(row => row.chargers.charger1?.currentA > 0 || row.chargers.charger2?.currentA > 0));
    for (const row of allocations) {
      const currents = ['charger1', 'charger2'].map(id => row.chargers[id]?.currentA ?? 0);
      assert.ok(currents.every(current => current === 0 || current >= 6), 'No sub-minimum simultaneous current');
      assert.ok(currents[0] + currents[1] <= 16 + 1e-9, 'Both chargers share the same 16 A modeled budget');
    }
  }
  await f.restart();
  assert.equal(f.runtime.settings.priority, 'balanced');
  assert.deepEqual(['charger1', 'charger2'].map(id => f.view(id).request), requests);
});

test('an infeasible shared deadline follows the selected priority in forecasts and physical Charger 2 commands', async t => {
  const f = await fixture(t);
  await f.connect('charger1'); await f.connect('charger2');
  for (const id of ['charger1', 'charger2']) await f.edit(id, { capacityKwh: 25, readyBy: '03:00' });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  // Each vehicle needs over 16 kWh; the shared 16 A supply can provide at most
  // 11.04 kWh before 01:00 UTC. These equal requests cannot both be fulfilled.
  for (const [priority, expected] of [['balanced', [8, 8]], ['charger1', [16, 0]], ['charger2', [0, 16]]]) {
    await f.priority(priority);
    const active = f.runtime.status().coordination.allocations.find(row => row.start <= f.now && row.end > f.now);
    assert.deepEqual(['charger1', 'charger2'].map(id => active.chargers[id].currentA), expected);
    const shortfalls = ['charger1', 'charger2'].map(id => f.view(id).forecast.shortfallGridKwh);
    assert.ok(shortfalls.every(value => value > 0), 'Neither impossible deadline is reported as assured');
    if (priority === 'balanced') assert.ok(Math.abs(shortfalls[0] - shortfalls[1]) < .01);
    else assert.ok(shortfalls[priority === 'charger1' ? 0 : 1] < shortfalls[priority === 'charger1' ? 1 : 0]);
    assert.equal(f.fields.start_charging.value, expected[1] > 0);
    if (expected[1] > 0) assert.equal(f.fields.current_limit.value, expected[1]);
  }
  assert.ok(f.commands.filter(command => command.role === 'current_limit').every(command => command.value >= 6),
    'A zero allocation pauses instead of sending an unsupported current');
});
