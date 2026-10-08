import { registerJournalFunctions, encodeChange } from '../src/storage/journal-codec.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { verifyJournal, resolveChange } from '../src/storage/journal.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'stmq-journal-'));
  const source=new Store(join(dir,'source.sqlite'));
  t.after(async()=>{try{source.close();}catch{} await rm(dir,{recursive:true,force:true});});
  return {dir,source};
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
  const raw=new DatabaseSync(source.path); registerJournalFunctions(raw);raw.prepare("INSERT INTO events(type,payload,at) VALUES('external','{}',1)").run();raw.close();
  const bytes=await readFile(source.path);
  assert.throws(()=>new Store(source.path),{code:'database_journal_invalid'});
  assert.deepEqual(await readFile(source.path),bytes);
});

test('startup preserves malformed WAL companions instead of silently opening older main-file contents',async t=>{
  const {source}=await fixture(t);source.setState('committed',1);source.close();
  const main=await readFile(source.path),wal=Buffer.from('synthetic damaged write-ahead journal');
  await writeFile(`${source.path}-wal`,wal);
  for(const readOnly of [false,true]) {
    assert.throws(()=>new Store(source.path,{readOnly}),{code:'database_integrity_failed'});
    assert.deepEqual(await readFile(source.path),main);
    assert.deepEqual(await readFile(`${source.path}-wal`),wal);
  }
});

test('read-only startup validates one checkpoint while a concurrent writer advances',async t=>{
  const {source}=await fixture(t);source.setState('before-read',1);
  const prepare=DatabaseSync.prototype.prepare;
  let armed=true;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql) {
    const statement=prepare.call(this,sql);
    if(sql==='SELECT database_id,sequence,hash FROM journal_meta WHERE id=1') {
      const get=statement.get.bind(statement);
      statement.get=(...args)=>{
        const result=get(...args);
        if(armed) {armed=false;source.setState('during-read',2);}
        return result;
      };
    }
    return statement;
  });
  const reader=new Store(source.path,{readOnly:true});t.after(()=>reader.close());
  assert.equal(armed,false);
  assert.deepEqual(reader.checkpoint(),source.checkpoint());
  assert.equal(reader.getState('during-read'),2);
});

test('raw transaction-control batches and outer savepoints fail before mutation',async t=>{
  const {source:s}=await fixture(t),before=s.checkpoint();
  for(const sql of ["BEGIN; INSERT INTO events(type,payload,at) VALUES('bad','{}',1); COMMIT",'SAVEPOINT outer',
    "PRAGMA busy_timeout=0; BEGIN; INSERT INTO events(type,payload,at) VALUES('bad','{}',1); COMMIT"])
    assert.throws(()=>s.db.exec(sql),{code:'journal_transaction_boundary_invalid'});
  assert.throws(()=>s.db.prepare('COMMIT'),{code:'journal_transaction_boundary_invalid'});
  assert.deepEqual(s.checkpoint(),before);assert.equal(s.events().length,0);
  s.setState('still-writable',true);assert.equal(s.getState('still-writable'),true);
});
test('JSON SQL subtypes are captured as stored text and CTE reads require no writer transaction',async t=>{
  const {source:s}=await fixture(t);
  s.db.exec("INSERT INTO events(type,payload,at) VALUES('fixture',json_object('value','synthetic'),1)");
  const batch=s.exportChanges({after:s.checkpointAt(0)});
  assert.equal(batch.commits[0].changes[0].after.payload,'{"value":"synthetic"}');
  assert.equal([...s.db.prepare('/* prefix */ WITH values_read AS (SELECT 1 n) SELECT n FROM values_read').iterate()][0].n,1);
  assert.equal(s.checkpoint().sequence,1);
});

test('compact payload updates validate the complete current event contract before mutation',async t=>{
  const {source:s}=await fixture(t);
  s.event('charging-session-check',{version:1,source:'easee'},1);
  const row={...s.db.prepare('SELECT * FROM events').get()},head=s.checkpoint();
  const after={...row,payload:JSON.stringify({version:0,source:'easee'})};
  const change=encodeChange('events',[row.id],row,after);
  assert.equal(change.after.type,undefined,'The update carries no unchanged event type');
  assert.throws(()=>resolveChange(change,row),{code:'database_state_incompatible'});
  assert.throws(()=>s.db.prepare('UPDATE events SET payload=? WHERE id=?').run(after.payload,row.id),
    {code:'database_state_incompatible'});
  assert.deepEqual(s.checkpoint(),head);
  assert.deepEqual({...s.db.prepare('SELECT * FROM events').get()},row);
});
