import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { bluHtEquipment } from '../integrations/shelly/blu-ht.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';
import { caravanPowerTimingKey, CARAVAN_NATIVE_RESTART_DELAY_MS } from '../src/domain/caravan-power-timing.js';

const START = Date.parse('2026-09-22T10:00:00Z');
const SIGNAL = 'caravan_dehumidifier_state';
const RESTORE_KEY = `equipment:caravan-probe-restoration:v1:caravan_dehumidifier:${'a'.repeat(64)}`;
const capabilities = { power: ['off', 'on'], fanSpeed: ['low', 'medium', 'high'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5) };
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const store = options.store ?? new Store(':memory:'), observations = [], sent = [], publications = [], allPublications = [];
  const initialClock = options.startAt ?? START;
  let now = !options.store && options.knownOff !== false ? initialClock - CARAVAN_NATIVE_RESTART_DELAY_MS : initialClock, authority = true, capture;
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
      if (options.beforePublish) await options.beforePublish(topic, payload, flags);
      flags?.beforePublish?.();
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
  const f = { get capture() { return capture; }, store, recorder, sent, observations, publications, allPublications,
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
    start: async ({ temperature = 1.5, humidity = 50, appliance = {}, enabled } = {}) => {
      f.air(temperature, humidity); f.dryer('off', appliance);
      if (enabled !== undefined) await f.policy({ enabled });
      f.meter(100); await settle();
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
    while (now < initialClock) { now += Math.min(60_000, initialClock - now); f.dryer('off'); }
  }
  return f;
}

async function restartFromQualifiedSnapshot(t) {
  const previous = fixture(t); await previous.qualify();
  const historical = previous.history().findLast(row => row.value !== null);
  const directory = await mkdtemp(join(tmpdir(), 'caravan-gate-restart-'));
  const path = join(directory, 'current.sqlite');
  // A current backup preserves the last committed boundary before an abrupt
  // stop could report transport loss. The new Store and Recorder then start
  // normally; no capture-local qualification survives the restart.
  await previous.store.backup(path); previous.capture.close();
  const fresh = fixture(t, { store: new Store(path), startAt: previous.now + 1000 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { fresh, historical };
}

test('native Off holds location-test On for five minutes without renewing clocks or consuming command intent', async t => {
  const f = fixture(t, { knownOff: false }); await f.start();
  const original = f.timing();
  for (let index = 0; index < 6; index++) await f.sample(45_000, 'off', 100);
  assert.equal(f.guard().locationTest.phase, 'baseline'); assert.equal(f.guard().locationTest.reason, 'waiting-restart');
  assert.equal(f.store.getState(RESTORE_KEY), null); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.timing(), original, 'unchanged native Off reports preserve transition and first confirmation clocks');
  await f.sample(29_999, 'off', 100); assert.deepEqual(f.sent, []);
  await f.sample(1, 'off', 100); assert.deepEqual(f.sent, [{ power: 'on' }]);
  assert.equal(f.publications[0].body.requestedAt, START + 300_000);
  assert.equal(f.guard().locationTest.phase, 'on'); assert.deepEqual(f.timing(), original);
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
  await f.start();
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
  await f.waitRestart();
  await f.sample(5000, 'off', 100);
  for (let index = 0; index < 4; index++) await f.sample(45000, 'on', 100);
  await f.sample(1000, 'off', 100);
  assert.equal(f.guard().locationTest.status, 'failed'); assert.equal(f.guard().locationTest.reason, 'no-power-rise');
  assert.equal(f.state().available, true); assert.equal(f.guard().recording, false);
  for (let index = 0; index < 3; index++) await f.sample(30000, 'off', 100);
  const unavailable = f.recorder.status(f.now).exactParameters.find(point => point.signal === SIGNAL);
  assert.equal(unavailable.freshness.status, 'unavailable');
  assert(unavailable.freshness.reasons.includes('location-unconfirmed'));
  assert.equal(unavailable.freshness.sourceObservedAt, historical.sourceTime);
  assert.equal(f.history().filter(point => point.quality.includes('location-unconfirmed')).length, gaps.length,
    'fresh unqualified polling and a failed check do not generate repeated gap transitions');
  assert.deepEqual(f.sent, [{ power: 'on' }, { power: 'off' }], 'failure restores once and does not renew the test');
  assert.deepEqual(f.history().findLast(point => point.value !== null), historical);

  f.capture.receive('fixture/dryer/online', 'offline'); f.capture.receive('fixture/dryer/online', 'online');
  await f.qualify();
  assert.equal(f.guard().qualified, true); assert.equal(f.guard().recording, true);
  const recovered = f.history().findLast(point => point.value !== null);
  assert.equal(recovered.sourceTime, f.now);
  assert.equal(f.recorder.status(f.now).exactParameters.find(point => point.signal === SIGNAL).freshness.status, 'fresh');
  assert.deepEqual(f.history().find(point => point.id === historical.id), historical,
    'fresh qualification adds current evidence without changing the earlier state or filling the gap');
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
    const { beforePublish, signal, ...flags } = publication.flags;
    assert.equal(typeof beforePublish, 'function'); assert(signal instanceof AbortSignal);
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
  await f.waitRestart();
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
