import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingTeslaCapture, teslamateVehicleTelemetry } from '../src/charging/teslamate.js';
const NOW=1800000000000;
const topic=field=>`teslamate/cars/1/${field}`;
test('healthy vehicle evidence stays separate from charger electricity and keeps last-known SoC when unhealthy',()=>{
  const capture=createChargingTeslaCapture({clock:()=>NOW});capture.setConnected(true);
  for(const [key,value] of Object.entries({healthy:'true',battery_level:'80',charge_limit_soc:'90',charge_current_request:'6',scheduled_charging_start_time:new Date(NOW+7200000).toISOString()}))capture.receive(topic(key),value,{},NOW);
  let evidence=teslamateVehicleTelemetry(capture.snapshot(),{now:NOW});assert.equal(evidence.soc.value,80);assert.equal(evidence.vehicleCurrentA.value,6);assert.equal(evidence.vehicleNotBefore.value,NOW+7200000);assert.equal(evidence.powerKw,undefined);assert.equal(evidence.connected,undefined);
  capture.receive(topic('healthy'),'false',{},NOW);evidence=teslamateVehicleTelemetry(capture.snapshot(),{now:NOW});assert.equal(evidence.soc.available,false);assert.equal(evidence.soc.lastKnownValue,80);
});
test('failed first live persistence rolls admission and clocks back so retained recovery is not suppressed',()=>{
  let fail=true,saved;const capture=createChargingTeslaCapture({clock:()=>NOW,saveState:value=>{if(fail)throw Error('disk');saved=structuredClone(value);}});capture.setConnected(true);
  assert.throws(()=>capture.receive(topic('battery_level'),'50',{},NOW));assert.equal(capture.reception().lastLiveAt,null);
  fail=false;capture.receive(topic('battery_level'),'40',{retain:true},NOW);assert.equal(capture.snapshot().batteryLevel,40);assert.equal(saved.fields.battery_level.retained,true);
});
test('negative/positive edges are durable and MQTT duplicate never renews evidence',()=>{
  let saved;const capture=createChargingTeslaCapture({clock:()=>NOW+1000,saveState:value=>saved=structuredClone(value)});capture.setConnected(true);
  capture.receive(topic('plugged_in'),'false',{},NOW);capture.receive(topic('plugged_in'),'true',{},NOW+1);
  assert.deepEqual(saved.boundaries.map(edge=>edge.value),[false,true]);
  capture.receive(topic('healthy'),'true',{},NOW);capture.receive(topic('healthy'),'true',{dup:true},NOW+1000);
  assert.equal(capture.snapshot().fields.healthy.receivedAt,NOW);
  const restored=createChargingTeslaCapture({initialState:saved,clock:()=>NOW+1000});assert.equal(restored.snapshot().healthy,false);assert.equal(restored.snapshot().boundaries.length,2);
});
test('old state and old assignment settings cannot authorize a new vehicle association',()=>{
  assert.throws(()=>createChargingTeslaCapture({initialState:{signature:'old'}}),/Unsupported/);
  assert.throws(()=>createChargingTeslaCapture({settings:{chargerAssignment:'easee'}}),/Unsupported/);
});
