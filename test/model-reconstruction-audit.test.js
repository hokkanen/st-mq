import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createModelReconstruction } from '../src/app/model-reconstruction.js';
import { modelVerificationDifferences } from '../src/app/model-verification-differences.js';
import { ModelVerificationWork, verificationWorkPath } from '../src/storage/model-verification-work.js';
import { readCoefficientEvents, readCoefficientCoverage, persistCoefficientBatch, coefficientProjectionAt, validateCoefficientHistory } from '../src/storage/coefficient-history.js';
import { getChartData } from '../src/app/chart-data.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { LearningCheckpointCache } from '../src/app/learning-checkpoint-cache.js';
import { MODEL_COEFFICIENT_INFO } from '../src/domain/history-series.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { learningCheckpointDigest, replayLearningJournal } from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { addFireplace } from '../src/app/fireplace.js';
import { fixture as recoveryFixture, sample as recoverySample, observation as recoveryObservation, recover, start as recoveryStart, W } from './helpers/recovery-fixture.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';

// Independent fixtures use the public ordered update and explicit transitions.
// They never import the verification worker's comparison helpers.
const start = Date.parse('2026-09-08T08:00:00Z'), MINUTE = 60_000;
const sourceBytes = store => ['', '-wal'].map(suffix => existsSync(store.path + suffix)
  ? createHash('sha256').update(readFileSync(store.path + suffix)).digest('hex') : null);
function fixture(t, { now = start + 600 * MINUTE, progressIntervalMs = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-model-audit-'));
  const store = new Store(join(directory, 'main.sqlite')), services = [], stores = [store];
  let selected = store;
  const open = (options = {}) => {
    const service = createModelReconstruction({ directory: join(directory, 'disposable'),
      acquire: async () => ({ store: selected, dbPath: selected.path, input: 'mqtt', role: 'slave',
        checkpoint: selected.checkpoint(), snapshotAt: now, release() {} }), clock: () => now, progressIntervalMs, ...options });
    services.push(service); service.enable?.(); return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
    for (const value of stores) await value.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, open, workPath: verificationWorkPath(join(directory, 'disposable')),
    select(value) { if (!stores.includes(value)) stores.push(value); selected = value; } };
}
function context(store, at, lossPerHour) {
  return appendLearningRecord(store, 'mqtt', 'context', { timestamp: at,
    ...(lossPerHour === undefined ? {} : { historySeed: {
      model: initialAdaptiveModel({ thermalPriors: { lossPerHour } }),
      source: { basis: 'invented-audit-model' } } }) }, { config: {} });
}
async function run(service, action = 'verify') {
  await service.action({ action, requestId: randomUUID() });
  await service.settled(); return service.status();
}
async function until(service, predicate) {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    const state = await service.status(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The isolated verification did not reach the expected state');
}

test('independent audit: mismatch diagnostics use the exact digest exclusions and never introduce a tolerance', () => {
  const expected = { version: 1, health: { acceptedFits: 3 }, model: { parameters: { lossPerHour: 0.025 } },
    checkpointDigest: 'invented-ignored-digest', historyCursor: 42,
    historyResampling: { private: 'invented-ignored-one' }, reconstruction: { private: 'invented-ignored-two' } };
  const reconstructed = { model: { parameters: { lossPerHour: 0.025 } }, health: { acceptedFits: 3 }, version: 1,
    checkpointDigest: 'other-ignored-digest', historyCursor: 99,
    historyResampling: { other: 'ignored' }, reconstruction: { other: 'ignored' } };
  assert.equal(learningCheckpointDigest(expected), learningCheckpointDigest(reconstructed));
  assert.equal(modelVerificationDifferences(expected, reconstructed).count, 0);
  reconstructed.model.parameters.lossPerHour = 0.025 + Number.EPSILON;
  assert.notEqual(learningCheckpointDigest(expected), learningCheckpointDigest(reconstructed));
  const tiny = modelVerificationDifferences(expected, reconstructed);
  assert.equal(tiny.count, 1); assert.equal(tiny.numericCount, 1); assert.equal(tiny.otherCount, 0);
  assert.deepEqual(tiny.paths, ['model.parameters.lossPerHour']);
  assert(tiny.maxAbsoluteDelta > 0 && tiny.maxRelativeDelta > 0);
});

test('independent audit: mismatch diagnostics bound output and redact private scalar values and identifier-shaped map keys', () => {
  const fixtureMapKey = 'InventedPrivateHouseholdDeviceIdentifier', privateValue = 'invented-private-value-do-not-expose';
  const expected = { model: { provenance: { [fixtureMapKey]: privateValue } },
    samples: Array.from({ length: 40 }, (_, i) => ({ inputSegments: [{ fireplaceKgPerHour: i + 0.125 }] })) };
  const reconstructed = { model: { provenance: { [fixtureMapKey]: 'different-private-value-do-not-expose' } },
    samples: Array.from({ length: 40 }, (_, i) => ({ inputSegments: [{ fireplaceKgPerHour: i + 0.25 }] })) };
  const result = modelVerificationDifferences(expected, reconstructed), text = JSON.stringify(result);
  assert.equal(result.count, 41); assert.equal(result.numericCount, 40); assert.equal(result.otherCount, 1);
  assert.equal(result.paths.length, 8); assert.equal(result.truncated, true); assert(text.length < 2048);
  assert(!text.includes(fixtureMapKey)); assert(!text.includes(privateValue)); assert(!text.includes('different-private-value-do-not-expose'));
  assert(!text.includes('expected')); assert(!text.includes('actual'));
});

test('independent audit: rounding wording is a conservative numeric-only classification independent of exact agreement', () => {
  const checkpoint = value => ({ model: { parameters: { lossPerHour: value } } });
  for (const [expected, reconstructed, qualifies] of [
    [1, 1, false],
    [1, 1 + Number.EPSILON, true],
    [0, 1e-13, true],
    [0, 1e-10, false],
    [1e8, 1e8 + 1e-8, false],
    [1, 1.001, false],
  ]) {
    const left = checkpoint(expected), right = checkpoint(reconstructed), result = modelVerificationDifferences(left, right);
    assert.equal(result.roundingConsistent, qualifies, `classification for ${expected} and ${reconstructed}`);
    if (qualifies) assert.notEqual(learningCheckpointDigest(left), learningCheckpointDigest(right), 'wording never makes unequal canonical models match');
  }
  const left = checkpoint(1), right = checkpoint(1 + Number.EPSILON);
  assert.equal(modelVerificationDifferences({ ...left, journalHash: 'invented-original' },
    { ...right, journalHash: 'invented-divergent' }).roundingConsistent, false);
  assert.equal(modelVerificationDifferences({ ...left, phase: 'normal' },
    { ...right, phase: 'reduction' }).roundingConsistent, false);
  assert.equal(modelVerificationDifferences(left, null).roundingConsistent, false);
});

for (const divergentJournal of [false, true])
  test('independent audit: tiny numeric model differences retain exact mismatch and require an intact journal for rounding wording (divergent: ' + divergentJournal + ')', async t => {
    const f = fixture(t); context(f.store, start, 0.025);
    const original = replayLearningJournal(f.store, 'mqtt'), expected = structuredClone(original);
    expected.model.parameters.lossPerHour += Number.EPSILON;
    if (divergentJournal) expected.journalHash = 'a'.repeat(64);
    expected.checkpointDigest = learningCheckpointDigest(expected); f.store.setState('adaptive:mqtt', expected);
    const before = f.store.checkpoint(), bytes = sourceBytes(f.store), state = await run(f.open());
    assert.equal(state.lastVerification?.state, 'mismatch');
    assert.equal(state.lastVerification.modelMatched, false); assert.equal(state.lastVerification.historyMatched, true);
    assert.equal(state.lastVerification.streams[0].differences.roundingConsistent, !divergentJournal);
    assert.deepEqual(f.store.getState('adaptive:mqtt'), expected);
    assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
  });

test('independent audit: saved model may lag newer committed coefficient history', async t => {
  const f = fixture(t); context(f.store, start, 0.025);
  const target = replayLearningJournal(f.store, 'mqtt');
  context(f.store, start + 15 * MINUTE, 0.055);
  replayLearningJournal(f.store, 'mqtt', target, { persistCheckpoint: false, persistCoefficients: true });
  assert(readCoefficientCoverage(f.store, { input: 'mqtt' }).cursor > target.journalCursor);
  const before = f.store.checkpoint(), bytes = sourceBytes(f.store), state = await run(f.open());
  assert.equal(state.lastVerification?.state, 'matched');
  assert.equal(state.lastVerification.journalId, target.journalCursor);
  assert.equal(state.lastVerification.modelMatched, true);
  assert.equal(state.lastVerification.historyMatched, true);
  assert.deepEqual(f.store.checkpoint(), before, 'slave verification cannot mutate source or chart history');
  assert.deepEqual(sourceBytes(f.store), bytes, 'main database and WAL bytes remain exactly unchanged');
});

test('independent audit: equal four coefficients cannot hide different complete model state', async t => {
  const f = fixture(t); context(f.store, start, 0.025);
  const expected = replayLearningJournal(f.store, 'mqtt'), damaged = structuredClone(expected);
  damaged.baselineC = 19.125; damaged.checkpointDigest = learningCheckpointDigest(damaged);
  f.store.setState('adaptive:mqtt', damaged);
  const before = f.store.checkpoint(), state = await run(f.open());
  assert.equal(state.lastVerification?.state, 'mismatch');
  assert.equal(state.lastVerification.modelMatched, false);
  assert.equal(state.lastVerification.historyMatched, true);
  assert.deepEqual(f.store.checkpoint(), before);
  assert.equal(f.store.getState('adaptive:mqtt').baselineC, 19.125, 'verification never repairs the controlling model');
});

test('independent audit: mismatch diagnostics compare the captured reference even when the main model cache changes', async t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  const correct = replayLearningJournal(f.store, 'mqtt'), captured = structuredClone(correct);
  captured.health.rejectedFits = 37; captured.checkpointDigest = learningCheckpointDigest(captured);
  f.store.setState('adaptive:mqtt', captured);
  const service = f.open(); await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 5);
  await run(service, 'pause');
  const work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  assert.equal(work.reference('mqtt').checkpointDigest, captured.checkpointDigest); work.close();
  f.store.setState('adaptive:mqtt', correct);
  const before = f.store.checkpoint(), bytes = sourceBytes(f.store), state = await run(service, 'resume');
  const result = state.lastVerification; assert.equal(result?.state, 'mismatch');
  assert.equal(result.modelMatched, false); assert.equal(result.historyMatched, true);
  assert.deepEqual(result.streams[0].differences.paths, ['health.rejectedFits']);
  assert.equal(result.streams[0].differences.count, 1); assert.equal(result.streams[0].differences.numericCount, 1);
  assert.deepEqual(result.runtime, { node: process.versions.node, v8: process.versions.v8, arch: process.arch, platform: process.platform });
  assert.equal(JSON.stringify(result).includes('"rejectedFits":37'), false, 'diagnostics contain schema paths and deltas, never the saved field payload');
  assert.deepEqual(f.store.getState('adaptive:mqtt'), correct);
  assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
});

for (const damage of ['compressed bytes', 'valid substitute', 'missing reference'])
  test('independent audit: ' + damage + ' in a fixed comparison reference fails closed without using the main cache', async t => {
    const f = fixture(t);
    for (let i = 0; i < 80; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
    const checkpoint = replayLearningJournal(f.store, 'mqtt'), service = f.open();
    await service.action({ action: 'verify', requestId: randomUUID() });
    await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 5);
    await run(service, 'pause');
    const work = new ModelVerificationWork({ path: f.workPath });
    if (damage === 'compressed bytes') work.db.prepare('UPDATE reference_models SET body=? WHERE input=?').run(Buffer.from('invented-corrupt-gzip'), 'mqtt');
    else if (damage === 'missing reference') work.db.prepare('DELETE FROM reference_models WHERE input=?').run('mqtt');
    else {
      const substitute = structuredClone(checkpoint); substitute.health.rejectedFits++;
      substitute.checkpointDigest = learningCheckpointDigest(substitute);
      const text = JSON.stringify(substitute);
      work.db.prepare('UPDATE reference_models SET body=?,digest=? WHERE input=?')
        .run(gzipSync(text), createHash('sha256').update(text).digest('hex'), 'mqtt');
    }
    work.close();
    const before = f.store.checkpoint(), bytes = sourceBytes(f.store), state = await run(service, 'resume');
    assert.equal(state.error, 'model_reconstruction_invalid'); assert.equal(state.lastVerification, null);
    assert.deepEqual(f.store.getState('adaptive:mqtt'), checkpoint);
    assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
  });

test('independent audit: fixed references and target job replace atomically when preparation fails', t => {
  const f = fixture(t); context(f.store, start, 0.025);
  const checkpoint = replayLearningJournal(f.store, 'mqtt'), work = new ModelVerificationWork({ path: f.workPath });
  try {
    const original = { id: randomUUID(), marker: 'invented-original-fixed-target' };
    work.start(original, [{ input: 'mqtt', checkpoint }]);
    const progress = { state: { cursor: 1 }, jobId: original.id }; work.save(progress);
    const replacement = { id: randomUUID(), marker: 'invented-incomplete-replacement' };
    assert.throws(() => work.start(replacement, [{ input: 'mqtt', checkpoint }, { input: 'mqtt', checkpoint }]));
    assert.deepEqual(work.get('job'), original);
    assert.deepEqual(work.progress(), progress);
    assert.deepEqual(work.reference('mqtt'), checkpoint);
  } finally { work.close(); }
});

for (const field of ['arch', 'node', 'v8', 'platform'])
  test('independent audit: saved progress from a different ' + field + ' cannot become a hybrid reconstruction', async t => {
    const f = fixture(t);
    for (let i = 0; i < 60; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
    replayLearningJournal(f.store, 'mqtt');
    const service = f.open(); await service.action({ action: 'verify', requestId: randomUUID() });
    await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 5);
    await run(service, 'pause');
    const work = new ModelVerificationWork({ path: f.workPath }), job = work.get('job');
    assert(work.progress().state.cursor > 0); job.runtime[field] = 'invented-other-' + field;
    work.transaction(() => work.set('job', job)); work.close();
    const before = f.store.checkpoint(), bytes = sourceBytes(f.store), state = await run(service, 'resume');
    assert.equal(state.error, 'model_reconstruction_invalid'); assert.equal(state.lastVerification, null);
    assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
  });

for (const key of Object.keys(MODEL_COEFFICIENT_INFO))
  test('independent audit: earlier altered ' + key + ' fails history check even when final values match', async t => {
    const f = fixture(t);
    context(f.store, start, 0.025); context(f.store, start + 15 * MINUTE, 0.055); context(f.store, start + 30 * MINUTE, 0.025);
    replayLearningJournal(f.store, 'mqtt');
    const [first, middle, last] = readCoefficientEvents(f.store, { input: 'mqtt' }); assert(first && middle && last);
    f.store.db.prepare("UPDATE coefficient_events SET coefficients=json_set(coefficients,?,?) WHERE generation=? AND cursor=?")
      .run('$.' + key + '.value', middle.coefficients[key].value + 0.123,
        readCoefficientCoverage(f.store, { input: 'mqtt' }).generation, middle.cursor);
    const before = f.store.checkpoint(), state = await run(f.open());
    assert.equal(state.lastVerification?.state, 'mismatch');
    assert.equal(state.lastVerification.modelMatched, true);
    assert.equal(state.lastVerification.historyMatched, false);
    assert.deepEqual(f.store.checkpoint(), before, 'mismatching historical series remain unchanged for investigation');
  });

test('independent audit: missing intermediate history is detected without rebuilding it', async t => {
  const f = fixture(t);
  context(f.store, start, 0.025); context(f.store, start + 15 * MINUTE, 0.055); context(f.store, start + 30 * MINUTE, 0.025);
  replayLearningJournal(f.store, 'mqtt');
  const middle = readCoefficientEvents(f.store, { input: 'mqtt' })[1];
  f.store.db.prepare('DELETE FROM coefficient_events WHERE generation=? AND cursor=?')
    .run(readCoefficientCoverage(f.store, { input: 'mqtt' }).generation, middle.cursor);
  const before = f.store.checkpoint(), state = await run(f.open());
  assert.equal(state.lastVerification?.modelMatched, true); assert.equal(state.lastVerification.historyMatched, false);
  assert.equal(readCoefficientEvents(f.store, { input: 'mqtt' }).length, 2);
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: compact event projection rejects retired and malformed persisted shapes without mutation', t => {
  const f = fixture(t); context(f.store, start, 0.025); replayLearningJournal(f.store, 'mqtt');
  const event = readCoefficientEvents(f.store, { input: 'mqtt' })[0];
  const generation = readCoefficientCoverage(f.store, { input: 'mqtt' }).generation;
  const update = f.store.db.prepare('UPDATE coefficient_events SET projection=? WHERE generation=? AND cursor=?');
  const current = JSON.parse(f.store.db.prepare('SELECT projection FROM coefficient_events WHERE generation=? AND cursor=?').get(generation, event.cursor).projection);
  assert.deepEqual(Object.keys(current).sort(), ['blocked', 'fitted', 'learned']);
  for (const projection of [
    { ...current, at: event.at, cursor: event.cursor, coefficients: event.coefficients },
    { ...current, unknown: true },
    { learned: [], fitted: [] },
    { ...current, learned: ['invented-unsupported-parameter'] },
  ]) {
    update.run(JSON.stringify(projection), generation, event.cursor);
    const before = f.store.checkpoint(), bytes = sourceBytes(f.store);
    assert.throws(() => validateCoefficientHistory(f.store.db, { full: true }), { code: 'database_state_incompatible' });
    assert.throws(() => coefficientProjectionAt(f.store, { input: 'mqtt', cursor: event.cursor }));
    assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
  }
});

test('independent audit: readonly live replay stages every intermediate event in bounded unpublished pages', async t => {
  const f = fixture(t);
  for (let i = 0; i < 520; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  const worker = new LiveLearning({ store: f.store, input: 'mqtt' }); t.after(() => worker.close());
  const pages = [], startWorker = worker.start.bind(worker);
  worker.start = () => {
    startWorker();
    worker.worker.on('message', message => { if (message?.type === 'coefficient-page') pages.push(message); });
  };
  const journal = f.store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all();
  const checkpoint = await worker.calculate('replay', { config: {} }, null);
  const batch = worker.takeCoefficientBatch(checkpoint);
  assert(batch?.coefficientGeneration, 'large tails return a compact staged-generation descriptor');
  assert.equal(batch.events, undefined); assert(JSON.stringify(batch).length < 1000);
  assert(pages.length >= 5); assert(pages.every(page => page.events.length <= 128));
  assert(pages.every(page => JSON.stringify(page).length < 256_000), 'each transferred page has bounded size');
  const events = readCoefficientEvents(f.store, { input: 'mqtt', generation: batch.coefficientGeneration });
  assert.equal(events.length, 520, 'every change survives every source page boundary');
  assert.equal(events[0].coefficients.model_coefficient_heat_loss.value, 0.02);
  assert.equal(events.at(-1).coefficients.model_coefficient_heat_loss.value, 0.02 + 519 / 100_000);
  assert.equal(readCoefficientCoverage(f.store, { input: 'mqtt' }), null, 'staged changes are never selected before publication');
  assert.equal(f.store.getState('adaptive:mqtt'), null, 'staging cannot advance the live model');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all(), journal,
    'the parent may stage derived rows but neither worker nor owner alters the learning source');
  f.store.transaction(() => {
    persistCoefficientBatch(f.store, 'mqtt', batch); worker.commitCoefficientBatch(batch);
    f.store.setState('adaptive:mqtt', checkpoint);
  });
  assert.equal(readCoefficientEvents(f.store, { input: 'mqtt' }).length, 520);
  assert.equal(f.store.getState(worker.stageKey), null);
  const state = await run(f.open()); assert.equal(state.lastVerification?.state, 'matched');
  await worker.close();
});

for (const cause of ['write failure', 'authority superseded'])
  test('independent audit: coefficient staging ' + cause + ' cannot hang or publish a partial timeline', { timeout: 20_000 }, async t => {
    const f = fixture(t); context(f.store, start, 0.025);
    const checkpoint = replayLearningJournal(f.store, 'mqtt');
    const coverage = readCoefficientCoverage(f.store, { input: 'mqtt' });
    const events = readCoefficientEvents(f.store, { input: 'mqtt' });
    for (let i = 1; i <= 260; i++) context(f.store, start + i * MINUTE, 0.03 + i / 100_000);
    const journal = f.store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all();
    const worker = new LiveLearning({ store: f.store, input: 'mqtt' }); t.after(() => worker.close());
    const original = f.store.runWrite.bind(f.store); let writes = 0, current = true;
    f.store.runWrite = async (operation, options) => {
      writes++;
      if (cause === 'write failure' && writes === 2) throw new Error('Invented parent writer rejection');
      const result = await original(operation, options);
      if (cause === 'authority superseded' && writes === 1) current = false;
      return result;
    };
    const pending = worker.calculate('replay', { config: {} }, checkpoint, { isCurrent: () => current });
    await assert.rejects(pending, { code: 'LIVE_LEARNING_FAILED' });
    await worker.close();
    assert(writes >= 2, 'the failure occurs after a generation has been staged');
    assert.deepEqual(readCoefficientCoverage(f.store, { input: 'mqtt' }), coverage);
    assert.deepEqual(readCoefficientEvents(f.store, { input: 'mqtt' }), events);
    assert.deepEqual(f.store.getState('adaptive:mqtt'), checkpoint);
    assert.equal(f.store.getState(worker.stageKey), null, 'the bounded owner cleanup retires its abandoned candidate');
    assert.deepEqual(f.store.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all(), journal);
  });

test('independent audit: charts read all four committed series without a verification working file', t => {
  const f = fixture(t);
  context(f.store, start - 30 * MINUTE, 0.025); context(f.store, start + 45 * MINUTE, 0.055);
  context(f.store, start + 20 * MINUTE, 0.085); replayLearningJournal(f.store, 'mqtt');
  const before = f.store.checkpoint();
  for (const key of Object.keys(MODEL_COEFFICIENT_INFO)) {
    const chart = getChartData({ store: f.store, input: 'mqtt', startDate: '2026-09-08', now: start + 30 * MINUTE, left: key });
    const points = chart.series[key].filter(point => point.y !== null); assert(points.length > 0);
    if (key === 'model_coefficient_heat_loss') assert(points.every(point => point.y === 0.025),
      'a backdated dependent tail cannot bypass its first future journal entry');
  }
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: cancellation and discard preserve main chart history', async t => {
  const f = fixture(t);
  for (let i = 0; i < 200; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  replayLearningJournal(f.store, 'mqtt');
  const before = f.store.checkpoint(), timeline = readCoefficientEvents(f.store, { input: 'mqtt' }), service = f.open();
  await service.action({ action: 'verify', requestId: randomUUID() }); await until(service, value => value.state === 'running');
  await run(service, 'cancel'); await run(service, 'discard');
  assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(readCoefficientEvents(f.store, { input: 'mqtt' }), timeline);
});

test('independent audit: paused verification resumes its own exact checkpoint after restart', async t => {
  const f = fixture(t);
  for (let i = 0; i < 250; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  replayLearningJournal(f.store, 'mqtt');
  const before = f.store.checkpoint(), service = f.open();
  await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.state === 'running' && value.job?.phase === 'replaying' && value.job?.processed >= 5);
  const paused = await run(service, 'pause'); assert.equal(paused.state, 'paused');
  let work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  const savedCursor = work.progress().state.cursor; work.close(); assert(savedCursor > 0 && savedCursor < 250);
  await service.close(); const restarted = f.open(); assert.equal((await restarted.status()).state, 'paused');
  const state = await run(restarted, 'resume'); assert.equal(state.lastVerification?.state, 'matched');
  assert.equal(state.lastVerification.streams[0].resumedFrom, savedCursor);
  work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  try { assert(work.db.prepare('SELECT COUNT(*) n FROM checkpoints').get().n <= 2); } finally { work.close(); }
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: an unpaused interrupted verification resumes automatically after service restart', async t => {
  const f = fixture(t);
  for (let i = 0; i < 120; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  replayLearningJournal(f.store, 'mqtt');
  const before = f.store.checkpoint(), bytes = sourceBytes(f.store), service = f.open();
  await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job?.processed >= 5);
  await service.close();
  const work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  const cursor = work.progress().state.cursor; work.close(); assert(cursor > 0 && cursor < 120);
  const restarted = f.open({ pollMs: 10 });
  const state = await until(restarted, value => value.lastVerification?.state === 'matched');
  assert.equal(state.lastVerification.streams[0].resumedFrom, cursor);
  assert.deepEqual(f.store.checkpoint(), before); assert.deepEqual(sourceBytes(f.store), bytes);
});

for (const action of ['pause', 'cancel', 'close'])
  test('independent audit: a stuck read-only worker cannot hang ' + action, async t => {
    const f = fixture(t); context(f.store, start, 0.025); replayLearningJournal(f.store, 'mqtt');
    let terminations = 0;
    class StuckWorker extends EventEmitter {
      postMessage() {}
      async terminate() { terminations++; queueMicrotask(() => this.emit('exit', 1)); return 1; }
    }
    const before = f.store.checkpoint(), service = f.open({ stopTimeoutMs: 25, workerFactory: () => new StuckWorker() });
    await service.action({ action: 'verify', requestId: randomUUID() });
    const at = performance.now();
    if (action === 'close') await service.close(); else await run(service, action);
    assert(performance.now() - at < 1000, 'forced stop is bounded');
    assert.equal(terminations, 1); assert.deepEqual(f.store.checkpoint(), before);
    if (action !== 'close') {
      const state = await service.status();
      assert.equal(state.state, action === 'pause' ? 'paused' : 'idle');
      assert.equal(state.error, null);
    }
  });

test('independent audit: valid independent progress resumes after transaction ancestry is compacted', async t => {
  const f = fixture(t);
  for (let i = 0; i < 200; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  replayLearningJournal(f.store, 'mqtt');
  const service = f.open(); await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 5);
  await run(service, 'pause');
  const work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  const cursor = work.progress().state.cursor, boundary = work.get('job').targets[0].source.database.sequence; work.close();
  for (let i = 0; i < 6; i++) f.store.setState('invented-forward-bookkeeping', { i });
  f.store.compactJournal({ maxBytes: 1024 * 1024, maxCommits: 1 });
  assert(f.store.journalBase().sequence > boundary);
  const before = f.store.checkpoint(), state = await run(service, 'resume');
  assert.equal(state.lastVerification?.state, 'matched');
  assert.equal(state.lastVerification.streams[0].resumedFrom, cursor);
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: same-inode divergent middle history cannot reuse paused progress after ancestry compaction', async t => {
  const f = fixture(t); context(f.store, start, 0.025); replayLearningJournal(f.store, 'mqtt');
  const forkPath = join(f.directory, 'fork.sqlite');
  await createSourceSnapshot({ dbPath: f.store.path, destination: forkPath, signal: t.signal });
  const fork = new Store(forkPath); f.select(fork); f.select(f.store);
  context(f.store, start + MINUTE, 0.035);
  for (let i = 2; i < 150; i++) context(f.store, start + i * MINUTE);
  const original = replayLearningJournal(f.store, 'mqtt'), service = f.open();
  await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 5);
  await run(service, 'pause');
  const work = new ModelVerificationWork({ path: f.workPath, readOnly: true });
  const boundary = work.get('job').targets[0].source.database.sequence; work.close();
  context(fork, start + MINUTE, 0.075);
  for (let i = 2; i < 150; i++) context(fork, start + i * MINUTE);
  const replacement = replayLearningJournal(fork, 'mqtt');
  assert.equal(replacement.journalCursor, original.journalCursor);
  assert.equal(replacement.journalEntryHash, original.journalEntryHash);
  assert.notEqual(replacement.journalHash, original.journalHash);
  for (let i = 0; i < 8; i++) fork.setState('invented-forward-bookkeeping', { i });
  fork.compactJournal({ maxBytes: 1024 * 1024, maxCommits: 1 }); assert(fork.journalBase().sequence > boundary);
  const image = join(f.directory, 'replacement-image.sqlite');
  await createSourceSnapshot({ dbPath: fork.path, destination: image, signal: t.signal });
  await f.store.close(); copyFileSync(image, f.store.path);
  const current = new Store(f.store.path); f.select(current);
  const before = current.checkpoint(), state = await run(service, 'resume');
  assert.equal(state.state, 'superseded'); assert.equal(state.error, 'model_reconstruction_source_changed');
  assert.notEqual(state.lastVerification?.state, 'matched');
  assert.deepEqual(current.checkpoint(), before);
});

test('independent audit: same-time transitions survive lagged and coalesced model cache saves', async t => {
  const f = fixture(t); context(f.store, start, 0.025);
  const first = replayLearningJournal(f.store, 'mqtt');
  context(f.store, start, 0.055);
  const second = replayLearningJournal(f.store, 'mqtt', first, { persistCheckpoint: false, persistCoefficients: true });
  context(f.store, start, 0.075);
  const third = replayLearningJournal(f.store, 'mqtt', second, { persistCheckpoint: false, persistCoefficients: true });
  const timeline = readCoefficientEvents(f.store, { input: 'mqtt' });
  assert.deepEqual(timeline.map(event => event.at), [start, start, start]);
  assert.deepEqual(timeline.map(event => event.coefficients.model_coefficient_heat_loss.value), [0.025, 0.055, 0.075]);
  const service = f.open(), old = await run(service);
  assert.equal(old.lastVerification?.state, 'matched'); assert.equal(old.lastVerification.journalId, first.journalCursor);
  const cache = new LearningCheckpointCache({ store: f.store, input: 'mqtt' }); t.after(() => cache.close());
  assert.equal(cache.save(second), true); assert.equal(cache.save(third), true);
  await cache.flush(); assert.equal(f.store.getState('adaptive:mqtt').journalCursor, third.journalCursor);
  assert.deepEqual(readCoefficientEvents(f.store, { input: 'mqtt' }), timeline);
  assert.equal((await run(service)).lastVerification?.state, 'matched');
  await cache.close();
});

test('independent audit: a damaged newest rolling checkpoint falls back to the older independent point', async t => {
  const f = fixture(t);
  for (let i = 0; i < 200; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  replayLearningJournal(f.store, 'mqtt');
  const service = f.open(); await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 8);
  await run(service, 'pause');
  const work = new ModelVerificationWork({ path: f.workPath });
  const [newest, older] = work.db.prepare('SELECT * FROM checkpoints ORDER BY serial DESC').all();
  assert(newest && older);
  const body = Buffer.from(newest.body); body[body.length - 1] ^= 1;
  work.transaction(() => work.db.prepare('UPDATE checkpoints SET body=? WHERE slot=?').run(body, newest.slot));
  work.close();
  const before = f.store.checkpoint(), state = await run(service, 'resume');
  assert.equal(state.lastVerification?.state, 'matched');
  assert.equal(state.lastVerification.streams[0].resumedFrom, older.cursor);
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: a main model checkpoint cannot substitute for an earlier independent progress point', async t => {
  const f = fixture(t);
  for (let i = 0; i < 200; i++) context(f.store, start + i * MINUTE, 0.02 + i / 100_000);
  const checkpoint = replayLearningJournal(f.store, 'mqtt'), service = f.open();
  await service.action({ action: 'verify', requestId: randomUUID() });
  await until(service, value => value.job?.phase === 'replaying' && value.job.processed >= 8);
  await run(service, 'pause');
  const work = new ModelVerificationWork({ path: f.workPath }), progress = work.progress();
  assert(progress.state.cursor < checkpoint.journalCursor);
  progress.state.checkpoint = checkpoint;
  work.save(progress); work.close();
  const before = f.store.checkpoint(), state = await run(service, 'resume');
  assert.equal(state.error, 'model_reconstruction_invalid');
  assert.notEqual(state.lastVerification?.state, 'matched'); assert.deepEqual(f.store.checkpoint(), before);
});

for (const previousLog of [false, true])
  test('independent audit: later unconsumed firewood leaves the fixed saved model verifiable (prior log: ' + previousLog + ')', async t => {
    const f = fixture(t);
    if (previousLog) addFireplace(f.store, 'mqtt', { requestId: 'invented-earlier-load', kg: 4 }, start - MINUTE);
    context(f.store, start, 0.025); const checkpoint = replayLearningJournal(f.store, 'mqtt');
    assert.equal(checkpoint.fireplaceRevision ?? 0, previousLog ? 1 : 0);
    const later = addFireplace(f.store, 'mqtt', { requestId: 'invented-later-load', kg: 4 }, start + 60 * MINUTE);
    assert.equal(later.requiresRebuild, false);
    const before = f.store.checkpoint(), state = await run(f.open());
    assert.equal(state.lastVerification?.state, 'matched', JSON.stringify({ state: state.state, error: state.error, last: state.lastVerification }));
    assert.deepEqual(f.store.checkpoint(), before);
  });

test('independent audit: an unprocessed committed learning tail cannot appear as current coefficient history', t => {
  const f = fixture(t); context(f.store, start, 0.025); replayLearningJournal(f.store, 'mqtt');
  const nextAt = start + 15 * MINUTE; context(f.store, nextAt, 0.055);
  const before = f.store.checkpoint();
  const chart = getChartData({ store: f.store, input: 'mqtt', startDate: '2026-09-08',
    now: start + 30 * MINUTE, left: 'model_coefficient_heat_loss' });
  assert.equal(chart.meta.modelCoefficients.state, 'behind');
  const finite = chart.series.model_coefficient_heat_loss.filter(point => point.y !== null);
  assert(finite.length > 0 && finite.every(point => point.x < nextAt),
    'prepared values end before the first unapplied model transition');
  assert(chart.series.model_coefficient_heat_loss.some(point => point.x >= nextAt && point.y === null));
  assert.deepEqual(f.store.checkpoint(), before);
});

test('independent audit: future firewood cannot force ordinary live learning to replay its unchanged historical prefix', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) context(f.store, start + i * MINUTE, i ? undefined : 0.025);
  const checkpoint = replayLearningJournal(f.store, 'mqtt');
  const event = addFireplace(f.store, 'mqtt', { requestId: 'invented-future-load', kg: 4 }, start + 200 * MINUTE);
  assert.equal(event.requiresRebuild, false);
  const batches = [], priorEvents = readCoefficientEvents(f.store, { input: 'mqtt' });
  const next = replayLearningJournal(f.store, 'mqtt', checkpoint, { persistCheckpoint: false, onCoefficientBatch: batch => batches.push(batch) });
  const expected = replayLearningJournal(f.store, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  assert.deepEqual(next, expected, 'a proven revision-only prefix update remains exactly reconstructible');
  assert.equal(batches.length, 1, 'only the new revision metadata requires publication');
  assert.deepEqual(batches[0].events, [], 'no unchanged numerical input is re-applied during an ordinary live update');
  assert.equal(batches[0].baseCursor, checkpoint.journalCursor);
  assert.equal(batches[0].cursor, checkpoint.journalCursor);
  assert.equal(batches[0].reusedPrefixCursor, checkpoint.journalCursor);
  f.store.transaction(() => {
    persistCoefficientBatch(f.store, 'mqtt', batches[0]); f.store.setState('adaptive:mqtt', next);
  });
  assert.deepEqual(readCoefficientEvents(f.store, { input: 'mqtt' }), priorEvents);
  assert.equal(readCoefficientCoverage(f.store, { input: 'mqtt' }).fireplaceRevision, next.fireplaceRevision);
});

test('independent audit: recovery, revert and restore retain fully verifiable coefficient history and concurrent local changes', async t => {
  const f = recoveryFixture(t), now = recoveryStart + 10 * W;
  context(f.master, recoveryStart, 0.02); recoverySample(f.master, recoveryStart + W);
  const initial = replayLearningJournal(f.master, 'mqtt'), donor = await f.donor();
  context(donor, recoveryStart + 2 * W, 0.04); recoverySample(donor, recoveryStart + 3 * W);
  replayLearningJournal(donor, 'mqtt');
  context(f.master, recoveryStart + 4 * W, 0.06); recoverySample(f.master, recoveryStart + 5 * W);
  const old = replayLearningJournal(f.master, 'mqtt', initial);
  const service = createModelReconstruction({ directory: join(f.directory, 'disposable'), clock: () => now, progressIntervalMs: 1,
    acquire: async () => ({ store: f.master, dbPath: f.master.path, input: 'mqtt', role: 'slave',
      checkpoint: f.master.checkpoint(), snapshotAt: now, release() {} }) });
  t.after(() => service.close()); service.enable();
  const verify = async () => {
    const before = f.master.checkpoint(), state = await run(service);
    assert.equal(state.lastVerification?.state, 'matched');
    assert.equal(state.lastVerification.modelMatched, true); assert.equal(state.lastVerification.historyMatched, true);
    assert.deepEqual(f.master.checkpoint(), before);
  };
  await verify();
  let appended = false;
  const result = await recover(f, await f.snapshot(donor), { onProgress(value) {
    if (!appended && value.phase === 'rebuilding') {
      appended = true;
      f.master.transaction(() => {
        context(f.master, recoveryStart + 6 * W, 0.08);
        replayLearningJournal(f.master, 'mqtt', old);
      });
    }
  } });
  assert.equal(appended, true); await verify();
  for (const active of [false, true]) {
    for (let i = 0; i < 4; i++) f.master.setState('invented-expiring-bookkeeping', { i, active });
    f.master.compactJournal({ maxBytes: 1024 * 1024, maxCommits: 1 });
    const args = { store: f.master, input: 'mqtt', recoveryId: result.report.recoveryId, active, signal: t.signal };
    await reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
    await verify();
    const events = readCoefficientEvents(f.master, { input: 'mqtt' });
    assert.equal(events.some(event => event.coefficients.model_coefficient_heat_loss.value === 0.04), active);
    assert.equal(events.at(-1).coefficients.model_coefficient_heat_loss.value, 0.08);
  }
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  await service.close();
});

test('independent audit: observation-only reversal cannot force a future-only coefficient revision to replay historical learning', async t => {
  const f = recoveryFixture(t);
  for (let i = 0; i < 30; i++) context(f.master, recoveryStart + i * MINUTE, i ? undefined : 0.025);
  const checkpoint = replayLearningJournal(f.master, 'mqtt'), donor = await f.donor();
  recoveryObservation(donor, recoveryStart + 50 * MINUTE, 22);
  const result = await recover(f, await f.snapshot(donor));
  const args = { store: f.master, input: 'mqtt', recoveryId: result.report.recoveryId, active: false, signal: t.signal };
  await reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
  assert.deepEqual(f.master.getState('adaptive:mqtt'), checkpoint);
  addFireplace(f.master, 'mqtt', { requestId: 'invented-future-load-after-observation-reversal', kg: 4 }, recoveryStart + 60 * MINUTE);
  const batches = [], next = replayLearningJournal(f.master, 'mqtt', checkpoint, {
    persistCheckpoint: false, onCoefficientBatch: batch => batches.push(batch) });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].baseCursor, checkpoint.journalCursor, 'an observation-only selection change does not invalidate a proven learning prefix');
  assert.equal(batches[0].reusedPrefixCursor, checkpoint.journalCursor);
  assert.deepEqual(batches[0].events, []);
  assert.deepEqual(next, replayLearningJournal(f.master, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
});
