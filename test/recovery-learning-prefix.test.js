import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fixture,sample,recover,start,W } from './helpers/recovery-fixture.js';
import { replayLearningJournal,appendLearningRecord } from '../src/app/committed-learning.js';
import { previewRecoveryRevision,reviseRecovery } from '../src/recovery/service.js';

const measurements=[];
const io=()=>Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\n').map(line=>{const [key,value]=line.split(':');return [key,Number(value)];}));
for(const history of [256,4096]) test(`recent learned recovery and reversal retain ${history} entries without copying or replaying the prefix`,async t=>{
  const f=fixture(t);
  f.master.transaction(()=>{for(let i=1;i<=history;i++) {
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
