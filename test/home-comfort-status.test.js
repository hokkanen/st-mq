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

test('comfort status exposes one configured aggregate reference and fixed membership', t => {
  const engine = fixture(t, { targetC: 21, maxDropC: 1, maxRiseC: 1.5 });
  const status = engine.status();
  assert.equal(status.settings.comfort.targetC, 21);
  assert.equal(status.decision.comfort.targetC, 21);
  assert.equal(Object.hasOwn(status, 'comfortRooms'), false);
  assert.deepEqual(status.observations.indoor.weights, { indoor_temperature: 2 / 3, bedroom_temperature: 1 / 3 });
  assert.equal(status.observations.indoorControl.stale, true);
  assert.equal(status.observations.indoorControl.estimated, false);
});

test('missing observed indoor temperature never invents a reference or a fallback anchor', t => {
  const engine = fixture(t);
  const status = engine.status();
  assert.equal(status.observations.indoor.stale, true);
  assert.equal(status.learning.adaptive.comfortReference, null);
  assert.equal(status.decision.comfort.targetC, null);
  assert.equal(status.observations.indoorControl.value, null);
  assert.equal(engine.store.getState('indoor-control-anchor:offline'), null);
  assert.deepEqual(engine.status().observations.indoorControl, status.observations.indoorControl);
});
