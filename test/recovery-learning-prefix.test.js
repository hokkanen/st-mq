import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fixture,sample,recover,start,W } from './helpers/recovery-fixture.js';
import { replayLearningJournal,appendLearningRecord } from '../src/app/committed-learning.js';
import { Store } from '../src/storage/store.js';
import { findLearningPrefix } from '../src/recovery/learning-prefix.js';
import { previewRecoveryRevision,reviseRecovery } from '../src/recovery/service.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';

const measurements=[];
const io=()=>Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(line=>{const [key,value]=line.split(':');return [key,Number(value)];}));
for(const history of [256,4096]) test(`recent learned recovery and reversal retain ${history} entries without copying or replaying the prefix`,async t=>{
  const f=fixture(t);
  for(let first=1;first<=history;first+=128) f.master.transaction(()=>{for(let i=first;i<=Math.min(history,first+127);i++) {
    if(i<=16) sample(f.master,start+i*W);
    else appendLearningRecord(f.master,'mqtt','context',{timestamp:start+i*W,phase:'normal',regime:'occupied',targetC:21,roomBoostC:0},{config:{}});
  }});
  const baseline=replayLearningJournal(f.master,'mqtt');
  const donor=await f.donor();
  sample(donor,start+(history+1)*W,{indoorC:21.1});
  f.master.transaction(()=>{sample(f.master,start+(history+2)*W);sample(f.master,start+(history+3)*W);});
  replayLearningJournal(f.master,'mqtt',baseline);
  const progress=[],donorPath=await f.snapshot(donor),initialIo=io(),started=performance.now();
  const recovered=await recover(f,donorPath,{onProgress:value=>progress.push(value)});
  const recoveredIo=io(),recoveryMs=performance.now()-started,metrics={history,databaseBytes:f.master.databaseBytes(),recoveryMs,readBytes:recoveredIo.rchar-initialIo.rchar,writeBytes:recoveredIo.wchar-initialIo.wchar};
  assert.equal(recovered.report.model.acceptedSamples,1);
  const direct=()=>f.master.db.prepare('SELECT COUNT(*) count FROM learning_journal_entries WHERE epoch=?').get(f.master.learningEpoch('mqtt')).count;
  const retained=()=>f.master.db.prepare('SELECT * FROM learning_epoch_segments WHERE epoch=?').all(f.master.learningEpoch('mqtt'));
  assert.equal(direct(),3,'only affected tail has new ordering rows');
  assert.equal(retained().length,1,'one descriptor retains the entire unchanged prefix');
  assert.equal(retained()[0].through_id,baseline.journalCursor);
  assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),recovered.checkpoint);
  assert(progress.filter(value=>value.phase==='rebuilding').every(value=>value.total===3));
  for(const active of [false,true]) {
    const args={store:f.master,input:'mqtt',recoveryId:recovered.report.recoveryId,active,signal:f.signal};
    const preview=await previewRecoveryRevision(args),steps=[];
    if(history===256 && !active) {
      let current=true;
      const selected=f.master.learningEpoch('mqtt'),saved=f.master.getState('adaptive:mqtt');
      await assert.rejects(reviseRecovery({...args,preview,isCurrent:()=>current,onProgress:value=>{
        if(value.phase==='rebuilding') current=false;
      }}),/authority changed/i);
      assert.equal(f.master.learningEpoch('mqtt'),selected,'interrupted suffix stays unpublished');
      assert.deepEqual(f.master.getState('adaptive:mqtt'),saved,'interruption retains the previous complete model');
    }
    const before=io(),started=performance.now();
    const changed=await reviseRecovery({...args,preview,onProgress:value=>steps.push(value)});
    const after=io();metrics[active?'restore':'revert']={ms:performance.now()-started,readBytes:after.rchar-before.rchar,writeBytes:after.wchar-before.wchar};
    assert.equal(direct(),active?3:2,'revision stages only affected tail');
    assert.equal(retained().length,1);
    assert.equal(retained()[0].through_id,baseline.journalCursor);
    assert(steps.filter(value=>value.phase==='rebuilding').every(value=>value.total<4));
    assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),changed.checkpoint);
  }
  measurements.push(metrics);
  const plan=f.master.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM learning_journal_all
    WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 64`).all(f.master.learningEpoch('mqtt'),'mqtt',baseline.journalCursor);
  t.diagnostic(JSON.stringify({...metrics,staged:direct(),ranges:retained().length,plan:plan.map(row=>row.detail)}));
  assert(plan.some(row=>/SEARCH e .*id>/.test(row.detail)),'tail reads seek by indexed journal ID');
  assert(!plan.some(row=>/^SCAN e\b/.test(row.detail)),'no historical journal scan');
  // EXPLAIN QUERY PLAN prints id>? even when SQLite seeks at the segment's
  // historical start and filters the requested cursor afterwards. Inspect the
  // real VM seek operand to ensure both branches seek the requested suffix.
  const vm=f.master.db.prepare(`EXPLAIN SELECT * FROM learning_journal_all
    WHERE epoch=? AND input=? AND id>? ORDER BY id LIMIT 64`).all(f.master.learningEpoch('mqtt'),'mqtt',baseline.journalCursor);
  const seeks=vm.filter(row=>row.opcode==='SeekGT' && Number(row.p4)===3);
  assert.equal(seeks.length,2);
  for(const seek of seeks) {
    const last=vm.filter(row=>row.addr<seek.addr && ((row.opcode==='Variable' || row.opcode==='Integer') && row.p2===seek.p3+2
      || row.opcode==='Column' && row.p3===seek.p3+2)).at(-1);
    assert.equal(last.opcode,'Variable');assert.equal(last.p1,3,'both range seeks start at the external cursor');
  }
});

test('backdated trailing context cannot hide later samples inside a reusable prefix',async t=>{
  const f=fixture(t);
  sample(f.master,start+W);
  const prior=replayLearningJournal(f.master,'mqtt');
  sample(f.master,start+3*W);
  appendLearningRecord(f.master,'mqtt','context',{timestamp:start+1.5*W,phase:'normal',regime:'occupied',targetC:21},{config:{}});
  const later=replayLearningJournal(f.master,'mqtt',prior);
  const {findLearningPrefix}=await import('../src/recovery/learning-prefix.js');
  const prefix=await findLearningPrefix(f.master,{input:'mqtt',epoch:'original',earliest:start+2*W,yieldControl:async()=>{}});
  assert.equal(prefix.cursor,prior.journalCursor);
  assert.notEqual(prefix.cursor,later.journalCursor);
});


test('learned-operation I/O stays bounded when retained history grows sixteen-fold',t=>{
  if(measurements.length!==2) return t.skip('requires both synthetic scale cases');
  const [small,large]=measurements;
  for(const operation of [null,'revert','restore']) {
    const before=operation?small[operation]:small,after=operation?large[operation]:large;
    assert(after.readBytes<before.readBytes*3+1024*1024,`${operation??'recover'} reads must not grow with retained history`);
    assert(after.writeBytes<before.writeBytes*3+1024*1024,`${operation??'recover'} writes must not copy retained history`);
  }
});

test('recovery and timeless revert reuse sparse checkpoints after transaction patches expire',async t=>{
  const f=fixture(t);
  f.master.transaction(()=>{for(let i=1;i<=16;i++) sample(f.master,start+i*W);});
  const baseline=replayLearningJournal(f.master,'mqtt');
  const donor=await f.donor();
  sample(donor,start+17*W,{indoorC:21.1});
  f.master.transaction(()=>{sample(f.master,start+18*W);sample(f.master,start+19*W);});
  replayLearningJournal(f.master,'mqtt',baseline);
  const expire=()=>{
    for(let i=0;i<4;i++) f.master.setState('synthetic-current-bookkeeping',{iteration:i});
    f.master.compactJournal({maxBytes:1024*1024,maxCommits:1});
  };
  expire();
  assert(f.master.journalBase().sequence>donor.checkpoint().sequence);
  const progress=[];
  const recovered=await recover(f,await f.snapshot(donor),{onProgress:value=>progress.push(value)});
  assert.equal(recovered.report.model.acceptedSamples,1);
  assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),recovered.checkpoint);
  assert(progress.filter(value=>value.phase==='rebuilding').every(value=>value.total===3),
    'expired transaction patches do not force the unchanged prefix to replay');
  assert.equal(f.master.db.prepare('SELECT through_id FROM learning_epoch_segments WHERE epoch=?')
    .get(f.master.learningEpoch('mqtt')).through_id,baseline.journalCursor);
  const sourceEntries=f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries WHERE source_entry_id IS NULL').get().n;
  for(const active of [false,true]) {
    expire();
    const args={store:f.master,input:'mqtt',recoveryId:recovered.report.recoveryId,active,signal:f.signal};
    const preview=await previewRecoveryRevision(args);
    const steps=[];
    const revised=await reviseRecovery({...args,preview,onProgress:value=>steps.push(value)});
    assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),revised.checkpoint);
    assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries WHERE source_entry_id IS NULL').get().n,sourceEntries,
      'compaction and selection preserve immutable source inputs');
    assert.equal(f.master.getState('synthetic-current-bookkeeping').iteration,3);
    assert(steps.filter(value=>value.phase==='rebuilding').every(value=>value.total<4));
  }
});


test('prefix lookup pins cached states and patches while the controller commits a new state',async t=>{
  const f=fixture(t);
  sample(f.master,start+W);
  const prior=replayLearningJournal(f.master,'mqtt');
  sample(f.master,start+3*W);
  replayLearningJournal(f.master,'mqtt',prior);
  const writer=new Store(f.master.path);t.after(()=>writer.close());
  const prepare=f.master.db.prepare.bind(f.master.db);let wrote=false;
  t.mock.method(f.master.db,'prepare',sql=>{
    const statement=prepare(sql);
    if(sql==='SELECT * FROM state WHERE key=?') {
      const get=statement.get.bind(statement);
      statement.get=(...args)=>{
        const row=get(...args);
        if(!wrote) {
          wrote=true;
          writer.db.prepare('UPDATE state SET updated_at=updated_at+1 WHERE key=?').run('adaptive:mqtt');
        }
        return row;
      };
    }
    return statement;
  });
  const prefix=await findLearningPrefix(f.master,{input:'mqtt',epoch:'original',earliest:start+2*W,yieldControl:async()=>{}});
  assert(wrote);assert.equal(prefix.cursor,prior.journalCursor);
  f.master.setState('synthetic-after-prefix',{recording:true});
  assert.deepEqual(f.master.getState('synthetic-after-prefix'),{recording:true},'lookup releases its own pinned snapshot');
});

for(const correction of ['fireplace','sensor','fireplace-removal']) test(`late ${correction} corrections and timeless reversal replay only their affected suffix`,async t=>{
  const f=fixture(t),history=128;
  f.master.transaction(()=>{for(let i=1;i<=history;i++) {
    if(i<=16) sample(f.master,start+i*W);
    else appendLearningRecord(f.master,'mqtt','context',{timestamp:start+i*W,phase:'normal',regime:'occupied',targetC:21,roomBoostC:0},{config:{}});
  }});
  const baseline=replayLearningJournal(f.master,'mqtt');
  if(correction==='sensor') addSensorChange(f.master,'mqtt',
    {signal:'indoor_temperature',reason:'replacement',requestId:'synthetic-late-sensor'},start+(history+1)*W,{config:{}});
  const load=correction==='fireplace-removal' ? addFireplace(f.master,'mqtt',
    {requestId:'synthetic-existing-late-load',kg:2},start+(history+1)*W) : null;
  const donor=await f.donor();
  if(correction==='fireplace') addFireplace(donor,'mqtt',
    {requestId:'synthetic-late-load',kg:2},start+(history+1)*W);
  else if(correction==='fireplace-removal') removeFireplace(donor,'mqtt',
    {requestId:'synthetic-recovered-late-removal',id:load.id},start+(history+4)*W);
  else {
    const id=donor.db.prepare("SELECT id FROM learning_journal WHERE json_type(payload,'$.value.sensorChange')='object'").get().id;
    revertSensorChange(donor,'mqtt',{id,requestId:'synthetic-late-reversal'},start+(history+4)*W,{config:{}});
  }
  for(const i of [2,3,5]) sample(f.master,start+(history+i)*W,{indoorC:21.1});
  replayLearningJournal(f.master,'mqtt',baseline);
  const expire=()=>{
    for(let i=0;i<4;i++) f.master.setState('synthetic-current-bookkeeping',{iteration:i});
    f.master.compactJournal({maxBytes:1024*1024,maxCommits:1});
  };
  const check=(result,steps)=>{
    const rebuilt=steps.filter(value=>value.phase==='rebuilding');
    assert(rebuilt.length>0);
    assert(rebuilt.every(value=>value.total<=5),'only records from the original affected time replay');
    assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),result.checkpoint);
    assert.equal(f.master.db.prepare('SELECT through_id FROM learning_epoch_segments WHERE epoch=?')
      .get(f.master.learningEpoch('mqtt')).through_id,baseline.journalCursor);
  };
  expire();
  const steps=[],recovered=await recover(f,await f.snapshot(donor),{onProgress:value=>steps.push(value)});
  check(recovered,steps);
  for(const active of [false,true]) {
    expire();
    const args={store:f.master,input:'mqtt',recoveryId:recovered.report.recoveryId,active,signal:f.signal};
    const preview=await previewRecoveryRevision(args),progress=[];
    const revised=await reviseRecovery({...args,preview,onProgress:value=>progress.push(value)});
    check(revised,progress);
  }
});

test('successive late recoveries retain exact source selection across compaction, reopen and nonsequential reversals',async t=>{
  const f=fixture(t),history=128;
  f.master.transaction(()=>{for(let i=1;i<=history;i++) {
    if(i<=16) sample(f.master,start+i*W);
    else appendLearningRecord(f.master,'mqtt','context',{timestamp:start+i*W,phase:'normal',regime:'occupied',targetC:21,roomBoostC:0},{config:{}});
  }});
  replayLearningJournal(f.master,'mqtt');
  const donor=await f.donor(),recoveries=[],selected=new Set(),local=new Set();
  const expireAndReopen=()=>{
    f.master.setState('synthetic-current-bookkeeping',{retained:true});
    f.master.compactJournal({maxBytes:1,maxCommits:1});
    const reopened=new Store(f.master.path,{readOnly:true});
    try {
      assert.deepEqual(reopened.getState('adaptive:mqtt'),f.master.getState('adaptive:mqtt'));
      assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM learning_checkpoints').get().n,
        f.master.db.prepare('SELECT COUNT(*) n FROM learning_checkpoints').get().n);
    } finally { reopened.close(); }
  };
  const verify=(result,progress)=>{
    const expected=[...Array.from({length:16},(_,i)=>i+1),...local,...selected].sort((a,b)=>a-b);
    assert.deepEqual(f.master.learningJournal({input:'mqtt',limit:1000}).filter(row=>row.kind==='sample').map(row=>row.at),
      expected.map(i=>start+i*W));
    assert.deepEqual(replayLearningJournal(f.master,'mqtt',null,{rebuild:true,persistCheckpoint:false}),result.checkpoint);
    assert(progress.filter(value=>value.phase==='rebuilding').every(value=>value.total<=9),
      'each correction replays only the recent affected suffix across flattened prefix ranges');
    assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(),undefined);
  };
  for(let index=0;index<3;index++) {
    const gap=history+index*3+1;
    sample(donor,start+gap*W,{indoorC:21+index/10});
    for(const at of [gap+1,gap+2]) {sample(f.master,start+at*W);local.add(at);}
    replayLearningJournal(f.master,'mqtt',f.master.getState('adaptive:mqtt'));
    expireAndReopen();
    const progress=[],result=await recover(f,await f.snapshot(donor),{onProgress:value=>progress.push(value)});
    recoveries.push({id:result.report.recoveryId,gap});selected.add(gap);
    verify(result,progress);
  }
  const originalSources=f.master.db.prepare('SELECT id,payload FROM learning_journal_entries WHERE source_entry_id IS NULL ORDER BY id').all();
  for(const [index,active] of [[1,false],[0,false],[1,true],[2,false],[0,true],[2,true]]) {
    expireAndReopen();
    const operation=recoveries[index],args={store:f.master,input:'mqtt',recoveryId:operation.id,active,signal:f.signal};
    const preview=await previewRecoveryRevision(args),progress=[];
    const result=await reviseRecovery({...args,preview,onProgress:value=>progress.push(value)});
    if(active) selected.add(operation.gap);else selected.delete(operation.gap);
    verify(result,progress);
    assert.deepEqual(f.master.db.prepare('SELECT id,payload FROM learning_journal_entries WHERE source_entry_id IS NULL ORDER BY id').all(),originalSources,
      'revisions retain every immutable source input even when another recovery remains excluded');
  }
});
