import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';

for (const canControl of [true, false]) test(`garage display failure cannot interrupt Home or command the pump (authority ${canControl})`, async t => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'simulated', connections: {} },
    clock: () => 1_800_000_000_000, canControl: () => canControl });
  t.after(async () => { await engine.garage.close(); store.close(); });
  t.mock.method(engine.garage, 'tick', () => { throw new Error('private synthetic exception'); });
  const result = engine.tick();
  assert.ok(result.decision);
  assert.equal(result.garage.reason, 'garage-runtime-unavailable');
  assert.equal(JSON.stringify(result).includes('private synthetic exception'), false);
  assert.equal(Object.hasOwn(result.automation, 'garage'), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM learning_journal WHERE input LIKE 'garage:%'").get().n, 0);
});
