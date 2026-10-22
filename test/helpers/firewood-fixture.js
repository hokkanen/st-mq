import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/store.js';
import { initialAdaptiveModel } from '../../src/control/adaptive-learning.js';
import { applyLearningRecord, learningCheckpointDigest } from '../../src/app/committed-learning.js';
import { fireplaceLearningContext } from '../../src/app/fireplace-inputs.js';
import { addFireplace } from '../../src/app/fireplace.js';
import { FirewoodProjectionCache } from '../../src/app/firewood-projection-cache.js';
import { getFirewoodBenefit, maintainFirewoodProjection } from '../../src/app/firewood-benefit.js';
import { appendLearningRecord } from './home-learning-fixture.js';

export const HOUR = 3_600_000, DAY = 24 * HOUR, WINDOW = HOUR / 4, START = Date.UTC(2026, 0, 1);

/** Current synthetic source with a separately disposable comparison cache. */
export function firewoodFixture(t, { days = 10, file = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-firewood-incremental-'));
  const path = join(directory, 'synthetic.sqlite'), source = new Store(file ? path : ':memory:');
  let projection = new FirewoodProjectionCache(path);
  const model = initialAdaptiveModel(); model.trainedAt = new Date(START - DAY).toISOString();
  const seed = { version: 1, samples: [], model, baselineC: 21 };
  const loads = [addFireplace(source, 'mqtt', { kg: 8, requestId: 'first-synthetic-load' }, START),
    addFireplace(source, 'mqtt', { kg: 8, requestId: 'second-synthetic-load' }, START + 2 * DAY)];
  function append(index) {
    const at = START + index * WINDOW;
    return appendLearningRecord(source, 'mqtt', 'sample', { timestamp: at, windowStart: at - WINDOW,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, targetC: 21, phase: 'normal', regime: 'occupied', quality: [],
      compressorDuty: 1, thermalCompressorDuty: 1, auxKw: 0, thermalAuxKw: 0,
      actualModeKnown: true, compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true }, { seed });
  }
  for (let i = 0; i <= days * 96; i++) append(i);
  // Fix the selected model at a canonical first-entry checkpoint. These tests
  // exercise comparison reuse while inputs accumulate, not fitting throughput.
  let checkpoint = applyLearningRecord(null, source.learningJournal({ input: 'mqtt', limit: 1 })[0], fireplaceLearningContext(source, 'mqtt'));
  checkpoint.model = structuredClone(model);
  function saveModel(change = () => {}) {
    checkpoint = structuredClone(checkpoint); change(checkpoint.model, checkpoint);
    checkpoint.checkpointDigest = learningCheckpointDigest(checkpoint);
    source.setState('adaptive:mqtt', checkpoint);
    return checkpoint;
  }
  saveModel();
  const now = START + days * DAY;
  const args = { store: source, input: 'mqtt', now, range: { from: now - DAY, to: now },
    priceIntervals: [{ start: now - DAY, end: now, price: 20 }] };
  source.firewoodProjection = projection;
  t.after(() => { projection.close(); source.close(); rmSync(directory, { recursive: true, force: true }); });
  return { source, path, args, loads, append, saveModel,
    get projection() { return projection; },
    reopen() { projection.close(); projection = new FirewoodProjectionCache(path); source.firewoodProjection = projection; },
    oracle(query = args) { return getFirewoodBenefit({ ...query, store: { db: source.db } }); },
    finish(query = args) {
      let rows = 0;
      for (let n = 0; n < 100; n++) {
        const result = maintainFirewoodProjection({ ...query, maxRows: 128 });
        assert.ok(result.processed <= 128); rows += result.processed ?? 0;
        if (result.complete) return rows;
      }
      assert.fail('Bounded comparison maintenance did not finish');
    },
  };
}
