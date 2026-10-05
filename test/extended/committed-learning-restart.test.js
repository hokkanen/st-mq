import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { replayLearningJournal, LEARNING_WINDOW_MS } from '../../src/app/committed-learning.js';
import { appendLearningRecord } from '../helpers/home-learning-fixture.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const start = Date.parse('2026-01-01T00:00:00Z');
const config = { heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025 };

// This full persisted-history replay uses the extended suite's integration budget.
test('a crash between journal commit and checkpoint preserves sample/episode ordering and deterministic rebuild', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-learning-journal-'));
  const path = join(dir, 'synthetic.sqlite');
  let store = new Store(path), checkpoint = null;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 768; i++) {
    const at = start + i * LEARNING_WINDOW_MS;
    const value = { timestamp: at, windowStart: at - LEARNING_WINDOW_MS, windowEnd: at,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0,
      targetC: 21, regime: 'occupied', quality: [], energyBasis: 'estimated', actualModeKnown: false,
      provenance: { basis: 'committed-history', forecastVersion: { id: Math.floor(i / 96) + 1 } } };
    const configuration = i < 384 ? config : { ...config, heatPumpCompressorKw: 3.1 };
    appendLearningRecord(store, 'mqtt', 'sample', value, { config: configuration, seed: checkpoint });
    if (i === 384) {
      const episode = { id: 'invented-complete-cycle', startedAt: at - 8 * HOUR, endedAt: at,
        complete: true, recoveryComplete: true, phases: ['preheat', 'reduction', 'recovery'],
        energyBasis: 'estimated', recoveryHours: 4, recoveryEnergyKwh: 8, recoveryAuxKwh: 1,
        predictedRecoveryEnergyKwh: 6, predictedRecoveryAuxKwh: 1, compressorActivityObserved: true,
        auxiliaryObserved: true, auxiliaryRouteKnown: true, spaceHeatingAuxKwh: 1, dhwAuxKwh: 0,
        predictedSpaceHeatingAuxKwh: 0.5 };
      appendLearningRecord(store, 'mqtt', 'episode', episode, { config: configuration, seed: checkpoint });
      // The durable checkpoint still precedes BOTH journal entries.
      const beforeCrash = store.getState('adaptive:mqtt').journalCursor;
      store.close(); store = new Store(path);
      assert.equal(store.getState('adaptive:mqtt').journalCursor, beforeCrash);
      checkpoint = replayLearningJournal(store, 'mqtt', store.getState('adaptive:mqtt'));
      assert.equal(checkpoint.model.energy.episodes, 0,
        'The durable episode straddles a power-configuration change and must not calibrate the new epoch');
    } else checkpoint = replayLearningJournal(store, 'mqtt', checkpoint);
  }
  assert.notEqual(checkpoint.model.validation?.accepted, true,
    'Flat temperatures without observed heat input cannot validate thermal coefficients');
  const rebuilt = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  assert.deepEqual(rebuilt, checkpoint);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', rebuilt), rebuilt);
  const entries = store.learningJournal({ input: 'mqtt', limit: 1000 });
  assert.equal(entries.filter(entry => entry.kind === 'episode').length, 1);
  assert.equal(new Set(entries.map(entry => entry.configVersion)).size, 2);
});
