import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { startReplica } from '../src/app/replica.js';
import { createChartService } from '../src/app/chart-service.js';
import { loadConfig } from '../src/app/config.js';
import { start } from '../src/main.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { Recorder } from '../src/storage/recorder.js';
import { applyLearningRecord, LEARNING_ALGORITHM} from '../src/app/committed-learning.js';
import { appendLearningRecord, currentComfortReference } from './helpers/home-learning-fixture.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { garageSettings } from '../src/garage/settings.js';
import { mitsubishiControl } from '../chart/mitsubishi.js';

const at = Date.parse('2026-01-15T12:00:00+02:00');
const chartPath = '/api/chart?start=2026-01-15&end=2026-01-15&left=power';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-replica-viewer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function snapshot(directory, generation, value = 21, sourceAt = at) {
  const dbPath = join(directory, `${generation}.sqlite`), store = new Store(dbPath);
  store.observation({ source: 'test-fixture', device: 'synthetic-sensor', signal: 'indoor_temperature',
    value, unit: 'degC', sourceTime: sourceAt - 60_000, receivedAt: sourceAt - 60_000 });
  store.event('decision', { input: 'mqtt', phase: 'reduction', commands: ['reduction'] }, sourceAt);
  // Copied settings and outstanding obligations must never activate on a viewer.
  store.setState('settings:mqtt', { comfort: { maxDropC: 0.5 } });
  store.setState('executor:home', { version: 2, targetBindings: { tariff: { identity: 'a'.repeat(64), generation: 'synthetic-generation' } },
    legacyOutstanding: true, phase: 'reduction', pulseUntil: 0, expiresAt: sourceAt + 60_000 });
  store.setState('h66:control:synthetic-device', { version: 1, phase: 'preheat', baseline: { '0203': 20 },
    obligations: { '0203': { baseline: 20, expected: 25, previousValue: 20, requestedAt: sourceAt,
      originalAt: sourceAt, requestedRevision: 1, confirmed: true, confirmedAt: sourceAt, restoring: false } },
    requested: { '0203': 25 }, expiresAt: sourceAt + 60_000 });
  store.db.prepare(`INSERT INTO energy_audits(source,device,signal,source_time,received_at,value,quality)
    VALUES('easee','synthetic-device','ev1_lifetime_energy_counter',?,?,10,'[]')`).run(sourceAt, sourceAt);
  store.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  chmodSync(dbPath, 0o600);
  return { dbPath, generation, sourceAt, verifiedAt: sourceAt, sourceStartedAt: sourceAt - 1000,
    digest: digest(dbPath), bytes: readFileSync(dbPath).length };
}

const configuration = directory => ({ topology: 'mirror', role: 'slave', input: 'mqtt', addon: false,
  host: '127.0.0.1', port: 0, token: '', mirror: { directory, intervalMs: 60_000 },
  settings: { comfort: { maxDropC: 0.5 } }, connections: { mqtt: { address: 'mqtt://127.0.0.1:1' } },
  h66: { enabled: true, writeEnabled: true } });

async function viewer(t, directory, readPublication, extra = {}) {
  const app = await startReplica({ config: configuration(directory), readPublication,
    clock: () => at, installSignalHandlers: false, ...extra });
  t.after(() => app.close());
  const request = async (path, options) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, options);
    return { status: response.status, body: await response.json() };
  };
  return { app, request };
}

test('replica startup seeks the latest recorded decision by commit order without sorting history', async t => {
  const directory=fixture(t),publication=snapshot(directory,'decision-index');
  const writer=new Store(publication.dbPath);
  writer.transaction(()=>{
    for(let i=0;i<2048;i++) writer.event('decision',{input:'mqtt'},at+i);
    writer.event('decision',{input:'providers'},at-1000);
  });
  writer.close();
  let lookup;
  const prepare=DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql) {
    if(/^SELECT payload,at FROM active_events/.test(sql)) lookup=sql;
    return prepare.call(this,sql);
  });
  const {request}=await viewer(t,directory,async()=>publication);
  assert.equal((await request('/api/status')).body.input,'providers','later stored decisions retain ID ordering even with an older timestamp');
  assert(lookup,'inspect the actual startup lookup');
  const reader=new Store(publication.dbPath,{readOnly:true});
  try {
    const plan=reader.db.prepare(`EXPLAIN QUERY PLAN ${lookup}`).all().map(row=>row.detail);
    assert(plan.some(detail=>/SEARCH (?:r|events) USING INDEX events_type_id/.test(detail)),plan.join('; '));
    assert(!plan.some(detail=>/TEMP B-TREE|SCAN (?:r|events)\b/.test(detail)),plan.join('; '));
  } finally {reader.close();}
});

function recordLearningModels(publication, { recordedAt = publication.sourceAt, matching = true, homeModelVersion = 4 } = {}) {
  const store = new Store(publication.dbPath), seed = restoreAdaptiveCheckpoint(null);
  seed.model.parameters.lossPerHour = .031;
  seed.baselineC = 21.4;
  seed.comfortReference = currentComfortReference(21.4, recordedAt);
  seed.samples = [{ timestamp: recordedAt - 60_000, indoorC: 21, outdoorC: 5, phase: 'normal',
    regime: 'occupied', quality: [], privateFixture: 'invented-sample-marker-not-for-browser' }];
  appendLearningRecord(store, 'mqtt', 'context', { timestamp: recordedAt }, { seed });
  const checkpoint = applyLearningRecord(null, store.learningJournal({ input: 'mqtt' })[0]);
  checkpoint.privateFixture = 'invented-checkpoint-marker-not-for-browser';
  checkpoint.model.version = homeModelVersion;
  if (!matching) checkpoint.algorithmVersion = 'invented-unsupported-home-algorithm';
  store.setState('adaptive:mqtt', checkpoint);
  store.setState('garage:configuration:mqtt', garageSettings({ enabled: true }));
  store.setState('garage:mode:mqtt', { version: 1, adapterKey: 'a'.repeat(64), targetIdentity: 'b'.repeat(64),
    mode: 'away', normalTargetC: 10, awayTargetC: 5, changedAt: recordedAt, warmingWarning: null });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
}

test('replica exposes saved Home learning and manual Garage intent without live readiness, commands or writes', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'saved-models');
  recordLearningModels(publication);
  let now = at;
  const { app, request } = await viewer(t, directory, async () => publication, { clock: () => now });
  const status = (await request('/api/status')).body;
  assert.equal(status.learning.adaptive.model.parameters.lossPerHour, .031);
  assert.equal(status.learning.adaptive.model.version, 4);
  assert(Number.isFinite(status.learning.adaptive.model.parameters.hydronicCPerKwh));
  assert.equal(status.learning.adaptive.model.performance.version, 'dhp-h10-b0-v1');
  assert.equal(status.learning.adaptive.baselineC, 21.4);
  assert.equal(status.learning.adaptive.comfortReference.confidence, 'observed-heating-baseline');
  assert.equal(status.learning.adaptive.algorithmVersion, LEARNING_ALGORITHM);
  assert.equal(status.learning.adaptive.health.usableSamples, 1);
  for (const key of ['metrics', 'readiness', 'outcomes', 'episode']) assert.equal(status.learning[key], null);
  assert.equal(Object.hasOwn(status.learning.adaptive, 'samples'), false);
  assert.equal(Object.hasOwn(status.learning.adaptive, 'episodeArchive'), false);
  assert.doesNotMatch(JSON.stringify(status.learning), /invented-.*marker/);
  assert.equal(status.learning.reconstruction, 'snapshot');
  assert.equal(status.learning.readOnly, true);
  assert.equal(status.learning.snapshotAt, at);
  assert.equal(status.learning.recordedAt, at);
  assert.equal(status.readOnly, true);
  assert.equal(status.garage.mode, 'away');
  assert.equal(status.garage.requestedTargetC, 5);
  assert.equal(status.garage.targetConfirmed, false);
  assert.equal(status.garage.adapter.liveControlSupported, false);
  assert.equal(status.garage.heatingControls.available, false);
  assert.equal(status.garage.protection.available, false);
  assert.equal(status.garage.protection.active, null);
  assert.equal(status.garage.learning, undefined);
  assert.equal(status.garage.plan, undefined);
  assert.equal(mitsubishiControl(status, 'power').available, false);
  for (const path of ['/api/garage/native', '/api/garage/heating', '/api/garage/protection'])
    assert.equal((await request(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'normal' }) })).status, 405, `${path} remains read-only`);
  assert.equal(app.engine, undefined);
  assert.equal((await request('/api/override', { method: 'POST' })).status, 405);
  now += 7 * 86_400_000;
  assert.deepEqual((await request('/api/status')).body.learning, status.learning, 'Advancing the viewer clock never advances the saved learner');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 1, 'The recorded primary decision is the only event');
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('replica infers the primary input from the Home journal and ignores unsupported scopes', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'garage-journal-input');
  recordLearningModels(publication);
  const store = new Store(publication.dbPath);
  store.db.exec("DELETE FROM events WHERE type='decision'");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM state WHERE key LIKE 'contract:%'").get().n, 0);
  assert.equal(store.db.prepare('SELECT input FROM learning_journal ORDER BY id DESC LIMIT 1').get().input, 'mqtt');
  store.appendLearningJournal('garage:unsupported-scope', { kind: 'context', at,
    algorithmVersion: LEARNING_ALGORITHM, payload: { value: {} } });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  const { request } = await viewer(t, directory, async () => publication);
  const status = (await request('/api/status')).body;
  assert.equal(status.input, 'mqtt', 'Unsupported journal scopes cannot conceal the latest known Home input');
  assert.equal(status.lastDecision, null);
  assert.equal(status.learning.adaptive.model.parameters.lossPerHour, .031);
  assert.equal(status.garage.mode, 'away');
  assert.equal(status.readOnly, true);
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('replica does not substitute priors for missing, unsupported or post-publication model checkpoints', async t => {
  const directory = fixture(t);
  let publication = snapshot(directory, 'no-models');
  const { request } = await viewer(t, directory, async () => publication);
  const missing = (await request('/api/status')).body;
  assert.equal(missing.learning.status, 'unavailable');
  assert.equal(missing.learning.adaptive, null);
  assert.equal(missing.garage.mode, null);
  for (const [generation, options] of [
    ['unsupported-models', { matching: false }], ['future-models', { recordedAt: at + 60_000 }],
    ['archived-home-shape', { homeModelVersion: 3 }],
  ]) {
    publication = snapshot(directory, generation);
    recordLearningModels(publication, options);
    const status = (await request('/api/status')).body;
    assert.equal(status.learning.status, 'unavailable');
    assert.equal(status.learning.adaptive, null);
    assert.equal(status.learning.recordedAt, null);
    assert.equal(status.garage.mode, options.recordedAt > at ? null : 'away',
      'Home compatibility does not hide valid Garage intent; post-publication intent is excluded');
    assert.equal(digest(publication.dbPath), publication.digest);
  }
});

test('replica refuses server-side database saves without changing the verified snapshot', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'export-source');
  const exportDirectory = join(directory, 'local-copies');
  const { request } = await viewer(t, directory, async () => publication, {
    config: { ...configuration(directory), recording: { exportDirectory } },
  });
  const result = await request('/api/database-export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(result.status, 405);
  assert.equal(existsSync(exportDirectory), false);
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('malformed saved Garage sections do not hide independent protected dashboard evidence', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'invalid-garage-sections');
  const source = new Store(publication.dbPath);
  const sections = ['configuration', 'adapter', 'mode', 'sender'];
  for (const key of [...sections.map(section => `garage:${section}:mqtt`), 'adaptive:mqtt']) {
    source.setState(key, null);
    source.db.prepare('UPDATE state SET value=? WHERE key=?').run('{invalid', key);
  }
  source.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  const { request } = await viewer(t, directory, async () => publication);
  const response = await request('/api/status'), status = response.body;
  assert.equal(response.status, 200);
  assert.equal(status.observations.upstairs.value, 21);
  assert.equal(status.readOnly, true);
  assert.equal(status.garage.adapter.control, null);
  assert.equal(status.garage.requestedTargetC, null);
  assert.equal(status.garage.protection.active, null);
  assert.deepEqual(status.garage.settings, {});
  for (const section of sections) assert(status.garage.errors.some(error => error.section === section));
  assert.match(status.learning.error, /unavailable/);
  assert.equal((await request('/api/recording-overview')).status, 200);
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('read-only Store never migrates, deletes, creates a missing database or permits writes', t => {
  const directory = fixture(t), publication = snapshot(directory, 'readonly');
  const store = new Store(publication.dbPath, { readOnly: true });
  assert.equal(store.readOnly, true);
  assert.equal(store.getState('settings:mqtt').comfort.maxDropC, 0.5);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM energy_audits').get().count, 1);
  assert.throws(() => store.setState('settings:mqtt', { comfort: { maxDropC: 1 } }), /readonly/i);
  assert.throws(() => store.db.exec('DELETE FROM events'), /readonly/i);
  store.close();
  assert.equal(digest(publication.dbPath), publication.digest);
  assert.equal(existsSync(`${publication.dbPath}-wal`), false);
  assert.equal(existsSync(`${publication.dbPath}-shm`), false);

  const raw = new DatabaseSync(publication.dbPath);
  raw.exec(`PRAGMA user_version=${SCHEMA_VERSION - 1}`); raw.close();
  const oldDigest = digest(publication.dbPath);
  assert.throws(() => new Store(publication.dbPath, { readOnly: true }), /Unsupported database schema/);
  assert.equal(digest(publication.dbPath), oldDigest);
  const missing = join(directory, 'missing', 'database.sqlite');
  assert.throws(() => new Store(missing, { readOnly: true }));
  assert.equal(existsSync(join(directory, 'missing')), false);
});

test('main replica startup bypasses legacy migration and providers and removes its signal handlers', async t => {
  const directory = fixture(t), legacy = snapshot(directory, 'st-mq');
  const databaseDir = join(directory, 'database');
  const config = loadConfig({ HOME: directory, XDG_CONFIG_HOME: join(directory, 'configuration'),
    STMQ_TOPOLOGY: 'mirror', STMQ_MIRROR_ROLE: 'slave', STMQ_INPUT: 'mqtt', STMQ_DATA_DIR: directory,
    STMQ_DATABASE_DIR: databaseDir, STMQ_PORT: '0' }, directory);
  const signalCounts = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listenerCount(signal)]));
  const app = await start({ config, clock: () => at,
    mqttOptions: { connect() { assert.fail('A replica must not connect to MQTT'); } },
    providerOptions: { temperatureProvider() { assert.fail('A replica must not query providers'); } } });
  t.after(() => app.close());
  assert.equal(app.store, null);
  assert.equal(app.engine, undefined);
  assert.equal(existsSync(databaseDir), false, 'No primary database or migration directory is created');
  assert.equal(digest(legacy.dbPath), legacy.digest);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`);
  assert.equal((await response.json()).sync.state, 'waiting');
  await app.close();
  for (const signal of ['SIGINT', 'SIGTERM']) assert.equal(process.listenerCount(signal), signalCounts[signal]);
});

test('configured freshness checks source snapshot age even immediately after verification', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'delayed', 21, at - 40_000);
  publication.verifiedAt = at;
  const config = configuration(directory);
  config.mirror.staleAfterMs = 30_000;
  const { request } = await viewer(t, directory, async () => publication, { config });
  const result = await request('/api/status');
  assert.equal(result.body.sync.state, 'stale');
  assert.equal(result.body.sync.staleAfterMs, 30_000);
  assert.equal(result.body.sync.lastSuccessAt, at);
});

test('viewer starts before first snapshot and denies every mutation without opening control runtime', async t => {
  const directory = fixture(t);
  const { app, request } = await viewer(t, directory, async () => null);
  const result = await request('/api/status');
  assert.equal(result.status, 200);
  assert.equal(result.body.instance.role, 'slave');
  assert.equal(result.body.sync.state, 'waiting');
  assert.equal(result.body.readOnly, true);
  assert.equal(app.store, null);
  assert.equal((await request(chartPath)).status, 503);
  for (const path of ['/api/temporary', '/api/override', '/api/fireplace', '/api/fireplace/remove', '/api/sensor-changes',
    '/api/settings/reload', '/api/heating-test', '/api/test/h66', '/api/charger-identification', '/api/unrecognized']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await request(path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.match(response.body.error, /read-only/);
    }
  }
});

test('replica averages retain source freshness and the primary sensor settling boundary', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'sensor-change');
  const store = new Store(publication.dbPath);
  const control = { indoorSensorWeights: { indoor_temperature: 0.5, bedroom_temperature: 0.5 } };
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-bedroom', signal: 'bedroom_temperature',
    value: 19, unit: 'degC', sourceTime: at - 60_000, receivedAt: at - 60_000, quality: [] });
  addSensorChange(store, 'mqtt', { requestId: 'synthetic-move', signal: 'bedroom_temperature', reason: 'moved' }, at,
    { config: control });
  store.setState('adaptive:mqtt', { learningConfiguration: control, measurementEpochAt: at });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  let now = at;
  const { request } = await viewer(t, directory, async () => publication, { clock: () => now });
  const current = (await request('/api/status')).body;
  assert.equal(current.observations.bedroom.value, 19);
  assert.equal(current.observations.bedroom.settling, true);
  assert.equal(current.observations.indoor.value, null);
  assert.equal(current.observations.indoor.stale, true);
  assert.equal((await request('/api/sensor-changes')).body.available, false);
  now += 60 * 60_000;
  const stale = (await request('/api/status')).body;
  assert.equal(stale.observations.upstairs.stale, false, 'Unchanged rooms do not expire while another sensor settles');
  assert.equal(stale.observations.bedroom.stale, true);
  assert.equal(stale.observations.indoor.stale, true);
  assert.equal(stale.observations.indoor.value, null, 'Pre-change inputs cannot reappear after the settling timer');
  assert.equal(stale.observations.bedroom.observedAt, at - 60_000);
});

test('replica keeps fixed recorded room contributions through age and outages without renewing source times', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'held-rooms');
  const store = new Store(publication.dbPath);
  const control = { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1 } };
  for (const [signal, value] of [['downstairs_temperature', 20], ['bedroom_temperature', 19], ['garage_temperature', 12], ['outdoor_temperature', 4]])
    store.observation({ source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: `synthetic-${signal}`,
      signal, value, unit: 'degC', sourceTime: at - 60_000, receivedAt: at - 60_000, quality: [] });
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-bedroom_temperature', signal: 'bedroom_temperature',
    value: null, unit: 'degC', sourceTime: null, receivedAt: at, quality: ['mqtt-disconnected'], raw: { timeBasis: 'availability-transition' } });
  // This reading exists in the copied bytes but was not known at publication.
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-bedroom_temperature', signal: 'bedroom_temperature',
    value: 30, unit: 'degC', sourceTime: at + 60_000, receivedAt: at + 60_000, quality: [] });
  store.setState('adaptive:mqtt', { learningConfiguration: control });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  let now = at;
  const { request } = await viewer(t, directory, async () => publication, { clock: () => now });
  const current = (await request('/api/status')).body.observations;
  assert.equal(current.indoor.value, 20);
  assert.equal(current.indoor.stale, false);
  assert.deepEqual(current.indoor.attentionSensors.map(row => row.signal), ['bedroom_temperature']);
  assert.deepEqual(current.bedroom.attentionReasons, ['disconnected']);
  assert.equal(current.garage.value, 12);
  assert.equal(current.garage.needsAttention, undefined);
  assert.equal(current.outdoor.stale, false);
  now += 7 * 86_400_000;
  const held = (await request('/api/status')).body.observations;
  assert.equal(held.indoor.value, 20);
  assert.equal(held.indoor.stale, false);
  assert.equal(held.bedroom.value, 19, 'Advancing the viewer clock cannot reveal a post-publication measurement');
  assert.deepEqual(held.bedroom.attentionReasons, ['disconnected', 'old-reading']);
  for (const key of ['upstairs', 'downstairs', 'bedroom', 'garage']) {
    assert.equal(held[key].observedAt, at - 60_000);
    assert.equal(held[key].stale, false);
    assert.equal(held[key].needsAttention, true);
  }
  assert.equal(held.outdoor.stale, true, 'Outdoor retains its existing expiry');
  assert.equal(digest(publication.dbPath), publication.digest, 'Serving status does not write to the snapshot');
});

test('replica cannot invent a first room contribution from post-publication or retained-only data', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'unknown-room');
  const store = new Store(publication.dbPath);
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-bedroom', signal: 'bedroom_temperature',
    value: 19, unit: 'degC', sourceTime: at + 60_000, receivedAt: at + 60_000, quality: [] });
  store.observation({ source: 'mqtt-temperature', device: 'synthetic-garage', signal: 'garage_temperature',
    value: 12, unit: 'degC', sourceTime: at - 60_000, receivedAt: at, quality: ['retained'], raw: { retained: true } });
  store.setState('adaptive:mqtt', { learningConfiguration: { indoorSensorWeights: { indoor_temperature: 1, bedroom_temperature: 1 } } });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  const { request } = await viewer(t, directory, async () => publication, { clock: () => at + 3_600_000 });
  const observations = (await request('/api/status')).body.observations;
  assert.equal(observations.bedroom, null);
  assert.equal(observations.garage.value, null);
  assert.equal(observations.garage.stale, true);
  assert.deepEqual(observations.garage.availabilityReasons, ['retained']);
  assert.equal(observations.indoor.value, null);
  assert.equal(observations.indoor.stale, true);
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('replica expires periodic room coverage at the report deadline while preserving the saved value time', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'periodic-room');
  const store = new Store(publication.dbPath), recorder = new Recorder(store);
  for (const minute of [-45, -30, -15]) recorder.record({ source: 'mqtt-temperature', device: 'synthetic-periodic-bedroom',
    signal: 'bedroom_temperature', value: 20, unit: 'degC', sourceTime: at + minute * 60_000,
    receivedAt: at + minute * 60_000, quality: [], raw: { reportIntervalMs: 15 * 60_000, reportGraceMs: 2 * 60_000 } });
  store.setState('adaptive:mqtt', { learningConfiguration: { indoorSensorWeights: { bedroom_temperature: 1 } } });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  let now = at + 2 * 60_000 - 1;
  const { app } = await viewer(t, directory, async () => publication, { clock: () => now });
  let observations = app.status().observations;
  assert.equal(observations.bedroom.observedAt, at - 45 * 60_000);
  assert.equal(observations.bedroom.lastReportAt, at - 15 * 60_000);
  assert.equal(observations.bedroom.reportExpiresAt, now + 1);
  assert.equal(observations.bedroom.periodicReports, true);
  assert.equal(observations.indoor.value, 20);
  assert.equal(observations.indoor.stale, false);
  now++;
  observations = app.status().observations;
  assert.equal(observations.bedroom.value, 20);
  assert.equal(observations.bedroom.stale, true);
  assert.deepEqual(observations.bedroom.availabilityReasons, ['missing-report']);
  assert.equal(observations.indoor.value, null);
  assert.equal(observations.indoor.missingMembers[0].reportMaxAgeMs, 17 * 60_000);
  assert.equal(digest(publication.dbPath), publication.digest);
});

test('replica preserves a newly enabled reporting policy that still awaits its first report', async t => {
  const directory = fixture(t), publication = snapshot(directory, 'pending-report-policy');
  const store = new Store(publication.dbPath), recorder = new Recorder(store);
  const identity = { source: 'mqtt-temperature', device: 'synthetic-periodic-bedroom', signal: 'bedroom_temperature', unit: 'degC' };
  recorder.record({ ...identity, value: 20, sourceTime: at - 5 * 60_000, receivedAt: at - 5 * 60_000,
    quality: [], raw: { reportIntervalMs: 0, reportGraceMs: 0 } });
  recorder.record({ ...identity, value: null, sourceTime: null, receivedAt: at - 60_000,
    quality: ['missing', 'report-policy-changed'], raw: { timeBasis: 'availability-transition',
      reportIntervalMs: 15 * 60_000, reportGraceMs: 2 * 60_000 } });
  store.setState('adaptive:mqtt', { learningConfiguration: { indoorSensorWeights: { bedroom_temperature: 1 } } });
  store.close();
  const raw = new DatabaseSync(publication.dbPath); raw.exec('PRAGMA journal_mode=DELETE'); raw.close();
  publication.digest = digest(publication.dbPath); publication.bytes = readFileSync(publication.dbPath).length;
  const { app } = await viewer(t, directory, async () => publication);
  const observations = app.status().observations;
  assert.equal(observations.bedroom.stale, true);
  assert.equal(observations.bedroom.periodicReports, true);
  assert.equal(observations.bedroom.lastReportAt, null);
  assert.deepEqual(observations.bedroom.availabilityReasons, ['report-policy-changed']);
  assert.equal(observations.indoor.value, null);
});

test('verified snapshots remain unchanged and viewer replaces charts and history after outage catch-up', async t => {
  const directory = fixture(t), first = snapshot(directory, 'first', 21);
  let publication = first, now = at;
  const { app, request } = await viewer(t, directory, async () => publication, { clock: () => now });
  const initial = await request('/api/status');
  assert.equal(initial.body.input, 'mqtt');
  assert.equal(initial.body.observations.indoor.value, 21);
  assert.equal(initial.body.lastDecision.phase, 'reduction');
  assert.equal(initial.body.readOnly, true);
  assert.equal(initial.body.sync.digest, first.digest);
  assert.equal((await request(chartPath)).body.series.indoor_temperature[0].y, 21);
  assert.equal((await request('/api/recording-overview')).status, 200);
  assert.equal((await request('/api/energy-audits')).status, 200);
  assert.equal((await request('/api/events')).body.length, 1);
  assert.equal((await request('/api/fireplace')).status, 200);
  assert.equal((await request('/api/heating-test', { method: 'POST' })).status, 405);

  now += 7 * 86_400_000;
  const stale = await request('/api/status');
  assert.equal(stale.body.sync.state, 'stale');
  assert.equal(stale.body.now, now);
  const oldChart = await request(chartPath);
  assert.equal(oldChart.body.now, first.sourceAt, 'snapshot calculations never advance into an unobserved outage');
  assert.equal(oldChart.body.series.indoor_temperature[0].y, 21);
  assert.equal(digest(first.dbPath), first.digest);

  const second = snapshot(directory, 'second', 24, at + 120_000);
  publication = second;
  now = second.verifiedAt;
  assert.equal((await request('/api/status')).body.sync.generation, 'second');
  assert.equal(app.store.path, second.dbPath);
  assert.equal((await request(chartPath)).body.series.indoor_temperature[0].y, 24);
  assert.equal((await request('/api/history?signal=indoor_temperature')).body[0].value, 24);
  assert.equal(digest(first.dbPath), first.digest);
  assert.equal(digest(second.dbPath), second.digest);
});

test('bad replacement keeps serving the last verified snapshot and recovers on next publication', async t => {
  const directory = fixture(t), first = snapshot(directory, 'first');
  let publication = first;
  const { request } = await viewer(t, directory, async () => publication);
  publication = { ...first, generation: 'missing', dbPath: join(directory, 'absent.sqlite') };
  const error = await request('/api/status');
  assert.equal(error.body.sync.state, 'error');
  assert.equal(error.body.sync.generation, 'first');
  assert.equal(error.body.observations.indoor.value, 21);
  assert.equal((await request(chartPath)).body.series.indoor_temperature[0].y, 21);
  assert(!error.body.sync.error.includes(directory));
  publication = snapshot(directory, 'recovered', 23);
  assert.equal((await request('/api/status')).body.sync.state, 'ready');
  assert.equal((await request(chartPath)).body.series.indoor_temperature[0].y, 23);
});

test('in-flight chart requests lease their generation across publication and old-file removal', async t => {
  const directory = fixture(t), first = snapshot(directory, 'first', 21);
  let publication = first;
  const entered = deferred(), proceed = deferred();
  const makeChartService = ({ store }) => {
    const service = createChartService({ store });
    return { pin: options => service.pin(options), overview: options => service.overview(options), close: () => service.close(),
      async query(args, options) {
        if (store.path === first.dbPath) { entered.resolve(); await proceed.promise; }
        return service.query(args, options);
      } };
  };
  const { request } = await viewer(t, directory, async () => publication, { makeChartService });
  const oldRequest = request(chartPath);
  await entered.promise;
  publication = snapshot(directory, 'second', 25);
  assert.equal((await request('/api/status')).body.sync.generation, 'second');
  unlinkSync(first.dbPath);
  proceed.resolve();
  const old = await oldRequest;
  assert.equal(old.status, 200);
  assert.equal(old.body.series.indoor_temperature[0].y, 21);
  assert.equal((await request(chartPath)).body.series.indoor_temperature[0].y, 25);
});
