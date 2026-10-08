import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createShellyCapture } from '../src/acquisition/shelly.js';
import { seedVoltage } from './voltage-fixture.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';
import { Recorder } from '../src/storage/recorder.js';

const HOUR = 3_600_000, initial = Date.parse('2026-09-10T12:00:00Z');
function fixture(t, devices = [], initialAt = initial) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = initialAt, authority = true;
  const observations = [], publications = [];
  const engine = { clock: () => now, ingest: row => { observations.push(row); store.observation(row); }, rememberObservation: row => observations.push(row) };
  const settings = equipmentConfiguration({ devices });
  const capture = createShellyCapture({ engine, store, settings,
    publish: async (topic, payload, options) => { publications.push({ topic, payload, options }); },
    canControl: () => authority, readbackTimeoutMs: 100 });
  t.after(() => { capture.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const identities = new Map();
  const reply = (publication, result, extra = {}) => {
    const request = JSON.parse(publication.payload), prefix = publication.topic.slice(0, -4);
    if (request.method === 'Shelly.GetDeviceInfo') identities.set(prefix, result.id);
    const current = structuredClone(result);
    for (const [key, value] of Object.entries(current)) if (/^[a-z]+:\d+$/.test(key) && value && typeof value === 'object') value.id ??= Number(key.split(':')[1]);
    if (request.method === 'Switch.GetStatus') current.id ??= request.params.id;
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, src: identities.get(prefix), result: current, ...extra }), {}, now);
  };
  const connect = capture.setConnected.bind(capture);
  capture.setConnected = value => {
    connect(value);
    if (value) for (const publication of publications.filter(row => row.topic.endsWith('/rpc') && JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo'))
      reply(publication, { id: `fixture-${publication.topic.slice(0, -4).replaceAll('/', '-')}`, gen: 2 });
  };
  const status = result => reply(publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetStatus'), result);
  return { capture, store, observations, publications, settings, status, reply,
    now: value => { now = value; }, authority: value => { authority = value; } };
}
const caravan = { id: 'caravan', kind: 'metered_switch', connection: 'shelly:invented-caravan' };
const garage = { id: 'garage', kind: 'switch', connection: 'shelly:invented-garage', temperature_id: 100 };
const pairedGarage = { id: 'garage', kind: 'temperature', connection: 'shelly:invented-garage',
  signal: 'garage_temperature', temperature_id: 100, readings: [
    { key: 'front', signal: 'garage_temperature_2', component: 'temperature:101', unit: 'degC', required: true }] };
const heat = { id: 'heat_savings', kind: 'switch', connection: 'shelly:invented-mini', tariff_control: true };

test('native Shelly preserves both pending probe updates and original clocks across a tiny source lead', t => {
  const f = fixture(t, [pairedGarage]); f.capture.setConnected(true);
  f.status({ 'temperature:100': { tC: 9 }, 'temperature:101': { tC: 10 } });
  f.now(initial + 10_000);
  for (const [id, lead, value] of [[100, 4, 11], [101, 5, 12]])
    f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyStatus',
      params: { ts: (initial + 10_000 + lead) / 1000, [`temperature:${id}`]: { id, tC: value } } }));
  assert.equal(f.capture.status().devices[0].readings.garage_temperature.value, 9);
  f.now(initial + 10_005); f.capture.tick();
  for (const [signal, lead, value] of [['garage_temperature', 4, 11], ['garage_temperature_2', 5, 12]]) {
    const row = f.observations.findLast(row => row.signal === signal);
    assert.equal(row.value, value); assert.equal(row.receivedAt, initial + 10_000);
    assert.deepEqual(row.raw.timeAdmission, { sourceTime: initial + 10_000 + lead,
      receivedAt: initial + 10_000, admittedAt: initial + 10_005 });
  }
  f.now(initial - 1);
  assert.equal(f.capture.status().devices[0].available, false);
  assert.equal(f.capture.status().devices[0].readings.garage_temperature.stale, true);
});

test('Gen2 status reads actual plug values, ignores retained/replayed payloads and expires individual readings', t => {
  const f = fixture(t, [caravan]); f.capture.setConnected(true);
  assert(f.publications.every(row => row.options.retain === false));
  f.status({ 'switch:0': { output: true, apower: 575, current: 2.5, aenergy: { total: 12000 } } });
  const values = Object.fromEntries(f.observations.map(row => [row.signal, row.value]));
  assert.equal(values.caravan_active, 1); assert.equal(values.caravan_power, 0.575); assert.equal(values.caravan_current, 2.5);
  const count = f.observations.length;
  f.capture.receive('invented-caravan/status/switch:0', '{"output":false,"apower":0,"current":0}', { retain: true });
  f.capture.receive('invented-caravan/status/switch:0', '{"output":false}', { dup: true });
  assert.equal(f.observations.length, count);
  f.now(initial + 121_000); f.capture.tick(initial + 121_000);
  assert.equal(f.capture.status(initial + 121_000).devices[0].available, false);
  assert.equal(f.observations.at(-1).value, null);
  f.capture.setConnected(false); f.capture.setConnected(true);
  assert.equal(f.capture.status(initial + 121_000).devices[0].available, false, 'A broker reconnect is not a device reading');
});

test('Garage add-on uses external temperature component, never the relay CPU temperature', t => {
  const f = fixture(t, [garage]);
  f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false, temperature: { tC: 55 } }, 'temperature:100': { tC: 12.5 } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, 12.5);
  f.now(initial + 30_000); f.capture.tick(initial + 30_000);
  f.status({ 'switch:0': { output: false, temperature: { tC: 55 } } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, null);
});

test('garage partial notifications preserve other components in an overlapping complete status reply', t => {
  const f = fixture(t, [{ id: 'garage', kind: 'temperature', connection: 'shelly:invented-garage',
    signal: 'garage_temperature', temperature_id: 100, readings: [
      { key: 'front', signal: 'garage_temperature_2', component: 'temperature:101', unit: 'degC', required: true }] }]);
  f.capture.setConnected(true);
  f.status({ 'temperature:100': { tC: 8 }, 'temperature:101': { tC: 9 } });
  f.now(initial + 30_000); f.capture.tick();
  const pending = f.publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetStatus');
  f.now(initial + 30_010);
  f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyStatus',
    params: { ts: (initial + 30_010) / 1000, 'temperature:100': { tC: 8.5 } } }));
  f.now(initial + 30_020);
  f.reply(pending, { 'temperature:100': { tC: 8.25 }, 'temperature:101': { tC: 9.5 } });
  const readings = f.capture.status().devices[0].readings;
  assert.equal(readings.garage_temperature.value, 8.5, 'Newer rear evidence survives a delayed poll');
  assert.equal(readings.garage_temperature.observedAt, initial + 30_010);
  assert.equal(readings.garage_temperature_2.value, 9.5, 'Unrelated rear notification does not discard front poll');
  assert.equal(readings.garage_temperature_2.observedAt, initial + 30_000);
  f.now(initial + 150_001);
  assert.equal(f.capture.status().devices[0].readings.garage_temperature_2.stale, true, 'No freshness extension');
});

test('Direct heating requires a post-command Switch.GetStatus response and preserves configurable polarity', async t => {
  const f = fixture(t, [{ ...heat, reduction_on: false }]);
  f.capture.setConnected(true);
  const pending = f.capture.publishHeating(['reduction']);
  await Promise.resolve();
  const set = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.Set');
  assert.deepEqual(JSON.parse(set.payload).params, { id: 0, on: false });
  let settled = false; pending.then(() => { settled = true; });
  f.status({ 'switch:0': { output: false } });
  await Promise.resolve(); assert.equal(settled, false, 'Preexisting snapshot cannot verify a command');
  f.reply(set, { was_on: true });
  const get = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  assert(get); f.reply(get, { output: false });
  const result = await pending; assert.equal(result.acknowledgement, 'shelly-live-relay-readback');
  f.authority(false);
  await assert.rejects(f.capture.publishHeating(['normal']), /unavailable/);
});

test('Readback timeout and device disconnect never claim delivery', async t => {
  const f = fixture(t, [heat]);
  f.capture.setConnected(true);
  await assert.rejects(f.capture.publishHeating(['reduction']), /readback timed out/);
  const pending = f.capture.publishHeating(['reduction']);
  f.capture.receive('invented-mini/online', 'false');
  await assert.rejects(pending, /unavailable/);
});

test('Gen1 plug watt-minute counter converts to kWh and labels current as an estimate', t => {
  const f = fixture(t, [{ ...caravan, generation: 1, connection: 'shelly:shellies/invented-plug' }]);
  seedVoltage(f.store, initial, [240, 240, 240]);
  f.capture.setConnected(true);
  f.capture.receive('shellies/invented-plug/relay/0', 'on');
  f.capture.receive('shellies/invented-plug/relay/0/power', '460');
  f.capture.receive('shellies/invented-plug/relay/0/energy', '60000');
  const current = f.observations.find(row => row.signal === 'caravan_current');
  assert.equal(current.value, 460 / 240); assert(current.quality.includes('estimated'));
  assert.equal(current.raw.voltageV, 240);
  assert.equal(current.raw.phase, 'unknown');
  assert.equal(f.store.getState('shelly:caravan-energy:v2').previous.counterKwh, 1);
});

test('Gen1 power and availability remain usable before voltage history can estimate current', t => {
  const f = fixture(t, [{ ...caravan, generation: 1, connection: 'shelly:shellies/invented-plug' }]);
  f.capture.setConnected(true);
  f.capture.receive('shellies/invented-plug/relay/0', 'on');
  f.capture.receive('shellies/invented-plug/relay/0/power', '460');
  const readings = f.capture.status(initial).devices[0];
  assert.equal(readings.available, true);
  assert.equal(readings.readings.caravan_power.value, .46);
  assert.equal(readings.readings.caravan_current.value, null);
  assert.deepEqual(readings.readings.caravan_current.quality, ['voltage-estimate-unavailable']);
});

test('Adaptive counter deltas survive restart and conserve measured energy across resets', t => {
  const f = fixture(t, []), recorder = new Recorder(f.store);
  const energy = createCaravanEnergy({ store: f.store, recorder, device: 'fixture-caravan', maxGapMs: 120_000 });
  energy.receive(20, initial - 30_000);
  energy.tick(initial);
  energy.receive(20.01, initial + 30_000);
  const rows = f.store.observations({ signal: 'caravan_energy' });
  assert.equal(rows.length, 1); assert(Math.abs(rows[0].value - 0.01) < 1e-10);
  assert.equal(rows[0].raw.intervalStart, initial - 30_000);
  assert.equal(rows[0].raw.intervalEnd, initial + 30_000);
  assert.equal(rows[0].raw.basis, 'meter-counter-delta');
  const resumed = createCaravanEnergy({ store: f.store, recorder, device: 'fixture-caravan', maxGapMs: 120_000 });
  resumed.receive(20.02, initial + 60_000);
  assert(Math.abs(resumed.status(initial + 60_000).dailyKwh - 0.02) < 1e-10);
  resumed.receive(0.001, initial + 90_000);
  assert.equal(resumed.status(initial + 90_000).counterReset, true);
  resumed.receive(0.003, initial + 120_000);
  resumed.tick(initial + HOUR + 120_000);
  const completed = f.store.observations({ signal: 'caravan_energy' });
  assert(completed.some(row => row.value === null));
  const measured = completed.filter(row => Number.isFinite(row.value));
  assert(measured.every(row => row.value >= 0));
  assert(Math.abs(measured.reduce((sum, row) => sum + row.value, 0) - 0.022) < 1e-10);
  assert(measured.every(row => row.raw.learningRole === 'history-only'));
});

test('Midnight in Helsinki resets the daily display; long offline gaps and implausible counter jumps are not allocated', t => {
  const f = fixture(t, []), energy = createCaravanEnergy({ store: f.store, device: 'fixture-caravan', maxGapMs: 120_000 });
  const midnight = Date.parse('2026-09-10T21:00:00Z');
  energy.receive(1, midnight - 30_000); energy.receive(1.01, midnight + 30_000);
  assert(Math.abs(energy.status(midnight + 30_000).dailyKwh - 0.005) < 1e-10);
  energy.receive(10, midnight + HOUR); // Distribution during an outage is unknown.
  energy.receive(1e9, midnight + HOUR + 30_000); // Not physically possible for a plug.
  assert(Math.abs(energy.status(midnight + HOUR + 30_000).dailyKwh - 0.005) < 1e-10);
  assert.equal(energy.status(midnight + HOUR + 30_000).partial, true);
});

test('Full invalid switch status and unrelated partial changes cannot restore component availability', t => {
  const f = fixture(t, [garage]);
  f.capture.setConnected(true);
  f.status({ 'switch:0': { output: true }, 'temperature:100': { tC: 12 } });
  assert.equal(f.capture.status(initial).devices[0].available, true);
  f.now(initial + 30_000); f.capture.tick(initial + 30_000);
  f.status({ 'switch:0': { errors: ['overtemp'] }, 'temperature:100': { tC: 12 } });
  assert.equal(f.capture.status(initial + 30_000).devices[0].available, false);
  assert.equal(f.capture.status(initial + 30_000).devices[0].readings.garage_relay_active.value, null);
  f.now(initial + 151_000);
  f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyStatus', params: { 'switch:0': { id: 0, output: false } } }));
  assert.equal(f.capture.status(initial + 151_000).devices[0].available, false, 'The external temperature still expired');
});

test('Selected native garage ignores unselected MQTT topics and never creates an alternate garage stream', async t => {
  const { EventEmitter } = await import('node:events');
  const { startMqtt } = await import('../src/acquisition/mqtt.js');
  const { Engine } = await import('../src/app/engine.js');
  const { loadConfig } = await import('../src/app/config.js');
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-integration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'mqtt',
    connections: { mqtt: { address: 'mqtt://example.invalid' },
      equipment: equipmentConfiguration({ devices: [{ ...garage, connection: 'shelly:invented-direct-garage' }, caravan] }) } };
  let now = initial;
  const engine = new Engine({ store, config, clock: () => now });
  const client = new EventEmitter();
  const publications = [];
  client.subscribe = (topic, options, done) => done();
  client.publish = (topic, payload, options, done) => { publications.push({ topic, payload }); done(); };
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => {
    await acquisition.close();
    await engine.garage.close({ restore: false }); await engine.charging.close();
    await engine.closeFireplace(); await engine.executor.close({ restore: false });
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  client.emit('connect');
  const identification = publications.map(row => { try { return JSON.parse(row.payload); } catch { return null; } })
    .find(row => row?.method === 'Shelly.GetDeviceInfo');
  client.emit('message', `${identification.src}/rpc`, Buffer.from(JSON.stringify({ id: identification.id,
    dst: identification.src, src: 'invented-direct-gateway', result: { id: 'invented-direct-gateway', gen: 2 } })));
  client.emit('message', 'invented-direct-garage/status/temperature:100', Buffer.from('{"id":100,"tC":11}'));
  client.emit('message', 'invented-ha/garage', Buffer.from('18.5'));
  assert.equal(engine.latest.garage_temperature.value, 11);
  assert.equal(Object.keys(engine.latest).filter(signal => signal.startsWith('garage_temperature')).length, 1);
  assert.equal(store.observations({ signal: 'garage_temperature' }).length, 1);
  assert.equal(engine.status().equipment.devices.length, 2);
  now += 30_000;
  client.emit('message', 'invented-ha/garage', Buffer.from('invalid-json'));
  assert.equal(engine.latest.garage_temperature.value, 11);
  assert.equal(store.observations({ signal: 'garage_temperature' }).length, 1);
  client.emit('offline');
  assert.equal(engine.latest.garage_temperature.value, null);
});

test('Garage temperature routes bind the native Shelly identity and preserve it on transport loss', t => {
  const f = fixture(t, [garage]); f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false }, 'temperature:100': { tC: 9 } });
  const original = f.observations.findLast(row => row.signal === 'garage_temperature');
  assert.match(original.raw.temperatureRouteSignature, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(original).includes('fixture-invented-garage'), false);
  f.now(initial + 10_000); f.capture.receive('invented-garage/online', 'false');
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').raw.temperatureRouteSignature,
    original.raw.temperatureRouteSignature);
  const count = f.observations.length;
  f.capture.receive('invented-garage/status/temperature:100', '{"id":100,"tC":10}');
  assert.equal(f.observations.length, count, 'A topic publication without authenticated native identity cannot grant permission');
  f.now(initial + 20_000); f.capture.receive('invented-garage/online', 'true');
  f.reply(f.publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo'),
    { id: 'invented-replacement-gateway', gen: 2 });
  const changed = f.observations.findLast(row => row.signal === 'garage_temperature');
  assert.equal(changed.value, null); assert(changed.quality.includes('sensor-identity-changed'));
  assert.notEqual(changed.raw.temperatureRouteSignature, original.raw.temperatureRouteSignature);
  f.status({ 'switch:0': { output: false }, 'temperature:100': { tC: 10 } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, 10);
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').raw.temperatureRouteSignature,
    changed.raw.temperatureRouteSignature);
});

for (const [name, timestamp] of [
  ['1001 milliseconds ahead', (initial + 11_001) / 1000],
  ['one hour ahead', (initial + HOUR) / 1000],
  ['null', null], ['numeric string', String(initial / 1000)], ['nonnumeric string', 'invalid'],
  ['boolean', true], ['object', {}], ['noncoercible object', { toString: null, valueOf: null }],
  ['negative', -1], ['unsafe integer', Number.MAX_SAFE_INTEGER],
]) test(`Shelly ${name} clock rejects only the incoming measurement and preserves original expiry`, t => {
  const f = fixture(t, [pairedGarage]); f.capture.setConnected(true);
  f.status({ 'temperature:100': { tC: 9 }, 'temperature:101': { tC: 10 } });
  const before = structuredClone(f.capture.status().devices[0]), count = f.observations.length;
  f.now(initial + 10_000);
  f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyStatus',
    params: { ts: timestamp, 'temperature:100': { id: 100, tC: 11 } } }));
  assert.equal(f.observations.length, count, 'Rejected clock neither creates evidence nor invalidates either probe');
  assert.deepEqual(f.capture.status().devices[0].readings, before.readings);
  assert.equal(f.capture.status().devices[0].observedAt, initial, 'No device liveness credit');
  assert.equal(f.capture.status().devices[0].available, true);
  f.now(initial + 119_999);
  f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyFullStatus',
    params: { ts: (initial + HOUR) / 1000, 'temperature:100': { tC: 12 }, 'temperature:101': { tC: 13 } } }));
  assert.equal(f.observations.length, count, 'A rejected full snapshot cannot renew either probe');
  assert.equal(f.capture.status().devices[0].available, true);
  f.now(initial + 120_000); f.capture.tick();
  const expired = f.capture.status().devices[0];
  assert.equal(expired.available, false);
  for (const signal of ['garage_temperature', 'garage_temperature_2']) {
    assert.equal(expired.readings[signal].value, null);
    assert(expired.readings[signal].quality.includes('missing-report'));
  }
});

test('a rejected Shelly clock cannot establish a first reading or undo a real fault', t => {
  const f = fixture(t, [pairedGarage]); f.capture.setConnected(true);
  const notification = (ts, temperature) => f.capture.receive('invented-garage/events/rpc', JSON.stringify({
    src: 'fixture-invented-garage', method: 'NotifyStatus', params: { ts, 'temperature:100': { tC: temperature } } }));
  notification((initial + 4) / 1000, 9);
  assert.equal(f.observations.length, 0);
  assert.equal(f.capture.status().devices[0].available, false);
  f.status({ 'temperature:100': { tC: 9 }, 'temperature:101': { tC: 10 } });
  f.now(initial + 10_000); notification((initial + 10_000) / 1000, null);
  const fault = structuredClone(f.capture.status().devices[0].readings.garage_temperature);
  f.now(initial + 20_000); notification((initial + 20_004) / 1000, 11);
  assert.deepEqual(f.capture.status().devices[0].readings.garage_temperature, fault);
  assert.equal(f.capture.status().devices[0].available, false);
  f.now(initial + 30_000); notification((initial + 30_000) / 1000, 12);
  const recovered = f.capture.status().devices[0];
  assert.equal(recovered.available, true);
  assert.equal(recovered.readings.garage_temperature.value, 12);
  assert.equal(recovered.readings.garage_temperature.observedAt, initial + 30_000);
  assert.equal(recovered.readings.garage_temperature_2.observedAt, initial);
});

for (const component of [{ tC: null }, { tC: 999 }, { tC: 9, errors: ['read'] }])
  for (const probe of [100, 101]) test(`a rejected Shelly clock cannot hide probe ${probe} fault ${JSON.stringify(component)}`, t => {
    const f = fixture(t, [pairedGarage]); f.capture.setConnected(true);
    f.status({ 'temperature:100': { tC: 9 }, 'temperature:101': { tC: 10 } });
    f.now(initial + 10_000);
    f.capture.receive('invented-garage/events/rpc', JSON.stringify({ src: 'fixture-invented-garage', method: 'NotifyStatus',
      params: { ts: (initial + 10_004) / 1000, [`temperature:${probe}`]: component } }));
    const affected = probe === 100 ? 'garage_temperature' : 'garage_temperature_2';
    const other = probe === 100 ? 'garage_temperature_2' : 'garage_temperature';
    const reading = f.observations.findLast(row => row.signal === affected);
    assert.equal(reading.value, null); assert.equal(reading.sourceTime, null);
    assert.equal(reading.receivedAt, initial + 10_000);
    assert.equal(reading.raw.timeBasis, 'availability-transition');
    const state = f.capture.status().devices[0];
    assert.equal(state.available, false);
    assert.equal(state.readings[other].observedAt, initial);
    assert.equal(state.readings[other].value, probe === 100 ? 10 : 9);
  });

test('a rejected Shelly clock cannot change relay state or meter energy', t => {
  const f = fixture(t, [caravan]); f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false, apower: 0, current: 0, aenergy: { total: 12000 } } });
  const before = structuredClone(f.capture.status().devices[0]), count = f.observations.length;
  f.now(initial + 10_000);
  f.capture.receive('invented-caravan/events/rpc', JSON.stringify({ src: 'fixture-invented-caravan', method: 'NotifyStatus',
    params: { ts: (initial + 10_004) / 1000, 'switch:0': { id: 0, output: true, apower: 100, current: 1, aenergy: { total: 12001 } } } }));
  const after = f.capture.status().devices[0];
  assert.deepEqual(after.readings, before.readings);
  assert.deepEqual(after.energy, before.energy);
  assert.deepEqual(f.store.getState('shelly:caravan-energy:v2').previous, { counterKwh: 12, at: initial });
  assert.equal(f.observations.length, count);
  assert.equal(after.observedAt, initial);
});

test('a failed identity check invalidates a temperature already held through transport loss', t => {
  const f = fixture(t, [garage]); f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false }, 'temperature:100': { tC: 9 } });
  f.now(initial + 10_000); f.capture.receive('invented-garage/online', 'false');
  f.now(initial + 20_000); f.capture.receive('invented-garage/online', 'true');
  f.reply(f.publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo'),
    { id: '!', gen: 2 });
  const reading = f.observations.findLast(row => row.signal === 'garage_temperature');
  assert.equal(reading.value, null); assert(reading.quality.includes('device-identity-unavailable'));
});

test('an RPC device error is recorded even after a transport-only outage already made readings null', t => {
  const f = fixture(t, [garage]); f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false }, 'temperature:100': { tC: 9 } });
  f.now(initial + 10_000); f.capture.receive('invented-garage/online', 'false');
  f.now(initial + 20_000); f.capture.receive('invented-garage/online', 'true');
  const request = JSON.parse(f.publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetDeviceInfo').payload);
  f.capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src,
    error: { code: -1, message: 'Synthetic device error' } }));
  const reading = f.observations.findLast(row => row.signal === 'garage_temperature');
  assert.equal(reading.value, null); assert(reading.quality.includes('device-rpc-error'));
});

test('A late readback from a timed-out command cannot confirm a newer command with the same output', async t => {
  const f = fixture(t, [heat]);
  f.capture.setConnected(true);
  const first = f.capture.publishHeating(['reduction']);
  const firstSet = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.Set');
  f.now(initial + 50); f.reply(firstSet, { was_on: false });
  const staleRead = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  await assert.rejects(first, /readback timed out/);
  f.now(initial + 100);
  const second = f.capture.publishHeating(['reduction']);
  let completed = false; second.then(() => { completed = true; });
  f.now(initial + 110); f.reply(staleRead, { output: true });
  await Promise.resolve(); assert.equal(completed, false);
  const secondSet = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.Set');
  f.reply(secondSet, { was_on: true });
  const currentRead = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  f.reply(currentRead, { output: true });
  await second;
});
