import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { isolatedGarageAdapter } from './helpers/garage-mqtt.js';
import { identityConnection, idleIdentityClient } from './helpers/identity-mqtt.js';
import { committedWrites } from './helpers/committed-status.js';

const INITIAL = Date.parse('2026-09-14T10:00:00Z');
const TOPIC = 'synthetic/startup-room';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function client({ deferRoom = false } = {}) {
  const mqtt = new EventEmitter();
  mqtt.room = []; mqtt.publications = []; mqtt.closed = false;
  mqtt.subscribe = (topic, _options, done) => {
    if (deferRoom && topic === TOPIC) mqtt.room.push(() => done(null, [{ topic, qos: 1 }]));
    else done(null, [{ topic, qos: 1 }]);
  };
  mqtt.publish = (topic, payload, _options, done) => { mqtt.publications.push({ topic, payload }); done?.(); };
  mqtt.end = (_force, _options, done) => { mqtt.closed = true; mqtt.emit('close'); done?.(); };
  return mqtt;
}
function providers(onConstruct = () => {}) {
  return { automatic: false, http: { json() { throw new Error('External provider forbidden'); }, close() {} },
    devices: { get temperatures() { onConstruct(); return async () => []; }, async close() {} } };
}
async function fixture(t, { hold = false, fail = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-first-status-'));
  const config = loadConfig({ HOME: directory, XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  config.input = 'mqtt'; config.deviceId = null;
  config.connections = { mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic',
    temperatureReportIntervalMs: 70 * 60_000, temperatureReportGraceMs: 5 * 60_000 },
    equipment: equipmentConfiguration({ devices: [{ id: 'upstairs', kind: 'temperature',
      connection: `mqtt:${TOPIC}`, signal: 'indoor_temperature' }] }) };
  config.garage.adapter = isolatedGarageAdapter(); config.garage.sender = { stateTopic: '', commandTopic: '' };
  let now = INITIAL, warm, app, store, reader, startup, server;
  const controller = new AbortController(), entered = deferred(), release = deferred();
  const state = { recovery: null, recoveryCommitted: false, firstTickCommitted: false,
    seedSelected: false, seedCommitted: false, rollback: false, cueCount: 0 };
  const original = { startWriter: Store.prototype.startWriter, tickSteps: Engine.prototype.tickSteps,
    confirm: Engine.prototype.confirmTemperatureConnection, status: Engine.prototype.status, listen: Server.prototype.listen };
  const first = client(), resumed = client({ deferRoom: true });
  const connect = mqtt => (_address, options) => {
    if (identityConnection(options)) return idleIdentityClient();
    queueMicrotask(() => mqtt.emit('connect')); return mqtt;
  };
  t.after(async () => {
    const errors = [];
    const attempt = async operation => { try { return await operation(); } catch (error) { errors.push(error); } };
    release.resolve(); controller.abort();
    const outcome = await attempt(() => startup);
    if (outcome?.app) app = outcome.app;
    try {
      if (app) await attempt(() => app.close());
      if (warm) await attempt(() => warm.close());
    } finally {
      Store.prototype.startWriter = original.startWriter;
      Engine.prototype.tickSteps = original.tickSteps;
      Engine.prototype.confirmTemperatureConnection = original.confirm;
      Engine.prototype.status = original.status;
      Server.prototype.listen = original.listen;
    }
    await attempt(() => reader?.close());
    await attempt(() => rmSync(directory, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, 'Startup fixture cleanup failed');
  });
  warm = await start({ config, clock: () => now, installSignalHandlers: false,
    mqttOptions: { connect: connect(first) }, providerOptions: providers() });
  first.emit('message', TOPIC, Buffer.from(JSON.stringify({ value: 21, timestamp: now, unit: 'C' })), { retain: false });
  await committedWrites(warm.store);
  assert.equal(warm.engine.recorder.latestCommitted('indoor_temperature').value, 21);
  now += 15_000;
  await warm.close(); warm = null; now = INITIAL + 60_000;
  reader = new Store(config.dbPath, { readOnly: true });
  Store.prototype.startWriter = async function (...args) {
    const result = await original.startWriter.apply(this, args);
    if (this.path === config.dbPath) {
      store = this;
      const request = this.writer.request.bind(this.writer);
      this.writer.request = async (operation, ...values) => {
        if (operation === 'commit' && state.seedSelected && !state.commitIntercepted) {
          state.commitIntercepted = true;
          state.checkpointBeforeSeed = reader.checkpoint();
          state.decisionsBeforeSeed = reader.events().filter(row => row.type === 'decision').length;
          entered.resolve();
          if (hold) await release.promise;
          if (fail) throw Object.assign(new Error('Synthetic initial view COMMIT failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
        }
        const reply = await request(operation, ...values);
        if (operation === 'rollback' && state.commitIntercepted) state.rollback = true;
        return reply;
      };
    }
    return result;
  };
  Engine.prototype.tickSteps = function* (...args) {
    const result = yield* original.tickSteps.apply(this, args);
    if (this.store.path === config.dbPath && !state.firstTickCommitted && !state.recovery)
      this.store.afterCommit(() => { state.firstTickCommitted = true; });
    if (state.advanceAfterTick) {
      const advance = state.advanceAfterTick; state.advanceAfterTick = null; advance();
    }
    return result;
  };
  Engine.prototype.confirmTemperatureConnection = function (...args) {
    const beforeHadView = Boolean(this.latestStatus), result = original.confirm.apply(this, args);
    if (this.store.path === config.dbPath && args[0] === 'indoor_temperature' && result) {
      state.recovery = { beforeHadView, latestAbsent: this.latestStatus === null,
        inTransaction: this.store.transactionDepth > 0, sourceTime: result.sourceTime, receivedAt: result.receivedAt };
      this.store.afterCommit(() => { state.recoveryCommitted = true; });
    }
    return result;
  };
  Engine.prototype.status = function (...args) {
    const result = original.status.apply(this, args);
    if (this.store.path === config.dbPath && state.recoveryCommitted && this.store.transactionDepth > 0
      && !this.suspended && !state.seedSelected) {
      state.seedSelected = true; state.seedView = structuredClone(result); state.engine = this;
      this.store.afterCommit(() => { state.seedCommitted = true; });
    }
    return result;
  };
  Server.prototype.listen = function (...args) {
    this.once('listening', () => { server = this; });
    return original.listen.apply(this, args);
  };
  startup = start({ config, clock: () => now, installSignalHandlers: false, shutdownSignal: controller.signal,
    mqttOptions: { connect: connect(resumed) }, providerOptions: providers(() => {
      if (state.cueCount) return;
      assert(state.firstTickCommitted, 'Room SUBACK must follow the real first controller COMMIT');
      assert.equal(resumed.room.length, 1);
      state.cueCount++; resumed.room[0]();
    }) }).then(value => ({ app: value }), error => ({ error }));
  return { config, state, entered, release, controller, resumed, reader, startup,
    get store() { return store; }, get server() { return server; }, setNow: value => { now = value; } };
}
function recovered(f) {
  assert.equal(f.state.cueCount, 1);
  assert.deepEqual(f.state.recovery, { beforeHadView: true, latestAbsent: true,
    inTransaction: true, sourceTime: INITIAL, receivedAt: INITIAL });
  assert(f.state.recoveryCommitted, 'The invalidating SUBACK recovery really committed');
  assert.equal(f.resumed.publications.length, 0, 'A temperature subscription cannot send device commands');
}
async function seedEntered(f) {
  const first = await Promise.race([f.entered.promise.then(() => ({ entered: true })), f.startup]);
  assert.ifError(first.error);
  assert(first.entered, 'Startup returned before the initial view COMMIT was selected');
  recovered(f);
}

test('standalone startup commits its first complete view after delayed room SUBACK recovery', async t => {
  const f = await fixture(t), result = await f.startup;
  assert.ifError(result.error);
  recovered(f);
  assert.equal(result.app.engine.status().observations.upstairs.value, 21);
  assert.equal(result.app.engine.status().observations.upstairs.observedAt, INITIAL);
  assert.equal(result.app.engine.committedStatus.observations.upstairs.observedAt, INITIAL);
  assert(f.state.seedCommitted);
});

test('first public view waits for its actual writer COMMIT and exposes no provisional snapshot', async t => {
  const f = await fixture(t, { hold: true });
  await seedEntered(f);
  assert.equal(f.store.writePending, true);
  assert.equal(f.state.engine.committedStatus, undefined);
  assert.deepEqual(f.reader.checkpoint(), f.state.checkpointBeforeSeed);
  const response = await fetch(`http://127.0.0.1:${f.server.address().port}/api/status`);
  assert.equal(response.status, 503);
  f.release.resolve();
  const result = await f.startup; assert.ifError(result.error);
  assert(f.state.seedCommitted);
  assert.equal(result.app.engine.committedStatus.observations.upstairs.value, 21);
});

test('refused first-view COMMIT request performs real rollback and preserves startup failure', async t => {
  const f = await fixture(t, { hold: true, fail: true });
  await seedEntered(f); f.release.resolve();
  const result = await f.startup;
  assert.equal(result.error?.code, 'ERR_SQLITE_ERROR');
  assert.match(result.error.message, /Synthetic initial view COMMIT failure/);
  assert.equal(f.state.seedCommitted, false);
  assert.equal(f.state.engine.committedStatus, undefined);
  assert(f.state.rollback);
  assert.equal(f.reader.events().filter(row => row.type === 'decision').length, f.state.decisionsBeforeSeed);
  assert.equal(f.store.writer.terminated, true);
  assert.equal(f.resumed.closed, true);
});

test('shutdown during first-view COMMIT joins startup without publishing or returning a late app', async t => {
  const f = await fixture(t, { hold: true });
  await seedEntered(f); f.controller.abort(); f.release.resolve();
  const result = await f.startup;
  assert(result.error); assert.equal(result.app, undefined);
  assert.equal(f.state.engine.committedStatus, undefined, 'Cancelled startup must not publish its captured view');
  assert.equal(f.store.writer.terminated, true);
  assert.equal(f.resumed.closed, true);
  assert.equal(f.resumed.publications.length, 0);
});

test('asynchronous status refresh at an occupancy deadline retains the full public projection', async t => {
  const f = await fixture(t), result = await f.startup;
  assert.ifError(result.error);
  await result.app.store.runWrite(() => result.app.engine.setTemporary({ awayUntil: new Date(INITIAL + 65_000).toISOString() }));
  f.setNow(INITIAL + 66_000);
  f.state.advanceAfterTick = () => f.setNow(INITIAL + 67_000);
  result.app.engine.status();
  await result.app.engine.statusRefresh;
  const view = result.app.engine.status();
  assert.equal(view.settings.occupancy.mode, 'occupied');
  assert.equal(view.now, INITIAL + 67_000, 'Public projection observes the clock after the deadline-triggered tick');
  assert.equal(view.observations.upstairs.observedAt, INITIAL, 'Projection cannot renew the recovered source clock');
});
