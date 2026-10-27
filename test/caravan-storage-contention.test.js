import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { CARAVAN_NATIVE_RESTART_DELAY_MS } from '../src/domain/caravan-power-timing.js';
import { testCompletionLimit } from '../scripts/lib/offline-test-profile.js';

const START = Date.parse('2026-10-09T10:00:00Z'), IDENTITY = 'a'.repeat(64);
const RESTORE_KEY = `equipment:caravan-probe-restoration:v1:caravan_dehumidifier:${IDENTITY}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = performance.now() + testCompletionLimit(3000);
  while (!predicate()) { assert.ok(performance.now() < deadline, 'Condition did not settle'); await delay(5); }
}

async function fixture(t, { locationCheck = true, holdSubscriptions = false, readbackTimeoutMs = 10_000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-caravan-contention-'));
  const store = new Store(join(directory, 'recording.sqlite')), writer = new DatabaseSync(store.path);
  const client = new EventEmitter(), commands = [], subscriptions = [];
  let now = locationCheck ? START - CARAVAN_NATIVE_RESTART_DELAY_MS : START, locked = false, authority = true, elapsed = 0;
  const advance = ms => { now += ms; elapsed += Math.max(0, ms); };
  const settings = equipmentConfiguration({ devices: [
    { id: 'blu_ht', kind: 'temperature', area: 'garage', connection: 'mqtt:fixture/air', signal: 'caravan_temperature',
      mqtt: { state_path: 'temperature', timestamp_path: 'timestamp' } },
    { id: 'caravan', kind: 'power', area: 'garage', connection: 'mqtt:fixture/power', record: false,
      max_age_seconds: 180, mqtt: { state_path: 'power', timestamp_path: 'timestamp' } },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/appliance',
      dehumidifier_control: true, ...(locationCheck ? { temperature_control: { sensor_device_id: 'blu_ht' } } : {}), max_age_seconds: 180,
      mqtt: { command_topic: 'fixture/appliance/set', timestamp_path: 'timestamp', availability_topic: 'fixture/appliance/online' } },
  ] });
  client.connected = true;
  client.subscribe = (topic, options, done) => {
    if (holdSubscriptions && topic === 'fixture/appliance') subscriptions.push(() => done(null, [{ topic, qos: 1 }]));
    else done(null, [{ topic, qos: 1 }]);
  };
  client.publish = (topic, payload, options, done) => {
    if (topic === 'fixture/appliance/set') commands.push(JSON.parse(payload));
    done();
  };
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ monotonicClock: () => elapsed, engine: { clock: () => now, ingest() {} }, store,
    connect: () => client, canControl: () => authority,
    config: { h66: { readbackTimeoutMs }, connections: { equipment: settings, mqtt: { address: 'mqtt://synthetic.invalid' } } } });
  t.after(async () => {
    if (locked) writer.exec('ROLLBACK');
    await acquisition.close({ restore: false });
    writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const report = (topic, value) => client.emit('message', topic, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), { retain: false });
  const appliance = (power = 'off', extra = {}) => report('fixture/appliance', { identity: IDENTITY, power,
    fanSpeed: 'low', targetHumidity: 50, timestamp: now, fieldTimestamps: { power: now, fanSpeed: now, targetHumidity: now },
    capabilities: { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'], targetHumidity: [50, 55] }, ...extra });
  const air = temperature => report('fixture/air', { temperature, timestamp: now });
  const meter = watts => report('fixture/power', { power: watts, timestamp: now });
  if (holdSubscriptions) await until(() => store.writeQueueStatus().pending === 0);
  report('fixture/appliance/online', 'online');
  if (!holdSubscriptions) {
  if (locationCheck) {
    appliance(); await until(() => store.writeQueueStatus().pending === 0);
    while (now < START) { advance(Math.min(60_000, START - now)); appliance(); await until(() => store.writeQueueStatus().pending === 0); }
  }
  air(1.5); appliance(); meter(100);
  await until(() => store.writeQueueStatus().pending === 0);
  if (locationCheck) { advance(30_000); air(1.5); appliance(); meter(100);
    await until(() => store.writeQueueStatus().pending === 0); }
  }
  return { store, acquisition, client, commands, report, appliance, air, meter,
    releaseSubscriptions() { assert.equal(subscriptions.length, 1); subscriptions.splice(0).forEach(done => done()); },
    now: () => now, advance, shiftWall: ms => { now += ms; }, elapsed: () => elapsed, authority: value => { authority = value; },
    lock() { writer.exec('BEGIN IMMEDIATE'); locked = true; },
    unlock() { writer.exec('ROLLBACK'); locked = false; },
    state: () => acquisition.equipment.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier };
}

test('Caravan power test survives a queued observation burst and confirms the complete power cycle', async t => {
  const f = await fixture(t);
  f.advance(5000); f.lock(); f.meter(100); f.appliance();
  await delay(30); assert.equal(f.commands.length, 0);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
  assert.deepEqual(f.commands.map(row => row.power), ['on']);
  assert.equal(f.state().temperatureControl.locationTest.status, 'testing');
  assert.equal(f.state().operation.status, 'published', 'Broker acknowledgement cannot confirm native On');
  assert.equal(f.store.getState(RESTORE_KEY).power, 'off');
  for (const [ms, power, watts] of [[1000, 'on', 105], [5000, 'on', 105], [1000, 'off', 100], [5000, 'off', 100]]) {
    f.advance(ms); f.appliance(power); f.meter(watts); await delay(0);
  }
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off']);
  assert.equal(f.state().temperatureControl.qualified, true);
  assert.equal(f.state().probeBusy, false);
  assert.equal(f.state().temperatureControl.canEdit, true);
  assert.equal(f.store.getState(RESTORE_KEY), null);
});

test('a delayed native setting needs a committed report received after actual dispatch', async t => {
  const f = await fixture(t, { locationCheck: false });
  f.advance(100); f.lock(); f.air(2);
  const pending = f.acquisition.equipment.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'targetHumidity', value: 50 });
  f.advance(100); f.appliance();
  await delay(30); assert.equal(f.commands.length, 0);
  f.unlock(); await pending;
  assert.equal(f.commands.length, 1);
  assert.equal(f.state().operation.status, 'published', 'A queued matching report predates actual dispatch');
  assert.equal(f.commands[0].requestedAt, START + 100);
  assert.equal(f.commands[0].expiresAt, START + 10_100, 'Storage waits never renew the original deadline');
  assert.equal(f.state().operation.dispatchedAt, START + 200);
  f.advance(1); f.lock(); f.appliance(); await delay(20);
  assert.equal(f.state().operation.status, 'published');
  f.unlock(); await until(() => f.state().operation.status === 'observed');
});

for (const interruption of ['authority', 'revocation', 'reconnect', 'deadline', 'shutdown', 'timeout', 'newer-setting', 'identity', 'capability', 'failed-save']) {
  test(`a waiting dehumidifier setting is cancelled on ${interruption}`, async t => {
    const f = await fixture(t, { locationCheck: false, readbackTimeoutMs: 500 });
    f.advance(100); f.lock(); f.air(2);
    const pending = f.acquisition.equipment.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'targetHumidity', value: 55 });
    const rejected = assert.rejects(pending);
    await delay(20); assert.equal(f.commands.length, 0);
    if (interruption === 'authority') f.authority(false);
    if (interruption === 'revocation') f.acquisition.revoke();
    if (interruption === 'reconnect') { f.client.emit('offline'); f.client.emit('connect'); }
    if (interruption === 'deadline') f.advance(500);
    if (interruption === 'shutdown') await f.acquisition.close({ restore: false });
    if (interruption === 'timeout') await rejected;
    if (interruption === 'newer-setting') { f.advance(1); f.appliance('off', { targetHumidity: 55 }); }
    if (interruption === 'identity') { f.advance(1); f.appliance('off', { identity: 'b'.repeat(64) }); }
    if (interruption === 'capability') { f.advance(1); f.appliance('off', { capabilities: { power: ['off', 'on'] } }); }
    if (interruption === 'failed-save') {
      const transaction = f.store._transaction.bind(f.store); let armed = true;
      f.store._transaction = (action, admission) => admission && armed ? transaction(() => {
        armed = false; action(); throw new Error('Synthetic observation commit failure');
      }, admission) : transaction(action, admission);
    }
    f.unlock(); await rejected;
    await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
    assert.equal(f.commands.length, 0, 'Cancelled native settings must not escape after storage recovery');
  });
}

test('a new external power choice cancels an unsent test and its captured restoration', async t => {
  const f = await fixture(t);
  f.advance(5000); f.lock(); f.meter(100); f.advance(1); f.appliance('on');
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.state().temperatureControl.locationTest.reason, 'power-changed-externally');
  assert.equal(f.state().probeBusy, false);
  assert.equal(f.store.getState(RESTORE_KEY), null);
  f.advance(1000); f.appliance('on'); f.meter(105); await delay(0);
  assert.equal(f.commands.length, 0, 'Restoration cannot overwrite the newer independent On');
});

test('a newly cold Caravan cancels a queued test On before it reaches the appliance', async t => {
  const f = await fixture(t);
  f.advance(5000); f.lock(); f.meter(100); f.air(0);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
  assert.equal(f.commands.some(row => row.power === 'on'), false);
  assert.equal(f.state().temperatureControl.locationTest.reason, 'cold');
});

test('invalid power while a test command waits cannot discharge the restoration obligation', async t => {
  const f = await fixture(t);
  f.advance(5000); f.lock(); f.meter(100); f.advance(1); f.appliance(null);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
  assert.equal(f.commands.length, 0);
  assert.equal(f.store.getState(RESTORE_KEY)?.power, 'off');
  assert.equal(f.state().probeBusy, true, 'Unknown power cannot prove restoration or a newer independent choice');
});

test('delayed test dispatch durably fences restoration and phase evidence at its actual send time', async t => {
  const f = await fixture(t);
  f.advance(5000); f.lock(); f.meter(100);
  const clockChange = f.store.runWrite(() => f.advance(100));
  f.appliance(); f.unlock(); await clockChange;
  await until(() => f.commands.length === 1);
  assert.equal(f.commands[0].requestedAt, START + 35_000);
  assert.equal(f.commands[0].expiresAt, START + 45_000);
  assert.equal(f.state().operation.dispatchedAt, START + 35_100);
  assert.equal(f.store.getState(RESTORE_KEY).lastCommandAt, START + 35_100);
  assert.equal(f.state().temperatureControl.locationTest.phase, 'on');
  assert.equal(f.state().temperatureControl.qualified, false);
});

test('a queued automatic Off is cancelled when fresh warm air restores On demand before dispatch', async t => {
  const f = await fixture(t);
  for (const [ms, power, watts] of [[5000, 'off', 100], [1000, 'on', 105], [5000, 'on', 105], [1000, 'off', 100], [5000, 'off', 100]]) {
    f.advance(ms); f.appliance(power); f.meter(watts); await delay(0);
  }
  assert.equal(f.state().temperatureControl.qualified, true);
  const restartAt = f.state().temperatureControl.powerRestartNotBefore;
  while (f.now() < restartAt) { f.advance(Math.min(60_000, restartAt - f.now())); f.appliance('off'); f.meter(100); await delay(0); }
  f.advance(1000); f.air(10); await delay(0);
  f.advance(1000); f.appliance('on'); await delay(0);
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
  f.advance(1000); f.lock(); f.air(0); f.advance(1); f.air(10);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0); await delay(0);
  assert.equal(f.state().temperatureControl.desiredPower, 'on');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});


test('queued native Off keeps the raw MQTT elapsed receipt instead of starting five minutes at writer admission', async t => {
  const f = await fixture(t);
  f.advance(1); f.appliance('on'); await until(() => f.store.writeQueueStatus().pending === 0);
  f.advance(1); f.lock(); const receipt = f.now(); f.appliance('off');
  f.advance(120_000); f.shiftWall(10_000);
  f.unlock(); await until(() => f.store.writeQueueStatus().pending === 0);
  const guard = f.state().temperatureControl;
  assert.equal(guard.restartWaiting, true);
  assert.equal(guard.powerRestartNotBefore, f.now() + 180_000,
    'Two physical minutes waiting for the writer count toward the original five-minute hold');
  const key = `equipment:caravan-power-timing:v1:caravan_dehumidifier:${IDENTITY}:${f.acquisition.equipment.signature('caravan_dehumidifier')}`;
  const saved = f.store.getState(key);
  assert.equal(saved.receivedAt, receipt); assert.equal(saved.admittedAt, f.now());
  assert.equal(saved.sourceAt, receipt);
});

test('SUBACK buffering carries the receipt point without granting pre-subscription native continuity', async t => {
  const f = await fixture(t, { holdSubscriptions: true });
  f.appliance('off'); await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.state().temperatureControl.powerRestartNotBefore, null);
  const receiptPoints = [], receive = f.acquisition.equipment.receive;
  t.mock.method(f.acquisition.equipment, 'receive', (...args) => { receiptPoints.push(args[6]); return receive(...args); });
  f.advance(120_000); f.shiftWall(10_000); f.releaseSubscriptions();
  await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(receiptPoints.length, 2); assert.equal(receiptPoints.every(point => point === 0), true, 'Buffer replay retains both raw receipt points');
  assert.equal(f.state().state.power, 'off', 'Buffered live Off is actually admitted');
  assert.equal(f.state().available, true, 'Buffered appliance remains fresh');
  const timing = f.store.getState(`equipment:caravan-power-timing:v1:caravan_dehumidifier:${IDENTITY}:${f.acquisition.equipment.signature('caravan_dehumidifier')}`);
  assert.ok(timing, 'Buffered Off establishes native timing');
  assert.equal(f.state().temperatureControl.powerRestartNotBefore, null,
    'Pre-subscription feedback cannot confirm current native continuity');
  f.advance(1); f.appliance('off'); await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.state().temperatureControl.powerRestartNotBefore, f.now() + 300_000,
    'The first current Off retains the existing fresh-connection confirmation rule');
  assert.equal(f.state().temperatureControl.restartWaiting, true);
  assert.deepEqual(f.commands, []);
});
