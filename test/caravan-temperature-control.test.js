import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';

const START = Date.parse('2026-09-22T10:00:00Z');
function fixture(t) {
  const store = new Store(':memory:'), observations = [], sent = [];
  let now = START, authority = true;
  const capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest: row => observations.push(row) },
    canControl: () => authority, publish: async (topic, payload) => { if (topic === 'fixture/dryer/set') sent.push(JSON.parse(payload)); },
    settings: equipmentConfiguration({ devices: [bluHtEquipment({ prefix: 'fixture/air' }),
      { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer/state',
        dehumidifier_control: true, temperature_control: { sensor_device_id: 'blu_ht' }, max_age_seconds: 180,
        mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } }] }) });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  capture.receive('fixture/dryer/online', 'online');
  t.after(() => { capture.close(); store.close(); });
  return { capture, sent, observations,
    advance: ms => { now += ms; }, authority: value => { authority = value; },
    air: (temperature, humidity = 50, retained = false) => capture.receive('fixture/air/state',
      JSON.stringify({ temperature, humidity, timestamp: now }), { retain: retained }),
    dryer: (power, temperature = 3, humidity = 50) => capture.receive('fixture/dryer/state',
      JSON.stringify({ power, temperature, humidity, fanSpeed: 'low', mode: 'dehumidify', targetHumidity: 55,
        swing: 'fixed_90', timestamp: now })),
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier,
    history: () => observations.filter(row => row.signal === 'caravan_dehumidifier_running_state') };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a newly confirmed ON can be turned OFF immediately at the cold boundary', async t => {
  const f = fixture(t); f.air(2); f.dryer('off', 2); await settle();
  f.advance(1000); f.dryer('on', 2); await settle();
  f.advance(1000); f.air(1); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }], 'A direction change is not delayed by retry throttling');
});

test('caravan hysteresis requires colocated fresh readings and records only confirmed live state', async t => {
  const f = fixture(t);
  f.dryer('off'); assert.equal(f.history().length, 0); assert.equal(f.sent.length, 0);
  f.air(2); await settle(); assert.deepEqual(f.sent, [{ power: 'on' }]);
  assert.equal(f.history().at(-1).value, 0, 'Publication is not running-state evidence');
  f.advance(1000); f.dryer('on', 2); await settle();
  assert.equal(f.state().operation.status, 'observed'); assert.equal(f.history().at(-1).value, 1);
  f.advance(30_000); f.air(1.5); f.dryer('on', 1.5); await settle();
  assert.equal(f.sent.length, 1, 'Retain prior demand inside the dead band');
  f.advance(1000); f.air(1); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'off' });
  f.advance(1000); f.dryer('off', 1); await settle();
  f.advance(30_000); f.air(1.9); f.dryer('off', 1.9); await settle(); assert.equal(f.sent.length, 2);
  f.advance(1000); f.air(2); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'on' });
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'off' }), /managed/);
});

test('moving the appliance, stale air, and lost authority cannot start it or extend caravan history', async t => {
  const f = fixture(t); f.air(3); f.dryer('off', 20); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  f.advance(1000); f.dryer('off', 3, 90); await settle(); assert.equal(f.sent.length, 0);
  f.authority(false); f.advance(1000); f.dryer('off', 3, 50); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.history().at(-1).value, 0);
  f.authority(true); f.advance(1000); f.capture.tick(); await settle(); assert.deepEqual(f.sent, [{ power: 'on' }]);
  f.advance(1000); f.dryer('on'); await settle();
  f.advance(180_000); f.dryer('on'); f.capture.tick(); await settle();
  assert.deepEqual(f.sent.at(-1), { power: 'off' });
  assert.equal(f.history().at(-1).value, null); assert.equal(f.state().temperatureControl.reason, 'air-unavailable');
});

test('startup dead band stays off and retained air never authorizes temperature control', async t => {
  const f = fixture(t); f.air(3, 50, true); f.dryer('off'); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  f.advance(1000); f.air(1.5); f.dryer('off', 1.5); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.state().temperatureControl.desiredPower, 'off');
  f.capture.setConnected(false); f.capture.tick(); await settle(); assert.equal(f.sent.length, 0);
});
