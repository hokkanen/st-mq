import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { committedLearningSample, recordLearningContext, latestLearningControlContext } from '../src/app/committed-learning.js';

const START = Date.parse('2026-10-15T12:00:00Z');
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = START;
  const engine = { store, config: { input: 'mqtt' }, control: {}, checkpoint: null, clock: () => now };
  recordLearningContext(store, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21,
    roomBoostC: 0, floorOverrideMode: 'off', treatmentKey: 'normal', dhwrActive: false }, START);
  return { store, at: value => { now = value; },
    record: (mode, at) => Engine.prototype.recordFloorLearningMode.call(engine, { mode, at }) };
}

test('a manual GPIO pulse between controller ticks remains excluded in committed learning inputs', t => {
  const f = fixture(t);
  f.at(START + 10_000); f.record('unknown', START + 10_000);
  f.at(START + 12_000); f.record('partial', START + 12_000);
  f.at(START + 20_000); f.record('off', START + 20_000);
  const sample = committedLearningSample({ store: f.store, input: 'mqtt', at: START + 900_000, config: {} });
  assert(sample.inputSegments.some(row => row.floorOverrideMode === 'unknown'
    && row.start === START + 10_000 && row.end === START + 12_000));
  assert(sample.inputSegments.some(row => row.floorOverrideMode === 'partial'
    && row.start === START + 12_000 && row.end === START + 20_000));
  assert.equal(latestLearningControlContext(f.store, 'mqtt').context.phase, 'normal');
});

test('late GPIO evidence cannot backdate or overwrite committed control history', t => {
  const f = fixture(t);
  f.at(START + 20_000); f.record('partial', START + 20_000);
  const before = f.store.learningJournal({ input: 'mqtt', limit: 100 });
  f.at(START + 30_000); f.record('off', START + 15_000);
  const after = f.store.learningJournal({ input: 'mqtt', limit: 100 });
  assert.deepEqual(after.slice(0, before.length), before);
  const latest = latestLearningControlContext(f.store, 'mqtt');
  assert.equal(latest.at, START + 30_000);
  assert.equal(latest.context.floorOverrideMode, 'unknown');
});

test('floor context and the observation transaction roll back together', t => {
  const f = fixture(t);
  const before = f.store.learningJournal({ input: 'mqtt', limit: 100 });
  f.at(START + 10_000);
  assert.throws(() => f.store.transaction(() => {
    f.record('partial', START + 10_000);
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.deepEqual(f.store.learningJournal({ input: 'mqtt', limit: 100 }), before);
});
