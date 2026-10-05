import test from 'node:test';
import assert from 'node:assert/strict';
import { H66_HISTORY_SIGNALS,HISTORY_AXES,PHASE_ENERGY_SIGNALS } from '../src/domain/history-series.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { recordingRows } from '../chart/recording.js';

test('every retained H66 parameter and garage temperature is selectable independently of model use',()=>{
  assert.equal(H66_HISTORY_SIGNALS.length,29);
  assert.deepEqual(new Set(Object.values(H66_REGISTERS).map(row=>row.signal==='integral'?'heating_integral':row.signal)),new Set(H66_HISTORY_SIGNALS));
  const selectable=new Set(HISTORY_AXES.flatMap(axis=>axis.signals));
  for(const signal of [...H66_HISTORY_SIGNALS,'downstairs_temperature','bedroom_temperature','garage_temperature',...PHASE_ENERGY_SIGNALS])assert(selectable.has(signal),signal);
  assert(selectable.has('brine_pump_speed'));assert(!selectable.has('brine_pump_active'));assert(!selectable.has('discharge_temperature'));
  assert.equal(new Set(HISTORY_AXES.map(a=>a.key)).size,HISTORY_AXES.length);
  const rows=recordingRows({parameters:[
    {signal:'garage_native_indoor_temperature',policy:'adaptive-value',observedThisRun:true,day:{averageIntervalMs:180000},threshold:0.04,status:'fresh'},
    {signal:'garage_temperature',policy:'change-only',day:{averageIntervalMs:180000},threshold:null,status:'fresh'},
  ]});
  const garage=rows.find(r=>r.signal==='garage_native_indoor_temperature');
  assert.equal(garage.label,'Pump interpreted indoor temperature');assert.equal(garage.day.averageIntervalMs,180000);
  assert(!rows.some(r=>r.signal==='garage_temperature'), 'exact sensor endpoints are listed in the other-data inventory');
  assert(!rows.some(r=>r.signal==='brine_pump_speed'), 'unobserved catalogue entries are not recorder streams');
  assert(!rows.some(r=>r.signal==='auxiliary_power'), 'derived exact changes are not adaptive measurements');
  assert(!rows.some(r=>r.signal.startsWith('model_')),'Calculated learning views do not create recorder channels');
});
