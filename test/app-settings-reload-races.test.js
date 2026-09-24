import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { identityConnection, idleIdentityClient } from './helpers/identity-mqtt.js';
import { request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(t, options = {}, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-reload-races-'));
  const path = join(directory, 'options.json');
  // These races exercise explicitly configured equipment topics, independently of
  // the public equipment catalogue and its read-only discovery requests.
  const write = value => writeFileSync(path, JSON.stringify({ equipment: { devices: [] }, ...value }));
  const read = () => loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  write(options);
  const config = read();
  const app = await start({ config, ...overrides });
  t.after(async () => {
    try { await app.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (endpoint, value = {}) => fetch(`${base}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  return { app, config, read, write, base, post };
}

async function beginSlowPost(app, base, endpoint) {
  const received = deferred();
  const onRequest = incoming => {
    if (incoming.url === endpoint) received.resolve();
  };
  app.server.on('request', onRequest);
  const response = deferred();
  let rejectResponse;
  const complete = new Promise((resolve, reject) => {
    rejectResponse = reject;
    response.promise.then(resolve, reject);
  });
  const req = request(`${base}${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { text += chunk; });
    res.on('end', () => {
      try { response.resolve({ status: res.statusCode, body: JSON.parse(text) }); }
      catch (error) { rejectResponse(error); }
    });
    res.on('error', rejectResponse);
  });
  req.on('error', rejectResponse);
  req.write('{');
  // The application's request listener has entered its JSON reader before this
  // second listener runs, so the first engine would already have been captured.
  await received.promise;
  app.server.removeListener('request', onRequest);
  return { finish: value => { req.end(JSON.stringify(value).slice(1)); return complete; } };
}

test('a slow temporary-control POST spanning a completed reload dispatches only to the replacement engine', async t => {
  const { app, base, write, post } = await setup(t);
  const old = app.engine;
  let oldMutations = 0;
  const original = old.setTemporary.bind(old);
  old.setTemporary = value => { oldMutations++; return original(value); };
  const pending = await beginSlowPost(app, base, '/api/temporary');
  write({ controller: { mode: 'monitoring', max_drop_c: 0.5 } });
  assert.equal((await post('/api/settings/reload')).status, 200);
  assert.notEqual(app.engine, old);
  const awayUntil = new Date(Date.now() + 3600_000).toISOString();
  const response = await pending.finish({ awayUntil });
  assert.equal(response.status, 200);
  assert.equal(oldMutations, 0);
  assert.equal(response.body.mode, 'monitoring');
  assert.equal(response.body.settings.comfort.maxDropC, 0.5);
  assert.equal(app.engine.settings.occupancy.returnAt, awayUntil);
});

test('a slow POST already reading JSON is rejected if its body completes during reload', async t => {
  const entered = deferred(), release = deferred();
  let current;
  const { app, base, config } = await setup(t, {}, {
    readConfig: async () => { entered.resolve(); await release.promise; return current; },
  });
  current = config;
  const pending = await beginSlowPost(app, base, '/api/temporary');
  const reload = app.reloadSettings();
  await entered.promise;
  try {
    const response = await pending.finish({ awayUntil: new Date(Date.now() + 3600_000).toISOString() });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /being updated/);
    assert.equal(app.engine.settings.occupancy.mode, 'occupied');
  } finally { release.resolve(); await reload; }
});

function fakeMqtt() {
  const clients = [], packets = [];
  const connect = (_address, options) => {
    if (identityConnection(options)) return idleIdentityClient();
    const client = new EventEmitter();
    Object.assign(client, { connected: true, endCalls: 0 });
    client.subscribe = (_topic, _options, done) => done();
    client.publish = (topic, payload, _options, done) => { packets.push({ topic, payload }); done(); };
    client.end = (_force, _options, done) => { client.endCalls++; done(); };
    clients.push(client);
    return client;
  };
  return { clients, packets, connect };
}

test('shutdown during a delayed config read prevents reconnection and active dispatch', async t => {
  const entered = deferred(), release = deferred(), mqtt = fakeMqtt();
  let next;
  const options = { controller: { input: 'mqtt' },
    mqtt: { address: 'mqtt://invented-first.invalid' }, equipment: { devices: [{ id: 'indoor', kind: 'temperature', connection: 'mqtt:' + 'invented/first' }] } };
  const { app, write, read } = await setup(t, options, {
    mqttOptions: { connect: mqtt.connect },
    readConfig: async () => { entered.resolve(); await release.promise; return next; },
  });
  write({ controller: { input: 'mqtt', mode: 'active' },
    mqtt: { address: 'mqtt://invented-second.invalid' }, equipment: { devices: [{ id: 'indoor', kind: 'temperature', connection: 'mqtt:' + 'invented/second' }] } });
  next = read();
  const old = app.engine;
  let ticks = 0;
  const tick = old.tick.bind(old);
  old.tick = () => { ticks++; return tick(); };
  const reload = app.reloadSettings();
  const rejected = assert.rejects(reload, /shutting down/);
  await entered.promise;
  const closed = app.close();
  release.resolve();
  await Promise.all([closed, rejected]);
  assert.equal(app.engine, old);
  assert.equal(ticks, 0);
  assert.equal(mqtt.clients.length, 1);
  assert.equal(mqtt.clients[0].endCalls, 1);
  assert.deepEqual(mqtt.packets, []);
  assert.equal(old.executor.closed, true);
});

test('failed replacement and recovery disable API mutations and scheduled control ticks', async t => {
  const mqtt = fakeMqtt();
  let attempts = 0;
  let now = Date.parse('2026-09-08T12:00:00Z');
  const connect = (_address, options) => {
    if (identityConnection(options)) return idleIdentityClient();
    if (++attempts > 1) throw new Error('synthetic-private-reconnect-failure');
    return mqtt.connect();
  };
  const options = { controller: { input: 'mqtt' },
    mqtt: { address: 'mqtt://invented-first.invalid' }, equipment: { devices: [{ id: 'indoor', kind: 'temperature', connection: 'mqtt:' + 'invented/first' }] } };
  const { app, base, post, write } = await setup(t, options, { clock: () => now, mqttOptions: { connect } });
  write({ ...options, controller: { input: 'mqtt', max_drop_c: 0.5 } });
  // A broken finally block would arm a tick just 25 ms after failure.
  now += 59_975;
  await assert.rejects(app.reloadSettings(), /runtime recovery failed/);
  assert.equal(attempts, 3);
  assert.equal(app.engine.executor.closed, true);
  let ticks = 0;
  app.engine.tick = () => { ticks++; throw new Error('A failed runtime must stay stopped'); };
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(ticks, 0);
  assert.equal((await post('/api/temporary', {})).status, 503);
  assert.equal((await post('/api/settings/reload')).status, 503);
  const response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /Restart/);
  assert.doesNotMatch(JSON.stringify({ body, events: app.store.events() }), /synthetic-private-reconnect-failure/);
});
