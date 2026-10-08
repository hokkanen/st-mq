import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { verifyJournal } from '../src/storage/journal.js';
import { registerJournalFunctions } from '../src/storage/journal-codec.js';
import { enrollJournalPeer,peerAnchor,preparePeerTransfer,peerTransferRows,acknowledgePeer,applyPeerTransfer,rewindPeer,verifyPeerHistory } from '../src/storage/journal-peer.js';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'stmq-peer-log-')),a=new Store(join(dir,'a.sqlite'));
 a.setState('doc',{counter:0,payload:'unchanged'.repeat(300)});enrollJournalPeer(a.db);
 await a.backup(join(dir,'b.sqlite'));const b=new Store(join(dir,'b.sqlite'));
 t.after(async()=>{for(const s of[a,b])try{s.close();}catch{}await rm(dir,{recursive:true,force:true});});
 return {a,b,dir};
}
function* transferRows(a,id) {let afterOrdinal=-1;for(;;){const rows=peerTransferRows(a.db,{id,afterOrdinal,limit:16});if(!rows.length)return;for(const row of rows){afterOrdinal=row.ordinal;yield row.change;}}}
function apply(a,b,m) {return applyPeerTransfer(b.db,{...m,changes:transferRows(a,m.id)});}

test('long-offline peer receives only consolidated changes after repeated transaction compaction',async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint();
 for(let i=1;i<=256;i++){a.setState('doc',{counter:i,payload:'unchanged'.repeat(300)});if(i%16===0)a.compactJournal({maxCommits:8});}
 a.event('required',{meaning:'observed',at:123},123);
 assert(a.journalBase().sequence>base.sequence);
 assert.equal(a.db.prepare('SELECT COUNT(*) n FROM journal_peer_changes').get().n,2);
 const m=preparePeerTransfer(a.db,{after:base});assert.equal(m.rows,2);
 const wire=[...transferRows(a,m.id)];assert(Buffer.byteLength(JSON.stringify(wire))<2000);
 apply(a,b,m);assert.deepEqual(b.getState('doc'),a.getState('doc'));assert.deepEqual(b.events(),a.events());assert.deepEqual(b.checkpoint(),a.checkpoint());
 assert.deepEqual(preparePeerTransfer(a.db,{after:base}).target,m.target,'lost acknowledgement retains original target');
 assert.deepEqual(apply(a,b,m),b.checkpoint(),'committed delivery retry is harmless');
 assert(acknowledgePeer(a.db,{checkpoint:b.checkpoint()}).complete);verifyJournal(a.db);verifyJournal(b.db);
});

test('bounded acknowledgement resumes around concurrent updates, deletion and reinsertion',async t=>{
 const {a,b}=await fixture(t);
 for(let i=0;i<8;i++)a.setState(`key:${i}`,{value:1});
 const m=preparePeerTransfer(a.db,{after:b.checkpoint()});apply(a,b,m);
 assert.equal(acknowledgePeer(a.db,{checkpoint:m.target,limit:2}).complete,false);
 a.setState('key:0',{value:2});a.db.prepare('DELETE FROM state WHERE key=?').run('key:6');a.setState('key:7',{value:3});
 a.setState('new-after-target',{value:4});
 verifyPeerHistory(a.db);
 let result;do{result=acknowledgePeer(a.db,{checkpoint:m.target,limit:2});}while(!result.complete);
 verifyJournal(a.db);
 const next=preparePeerTransfer(a.db,{after:b.checkpoint()});assert.equal(next.rows,4);apply(a,b,next);
 for(const key of ['key:0','key:6','key:7','new-after-target'])assert.deepEqual(b.getState(key),a.getState(key));
 assert.deepEqual(b.checkpoint(),a.checkpoint());verifyJournal(b.db);
});

test('a rejected net transfer rolls back rows, peer baseline and checkpoint together',async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint();a.setState('doc',{counter:1});a.event('new',{},1);
 const m=preparePeerTransfer(a.db,{after:base}),changes=[...transferRows(a,m.id)];
 for(const damaged of [{...m,contentHash:'0'.repeat(64)}, {...m,rows:m.rows+1}]) {
  assert.throws(()=>applyPeerTransfer(b.db,{...damaged,changes}));assert.deepEqual(b.checkpoint(),base);assert.equal(b.events().length,0);assert.equal(b.getState('doc').counter,0);
 }
 apply(a,b,m);verifyJournal(b.db);
});

test('net divergent evidence survives active deletion, compaction and restart',async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint();
 b.setState('doc',{counter:22,payload:'unique'});b.event('divergent',{quality:['synthetic']},22);
 a.setState('doc',{counter:33});
 for(let i=0;i<30;i++)b.setState('bookkeeping',i);
 b.compactJournal({maxCommits:1});const id=rewindPeer(b.db,{checkpoint:base});
 const m=preparePeerTransfer(a.db,{after:base});apply(a,b,m);b.db.prepare('DELETE FROM state WHERE key=?').run('doc');b.compactJournal({maxCommits:1});
 verifyJournal(b.db);const rows=b.db.prepare('SELECT * FROM journal_peer_branch_rows WHERE branch_id=?').all(id);
 assert(rows.some(row=>row.after_row?.includes('unique')));assert(rows.some(row=>row.after_row?.includes('divergent')));
 b.close();const reopened=new Store(b.path);try{verifyJournal(reopened.db);assert.equal(reopened.getState('doc'),null);}finally{reopened.close();}
});

for(const phase of ['during-cleanup','after-cleanup','after-commit'])test(`compaction process interruption ${phase} preserves one committed boundary`,async t=>{
 const {a}=await fixture(t);for(let i=0;i<25;i++)a.setState('tick',i);const old=a.checkpoint(),oldBase=a.journalBase();a.close();
 const url=new URL('../src/storage/store.js',import.meta.url).href;
 const script=`import {Store} from ${JSON.stringify(url)}; const s=new Store(process.argv[1]);s.db.function('interrupt',()=>process.kill(process.pid,'SIGKILL'));
 ${phase==='during-cleanup'?"s.db.exec('CREATE TEMP TRIGGER interrupt_cleanup AFTER DELETE ON journal_changes BEGIN SELECT interrupt(); END');":''}
 ${phase==='after-cleanup'?"s.db.exec('CREATE TEMP TRIGGER interrupt_floor AFTER UPDATE OF base_sequence ON journal_meta BEGIN SELECT interrupt(); END');":''}
 s.compactJournal({maxCommits:1});process.kill(process.pid,'SIGKILL');`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script,a.path]).signal,'SIGKILL');
 const reopened=new Store(a.path);try{assert.deepEqual(reopened.checkpoint(),old);assert.equal(reopened.getState('tick'),24);verifyJournal(reopened.db);
 if(phase==='after-commit')assert(reopened.journalBase().sequence>oldBase.sequence);else assert.deepEqual(reopened.journalBase(),oldBase);
 }finally{reopened.close();}
});

test('full verification checks compact payload index identity and rows older than retained mutations',async t=>{
 const {a}=await fixture(t);a.event('old',{keep:true},1);a.setState('recent',1);a.compactJournal({maxCommits:1});
 const raw=new DatabaseSync(a.path);registerJournalFunctions(raw);
 raw.prepare('UPDATE journal_changes SET record_key=?').run('["wrong-index"]');assert.throws(()=>verifyJournal(a.db));
 raw.prepare('UPDATE journal_changes SET record_key=?').run('["recent"]');verifyJournal(a.db);
 raw.exec("UPDATE events SET payload='{}';DELETE FROM journal_pending");raw.close();assert.throws(()=>verifyJournal(a.db),{code:'journal_row_conflict'});
});

for(const phase of ['during-apply','before-publication','after-publication'])test(`peer transfer crash ${phase} exposes only a complete source checkpoint`,async t=>{
 const {a,b}=await fixture(t),old=b.checkpoint();a.setState('doc',{counter:99});a.event('after-base',{measured:true},99);
 const m=preparePeerTransfer(a.db,{after:old});b.close();
 const storeURL=new URL('../src/storage/store.js',import.meta.url).href,peerURL=new URL('../src/storage/journal-peer.js',import.meta.url).href;
 const script=`import {Store} from ${JSON.stringify(storeURL)};import {peerTransferRows,applyPeerTransfer} from ${JSON.stringify(peerURL)};
 const source=new Store(process.argv[1],{readOnly:true}),target=new Store(process.argv[2]);target.db.function('interrupt',()=>process.kill(process.pid,'SIGKILL'));
 ${phase==='during-apply'?"target.db.exec('CREATE TEMP TRIGGER interrupt_apply AFTER INSERT ON events BEGIN SELECT interrupt(); END');":''}
 ${phase==='before-publication'?"target.db.exec('CREATE TEMP TRIGGER interrupt_head BEFORE UPDATE OF base_sequence ON journal_meta BEGIN SELECT interrupt(); END');":''}
 const m=JSON.parse(process.argv[3]);applyPeerTransfer(target.db,{...m,changes:peerTransferRows(source.db,{id:m.id}).map(row=>row.change)});process.kill(process.pid,'SIGKILL');`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script,a.path,b.path,JSON.stringify(m)]).signal,'SIGKILL');
 const reopened=new Store(b.path);try{
  assert.deepEqual(reopened.checkpoint(),phase==='after-publication'?m.target:old);
  if(phase!=='after-publication'){assert.equal(reopened.getState('doc').counter,0);assert.equal(reopened.events().length,0);}
  apply(a,reopened,m);assert.equal(reopened.getState('doc').counter,99);assert.equal(reopened.events().length,1);verifyJournal(reopened.db);
 }finally{reopened.close();}
});

test('acknowledgement cleanup interruption resumes after restart without dropping post-target rows',async t=>{
 const {a,b}=await fixture(t);for(let i=0;i<6;i++)a.setState(`pending:${i}`,i);
 const m=preparePeerTransfer(a.db,{after:b.checkpoint()});apply(a,b,m);a.setState('pending:5',999);a.close();
 const storeURL=new URL('../src/storage/store.js',import.meta.url).href,peerURL=new URL('../src/storage/journal-peer.js',import.meta.url).href;
 const script=`import {Store} from ${JSON.stringify(storeURL)};import {acknowledgePeer} from ${JSON.stringify(peerURL)};
 const s=new Store(process.argv[1]);acknowledgePeer(s.db,{checkpoint:JSON.parse(process.argv[2]),limit:2});process.kill(process.pid,'SIGKILL');`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script,a.path,JSON.stringify(m.target)]).signal,'SIGKILL');
 const reopened=new Store(a.path);try{
  assert.equal(peerAnchor(reopened.db).pending.status,'rebasing');reopened.setState('pending:0',888);
  let done;do{done=acknowledgePeer(reopened.db,{checkpoint:m.target,limit:2});}while(!done.complete);
  verifyJournal(reopened.db);const next=preparePeerTransfer(reopened.db,{after:b.checkpoint()});assert.equal(next.rows,2);apply(reopened,b,next);
  assert.equal(b.getState('pending:0'),888);assert.equal(b.getState('pending:5'),999);verifyJournal(b.db);
 }finally{reopened.close();}
});

test('a crash before publishing a staged transfer leaves no advanced anchor and its orphan is reclaimable',async t=>{
 const {a,b,dir}=await fixture(t),base=b.checkpoint();a.setState('doc',{counter:55});a.close();
 const storeURL=new URL('../src/storage/store.js',import.meta.url).href,peerURL=new URL('../src/storage/journal-peer.js',import.meta.url).href;
 const script=`import {Store} from ${JSON.stringify(storeURL)};import {preparePeerTransfer} from ${JSON.stringify(peerURL)};
 const s=new Store(process.argv[1]);s.db.function('interrupt',()=>process.kill(process.pid,'SIGKILL'));
 s.db.exec('CREATE TEMP TRIGGER interrupt_stage BEFORE UPDATE OF pending ON journal_peer BEGIN SELECT interrupt(); END');
 preparePeerTransfer(s.db,{after:JSON.parse(process.argv[2])});`;
 assert.equal(spawnSync(process.execPath,['--input-type=module','-e',script,a.path,JSON.stringify(base)]).signal,'SIGKILL');
 const reopened=new Store(a.path);try{assert.equal(peerAnchor(reopened.db).pending,null);assert.deepEqual(peerAnchor(reopened.db).checkpoint,base);
  const next=preparePeerTransfer(reopened.db,{after:base});apply(reopened,b,next);assert.equal(b.getState('doc').counter,55);verifyJournal(b.db);
  const {readdir}=await import('node:fs/promises');assert.equal((await readdir(dir)).filter(name=>/^a.sqlite.peer-.*\.sqlite$/.test(name)).length,1);
 }finally{reopened.close();}
});

test('corrupt retained undo baseline cannot publish an apparently valid common checkpoint',async t=>{
 const {a}=await fixture(t);a.setState('doc',{counter:77});const head=a.checkpoint(),anchor=peerAnchor(a.db).checkpoint;
 a.db.prepare('UPDATE journal_peer_before SET row=? WHERE table_name=?').run(JSON.stringify({key:'doc',value:'{"counter":88}',updated_at:1}),'state');
 assert.throws(()=>rewindPeer(a.db,{checkpoint:anchor}),{code:'journal_peer_conflict'});
 assert.deepEqual(a.checkpoint(),head);assert.equal(a.getState('doc').counter,77);
 assert.equal(a.db.prepare('SELECT COUNT(*) n FROM journal_peer_branches').get().n,0);
 assert.throws(()=>preparePeerTransfer(a.db,{after:anchor}),{code:'journal_peer_conflict'});
});

for(const missing of ['first','last']) test(`acknowledgement rejects a missing ${missing} spool row without advancing its peer anchor`,async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint();
 a.setState('key:0',1);a.setState('key:1',1);
 const transfer=preparePeerTransfer(a.db,{after:base});apply(a,b,transfer);
 a.setState('key:0',2);
 const head=a.checkpoint(),spool=new DatabaseSync(transfer.path);
 try {spool.prepare('DELETE FROM rows WHERE ordinal=?').run(missing==='first'?0:transfer.rows-1);}
 finally {spool.close();}
 if(missing==='last') {
  const first=acknowledgePeer(a.db,{checkpoint:transfer.target,limit:1});
  assert.equal(first.complete,false);
 }
 assert.throws(()=>acknowledgePeer(a.db,{checkpoint:transfer.target,limit:1}),{code:'journal_peer_conflict'},
  'a missing final row fails immediately instead of a non-progressing cleanup loop');
 assert.deepEqual(peerAnchor(a.db).checkpoint,base);
 assert.deepEqual(a.checkpoint(),head);
 assert.equal(a.getState('key:0'),2,'unacknowledged later source writes remain intact');
 assert(peerAnchor(a.db).pending,'the failed delivery remains available for diagnosis');
});

test('acknowledgement checks the complete target fingerprint even when a corrupt row and its own hash agree',async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint();
 a.setState('doc',{counter:1});
 const transfer=preparePeerTransfer(a.db,{after:base});apply(a,b,transfer);
 a.setState('doc',{counter:2});const head=a.checkpoint();
 const spool=new DatabaseSync(transfer.path);
 try {
  const saved=spool.prepare('SELECT * FROM rows WHERE ordinal=0').get();
  const after={...JSON.parse(saved.after_row),value:JSON.stringify({counter:999})};
  const before=JSON.parse(a.db.prepare('SELECT row FROM journal_peer_before WHERE table_name=? AND record_key=?')
   .get(saved.table_name,saved.record_key).row);
  const {encodeChange}=await import('../src/storage/journal-codec.js');
  const changed=encodeChange(saved.table_name,JSON.parse(saved.record_key),before,after);
  spool.prepare('UPDATE rows SET change=?,after_row=? WHERE ordinal=0').run(JSON.stringify(changed),JSON.stringify(after));
 } finally {spool.close();}
 assert.throws(()=>acknowledgePeer(a.db,{checkpoint:transfer.target}),{code:'journal_peer_conflict'});
 assert.deepEqual(peerAnchor(a.db).checkpoint,base);
 assert.deepEqual(a.checkpoint(),head);
 assert.deepEqual(a.getState('doc'),{counter:2});
 verifyPeerHistory(a.db);
});

test('full verification binds preserved peer branch checkpoint provenance to its archived records',async t=>{
 const {a}=await fixture(t),base=peerAnchor(a.db).checkpoint;
 a.setState('doc',{counter:55});
 const branch=rewindPeer(a.db,{checkpoint:base});
 const verified=verifyJournal(a.db);
 assert.equal(verified.branches,1);assert.equal(verified.archivedPeerRows,1);
 const saved=a.db.prepare('SELECT head FROM journal_peer_branches WHERE id=?').get(branch);
 const head={...JSON.parse(saved.head),hash:'f'.repeat(64)};
 a.db.prepare('UPDATE journal_peer_branches SET head=? WHERE id=?').run(JSON.stringify(head),branch);
 assert.throws(()=>verifyJournal(a.db),{code:'journal_peer_conflict'});
 assert.deepEqual(a.checkpoint(),base,'verification is read only and leaves the protected evidence intact');
});

test('peer spool pages bound bytes as well as row count and acknowledgement resumes every page',async t=>{
 const {a,b}=await fixture(t),base=b.checkpoint(),payload='x'.repeat(300*1024);
 for(let i=0;i<16;i++) a.setState(`synthetic-large:${i}`,{payload,revision:i});
 const transfer=preparePeerTransfer(a.db,{after:base});
 const first=peerTransferRows(a.db,{id:transfer.id,limit:128});
 assert(first.length>0 && first.length<16,'a page cannot materialize all large rows just because their count is small');
 assert(Buffer.byteLength(JSON.stringify(first))<4*1024*1024,'normal pages keep their encoded data inside the byte budget');
 apply(a,b,transfer);
 let acknowledged=acknowledgePeer(a.db,{checkpoint:transfer.target,limit:128}),pages=1;
 assert.equal(acknowledged.complete,false,'cleanup uses the same bounded page admission');
 while(!acknowledged.complete) {
  acknowledged=acknowledgePeer(a.db,{checkpoint:transfer.target,limit:128});pages++;
  assert(pages<=16,'each admitted page makes progress');
 }
 for(let i=0;i<16;i++) assert.deepEqual(b.getState(`synthetic-large:${i}`),a.getState(`synthetic-large:${i}`));
 assert.equal(a.db.prepare('SELECT COUNT(*) n FROM journal_peer_changes').get().n,0);
 verifyJournal(a.db);verifyJournal(b.db);
});

test('failed source opening releases the staging lease and removes its abandoned partial file',async t=>{
 const {a,b,dir}=await fixture(t),base=b.checkpoint();a.setState('doc',{counter:44});
 assert.throws(()=>preparePeerTransfer(a.db,{after:base,sourcePath:join(dir,'synthetic-missing.sqlite')}));
 assert.equal(peerAnchor(a.db).pending,null);
 const {readdir}=await import('node:fs/promises');
 assert(!(await readdir(dir)).some(name=>name.endsWith('.partial')));
 const transfer=preparePeerTransfer(a.db,{after:base});
 apply(a,b,transfer);assert.deepEqual(b.getState('doc'),{counter:44});
 assert.equal((await readdir(dir)).filter(name=>/^a.sqlite.peer-.*\.sqlite$/.test(name)).length,1);
 verifyJournal(a.db);verifyJournal(b.db);
});
