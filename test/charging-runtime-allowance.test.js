import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/charging-joint-fixture.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { getChartData } from '../src/app/chart-data.js';
import { chargingAllowanceDisplay } from '../chart/charging-allowance.js';

for (const reason of ['evse-input-persistence-pending', 'evse-source-time-pending'])
  test(`an idle charger keeps its confirmed setting and fresh capacity during ${reason}`, async t => {
    const f = await fixture(t);
    await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
    const item = f.runtime.chargers.charger2, controller = item.controller, adapter = item.adapter;
    const snapshot = adapter.snapshot, initial = controller.status(), commands = f.commands.length;
    assert.equal(initial.limiter.settingMode, 'idle-fallback');
    assert.equal(initial.limiter.settingCurrentA, 12);
    assert.equal(initial.scheduleConfirmed, true);
    const settingAt = initial.snapshot.fields.current_limit.measuredAt;
    const permissionAt = initial.snapshot.fields.start_charging.measuredAt;
    adapter.snapshot = () => ({ ...snapshot(), controlReady: false, observationReady: true, commandBlockReason: reason });
    t.after(() => { adapter.snapshot = snapshot; });
    for (const [load, expected] of [[2, 14], [7, 9], [0, 16]]) {
      f.household.currentA = load; f.advance(5000);
      await controller.update({ enabled: true, plan: item.plan });
      const control = controller.status(), limiter = f.runtime.limiterStatus(control, f.now);
      assert.equal(control.limiter.currentA, expected);
      assert.equal(control.limiter.settingMode, 'idle-fallback');
      assert.equal(control.limiter.settingCurrentA, 12);
      assert.equal(control.scheduleConfirmed, true);
      assert.equal(control.snapshot.controlReady, false);
      assert.equal(control.snapshot.fields.current_limit.measuredAt, settingAt);
      assert.equal(control.snapshot.fields.start_charging.measuredAt, permissionAt);
      assert.equal(limiter.applicationStatus, 'idle');
      f.runtime.recordLimiterHistory();
      const row = f.store.observations({ signal: 'charger2_current_allowance' }).at(-1);
      assert.equal(row.value, expected, 'Independent capacity continues to be recorded');
      assert.equal(row.raw.allowance.limiter.applicationStatus, 'idle');
      assert.equal(f.commands.length, commands, 'Processing holds still prevent every new command');
    }
  });

test('an idle processing hold respects a tighter vehicle ceiling without confirming or sending the changed setting', async t => {
  const f = await fixture(t);
  await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
  const item = f.runtime.chargers.charger2, controller = item.controller, adapter = item.adapter;
  const snapshot = adapter.snapshot, allocation = f.runtime.allocationContext, commands = f.commands.length;
  assert.equal(controller.status().limiter.settingCurrentA, 12);
  adapter.snapshot = () => ({ ...snapshot(), controlReady: false, observationReady: true,
    commandBlockReason: 'evse-input-persistence-pending' });
  f.runtime.allocationContext = (...args) => ({ ...allocation.apply(f.runtime, args), vehicleCurrentA: 8 });
  t.after(() => { adapter.snapshot = snapshot; f.runtime.allocationContext = allocation; });
  f.household.currentA = 2; f.advance(5000);
  await controller.update({ enabled: true, plan: item.plan });
  const control = controller.status();
  assert.equal(control.limiter.loadCurrentA, 14);
  assert.equal(control.limiter.settingMode, 'idle-fallback');
  assert.equal(control.limiter.settingCurrentA, 8);
  assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.runtime.limiterStatus(control, f.now).applicationStatus, 'blocked');
  f.runtime.recordLimiterHistory();
  const row = f.store.observations({ signal: 'charger2_current_allowance' }).at(-1);
  assert.equal(row.value, 14);
  assert.equal(row.raw.allowance.limiter.applicationStatus, 'blocked');
  assert.equal(f.commands.length, commands);
});

for (const changed of ['generation', 'permission', 'physical-evidence'])
  test(`idle-setting confirmation does not cross changed ${changed} during an input hold`, async t => {
    const f = await fixture(t);
    await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
    const item = f.runtime.chargers.charger2, adapter = item.adapter, controller = item.controller;
    const snapshot = adapter.snapshot, liveCurrents = adapter.liveCurrents, commands = f.commands.length;
    assert.equal(controller.status().limiter.settingMode, 'idle-fallback');
    adapter.snapshot = () => {
      const current = snapshot();
      return { ...current, controlReady: false, observationReady: true, commandBlockReason: 'evse-input-persistence-pending',
        ...(changed === 'generation' ? { generation: current.generation + 1 } : {}),
        ...(changed === 'permission' ? { fields: { ...current.fields,
          start_charging: { ...current.fields.start_charging, value: true } } } : {}) };
    };
    if (changed === 'physical-evidence') adapter.liveCurrents = () => ({ ...liveCurrents(), healthy: false });
    t.after(() => { adapter.snapshot = snapshot; adapter.liveCurrents = liveCurrents; });
    f.household.currentA = 2; f.advance(5000);
    await controller.update({ enabled: true, plan: item.plan });
    const control = controller.status();
    assert.equal(control.limiter.settingMode, undefined);
    assert.notEqual(f.runtime.limiterStatus(control, f.now).applicationStatus, 'idle');
    assert.equal(f.commands.length, commands);
  });

for (const changed of ['work-state', 'power', 'generation', 'hold-cleared'])
  test(`idle confirmation rechecks ${changed} after awaiting allocation`, async t => {
    const f = await fixture(t);
    await f.automatic('charger2', true); await f.plan(); await f.connect('charger2'); await f.plan();
    const item = f.runtime.chargers.charger2, adapter = item.adapter, controller = item.controller;
    const snapshot = adapter.snapshot, allocation = f.runtime.allocationContext, commands = f.commands.length;
    let allocationWaiting, releaseAllocation, changedDuringAllocation = false;
    const waiting = new Promise(resolve => { allocationWaiting = resolve; });
    adapter.snapshot = () => {
      const current = snapshot();
      if (changedDuringAllocation && changed === 'hold-cleared') return current;
      return { ...current, controlReady: false, observationReady: true, commandBlockReason: 'evse-input-persistence-pending',
        ...(changedDuringAllocation && changed === 'generation' ? { generation: current.generation + 1 } : {}),
        fields: { ...current.fields,
          ...(changedDuringAllocation && changed === 'work-state'
            ? { work_state: { ...current.fields.work_state, value: 'charger_charging' } } : {}),
          ...(changedDuringAllocation && changed === 'power'
            ? { phase_info: { ...current.fields.phase_info, value: { ...current.fields.phase_info.value, total_power: .15 } } } : {}),
        } };
    };
    f.runtime.allocationContext = (...args) => {
      const context = allocation.apply(f.runtime, args);
      return new Promise(resolve => { releaseAllocation = () => resolve(context); allocationWaiting(); });
    };
    t.after(() => { adapter.snapshot = snapshot; f.runtime.allocationContext = allocation; });
    f.household.currentA = 2; f.advance(5000);
    const updating = controller.update({ enabled: true, plan: item.plan });
    await waiting;
    changedDuringAllocation = true;
    releaseAllocation(); await updating;
    const control = controller.status();
    assert(adapter.liveCurrents().currents.every(value => value < .5), 'Low phase currents alone do not prove stopped power or work state');
    assert.equal(control.limiter.settingMode, changed === 'hold-cleared' ? 'idle-fallback' : undefined);
    assert.equal(f.runtime.limiterStatus(control, f.now).applicationStatus === 'idle', changed === 'hold-cleared');
    assert.equal(f.commands.length, commands);
  });

test('uncertain Charger 2 commands keep recording fresh capacity without replay or invented coverage', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger2');
  f.rejectShellyWrites(true);
  f.household.currentA = 11;
  f.advance(5000); await f.settle();
  const control = () => f.runtime.chargers.charger2.controller.status();
  const pending = structuredClone(control().pending);
  assert.equal(pending.role, 'current_limit');
  assert.equal(pending.value, 14);
  const commands = f.commands.length;
  const rows = () => f.store.observations({ signal: 'charger2_current_allowance' });
  for (const [load, expected] of [[11, 14], [16, 9], [20, 0], [0, 16]]) {
    f.household.currentA = load;
    f.advance(60_000); await f.settle(); f.runtime.recordLimiterHistory();
    assert.deepEqual(control().pending, pending, 'Uncertain execution retains the original pending command');
    assert.equal(control().reason, 'evse-command-unconfirmed');
    assert.equal(f.view('charger2').limiter.applicationStatus, 'pending');
    assert.equal(f.view('charger2').allowance.allowanceA, expected);
    assert.equal(rows().at(-1).value, expected);
  }
  const count = rows().length;
  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  assert.equal(rows().length, count, 'Unchanged capacity extends coverage without another observation');
  const adapter = f.runtime.chargers.charger2.adapter, snapshot = adapter.snapshot;
  try {
    for (const observationReady of [true, false]) {
      adapter.snapshot = () => ({ ...snapshot(), controlReady: false, observationReady, error: 'evse-control-unavailable' });
      f.household.currentA = 13;
      f.advance(60_000); await f.settle(); f.runtime.recordLimiterHistory();
      assert.equal(control().snapshot.controlReady, false);
      assert.equal(control().phase, observationReady ? 'uncertain' : 'unavailable',
        'Fresh observations retain the uncertain instruction while command access is blocked');
      assert.equal(control().reason, observationReady ? 'evse-command-unconfirmed' : 'evse-control-unavailable');
      assert.equal(rows().at(-1).value, 12, 'Healthy load evidence is independent of command readiness');
      assert.deepEqual(control().pending, pending);
    }
  } finally { adapter.snapshot = snapshot; }
  // A real acquisition gap stays unknown; new calculations cannot fill it.
  f.advance(6 * 3600_000); f.runtime.recordLimiterHistory();
  assert.equal(rows().at(-1).raw.allowance.mode, 'unknown');
  await f.restart(); f.runtime.recordLimiterHistory();
  assert.deepEqual(control().pending, pending, 'Restart retains the uncertain command');
  assert.equal(rows().at(-1).value, 12);
  assert(rows().some(row => row.raw.allowance.mode === 'unknown'), 'Restart does not backfill the gap');
  f.household.feedsSynchronized = false;
  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  assert.equal(rows().at(-1).raw.allowance.mode, 'fallback');
  assert.equal(rows().at(-1).value, 12);
  assert.equal(f.commands.length, commands, 'No uncertain write is retried and no Start is sent');
  assert.equal(f.runtime.limiterHistoryError, null);
});

test('unplugged chargers record changing numeric allowances without creating sessions or sending commands', async t => {
  const f = await fixture(t, { budgetA: 25 });
  const rows = id => f.store.observations({ signal: `${id}_current_allowance` });
  const commands = f.commands.length;
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).values.connected.value, false);
    assert.equal(f.view(id).request, null);
    assert.equal(f.view(id).allowance.allowanceA, 16);
  }
  assert.equal(f.view('charger2').limiter.applicationStatus, 'inactive');
  const display = chargingAllowanceDisplay(f.view('charger2').allowance, { limiter: f.view('charger2').limiter });
  assert.equal(display.label, '16 A Available');
  assert.match(display.detail, /No vehicle is connected/);
  assert.match(display.detail, /applies no charger instruction/);

  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  const counts = ['charger1', 'charger2'].map(id => rows(id).length);
  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  assert.deepEqual(['charger1', 'charger2'].map(id => rows(id).length), counts,
    'Unchanged unplugged observations extend coverage without another row');
  f.household.currentA = 15;
  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  for (const id of ['charger1', 'charger2']) {
    assert.equal(f.view(id).allowance.allowanceA, 10);
    assert.equal(rows(id).at(-1).value, 10);
  }
  assert.equal(f.commands.length, commands, 'Capacity observation never issues a charger command');
  assert.equal(f.runtime.limiterHistoryError, null);
  const chart = getChartData({ store: f.store, input: 'mqtt', now: f.now,
    startDate: '2026-01-15', endDate: '2026-01-15', view: 'charging_currents' });
  for (const key of ['ev1_current_allowance', 'ev2_current_allowance'])
    assert(chart.series[key].some(point => point.y === 16), 'Unplugged capacity has recorded chart coverage');

  f.household.feedsSynchronized = false;
  f.advance(5000); await f.settle(); f.runtime.recordLimiterHistory();
  assert.equal(rows('charger1').at(-1).raw.allowance.mode, 'unknown');
  assert.equal(rows('charger2').at(-1).raw.allowance.mode, 'fallback');
  assert.equal(rows('charger2').at(-1).value, 12, 'Fallback remains explicit while no vehicle is connected');
  assert.equal(f.view('charger2').limiter.applicationStatus, 'inactive');
  assert.equal(f.commands.length, commands);
});

test('unplugged Charger 2 capacity retains the connected peer commitment for every selected priority', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger1');
  const commands = () => f.commands.filter(row => row.chargerId === 'charger2').length;
  const before = commands();
  for (const priority of ['balanced', 'charger1', 'charger2']) {
    await f.priority(priority); f.advance(5000); await f.settle();
    assert.equal(f.view('charger2').request, null);
    assert.equal(f.view('charger2').allowance.allowanceA, 9,
      'Current 16 A peer commitment is reserved without inventing a second request');
    assert.equal(f.runtime.settings.priority, priority, 'The saved sharing preference is unchanged');
  }
  await f.disconnect('charger1');
  assert.equal(f.view('charger2').allowance.allowanceA, 16, 'Released peer commitment restores available capacity');
  assert.equal(commands(), before);
});

test('configured Charger 1 records native allowance with Automatic off and alongside Charger 2', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger1'); await f.connect('charger2');
  assert.deepEqual(f.runtime.configuration.chargers.charger1, {}, 'Charger 1 has no configured enabled switch');
  assert.equal(f.view('charger1').controls.enabled, false);
  const rows = id => f.store.observations({ signal: `${id}_current_allowance` });
  f.advance(5000); f.runtime.recordLimiterHistory();
  const first = rows('charger1');
  assert(first.some(row => row.value === 16 && row.raw.allowance.source === 'easee-equalizer'));
  assert(rows('charger2').length > 0);
  const commands = f.commands.length, reads = { ...f.reads };
  f.advance(5000); f.runtime.recordLimiterHistory();
  assert.equal(rows('charger1').length, first.length, 'Unchanged evidence extends coverage without another historical row');
  assert.equal(f.commands.length, commands); assert.deepEqual(f.reads, reads);
  const inventory = getDatabaseOverview({ store: f.store, now: f.now });
  assert(inventory.groups.flatMap(group => group.items).some(item => item.id === 'charger1_current_allowance' && item.count > 0));
  const chart = getChartData({ store: f.store, input: 'mqtt', now: f.now,
    startDate: '2026-01-15', endDate: '2026-01-15', view: 'charging_currents' });
  assert(chart.series.ev1_current_allowance.some(point => point.y === 16));
  assert(chart.series.ev2_current_allowance.some(point => Number.isFinite(point.y)));
  f.household.currentA = 20;
  f.advance(5000); f.runtime.recordLimiterHistory();
  assert(rows('charger1').some(row => row.value === 0), 'Native zero is recorded as an allowance');
  f.household.feedsSynchronized = false;
  f.advance(5000); f.runtime.recordLimiterHistory();
  assert.equal(rows('charger1').at(-1).raw.allowance.mode, 'unknown');
  assert.equal(f.runtime.limiterHistoryError, null);
});

test('allowance recording skips unconfigured integrations and replicas without inventing history', async t => {
  const f = await fixture(t, { budgetA: 25 });
  await f.connect('charger1'); await f.connect('charger2');
  const count = () => f.store.db.prepare("SELECT count(*) n FROM observations WHERE source='charging-allowance'").get().n;
  f.runtime.canControl = () => false;
  const beforeReplica = count(); f.advance(5000); f.runtime.recordLimiterHistory();
  assert.equal(count(), beforeReplica); assert.equal(f.runtime.limiterHistory.previous.size, 0);
  f.runtime.canControl = () => true;
  f.runtime.config.connections.easee.charger_id = '';
  f.runtime.configuration.chargers.charger2.enabled = false;
  f.advance(5000); f.runtime.recordLimiterHistory();
  assert.equal(count(), beforeReplica); assert.equal(f.runtime.limiterHistory.previous.size, 0);
});
