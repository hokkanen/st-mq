import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { validateSettings } from '../src/app/config.js';

function fixture(t, comfort = {}) {
  const store = new Store(':memory:');
  const engine = new Engine({ store, clock: () => Date.parse('2026-09-24T10:00:00Z'),
    config: { input: 'offline', settings: validateSettings({ comfort }),
      control: { indoorSensorWeights: { bedroom_temperature: 1, downstairs_temperature: 0, indoor_temperature: 2 } } } });
  t.after(async () => {
    await engine.closeFireplace();
    await engine.charging.close();
    await engine.garage.close({ restore: false });
    clearTimeout(engine.executor.timer);
    engine.executor.closed = true;
    store.close();
  });
  return engine;
}

test('room comfort presentation retains configured membership and separates learned and overall references', t => {
  const engine = fixture(t, { targetC: 21, maxDropC: 1, maxRiseC: 1.5 });
  const checkpoint = { baselineC: 22, sensorComfortReferences: {
    indoor_temperature: { targetC: 20 }, downstairs_temperature: { targetC: 23 },
  } };
  const before = structuredClone(checkpoint);
  assert.deepEqual(engine.comfortRooms(checkpoint), [
    { id: 'indoor_temperature', label: 'Upstairs', referenceC: 20, referenceSource: 'room', minC: 19, maxC: 21.5, limitsApply: true },
    { id: 'bedroom_temperature', label: 'Bedroom', referenceC: 21, referenceSource: 'overall', minC: 20, maxC: 22.5, limitsApply: true },
  ]);
  assert.deepEqual(checkpoint, before);
  engine.settings.comfort.targetC = null;
  assert.equal(engine.comfortRooms(checkpoint)[1].referenceC, 22, 'Unlearned room falls back to learned overall reference');
  engine.settings.occupancy = { mode: 'away', returnAt: '2026-09-25T10:00:00Z' };
  assert(engine.comfortRooms(checkpoint).every(room => room.limitsApply === false));
  assert.equal(engine.comfortRooms(checkpoint)[0].minC, 19, 'Occupied limits remain visible while inactive');
});

test('status exposes unknown room references without inventing targets or dropping missing sensors', t => {
  const engine = fixture(t);
  const status = engine.status();
  assert.equal(status.observations.indoor.stale, true);
  assert.deepEqual(status.comfortRooms.map(({ id, referenceC, referenceSource, minC, maxC }) =>
    ({ id, referenceC, referenceSource, minC, maxC })), [
    { id: 'indoor_temperature', referenceC: null, referenceSource: 'unavailable', minC: null, maxC: null },
    { id: 'bedroom_temperature', referenceC: null, referenceSource: 'unavailable', minC: null, maxC: null },
  ]);
  assert.deepEqual(engine.status().comfortRooms, status.comfortRooms, 'Polling preserves the authoritative presentation');
});
