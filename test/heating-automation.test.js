import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { createAppServer } from '../src/app/server.js';
import { HeatingAutomation } from '../src/app/automation.js';

function setup(t, { input = 'simulated', canControl = () => true, commandTransport = null,
  clock = () => Date.parse('2026-09-28T12:00Z') } = {}) {
  const store = new Store(':memory:');
  const config = { input, settings: {}, garage: { enabled: true },
    connections: { mqtt: { address: 'mqtt://invented.invalid', user: 'invented-account' } } };
  const engine = new Engine({ store, config, commandTransport, canControl, clock });
  t.after(() => { clearTimeout(engine.executor.timer); engine.executor.closed = true; store.close(); });
  return { engine, store, config };
}

test('Home starts paused and persists for unchanged equipment; Garage has no automatic permission', async t => {
  const { engine, store, config } = setup(t);
  assert.deepEqual(Object.values(engine.status().automation).map(row => row.enabled), [false]);
  assert.equal(engine.status().environment, 'simulation');
  assert.equal(engine.status().automation.home.activity, 'paused');
  assert.equal(engine.status().override.expiresAt, null);
  await engine.setAutomation({ feature: 'home', enabled: true });
  assert.equal(engine.automationEnabled('home'), true);
  assert.equal(engine.status().automation.garage, undefined);
  const restarted = new HeatingAutomation({ store, config });
  assert.equal(restarted.features.home.enabled, true);
  assert.equal(restarted.features.garage, undefined);
  await assert.rejects(engine.setAutomation({ feature: 'garage', enabled: true }), /home|unsupported|feature/i);
  await engine.setAutomation({ feature: 'home', enabled: false });
  assert.equal(engine.automationEnabled('home'), false);

  assert.equal(Object.hasOwn(engine.settings, 'mode'), false);
  assert.equal(Object.hasOwn(engine.status(), 'mode'), false);
  assert.equal(Object.hasOwn(engine.status(), 'liveWrites'), false);
});

test('device destination changes invalidate only the affected heating permission', async t => {
  const { engine, store, config } = setup(t);
  await engine.setAutomation({ feature: 'home', enabled: true });
  await assert.rejects(engine.setAutomation({ feature: 'garage', enabled: true }), /home|unsupported|feature/i);
  const changedGarage = new HeatingAutomation({ store, config: { ...config, garage: { ...config.garage,
    adapter: { commandTopic: 'invented/replacement' } } } });
  assert.equal(changedGarage.features.home.enabled, true);
  assert.equal(changedGarage.features.garage, undefined);
  const changedHome = new HeatingAutomation({ store, config: { ...config, deviceId: 'invented-new-home' } });
  assert.equal(changedHome.features.home.enabled, false);

  const changedBroker = new HeatingAutomation({ store, config: { ...config,
    connections: { mqtt: { ...config.connections.mqtt, address: 'mqtt://replacement.invalid' } } } });
  assert.deepEqual(Object.values(changedBroker.features).map(row => row.enabled), [false]);
  assert.equal(JSON.stringify(engine.automationStatus()).includes('invented'), false);
});

test('read-only authority and history cannot grant automation or manual heating authority', async t => {
  let authority = true;
  const { engine } = setup(t, { canControl: () => authority });
  await engine.setAutomation({ feature: 'home', enabled: true });
  authority = false;
  assert.equal(engine.automationStatus().home.enabled, true, 'Saved intent is distinct from current authority');
  assert.equal(engine.automationEnabled('home'), false);
  assert.equal(engine.automationStatus().home.available, false);
  assert.equal(engine.heatingTests().available, false);
  await assert.rejects(engine.setAutomation({ feature: 'home', enabled: false }), /read-only/);
  const history = setup(t, { input: 'offline' }).engine;
  assert.equal(history.status().environment, 'history');
  await assert.rejects(history.setAutomation({ feature: 'home', enabled: true }), /history viewer/);
});

test('selecting Pause removes the scheduled end and preserves the manual reduction', async t => {
  const commands = [], commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    async publish(batch) { commands.push(batch); return { status: 'mqtt', sent: true }; } };
  const { engine } = setup(t, { input: 'mqtt', commandTransport });
  engine.automation.set('home', true);
  engine.setTemporary({ pauseUntil: new Date(engine.clock() + 30 * 60_000).toISOString() }); await engine.dispatchPending;
  await engine.testHeating({ command: 'reduction' });
  const scope = engine.executor.status().manualPause;
  commands.length = 0;
  await engine.setAutomation({ feature: 'home', enabled: false });
  assert.deepEqual(commands, []);
  assert.deepEqual(engine.executor.status().manualPause, { ...scope, expiresAt: null });
  assert.equal(engine.executor.status().phase, 'reduction');
  assert.equal(engine.status().automation.home.activity, 'paused');
});

test('unsupported saved automation state is rejected before database mutation', t => {
  const { store, config } = setup(t);
  store.setState('automation:simulated', { version: 0, mode: 'active' });
  const before = store.db.prepare('SELECT * FROM state ORDER BY key').all();
  assert.throws(() => new Engine({ store, config }), /Unsupported saved heating automation/);
  assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
});

test('indefinite Pause holds manual Reduced through updates and restart until Automatic is selected', async t => {
  let now = Date.parse('2026-09-28T12:00Z');
  const commands = [], commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    async publish(batch) { commands.push(batch); return { status: 'mqtt', sent: true }; } };
  const { engine, store, config } = setup(t, { input: 'mqtt', commandTransport, clock: () => now });
  const request = await engine.testHeating({ command: 'reduction' });
  assert.equal(request.expiresAt, null);
  assert.equal(engine.status().decision.manualHold.until, null);
  const pauseId = engine.status().override.id;
  now += 2 * 86_400_000;
  engine.tick(); await engine.dispatchPending;
  assert.equal(engine.executor.status().phase, 'reduction');
  assert.equal(engine.status().override.id, pauseId);
  const restarted = new Engine({ store, config, commandTransport, clock: () => now });
  t.after(() => { clearTimeout(restarted.executor.timer); restarted.executor.closed = true; });
  commandTransport.targetIdentity.tariff = null;
  const beforeReconnect = commands.length;
  restarted.tick(); await restarted.dispatchPending;
  assert.equal(commands.length, beforeReconnect, 'Unknown identity never sends a command');
  assert.equal(restarted.executor.status().manualRequested.phase, 'reduction');
  assert.equal(restarted.executor.status().restorationPending, false, 'A normal reconnect wait does not discard durable intent');
  commandTransport.targetIdentity.tariff = 'a'.repeat(64);
  restarted.tick(); await restarted.dispatchPending;
  assert.equal(restarted.executor.status().phase, 'reduction');
  assert.equal(restarted.status().decision.manualHold.until, null);
  assert.equal(commands.some(batch => batch.includes('normal')), false);
  await restarted.setAutomation({ feature: 'home', enabled: true });
  await restarted.dispatchPending;
  assert.equal(restarted.status().override, null);
  assert.equal(restarted.executor.status().manualPause, null);
  assert.equal(commands.at(-1)[0], 'normal');
});

test('editing or removing a scheduled pause end preserves its manual choice and ownership', async t => {
  const commands = [], commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    async publish(batch) { commands.push(batch); return { status: 'mqtt', sent: true }; } };
  const { engine } = setup(t, { input: 'mqtt', commandTransport });
  await engine.testHeating({ command: 'reduction' });
  const pauseId = engine.status().override.id, until = engine.clock() + 3_600_000;
  await engine.dispatchPending;
  engine.setTemporary({ pauseUntil: new Date(until).toISOString() }); await engine.dispatchPending;
  assert.deepEqual(engine.executor.status().manualPause, { id: pauseId, expiresAt: until });
  engine.setTemporary({ pauseUntil: null }); await engine.dispatchPending;
  assert.deepEqual(engine.executor.status().manualPause, { id: pauseId, expiresAt: null });
  assert.equal(engine.status().automation.home.activity, 'paused');
  assert.equal(engine.nextTemporaryDeadline(), Infinity);
  assert.deepEqual(commands, [['reduction']]);
});

test('scheduled Pause resumes only the originally selected equipment and a changed target revokes the schedule', async t => {
  let now = Date.parse('2026-09-28T12:00Z');
  const commands = [], commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    async publish(batch) { commands.push(batch); return { status: 'mqtt', sent: true }; } };
  const { engine } = setup(t, { input: 'mqtt', commandTransport, clock: () => now });
  engine.setTemporary({ pauseUntil: new Date(now + 60_000).toISOString() });
  assert.equal(engine.status().automation.home.enabled, false);
  assert.deepEqual(commands, []);
  now += 60_000; engine.tick(); await engine.dispatchPending;
  assert.equal(engine.status().automation.home.enabled, true);
  assert.equal(engine.status().override, null);
  engine.setTemporary({ pauseUntil: new Date(now + 60_000).toISOString() }); await engine.dispatchPending;
  commandTransport.targetIdentity.tariff = 'c'.repeat(64);
  now += 60_000; engine.tick(); await engine.dispatchPending;
  assert.equal(engine.status().automation.home.enabled, false);
  assert.equal(engine.status().override.expiresAt, null);
});

test('retired parallel pause state and prior automation schema reject without changing the database', t => {
  for (const retired of ['override', 'automation']) {
    const { store, config } = setup(t);
    if (retired === 'override') store.setState('override:simulated', { id: 'retired-pause', mode: 'normal', expiresAt: Date.now() + 60_000 });
    else store.setState('automation:simulated', { ...store.getState('automation:simulated'), version: 2 });
    const before = store.db.prepare('SELECT * FROM state ORDER BY key').all();
    assert.throws(() => new Engine({ store, config }), /Unsupported saved heating/);
    assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
  }
});

test('automation API permits family choices and rejects retired or ambiguous payloads', async t => {
  const { engine, store } = setup(t);
  const token = 'synthetic-admin-token-at-least-24', familyToken = 'synthetic-family-token-at-least-24';
  const server = createAppServer({ engine, store, token, familyToken });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = payload => fetch(`${base}/api/automation`, { method: 'POST', headers: {
    authorization: `Bearer ${familyToken}`, 'content-type': 'application/json', origin: base }, body: JSON.stringify(payload) });
  const response = await post({ feature: 'home', enabled: true });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.automation.home.enabled, true);
  assert.equal(status.automation.garage, undefined);
  for (const payload of [{ mode: 'active' }, { feature: 'home', enabled: 'true' },
    { feature: 'garage', enabled: true, mode: 'active' }, { feature: 'charging', enabled: true }, null])
    assert.equal((await post(payload)).status, 400);
});


test('failed persistence never grants an in-memory automation permission', t => {
  const { engine, store } = setup(t);
  const original = store.setState.bind(store);
  store.setState = (key, value) => {
    if (key.startsWith('automation:')) throw new Error('synthetic storage failure');
    return original(key, value);
  };
  assert.throws(() => engine.automation.set('home', true), /storage failure/);
  assert.equal(engine.automationEnabled('home'), false);
  assert.equal(store.getState('automation:simulated').features.home.enabled, false);
});

test('reconnect waits for the original actual relay and a replacement cannot inherit Home automation', async t => {
  const commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    publish: async () => ({ status: 'mqtt', sent: true }) };
  const { engine, store } = setup(t, { input: 'mqtt', commandTransport });
  engine.automation.set('home', true);
  const original = store.getState('automation:mqtt').features.home;
  commandTransport.targetIdentity.tariff = null;
  engine.tick();
  assert.equal(engine.automationEnabled('home'), false);
  assert.equal(engine.automationStatus().home.enabled, true, 'Missing live identity preserves intent without granting authority');
  commandTransport.targetIdentity.tariff = original.targetIdentity;
  assert.equal(engine.automationEnabled('home'), true);
  commandTransport.targetIdentity.tariff = 'c'.repeat(64);
  assert.equal(engine.automationEnabled('home'), false);
  engine.tick();
  assert.equal(engine.automationStatus().home.enabled, false);
  assert.equal(store.getState('automation:mqtt').features.home.enabled, false);
  commandTransport.targetIdentity.tariff = original.targetIdentity;
  assert.equal(engine.automationEnabled('home'), false, 'Returning an old device cannot silently restore a revoked choice');
});

test('disabling Home during an in-flight automatic reduction drains it before restoring Normal', async t => {
  const commands = []; let release;
  const commandTransport = { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
    async publish(batch) {
      commands.push(batch);
      if (batch[0] === 'reduction') await new Promise(resolve => { release = resolve; });
      return { status: 'mqtt', sent: true };
    } };
  const { engine } = setup(t, { input: 'mqtt', commandTransport });
  engine.automation.set('home', true);
  engine.dispatchPending = engine.executor.execute({ phase: 'reduction', commands: ['reduction'] },
    { automationEnabled: true, now: engine.clock() });
  await new Promise(resolve => setImmediate(resolve));
  const disable = engine.setAutomation({ feature: 'home', enabled: false });
  assert.equal(engine.automationEnabled('home'), false);
  await assert.rejects(engine.setAutomation({ feature: 'home', enabled: true }), /current automation change/);
  release(); await disable;
  assert.deepEqual(commands, [['reduction'], ['normal']]);
  assert.equal(engine.executor.status().legacyOutstanding, false);
  assert.equal(engine.automationEnabled('home'), false);
  assert.equal(engine.automationChangePending, false);
});
