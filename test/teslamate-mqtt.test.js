import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'stmq-vehicle-mqtt-')),store=new Store(join(directory,'test.sqlite'));
  let now=Date.parse('2026-09-15T18:00:00Z'),acknowledge;
  const client=new EventEmitter(),publications=[],boundaries=[];
  client.subscribe=(_topic,_options,done)=>{acknowledge=done;};
  client.publish=(topic,_body,_options,done)=>{publications.push(topic);done?.();};
  client.end=(_force,_options,done)=>done();
  const engine={clock:()=>now,recorder:new Recorder(store),charging:{mqttRoutes:()=>[],setMqttStatus(){},receiveSoc:()=>false,receiveVehicleBoundary:(_id,event)=>boundaries.push(event)}};
  const config={input:'mqtt',connections:{mqtt:{address:'mqtt://synthetic.invalid'},teslamate:{enabled:true}}};
  const capture=await startMqtt({engine,store,config,connect:()=>client});
  t.after(async()=>{await capture.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {client,store,engine,publications,boundaries,get now(){return now;},advance(){now+=1000;},
    ack(qos=0){acknowledge(null,[{topic:'teslamate/cars/1/#',qos}]);},
    send(field,value,packet={}){client.emit('message',`teslamate/cars/1/${field}`,Buffer.from(String(value)),packet);}};
}
test('one MQTT subscription captures vehicle evidence without producing physical electricity or commands',async t=>{
  const f=await fixture(t);f.client.emit('connect');f.ack();
  for(const [field,value] of Object.entries({healthy:true,geofence:'Home',plugged_in:true,battery_level:80,charge_limit_soc:90,charging_state:'Charging',charger_power:11,charge_energy_added:4}))f.send(field,value);
  f.advance();f.engine.recorder.flush(f.now,{force:true});
  assert.equal(f.engine.teslamate.snapshot().batteryLevel,80);
  assert.equal(f.engine.teslamate.status().recording,false);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM observations WHERE source='teslamate' OR signal GLOB 'ev2_energy_l[123]'").get().n,0);
  assert.deepEqual(f.publications,[]);
  assert.equal(f.store.getState('charging:teslamate').version,1);
  f.client.emit('offline');assert.equal(f.engine.teslamate.status().healthy,false);
});
test('SUBACK buffering preserves every negative boundary and original receipt order',async t=>{
  const f=await fixture(t);f.client.emit('connect');
  f.send('battery_level',80,{retain:true});f.send('plugged_in',true);f.advance();f.send('plugged_in',false);f.advance();f.send('plugged_in',true);
  f.ack();const capture=f.engine.charging.teslaCapture;
  assert.equal(capture.snapshot().batteryLevel,80);
  assert.deepEqual(capture.snapshot().boundaries.filter(row=>row.field==='plugged_in').map(row=>row.value),[true,false,true]);
  assert.equal(capture.reception().lastRetainedAt,f.now-2000);
  assert.equal(f.boundaries.length,3);
});
test('denied and overflowing subscriptions remain unavailable',async t=>{
  const f=await fixture(t);f.client.emit('connect');f.send('healthy',true);f.ack(128);
  assert.equal(f.engine.charging.teslaCapture.reception().subscribed,false);
  f.client.emit('offline');f.client.emit('connect');for(let i=0;i<129;i++)f.send('plugged_in',i%2===0);f.ack();
  assert.equal(f.engine.charging.teslaCapture.reception().subscribed,false);
  assert.equal(f.engine.charging.teslaCapture.snapshot().healthy,false);
});
test('vehicle persistence failure rolls back fields and admits the same report after storage recovery',async t=>{
  const f=await fixture(t);f.client.emit('connect');f.ack();
  const write=f.store.setState.bind(f.store);let fail=true;
  f.store.setState=(key,value)=>{if(fail&&key==='charging:teslamate')throw Error('synthetic storage failure');return write(key,value);};
  f.send('battery_level',80);assert.equal(f.engine.charging.teslaCapture.snapshot().batteryLevel,undefined);
  fail=false;f.send('battery_level',80);assert.equal(f.engine.charging.teslaCapture.snapshot().batteryLevel,80);
});
test('provider status separates vehicle health from commissioned physical Charger 2',()=>{
  const engine={store:{getState:()=>({})},config:{input:'mqtt',connections:{teslamate:{enabled:true}}},charging:{configuration:{chargers:{charger2:{enabled:true}}}}};
  let status=Engine.prototype.providerStatus.call(engine);
  assert.equal(status.teslamate.reason,'awaiting-mqtt');assert.equal(status['shelly-evse'].reason,'awaiting-mqtt');
  engine.charging.chargers={charger2:{adapter:{snapshot:()=>({online:true,controlReady:false,fields:{}})}}};
  status=Engine.prototype.providerStatus.call(engine);assert.equal(status['shelly-evse'].reason,'commissioning-required');
});
