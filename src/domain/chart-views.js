import { MODEL_COEFFICIENT_INFO, PHASE_ENERGY_SIGNALS } from './history-series.js';
import { FLOOR_PREHEAT_SIGNALS } from './floor-circuits.js';

// A view declares its subject, compatible quantities and intentional context.
// The same definition bounds server queries and drives the chart controls.
const home = ['model_indoor_temperature', 'indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const garage = ['garage_temperature', 'garage_temperature_2', 'garage_room_target', 'garage_effective_target', 'garage_native_indoor_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const property = ['model_indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const homeRows = ['controller_phase', 'operatingMode', 'compressorHome', 'dhwr_active', 'fireplace'];
const garageRows = ['garage_away_mode', 'garage_native_power', 'compressorGarage', 'garage_native_defrost', 'garage_door1_open', 'garage_door2_open'];
const water = ['supply_temperature', 'return_temperature', 'heating_setpoint', 'maximum_supply_setting'];
const saved = ['model_indoor_temperature', 'model_outdoor_temperature', 'model_target_temperature'];
const views = [];
function view(key, label, group, description, unit, leftSignals, rightSignals, tracks = [], show = [], extra = {}) {
  const keys = [...leftSignals, ...rightSignals, ...tracks];
  views.push(Object.freeze({ key, label, group, description, unit, leftSignals: Object.freeze(leftSignals),
    rightSignals: Object.freeze(rightSignals), tracks: Object.freeze(tracks),
    defaults: Object.freeze(Object.fromEntries(keys.map(key => [key, show.includes(key)]))), ...extra }));
}
view('power', 'Electrical power', 'Electricity', 'Compare property demand with charging and estimated heating loads.', 'kW',
  ['property_power', 'charger_power', 'charger2_power', 'heat_pump_power', 'auxiliary_power'], property, ['shellyLimiter', ...homeRows],
  ['property_power', 'charger_power', 'charger2_power', 'model_indoor_temperature', 'outdoor_temperature', 'outdoor_forecast', 'shellyLimiter', ...homeRows], { stackPower: true });
view('phases', 'Phase loading', 'Electricity', 'Compare property phase currents with charger fills stacked separately for each phase. Reconstructed currents are interval averages.', 'A',
  ['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)), property, ['shellyLimiter'],
  ['property_current_l1', 'property_current_l2', 'property_current_l3', 'shellyLimiter'], { stackPhases: true });
view('voltage_estimates', 'Phase voltage estimates', 'Electricity', 'Saved smoothed voltage estimates for each supply phase, not live measurements. Inspect a point for the contributing sources and the feed used for its latest update.', 'V',
  ['voltage_estimate_l1', 'voltage_estimate_l2', 'voltage_estimate_l3'], [], [],
  ['voltage_estimate_l1', 'voltage_estimate_l2', 'voltage_estimate_l3']);
view('session_checks', 'Charging session checks', 'Electricity', 'Charger 1 final meter readings for completed sessions; inspect a point for its reconstruction and difference.', 'kWh / session',
  ['ev1_session_energy_check'], property, [], ['ev1_session_energy_check']);
view('temperatures', 'Property temperatures', 'Temperatures & weather', 'Compare the three home rooms and both garage probes on one temperature scale.', '', [],
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', ...property, 'garage_temperature_2', 'caravan_temperature'],
  ['controller_phase', 'operatingMode', 'compressorHome', 'fireplace', 'garage_frost_active', ...garageRows],
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'garage_temperature', 'garage_temperature_2', 'controller_phase', 'compressorHome']);
view('home_temperatures', 'Home temperatures & comfort', 'Temperatures & weather', 'Compare rooms with the saved indoor average and comfort reference.', '', [],
  [...home, 'model_target_temperature', 'learning_indoor_temperature'], homeRows,
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'model_indoor_temperature', 'model_target_temperature', ...homeRows]);
view('weather', 'Outdoor conditions & sunshine', 'Temperatures & weather', 'Outdoor temperature, historical solar estimates and the future solar forecast. Solar values come from weather models, not a radiation sensor.', 'W/m²',
  ['solar_radiation', 'solar_forecast'], ['outdoor_temperature', 'outdoor_forecast', 'model_indoor_temperature'], [],
  ['solar_radiation', 'solar_forecast', 'outdoor_temperature', 'outdoor_forecast']);
view('home_power', 'Heat-pump electricity', 'Home heating', 'The whole heat-pump estimate includes auxiliary heating. Compare the component without adding it to the total.', 'kW',
  ['heat_pump_power', 'auxiliary_power'], home, homeRows, ['heat_pump_power', 'auxiliary_power', 'model_indoor_temperature', ...homeRows]);
view('heating_water', 'Heating water & demand', 'Home heating', 'Supply, return and target temperatures explain the heating integral. Hide the integral for a temperature-only view.', '°min',
  ['heating_integral'], water, homeRows, ['heating_integral', 'supply_temperature', 'return_temperature', 'heating_setpoint', ...homeRows]);
view('hot_water', 'Hot water & circulation', 'Home heating', 'Tank temperature and switching thresholds, with circulation requests distinct from reported operation.', '', [],
  ['dhw_temperature', 'dhw_start_setting', 'dhw_stop_setting'], ['compressorHome', 'dhwr', 'dhwr_active', 'dhw_routing', 'operatingMode'],
  ['dhw_temperature', 'dhw_start_setting', 'dhw_stop_setting', 'compressorHome', 'dhwr', 'dhwr_active']);
view('ground_loop', 'Ground-loop temperatures', 'Home heating', 'Compare brine inlet and outlet temperatures during compressor operation.', '', [],
  ['brine_in_temperature', 'brine_out_temperature'], ['compressorHome'], ['brine_in_temperature', 'brine_out_temperature', 'compressorHome']);
view('circulation', 'Circulation-pump speeds', 'Home heating', 'Compare reported heating and brine pump speeds with their operating context.', '%',
  ['heating_pump_speed', 'brine_pump_speed'], water, ['heating_pump_active', 'compressorHome'], ['heating_pump_speed', 'brine_pump_speed', 'heating_pump_active']);
view('auxiliary', 'Auxiliary output', 'Home heating', 'Reported heater output alongside heating-water temperature and operating mode.', '%',
  ['auxiliary_output'], water, ['operatingMode', 'compressorHome'], ['auxiliary_output', 'supply_temperature', 'heating_setpoint', 'operatingMode']);
view('control', 'Control requests & operation', 'Home controls & diagnostics', 'Inspect requests and equipment readback separately. A requested reduction does not prove that the compressor stopped.', '', [], home,
  ['controller_phase', 'heating_pump_active', 'operatingMode', 'compressorHome', 'dhwr', 'dhwr_active', 'heat_savings_active',
    ...FLOOR_PREHEAT_SIGNALS, 'alarm_active'],
  ['model_indoor_temperature', 'controller_phase', 'heating_pump_active', 'operatingMode', 'compressorHome']);
view('settings', 'Temperature settings', 'Home controls & diagnostics', 'Recorded temperature settings, shown as smooth curves. Interpolation is for display; settings change at their recorded times.', '', [],
  ['room_setting', 'heating_curve', 'maximum_supply_setting', 'heat_stop_setting', 'tariff_reduction_setting', 'dhw_start_setting', 'dhw_stop_setting'], ['operatingMode'],
  ['room_setting', 'heating_curve', 'maximum_supply_setting']);
view('room_influence', 'Room influence', 'Home controls & diagnostics', 'The recorded room-influence factor with indoor temperature context.', 'factor', ['room_influence'], home, [], ['room_influence', 'model_indoor_temperature']);
view('runtime', 'Lifetime runtime counters', 'Home controls & diagnostics', 'Reported cumulative runtime. These are lifetime counters, not hours consumed within the selected dates.', 'h',
  ['compressor_hours', 'dhw_hours', 'auxiliary_3kw_hours', 'auxiliary_6kw_hours'], [], [], ['compressor_hours', 'dhw_hours', 'auxiliary_3kw_hours', 'auxiliary_6kw_hours']);
view('alarms', 'Pump alarms', 'Home controls & diagnostics', 'Recorded alarm codes with a separate alarm activity row. Missing readback remains unknown.', 'code', ['alarm_code'], [], ['alarm_active', 'operatingMode'], ['alarm_code', 'alarm_active']);
view('garage', 'Garage temperatures & compressor', 'Garage', 'Compare measured front and rear temperatures with compressor frequency, heat-pump defrost and door state. The pump control temperature is a separate diagnostic.', 'Hz',
  ['garage_compressor_frequency'], garage, garageRows, ['garage_compressor_frequency', 'garage_temperature', 'garage_temperature_2', ...garageRows]);
view('garage_control', 'Garage protection & electricity', 'Garage', 'Compare saved and effective targets, measured temperatures, pipe estimates and heat-pump electricity.', 'kWh / interval', ['garage_energy'],
  ['garage_room_target', 'garage_effective_target', 'garage_pipe_rear_temperature', 'garage_pipe_front_temperature', 'garage_temperature', 'garage_temperature_2'],
  ['garage_away_mode', 'garage_external_enabled', 'garage_frost_available', 'garage_frost_active', 'garage_native_power', 'compressorGarage'],
  ['garage_energy', 'garage_room_target', 'garage_effective_target', 'garage_temperature', 'garage_away_mode', 'garage_frost_available', 'garage_frost_active']);
view('caravan', 'Caravan climate', 'Caravan', 'Air temperature, relative humidity and reported dehumidifier state: Off, Low, Medium or High. A powered fan setting does not prove water removal.', '%',
  ['caravan_humidity'], ['caravan_temperature', 'outdoor_temperature', 'outdoor_forecast'], ['caravan_dehumidifier_state'], ['caravan_humidity', 'caravan_temperature', 'caravan_dehumidifier_state']);
view('caravan_power', 'Caravan power', 'Caravan', 'Average electrical load calculated from measured energy over each recorded interval, with air temperature and dehumidifier Off/Low/Medium/High state. This is not instantaneous power.', 'kW',
  ['caravan_power'], ['caravan_temperature'], ['caravan_dehumidifier_state'], ['caravan_power', 'caravan_temperature', 'caravan_dehumidifier_state']);
view('firewood', 'Firewood additions', 'Fireplace', 'Manually recorded fuel additions, with room temperatures and the modeled burn window.', 'kg / addition', ['firewood_load'], home, ['fireplace'], ['firewood_load', 'model_indoor_temperature', 'fireplace']);
view('fireplace_release', 'Modeled fireplace release', 'Fireplace', 'Delayed fuel-equivalent release from corrected additions. This is a model input, not measured heat output.', 'kg/h', ['model_fireplace_release'], home, ['fireplace'], ['model_fireplace_release', 'model_indoor_temperature', 'fireplace']);
view('fireplace_energy', 'Firewood electricity avoided', 'Fireplace', 'Retrospective daily model estimates of electricity avoided. Inspect points for evidence and provisional status.', 'kWh/day', ['firewood_electricity_avoided'], home, [], ['firewood_electricity_avoided']);
view('fireplace_cost', 'Firewood electricity cost avoided', 'Fireplace', 'Retrospective daily model estimates with wood cost set to zero. These are distinct from timing comparisons.', '€/day', ['firewood_savings'], home, [], ['firewood_savings']);
view('learning_temperatures', 'Saved temperatures & control', 'Home learning', 'Original indoor, outdoor and comfort-reference inputs with saved control phase and valve feedback. Optional ROOM boost is a requested temperature increase, not measured warming.', 'Δ°C', ['model_room_boost'], saved,
  ['model_controller_phase', 'model_valve_override'], [...saved, 'model_controller_phase', 'model_valve_override']);
view('learning_heat', 'Saved hydronic heat input', 'Home learning', 'Saved estimated thermal input from compressor and auxiliary heating together. This is not electrical power or metered heat.', 'kW thermal', ['model_hydronic_heat'], saved, ['model_controller_phase', 'model_valve_override'], ['model_hydronic_heat', 'model_indoor_temperature']);
view('learning_duty', 'Saved compressor duty', 'Home learning', 'The fraction of each saved interval attributed to compressor space heating.', '%', ['model_compressor_duty'], saved, ['model_controller_phase'], ['model_compressor_duty']);
view('learning_solar', 'Saved solar input', 'Home learning', 'Forecast radiation available before the learning interval began; later forecasts do not replace this evidence.', 'W/m²', ['model_solar_radiation'], saved, [], ['model_solar_radiation']);
for (const [key, info] of Object.entries(MODEL_COEFFICIENT_INFO)) view(key, info.label, 'Home coefficients', info.detail, info.unit, [key], saved, [], [key]);
view('learning_benefit', 'Assessed heating-cycle benefit', 'Home outcomes', 'Saved rolling mean benefit per completed heating cycle, separating cycles with auxiliary recovery. These estimates are not individual cycle totals or metered savings.', '€/cycle', ['learning_profit', 'learning_aux_profit'], saved, [], ['learning_profit', 'learning_aux_profit']);
view('learning_error', 'Recovery-cost prediction error', 'Home outcomes', 'Saved rolling mean absolute recovery-cost prediction error; lower is better. Missing eligible assessments remain gaps.', '€/cycle', ['learning_recovery_error'], saved, [], ['learning_recovery_error']);
view('interval_energy', 'Recording-interval energy', 'Recorded evidence', 'Original energy intervals, not fixed-period totals. The three phase energies sum to property or charger consumption; Charger 2 preserves measured meter increments with estimated phase allocation. Garage electricity retains its qualified dedicated-meter basis.', 'kWh / interval', [...PHASE_ENERGY_SIGNALS, 'caravan_energy', 'garage_energy'], [], [], ['property_energy_l1', 'property_energy_l2', 'property_energy_l3', 'ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3']);
view('meter_counter', 'Property meter counter', 'Recorded evidence', 'A cumulative diagnostic meter reading. It does not correct recorded energy or describe period consumption.', 'kWh cumulative', ['property_import_energy_counter'], [], [], ['property_import_energy_counter']);

export const CHART_VIEWS = Object.freeze(views);
export const CHART_VIEW_BY_KEY = Object.freeze(Object.fromEntries(views.map(view => [view.key, view])));
