import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundPlanDeadline } from '../src/charging/plan-settling.js';
import { fixture, HOUR } from './helpers/charging-joint-fixture.js';

const NOW = 1_800_000_000_000;
function waiting() {
  const periods = [{ startAt: NOW + HOUR, endAt: null }];
  return { now: NOW + 1000, key: 'unchanged', previous: { key: 'unchanged', at: NOW },
    coordination: { proposed: { feasible: true }, adopted: { feasible: true }, allocations: [] },
    chargers: [{ id: 'charger2', capabilities: { currentControl: true }, settings: { enabled: true },
      values: { connected: { available: true, value: true } }, request: { sessionId: 'same-session' },
      identification: { active: true, phase: 'waiting', action: null },
      control: { phase: 'waiting', snapshot: { transport: 'shelly-evse', online: true,
        observationReady: true, currentObservationReady: true, controlReady: true },
      execution: { planId: 'accepted', periods } } }],
    plans: { charger2: { id: 'accepted', state: 'waiting', feasible: true, deadlineAt: NOW + 2 * HOUR, periods } } };
}

test('background settling has a fixed deadline and never extends it for further noise', () => {
  const context = waiting();
  assert.equal(backgroundPlanDeadline(context), NOW + 30_000);
  context.now = NOW + 29_999;
  assert.equal(backgroundPlanDeadline(context), NOW + 30_000);
  context.now++;
  assert.equal(backgroundPlanDeadline(context), null);
  context.now = NOW - 1;
  assert.equal(backgroundPlanDeadline(context), null);
});

test('brief processing holds can retain a confirmed waiting program with original evidence', () => {
  const context = waiting(), snapshot = context.chargers[0].control.snapshot;
  snapshot.controlReady = false;
  snapshot.commandBlockReason = 'evse-input-persistence-pending';
  assert.equal(backgroundPlanDeadline(context), NOW + 30_000);
  snapshot.commandBlockReason = 'evse-source-time-pending';
  assert.equal(backgroundPlanDeadline(context), NOW + 30_000);
  snapshot.observationReady = false;
  assert.equal(backgroundPlanDeadline(context), null);
});

for (const [name, mutate] of Object.entries({
  'changed intent or electrical ceiling': c => { c.key = 'changed'; },
  'unknown joint feasibility': c => { c.coordination.adopted.feasible = null; },
  'missing adopted program': c => { c.chargers[0].control.execution = null; },
  'unconfirmed replacement': c => { c.chargers[0].control.execution.planId = 'other'; },
  'Charge now': c => { c.chargers[0].request.chargeNow = true; },
  'manual instruction': c => { c.chargers[0].control.manual = { kind: 'stop' }; },
  'device permission hold': c => { c.chargers[0].control.devicePermissionHeld = true; },
  'pending command': c => { c.chargers[0].control.pending = { kind: 'start' }; },
  'offline source': c => { c.chargers[0].control.snapshot.online = false; },
  'unknown connection': c => { c.chargers[0].values.connected.available = false; },
  'native current-control restriction': c => { c.chargers[0].control.snapshot.currentObservationReady = false; },
  'fault': c => { c.chargers[0].control.snapshot.faulted = true; },
  'native schedule': c => { c.chargers[0].control.snapshot.nativeScheduleActive = true; },
  'identification action': c => { c.chargers[0].identification.action = 'start'; },
  'unresolved current test': c => { c.chargers[0].control.currentTest = { phase: 'uncertain' }; },
  'running period': c => { c.plans.charger2.periods[0].startAt = NOW; },
  'start within 30 seconds': c => { c.plans.charger2.periods[0].startAt = NOW + 31_000; },
  'deadline within 30 seconds': c => { c.plans.charger2.deadlineAt = NOW + 31_000; },
  'allocation boundary within 30 seconds': c => { c.coordination.allocations = [{ start: NOW + 15_000 }]; },
})) test(`background settling bypasses ${name}`, () => {
  const context = waiting(); mutate(context);
  assert.equal(backgroundPlanDeadline(context), null);
});

async function acceptedWaiting(t) {
  const f = await fixture(t, { limiter: false });
  await f.automatic('charger1', true); await f.automatic('charger2', true); await f.plan();
  await f.connect('charger1'); await f.connect('charger2'); await f.plan();
  assert.ok(f.runtime.coordination.adopted.feasible);
  return f;
}

test('runtime coalesces background updates, wakes at 30 seconds and keeps both accepted schedules', async t => {
  const f = await acceptedWaiting(t);
  const at = f.runtime.lastBackgroundPlan.at, commands = f.commands.length;
  const executions = () => ['charger1', 'charger2'].map(id => f.view(id).control.execution);
  const accepted = structuredClone(executions());
  for (const elapsed of [1000, 5000, 15_000, 29_999]) {
    f.advance(at + elapsed - f.now);
    await f.runtime.chargers.charger2.adapter.refresh();
    await f.runtime.updatePlan(f.now, { background: true });
    assert.equal(f.runtime.lastBackgroundPlan.at, at, 'No new forecast publication inside the fixed window');
    assert.equal(f.runtime.backgroundPlanDueAt, at + 30_000);
    assert.equal(f.runtime.boundaryAt, at + 30_000, 'A timer guarantees a recheck without new telemetry');
    assert.deepEqual(executions(), accepted);
  }
  assert.equal(f.commands.length, commands);
  f.advance(1); await f.runtime.tick({ force: true }); await f.settle();
  assert.equal(f.runtime.lastBackgroundPlan.at, at + 30_000);
  assert.deepEqual(executions(), accepted);
});

test('explicit planning and changed prices bypass an outstanding background wait', async t => {
  const f = await acceptedWaiting(t);
  f.advance(1000); await f.runtime.updatePlan(f.now, { background: true });
  assert.ok(f.runtime.backgroundPlanDueAt);
  await f.runtime.updatePlan();
  assert.equal(f.runtime.lastBackgroundPlan.at, f.now);
  assert.equal(f.runtime.backgroundPlanDueAt, null);
  f.advance(1000); await f.runtime.updatePlan(f.now, { background: true });
  assert.ok(f.runtime.backgroundPlanDueAt);
  const prices = f.runtime.prices.map((row, index) => ({ ...row, price: index === 3 ? 0.5 : row.price }));
  await f.runtime.tick({ prices });
  assert.equal(f.runtime.lastBackgroundPlan.at, f.now);
  assert.equal(f.runtime.backgroundPlanDueAt, null);
});
