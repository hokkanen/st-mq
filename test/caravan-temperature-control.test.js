import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';

const START = Date.parse('2026-09-22T10:00:00Z');
const capabilities = { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5) };
function fixture(t, options = {}) {
  const store = new Store(':memory:'), observations = [], sent = [], publications = [];
  let now = START, authority = true, capture;
  const recorder = new Recorder(store, { clock: () => now });
  const settings = equipmentConfiguration({ devices: [bluHtEquipment({ prefix: 'fixture/air' }),
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer/state',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'blu_ht' }, max_age_seconds: 180,
      ...(options.record === false ? { record: false } : {}),
      mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } }] });
  const create = extra => {
    capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest: row => {
      options.beforeIngest?.(row);
      observations.push(row); return recorder.record(row);
    } }, canControl: () => authority,
    publish: async (topic, payload, flags) => {
      if (topic !== 'fixture/dryer/set') return;
      const body = JSON.parse(payload), { identity, requestedAt, expiresAt, ...command } = body;
      sent.push(command); publications.push({ body, flags });
      await options.publish?.(body);
    }, settings, ...extra });
    capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
    capture.receive('fixture/dryer/online', 'online');
  };
  create();
  t.after(() => { capture.close(); store.close(); });
  const f = { get capture() { return capture; }, store, sent, observations, publications,
    get now() { return now; }, advance: ms => { now += ms; }, authority: value => { authority = value; },
    restart: extra => { capture.close(); create(extra); },
    air: (temperature, humidity = 50, retained = false, at = now) => capture.receive('fixture/air/state',
      JSON.stringify({ temperature, humidity, timestamp: at }), { retain: retained }),
    dryer: (power, temperature = 3, humidity = 50, extra = {}) => capture.receive('fixture/dryer/state',
      JSON.stringify({ identity: 'a'.repeat(64), power, temperature, humidity, fanSpeed: 'low', targetHumidity: 55,
        capabilities, timestamp: now, ...extra })),
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier,
    history: () => observations.filter(row => row.signal === 'caravan_dehumidifier_state'),
    policy: patch => capture.setDehumidifierTemperatureControl({ deviceId: 'caravan_dehumidifier', ...patch }),
    qualify: (temperature = 3, humidity = 50, power = 'off', applianceTemperature = temperature) => {
      for (let index = 0; index < 3; index++) {
        if (index) f.advance(60_000);
        f.air(temperature, humidity); f.dryer(power, applianceTemperature, humidity);
      }
    } };
  return f;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('humidity agreement needs two minutes and independent fresh reports before control or history', async t => {
  const f = fixture(t); f.air(2); f.dryer('off', null); await settle();
  assert.equal(f.state().temperatureControl.comparison, 'humidity');
  assert.equal(f.state().temperatureControl.reason, 'checking-readings');
  assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  f.advance(120_000); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 0, 'A timer cannot turn one pair into sustained evidence');
  f.dryer('off', null, 50, { timestamp: START }); f.air(2, 50, false, START); await settle();
  assert.equal(f.sent.length, 0, 'Cached republishes do not count as new readings');
  f.air(2); assert.equal(f.sent.length, 0, 'Both sources must advance');
  f.dryer('off', null); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }]);
  assert.equal(f.history().at(-1).value, 0, 'Publication is not running-state evidence');
  assert.equal(f.history().at(-1).sourceTime, f.now, 'Qualification never backfills the waiting period');
  assert.equal(f.state().temperatureControl.qualified, true);
  assert.deepEqual(f.publications[0], { body: { power: 'on', identity: 'a'.repeat(64), requestedAt: f.now, expiresAt: f.now + 10_000 },
    flags: { qos: 1, retain: false, noReplay: true } });
});

test('caravan hysteresis turns off at 1°C, on at 2°C, and retains demand between', async t => {
  const f = fixture(t); f.qualify(2); await settle();
  f.advance(1000); f.dryer('on', 2); await settle();
  assert.equal(f.state().operation.status, 'observed'); assert.equal(f.history().at(-1).value, 1);
  f.advance(30_000); f.air(1.5); f.dryer('on', 1.5); await settle();
  assert.equal(f.sent.length, 1);
  f.advance(1000); f.air(1); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'off' });
  f.advance(1000); f.dryer('off', 1); await settle();
  f.advance(30_000); f.air(1.9); f.dryer('off', 1.9); await settle(); assert.equal(f.sent.length, 2);
  f.advance(1000); f.air(2); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'on' });
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'off' }), /managed/);
});

test('protective OFF supersedes an unacknowledged ON immediately', async t => {
  const acknowledgements = [], f = fixture(t, { publish: () => new Promise(resolve => acknowledgements.push(resolve)) });
  f.qualify(2);
  assert.equal(f.state().operation.status, 'publishing');
  f.advance(1000); f.air(1);
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  acknowledgements[0](); await settle();
  assert.equal(f.state().operation.value, 'off'); assert.equal(f.state().operation.status, 'publishing');
  acknowledgements[1](); await settle();
  f.advance(1000); f.dryer('off', 1); await settle();
  assert.equal(f.state().operation.status, 'observed');
});

test('humidity mismatch prevents an appliance elsewhere from being controlled or recorded', async t => {
  const f = fixture(t);
  for (let index = 0; index < 4; index++) {
    f.air(3, 80); f.dryer('on', null, 50); f.advance(60_000);
  }
  await settle(); assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  assert.equal(f.state().temperatureControl.reason, 'readings-mismatch');
  f.qualify(3, 50, 'on', null); await settle(); assert.equal(f.history().at(-1).value, 1);
  f.advance(1000); f.air(3, 61); await settle();
  assert.deepEqual(f.sent, [{ power: 'off' }]); assert.equal(f.history().at(-1).value, null);
  assert.equal(f.state().temperatureControl.recording, false);
});

test('optional appliance temperature provides an additional agreement check', async t => {
  const f = fixture(t); f.air(3); f.dryer('off', 20); await settle();
  assert.equal(f.state().temperatureControl.reason, 'readings-mismatch');
  assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  f.advance(1000); f.qualify(3, 50, 'off', 7); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }]);
});

test('lost air evidence stops a managed appliance and leaves an explicit history gap', async t => {
  const f = fixture(t); f.qualify(3, 50, 'on'); await settle();
  f.advance(180_000); f.dryer('on'); f.capture.tick(); await settle();
  assert.deepEqual(f.sent, [{ power: 'off' }]);
  assert.equal(f.history().at(-1).value, null); assert.equal(f.state().temperatureControl.reason, 'air-unavailable');
  const gapAt = f.now;
  f.advance(1000); f.air(3); f.dryer('off');
  assert.equal(f.state().temperatureControl.qualified, false);
  f.advance(120_000); f.air(3); f.dryer('off'); await settle();
  assert(f.history().filter(row => row.value !== null && row.receivedAt > gapAt).every(row => row.sourceTime >= gapAt + 121_000));
});

test('startup dead band stays off, retained air cannot qualify, and authority loss blocks writes', async t => {
  const f = fixture(t); f.air(3, 50, true); f.dryer('off'); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.history().length, 0);
  f.advance(1000); f.qualify(1.5); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.state().temperatureControl.desiredPower, 'off');
  f.authority(false); f.advance(1000); f.air(2); await settle(); assert.equal(f.sent.length, 0);
  await assert.rejects(f.policy({ enabled: false }), /authority/);
  f.authority(true); f.capture.tick(); await settle(); assert.deepEqual(f.sent, [{ power: 'on' }]);
  f.capture.setConnected(false); f.capture.tick(); await settle(); assert.equal(f.sent.length, 1);
});

test('temperature control choices persist for the equipment identity and disabling preserves recording checks', async t => {
  const f = fixture(t); f.dryer('off'); await f.policy({ enabled: false, offAtC: 4, onAtC: 5 });
  f.qualify(3); await settle(); assert.equal(f.sent.length, 0);
  assert.equal(f.state().temperatureControl.recording, true);
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  assert.deepEqual(f.sent, [{ power: 'on' }]);
  f.restart(); assert.equal(f.state().temperatureControl.enabled, false);
  assert.equal(f.state().temperatureControl.offAtC, 4); assert.equal(f.state().temperatureControl.onAtC, 5);
  f.advance(1000); f.air(3, 80); f.dryer('on', null, 50);
  assert.equal(f.state().temperatureControl.recording, false);
  f.restart({ brokerIdentity: 'different-test-broker' });
  assert.equal(f.state().temperatureControl.enabled, true);
  assert.equal(f.state().temperatureControl.offAtC, 1); assert.equal(f.state().temperatureControl.onAtC, 2);
});

test('editing thresholds immediately reassesses current evidence and rejects malformed choices', async t => {
  const f = fixture(t); f.qualify(3, 50, 'on'); await settle();
  await f.policy({ offAtC: 3, onAtC: 4 }); await settle(); assert.deepEqual(f.sent, [{ power: 'off' }]);
  for (const patch of [{}, { enabled: 'false' }, { offAtC: 4 }, { onAtC: 3.4 }, { offAtC: -11 },
    { onAtC: 31 }, { offAtC: 1.25 }, { sensorDeviceId: 'elsewhere' }, { caravanUse: true }])
    await assert.rejects(f.policy(patch));
  f.capture.setConnected(false); await f.policy({ enabled: false });
  assert.equal(f.state().temperatureControl.enabled, false, 'Durable choices may be changed while the device is offline');
});

test('a fresh status envelope cannot refresh older independent humidity or power measurements', async t => {
  const f = fixture(t); f.qualify(3, 50, 'on', null); await settle();
  f.advance(180_000); f.air(3);
  f.dryer('on', null, 50, { fieldTimestamps: { power: f.now, fanSpeed: f.now, humidity: START + 120_000,
    targetHumidity: f.now } }); await settle();
  assert.equal(f.state().temperatureControl.reason, 'appliance-readings-unavailable');
  assert.deepEqual(f.sent, [{ power: 'off' }]); assert.equal(f.history().at(-1).value, null);
  f.advance(1000); f.dryer('on', null, 50, { fieldTimestamps: { power: START + 120_000, fanSpeed: f.now, humidity: f.now } });
  assert.equal(f.state().available, true, 'A backwards field clock rejects the entire conflicting snapshot');
});

test('failed history qualification rolls back evidence and cannot dispatch automatic ON', async t => {
  let failOnce = true;
  const f = fixture(t, { beforeIngest: row => {
    if (row.signal === 'caravan_dehumidifier_state' && failOnce) {
      failOnce = false; throw new Error('Synthetic recording failure');
    }
  } });
  f.air(3); f.dryer('off', null); f.advance(120_000); f.air(3);
  assert.throws(() => f.dryer('off', null), /Synthetic recording failure/);
  await settle(); assert.equal(f.sent.length, 0); assert.equal(f.state().temperatureControl.qualified, false);
  assert.equal(f.store.observations().filter(row => row.signal === 'caravan_dehumidifier_state').length, 0);
  f.dryer('off', null); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }]); assert.equal(f.state().temperatureControl.qualified, true);
});

test('a failed durable policy update leaves automatic control and thresholds unchanged', async t => {
  const f = fixture(t); f.dryer('off'); const setState = f.store.setState.bind(f.store);
  f.store.setState = (key, value, ...args) => {
    if (key.startsWith('equipment:dehumidifier-temperature-control:')) throw new Error('Synthetic settings failure');
    return setState(key, value, ...args);
  };
  await assert.rejects(f.policy({ enabled: false, offAtC: 5, onAtC: 6 }), /Synthetic settings failure/);
  assert.equal(f.state().temperatureControl.enabled, true);
  assert.equal(f.state().temperatureControl.offAtC, 1); assert.equal(f.state().temperatureControl.onAtC, 2);
});

test('policy edits and commands wait for a known physical identity', async t => {
  const f = fixture(t);
  assert.equal(f.state().temperatureControl.canEdit, false);
  await assert.rejects(f.policy({ enabled: false }), /identity/);
  f.air(3); f.dryer('off', null, 50, { identity: undefined });
  assert.equal(f.state().temperatureControl.reason, 'appliance-unavailable');
  assert.equal(f.state().temperatureControl.canEdit, false);
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'targetHumidity', value: 60 }), /unavailable/);
  f.advance(1000); f.dryer('off', null);
  assert.equal(f.state().temperatureControl.canEdit, true);
  await f.policy({ enabled: false });
  f.restart(); assert.equal(f.state().temperatureControl.canEdit, true, 'Saved identity permits editing during a temporary outage');
});

test('physical replacement on the same MQTT route clears old policy and agreement evidence', async t => {
  const f = fixture(t); f.dryer('off', null); await f.policy({ enabled: false, offAtC: 4, onAtC: 5 });
  f.qualify(3, 50, 'on', null); await settle(); assert.equal(f.state().temperatureControl.recording, true);
  f.advance(1000); f.dryer('on', null, 50, { identity: 'b'.repeat(64) }); await settle();
  const guard = f.state().temperatureControl;
  assert.equal(guard.enabled, true); assert.equal(guard.offAtC, 1); assert.equal(guard.onAtC, 2);
  assert.equal(guard.qualified, false); assert.equal(guard.recording, false);
  assert.equal(f.state().operation, null); assert.equal(f.sent.length, 0); assert.equal(f.history().at(-1).value, null);
  await f.policy({ enabled: false, offAtC: 6, onAtC: 7 });
  f.dryer('on', null, 50, { identity: 'a'.repeat(64), timestamp: f.now - 1000 });
  f.dryer('on', null, 50, { identity: 'a'.repeat(64) });
  assert.equal(f.state().temperatureControl.offAtC, 6, 'Late or equal-clock old-device reports cannot replace the current identity');
  f.restart(); assert.equal(f.state().temperatureControl.enabled, false); assert.equal(f.state().temperatureControl.offAtC, 6);
});

test('power and qualification remain available while an expired fan leaves unknown history', async t => {
  const f = fixture(t); f.qualify(3, 50, 'on', null); await settle();
  f.advance(100_000); f.air(3);
  f.dryer('on', null, 50, { fieldTimestamps: { power: f.now, fanSpeed: START + 120_000, humidity: f.now } });
  f.advance(81_000); f.air(3);
  f.dryer('on', null, 50, { fieldTimestamps: { power: f.now, fanSpeed: START + 120_000, humidity: f.now } }); await settle();
  assert.equal(f.state().available, true); assert.equal(f.state().powerOffAvailable, true);
  assert.deepEqual(f.sent, []);
  assert.equal(f.history().at(-1).value, null);
  assert.equal(f.state().runningState, 'on');
  assert.equal(f.state().temperatureControl.qualified, true);
  assert.equal(f.state().temperatureControl.recording, false);
});

test('durable Off/Low/Medium/High history cannot backfill a matching gap with old power and fan observations', async t => {
  const f = fixture(t); f.dryer('on', null); await f.policy({ enabled: false });
  f.qualify(3, 50, 'on', null);
  const signal = 'caravan_dehumidifier_state';
  assert.equal(f.store.observations({ signal }).at(-1).value, 1);
  const original = START + 120_000;
  f.advance(10_000); f.air(3, 90);
  const gapAt = f.now;
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
  f.advance(1000); f.air(3);
  f.dryer('on', null, 50, { fieldTimestamps: { power: original, fanSpeed: original, humidity: f.now } });
  f.advance(120_000); f.air(3);
  f.dryer('on', null, 50, { fieldTimestamps: { power: original, fanSpeed: original, humidity: f.now } });
  assert.equal(f.state().temperatureControl.qualified, true);
  assert.equal(f.state().temperatureControl.recording, false);
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
  f.advance(1000);
  f.dryer('on', null, 50, { fanSpeed: 'high', fieldTimestamps: { power: original, fanSpeed: f.now, humidity: f.now } });
  const row = f.store.observations({ signal }).at(-1);
  assert.equal(row.value, 3); assert.equal(row.sourceTime, f.now);
  assert.deepEqual(row.raw.fieldTimestamps, { power: original, fanSpeed: f.now });
  assert.equal(row.raw.reportIntervalMs, original + 180_000 - f.now);
  assert(f.store.observations({ signal }).filter(value => value.value !== null && value.receivedAt > gapAt)
    .every(value => value.sourceTime >= START + 252_000));
  assert.equal(f.state().temperatureControl.recording, true);
});

test('delayed OFF after a newer fan source leaves a durable gap while matching and controls stay available', async t => {
  const f = fixture(t); f.dryer('on', null); await f.policy({ enabled: false });
  f.qualify(3, 50, 'on', null);
  const signal = 'caravan_dehumidifier_state', original = START + 120_000;
  f.advance(20_000); f.dryer('on', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: original, fanSpeed: f.now, humidity: f.now } });
  assert.equal(f.store.observations({ signal }).at(-1).value, 3);
  f.advance(1000); f.dryer('off', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: original + 10_000, fanSpeed: original + 20_000, humidity: f.now } });
  assert.equal(f.state().runningState, 'off');
  assert.equal(f.state().available, true);
  assert.equal(f.state().temperatureControl.qualified, true);
  assert.equal(f.state().temperatureControl.recording, false);
  const gap = f.store.observations({ signal }).at(-1);
  assert.equal(gap.value, null); assert.equal(gap.sourceTime, null); assert.equal(gap.receivedAt, f.now);
  f.advance(1000); f.dryer('off', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: original + 10_000, fanSpeed: original + 20_000, humidity: f.now } });
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
  f.advance(1000); f.dryer('off', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: f.now, fanSpeed: original + 20_000, humidity: f.now } });
  const recovered = f.store.observations({ signal }).at(-1);
  assert.equal(recovered.value, 0); assert.equal(recovered.sourceTime, f.now);
  assert.deepEqual(recovered.raw.fieldTimestamps, { power: f.now });
  assert.equal(f.state().temperatureControl.recording, true);
});

test('failed delayed-OFF gap recording rolls back its history boundary together with live power', async t => {
  let failGap = false;
  const signal = 'caravan_dehumidifier_state';
  const f = fixture(t, { beforeIngest: row => {
    if (failGap && row.signal === signal && row.value === null) {
      failGap = false; throw new Error('Synthetic gap recording failure');
    }
  } });
  f.dryer('on', null); await f.policy({ enabled: false }); f.qualify(3, 50, 'on', null);
  const original = START + 120_000;
  f.advance(20_000); f.dryer('on', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: original, fanSpeed: f.now, humidity: f.now } });
  f.advance(1000); failGap = true;
  const delayed = { fanSpeed: 'high', fieldTimestamps: { power: original + 10_000, fanSpeed: original + 20_000, humidity: f.now } };
  assert.throws(() => f.dryer('off', null, 50, delayed), /Synthetic gap recording failure/);
  assert.equal(f.state().runningState, 'on');
  assert.equal(f.store.observations({ signal }).at(-1).value, 3);
  f.dryer('on', null, 50, { fanSpeed: 'high',
    fieldTimestamps: { power: original, fanSpeed: original + 20_000, humidity: f.now } });
  assert.equal(f.state().temperatureControl.recording, true, 'A rolled-back boundary cannot hide the previously valid observation');
  assert.equal(f.store.observations({ signal }).at(-1).value, 3);
  f.dryer('off', null, 50, delayed);
  assert.equal(f.state().runningState, 'off');
  assert.equal(f.state().temperatureControl.recording, false);
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
});
