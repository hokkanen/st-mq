import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
test('vehicle observation cannot create canonical grid energy or a charger session check',()=>{
  const captured=[];const capture=createChargingTeslaCapture({saveState:value=>captured.push(value),clock:()=>1800000000000});capture.setConnected(true);
  for(const [field,value]of Object.entries({healthy:'true',plugged_in:'true',charging_state:'Charging',geofence:'Home',charger_power:'11',charge_energy_added:'1'}))capture.receive(`teslamate/cars/1/${field}`,value);
  assert.equal(capture.status().recording,false);assert.equal(captured.length,6);
  assert.equal(existsSync(new URL('../src/acquisition/teslamate.js',import.meta.url)),false);
  assert.doesNotMatch(readFileSync(new URL('../src/charging/teslamate.js',import.meta.url),'utf8'),/recordEnergy|recordChargingSessionCheck/);
});
