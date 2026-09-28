import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings } from '../src/app/config.js';
import { applyLearningRecord, LEARNING_ALGORITHM, validLearningCheckpoint} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';

const WINDOW = 900_000, start = Date.parse('2026-01-01T00:00:00Z');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-fireplace-engine-'));
  const path = join(directory, 'invented.sqlite'), store = new Store(path);
  const config = { input: 'mqtt', settings: validateSettings({ comfort: { targetC: 21 } }),
    control: { learningTrials: false } };
  let now = start, engine = new Engine({ store, config, clock: () => now });
  const observer = new DatabaseSync(path, { readOnly: true });
  const externalState = key => {
    const row = observer.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  };
  t.after(async () => {
    await engine.closeFireplace();
    engine.executor.closed = true; clearTimeout(engine.executor.timer);
    observer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const sample = i => {
    const timestamp = start + i * WINDOW, windowStart = timestamp - WINDOW;
    const intervalInputs = { outdoorC: 10, solarRadiationWm2: 0, compressorDuty: 0.4, auxKw: 0,
      phase: 'normal', targetC: 21, roomBoostC: 0 };
    appendLearningRecord(store, 'mqtt', 'sample', { timestamp, windowStart, windowEnd: timestamp, ...intervalInputs,
      indoorC: 21, regime: 'occupied', quality: [], actualModeKnown: true, intervalInputs,
      heating: { verified: true, compressorActive: true, route: 'space-heating', quality: [] },
      powerKw: 1.22, energyBasis: 'estimated' }, { config: engine.control });
    now = Math.max(now, timestamp);
  };
  return { store, sample, externalState,
    get engine() { return engine; }, get now() { return now; }, set now(value) { now = value; },
    async restart() {
      await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer);
      engine = new Engine({ store, config, clock: () => now }); return engine;
    } };
}
async function waitReady(engine) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = engine.fireplaceManager().status();
    assert.notEqual(status.status, 'failed', 'The real rebuild worker must finish successfully');
    if (status.status === 'ready') return;
    await pause();
  }
  throw new Error('Synthetic engine rebuild did not finish before deadline');
}
function pureReplay(store) {
  const context = fireplaceLearningContext(store, 'mqtt');
  return store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
    .reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
}

test('engine holds the old revision through real-worker replay and suffix catchup, then swaps all durable state atomically',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const created = f.engine.changeFireplace({ requestId: 'invented-engine-load', kg: 8 });
    const load = created.entries[0];
    for (let i = 1; i <= 12; i++) f.sample(i);
    const old = structuredClone(f.engine.readAdaptive(f.now));
    assert.equal(old.fireplaceRevision, load.id);
    const journalBefore = f.store.learningJournal({ input: 'mqtt' });
    f.now++;
    const removed = f.engine.changeFireplace({ requestId: 'invented-engine-remove', id: load.id }, true);
    assert.equal(removed.rebuild.status, 'running');
    assert.equal(f.engine.readAdaptive(f.now).fireplaceRevision, old.fireplaceRevision);
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    await waitReady(f.engine);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'running', 'A ready candidate is not yet an active model');
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    f.sample(13);
    const retained = f.engine.readAdaptive(f.now);
    assert.equal(retained.fireplaceRevision, old.fireplaceRevision, 'New journal suffixes must catch up before activation');
    assert.equal(retained.samples.length, old.samples.length + 1);
    assert.equal(f.engine.fireplaceManager().status().status, 'running');
    await waitReady(f.engine);
    f.engine.pendingPlan = { invented: true };
    f.store.setState('pending-plan:mqtt', f.engine.pendingPlan);
    const beforeSwap = structuredClone(f.store.getState('adaptive:mqtt'));
    const setState = f.store.setState.bind(f.store);
    let inspectedSwap = false;
    f.store.setState = (key, value) => {
      const result = setState(key, value);
      if (key === 'adaptive:mqtt' && value.fireplaceRevision === removed.revision) {
        inspectedSwap = true;
        assert.deepEqual(f.externalState('adaptive:mqtt'), beforeSwap, 'A separate reader cannot see a half-published checkpoint');
        assert.equal(f.externalState('fireplace:rebuild:mqtt').status, 'ready');
        assert.deepEqual(f.externalState('pending-plan:mqtt'), { invented: true });
      }
      return result;
    };
    const current = f.engine.readAdaptive(f.now);
    f.store.setState = setState;
    assert.equal(inspectedSwap, true);
    assert.equal(current.fireplaceRevision, removed.revision);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(validLearningCheckpoint(current), true);
    assert.deepEqual(f.externalState('adaptive:mqtt'), current);
    assert.equal(f.externalState('fireplace:rebuild:mqtt').status, 'current');
    assert.equal(f.externalState('pending-plan:mqtt'), null);
    assert.equal(f.engine.pendingPlan, null);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'idle');
    assert.deepEqual(f.store.learningJournal({ input: 'mqtt' }).slice(0, journalBefore.length), journalBefore);
  });

test('a load exactly at the closed-window boundary and its immediate removal need no retrospective rebuild', async t => {
  const f = fixture(t);
  f.sample(0);
  const original = structuredClone(f.engine.readAdaptive(f.now));
  const created = f.engine.changeFireplace({ requestId: 'invented-boundary-load', kg: 8 });
  assert.equal(created.requiresRebuild, false);
  assert.equal(created.rebuild.status, 'idle');
  assert.equal(f.engine.fireplaceRebuild, undefined);
  assert.equal(f.engine.fireplaceReserveOverride, null);
  f.now++;
  const removed = f.engine.changeFireplace({ requestId: 'invented-boundary-remove', id: created.entries[0].id }, true);
  assert.equal(removed.requiresRebuild, false);
  assert.equal(removed.rebuild.status, 'idle');
  assert.equal(f.engine.fireplaceRebuild, undefined);
  assert.equal(f.engine.fireplaceReserveOverride, null);
  const after = f.engine.readAdaptive(f.now);
  assert.deepEqual(after.model, original.model);
  assert.deepEqual(after.samples, original.samples);
  assert.equal(after.fireplaceRevision, removed.revision);
  assert.equal(validLearningCheckpoint(after), true);
});

test('restart resumes a pending correction while preserving the previous checkpoint until the worker is ready',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const created = f.engine.changeFireplace({ requestId: 'invented-restart-load', kg: 6 });
    for (let i = 1; i <= 16; i++) f.sample(i);
    const old = structuredClone(f.engine.readAdaptive(f.now));
    f.now++;
    const removed = f.engine.changeFireplace({ requestId: 'invented-restart-remove', id: created.entries[0].id }, true);
    await f.restart();
    assert.equal(f.store.getState('fireplace:rebuild:mqtt').status, 'pending');
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    const firstRead = f.engine.readAdaptive(f.now);
    assert.equal(firstRead.fireplaceRevision, old.fireplaceRevision);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'running');
    await waitReady(f.engine);
    const current = f.engine.readAdaptive(f.now);
    assert.equal(current.fireplaceRevision, removed.revision);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'idle');
  });
