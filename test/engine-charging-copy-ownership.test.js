import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { copyOwnedValue, immutableValue } from '../src/domain/immutable.js';

const START = Date.parse('2026-10-16T12:00:00Z');
const calculation = label => immutableValue({ label, intervals: Array.from({ length: 64 }, (_, index) => ({
  start: START + index * 900_000, scenarios: Array.from({ length: 32 }, (_, scenario) => ({ scenario, amps: 6 + index % 8 })),
})) });

async function fixture(t) {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'simulated', settings: {} }, clock: () => START });
  t.after(async () => {
    store.writePending = false;
    engine.statusSettlement?.(); engine.statusSettlement = null;
    engine.beginShutdown({ restore: false });
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  await store.runWrite(() => engine.tick());
  const current = { chargers: { charger2: { plan: calculation('committed'), control: { pause: false } } } };
  t.mock.method(engine.charging, 'status', () => copyOwnedValue(current));
  return { store, engine, current };
}

test('public status skips the superseded charging graph and shares only immutable calculations', async t => {
  const { engine, current } = await fixture(t);
  Object.defineProperty(engine.latestStatus, 'charging', { enumerable: true, configurable: true,
    get() { throw new Error('The superseded charging view must not be read'); } });
  const first = engine.status(), second = engine.status();
  const plan = current.chargers.charger2.plan;
  assert.strictEqual(first.charging.chargers.charger2.plan, plan);
  assert.strictEqual(second.charging.chargers.charger2.plan, plan);
  assert.strictEqual(engine.committedStatus.charging.chargers.charger2.plan, plan);
  assert.notStrictEqual(first.charging.chargers.charger2.control, current.chargers.charger2.control);
  first.charging.chargers.charger2.control.pause = true;
  first.settings.comfort.targetC = 25;
  assert.equal(current.chargers.charger2.control.pause, false);
  assert.equal(second.charging.chargers.charger2.control.pause, false);
  assert.equal(engine.committedStatus.charging.chargers.charger2.control.pause, false);
  assert.notEqual(engine.settings.comfort.targetC, 25);
  assert.throws(() => { plan.intervals[0].scenarios[0].amps = 99; }, TypeError);
});

test('pending storage returns the committed charging boundary without observing provisional replacements', async t => {
  const { store, engine, current } = await fixture(t);
  const committed = engine.status(), originalPlan = committed.charging.chargers.charger2.plan;
  current.chargers.charger2.plan = calculation('provisional');
  current.chargers.charger2.control.pause = true;
  store.writePending = true;
  const pending = engine.status();
  assert.equal(pending.storagePending, true);
  assert.equal(pending.now, START);
  assert.strictEqual(pending.charging.chargers.charger2.plan, originalPlan);
  assert.equal(pending.charging.chargers.charger2.control.pause, false);
  pending.charging.chargers.charger2.control.pause = true;
  assert.equal(engine.committedStatus.charging.chargers.charger2.control.pause, false);
  assert.notStrictEqual(pending.observations, engine.committedStatus.observations);
  store.writePending = false;
  const published = engine.status();
  assert.strictEqual(published.charging.chargers.charger2.plan, current.chargers.charger2.plan);
  assert.equal(published.charging.chargers.charger2.control.pause, true);
});

test('initial committed status detaches mutable charging controls while retaining immutable plan ownership', async t => {
  const { engine, current } = await fixture(t);
  await engine.initializeCommittedStatus();
  const committed = engine.committedStatus;
  assert.strictEqual(committed.charging.chargers.charger2.plan, current.chargers.charger2.plan);
  current.chargers.charger2.control.pause = true;
  assert.equal(committed.charging.chargers.charger2.control.pause, false);
  assert.notStrictEqual(committed.settings, engine.settings);
});

test('failed tick restores detached charging controls and heating aliases without copying immutable plans', async t => {
  const { store, engine, current } = await fixture(t);
  engine.latestStatus.charging = copyOwnedValue(current);
  const previous = engine.latestStatus, plan = previous.charging.chargers.charger2.plan;
  const target = engine.settings.comfort.targetC;
  assert.strictEqual(previous.settings, engine.settings, 'the tick status aliases the current heating settings');
  t.mock.method(engine.automation, 'reconcileTargets', () => {
    previous.charging.chargers.charger2.control.pause = true;
    engine.settings.comfort.targetC = 25;
    throw new Error('Synthetic tick rollback');
  });
  await assert.rejects(store.runWrite(() => engine.tick()), /Synthetic tick rollback/);
  assert.strictEqual(engine.latestStatus.charging.chargers.charger2.plan, plan);
  assert.equal(engine.latestStatus.charging.chargers.charger2.control.pause, false);
  assert.equal(engine.settings.comfort.targetC, target);
  assert.strictEqual(engine.latestStatus.settings, engine.settings, 'rollback preserves the native heating graph aliases');
  assert.notStrictEqual(engine.latestStatus.charging.chargers.charger2.control, previous.charging.chargers.charger2.control);
});

test('suspended tick returns detached status shells without duplicating immutable plans', async t => {
  const { engine, current } = await fixture(t);
  engine.latestStatus.charging = copyOwnedValue(current);
  engine.suspended = true;
  const view = engine.tick();
  assert.strictEqual(view.charging.chargers.charger2.plan, current.chargers.charger2.plan);
  view.charging.chargers.charger2.control.pause = true;
  view.observations.indoor.value = 30;
  assert.equal(engine.latestStatus.charging.chargers.charger2.control.pause, false);
  assert.notEqual(engine.latestStatus.observations.indoor.value, 30);
});
