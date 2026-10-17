import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { replayLearningJournal, validLearningCheckpoint, learningCheckpointDigest } from '../src/app/committed-learning.js';
import { immutableValue, isImmutableValue, copyOwnedValue } from '../src/domain/immutable.js';

const START = Date.parse('2026-10-01T12:00:00Z'), WINDOW = 900_000;

async function fixture(t) {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'mqtt', settings: {} }, clock: () => START + 2 * WINDOW });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await Promise.all([engine.charging.close(), engine.garage.close({ restore: false }),
      engine.closeFireplace(), engine.executor.close({ restore: false })]);
    store.close();
  });
  const sample = at => appendLearningRecord(store, 'mqtt', 'sample', {
    timestamp: at, indoorC: 21, outdoorC: 3, phase: 'normal', regime: 'occupied',
    quality: [], actualModeKnown: false, thermalCompressorDuty: null, thermalAuxKw: null,
  }, { config: engine.control });
  sample(START);
  return { store, engine, sample };
}

test('an unchanged Engine checkpoint reuses verified immutable state and its digest', async t => {
  const { store, engine } = await fixture(t);
  const expected = replayLearningJournal(store, 'mqtt', null, { persistCheckpoint: false });
  const owned = engine.readAdaptive(START);
  assert.deepEqual(owned, expected);
  assert.equal(isImmutableValue(owned), true);
  assert.equal(isImmutableValue(owned.samples[0].inputSegments), true);
  assert.equal(validLearningCheckpoint(owned), true);
  const keys = Object.keys;
  let modelTraversals = 0;
  t.mock.method(Object, 'keys', value => {
    if (value === owned.model) modelTraversals++;
    return keys(value);
  });
  for (let n = 0; n < 4; n++) {
    assert.strictEqual(engine.readAdaptive(START + n), owned);
    assert.equal(validLearningCheckpoint(owned), true);
  }
  assert.equal(modelTraversals, 0, 'unchanged owned state does not canonicalize the model again');
  assert.throws(() => { owned.model.parameters.lossPerHour = 99; }, TypeError);
  const rollback = copyOwnedValue({ checkpoint: owned, settings: engine.settings });
  assert.strictEqual(rollback.checkpoint, owned);
  assert.notStrictEqual(rollback.settings, engine.settings);
});

test('new journal input creates a detached complete checkpoint with the same reconstruction', async t => {
  const { store, engine, sample } = await fixture(t);
  const previous = engine.readAdaptive(START);
  const before = structuredClone(previous);
  sample(START + WINDOW);
  const next = engine.readAdaptive(START + WINDOW);
  assert.notStrictEqual(next, previous);
  assert.deepEqual(previous, before);
  assert.deepEqual(next, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  assert.equal(validLearningCheckpoint(next), true);
});

test('foreign freezing cannot cache a mutable model or bless a corrupted digest', async t => {
  const { store } = await fixture(t);
  const source = replayLearningJournal(store, 'mqtt', null, { persistCheckpoint: false });
  const shallow = Object.freeze(structuredClone(source));
  assert.equal(isImmutableValue(shallow), false);
  assert.equal(validLearningCheckpoint(shallow), true);
  shallow.model.parameters.lossPerHour *= 2;
  assert.equal(validLearningCheckpoint(shallow), false);
  const corrupt = immutableValue({ ...source, checkpointDigest: '0'.repeat(64) });
  assert.equal(validLearningCheckpoint(corrupt), false);
  assert.equal(learningCheckpointDigest(corrupt), learningCheckpointDigest(source));
});

test('rollback retains the exact owned checkpoint and mutable control aliases', async t => {
  const { store, engine, sample } = await fixture(t);
  const previous = engine.readAdaptive(START), baseline = structuredClone(previous);
  t.mock.method(engine.automation, 'reconcileTargets', () => { throw Error('Synthetic tick rollback'); });
  await assert.rejects(store.runWrite(() => engine.tick()), /Synthetic tick rollback/);
  assert.strictEqual(engine.checkpoint, previous);
  assert.deepEqual(engine.checkpoint, baseline);
  sample(START + WINDOW);
  assert.notStrictEqual(engine.readAdaptive(START + WINDOW), previous);
});
