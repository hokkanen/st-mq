import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bluHtScript, bluHtEquipment } from '../integrations/shelly/blu-ht.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';

const address = '00:00:00:00:00:01';
const initial = Date.parse('2026-09-21T12:00:00Z');
const packet = (temperature = 215, humidity = 46, extra = []) =>
  String.fromCharCode(0x40, 0, 1, 1, 95, 0x2e, humidity, 0x45, temperature & 255, (temperature >> 8) & 255, ...extra);
function bridge({ scanStart = true } = {}) {
  let now = initial, uptime = 100, connected = true, callback, query;
  const publications = [], calls = [], messages = [];
  const context = vm.createContext({
    print: message => messages.push(message),
    Shelly: { getComponentStatus: () => ({ unixtime: now / 1000, uptime }),
      getCurrentScriptId: () => 7, call: (method, params) => calls.push({ method, ...params }) },
    MQTT: { isConnected: () => connected, publish: (topic, body, qos, retain) => {
      publications.push({ topic, body, qos, retain }); return true;
    }, subscribe: (topic, cb) => { assert.equal(topic, 'invented/blu/get'); query = cb; } },
    BLE: { Scanner: { SCAN_RESULT: 2, INFINITE_SCAN: -1,
      Subscribe: cb => { callback = cb; }, Start: options => { assert.equal(options.active, false); return scanStart; } } },
  });
  vm.runInContext(bluHtScript({ address, prefix: 'invented/blu' }), context);
  return { publications, calls, messages, context, time: value => { now = value; uptime = 100 + (value - initial) / 1000; },
    connected: value => { connected = value; }, query: message => query('invented/blu/get', message),
    receive: (data = packet(), addr = address) => callback(2, { addr, rssi: -65, service_data: { fcd2: data } }) };
}

test('BLU bridge stops its own script if the native scanner cannot start', () => {
  for (const scanStart of [false, null]) {
    const b = bridge({ scanStart });
    assert.deepEqual(b.calls, [{ method: 'Script.Stop', id: 7 }]);
    assert.deepEqual(b.messages, ['BLU scanner could not start']);
    assert.equal(b.publications.length, 0);
  }
  const running = bridge({ scanStart: { duration_ms: -1, active: false } });
  running.receive();
  assert.equal(running.publications.length, 1);
  assert.deepEqual(running.calls, []);
});

test('BLU bridge decodes signed temperatures, ignores duplicate bursts, and preserves unchanged minute reports', () => {
  const b = bridge(); b.receive(packet(-123));
  let sample = JSON.parse(b.publications[0].body);
  assert.equal(sample.temperature, -12.3); assert.equal(sample.humidity, 46); assert.equal(sample.battery, 95);
  assert.equal(sample.timestamp, initial); assert.equal(sample.time_basis, 'blu-received');
  b.time(initial + 1000); b.receive(packet(-123)); assert.equal(b.publications.length, 1);
  b.time(initial + 60000); b.receive(packet(-123)); assert.equal(b.publications.length, 2);
  assert.equal(JSON.parse(b.publications[1].body).timestamp, initial + 60000);
  assert(b.publications.every(p => p.qos === 1 && p.retain === false));
});

test('BLU bridge rejects other sensors, encrypted, truncated, unknown and invalid measurements', () => {
  const b = bridge();
  b.receive(packet(), '00:00:00:00:00:02');
  b.receive(String.fromCharCode(0x41) + packet().slice(1));
  b.receive(packet().slice(0, -1)); b.receive(packet(215, 101));
  b.receive(packet(215, 46, [0xff, 1])); b.receive(String.fromCharCode(0x40, 1, 95));
  b.time(0); b.receive(); assert.equal(b.publications.length, 0);
  b.time(initial); b.receive(packet(215, 46, [0xf0, 0x11, 0, 0xf1, 1, 2, 3, 4, 0xf2, 1, 2, 3]));
  assert.equal(b.publications.length, 1);
});

test('MQTT polling returns the cache without renewing the BLE reception timestamp', () => {
  const b = bridge(); b.query('status'); assert.equal(b.publications.length, 0);
  b.receive(); b.time(initial + 300000); b.query('status');
  assert.equal(b.publications.length, 2);
  assert.equal(b.publications[1].body, b.publications[0].body);
  b.query('toggle'); assert.equal(b.publications.length, 2);
  b.connected(false); b.time(initial + 360000); b.receive(packet(225));
  assert.equal(b.publications.length, 2);
  b.connected(true); b.query('status');
  assert.equal(JSON.parse(b.publications[2].body).timestamp, initial + 360000);
});

test('standalone BLU equipment receives both measurements and expires cached readbacks', t => {
  const entry = bluHtEquipment({ prefix: 'invented/blu' });
  const settings = equipmentConfiguration({ devices: [entry] });
  let now = initial; const observations = [];
  const capture = createEquipmentCapture({ settings,
    engine: { clock: () => now, ingest: row => observations.push(row) }, store: {}, publish: async () => {} });
  t.after(() => capture.close()); capture.setConnected(true);
  const b = bridge(); b.receive(); const frame = b.publications[0];
  capture.receive(frame.topic, frame.body, { retain: true }, now);
  assert.equal(capture.status().devices[0].available, false);
  capture.receive(frame.topic, frame.body, {}, now);
  let device = capture.status().devices[0]; assert.equal(device.available, true);
  assert.equal(device.readings.caravan_temperature.value, 21.5);
  assert.equal(device.readings.caravan_humidity.value, 46);
  assert.equal(device.readings.blu_ht_battery.value, 95);
  assert.equal(device.readings.blu_ht_rssi.value, -65);
  assert(!observations.some(row => ['blu_ht_rssi', 'blu_ht_battery'].includes(row.signal)));
  assert.deepEqual(observations.filter(row => Number.isFinite(row.value)).map(row => row.signal).sort(),
    ['caravan_humidity', 'caravan_temperature']);
  assert(!settings.ownedSignals.some(signal => /^(indoor|garage|bedroom|downstairs)_temperature$/.test(signal)));
  now += 181000; capture.receive(frame.topic, frame.body, {}, now);
  device = capture.status().devices[0]; assert.equal(device.available, false);
  assert.equal(device.readings.caravan_temperature.observedAt, initial);
  b.time(now); b.receive(packet(223, 51));
  capture.receive(frame.topic, b.publications.at(-1).body, {}, now);
  assert.equal(capture.status().devices[0].available, true);
});

test('bridge generator validates installation inputs', () => {
  assert.throws(() => bluHtScript({ address: 'invalid' }));
  assert.throws(() => bluHtScript({ address, prefix: 'bad/+' }));
  assert.throws(() => bluHtEquipment({ id: 'x;bad' }));
  assert.throws(() => bluHtEquipment({ area: 'other' }));
});
