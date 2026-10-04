import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargingTeslaCapture, teslamateVehicleTelemetry } from '../src/charging/teslamate.js';
const NOW=1800000000000;
const topic=field=>`teslamate/cars/1/${field}`;
test('healthy vehicle evidence stays separate from charger electricity and keeps last-known SoC when unhealthy',()=>{
  const capture=createChargingTeslaCapture({clock:()=>NOW});capture.setConnected(true);
  for(const [key,value] of Object.entries({healthy:'true',battery_level:'80',charge_limit_soc:'90',charge_current_request:'6',charge_current_request_max:'16',scheduled_charging_start_time:new Date(NOW+7200000).toISOString()}))capture.receive(topic(key),value,{},NOW);
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
test('unchanged retained Tesla settings follow live logger health without renewing their field clocks',()=>{
  let now=NOW;
  const capture=createChargingTeslaCapture({clock:()=>now});capture.setConnected(true);
  const start=NOW+2*3600000;
  for(const [key,value] of Object.entries({charge_current_request:'6',charge_current_request_max:'16',
    scheduled_charging_start_time:new Date(start).toISOString()}))capture.receive(topic(key),value,{retain:true});
  now+=20*60000;capture.receive(topic('healthy'),'true');
  let telemetry=teslamateVehicleTelemetry(capture.snapshot(),{now});
  assert.equal(telemetry.vehicleCurrentA.value,6);
  assert.equal(telemetry.vehicleCurrentA.receivedAt,NOW);
  assert.equal(telemetry.vehicleCurrentA.retained,true);
  assert.equal(telemetry.vehicleNotBefore.value,start);
  assert.equal(telemetry.vehicleNotBefore.receivedAt,NOW);
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(),{now,charging:true}).vehicleNotBefore.available,false,
    'Observed charging takes precedence over a reported future timer');
  capture.setConnected(false);capture.setConnected(true);
  telemetry=teslamateVehicleTelemetry(capture.snapshot(),{now});
  assert.equal(telemetry.vehicleCurrentA.available,false,'Reconnect needs a new live healthy pulse');
  assert.equal(telemetry.vehicleNotBefore.available,false);
  capture.receive(topic('healthy'),'true');
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(),{now}).vehicleNotBefore.value,start);
  capture.receive(topic('scheduled_charging_start_time'),'');
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(),{now}).vehicleNotBefore.available,false);
  capture.receive(topic('healthy'),'false');
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(),{now}).vehicleCurrentA.available,false);
});

test('Tesla supply-following requests cannot become permanent vehicle limits after a pause or current test', () => {
  let now = NOW;
  const capture = createChargingTeslaCapture({ clock: () => now }); capture.setConnected(true);
  const send = (field, value) => capture.receive(topic(field), String(value));
  send('healthy', true);
  for (const [chargingState, current] of [['Charging', 16], ['Charging', 6], ['Stopped', 5]]) {
    now += 1000;
    send('charging_state', chargingState); send('charge_current_request', current); send('charge_current_request_max', current);
    const snapshot = capture.snapshot(), before = structuredClone(snapshot.fields);
    const projected = teslamateVehicleTelemetry(snapshot, { now }).vehicleCurrentA;
    assert.equal(projected.available, false);
    assert.equal(projected.value, null);
    assert.equal(projected.reason, 'vehicle-current-limit-unknown');
    assert.equal(projected.lastKnownValue, current, 'The original request remains diagnostic context');
    assert.deepEqual(snapshot.fields, before, 'Projection does not rewrite observed supply or requested current');
  }
  now += 10 * 60_000; send('healthy', true);
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(), { now }).vehicleCurrentA.available, false,
    'A later health pulse cannot turn the stopped 5 A supply report into a persistent vehicle limit');
});

test('Tesla distinct vehicle requests retain zero and low limits while missing or inconsistent supply stays unknown', () => {
  const capture = createChargingTeslaCapture({ clock: () => NOW }); capture.setConnected(true);
  const send = (field, value) => capture.receive(topic(field), String(value));
  send('healthy', true); send('charge_current_request', 8);
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(), { now: NOW }).vehicleCurrentA.available, false,
    'A request without available-supply context has unknown restriction ownership');
  send('charge_current_request_max', 16);
  for (const requested of [8, 5, 1, 0]) {
    send('charge_current_request', requested);
    const projected = teslamateVehicleTelemetry(capture.snapshot(), { now: NOW }).vehicleCurrentA;
    assert.equal(projected.value, requested); assert.equal(projected.available, true);
  }
  send('charge_current_request', 16); send('charge_current_request_max', 6);
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(), { now: NOW }).vehicleCurrentA.value, null,
    'A mismatched supply/request pair cannot assign the smaller supply to a vehicle-owned setting');
  send('charge_current_request', 8); send('charge_current_request_max', 'invalid');
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(), { now: NOW }).vehicleCurrentA.available, false);
  send('charge_current_request_max', 16);
  const future = capture.snapshot(); future.fields.charge_current_request_max.receivedAt = NOW + 1;
  assert.equal(teslamateVehicleTelemetry(future, { now: NOW }).vehicleCurrentA.available, false);
  send('healthy', false);
  assert.equal(teslamateVehicleTelemetry(capture.snapshot(), { now: NOW }).vehicleCurrentA.reason, 'vehicle-logger-unhealthy');
});
