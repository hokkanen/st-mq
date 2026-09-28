import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';

test('a garage planning failure revokes its permission while the Home decision still completes', async t => {
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const engine = new Engine({ store, config: { input: 'simulated', automationEnabled: () => false, connections: {} }, clock: () => now });
  t.after(async () => { await engine.garage.close({ restore: false }); store.close(); });
  const first = engine.tick();
  assert.ok(first.decision);
  const releases = [];
  engine.garage.setAdapter({ status: () => ({ restorePending: true, native: {}, health: {} }),
    release: async request => { releases.push(request); } });
  engine.garage.plan = { nextAction: 'renew' }; engine.garage.lastPlannerAt = now;
  t.mock.method(engine.garage, 'tick', () => { throw new Error('synthetic-private-garage-failure'); });
  now += 60_000;
  const result = engine.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.now, now);
  assert.ok(result.decision.action);
  assert.equal(result.execution.sent, false);
  assert.equal(engine.garage.lastPlannerAt, null);
  assert.equal(engine.garage.plan, null);
  assert.equal(engine.garage.protection.safeToPause, false);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, 'garage-runtime-unavailable');
  assert.equal(JSON.stringify(result).includes('synthetic-private-garage-failure'), false);
});

test('a garage failure in an instance without authority cannot send a restoration command', async t => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'simulated', automationEnabled: () => false, connections: {} },
    clock: () => 1_800_000_000_000, canControl: () => false });
  t.after(async () => { await engine.garage.close({ restore: false }); store.close(); });
  let releases = 0;
  engine.garage.setAdapter({ status: () => ({ restorePending: true, native: {}, health: {} }), release: async () => { releases++; } });
  t.mock.method(engine.garage, 'tick', () => { throw new Error('fixture garage failure'); });
  const result = engine.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(result.decision);
  assert.equal(releases, 0);
  assert.equal(engine.garage.lastPlannerAt, null);
});
