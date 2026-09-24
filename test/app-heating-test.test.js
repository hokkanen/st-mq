import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { Executor } from '../src/app/executor.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';

function setup(t, { input = 'providers', commandTransport, mode = 'shadow' } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { input, settings: validateSettings({ mode }) };
  if (commandTransport) commandTransport.targetIdentity = { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) };
  const engine = new Engine({ store, config, commandTransport, clock: () => Date.parse('2026-09-07T12:00Z') });
  t.after(() => { clearTimeout(engine.executor.timer); engine.executor.closed = true; });
  return { engine, store, config };
}

test('paused manual heating selections use the executor and preserve the automatic schedule, occupancy and learned parameters', async t => {
  const commands = [], switches = [];
  const commandTransport = { publish: async batch => { commands.push(batch); return { status: 'mqtt', sent: true, actual: null }; },
    publishDhwr: async on => { switches.push(on); return { status: 'mqtt', sent: true, actual: null }; } };
  const { engine, store, config } = setup(t, { commandTransport });
  engine.setTemporary({ awayUntilLocal: '2026-09-09T12:00', pauseUntilLocal: '2026-09-08T12:00' });
  const before = engine.status();
  const checkpoint = store.getState('controller:providers:shadow');
  const parameters = structuredClone(engine.checkpoint.model.parameters);
  const execute = engine.executor.execute.bind(engine.executor), calls = [];
  engine.executor.execute = (decision, options) => { calls.push({ decision, options }); return execute(decision, options); };
  for (const command of ['reduction', 'normal', 'circulation']) {
    const result = await engine.testHeating({ command });
    assert.equal(result.command, command); assert.equal(result.status, 'mqtt');
    assert.equal(result.sent, true); assert.equal(result.actual, null); assert.equal(result.at, engine.clock());
    if (command !== 'circulation') {
      assert.equal(result.phase, command === 'reduction' ? 'reduction' : 'normal');
      assert.equal(result.physicalStateVerified, false);
      assert.equal(result.expiresAt, before.override.expiresAt);
      assert.equal(result.holdUntil, before.override.expiresAt);
    }
    assert.deepEqual(calls.at(-1).decision.commands, [command]);
    assert.equal(calls.at(-1).options.manualTest, true);
  }
  assert.deepEqual(commands, [['reduction'], ['normal']]);
  assert.deepEqual(switches, [true]);
  const after = engine.status();
  assert.equal(after.liveWrites, false, 'Automatic physical control remains disabled');
  assert.equal(after.observations.actual.mode, 'normal');
  assert.equal(after.observations.actual.verified, false);
  assert.equal(after.observations.actual.source, 'mqtt-request');
  for (const field of ['settings', 'override', 'execution']) assert.deepEqual(after[field], before[field]);
  const { manualHold, ...automaticDecision } = after.decision;
  assert.deepEqual(automaticDecision, before.decision);
  assert.equal(manualHold.until, before.override.expiresAt);
  assert.deepEqual(engine.checkpoint.model.parameters, parameters);
  assert.deepEqual(store.getState('controller:providers:shadow'), checkpoint);
  assert.equal(store.events().filter(event => event.type === 'heating-test-sent').length, 3);
  assert.equal(store.events().filter(event => event.type === 'decision').length, 1);
  const restarted = new Engine({ store, config, commandTransport, clock: engine.clock });
  t.after(() => { clearTimeout(restarted.executor.timer); restarted.executor.closed = true; });
  assert.equal(restarted.status().heatingTests.lastResult.command, 'circulation');
  await restarted.dispatchPending;
  assert.equal(commands.length, 2, 'Startup and normal ticks do not replay manual commands');
  assert.deepEqual(switches, [true, false], 'Restart restores the outstanding circulation run');
});

test('manual MQTT tests require live input, exact commands and a configured transport', async t => {
  let publishes = 0;
  const commandTransport = { publish: () => { publishes++; } };
  for (const input of ['offline', 'simulated']) {
    const { engine } = setup(t, { input, commandTransport });
    assert.equal(engine.status().heatingTests.available, false);
    await assert.rejects(engine.testHeating({ command: 'reduction' }), /unavailable/);
  }
  const { engine: disconnected } = setup(t);
  assert.equal(disconnected.status().heatingTests.available, false);
  await assert.rejects(disconnected.testHeating({ command: 'reduction' }), /Configure an MQTT broker/);
  const { engine, store } = setup(t, { commandTransport });
  for (const body of [null, [], {}, { command: 'unknown' }, { command: ['reduction'] },
    { command: 'reduction', topic: 'arbitrary/device' }, { command: 'reduction', retain: true }]) {
    await assert.rejects(engine.testHeating(body), /Choose Normal heating, Max preheating, Reduced heating or hot-water circulation/);
  }
  assert.equal(publishes, 0);
  assert.equal(store.events().filter(event => event.type.startsWith('heating-test')).length, 0);
});

test('pending tests cannot overlap and failed tests are recorded without exposing transport details', async t => {
  let rejectPublish;
  const commandTransport = { publish: () => new Promise((resolve, reject) => { rejectPublish = reject; }) };
  const { engine, store } = setup(t, { commandTransport });
  engine.tick(); await engine.dispatchPending;
  const pending = engine.testHeating({ command: 'reduction' });
  await assert.rejects(engine.testHeating({ command: 'normal' }), /already in progress/);
  rejectPublish(new Error('synthetic-private-broker-password'));
  await assert.rejects(pending, /Delivery is unconfirmed/);
  const result = engine.status().heatingTests.lastResult;
  assert.equal(result.status, 'failed');
  assert.equal(result.sent, false);
  assert.equal(result.actual, null);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-password'), false);
  assert.equal(engine.executor.status().restorationPending, true);
  commandTransport.publish = async () => ({ status: 'mqtt', sent: true, actual: null });
  await engine.executor.restore();
  commandTransport.publish = async () => { throw Object.assign(new Error('synthetic-private-broker-password'), { code: 'MQTT_TIMEOUT' }); };
  await assert.rejects(engine.testHeating({ command: 'normal' }), /acknowledgement timed out/);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-password'), false);
  commandTransport.publish = async () => ({ status: 'mqtt', sent: true, actual: null });
  await engine.executor.restore();
  commandTransport.publishDhwr = async () => { throw Object.assign(new Error('synthetic-private-broker-address'), { code: 'MQTT_NETWORK_UNREACHABLE' }); };
  await assert.rejects(engine.testHeating({ command: 'circulation' }), /unreachable from this server.*No command was sent/);
  assert.match(engine.status().heatingTests.lastResult.error, /unreachable from this server/);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-address'), false);
  commandTransport.publishDhwr = async () => ({ status: 'mqtt', sent: true, actual: null });
  await engine.executor.restore();
  assert.equal(engine.executor.status().restorationPending, false);
  assert.equal((await engine.testHeating({ command: 'normal' })).sent, true);
});

test('physical writes require active mode while shadow and monitoring remain observational', async t => {
  const { store } = setup(t);
  const commands = [];
  const executor = new Executor({ input: 'mqtt', store, clock: () => 0, commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) }, publish: async batch => {
    commands.push(batch); return { status: 'mqtt', sent: true, actual: null };
  } } });
  t.after(() => { clearTimeout(executor.timer); executor.closed = true; });
  for (const mode of ['monitoring', 'shadow']) assert.equal(executor.execute({ commands: ['reduction'] }, { mode, now: 0 }).sent, false);
  assert.equal(commands.length, 0);
  assert.equal((await executor.execute({ commands: ['reduction'] }, { mode: 'active', now: 0 })).sent, true);
  assert.deepEqual(commands, [['reduction']]);
});

test('heating test API authenticates, validates same-origin JSON and waits for publish acknowledgement', async t => {
  let acknowledge;
  const commandTransport = { publish: () => new Promise(resolve => { acknowledge = resolve; }) };
  const { engine, store } = setup(t, { commandTransport });
  const token = 'synthetic-test-access-token-24';
  const server = createAppServer({ engine, store, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/heating-test`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = overrides => fetch(endpoint, { method: 'POST', headers, body: '{"command":"reduction"}', ...overrides });
  assert.equal((await post({ headers: {} })).status, 401);
  assert.equal((await post({ headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await post({ headers: { Authorization: headers.Authorization } })).status, 400);
  assert.equal((await post({ body: '{"command":"unknown"}' })).status, 400);
  assert.equal(acknowledge, undefined);
  const response = post();
  for (let i = 0; !acknowledge && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof acknowledge, 'function');
  assert.equal(store.events().some(event => event.type === 'heating-test-sent'), false);
  acknowledge({ status: 'mqtt', sent: true, actual: null });
  const success = await response;
  assert.equal(success.status, 200);
  assert.equal((await success.json()).sent, true);
  commandTransport.publish = async () => { throw new Error('synthetic-private-broker'); };
  const failure = await post();
  assert.equal(failure.status, 400);
  assert.match((await failure.json()).error, /unconfirmed/);
});

for (const mode of ['shadow', 'monitoring']) test(`restart in ${mode} restores a saved DHWR run without a new ON`, async t => {
  const switches = [];
  const commandTransport = { async publish() { return { status: 'mqtt', sent: true, actual: null }; },
    async publishDhwr(on) { switches.push(on); return { status: 'mqtt', sent: true, actual: null }; } };
  const { engine, store, config } = setup(t, { commandTransport, mode });
  await engine.testHeating({ command: 'circulation' });
  assert.equal(store.getState('executor:home').dhwrOutstanding, true);
  clearTimeout(engine.executor.timer); engine.executor.closed = true;
  const restarted = new Engine({ store, config, commandTransport, clock: engine.clock });
  t.after(() => { clearTimeout(restarted.executor.timer); restarted.executor.closed = true; });
  restarted.tick(); await restarted.dispatchPending;
  assert.deepEqual(switches, [true, false]);
  assert.equal(store.getState('executor:home').dhwrOutstanding, false);
  restarted.tick(); await restarted.dispatchPending;
  assert.deepEqual(switches, [true, false]);
});

test('leaving active mode stops an outstanding DHWR switch run', async t => {
  const switches = [];
  const commandTransport = { async publish() { return { status: 'mqtt', sent: true, actual: null }; },
    async publishDhwr(on) { switches.push(on); return { status: 'mqtt', sent: true, actual: null }; } };
  const { engine, store } = setup(t, { commandTransport, mode: 'active' });
  await engine.testHeating({ command: 'circulation' });
  engine.updateSettings({ ...engine.settings, mode: 'shadow' });
  await engine.dispatchPending;
  assert.deepEqual(switches, [true, false]);
  assert.equal(store.getState('executor:home').dhwrOutstanding, false);
  assert.equal(engine.settings.mode, 'shadow');
});
