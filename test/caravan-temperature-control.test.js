import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createMqttSourceContext, mqttSourceIdentity } from '../src/pairing/mqtt-source-context.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { caravanPowerTimingKey, CARAVAN_NATIVE_RESTART_DELAY_MS } from '../src/domain/caravan-power-timing.js';
import { createEquipmentActions } from '../chart/equipment.js';

const START = Date.parse('2026-09-22T10:00:00Z');
const SIGNAL = 'caravan_dehumidifier_state';
const RESTORE_KEY = `equipment:caravan-probe-restoration:v1:caravan_dehumidifier:${'a'.repeat(64)}`;
const capabilities = { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5) };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const store = options.store ?? new Store(':memory:'), observations = [], sent = [], publications = [], allPublications = [];
  const initialClock = options.startAt ?? START;
  let now = !options.store && options.knownOff !== false ? initialClock - CARAVAN_NATIVE_RESTART_DELAY_MS : initialClock, authority = true, capture, elapsed = 0;
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
    capture = createEquipmentCapture({ store, monotonicClock: () => options.monotonicClock ? options.monotonicClock(elapsed) : elapsed, engine: { clock: () => now, ingest: row => {
      options.beforeIngest?.(row);
      observations.push(row); return recorder.record(row);
    } }, canControl: () => authority,
    publish: async (topic, payload, flags) => {
      if (options.beforePublish) await options.beforePublish(topic, payload, flags);
      await flags?.preparePublish?.();
      flags?.beforePublish?.();
      allPublications.push({ topic, payload, flags });
      if (topic !== 'fixture/dryer/set') return;
      const body = JSON.parse(payload), { identity, requestedAt, expiresAt, ...command } = body;
      sent.push(command); publications.push({ body, flags });
      await options.publish?.(body);
    }, settings, ...extra });
    const receive = capture.receive;
    capture.receive = (...args) => {
      if (args.length < 7) { while (args.length < 6) args.push(undefined); args.push(elapsed); }
      return receive(...args);
    };
    capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
    capture.receive('fixture/dryer/online', 'online');
    if (options.nativeMeter) capture.receive('fixture/native-meter/online', 'true');
    else capture.receive('fixture/meter/online', 'online');
  };
  create();
  t.after(() => { capture.close(); store.close(); });
  const f = { get capture() { return capture; }, store, recorder, sent, observations, publications, allPublications,
    get now() { return now; }, advance: ms => { now += ms; elapsed += Math.max(0, ms); },
    shiftWall: ms => { now += ms; }, get elapsed() { return elapsed; }, authority: value => { authority = value; },
    restart: extra => { capture.close(); create(extra); },
    air: (temperature = 1.5, humidity = 50, retained = false, at = now) => capture.receive('fixture/air/state',
      JSON.stringify({ temperature, humidity, timestamp: at }), { retain: retained }),
    meter: (power = 100, at = now, retain = false) => {
      if (options.nativeMeter) {
        capture.receive('fixture/native-meter/relay/0', 'on', { retain });
        capture.receive('fixture/native-meter/relay/0/power', String(power), { retain });
      } else capture.receive('fixture/meter/power', JSON.stringify({ power, timestamp: at }), { retain });
    },
    dryer: (power, extra = {}, retain = false, receivedAt = now) => capture.receive('fixture/dryer/state',
      JSON.stringify({ identity: 'a'.repeat(64), power, temperature: null, humidity: null,
        fieldTimestamps: Object.fromEntries(['power', 'fanSpeed', 'targetHumidity', 'humidity', 'temperature']
          .map(field => [field, extra.timestamp ?? now])),
        fanSpeed: 'low', targetHumidity: 55, capabilities, timestamp: now, ...extra }), { retain }, receivedAt),
    state: () => capture.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier,
    guard: () => f.state().temperatureControl,
    history: () => store.observations({ signal: SIGNAL }),
    timing: () => store.getState(caravanPowerTimingKey('caravan_dehumidifier', 'a'.repeat(64), capture.signature('caravan_dehumidifier'))),
    policy: patch => capture.setDehumidifierTemperatureControl({ deviceId: 'caravan_dehumidifier', ...patch }),
    sample: async (ms, power, watts, extra = {}) => {
      f.advance(ms); f.dryer(power, extra); f.meter(watts); await settle();
    },
    waitRestart: async ({ temperature = 1.5, humidity = 50, appliance = {} } = {}) => {
      const until = f.guard().powerRestartNotBefore;
      while (f.now < until) {
        f.advance(Math.min(60_000, until - f.now)); f.air(temperature, humidity); f.dryer('off', appliance); f.meter(100); await settle();
      }
    },
    start: async ({ temperature = 1.5, humidity = 50, appliance = {}, enabled, stable = true } = {}) => {
      f.air(temperature, humidity); f.dryer('off', appliance);
      if (enabled !== undefined) await f.policy({ enabled });
      f.meter(100); await settle();
      // Stable feed qualification precedes the separately bounded power cycle.
      if (stable) { f.air(temperature, humidity); await f.sample(30_000, 'off', 100, appliance); }
    },
    qualify: async (options = {}) => {
      await f.start(options);
      const appliance = options.appliance ?? {};
      await f.waitRestart(options);
      await f.sample(5000, 'off', 100, appliance);
      await f.sample(1000, 'on', 105, appliance);
      await f.sample(5000, 'on', 105, appliance);
      await f.sample(1000, 'off', 100, appliance);
      await f.sample(5000, 'off', 100, appliance);
      if (options.enabled === false || options.temperature >= f.guard().onAtC) await f.waitRestart(options);
    } };
  // Other feature tests start after a real same-connection Off report and its
  // five-minute hold. Timing tests explicitly omit this warm-up.
  if (!options.store && options.knownOff !== false) {
    f.dryer('off');
    while (now < initialClock) { f.advance(Math.min(60_000, initialClock - now)); f.dryer('off'); }
  }
  return f;
}

test('a passed Caravan association survives a brief real dropout after advancing stable recovery without another power cycle', async t => {
  const f = fixture(t); await f.qualify();
  assert.equal(f.guard().qualified, true);
  const before = f.sent.length;
  f.capture.receive('fixture/dryer/online', 'offline');
  assert.equal(f.guard().qualified, false, 'Missing live evidence is still unknown');
  assert.equal(f.guard().recording, false);
  f.advance(20_000); f.capture.receive('fixture/dryer/online', 'online');
  f.dryer('off'); f.meter(100); await settle();
  await f.sample(29_999, 'off', 100);
  assert.equal(f.guard().qualified, false, 'Recovery cannot finish at 29,999 ms');
  await f.sample(1, 'off', 100);
  assert.equal(f.guard().qualified, true);
  assert.equal(f.sent.length, before, 'Stable recovery of a historical pass sends no test command');
});

test('a passed Caravan association survives current-version restart with original proof and fresh recovery', async t => {
  const f = fixture(t); await f.qualify(); f.dryer('off'); f.meter(100); await settle();
  const proof = structuredClone(f.history().findLast(row => row.value !== null).raw.locationEvidence);
  const before = f.sent.length;
  f.restart(); f.advance(1); f.air(); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false, 'Stored proof is not fresh evidence');
  await f.sample(30_000, 'off', 100);
  assert.equal(f.guard().qualified, true);
  assert.equal(f.sent.length, before, 'Restart alone does not retest a successful association');
  assert.equal(f.guard().locationTest.completedAt, proof.completedAt, 'A recovered association keeps its actual test clock');
});

test('an abandoned meter scope cannot recover its old pass after a quick A to B to A change', async t => {
  const f = fixture(t); let meterAddress = 'mqtt://synthetic-meter-a';
  f.restart({ brokerIdentityForDevice: d => ({ address: d.id === 'caravan' ? meterAddress : 'mqtt://synthetic-source', username: 'synthetic' }) });
  await f.qualify(); const original = f.guard().qualification.passedAt, before = f.sent.length;
  meterAddress = 'mqtt://synthetic-meter-b'; await f.sample(1, 'off', 100);
  meterAddress = 'mqtt://synthetic-meter-a'; await f.sample(1, 'off', 100);
  await f.sample(30_000, 'off', 100);
  assert.equal(f.guard().qualified, false);
  assert.equal(f.guard().qualification.retained, false);
  assert.equal(f.guard().qualification.passedAt, original, 'Retired historical evidence is preserved');
  assert.equal(f.sent.length, before, 'New physical check has only begun its baseline');
  assert.equal(f.guard().locationTest.status, 'testing');
});

test('changing the meter during Original On restoration closes the old duty without qualifying new wiring', async t => {
  const f = fixture(t); let meterAddress = 'mqtt://synthetic-meter-a';
  f.restart({ brokerIdentityForDevice: d => ({ address: d.id === 'caravan' ? meterAddress : 'mqtt://synthetic-source', username: 'synthetic' }) });
  f.advance(1); f.air(3); f.dryer('on'); await f.policy({ enabled: false }); f.meter(105); await settle();
  await f.sample(30_000, 'on', 105); await f.sample(1000, 'off', 100); await f.waitRestart({ temperature: 3 });
  await f.sample(5000, 'off', 100); await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  assert.equal(f.guard().locationTest.status, 'restoring');
  const oldPassedAt = f.guard().locationTest.completedAt, oldScope = f.guard().qualification.signature;
  assert.equal(f.store.getState(RESTORE_KEY).power, 'on');
  meterAddress = 'mqtt://synthetic-meter-b'; f.advance(1); f.air(3); f.dryer('off'); f.meter(100); await settle();
  assert.notEqual(f.guard().qualification.signature, oldScope);
  assert.equal(f.store.getState(RESTORE_KEY).power, 'on');
  const writes = [], save = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => { if (key === RESTORE_KEY) writes.push(value); return save(key, value); };
  await f.waitRestart({ temperature: 3 }); await f.sample(1000, 'on', 105);
  assert(writes.includes(null), 'Fresh original On discharges its old obligation; a necessary new-scope check may create a new one');
  assert.equal(f.guard().qualified, false); assert.notEqual(f.guard().qualification.passedAt, oldPassedAt);
});

test('cached pre-restart source clocks cannot break the conservative unobserved loss interval', async t => {
  const f = fixture(t); await f.qualify(); f.advance(1000); f.dryer('off'); f.meter(100); await settle();
  const cachedAt = f.now, proofAt = f.guard().qualification.passedAt, commands = f.sent.length;
  f.advance(1000); f.restart(); f.air(); f.dryer('off', { timestamp: cachedAt }); f.meter(100, cachedAt); await settle();
  const loss = f.guard().qualification.unavailableSince;
  f.advance(30_000); f.capture.tick(); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().qualification.unavailableSince, loss);
  assert.equal(f.guard().qualification.passedAt, proofAt); assert.equal(f.sent.length, commands);
  f.dryer('off'); f.meter(100); await settle(); await f.sample(29_999, 'off', 100);
  assert.equal(f.guard().qualified, false); await f.sample(1, 'off', 100);
  assert.equal(f.guard().qualified, true);
});

test('a physical location check requires the exact current revision and cannot be duplicated or replace restoration', async t => {
  const f = fixture(t); await f.qualify();
  const current = () => ({ deviceId: 'caravan_dehumidifier', identity: 'a'.repeat(64),
    signature: f.guard().qualification.signature, revision: f.guard().qualification.revision });
  const request = current(), before = f.sent.length, state = f.store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'equipment:caravan-qualification%'").all();
  await assert.rejects(f.capture.recheckDehumidifierLocation({ ...request, retired: true }));
  await assert.rejects(f.capture.recheckDehumidifierLocation({ ...request, revision: request.revision - 1 }));
  f.authority(false); await assert.rejects(f.capture.recheckDehumidifierLocation(request)); f.authority(true);
  assert.deepEqual(f.store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'equipment:caravan-qualification%'").all(), state);
  await f.capture.recheck({ deviceId: 'caravan_dehumidifier' });
  assert.equal(f.guard().qualified, true, 'Ordinary refresh is not a physical check');
  await f.capture.recheckDehumidifierLocation(request);
  f.advance(1); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().qualification.revision, request.revision + 1);
  await assert.rejects(f.capture.recheckDehumidifierLocation(request));
  await assert.rejects(f.capture.recheckDehumidifierLocation(current()));
  assert.equal(f.sent.length, before, 'Explicit check waits for actual stable reports');
  await f.sample(30_000, 'off', 100); await f.waitRestart(); await f.sample(5000, 'off', 100);
  assert.equal(f.store.getState(RESTORE_KEY)?.power, 'off');
  const obligation = structuredClone(f.store.getState(RESTORE_KEY));
  await assert.rejects(f.capture.recheckDehumidifierLocation(current()));
  assert.deepEqual(f.store.getState(RESTORE_KEY), obligation);
});

test('a failed physical check can be rechecked through the UI using the actual equipment status', async t => {
  const f = fixture(t, { knownOff: false });
  f.air(3); f.dryer('on'); await f.policy({ enabled: false }); f.meter(105); await settle();
  await f.sample(30_000, 'on', 105);
  for (let i = 0; i < 8; i++) { f.air(3); await f.sample(60_000, 'on', 105); }
  f.capture.tick(); await settle();
  assert.equal(f.guard().locationTest.status, 'failed');
  assert.equal(f.guard().locationTest.reason, 'baseline-unavailable');
  assert.equal(f.guard().qualification.canRecheck, true);
  const snapshot = () => ({ now: f.now, role: 'master', readOnly: false, topology: 'standalone', equipment: f.capture.status() });
  const before = snapshot(), device = before.equipment.devices.find(row => row.id === 'caravan_dehumidifier');
  const originalPolicy = { enabled: f.guard().enabled, offAtC: f.guard().offAtC, onAtC: f.guard().onAtC };
  const sent = f.sent.length, requests = [];
  const actions = createEquipmentActions({ request: async (path, body) => {
    requests.push({ path, body });
    await f.capture.recheckDehumidifierLocation(body);
    return snapshot();
  } });
  actions.update(before);
  assert.equal(await actions.recheckDehumidifierLocation(device.id), true,
    'The real status producer must supply the identity consumed by the UI and actual recheck boundary');
  assert.deepEqual(requests, [{ path: '/api/equipment/dehumidifier/location-check', body: {
    deviceId: device.id, identity: device.dehumidifier.identity,
    signature: device.dehumidifier.temperatureControl.qualification.signature,
    revision: device.dehumidifier.temperatureControl.qualification.revision,
  } }]);
  assert.equal(requests[0].body.identity, 'a'.repeat(64));
  assert.equal(f.guard().qualification.revision, device.dehumidifier.temperatureControl.qualification.revision + 1);
  assert.equal(f.sent.length, sent, 'Accepting a recheck waits for new stable evidence rather than replaying the failed Off');
  assert.deepEqual({ enabled: f.guard().enabled, offAtC: f.guard().offAtC, onAtC: f.guard().onAtC }, originalPolicy);
  await assert.rejects(f.capture.recheckDehumidifierLocation(requests[0].body), /location check/);
});

test('dehumidifier status identity follows admitted reports without granting live control', async t => {
  const f = fixture(t, { knownOff: false });
  assert.equal(f.state().identity, null);
  f.dryer('on', { identity: 'invalid' });
  assert.equal(f.state().identity, null, 'An invalid report cannot establish an identity');
  f.dryer('on');
  assert.equal(f.state().identity, 'a'.repeat(64));
  f.capture.receive('fixture/dryer/online', 'offline');
  assert.equal(f.state().identity, 'a'.repeat(64), 'Identity metadata does not manufacture a fresh observation');
  assert.equal(f.state().available, false);
  assert.equal(f.guard().qualification.canRecheck, false);
  f.authority(false); f.capture.receive('fixture/dryer/online', 'online'); f.advance(1);
  f.dryer('on', { identity: 'b'.repeat(64) });
  assert.equal(f.state().identity, 'b'.repeat(64));
  assert.equal(f.state().available, false, 'A known current identity does not grant command authority');
  assert.equal(f.guard().qualification.canRecheck, false);
});

test('location-test dispatch rejects wiring movement after durable intent and before publication', async t => {
  let hold = false, release; const waiting = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { beforePublish: async topic => { if (hold && topic === 'fixture/dryer/set') await waiting; } });
  let meterAddress = 'mqtt://synthetic-meter-a';
  f.restart({ brokerIdentityForDevice: d => ({ address: d.id === 'caravan' ? meterAddress : 'mqtt://synthetic-source', username: 'synthetic' }) });
  f.advance(1); await f.start(); hold = true; await f.waitRestart(); await f.sample(5000, 'off', 100);
  assert.equal(f.store.getState(RESTORE_KEY)?.power, 'off'); assert.deepEqual(f.sent, []);
  meterAddress = 'mqtt://synthetic-meter-b'; release(); await settle(); await settle();
  assert.deepEqual(f.sent, [], 'Final physical-scope check cancels the unsent old-wiring command');
  assert.equal(f.guard().qualified, false);
});

test('actual successful proof rejects future completion and impossible command chronology before writable startup', async t => {
  const f = fixture(t); await f.qualify();
  const directory = await mkdtemp(join(tmpdir(), 'caravan-proof-validation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, corrupt] of [['future', r => { r.proof.completedAt = r.lastHealthyAt + 86_400_000; }],
    ['order', r => { const on = r.proof.phases.on.commandAt; r.proof.phases.on.commandAt = r.proof.phases.off.commandAt; r.proof.phases.off.commandAt = on; }]]) {
    const path = join(directory, `${name}.sqlite`); await f.store.backup(path);
    const writer = new Store(path), row = writer.db.prepare("SELECT key,value FROM state WHERE key LIKE 'equipment:caravan-qualification:v1:%'").get();
    const record = JSON.parse(row.value); corrupt(record);
    writer.db.prepare('UPDATE state SET value=? WHERE key=?').run(JSON.stringify(record), row.key);
    writer.db.exec('PRAGMA journal_mode=DELETE'); writer.close();
    const original = await readFile(path);
    assert.throws(() => new Store(path), { code: 'database_state_incompatible' });
    assert.deepEqual(await readFile(path), original, 'Invalid current proof is rejected before mutation');
  }
});

test('failed COMMIT rewinds a healthy association checkpoint and reads do not persist it', async t => {
  const f = fixture(t); await f.qualify();
  const rows = () => f.store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'equipment:caravan-qualification%'").all();
  const before = rows(); for (let i = 0; i < 30; i++) f.guard();
  assert.deepEqual(rows(), before, 'Dashboard reads cannot refresh durable source evidence');
  const exec = f.store.db.exec.bind(f.store.db); let fail = true;
  t.mock.method(f.store.db, 'exec', sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Synthetic association COMMIT failure'); } return exec(sql); });
  f.advance(30_000);
  await assert.rejects(f.store.runWrite(() => { f.dryer('off'); f.meter(100); }), /Synthetic association COMMIT failure/);
  assert.deepEqual(rows(), before); assert.equal(f.guard().qualified, true);
  await f.store.runWrite(() => { f.dryer('off'); f.meter(100); });
  assert.notDeepEqual(rows(), before, 'Only successfully admitted new source clocks update the checkpoint');
});

test('verified paired MQTT source context retains the association through transport handover with fresh recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'caravan-pair-source-'));
  const f = fixture(t, { store: new Store(join(directory, 'current.sqlite')) });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ha = { topology: 'pair', input: 'mqtt', pair: { pairId: 'synthetic-house', token: 'synthetic-pair-token', vip: { address: '192.0.2.30' } },
    connections: { mqtt: { address: 'mqtt://core-mosquitto', user: 'synthetic-ha' } } };
  const ubuntu = structuredClone(ha); ubuntu.connections.mqtt = { address: 'mqtt://127.0.0.1', user: 'synthetic-local', ha: { address: 'mqtt://192.0.2.20:1885', user: 'synthetic-ha' } };
  const local = createMqttSourceContext({ configuration: () => ha, directory: join(directory, 'ha') });
  const remote = createMqttSourceContext({ configuration: () => ubuntu, directory: join(directory, 'ubuntu') });
  await local.activate(ha, f.store, { allowSeed: true });
  f.restart({ brokerIdentityForDevice: () => mqttSourceIdentity(ha, 'primary') }); f.advance(1); await f.qualify();
  const proofAt = f.guard().qualification.passedAt, scope = f.guard().qualification.signature, commands = f.sent.length;
  const args = { requirements: local.requirements(f.store), token: randomUUID(), dbPath: f.store.path };
  await remote.prepare(args); remote.verify(args); await remote.authorize(args); await remote.activate(ubuntu, f.store);
  assert.notEqual(ha.connections.mqtt.address, ubuntu.connections.mqtt.address);
  f.restart({ brokerIdentityForDevice: () => mqttSourceIdentity(ubuntu, 'primary') }); f.advance(1); f.air(); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualification.signature, scope); assert.equal(f.guard().qualified, false);
  await f.sample(29_999, 'off', 100); assert.equal(f.guard().qualified, false);
  await f.sample(1, 'off', 100); assert.equal(f.guard().qualified, true);
  assert.equal(f.guard().qualification.passedAt, proofAt); assert.equal(f.sent.length, commands);
});

for (const duration of [59_999, 60_000]) test(`actual source return at ${duration} ms preserves the exact continuous-loss boundary`, async t => {
  const f = fixture(t); await f.qualify(); const proofAt = f.guard().qualification.passedAt;
  f.capture.receive('fixture/dryer/online', 'offline'); f.advance(duration);
  f.capture.receive('fixture/dryer/online', 'online'); f.air(); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false);
  await f.sample(29_999, 'off', 100); assert.equal(f.guard().qualified, false);
  await f.sample(1, 'off', 100);
  assert.equal(f.guard().qualified, duration < 60_000);
  assert.equal(f.guard().qualification.passedAt, proofAt, 'Historical proof is not renewed on return');
});

test('delayed source-loss detection uses the original expiry before a fresh report replaces it', async t => {
  const f = fixture(t); await f.qualify();
  const powerAt = f.now; f.advance(240_000); f.air(); f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().qualification.retained, false,
    'Required-field expiry plus 60 seconds invalidates the association without an earlier tick');
  const rows = f.store.db.prepare("SELECT value FROM state WHERE key LIKE 'equipment:caravan-qualification:v1:%'").all();
  assert.equal(JSON.parse(rows[0].value).invalidatedAt, powerAt + 240_000);
});

test('late writer admission cannot resurrect an association from a report received just before expiry', async t => {
  const f = fixture(t); await f.qualify(); f.capture.receive('fixture/dryer/online', 'offline');
  await f.store.runWrite(() => {});
  let release, started = false; const held = new Promise(resolve => { release = resolve; });
  const publication = f.store.runPublication(async () => { started = true; await held; });
  await settle(); assert.equal(started, true);
  f.advance(59_999); const receivedAt = f.now;
  const queued = f.store.runWrite(() => { f.capture.receive('fixture/dryer/online', 'online', {}, receivedAt); f.air();
    f.dryer('off', { timestamp: receivedAt }, false, receivedAt); f.meter(100, receivedAt); });
  f.advance(1); release(); await publication; await queued; await f.store.runWrite(() => {}); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().qualification.retained, false);
});

test('queued physical recheck refuses changed wiring before admission without rewriting proof or restoration', async t => {
  const f = fixture(t); let meterAddress = 'mqtt://synthetic-meter-a';
  f.restart({ brokerIdentityForDevice: d => ({ address: d.id === 'caravan' ? meterAddress : 'mqtt://synthetic-source', username: 'synthetic' }) });
  f.advance(1); await f.qualify();
  const request = { deviceId: 'caravan_dehumidifier', identity: 'a'.repeat(64), signature: f.guard().qualification.signature, revision: f.guard().qualification.revision };
  const rows = () => f.store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'equipment:caravan-qualification%'").all();
  const before = rows(); let release, started = false; const held = new Promise(resolve => { release = resolve; });
  const publication = f.store.runPublication(async () => { started = true; await held; }); await settle(); assert(started);
  const requestPromise = f.capture.recheckDehumidifierLocation(request), rejected = assert.rejects(requestPromise);
  meterAddress = 'mqtt://synthetic-meter-b'; release(); await publication; await rejected;
  assert.deepEqual(rows(), before); assert.equal(f.store.getState(RESTORE_KEY), null);
});

for (const enabled of [true, false]) test(`retained restart association ${enabled ? 'protects Off' : 'preserves native power'} when fresh air is missing and Automatic is ${enabled}`, async t => {
  const f = fixture(t); await f.qualify({ temperature: 2 }); await f.sample(1000, 'on', 105);
  assert.equal(f.state().state.power, 'on'); if (!enabled) await f.policy({ enabled: false });
  const commands = f.sent.length; f.restart(); f.advance(1); f.dryer('on'); f.meter(105); await settle();
  await f.sample(30_000, 'on', 105);
  assert.equal(f.guard().temperatureC, null);
  assert.deepEqual(f.sent.slice(commands), enabled ? [{ power: 'off' }] : [],
    'Historical proof authorizes neither new On nor a disabled Automatic Off');
});

test('missing air cannot grant Automatic Off from an absent or changed location association', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t); let address = 'mqtt://synthetic-a';
    f.restart({ brokerIdentityForDevice: () => ({ address, username: 'synthetic' }) }); f.advance(1);
    if (changed) { await f.qualify({ temperature: 2 }); await f.sample(1000, 'on', 105); address = 'mqtt://synthetic-b'; }
    const commands = f.sent.length; f.restart({ brokerIdentityForDevice: () => ({ address, username: 'synthetic' }) });
    f.advance(1); f.dryer('on'); f.meter(105); await settle();
    assert.equal(f.guard().qualified, false); assert.deepEqual(f.sent.slice(commands), []);
  }
});

async function restartFromQualifiedSnapshot(t) {
  const previous = fixture(t); await previous.qualify();
  const historical = previous.history().findLast(row => row.value !== null);
  const directory = await mkdtemp(join(tmpdir(), 'caravan-gate-restart-'));
  const path = join(directory, 'current.sqlite');
  // A current backup preserves the last committed boundary before an abrupt
  // stop could report transport loss. The new Store and Recorder then start
  // normally; historical association survives, but no current evidence does.
  await previous.store.backup(path); previous.capture.close();
  const fresh = fixture(t, { store: new Store(path), startAt: previous.now + 1000 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { fresh, historical };
}

test('native Off holds location-test On for five minutes without renewing clocks or consuming command intent', async t => {
  const f = fixture(t, { knownOff: false }); await f.start();
  const original = f.timing();
  while (f.now < original.sourceAt + 270_000) await f.sample(Math.min(45_000, original.sourceAt + 270_000 - f.now), 'off', 100);
  assert.equal(f.guard().locationTest.phase, 'baseline'); assert.equal(f.guard().locationTest.reason, 'waiting-restart');
  assert.equal(f.store.getState(RESTORE_KEY), null); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.timing(), original, 'unchanged native Off reports preserve transition and first confirmation clocks');
  await f.sample(29_999, 'off', 100); assert.deepEqual(f.sent, []);
  await f.sample(1, 'off', 100); assert.deepEqual(f.sent, [{ power: 'on' }]);
  assert.equal(f.publications[0].body.requestedAt, START + 300_000);
  assert.equal(f.guard().locationTest.phase, 'on'); assert.deepEqual(f.timing(), original);
});

for (const corrections of [[10_000], [10_000, 10_000, 10_000]]) {
  test(`small forward wall corrections ${corrections.length} preserve five physical minutes before manual On`, async t => {
    const f = fixture(t, { knownOff: false }); f.dryer('off'); await f.policy({ enabled: false });
    const original = structuredClone(f.timing());
    for (let n = 0; n < 9; n++) {
      f.advance(30_000);
      if (n % 2 === 1 && n / 2 < corrections.length) f.shiftWall(corrections[Math.floor(n / 2)]);
      f.dryer('off'); await settle();
    }
    assert.equal(f.elapsed, 270_000); assert.deepEqual(f.timing(), original);
    assert.equal(f.guard().restartWaiting, true);
    assert.equal(f.guard().powerRestartNotBefore, f.now + 30_000);
    await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /drying/);
    assert.deepEqual(f.sent, []);
    f.advance(29_999); f.dryer('off');
    await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /drying/);
    f.advance(1); f.dryer('off');
    await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
    assert.deepEqual(f.sent, [{ power: 'on' }]); assert.deepEqual(f.timing(), original);
  });
}

test('small forward corrections cannot advance location-test On or its displayed drying deadline', async t => {
  const f = fixture(t, { knownOff: false }); await f.start();
  const original = structuredClone(f.timing());
  while (f.elapsed < 270_000) {
    await f.sample(30_000, 'off', 100); f.shiftWall(5000); f.dryer('off');
  }
  assert.deepEqual(f.sent, []); assert.equal(f.guard().restartWaiting, true);
  assert.equal(f.guard().powerRestartNotBefore, f.now + 30_000);
  await f.sample(30_000, 'off', 100);
  assert.deepEqual(f.sent, [{ power: 'on' }]); assert.deepEqual(f.timing(), original);
});

test('missing and invalid monotonic receipt cannot establish elapsed restart permission', async t => {
  const f = fixture(t, { knownOff: false });
  const body = () => JSON.stringify({ identity: 'a'.repeat(64), power: 'off', fanSpeed: 'low', timestamp: f.now,
    fieldTimestamps: { power: f.now, fanSpeed: f.now }, capabilities });
  for (const point of [null, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, 1_000_000]) {
    f.advance(1); f.capture.receive('fixture/dryer/state', body(), {}, f.now, null, null, point);
    if (point === null) await f.policy({ enabled: false });
    await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /fresh native/);
    assert.deepEqual(f.sent, []);
  }
  f.dryer('off'); assert.equal(f.guard().restartWaiting, true);
});

test('fractional elapsed clocks project a safe integer drying deadline without rounding admission down', async t => {
  const f = fixture(t, { knownOff: false, monotonicClock: elapsed => elapsed + 0.75 });
  f.capture.receive('fixture/dryer/state', JSON.stringify({ identity: 'a'.repeat(64), power: 'off', fanSpeed: 'low',
    timestamp: f.now, fieldTimestamps: { power: f.now, fanSpeed: f.now }, capabilities }), {}, f.now, null, null, 0.25);
  const original = structuredClone(f.timing()); await f.start(); f.shiftWall(2); await f.sample(5000, 'off', 100);
  assert.equal(f.guard().powerRestartNotBefore, START + 300_002);
  assert.equal(Number.isSafeInteger(f.guard().powerRestartNotBefore), true);
  assert.equal(f.guard().locationTest.reason, 'waiting-restart');
  assert.deepEqual(f.sent, []); assert.deepEqual(f.timing(), original);
});

test('deferred native Off retains its pre-admission elapsed point through later wall corrections', async t => {
  const f = fixture(t, { knownOff: false });
  f.dryer('off', { timestamp: START + 500 });
  f.advance(500); f.capture.tick(); await settle();
  await f.policy({ enabled: false }); const original = structuredClone(f.timing());
  for (let n = 0; n < 9; n++) { f.advance(30_000); f.shiftWall(2000); f.dryer('off'); }
  assert.equal(f.guard().powerRestartNotBefore, f.now + 29_500);
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /drying/);
  f.advance(29_500); f.dryer('off');
  // The original source clock was 500 ms after receipt and retains its own epoch floor.
  f.advance(500); f.dryer('off');
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  assert.deepEqual(f.timing(), original); assert.deepEqual(f.sent, [{ power: 'on' }]);
});

test('unsafe or throwing current elapsed clock fences On without changing saved timing', async t => {
  let failure = false;
  const f = fixture(t, { knownOff: false, monotonicClock: elapsed => {
    if (failure === 'throw') throw new Error('Synthetic clock refusal');
    return failure === false ? elapsed : failure;
  } });
  f.dryer('off'); await f.policy({ enabled: false });
  const original = structuredClone(f.timing());
  for (let n = 0; n < 10; n++) { f.advance(30_000); f.dryer('off'); }
  for (const bad of [NaN, Infinity, -1, 'throw']) {
    failure = bad;
    await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /fresh native/);
    assert.deepEqual(f.sent, []); assert.deepEqual(f.timing(), original);
  }
  failure = false;
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  assert.deepEqual(f.sent, [{ power: 'on' }]);
});

test('retained and quarantined Off cannot establish restart timing until actual source admission', async t => {
  const f = fixture(t, { knownOff: false });
  f.dryer('off', {}, true); assert.equal(f.timing(), null); assert.equal(f.guard().restartWaiting, false);
  f.dryer('off', { timestamp: START + 500 }); assert.equal(f.timing(), null);
  f.advance(500); f.capture.tick(); await settle();
  assert.deepEqual(f.timing(), { identity: 'a'.repeat(64), signature: f.capture.signature('caravan_dehumidifier'),
    power: 'off', sourceAt: START + 500, receivedAt: START, admittedAt: START + 500,
    offConfirmation: { sourceAt: START + 500, receivedAt: START, admittedAt: START + 500 } });
  assert.equal(f.guard().powerRestartNotBefore, START + 300_500); assert.deepEqual(f.sent, []);
});

test('failed native Off commit rewinds the restart boundary and one-time connection confirmation together', async t => {
  const f = fixture(t, { knownOff: false }), exec = f.store.db.exec.bind(f.store.db); let fail = true;
  t.mock.method(f.store.db, 'exec', sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Synthetic timing commit failure'); } return exec(sql); });
  await assert.rejects(f.store.runWrite(() => f.dryer('off')), /Synthetic timing commit failure/);
  assert.equal(f.timing(), null); assert.equal(f.guard().restartWaiting, false); assert.deepEqual(f.sent, []);
  await f.store.runWrite(() => f.dryer('off'));
  assert.equal(f.timing().sourceAt, START); assert.equal(f.timing().offConfirmation.receivedAt, START);
  assert.equal(f.guard().powerRestartNotBefore, START + 300_000);
});

test('reconnect after unknown native power retains the original Off edge and adds one conservative fresh confirmation hold', async t => {
  const f = fixture(t, { knownOff: false }); await f.start(); const edge = f.timing();
  f.capture.receive('fixture/dryer/online', 'offline'); f.advance(600_000);
  f.capture.receive('fixture/dryer/online', 'online'); f.dryer('off'); f.meter(100); await settle();
  const confirmation = f.timing();
  assert.equal(confirmation.sourceAt, edge.sourceAt); assert.equal(confirmation.receivedAt, edge.receivedAt);
  assert.equal(confirmation.offConfirmation.sourceAt, f.now); assert.equal(f.guard().powerRestartNotBefore, f.now + 300_000);
  await f.sample(60_000, 'off', 100); assert.deepEqual(f.timing(), confirmation); assert.deepEqual(f.sent, []);
  f.advance(1); f.dryer('on'); await settle();
  assert.equal(f.timing().power, 'on'); assert.equal(f.timing().offConfirmation, null);
  assert.equal(f.guard().restartWaiting, false, 'an independent actual On supersedes the conservative Off wait');
});

test('native power silence expiry loses continuity even when no disconnect or controller tick occurs', async t => {
  const f = fixture(t, { knownOff: false }); f.dryer('off'); const edge = f.timing();
  f.advance(600_000); f.dryer('off');
  assert.equal(f.timing().sourceAt, edge.sourceAt);
  assert.equal(f.timing().offConfirmation.sourceAt, f.now);
  assert.equal(f.guard().powerRestartNotBefore, f.now + 300_000); assert.deepEqual(f.sent, []);
});

test('an Off report stale by writer admission cannot confirm unknown continuity or permit On', async t => {
  const f = fixture(t, { knownOff: false }); f.advance(600_000);
  f.dryer('off', { timestamp: START }, false, START);
  assert.equal(f.timing().sourceAt, START); assert.equal(f.timing().receivedAt, START);
  assert.equal(f.timing().admittedAt, f.now); assert.equal(f.timing().offConfirmation, null);
  assert.equal(f.guard().restartWaiting, false, 'unknown timing is not described as a known drying cycle');
  assert.equal(f.guard().powerRestartNotBefore, null); assert.deepEqual(f.sent, []);
  f.advance(1); f.dryer('off');
  assert.equal(f.guard().powerRestartNotBefore, f.now + 300_000);
});

test('final On dispatch rechecks a new conservative Off hold after temporarily unknown power feedback', async t => {
  let release, blocked = false;
  const f = fixture(t, { beforePublish: async (topic, payload) => {
    if (blocked && topic === 'fixture/dryer/set' && JSON.parse(payload).power === 'on') await new Promise(resolve => { release = resolve; });
  } });
  await f.qualify({ enabled: false }); blocked = true;
  const request = f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  await settle(); const count = f.sent.length;
  f.advance(1); f.dryer('off', { fieldTimestamps: { power: null, fanSpeed: f.now, targetHumidity: f.now } });
  f.advance(1); f.dryer('off'); await settle();
  assert.equal(f.guard().restartWaiting, true); release();
  await assert.rejects(request, /delivery is unconfirmed/);
  assert.equal(f.sent.length, count, 'regained command freshness does not bypass the newly confirmed Off restart hold');
});

test('manual On respects the same native Off boundary without saving an attempted command', async t => {
  const f = fixture(t); await f.qualify({ enabled: false });
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  await f.sample(1000, 'on', 105);
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'off' });
  await f.sample(1000, 'off', 100); const operation = structuredClone(f.state().operation), clock = f.timing().sourceAt;
  await assert.rejects(f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' }), /drying.*300 seconds/);
  assert.deepEqual(f.state().operation, operation); assert.equal(f.timing().sourceAt, clock);
  await f.waitRestart();
  await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
  assert.equal(f.publications.at(-1).body.requestedAt, clock + 300_000);
});

test('On restoration remains durable during drying and restart without renewed attempts', async t => {
  const f = fixture(t, { knownOff: false }); f.dryer('on'); await f.policy({ enabled: false }); f.meter(105); await settle();
  await f.sample(30_000, 'on', 105);
  await f.sample(1000, 'off', 100); await f.waitRestart();
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  const obligation = f.store.getState(RESTORE_KEY), edge = f.timing(), count = f.sent.length;
  assert.equal(obligation.power, 'on'); assert.equal(f.guard().locationTest.status, 'restoring');
  await f.sample(60_000, 'off', 100); assert.deepEqual(f.store.getState(RESTORE_KEY), obligation);
  assert.deepEqual(await f.capture.restoreCaravanProbes({ timeoutMs: 0 }), { restorationPending: true });
  assert.equal(f.sent.length, count); assert.deepEqual(f.store.getState(RESTORE_KEY), obligation);
  f.restart(); f.advance(1); f.dryer('off'); await settle();
  assert.equal(f.timing().sourceAt, edge.sourceAt); assert.equal(f.store.getState(RESTORE_KEY).lastCommandAt, obligation.lastCommandAt);
  const restartAt = f.guard().powerRestartNotBefore;
  await f.waitRestart(); assert.equal(f.sent.length, count + 1);
  assert.equal(f.sent.at(-1).power, 'on'); assert.equal(f.publications.at(-1).body.requestedAt, restartAt);
  f.capture.receive('fixture/meter/online', 'offline');
  f.advance(1); f.dryer('on'); await settle(); assert.equal(f.store.getState(RESTORE_KEY), null);
});

test('clock rollback after restart cannot shorten the durable conservative Off confirmation hold', async t => {
  const f = fixture(t, { knownOff: false }); f.dryer('off'); f.advance(200_000); f.dryer('off');
  const original = f.timing(), restartAt = f.guard().powerRestartNotBefore;
  f.advance(-100_000); f.restart(); f.dryer('off');
  assert.deepEqual(f.timing(), original, 'earlier current confirmation cannot replace the later durable safety boundary');
  assert.equal(f.guard().powerRestartNotBefore, restartAt); assert.equal(f.guard().restartWaiting, true);
  assert.deepEqual(f.sent, []);
});

test('restart clock earlier than the original Off edge cannot save an out-of-order confirmation', async t => {
  const f = fixture(t, { knownOff: false }); f.dryer('off'); const original = f.timing();
  f.advance(-60_000); f.restart(); f.dryer('off');
  assert.deepEqual(f.timing(), original); assert.equal(f.guard().powerRestartNotBefore, START + 300_000);
  const directory = await mkdtemp(join(tmpdir(), 'caravan-timing-rollback-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'current.sqlite'); await f.store.backup(path);
  const reopened = new Store(path); assert.deepEqual(reopened.getState(caravanPowerTimingKey('caravan_dehumidifier',
    'a'.repeat(64), f.capture.signature('caravan_dehumidifier'))), original); reopened.close();
  assert.deepEqual(f.sent, []);
});

test('current-format restart reports a qualification gap on its first fresh state without renewing historical measurements', async t => {
  const { fresh: f, historical } = await restartFromQualifiedSnapshot(t);
  await f.start({ stable: false });
  const row = f.recorder.status(f.now).exactParameters.find(row => row.signal === SIGNAL);
  assert.equal(f.state().available, true); assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  assert.equal(row.observedThisRun, true);
  assert.equal(row.freshness.status, 'unavailable');
  assert(row.freshness.reasons.includes('location-unconfirmed'));
  assert.equal(row.freshness.sourceObservedAt, historical.sourceTime);
  assert.equal(row.lastSourceTime, historical.sourceTime);
  assert.deepEqual(f.history().findLast(point => point.value !== null), historical);
  const gaps = f.history().filter(point => point.quality.includes('location-unconfirmed'));
  assert.equal(gaps.length, 2, 'the original startup gap and this restarted capture each have one real transition');
  assert.equal(gaps.at(-1).value, null); assert.equal(gaps.at(-1).sourceTime, null);
  assert.equal(gaps.at(-1).receivedAt, f.now);
  await f.sample(29_999, 'off', 0); assert.equal(f.guard().recording, false);
  await f.sample(1, 'off', 0);
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.guard().locationTest.completedAt, historical.raw.locationEvidence.completedAt);
  assert.equal(f.guard().restartWaiting, true, 'The independent native restart restriction still applies');
  assert.deepEqual(f.sent, [], 'Zero meter watts alone do not revoke an electrical association or authorize a test');
  const recovered = f.history().findLast(point => point.value !== null);
  assert.equal(recovered.sourceTime, f.now, 'New state evidence does not fill the earlier recovery gap');
  assert.equal(f.history().filter(point => point.quality.includes('location-unconfirmed')).length, gaps.length,
    'the real gap is retained once across association recovery');
  f.capture.receive('fixture/dryer/online', 'offline'); f.capture.receive('fixture/dryer/online', 'online');
  await f.sample(1, 'off', 0); await f.sample(30_000, 'off', 0);
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.history().findLast(point => point.value !== null).sourceTime, f.now);
  assert.deepEqual(f.sent, [], 'A later brief flap also recovers without a test');
  assert.equal(f.recorder.status(f.now).exactParameters.find(point => point.signal === SIGNAL).freshness.status, 'fresh');
  assert.deepEqual(f.history().find(point => point.id === historical.id), historical,
    'fresh recovery adds current evidence without changing the earlier state or filling the gap');
});

test('retained and pending source reports cannot publish a new capture qualification transition before admission', async t => {
  const { fresh: f, historical } = await restartFromQualifiedSnapshot(t);
  const gaps = () => f.history().filter(point => point.quality.includes('location-unconfirmed'));
  const baseline = gaps().length;
  f.dryer('off', {}, true); f.meter(100);
  assert.equal(gaps().length, baseline, 'retained appliance context is not current qualification evidence');
  const receipt = f.now; f.dryer('off', { timestamp: receipt + 500 });
  assert.equal(gaps().length, baseline, 'a quarantined report is not yet admitted');
  f.advance(500); f.capture.tick(); await settle();
  assert.equal(gaps().length, baseline + 1);
  assert.equal(gaps().at(-1).sourceTime, null);
  assert.equal(gaps().at(-1).receivedAt, f.now);
  assert.equal(f.state().observedAt, receipt + 500, 'admission retains the original native source clock');
  assert.equal(f.recorder.status(f.now).exactParameters.find(point => point.signal === SIGNAL).lastSourceTime, historical.sourceTime);
  assert.equal(f.guard().recording, false); assert.deepEqual(f.sent, []);
});

test('a failed first qualification-gap commit rewinds admission and retries one honest transition', async t => {
  const { fresh: f, historical } = await restartFromQualifiedSnapshot(t);
  f.air(); f.meter(100);
  const rows = f.history(), exec = f.store.db.exec.bind(f.store.db); let fail = true;
  t.mock.method(f.store.db, 'exec', sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw new Error('Synthetic qualification-gap commit failure'); }
    return exec(sql);
  });
  await assert.rejects(f.store.runWrite(() => f.dryer('off')), /Synthetic qualification-gap commit failure/);
  assert.deepEqual(f.history(), rows);
  await f.store.runWrite(() => f.dryer('off'));
  const gap = f.history().at(-1);
  assert.equal(gap.value, null); assert(gap.quality.includes('location-unconfirmed'));
  assert.equal(f.history().length, rows.length + 1);
  assert.equal(f.recorder.status(f.now).exactParameters.find(point => point.signal === SIGNAL).lastSourceTime, historical.sourceTime);
  assert.equal(f.guard().recording, false); assert.deepEqual(f.sent, []);
});

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
  assert.equal(inventory.find(row => row.id === 'state-caravan-power-timing').count, 1);
  for (const publication of f.publications) {
    assert.equal(publication.body.expiresAt, publication.body.requestedAt + 10000);
    const { beforePublish, preparePublish, signal, ...flags } = publication.flags;
    assert.equal(typeof beforePublish, 'function'); assert.equal(typeof preparePublish, 'function'); assert(signal instanceof AbortSignal);
    assert.deepEqual(flags, { qos: 1, retain: false, noReplay: true });
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
  const f = fixture(t); f.advance(1); f.dryer('on'); await f.policy({ enabled: false }); f.meter(105); await settle();
  await f.sample(30_000, 'on', 105);
  assert.deepEqual(f.sent, [{ power: 'off' }]);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  await f.waitRestart();
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  await f.sample(1000, 'off', 100); await f.sample(5000, 'off', 100);
  assert.equal(f.guard().locationTest.status, 'restoring'); assert.equal(f.guard().recording, false);
  assert.deepEqual(f.sent, [{ power: 'off' }, { power: 'on' }, { power: 'off' }]);
  await f.waitRestart();
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
  f.meter(100); f.dryer('off'); await settle();
  await f.sample(29_999, 'off', 100); assert.deepEqual(f.sent, []);
  await f.sample(1, 'off', 100); assert.deepEqual(f.sent, []);
  await f.sample(5000, 'off', 100); assert.deepEqual(f.sent, [{ power: 'on' }]);
  f.advance(1000); f.dryer('on', { fieldTimestamps: { power: START, fanSpeed: f.now } }); f.meter(105); await settle();
  f.advance(5000); f.meter(105); await settle();
  assert.equal(f.sent.length, 1, 'Fresh meter samples cannot replace independent native On readback');
  await f.sample(1000, 'on', 105); await f.sample(5000, 'on', 105);
  assert.deepEqual(f.sent.at(-1), { power: 'off' });
});

test('offline and repeated online markers retain only historical association until advancing recovery', async t => {
  const f = fixture(t); await f.qualify(); const gapAt = f.now + 1000;
  f.advance(1000); f.capture.receive('fixture/dryer/online', 'offline');
  assert.equal(f.guard().recording, false); assert.equal(f.history().at(-1).value, null);
  f.capture.receive('fixture/dryer/online', 'online'); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 2); assert.equal(f.guard().qualified, false);
  await f.sample(1000, 'off', 100); await f.sample(29_999, 'off', 100);
  assert.equal(f.guard().qualified, false);
  await f.sample(1, 'off', 100);
  assert.equal(f.sent.length, 2); assert.equal(f.guard().qualified, true);
  assert(f.history().filter(row => row.value !== null && row.receivedAt > gapAt)
    .every(row => row.sourceTime >= gapAt + 31_000));
  f.advance(1000); f.capture.receive('fixture/dryer/online', 'online'); f.capture.tick(); await settle();
  assert.equal(f.sent.length, 2, 'A repeated online heartbeat does not create a new physical session');
});

test('broker reconnection preserves association while current qualification requires stable source recovery', async t => {
  const f = fixture(t); await f.qualify(); f.capture.setConnected(false);
  f.advance(1000); f.capture.setConnected(true); f.capture.confirmSubscriptions(f.capture.topics);
  f.capture.receive('fixture/dryer/online', 'online'); f.capture.receive('fixture/meter/online', 'online');
  f.dryer('off'); f.meter(100); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.guard().recording, false);
  await f.waitRestart();
  await f.sample(5000, 'off', 100); assert.equal(f.sent.length, 2);
  assert.equal(f.guard().qualified, true);
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
  f.meter(100); await f.waitRestart(); await f.sample(5000, 'off', 100); assert.deepEqual(f.sent.at(-1), { power: 'on' });
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
  f.advance(1000); f.air(2); await settle(); assert.deepEqual(f.sent.at(-1), { power: 'off' });
  await f.waitRestart({ temperature: 2 }); assert.deepEqual(f.sent.at(-1), { power: 'on' });
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
  f.meter(100); await settle(); assert.equal(f.guard().qualified, true); assert.equal(f.sent.length, 2);
  await f.waitRestart({ temperature: 3 }); assert.equal(f.sent.length, 3);
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
  await f.waitRestart();
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

test('native Shelly kW reports advance placement and recover a brief outage without plug switching', async t => {
  const f = fixture(t, { nativeMeter: true }); await f.qualify({ enabled: false });
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  assert.equal(f.guard().locationTest.powerRiseW, 5, 'Native kW readings are compared in watts');
  assert.equal(f.sent.length, 2);
  f.advance(1000); f.capture.receive('fixture/native-meter/online', 'false');
  assert.equal(f.guard().qualified, false); assert.equal(f.history().at(-1).value, null);
  f.capture.receive('fixture/native-meter/online', 'true'); f.meter(100, f.now, true); await settle();
  assert.equal(f.guard().qualified, false); assert.equal(f.sent.length, 2);
  await f.sample(1, 'off', 100); await f.sample(29_999, 'off', 100);
  assert.equal(f.guard().qualified, false);
  await f.sample(1, 'off', 100);
  assert.equal(f.sent.length, 2); assert.equal(f.guard().qualified, true);
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

for (const mode of ['warm-unqualified', 'rollback-unqualified', 'hysteresis-unqualified', 'threshold-control', 'missing-air-control', 'stale-air-control', 'future-air-control', 'warm-qualified-control']) {
  test(`actual current protective Off publication: ${mode}`, async t => {
    let armed = false, held = false, released = false, entered = 0, gateCalls = 0, release;
    const waiting = new Promise(resolve => { release = () => { if (!released) { released = true; resolve(); } }; });
    const f = fixture(t, { beforePublish: async (topic, payload, flags) => {
      if (!armed || topic !== 'fixture/dryer/set' || JSON.parse(payload).power !== 'off') return;
      entered++; held = true;
      assert.equal(typeof flags.beforePublish, 'function');
      const original = flags.beforePublish;
      flags.beforePublish = (...args) => { gateCalls++; return original(...args); };
      await waiting;
    } });
    try {
      await f.qualify({ temperature: 3 });
      await f.sample(1, 'on', 105);
      assert.equal(f.state().available, true);
      assert.equal(f.state().state.power, 'on');
      assert.equal(f.guard().qualified, true);
      assert.equal(f.guard().qualification.retained, true);
      assert.equal(f.store.getState('equipment:caravan-probe-restoration:v1:caravan_dehumidifier:' + 'a'.repeat(64)), null);
      const passedAt = f.guard().qualification.passedAt, revision = f.guard().qualification.revision;
      const before = f.sent.length;
      armed = true;
      if (mode === 'warm-qualified-control') {
        // Keep native and meter reports continuous while only room air expires.
        for (let n = 0; n < 4; n++) await f.sample(45_000, 'on', 105);
        assert.equal(f.guard().qualified, true);
      } else {
        f.restart(); f.advance(1); f.dryer('on'); f.meter(105); await settle();
        assert.equal(f.guard().qualified, false);
      }
      assert.equal(held, true, 'the actual producer reached the final publisher hold');
      assert.equal(entered, 1, 'one original current Off request is held');
      assert.equal(f.guard().temperatureC, null, 'missing room evidence actually armed protective Off');
      assert.equal(f.state().state.power, 'on', 'native On remains observed before any Off bytes');
      assert.equal(f.state().available, true, 'fresh native appliance feedback is usable');
      assert.equal(f.sent.length, before, 'the held publisher has sent no bytes');
      assert.equal(f.guard().qualification.retained, true);
      assert.equal(f.guard().qualification.passedAt, passedAt);
      assert.equal(f.guard().qualification.revision, revision);
      if (mode === 'rollback-unqualified') assert.throws(() => f.store.transaction(() => {
        f.air(2.5); throw new Error('synthetic receipt rollback');
      }), /synthetic receipt rollback/);
      f.advance(1);
      if (['warm-unqualified', 'rollback-unqualified', 'warm-qualified-control'].includes(mode)) f.air(3);
      if (mode === 'hysteresis-unqualified') f.air(1.5, 50, false, f.now - 179_999);
      if (mode === 'threshold-control') f.air(1);
      if (mode === 'stale-air-control') f.air(3, 50, false, f.now - 180_001);
      if (mode === 'future-air-control') f.air(3, 50, false, f.now + 500);
      await settle();
      if (['warm-unqualified', 'rollback-unqualified', 'hysteresis-unqualified'].includes(mode)) {
        assert.equal(f.guard().qualified, false, 'the original 30-second recovery boundary has not elapsed');
        assert.equal(f.guard().qualification.retained, true);
        assert.equal(f.guard().locationTest.status, 'passed');
        assert.equal(f.guard().temperatureC, mode === 'hysteresis-unqualified' ? 1.5 : 3);
        assert.equal(f.guard().reason, 'recovering-feedback', 'native and selected meter are healthy while association recovery is pending');
        assert.equal(f.state().available, true);
        assert.equal(f.state().state.power, 'on');
      } else if (mode === 'warm-qualified-control') {
        assert.equal(f.guard().qualified, true);
        assert.equal(f.guard().temperatureC, 3);
        assert.equal(f.guard().desiredPower, 'on', 'the existing demand fence is re-evaluated for fully qualified warm evidence');
      } else if (mode === 'threshold-control') assert.equal(f.guard().temperatureC, 1);
      else assert.equal(f.guard().temperatureC, null, 'stale/future-unadmitted/missing air cannot supersede protection');
      const beforeRelease = { qualified: f.guard().qualified, warm: f.guard().temperatureC === 3,
        retained: f.guard().qualification.retained, nativeOn: f.state().state.power === 'on',
        locationPassed: f.guard().locationTest.status === 'passed' };
      release(); await settle(); await settle();
      assert.equal(gateCalls, 1, 'the ORIGINAL beforePublish admission gate actually executed once');
      const commands = f.sent.slice(before);
      t.diagnostic(JSON.stringify({ mode, beforeRelease, entered, gateCalls,
        offCommands: commands.filter(command => command.power === 'off').length,
        onCommands: commands.filter(command => command.power === 'on').length }));
      assert.equal(commands.some(command => command.power === 'on'), false, 'historical proof never grants a replacement On');
      const expected = ['warm-unqualified', 'rollback-unqualified', 'hysteresis-unqualified', 'warm-qualified-control'].includes(mode) ? [] : [{ power: 'off' }];
      assert.deepEqual(commands, expected, 'fresh warm recovery preserves the actual native baseline; current missing evidence still protects Off');
      if (['warm-unqualified', 'rollback-unqualified', 'hysteresis-unqualified'].includes(mode)) {
        assert.equal(f.state().operation.status, 'failed');
        assert.equal(f.state().operation.code, 'EQUIPMENT_COMMAND_CANCELLED');
        assert.match(f.state().operation.error, /request was not sent/);
        assert.equal(f.state().operation.dispatchedAt, undefined);
        assert.equal(f.state().operation.acknowledgedAt, undefined);
        // A known-unsent cancellation must not throttle a later actual cold boundary.
        const cancelledAt = f.now;
        if (mode === 'hysteresis-unqualified') {
          await f.sample(2, 'on', 105);
          assert.equal(f.guard().temperatureC, null, 'the original room clock expires without a replacement observation');
        } else { f.advance(1); f.air(0); await settle(); }
        await settle();
        assert(f.now - cancelledAt < 30_000);
        assert.deepEqual(f.sent.slice(before), [{ power: 'off' }]);
        assert.equal(f.state().operation.status, 'published');
        assert.equal(f.state().operation.code, undefined);
        assert.equal(f.state().operation.dispatchedAt, f.now);
      }
    } finally { release(); await settle(); }
  });
}

for (const [temperature, rollback] of [[1.5, false], [3, false], [3, true]]) test(`warm recovery at ${temperature} cancels protective Off before its committed effect starts (rollback ${rollback})`, async t => {
  const f = fixture(t); await f.qualify({ temperature: 3 }); await f.sample(1, 'on', 105);
  const proof = f.guard().qualification.passedAt, before = f.sent.length;
  f.restart();
  // The actual Store defers both receipt effects until this outer commit. The
  // missing-air decision precedes the newly admitted warm room observation.
  f.store.transaction(() => {
    f.advance(1); f.dryer('on'); f.meter(105);
    assert.equal(f.guard().temperatureC, null);
    assert.equal(f.state().operation, null);
    if (rollback) assert.throws(() => f.store.transaction(() => {
      f.air(2.5); throw new Error('synthetic receipt rollback');
    }), /synthetic receipt rollback/);
    f.advance(1); f.air(temperature);
    assert.equal(f.guard().qualified, false);
    assert.equal(f.guard().reason, 'recovering-feedback');
    assert.equal(f.state().available, true); assert.equal(f.state().state.power, 'on');
    assert.equal(f.guard().qualification.passedAt, proof);
    assert.equal(f.sent.length, before);
  });
  await settle(); assert.equal(f.sent.length, before);
  assert.equal(f.state().operation, null, 'a cancelled post-commit effect creates no native command receipt');
  f.advance(1); f.air(0); await settle(); await settle();
  assert.deepEqual(f.sent.slice(before), [{ power: 'off' }], 'the unsent old attempt cannot throttle a new cold boundary');
});

test('a deferred warm-baseline cancellation cannot replace a newer operation owner', async t => {
  const f = fixture(t); await f.qualify({ temperature: 3 }); await f.sample(1, 'on', 105);
  f.restart(); const before = f.sent.length, afterCommit = f.store.afterCommit, effects = [];
  // Hold only effects of already committed fixture receipts. Restore the real
  // method before the newer request, without guessing callback names.
  f.store.afterCommit = function (effect) { return afterCommit.call(this, () => effects.push(effect)); };
  try {
    f.advance(1); f.dryer('on'); f.meter(105);
    assert(effects.length > 0); assert.equal(f.state().operation, null);
    f.store.afterCommit = afterCommit;
    f.advance(1); f.air(3); await settle();
    assert.equal(f.guard().reason, 'recovering-feedback');
    await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'fanSpeed', value: 'high' });
    const newer = f.state().operation;
    assert.equal(newer.status, 'published');
    for (const effect of effects.splice(0)) effect();
    await settle();
    assert.deepEqual(f.state().operation, newer);
    assert.deepEqual(f.sent.slice(before), [{ fanSpeed: 'high' }]);
  } finally {
    f.store.afterCommit = afterCommit;
    for (const effect of effects.splice(0)) effect();
    await settle();
  }
});

test('known-unsent warm cancellation cannot clear a newer operation created before its transport rejects', async t => {
  let armed = false, held = false, release, newer, f;
  const waiting = new Promise(resolve => { release = resolve; });
  f = fixture(t, { beforePublish: async (topic, payload, flags) => {
    if (!armed || topic !== 'fixture/dryer/set' || JSON.parse(payload).power !== 'off') return;
    held = true; await waiting;
    // Run the actual byte gate exactly once. Before returning its rejection,
    // let the real timeout/replacement path admit a new supported request.
    try { flags.beforePublish(); }
    catch (error) {
      assert.equal(f.state().operation.dispatchedAt, undefined);
      f.advance(10_001); f.capture.tick();
      await f.policy({ enabled: false });
      await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'fanSpeed', value: 'high' });
      newer = f.state().operation; throw error;
    }
    assert.fail('warm recovery must reject the obsolete Off before bytes');
  } });
  try {
    await f.qualify({ temperature: 3 }); await f.sample(1, 'on', 105);
    const before = f.sent.length; armed = true;
    f.restart(); f.advance(1); f.dryer('on'); f.meter(105); await settle();
    assert.equal(held, true);
    f.advance(1); f.air(3); await settle();
    release(); await settle(); await settle();
    assert(newer); assert.equal(newer.setting, 'fanSpeed'); assert.equal(newer.status, 'published');
    assert.deepEqual(f.state().operation, newer);
    assert.deepEqual(f.sent.slice(before), [{ fanSpeed: 'high' }]);
  } finally { release(); await settle(); await settle(); }
});

test('warm recovery cannot erase an already dispatched uncertain Off or a newer native request', async t => {
  let hold = false, entered = false, reject;
  const waiting = new Promise((resolve, fail) => { reject = fail; });
  const f = fixture(t, { publish: async body => {
    if (hold && body.power === 'off') { entered = true; await waiting; }
  } });
  try {
    await f.qualify({ temperature: 3 }); await f.sample(1, 'on', 105);
    const before = f.sent.length; hold = true;
    f.restart(); f.advance(1); f.dryer('on'); f.meter(105); await settle();
    assert.equal(entered, true); assert.deepEqual(f.sent.slice(before), [{ power: 'off' }]);
    const dispatchedAt = f.state().operation.dispatchedAt;
    assert.equal(dispatchedAt, f.now, 'the real publisher gate ran before the synthetic transport failure');
    f.advance(1); f.air(3); await settle();
    assert.equal(f.guard().reason, 'recovering-feedback');
    assert.equal(f.state().operation.dispatchedAt, dispatchedAt);
    f.advance(10_001); f.capture.tick();
    assert.equal(f.state().operation.status, 'unconfirmed');
    assert.equal(f.state().operation.code, undefined);
    await f.policy({ enabled: false });
    await f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'fanSpeed', value: 'high' });
    const newer = f.state().operation;
    assert.equal(newer.setting, 'fanSpeed'); assert.equal(newer.status, 'published');
    reject(new Error('synthetic lost publication acknowledgement')); await settle(); await settle();
    assert.deepEqual(f.state().operation, newer, 'an older dispatched completion cannot clear or relabel the newer request');
    assert.deepEqual(f.sent.slice(before), [{ power: 'off' }, { fanSpeed: 'high' }]);
  } finally { reject(new Error('synthetic fixture cleanup')); await settle(); }
});

for (const dispatched of [false, true]) test(`cancelled protective Off preserves only an actually dispatched unresolved On (${dispatched})`, async t => {
  let armed = false, offHeld = false, releaseOff, releaseOn;
  const offWaiting = new Promise(resolve => { releaseOff = resolve; });
  const onWaiting = new Promise(resolve => { releaseOn = resolve; });
  const f = fixture(t, { beforePublish: async (topic, payload) => {
    if (!armed || topic !== 'fixture/dryer/set') return;
    if (JSON.parse(payload).power === 'off') { offHeld = true; await offWaiting; }
    if (!dispatched && JSON.parse(payload).power === 'on') await onWaiting;
  }, publish: async body => { if (armed && dispatched && body.power === 'on') await onWaiting; } });
  let request;
  try {
    await f.qualify({ enabled: false, temperature: 3 }); armed = true;
    const before = f.sent.length;
    request = f.capture.setDehumidifier({ deviceId: 'caravan_dehumidifier', setting: 'power', value: 'on' });
    request.catch(() => {}); await settle();
    const original = f.state().operation;
    assert.equal(Number.isFinite(original.dispatchedAt), dispatched);
    assert.equal(f.sent.length - before, dispatched ? 1 : 0);
    // Enabling Automatic cannot create takeover or bypass the original On.
    await f.policy({ enabled: true });
    f.advance(1); f.capture.setConnected(false); f.capture.setConnected(true);
    f.capture.confirmSubscriptions(f.capture.topics);
    f.capture.receive('fixture/dryer/online', 'online');
    f.capture.receive('fixture/meter/online', 'online');
    f.dryer('off'); f.meter(100); await settle();
    assert.equal(offHeld, true);
    assert.equal(f.guard().temperatureC, null);
    f.advance(1); f.air(3); await settle();
    assert.equal(f.guard().reason, 'recovering-feedback');
    assert.equal(f.guard().qualification.retained, true);
    releaseOff(); await settle(); await settle();
    assert.equal(f.sent.slice(before).some(command => command.power === 'off'), false);
    const retained = f.state().operation;
    if (dispatched) {
      assert.equal(retained.value, 'on'); assert.equal(retained.status, 'unconfirmed');
      assert.equal(retained.requestedAt, original.requestedAt);
      assert.equal(retained.dispatchedAt, original.dispatchedAt);
      assert.equal(retained.code, undefined);
      assert.equal(retained.error, 'Dehumidifier command delivery is unconfirmed. Check its live state before trying again.');
    } else {
      assert.equal(retained.value, 'off'); assert.equal(retained.status, 'failed');
      assert.equal(retained.code, 'EQUIPMENT_COMMAND_CANCELLED');
      assert.equal(retained.dispatchedAt, undefined);
    }
    releaseOn(); await request.catch(() => {}); await settle();
    assert.equal(f.sent.length - before, dispatched ? 1 : 0);
    assert.equal(f.state().operation.requestedAt, retained.requestedAt);
    assert.equal(f.state().operation.value, retained.value);
    assert.equal(f.state().operation.status, retained.status);
  } finally { releaseOff(); releaseOn(); await request?.catch(() => {}); await settle(); }
});
