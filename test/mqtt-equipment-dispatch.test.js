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

const START = Date.parse('2026-10-10T10:00:00Z');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'The isolated MQTT fixture did not settle');
    await delay(5);
  }
}

async function fixture(t, { timeoutMs = 1000, switchState = false, doorState = 'closed', publicationMode = 'acknowledge' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-equipment-dispatch-'));
  const store = new Store(join(directory, 'recording.sqlite')), writer = new DatabaseSync(store.path);
  let now = START, locked = false, authority = true;
  const settings = equipmentConfiguration({ devices: [
    { id: 'door', kind: 'door', connection: 'mqtt:fixture/door/state', cover_control: true,
      mqtt: { command_topic: 'fixture/door/set', open_payload: 'open', close_payload: 'closed', stop_payload: 'stop',
        state_path: 'value', timestamp_path: 'timestamp', cover_state_path: 'cover_state', availability_topic: 'fixture/door/online' } },
    { id: 'switch', kind: 'switch', connection: 'mqtt:fixture/switch/state', switch_control: true,
      mqtt: { command_topic: 'fixture/switch/set', on_payload: 'ON', off_payload: 'OFF',
        state_path: 'value', timestamp_path: 'timestamp', availability_topic: 'fixture/switch/online' } },
    { id: 'unrelated', kind: 'power', connection: 'mqtt:fixture/unrelated/power' },
  ] });
  const engine = { clock: () => now, ingest: row => store.setState(`fixture:${row.device}:${row.signal}`, row) };
  const client = new EventEmitter(), commands = [], acknowledgements = [];
  client.subscribe = (topic, options, done) => done(null, [{ topic, qos: 1 }]);
  client.publish = (topic, payload, options, done) => {
    commands.push({ topic, payload, options }); acknowledgements.push(done);
    if (publicationMode === 'fail') done(new Error('invented-private-broker-detail'));
    else if (publicationMode === 'acknowledge') done();
  };
  client.end = (force, options, done) => done();
  const reader = await startMqtt({ engine, store,
    config: { h66: { readbackTimeoutMs: timeoutMs }, connections: { equipment: settings, mqtt: { address: 'mqtt://fixture.invalid' } } },
    connect: () => client, canControl: () => authority, reportStorageFailure: () => {} });
  t.after(async () => {
    if (locked) { writer.exec('ROLLBACK'); locked = false; }
    await reader.close({ restore: false });
    writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const send = (topic, payload) => client.emit('message', topic, Buffer.from(typeof payload === 'object' ? JSON.stringify(payload) : String(payload)), {});
  const reportDoor = (state = 'closed') => send('fixture/door/state', {
    value: state === 'closed' ? 'closed' : 'open', cover_state: state, timestamp: new Date(now).toISOString(),
  });
  const reportSwitch = on => send('fixture/switch/state', { value: on, timestamp: new Date(now).toISOString() });
  client.emit('connect');
  reportDoor(doorState); send('fixture/door/online', 'online');
  reportSwitch(switchState); send('fixture/switch/online', 'online');
  send('fixture/unrelated/power', 10);
  await until(() => reader.status().brokers.primary.ready && store.writeQueueStatus().pending === 0);
  const status = id => reader.equipment.status().devices.find(device => device.id === id);
  assert.equal(status('door').cover.available, true);
  assert.equal(status('switch').available, true);
  return { store, reader, client, commands, send, reportDoor, reportSwitch, status,
    acknowledge: () => acknowledgements.shift()?.(),
    at: at => { now = at; }, authority: value => { authority = value; },
    lock() { writer.exec('BEGIN IMMEDIATE'); locked = true; },
    unlock() { writer.exec('ROLLBACK'); locked = false; },
    backlog() { writer.exec('BEGIN IMMEDIATE'); locked = true; now += 1000; send('fixture/unrelated/power', 20); },
    mutations: id => commands.filter(row => row.topic === `fixture/${id}/set`),
    command: id => id === 'door' ? reader.equipment.setCover({ deviceId: 'door', action: 'open' }) : reader.equipment.setSwitch('switch', true),
  };
}

function failNextCommit(store) {
  const transaction = store._transaction.bind(store); let armed = true;
  store._transaction = (action, admission) => admission && armed ? transaction(() => {
    armed = false; action(); throw new Error('synthetic recording failure with private detail');
  }, admission) : transaction(action, admission);
}

test('a door waits for unrelated recording, sends once and requires committed terminal feedback', async t => {
  const f = await fixture(t); f.backlog();
  let outcome;
  const pending = f.command('door').then(value => { outcome = value; }, error => { outcome = error; });
  await delay(30);
  assert.equal(outcome, undefined, 'A temporary recording backlog must delay this valid door request');
  assert.equal(f.status('door').cover.available, true);
  assert.equal(f.mutations('door').length, 0);
  f.unlock(); await pending;
  assert.equal(outcome.confirmed, false, 'A broker acknowledgement does not establish door movement');
  assert.equal(f.status('door').cover.operation.status, 'published');
  assert.deepEqual(f.mutations('door'), [{ topic: 'fixture/door/set', payload: 'open', options: { qos: 1, retain: false } }]);
  f.at(START + 2000); f.lock(); f.reportDoor('open'); await delay(30);
  assert.equal(f.status('door').cover.operation.status, 'published', 'Uncommitted feedback cannot confirm movement');
  f.unlock(); await until(() => f.status('door').cover.operation.status === 'observed');
  assert.equal(f.mutations('door').length, 1);
});

test('a switch waits for recording and only a committed report after dispatch can confirm it', async t => {
  const f = await fixture(t, { switchState: true }); f.backlog();
  f.reportSwitch(true);
  let outcome;
  const pending = f.command('switch').then(value => { outcome = value; }, error => { outcome = error; });
  await delay(30);
  assert.equal(outcome, undefined, 'A temporary recording backlog must delay this valid switch request');
  assert.equal(f.mutations('switch').length, 0);
  f.unlock(); await until(() => f.mutations('switch').length === 1); await delay(20);
  assert.equal(outcome, undefined, 'A matching report received before dispatch is not command confirmation');
  assert.deepEqual(f.mutations('switch'), [{ topic: 'fixture/switch/set', payload: 'ON', options: { qos: 1, retain: false } }]);
  f.at(START + 2000); f.lock(); f.reportSwitch(true); await delay(30);
  assert.equal(outcome, undefined, 'Post-dispatch feedback must also commit before confirmation');
  f.unlock(); await pending;
  assert.equal(outcome.confirmed, true);
  assert.equal(f.mutations('switch').length, 1);
});

for (const device of ['door', 'switch']) for (const interruption of ['timeout', 'expiry', 'authority', 'revocation', 'reconnect', 'shutdown', 'device-offline', 'recording-failure']) {
  test(`waiting ${device} rejects ${interruption} without a command after storage recovers`, async t => {
    const f = await fixture(t, { timeoutMs: interruption === 'timeout' ? 100 : 1000 }); f.backlog();
    let settled = false, failure;
    const rejected = assert.rejects(f.command(device), error => {
      failure = error;
      const code = interruption === 'timeout' ? 'EQUIPMENT_COMMAND_WAIT_EXPIRED'
        : interruption === 'recording-failure' ? 'EQUIPMENT_COMMAND_RECORDING_FAILED' : 'EQUIPMENT_COMMAND_CANCELLED';
      assert.equal(error.code, code); assert.equal(error.sent, false); assert.equal(error.statusCode, 409);
      assert.match(error.message, /request was not sent/i); assert.doesNotMatch(error.message, /private detail/);
      return true;
    }).then(() => { settled = true; });
    await delay(20);
    assert.equal(settled, false, 'The valid request must first wait for the temporary recording backlog');
    assert.equal(f.mutations(device).length, 0);
    if (interruption === 'timeout') await rejected;
    if (interruption === 'expiry') f.at(START + 2000);
    if (interruption === 'authority') f.authority(false);
    if (interruption === 'revocation') { f.reader.revoke(); await rejected; }
    if (interruption === 'reconnect') { f.client.emit('offline'); f.client.emit('connect'); }
    if (interruption === 'shutdown') await f.reader.close({ restore: false });
    if (interruption === 'device-offline') f.send(`fixture/${device}/online`, 'offline');
    if (interruption === 'recording-failure') failNextCommit(f.store);
    f.unlock(); await rejected; await until(() => f.store.writeQueueStatus().pending === 0); await delay(20);
    assert.equal(f.mutations(device).length, 0, 'An obsolete request cannot be dispatched when storage recovers');
    if (device === 'door') {
      const operation = f.status(device).cover.operation;
      assert.equal(operation.status, 'failed'); assert.equal(operation.code, failure.code);
      assert.equal(operation.error, failure.message); assert.equal(operation.dispatchedAt, undefined);
      assert.equal(operation.observedAt, undefined);
    }
  });
}

for (const device of ['door', 'switch']) for (const publicationMode of ['fail', 'hold']) {
  test(`a ${device} failure after dispatch (${publicationMode}) remains uncertain and is never retried`, async t => {
    const f = await fixture(t, { timeoutMs: 100, publicationMode });
    await assert.rejects(f.command(device), error => {
      assert.equal(error.code, undefined); assert.notEqual(error.sent, false);
      assert.match(error.message, /unconfirmed/); assert.doesNotMatch(error.message, /invented-private/);
      return true;
    });
    assert.equal(f.mutations(device).length, 1);
    if (device === 'door') {
      const operation = f.status(device).cover.operation;
      assert.equal(operation.status, 'unconfirmed'); assert.equal(operation.code, undefined);
      assert.equal(operation.dispatchedAt, START); assert.equal(operation.observedAt, undefined);
    }
    f.client.emit('offline'); f.client.emit('connect');
    f.at(START + 1000); f.reportDoor(); f.reportSwitch(false);
    await until(() => f.store.writeQueueStatus().pending === 0);
    assert.equal(f.mutations(device).length, 1);
  });
}

test('a matching door report received before dispatch cannot confirm the later request', async t => {
  const f = await fixture(t, { doorState: 'open' }); f.backlog(); f.reportDoor('open');
  let outcome;
  const pending = f.command('door').then(value => { outcome = value; }, error => { outcome = error; });
  await delay(20); assert.equal(outcome, undefined);
  assert.equal(f.status('door').cover.operation.observedAt, undefined);
  f.unlock(); await pending;
  assert.equal(outcome.confirmed, false); assert.equal(outcome.status, 'published');
  assert.equal(outcome.observedAt, undefined); assert.equal(f.mutations('door').length, 1);
  f.at(START + 2000); f.reportDoor('open');
  await until(() => f.status('door').cover.operation.status === 'observed');
});

test('rolled-back door readback cannot confirm a later broker acknowledgement', async t => {
  const f = await fixture(t, { publicationMode: 'hold' });
  let outcome;
  const pending = f.command('door').then(value => { outcome = value; }, error => { outcome = error; });
  await until(() => f.mutations('door').length === 1);
  f.at(START + 1000); failNextCommit(f.store); f.reportDoor('open');
  await delay(20);
  assert.equal(outcome, undefined);
  assert.equal(f.status('door').cover.operation.observedAt, undefined);
  assert.notEqual(f.status('door').cover.operation.status, 'observed');
  f.acknowledge(); await pending;
  assert.equal(outcome.confirmed, false); assert.notEqual(outcome.status, 'observed');
  assert.equal(outcome.observedAt, undefined); assert.equal(f.mutations('door').length, 1);
  assert.equal(f.status('door').cover.operation.status, outcome.status,
    'Rollback must preserve the operation that receives the later acknowledgement');
});

test('Stop supersedes an Open that is still waiting for recording', async t => {
  const f = await fixture(t); f.backlog();
  let settled = false;
  const opening = assert.rejects(f.command('door')).then(() => { settled = true; });
  await delay(20);
  assert.equal(settled, false);
  const stopping = f.reader.equipment.setCover({ deviceId: 'door', action: 'stop' });
  await opening;
  assert.equal(f.mutations('door').length, 0);
  f.at(START + 1500); f.reportDoor('opening');
  f.unlock(); const result = await stopping;
  assert.equal(result.action, 'stop');
  assert.equal(f.status('door').cover.operation.action, 'stop');
  assert.deepEqual(f.mutations('door').map(row => row.payload), ['stop']);
});

test('Stop cancels an older publication after preflight without letting its late acknowledgement replace Stop', async t => {
  const f = await fixture(t, { publicationMode: 'hold' });
  const opening = assert.rejects(f.command('door'), /unconfirmed/);
  await until(() => f.mutations('door').length === 1);
  const stopping = f.reader.equipment.setCover({ deviceId: 'door', action: 'stop' });
  await opening;
  assert.deepEqual(f.mutations('door').map(row => row.payload), ['open', 'stop']);
  f.acknowledge(); f.acknowledge();
  const result = await stopping;
  assert.equal(result.action, 'stop'); assert.equal(result.status, 'published');
  assert.equal(f.status('door').cover.operation.action, 'stop');
});

test('a door state change during recording wait cancels the older movement request', async t => {
  const f = await fixture(t); f.backlog();
  let settled = false;
  const rejected = assert.rejects(f.command('door')).then(() => { settled = true; });
  await delay(20); assert.equal(settled, false);
  f.at(START + 1500); f.reportDoor('opening');
  f.unlock(); await rejected; await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.status('door').cover.state, 'opening');
  assert.equal(f.mutations('door').length, 0, 'A movement requested against the previous door state must be cancelled');
});

test('a newer independent switch state cancels its waiting command', async t => {
  const f = await fixture(t); f.backlog();
  let settled = false;
  const rejected = assert.rejects(f.command('switch')).then(() => { settled = true; });
  await delay(20); assert.equal(settled, false);
  f.at(START + 1500); f.reportSwitch(true);
  f.unlock(); await rejected; await until(() => f.store.writeQueueStatus().pending === 0);
  assert.equal(f.status('switch').readings.switch_active.value, 1);
  assert.equal(f.mutations('switch').length, 0);
});

test('an unchanged door report while recording waits preserves the valid movement request', async t => {
  const f = await fixture(t); f.backlog();
  let outcome;
  const pending = f.command('door').then(value => { outcome = value; }, error => { outcome = error; });
  await delay(20); assert.equal(outcome, undefined);
  f.at(START + 1500); f.reportDoor('closed');
  f.unlock(); await pending;
  assert.equal(outcome.status, 'published');
  assert.equal(outcome.confirmed, false);
  assert.deepEqual(f.mutations('door').map(row => row.payload), ['open']);
});
