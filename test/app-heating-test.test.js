import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { Executor } from '../src/app/executor.js';
import { createAppServer } from '../src/app/server.js';
import { validateSettings } from '../src/app/config.js';

function setup(t, { input = 'providers', commandTransport } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = { input, settings: validateSettings() };
  const engine = new Engine({ store, config, commandTransport, clock: () => Date.parse('2026-09-07T12:00Z') });
  return { engine, store, config };
}

test('manual heating tests use the normal executor without replacing decisions, occupancy or learned state', async t => {
  const commands = [];
  const commandTransport = { publish: async batch => { commands.push(batch); return { status: 'mqtt', sent: true, actual: null }; } };
  const { engine, store, config } = setup(t, { commandTransport });
  engine.setTemporary({ awayUntilLocal: '2026-09-09T12:00', pauseUntilLocal: '2026-09-08T12:00' });
  const before = engine.status();
  const checkpoint = store.getState('controller:providers:shadow');
  const execute = engine.executor.execute.bind(engine.executor), calls = [];
  engine.executor.execute = (decision, options) => { calls.push({ decision, options }); return execute(decision, options); };
  for (const command of ['heatoff', 'heaton15', 'heaton60']) {
    const result = await engine.testHeating({ command });
    assert.deepEqual(result, { command, status: 'mqtt', sent: true, actual: null, at: engine.clock() });
    assert.deepEqual(calls.at(-1).decision.commands, [command]);
    assert.equal(calls.at(-1).options.manualTest, true);
  }
  assert.deepEqual(commands, [['heatoff'], ['heaton15'], ['heaton60']]);
  const after = engine.status();
  assert.equal(after.liveWrites, false, 'Automatic physical control remains disabled');
  assert.equal(after.observations.actual.mode, 'unknown');
  for (const field of ['settings', 'override', 'decision', 'execution']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(store.getState('controller:providers:shadow'), checkpoint);
  assert.equal(store.events().filter(event => event.type === 'heating-test-sent').length, 3);
  assert.equal(store.events().filter(event => event.type === 'decision').length, 1);
  const restarted = new Engine({ store, config, commandTransport, clock: engine.clock });
  assert.equal(restarted.status().heatingTests.lastResult.command, 'heaton60');
  assert.equal(commands.length, 3, 'Startup and normal ticks do not replay manual commands');
});

test('manual MQTT tests require live input, exact commands and a configured transport', async t => {
  let publishes = 0;
  const commandTransport = { publish: () => { publishes++; } };
  for (const input of ['offline', 'simulated']) {
    const { engine } = setup(t, { input, commandTransport });
    assert.equal(engine.status().heatingTests.available, false);
    await assert.rejects(engine.testHeating({ command: 'heatoff' }), /unavailable/);
  }
  const { engine: disconnected } = setup(t);
  assert.equal(disconnected.status().heatingTests.available, false);
  await assert.rejects(disconnected.testHeating({ command: 'heatoff' }), /Configure an MQTT broker/);
  const { engine, store } = setup(t, { commandTransport });
  for (const body of [null, [], {}, { command: 'unknown' }, { command: ['heatoff'] },
    { command: 'heatoff', topic: 'arbitrary/device' }, { command: 'heatoff', retain: true }]) {
    await assert.rejects(engine.testHeating(body), /Choose heatoff/);
  }
  assert.equal(publishes, 0);
  assert.equal(store.events().filter(event => event.type.startsWith('heating-test')).length, 0);
});

test('pending tests cannot overlap and failed tests are recorded without exposing transport details', async t => {
  let rejectPublish;
  const commandTransport = { publish: () => new Promise((resolve, reject) => { rejectPublish = reject; }) };
  const { engine, store } = setup(t, { commandTransport });
  const pending = engine.testHeating({ command: 'heatoff' });
  await assert.rejects(engine.testHeating({ command: 'heaton15' }), /already in progress/);
  rejectPublish(new Error('synthetic-private-broker-password'));
  await assert.rejects(pending, /Delivery is unconfirmed/);
  const result = engine.status().heatingTests.lastResult;
  assert.equal(result.status, 'failed');
  assert.equal(result.sent, false);
  assert.equal(result.actual, null);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-password'), false);
  commandTransport.publish = async () => { throw Object.assign(new Error('synthetic-private-broker-password'), { code: 'MQTT_TIMEOUT' }); };
  await assert.rejects(engine.testHeating({ command: 'heaton15' }), /acknowledgement timed out/);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-password'), false);
  commandTransport.publish = async () => { throw Object.assign(new Error('synthetic-private-broker-address'), { code: 'MQTT_NETWORK_UNREACHABLE' }); };
  await assert.rejects(engine.testHeating({ command: 'heaton60' }), /unreachable from this server.*No command was sent/);
  assert.match(engine.status().heatingTests.lastResult.error, /unreachable from this server/);
  assert.equal(JSON.stringify(store.events()).includes('synthetic-private-broker-address'), false);
  commandTransport.publish = async () => ({ status: 'mqtt', sent: true, actual: null });
  assert.equal((await engine.testHeating({ command: 'heaton15' })).sent, true);
});

test('a physical transport never enables automatic active, shadow or monitoring writes', t => {
  const { store } = setup(t);
  const executor = new Executor({ input: 'mqtt', store, commandTransport: { publish: () => assert.fail('Unexpected physical publish') } });
  for (const mode of ['monitoring', 'shadow']) assert.equal(executor.execute({ commands: ['heatoff'] }, { mode, now: 0 }).sent, false);
  assert.throws(() => executor.execute({ commands: ['heatoff'] }, { mode: 'active', now: 0 }), /not commissioned/);
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
  const post = overrides => fetch(endpoint, { method: 'POST', headers, body: '{"command":"heatoff"}', ...overrides });
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
