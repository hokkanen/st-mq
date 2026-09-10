import test from 'node:test';
import assert from 'node:assert/strict';
import { H66_HISTORY_SIGNALS,HISTORY_AXES,PHASE_ENERGY_SIGNALS,MODEL_COEFFICIENT_INFO,RIGHT_AXIS_SIGNALS } from '../src/domain/history-series.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { recordingRows, populateHistoryAxes } from '../chart/recording.js';

test('every retained H66 parameter and garage temperature is selectable independently of model use',()=>{
  assert.equal(H66_HISTORY_SIGNALS.length,30);
  assert.deepEqual(new Set(Object.values(H66_REGISTERS).map(row=>row.signal==='integral'?'heating_integral':row.signal)),new Set(H66_HISTORY_SIGNALS));
  const selectable=new Set(HISTORY_AXES.flatMap(axis=>axis.signals));
  for(const signal of [...H66_HISTORY_SIGNALS,'downstairs_temperature','bedroom_temperature','garage_temperature',...PHASE_ENERGY_SIGNALS])assert(selectable.has(signal),signal);
  assert(selectable.has('brine_pump_speed'));assert(!selectable.has('brine_pump_active'));assert(!selectable.has('discharge_temperature'));
  assert.equal(new Set(HISTORY_AXES.map(a=>a.key)).size,HISTORY_AXES.length);
  const rows=recordingRows({parameters:[{signal:'garage_temperature',day:{averageIntervalMs:180000},threshold:0.04,status:'fresh'}]});
  const garage=rows.find(r=>r.signal==='garage_temperature');
  assert.equal(garage.role,'History only');assert.equal(garage.day.averageIntervalMs,180000);
  assert(rows.find(r=>r.signal==='brine_pump_speed'));
  assert.equal(rows.find(r=>r.signal==='auxiliary_power').group,'Electricity');
  assert(!rows.some(r=>r.signal.startsWith('model_')),'Calculated learning views do not create recorder channels');
});

test('left-axis menu puts electricity first and groups replay coefficients without duplicating the right axis', t => {
  const node = () => ({ children: [], value: '', append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; } });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: node };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const select = node(); select.value = 'model_coefficient_heat_loss';
  populateHistoryAxes(select);
  assert.equal(select.value, 'model_coefficient_heat_loss');
  assert.deepEqual(select.children.map(group => group.label.split(' · ')[0]), ['Electricity', 'Home temperatures', 'Heating', 'Hot water',
    'Ground loop', 'Control', 'Weather', 'Learning', 'Model coefficients', 'Model inputs', 'Equipment states',
    'Settings', 'Runtime counters', 'Meter checks']);
  const choices = new Set(select.children.flatMap(group => group.children.map(option => option.value)));
  for (const key of RIGHT_AXIS_SIGNALS) assert(!choices.has(key), `${key} already appears on the right axis`);
  const coefficients = select.children.find(group => group.label === 'Model coefficients · Calculated');
  assert.deepEqual(coefficients.children.map(option => option.value), Object.keys(MODEL_COEFFICIENT_INFO));
  assert.equal(coefficients.children.length, 5);
  assert.deepEqual(Object.values(MODEL_COEFFICIENT_INFO).map(info => info.parameter),
    ['lossPerHour', 'normalHeatCPerHour', 'solarCPerHourPerKwM2', 'auxiliaryCPerKwh', 'fireplaceCPerKg']);
  assert(choices.has('model_outdoor_temperature'), 'Saved outdoor learning inputs remain inspectable');
  const rooms = select.children.find(group => group.label === 'Home temperatures · Recorded');
  assert.deepEqual(rooms.children.map(option => [option.value, option.textContent]), [
    ['temperatures', 'All air temperatures'],
    ['indoor_temperature', 'Upstairs'], ['downstairs_temperature', 'Downstairs'],
    ['bedroom_temperature', 'Bedroom'], ['garage_temperature', 'Garage temperature'],
  ]);
  for (const key of ['firewood_load', 'model_fireplace_release', 'firewood_savings', 'firewood_electricity_avoided']) assert(choices.has(key));
  const meterChecks = select.children.find(group => group.label.split(' · ')[0] === 'Meter checks');
  assert.deepEqual(meterChecks.children.map(option => option.textContent), ['Property meter counter', 'Charger 1', 'Charger 2']);
  assert.deepEqual(meterChecks.children.map(option => option.value), ['property_import_energy_counter', 'ev1_session_energy_check', 'tesla_session_energy_check']);
  for (const obsolete of ['ev1_lifetime_energy_counter', 'ev1_session_energy_counter', 'ev2_energy']) assert(!choices.has(obsolete));
  assert(!recordingRows().some(row => row.signal.endsWith('_session_energy_check')), 'Finalized session views reuse event history without recorder channels');
  const manual = select.children.flatMap(group => group.children).find(option => option.value === 'firewood_load');
  assert.equal(manual.textContent, 'Manually recorded firewood additions');
  assert(!recordingRows().some(row => row.group === 'Model coefficients'), 'Replay does not add recorder channels');
  select.value = 'spot_price'; populateHistoryAxes(select);
  assert.equal(select.value, 'power', 'An unavailable old choice falls back to the default');
});
