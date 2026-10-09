import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';

const START = Date.parse('2026-10-09T10:00:00Z');
const IDENTITY = 'a'.repeat(64);
const METER = 'invented-caravan-meter';
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { failOn = false, genericMeter = false } = {}) {
  const store = new Store(':memory:'), publications = [], commands = [];
  let now = START;
  const settings = equipmentConfiguration({ devices: [
    { id: 'air', kind: 'temperature', area: 'garage', signal: 'caravan_temperature', connection: 'mqtt:fixture/air' },
    genericMeter ? { id: 'caravan', kind: 'power', area: 'garage', connection: 'mqtt:fixture/caravan/power',
      max_age_seconds: 180, record: false, mqtt: { state_path: 'power', timestamp_path: 'timestamp' } }
      : { id: 'caravan', kind: 'metered_switch', area: 'garage', connection: 'shelly:fixture/caravan',
        generation: 3, max_age_seconds: 180 },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'air' }, max_age_seconds: 180,
      mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } },
  ] });
  const capture = createEquipmentCapture({ store, settings, engine: { clock: () => now, ingest() {} },
    publish: async (topic, payload, options) => {
      publications.push({ topic, payload });
      if (topic !== 'fixture/dryer/set') return;
      options.beforePublish?.();
      const command = JSON.parse(payload); commands.push(command);
      if (failOn && command.power === 'on') throw new Error('Synthetic publication failure');
    } });
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  capture.receive('fixture/dryer/online', 'online');
  const reply = (method, result) => {
    const publication = publications.findLast(row => row.topic === 'fixture/caravan/rpc' && JSON.parse(row.payload).method === method);
    assert(publication, `Expected native ${method} request`);
    const request = JSON.parse(publication.payload);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, src: METER, dst: request.src, result }));
  };
  const meterConnect = () => {
    if (genericMeter) {
      capture.receive('fixture/caravan/power', JSON.stringify({ power: 100, timestamp: now })); return;
    }
    reply('Shelly.GetDeviceInfo', { id: METER, gen: 3 });
    reply('Shelly.GetStatus', { 'switch:0': { id: 0, output: true, apower: 100, current: 0.5, aenergy: { total: 1000 } } });
  };
  meterConnect();
  const f = { capture, commands, now: () => now, advance: ms => { now += ms; },
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier.temperatureControl,
    air: temperature => capture.receive('fixture/air', JSON.stringify({ value: temperature, timestamp: now })),
    dryer: power => capture.receive('fixture/dryer', JSON.stringify({ identity: IDENTITY, power, fanSpeed: 'low',
      timestamp: now, fieldTimestamps: { power: now, fanSpeed: now }, capabilities: { power: ['off', 'on'], fanSpeed: ['low'] } })),
    meter: (watts = 100, lead = 0) => genericMeter
      ? capture.receive('fixture/caravan/power', JSON.stringify({ power: watts, timestamp: now + lead }))
      : capture.receive('fixture/caravan/events/rpc', JSON.stringify({
        src: METER, method: 'NotifyStatus', params: { ts: (now + lead) / 1000,
          'switch:0': { id: 0, output: true, apower: watts, current: watts / 230 } } })),
    reconnectMeter: () => {
      capture.receive('fixture/caravan/online', 'false');
      capture.receive('fixture/caravan/online', 'true'); meterConnect();
    },
    sample: async (ms, power, watts = 100) => { f.advance(ms); f.dryer(power); f.meter(watts); await settle(); },
    fail: async () => {
      f.dryer('off'); await f.sample(5000, 'off');
      assert.equal(f.commands.length, 1);
      await f.sample(1000, 'off');
      assert.equal(f.state().locationTest.status, 'failed');
      assert.equal(f.state().locationTest.reason, 'command-unconfirmed');
    },
    qualifyManaged: async () => {
      f.air(10); f.dryer('off');
      await f.sample(5000, 'off');
      await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
      await f.sample(1000, 'off'); await f.sample(5000, 'off');
      await f.sample(1000, 'on', 105);
      assert.equal(f.state().qualified, true);
      assert.equal(f.state().desiredPower, 'on');
      assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
    },
  };
  return f;
}

for (const genericMeter of [false, true]) test(`a failed Caravan check does not retry after a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead`, async t => {
  const f = fixture(t, { failOn: true, genericMeter }); await f.fail();
  f.advance(1000); f.meter(100, 500);
  assert.equal(f.state().recording, false);
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().locationTest.status, 'failed', 'Waiting for source time is not a new appliance or meter connection');
  assert.equal(f.state().locationTest.reason, 'command-unconfirmed');
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 1, 'A failed continuous session must leave ordinary controls available');
  assert.equal(f.state().canEdit, true);
});

for (const genericMeter of [false, true]) test(`a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead pauses an active Caravan check without restarting its baseline`, async t => {
  const f = fixture(t, { genericMeter }); f.dryer('off');
  f.advance(5000); f.dryer('off'); f.meter(100, 500); await settle();
  assert.equal(f.commands.length, 0, 'Future source evidence cannot dispatch native power');
  assert.equal(f.state().recording, false);
  assert.equal(f.state().locationTest.status, 'testing');
  assert.equal(f.state().locationTest.phase, 'baseline');
  f.advance(500); f.capture.tick(); await settle();
  assert.deepEqual(f.commands.map(row => row.power), ['on'], 'The original baseline remains usable when the deferred report is admitted');
  assert.equal(f.state().locationTest.phase, 'on');
  assert.equal(f.state().recording, false);
});

test('an actual native Caravan meter outage permits a new check after a failed check', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.advance(1000); f.reconnectMeter(); f.dryer('off');
  assert.equal(f.state().locationTest.status, 'testing');
  assert.equal(f.state().recording, false);
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 2, 'A real meter connection boundary requires a fresh electrical check');
});

test('meter evidence expiring during a source-time wait still invalidates the Caravan check session', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.advance(179900); f.dryer('off'); f.meter(100, 500);
  assert.equal(f.state().locationTest.status, 'failed');
  f.advance(100); f.capture.tick(); await settle();
  assert.equal(f.commands.length, 1);
  assert.equal(f.state().recording, false);
  f.advance(400); f.capture.tick(); await settle();
  assert.equal(f.state().reason, 'power-unavailable', 'Expiry discards pending evidence from before the reporting gap');
  f.meter(100); await settle();
  assert.equal(f.state().locationTest.status, 'testing', 'Expired prior evidence remains a real gap even with a bounded report waiting');
  assert.equal(f.state().locationTest.phase, 'baseline');
});

test('a native meter outage discards its pending source report before Caravan recovery', async t => {
  const f = fixture(t, { failOn: true }); await f.fail();
  f.advance(1000); f.meter(100, 500);
  f.capture.receive('fixture/caravan/online', 'false');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().reason, 'power-unavailable');
  assert.equal(f.state().recording, false);
  assert.equal(f.commands.length, 1, 'A report from the ended connection cannot start a new test');
  f.reconnectMeter(); f.dryer('off');
  assert.equal(f.state().locationTest.status, 'testing');
  await f.sample(5000, 'off');
  assert.equal(f.commands.length, 2);
});

for (const genericMeter of [false, true]) test(`a bounded ${genericMeter ? 'MQTT' : 'native'} meter clock lead cannot cycle managed automatic Caravan power`, async t => {
  const f = fixture(t, { genericMeter }); await f.qualifyManaged();
  f.advance(1000); f.dryer('on'); f.meter(105, 500); f.capture.tick(); await settle();
  assert.equal(f.state().recording, false, 'Pending evidence cannot qualify current recording');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on'], 'A clock wait is not a new Off demand');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(f.state().qualified, true);
  assert.equal(f.state().locationTest.status, 'passed');
  assert.equal(f.state().desiredPower, 'on');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on']);
});

for (const temperature of [1, null]) test(`${temperature === null ? 'Missing' : 'Cold'} Caravan air still requests protective Off during a bounded native meter clock lead`, async t => {
  const f = fixture(t); await f.qualifyManaged();
  f.advance(1000); f.dryer('on'); f.meter(105, 500);
  f.air(temperature); f.capture.tick(); await settle();
  assert.equal(f.state().recording, false);
  assert.equal(f.state().desiredPower, 'off');
  assert.deepEqual(f.commands.map(row => row.power), ['on', 'off', 'on', 'off']);
});
