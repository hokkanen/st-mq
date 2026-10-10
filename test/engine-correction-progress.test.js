import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { sample, start, W } from './helpers/recovery-fixture.js';

test('ordinary minute controller updates publish a correction after crossing a learning-window boundary',
  { timeout: 20_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-correction-progress-'));
    const store = new Store(join(directory, 'history.sqlite'));
    let now = start;
    const engine = new Engine({ store, config: { input: 'mqtt', settings: {}, control: { learningTrials: false } },
      clock: () => now });
    t.after(async () => {
      engine.beginShutdown({ restore: false });
      await engine.charging.close(); await engine.garage.close({ restore: false });
      await engine.closeFireplace(); await engine.executor.close({ restore: false });
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    const load = engine.changeFireplace({ requestId: 'synthetic-progress-load', kg: 4 }).entries[0];
    for (let index = 1; index <= 4; index++) sample(store, start + index * W);
    now = start + 4 * W;
    await store.runWrite(() => engine.tick());
    const old = structuredClone(engine.checkpoint);
    now++;
    const removed = await store.runWrite(() => engine.changeFireplace({ requestId: 'synthetic-progress-remove', id: load.id }, true));
    const manager = engine.fireplaceManager();
    const waitReady = async () => {
      const deadline = Date.now() + 5_000;
      while (manager.status().status !== 'ready' && manager.status().status !== 'current') {
        assert.notEqual(manager.status().status, 'failed');
        assert(Date.now() < deadline, 'the real replay worker finishes');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    await waitReady();
    now = start + 5 * W;
    let ticks = 0;
    for (; ticks < 4; ticks++) {
      await store.runWrite(() => engine.tick());
      await manager.publication;
      if (manager.status().status === 'current') { ticks++; break; }
      if (manager.status().status !== 'current') await waitReady();
      now += 60_000;
    }
    assert.equal(manager.status().status, 'current', 'normal scheduled updates complete correction without a manual reconcile call');
    assert.equal(engine.checkpoint.fireplaceRevision, removed.revision);
    assert(engine.checkpoint.journalCursor > old.journalCursor, 'normal control kept recording learning during correction');
    assert(engine.checkpoint.windowCursor >= start + 5 * W);
    assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
    t.diagnostic(JSON.stringify({ controllerTicksToPublish: ticks }));
  });

test('correction publication does not require a quiet controller update', { timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-correction-moving-context-'));
  const store = new Store(join(directory, 'history.sqlite'));
  let now = start;
  const engine = new Engine({ store, config: { input: 'mqtt', settings: {}, control: { learningTrials: false } },
    clock: () => now });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false });
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const load = engine.changeFireplace({ requestId: 'synthetic-moving-context-load', kg: 4 }).entries[0];
  for (let index = 1; index <= 4; index++) sample(store, start + index * W);
  now = start + 4 * W;
  await store.runWrite(() => engine.tick());
  const old = structuredClone(engine.checkpoint);
  now++;
  const removed = await store.runWrite(() => engine.changeFireplace({ requestId: 'synthetic-moving-context-remove', id: load.id }, true));
  const manager = engine.fireplaceManager();
  let updates = 0, advanced = 0;
  for (; updates < 200 && (updates < 2 || manager.status().status !== 'current'); updates++) {
    now += 60_000;
    const before = store.learningJournalHead('mqtt');
    // Accelerate changing control context without equipment commands. This is
    // a concurrency stress fixture, not a claim about normal household cadence.
    await store.runWrite(() => {
      engine.settings.comfort.targetC = updates % 2 ? 21 : 20;
      engine.tick();
    });
    if (store.learningJournalHead('mqtt') > before) advanced++;
    await manager.publication;
    assert.notEqual(manager.status().status, 'failed');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(advanced >= 2, 'real controller updates kept appending changing learning context');
  assert.equal(manager.status().status, 'current', 'rebuild publishes between updates even though every update advances learning');
  assert.equal(engine.checkpoint.fireplaceRevision, removed.revision);
  assert(engine.checkpoint.journalCursor > old.journalCursor);
  assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }));
  t.diagnostic(JSON.stringify({ updates, advanced }));
});
