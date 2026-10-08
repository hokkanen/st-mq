import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'stmq-journal-'));
  const source=new Store(join(dir,'source.sqlite'));
  t.after(async()=>{try{source.close();}catch{} await rm(dir,{recursive:true,force:true});});
  const copy=async()=>{
    const path=join(dir,'replica.sqlite'); await source.backup(path);
    const store=new Store(path);t.after(()=>{try{store.close();}catch{}});return store;
  };
  return {dir,source,copy};
}
test('one transaction seals all actual row effects; rollback and nested savepoints leave no journal evidence',async t=>{
  const {source:s}=await fixture(t),genesis=s.checkpoint();
  s.transaction(()=>{
    s.setState('first',1);
    assert.throws(()=>s.transaction(()=>{s.setState('discarded',2);throw Error('rollback');}));
    s.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)').run('fixture','{}',1);
    s.setState('last',3);
  });
  const batch=s.exportChanges({after:genesis});
  assert.equal(batch.commits.length,1);
  assert.deepEqual(batch.commits[0].changes.map(c=>c.table),['state','events','state']);
  assert.equal(s.getState('discarded'),null);
  const committed=s.checkpoint();
  assert.throws(()=>s.transaction(()=>{s.setState('first',4);throw Error('outer rollback');}));
  assert.deepEqual(s.checkpoint(),committed);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM journal_pending').get().n,0);
  assert.equal(verifyJournal(s.db).commits,1);
});
test('direct prepared writes and multi-statement writes are journaled with savepoint-safe atomic capture',async t=>{
  const {source:s}=await fixture(t);
  s.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)').run('first','{}',1);
  s.db.exec("INSERT INTO events(type,payload,at) VALUES('second','{}',2); INSERT INTO events(type,payload,at) VALUES('third','{}',3)");
  assert.equal(s.checkpoint().sequence,2);
  assert.equal(s.exportChanges({after:s.checkpointAt(1)}).commits[0].changes.length,2);
});
test('replication applies an intact transaction atomically, including deletes, and repeated delivery never restores older values',async t=>{
  const {source,copy}=await fixture(t);source.setState('value',1);
  const replica=await copy(),base=replica.checkpoint();
  source.transaction(()=>{source.setState('value',2);source.setState('deleted',3);});
  source.transaction(()=>{source.db.prepare('DELETE FROM state WHERE key=?').run('deleted');source.event('fixture',{},2);});
  const first=source.exportChanges({after:base,limit:1});
  assert.equal(first.hasMore,true); replica.applyChanges(first);
  const second=source.exportChanges({after:first.to});replica.applyChanges(second);
  assert.deepEqual(replica.checkpoint(),source.checkpoint());
  assert.deepEqual(replica.applyChanges(first),source.checkpoint());
  assert.equal(replica.getState('value'),2);assert.equal(replica.getState('deleted'),null);
  assert.equal(verifyJournal(replica.db).commits,source.checkpoint().sequence);
});
test('damaged, truncated, reordered and wrong-lineage transfers fail before mutation',async t=>{
  const {source,copy}=await fixture(t),replica=await copy(),base=replica.checkpoint();
  source.setState('value',1);source.setState('value',2);
  const batch=source.exportChanges({after:base});
  const cases=[{...batch,commits:batch.commits.slice(0,1)}, {...batch,commits:[...batch.commits].reverse()},
    {...batch,from:{...batch.from,databaseId:'00000000-0000-0000-0000-000000000000'}},
    {...batch,unknown:true}, {...batch,commits:batch.commits.map((commit,i)=>i ? commit : {...commit,changes:[]})}];
  for(const damaged of cases){assert.throws(()=>replica.applyChanges(damaged));assert.deepEqual(replica.checkpoint(),base);assert.equal(replica.getState('value'),null);}
  replica.applyChanges(batch);assert.equal(replica.getState('value'),2);
});
test('row conflicts fence a transaction even if a checkpoint still matches',async t=>{
  const {source,copy}=await fixture(t);source.setState('value',1);const replica=await copy();
  source.setState('value',2);
  // Simulate disk/tool damage outside the application, without forging a valid journal.
  const raw=new DatabaseSync(replica.path);raw.prepare("UPDATE state SET value='9' WHERE key='value'").run();raw.close();
  assert.throws(()=>replica.applyChanges(source.exportChanges({after:replica.checkpoint()})),/checkpoint/);
  assert.equal(replica.getState('value'),9);
});
test('rejoin stores losing suffix before rewind and retains it across restart and subsequent replication',async t=>{
  const {source,copy}=await fixture(t);source.setState('common',1);const replica=await copy(),base=replica.checkpoint();
  replica.setState('private-tail',{observed:2});source.setState('master-tail',3);
  assert.deepEqual(source.commonCheckpoint(replica),base);
  const branch=replica.rewindTo(base,{preserve:true});
  assert.equal(replica.getState('private-tail'),null);
  assert.equal(replica.db.prepare('SELECT COUNT(*) n FROM journal_branch_commits WHERE branch_id=?').get(branch).n,1);
  replica.applyChanges(source.exportChanges({after:base}));const expected=replica.checkpoint();replica.close();
  const reopened=new Store(replica.path);t.after(()=>reopened.close());assert.deepEqual(reopened.checkpoint(),expected);
  const retained=JSON.parse(reopened.db.prepare('SELECT payload FROM journal_branch_commits WHERE branch_id=?').get(branch).payload);
  assert.deepEqual(retained.changes[0].after.value,JSON.stringify({observed:2}));
  assert.equal(reopened.getState('master-tail'),3);
});
test('kill during uncommitted write leaves exactly the last durable checkpoint',async t=>{
  const {source,dir}=await fixture(t);source.setState('committed',1);const before=source.checkpoint();source.close();
  const url=new URL('../src/storage/store.js',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',
    `import {Store} from ${JSON.stringify(url)}; const s=new Store(process.argv[1]);s.db.exec('BEGIN IMMEDIATE');s.setState('uncommitted',2);process.kill(process.pid,'SIGKILL');`,join(dir,'source.sqlite')]);
  assert.equal(result.signal,'SIGKILL');
  const reopened=new Store(join(dir,'source.sqlite'));t.after(()=>reopened.close());
  assert.deepEqual(reopened.checkpoint(),before);assert.equal(reopened.getState('uncommitted'),null);assert.equal(reopened.getState('committed'),1);
});
test('unsealed external changes fail startup without rewriting original bytes',async t=>{
  const {source}=await fixture(t);source.setState('value',1);source.close();
  const raw=new DatabaseSync(source.path);raw.prepare("INSERT INTO events(type,payload,at) VALUES('external','{}',1)").run();raw.close();
  const bytes=await readFile(source.path);
  assert.throws(()=>new Store(source.path),{code:'database_journal_invalid'});
  assert.deepEqual(await readFile(source.path),bytes);
});
