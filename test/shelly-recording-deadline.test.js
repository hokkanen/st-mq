import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { heatingErrorMessage } from '../src/domain/heating-errors.js';

const START = Date.parse('2026-10-16T08:00:00Z'), DEVICE = 'recording-deadline-fixture';
const TIMEOUT = 1000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = performance.now() + 3000;
  while (!predicate()) { assert.ok(performance.now() < end, 'The real-writer relay boundary did not settle'); await delay(5); }
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-deadline-'));
  const store = new Store(join(directory, 'recording.sqlite'));
  const config = { input: 'mqtt', deviceId: DEVICE, h66: { writeEnabled: true, readbackTimeoutMs: TIMEOUT },
    garage: { enabled: false }, connections: { mqtt: { address: 'mqtt://fixture.invalid' },
      equipment: equipmentConfiguration({ devices: [{ id: 'relay', kind: 'switch',
        connection: 'shelly:fixture-relay', generation: 3, switch_control: true }] }) } };
  let now = START, authority = true, acquisition, reader;
  const engine = new Engine({ store, config, clock: () => now });
  const client = new EventEmitter(), commands = [], gates = [], actions = new Set();
  client.subscribe = (_topic, _options, callback) => callback();
  client.publish = (topic, payload, options, callback) => {
    assert.equal(Object.hasOwn(options, 'onRecordingBlocked'), false, 'The local reporting callback must never enter MQTT options');
    commands.push({ topic, payload: String(payload) }); callback();
  };
  client.end = (_force, _options, callback) => callback();
  t.after(async () => {
    authority = false;
    acquisition?.revoke();
    for (const gate of gates) gate.release();
    const failures = [];
    for (const close of [() => Promise.allSettled([...actions]), () => acquisition?.close({ restore: false }),
      () => engine.garage.close({ restore: false }), () => engine.charging.close(),
      () => engine.closeFireplace(), () => engine.executor.close({ restore: false }),
      () => reader?.close(), () => store.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (store.writer) try { assert.equal(await store.writer.exitPromise, 0); } catch (error) { failures.push(error); }
    if (!failures.length) rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'Every real writer, cache, reader and acquisition owner must close');
  });
  await store.startWriter();
  reader = new DatabaseSync(store.path, { readOnly: true });
  acquisition = await startMqtt({ engine, store, config, connect: () => client, canControl: () => authority });
  const requests = method => commands.filter(row => row.topic === 'fixture-relay/rpc')
    .map(row => JSON.parse(row.payload)).filter(row => row.method === method);
  const reply = (method, result) => {
    const request = requests(method).at(-1); assert.ok(request, `Expected current ${method}`);
    client.emit('message', `${request.src}/rpc`, Buffer.from(JSON.stringify({
      id: request.id, src: 'fixture-relay', dst: request.src, result,
    })), {});
  };
  const send = value => { now++; client.emit('message', `${DEVICE}/HP/0203`, Buffer.from(String(value)), {}); };
  client.emit('connect');
  await until(() => requests('Shelly.GetDeviceInfo').length > 0);
  reply('Shelly.GetDeviceInfo', { id: 'fixture-relay', gen: 3 });
  await store.whenWritesSettled();
  await until(() => requests('Shelly.GetStatus').length > 0);
  reply('Shelly.GetStatus', { 'switch:0': { id: 0, output: false } });
  send(20);
  await until(() => acquisition.equipment.status().devices.find(row => row.id === 'relay')?.available && store.canDispatch());
  await store.whenWritesSettled();
  const track = promise => { actions.add(promise); promise.finally(() => actions.delete(promise)).catch(() => {}); return promise; };
  return { store, acquisition, requests, reply, send,
    savedRows: () => reader.prepare('SELECT count(*) AS n FROM observations').get().n,
    commandsNotSent: () => store.writeHealth.status().history.windows.day.commandsNotSent,
    command(options = {}) {
      return track(acquisition.equipment.setSwitch('relay', true, options).then(value => ({ value }), error => ({ error })));
    },
    holdNextCommit({ fail = false, select = () => true } = {}) {
      const request = store.writer.request.bind(store.writer); let entered = false, release;
      const barrier = new Promise(resolve => { release = resolve; });
      store.writer.request = async (method, ...args) => {
        if (method === 'commit' && !entered && select()) {
          entered = true; await barrier;
          if (fail) throw Object.assign(new Error('Synthetic rejected observation COMMIT'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
        }
        return request(method, ...args);
      };
      const gate = { get entered() { return entered; }, release }; gates.push(gate); return gate;
    },
    ownTransaction(action) { return track(store.runWrite(action)); },
    revoke() { authority = false; acquisition.revoke(); },
  };
}

test('real ingress COMMIT deadline reports known-unsent storage and a new command can later confirm', async t => {
  const f = await fixture(t), before = f.savedRows(), gate = f.holdNextCommit();
  f.send(21); await until(() => gate.entered);
  assert.equal(f.store.writePending, true); assert.equal(f.savedRows(), before);
  const outcome = await f.command();
  assert.equal(outcome.error?.code, 'MQTT_STORAGE_PENDING');
  assert.equal(outcome.error.message, heatingErrorMessage('MQTT_STORAGE_PENDING'));
  assert.equal(f.requests('Switch.Set').length, 0); assert.equal(f.commandsNotSent(), 1);
  gate.release(); await f.store.whenWritesSettled(); await until(() => f.store.canDispatch()); await delay(10);
  assert.equal(f.requests('Switch.Set').length, 0, 'Saving the original observation cannot replay the expired command');
  assert.ok(f.savedRows() > before);
  const next = f.command(); await until(() => f.requests('Switch.Set').length === 1);
  f.reply('Switch.Set', { was_on: false });
  await until(() => f.requests('Switch.GetStatus').length === 1);
  f.reply('Switch.GetStatus', { id: 0, output: true });
  assert.equal((await next).value?.confirmed, true);
  assert.equal(f.commandsNotSent(), 1, 'Later success neither repeats nor erases the known-unsent attempt');
});

test('a dispatched relay with no current readback retains delivery uncertainty', async t => {
  const f = await fixture(t), pending = f.command();
  await until(() => f.requests('Switch.Set').length === 1);
  const outcome = await pending;
  assert.equal(outcome.error?.code, 'SHELLY_READBACK_TIMEOUT');
  assert.equal(f.commandsNotSent(), 0);
});

test('a publisher deferred until COMMIT still completes at the original deadline without late dispatch', async t => {
  let action, outcome;
  const f = await fixture(t), gate = f.holdNextCommit({ select: () => action !== undefined });
  const transaction = f.ownTransaction(() => { action = f.command(); action.then(value => { outcome = value; }); });
  await until(() => gate.entered);
  assert.ok(action, 'The held COMMIT must belong to the transaction that created this command');
  await until(() => outcome !== undefined);
  assert.equal(outcome.error?.code, 'SHELLY_READBACK_TIMEOUT', 'No publisher exists yet to witness a storage cause');
  assert.equal(f.requests('Switch.Set').length, 0); assert.equal(f.commandsNotSent(), 0);
  assert.equal(f.store.writePending, true, 'The request must complete while its publication COMMIT is still held');
  gate.release(); await transaction; await action; await f.store.whenWritesSettled(); await delay(10);
  assert.equal(f.requests('Switch.Set').length, 0, 'Deferred publisher must observe the original cancellation after COMMIT');
  assert.equal(f.commandsNotSent(), 0);
});

test('authority revocation during recording wait is not reported as a storage deadline', async t => {
  const f = await fixture(t), gate = f.holdNextCommit();
  f.send(21); await until(() => gate.entered);
  const pending = f.command(); await delay(10); f.revoke();
  const outcome = await pending;
  assert.ok(outcome.error); assert.notEqual(outcome.error.code, 'MQTT_STORAGE_PENDING');
  assert.notEqual(outcome.error.code, 'MQTT_STORAGE_FAILED'); assert.equal(f.commandsNotSent(), 0);
  gate.release(); await f.store.whenWritesSettled();
  assert.equal(f.requests('Switch.Set').length, 0);
});

test('caller expiry after recording resumes retains its own preflight refusal', async t => {
  const f = await fixture(t), gate = f.holdNextCommit();
  f.send(21); await until(() => gate.entered);
  const pending = f.command({ beforePublish: () => { throw Object.assign(new Error('Synthetic scoped action expired'), { code: 'EXECUTOR_EXPIRED' }); } });
  gate.release(); const outcome = await pending;
  assert.equal(outcome.error?.code, 'EXECUTOR_EXPIRED');
  assert.equal(f.commandsNotSent(), 0); assert.equal(f.requests('Switch.Set').length, 0);
});

test('a rejected real observation COMMIT keeps the existing known-unsent storage failure', async t => {
  const f = await fixture(t), before = f.savedRows(), gate = f.holdNextCommit({ fail: true });
  f.send(21); await until(() => gate.entered);
  const pending = f.command(); gate.release(); const outcome = await pending;
  assert.equal(outcome.error?.code, 'MQTT_STORAGE_FAILED');
  assert.equal(f.savedRows(), before); assert.equal(f.requests('Switch.Set').length, 0);
  assert.equal(f.commandsNotSent(), 1);
});
