import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { replayLearningJournal, replayLearningJournalSteps, applyLearningRecord, learningCheckpointDigest } from '../src/app/committed-learning.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { sensorLearningContext } from '../src/app/sensor-inputs.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { readCoefficientCoverage } from '../src/storage/coefficient-history.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const T = Date.UTC(2026, 8, 1), HOUR = 3_600_000, W = HOUR / 4;
const noPersistence = { persistCheckpoint: false, persistCoefficients: false };
const context = (store, at, changes = {}) => appendLearningRecord(store, 'mqtt', 'context',
  { timestamp: at, phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0, ...changes });
const sample = (store, at, changes = {}) => appendLearningRecord(store, 'mqtt', 'sample', {
  timestamp: at, windowStart: at - W, windowEnd: at, indoorC: 21, outdoorC: 0, solarRadiationWm2: 0,
  phase: 'normal', roomBoostC: 0, targetC: 21, regime: 'occupied', quality: [],
  energyBasis: 'estimated', actualModeKnown: false, ...changes });
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }
function tracked(store) {
  const state = { hydrations: 0, hydratedRows: 0, heads: [], revisions: [] };
  const reader = { getState: store.getState.bind(store), learningJournal: store.learningJournal.bind(store), db: { prepare(sql) {
    const statement = store.db.prepare(sql);
    return Object.fromEntries(['get', 'all', 'iterate'].map(method => [method, (...args) => {
      const result = statement[method](...args);
      if (sql.includes('SELECT id,at,kind,kg,target_id FROM active_fireplace_events')) {
        state.hydrations++; state.hydratedRows += result.length; state.revisions.push(args[1]);
      }
      if (sql.includes('SELECT id FROM active_fireplace_events') && sql.includes('ORDER BY id DESC LIMIT 1'))
        state.heads.push({ args, plan: store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail) });
      return result;
    }]));
  } } };
  return { reader, state };
}
function replay(reader, checkpoint, options = {}) {
  const batches = [], result = replayLearningJournal(reader, 'mqtt', checkpoint,
    { ...noPersistence, ...options, onCoefficientBatch: batch => batches.push(batch) });
  return { result, batches };
}
function manualRows(store, count) {
  const insert = store.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt',?,?,'load',2)");
  for (let start = 0; start < count; start += 128) store.transaction(() => {
    for (let n = start; n < Math.min(count, start + 128); n++) insert.run(`invented-${n}`, T - (n + 1) * 6 * HOUR);
  });
}

test('a current no-op replay seeks the source head without hydrating a growing manual archive', t => {
  for (const count of [1000, 30000]) {
    const store = fixture(t); manualRows(store, count); context(store, T);
    const checkpoint = replayLearningJournal(store, 'mqtt', null, noPersistence), before = store.checkpoint();
    const { reader, state } = tracked(store), began = performance.now();
    const { result, batches } = replay(reader, checkpoint);
    assert.equal(result, checkpoint); assert.deepEqual(batches, []);
    assert.equal(state.hydrations, 0); assert.equal(state.hydratedRows, 0); assert.equal(state.heads.length, 1);
    assert(state.heads[0].plan.some(detail => /fireplace_events_input_id/.test(detail)));
    assert(!state.heads[0].plan.some(detail => /TEMP B-TREE|SCAN r/.test(detail)));
    assert.deepEqual(store.checkpoint(), before);
    t.diagnostic(JSON.stringify({ manualRows: count, hydratedRows: state.hydratedRows, elapsedMs: performance.now() - began }));
  }
});

test('a real multi-page tail hydrates once at the captured revision and preserves exact canonical application', t => {
  const store = fixture(t);
  addFireplace(store, 'mqtt', { kg: 2, requestId: 'invented-initial-load' }, T - HOUR);
  context(store, T); sample(store, T + W);
  const checkpoint = replayLearningJournal(store, 'mqtt');
  for (let n = 2; n <= 8; n++) sample(store, T + n * W, { indoorC: 21 + n / 100 });
  const entries = store.learningJournal({ input: 'mqtt', after: checkpoint.journalCursor });
  const source = { ...fireplaceLearningContext(store, 'mqtt'), ...sensorLearningContext(store, 'mqtt') };
  const expected = entries.reduce((prior, entry) => applyLearningRecord(prior, entry, source), checkpoint);
  const { reader, state } = tracked(store), steps = replayLearningJournalSteps(reader, 'mqtt', checkpoint,
    { ...noPersistence, pageSize: 2 }), batches = [];
  let step = steps.next(); assert.equal(step.done, false); batches.push(step.value);
  // Source appends between pages cannot change an already captured interpretation.
  addFireplace(store, 'mqtt', { kg: 3, requestId: 'invented-later-source' }, T + 10 * HOUR);
  while (!(step = steps.next()).done) batches.push(step.value);
  assert.deepEqual(step.value, expected);
  assert.equal(state.hydrations, 1); assert.deepEqual(state.revisions, [source.fireplaceRevision]);
  assert.deepEqual(batches.map(batch => batch.cursor), [entries[1].id, entries[3].id, entries[5].id, entries[6].id]);
  assert.deepEqual(batches.map(batch => batch.baseCursor), [checkpoint.journalCursor, entries[1].id, entries[3].id, entries[5].id]);
  assert(batches.every(batch => batch.fireplaceRevision === source.fireplaceRevision));
  const rebuilt = replayLearningJournal(store, 'mqtt', null, { ...noPersistence, rebuild: true, fireplaceRevision: source.fireplaceRevision });
  assert.deepEqual(step.value, rebuilt);
});

test('forward-only source revision publication reuses the exact prefix without loading its event arrays', t => {
  const store = fixture(t); context(store, T); sample(store, T + W);
  const checkpoint = replayLearningJournal(store, 'mqtt'), coverage = readCoefficientCoverage(store, { input: 'mqtt' });
  const load = addFireplace(store, 'mqtt', { kg: 2, requestId: 'invented-future-only' }, T + HOUR);
  const { reader, state } = tracked(store), { result, batches } = replay(reader, checkpoint);
  const expected = { ...checkpoint, fireplaceRevision: load.revision }; expected.checkpointDigest = learningCheckpointDigest(expected);
  assert.deepEqual(result, expected); assert.equal(state.hydrations, 0);
  assert.equal(batches.length, 1); assert.deepEqual(batches[0].events, []);
  assert.equal(batches[0].reusedPrefixCursor, checkpoint.journalCursor);
  assert.equal(batches[0].baseCursor, checkpoint.journalCursor); assert.equal(batches[0].cursor, checkpoint.journalCursor);
  assert.equal(batches[0].fireplaceRevision, load.revision);
  assert.deepEqual(readCoefficientCoverage(store, { input: 'mqtt' }), coverage, 'Read-only replay does not publish the replacement generation');
  const published = replayLearningJournal(store, 'mqtt', checkpoint);
  assert.deepEqual(published, expected); assert.equal(readCoefficientCoverage(store, { input: 'mqtt' }).fireplaceRevision, load.revision);
  const again = tracked(store); assert.equal(replay(again.reader, published).result, published); assert.equal(again.state.hydrations, 0);
});

for (const correction of ['load', 'remove']) test(`an earlier ${correction} invalidates the prefix and hydrates before rebuilding`, t => {
  const store = fixture(t);
  const load = addFireplace(store, 'mqtt', { kg: 2, requestId: 'invented-before' }, T - HOUR);
  context(store, T); sample(store, T + W); const checkpoint = replayLearningJournal(store, 'mqtt');
  if (correction === 'remove') removeFireplace(store, 'mqtt', { id: load.id, requestId: 'invented-remove' }, T + 2 * W);
  else addFireplace(store, 'mqtt', { kg: 3, requestId: 'invented-retrospective' }, T - HOUR / 2);
  const { reader, state } = tracked(store), { result, batches } = replay(reader, checkpoint);
  assert.equal(state.hydrations, 1); assert.equal(batches[0].baseCursor, 0);
  assert.deepEqual(result, replayLearningJournal(store, 'mqtt', null, { ...noPersistence, rebuild: true }));
});

test('bounded source revisions, selected exclusions and held recovery retain their original meanings', t => {
  const store = fixture(t);
  const first = addFireplace(store, 'mqtt', { kg: 2, requestId: 'invented-first' }, T - HOUR);
  const excluded = addFireplace(store, 'mqtt', { kg: 3, requestId: 'invented-excluded' }, T - HOUR / 2);
  store.transaction(() => store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','fireplace_events',?)")
    .run(String(excluded.id)));
  context(store, T); sample(store, T + W); const checkpoint = replayLearningJournal(store, 'mqtt');
  assert.equal(checkpoint.fireplaceRevision, first.revision);
  const current = tracked(store); assert.equal(replay(current.reader, checkpoint).result, checkpoint); assert.equal(current.state.hydrations, 0);
  addFireplace(store, 'mqtt', { kg: 4, requestId: 'invented-new' }, T + 2 * W);
  context(store, T + 3 * W);
  const bounded = tracked(store), expected = replayLearningJournal(store, 'mqtt', null,
    { ...noPersistence, rebuild: true, fireplaceRevision: first.revision });
  assert.deepEqual(replay(bounded.reader, checkpoint, { fireplaceRevision: first.revision }).result, expected);
  assert.deepEqual(bounded.state.revisions, [first.revision]);
  store.setState('recovery:active:mqtt', { status: 'importing' });
  const held = tracked(store); assert.deepEqual(replay(held.reader, checkpoint).result, expected);
  assert.deepEqual(held.state.revisions, [first.revision]);
  const cut = tracked(store); assert.equal(replay(cut.reader, checkpoint, { through: checkpoint.journalCursor }).result, checkpoint);
  assert.equal(cut.state.hydrations, 0, 'Unconsumed entries beyond the explicit boundary do not consume context');
});

test('an invalid checkpoint anchor still rebuilds and an empty rebuild does not need firewood arrays', t => {
  const store = fixture(t); manualRows(store, 10); context(store, T);
  const checkpoint = replayLearningJournal(store, 'mqtt'), corrupt = { ...checkpoint, checkpointDigest: 'invalid' };
  const failedAnchor = tracked(store), result = replay(failedAnchor.reader, corrupt).result;
  assert.deepEqual(result, checkpoint); assert.equal(failedAnchor.state.hydrations, 1);
  const empty = fixture(t); manualRows(empty, 10);
  const { reader, state } = tracked(empty);
  assert.deepEqual(replay(reader, checkpoint, { rebuild: true }).result, restoreAdaptiveCheckpoint(null));
  assert.equal(state.hydrations, 0);
});
