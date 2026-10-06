import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/charging-joint-fixture.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { getChartData } from '../src/app/chart-data.js';
import { chargingAllowanceDisplay } from '../chart/charging-allowance.js';

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
