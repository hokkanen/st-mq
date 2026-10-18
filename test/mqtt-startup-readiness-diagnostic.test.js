import test from 'node:test';
import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Store} from '../src/storage/store.js';
import {Engine} from '../src/app/engine.js';
import {startMqtt} from '../src/acquisition/mqtt.js';
import {startupFailureDiagnostic} from '../src/pairing/manager.js';
const require=createRequire(new URL('../package.json',import.meta.url)),mqtt=require('mqtt'),packet=require('mqtt-packet');
const START=Date.parse('2026-01-09T12:00Z');
async function until(t,check){for(;;){t.signal.throwIfAborted();if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}}
// Actual MQTT.js and native protocol packets stay on this owned in-memory
// stream. The competing SQLite writer and all files are synthetic and owned.
// Disable fixture reconnect/keepalive to isolate one attempt; production
// budgets remain real. One test exercises the actual twenty-second deadline;
// other timeout diagnostics accelerate that timer while retaining native packets.
async function fixture(t,{locked=true,rejectAck=false,connack=true,manualClient=null}={}){
 t.signal.throwIfAborted();
 const directory=mkdtempSync(join(tmpdir(),'stmq-readiness-native-offline-'));
 const store=new Store(join(directory,'current.sqlite')),writer=new DatabaseSync(store.path);
 let lockHeld=false,allowed=true,reader,closing=null,client;
 const counters={connects:0,subscriptions:0,subacks:0,subscriptionCallbacks:0,publishPackets:0},streams=[];
 const config={input:'mqtt',deviceId:'synthetic-readiness-device',h66:{writeEnabled:false,readbackTimeoutMs:1000},garage:{enabled:false},
  charging:{vehicles:{bmw:{mqttTopic:'fixture/startup/vehicle'}}},
  connections:{mqtt:{address:'mqtt://synthetic.invalid'},teslamate:{enabled:false}}};
 const engine=new Engine({store,config,clock:()=>START,canControl:()=>allowed});
 const connect=(_address,options)=>{
  if(manualClient){client=manualClient;return client;}
  client=new mqtt.MqttClient(()=>{
   const parser=packet.parser();
   const stream=new Duplex({read(){},write(chunk,_encoding,done){parser.parse(chunk);done();}});streams.push(stream);
   parser.on('error',()=>{});
   parser.on('packet',p=>{
    if(p.cmd==='connect'){counters.connects++;if(connack)queueMicrotask(()=>stream.push(packet.generate({cmd:'connack',returnCode:0,sessionPresent:false})));}
    if(p.cmd==='subscribe'){
     counters.subscriptions+=p.subscriptions.length;
     queueMicrotask(()=>{counters.subacks+=p.subscriptions.length;stream.push(packet.generate({cmd:'suback',messageId:p.messageId,granted:p.subscriptions.map(()=>rejectAck?128:1)}));});
    }
    if(p.cmd==='publish'){counters.publishPackets++;if(p.qos===1)queueMicrotask(()=>stream.push(packet.generate({cmd:'puback',messageId:p.messageId})));}
    if(p.cmd==='pingreq')queueMicrotask(()=>stream.push(packet.generate({cmd:'pingresp'})));
   });
   return stream;
  },{...options,reconnectPeriod:0,keepalive:0});
  const realSubscribe=client.subscribe.bind(client);
  client.subscribe=(topic,opts,callback)=>realSubscribe(topic,opts,(error,granted)=>{counters.subscriptionCallbacks++;callback(error,granted);});
  client.on('error',()=>{});return client;
 };
 const unlock=()=>{if(lockHeld){writer.exec('ROLLBACK');lockHeld=false;}};
 const close=()=>closing??=(async()=>{allowed=false;await reader?.close({restore:false});})();
 // Cleanup owns the writer independently of client cancellation or assertions.
 const cancelled=()=>{allowed=false;void close().catch(()=>{});unlock();};
 t.signal.addEventListener('abort',cancelled,{once:true});
 t.after(async()=>{
  unlock();await close();for(const stream of streams)stream.destroy();
  await engine.garage.close({restore:false});await engine.charging.close();await engine.closeFireplace();await engine.executor.close({restore:false});
  writer.close();store.close();rmSync(directory,{recursive:true,force:true});t.signal.removeEventListener('abort',cancelled);
 });
 if(locked){writer.exec('BEGIN IMMEDIATE');lockHeld=true;}
 reader=await startMqtt({engine,store,config,connect,canControl:()=>allowed});
 const acked=()=>counters.subscriptions>0&&counters.subscriptions===counters.subacks&&counters.subscriptions===counters.subscriptionCallbacks;
 const connectedEvents=()=>store.db.prepare("SELECT count(*) AS n FROM events WHERE type='mqtt-connected'").get().n;
 return{store,writer,engine,reader,counters,streams,client:()=>client,acked,connectedEvents,unlock,close};
}
test('real MQTT.js SUBACKs remain unready until real Store admission commits',async t=>{
 const f=await fixture(t);await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 assert.equal(f.client().connected,true);assert.equal(f.reader.status().brokers.primary.ready,false);assert.equal(f.connectedEvents(),0);
 const ready=f.reader.ready();f.unlock();await ready;
 assert.equal(f.reader.status().brokers.primary.ready,true);assert.equal(f.connectedEvents(),1);
});
test('confirmed SUBACKs held by SQLite can hit the actual twenty-second readiness timer',async t=>{
 const f=await fixture(t);await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 const began=performance.now();const pending=f.reader.ready();
 let error;await assert.rejects(pending,value=>{error=value;return /MQTT primary subscription readiness timed out/.test(value.message);});
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;
 assert.ok(diagnostic,'The actual timeout retains its trusted acquisition phase snapshot');
 assert.equal(diagnostic.stage,'primary-subscriptions');assert.equal(diagnostic.cause,'timeout');
 assert.equal(diagnostic.connected,true);assert.equal(diagnostic.observedConnections,1);
 assert.equal(diagnostic.subscriptionRequests,2);assert.equal(diagnostic.subscriptionCallbacks,2);
 assert.equal(diagnostic.acceptedCallbacks,2);assert.equal(diagnostic.rejectedCallbacks,0);assert.equal(diagnostic.committedCallbacks,0);
 assert.ok(diagnostic.queueQueued>0);assert.equal(diagnostic.queueActive,0);assert.equal(diagnostic.queueWaiting,true);
 assert.equal(Object.isFrozen(diagnostic),true);
 const elapsedMs=performance.now()-began;
 t.diagnostic(JSON.stringify({actualHeldWallMs:elapsedMs,actualSubscribeCallbacks:f.counters.subscriptionCallbacks}));
 assert.ok(elapsedMs>=19900);assert.equal(f.client().connected,true);assert.equal(f.acked(),true);assert.equal(f.reader.status().brokers.primary.ready,false);assert.ok(f.store.writeQueueStatus().pending>0);assert.equal(f.connectedEvents(),0);
 await f.close();f.unlock();await until(t,()=>f.store.writeQueueStatus().pending===0);
 assert.equal(f.connectedEvents(),0);assert.equal(f.counters.publishPackets,0);assert.equal(diagnostic.connected,true);assert.ok(diagnostic.queuePending>0);
});
test('closing before admission rejects readiness and cancels held callbacks without late writes',async t=>{
 const f=await fixture(t);await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 const pending=f.reader.ready();let error;const rejected=assert.rejects(pending,value=>{error=value;return value.message==='MQTT closed';});await f.close();await rejected;
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;assert.equal(diagnostic.cause,'closed');assert.equal(diagnostic.subscriptionCallbacks,2);assert.ok(diagnostic.queuePending>0);
 f.unlock();await until(t,()=>f.store.writeQueueStatus().pending===0);assert.equal(f.connectedEvents(),0);assert.equal(f.counters.publishPackets,0);
});
test('transport loss uses the same timeout but leaves current connected false',async t=>{
 const timer = globalThis.setTimeout; t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===20_000?1000:ms,...args));
 const f=await fixture(t);await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 const pending=f.reader.ready();let error;const rejected=assert.rejects(pending,value=>{error=value;return /MQTT primary subscription readiness timed out/.test(value.message);});
 f.streams.at(-1).destroy();await until(t,()=>!f.client().connected);await rejected;
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;assert.equal(diagnostic.connected,false);assert.equal(diagnostic.observedConnections,1);assert.equal(diagnostic.cause,'timeout');
 assert.equal(f.reader.status().brokers.primary.connected,false);assert.equal(f.reader.status().brokers.primary.ready,false);
 await f.close();f.unlock();await until(t,()=>f.store.writeQueueStatus().pending===0);assert.equal(f.counters.publishPackets,0);
});
test('rejected real SUBACK fails explicitly after its admission rather than claiming readiness',async t=>{
 const f=await fixture(t,{rejectAck:true});await until(t,()=>f.acked());let error;const rejected=assert.rejects(f.reader.ready(),value=>{error=value;return /MQTT primary subscriptions unavailable/.test(value.message);});f.unlock();await rejected;
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;assert.equal(diagnostic.cause,'unavailable');assert.equal(diagnostic.readinessFailed,true);assert.equal(diagnostic.rejectedCallbacks,2);assert.equal(diagnostic.acceptedCallbacks,0);assert.equal(f.reader.status().brokers.primary.ready,false);
});
test('unsupported schema refuses before any MQTT producer can be constructed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'stmq-readiness-schema-offline-')),path=join(dir,'unsupported.sqlite');
 try{
  const db=new DatabaseSync(path);db.exec('CREATE TABLE synthetic_unsupported (n INTEGER); PRAGMA user_version=29');db.close();
  const before=createHash('sha256').update(readFileSync(path)).digest('hex');let failure;
  try{new Store(path);}catch(error){failure=error;}
  assert.ok(failure);const diagnostic=startupFailureDiagnostic(failure,'runtime_failed');assert.notEqual(diagnostic.reason,'runtime_failed');
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('no native CONNACK observed remains distinct from a later connection loss',async t=>{
 const timer = globalThis.setTimeout; t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===20_000?1000:ms,...args));
 const f=await fixture(t,{locked:false,connack:false});let error;
 await assert.rejects(f.reader.ready(),value=>{error=value;return /MQTT primary subscription readiness timed out/.test(value.message);});
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;
 assert.equal(diagnostic.connected,false);assert.equal(diagnostic.observedConnections,0);
 assert.equal(diagnostic.subscriptionRequests,0);assert.equal(diagnostic.subscriptionCallbacks,0);
 assert.equal(diagnostic.cause,'timeout');assert.equal(f.connectedEvents(),0);assert.equal(f.counters.publishPackets,0);
});

test('unknown queue evidence cannot replace the original owned-close exception',async t=>{
 const f=await fixture(t);await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 let error;const rejected=assert.rejects(f.reader.ready(),value=>{error=value;return value.message==='MQTT closed';});
 const original=f.store.writeQueueStatus;f.store.writeQueueStatus=()=>{throw new Error('synthetic private queue failure');};
 await f.close();await rejected;f.store.writeQueueStatus=original;
 const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;
 assert.equal(diagnostic.cause,'closed');assert.equal(diagnostic.subscriptionCallbacks,2);
 for(const key of ['queuePending','queueQueued','queueActive','queueWaiting','queueOldestPendingMs'])assert.equal(diagnostic[key],null);
 assert.doesNotMatch(JSON.stringify(diagnostic),/private|failure/);
 f.unlock();await until(t,()=>f.store.writeQueueStatus().pending===0);
 assert.equal(f.connectedEvents(),0);assert.equal(f.counters.publishPackets,0);
});

test('old callbacks and queued admission cannot overwrite replacement connection evidence',async t=>{
 const client=new EventEmitter(),callbacks=[];
 client.subscribe=(topic,_options,done)=>callbacks.push({topic,done});
 client.publish=(_topic,_payload,_options,done)=>done?.();client.end=(_force,_options,done)=>done();
 const f=await fixture(t,{manualClient:client});client.emit('connect');const first=callbacks.splice(0);
 assert.equal(first.length,2);first[0].done(null,[{topic:first[0].topic,qos:1}]);
 client.emit('offline');client.emit('connect');const replacement=callbacks.splice(0);
 // One older callback is queued before replacement, the other arrives after it.
 first[1].done(null,[{topic:first[1].topic,qos:1}]);
 for(const row of replacement)row.done(null,[{topic:row.topic,qos:1}]);
 let error;const rejected=assert.rejects(f.reader.ready(),value=>{error=value;return value.message==='MQTT closed';});
 await f.close();await rejected;const diagnostic=startupFailureDiagnostic(error,'runtime_failed').acquisition;
 assert.equal(diagnostic.observedConnections,2);assert.equal(diagnostic.subscriptionRequests,2);
 assert.equal(diagnostic.subscriptionCallbacks,2);assert.equal(diagnostic.acceptedCallbacks,2);
 assert.equal(diagnostic.committedCallbacks,0);assert.equal(diagnostic.admissionFailures,0);
 for(const row of first)row.done(null,[{topic:row.topic,qos:1}]);
 f.unlock();await until(t,()=>f.store.writeQueueStatus().pending===0);
 assert.equal(f.connectedEvents(),0);assert.equal(diagnostic.admissionFailures,0);
});

test('whole fixture cancellation discards admission before releasing its owned writer',async t=>{
 const owner=new AbortController();
 const f=await fixture({signal:owner.signal,after:cleanup=>t.after(cleanup)});
 await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 const rejected=assert.rejects(f.reader.ready(),/MQTT closed/);
 owner.abort(new Error('synthetic fixture cancellation'));await rejected;await f.close();
 await until(t,()=>f.store.writeQueueStatus().pending===0);
 assert.equal(f.connectedEvents(),0);assert.equal(f.counters.publishPackets,0);
});

test('already cancelled fixture refuses before constructing its Store or protocol client',async()=>{
 const owner=new AbortController(),reason=new Error('synthetic cancelled before setup');owner.abort(reason);
 await assert.rejects(fixture({signal:owner.signal,after(){throw new Error('cleanup should not be registered');}}),error=>error===reason);
});

test('a progressing durable subscription queue can finish after the former ten-second limit', async t => {
 const f = await fixture(t); await until(t,()=>f.acked()&&f.store.writeQueueStatus().pending>0);
 const ready=f.reader.ready(); await new Promise(resolve=>setTimeout(resolve,10_500)); f.unlock(); await ready;
 assert.equal(f.reader.status().brokers.primary.ready,true); assert.equal(f.connectedEvents(),1);
});
