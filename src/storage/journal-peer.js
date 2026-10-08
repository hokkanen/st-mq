import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, readdirSync, constants } from 'node:fs';
import { dirname, basename } from 'node:path';
import { JOURNALED_TABLES } from './schema.js';
import { encodeChange, rowHash, changeContentHash } from './journal-codec.js';
import { journalConnection, journalExclusive, journalReadRow, journalApplyRow, readCheckpoint,
  matchingCheckpoint, validCheckpoint, resolveChange, validateCheckpoint, decodeJournalChange } from './journal.js';

const fail = (code='journal_peer_conflict') => { throw Object.assign(new Error('The retained peer checkpoint could not be reconciled. Preserve both histories and retry the peer operation.'),{code}); };
const tables=new Map(JOURNALED_TABLES.map(table=>[table.name,table]));
const meta = db => journalConnection(db).prepare('SELECT * FROM journal_peer WHERE id=1').get();
const content = db => journalConnection(db).prepare('SELECT content_hash FROM journal_meta WHERE id=1').get().content_hash;
const parse = text => text===null ? null : JSON.parse(text);
const stringify = value => value===null ? null : JSON.stringify(value);
function location(db) {
  const file=journalConnection(db).prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
  if(!file) fail('journal_peer_file_required');
  return file;
}
function ownedPath(db,path) {
  return typeof path==='string' && path.startsWith(`${location(db)}.peer-`) && /^[a-f0-9-]{36}\.sqlite$/.test(path.slice(`${location(db)}.peer-`.length));
}
function syncFile(path) { const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);} }
function stageLease(db) {
  const path=location(db),lockPath=`${path}.peer-lock`;
  closeSync(openSync(lockPath,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600));
  const lock=new DatabaseSync(lockPath);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch(error){lock.close();throw error;}
  const pending=peerAnchor(db)?.pending?.path,prefix=`${basename(path)}.peer-`;
  try {
    for(const name of readdirSync(dirname(path))) if(name.startsWith(prefix)&&/^[a-f0-9-]{36}\.sqlite(?:\.partial)?(?:-journal)?$/.test(name.slice(prefix.length))) {
      const candidate=`${dirname(path)}/${name}`;
      if(candidate!==pending) rmSync(candidate,{force:true});
    }
    return lock;
  } catch(error){lock.close();throw error;}
}
function checkpointContent(db,checkpoint) {
  if(!matchingCheckpoint(readCheckpoint(db),checkpoint)) fail();
  return content(db);
}
export function peerAnchor(db) {
  const row=meta(db);
  if(!row) return null;
  const checkpoint=parse(row.anchor),pending=parse(row.pending);
  if(!validCheckpoint(checkpoint)) fail();
  return {checkpoint,contentHash:row.content_hash,pending:pending&&{...pending,status:row.rebase_cursor===null?'ready':'rebasing',cursor:row.rebase_cursor}};
}
export function enrollJournalPeer(db,{checkpoint=readCheckpoint(db)}={}) {
  return journalExclusive(db,()=>{
    const current=meta(db);if(current) return peerAnchor(db);
    const hash=checkpointContent(db,checkpoint);
    journalConnection(db).prepare('INSERT INTO journal_peer VALUES(1,?,?,NULL,NULL)').run(JSON.stringify(checkpoint),hash);
    return peerAnchor(db);
  });
}
/** The receiver has durably accepted this exact source state. No command or
 * machine-local authority is inferred from this storage acknowledgement. */
export function acceptPeerCheckpoint(db,{checkpoint=readCheckpoint(db)}={}) {
  return journalExclusive(db,()=>{
    const hash=checkpointContent(db,checkpoint),state=journalConnection(db);
    state.exec('DELETE FROM journal_peer_changes');
    state.prepare('INSERT INTO journal_peer VALUES(1,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor,content_hash=excluded.content_hash,pending=NULL,rebase_cursor=NULL')
      .run(JSON.stringify(checkpoint),hash);
    return peerAnchor(db);
  });
}
export function capturePeerChanges(db,changes,sequence) {
  if(!meta(db)) return;
  const state=journalConnection(db);
  const get=state.prepare('SELECT before_hash FROM journal_peer_changes WHERE table_name=? AND record_key=?');
  const put=state.prepare('INSERT INTO journal_peer_changes VALUES(?,?,?,?,?) ON CONFLICT(table_name,record_key) DO UPDATE SET after_hash=excluded.after_hash,last_sequence=excluded.last_sequence');
  const baseline=state.prepare('INSERT INTO journal_peer_before VALUES(?,?,?)');
  const remove=state.prepare('DELETE FROM journal_peer_changes WHERE table_name=? AND record_key=?');
  for(const change of changes) {
    const key=JSON.stringify(change.key),saved=get.get(change.table,key);
    const before=saved ? null : resolveChange(change,journalReadRow(db,change),{reverse:true});
    const beforeHash=saved?saved.before_hash:rowHash(change.table,change.key,before);
    if(beforeHash===change.afterHash) remove.run(change.table,key);
    else {
      put.run(change.table,key,beforeHash,change.afterHash,sequence);
      if(!saved) baseline.run(change.table,key,stringify(before));
    }
  }
}

/** Freeze only keys changed since this configured peer's acknowledged anchor.
 * A private spool is built under a read snapshot: control writers keep their
 * SQLite write lock. Publishing the fsynced spool needs one short transaction. */
export function preparePeerTransfer(db,{after,sourcePath,refresh=false}={}) {
  const lease=stageLease(db);
  try { return stagePeerTransfer(db,{after,sourcePath,refresh}); }
  finally {lease.close();}
}
function stagePeerTransfer(db,{after,sourcePath,refresh}) {
  let anchor=peerAnchor(db);
  if(!anchor) fail('journal_peer_unregistered');
  if(refresh && anchor.pending) {
    if(anchor.pending.status==='rebasing'||!matchingCheckpoint(after,anchor.checkpoint)) fail();
    const previous=anchor.pending;
    journalExclusive(db,()=>{
      const current=peerAnchor(db);
      if(current.pending?.id!==previous.id||current.pending.status==='rebasing'||!matchingCheckpoint(current.checkpoint,after)) fail();
      journalConnection(db).prepare('UPDATE journal_peer SET pending=NULL,rebase_cursor=NULL WHERE id=1').run();
    });
    if(ownedPath(db,previous.path)) rmSync(previous.path,{force:true});
    anchor=peerAnchor(db);
  }
  if(anchor.pending) return {...anchor.pending};
  if(after && !matchingCheckpoint(after,anchor.checkpoint)) fail();
  const id=randomUUID(),path=`${location(db)}.peer-${id}.sqlite`,partial=`${path}.partial`,state=journalConnection(db);
  let spool,metadata,source;
  try {
    const file=openSync(partial,'wx',0o600);closeSync(file);
    const sourceDb=sourcePath ? (source=new DatabaseSync(sourcePath,{readOnly:true})) : db;
    const reader=journalConnection(sourceDb);
    spool=new DatabaseSync(partial);
    spool.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE meta(value TEXT NOT NULL); CREATE TABLE rows(ordinal INTEGER PRIMARY KEY,table_name TEXT NOT NULL,record_key TEXT NOT NULL,change TEXT NOT NULL,after_row TEXT); BEGIN');
    reader.exec('BEGIN');
    try {
      validateCheckpoint(sourceDb);
      anchor=peerAnchor(sourceDb);
      if(anchor.pending?.status==='rebasing' || anchor.pending&&!refresh || after && !matchingCheckpoint(after,anchor.checkpoint)) fail();
      const target=readCheckpoint(sourceDb),contentHash=content(sourceDb);
      let rows=0,projected=anchor.contentHash;
      const put=spool.prepare('INSERT INTO rows VALUES(?,?,?,?,?)');
      for(const saved of reader.prepare('SELECT c.*,b.row AS before_row FROM journal_peer_changes c JOIN journal_peer_before b USING(table_name,record_key) ORDER BY table_name,record_key').iterate()) {
        const key=JSON.parse(saved.record_key),row=journalReadRow(sourceDb,{table:saved.table_name,key});
        const before=parse(saved.before_row);
        if(rowHash(saved.table_name,key,row)!==saved.after_hash||rowHash(saved.table_name,key,before)!==saved.before_hash) fail();
        const change=encodeChange(saved.table_name,key,before,row);
        projected=changeContentHash(projected,[change]);
        put.run(rows++,saved.table_name,saved.record_key,JSON.stringify(change),stringify(row));
      }
      if(projected!==contentHash) fail();
      metadata={id,base:anchor.checkpoint,target,contentHash,rows};
      spool.prepare('INSERT INTO meta VALUES(?)').run(JSON.stringify(metadata));
    } finally { reader.exec('ROLLBACK'); source?.close();source=null; }
    spool.exec('COMMIT');spool.close();spool=null;
    syncFile(partial);renameSync(partial,path);syncFile(dirname(path));
    return journalExclusive(db,()=>{
      const current=peerAnchor(db);
      if(!matchingCheckpoint(current.checkpoint,anchor.checkpoint)||current.pending) fail();
      const pending={...metadata,path,...(sourcePath?{sourcePath}:{})};
      state.prepare('UPDATE journal_peer SET pending=?,rebase_cursor=NULL WHERE id=1').run(JSON.stringify(pending));
      return pending;
    });
  } catch(error) {
    try{spool?.close();}catch{}
    try{source?.close();}catch{}
    rmSync(partial,{force:true});
    if(peerAnchor(db)?.pending?.path!==path) rmSync(path,{force:true});
    throw error;
  }
}
function openPending(db,id) {
  const pending=peerAnchor(db)?.pending;
  if(!pending || id&&pending.id!==id || !ownedPath(db,pending.path)) fail();
  const spool=new DatabaseSync(pending.path,{readOnly:true});
  try {
    const saved=JSON.parse(spool.prepare('SELECT value FROM meta').get().value);
    if(saved.id!==pending.id || !matchingCheckpoint(saved.base,pending.base)||!matchingCheckpoint(saved.target,pending.target)
      ||saved.contentHash!==pending.contentHash||saved.rows!==pending.rows) fail();
    return {spool,pending};
  } catch(error){spool.close();throw error;}
}
// A record count alone does not bound memory when durable state rows are large.
// One legal oversized record is processed on its own; other batches stay small.
function pendingRows(spool,afterOrdinal,limit) {
  const rows=[];let bytes=0;
  for(const row of spool.prepare('SELECT * FROM rows WHERE ordinal>? ORDER BY ordinal LIMIT ?').iterate(afterOrdinal,limit)) {
    const size=Buffer.byteLength(row.change)+Buffer.byteLength(row.after_row??'');
    if(rows.length && bytes+size>4*1024*1024) break;
    rows.push(row);bytes+=size;
  }
  return rows;
}
export function peerTransferRows(db,{id,afterOrdinal=-1,limit=128}={}) {
  if(!Number.isSafeInteger(afterOrdinal)||afterOrdinal< -1||!Number.isSafeInteger(limit)||limit<1||limit>1024) fail();
  const {spool}=openPending(db,id);
  try {return pendingRows(spool,afterOrdinal,limit)
    .map(row=>({ordinal:row.ordinal,change:JSON.parse(row.change),after:parse(row.after_row)}));}
  finally{spool.close();}
}
/** Bounded, resumable cleanup. While rebasing, further capture keeps each key's
 * current baseline; exports are held until the common anchor publishes. */
export function acknowledgePeer(db,{checkpoint,limit=128}={}) {
  if(!validCheckpoint(checkpoint)||!Number.isSafeInteger(limit)||limit<1||limit>1024) fail();
  const anchor=peerAnchor(db);
  if(!anchor) fail('journal_peer_unregistered');
  if(!anchor.pending) {
    if(!matchingCheckpoint(anchor.checkpoint,checkpoint)) fail();
    return {complete:true,checkpoint};
  }
  if(!matchingCheckpoint(anchor.pending.target,checkpoint)) fail();
  const {spool,pending}=openPending(db,anchor.pending.id);
  let result;
  try {
    result=journalExclusive(db,()=>{
      const current=peerAnchor(db),state=journalConnection(db);
      if(current.pending?.id!==pending.id) fail();
      let cursor=current.pending.cursor??-1;
      let projected=current.pending.ackContentHash??current.contentHash;
      const rows=pendingRows(spool,cursor,limit);
      if(!rows.length && cursor+1<pending.rows) fail();
      const put=state.prepare('INSERT INTO journal_peer_changes VALUES(?,?,?,?,?) ON CONFLICT(table_name,record_key) DO UPDATE SET before_hash=excluded.before_hash,after_hash=excluded.after_hash,last_sequence=excluded.last_sequence');
      const baseline=state.prepare('INSERT INTO journal_peer_before VALUES(?,?,?) ON CONFLICT(table_name,record_key) DO UPDATE SET row=excluded.row');
      const remove=state.prepare('DELETE FROM journal_peer_changes WHERE table_name=? AND record_key=?');
      for(const saved of rows) {
        if(saved.ordinal!==cursor+1 || saved.ordinal>=pending.rows) fail();
        const change=decodeJournalChange({...saved,payload:saved.change}),before=parse(saved.after_row),actual=journalReadRow(db,change);
        const beforeHash=rowHash(change.table,change.key,before),afterHash=rowHash(change.table,change.key,actual);
        if(beforeHash!==change.afterHash) fail();
        projected=changeContentHash(projected,[change]);
        if(beforeHash===afterHash) remove.run(change.table,saved.record_key);
        else {
          put.run(change.table,saved.record_key,beforeHash,afterHash,readCheckpoint(db).sequence);
          baseline.run(change.table,saved.record_key,saved.after_row);
        }
        cursor=saved.ordinal;
      }
      const complete=cursor+1===pending.rows;
      if(complete && projected!==pending.contentHash) fail();
      if(complete) state.prepare('UPDATE journal_peer SET anchor=?,content_hash=?,pending=NULL,rebase_cursor=NULL WHERE id=1')
        .run(JSON.stringify(pending.target),pending.contentHash);
      else state.prepare('UPDATE journal_peer SET rebase_cursor=?,pending=? WHERE id=1')
        .run(cursor,JSON.stringify({...parse(meta(db).pending),ackContentHash:projected}));
      return {complete,checkpoint:complete?pending.target:current.checkpoint};
    });
  } finally {spool.close();}
  if(result.complete) rmSync(pending.path,{force:true});
  return result;
}
function resetHead(db,target,hash) {
  const state=journalConnection(db);
  state.exec('DELETE FROM journal_changes; DELETE FROM journal_commits');
  state.prepare('UPDATE journal_meta SET sequence=?,hash=?,base_sequence=?,base_hash=?,content_hash=?,base_content_hash=?,retained_bytes=0,retained_commits=0 WHERE id=1')
    .run(target.sequence,target.hash,target.sequence,target.hash,hash,hash);
}
export function applyPeerTransfer(db,{base,target,contentHash,changes,rows}={}) {
  if(!validCheckpoint(base)||!validCheckpoint(target)||base.databaseId!==target.databaseId||!/^([a-f0-9]{64})$/.test(contentHash)
    ||target.sequence<base.sequence||!Number.isSafeInteger(rows)||rows<0) fail();
  return journalExclusive(db,()=>{
    const head=validateCheckpoint(db),state=journalConnection(db);
    if(matchingCheckpoint(head,target)) return head;
    if(!matchingCheckpoint(head,base)) fail();
    let hash=content(db),count=0;
    for(const change of changes) {
      journalApplyRow(db,change);hash=changeContentHash(hash,[change]);count++;
    }
    if(count!==rows||hash!==contentHash) fail();
    resetHead(db,target,hash);
    state.exec('DELETE FROM journal_peer_changes');
    state.prepare('INSERT INTO journal_peer VALUES(1,?,?,NULL,NULL) ON CONFLICT(id) DO UPDATE SET anchor=excluded.anchor,content_hash=excluded.content_hash,pending=NULL,rebase_cursor=NULL')
      .run(JSON.stringify(target),hash);
    return target;
  });
}
/** Explicit protected rejoin only. Retain unique changed rows once, then restore
 * the shared peer anchor atomically. Bookkeeping histories are not replayed. */
export function rewindPeer(db,{checkpoint}={}) {
  return journalExclusive(db,()=>{
    const anchor=peerAnchor(db),head=validateCheckpoint(db),state=journalConnection(db);
    if(!anchor||anchor.pending?.status==='rebasing'||!matchingCheckpoint(checkpoint,anchor.checkpoint)) fail();
    if(matchingCheckpoint(head,checkpoint)) return null;
    const id=randomUUID(),createdAt=Date.now(),contentHash=content(db),hash=createHash('sha256');let count=0,projected=contentHash;
    hash.update(JSON.stringify([id,createdAt,checkpoint,head,anchor.contentHash,contentHash]));
    state.prepare('INSERT INTO journal_peer_branches VALUES(?,?,?,?,?,?,?,?)')
      .run(id,createdAt,JSON.stringify(checkpoint),JSON.stringify(head),anchor.contentHash,contentHash,0,'');
    const put=state.prepare('INSERT INTO journal_peer_branch_rows VALUES(?,?,?,?,?,?)');
    for(const saved of state.prepare('SELECT c.*,b.row AS before_row FROM journal_peer_changes c JOIN journal_peer_before b USING(table_name,record_key) ORDER BY table_name,record_key').iterate()) {
      const key=JSON.parse(saved.record_key),after=journalReadRow(db,{table:saved.table_name,key}),before=parse(saved.before_row);
      if(rowHash(saved.table_name,key,after)!==saved.after_hash||rowHash(saved.table_name,key,before)!==saved.before_hash) fail();
      const record=[saved.table_name,saved.record_key,saved.before_row,stringify(after)];hash.update(JSON.stringify(record));
      put.run(id,count++,...record);
      const change=encodeChange(saved.table_name,key,before,after);
      journalApplyRow(db,change,true);projected=changeContentHash(projected,[change]);
    }
    if(projected!==anchor.contentHash) fail();
    state.prepare('UPDATE journal_peer_branches SET rows=?,digest=? WHERE id=?').run(count,hash.digest('hex'),id);
    resetHead(db,checkpoint,anchor.contentHash);
    state.exec('DELETE FROM journal_peer_changes');
    state.prepare('UPDATE journal_peer SET pending=NULL,rebase_cursor=NULL WHERE id=1').run();
    return id;
  });
}
export function* reversePeerChanges(db) {
  const anchor=peerAnchor(db);
  if(!anchor || anchor.pending?.status==='rebasing') fail();
  for(const saved of journalConnection(db).prepare('SELECT c.*,b.row AS before_row FROM journal_peer_changes c JOIN journal_peer_before b USING(table_name,record_key) ORDER BY table_name,record_key').iterate()) {
    const key=JSON.parse(saved.record_key),after=journalReadRow(db,{table:saved.table_name,key});
    const before=parse(saved.before_row);
    if(rowHash(saved.table_name,key,after)!==saved.after_hash||rowHash(saved.table_name,key,before)!==saved.before_hash) fail();
    yield encodeChange(saved.table_name,key,before,after);
  }
}
export function verifyPeerHistory(db) {
  const state=journalConnection(db),anchor=peerAnchor(db);
  let branches=0,archivedRows=0;
  if(state.prepare('SELECT 1 FROM journal_peer_changes c WHERE NOT EXISTS(SELECT 1 FROM journal_peer_before b WHERE b.table_name=c.table_name AND b.record_key=c.record_key) LIMIT 1').get()) fail();
  if(anchor) {
    let hash=anchor.contentHash;
    for(const saved of state.prepare('SELECT c.*,b.row AS before_row FROM journal_peer_changes c JOIN journal_peer_before b USING(table_name,record_key)').iterate()) {
      const key=JSON.parse(saved.record_key),actual=journalReadRow(db,{table:saved.table_name,key});
      if(rowHash(saved.table_name,key,parse(saved.before_row))!==saved.before_hash||rowHash(saved.table_name,key,actual)!==saved.after_hash) fail();
      hash=changeContentHash(hash,[{beforeHash:saved.before_hash,afterHash:saved.after_hash}]);
    }
    if(anchor.pending?.status!=='rebasing'&&hash!==content(db)) fail();
  }
  for(const branch of state.prepare('SELECT * FROM journal_peer_branches').iterate()) {
    let base,head;
    try {base=JSON.parse(branch.base);head=JSON.parse(branch.head);} catch {fail();}
    if(!validCheckpoint(base)||!validCheckpoint(head)||base.databaseId!==head.databaseId||base.sequence>=head.sequence
      || !Number.isSafeInteger(branch.created_at)||branch.created_at<0||!Number.isSafeInteger(branch.rows)||branch.rows<0
      || ![branch.base_content_hash,branch.content_hash,branch.digest].every(value=>/^[a-f0-9]{64}$/.test(value))) fail();
    let count=0,contentHash=branch.base_content_hash;const digest=createHash('sha256');
    digest.update(JSON.stringify([branch.id,branch.created_at,base,head,branch.base_content_hash,branch.content_hash]));
    for(const row of state.prepare('SELECT * FROM journal_peer_branch_rows WHERE branch_id=? ORDER BY ordinal').iterate(branch.id)) {
      if(row.ordinal!==count++) fail();
      const key=JSON.parse(row.record_key),before=parse(row.before_row),after=parse(row.after_row);
      resolveChange(encodeChange(row.table_name,key,before,after),before);
      contentHash=changeContentHash(contentHash,[encodeChange(row.table_name,key,before,after)]);
      digest.update(JSON.stringify([row.table_name,row.record_key,row.before_row,row.after_row]));
    }
    if(count!==branch.rows||digest.digest('hex')!==branch.digest||contentHash!==branch.content_hash) fail();
    branches++;archivedRows+=count;
  }
  return {branches,archivedRows};
}
