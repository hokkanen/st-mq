import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/charging-joint-fixture.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { getChartData } from '../src/app/chart-data.js';

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
