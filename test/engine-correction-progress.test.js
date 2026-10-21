import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { stageScriptedCoefficientCandidate } from './helpers/coefficient-fixture.js';
import { sample, start, W } from './helpers/recovery-fixture.js';
import { addFireplace, removeFireplace, FireplaceRebuildManager } from '../src/app/fireplace.js';

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
    await engine.update();
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
      await engine.update();
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
  await engine.update();
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
    });
    await engine.update();
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

test('correction catches up a controller write admitted at the control-priority fairness boundary',
  { timeout: 20_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'stmq-correction-fairness-'));
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
    const load = engine.changeFireplace({ requestId: 'synthetic-fairness-load', kg: 4 }).entries[0];
    for (let index = 1; index <= 4; index++) sample(store, start + index * W);
    now = start + 4 * W;await engine.refreshLearning();
    engine.requestUpdate = () => {};
    const old = structuredClone(engine.checkpoint), manager = engine.fireplaceManager();
    // Control READY delivery precisely while retaining the actual ordered
    // learning function and real storage publication worker.
    const worker = new EventEmitter(), requests = [];
    worker.terminate = async () => 0;
    worker.postMessage = message => {
      requests.push(message);
      if(message.type==='coefficient-ack'){worker.emit('coefficient-ack',message);return;}
      if (message.type !== 'catchup') return;
      void stageScriptedCoefficientCandidate(worker,store,'mqtt',message,{generation:worker.coefficientGeneration})
        .then(({checkpoint,coefficientGeneration})=>worker.emit('message',{...message,type:'ready',checkpoint,
          processed:checkpoint.journalCursor,head:checkpoint.journalCursor,coefficientGeneration}));
    };
    manager.workerFactory = () => worker;
    now++;
    const removed = engine.changeFireplace({ requestId: 'synthetic-fairness-remove', id: load.id }, true);
    const request = requests.find(message => message.type === 'rebuild');
    assert(request);
    const staged=await stageScriptedCoefficientCandidate(worker,store,'mqtt',request);
    const candidate=staged.checkpoint;
    let advancing;
    await store.runPublication(async () => {
      // Completing this control turn and then READY reaches the existing eight
      // turn limit. Fairness must admit the waiting normal controller first.
      store.writeQueue.controlStreak = 6;
      advancing = store.runWrite(() => {
        assert.equal(manager.ready?.head, candidate.journalCursor, 'READY overtakes the waiting normal update');
        assert.equal(engine.checkpoint.fireplaceRevision, old.fireplaceRevision);
        now = start + 5 * W;sample(store, now);engine.readAdaptive(now);
      });
      worker.emit('message', { ...request, type: 'ready', checkpoint: candidate,
        processed: candidate.journalCursor, head: candidate.journalCursor,coefficientGeneration:staged.coefficientGeneration });
    }, { priority: 'control' });
    await advancing;
    const deadline = Date.now() + 5_000;
    while (manager.status().status !== 'current') {
      assert.notEqual(manager.status().status, 'failed');
      assert(Date.now() < deadline, 'the exact-head correction publishes after the fairness turn');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await manager.publication;
    assert(requests.some(message => message.type === 'catchup' && message.after === candidate.journalCursor
      && message.head > candidate.journalCursor), 'the intervening input invalidates the stale publication boundary');
    assert.equal(engine.checkpoint.fireplaceRevision, removed.revision);
    assert(engine.checkpoint.journalCursor > candidate.journalCursor);
    assert.deepEqual(engine.checkpoint, replayLearningJournal(store, 'mqtt', null,
      { rebuild: true, persistCheckpoint: false }));
    assert.deepEqual(store.getState('adaptive:mqtt'), engine.checkpoint);
  });

test('an older ordinary progress report cannot demote a ready correction after priority admission',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'stmq-correction-ready-progress-'));
  const store=new Store(join(directory,'history.sqlite')),worker=new EventEmitter(),requests=[];
  worker.terminate=async()=>0;worker.postMessage=message=>{requests.push(message);if(message.type==='coefficient-ack')worker.emit('coefficient-ack',message);};
  const manager=new FireplaceRebuildManager({store,input:'mqtt',workerFactory:()=>worker});
  t.after(async()=>{await manager.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const load=addFireplace(store,'mqtt',{requestId:'synthetic-ready-progress-load',kg:4},start);
  sample(store,start+W);const original=replayLearningJournal(store,'mqtt');
  removeFireplace(store,'mqtt',{requestId:'synthetic-ready-progress-remove',id:load.id},start+W+1);
  manager.start();const request=requests.find(message=>message.type==='rebuild');assert(request);
  const staged=await stageScriptedCoefficientCandidate(worker,store,'mqtt',request);
  const checkpoint=staged.checkpoint;
  await store.runPublication(async()=>{
    // Both reports arrive while admission is reserved. READY must run first;
    // no automatic publication clears the candidate before progress follows.
    worker.emit('message',{...request,type:'progress',processed:checkpoint.journalCursor,journalCursor:checkpoint.journalCursor});
    worker.emit('message',{...request,type:'ready',checkpoint,processed:checkpoint.journalCursor,head:checkpoint.journalCursor,coefficientGeneration:staged.coefficientGeneration});
  });
  await store.runWrite(()=>{
    assert.equal(manager.status().status,'ready');
    assert.deepEqual(manager.ready.checkpoint,checkpoint);
    assert.deepEqual(store.getState('adaptive:mqtt'),original,'progress never publishes or replaces model state');
  });
});
