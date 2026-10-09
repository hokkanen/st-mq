import { registerJournalFunctions } from '../src/storage/journal-codec.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { importCsv } from '../src/storage/history.js';
import { Recorder } from '../src/storage/recorder.js';
const header='unix_time,price,heat_on,temp_in,temp_ga,temp_out\n';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'stmq-audit-storage-')), path=join(dir,'db.sqlite'), store=new Store(path);
  t.after(()=>{try {store.close();}catch{} rmSync(dir,{recursive:true,force:true});});
  return {dir,path,store};
}

for (const altered of ['1788220800,1,60,29,10,3\n','1788220800,1,60,29,10,3\n1788224400,1,60,30,10,3\n','']) {
  test(`A08-001 changed-byte generation is discarded on stable retry (${altered.length} bytes)`,async t=>{
    const {store,dir}=fixture(t), file=join(dir,'st-mq.csv'), changed=join(dir,'changed.csv');
    const original=header+'1788220800,1,60,21,10,3\n';
    writeFileSync(file,original); writeFileSync(changed,header+altered);
    const create=fs.createReadStream; let reads=0;
    fs.createReadStream=function(path,...args) {return create.call(this,path===file && ++reads===2?changed:path,...args);}; syncBuiltinESMExports();
    try {await assert.rejects(importCsv(store,file,{kind:'stmq',batchSize:1}),/changed while importing/);}
    finally {fs.createReadStream=create;syncBuiltinESMExports();}
    assert.equal(store.observations().length,0);
    const result=await importCsv(store,file,{kind:'stmq',batchSize:1});
    assert.equal(result.rows,1);assert.equal(store.observations().length,5);
    assert.equal(store.observations({signal:'indoor_temperature'})[0].value,21);
    assert.equal(store.importRow(result.importId,1).raw,original.split('\n')[1]);
    assert.equal(store.importRow(result.importId,2),null);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  });
}

test('A08-002 training consumes strict canonical values without reparsing quoted CSV',async t=>{
  const {store,dir}=fixture(t),file=join(dir,'st-mq.csv');
  writeFileSync(file,header+'1788220800,1,60,21,"1,2",3\n1788224400,1,0x0,21,10,0x10\n1788228000,1,"6e1",21,"1""2","-3.5"\n');
  await importCsv(store,file,{kind:'stmq'});
  const rows=store.trainingRows(); assert.equal(rows[0].outdoorC,3);
  assert(!rows[0].quality.includes('invalid_numeric'),'unconsumed garage field does not poison training');
  assert.equal(rows[1].outdoorC,null);assert.equal(rows[1].action,null);
  assert(rows[1].quality.includes('invalid_numeric'));assert(rows[1].quality.includes('unknown_legacy_command'));
  assert.equal(rows[2].outdoorC,-3.5);assert.equal(rows[2].action,'normal');
});

for (const laterSource of [true,false]) test(`A08-003 later completion stays beyond committed cursor (source order ${laterSource})`,async t=>{
  const {store,dir,path}=fixture(t),a=join(dir,'a.csv'),b=join(dir,'b.csv');
  writeFileSync(a,header+`${laterSource?1788228000:1788220800},1,60,21,10,3\n`);
  writeFileSync(b,header+'1788224400,1,60,22,10,3\n');
  await assert.rejects(importCsv(store,a,{kind:'stmq',batchSize:1,onProgress(){throw Error('interrupted');}}),/interrupted/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n,0);
  await importCsv(store,b,{kind:'stmq'}); const cursor=store.trainingRows()[0].id; store.close();
  const reopened=new Store(path);t.after(()=>reopened.close());
  await importCsv(reopened,a,{kind:'stmq',batchSize:1});
  const next=reopened.trainingRows({afterId:cursor,limit:1});assert.equal(next.length,1);assert.equal(next[0].indoorC,21);
  assert.equal(reopened.trainingRows({afterId:next[0].id}).length,0);
  assert.equal((await importCsv(reopened,a,{kind:'stmq'})).skipped,true);
});

test('A08 import completion and audit event are atomic',async t=>{
  const {store,dir}=fixture(t),file=join(dir,'st-mq.csv');writeFileSync(file,header+'1788220800,1,60,21,10,3\n');
  const event=store.event;store.event=()=>{throw Error('event write failed');};
  await assert.rejects(importCsv(store,file,{kind:'stmq'}),/event write failed/);store.event=event;
  assert.equal(store.observations().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n,0);
  await importCsv(store,file,{kind:'stmq'});assert.equal(store.observations().length,5);
  assert.equal(store.events().filter(e=>e.type==='history.imported').length,1);
});

test('A08-004 coverage extension, recovery and unrelated streams cannot rewrite past availability',t=>{
  const {store}=fixture(t);const recorder=new Recorder(store,{clock:()=>5000});
  const row={source:'synthetic',device:'one',signal:'room_setting',value:20,unit:'degC',sourceTime:1000,receivedAt:1000};
  recorder.record(row);recorder.record({...row,value:null,sourceTime:null,receivedAt:2000,quality:['failed']});
  assert.equal(recorder.committedAt('room_setting',2500).value,null);
  recorder.record({...row,value:null,sourceTime:null,receivedAt:3000,quality:['failed']});
  assert.equal(recorder.committedAt('room_setting',2500).value,null);
  recorder.record({...row,sourceTime:4000,receivedAt:4000});
  assert.equal(recorder.committedAt('room_setting',2500).value,null);
  recorder.record({...row,device:'two',sourceTime:5000,receivedAt:5000});
  assert.equal(recorder.committedAt('room_setting',2500).value,null);
});

test('A08-005 exact retained transitions remain outside adaptive error metrics',t=>{
  const {store}=fixture(t),recorder=new Recorder(store,{clock:()=>6000});
  const states=[0,1,0,1,0];
  states.forEach((value,index)=>recorder.record({source:'synthetic',device:'one',signal:'compressor_active',
    value,unit:'state',sourceTime:1000+index*1000,receivedAt:1000+index*1000}));
  const saved=store.observations({signal:'compressor_active'}).sort((a,b)=>a.sourceTime-b.sourceTime);
  assert.deepEqual(saved.map(row=>row.value),states);
  // Independent hold reconstruction of this exact event channel has zero loss.
  for(let time=1000;time<6000;time+=37) {
    const reconstructed=saved.filter(row=>row.sourceTime<=time).at(-1).value;
    assert.equal(reconstructed,states[Math.min(4,Math.floor((time-1000)/1000))]);
  }
  const metric=recorder.status().exactParameters.find(row=>row.signal==='compressor_active').day;
  assert.equal(metric.normalizedRmsChange,null);
  assert.equal(recorder.status().parameters.length,0);
  assert.equal(Object.hasOwn(metric,'normalizedRmsError'),false);
});

test('A08-006 real SQLite FULL remains the primary error through nested rollback',t=>{
  const {store}=fixture(t);const pages=store.db.prepare('PRAGMA page_count').get().page_count;
  store.db.exec(`PRAGMA max_page_count=${pages+10}`);
  for(const nested of [false,true]) {
    let error;try{store.transaction(()=>nested?store.transaction(()=>store.setState('large','x'.repeat(2e6))):store.setState('large','x'.repeat(2e6)));}catch(e){error=e;}
    assert(error);assert.equal(error.errcode,13);assert.equal(store.getState('large'),null);assert.equal(store.transactionDepth,0);
    store.transaction(()=>store.setState('small',1));assert.equal(store.getState('small'),1);
  }
  store.transaction(()=>{assert.throws(()=>store.transaction(()=>{store.setState('aborted',1);throw Error('callback');}),/callback/);store.setState('continued',1);});
  assert.equal(store.getState('aborted'),null);assert.equal(store.getState('continued'),1);
});

for (const shape of ['unversioned','unversioned-sqlite-lookalike','current-sqlite-lookalike','wrong-structure','dangling-content']) test(`B12 unsupported database is rejected before mutation: ${shape}`,async t=>{
  const {dir}=fixture(t),path=join(dir,'unsupported.sqlite'),destination=join(dir,'restore.sqlite');
  if(shape==='dangling-content') {const db=new Store(path);db.snapshot({kind:'weather',source:'synthetic',fetchedAt:1000,payload:{}});db.close();}
  if(shape==='current-sqlite-lookalike') {const db=new Store(path);db.close();}
  const raw=new DatabaseSync(path); registerJournalFunctions(raw);
  if(shape==='unversioned')raw.exec('CREATE TABLE unrelated(value TEXT)');
  if(shape.endsWith('sqlite-lookalike'))raw.exec("CREATE TABLE sqliteXcustom(value TEXT); INSERT INTO sqliteXcustom VALUES ('preserve me')");
  if(shape==='wrong-structure')raw.exec(`CREATE TABLE state(key TEXT);PRAGMA user_version=${SCHEMA_VERSION}`);
  if(shape==='dangling-content')raw.exec('PRAGMA foreign_keys=OFF;DELETE FROM provider_snapshot_contents');
  raw.close();const before=readFileSync(path);
  const rejection = shape === 'dangling-content' ? { code: 'database_journal_invalid' } : /Unsupported|Malformed/;
  assert.throws(()=>new Store(path),rejection);assert.deepEqual(readFileSync(path),before);
  assert.throws(()=>new Store(path,{readOnly:true}),rejection);assert.deepEqual(readFileSync(path),before);
  const restoreRejection = shape === 'dangling-content'
    ? { code: 'backup_source_invalid', details: { code: 'database_journal_invalid' } } : rejection;
  await assert.rejects(Store.restore(path,destination),restoreRejection);assert(!existsSync(destination));assert.deepEqual(readFileSync(path),before);
});
