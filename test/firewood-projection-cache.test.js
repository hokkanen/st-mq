import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { readCheckpoint,checkpointAt,compactJournal } from '../src/storage/journal.js';
import { createDerivedCacheAnchorOwner } from '../src/storage/derived-cache-anchor.js';
import { addFireplace,removeFireplace } from '../src/app/fireplace.js';
import { FirewoodProjectionCache } from '../src/app/firewood-projection-cache.js';

const HOUR=3_600_000,DAY=24*HOUR,START=Date.UTC(2026,0,1),INPUT='mqtt';
const state=at=>({previous:null,cursor:at,blocked:false,scenarios:null,
  sourceGaps:0,unsupportedRows:0,resetCount:0,evidenceHours:0,observedKwh:0,predictedKwh:0,dutyErrorHours:0,auxErrorKwh:0,
  lastConfiguration:{},lastTargetC:21,assumptions:[],evidenceAfter:null,evidenceDays:[],fireEvidence:[],cleanEvidence:[],evidenceBurns:[]});

function fixture(t,{loads=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'stmq-forward-firewood-cache-')),path=join(directory,'synthetic.sqlite');
  const source=new Store(':memory:');let cache=new FirewoodProjectionCache(path);
  const first=loads?addFireplace(source,INPUT,{kg:8,requestId:'first-synthetic-load'},START):null;
  const last=loads?addFireplace(source,INPUT,{kg:6,requestId:'last-synthetic-load'},START+10*DAY):null;
  const at=START+10*DAY+6*HOUR;
  function manual(now=at,options={}) {return cache.manual(source,INPUT,now,{advance:true,...options});}
  assert.equal(manual().complete,true);
  cache.generation(INPUT,'same-numerical-model',source.db,100,at);
  cache.save(INPUT,{at,cursor:100,state:state(at)},{checkpoint:true,head:100,sourceDb:source.db});
  t.after(()=>{cache.close();source.close();rmSync(directory,{recursive:true,force:true});});
  return {source,path,at,first,last,get cache(){return cache;},manual,
    add(now,requestId='synthetic-forward-load'){return addFireplace(source,INPUT,{kg:4,requestId},now);},
    reopen(){cache.close();cache=new FirewoodProjectionCache(path);return cache;}};
}
const snapshots=f=>f.cache.db.prepare('SELECT cursor,at,hex(payload) payload,digest FROM snapshots ORDER BY cursor').all();
const generation=f=>f.cache.db.prepare('SELECT * FROM generation WHERE input=?').get(INPUT);
const groups=f=>f.cache.db.prepare('SELECT id,at FROM manual_groups WHERE input=? ORDER BY at,id').all(INPUT);

// Use the real source-owned protocol, asynchronously at the fixture boundary.
// The production worker bridges its synchronous cache callback to this owner.
async function publish(f) {
  const owner=createDerivedCacheAnchorOwner({store:f.source,cacheId:f.cache.cacheId,purpose:'firewood'});
  const source=readCheckpoint(f.source.db),selection=f.source.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
  const pin=await owner({operation:'pin',input:INPUT,source,selection});
  f.cache.db.prepare('UPDATE generation SET pending=? WHERE input=?').run(JSON.stringify(pin),INPUT);
  const proof=await owner({operation:'publish',input:INPUT,source,selection,token:pin.token,digest:f.cache.catalog(INPUT)});
  f.cache.db.prepare('UPDATE generation SET pending=NULL,published=? WHERE input=?').run(JSON.stringify(proof),INPUT);
  return proof;
}

test('ordinary forward loads preserve numerical bodies and stable 24-hour burn anchors',t=>{
  const f=fixture(t),before=snapshots(f),originalGroups=groups(f);
  const reload=f.add(f.at+HOUR);
  assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.deepEqual(snapshots(f),before);
  assert.deepEqual(groups(f),originalGroups,'A reload within 24 hours keeps the original burn-group identity');
  assert.equal(generation(f).signature,'same-numerical-model');
  assert.equal(generation(f).head,100,'Manual admission must not advance the consumed learning head');
  assert.deepEqual(JSON.parse(generation(f).proof),readCheckpoint(f.source.db));
  const context=f.cache.context(INPUT,f.at,f.at+2*HOUR);
  assert.equal(context.fireplaceRevision,reload.revision);
  assert.ok(context.fireplaceEvents.some(row=>row.id===reload.id));
  const next=f.add(START+11*DAY+HOUR,'synthetic-next-burn');
  assert.equal(f.manual(START+11*DAY+HOUR).complete,true);
  assert.deepEqual(snapshots(f),before);
  assert.deepEqual({...groups(f).at(-1)},{id:String(next.id),at:next.at});
});

test('large forward-load tails classify in bounded pages and resume after restart and further appends',t=>{
  const f=fixture(t),before=snapshots(f);
  for(let i=0;i<130;i++)f.add(f.at+HOUR+i,`synthetic-tail-${i}`);
  const first=f.manual(f.at+2*HOUR,{maxRows:17});
  assert.equal(first.complete,false);assert.equal(first.phase,'append');
  assert.equal(first.cursor,f.last.id+17);
  assert.equal(f.cache.context(INPUT,f.at,f.at+2*HOUR),null,'Unclassified source revisions cannot supply a ready comparison');
  assert.deepEqual(snapshots(f),before);
  f.reopen();f.add(f.at+HOUR+131,'synthetic-tail-after-restart');
  let result,turns=0;
  do {const prior=f.cache.db.prepare('SELECT cursor FROM manual_meta WHERE input=?').get(INPUT).cursor;
    result=f.manual(f.at+2*HOUR,{maxRows:17});assert.ok(result.cursor-prior<=17);assert.ok(++turns<10);
  } while(!result.complete);
  assert.equal(result.cursor,f.source.db.prepare('SELECT MAX(id) id FROM active_fireplace_events WHERE input=?').get(INPUT).id);
  assert.deepEqual(snapshots(f),before);
});

test('forward source admission also preserves burn anchors when numerical preparation has no saved state',t=>{
  const f=fixture(t),before=groups(f);
  f.cache.invalidate(INPUT);
  f.cache.generation(INPUT,'new-numerical-generation',f.source.db,100,f.at);
  const added=f.add(f.at+HOUR);
  assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.deepEqual(groups(f),before);
  assert.equal(generation(f).signature,'new-numerical-generation');
  assert.equal(snapshots(f).length,0);
  assert.equal(f.cache.context(INPUT,f.at,f.at+2*HOUR).fireplaceRevision,added.revision);
});

test('failed append classification rolls back its group and cursor and resumes after restart',t=>{
  const f=fixture(t),before=snapshots(f),originalGroups=groups(f);
  f.add(START+11*DAY+HOUR);
  const pending=f.cache.manual(f.source,INPUT,START+11*DAY+HOUR);
  assert.equal(pending.phase,'append');assert.equal(pending.complete,false);
  f.cache.db.exec(`CREATE TRIGGER synthetic_append_failure BEFORE UPDATE ON manual_meta
    WHEN NEW.phase='complete' BEGIN SELECT RAISE(ABORT,'synthetic interrupted append'); END`);
  assert.throws(()=>f.manual(START+11*DAY+HOUR),/synthetic interrupted append/);
  assert.deepEqual(groups(f),originalGroups);
  assert.equal(f.cache.db.prepare('SELECT cursor FROM manual_meta WHERE input=?').get(INPUT).cursor,pending.cursor);
  assert.equal(f.cache.context(INPUT,f.at,START+11*DAY+2*HOUR),null);
  assert.deepEqual(snapshots(f),before);
  f.cache.db.exec('DROP TRIGGER synthetic_append_failure');
  f.reopen();assert.equal(f.manual(START+11*DAY+HOUR).complete,true);
  assert.equal(groups(f).length,originalGroups.length+1);
  assert.deepEqual(snapshots(f),before);
});

test('an unsafe row after an admitted append page invalidates the entire old numerical prefix',t=>{
  const f=fixture(t);
  for(let i=0;i<20;i++)f.add(f.at+HOUR+i,`synthetic-safe-tail-${i}`);
  removeFireplace(f.source,INPUT,{id:f.first.id,requestId:'synthetic-later-removal'},f.at+2*HOUR);
  assert.equal(f.manual(f.at+2*HOUR,{maxRows:10}).complete,false);
  assert.equal(snapshots(f).length,1);
  assert.equal(f.manual(f.at+2*HOUR,{maxRows:10}).complete,false);
  assert.equal(f.manual(f.at+2*HOUR,{maxRows:10}).phase,'groups');
  assert.equal(snapshots(f).length,0);
  assert.equal(generation(f),undefined);
});

for(const kind of ['removal','backdated','equal-boundary','future','rollback','selection','source-identity','first-fire']) {
  test(`forward-load admission rejects ${kind} before a numerical prefix can be reused`,t=>{
    const f=fixture(t,{loads:kind!=='first-fire'});
    let now=f.at+HOUR;
    if(kind==='removal')removeFireplace(f.source,INPUT,{id:f.first.id,requestId:'synthetic-correction'},now);
    else if(kind==='backdated')f.add(f.at-HOUR);
    else if(kind==='equal-boundary')f.add(f.at);
    else if(kind==='future')f.add(now+HOUR);
    else if(kind==='rollback'){now=f.at-1;f.add(now);}
    else if(kind==='selection')f.source.db.prepare("UPDATE history_selection SET generation='synthetic-new-selection' WHERE id=1").run();
    else if(kind==='source-identity') {
      const other=new Store(':memory:');t.after(()=>other.close());
      addFireplace(other,INPUT,{kg:8,requestId:'synthetic-other-source'},START);
      f.cache.manual(other,INPUT,now,{advance:true});
      assert.equal(snapshots(f).length,0);return;
    } else f.add(now);
    f.manual(now);
    assert.equal(snapshots(f).length,0);
    assert.equal(generation(f),undefined);
  });
}

test('forward admission replaces catalog proofs and survives pruning after a new source-owned publication',async t=>{
  const f=fixture(t),original=await publish(f),before=snapshots(f);
  for(let i=0;i<8;i++)f.source.setState('synthetic-source-progress',i);
  compactJournal(f.source.db,{maxCommits:1,maxBytes:1024});
  assert.equal(checkpointAt(f.source.db,JSON.parse(generation(f).proof).sequence),null);
  assert.equal(f.cache.trustedAnchor(INPUT,f.source.db),true);
  let foregroundProofCalls=0;
  f.cache.anchor=()=>{foregroundProofCalls++;throw new Error('Foreground source admission must not wait for proof RPC');};
  f.add(f.at+HOUR);assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.equal(foregroundProofCalls,0);
  assert.deepEqual(snapshots(f),before);
  assert.equal(generation(f).pending,null);assert.equal(generation(f).published,null);
  assert.equal(f.cache.needsPublication(INPUT),true);
  assert.equal(f.cache.trustedAnchor(INPUT,f.source.db),false,'An old catalog digest cannot certify a newer source tail');
  assert.equal(f.cache.generation(INPUT,'same-numerical-model',f.source.db,100,f.at+HOUR,false).notReady,undefined);
  const replacement=await publish(f);assert.notEqual(replacement.token,original.token);
  for(let i=0;i<8;i++)f.source.setState('synthetic-source-progress',i+20);
  compactJournal(f.source.db,{maxCommits:1,maxBytes:1024});
  f.reopen();assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.deepEqual(snapshots(f),before);assert.equal(f.cache.trustedAnchor(INPUT,f.source.db),true);
});

test('an intact older manual proof cannot bless an unproven newer numerical generation',t=>{
  const f=fixture(t),before=groups(f);
  const proof=readCheckpoint(f.source.db);
  f.cache.db.prepare('UPDATE generation SET proof=? WHERE input=?')
    .run(JSON.stringify({...proof,sequence:proof.sequence+100}),INPUT);
  f.add(f.at+HOUR);
  assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.deepEqual(groups(f),before,'The separately proven source grouping remains reusable');
  assert.equal(snapshots(f).length,0);
  assert.equal(generation(f),undefined,'New source admission must not replace missing numerical ancestry with its own proof');
});

test('resumed append pages check numerical ancestry again before refreshing their proof',t=>{
  const f=fixture(t);
  for(let i=0;i<12;i++)f.add(f.at+HOUR+i,`synthetic-recheck-${i}`);
  assert.equal(f.manual(f.at+2*HOUR,{maxRows:8}).complete,false);
  const proof=readCheckpoint(f.source.db);
  f.cache.db.prepare('UPDATE generation SET proof=? WHERE input=?')
    .run(JSON.stringify({...proof,hash:'0'.repeat(64)}),INPUT);
  assert.equal(f.manual(f.at+2*HOUR,{maxRows:8}).complete,true);
  assert.equal(snapshots(f).length,0);assert.equal(generation(f),undefined);
});

test('genuine numerical progress advances its verified manual fence before the old journal proof is pruned',t=>{
  const f=fixture(t),initial=JSON.parse(f.cache.db.prepare('SELECT proof FROM manual_meta WHERE input=?').get(INPUT).proof);
  for(let i=0;i<3;i++)f.source.setState('synthetic-live-progress',i);
  const proof=readCheckpoint(f.source.db);
  f.cache.save(INPUT,{at:f.at+HOUR,cursor:128,state:state(f.at+HOUR)},{head:256,sourceDb:f.source.db});
  assert.deepEqual(JSON.parse(f.cache.db.prepare('SELECT proof FROM manual_meta WHERE input=?').get(INPUT).proof),proof);
  compactJournal(f.source.db,{maxCommits:1,maxBytes:1024});
  assert.equal(checkpointAt(f.source.db,initial.sequence),null);
  assert.equal(f.manual(f.at+HOUR).complete,true);
  assert.equal(f.cache.latest(INPUT).cursor,128,'A bounded numerical turn must not lose all progress when its initial manual proof expires');
  assert.equal(f.cache.generation(INPUT,'same-numerical-model',f.source.db,256,f.at+HOUR,false).notReady,undefined);
});

test('progress cannot refresh a damaged or divergent manual fence',t=>{
  const f=fixture(t),before=snapshots(f),originalGeneration=generation(f);
  const proof=readCheckpoint(f.source.db);
  f.cache.db.prepare('UPDATE manual_meta SET proof=? WHERE input=?')
    .run(JSON.stringify({...proof,sequence:proof.sequence+100}),INPUT);
  f.cache.sealManual(INPUT);
  assert.throws(()=>f.cache.save(INPUT,{at:f.at+HOUR,cursor:128,state:state(f.at+HOUR)},
    {head:256,sourceDb:f.source.db}),/verified source boundary/);
  assert.deepEqual(snapshots(f),before);assert.deepEqual(generation(f),originalGeneration);
});

test('a model-generation replacement retains a published manual fence before dropping the old catalog',async t=>{
  const f=fixture(t);await publish(f);
  for(let i=0;i<8;i++)f.source.setState('synthetic-source-progress',i);
  compactJournal(f.source.db,{maxCommits:1,maxBytes:1024});
  assert.equal(f.manual().complete,true);
  const proof=readCheckpoint(f.source.db);
  assert.equal(f.cache.generation(INPUT,'new-numerical-model',f.source.db,100,f.at).reset,true);
  assert.deepEqual(JSON.parse(f.cache.db.prepare('SELECT proof FROM manual_meta WHERE input=?').get(INPUT).proof),proof);
  assert.equal(generation(f).published,null);
  f.cache.save(INPUT,{at:f.at,cursor:100,state:state(f.at)},{head:100,sourceDb:f.source.db});
  assert.equal(f.manual().complete,true);assert.equal(f.cache.latest(INPUT).cursor,100);
});

test('activated future rows rewind by source cursor and preserve demand, model identity and earlier exact bodies',async t=>{
  const f=fixture(t),before=snapshots(f);
  f.cache.save(INPUT,{at:f.at-HOUR,cursor:120,state:state(f.at-HOUR)},{checkpoint:true});
  f.cache.save(INPUT,{at:f.at+HOUR,cursor:140,state:state(f.at+HOUR)},{checkpoint:true,head:140,nextAt:f.at+2*HOUR,sourceDb:f.source.db});
  f.cache.request(INPUT,f.at-2*DAY);await publish(f);
  const sourceProof=readCheckpoint(f.source.db),want=f.cache.requested(INPUT);
  assert.equal(f.cache.generation(INPUT,'same-numerical-model',f.source.db,140,f.at+3*HOUR,false).notReady,undefined,'The caller handles activation from its earliest deferred source cursor');
  assert.equal(snapshots(f).length,3);
  assert.deepEqual(f.cache.rewind(INPUT,120,{sourceDb:f.source.db}),{removed:2,cursor:100});
  assert.deepEqual(snapshots(f),before,'A later cursor with an earlier timestamp is still removed');
  const after=generation(f);assert.equal(after.signature,'same-numerical-model');assert.equal(after.head,140);assert.equal(after.next_at,null);
  assert.equal(after.pending,null);assert.equal(after.published,null);assert.deepEqual(JSON.parse(after.proof),sourceProof);
  assert.equal(f.cache.requested(INPUT),want);
  assert.deepEqual(f.cache.rewind(INPUT,100,{sourceDb:f.source.db}),{removed:1,cursor:0},'An evicted/missing predecessor falls back to cold preparation');
});

test('a rewind cannot rebind an old numerical prefix to another database identity',t=>{
  const f=fixture(t),other=new Store(':memory:');t.after(()=>other.close());
  assert.deepEqual(f.cache.rewind(INPUT,120,{sourceDb:other.db}),{removed:1,cursor:0});
  assert.equal(generation(f),undefined);
});

test('a genuine numerical model change still discards every old paired state',t=>{
  const f=fixture(t);f.add(f.at+HOUR);f.manual(f.at+HOUR);
  assert.equal(snapshots(f).length,1);
  assert.equal(f.cache.generation(INPUT,'different-numerical-model',f.source.db,100,f.at+HOUR,false).notReady,true);
  assert.equal(snapshots(f).length,1,'A requested read does not replace the generation');
  assert.equal(f.cache.generation(INPUT,'different-numerical-model',f.source.db,100,f.at+HOUR).reset,true);
  assert.equal(snapshots(f).length,0);
});

test('current cache states require an explicit finite-or-null electrical evidence cutoff',t=>{
  const f=fixture(t);
  assert.ok(f.cache.latest(INPUT));
  const missing=state(f.at);delete missing.evidenceAfter;
  f.cache.save(INPUT,{at:f.at,cursor:100,state:missing});
  assert.equal(f.cache.latest(INPUT),null);
  f.cache.save(INPUT,{at:f.at,cursor:100,state:{...state(f.at),evidenceAfter:'retired-or-invalid'}});
  assert.equal(f.cache.latest(INPUT),null);
  f.cache.save(INPUT,{at:f.at,cursor:100,state:{...state(f.at),evidenceAfter:f.at-DAY}});
  assert.equal(f.cache.latest(INPUT).state.evidenceAfter,f.at-DAY);
});

test('the previous disposable format is rebuilt without an old state decoder or source mutation',t=>{
  const f=fixture(t),source=readCheckpoint(f.source.db);
  f.cache.db.exec('PRAGMA user_version=7');
  f.reopen();
  assert.equal(f.cache.db.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(snapshots(f).length,0);assert.deepEqual(readCheckpoint(f.source.db),source);
});
