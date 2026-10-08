import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ownedDirectory, GENERATION_PATTERN, replicationError } from './publication.js';
import { acquireReceiverLock } from './receiver.js';
import { sameCheckpoint, validCheckpoint } from './incremental.js';

export const CHANGE_CHUNK_BYTES = 256 * 1024;

export function peerOperation(operation,{dbPath,signal,onYield,...args}) {
  if(signal?.aborted) return Promise.reject(signal.reason);
  const worker=new Worker(new URL('./coalesced-worker.js',import.meta.url),{workerData:{operation,dbPath,...args},
    ...(process.execArgv.some(value=>value.startsWith('--input-type'))?{execArgv:[]}: {})});
  return new Promise((resolve,reject)=>{
    let result,error;
    const abort=()=>{error=signal.reason;void worker.terminate();};
    signal?.addEventListener('abort',abort,{once:true});
    worker.on('message',message=>{
      if(message.type==='yield') {
        setImmediate(()=>{Promise.resolve().then(()=>onYield?.()).then(()=>{if(!error)worker.postMessage({type:'continue',id:message.id});})
          .catch(failure=>{error=failure;void worker.terminate();});});
      } else result=message;
    });
    worker.once('error',()=>{error??=replicationError('verification_failed');});
    worker.once('exit',code=>{signal?.removeEventListener('abort',abort);
      if(error)reject(error);else if(code===0 && result?.ok)resolve(result.value);
      else reject(Object.assign(replicationError(result?.error?.code ?? 'verification_failed'),result?.error));});
    if(signal?.aborted)abort();
  });
}
export function validPeerTransfer(value) {
  return value?.version===1 && GENERATION_PATTERN.test(value.id ?? '') && validCheckpoint(value.base) && validCheckpoint(value.target)
    && Object.keys(value).every(key=>['version','id','base','target','contentHash','rows','bytes','digest'].includes(key))
    && value.base.databaseId===value.target.databaseId && value.base.sequence<=value.target.sequence
    && /^[a-f0-9]{64}$/.test(value.contentHash ?? '') && Number.isSafeInteger(value.rows) && value.rows>=0
    && Number.isSafeInteger(value.bytes) && value.bytes>0 && /^[a-f0-9]{64}$/.test(value.digest ?? '');
}
export class PeerTransfers {
  constructor(directory){this.directory=directory;}
  async export({dbPath,after,signal,sourcePath,refresh=false,onYield}) {
    await ownedDirectory(this.directory,'.st-mq-peer-transfers');
    const unlock=await acquireReceiverLock(this.directory);
    try {
      const result=await peerOperation('export',{dbPath,after,directory:this.directory,sourcePath,refresh,signal,onYield});
      for(const name of await readdir(this.directory)) {
        const match=/^peer-([a-f0-9-]{36})\.changes(?:\.partial)?$/.exec(name);
        if(match && (match[1]!==result.id || name.endsWith('.partial'))) await rm(join(this.directory,name),{force:true});
      }
      return result;
    } finally {await unlock();}
  }
  async chunk({id,offset}) {
    if(!GENERATION_PATTERN.test(id ?? '') || !Number.isSafeInteger(offset) || offset<0 || offset%CHANGE_CHUNK_BYTES)
      throw replicationError('invalid_protocol');
    const file=await open(join(this.directory,`peer-${id}.changes`),'r').catch(()=>{throw replicationError('snapshot_unavailable');});
    try {
      const info=await file.stat();if(offset>=info.size)throw replicationError('invalid_protocol');
      const bytes=Buffer.alloc(Math.min(CHANGE_CHUNK_BYTES,info.size-offset));
      if((await file.read(bytes,0,bytes.length,offset)).bytesRead!==bytes.length)throw replicationError('transfer_failed');
      return {data:bytes.toString('base64')};
    }finally{await file.close();}
  }
}
export async function receivePeerTransfer({directory,peer,after,signal,refresh=false,guard=async()=>{}}) {
  await guard();
  const metadata=await peer.request('peer-transfer',{after,refresh},{signal});
  if(!validPeerTransfer(metadata) || !sameCheckpoint(metadata.base,after))throw replicationError('invalid_protocol');
  await ownedDirectory(directory,'.st-mq-peer-receive');
  const unlock=await acquireReceiverLock(directory);
  try {
    for(const name of await readdir(directory)) if(/^incoming-peer-[a-f0-9-]{36}\.changes$/.test(name)) await rm(join(directory,name),{force:true});
    const path=join(directory,`incoming-peer-${randomUUID()}.changes`),file=await open(path,'wx',0o600),hash=createHash('sha256');
    try {
      for(let offset=0;offset<metadata.bytes;offset+=CHANGE_CHUNK_BYTES) {
        signal?.throwIfAborted();await guard();
        const value=await peer.request('peer-transfer-chunk',{id:metadata.id,offset},{signal});
        if(typeof value?.data!=='string' || value.data.length>Math.ceil(CHANGE_CHUNK_BYTES/3)*4)throw replicationError('invalid_protocol');
        const bytes=Buffer.from(value.data,'base64');
        if(bytes.length!==Math.min(CHANGE_CHUNK_BYTES,metadata.bytes-offset))throw replicationError('verification_failed');
        hash.update(bytes);await file.writeFile(bytes);
      }
      if(hash.digest('hex')!==metadata.digest)throw replicationError('verification_failed');
      await file.sync();
    }catch(error){await file.close();await rm(path,{force:true});throw error;}
    await file.close();
    const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
    return {metadata,path};
  }finally{await unlock();}
}
