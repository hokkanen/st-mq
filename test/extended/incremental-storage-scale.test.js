import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,copyFileSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../../src/storage/store.js';

const storeURL=new URL('../../src/storage/store.js',import.meta.url).href;
const measure=`import {Store} from ${JSON.stringify(storeURL)};
import {readFileSync} from 'node:fs';
const io=()=>Object.fromEntries(readFileSync('/proc/self/io','utf8').trim().split('\\n').map(line=>{const [key,value]=line.split(':');return [key,Number(value.trim())];}));
const before=io(),start=performance.now(),source=new Store(process.argv[1]),replica=new Store(process.argv[2]);
const startupMs=performance.now()-start,base=replica.checkpoint();
const begun=performance.now();source.setState('small-tail',{value:2});
const batch=source.exportChanges({after:base});replica.applyChanges(batch);
const applyMs=performance.now()-begun,bytes=Buffer.byteLength(JSON.stringify(batch));
if(source.checkpoint().hash!==replica.checkpoint().hash)throw Error('Different checkpoints');
source.close();replica.close();const after=io();
console.log(JSON.stringify({startupMs,applyMs,bytes,rchar:after.rchar-before.rchar,wchar:after.wchar-before.wchar}));`;

test('startup and fixed transaction replication use bounded I/O across large historical databases',{skip:process.platform!=='linux'},t=>{
  const root=mkdtempSync(join(tmpdir(),'stmq-incremental-scale-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const requested=process.env.STMQ_JOURNAL_SCALE_MIB ?? '4,128';
  const scales=requested.split(',').map(Number);
  assert(scales.every(value=>Number.isSafeInteger(value)&&value>=1&&value<=1024));
  const results=[];
  for(const mib of scales) {
    const path=join(root,`source-${mib}.sqlite`),replica=join(root,`replica-${mib}.sqlite`),store=new Store(path);
    const insert=store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
    const payload=JSON.stringify({synthetic:'x'.repeat(4096)});
    const rows=mib*256;
    for(let offset=0;offset<rows;offset+=256)store.transaction(()=>{
      for(let i=offset;i<Math.min(rows,offset+256);i++)insert.run('scale',payload,i);
    });
    store.setState('small-tail',{value:1});store.close();
    // One deliberately seeded fixture, outside measured routine work. The last
    // connection is closed; there is no live WAL or installation data here.
    copyFileSync(path,replica);
    const result=spawnSync(process.execPath,['--input-type=module','-e',measure,path,replica],{encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr);
    const metrics={payloadMiB:mib,databaseMiB:statSync(path).size/1024**2,...JSON.parse(result.stdout)};
    assert(metrics.bytes<4096,'Only the small suffix should be transferred');
    assert(metrics.rchar<8*1024**2,`Routine read I/O must stay bounded; ${metrics.rchar}`);
    assert(metrics.wchar<2*1024**2,`Routine write I/O must stay bounded; ${metrics.wchar}`);
    assert(metrics.startupMs<5000 && metrics.applyMs<5000,'Generous latency guard catches accidental full work');
    results.push(metrics);t.diagnostic(JSON.stringify(metrics));
  }
  if(results.length>1) {
    assert(Math.max(...results.map(r=>r.bytes))-Math.min(...results.map(r=>r.bytes))<128);
    assert(Math.max(...results.map(r=>r.rchar))-Math.min(...results.map(r=>r.rchar))<2*1024**2);
  }
});
