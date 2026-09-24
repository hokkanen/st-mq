import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Engine } from '../src/app/engine.js';
import { startPaired } from '../src/pairing/runtime.js';
import { startReplica } from '../src/app/replica.js';
function configuration(t) {
  const dir=mkdtempSync(join(tmpdir(),'stmq-lifecycle-audit-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return loadConfig({XDG_CONFIG_HOME:dir,STMQ_DATA_DIR:dir,STMQ_PORT:'0'},dir);
}

test('A11-001/004 stopping synchronously closes mutation admission and shares full cleanup completion',async t=>{
  const app=await start({config:configuration(t),installSignalHandlers:false});
  const endpoint=`http://127.0.0.1:${app.server.address().port}`;
  let release; const held=new Promise(resolve=>{release=resolve;});
  app.engine.charging.close=()=>held;
  let dispatched=0;app.engine.setTemporary=()=>{dispatched++;};
  const first=app.close(),second=app.close();assert.equal(first,second);
  let completed=false;second.then(()=>{completed=true;});
  for(const path of ['/api/temporary','/api/equipment/control','/api/heating-test','/api/charging/settings']) {
    const response=await fetch(endpoint+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,503);assert.match((await response.json()).error,/shutting down/);
  }
  assert.equal(completed,false);assert.equal(dispatched,0);release();await first;assert.equal(completed,true);
  assert.equal(app.server.listening,false);assert.throws(()=>app.store.getState('anything'),/closed|not open/i);
});

test('A11-004 final recorder failure cannot abandon HTTP, workers or Store cleanup',async t=>{
  const app=await start({config:configuration(t),installSignalHandlers:false});
  let restored=0;const closeExecutor=app.engine.executor.close.bind(app.engine.executor);
  app.engine.executor.close=async options=>{restored++;return closeExecutor(options);};
  app.engine.recorder.flush=()=>{throw Error('synthetic full disk');};
  const first=app.close(),second=app.close();assert.equal(first,second);
  await assert.rejects(first,/cleanup completed with errors/);assert.equal(restored,1);
  assert.equal(app.server.listening,false);assert.throws(()=>app.store.getState('anything'),/closed|not open/i);
  await assert.rejects(app.close(),/cleanup completed with errors/);
});

test('A11-002 signal ownership precedes the first controller tick and cancels partial startup',async t=>{
  const config=configuration(t),original=Engine.prototype.tick;let engine,restored=0;
  t.mock.method(Engine.prototype,'tick',function(...args){
    engine=this;const close=this.executor.close.bind(this.executor);
    this.executor.close=async options=>{restored++;return close(options);};
    const result=original.apply(this,args);
    assert(process.listenerCount('SIGTERM')>0);process.emit('SIGTERM');return result;
  });
  await assert.rejects(start({config,installSignalHandlers:true}),/shutting down/);
  assert.equal(restored,1);assert.throws(()=>engine.store.getState('anything'),/closed|not open/i);
});

test('paired signal ownership reaches a child still executing its first tick and restores before manager close', async t => {
  const config = configuration(t), original = Engine.prototype.tick;
  config.pairing = {...config.pairing, vip:{}};
  let restored = 0, managerClosed = false, hooks;
  t.mock.method(Engine.prototype,'tick',function(...args) {
    const close = this.executor.close.bind(this.executor);
    this.executor.close = async options => { assert.equal(managerClosed,false); assert.equal(options.restore,true); restored++; return close(options); };
    const result = original.apply(this,args); process.emit('SIGTERM'); return result;
  });
  await assert.rejects(startPaired({ config, startRuntime: start, prepareVipPolicy: async () => {}, validateBroker: async () => {},
    managerFactory: options => { hooks=options.hooks; return {
      init: async()=>{}, start:()=>hooks.startPrimary({dbPath:config.dbPath}), canControl:()=>!managerClosed,
      status:()=>({role:'primary'}), prepareShutdown:()=>{}, close:async()=>{managerClosed=true;},
    }; } }), /shutting down/);
  assert.equal(restored,1); assert.equal(managerClosed,true);
});

test('replica signal ownership precedes publication lookup and aborts startup before opening HTTP', async t => {
  const config = {...configuration(t),role:'replica'};
  await assert.rejects(startReplica({config,readPublication:async()=>{process.emit('SIGTERM');return null;}}),/shutting down/);
});
