import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { verifyCycleEvidencePages } from '../src/recovery/cycle-validation.js';
import { validateRecoveryDependencies } from '../src/recovery/dependencies.js';
import { scopeIncrementalSource } from '../src/recovery/incremental-source.js';
import { sourceFingerprint } from '../src/recovery/ledger.js';
import { fixture, observation, recover, start, W } from './helpers/recovery-fixture.js';
import { recordLearningContext } from '../src/app/committed-learning.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';

function cycle(store,{id='invented-cycle',count=5,observationId=null,provenance,at=start}={}) {
  let value={id,startedAt:at,status:'active',observationCount:0,plan:{model:{trainedAt:at-W},baseline:{energyKwh:0}},
    modelConfig:{synthetic:true},originalPrediction:{energyKwh:0},treatmentKey:'native',executionBasis:'manual'};
  store.transaction(()=>store.cycle('mqtt',value));
  for(let index=0;index<count;index++) {
    const end=at+(index+1)*W;
    value={...value,observationCount:index+1,lastSample:{timestamp:end,indoorC:21}};
    store.transaction(()=>store.appendCycleEvidence('mqtt',value,[{start:end-W,end,indoorC:21,outdoorC:0,energyKwh:0}],
      {sampleAt:end,provenance:provenance ?? (observationId === null ? null : {observationId,lineage:{indoor:{observations:[observationId,observationId]}}}),
        context:{phase:'normal',roomBoostC:0,trial:false}}));
  }
  value={...value,status:'completed',endedAt:at+count*W};store.transaction(()=>store.cycle('mqtt',value));
  return value;
}
const rows=(store,table)=>store.db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'recovery_dependencies' ? 'owner_table,owner_key,source_table,source_key' : 'id'}`).all();

test('cycle structural and source dependencies survive header updates, rollback and deletion',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const source=observation(store,start),value=cycle(store,{observationId:source});
  assert.doesNotThrow(()=>validateRecoveryDependencies(store.db));
  const before=rows(store,'recovery_dependencies');
  store.transaction(()=>store.cycle('mqtt',{...value,assessment:{complete:false}}));
  assert.deepEqual(rows(store,'recovery_dependencies'),before);
  assert.throws(()=>store.transaction(()=>{store.db.prepare('DELETE FROM learning_cycles WHERE id=?').run(value.id);throw Error('rollback');}),/rollback/);
  assert.deepEqual(rows(store,'recovery_dependencies'),before);
  const edge=before.find(row=>row.owner_table==='learning_cycle_samples' && row.source_table==='observations');
  store.db.prepare('DELETE FROM recovery_dependencies WHERE owner_table=? AND owner_key=? AND source_table=? AND source_key=?')
    .run(edge.owner_table,edge.owner_key,edge.source_table,edge.source_key);
  assert.throws(()=>validateRecoveryDependencies(store.db),{code:'database_integrity_failed'});
  store.db.prepare('INSERT INTO recovery_dependencies VALUES(?,?,?,?)').run(edge.owner_table,edge.owner_key,edge.source_table,edge.source_key);
  store.transaction(()=>store.db.prepare('DELETE FROM learning_cycles WHERE id=?').run(value.id));
  assert.deepEqual(rows(store,'recovery_dependencies'),[]);
  assert.doesNotThrow(()=>validateRecoveryDependencies(store.db));
});

test('changed cycle headers and child rows scope the complete frozen evidence closure',async t=>{
  for(const changed of ['learning_cycles','learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations']) {
    const f=fixture(t);const source=observation(f.master,start);cycle(f.master,{observationId:source,count:150});
    const store=new Store(await f.snapshot(f.master),{readOnly:true});t.after(()=>store.close());
    const first=rows(store,changed)[0];let yields=0;
    await scopeIncrementalSource(store,{changes:[{table:changed,key:[first.id],after:{id:first.id}}],yieldControl:async()=>{yields++;}});
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_learning_cycles').get().n,1,changed);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_learning_cycle_definitions').get().n,1,changed);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_learning_cycle_samples').get().n,150,changed);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_learning_cycle_observations').get().n,150,changed);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n,1,changed);
    assert.ok(yields>5,'closure work yields between bounded pages');
  }
});

test('cycle and child fingerprints preserve meaning across remapped local identities',t=>{
  const a=new Store(':memory:'),b=new Store(':memory:');t.after(()=>{a.close();b.close();});
  observation(b,start-W,19);cycle(b,{id:'unrelated',count:2,at:start-10*W});
  const aid=observation(a,start),bid=observation(b,start);
  cycle(a,{id:'cycle-a',observationId:aid});cycle(b,{id:'cycle-b',observationId:bid});
  for(const table of ['learning_cycles','learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations']) {
    const arow=a.db.prepare(`SELECT * FROM ${table} WHERE ${['learning_cycles','learning_cycle_definitions'].includes(table)?'id':'cycle_id'}=? ORDER BY id LIMIT 1`).get('cycle-a');
    const brow=b.db.prepare(`SELECT * FROM ${table} WHERE ${['learning_cycles','learning_cycle_definitions'].includes(table)?'id':'cycle_id'}=? ORDER BY id LIMIT 1`).get('cycle-b');
    assert.equal(sourceFingerprint(a,table,arow),sourceFingerprint(b,table,brow),table);
  }
});

test('recovery imports and reversibly selects a normalized tape without duplicate samples',async t=>{
  const f=fixture(t),donor=await f.donor();
  observation(f.master,start-W,19);const source=observation(donor,start);
  const original=cycle(donor,{observationId:source,count:180});
  const result=await recover(f,await f.snapshot(donor));
  assert.equal(result.report.counts.skipped,0);
  const header=f.master.cycleById({input:'mqtt',id:rows(f.master,'learning_cycles')[0].id});
  assert.equal(header.observationCount,180);assert.equal(Object.hasOwn(header,'observations'),false);
  assert.deepEqual(header.plan,original.plan);assert.deepEqual(header.originalPrediction,original.originalPrediction);
  assert.equal(rows(f.master,'learning_cycle_samples').length,180);
  assert.equal(rows(f.master,'learning_cycle_observations').length,180);
  const mapped=f.master.db.prepare('SELECT id FROM observations WHERE source_time=?').get(start).id;
  assert.notEqual(mapped,source);
  assert.equal(JSON.parse(rows(f.master,'learning_cycle_samples')[0].provenance).observationId,mapped);
  assert.doesNotThrow(()=>validateRecoveryDependencies(f.master.db));
  donor.event('invented-new-checkpoint',{},start+200*W);
  await recover(f,await f.snapshot(donor));
  assert.equal(rows(f.master,'learning_cycle_observations').length,180);
  const args={store:f.master,input:'mqtt',recoveryId:result.report.recoveryId,active:false,signal:f.signal};
  await reviseRecovery({...args,preview:await previewRecoveryRevision(args)});
  for(const table of ['learning_cycles','learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations'])
    assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM active_${table}`).get().n,0,table);
  args.active=true;await reviseRecovery({...args,preview:await previewRecoveryRevision(args)});
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM active_learning_cycle_observations').get().n,180);
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});

test('interrupted cycle import resumes its immutable prefix and refuses incomplete publication',async t=>{
  const target=new Store(':memory:'),donor=new Store(':memory:');t.after(()=>{target.close();donor.close();});
  cycle(donor,{count:180});
  const {HistoryMerge}=await import('../src/recovery/merge.js');
  const {beginRecovery}=await import('../src/recovery/ledger.js');
  const recoveryId=target.transaction(()=>beginRecovery(target,{input:'mqtt',donorDigest:'a'.repeat(64)}));
  let stopped=false;
  const options={target,donor,donorDigest:'a'.repeat(64),input:'mqtt',recoveryId};
  const interrupted=new HistoryMerge({...options,yieldControl:async()=>{
    if(target.db.prepare('SELECT COUNT(*) n FROM learning_cycle_observations').get().n>=64) {stopped=true;throw Error('invented worker interruption');}
  }});
  await assert.rejects(interrupted.evidence(),/worker interruption/);
  assert.equal(stopped,true);assert.equal(rows(target,'learning_cycle_observations').length,64);
  await assert.rejects(new HistoryMerge(options).verifyCycleEvidence(),{code:'RECOVERY_INVALID'});
  const imported=rows(target,'learning_cycles')[0],header=JSON.parse(imported.payload);
  assert.doesNotThrow(()=>[...verifyCycleEvidencePages(target.db,{id:imported.id,startedAt:header.startedAt,
    observationCount:header.observationCount,lastSampleAt:header.lastSample.timestamp,allowPrefix:true})]);
  const resumed=new HistoryMerge(options);await resumed.evidence();await resumed.verifyCycleEvidence();
  assert.equal(rows(target,'learning_cycle_samples').length,180);
  assert.equal(rows(target,'learning_cycle_observations').length,180);
  assert.doesNotThrow(()=>validateRecoveryDependencies(target.db));
  target.transaction(()=>target.db.prepare('DELETE FROM learning_cycle_observations WHERE ordinal=70').run());
  await assert.rejects(resumed.verifyCycleEvidence(),{code:'RECOVERY_INVALID'});
});

test('current cycle wins over overlapping donor cycles without importing orphaned children',async t=>{
  const target=new Store(':memory:'),donor=new Store(':memory:');t.after(()=>{target.close();donor.close();});
  cycle(target,{count:2});cycle(donor,{count:4});
  const {HistoryMerge}=await import('../src/recovery/merge.js');
  const merge=new HistoryMerge({target,donor,donorDigest:'b'.repeat(64),input:'mqtt'});
  await merge.evidence();
  assert.equal(rows(target,'learning_cycles').length,1);
  assert.equal(rows(target,'learning_cycle_samples').length,2);
  assert.equal(rows(target,'learning_cycle_observations').length,2);
  assert.equal(merge.report.tables.find(row=>row.name==='learning_cycles').conflicts,1);
  assert.equal(target.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});


test('unresolved donor journal provenance retains its original meaning without local ID aliasing',async t=>{
  const f=fixture(t);
  const context=targetC=>({phase:'normal',regime:'occupied',targetC,roomBoostC:0});
  recordLearningContext(f.master,'mqtt',context(21),start-W);
  const donor=await f.donor();
  const donorId=recordLearningContext(donor,'mqtt',context(20),start);
  const localId=recordLearningContext(f.master,'mqtt',context(22),start+W/2);
  assert.equal(donorId,localId,'independent sources allocate equal IDs');
  const original={lineage:{control_context:{journal:[donorId]}}};
  cycle(donor,{count:2,provenance:original});
  const result=await recover(f,await f.snapshot(donor));
  assert.equal(result.report.counts.skipped,0);
  const group=rows(f.master,'learning_cycle_samples')[0],accepted=JSON.parse(group.provenance);
  assert.deepEqual(accepted.lineage.control_context.journal,[null]);
  assert.deepEqual(JSON.parse(accepted.recoveryReferences.original),original);
  assert.deepEqual(accepted.recoveryReferences.entries,[{table:'learning_journal',id:donorId}]);
  assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM recovery_dependencies WHERE owner_table='learning_cycle_samples'
    AND owner_key=? AND source_table='learning_journal'`).get(String(group.id)).n,0,'an unresolved donor ID is not a local source edge');
  assert.doesNotThrow(()=>validateRecoveryDependencies(f.master.db));
});


test('the compact last-forecast reference remains in source closure and remaps on import',async t=>{
  const f=fixture(t),donor=await f.donor();
  f.master.snapshot({kind:'weather',source:'invented-weather',fetchedAt:start-W,payload:{forecast:[]}});
  const forecastId=donor.snapshot({kind:'weather',source:'invented-weather',fetchedAt:start,payload:{forecast:[]}});
  const forecast=donor.snapshotById(forecastId);
  const value=cycle(donor,{count:2});
  donor.cycle('mqtt',{...value,lastForecastVersion:{id:forecastId,contentId:forecast.contentId}});
  const result=await recover(f,await f.snapshot(donor));
  assert.equal(result.report.counts.skipped,0);
  const header=JSON.parse(rows(f.master,'learning_cycles')[0].payload);
  const mapped=f.master.db.prepare('SELECT id,content_id FROM provider_snapshot_fetches WHERE fetched_at=?').get(start);
  assert.notEqual(mapped.id,forecastId);
  assert.equal(header.lastForecastVersion.id,mapped.id);
  assert.equal(header.lastForecastVersion.contentId,mapped.content_id);
  assert.doesNotThrow(()=>validateRecoveryDependencies(f.master.db));
});
