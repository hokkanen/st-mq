import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { Store,validateCurrentDatabase } from '../src/storage/store.js';
import { appendLearningRecord,replayLearningJournal } from '../src/app/committed-learning.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { readCoefficientCoverage,readCoefficientEvents,createCoefficientGeneration,appendCoefficientEvents,
  publishCoefficientGeneration,discardCoefficientGeneration,cleanupRetiredCoefficientGenerations } from '../src/storage/coefficient-history.js';
import { coefficientProjectionAt } from '../src/storage/coefficient-history.js';
import { createSourceSnapshot } from '../src/replication/transport.js';
import { ownedDirectory,publishSnapshot } from '../src/replication/publication.js';
import { acceptPeerPublication,applyPeerPublication } from '../src/replication/journal-publication.js';
import { PeerTransfers,peerOperation,receivePeerTransfer } from '../src/replication/coalesced.js';

const start=Date.parse('2026-01-01T00:00Z');
function fixture(t){const directory=mkdtempSync(join(tmpdir(),'stmq-coefficient-history-')),store=new Store(join(directory,'main.sqlite'));
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return{directory,store};}
function learn(store,count=10){for(let i=0;i<count;i++)appendLearningRecord(store,'mqtt','context',{timestamp:start+i*900_000,
 historySeed:{model:initialAdaptiveModel({thermalPriors:{lossPerHour:.02+i*.001}}),source:{basis:'invented-coefficient-storage-test'}}},{config:{}});
 return replayLearningJournal(store,'mqtt');}
function copyRows(store,source,generation){const rows=store.db.prepare('SELECT cursor,at,coefficients,projection FROM coefficient_events WHERE generation=? ORDER BY cursor').all(source);
 return rows.map(row=>({cursor:row.cursor,at:row.at,coefficients:JSON.parse(row.coefficients),
  projection:coefficientProjectionAt(store,{input:'mqtt',generation:source,cursor:row.cursor})}));}

test('coefficient rows replicate with their selected model under the ordinary journal and exact content verification',async t=>{
 const {directory,store}=fixture(t),replicaDirectory=join(directory,'replica');await ownedDirectory(replicaDirectory,'.st-mq-replica');
 await peerOperation('enroll',{dbPath:store.path});
 const generation=randomUUID(),incoming=join(replicaDirectory,`incoming-${generation}.sqlite`),metadata=await createSourceSnapshot({dbPath:store.path,destination:incoming});
 await publishSnapshot(replicaDirectory,incoming,{...metadata,generation,verifiedAt:Date.now()});
 const before=await acceptPeerPublication({directory:replicaDirectory});
 store.transaction(()=>learn(store,4));
 const transfers=new PeerTransfers(join(directory,'changes')),peer={request:(operation,value)=>operation==='peer-transfer'
  ?transfers.export({dbPath:store.path,...value}):transfers.chunk(value)};
 const transfer=await receivePeerTransfer({directory:join(directory,'receive'),peer,after:before.checkpoint});
 const after=await applyPeerPublication({directory:replicaDirectory,transfer,metadata:{...before,generation:randomUUID()}});
 const replica=new Store(after.dbPath,{readOnly:true});try{
  assert.deepEqual(replica.checkpoint(),store.checkpoint());
  assert.deepEqual(readCoefficientCoverage(replica,{input:'mqtt'}),readCoefficientCoverage(store,{input:'mqtt'}));
  assert.deepEqual(readCoefficientEvents(replica,{input:'mqtt'}),readCoefficientEvents(store,{input:'mqtt'}));
  assert.equal(readCoefficientEvents(replica,{input:'mqtt'}).length,4);
  validateCurrentDatabase(replica.db,{full:true,readOnly:true});
 }finally{replica.close();}
});

test('retired generation cleanup is bounded and never removes selected or referenced prefix evidence',t=>{
 const {store}=fixture(t),checkpoint=learn(store),before=readCoefficientCoverage(store,{input:'mqtt'});
 let replacement;
 store.transaction(()=>{replacement=createCoefficientGeneration(store,'mqtt');appendCoefficientEvents(store,replacement,{
  events:copyRows(store,before.generation),projection:coefficientProjectionAt(store,{input:'mqtt',cursor:checkpoint.journalCursor})});
  publishCoefficientGeneration(store,'mqtt',replacement,checkpoint);});
 assert.equal(store.transaction(()=>cleanupRetiredCoefficientGenerations(store,{limit:3})).removed,3);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM coefficient_events WHERE generation=?').get(before.generation).n,7);
 while(!store.transaction(()=>cleanupRetiredCoefficientGenerations(store,{limit:3})).complete){}
 assert.equal(readCoefficientEvents(store,{input:'mqtt'}).length,10);
 const prefix=store.transaction(()=>createCoefficientGeneration(store,'mqtt',{prefixCursor:checkpoint.journalCursor}));
 assert.deepEqual(store.transaction(()=>discardCoefficientGeneration(store,replacement)),{removed:0,complete:false});
 assert.deepEqual(store.transaction(()=>discardCoefficientGeneration(store,prefix)),{removed:0,complete:true});
 assert.deepEqual(store.transaction(()=>discardCoefficientGeneration(store,replacement)),{removed:0,complete:false},'The active interpretation is always retained');
});

test('unsupported current coefficient metadata is rejected before writable startup mutation',t=>{
 const {directory,store}=fixture(t);learn(store,2);
 const generation=readCoefficientCoverage(store,{input:'mqtt'}).generation;
 const projection=JSON.parse(store.db.prepare('SELECT projection FROM coefficient_generations WHERE id=?').get(generation).projection);
 store.transaction(()=>store.db.prepare('UPDATE coefficient_generations SET projection=? WHERE id=?').run(JSON.stringify({...projection,retiredShape:true}),generation));
 store.close();
 const fingerprint=()=>Object.fromEntries(readdirSync(directory).filter(name=>!name.endsWith('-shm')).map(name=>[name,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')]));
 const before=fingerprint();assert.throws(()=>new Store(store.path),{code:'database_state_incompatible'});
 const after=fingerprint();for(const[name,digest]of Object.entries(before))assert.equal(after[name],digest,name);
});

test('coefficient publication refuses a staged generation for another selected history',t=>{
 const {store}=fixture(t),checkpoint=learn(store,3),before=readCoefficientCoverage(store,{input:'mqtt'});
 const candidate=store.transaction(()=>{
  const generation=createCoefficientGeneration(store,'mqtt',{selection:'synthetic-other-history'});
  appendCoefficientEvents(store,generation,{events:copyRows(store,before.generation),
   projection:coefficientProjectionAt(store,{input:'mqtt',cursor:checkpoint.journalCursor})});
  return generation;
 });
 const durable=store.checkpoint();
 assert.throws(()=>store.transaction(()=>publishCoefficientGeneration(store,'mqtt',candidate,checkpoint)));
 assert.deepEqual(store.checkpoint(),durable);
 assert.deepEqual(readCoefficientCoverage(store,{input:'mqtt'}),before);
 assert.deepEqual(store.getState('adaptive:mqtt'),checkpoint);
});
