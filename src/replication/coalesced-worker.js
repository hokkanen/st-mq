import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { openSync, closeSync, readSync, writeSync, fsyncSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join } from 'node:path';
import { yieldToController } from '../recovery/scheduler.js';
import { Store } from '../storage/store.js';
import { MAX_COMMIT_BYTES, validCheckpoint, matchingCheckpoint } from '../storage/journal.js';
import { enrollJournalPeer, peerAnchor, preparePeerTransfer, peerTransferRows, acknowledgePeer,
  applyPeerTransfer, acceptPeerCheckpoint, rewindPeer, releasePeerSource } from '../storage/journal-peer.js';
import { databaseErrorDetails } from '../storage/database-errors.js';

const invalid=()=>{throw Object.assign(new Error('Invalid consolidated transfer'),{code:'journal_peer_invalid'});};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const headerFields=['id','base','target','contentHash','rows'];
const publicMetadata=value=>Object.fromEntries(headerFields.map(key=>[key,value[key]]));
function writeAll(fd,bytes) { let offset=0;while(offset<bytes.length) offset+=writeSync(fd,bytes,offset,bytes.length-offset); }
function* lines(path) {
  const fd=openSync(path,'r'),buffer=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');let pending='';
  try {
    for(;;) {
      const length=readSync(fd,buffer,0,buffer.length,null);
      if(!length) break;
      // Decoder preserves a multibyte codepoint split between disk reads.
      pending+=decoder.write(buffer.subarray(0,length));
      for(;;) {
        const end=pending.indexOf('\n');if(end<0) break;
        const line=pending.slice(0,end);pending=pending.slice(end+1);
        if(Buffer.byteLength(line)>MAX_COMMIT_BYTES) invalid();
        yield line;
      }
      if(Buffer.byteLength(pending)>MAX_COMMIT_BYTES) invalid();
    }
    pending+=decoder.end();if(pending) invalid();
  } finally {closeSync(fd);}
}
function fileRows(path,expected) {
  const iterator=lines(path),first=iterator.next();
  try {
    let header;try{header=JSON.parse(first.value);}catch{invalid();}
    if(first.done || !header || header.version!==1 || header.mode!=='peer' || !validCheckpoint(header.base) || !validCheckpoint(header.target)
      || !Object.keys(header).every(key=>['version','mode',...headerFields].includes(key))
      || header.id!==expected.id || !matchingCheckpoint(header.base,expected.base) || !matchingCheckpoint(header.target,expected.target)
      || header.contentHash!==expected.contentHash || header.rows!==expected.rows) invalid();
  }catch(error){iterator.return();throw error;}
  const rows=(function*(){try{let count=0;for(const line of iterator){let value;try{value=JSON.parse(line);}catch{invalid();}count++;yield value;}
    if(count!==expected.rows) invalid();}finally{iterator.return();}})();
  return {rows,close:()=>iterator.return()};
}

let store;
try {
  const {operation,dbPath}=workerData;
  if(operation==='lineage') {
    const stamp=workerData.value;
    if(!stamp || typeof stamp!=='object' || Array.isArray(stamp) || Object.keys(stamp).sort().join(',')!=='epoch,sequence,token'
      || typeof stamp.epoch!=='string' || typeof stamp.token!=='string' || !UUID.test(stamp.epoch) || !UUID.test(stamp.token)
      || !Number.isSafeInteger(stamp.sequence) || stamp.sequence<0
      || !Number.isSafeInteger(workerData.at) || workerData.at<0) invalid();
  }
  store=new Store(dbPath,{readOnly:operation==='anchor'||operation==='checkpoint'&&!workerData.enroll});
  let value;
  if(operation==='anchor') value=peerAnchor(store.db);
  else if(operation==='checkpoint') {
    if(workerData.enroll)enrollJournalPeer(store.db);
    value=store.checkpoint();
  }
  else if(operation==='enroll') value=enrollJournalPeer(store.db,{checkpoint:workerData.checkpoint});
  else if(operation==='accept') value=acceptPeerCheckpoint(store.db,{checkpoint:workerData.checkpoint});
  else if(operation==='lineage') {
    const stamp=workerData.value;
    await store.runWrite(()=>store.db.prepare(`INSERT INTO state(key,value,updated_at) VALUES('pairing-lineage',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(stamp),workerData.at));
    value=true;
  }
  else if(operation==='release-source') value=releasePeerSource(store.db,{sourcePath:workerData.sourcePath});
  else if(operation==='rewind') value=rewindPeer(store.db,{checkpoint:workerData.checkpoint});
  else if(operation==='acknowledge') {
    do { value=acknowledgePeer(store.db,{checkpoint:workerData.checkpoint});if(!value.complete) await yieldToController(); } while(!value.complete);
  } else if(operation==='export') {
    const anchor=peerAnchor(store.db);
    if(anchor?.pending && matchingCheckpoint(workerData.after,anchor.pending.target)) {
      do {value=acknowledgePeer(store.db,{checkpoint:workerData.after});if(!value.complete) await yieldToController();} while(!value.complete);
    }
    const metadata=preparePeerTransfer(store.db,{after:workerData.after,sourcePath:workerData.sourcePath,refresh:workerData.refresh});
    const directory=workerData.directory;
    mkdirSync(directory,{recursive:true,mode:0o700});
    const path=join(directory,`peer-${metadata.id}.changes`),temporary=`${path}.partial`;
    // Recreate the bounded-memory wire file from the durable private delivery
    // snapshot after an interrupted response or receiver restart.
    try {unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
    const fd=openSync(temporary,'wx',0o600),hash=createHash('sha256');let bytes=0;
    const write=value=>{const chunk=Buffer.from(`${JSON.stringify(value)}\n`);writeAll(fd,chunk);hash.update(chunk);bytes+=chunk.length;};
    try {
      write({version:1,mode:'peer',...publicMetadata(metadata)});
      let afterOrdinal=-1,count=0;
      for(;;) {
        const rows=peerTransferRows(store.db,{id:metadata.id,afterOrdinal,limit:128});if(!rows.length)break;
        for(const row of rows){write(row.change);afterOrdinal=row.ordinal;count++;}
      }
      if(count!==metadata.rows) invalid();
      fsyncSync(fd);
    } finally {closeSync(fd);}
    renameSync(temporary,path);const parent=openSync(dirname(path),'r');try{fsyncSync(parent);}finally{closeSync(parent);}
    value={version:1,...publicMetadata(metadata),bytes,digest:hash.digest('hex')};
  } else if(operation==='apply') {
    const input=fileRows(workerData.path,workerData.metadata);
    try{value=applyPeerTransfer(store.db,{...publicMetadata(workerData.metadata),changes:input.rows});}
    finally{input.close();}
  } else invalid();
  parentPort.postMessage({ok:true,value});
} catch(error) {
  const details=databaseErrorDetails(error),code=details?.code ?? (/^journal_[a-z_]+$/.test(error?.code ?? '') ? error.code : 'verification_failed');
  parentPort.postMessage({ok:false,error:{code,...details}});
} finally {store?.close();}
