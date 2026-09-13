import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings } from '../src/app/config.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { appendLearningRecord, applyLearningRecord, LEARNING_ALGORITHM, validLearningCheckpoint } from '../src/app/committed-learning.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { sensorLearningContext } from '../src/app/sensor-inputs.js';
import { revertSensorChange } from '../src/app/sensor-changes.js';

const start = Date.parse('2026-09-10T12:00:00Z'), HOUR = 3_600_000;
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-sensor-revert-engine-'));
  const path = join(directory, 'invented.sqlite'), store = new Store(path);
  const config = { input: 'providers', settings: validateSettings({ mode: 'monitoring' }), control: { learningTrials: false } };
  let now = start, engine = new Engine({ store, config, clock: () => now });
  engine.tick = () => {};
  const seed = restoreAdaptiveCheckpoint(null, engine.control);
  seed.baselineC = 21.5;
  seed.comfortReference = { baselineC: 21.5, observedAt: now - HOUR };
  seed.sensorComfortReferences = { indoor_temperature: { baselineC: 21.5 } };
  seed.state = { indoorC: 21.5, reserveC: 22, observedAt: now - HOUR };
  seed.samples = [now - 2 * HOUR, now - HOUR].map(timestamp => ({ timestamp, indoorC: 21.5, outdoorC: 10,
    phase: 'normal', regime: 'occupied', quality: [], valid: true }));
  seed.cursor = new Date(now - HOUR).toISOString();
  appendLearningRecord(store, config.input, 'context', { timestamp: now - HOUR }, { config: engine.control, seed });
  const initial = structuredClone(engine.readAdaptive(now));
  const observer = new DatabaseSync(path, { readOnly: true });
  const externalState = key => {
    const row = observer.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  };
  t.after(async () => {
    await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer);
    observer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, initial, externalState, get engine() { return engine; }, get now() { return now; },
    set now(value) { now = value; },
    appendContext() {
      now++;
      appendLearningRecord(store, config.input, 'context', { timestamp: now }, { config: engine.control });
    },
    async restart() {
      await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer);
      engine = new Engine({ store, config, clock: () => now }); engine.tick = () => {};
    } };
}

async function waitReady(engine) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = engine.fireplaceManager().status();
    assert.notEqual(status.status, 'failed', 'The real reconstruction worker must complete');
    if (status.status === 'ready') return;
    await pause();
  }
  throw new Error('Synthetic sensor rebuild timed out');
}

function pureReplay(store) {
  const context = { ...fireplaceLearningContext(store, 'providers'), ...sensorLearningContext(store, 'providers') };
  return store.learningJournal({ input: 'providers', algorithmVersion: LEARNING_ALGORITHM })
    .reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
}

test('sensor undo keeps the old model available, catches up and atomically restores the pre-reset knowledge',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const changed = f.engine.changeSensor({ requestId: 'invented-reset', signal: 'indoor_temperature', reason: 'replacement' });
    assert.equal(f.engine.checkpoint.baselineC, null);
    assert.deepEqual(f.engine.checkpoint.samples, []);
    const old = structuredClone(f.engine.checkpoint);
    const prefix = structuredClone(f.store.learningJournal({ input: 'providers' }));
    f.now++;
    f.engine.pendingPlan = { invented: true }; f.store.setState('pending-plan:providers', f.engine.pendingPlan);
    const reversed = f.engine.revertSensor({ id: changed.events[0].id, requestId: 'invented-undo' });
    assert.equal(reversed.rebuild.status, 'running');
    assert.deepEqual(f.engine.checkpoint, old);
    assert.deepEqual(f.externalState('adaptive:providers'), old);
    assert.equal(f.engine.pendingPlan, null);
    const retained = f.engine.readAdaptive(f.now);
    assert.equal(retained.sensorRevision ?? 0, 0);
    assert.equal(retained.baselineC, null);
    await waitReady(f.engine);
    f.appendContext();
    const catchup = f.engine.readAdaptive(f.now);
    assert.equal(catchup.sensorRevision ?? 0, 0);
    assert.equal(catchup.baselineC, null);
    assert.equal(f.engine.fireplaceManager().status().status, 'running');
    await waitReady(f.engine);
    const beforeSwap = structuredClone(f.store.getState('adaptive:providers'));
    const setState = f.store.setState.bind(f.store);
    let inspectedSwap = false;
    f.engine.pendingPlan = { invented: 'new-plan' }; f.store.setState('pending-plan:providers', f.engine.pendingPlan);
    f.store.setState = (key, value) => {
      const result = setState(key, value);
      if (key === 'adaptive:providers' && value.sensorRevision === reversed.revision) {
        inspectedSwap = true;
        assert.deepEqual(f.externalState('adaptive:providers'), beforeSwap);
        assert.equal(f.externalState('fireplace:rebuild:providers').status, 'ready');
        assert.deepEqual(f.externalState('pending-plan:providers'), { invented: 'new-plan' });
      }
      return result;
    };
    const current = f.engine.readAdaptive(f.now);
    f.store.setState = setState;
    assert.equal(inspectedSwap, true);
    assert.equal(current.sensorRevision, reversed.revision);
    assert.equal(current.baselineC, f.initial.baselineC);
    assert.deepEqual(current.samples, f.initial.samples);
    assert.deepEqual(current.sensorComfortReferences, f.initial.sensorComfortReferences);
    assert.equal(current.measurementEpochAt, undefined);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(validLearningCheckpoint(current), true);
    assert.deepEqual(f.externalState('adaptive:providers'), current);
    assert.equal(f.externalState('fireplace:rebuild:providers').status, 'current');
    assert.equal(f.externalState('fireplace:rebuild:providers').sensorRevision, reversed.revision);
    assert.equal(f.externalState('pending-plan:providers'), null);
    assert.deepEqual(f.store.learningJournal({ input: 'providers' }).slice(0, prefix.length), prefix);
  });

test('restart resumes a sensor reversal with both source revisions pinned until reconstruction completes',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const changed = f.engine.changeSensor({ requestId: 'invented-restart-reset', signal: 'outdoor_temperature', reason: 'calibration' });
    const before = structuredClone(f.engine.checkpoint);
    f.now++;
    const reversed = f.engine.revertSensor({ id: changed.events[0].id, requestId: 'invented-restart-undo' });
    await f.restart();
    assert.equal(f.store.getState('fireplace:rebuild:providers').status, 'pending');
    assert.deepEqual(f.externalState('adaptive:providers'), before);
    const retained = f.engine.readAdaptive(f.now);
    assert.equal(retained.sensorRevision ?? 0, before.sensorRevision ?? 0);
    assert.equal(retained.fireplaceRevision ?? 0, before.fireplaceRevision ?? 0);
    assert.equal(retained.baselineC, null);
    await waitReady(f.engine);
    const current = f.engine.readAdaptive(f.now);
    assert.equal(current.sensorRevision, reversed.revision);
    assert.equal(current.baselineC, f.initial.baselineC);
    assert.deepEqual(current, pureReplay(f.store));
  });

test('reverting a reset leaves its cancelled cycle and frozen observations intact', { timeout: 30_000 }, async t => {
  const f = fixture(t), cycleStart = start - HOUR;
  const plan = { model: f.initial.model, intervals: Array.from({ length: 8 }, (_, i) => ({
    start: cycleStart + i * HOUR / 4, end: cycleStart + (i + 1) * HOUR / 4,
    outdoorC: 10, solarRadiationWm2: 0, price: 10,
  })), initialState: { indoorC: 21.5, reserveC: 22 }, targetC: 21.5,
    schedule: { preheatStart: cycleStart, preheatEnd: cycleStart, reductionStart: cycleStart, reductionEnd: start + HOUR, roomBoostC: 0 },
    reference: null, occupancy: { mode: 'occupied' }, maxDropC: 1, equipment: {} };
  const cycle = f.engine.cycles.start(plan, { timestamp: cycleStart, indoorC: 21.5 }, cycleStart);
  cycle.observations.push({ start: cycleStart, end: start, indoorC: 21, electricityKwh: 1 });
  cycle.actual.electricityKwh = 1; f.engine.cycles.save(cycle);
  const changed = f.engine.changeSensor({ requestId: 'invented-cycle-reset', signal: 'indoor_temperature', reason: 'moved' });
  const cancelled = structuredClone(f.store.cycles({ input: 'providers' }));
  assert.equal(cancelled[0].status, 'incomplete');
  assert.equal(cancelled[0].incompleteReason, 'sensor-measurement-changed');
  f.now++;
  f.engine.revertSensor({ id: changed.events[0].id, requestId: 'invented-cycle-undo' });
  await waitReady(f.engine);
  f.engine.readAdaptive(f.now);
  assert.equal(f.engine.cycles.active(), null);
  assert.deepEqual(f.store.cycles({ input: 'providers' }), cancelled);
});

for (const race of ['journal suffix', 'sensor correction']) test(`publication rejects a ${race} committed after candidate selection but before the writer lock`,
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const first = f.engine.changeSensor({ requestId: 'invented-race-first', signal: 'indoor_temperature', reason: 'replacement' });
    let second;
    if (race === 'sensor correction') {
      f.now++;
      second = f.engine.changeSensor({ requestId: 'invented-race-second', signal: 'outdoor_temperature', reason: 'moved' });
    }
    f.now++;
    f.engine.revertSensor({ id: first.events[0].id, requestId: 'invented-race-undo-first' });
    await waitReady(f.engine);
    const previous = structuredClone(f.engine.checkpoint);
    const pending = { invented: 'not-yet-invalidated-by-publication' };
    f.engine.pendingPlan = pending; f.store.setState('pending-plan:providers', pending);
    const manager = f.engine.fireplaceManager(), selectedHead = manager.ready.head;
    const transaction = f.store.transaction.bind(f.store);
    const writer = new Store(f.store.path);
    let raced = false;
    f.store.transaction = callback => {
      f.store.transaction = transaction;
      raced = true;
      assert.equal(manager.ready.head, selectedHead);
      f.now++;
      if (race === 'journal suffix')
        appendLearningRecord(writer, 'providers', 'context', { timestamp: f.now }, { config: f.engine.control });
      else revertSensorChange(writer, 'providers', { id: second.events[0].id,
        requestId: 'invented-race-undo-second' }, f.now, { config: f.engine.control });
      return transaction(callback);
    };
    try { f.engine.reconcileFireplace(); }
    finally { f.store.transaction = transaction; writer.close(); }
    assert.equal(raced, true);
    assert.deepEqual(f.engine.checkpoint, previous, 'A stale candidate never reaches process state');
    assert.deepEqual(f.externalState('adaptive:providers'), previous, 'A stale candidate never reaches durable state');
    assert.deepEqual(f.externalState('pending-plan:providers'), pending);
    assert.equal(manager.status().status, 'running', 'The manager resumes the latest complete source selection');
    assert.equal(manager.ready, null);
    await waitReady(f.engine);
    const current = f.engine.readAdaptive(f.now);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(current.journalCursor, manager.head());
    assert.equal(current.sensorRevision, sensorLearningContext(f.store, 'providers').sensorRevision);
    assert.equal(current.baselineC, f.initial.baselineC);
    assert.equal(f.externalState('pending-plan:providers'), null);
    assert.equal(manager.status().status, 'current');
  });
