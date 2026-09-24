import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { GarageRuntime } from '../src/garage/runtime.js';
import { GARAGE_ALGORITHM_VERSION, createGarageModel } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageExposure, updateGarageExposure, assessGarageProtection, validGarageExposure } from '../src/garage/protection.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
import { startGarageAssessment } from '../src/garage/episodes.js';
import { garageInput, replayGarageJournal } from '../src/garage/learning.js';
const START = Date.parse('2026-01-01T00:00:00Z'), MINUTE = 60_000;
const settings = garageSettings({ enabled: true, minOnMs: 30 * MINUTE, protection: { approved: true } });
const construct = store => new GarageRuntime({ store, engine: { latest: {}, settings: { mode: 'active' } },
  config: { input: 'mqtt', garage: settings }, clock: () => START });

test('unsupported Garage saved exposure and algorithms fail before source mutation', () => {
  const currentModel = createGarageModel({ seedAt: START });
  for (const [key, value] of [
    ['exposure', {}], ['exposure', 0], ['exposure', { version: 'garage-exposure-v1' }],
    ['exposure', { version: 'garage-exposure-v2' }],
    ['checkpoint', { algorithmVersion: 'committed-garage-v4-simple-off' }],
    ['checkpoint', { algorithmVersion: 'committed-garage-v5-protection-limited' }],
    ['episode', { algorithmVersion: GARAGE_ALGORITHM_VERSION, frozenModel: { algorithm: 'old' } }],
    ['episode', { algorithmVersion: GARAGE_ALGORITHM_VERSION, frozenModel: currentModel, accounting: { algorithmVersion: 'old' } }],
  ]) {
    const store = new Store(':memory:');
    try {
      store.setState(`garage:${key}:mqtt`, value);
      store.setState('garage:adapter:mqtt', { version: 1, restorePending: true, outstandingPermissionExpiresAt: START + MINUTE });
      const before = store.db.prepare('SELECT * FROM state ORDER BY key').all();
      assert.throws(() => construct(store), /Unsupported|Invalid/);
      assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(), before);
    } finally { store.close(); }
  }
});

test('an obsolete journal cannot seed a new current model', () => {
  const store = new Store(':memory:');
  try {
    store.appendLearningJournal(garageInput('mqtt'), { kind: 'context', at: START, key: 'unsupported',
      algorithmVersion: 'committed-garage-v4-simple-off', configVersion: 'old', payload: {} });
    assert.throws(() => construct(store), /Unsupported Garage journal/);
    assert.equal(store.learningJournal({ input: garageInput('mqtt') }).length, 1);
  } finally { store.close(); }
});

test('current restart retains reserve, frozen accounting and restoration while reconstructing current journal', async () => {
  const store = new Store(':memory:'); let first, restored;
  try {
    first = construct(store);
    const exposure = knownGarageReserve(settings, { at: START, rearC: 8, frontC: 8 });
    const model = createGarageModel({ seedAt: START });
    const observation = { at: START, rearAt: START, frontAt: START, rearC: 8, frontC: 8, outdoorC: -5, available: false };
    const episode = { id: 'current-cycle', pauseId: 'current-pause', status: 'active', phase: 'pause',
      algorithmVersion: GARAGE_ALGORITHM_VERSION, frozenModel: model, settings,
      startedAt: START, pauseStartedAt: START, pauseUntil: START + 10 * MINUTE,
      initialObservation: observation, initialExposure: exposure, accounting: startGarageAssessment(model, observation) };
    store.setState('garage:exposure:mqtt', exposure); store.setState('garage:episode:mqtt', episode);
    const obligation = { version: 1, restorePending: true, outstandingPermissionExpiresAt: START + MINUTE };
    store.setState('garage:adapter:mqtt', obligation);
    await first.close({ restore: false }); first = null;
    restored = construct(store);
    assert.deepEqual(restored.exposure, exposure);
    assert.deepEqual(restored.episode.accounting, episode.accounting);
    assert.equal(restored.episode.phase, 'recovery'); assert.equal(restored.episode.restarted, true);
    assert.deepEqual(store.getState('garage:adapter:mqtt'), obligation);
    assert.deepEqual(replayGarageJournal(store, 'mqtt'), restored.checkpoint);
  } finally { await first?.close({ restore: false }); await restored?.close({ restore: false }); store.close(); }
});

test('nonfinite exposure cannot become valid protection or be silently replaced', () => {
  const store = new Store(':memory:');
  try {
    const exposure = updateGarageExposure(null, { at: START, rearC: 8, frontC: 7 }, settings);
    exposure.locations.front.energyJPerM = NaN;
    assert.equal(validGarageExposure(exposure, START, settings), false);
    assert.throws(() => updateGarageExposure(exposure, { at: START + MINUTE, rearC: 8, frontC: 7 }, settings), /Invalid/);
    assert.equal(assessGarageProtection(exposure, { now: START + MINUTE, observation: { at: START + MINUTE, rearC: 8, frontC: 7 }, settings }).safeToPause, false);
    store.setState('garage:exposure:mqtt', exposure);
    assert.throws(() => construct(store), /Invalid/);
  } finally { store.close(); }
});
