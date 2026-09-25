import test from 'node:test';
import assert from 'node:assert/strict';
import { H66_HISTORY_SIGNALS,HISTORY_AXES,PHASE_ENERGY_SIGNALS,MODEL_COEFFICIENT_INFO,GARAGE_COEFFICIENT_INFO,RIGHT_AXIS_SIGNALS } from '../src/domain/history-series.js';
import { H66_REGISTERS } from '../src/domain/telemetry.js';
import { recordingRows, populateHistoryAxes } from '../chart/recording.js';

test('every retained H66 parameter and garage temperature is selectable independently of model use',()=>{
  assert.equal(H66_HISTORY_SIGNALS.length,29);
  assert.deepEqual(new Set(Object.values(H66_REGISTERS).map(row=>row.signal==='integral'?'heating_integral':row.signal)),new Set(H66_HISTORY_SIGNALS));
  const selectable=new Set(HISTORY_AXES.flatMap(axis=>axis.signals));
  for(const signal of [...H66_HISTORY_SIGNALS,'downstairs_temperature','bedroom_temperature','garage_temperature',...PHASE_ENERGY_SIGNALS])assert(selectable.has(signal),signal);
  assert(selectable.has('brine_pump_speed'));assert(!selectable.has('brine_pump_active'));assert(!selectable.has('discharge_temperature'));
  assert.equal(new Set(HISTORY_AXES.map(a=>a.key)).size,HISTORY_AXES.length);
  const rows=recordingRows({parameters:[
    {signal:'garage_native_indoor_temperature',policy:'adaptive-value',day:{averageIntervalMs:180000},threshold:0.04,status:'fresh'},
    {signal:'garage_temperature',policy:'change-only',day:{averageIntervalMs:180000},threshold:null,status:'fresh'},
  ]});
  const garage=rows.find(r=>r.signal==='garage_native_indoor_temperature');
  assert.equal(garage.label,'Pump interpreted indoor temperature');assert.equal(garage.day.averageIntervalMs,180000);
  assert(!rows.some(r=>r.signal==='garage_temperature'), 'exact sensor endpoints are listed in the other-data inventory');
  assert(!rows.some(r=>r.signal==='brine_pump_speed'), 'unobserved catalogue entries are not recorder streams');
  assert(!rows.some(r=>r.signal==='auxiliary_power'), 'derived exact changes are not adaptive measurements');
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
  assert.deepEqual(select.children.map(group => group.label), ['Electricity', 'Room temperatures', 'Caravan', 'Garage heat pump', 'Home heat pump',
    'Home hot water', 'Home ground loop', 'Weather', 'Home learning and outcomes', 'Home learning · saved inputs',
    'Home learning · coefficients', 'Garage learning · saved inputs', 'Garage learning · coefficients', 'Requested control',
    'Equipment diagnostics', 'Home pump settings', 'Home runtime counters', 'Meter checks']);
  const choices = new Set(select.children.flatMap(group => group.children.map(option => option.value)));
  for (const key of RIGHT_AXIS_SIGNALS) assert(!choices.has(key), `${key} already appears on the right axis`);
  const coefficients = select.children.find(group => group.label === 'Home learning · coefficients');
  assert.deepEqual(coefficients.children.map(option => option.value), Object.keys(MODEL_COEFFICIENT_INFO));
  assert.equal(coefficients.children.length, 4);
  assert.deepEqual(Object.values(MODEL_COEFFICIENT_INFO).map(info => info.parameter),
    ['lossPerHour', 'hydronicCPerKwh', 'solarCPerHourPerKwM2', 'fireplaceCPerKg']);
  assert(choices.has('garage_model_front'));
  const garageCoefficients = select.children.find(group => group.label === 'Garage learning · coefficients');
  assert.deepEqual(garageCoefficients.children.map(option => option.value), [
    'garage_coefficient_rear_coolingPerHour', 'garage_coefficient_front_coolingPerHour', 'garage_coefficient_native_normalPowerKw',
  ]);
  assert.deepEqual(garageCoefficients.children.map(option => option.value), Object.keys(GARAGE_COEFFICIENT_INFO));
  assert(!choices.has('garage_coefficient_rear_lossPerHour'));
  assert(!choices.has('garage_coefficient_native_restartKw'));
  assert(choices.has('model_hydronic_heat'));
  assert(choices.has('model_valve_override'));
  assert(choices.has('model_outdoor_temperature'), 'Saved outdoor learning inputs remain inspectable');
  const rooms = select.children.find(group => group.label === 'Room temperatures');
  assert.deepEqual(rooms.children.map(option => [option.value, option.textContent]), [
    ['temperatures', 'Home and garage temperatures · °C · recorded'],
  ]);
  assert(choices.has('caravan_energy'));
  for (const signal of ['caravan_power', 'caravan_current', 'caravan_active', 'garage_temperature_ha', 'garage_temperature_2', 'garage_heat_pump_power', 'garage_heat_pump_temperature', 'garage_relay_active', 'heat_savings_active']) assert(!choices.has(signal));
  for (const signal of ['caravan_power', 'caravan_current', 'caravan_active', 'garage_temperature_ha', 'garage_heat_pump_active', 'garage_heat_pump_power', 'garage_heat_pump_current', 'garage_heat_pump_energy', 'garage_heat_pump_temperature', 'garage_relay_active', 'heat_savings_active'])
    assert(!HISTORY_AXES.some(axis => axis.signals.includes(signal)), `${signal} is not part of a chart dataset`);
  assert.deepEqual(HISTORY_AXES.find(axis => axis.key === 'temperatures').signals, ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'garage_temperature', 'garage_temperature_2']);
  assert(!choices.has('garage_temperature'), 'Garage is shared on the right axis');
  for (const room of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature']) assert(!choices.has(room));
  for (const key of ['firewood_load', 'model_fireplace_release', 'firewood_savings', 'firewood_electricity_avoided']) assert(choices.has(key));
  const meterChecks = select.children.find(group => group.label.split(' · ')[0] === 'Meter checks');
  assert.deepEqual(meterChecks.children.map(option => option.textContent), ['Property meter counter · kWh · recorded', 'Charger 1 · kWh · recorded', 'Charger 2 · kWh · recorded']);
  assert.deepEqual(meterChecks.children.map(option => option.value), ['property_import_energy_counter', 'ev1_session_energy_check', 'shelly_session_energy_check']);
  for (const obsolete of ['ev1_lifetime_energy_counter', 'ev1_session_energy_counter', 'ev2_energy']) assert(!choices.has(obsolete));
  assert(!recordingRows().some(row => row.signal.endsWith('_session_energy_check')), 'Finalized session views reuse event history without recorder channels');
  const manual = select.children.flatMap(group => group.children).find(option => option.value === 'firewood_load');
  assert.equal(manual.textContent, 'Manually recorded firewood additions · kg · saved input');
  assert(!recordingRows().some(row => row.group === 'Model coefficients'), 'Replay does not add recorder channels');
  select.value = 'garage_coefficient_rear_lossPerHour'; populateHistoryAxes(select);
  assert.equal(select.value, 'power', 'An archived garage coefficient choice falls back instead of reinterpreting its history');
  select.value = 'spot_price'; populateHistoryAxes(select);
  assert.equal(select.value, 'power', 'An unavailable old choice falls back to the default');
});
