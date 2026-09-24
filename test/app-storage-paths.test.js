import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { prepareStorage } from '../src/app/storage-paths.js';

test('current add-on path setup never relocates an old database or private files', async t => {
  const root=mkdtempSync(join(tmpdir(),'stmq-paths-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dataDir=join(root,'data'), dbPath=join(root,'public','st-mq.sqlite');
  const old=new Store(join(dataDir,'st-mq.sqlite')); old.setState('old',{count:42}); old.close();
  const before=readFileSync(join(dataDir,'st-mq.sqlite'));
  await prepareStorage({addon:true,dataDir,dbPath});
  assert(!existsSync(dbPath)); assert.deepEqual(readFileSync(join(dataDir,'st-mq.sqlite')),before);
  const current=new Store(dbPath); assert.equal(current.getState('old'),null); current.close();
});

test('unrelated corrupt old-path files remain untouched', async t => {
  const root=mkdtempSync(join(tmpdir(),'stmq-paths-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dataDir=join(root,'data'), dbPath=join(root,'public','st-mq.sqlite');
  await prepareStorage({addon:true,dataDir,dbPath});
  const old=join(dataDir,'st-mq.sqlite'); writeFileSync(old,'broken database');
  await prepareStorage({addon:true,dataDir,dbPath});
  assert(!existsSync(dbPath)); assert.equal(readFileSync(old,'utf8'),'broken database');
});
