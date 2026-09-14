import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { startMqtt, decodeMqttTemperature } from '../src/acquisition/mqtt.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../src/domain/temperature-reports.js';
import { Store } from '../src/storage/store.js';

const initial = Date.parse('2026-09-10T12:00:00Z');
const garage = { id: 'garage', area: 'garage', kind: 'switch', connection: 'shelly:invented/garage', readings: [
  { key: 'temperature_2', label: 'Garage rear probe', signal: 'garage_temperature_2', unit: 'degC', component: 'temperature:101' },
] };
const door = { id: 'garage_door1', label: 'Garage front door', area: 'garage', kind: 'door', connection: 'mqtt:invented/door' };
const home = { id: 'upstairs', label: 'Upstairs', area: 'home', kind: 'temperature', signal: 'indoor_temperature', connection: 'mqtt:invented/upstairs' };
const plug = { id: 'caravan', kind: 'metered_switch', connection: 'shelly:invented/plug', switch_control: true };
const genericSwitch = { id: 'relay', kind: 'switch', connection: 'mqtt:invented/state', switch_control: true,
  mqtt: { command_topic: 'invented/command', on_payload: 'ON', off_payload: 'OFF' } };
function fixture(t, rows, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-equipment-capture-')), store = new Store(join(directory, 'test.sqlite'));
  let now = initial, authority = true;
  const observations = [], publications = [], reportPolicies = [], cleanups = [];
  const engine = { clock: () => now, ingest: row => { observations.push(row); store.observation(row); },
    configureTemperatureReports: (...args) => reportPolicies.push(args), rememberObservation: row => observations.push(row) };
  const settings = equipmentConfiguration({ devices: rows });
  const capture = createEquipmentCapture({ engine, store, settings, canControl: () => authority,
    brokerIdentity: { address: 'mqtt://example.invalid', username: 'invented' },
    publish: async (topic, payload, options) => { publications.push({ topic, payload, options }); }, readbackTimeoutMs: 50, ...options });
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); capture.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const reply = (publication, result) => {
    const request = JSON.parse(publication.payload);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, result }), {}, now);
  };
  return { store, engine, settings, capture, observations, publications, reportPolicies, reply, cleanups,
    now: value => { now = value; }, authority: value => { authority = value; },
    status: (prefix, result) => reply(publications.findLast(row => row.topic === `${prefix}/rpc` && JSON.parse(row.payload).method === 'Shelly.GetStatus'), result) };
}

test('equipment configuration requires explicit protocols and unambiguous subscriptions/control mappings', () => {
  for (const connection of ['invented/topic', 'http:invented', 'mqtt:invented/+', 'shelly:invented/#', 'shelly: invented', 'shelly:invented/'])
    assert.throws(() => equipmentConfiguration({ devices: [{ ...door, connection }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ ...genericSwitch, mqtt: {} }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ ...genericSwitch, mqtt: { ...genericSwitch.mqtt, command_topic: 'invented/state' } }] }));
  assert.throws(() => equipmentConfiguration({ devices: [garage, { ...door, connection: 'mqtt:invented/garage/status/switch:0' }] }));
  assert.throws(() => equipmentConfiguration({ devices: [home, { ...home, id: 'another', connection: 'mqtt:elsewhere' }] }));
  assert.throws(() => equipmentConfiguration({ devices: [{ ...garage, readings: [{ key: 'temperature_2', unit: 'degC' }] }] }));
  const settings = equipmentConfiguration({ devices: [home, garage, door, { ...plug, enabled: false }] });
  assert.equal(settings.ownsGarage, true); assert(settings.ownedSignals.includes('indoor_temperature'));
  assert(!settings.ownedSignals.includes('caravan_power'));
  assert.equal(settings.devices.find(row => row.id === door.id).maxAgeMs, 0);
});

test('optional garage probe appears with its configured name and independent freshness', t => {
  const f = fixture(t, [garage]); f.capture.setConnected(true);
  f.status('invented/garage', { 'switch:0': { output: false }, 'temperature:100': { tC: 10 } });
  let device = f.capture.status().devices[0]; assert.equal(device.available, true);
  assert.equal(device.readings.garage_temperature_2, undefined);
  f.capture.receive('invented/garage/status/temperature:101', '{"tC":11.5}');
  device = f.capture.status().devices[0]; assert.equal(device.readings.garage_temperature_2.label, 'Garage rear probe');
  assert.equal(device.readings.garage_temperature_2.value, 11.5);
  f.now(initial + 30_000); f.capture.tick();
  f.status('invented/garage', { 'switch:0': { output: false }, 'temperature:100': { tC: 10.2 } });
  device = f.capture.status().devices[0]; assert.equal(device.available, true);
  assert.equal(device.readings.garage_temperature_2.value, null); assert.equal(device.readings.garage_temperature_2.stale, true);
  assert(f.observations.some(row => row.signal === 'garage_temperature_2' && row.value === 11.5));
});

test('event-only doors keep last-reported state but reconnect and retained messages cannot freshen it', t => {
  const f = fixture(t, [door]); f.capture.setConnected(true);
  f.capture.receive('invented/door', 'open', { retain: true });
  let reading = f.capture.status().devices[0].readings.garage_door1_open;
  assert.equal(reading.value, 1); assert.equal(reading.observedAt, null); assert.equal(reading.stale, true);
  assert.equal(f.observations.length, 0);
  f.capture.receive('invented/door', 'closed'); f.now(initial + 7 * 86400_000); f.capture.tick();
  assert.equal(f.capture.status().devices[0].available, true, 'Event-only contacts have no invented reporting interval');
  f.capture.setConnected(false); f.capture.setConnected(true);
  reading = f.capture.status().devices[0].readings.garage_door1_open;
  assert.equal(reading.value, 0); assert.equal(reading.observedAt, initial); assert.equal(reading.stale, true);
  f.capture.receive('invented/door', 'open', { retain: true });
  assert.equal(f.capture.status().devices[0].readings.garage_door1_open.value, 0);
  f.capture.receive('invented/door', 'open');
  assert.equal(f.capture.status().devices[0].available, true);
});

test('door state survives restart as last-reported context tied to physical identity', t => {
  const f = fixture(t, [door]); f.capture.setConnected(true); f.capture.receive('invented/door', 'open'); f.capture.close();
  const options = { engine: f.engine, store: f.store, settings: f.settings, publish: async () => {}, brokerIdentity: { address: 'mqtt://example.invalid', username: 'invented' } };
  const restored = createEquipmentCapture(options); f.cleanups.push(() => restored.close()); restored.setConnected(true);
  assert.equal(restored.status().devices[0].readings.garage_door1_open.value, 1);
  assert.equal(restored.status().devices[0].readings.garage_door1_open.stale, true);
  const moved = createEquipmentCapture({ ...options, brokerIdentity: { address: 'mqtt://different.invalid', username: 'invented' } }); f.cleanups.push(() => moved.close());
  assert.deepEqual(moved.status().devices[0].readings, {});
});

test('explicit door heartbeat and offline status invalidate readings without replacing original event time', t => {
  const f = fixture(t, [{ ...door, mqtt: { heartbeat_topic: 'invented/heartbeat', heartbeat_seconds: 30,
    availability_topic: 'invented/online' } }]); f.capture.setConnected(true);
  f.capture.receive('invented/door', 'closed'); assert.equal(f.capture.status().devices[0].available, false);
  f.capture.receive('invented/heartbeat', 'tick'); assert.equal(f.capture.status().devices[0].available, true);
  f.now(initial + 31_000); f.capture.tick();
  let device = f.capture.status().devices[0]; assert.equal(device.available, false);
  assert.equal(device.readings.garage_door1_open.value, 0); assert.equal(device.readings.garage_door1_open.observedAt, initial);
  f.capture.receive('invented/heartbeat', 'tick'); assert.equal(f.capture.status().devices[0].available, false);
  f.capture.receive('invented/door', 'open'); assert.equal(f.capture.status().devices[0].available, true);
  f.capture.receive('invented/online', 'offline', { retain: true }); assert.equal(f.capture.status().devices[0].available, false);
});

test('home equipment preserves the original temperature identity, report policy, decoder, and retained lineage', t => {
  const f = fixture(t, [home]); f.capture.setConnected(true);
  const payload = JSON.stringify({ value: 68, unit: 'F', timestamp: initial });
  f.capture.receive('invented/upstairs', payload);
  const observation = f.observations.at(-1), { temperatureRouteSignature, ...raw } = observation.raw;
  assert.match(temperatureRouteSignature, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...observation, raw }, decodeMqttTemperature({ signal: 'indoor_temperature', payload, receivedAt: initial,
    reportIntervalMs: DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, reportGraceMs: DEFAULT_TEMPERATURE_REPORT_GRACE_MS }));
  assert.deepEqual(f.reportPolicies, [['indoor_temperature', { reportIntervalMs: DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, reportGraceMs: DEFAULT_TEMPERATURE_REPORT_GRACE_MS }]]);
  const deadline = initial + DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS + DEFAULT_TEMPERATURE_REPORT_GRACE_MS;
  f.now(deadline - 1); assert.equal(f.capture.status().devices[0].available, true);
  f.now(deadline); f.capture.tick(); assert.equal(f.capture.status().devices[0].available, false);
  f.capture.receive('invented/upstairs', JSON.stringify({ value: 20, timestamp: deadline }), { retain: true });
  assert.equal(f.observations.at(-1).raw.retained, true); assert.equal(f.capture.status().devices[0].available, false);
});

test('native switch confirmation requires correlated RPC readback and read-only recheck never sends switch writes', async t => {
  const f = fixture(t, [plug]); f.capture.setConnected(true);
  f.reply(f.publications.find(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo'), { id: 'invented-caravan-id', gen: 2 });
  f.status('invented/plug', { 'switch:0': { output: false, apower: 0, current: 0 } });
  const checking = f.capture.recheck({ deviceId: 'caravan' });
  assert(f.capture.status().checking);
  f.status('invented/plug', { 'switch:0': { output: false, apower: 0, current: 0 } });
  assert.equal((await checking).devices[0].check.status, 'available');
  assert(f.publications.every(row => ['Shelly.GetDeviceInfo', 'Shelly.GetStatus'].includes(JSON.parse(row.payload).method)));
  const switching = f.capture.setSwitch('caravan', true); await Promise.resolve();
  const set = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.Set');
  let settled = false; switching.then(() => { settled = true; });
  f.capture.receive('invented/plug/status/switch:0', '{"output":true,"apower":0,"current":0}');
  await Promise.resolve(); assert.equal(settled, false);
  f.reply(set, { was_on: false });
  const get = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  f.reply(get, { output: true, apower: 0, current: 0 }); assert.equal((await switching).confirmed, true);
});

test('generic switch requires explicit publication plus fresh state, rejects retained confirmation and authority loss', async t => {
  const f = fixture(t, [genericSwitch]); f.capture.setConnected(true); f.capture.receive('invented/state', 'off');
  const pending = f.capture.setSwitch('relay', true); await Promise.resolve(); await Promise.resolve();
  let settled = false; pending.then(() => { settled = true; });
  f.capture.receive('invented/state', 'on', { retain: true }); await Promise.resolve(); assert.equal(settled, false);
  f.now(initial + 1); f.capture.receive('invented/state', 'on'); assert.equal((await pending).confirmed, true);
  assert.deepEqual(f.publications, [{ topic: 'invented/command', payload: 'ON', options: { qos: 1, retain: false } }]);
  f.authority(false); await assert.rejects(f.capture.setSwitch('relay', false), /authority/);
});

test('signatures include broker, physical topic and command mappings while excluding presentation', t => {
  const a = fixture(t, [genericSwitch]), b = fixture(t, [{ ...genericSwitch, label: 'New name', area: 'garage' }]),
    c = fixture(t, [{ ...genericSwitch, mqtt: { ...genericSwitch.mqtt, on_payload: '1' } }]),
    d = fixture(t, [genericSwitch], { brokerIdentity: { address: 'mqtt://other.invalid', username: 'invented' } });
  assert.equal(a.capture.signature('relay'), b.capture.signature('relay'));
  assert.notEqual(a.capture.signature('relay'), c.capture.signature('relay'));
  assert.notEqual(a.capture.signature('relay'), d.capture.signature('relay'));
});

test('unsupported hypothetical heat-pump equipment kind is rejected', () => {
  assert.throws(() => equipmentConfiguration({ devices: [{ id: 'future_controller', kind: 'heat_pump', connection: 'shelly:invented/future' }] }), /kind/);
});

test('MQTT equipment mappings can explicitly override meter field paths without duplicate signals', t => {
  const f = fixture(t, [{ id: 'meter', kind: 'metered_switch', connection: 'mqtt:invented/meter', mqtt: { state_path: 'output' },
    readings: [{ key: 'power', unit: 'kW', path: 'watts', scale: 0.001 }, { key: 'current', unit: 'A', path: 'amps' }] }]);
  f.capture.setConnected(true); f.capture.receive('invented/meter', '{"output":true,"watts":500,"amps":2.2,"energy":1}');
  const device = f.capture.status().devices[0]; assert.equal(device.available, true);
  assert.equal(device.readings.meter_power.value, 0.5); assert.equal(device.readings.meter_current.value, 2.2);
  assert.equal(f.observations.filter(row => row.signal === 'meter_power').length, 1);
});

test('startMqtt subscribes equipment home topics once, preserves home recorder identity, and leaves unselected native prefixes alone', async t => {
  const f = fixture(t, [home, door]); const client = new EventEmitter(), topics = [];
  client.subscribe = (topic, options, done) => { topics.push(topic); done(); };
  client.publish = (topic, payload, options, done) => done(); client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store, config: { connections: { equipment: f.settings,
    mqtt: { address: 'mqtt://example.invalid', temperatureTopics: { indoor_temperature: 'invented/upstairs' } } } }, connect: () => client });
  f.cleanups.push(() => acquisition.close()); client.emit('connect');
  assert.deepEqual(topics.sort(), ['invented/door', 'invented/upstairs']);
  client.emit('message', 'invented/upstairs', Buffer.from('21.5'));
  assert.equal(f.observations.length, 1); assert.equal(f.observations[0].source, 'mqtt-temperature');
  assert.equal(f.observations[0].device, 'indoor_temperature');
  assert(acquisition.equipment); assert.equal(acquisition.equipment.status().devices.length, 2);
});

test('native identity gates signatures and reannouncement cannot reuse the old physical device identity', async t => {
  const f = fixture(t, [plug]); f.capture.setConnected(true);
  assert.equal(f.capture.signature('caravan'), null);
  await assert.rejects(f.capture.setSwitch('caravan', true), /identity/);
  const info = () => f.publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo');
  f.reply(info(), { id: 'invented-original', gen: 2 });
  const original = f.capture.signature('caravan'); assert.match(original, /^[a-f0-9]{64}$/);
  f.capture.receive('invented/plug/online', 'false'); assert.equal(f.capture.signature('caravan'), null);
  f.capture.receive('invented/plug/online', 'true'); assert.equal(f.capture.signature('caravan'), null);
  f.reply(info(), { id: 'invented-replacement', gen: 2 });
  assert.notEqual(f.capture.signature('caravan'), original);
  assert.equal(JSON.stringify(f.capture.status()).includes('invented-replacement'), false, 'Native hardware identity stays private');
});

test('a full native status missing the required relay cannot reuse an old live relay reading', t => {
  const f = fixture(t, [garage]); f.capture.setConnected(true);
  f.status('invented/garage', { 'switch:0': { output: true }, 'temperature:100': { tC: 10 } });
  f.capture.receive('invented/garage/events/rpc', JSON.stringify({ method: 'NotifyFullStatus', params: { 'temperature:100': { tC: 11 } } }));
  const device = f.capture.status().devices[0]; assert.equal(device.available, false);
  assert.equal(device.readings.garage_relay_active.value, null); assert.equal(device.readings.garage_temperature.value, 11);
  assert.equal(device.readings.garage_temperature.stale, false);
});

test('explicit energy counter field and unit mapping persists hourly kWh with no input.energy fallback', t => {
  const f = fixture(t, [{ id: 'mapped_meter', kind: 'metered_switch', connection: 'mqtt:invented/mapped-meter',
    readings: [{ key: 'energy_counter', path: 'meter.total_wh', unit: 'Wh', label: 'Lifetime counter' }] }]);
  f.capture.setConnected(true);
  for (let minute = 0; minute <= 60; minute++) {
    f.now(initial + minute * 60_000);
    f.capture.receive('invented/mapped-meter', JSON.stringify({ value: true, power: 1, current: 4.3, energy: 999999,
      meter: { total_wh: 1000 + minute * 1000 / 60 } }));
  }
  const rows = f.store.db.prepare("SELECT value FROM observations WHERE signal='mapped_meter_energy'").all();
  assert.equal(rows.length, 1); assert(Math.abs(rows[0].value - 1) < 1e-9);
});

test('public-style garage temperature-only configuration remains available without relay state or a second probe', t => {
  const f = fixture(t, [{ ...garage, kind: 'temperature', signal: 'garage_temperature' }]); f.capture.setConnected(true);
  f.status('invented/garage', { 'temperature:100': { tC: 12 } });
  const device = f.capture.status().devices[0]; assert.equal(device.available, true);
  assert.equal(device.readings.garage_temperature.value, 12);
  assert.equal(device.readings.garage_relay_active, undefined); assert.equal(device.readings.garage_temperature_2, undefined);
});

test('explicit modern native RPC accepts Gen3 identity without changing protocol or deriving new topics', async t => {
  const f = fixture(t, [{ id: 'heat_savings', kind: 'switch', connection: 'shelly:invented/mini', tariff_control: true }]);
  f.capture.setConnected(true);
  f.reply(f.publications.find(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo'), { id: 'invented-mini-gen3', gen: 3 });
  assert.match(f.capture.signature('heat_savings'), /^[a-f0-9]{64}$/);
  const pending = f.capture.publishHeating(['heatoff']); await Promise.resolve();
  const set = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.Set');
  assert.deepEqual(JSON.parse(set.payload).params, { id: 0, on: true });
  f.reply(set, { was_on: false });
  f.reply(f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.GetStatus'), { output: true });
  assert.equal((await pending).confirmed, true);
  assert(f.publications.every(row => row.topic === 'invented/mini/rpc'));
});

test('configured garage MQTT connection uses one canonical signal and expires at two minutes without heartbeat extension', t => {
  const f = fixture(t, [{ id: 'garage', kind: 'temperature', connection: 'mqtt:invented/garage', signal: 'garage_temperature',
    mqtt: { heartbeat_topic: 'invented/garage/heartbeat', heartbeat_seconds: 60 } }]);
  f.capture.setConnected(true);
  f.capture.receive('invented/garage', JSON.stringify({ value: 50, unit: 'F', timestamp: initial }));
  f.capture.receive('invented/garage/heartbeat', 'alive');
  const observation = f.observations.at(-1);
  assert.equal(observation.value, 10); assert.equal(observation.source, 'mqtt-temperature'); assert.equal(observation.device, 'garage_temperature');
  assert.equal(observation.signal, 'garage_temperature'); assert.equal(observation.sourceTime, initial);
  assert.equal(observation.raw.reportIntervalMs + observation.raw.reportGraceMs, 120_000);
  f.now(initial + 119_999); f.capture.receive('invented/garage/heartbeat', 'alive');
  assert.equal(f.capture.status().devices[0].available, true);
  f.now(initial + 120_000); f.capture.receive('invented/garage/heartbeat', 'alive');
  assert.equal(f.capture.status().devices[0].available, false);
  f.capture.receive('invented/garage', JSON.stringify({ value: 10, timestamp: initial }), { retain: true });
  assert.equal(f.capture.status().devices[0].available, false);
  f.capture.receive('invented/garage', JSON.stringify({ value: 10, timestamp: initial + 120_000 }));
  assert.equal(f.capture.status().devices[0].available, true);
});

test('one equipment subscription rejection leaves successfully subscribed equipment available on the same broker', async t => {
  const f = fixture(t, [home, door]), client = new EventEmitter();
  client.subscribe = (topic, options, done) => done(topic === 'invented/door' ? new Error('Rejected') : null);
  client.publish = (topic, payload, options, done) => done(); client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store, config: { connections: { equipment: f.settings,
    mqtt: { address: 'mqtt://example.invalid' } } }, connect: () => client });
  f.cleanups.push(() => acquisition.close()); client.emit('connect');
  client.emit('message', 'invented/upstairs', Buffer.from('21.5'));
  const status = acquisition.equipment.status(); assert.equal(status.connected, true);
  assert.equal(status.devices.find(row => row.id === 'upstairs').available, true);
  assert.equal(status.devices.find(row => row.id === 'garage_door1').available, false);
});

test('Caravan instantaneous values and tariff/garage relay states stay live without database datasets', t => {
  const f = fixture(t, [plug, garage, { id: 'heat_savings', kind: 'switch', connection: 'shelly:invented/tariff' }]);
  const ingested = [], ingest = f.engine.ingest;
  f.engine.ingest = observation => { ingested.push(observation.signal); ingest(observation); };
  f.capture.setConnected(true);
  f.status('invented/plug', { 'switch:0': { output: true, apower: 500, current: 2.2, aenergy: { total: 1000 } } });
  f.status('invented/garage', { 'switch:0': { output: true }, 'temperature:100': { tC: 11 } });
  f.status('invented/tariff', { 'switch:0': { output: false } });
  const caravanStatus = f.capture.status().devices.find(row => row.id === 'caravan');
  assert.equal(caravanStatus.readings.caravan_active.value, 1); assert.equal(caravanStatus.readings.caravan_power.value, 0.5);
  assert.equal(caravanStatus.readings.caravan_current.value, 2.2);
  assert.equal(caravanStatus.source, 'Shelly');
  for (const signal of ['caravan_active', 'caravan_power', 'caravan_current', 'heat_savings_active', 'garage_relay_active']) {
    assert(!ingested.includes(signal)); assert.equal(f.store.observations({ signal }).length, 0);
  }
  assert.equal(f.store.observations({ signal: 'garage_temperature' }).length, 1);
});

test('generic Caravan state/current/power remain runtime-only while completed hourly energy persists', t => {
  const f = fixture(t, [{ id: 'caravan', kind: 'metered_switch', connection: 'mqtt:invented/generic-caravan' }]);
  const ingested = [], ingest = f.engine.ingest;
  f.engine.ingest = observation => { ingested.push(observation.signal); ingest(observation); };
  f.capture.setConnected(true);
  f.now(initial + 3_540_000);
  f.capture.receive('invented/generic-caravan', JSON.stringify({ value: true, power: 0.6, current: 2.6, energy: 1 }));
  f.now(initial + 3_600_000);
  f.capture.receive('invented/generic-caravan', JSON.stringify({ value: true, power: 0.6, current: 2.6, energy: 1.01 }));
  assert.deepEqual(ingested, []);
  assert.equal(f.capture.status().devices[0].readings.caravan_power.value, 0.6);
  const hourly = f.store.observations({ signal: 'caravan_energy' }); assert.equal(hourly.length, 1);
  assert(Math.abs(hourly[0].value - 0.01) < 1e-9);
});

test('retained room replay cannot replace a genuine live reading or alter its deadline', t => {
  const f = fixture(t, [home]); f.capture.setConnected(true);
  f.capture.receive('invented/upstairs', JSON.stringify({ value: 20, timestamp: initial }));
  const deadline = initial + DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS + DEFAULT_TEMPERATURE_REPORT_GRACE_MS;
  f.now(deadline - 1000);
  f.capture.receive('invented/upstairs', JSON.stringify({ value: 25, timestamp: deadline - 1000 }), { retain: true });
  const reading = f.capture.status().devices[0].readings.indoor_temperature;
  assert.equal(reading.value, 20); assert.equal(reading.observedAt, initial); assert.equal(reading.stale, false);
  f.now(deadline); assert.equal(f.capture.status().devices[0].available, false);
});

test('passive MQTT recheck refreshes exact subscriptions and identifies retained context without publishing', async t => {
  const refreshed = [];
  const f = fixture(t, [{ ...door, mqtt: { availability_topic: 'invented/online' } }], {
    refreshSubscriptions: async topics => {
      refreshed.push(topics);
      f.capture.receive('invented/door', 'closed', { retain: true });
    },
  });
  f.capture.setConnected(true);
  let device = (await f.capture.recheck()).devices[0];
  assert.deepEqual(refreshed, [['invented/door', 'invented/online']]);
  assert.equal(f.publications.length, 0);
  assert.equal(device.available, false);
  assert.equal(device.check.status, 'retained-only');
  assert.equal(device.check.subscriptionStatus, 'subscribed');
  assert.equal(device.recheck.requestSupported, false);
  assert.equal(device.recheck.method, 'subscription');
  assert.equal(device.mqttStatus.lastLiveAt, null);
  assert.equal(device.mqttStatus.lastRetainedAt, initial);
  assert.equal(device.readings.garage_door1_open.stale, true);
  f.capture.receive('invented/door', 'open');
  f.now(initial + 60_000);
  device = (await f.capture.recheck()).devices[0];
  assert.equal(device.check.status, 'last-reported');
  assert.equal(device.readings.garage_door1_open.observedAt, initial, 'Rechecking does not renew a measurement');
  assert.equal(device.readings.garage_door1_open.value, 1, 'A retained replay cannot overwrite the live contact');
});

test('passive MQTT recheck reports listening when only the broker subscription is established', async t => {
  const f = fixture(t, [home], { refreshSubscriptions: async () => {} });
  f.capture.setConnected(true);
  const device = (await f.capture.recheck()).devices[0];
  assert.equal(device.check.status, 'listening');
  assert.equal(device.available, false);
  assert.equal(device.mqttStatus.subscriptionStatus, 'subscribed');
  assert.equal(f.observations.length, 0);
  assert.equal(f.publications.length, 0);
});

test('a live MQTT report arriving during subscription refresh is recognized without inventing a device reply', async t => {
  const f = fixture(t, [home], { refreshSubscriptions: async () => f.capture.receive('invented/upstairs', '21.5') });
  f.capture.setConnected(true);
  const device = (await f.capture.recheck()).devices[0];
  assert.equal(device.check.status, 'available');
  assert.equal(device.check.method, 'subscription');
  assert.equal(device.available, true);
  assert.equal(f.publications.length, 0);
});

test('generic status requests wait for every required live topic and a usable heartbeat', async t => {
  // This checks topic qualification, not the timeout. Allow a loaded test
  // runner to yield before the explicit replies; timeout behavior is separate.
  const f = fixture(t, [{ ...genericSwitch,
    mqtt: { ...genericSwitch.mqtt, request_topic: 'invented/get', request_payload: 'status', heartbeat_topic: 'invented/heartbeat', heartbeat_seconds: 30 },
    readings: [{ key: 'power', label: 'Power', unit: 'W', topic: 'invented/power', required: true }],
  }], { readbackTimeoutMs: 2000 });
  f.capture.setConnected(true);
  f.capture.receive('invented/state', 'OFF'); f.capture.receive('invented/power', '0');
  const pending = f.capture.recheck(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.publications.map(row => [row.topic, row.payload]), [['invented/get', 'status']]);
  assert.deepEqual(f.publications[0].options, { qos: 1, retain: false });
  f.capture.receive('invented/state', 'ON');
  assert.equal(f.capture.status().devices[0].check.checking, true, 'Old readings from another topic cannot complete the request');
  f.capture.receive('invented/power', '300', { retain: true });
  assert.equal(f.capture.status().devices[0].check.checking, true);
  f.capture.receive('invented/power', '300');
  assert.equal(f.capture.status().devices[0].check.checking, true, 'Missing required heartbeat still prevents availability');
  f.capture.receive('invented/heartbeat', 'alive');
  const device = (await pending).devices[0];
  assert.equal(device.check.status, 'available');
  assert.equal(device.check.method, 'request');
  assert.equal(device.check.retainedReceived, true);
  assert.equal(device.readings.relay_power.value, 300);
});

test('configured door status is requested after subscriptions and again after reconnect without renewing source time', async t => {
  const f = fixture(t, [{ ...door, mqtt: { request_topic: 'invented/get', request_payload: 'status_update',
    state_path: 'value', timestamp_path: 'timestamp' } }], { readbackTimeoutMs: 2000 });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  f.capture.setConnected(true);
  f.capture.confirmSubscriptions([]);
  await flush();
  assert.equal(f.publications.length, 0, 'No requests before the response subscription succeeds');
  f.capture.confirmSubscriptions(f.capture.topics);
  await flush();
  assert.deepEqual(f.publications, [{ topic: 'invented/get', payload: 'status_update', options: { qos: 1, retain: false } }]);
  f.capture.receive('invented/door', JSON.stringify({ value: 'closed', timestamp: initial }));
  assert.equal(f.capture.status().devices[0].check.status, 'available');
  f.capture.confirmSubscriptions(f.capture.topics);
  await flush();
  assert.equal(f.publications.length, 1, 'Repeated confirmation does not send duplicate requests');

  f.now(initial + 600_000);
  f.capture.setConnected(false);
  f.capture.setConnected(true);
  f.capture.confirmSubscriptions(f.capture.topics);
  await flush();
  assert.equal(f.publications.length, 2);
  f.capture.receive('invented/door', JSON.stringify({ value: 'closed', timestamp: initial }), { retain: true });
  assert.equal(f.capture.status().devices[0].check.checking, true, 'Retained context cannot complete the request');
  f.capture.receive('invented/door', JSON.stringify({ value: 'closed', timestamp: initial }));
  const device = f.capture.status().devices[0];
  assert.equal(device.check.status, 'available');
  assert.equal(device.readings.garage_door1_open.observedAt, initial, 'An HA snapshot preserves the source state time');
  assert.equal(f.observations.at(-1).sourceTime, initial);
});

test('a door snapshot with a configured source timestamp cannot substitute publication time when the timestamp is missing', t => {
  const f = fixture(t, [{ ...door, mqtt: { state_path: 'value', timestamp_path: 'timestamp' } }]);
  f.capture.setConnected(true);
  f.capture.receive('invented/door', JSON.stringify({ value: 'closed', timestamp: initial }));
  f.now(initial + 60_000);
  f.capture.receive('invented/door', JSON.stringify({ value: 'open' }));
  const device = f.capture.status().devices[0];
  assert.equal(device.available, false);
  assert.equal(device.readings.garage_door1_open.value, 0);
  assert.equal(device.readings.garage_door1_open.observedAt, initial);
  assert.deepEqual(f.observations.at(-1).quality, ['invalid-source-time']);
  assert.equal(f.observations.at(-1).value, null);
});

test('a configured generic request that gets only retained data times out without claiming a live reply', async t => {
  const f = fixture(t, [{ ...genericSwitch, mqtt: { ...genericSwitch.mqtt, request_topic: 'invented/get', request_payload: 'status' } }], {
    publish: async () => f.capture.receive('invented/state', 'ON', { retain: true }), readbackTimeoutMs: 15,
  });
  f.capture.setConnected(true);
  const device = (await f.capture.recheck()).devices[0];
  assert.equal(device.check.status, 'timeout');
  assert.equal(device.check.retainedReceived, true);
  assert.equal(device.available, false);
  assert.equal(f.observations.length, 0);
});

test('runtime MQTT recheck verifies broker grants and recovers a denied subscription on the existing connection', async t => {
  const f = fixture(t, [home]), client = new EventEmitter(), subscriptions = [];
  let rejected = true, connections = 0;
  client.subscribe = (topic, options, done) => { subscriptions.push(topic); done(null, [{ topic, qos: rejected ? 128 : 1 }]); };
  client.publish = (topic, payload, options, done) => { assert.fail('Passive recheck must not publish'); done(); };
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store, config: { connections: { equipment: f.settings,
    mqtt: { address: 'mqtt://example.invalid' } } }, connect: () => { connections++; return client; } });
  f.cleanups.push(() => acquisition.close()); client.emit('connect');
  assert.equal(acquisition.equipment.status().devices[0].mqttStatus.subscriptionStatus, 'failed');
  assert.equal((await acquisition.equipment.recheck()).devices[0].check.status, 'unavailable');
  rejected = false;
  const device = (await acquisition.equipment.recheck()).devices[0];
  assert.equal(device.check.status, 'listening');
  assert.equal(device.check.subscriptionStatus, 'subscribed');
  client.emit('message', 'invented/upstairs', Buffer.from('21.5'));
  assert.equal(acquisition.equipment.status().devices[0].available, true);
  assert.deepEqual(subscriptions, ['invented/upstairs', 'invented/upstairs', 'invented/upstairs']);
  assert.equal(connections, 1);
});

test('MQTT and Shelly diagnostics expose complete topic roles without command payloads or native hardware identity', t => {
  const f = fixture(t, [genericSwitch, plug]); f.capture.setConnected(true);
  const [mqttDevice, nativeDevice] = [genericSwitch, plug].map(config => f.capture.status().devices.find(row => row.id === config.id));
  assert.deepEqual(mqttDevice.topics, [
    { role: 'State', topic: 'invented/state', direction: 'subscribe' },
    { role: 'Switch command', topic: 'invented/command', direction: 'publish' },
  ]);
  assert(nativeDevice.topics.some(row => row.role === 'Device subscription' && row.topic === 'invented/plug/#'));
  assert(nativeDevice.topics.some(row => row.role === 'State' && row.topic === 'invented/plug/status/switch:0'));
  assert(nativeDevice.topics.some(row => row.role === 'RPC requests' && row.topic === 'invented/plug/rpc'));
  assert(nativeDevice.topics.some(row => row.role === 'RPC replies' && row.topic.startsWith('stmq-shelly-') && row.topic.endsWith('/rpc')));
  assert.equal(nativeDevice.recheck.method, 'native');
  assert.equal(JSON.stringify(f.capture.status()).includes('onPayload'), false);
});

test('an unanswered subscription refresh finishes unavailable and never leaves diagnostics refreshing', async t => {
  const f = fixture(t, [home], { refreshSubscriptions: () => new Promise(() => {}), readbackTimeoutMs: 15 });
  f.capture.setConnected(true);
  const device = (await f.capture.recheck()).devices[0];
  assert.equal(device.check.status, 'unavailable');
  assert.equal(device.mqttStatus.subscriptionStatus, 'failed');
  assert.equal(device.check.checking, false);
});

test('disconnect during MQTT recheck cancels subscription waiting and prevents a late status publication', async t => {
  const f = fixture(t, [{ ...genericSwitch, mqtt: { ...genericSwitch.mqtt, request_topic: 'invented/get', request_payload: 'status' } }]);
  const client = new EventEmitter(), publications = []; let refresh = false, acknowledge;
  client.subscribe = (topic, options, done) => { if (refresh) acknowledge = done; else done(null, [{ topic, qos: 1 }]); };
  client.publish = (topic, payload, options, done) => { publications.push(topic); done(); };
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store, config: { connections: { equipment: f.settings,
    mqtt: { address: 'mqtt://example.invalid' } } }, connect: () => client });
  f.cleanups.push(() => acquisition.close()); client.emit('connect'); refresh = true;
  const pending = acquisition.equipment.recheck(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof acknowledge, 'function');
  client.emit('offline');
  assert.equal((await pending).devices[0].check.status, 'unavailable');
  acknowledge(null, [{ topic: 'invented/state', qos: 1 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(publications, []);
  assert.equal(acquisition.equipment.status().devices[0].mqttStatus.subscriptionStatus, 'disconnected');
});

test('additional topic groups expose configured H66 and legacy temperature routes without repeating equipment-owned feeds', async t => {
  const f = fixture(t, [home, { ...genericSwitch, tariff_control: true }]), client = new EventEmitter();
  client.subscribe = (topic, options, done) => done();
  client.publish = (topic, payload, options, done) => done(); client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine: f.engine, store: f.store, config: {
    h66: { deviceId: 'invented-h66', writeEnabled: true }, connections: { equipment: f.settings,
      mqtt: { address: 'mqtt://example.invalid', temperatureTopics: { indoor_temperature: 'invented/upstairs', bedroom_temperature: 'invented/bedroom' } },
    } }, connect: () => client });
  f.cleanups.push(() => acquisition.close()); client.emit('connect');
  const groups = acquisition.equipment.status().topicGroups;
  assert.deepEqual(groups.find(group => group.id === 'temperatures').topics.map(row => row.topic), ['invented/bedroom']);
  assert.deepEqual(groups.find(group => group.id === 'h66').topics.map(row => row.topic), [
    'invented-h66/HP/#', 'invented-h66/HP/CMD', 'invented-h66/HP/SET/0203',
    'invented-h66/HP/SET/0212', 'invented-h66/HP/SET/0208', 'invented-h66/HP/SET/2201',
  ]);
  assert.equal(groups.find(group => group.id === 'heating'), undefined, 'The equipment relay owns the selected heating route');
  assert.equal(JSON.stringify(groups).includes('example.invalid'), false, 'Broker addresses remain private');
});
