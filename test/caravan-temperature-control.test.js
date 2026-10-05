import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';

const START = Date.parse('2026-09-22T10:00:00Z');
const SIGNAL = 'caravan_dehumidifier_state';
const RESTORE_KEY = `equipment:caravan-probe-restoration:v1:caravan_dehumidifier:${'a'.repeat(64)}`;
const capabilities = { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5) };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const store = new Store(':memory:'), observations = [], sent = [], publications = [], allPublications = [];
  let now = START, authority = true, capture;
  const recorder = new Recorder(store, { clock: () => now });
  const settings = equipmentConfiguration({ devices: [bluHtEquipment({ prefix: 'fixture/air' }),
    options.nativeMeter ? { id: 'caravan', kind: 'metered_switch', area: 'garage', connection: 'shelly:fixture/native-meter',
      generation: 1, max_age_seconds: 180 } : { id: 'caravan', kind: 'power', area: 'garage', connection: 'mqtt:fixture/meter/power',
      max_age_seconds: options.meterAgeSeconds ?? 180, record: false, mqtt: { state_path: 'power', timestamp_path: 'timestamp',
        availability_topic: 'fixture/meter/online' } },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer/state',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'blu_ht' }, max_age_seconds: 180,
      mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } }] });
  const create = extra => {
    capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest: row => {
      options.beforeIngest?.(row);
      observations.push(row); return recorder.record(row);
    } }, canControl: () => authority,
    publish: async (topic, payload, flags) => {
      allPublications.push({ topic, payload, flags });
      if (topic !== 'fixture/dryer/set') return;
      const body = JSON.parse(payload), { identity, requestedAt, expiresAt, ...command } = body;
      sent.push(command); publications.push({ body, flags });
      await options.publish?.(body);
    }, settings, ...extra });
    capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
    capture.receive('fixture/dryer/online', 'online');
    if (options.nativeMeter) capture.receive('fixture/native-meter/online', 'true');
    else capture.receive('fixture/meter/online', 'online');
  };
  create();
  t.after(() => { capture.close(); store.close(); });
  const f = { get capture() { return capture; }, store, sent, observations, publications, allPublications,
    get now() { return now; }, advance: ms => { now += ms; }, authority: value => { authority = value; },
    restart: extra => { capture.close(); create(extra); },
    air: (temperature = 1.5, humidity = 50, retained = false, at = now) => capture.receive('fixture/air/state',
      JSON.stringify({ temperature, humidity, timestamp: at }), { retain: retained }),
    meter: (power = 100, at = now, retain = false) => {
      if (options.nativeMeter) {
        capture.receive('fixture/native-meter/relay/0', 'on', { retain });
        capture.receive('fixture/native-meter/relay/0/power', String(power), { retain });
      } else capture.receive('fixture/meter/power', JSON.stringify({ power, timestamp: at }), { retain });
    },
    dryer: (power, extra = {}, retain = false) => capture.receive('fixture/dryer/state',
      JSON.stringify({ identity: 'a'.repeat(64), power, temperature: null, humidity: null,
        fanSpeed: 'low', targetHumidity: 55, capabilities, timestamp: now, ...extra }), { retain }),
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier,
    guard: () => f.state().temperatureControl,
    history: () => store.observations({ signal: SIGNAL }),
    policy: patch => capture.setDehumidifierTemperatureControl({ deviceId: 'caravan_dehumidifier', ...patch }),
    sample: async (ms, power, watts, extra = {}) => {
      f.advance(ms); f.dryer(power, extra); f.meter(watts); await settle();
    },
    start: async ({ temperature = 1.5, humidity = 50, appliance = {}, enabled } = {}) => {
      f.air(temperature, humidity); f.dryer('off', appliance);
      if (enabled !== undefined) await f.policy({ enabled });
      f.meter(100); await settle();
    },
    qualify: async (options = {}) => {
      await f.start(options);
      const appliance = options.appliance ?? {};
      await f.sample(5000, 'off', 100, appliance);
      await f.sample(1000, 'on', 105, appliance);
      await f.sample(5000, 'on', 105, appliance);
      await f.sample(1000, 'off', 100, appliance);
      await f.sample(5000, 'off', 100, appliance);
    } };
  return f;
}

test('a small matched electrical rise and fall qualify recording without appliance RH or temperature', async t => {
  const f = fixture(t); await f.qualify({ humidity: null });
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.guard().locationTest.status, 'passed');
  assert.equal(f.guard().locationTest.powerRiseW, 5); assert.equal(f.guard().locationTest.powerFallW, 5);
  assert.equal(f.guard().temperatureC, 1.5, 'Missing air RH does not invalidate independently observed air temperature');
  const actual = f.history().filter(row => row.value !== null);
  assert.equal(actual[0].sourceTime, f.now, 'A successful test never fills its waiting period backwards');
  assert.equal(actual[0].value, 0, 'Command publication cannot fabricate appliance On history');
  assert.equal(f.store.getState(RESTORE_KEY), null);
  const overview = getDatabaseOverview({ store: f.store, now: f.now });
  assert.equal(overview.catalogueComplete, true, overview.inventoryIssues.join('; '));
  const inventory = overview.groups.flatMap(group => group.items);
  assert.equal(inventory.find(row => row.id === 'state-caravan-restoration').count, 1);
  assert.equal(inventory.find(row => row.id === 'state-caravan-restoration').missingCount, 1);
  assert.equal(inventory.find(row => row.id === 'state-caravan-temperature-control').count, 1);
  for (const publication of f.publications) {
    assert.equal(publication.body.expiresAt, publication.body.requestedAt + 10000);
    assert.deepEqual(publication.flags, { qos: 1, retain: false, noReplay: true });
  }
});

test('humidity and optional appliance temperature disagreement do not affect the power test', async t => {
  const f = fixture(t); await f.qualify({ humidity: 95, appliance: { humidity: 10, temperature: 30 } });
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  f.advance(1000); f.air(1.5, 1); f.dryer('off', { humidity: 99, temperature: -10 });
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
});

test('flat Caravan power fails placement and restores original native Off without repeating the test', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100);
  for (let index = 0; index < 4; index++) await f.sample(45000, 'on', 100);
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  assert.equal(f.guard().locationTest.status, 'restoring');
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  await f.sample(1000, 'off', 100);
  assert.equal(f.guard().locationTest.status, 'failed'); assert.equal(f.guard().reason, 'power-test-failed');
  assert.equal(f.history().filter(row => row.value !== null).length, 0);
  for (let index = 0; index < 5; index++) await f.sample(30000, 'off', 100);
  assert.equal(f.sent.length, 2, 'A failed continuous online session must not keep cycling the appliance');
});

test('initial native On is restored after the complete Off/On/Off placement test', async t => {
  const f = fixture(t); f.dryer('on'); await f.policy({ enabled: false }); f.meter(105); await settle();
  assert.deepEqual(f.sent, [{ power: 'off' }]);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  assert.equal(f.guard().locationTest.status, 'restoring'); assert.equal(f.guard().recording, false);
  assert.deepEqual(f.sent, [{ power: 'off' }, { power: 'on' }, { power: 'off' }, { power: 'on' }]);
  await f.sample(1000, 'on', 105);
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.history().at(-1).value, 1); assert.equal(f.store.getState(RESTORE_KEY), null);
});

test('retained and duplicate meter or appliance reports cannot advance placement', async t => {
  const f = fixture(t); f.air(); f.dryer('off', {}, true); f.meter(100, f.now, true); await settle();
  assert.equal(f.sent.length, 0); assert.equal(f.guard().qualified, false);
  f.dryer('off'); f.meter(100); f.advance(5000);
  f.meter(100, START); f.dryer('off', { timestamp: START }); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 0);
  f.meter(100); await settle(); assert.deepEqual(f.sent, [{ power: 'on' }]);
  f.advance(1000); f.dryer('on', { fieldTimestamps: { power: START, fanSpeed: f.now } }); f.meter(105); await settle();
  f.advance(5000); f.meter(105); await settle();
  assert.equal(f.sent.length, 1, 'Fresh meter samples cannot replace independent native On readback');
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  assert.deepEqual(f.sent.at(-1), { power: 'off' });
});

test('offline and repeated online markers require one fresh test for the new connection', async t => {
  const f = fixture(t); await f.qualify(); const gapAt = f.now + 1000;
  f.advance(1000); f.capture.receive('fixture/dryer/online', 'offline');
  assert.equal(f.guard().recording, false); assert.equal(f.history().at(-1).value, null);
  f.capture.receive('fixture/dryer/online', 'online'); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 2); assert.equal(f.guard().qualified, false);
  f.advance(1000); await f.qualify();
  assert.equal(f.sent.length, 4); assert.equal(f.guard().qualified, true);
  assert(f.history().filter(row => row.value !== null && row.receivedAt > gapAt)
    .every(row => row.sourceTime >= gapAt + 18000));
  f.advance(1000); f.capture.receive('fixture/dryer/online', 'online'); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 4, 'A repeated online heartbeat does not create a new physical session');
});

test('broker reconnection discards previous placement qualification', async t => {
  const f = fixture(t); await f.qualify(); f.capture.setConnected(false);
  f.advance(1000); f.capture.setConnected(true); f.capture.confirmSubscriptions(f.capture.topics);
  f.capture.receive('fixture/dryer/online', 'online'); f.capture.receive('fixture/meter/online', 'online');
  f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  await f.sample(5000, 'off', 100); assert.equal(f.sent.length, 3);
});

test('restart during a test restores saved original power before starting any new test', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100); await f.sample(1000, 'on', 105);
  assert.equal(f.store.getState(RESTORE_KEY).power, 'off');
  const issuedAt = f.publications[0].body.requestedAt;
  f.restart(); assert.equal(f.guard().locationTest.status, 'restoring');
  f.advance(1000); f.dryer('on'); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  assert.equal(f.guard().qualified, false);
  f.advance(1000); f.dryer('off', { fieldTimestamps: { power: issuedAt, fanSpeed: f.now } });
  assert.notEqual(f.store.getState(RESTORE_KEY), null, 'An old power clock cannot discharge a durable restoration');
  f.advance(1000); f.dryer('off'); await settle();
  assert.equal(f.store.getState(RESTORE_KEY), null); assert.equal(f.guard().qualified, false);
  f.meter(100); await f.sample(5000, 'off', 100); assert.deepEqual(f.sent.at(-1), { power: 'on' });
});

test('authority loss stops writes while keeping the restoration obligation', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100); await f.sample(1000, 'on', 105);
  f.authority(false); f.advance(1000); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 1); assert.equal(f.guard().qualified, false);
  assert.equal(f.store.getState(RESTORE_KEY).power, 'off');
  await f.sample(5000, 'on', 105); assert.equal(f.sent.length, 1);
  f.authority(true); f.advance(1000); f.capture.tick(); await settle();
  assert.deepEqual(f.sent.at(-1), { power: 'off' });
  await f.sample(1000, 'off', 100);
  assert.equal(f.store.getState(RESTORE_KEY), null); assert.equal(f.guard().qualified, false);
});

test('read-only startup cannot probe or turn cached evidence into recording permission', async t => {
  const f = fixture(t); f.authority(false); await f.start();
  for (let i = 0; i < 4; i++) await f.sample(5000, 'off', 100);
  assert.equal(f.sent.length, 0); assert.equal(f.guard().qualified, false);
  assert.equal(f.guard().reason, 'control-unavailable');
});

test('temperature hysteresis resumes after placement and restoration are complete', async t => {
  const f = fixture(t); await f.qualify({ temperature: 2 });
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }, { power: 'on' }]);
  await f.sample(1000, 'on', 105); assert.equal(f.history().at(-1).value, 1);
  f.advance(30000); f.air(1.5); f.dryer('on'); f.meter(105); await settle(); assert.equal(f.sent.length, 3);
  f.advance(1000); f.air(1); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'off' });
  await f.sample(1000, 'off', 100);
  f.advance(30000); f.air(1.9); f.dryer('off'); f.meter(100); await settle(); assert.equal(f.sent.length, 4);
  f.advance(1000); f.air(2); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'on' });
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'off' }), /managed/);
});

test('stale air pauses automatic On but does not erase independently qualified appliance history', async t => {
  const f = fixture(t); await f.qualify({ temperature: 2 }); await f.sample(1000, 'on', 105);
  for (let i = 0; i < 4; i++) await f.sample(45000, 'on', 105);
  assert.equal(f.guard().reason, 'air-unavailable'); assert.equal(f.guard().qualified, true);
  assert.equal(f.guard().recording, true); assert.deepEqual(f.sent.at(-1), { power: 'off' });
});

test('disabling automatic temperature control preserves the independent recording test and saved policy', async t => {
  const f = fixture(t); f.dryer('off'); await f.policy({ enabled: false, offAtC: 4, onAtC: 5 });
  await f.qualify({ temperature: 9 }); assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  assert.equal(f.guard().recording, true); assert.equal(f.guard().enabled, false);
  f.restart(); assert.equal(f.guard().enabled, false); assert.equal(f.guard().offAtC, 4); assert.equal(f.guard().onAtC, 5);
  assert.equal(f.guard().qualified, false, 'Saved policy cannot authorize recording after a restart');
  f.restart({ brokerIdentity: 'different-test-broker' });
  assert.equal(f.guard().enabled, true); assert.equal(f.guard().offAtC, 1);
});

test('commands and policy edits cannot race a location probe or pending restoration', async t => {
  const f = fixture(t); await f.start();
  await assert.rejects(f.policy({ enabled: false }), /check|restoration/);
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'fanSpeed', value: 'high' }), /check|restoration/);
  assert.equal(f.guard().canEdit, false);
});

test('failed durable probe intent cannot dispatch native power or consume baseline evidence', async t => {
  const f = fixture(t); await f.start(); const save = f.store.setState.bind(f.store);
  let failOnce = true;
  f.store.setState = (key, value, ...args) => {
    if (key === RESTORE_KEY && value && failOnce) { failOnce = false; throw new Error('Synthetic probe intent failure'); }
    return save(key, value, ...args);
  };
  f.advance(5000); f.dryer('off');
  assert.throws(() => f.meter(100), /Synthetic probe intent failure/);
  await settle(); assert.equal(f.sent.length, 0); assert.equal(f.guard().qualified, false);
  f.meter(100); await settle(); assert.deepEqual(f.sent, [{ power: 'on' }]);
});

test('failed qualified-history recording rolls back qualification and cannot dispatch automatic On', async t => {
  let failOnce = true;
  const f = fixture(t, { beforeIngest: row => {
    if (row.signal === SIGNAL && row.value !== null && failOnce) { failOnce = false; throw new Error('Synthetic recording failure'); }
  } });
  await f.start({ temperature: 3 }); await f.sample(5000, 'off', 100);
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105); await f.sample(1000, 'off', 100);
  f.advance(5000); f.dryer('off');
  assert.throws(() => f.meter(100), /Synthetic recording failure/);
  await settle(); assert.equal(f.sent.length, 2); assert.equal(f.guard().qualified, false);
  assert.equal(f.history().filter(row => row.value !== null).length, 0);
  f.meter(100); await settle(); assert.equal(f.guard().qualified, true); assert.equal(f.sent.length, 3);
});

test('failed policy writes and malformed edits preserve the existing temperature choices', async t => {
  const f = fixture(t); f.dryer('off');
  for (const patch of [{}, { enabled: 'false' }, { offAtC: 4 }, { onAtC: 1.4 }, { offAtC: -11 },
    { onAtC: 31 }, { offAtC: 1.25 }, { sensorDeviceId: 'elsewhere' }, { caravanUse: true }]) await assert.rejects(f.policy(patch));
  const save = f.store.setState.bind(f.store);
  f.store.setState = (key, value, ...args) => {
    if (key.startsWith('equipment:dehumidifier-temperature-control:')) throw new Error('Synthetic settings failure');
    return save(key, value, ...args);
  };
  await assert.rejects(f.policy({ enabled: false, offAtC: 5, onAtC: 6 }), /Synthetic settings failure/);
  assert.equal(f.guard().enabled, true); assert.equal(f.guard().offAtC, 1);
});

test('a replacement physical appliance cannot inherit earlier recording qualification or choices', async t => {
  const f = fixture(t); await f.qualify({ enabled: false });
  f.advance(1000); f.dryer('off', { identity: 'b'.repeat(64) }); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false); assert.equal(f.guard().enabled, true);
  assert.equal(f.history().at(-1).value, null);
});

test('expired fan evidence leaves a history gap while live power and meter placement remain known', async t => {
  const f = fixture(t); await f.qualify({ enabled: false }); await f.sample(1000, 'on', 105);
  const fanAt = f.now;
  for (let i = 0; i < 4; i++) await f.sample(45000, 'on', 105,
    { fieldTimestamps: { power: f.now + 45000, fanSpeed: fanAt } });
  assert.equal(f.state().available, true); assert.equal(f.state().runningState, 'on');
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, false);
  assert.equal(f.history().at(-1).value, null);
});

test('delayed Off after newer fan evidence leaves a gap and only a new power report resumes history', async t => {
  const f = fixture(t); await f.qualify({ enabled: false }); await f.sample(1000, 'on', 105);
  const original = f.now;
  f.advance(20000); f.dryer('on', { fanSpeed: 'high', fieldTimestamps: { power: original, fanSpeed: f.now } });
  assert.equal(f.history().at(-1).value, 3);
  f.advance(1000); const delayed = { fanSpeed: 'high', fieldTimestamps: { power: original + 10000, fanSpeed: original + 20000 } };
  f.dryer('off', delayed); assert.equal(f.state().runningState, 'off'); assert.equal(f.guard().qualified, true);
  assert.equal(f.guard().recording, false); assert.equal(f.history().at(-1).value, null);
  f.advance(1000); f.dryer('off', delayed); assert.equal(f.history().at(-1).value, null);
  f.advance(1000); f.dryer('off', { fanSpeed: 'high', fieldTimestamps: { power: f.now, fanSpeed: original + 20000 } });
  assert.equal(f.history().at(-1).value, 0); assert.equal(f.history().at(-1).sourceTime, f.now);
  assert.deepEqual(f.history().at(-1).raw.fieldTimestamps, { power: f.now });
});

test('a failed delayed-Off gap rolls back its boundary and live power together', async t => {
  let failGap = false;
  const f = fixture(t, { beforeIngest: row => {
    if (failGap && row.signal === SIGNAL && row.value === null) { failGap = false; throw new Error('Synthetic gap recording failure'); }
  } });
  await f.qualify({ enabled: false }); await f.sample(1000, 'on', 105); const original = f.now;
  f.advance(20000); f.dryer('on', { fanSpeed: 'high', fieldTimestamps: { power: original, fanSpeed: f.now } });
  f.advance(1000); failGap = true;
  const delayed = { fanSpeed: 'high', fieldTimestamps: { power: original + 10000, fanSpeed: original + 20000 } };
  assert.throws(() => f.dryer('off', delayed), /Synthetic gap recording failure/);
  assert.equal(f.state().runningState, 'on'); assert.equal(f.history().at(-1).value, 3); assert.equal(f.guard().recording, true);
  f.dryer('off', delayed); assert.equal(f.state().runningState, 'off'); assert.equal(f.history().at(-1).value, null);
});

test('final meter proof cannot backdate held native state across the qualification boundary', async t => {
  const f = fixture(t); await f.start({ enabled: false }); await f.sample(5000, 'off', 100);
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105); await f.sample(1000, 'off', 100);
  const oldNativeAt = f.now;
  f.advance(5000); f.meter(100); await settle(); const qualifiedAt = f.now;
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, false);
  assert.equal(f.history().filter(row => row.value !== null).length, 0);
  f.advance(1000); f.dryer('off', { timestamp: oldNativeAt });
  assert.equal(f.guard().recording, false); assert.equal(f.history().filter(row => row.value !== null).length, 0);
  f.advance(1000); f.dryer('off');
  assert.equal(f.guard().recording, true); assert.equal(f.history().at(-1).sourceTime, f.now);
  assert(f.history().filter(row => row.value !== null).every(row => row.sourceTime >= qualifiedAt));
});

test('appliance power expiry cannot be renewed by fresh fan or humidity clocks', async t => {
  const f = fixture(t); await f.qualify({ enabled: false }); const powerAt = f.now;
  for (let index = 0; index < 4; index++) {
    f.advance(45000); f.meter(100);
    f.dryer('off', { humidity: 50, fieldTimestamps: { power: powerAt, fanSpeed: f.now, humidity: f.now } });
  }
  await settle(); assert.equal(f.state().available, false); assert.equal(f.guard().qualified, false);
  assert.equal(f.guard().recording, false); assert.equal(f.history().at(-1).value, null);
});

test('a fresh independent native power change aborts the test without overriding it', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100);
  await f.sample(1000, 'on', 105);
  f.advance(1000); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().locationTest.status, 'failed');
  assert.equal(f.guard().locationTest.reason, 'power-changed-externally');
  assert.equal(f.guard().qualified, false); assert.equal(f.store.getState(RESTORE_KEY), null);
  assert.deepEqual(f.sent, [{ power: 'on' }], 'The later native change takes precedence over the temporary probe');
});

test('meter offline and recovery between ticks invalidate earlier electrical placement', async t => {
  const f = fixture(t); await f.qualify();
  f.advance(1000); f.capture.receive('fixture/meter/online', 'offline');
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  assert.equal(f.history().at(-1).value, null);
  f.capture.receive('fixture/meter/online', 'online'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false, 'An unobserved unplug/replug interval needs a new electrical check');
  await f.sample(5000, 'off', 100);
  assert.deepEqual(f.sent.at(-1), { power: 'on' }); assert.equal(f.sent.length, 3);
});

test('fresh cold air defers an automatic-power placement test until above the Off threshold', async t => {
  const f = fixture(t); await f.start({ temperature: 1 });
  await f.sample(5000, 'off', 100); assert.equal(f.sent.length, 0); assert.equal(f.guard().qualified, false);
  assert.equal(f.guard().reason, 'cold');
  f.advance(1000); f.air(1.5); f.dryer('off'); f.meter(100); await settle();
  await f.sample(5000, 'off', 100); assert.deepEqual(f.sent, [{ power: 'on' }]);
});

test('a fresh cold boundary interrupts an automatic-power probe and restores native Off', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100); await f.sample(1000, 'on', 105);
  f.advance(1000); f.air(1); await settle();
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }]);
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
});

test('native Shelly kW reports advance placement and native offline invalidates it without plug switching', async t => {
  const f = fixture(t, { nativeMeter: true }); await f.qualify({ enabled: false });
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.guard().locationTest.powerRiseW, 5, 'Native kW readings are compared in watts');
  assert.equal(f.sent.length, 2);
  f.advance(1000); f.capture.receive('fixture/native-meter/online', 'false');
  assert.equal(f.guard().qualified, false); assert.equal(f.history().at(-1).value, null);
  f.capture.receive('fixture/native-meter/online', 'true'); f.meter(100, f.now, true); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.sent.length, 2);
  f.meter(100); await f.sample(5000, 'off', 100);
  assert.equal(f.sent.length, 3); assert.deepEqual(f.sent.at(-1), { power: 'on' });
  assert.equal(f.allPublications.some(row => row.topic === 'fixture/native-meter/relay/0/command'), false,
    'Only the appliance native power endpoint can be switched');
});


test('an unresolved restoration on another route remains visible and cannot be overwritten by a new test', async t => {
  const f = fixture(t); await f.start(); await f.sample(5000, 'off', 100);
  const saved = f.store.getState(RESTORE_KEY), commandCount = f.sent.length;
  f.restart({ brokerIdentity: 'other-synthetic-broker' });
  f.advance(1000); f.air(1.5); f.dryer('on'); f.meter(105); await settle();
  assert.equal(f.guard().locationTest.status, 'restoring');
  assert.equal(f.guard().recording, false);
  assert.equal(f.sent.length, commandCount);
  assert.deepEqual(f.store.getState(RESTORE_KEY), saved);
  assert.deepEqual(await f.capture.restoreCaravanProbes({ timeoutMs: 0 }), { restorationPending: true });
  assert.deepEqual(f.store.getState(RESTORE_KEY), saved);
});

test('event-only meter configuration still expires held power used for electrical placement', async t => {
  const f = fixture(t, { meterAgeSeconds: 0 }); await f.qualify();
  assert.equal(f.guard().qualified, true);
  f.advance(120000); f.air(1.5); f.dryer('off'); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  assert.equal(f.guard().reason, 'power-unavailable');
  assert.equal(f.history().at(-1).value, null);
});
