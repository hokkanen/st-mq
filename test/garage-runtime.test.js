import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { appendGarageEntry, applyGarageEntry, replayGarageJournal, garageCorrectionContext, garageInput,
  garageCheckpointDigest, garageJournalHead } from '../src/garage/learning.js';
import { garageSettings, GARAGE_PREFERENCE_VERSION } from '../src/garage/settings.js';
import { createGarageModel } from '../src/garage/model.js';
import { startGarageAssessment, updateGarageAssessment, completeGarageAssessment } from '../src/garage/episodes.js';
import { decodeMqttTemperature } from '../src/acquisition/mqtt-temperature.js';
import { Engine } from '../src/app/engine.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';

const START = Date.parse('2026-01-01T00:00:00Z'), MINUTE = 60_000;
function setup(t, { disk = false, settings = {}, owner = true } = {}) {
  const directory = disk ? mkdtempSync(join(tmpdir(), 'stmq-garage-runtime-')) : null;
  const store = new Store(directory ? join(directory, 'test.sqlite') : ':memory:');
  let now = START, authority = owner;
  const config = { input: 'mqtt', garage: garageSettings(settings) };
  const engine = { latest: {}, lastKnownTemperatures: {}, automationEnabled: () => true };
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now, canControl: () => authority });
  const calls = [], status = { automaticControl: false, phase: 'monitoring', native: {}, health: {},
    limits: { maxLeaseMs: 180_000, restorationDelayMs: 120_000 } };
  runtime.setAdapter({ status: () => status,
    plannerTick: async args => { calls.push(['planner', args]); return { status: 'blocked' }; },
    safetyTick: async args => { calls.push(['safety', args]); }, release: async args => { calls.push(['release', args]); } });
  const report = (signal, value, at = now, extra = {}) => engine.latest[signal] = {
    source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: signal,
    signal, value, unit: 'degC', sourceTime: at, receivedAt: now, quality: [], ...extra };
  const temperatures = (rear = 7, front = 6) => { report('garage_temperature', rear); report('garage_temperature_2', front); report('outdoor_temperature', 0); };
  t.after(async () => { await runtime.close({ restore: false }); store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  return { runtime, store, engine, config, status, calls, report, temperatures, at: value => { now = value; }, owner: value => { authority = value; } };
}

test('fresh equal front/rear reports create journal evidence; status and repeated polling do not', async t => {
  const f = setup(t); f.temperatures(); f.runtime.tick(); await f.runtime.dispatch;
  const head = garageJournalHead(f.store, 'mqtt'), before = JSON.stringify(f.runtime.checkpoint);
  for (let i = 0; i < 30; i++) f.runtime.status();
  assert.equal(garageJournalHead(f.store, 'mqtt'), head); assert.equal(JSON.stringify(f.runtime.checkpoint), before);
  f.at(START + MINUTE); f.runtime.tick(); await f.runtime.dispatch;
  assert.equal(garageJournalHead(f.store, 'mqtt'), head);
  f.temperatures(); f.runtime.tick(); await f.runtime.dispatch;
  assert.ok(garageJournalHead(f.store, 'mqtt') > head);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
  assert.equal(f.runtime.checkpoint.digest, garageCheckpointDigest(f.runtime.checkpoint));
});

test('a retained front and fresh native indoor reading cannot replace front protection', t => {
  const f = setup(t, { settings: { enabled: true, protection: { approved: true } } });
  f.runtime.exposure = knownGarageReserve(f.runtime.settings, { at: START });
  f.temperatures(); f.runtime.safetyTick(); assert.equal(f.runtime.protection.safeToPause, true);
  f.report('garage_temperature_2', 10, START, { raw: { retained: true } });
  f.status.telemetry = { indoorTemperature: { value: 12, sourceTime: START, usable: true } };
  f.runtime.safetyTick();
  assert.equal(f.runtime.protection.safeToPause, false);
  assert.equal(f.calls.at(-1)[1].valid, false);
  assert.equal(f.runtime.read().frontC, null);
});

test('cached temperatures stay last-known and forecast quality cannot hide invalid weather', t => {
  const f = setup(t); f.temperatures();
  f.engine.lastKnownTemperatures.garage_temperature_2 = f.engine.latest.garage_temperature_2;
  delete f.engine.latest.garage_temperature_2;
  assert.equal(f.runtime.status().observations.front.value, 6);
  assert.equal(f.runtime.status().observations.front.stale, true);
  assert.equal(f.runtime.read().frontC, null);
  f.report('outdoor_temperature', 2, START, { source: 'openmeteo', quality: ['estimated'] });
  assert.equal(f.runtime.read().outdoorC, 2);
  f.report('outdoor_temperature', 3, START, { source: 'openmeteo', quality: ['estimated', 'invalid_value'] });
  assert.equal(f.runtime.read().outdoorC, null);
  f.report('outdoor_temperature', 3, START, { source: 'openmeteo', quality: ['estimated'], raw: { retained: true } });
  assert.equal(f.runtime.read().outdoorC, null);
});

test('Garage EV2 confounders use physical charger evidence independently of vehicle association', t => {
  const f = setup(t);
  f.config.connections = { teslamate: { enabled: true } };
  f.engine.teslamate = { identificationSnapshot: () => ({ connected: true, home: true, healthy: true,
    healthyAt: START, currentA: 16, currentAt: START }) };
  assert.equal(f.runtime.read().evEvidenceRequired.ev2, false);
  assert.equal(f.runtime.read().ev2Active, null, 'a vehicle feed does not identify physical charger activity');
  let healthy = true, charging = false;
  f.engine.charging = { configuration: { chargers: { charger2: { enabled: true } } }, chargers: {
    charger2: { adapter: { snapshot: () => ({}),
      normalize: () => ({ providerConnected: healthy, charging: { value: charging, available: healthy, receivedAt: START } }),
      liveCurrents: () => ({ healthy, currents: [0, 7, 0], times: [START, START, START] }) } } } };
  let row = f.runtime.read();
  assert.equal(row.evEvidenceRequired.ev2, true);
  assert.equal(row.ev2Active, true);
  assert.equal(row.ev2Kw, null, 'activity must not invent interval energy');
  assert.equal(row.provenance.ev2.source, 'shelly-evse-current-activity');
  f.engine.charging.chargers.charger2.adapter.liveCurrents = () => ({ healthy: false });
  row = f.runtime.read();
  assert.equal(row.ev2Active, false, 'fresh physical idle state is useful without current telemetry');
  charging = true;
  assert.equal(f.runtime.read().ev2Active, true);
  healthy = false;
  assert.equal(f.runtime.read().ev2Active, null, 'unavailable charger evidence stays unknown');
  healthy = true; f.at(START + 3 * MINUTE);
  assert.equal(f.runtime.read().ev2Active, null, 'expired physical evidence cannot prove idle');
});

test('garage charger inputs use long durable energy tails without flushing or extending source freshness', t => {
  const f = setup(t), recorder = new Recorder(f.store);
  for (const [prefix, source, powers] of [['ev1', 'easee', [1, 2, 0]], ['ev2', 'shelly-evse', [4]]]) {
    for (let minute = 0; minute < 60; minute++) recorder.recordEnergy({ source, device: `synthetic-${prefix}`, prefix,
      start: START + minute * MINUTE, end: START + (minute + 1) * MINUTE,
      powers, energies: powers.map(power => power / 60) });
  }
  const count = f.store.db.prepare('SELECT count(*) n FROM observations').get().n;
  assert.equal(count, 4, 'only the first interval needs observations; unchanged power remains in the bounded tail');
  f.at(START + 60 * MINUTE);
  const row = f.runtime.read();
  assert(Math.abs(row.ev1Kw - 3) < 1e-10);
  assert(Math.abs(row.ev2Kw - 4) < 1e-10);
  assert.equal(row.provenance.ev1.pendingEnergy, true);
  assert.equal(row.provenance.ev2.pendingEnergy, true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM observations').get().n, count);
  f.at(START + 30 * MINUTE);
  assert.equal(f.runtime.read().ev1Kw, null, 'a later receipt cannot fill an earlier learning input');
  f.at(START + 66 * MINUTE);
  assert.equal(f.runtime.read().ev1Kw, null);
  assert.equal(f.runtime.read().ev2Kw, null, 'source expiry remains five minutes even when storage has no maximum interval');
});

test('thermal reserve survives restart and missing time consumes each location independently', async t => {
  const f = setup(t, { settings: { protection: { approved: true } } });
  f.runtime.exposure = knownGarageReserve(f.runtime.settings, { at: START, rearC: 5, frontC: 3 });
  f.temperatures(5, 0); f.runtime.safetyTick();
  f.at(START + MINUTE); f.temperatures(5, 0); f.runtime.safetyTick();
  const old = structuredClone(f.runtime.exposure);
  assert.ok(old.locations.front.estimatedC < 3);
  assert.equal(old.locations.rear.estimatedC, 5);
  await f.runtime.close({ restore: false }); f.at(START + 10 * MINUTE);
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine, config: f.config, clock: () => START + 10 * MINUTE });
  assert.deepEqual(restarted.exposure, old, 'restart alone must not erase the thermal state');
  restarted.safetyTick();
  assert.ok(restarted.exposure.locations.front.energyJPerM < old.locations.front.energyJPerM);
  assert.ok(restarted.exposure.locations.rear.uncertain);
  assert.equal(restarted.protection.safeToPause, false);
  await restarted.close({ restore: false });
});

test('database failure revokes OFF renewals and authority loss sends no release', async t => {
  const f = setup(t, { settings: { enabled: true, protection: { approved: true } } });
  f.temperatures(); f.runtime.lastPlannerAt = START;
  const original = f.store.setState;
  f.store.setState = () => { throw new Error('fixture storage failure'); };
  f.runtime.safetyTick(); assert.equal(f.calls.at(-1)[1].valid, false);
  f.store.setState = original;
  f.owner(false); await f.runtime.release();
  assert.equal(f.calls.some(([kind]) => kind === 'release'), false);
});

test('adapter state callbacks are deduplicated to prevent recursive restoration notifications', async t => {
  const f = setup(t);
  const snapshot = { restorePending: true };
  f.runtime.setAdapter({ status: () => ({}), safetyTick: async () => { f.calls.push('safety'); f.runtime.adapterChanged(snapshot); } });
  f.runtime.adapterChanged(snapshot);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

test('failed journal transaction leaves memory aligned and learning resumes after storage recovers', async t => {
  const f = setup(t); f.temperatures();
  const checkpoint = structuredClone(f.runtime.checkpoint), head = garageJournalHead(f.store, 'mqtt');
  const original = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key === f.runtime.keys.checkpoint) throw new Error('fixture checkpoint write failure');
    return original(key, value);
  };
  assert.throws(() => f.runtime.tick(), /fixture checkpoint write failure/);
  assert.deepEqual(f.runtime.checkpoint, checkpoint);
  assert.equal(garageJournalHead(f.store, 'mqtt'), head);
  f.store.setState = original;
  f.runtime.tick(); await f.runtime.dispatch;
  assert.ok(garageJournalHead(f.store, 'mqtt') > head);
  assert.deepEqual(f.runtime.checkpoint, replayGarageJournal(f.store, 'mqtt'));
});

test('corrupt checkpoint rebuilds off the control loop and matches the committed journal', async t => {
  const f = setup(t, { disk: true });
  for (let i = 0; i < 5; i++) { f.at(START + i * MINUTE); f.temperatures(); f.runtime.tick(); await f.runtime.dispatch; }
  const expected = replayGarageJournal(f.store, 'mqtt');
  await f.runtime.close({ restore: false });
  f.store.db.prepare('UPDATE state SET value=? WHERE key=?').run('{invalid', 'garage:checkpoint:mqtt');
  const restarted = new GarageRuntime({ store: f.store, engine: f.engine, config: f.config, clock: () => START + 6 * MINUTE });
  assert.equal(restarted.learningStatus, 'rebuilding');
  restarted.safetyTick(); assert.equal(restarted.protection.safeToPause, false);
  const deadline = Date.now() + 5000;
  while (restarted.learningStatus === 'rebuilding' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(restarted.learningStatus, 'current'); assert.deepEqual(restarted.checkpoint, expected);
  await restarted.close({ restore: false });
});

test('failed worker checkpoint publication keeps the prior model and revokes Garage control', async t => {
  const f = setup(t, { disk: true }); f.temperatures(); f.runtime.tick(); await f.runtime.dispatch;
  const prior = f.runtime.checkpoint;
  const original = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key === f.runtime.keys.checkpoint) throw new Error('fixture checkpoint write failure');
    return original(key, value);
  };
  f.runtime.startRebuild();
  const deadline = Date.now() + 5000;
  while (f.runtime.learningStatus === 'rebuilding' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.runtime.learningStatus, 'failed');
  assert.equal(f.runtime.checkpoint, prior);
  assert.equal(f.calls.at(-1)[1].valid, false);
  f.store.setState = original;
});

test('source corrections preserve raw journal and reproduce the selected reversal revision', () => {
  const store = new Store(':memory:');
  try {
    const settings = garageSettings(), observation = (at, value = 7) => ({ at, rearAt: at, frontAt: at, rearC: value,
      frontC: value - .3, outdoorC: 0, outdoorAt: at, available: false });
    appendGarageEntry(store, 'mqtt', 'sample', observation(START), settings, START, { key: 'first' });
    const change = addSensorChange(store, 'mqtt', { signal: 'garage_temperature_2', reason: 'replacement', requestId: 'fixture-change' }, START + MINUTE);
    appendGarageEntry(store, 'mqtt', 'context', { sensorChangeId: change.id }, settings, START + MINUTE, { key: 'change' });
    appendGarageEntry(store, 'mqtt', 'sample', observation(START + 2 * MINUTE), settings, START + 2 * MINUTE, { key: 'after' });
    const original = JSON.stringify(store.learningJournal({ input: garageInput('mqtt') }));
    const reset = replayGarageJournal(store, 'mqtt');
    assert.equal(reset.model.state.frontC, null);
    revertSensorChange(store, 'mqtt', { id: change.id, requestId: 'fixture-revert' }, START + 3 * MINUTE);
    const corrected = replayGarageJournal(store, 'mqtt');
    assert.equal(corrected.model.state.frontC, 6.7);
    assert.equal(JSON.stringify(store.learningJournal({ input: garageInput('mqtt') })), original);
    let rebuilt = null;
    for (const entry of store.learningJournal({ input: garageInput('mqtt') })) rebuilt = applyGarageEntry(rebuilt, entry, garageCorrectionContext(store, 'mqtt'));
    assert.deepEqual(rebuilt, corrected);
  } finally { store.close(); }
});

test('a failed group of source corrections retries every boundary without losing the committed cursor', async t => {
  const f = setup(t); f.temperatures(); f.runtime.tick(); await f.runtime.dispatch;
  addSensorChange(f.store, 'mqtt', { signal: 'garage_temperature', reason: 'replacement', requestId: 'fixture-rear' }, START + MINUTE);
  addSensorChange(f.store, 'mqtt', { signal: 'garage_temperature_2', reason: 'replacement', requestId: 'fixture-front' }, START + MINUTE);
  const checkpoint = f.runtime.checkpoint, context = f.runtime.context, head = garageJournalHead(f.store, 'mqtt');
  const original = f.store.setState.bind(f.store); let writes = 0;
  f.store.setState = (key, value) => {
    if (key === f.runtime.keys.checkpoint && ++writes === 2) throw new Error('fixture second correction failure');
    return original(key, value);
  };
  assert.throws(() => f.runtime.syncCorrections(), /second correction failure/);
  assert.equal(f.runtime.context, context); assert.equal(f.runtime.checkpoint, checkpoint);
  assert.equal(garageJournalHead(f.store, 'mqtt'), head);
  f.store.setState = original;
  f.runtime.syncCorrections();
  const changes = f.store.learningJournal({ input: garageInput('mqtt'), after: head });
  assert.equal(changes.length, 2);
  assert.deepEqual(f.runtime.checkpoint, replayGarageJournal(f.store, 'mqtt'));
});

test('completion and clearing the active recovery obligation commit together and remain retryable', async t => {
  const f = setup(t); f.temperatures(); f.runtime.tick(); await f.runtime.dispatch;
  f.runtime.startEpisode('fixture-pause', { preferenceVersion: GARAGE_PREFERENCE_VERSION, pauseUntil: START + 10 * MINUTE }, f.runtime.read(), START);
  const id = f.runtime.episode.id, original = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key === f.runtime.keys.episode && value === null) throw new Error('fixture clearing active episode failure');
    return original(key, value);
  };
  assert.throws(() => f.runtime.finishEpisode('completed', 'fixture-restored', { profitCents: -1 }), /clearing active episode/);
  assert.equal(f.runtime.episode.status, 'active');
  assert.equal(f.store.getState(f.runtime.keys.episode).status, 'active');
  assert.equal(f.store.cycles({ input: garageInput('mqtt') }).find(row => row.id === id).status, 'active');
  f.store.setState = original;
  f.runtime.finishEpisode('completed', 'fixture-restored', { profitCents: -1 });
  assert.equal(f.runtime.episode, null); assert.equal(f.store.getState(f.runtime.keys.episode), null);
  assert.equal(f.store.cycles({ input: garageInput('mqtt') }).find(row => row.id === id).assessment.profitCents, -1);
});

test('qualified electrical intervals persist once and never change property or EV accounting', t => {
  const f = setup(t), observation = { source: 'garage-adapter', device: 'fixture-pump', signal: 'garage_energy', unit: 'kWh',
    value: .01, sourceTime: START + MINUTE, receivedAt: START + MINUTE,
    quality: ['provisional-contract'], raw: { intervalStart: START, intervalEnd: START + MINUTE,
      coveredMs: MINUTE, energyBasis: 'power-trapezoid',
      sourceId: 'fixture-native-power', meterScope: 'garage-heat-pump-only', timingEligible: true } };
  assert.equal(f.runtime.ingestEnergy(observation).saved, true);
  assert.equal(f.runtime.ingestEnergy(observation).saved, false);
  assert.equal(f.store.observations({ signal: 'garage_energy' }).length, 1);
  assert.equal(f.store.observations({ signal: 'property_energy_l1' }).length, 0);
  assert.equal(f.store.observations({ signal: 'ev2_energy' }).length, 0);
  f.at(START + MINUTE);
  assert.equal(f.runtime.recordedEnergy(START, START + MINUTE), .01);
  f.store.db.prepare("UPDATE observations SET raw=json_set(raw,'$.coveredMs',?) WHERE signal='garage_energy'").run(MINUTE / 2);
  assert.equal(f.runtime.recordedEnergy(START, START + MINUTE), null);
});

test('electrical interval retries deduplicate missing provenance while keeping distinct source identities', t => {
  const f = setup(t), observation = { source: 'garage-adapter', signal: 'garage_energy', unit: 'kWh',
    value: .01, sourceTime: START + MINUTE, receivedAt: START + MINUTE,
    raw: { intervalStart: START, intervalEnd: START + MINUTE } };
  assert.equal(f.runtime.ingestEnergy(observation).saved, true);
  assert.equal(f.runtime.ingestEnergy(observation).saved, false);
  assert.equal(f.runtime.ingestEnergy({ ...observation, raw: { ...observation.raw, sourceId: null } }).saved, false);
  const identified = { ...observation, raw: { ...observation.raw, sourceId: 'fixture-native-power' } };
  assert.equal(f.runtime.ingestEnergy(identified).saved, true);
  assert.equal(f.runtime.ingestEnergy(identified).saved, false);
  assert.equal(f.runtime.ingestEnergy({ ...identified, source: 'fixture-independent-meter' }).saved, true);
  assert.equal(f.store.observations({ signal: 'garage_energy' }).length, 3);
});

test('front sensor accepts negative Celsius and remains distinct from Home average and rear history', async t => {
  const store = new Store(':memory:');
  const config = { input: 'mqtt', automationEnabled: () => false, connections: {} };
  const engine = new Engine({ store, config, clock: () => START });
  t.after(async () => { await engine.garage.close({ restore: false }); store.close(); });
  for (const [signal, value] of [['indoor_temperature', 21], ['garage_temperature', 6], ['garage_temperature_2', -1]])
    engine.ingest(decodeMqttTemperature({ signal, payload: JSON.stringify(value), receivedAt: START }));
  const readings = engine.temperatureObservations({}, START);
  assert.equal(readings.indoor.value, 21); assert.equal(readings.garage.value, 6); assert.equal(readings.garageFront.value, -1);
  assert.equal(store.latestObservation('garage_temperature_2').value, -1);
});

test('frozen episode accounting preserves negative savings, rejects gaps and cannot complete with front debt', () => {
  const model = createGarageModel({ seedAt: START, roomTargetC: 10 });
  model.state = { rearC: 8, frontC: 7.5, coreC: 8, differenceC: -.5 };
  const first = { at: START, rearC: 8, frontC: 7.5, outdoorC: 0, available: true, ev1Kw: 0, ev2Kw: 0 };
  let account = startGarageAssessment(model, first);
  account = updateGarageAssessment(account, model, { ...first, at: START + MINUTE }, { recordedKwh: 1, priceCtPerKwh: 20 });
  account.actualState = structuredClone(account.referenceState);
  const assessment = completeGarageAssessment(account);
  assert.ok(assessment.profitCents < 0); assert.equal(assessment.includesGarageOnly, true);
  account.actualState.frontC -= 1; assert.equal(completeGarageAssessment(account), null);
  const gap = updateGarageAssessment(account, model, { ...first, at: START + 60 * MINUTE }, { priceCtPerKwh: 20 });
  assert.equal(gap.qualified, false); assert.equal(completeGarageAssessment(gap), null);
});
