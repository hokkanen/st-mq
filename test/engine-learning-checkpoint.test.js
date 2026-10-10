import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { appendLearningRecord, replayLearningJournal, LEARNING_WINDOW_MS as WINDOW }
  from '../src/app/committed-learning.js';
import { MAIN_JOURNAL_CAPTURE_BYTES, MAIN_JOURNAL_ROW_BYTES } from '../src/storage/journal-codec.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';

const START = Date.parse('2026-10-01T12:00:00Z'), HOUR = 3_600_000;

// Frequent real inputs can divide a fifteen-minute window into many segments.
// All fields below are current resolved inputs, not an oversized padding string.
function richSample(at) {
  const segmentCount = 30, durationHours = WINDOW / segmentCount / HOUR;
  const inputSegments = Array.from({ length: segmentCount }, (_, index) => ({
    start: at - WINDOW + index * WINDOW / segmentCount,
    end: at - WINDOW + (index + 1) * WINDOW / segmentCount,
    outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0, targetC: 21,
    regime: 'occupied', episodeId: null, supplyC: 35 + index / 10, brineC: 0,
    compressorHeatKw: 9.4, sourceRelativeUncertainty: 0.25,
    sourceEstimateBasis: 'manufacturer-two-point-estimate; not measured heat or electricity',
    sourceUncertaintyReasons: ['installed-model-not-confirmed'], sourcePumpsIncluded: true,
    floorOverrideMode: 'off', treatmentKey: 'normal', compressorDuty: 1,
    compressorPowerKw: 2.2, circulationKw: 0, dhwrKw: 0, auxKw: 0, powerKw: 2.2,
    thermalCompressorDuty: 1, thermalAuxKw: 0, auxRoute: 'space',
    dhwCompressorDuty: 0, dhwAuxKw: 0, auxiliaryStage: 'off',
    auxiliaryPowerBasis: 'observed-output-stage', integral: -100 + index, supplyShortfallC: 1,
    operatingMode: 1, quality: [], hydronicHeatKw: 9.4,
    compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true,
    actualModeKnown: true, energyBasis: 'estimated', configurationVersion: 'a'.repeat(64),
    durationHours, energyKwh: 2.2 * durationHours, hydronicHeatKwh: 9.4 * durationHours,
    compressorKwh: 2.2 * durationHours, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
  }));
  return { sensorInputVersion: 1, timestamp: at, windowStart: at - WINDOW, windowEnd: at,
    indoorC: 21, outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied',
    roomBoostC: 0, targetC: 21, quality: [], actualModeKnown: true, energyBasis: 'estimated',
    thermalCompressorDuty: 1, thermalAuxKw: 0,
    heating: { verified: true, compressorActive: true, compressorDuty: 1, route: 'space-heating', quality: [] },
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: at,
      reportCoverageComplete: true, reportCoveredThrough: at,
      reportIntervals: [{ start: at - WINDOW, end: at, observedAt: at, endpoint: true }] } }, inputSegments };
}

function dayPlan(now, id) {
  const intervals = Array.from({ length: 96 }, (_, index) => ({
    start: now + index * WINDOW, end: now + (index + 1) * WINDOW,
    priceCtPerKwh: 5 + index % 4, energyKwh: 0.25, powerKw: 1,
    currentA: 6, currentLimitA: 6, phaseCurrentA: [6, 6, 6],
    householdCurrentA: [2, 2, 2], availableCurrentA: [16, 16, 16],
    voltageV: [230, 230, 230], externallyBalanced: id === 'charger1',
    source: 'synthetic-published-price', quality: [],
  }));
  return { id: `synthetic-${id}-day-plan`, feasible: true, state: 'scheduled',
    deadlineAt: now + 24 * HOUR, startAt: now, endAt: now + 24 * HOUR,
    periods: [{ startAt: now, endAt: now + 24 * HOUR }],
    requiredGridKwh: 24, deliveredGridKwh: 24, shortfallGridKwh: 0, costCents: 156,
    intervals, accounting: intervals.map(({ start, end, priceCtPerKwh, energyKwh, powerKw, currentA }) =>
      ({ start, end, priceCtPerKwh, energyKwh, powerKw, currentA })),
    allocations: intervals.map(({ start, end }) => ({ start, end, householdCurrentA: [2, 2, 2],
      availableCurrentA: [16, 16, 16], chargers: {
        charger1: { currentA: 6, phaseCurrentA: [6, 6, 6], powerKw: 1, currentLimitA: 6 },
        charger2: { currentA: 6, phaseCurrentA: [6, 6, 6], powerKw: 1, currentLimitA: 6 },
      } })), assumptions: [] };
}

const rawStateBytes = (store, key) => Buffer.byteLength(JSON.stringify(
  store.db.prepare('SELECT key,value,updated_at FROM state WHERE key=?').get(key)));
const controls = engine => structuredClone({ home: engine.automationEnabled('home'),
  shared: engine.charging.controls,
  chargers: Object.fromEntries(Object.entries(engine.charging.chargers).map(([id, item]) => [id,
    { controls: item.controls, association: item.association, request: item.request }])) });

async function closeEngine(engine) {
  engine.beginShutdown({ restore: false });
  await engine.charging.close(); await engine.garage.close({ restore: false });
  await engine.closeFireplace(); await engine.executor.close({ restore: false });
}

for (const correction of ['fireplace', 'sensor']) test(`incident-sized ${correction} correction publishes through the Engine while retaining charging controls`,
  { timeout: 30_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-engine-correction-'));
    const store = new Store(join(directory, 'synthetic.sqlite'));
    let now = START - 49 * WINDOW, commands = 0;
    const engine = new Engine({ store, config: { input: 'mqtt', settings: {},
      control: { indoorSensorWeights: { indoor_temperature: 1 } } }, clock: () => now,
      commandTransport: { async publish() { commands++; }, async publishDhwr() { commands++; }, async close() {} } });
    t.after(async () => { await closeEngine(engine); store.close(); rmSync(directory, { recursive: true, force: true }); });
    // Inspect the complete large candidate explicitly before publication.
    engine.fireplaceManager().onReady = null;
    const source = correction === 'fireplace'
      ? engine.changeFireplace({ requestId: 'invented-large-load', kg: 4 }).entries[0]
      : addSensorChange(store, 'mqtt', { requestId: 'invented-large-sensor', signal: 'outdoor_temperature', reason: 'replacement' }, now);
    for (let index = 0; index < 48; index++) store.transaction(() => appendLearningRecord(store, 'mqtt', 'sample',
      richSample(START - (48 - index) * WINDOW), { config: engine.control }));
    now = START;
    const old = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
    store.setState('adaptive:mqtt', old); engine.checkpoint = old;
    const originalControls = controls(engine), journal = store.learningJournal({ input: 'mqtt' });
    await store.runWrite(() => correction === 'fireplace'
      ? engine.changeFireplace({ requestId: 'invented-large-remove', id: source.id }, true)
      : engine.revertSensor({ requestId: 'invented-large-revert', id: source.id }));
    const manager = engine.fireplaceManager();
    const waitReady = async () => {
      const deadline = Date.now() + 20_000;
      while (manager.status().status !== 'ready') {
        assert.notEqual(manager.status().status, 'failed');
        assert(Date.now() < deadline, 'the correction catches up');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitReady();
    assert.deepEqual(engine.checkpoint, old, 'the original model serves control during replay');
    store.transaction(() => appendLearningRecord(store, 'mqtt', 'sample', richSample(now), { config: engine.control }));
    await store.runWrite(() => engine.reconcileFireplace());
    await waitReady();
    const candidateBytes = Buffer.byteLength(JSON.stringify(manager.ready.checkpoint));
    assert(candidateBytes > 1_800_000, 'real resolved inputs reproduce the affected checkpoint size');
    await store.runWrite(() => engine.reconcileFireplace());
    const publication = manager.publication;
    assert(publication, 'the actual Engine starts worker publication');
    let sawPublished = false;
    const nextUpdate = store.runWrite(() => {
      assert.equal(manager.status().status, 'current');
      assert.deepEqual(engine.checkpoint, store.getState('adaptive:mqtt'), 'RAM adoption precedes the next controller write');
      engine.tick(); sawPublished = true;
    });
    await publication; await nextUpdate; await engine.learningCheckpointCache?.flush();
    assert(sawPublished);
    assert.equal(manager.status().requiresRebuild, false);
    assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
    assert.deepEqual(store.learningJournal({ input: 'mqtt' }).slice(0, journal.length), journal);
    assert.deepEqual(controls(engine), originalControls);
    assert.equal(commands, 0);
    // A later firewood entry changes only the future source revision. Its
    // optional large restart cache must also avoid a main-thread publication.
    now++;
    await store.runWrite(() => engine.changeFireplace({ requestId: 'invented-large-future-load', kg: 2 }));
    await engine.learningCheckpointCache?.flush();
    assert.equal(manager.status().status, 'current');
    assert.deepEqual(store.getState('adaptive:mqtt'), engine.checkpoint);
    assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
    t.diagnostic(JSON.stringify({ correction, candidateBytes }));
  });

test('the MQTT controller advances a rich learning cache beside durable charging state without weakening storage admission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-engine-checkpoint-'));
  const path = join(directory, 'synthetic.sqlite');
  let now = START, store = new Store(path), engine;
  const configuration = { input: 'mqtt', settings: {}, control: { indoorSensorWeights: { indoor_temperature: 1 } } };
  let commands = 0;
  const rejectCommand = async () => { commands++; throw new Error('No synthetic fixture command is authorized'); };
  const create = () => new Engine({ store, config: configuration, clock: () => now,
    commandTransport: { publish: rejectCommand, publishDhwr: rejectCommand, async close() {} } });
  t.after(async () => { if (engine) await closeEngine(engine); store.close(); rmSync(directory, { recursive: true, force: true }); });
  engine = create();
  for (const item of Object.values(engine.charging.chargers)) item.controls.enabled = false;
  engine.charging.refreshSettings();
  for (let index = 0; index < 48; index++) {
    store.transaction(() => appendLearningRecord(store, 'mqtt', 'sample',
      richSample(START - (48 - index) * WINDOW), { config: engine.control }));
  }
  const original = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  assert.equal(original.samples.length, 48);
  store.setState('adaptive:mqtt', original);
  const setPlans = () => {
    for (const [id, item] of Object.entries(engine.charging.chargers)) {
      item.plan = dayPlan(now, id); item.forecast = structuredClone(item.plan);
    }
  };
  setPlans(); await store.runWrite(() => engine.charging.persist());
  const checkpointBytes = rawStateBytes(store, 'adaptive:mqtt');
  const chargingRows = store.db.prepare('SELECT key,value,updated_at FROM state WHERE key=? OR key GLOB ? ORDER BY key')
    .all('charging:mqtt', 'charging:mqtt:runtime:*');
  const chargingBytes = chargingRows.reduce((bytes, row) => bytes + Buffer.byteLength(JSON.stringify(row)), 0);
  const expandedChargingBytes = Buffer.byteLength(JSON.stringify(readChargingRuntime(store, 'charging:mqtt')));
  assert(checkpointBytes > 1.75 * 1024 * 1024, `The realistic cache must reproduce the large row (${checkpointBytes} bytes)`);
  assert(checkpointBytes < MAIN_JOURNAL_ROW_BYTES, 'each individual original row is admitted');
  assert(expandedChargingBytes > 177_000, 'the production charging snapshot includes a substantial day horizon');
  assert(chargingRows.length > 1 && chargingBytes < expandedChargingBytes,
    'the complete day horizon is retained in deduplicated current records');
  assert(2 * (checkpointBytes + chargingBytes) > MAIN_JOURNAL_CAPTURE_BYTES,
    'OLD plus NEW of the cache and all current charging records exceeds the unchanged transaction capture limit');
  const beforeAdmission = store.checkpoint();
  assert.throws(() => store.transaction(() => {
    store.db.prepare('UPDATE state SET updated_at=updated_at+1 WHERE key=? OR key GLOB ?')
      .run('charging:mqtt', 'charging:mqtt:runtime:*');
    store.db.prepare('UPDATE state SET updated_at=updated_at+1 WHERE key=?').run('adaptive:mqtt');
  }), { code: 'journal_main_thread_transaction_too_large' });
  assert.deepEqual(store.checkpoint(), beforeAdmission, 'the existing guard still rejects atomically');
  const originalControls = controls(engine), journalBefore = store.learningJournal({ input: 'mqtt' }).length;
  await store.runWrite(() => {
    engine.charging.preserveWriteState(); setPlans(); engine.charging.persist();
    engine.tick();
  });
  await engine.learningCheckpointCache?.flush();
  assert(engine.learningCheckpointCache, 'a large cache uses background persistence');
  assert(engine.checkpoint.journalCursor > original.journalCursor);
  assert(store.learningJournal({ input: 'mqtt' }).length > journalBefore);
  assert.deepEqual(store.getState('adaptive:mqtt'), engine.checkpoint);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), engine.checkpoint);
  assert.deepEqual(controls(engine), originalControls);
  assert.equal(commands, 0);

  // A failed controller transaction must not publish its deferred cache or keep
  // its provisional learning/control presentation in RAM.
  await engine.charging.planningFlight?.catch(() => {});
  const saved = store.getState('adaptive:mqtt'), priorJournal = store.learningJournal({ input: 'mqtt' });
  const priorRam = structuredClone(engine.checkpoint), priorControls = controls(engine);
  now += WINDOW;
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT') throw Object.assign(new Error('synthetic controller commit failure'), { errcode: 10 });
    return exec(sql);
  };
  try {
    await assert.rejects(store.runWrite(() => {
      engine.charging.preserveWriteState(); setPlans(); engine.charging.persist();
      engine.tick();
      assert(engine.checkpoint.journalCursor > priorRam.journalCursor);
    }), { errcode: 10 });
  } finally { store.db.exec = exec; }
  await engine.learningCheckpointCache.flush();
  assert.deepEqual(engine.checkpoint, priorRam);
  assert.deepEqual(store.getState('adaptive:mqtt'), saved);
  assert.deepEqual(store.learningJournal({ input: 'mqtt' }), priorJournal);
  assert.deepEqual(controls(engine), priorControls);
  await store.runWrite(() => engine.tick());
  await engine.learningCheckpointCache.flush();
  const committed = structuredClone(engine.checkpoint);
  assert.deepEqual(store.getState('adaptive:mqtt'), committed);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), committed);

  await closeEngine(engine); engine = null; store.close(); store = new Store(path); engine = create();
  assert.deepEqual(engine.readAdaptive(now), committed, 'restart restores the exact committed model');
  assert.deepEqual(controls(engine), priorControls);
  assert.equal(commands, 0);

  // A newly recorded sensor boundary is an immutable forward input. Its source
  // and plan invalidation must survive even if shutdown discards the cache job.
  engine.pendingPlan = { id: 'invented-invalidated-plan' };
  await store.runWrite(() => engine.commitSensorChange({ requestId: 'invented-rich-sensor-change',
    signal: 'indoor_temperature', reason: 'replacement' }));
  const changed = structuredClone(engine.checkpoint);
  assert(changed.journalCursor > committed.journalCursor);
  assert.equal(engine.pendingPlan, null);
  assert.equal(store.getState('pending-plan:mqtt'), null);
  assert.deepEqual(store.getState('adaptive:mqtt'), committed, 'the model cache still precedes the sensor boundary');
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), changed);
  await closeEngine(engine); engine = null; store.close(); store = new Store(path); engine = create();
  assert.deepEqual(engine.readAdaptive(now), changed, 'restart recovers the sensor boundary from the journal and older cache');
  await engine.learningCheckpointCache?.flush();
  assert.deepEqual(store.getState('adaptive:mqtt'), changed);
  assert.deepEqual(controls(engine), priorControls);
  assert.equal(commands, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  t.diagnostic(JSON.stringify({ samples: original.samples.length, checkpointBytes, chargingBytes, expandedChargingBytes,
    combinedCaptureBytes: 2 * (checkpointBytes + chargingBytes) }));
});
