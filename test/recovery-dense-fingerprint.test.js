import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CONTROL_DEFAULTS } from '../src/app/config.js';
import { committedLearningSample,recordLearningContext,LEARNING_WINDOW_MS as WINDOW,replayLearningJournal } from '../src/app/committed-learning.js';
import { LiveLearning } from '../src/app/live-learning.js';
import { pinnedSourceFingerprints,sourceFingerprint,beginRecovery } from '../src/recovery/ledger.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { fixture,recover,start } from './helpers/recovery-fixture.js';
import { seedCycleEvidence } from './helpers/cycle-evidence.js';

const config={...CONTROL_DEFAULTS,indoorSensorWeights:{indoor_temperature:1}};
function dense(store) {
  const from=start-WINDOW;
  const record=(signal,value,at)=>store.observation({source:signal==='outdoor_temperature'?'fmi':signal==='indoor_temperature'?'mqtt-temperature':'husdata-h66',
    device:'synthetic-dense-source',signal,value,unit:signal.endsWith('_temperature')?'degC':'state',sourceTime:at,receivedAt:at,quality:[],raw:{usableForControl:true,retained:false}});
  store.transaction(()=>{
    recordLearningContext(store,'mqtt',{phase:'normal',regime:'occupied',targetC:21,roomBoostC:0},from,{config});
    for(const [signal,value] of Object.entries({indoor_temperature:21,outdoor_temperature:3,compressor_active:1,dhw_routing:0,auxiliary_output:0,
      heating_integral:-100,supply_temperature:35,heating_setpoint:36,brine_in_temperature:0,alarm_active:0,operating_mode:1})) record(signal,value,from);
  });
  for(let first=0;first<2300;first+=64) store.transaction(()=>{
    for(let i=first;i<Math.min(2300,first+64);i++) record('supply_temperature',35+(i%100)/100,from+Math.floor((i+1)*(WINDOW-1)/2300));
  });
  const sample=committedLearningSample({store,input:'mqtt',at:start,config});
  const rows=sample.inputSegments;
  seedCycleEvidence(store,{input:'mqtt',cycle:{id:'synthetic-dense-cycle',startedAt:from,status:'completed',endedAt:start,plan:{model:{trainedAt:from}}},
    samples:[{at:start,rows,provenance:sample.provenance}]});
  return sample;
}
async function pinned(f,t,writer) {
  const donor=new Store(await f.snapshot(writer),{readOnly:true});donor.db.exec('BEGIN');t.after(()=>donor.close());return donor;
}

test('dense accepted provenance fingerprints once per pinned source group, with bounded digest-only reuse',async t=>{
  const f=fixture(t),sample=dense(f.master),donor=await pinned(f,t,f.master);
  const group=donor.db.prepare('SELECT * FROM learning_cycle_samples').get();
  assert.equal(sample.inputSegments.length,2301);
  assert.equal(sample.provenance.lineage.supply_temperature.observations.length,2301);
  const expected=sourceFingerprint(donor,'learning_cycle_samples',group);
  const session=pinnedSourceFingerprints(donor,{binding:'synthetic-snapshot'});t.after(()=>session.close());
  assert.equal(session.fingerprint('learning_cycle_samples',group),expected);
  const before=session.stats.expandedReferences;
  for(const row of donor.db.prepare('SELECT * FROM learning_cycle_observations ORDER BY ordinal').iterate())
    assert.match(session.fingerprint('learning_cycle_observations',row),/^[a-f0-9]{64}$/);
  assert.ok(session.stats.expandedReferences-before<=4,'intervals reuse the parent source fingerprint instead of expanding its 2312 reports again');
  assert.ok(session.stats.entries<=256);
  const first=donor.db.prepare('SELECT * FROM learning_cycle_observations ORDER BY ordinal LIMIT 1').get();
  assert.match(sourceFingerprint(donor,'learning_cycle_observations',{...first,payload:'{}'}),/^[a-f0-9]{64}$/,'a cold dense parent is not charged to the small interval row budget');
  assert.equal(session.fingerprint('learning_cycle_observations',first),sourceFingerprint(donor,'learning_cycle_observations',first));
  const changed={...group,context:JSON.stringify({changed:true})};
  assert.notEqual(session.fingerprint('learning_cycle_samples',changed),expected,'same local ID with a different supplied row is not a cache hit');
  session.close();assert.throws(()=>session.fingerprint('learning_cycle_samples',group),{code:'RECOVERY_INVALID'});
  assert.throws(()=>pinnedSourceFingerprints(f.master,{binding:'mutable'}),/pinned read-only source/);
});

test('ordinary fingerprints observe mutable evidence; repeated IDs count only actual expansion work',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const id=store.observation({source:'synthetic',device:'invented',signal:'indoor_temperature',unit:'degC',value:21,sourceTime:start,receivedAt:start});
  const event={type:'invented',at:start,payload:JSON.stringify({observations:Array(5000).fill(id)})};
  const before=sourceFingerprint(store,'events',event);
  store.transaction(()=>store.db.prepare('UPDATE observations SET value=22 WHERE id=?').run(id));
  assert.notEqual(sourceFingerprint(store,'events',event),before,'mutable calls never reuse source graph digests');
  assert.throws(()=>sourceFingerprint(store,'events',{...event,payload:JSON.stringify({observationId:id+1})}),/missing record/);
});

test('dense cycle fingerprints are prepared outside the writer and cancellation stops before admission',async t=>{
  const f=fixture(t);dense(f.master);const donor=await pinned(f,t,f.master),target=new Store(':memory:');t.after(()=>target.close());
  const abort=new AbortController();let prepared=0,yields=0;
  const recoveryId=target.transaction(()=>beginRecovery(target,{input:'mqtt',donorDigest:'a'.repeat(64)}));
  const merge=new HistoryMerge({target,donor,input:'mqtt',donorDigest:'a'.repeat(64),recoveryId,signal:abort.signal,
    yieldControl:async()=>{yields++;if(prepared)abort.abort();}});
  const original=merge.fingerprintSession.fingerprint.bind(merge.fingerprintSession);
  merge.fingerprintSession.fingerprint=(...args)=>{assert.equal(target.db.isTransaction,false,'source expansion cannot own target writer');prepared++;return original(...args);};
  await assert.rejects(merge.rows('learning_cycle_samples',()=>{throw Error('must not enter writer callback');}),{name:'AbortError'});
  assert.ok(prepared>0 && yields>0);
  assert.equal(target.db.prepare('SELECT COUNT(*) n FROM learning_cycle_samples').get().n,0);
});

test('dense complete-window journal and normalized cycle recover while independent target writes continue',async t=>{
  const f=fixture(t),writer=await f.donor(),sample=dense(writer);
  await writer.startWriter();const learning=new LiveLearning({store:writer,input:'mqtt'});
  try {await learning.calculate('append-sample',{value:sample,config},null);}finally{await learning.close();}
  const snapshot=await f.snapshot(writer);await f.master.startWriter();
  let pending=null,writes=0,failure=null,maxWriteMs=0;
  const timer=setInterval(()=>{if(pending)return;const began=performance.now();pending=f.master.runWrite(()=>f.master.event('synthetic-during-recovery',{sequence:writes++}))
    .catch(error=>{failure??=error;}).finally(()=>{maxWriteMs=Math.max(maxWriteMs,performance.now()-began);pending=null;});},10);
  let result;
  try {result=await recover(f,snapshot);}finally{clearInterval(timer);await pending;}
  assert.ifError(failure);assert.equal(result.report.counts.skipped,0);
  assert.ok(writes>5,'controller writer advances while dense source graphs are processed');
  assert.ok(maxWriteMs<1500,`dense donor work must not monopolize the target writer (${maxWriteMs} ms)`);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_cycle_observations').get().n,2301);
  assert.deepEqual(f.master.db.prepare('SELECT payload FROM learning_cycle_observations ORDER BY ordinal').all().map(row=>JSON.parse(row.payload)),
    writer.db.prepare('SELECT payload FROM learning_cycle_observations ORDER BY ordinal').all().map(row=>JSON.parse(row.payload)));
  assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true}),result.checkpoint);
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(),undefined);
  t.diagnostic(JSON.stringify({intervals:2301,writes,maxWriteMs}));
});


test('fingerprint sessions retain their pinned interpretation and reject a changed source boundary',async t=>{
  const f=fixture(t);
  const id=f.master.observation({source:'synthetic',device:'invented',signal:'indoor_temperature',unit:'degC',value:21,sourceTime:start,receivedAt:start});
  const donor=new Store(f.master.path,{readOnly:true});donor.db.exec('BEGIN');t.after(()=>donor.close());
  const session=pinnedSourceFingerprints(donor,{binding:'invented-boundary'});t.after(()=>session.close());
  const row={type:'invented',at:start,payload:JSON.stringify({observationId:id})};
  const before=session.fingerprint('events',row);
  f.master.transaction(()=>f.master.db.prepare('UPDATE observations SET value=22 WHERE id=?').run(id));
  assert.equal(session.fingerprint('events',row),before,'an independent append cannot change the pinned snapshot');
  donor.db.exec('ROLLBACK; BEGIN;');
  assert.throws(()=>session.fingerprint('events',row),{code:'RECOVERY_INVALID'});
  const fresh=pinnedSourceFingerprints(donor,{binding:'new-invented-boundary'});t.after(()=>fresh.close());
  assert.notEqual(fresh.fingerprint('events',row),before);
});
