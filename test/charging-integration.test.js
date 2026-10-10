import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { startMqtt } from '../src/acquisition/mqtt.js';

function fixture(t, charging) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-integration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = Date.parse('2026-09-15T18:00:00Z');
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory }, directory), input: 'mqtt', deviceId: null, ...(charging ? { charging } : {}),
    connections: { mqtt: { address: 'mqtt://example.invalid' }, teslamate: { enabled: true, carId: '7' } } };
  const engine = new Engine({ store, config, clock: () => now }), cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await engine.charging.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, engine, config, cleanup, advance(ms) { now += ms; } };
}

const chargerView = (runtime, id = 'charger1') => runtime.status().chargers.find(item => item.id === id);

test('one-day API separates preview from approval and fences authentication, authority, revision and repeated clicks', async t => {
  const { store, engine } = fixture(t, { defaults: { readyBy: '07:15' } });
  engine.electricityForecast = { snapshot: () => ({ enabled: true, available: false }),
    status: () => ({ enabled: true, available: false }) };
  const runtime = engine.charging, item = runtime.chargers.charger1, connectedAt = engine.clock();
  item.adapter = { normalize: () => ({ connected: { value: true, available: true },
    charging: { value: false, available: true, measuredAt: engine.clock() } }) };
  item.controller = { status: () => ({ session: { connectedAt }, snapshot: { online: true, readAt: engine.clock() }, phase: 'waiting' }),
    async update() {}, close() {} };
  await engine.runWrite(() => engine.tick());
  const before = chargerView(runtime);
  await runtime.setControl('charger1', { association: before.association, revision: before.controls.revision, enabled: true });
  const initial = chargerView(runtime), scope = { association: initial.association, sessionId: initial.request.sessionId,
    revision: initial.request.revision }, allowance = { ...scope, action: 'allow', actionId: 'synthetic-api-day' };
  let primary = true;
  const token = 'synthetic-flexibility-api-token';
  const server = createAppServer({ engine, store, token, controlAuthority: { canControl: () => primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (action, payload, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/api/charging/chargers/charger1/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload) });
  for (const [action, payload] of [['flexibility-preview', scope], ['flexibility', allowance]]) {
    assert.equal((await post(action, payload, false)).status, 401);
    primary = false; assert.equal((await post(action, payload)).status, 409); primary = true;
    assert.equal((await post(action, { ...payload, association: 'another-equipment' })).status, 400);
    assert.equal((await post(action, { ...payload, revision: scope.revision + 1 })).status, 400);
  }
  const preview = await post('flexibility-preview', scope);
  const previewBody = await preview.json();
  assert.equal(preview.status, 200, JSON.stringify(previewBody)); assert.equal(previewBody.comparison.available, false);
  assert.equal(chargerView(runtime).request.flexibility, undefined, 'Opening comparison grants no additional time');
  const approved = await post('flexibility', allowance);
  assert.equal(approved.status, 200, JSON.stringify(await approved.json()));
  const current = chargerView(runtime);
  assert.equal(current.deadlineAt, initial.deadlineAt + 24 * 3_600_000);
  assert.equal((await post('flexibility', allowance)).status, 200, 'A repeated action receipt is idempotent');
  assert.equal(chargerView(runtime).request.revision, current.request.revision);
  assert.equal((await post('flexibility', { ...allowance, actionId: 'another-click' })).status, 400);
  assert.equal((await post('flexibility', { ...allowance, revision: current.request.revision,
    actionId: 'cancel-api-day', action: 'cancel' })).status, 200);
  assert.equal(chargerView(runtime).deadlineAt, initial.deadlineAt);
});

test('charging API saves fenced dashboard controls separately from defaults and scoped session edits', async t => {
  const { store, engine, config } = fixture(t, { defaults: { capacityKwh: 79, readyBy: '07:15', manualSoc: 43 } });
  const item = engine.charging.chargers.charger1, connectedAt = engine.clock();
  item.adapter = { normalize: () => ({ connected: { value: true, available: true },
    charging: { value: false, available: true, measuredAt: engine.clock() } }) };
  item.controller = { status: () => ({ session: { connectedAt }, snapshot: { readAt: engine.clock() }, phase: 'off' }),
    async update() {}, close() {} };
  await engine.charging.write(() => engine.charging.persist());
  let primary = true;
  const token = 'synthetic-charging-test-authorization';
  const server = createAppServer({ engine, store, token,
    controlAuthority: { canControl: () => primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, authenticated = true) => fetch(`${base}/api/charging/${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post('chargers/charger1/settings', { enabled: true }, false)).status, 401);
  assert.equal((await post('settings', { priority: 'charger2' })).status, 400);
  assert.equal((await post('settings', { chargers: { charger1: { capacityKwh: 50 } } })).status, 400);
  assert.equal((await post('chargers/charger1/settings', { manualSoc: 44 })).status, 400);
  const displayed = chargerView(engine.charging);
  const request = { scope: 'session', association: displayed.association, sessionId: displayed.request.sessionId,
    revision: displayed.request.revision, changes: { manualSoc: 44, capacityKwh: 70 } };
  assert.equal((await post('chargers/charger1/settings', { ...request, changes: { enabled: true } })).status, 400);
  primary = false;
  assert.equal((await post('chargers/charger1/settings', request)).status, 409);
  primary = true;
  const response = await post('chargers/charger1/settings', request);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.charging.chargers.find(row => row.id === 'charger1').values.soc.value, 44);
  assert.equal(status.charging.timezone, 'Europe/Helsinki');
  assert.equal((await post('chargers/charger1/settings', request)).status, 400);
  assert.equal((await post('chargers/missing/settings', request)).status, 400);
  const current = chargerView(engine.charging);
  const automatic = { association: current.association, revision: current.controls.revision, enabled: true };
  const priority = { associations: Object.fromEntries(engine.charging.status().chargers.map(row => [row.id, row.association])),
    revision: engine.charging.status().controls.revision, priority: 'charger2' };
  assert.equal((await post('chargers/charger1/control', automatic, false)).status, 401);
  assert.equal((await post('settings', priority, false)).status, 401);
  primary = false;
  assert.equal((await post('chargers/charger1/control', automatic)).status, 409);
  assert.equal((await post('settings', priority)).status, 409);
  primary = true;
  assert.equal((await post('chargers/charger1/control', automatic)).status, 200);
  assert.equal((await post('settings', priority)).status, 200);
  assert.equal((await post('chargers/charger1/control', automatic)).status, 400);
  assert.equal((await post('settings', priority)).status, 400);
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.charging.settings.chargers.charger1.enabled, true);
  assert.equal(restarted.charging.settings.chargers.charger1.capacityKwh, 79);
  assert.equal(restarted.charging.settings.chargers.charger2.capacityKwh, 79);
  assert.equal(restarted.charging.settings.chargers.charger1.manualSoc, 43);
  assert.equal(restarted.charging.settings.priority, 'charger2');
  assert.equal(Object.hasOwn(readChargingRuntime(store, 'charging:mqtt') ?? {}, 'settings'), false);
  await restarted.charging.close();
});

test('Charge Now API authenticates and rejects stale scope with automatic charging on or off', async t => {
  for (const automaticEnabled of [true, false]) await t.test(`automatic charging ${automaticEnabled ? 'on' : 'off'}`, async t => {
    const { store, engine, config, advance } = fixture(t, { defaults: { readyBy: '07:15' } });
    const runtime = engine.charging, item = runtime.chargers.charger1, connectedAt = engine.clock(), updates = [];
    let sessionAt = connectedAt, primary = true;
    item.adapter = { normalize: () => ({ connected: { value: true, available: true },
      charging: { value: false, available: true, measuredAt: engine.clock() } }) };
    item.controller = { status: () => ({ session: { connectedAt: sessionAt },
      snapshot: { online: true, readAt: engine.clock() }, phase: 'waiting' }),
      async update(input) { updates.push(structuredClone(input)); }, close() {} };
    const token = 'synthetic-charge-now-api-authorization';
    const server = createAppServer({ engine, store, token,
      controlAuthority: { canControl: () => primary, status: () => ({}) } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/charging/chargers/charger1/charge-now`;
    const post = (body, authenticated = true) => fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
    const before = chargerView(runtime);
    await runtime.setControl('charger1', { association: before.association, revision: before.controls.revision, enabled: automaticEnabled });
    const initial = chargerView(runtime), settings = structuredClone(runtime.settings), configured = structuredClone(config.charging);
    const request = { association: initial.association, sessionId: initial.request.sessionId, revision: initial.request.revision };
    assert.equal((await post(request, false)).status, 401);
    primary = false;
    assert.equal((await post(request)).status, 409);
    primary = true;
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ ...request, enabled: true })).status, 400);
    assert.equal((await post({ ...request, revision: request.revision + 1 })).status, 400);
    assert.equal((await post({ ...request, association: 'different-physical-charger' })).status, 400);
    assert.equal(chargerView(runtime).request.chargeNow, undefined);
    const response = await post(request);
    assert.equal(response.status, 200);
    {
      const accepted = (await response.json()).charging.chargers.find(row => row.id === 'charger1');
      assert.equal(accepted.request.chargeNow, true);
      assert.equal(accepted.request.sessionId, request.sessionId);
      assert.equal(accepted.request.revision, request.revision + 1);
      assert.deepEqual(updates.at(-1).chargeNow, { connectedAt });
      assert.equal(readChargingRuntime(store, 'charging:mqtt').chargers.charger1.request.chargeNow, true);
      assert.equal((await post(request)).status, 400, 'an old screen cannot overwrite the accepted request');
      advance(60_000); sessionAt = engine.clock();
      assert.equal((await post({ ...request, revision: accepted.request.revision })).status, 400);
      assert.equal(chargerView(runtime).request?.chargeNow, undefined, 'a replacement connection does not inherit Charge Now');
    }
    assert.deepEqual(runtime.settings, settings);
    assert.deepEqual(config.charging, configured);
    assert.equal(Object.hasOwn(readChargingRuntime(store, 'charging:mqtt') ?? {}, 'settings'), false);
  });
});

test('independent MQTT vehicle routes keep source timestamps without overriding unassigned charger defaults', async t => {
  const { store, engine, config, cleanup, advance } = fixture(t, { defaults: { manualSoc: 44 }, vehicles: { bmw: { mqttTopic: 'stmq/test/bmw' } } }), client = new EventEmitter(), subscriptions = [];
  client.subscribe = (topic, options, done) => { subscriptions.push({ topic, qos: options.qos }); done(null, [{ topic, qos: options.qos }]); };
  client.unsubscribe = (_topic, done) => done();
  client.end = (_force, _options, done) => done();
  const capture = await startMqtt({ engine, store, config, connect: () => client });
  cleanup.push(() => capture.close({ restore: false }));
  client.emit('connect');
  assert(subscriptions.some(row => row.topic === engine.charging.configuration.vehicles.bmw.mqttTopic && row.qos === 1));
  const reading = { provider: 'bmw-cardata', vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', readingId: 'sample-1', soc: 64,
    measuredAt: engine.clock() - 24 * 3_600_000 };
  const sendSoc = (value, topic = engine.charging.configuration.vehicles.bmw.mqttTopic) => client.emit('message', topic, Buffer.from(JSON.stringify(value)), { retain: true });
  sendSoc(reading);
  assert.equal(chargerView(engine.charging).values.soc.value, 44);
  advance(1000); client.emit('offline'); client.emit('connect'); sendSoc(reading);
  assert.equal(engine.charging.vehicleFeeds.bmw.reading.measuredAt, reading.measuredAt);
  assert.equal(engine.charging.vehicleFeeds.bmw.reading.receivedAt, engine.clock() - 1000);
  sendSoc({ ...reading, readingId: 'sample-2', measuredAt: engine.clock(), soc: 65 });
  assert.equal(chargerView(engine.charging).values.soc.value, 44, 'Unknown vehicle retains the configured fallback');
  assert.equal(engine.charging.settings.chargers.charger1.manualSoc, 44, 'Fallback comes from configuration');
  await assert.rejects(engine.charging.setChargerSettings('charger1', { mqtt: { topic: 'new/topic' } }), /configuration/);
  assert(subscriptions.some(row => row.topic === 'stmq/test/bmw' && row.qos === 1));
  sendSoc({ readingId: 'second-car', measuredAt: engine.clock(), soc: 48 }, 'stmq/garage/charger2/vehicle');
  assert.equal(chargerView(engine.charging, 'charger2').values.soc.value, 44, 'A generic extra feed cannot identify the Tesla');
  assert.equal(chargerView(engine.charging).values.soc.value, 44, 'Vehicle topics cannot attach themselves to a charger');
  advance(1000);
  const send = (field, value) => client.emit('message', `teslamate/cars/7/${field}`, Buffer.from(String(value)));
  for (const [field, value] of Object.entries({ battery_level: 40, charge_limit_soc: 80, charge_current_request: 13,
    charge_current_request_max: 16, charger_phases: 3, charger_voltage: 230, plugged_in: true, geofence: 'Home',
    charger_power: 0, scheduled_charging_start_time: new Date(engine.clock() + 3_600_000).toISOString() })) send(field, value);
  engine.charging.tick();
  assert.equal(chargerView(engine.charging, 'charger2').values.currentA.available, false, 'Vehicle constraints cannot manufacture physical Charger 2 telemetry');
  assert.equal(chargerView(engine.charging, 'charger2').vehicle.id, null);
});

test('ordinary BMW target settings authenticate, enforce authority and reject retired routes and stale sessions', async t => {
  const { store, engine, advance } = fixture(t);
  const runtime = engine.charging, connectedAt = engine.clock();
  runtime.setMqttStatus({connected:true,subscribed:true},'bmw');
  let primary = true, charging = true, sessionAt = connectedAt;
  const token = 'synthetic-target-api-authorization';
  const item = runtime.chargers.charger1;
  item.adapter = { normalize: () => ({ connected: { value: true, available: true },
    charging: { value: charging, available: true, measuredAt: engine.clock() } }) };
  item.controller = { status: () => ({ session: { connectedAt: sessionAt },
    snapshot: { online: true, readAt: engine.clock() }, phase: 'off' }), async update() {}, close() {} };
  const publish = packet => runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify(packet));
  publish({ provider: 'bmw-cardata', soc: 40, chargeLimitSoc: 85, measuredAt: connectedAt, readingId: 'api-battery',
    atHome: true, pluggedIn: true, charging: true, fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt: connectedAt, readingId: `api-${key}` }])) });
  advance(60_000); charging = false;
  publish({ provider: 'bmw-cardata', charging: false, fields: { charging: { measuredAt: engine.clock(), readingId: 'api-stop' } } });
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  const server = createAppServer({ engine, store, token,
    controlAuthority: { canControl: () => primary, status: () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/charging/chargers/charger1`;
  const url = `${base}/settings`;
  const post = (body, authenticated = true) => fetch(url, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const displayed = chargerView(runtime);
  const request = { scope: 'session', association: displayed.association, sessionId: displayed.request.sessionId,
    revision: displayed.request.revision, changes: { minimumSoc: 100 } };
  assert.equal((await post(request, false)).status, 401);
  primary = false;
  assert.equal((await post(request)).status, 409);
  primary = true;
  assert.equal((await post({ connectedAt, mode: 'full' })).status, 400);
  assert.equal((await post({ ...request, mode: 'full' })).status, 400);
  assert.equal((await post({ ...request, changes: { minimumSoc: 100, mode: 'full' } })).status, 400);
  const before = structuredClone(runtime.chargers.charger1.request);
  for (const mode of ['full', 'automatic']) {
    const retired = await fetch(`${base}/target`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ connectedAt, mode }) });
    assert.equal(retired.status, 404);
    assert.deepEqual(runtime.chargers.charger1.request, before);
  }
  const response = await post(request);
  assert.equal(response.status, 200);
  const chosen = (await response.json()).charging.chargers[0];
  assert.equal(chosen.values.minimumSoc.value, 100);
  assert.equal(chosen.values.minimumSoc.source, 'session-request');
  assert.equal(chosen.targetSelection.raw.value, 85);
  assert.equal((await post(request)).status, 400, 'A repeated Save cannot reuse the old revision');
  const next = { ...request, revision: chosen.request.revision, changes: { minimumSoc: 84 } };
  assert.equal((await post(next)).status, 200);
  assert.equal(chargerView(runtime).values.minimumSoc.value, 84);
  advance(60_000); sessionAt = engine.clock();
  assert.equal((await post({ ...next, revision: chosen.request.revision + 1 })).status, 400);
  assert.equal(chargerView(runtime).targetSelection, null);
});
test('physical C2 alone starts MQTT acquisition when all vehicle feeds and other MQTT inputs are absent',async t=>{
 const {start}=await import('../src/main.js');
 const dir=mkdtempSync(join(tmpdir(),'stmq-physical-only-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const base=loadConfig({XDG_CONFIG_HOME:dir,STMQ_DATA_DIR:dir,STMQ_PORT:'0'},dir);
 const config={...base,input:'mqtt',deviceId:null,h66:{...base.h66,deviceId:null},
  charging:{chargers:{charger2:{enabled:true,deviceId:'synthetic-evse',topicPrefix:'synthetic/evse'}},vehicles:{bmw:{mqttTopic:null}}},
  connections:{mqtt:{address:'mqtt://synthetic.invalid'},teslamate:{enabled:false}}};
 const subscriptions=[];let clients=0;
 const connect=()=>{clients++;const client=new EventEmitter();client.subscribe=(topics,_options,done)=>{
  const list=Array.isArray(topics)?topics:[topics];subscriptions.push(...list);done?.(null,list.map(topic=>({topic,qos:0})));};
  client.publish=(_topic,_body,_options,done)=>done?.();client.end=(_force,_options,done)=>done?.();
  queueMicrotask(()=>client.emit('connect'));return client;
 };
 const app=await start({config,mqttOptions:{connect},installSignalHandlers:false});t.after(()=>app.close());
 assert.ok(clients>0);assert.ok(app.engine.charging.chargers.charger2.adapter);
 assert.ok(subscriptions.includes('synthetic/evse/events/rpc'));assert.equal(app.engine.charging.mqttRoutes().length,0);
 assert.equal(app.engine.providerStatus()['shelly-evse'].enabled,true);
});
