import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig } from '../src/app/config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { temperatureRouteSignature } from '../src/acquisition/mqtt-temperature.js';

const start = Date.parse('2026-09-14T10:00:00Z'), MINUTE = 60_000;
const home = { id: 'upstairs', kind: 'temperature', connection: 'mqtt:synthetic/upstairs', signal: 'indoor_temperature' };
function fixture(t) {
  const store = new Store(':memory:'), acquisitions = [];
  let now = start;
  t.after(async () => { for (const capture of acquisitions.reverse()) await capture.close(); store.close(); });
  const defaults = loadConfig({ HOME: '/missing-synthetic-home' }, '/missing-synthetic-repository');
  async function connect({ legacy = false, row = home, rows = [row], broker = 'mqtt://synthetic.invalid', user = 'synthetic',
    interval = 70 * MINUTE, grace = 5 * MINUTE, reject = null, deferred = false } = {}) {
    const client = new EventEmitter(), subscriptions = [], pending = [], publications = [];
    let connectOptions;
    client.subscribe = (topic, options, done) => { subscriptions.push(topic); if (deferred) pending.push({ topic, done }); else done(topic === reject ? new Error('Denied') : null); };
    client.publish = (topic, payload, options, done) => { publications.push({ topic, payload }); done(); };
    client.end = (force, options, done) => done();
    const config = { ...defaults, input: 'mqtt', deviceId: null,
      control: { ...defaults.control, indoorSensorWeights: { indoor_temperature: 1 } }, connections: {
        mqtt: { address: broker, user, temperatureReportIntervalMs: interval, temperatureReportGraceMs: grace,
          ...(legacy ? { temperatureTopics: { indoor_temperature: row.connection.slice(5) } } : {}) },
        ...(!legacy ? { equipment: equipmentConfiguration({ devices: rows }) } : {}),
      } };
    const engine = new Engine({ store, config, clock: () => now });
    const capture = await startMqtt({ engine, store, config, connect: (_address, options) => { connectOptions = options; return client; } }); acquisitions.push(capture);
    const publish = (topic, value, timestamp = now, packet = {}) => client.emit('message', topic,
      Buffer.from(JSON.stringify({ value, timestamp, unit: 'C' })), packet);
    return { client, capture, engine, config, subscriptions, pending, publications, publish, connectOptions,
      ready: () => client.emit('connect'), room: () => engine.status().observations.indoor,
      equipment: () => capture.equipment?.status().devices.find(device => device.id === 'upstairs') };
  }
  return { store, connect, at: value => { now = value; } };
}

for (const legacy of [false, true]) test(`${legacy ? 'legacy topic' : 'equipment'} reconnect restores signed room reports without changing report clocks or earlier outages`, async t => {
  const f = fixture(t), first = await f.connect({ legacy }); first.ready();
  first.publish('synthetic/upstairs', 20); f.at(start + MINUTE); first.publish('synthetic/upstairs', 20);
  const saved = f.store.observations({ signal: 'indoor_temperature' }).find(row => row.value === 20);
  assert.match(saved.raw.temperatureRouteSignature, /^[a-f0-9]{64}$/);
  f.at(start + 2 * MINUTE); if (legacy) first.client.emit('offline'); await first.capture.close();
  const gap = f.store.db.prepare("SELECT id,start_at,end_at,status FROM recorder_coverage WHERE signal='indoor_temperature' AND status<>'fresh' ORDER BY id DESC LIMIT 1").get();
  f.at(start + 3 * MINUTE); const resumed = await f.connect({ legacy });
  assert.equal(resumed.room().value, null); resumed.ready();
  assert.equal(resumed.room().value, 20); assert.equal(resumed.room().stale, false);
  assert.deepEqual(f.store.db.prepare('SELECT id,start_at,end_at,status FROM recorder_coverage WHERE id=?').get(gap.id), gap);
  const recovered = f.store.observations({ signal: 'indoor_temperature' }).findLast(row => row.raw?.transportRecoveredAt);
  assert.equal(recovered.raw.originalReportSourceTime, start + MINUTE);
  assert.equal(recovered.raw.originalReportReceivedAt, start + MINUTE);
  if (!legacy) {
    const reading = resumed.equipment().readings.indoor_temperature;
    assert.equal(reading.observedAt, start + MINUTE); assert.equal(reading.receivedAt, start + MINUTE); assert.equal(reading.stale, false);
  }
  f.at(start + 76 * MINUTE - 1); assert.equal(resumed.room().stale, false);
  f.at(start + 76 * MINUTE); assert.equal(resumed.room().value, null);
  if (!legacy) assert.equal(resumed.equipment().available, false);
});

test('policy-change restart recovers only after subscription with the same signed route', async t => {
  const f = fixture(t), first = await f.connect({ interval: 15 * MINUTE, grace: 2 * MINUTE }); first.ready();
  first.publish('synthetic/upstairs', 21); f.at(start + MINUTE); await first.capture.close();
  f.at(start + 20 * MINUTE); const resumed = await f.connect({ deferred: true }); resumed.ready();
  assert.equal(resumed.room().value, null); assert.equal(resumed.equipment().available, false);
  resumed.pending.find(row => row.topic === 'synthetic/upstairs').done();
  assert.equal(resumed.room().value, 21); assert.equal(resumed.equipment().readings.indoor_temperature.observedAt, start);
  f.at(start + 75 * MINUTE); assert.equal(resumed.room().value, null);
});

test('unsigned history, changed broker/topic/decoder mapping and failed subscriptions cannot recover a room', async t => {
  for (const change of ['unsigned', 'topic', 'broker', 'mapping', 'denied']) {
    const f = fixture(t), first = await f.connect(); first.ready();
    if (change === 'unsigned') first.engine.ingest({ source: 'mqtt-temperature', device: 'indoor_temperature', signal: 'indoor_temperature',
      value: 20, unit: 'degC', sourceTime: start, receivedAt: start, quality: [], raw: { reportIntervalMs: 70 * MINUTE, reportGraceMs: 5 * MINUTE } });
    else first.publish('synthetic/upstairs', 20);
    f.at(start + MINUTE); await first.capture.close(); f.at(start + 2 * MINUTE);
    const resumed = await f.connect(change === 'topic' ? { row: { ...home, connection: 'mqtt:synthetic/other' } }
      : change === 'broker' ? { broker: 'mqtt://other.invalid' }
        : change === 'mapping' ? { row: { ...home, mqtt: { state_path: 'temperature' } } }
          : change === 'denied' ? { reject: 'synthetic/upstairs' } : {});
    resumed.ready(); assert.equal(resumed.equipment().available, false, change); assert.equal(resumed.room().value, null, change);
  }
});

test('invalid payload exclusions survive transport recovery and no garage, door or control state is seeded', async t => {
  const rows = [home, { id: 'garage', kind: 'temperature', connection: 'mqtt:synthetic/garage', signal: 'garage_temperature' },
    { id: 'caravan', kind: 'metered_switch', connection: 'mqtt:synthetic/caravan', switch_control: true,
      mqtt: { command_topic: 'synthetic/caravan/set', on_payload: 'ON', off_payload: 'OFF' } },
    { id: 'garage_door1', kind: 'door', connection: 'mqtt:synthetic/door' }];
  const f = fixture(t), first = await f.connect({ rows }); first.ready();
  first.publish('synthetic/upstairs', 20); first.publish('synthetic/garage', 12);
  first.client.emit('message', 'synthetic/caravan', Buffer.from('{"value":true,"power":0.1,"current":0.4,"energy":1}'));
  first.client.emit('message', 'synthetic/door', Buffer.from('closed'));
  f.at(start + 10_000); first.client.emit('message', 'synthetic/upstairs', Buffer.from('invalid'));
  f.at(start + 20_000); await first.capture.close(); f.at(start + 30_000);
  const resumed = await f.connect({ rows }); resumed.ready();
  assert.equal(resumed.room().value, null);
  const status = resumed.capture.equipment.status();
  assert(status.devices.every(device => !device.available));
  assert.deepEqual(status.devices.find(device => device.id === 'caravan').readings, {});
  assert.equal(resumed.publications.length, 0);
  resumed.publish('synthetic/upstairs', 22, start + 5_000);
  assert.equal(resumed.room().value, null, 'A delayed pre-exclusion report cannot revive model input');
  assert.equal(resumed.equipment().available, false, 'Equipment cache respects the same rejected source timestamp');
});

test('manual reconnect subscriptions require broker acknowledgement and rejection cannot recover cached room state', async t => {
  const f = fixture(t), live = await f.connect({ deferred: true }); live.ready();
  assert.equal(live.connectOptions.resubscribe, false, 'MQTT.js must not acknowledge manual subscriptions from its automatic resubscribe cache');
  live.pending.find(row => row.topic === 'synthetic/upstairs').done(); live.publish('synthetic/upstairs', 20);
  f.at(start + MINUTE); live.client.emit('offline'); f.at(start + 2 * MINUTE); live.ready();
  assert.equal(live.room().value, null); assert.equal(live.equipment().available, false);
  live.pending.filter(row => row.topic === 'synthetic/upstairs')[1].done(new Error('Private denial details'));
  assert.equal(live.room().value, null); assert.equal(live.equipment().available, false);
  assert.equal(JSON.stringify(f.store.events()).includes('Private denial'), false);
});

test('genuine room packets arriving before unrelated SUBACKs retain their original measurement and receipt times', async t => {
  const rows = [home, { id: 'garage_door1', kind: 'door', connection: 'mqtt:synthetic/door' }];
  const f = fixture(t), first = await f.connect({ rows }); first.ready(); first.publish('synthetic/upstairs', 20);
  f.at(start + MINUTE); await first.capture.close(); f.at(start + 2 * MINUTE);
  const resumed = await f.connect({ rows, deferred: true }); resumed.ready();
  resumed.pending.find(row => row.topic === 'synthetic/upstairs').done();
  resumed.publish('synthetic/upstairs', 21);
  f.at(start + 3 * MINUTE); resumed.pending.find(row => row.topic === 'synthetic/door').done();
  assert.equal(resumed.room().value, 21);
  const reading = resumed.equipment().readings.indoor_temperature;
  assert.equal(reading.observedAt, start + 2 * MINUTE); assert.equal(reading.receivedAt, start + 2 * MINUTE);
});

test('early retained offline evidence is processed before cached room recovery', async t => {
  const row = { ...home, mqtt: { availability_topic: 'synthetic/upstairs/online' } };
  const rows = [row, { id: 'garage_door1', kind: 'door', connection: 'mqtt:synthetic/door' }];
  const f = fixture(t), first = await f.connect({ rows }); first.ready(); first.publish('synthetic/upstairs', 20);
  f.at(start + MINUTE); await first.capture.close(); f.at(start + 2 * MINUTE);
  const resumed = await f.connect({ rows, deferred: true }); resumed.ready();
  for (const entry of resumed.pending.filter(entry => entry.topic !== 'synthetic/door')) entry.done();
  resumed.client.emit('message', 'synthetic/upstairs/online', Buffer.from('offline'), { retain: true });
  resumed.pending.find(entry => entry.topic === 'synthetic/door').done();
  assert.equal(resumed.room().value, null); assert.equal(resumed.equipment().available, false);
});

test('buffered offline then genuine room recovery uses event receipt order instead of subscription completion time', async t => {
  const row = { ...home, mqtt: { availability_topic: 'synthetic/upstairs/online' } };
  const rows = [row, { id: 'garage_door1', kind: 'door', connection: 'mqtt:synthetic/door' }];
  const f = fixture(t), live = await f.connect({ rows, deferred: true }); live.ready();
  for (const entry of live.pending.filter(entry => entry.topic !== 'synthetic/door')) entry.done();
  live.client.emit('message', 'synthetic/upstairs/online', Buffer.from('offline'));
  f.at(start + 1_000); live.client.emit('message', 'synthetic/upstairs/online', Buffer.from('online'));
  f.at(start + 2_000); live.publish('synthetic/upstairs', 21);
  f.at(start + MINUTE); live.pending.find(entry => entry.topic === 'synthetic/door').done();
  assert.equal(live.room().value, 21); assert.equal(live.equipment().available, true);
  assert.equal(live.equipment().readings.indoor_temperature.observedAt, start + 2_000);
  assert.equal(live.equipment().readings.indoor_temperature.receivedAt, start + 2_000);
  const failure = f.store.observations({ signal: 'indoor_temperature' }).find(row => row.value === null);
  assert.equal(failure.receivedAt, start);
});

test('subscription setup buffers are bounded and discarded on broker disconnect', async t => {
  const rows = [home, { id: 'garage_door1', kind: 'door', connection: 'mqtt:synthetic/door' }];
  const f = fixture(t), live = await f.connect({ rows, deferred: true }); live.ready();
  live.pending.find(entry => entry.topic === 'synthetic/upstairs').done();
  live.publish('synthetic/upstairs', 20);
  live.client.emit('offline'); f.at(start + MINUTE); live.ready();
  for (const entry of live.pending.slice(3)) entry.done();
  assert.equal(live.room().value, null); assert.equal(live.equipment().available, false, 'Old-connection packets cannot be replayed on reconnect');
  live.publish('synthetic/upstairs', 21);
  live.client.emit('offline'); f.at(start + 2 * MINUTE); live.ready();
  live.pending.filter(row => row.topic === 'synthetic/upstairs').at(-1).done();
  for (let index = 0; index < 257; index++) live.publish('synthetic/upstairs', 22);
  live.pending.filter(row => row.topic === 'synthetic/door').at(-1).done();
  assert.equal(live.room().value, null); assert.equal(live.equipment().available, false, 'Overflow cannot silently erase a later invalidation and restore old state');
});

test('recovery storage failures remain sanitized and do not populate the equipment cache', async t => {
  const f = fixture(t), first = await f.connect(); first.ready(); first.publish('synthetic/upstairs', 20);
  f.at(start + MINUTE); await first.capture.close(); f.at(start + 2 * MINUTE);
  const resumed = await f.connect();
  resumed.engine.confirmTemperatureConnection = () => { throw new Error('Private database details'); };
  assert.doesNotThrow(() => resumed.ready());
  assert.equal(resumed.equipment().available, false); assert.equal(resumed.room().value, null);
  assert.equal(JSON.stringify(f.store.events()).includes('Private database'), false);
  assert(f.store.events().some(event => event.type === 'mqtt-temperature-recovery-failed'));
});

test('stale subscription acknowledgements cannot recover rooms on a newer connection generation', async t => {
  const f = fixture(t), first = await f.connect(); first.ready(); first.publish('synthetic/upstairs', 20);
  f.at(start + MINUTE); await first.capture.close(); f.at(start + 2 * MINUTE);
  const resumed = await f.connect({ deferred: true }); resumed.ready(); const stale = resumed.pending.find(row => row.topic === 'synthetic/upstairs');
  resumed.client.emit('offline'); resumed.ready(); stale.done();
  assert.equal(resumed.equipment().available, false); assert.equal(resumed.room().value, null);
  resumed.pending.filter(row => row.topic === 'synthetic/upstairs')[1].done(); assert.equal(resumed.equipment().available, true); assert.equal(resumed.room().value, 20);
});

test('room route signatures exclude presentation and include broker credentials identity and decoding paths', () => {
  const config = { brokerIdentity: { address: 'mqtt://synthetic.invalid', username: 'synthetic' }, topic: 'synthetic/upstairs' };
  const digest = temperatureRouteSignature(config);
  assert.equal(digest, temperatureRouteSignature({ ...config, label: 'Different presentation' }));
  assert.notEqual(digest, temperatureRouteSignature({ ...config, statePath: 'temperature' }));
  assert.notEqual(digest, temperatureRouteSignature({ ...config, brokerIdentity: { ...config.brokerIdentity, username: 'other' } }));
});
