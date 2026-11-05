import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { committedLearningSample, recordLearningContext, appendLearningRecord, replayLearningJournal,
  LEARNING_WINDOW_MS as WINDOW } from '../src/app/committed-learning.js';
import { MAIN_JOURNAL_ROW_BYTES } from '../src/storage/journal-codec.js';
import { currentHomeSample } from './helpers/home-learning-fixture.js';

const START = Date.parse('2026-10-01T12:00:00Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-dense-learning-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  let engine;
  await store.startWriter();
  await store.runWrite(() => { engine = new Engine({ store, config: { input: 'mqtt', settings: {},
    control: { indoorSensorWeights: { indoor_temperature: 1 } } }, clock: () => START }); });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await Promise.all([engine.closeFireplace(), engine.charging.close(), engine.garage.close({ restore: false }),
      engine.executor.close({ restore: false })]);
    await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine };
}

// Frequent genuine changes, not a large padding field: every source report and
// resolved interval remains part of the unchanged committed sample contract.
test('a dense completed window crosses the controller row limit without stalling the Engine or dropping evidence', async t => {
  const { store, engine } = await fixture(t), from = START - WINDOW;
  const record = (signal, value, at) => store.observation({ source: signal === 'outdoor_temperature' ? 'fmi'
    : signal === 'indoor_temperature' ? 'mqtt-temperature' : 'husdata-h66', device: 'synthetic-dense-source',
    signal, value, unit: signal.endsWith('_temperature') ? 'degC' : 'state', sourceTime: at, receivedAt: at,
    quality: [], raw: { usableForControl: true, retained: false } });
  await store.runWrite(() => {
    recordLearningContext(store, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, from,
      { config: engine.control });
    for (const [signal, value] of Object.entries({ indoor_temperature: 21, outdoor_temperature: 3,
      compressor_active: 1, dhw_routing: 0, auxiliary_output: 0, heating_integral: -100,
      supply_temperature: 35, heating_setpoint: 36, brine_in_temperature: 0, alarm_active: 0, operating_mode: 1 }))
      record(signal, value, from);
  });
  const reports = 2300;
  for (let first = 0; first < reports; first += 64) await store.runWrite(() => {
    for (let i = first; i < Math.min(reports, first + 64); i++)
      record('supply_temperature', 35 + (i % 100) / 100, from + Math.floor((i + 1) * (WINDOW - 1) / reports));
  });
  const sample = committedLearningSample({ store, input: 'mqtt', at: START, config: engine.control });
  sample.provenance.modelVersion = 'prior-v1';
  assert(Buffer.byteLength(JSON.stringify(sample)) > MAIN_JOURNAL_ROW_BYTES,
    'Real resolved inputs must reproduce the guarded row size');
  const before = store.checkpoint();
  await assert.rejects(store.runWrite(() => appendLearningRecord(store, 'mqtt', 'sample', sample,
    { config: engine.control })), { code: 'journal_main_thread_transaction_too_large' });
  assert.deepEqual(store.checkpoint(), before, 'The existing controller guard still rolls back atomically');
  await engine.update();
  assert.equal(engine.latestStatus.now, START, 'The complete controller pass publishes');
  const row = store.db.prepare("SELECT payload FROM learning_journal WHERE input='mqtt' AND kind='sample' AND at=?").get(START);
  assert.deepEqual(JSON.parse(row.payload).value, sample, 'All original segments, clocks, provenance and values are retained');
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  const restarted = new LiveLearning({ store, input: 'mqtt' });
  try {
    assert.deepEqual(await restarted.calculate('replay', { config: engine.control }), engine.checkpoint,
      'A replacement worker reconstructs the same model from the unchanged journal');
  } finally { await restarted.close(); }
  await engine.learningCheckpointCache?.flush();
  const savedCheckpoint = engine.checkpoint, committed = store.checkpoint();
  const conflicting = structuredClone(sample); conflicting.indoorC += 1;
  await assert.rejects(engine.liveLearning.calculate('append-sample', { value: conflicting, config: engine.control },
    savedCheckpoint), { code: 'LIVE_LEARNING_FAILED' });
  assert.deepEqual(store.checkpoint(), committed, 'A worker-side immutable-entry conflict rolls back without changing the journal');
  assert.strictEqual(engine.checkpoint, savedCheckpoint, 'Failure retains the previous complete model');
});

test('a learning append rejected before admission preserves its journal and model', async t => {
  const { store, engine } = await fixture(t);
  await engine.update();
  const checkpoint = engine.checkpoint, before = store.checkpoint();
  const sample = currentHomeSample({ timestamp: START + WINDOW, indoorC: 21, outdoorC: 3,
    phase: 'normal', regime: 'occupied', quality: [], thermalCompressorDuty: 0, thermalAuxKw: 0 });
  const entered = deferred(), release = deferred();
  const requested = deferred(), storageTask = store.runStorageTask.bind(store);
  const held = store.runStorageTask(async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  t.mock.method(store, 'runStorageTask', (operation, options) => {
    if (options?.kind === 'live-learning') requested.resolve();
    return storageTask(operation, options);
  });
  let current = true;
  const append = engine.liveLearning.calculate('append-sample', { value: sample, config: engine.control }, checkpoint,
    { isCurrent: () => current });
  append.catch(() => {});
  try { await requested.promise; current = false; } finally { release.resolve(); await held; }
  await assert.rejects(append);
  assert.deepEqual(store.checkpoint(), before);
  assert.strictEqual(engine.checkpoint, checkpoint);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM learning_journal WHERE input='mqtt' AND kind='sample' AND at=?")
    .get(START + WINDOW).count, 0);
});
