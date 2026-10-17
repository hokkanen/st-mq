import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { committedLearningSample, replayLearningJournal, LEARNING_WINDOW_MS as WINDOW }
  from '../src/app/committed-learning.js';

const START = Date.parse('2026-10-01T12:00:00Z');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-live-learning-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  let now = START;
  await store.startWriter();
  let engine;
  await store.runWrite(() => { engine = new Engine({ store, config: { input: 'mqtt', settings: {},
    control: { indoorSensorWeights: { indoor_temperature: 1 } } }, clock: () => now }); });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await Promise.all([engine.closeFireplace(), engine.charging.close(), engine.garage.close({ restore: false }),
      engine.executor.close({ restore: false })]);
    await store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, engine, advance: (milliseconds = WINDOW) => { now += milliseconds; } };
}

test('live worker replays the same ordered inputs, preserves prefixes and reads the same canonical window', async t => {
  const { store, engine } = await fixture(t);
  const worker = engine.liveLearning = new LiveLearning({ store, input: 'mqtt' });
  const sample = at => appendLearningRecord(store, 'mqtt', 'sample', { timestamp: at, indoorC: 21,
    outdoorC: 3, phase: 'normal', regime: 'occupied', quality: [], actualModeKnown: false,
    thermalCompressorDuty: null, thermalAuxKw: null }, { config: engine.control });
  await store.runWrite(() => sample(START - WINDOW));
  const first = await worker.calculate('replay', { config: engine.control });
  assert.deepEqual(first, replayLearningJournal(store, 'mqtt', null, { persistCheckpoint: false }));
  assert.strictEqual(await worker.calculate('replay', { config: engine.control }, first), first,
    'an unchanged owned result keeps its identity');
  await store.runWrite(() => sample(START));
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null,
    { through: first.journalCursor, persistCheckpoint: false }), first, 'bounded replay excludes a later committed suffix');
  const next = await worker.calculate('replay', { config: engine.control }, first);
  assert(next.journalCursor > first.journalCursor);
  assert.deepEqual(next, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  const options = { at: START, config: engine.control, measurementEpochAt: next.measurementEpochAt };
  assert.deepEqual(await worker.calculate('sample', options), committedLearningSample({ ...options, store, input: 'mqtt' }));
  assert.equal(store.getState('adaptive:mqtt'), null, 'computation has no write authority');
});

test('staged controller update commits complete replay-equivalent learning and reuses it on an unchanged turn', async t => {
  const { store, engine, advance } = await fixture(t);
  await engine.update();
  assert(engine.latestStatus);
  const first = engine.checkpoint;
  assert(first.journalCursor > 0);
  assert.deepEqual(first, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  assert.deepEqual(store.getState('adaptive:mqtt'), first);
  await engine.update();
  assert.strictEqual(engine.checkpoint, first);
  advance(); await engine.update();
  assert(engine.checkpoint.journalCursor > first.journalCursor);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('an urgent durable save proceeds while a learning result is pending and changed instructions get a fresh control turn', async t => {
  const { store, engine, advance } = await fixture(t);
  await engine.update(); advance();
  const held = deferred(), release = deferred(), calculate = engine.liveLearning.calculate.bind(engine.liveLearning);
  let blocked = false;
  engine.liveLearning.calculate = async (...args) => {
    const result = await calculate(...args);
    if (!blocked && args[0] === 'replay') { blocked = true; held.resolve(); await release.promise; }
    return result;
  };
  const update = engine.update(); await held.promise;
  try {
    assert.equal(store.transactionDepth, 0);
    assert.equal(Boolean(store.writePending), false);
    await store.runWrite(() => {
      store.setState('synthetic:urgent', true);
      engine.settings = { ...engine.settings, comfort: { ...engine.settings.comfort, targetC: 19 } };
    }, { priority: 'control' });
    assert.equal(store.getState('synthetic:urgent'), true);
    assert.equal(engine.status().settings.comfort.targetC, 19, 'committed choices are visible before model completion');
  } finally { release.resolve(); }
  await update;
  assert.equal(engine.latestStatus.settings.comfort.targetC, 19);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('ordinary journal growth retains a completed prefix instead of restarting the control preparation', async t => {
  const { store, engine, advance } = await fixture(t);
  await engine.update(); advance();
  const held = deferred(), release = deferred(), calculate = engine.liveLearning.calculate.bind(engine.liveLearning);
  let blocked = false, prefixes = 0;
  const reconcile = engine.automation.reconcileTargets.bind(engine.automation);
  t.mock.method(engine.automation, 'reconcileTargets', () => { prefixes++; return reconcile(); });
  engine.liveLearning.calculate = async (...args) => {
    const result = await calculate(...args);
    if (!blocked && args[0] === 'replay') { blocked = true; held.resolve(); await release.promise; }
    return result;
  };
  const update = engine.update(); await held.promise;
  try {
    await store.runWrite(() => appendLearningRecord(store, 'mqtt', 'context', { timestamp: START + 1 }, { config: engine.control }));
  } finally { release.resolve(); }
  await update;
  assert.equal(prefixes, 1, 'new ordinary entries extend the model without invalidating a valid prefix');
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('telemetry received during calculation stays live without becoming future evidence in the captured update', async t => {
  const { store, engine, advance } = await fixture(t);
  const reading = (value, at) => engine.ingest({ source: 'mqtt-temperature', device: 'synthetic-room',
    signal: 'indoor_temperature', value, unit: 'degC', sourceTime: at, receivedAt: at, quality: [], raw: null });
  await store.runWrite(() => reading(21, START));
  await engine.update(); advance();
  const held = deferred(), release = deferred(), calculate = engine.liveLearning.calculate.bind(engine.liveLearning);
  let blocked = false;
  engine.liveLearning.calculate = async (...args) => {
    const result = await calculate(...args);
    if (!blocked && args[0] === 'replay') { blocked = true; held.resolve(); await release.promise; }
    return result;
  };
  const update = engine.update(); await held.promise;
  try {
    advance(1000);
    await store.runWrite(() => reading(22, START + WINDOW + 1000));
  } finally { release.resolve(); }
  await update;
  assert.equal(engine.latestStatus.now, START + WINDOW);
  assert.equal(engine.latestStatus.observations.upstairs.value, 21);
  assert.equal(engine.latestStatus.observations.upstairs.observedAt, START);
  assert.equal(engine.latest.indoor_temperature.value, 22, 'later live ingestion is retained');
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('an old worker result cannot reinstate learning after a new empty history epoch is published', async t => {
  const { store, engine, advance } = await fixture(t);
  await engine.update(); advance();
  const prior = engine.checkpoint, held = deferred(), release = deferred();
  const calculate = engine.liveLearning.calculate.bind(engine.liveLearning);
  let blocked = false;
  engine.liveLearning.calculate = async (...args) => {
    const result = await calculate(...args);
    if (!blocked && args[0] === 'replay') { blocked = true; held.resolve(); await release.promise; }
    return result;
  };
  const update = engine.update(); await held.promise;
  try {
    // Same current publication boundary as complete history exclusion: retained
    // source rows stay in their old epoch, while new learning has a fresh seed.
    await store.runWrite(() => {
      store.db.prepare(`INSERT INTO learning_epochs(input,epoch) VALUES('mqtt','synthetic-empty-epoch')
        ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch`).run();
      store.setState('adaptive:mqtt', null);
      store.afterCommit(() => { engine.checkpoint = null; });
    });
  } finally { release.resolve(); }
  await update;
  const first = store.learningJournal({ input: 'mqtt', limit: 1 })[0];
  assert(first.id > prior.journalCursor);
  assert.equal(first.payload.seed?.journalCursor ?? null, null);
  assert.equal(first.payload.seed?.samples.length ?? 0, 0);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});

test('demotion cancels an unfinished learning turn and joins its worker before shutdown', async t => {
  const { store, engine } = await fixture(t);
  const started = deferred(), release = deferred();
  engine.liveLearning = new LiveLearning({ store, input: 'mqtt' });
  const calculate = engine.liveLearning.calculate.bind(engine.liveLearning);
  engine.liveLearning.calculate = async (...args) => { started.resolve(); await release.promise; return calculate(...args); };
  const update = engine.update(); await started.promise;
  engine.beginShutdown({ restore: false }); release.resolve();
  await assert.rejects(update, { code: 'STORAGE_WRITE_CANCELLED' });
  await engine.closeFireplace();
  assert.equal(engine.liveLearning.worker, null);
  assert.equal(engine.latestStatus, null);
  assert.equal(store.getState('adaptive:mqtt'), null);
});

test('a failed input transaction cannot publish its computed model or dispatch a command', async t => {
  const { store, engine, advance } = await fixture(t);
  await engine.update(); advance();
  const prior = engine.checkpoint, saved = store.getState('adaptive:mqtt'), head = store.learningJournalHead('mqtt');
  const calculate = engine.liveLearning.calculate.bind(engine.liveLearning), request = store.writer.request.bind(store.writer);
  let rejectSeal = false, rejected = false, commands = 0;
  engine.executor.execute = () => { commands++; return { status: 'paused', sent: false }; };
  engine.liveLearning.calculate = async (...args) => {
    const result = await calculate(...args);
    if (args[0] === 'sample') rejectSeal = true;
    return result;
  };
  store.writer.request = (operation, ...args) => {
    if (operation === 'seal' && rejectSeal && !rejected) {
      rejected = true;
      return Promise.reject(Object.assign(new Error('Synthetic input transaction failure'), { errcode: 10 }));
    }
    return request(operation, ...args);
  };
  try { await assert.rejects(engine.update(), { errcode: 10 }); }
  finally { store.writer.request = request; engine.liveLearning.calculate = calculate; }
  assert(rejected);
  assert.strictEqual(engine.checkpoint, prior);
  assert.deepEqual(store.getState('adaptive:mqtt'), saved);
  assert.equal(store.learningJournalHead('mqtt'), head);
  assert.equal(commands, 0);
  await engine.update();
  assert(engine.checkpoint.journalCursor > head);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});
