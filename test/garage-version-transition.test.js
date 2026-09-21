import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { GARAGE_ALGORITHM_VERSION, createGarageModel } from '../src/garage/model.js';
import { GARAGE_POLICY_VERSION, garageSettings } from '../src/garage/settings.js';
import { createGarageExposure, updateGarageExposure, assessGarageProtection, reserveProperties, validGarageExposure } from '../src/garage/protection.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
import { startGarageAssessment } from '../src/garage/episodes.js';
import { garageDigest, garageInput, replayGarageJournal } from '../src/garage/learning.js';
import { Engine } from '../src/app/engine.js';

const START = Date.parse('2026-01-01T00:00:00Z'), MINUTE = 60_000;
const LEGACY = 'committed-garage-v1-coupled';

function setup(t, { mismatchedSnapshot = false, mismatchedAccounting = false, existingDebt = true } = {}) {
  let now = START;
  const store = new Store(':memory:');
  const settings = garageSettings({ enabled: true, minOnMs: 30 * MINUTE, protection: { approved: true } });
  const oldSettings = { ...settings, protection: { ...settings.protection, version: 'garage-exposure-v1' } };
  const model = createGarageModel({ seedAt: START - 120 * MINUTE });
  model.algorithm = LEGACY;
  model.state = { rearC: 10, frontC: 9, coreC: 10, differenceC: -1 };
  const first = { at: START - 120 * MINUTE, rearC: 10, frontC: 9, outdoorC: 0, available: true };
  const oldId = store.appendLearningJournal(garageInput('mqtt'), { kind: 'context', at: first.at,
    key: 'archived-test-seed', algorithmVersion: LEGACY, configVersion: garageDigest(oldSettings),
    payload: { settings: oldSettings, value: {}, seed: model } });
  const archivedRows = structuredClone(store.learningJournal({ input: garageInput('mqtt'), algorithmVersion: LEGACY }));
  store.setState('garage:configuration:mqtt', oldSettings);
  store.setState('garage:checkpoint:mqtt', { algorithmVersion: LEGACY, model, cursor: oldId });
  const exposure = knownGarageReserve(settings, { at: START, rearC: 8, frontC: 8 });
  if (existingDebt) {
    exposure.version = 'garage-exposure-v1';
    exposure.locations.front.degreeMinutes = 170;
    exposure.locations.rear.degreeMinutes = 17;
  }
  store.setState('garage:exposure:mqtt', exposure);
  const accounting = startGarageAssessment(model, first);
  accounting.algorithmVersion = LEGACY;
  accounting.actualState = { rearC: 6, frontC: 4, coreC: 7, differenceC: -2 };
  accounting.actualCostCents = 12; accounting.referenceCostCents = 10; accounting.steps = 5;
  const episode = { id: 'archived-accounting', pauseId: 'archived-pause', status: 'active', phase: 'pause',
    startedAt: first.at, pauseStartedAt: first.at, pauseUntil: START + 15 * MINUTE,
    algorithmVersion: mismatchedSnapshot || mismatchedAccounting ? GARAGE_ALGORITHM_VERSION : LEGACY,
    frozenModel: mismatchedAccounting ? { ...model, algorithm: GARAGE_ALGORITHM_VERSION } : model,
    settings: oldSettings, initialObservation: first,
    initialExposure: createGarageExposure(settings), accounting,
    plan: { learningTrial: false, evidence: { economicHours: 4 } }, assessment: null };
  store.setState('garage:episode:mqtt', episode);
  const engine = { latest: {}, lastKnownTemperatures: {}, settings: { mode: 'active' } };
  const config = { input: 'mqtt', garage: settings };
  const runtime = new GarageRuntime({ store, engine, config, clock: () => now });
  const calls = [], native = { automaticControl: true, phase: 'recovery', restorePending: false,
    baselineVerified: true, native: { power: 'on', powerAt: now }, health: { pumpCommunicating: true } };
  runtime.setAdapter({ status: () => native,
    plannerTick: async args => { calls.push(args); return { status: 'blocked' }; },
    safetyTick: async () => {}, release: async () => {} });
  function temperatures(rearC = 10, frontC = 9) {
    native.native.powerAt = now;
    for (const [signal, value] of [['garage_temperature', rearC], ['garage_temperature_2', frontC], ['outdoor_temperature', 0]])
      engine.latest[signal] = { signal, value, unit: 'degC', source: 'test-temperature', device: signal,
        sourceTime: now, receivedAt: now, quality: [] };
  }
  async function tick() { runtime.tick({ now }); await runtime.dispatch; }
  t.after(async () => { await runtime.close({ restore: false }); store.close(); });
  return { store, runtime, archivedRows, episode, native, calls, temperatures, tick,
    at(value) { now = value; }, now: () => now };
}

test('new Garage epoch preserves archived journal and accounting while retiring unconvertible exposure indices', t => {
  const f = setup(t);
  assert.deepEqual(f.store.learningJournal({ input: garageInput('mqtt'), algorithmVersion: LEGACY }), f.archivedRows);
  const entries = f.store.learningJournal({ input: garageInput('mqtt'), algorithmVersion: GARAGE_ALGORITHM_VERSION });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.value.algorithmChanged, true);
  assert.equal(entries[0].payload.value.archivedAlgorithm, LEGACY);
  assert.equal(entries[0].payload.seed.algorithm, GARAGE_ALGORITHM_VERSION);
  assert.equal(entries[0].payload.settings.protection.version, GARAGE_POLICY_VERSION);
  assert.deepEqual(replayGarageJournal(f.store, 'mqtt'), f.runtime.checkpoint);
  assert.equal(f.runtime.exposure.previousVersion, 'garage-exposure-v1');
  assert.ok(f.runtime.exposure.locations.front.energyJPerM < 0);
  assert.ok(f.runtime.exposure.locations.rear.energyJPerM < 0);
  assert.equal(f.runtime.exposure.locations.front.uncertain, true);
  assert.deepEqual(f.runtime.episode.accounting, f.episode.accounting);
  assert.deepEqual(f.runtime.episode.frozenModel, f.episode.frozenModel);
  assert.equal(f.runtime.episode.phase, 'recovery'); assert.equal(f.runtime.episode.restarted, true);
});

test('archived frozen dynamics are not advanced and cannot renew their old pause', async t => {
  const f = setup(t), accounting = structuredClone(f.runtime.episode.accounting);
  f.temperatures(6, 4); await f.tick();
  assert.equal(f.runtime.plan.nextAction, 'available'); assert.equal(f.runtime.plan.reason, 'archived-model-recovery');
  assert.equal(f.calls.at(-1).valid, false);
  assert.deepEqual(f.runtime.episode.accounting, { ...accounting, qualified: false });
  assert.ok(f.runtime.exposure.locations.front.energyJPerM < 0);
  assert.equal(f.store.getState('garage:episode:mqtt').pauseId, 'archived-pause');
  assert.deepEqual(f.store.learningJournal({ input: garageInput('mqtt'), algorithmVersion: LEGACY }), f.archivedRows);
});

test('archived recovery needs both warm locations, clear exposure, native restoration and sustained dwell', async t => {
  const f = setup(t, { existingDebt: false });
  for (let minute = 0; minute <= 40; minute++) {
    f.at(START + minute * MINUTE); f.temperatures(10, 8); await f.tick();
  }
  assert.notEqual(f.runtime.episode, null, 'rear recovery does not substitute for front');
  f.native.restorePending = true;
  for (let minute = 41; minute <= 75; minute++) {
    f.at(START + minute * MINUTE); f.temperatures(); await f.tick();
  }
  assert.notEqual(f.runtime.episode, null, 'warm air does not prove native restoration');
  f.native.restorePending = false;
  for (let minute = 76; minute < 106; minute++) {
    f.at(START + minute * MINUTE); f.temperatures(); await f.tick();
  }
  assert.notEqual(f.runtime.episode, null, 'dwell has not yet elapsed');
  f.at(START + 106 * MINUTE); f.temperatures(); await f.tick();
  assert.equal(f.runtime.episode, null);
  const completed = f.store.cycles({ input: garageInput('mqtt') }).find(row => row.id === f.episode.id);
  assert.equal(completed.status, 'incomplete'); assert.equal(completed.reason, 'archived-model-warmth-restored');
  assert.equal(completed.accounting.algorithmVersion, LEGACY); assert.equal(completed.assessment, null);
  assert.equal(completed.accounting.actualCostCents, 12);
});

test('a current episode label cannot make an archived frozen snapshot eligible for planning', async t => {
  const f = setup(t, { mismatchedSnapshot: true, existingDebt: false });
  f.temperatures(6, 4); await f.tick();
  assert.equal(f.runtime.plan.reason, 'archived-model-recovery');
  assert.equal(f.runtime.plan.nextAction, 'available'); assert.equal(f.calls.at(-1).valid, false);
  assert.equal(f.runtime.episode.frozenModel.algorithm, LEGACY);
});

test('a current frozen model cannot reinterpret accounting saved by the old algorithm', async t => {
  const f = setup(t, { mismatchedAccounting: true, existingDebt: false });
  const accounting = structuredClone(f.runtime.episode.accounting);
  f.temperatures(6, 4); await f.tick();
  assert.equal(f.runtime.plan.reason, 'archived-model-recovery');
  assert.equal(f.calls.at(-1).valid, false);
  assert.deepEqual(f.runtime.episode.accounting, { ...accounting, qualified: false });
});

test('archived recovery can resolve changed-weather warmth after eight continuous verified hours without inventing savings', async t => {
  const f = setup(t, { existingDebt: false });
  for (let minute = 0; minute <= 240; minute++) {
    f.at(START + minute * MINUTE); f.temperatures(8, 7); await f.tick();
  }
  assert.notEqual(f.runtime.episode, null);
  f.native.baselineVerified = false;
  f.at(START + 241 * MINUTE); f.temperatures(8, 7); await f.tick();
  f.native.baselineVerified = true;
  for (let minute = 242; minute < 722; minute++) {
    f.at(START + minute * MINUTE); f.temperatures(8, 7); await f.tick();
  }
  assert.notEqual(f.runtime.episode, null, 'unverified native state interrupted the eight-hour qualification');
  f.at(START + 722 * MINUTE); f.temperatures(8, 7); await f.tick();
  assert.equal(f.runtime.episode, null);
  const completed = f.store.cycles({ input: garageInput('mqtt') }).find(row => row.id === f.episode.id);
  assert.equal(completed.status, 'incomplete'); assert.equal(completed.reason, 'archived-model-warm-native-operation');
  assert.equal(completed.assessment, null); assert.equal(completed.accounting.actualCostCents, 12);
});

test('malformed saved Garage exposure cannot prevent Home construction or grant fresh allowance', async t => {
  for (const saved of [{}, 0, { version: 'garage-exposure-v99' }]) await t.test(JSON.stringify(saved), async () => {
    const store = new Store(':memory:');
    store.setState('garage:exposure:mqtt', saved);
    let engine;
    try {
      engine = new Engine({ store, config: { input: 'mqtt', settings: { mode: 'shadow' }, connections: {},
        garage: garageSettings({ enabled: true, minOnMs: 30 * MINUTE, protection: { approved: true } }) }, clock: () => START });
      assert.equal(engine.garage.corruptState, true);
      for (const row of Object.values(engine.garage.exposure.locations)) {
        assert.ok(row.energyJPerM < 0); assert.equal(row.uncertain, true);
      }
      assert.deepEqual(store.getState('garage:exposure:mqtt'), saved, 'constructor does not rewrite the invalid source');
      engine.garage.safetyTick();
      assert.equal(engine.garage.protection.safeToPause, false);
    } finally { await engine?.garage.close({ restore: false }); store.close(); }
  });
});

test('malformed thermal state cannot preserve fabricated reserve or prevent Home control', async t => {
  const store = new Store(':memory:'), settings = garageSettings({ enabled: true, minOnMs: 30 * MINUTE, protection: { approved: true } });
  const saved = updateGarageExposure(null, { at: START, rearC: 8, frontC: 7 }, settings);
  saved.locations.front.energyJPerM = Infinity;
  delete saved.locations.front.estimatedC;
  store.setState('garage:exposure:mqtt', saved);
  const runtime = new GarageRuntime({ store, engine: { latest: {}, settings: { mode: 'active' } },
    config: { input: 'mqtt', garage: settings }, clock: () => START });
  t.after(async () => { await runtime.close({ restore: false }); store.close(); });
  assert.equal(runtime.corruptState, true);
  assert.ok(runtime.exposure.locations.front.energyJPerM < -reserveProperties(settings).latentJPerM);
  assert.equal(runtime.exposure.locations.front.lastAt, null);
  assert.equal(runtime.exposure.locations.front.lastC, null);
  assert.equal(runtime.exposure.locations.front.uncertain, true);
  const next = updateGarageExposure(runtime.exposure, { at: START + MINUTE, rearC: 8, frontC: 7 }, settings);
  assert.ok(next.locations.front.energyJPerM < 0); assert.equal(next.locations.front.uncertain, true);
  assert.equal(validGarageExposure(next, START + MINUTE, settings), true);
});

test('nonfinite exposure created by invalid internal state never passes protection assessment', () => {
  const settings = garageSettings({ protection: { approved: true } });
  let exposure = updateGarageExposure(null, { at: START, rearC: 8, frontC: 7 }, settings);
  exposure.locations.front.energyJPerM = NaN;
  assert.throws(() => updateGarageExposure(exposure, { at: START + MINUTE, rearC: 8, frontC: 7 }, settings), /Invalid/);
  const assessed = assessGarageProtection(exposure, { now: START + MINUTE,
    observation: { at: START + MINUTE, rearC: 8, frontC: 7 }, settings });
  assert.equal(assessed.safeToPause, false);
  assert.ok(assessed.reasons.includes('front:exposure-state-invalid'));
});
