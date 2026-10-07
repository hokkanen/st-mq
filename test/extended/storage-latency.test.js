import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { createRuntimeTiming } from '../../src/app/runtime-timing.js';
import { createH66Controller } from '../../src/control/h66.js';
import { createH66Decoder } from '../../src/domain/telemetry.js';

test('default SQLite contention fails promptly without losing durable state or blocking control timers for seconds', async t => {
  const directory = mkdtempSync(join(tmpdir(),'stmq-storage-latency-'));
  const store = new Store(join(directory,'fixture.sqlite')), writer = new DatabaseSync(store.path);
  const timing = createRuntimeTiming();
  t.after(() => { timing.close(); writer.close(); store.close(); rmSync(directory,{recursive:true,force:true}); });
  await new Promise(resolve => setTimeout(resolve,40));
  store.setState('fixture',{value:0});
  writer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  const independentTimer = new Promise(resolve => setTimeout(() => resolve(performance.now()-started),1));
  try { assert.throws(() => store.setState('fixture',{value:1}), error => error.errcode === 5); }
  finally { writer.exec('ROLLBACK'); }
  const timerDelayMs = await independentTimer;
  await new Promise(resolve => setTimeout(resolve,40));
  assert.ok(timerDelayMs < 1000, `A failed write must release the main thread below its warning threshold; observed ${timerDelayMs} ms`);
  assert.equal(store.writeHealth.status().errorCode,'database-busy');
  assert.equal(store.writeHealth.status().failing,true);
  assert.equal(timing.status().hardRealtime,false);
  assert.deepEqual(store.getState('fixture'),{value:0});
  assert.equal(store.db.isTransaction,false);
  store.setState('fixture',{value:2}); assert.deepEqual(store.getState('fixture'),{value:2});
  assert.equal(store.writeHealth.status().failing,false);
  t.diagnostic(JSON.stringify({timerDelayMs:Math.round(timerDelayMs),...timing.status()}));
});

test('a contended restoration-intent write cannot publish an H66 setting or erase its saved baseline', async t => {
  const directory = mkdtempSync(join(tmpdir(),'stmq-control-contention-'));
  const store = new Store(join(directory,'fixture.sqlite')), writer = new DatabaseSync(store.path);
  const deviceId='synthetic-contention', now=Date.now(), decoder=createH66Decoder({deviceId});
  let commands=0, locked=false;
  const controller=createH66Controller({deviceId,store,clock:()=>now,config:{writeEnabled:true},
    publish(){commands++;throw new Error('No physical transport in this fixture');}});
  t.after(async()=>{
    if(locked)writer.exec('ROLLBACK');
    await controller.close();writer.close();store.close();rmSync(directory,{recursive:true,force:true});
  });
  controller.setConnected(true);
  controller.ingest(decoder.decode({topic:`${deviceId}/HP/0212`,payload:'44',receivedAt:now}));
  // A successful no-op establishes a current-format saved record before the lock.
  await controller.writeSettings({'0212':44},{expiresAt:now+60_000});
  const before=store.getState(`h66:control:${deviceId}`);
  writer.exec('BEGIN IMMEDIATE');locked=true;
  await assert.rejects(controller.writeSettings({'0212':46},{expiresAt:now+60_000}),error=>(error.errcode&0xff)===5);
  assert.equal(commands,0);
  assert.deepEqual(store.getState(`h66:control:${deviceId}`),before);
  assert.equal(store.writeHealth.status().failing,true);
  writer.exec('ROLLBACK');locked=false;
  controller.ingest(decoder.decode({topic:`${deviceId}/HP/0212`,payload:'44',receivedAt:now}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(controller.status().restorationPending,false);
  assert.equal(commands,0,'Fresh unchanged native readback resolves the unissued write without a device command');
  assert.equal(store.writeHealth.status().failing,false);
});
