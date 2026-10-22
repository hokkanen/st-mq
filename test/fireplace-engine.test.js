import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings } from '../src/app/config.js';
import { applyLearningRecord, LEARNING_ALGORITHM, validLearningCheckpoint} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { decodeLearningCheckpoint, withLearningCheckpointRead } from '../src/storage/learning-checkpoint-storage.js';
import { readCoefficientCoverage, readCoefficientEvents } from '../src/storage/coefficient-history.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { updateAdaptiveLearning } from '../src/control/adaptive-learning.js';

const WINDOW = 900_000, start = Date.parse('2026-01-01T00:00:00Z');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

test('bounded engine firewood context includes ISO-normalized fitting samples without input segments',async t=>{
  const store=new Store(':memory:'),now=start+16*86_400_000;
  const load=addFireplace(store,'mqtt',{requestId:'synthetic-working-window-fire',kg:6},start+86_400_000);
  const engine=new Engine({store,config:{input:'mqtt',settings:{}},clock:()=>now});
  t.after(async()=>{engine.beginShutdown({restore:false});await engine.closeFireplace();await engine.charging.close();
    await engine.garage.close({restore:false});await engine.executor.close({restore:false});await store.close();});
  const sample={timestamp:start,indoorC:21,outdoorC:0,phase:'normal',regime:'occupied',quality:[],thermalCompressorDuty:1,thermalAuxKw:0};
  engine.checkpoint=updateAdaptiveLearning(null,sample,{now,config:engine.control});
  assert.equal(typeof engine.checkpoint.samples[0].timestamp,'string');
  assert.equal(engine.checkpoint.samples[0].inputSegments,undefined);
  assert.equal(engine.checkpoint.samples[0].windowStart,undefined);
  assert(engine.currentFireplaceContext(now).fireplaceEvents.some(event=>event.id===load.id),
    'Earlier heat affecting the retained fitting state cannot be dropped just because source timestamps are ISO strings');
});

test('restart reconciles old completed-cycle corrections before allowing the source rebuild to finish', async t => {
  const store = new Store(':memory:');
  const old = addFireplace(store,'mqtt',{requestId:'synthetic-old-cycle-fire',kg:6},start);
  store.cycle('mqtt',{id:'synthetic-old-cycle',status:'completed',startedAt:start,endedAt:start+3_600_000,
    assessment:{profitCents:12,recoveryErrorCents:0,basis:'modelled'}});
  const removed=removeFireplace(store,'mqtt',{requestId:'synthetic-old-cycle-remove',id:old.id},start+1_800_000);
  store.setState('fireplace:rebuild:mqtt',{status:'pending',revision:removed.revision,sensorRevision:0,
    epoch:store.learningEpoch('mqtt'),requestedAt:start+1_800_000,affectedAt:start,requiresRebuild:true});
  // The source event is committed; simulate losing the dashboard callback.
  const engine=new Engine({store,config:{input:'mqtt',settings:{}},clock:()=>start+365*86_400_000});
  let started=false;
  engine.fireplaceRebuild={publication:null,start(){
    const cycle=JSON.parse(store.db.prepare('SELECT payload FROM learning_cycles WHERE input=?').get('mqtt').payload);
    assert.equal(cycle.assessment.profitCents,null);
    assert.equal(cycle.assessment.basis,'unassessed-corrected-fireplace-history');
    started=true;
  },takeReady(){return null;},async close(){},beginShutdown(){}};
  t.after(async()=>{engine.beginShutdown({restore:false});await engine.closeFireplace();await engine.charging.close();
    await engine.garage.close({restore:false});await engine.executor.close({restore:false});await store.close();});
  assert.equal(engine.currentFireplaceContext(start+365*86_400_000).fireplaceExcludedRanges.length,0);
  engine.reconcileFireplace();
  assert(started);
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-fireplace-engine-'));
  const path = join(directory, 'invented.sqlite'), store = new Store(path);
  const config = { input: 'mqtt', settings: validateSettings({ comfort: { targetC: 21 } }),
    control: { learningTrials: false } };
  let now = start;
  const createEngine = () => {
    const value = new Engine({ store, config, clock: () => now });
    value.requestUpdate = () => {};
    const manager = value.fireplaceManager.bind(value);
    // These tests deliberately inspect the prepared candidate before allowing
    // publication. Automatic progress is exercised by engine-correction-progress.
    value.fireplaceManager = () => { const result = manager(); result.onReady = null; return result; };
    return value;
  };
  let engine = createEngine();
  const observer = new DatabaseSync(path, { readOnly: true });
  const externalState = key => withLearningCheckpointRead(observer, () => {
    const row = observer.prepare('SELECT value FROM state WHERE key=?').get(key);
    const value = row ? JSON.parse(row.value) : null;
    return key.startsWith('adaptive:') ? decodeLearningCheckpoint(observer, value) : value;
  });
  t.after(async () => {
    engine.beginShutdown({ restore: false });
    await engine.charging.close();
    await engine.closeFireplace();
    engine.executor.closed = true; clearTimeout(engine.executor.timer);
    observer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const sample = i => {
    const timestamp = start + i * WINDOW, windowStart = timestamp - WINDOW;
    const intervalInputs = { outdoorC: 10, solarRadiationWm2: 0, compressorDuty: 0.4, auxKw: 0,
      phase: 'normal', targetC: 21, roomBoostC: 0 };
    appendLearningRecord(store, 'mqtt', 'sample', { timestamp, windowStart, windowEnd: timestamp, ...intervalInputs,
      indoorC: 21, regime: 'occupied', quality: [], actualModeKnown: true, intervalInputs,
      heating: { verified: true, compressorActive: true, route: 'space-heating', quality: [] },
      powerKw: 1.22, energyBasis: 'estimated' }, { config: engine.control });
    now = Math.max(now, timestamp);
  };
  return { store, sample, externalState, observer,
    get engine() { return engine; }, get now() { return now; }, set now(value) { now = value; },
    async restart() {
      engine.beginShutdown({ restore: false });
      await engine.charging.close();
      await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer);
      engine = createEngine(); return engine;
    } };
}
async function waitReady(engine) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = engine.fireplaceManager().status();
    assert.notEqual(status.status, 'failed', 'The real rebuild worker must finish successfully');
    if (status.status === 'ready') return;
    await pause();
  }
  throw new Error('Synthetic engine rebuild did not finish before deadline');
}
function pureReplay(store) {
  const context = fireplaceLearningContext(store, 'mqtt');
  return store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })
    .reduce((checkpoint, entry) => applyLearningRecord(checkpoint, entry, context), null);
}

test('engine holds the old revision through real-worker replay and suffix catchup, then swaps all durable state atomically',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const created = f.engine.changeFireplace({ requestId: 'invented-engine-load', kg: 8 });
    const load = created.entries[0];
    for (let i = 1; i <= 12; i++) f.sample(i);
    const old = structuredClone((await f.engine.refreshLearning()));
    assert.equal(old.fireplaceRevision, load.id);
    const journalBefore = f.store.learningJournal({ input: 'mqtt' });
    f.now++;
    const removed = f.engine.changeFireplace({ requestId: 'invented-engine-remove', id: load.id }, true);
    assert.equal(removed.rebuild.status, 'running');
    assert.equal((await f.engine.refreshLearning()).fireplaceRevision, old.fireplaceRevision);
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    await waitReady(f.engine);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'running', 'A ready candidate is not yet an active model');
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    f.sample(13);
    const retained = (await f.engine.refreshLearning());
    assert.equal(retained.fireplaceRevision, old.fireplaceRevision, 'New journal suffixes must catch up before activation');
    assert.equal(retained.samples.length, old.samples.length + 1);
    assert(['running', 'ready'].includes(f.engine.fireplaceManager().status().status));
    await waitReady(f.engine);
    f.engine.pendingPlan = { invented: true };
    f.store.setState('pending-plan:mqtt', f.engine.pendingPlan);
    const beforeSwap = structuredClone(f.store.getState('adaptive:mqtt'));
    f.observer.exec('BEGIN');
    assert.deepEqual(f.externalState('adaptive:mqtt'), beforeSwap);
    (await f.engine.refreshLearning());
    await f.engine.fireplaceManager().publication;
    // A WAL reader retains the old complete interpretation throughout the
    // worker commit; a fresh snapshot then sees the entire replacement.
    assert.deepEqual(f.externalState('adaptive:mqtt'), beforeSwap);
    assert.equal(f.externalState('fireplace:rebuild:mqtt').status, 'ready');
    assert.deepEqual(f.externalState('pending-plan:mqtt'), { invented: true });
    f.observer.exec('ROLLBACK');
    const current = (await f.engine.refreshLearning());
    assert.equal(current.fireplaceRevision, removed.revision);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(validLearningCheckpoint(current), true);
    assert.deepEqual(f.externalState('adaptive:mqtt'), current);
    assert.equal(f.externalState('fireplace:rebuild:mqtt').status, 'current');
    assert.equal(f.externalState('pending-plan:mqtt'), null);
    assert.equal(f.engine.pendingPlan, null);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'idle');
    assert.deepEqual(f.store.learningJournal({ input: 'mqtt' }).slice(0, journalBefore.length), journalBefore);
  });

test('a load exactly at the closed-window boundary and its removal publish model and timeline revisions together', async t => {
  const f = fixture(t);
  f.sample(0);
  const original = structuredClone((await f.engine.refreshLearning()));
  const created = f.engine.changeFireplace({ requestId: 'invented-boundary-load', kg: 8 });
  assert.equal(created.entries[0].requiresRebuild, false, 'the completed sample contains no new fireplace heat');
  assert.equal(created.rebuild.status, 'running');
  assert.deepEqual(f.store.getState('adaptive:mqtt'), original, 'source metadata is not published ahead of its timeline');
  f.now++;
  const removed = f.engine.changeFireplace({ requestId: 'invented-boundary-remove', id: created.entries[0].id }, true);
  assert.equal(removed.rebuild.status, 'running');
  await waitReady(f.engine);
  await f.engine.refreshLearning();
  await f.engine.fireplaceManager().publication;
  const after = await f.engine.refreshLearning();
  assert.deepEqual(after.model, original.model);
  assert.deepEqual(after.samples, original.samples);
  assert.equal(after.fireplaceRevision, removed.revision);
  assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}).fireplaceRevision,removed.revision);
  assert.equal(validLearningCheckpoint(after), true);
});

test('a new future load reuses the complete proven model and coefficient prefix without historical replay',
  {timeout:30_000}, async t=>{
    const f=fixture(t);
    for(let i=1;i<=100;i++)f.sample(i);
    const original=structuredClone(await f.engine.refreshLearning());
    const before=readCoefficientEvents(f.store,{input:'mqtt'});
    f.now++;
    const created=f.engine.changeFireplace({requestId:'invented-future-load',kg:4});
    assert.equal(created.rebuild.status,'running');
    assert.deepEqual(f.store.getState('adaptive:mqtt'),original);
    assert.deepEqual(readCoefficientEvents(f.store,{input:'mqtt'}),before);
    await waitReady(f.engine);
    assert.equal(f.engine.fireplaceManager().status().processed,0,'unchanged historical inputs are never reapplied');
    await f.engine.refreshLearning();await f.engine.fireplaceManager().publication;
    const current=await f.engine.refreshLearning();
    assert.deepEqual(current.model,original.model);
    assert.deepEqual(current.samples,original.samples);
    assert.equal(current.fireplaceRevision,created.revision);
    assert.deepEqual(readCoefficientEvents(f.store,{input:'mqtt'}),before);
    assert.equal(readCoefficientCoverage(f.store,{input:'mqtt'}).fireplaceRevision,created.revision);
    assert.deepEqual(current,pureReplay(f.store));
  });

test('restart resumes a pending correction while preserving the previous checkpoint until the worker is ready',
  { timeout: 30_000 }, async t => {
    const f = fixture(t);
    const created = f.engine.changeFireplace({ requestId: 'invented-restart-load', kg: 6 });
    for (let i = 1; i <= 16; i++) f.sample(i);
    const old = structuredClone((await f.engine.refreshLearning()));
    f.now++;
    const removed = f.engine.changeFireplace({ requestId: 'invented-restart-remove', id: created.entries[0].id }, true);
    await f.restart();
    assert.equal(f.store.getState('fireplace:rebuild:mqtt').status, 'pending');
    assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
    const firstRead = (await f.engine.refreshLearning());
    assert.equal(firstRead.fireplaceRevision, old.fireplaceRevision);
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'running');
    await waitReady(f.engine);
    (await f.engine.refreshLearning());
    await f.engine.fireplaceManager().publication;
    const current = (await f.engine.refreshLearning());
    assert.equal(current.fireplaceRevision, removed.revision);
    assert.deepEqual(current, pureReplay(f.store));
    assert.equal(f.engine.fireplaceStatus().rebuild.status, 'idle');
  });

test('a failed correction publication retains control and is not retried by every update', async t => {
  const f = fixture(t);
  const load = f.engine.changeFireplace({ requestId: 'invented-publication-failure-load', kg: 4 }).entries[0];
  for (let i = 1; i <= 4; i++) f.sample(i);
  const old = structuredClone((await f.engine.refreshLearning()));
  f.now++;
  f.engine.changeFireplace({ requestId: 'invented-publication-failure-remove', id: load.id }, true);
  await waitReady(f.engine);
  const runPublication = f.store.runPublication.bind(f.store);
  let attempts = 0;
  f.store.runPublication = (operation, options) => runPublication(() => {
    attempts++; throw new Error('Invented publication storage failure');
  }, options);
  f.engine.reconcileFireplace();
  await f.engine.fireplaceManager().publication;
  f.store.runPublication = runPublication;
  assert.equal(f.engine.fireplaceManager().status().status, 'failed');
  assert.deepEqual(f.store.getState('adaptive:mqtt'), old);
  for (let i = 0; i < 3; i++) await f.engine.update();
  assert.equal(attempts, 1);
  assert.equal(f.engine.fireplaceManager().status().status, 'failed');
  assert.equal(f.engine.checkpoint.fireplaceRevision, old.fireplaceRevision);
  assert(f.store.learningJournalHead('mqtt') >= old.journalCursor, 'committed learning continues with the prior interpretation');
});
