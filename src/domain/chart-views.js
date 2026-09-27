import { MODEL_COEFFICIENT_INFO, PHASE_ENERGY_SIGNALS } from './history-series.js';

// A view declares its subject, compatible quantities and intentional context.
// The same definition bounds server queries and drives the chart controls.
const home = ['model_indoor_temperature', 'indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const garage = ['garage_temperature', 'garage_temperature_2', 'garage_native_indoor_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const property = ['model_indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast'];
const homeRows = ['operatingMode', 'compressorHome', 'heatOff', 'dhwr', 'fireplace'];
const garageRows = ['garage_model_managed_pause', 'garage_model_available', 'compressorGarage', 'garage_door1_open', 'garage_door2_open', 'garage_native_defrost'];
const water = ['supply_temperature', 'return_temperature', 'heating_setpoint', 'maximum_supply_setting'];
const saved = ['model_indoor_temperature', 'model_outdoor_temperature', 'model_target_temperature'];
const savedGarage = ['garage_model_rear', 'garage_model_front', 'garage_model_outdoor'];
const views = [];
function view(key, label, group, description, unit, leftSignals, rightSignals, tracks = [], show = [], extra = {}) {
  const keys = [...leftSignals, ...rightSignals, ...tracks];
  views.push(Object.freeze({ key, label, group, description, unit, leftSignals: Object.freeze(leftSignals),
    rightSignals: Object.freeze(rightSignals), tracks: Object.freeze(tracks),
    defaults: Object.freeze(Object.fromEntries(keys.map(key => [key, show.includes(key)]))), ...extra }));
}
view('power', 'Electrical power', 'Electricity', 'Compare property demand with charging and estimated heating loads.', 'kW',
  ['property_power', 'charger_power', 'charger2_power', 'heat_pump_power', 'auxiliary_power'], property, homeRows,
  ['property_power', 'charger_power', 'charger2_power', 'model_indoor_temperature', 'outdoor_temperature', 'outdoor_forecast', 'operatingMode', 'dhwr', 'fireplace'], { stackPower: true });
view('phases', 'Phase loading', 'Electricity', 'Compare property phase currents with charger fills stacked separately for each phase. Reconstructed currents are interval averages.', 'A',
  ['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)), property, [],
  ['property_current_l1', 'property_current_l2', 'property_current_l3'], { stackPhases: true });
view('session_checks', 'Charging session checks', 'Electricity', 'Final meter readings for completed sessions; inspect a point for its reconstruction and difference.', 'kWh / session',
  ['ev1_session_energy_check', 'shelly_session_energy_check'], property, [], ['ev1_session_energy_check', 'shelly_session_energy_check']);
view('temperatures', 'Property temperatures', 'Temperatures & weather', 'Compare the three home rooms and both garage probes on one temperature scale.', '', [],
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', ...property, 'garage_temperature_2', 'caravan_temperature'], ['operatingMode', 'fireplace', ...garageRows],
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'garage_temperature', 'garage_temperature_2']);
view('home_temperatures', 'Home temperatures & comfort', 'Temperatures & weather', 'Compare rooms with the saved indoor average and comfort reference.', '', [],
  [...home, 'model_target_temperature', 'learning_indoor_temperature'], homeRows,
  ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'model_indoor_temperature', 'model_target_temperature', 'fireplace']);
view('weather', 'Outdoor conditions & sunshine', 'Temperatures & weather', 'Outdoor temperature, historical solar estimates and the future solar forecast. Solar values come from weather models, not a radiation sensor.', 'W/m²',
  ['solar_radiation', 'solar_forecast'], ['outdoor_temperature', 'outdoor_forecast', 'model_indoor_temperature'], [],
  ['solar_radiation', 'solar_forecast', 'outdoor_temperature', 'outdoor_forecast']);
view('home_power', 'Heat-pump electricity', 'Home heating', 'The whole heat-pump estimate includes auxiliary heating. Compare the component without adding it to the total.', 'kW',
  ['heat_pump_power', 'auxiliary_power'], home, homeRows, ['heat_pump_power', 'auxiliary_power', 'model_indoor_temperature', 'compressorHome']);
view('heating_water', 'Heating water & demand', 'Home heating', 'Supply, return and target temperatures explain the heating integral. Hide the integral for a temperature-only view.', '°min',
  ['heating_integral'], water, homeRows, ['heating_integral', 'supply_temperature', 'return_temperature', 'heating_setpoint', 'compressorHome', 'heatOff']);
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
  ['controller_phase', 'operatingMode', 'compressorHome', 'heating_pump_active', 'dhwr', 'dhwr_active', 'heat_savings_active',
    'floor_living_0_active', 'floor_living_1_active', 'floor_storage_0_active', 'floor_storage_1_active', 'alarm_active'],
  ['model_indoor_temperature', 'controller_phase', 'operatingMode', 'compressorHome']);
view('settings', 'Temperature settings', 'Home controls & diagnostics', 'Recorded temperature settings, shown as smooth curves. Interpolation is for display; settings change at their recorded times.', '', [],
  ['room_setting', 'heating_curve', 'maximum_supply_setting', 'heat_stop_setting', 'tariff_reduction_setting', 'dhw_start_setting', 'dhw_stop_setting'], ['operatingMode'],
  ['room_setting', 'heating_curve', 'maximum_supply_setting']);
view('room_influence', 'Room influence', 'Home controls & diagnostics', 'The recorded room-influence factor with indoor temperature context.', 'factor', ['room_influence'], home, [], ['room_influence', 'model_indoor_temperature']);
view('runtime', 'Lifetime runtime counters', 'Home controls & diagnostics', 'Reported cumulative runtime. These are lifetime counters, not hours consumed within the selected dates.', 'h',
  ['compressor_hours', 'dhw_hours', 'auxiliary_3kw_hours', 'auxiliary_6kw_hours'], [], [], ['compressor_hours', 'dhw_hours', 'auxiliary_3kw_hours', 'auxiliary_6kw_hours']);
view('alarms', 'Pump alarms', 'Home controls & diagnostics', 'Recorded alarm codes with a separate alarm activity row. Missing readback remains unknown.', 'code', ['alarm_code'], [], ['alarm_active', 'operatingMode'], ['alarm_code', 'alarm_active']);
view('garage', 'Garage temperatures & compressor', 'Garage', 'Compare protection probes and compressor frequency with managed heating pauses and saved pump power readback. The pump-interpreted temperature is available as a diagnostic.', 'Hz',
  ['garage_compressor_frequency'], garage, garageRows, ['garage_compressor_frequency', 'garage_temperature', 'garage_temperature_2', ...garageRows]);
view('garage_inputs', 'Garage electrical inputs', 'Garage', 'Qualified electrical inputs saved for garage learning, including both chargers as independent comparisons.', 'kW',
  ['garage_model_power', 'garage_model_ev1', 'garage_model_ev2'], savedGarage, ['compressorGarage', 'garage_model_available'],
  ['garage_model_power', 'garage_model_ev1', 'garage_model_ev2', 'garage_model_rear', 'garage_model_front', 'compressorGarage']);
view('caravan', 'Caravan climate', 'Caravan', 'Air temperature, relative humidity and the reported dehumidifier mode. Auto mode does not imply continuous operation.', '%',
  ['caravan_humidity'], ['caravan_temperature', 'outdoor_temperature', 'outdoor_forecast'], ['caravan_dehumidifier_running_state'], ['caravan_humidity', 'caravan_temperature', 'caravan_dehumidifier_running_state']);
view('caravan_power', 'Caravan power', 'Caravan', 'Average electrical load calculated from measured energy over each recorded interval, with air temperature and dehumidifier mode. This is not instantaneous power.', 'kW',
  ['caravan_power'], ['caravan_temperature'], ['caravan_dehumidifier_running_state'], ['caravan_power', 'caravan_temperature', 'caravan_dehumidifier_running_state']);
view('firewood', 'Firewood additions', 'Fireplace', 'Manually recorded fuel additions, with room temperatures and the modeled burn window.', 'kg / addition', ['firewood_load'], home, ['fireplace'], ['firewood_load', 'model_indoor_temperature', 'fireplace']);
view('fireplace_release', 'Modeled fireplace release', 'Fireplace', 'Delayed fuel-equivalent release from corrected additions. This is a model input, not measured heat output.', 'kg/h', ['model_fireplace_release'], home, ['fireplace'], ['model_fireplace_release', 'model_indoor_temperature', 'fireplace']);
view('fireplace_energy', 'Firewood electricity avoided', 'Fireplace', 'Retrospective daily model estimates of electricity avoided. Inspect points for evidence and provisional status.', 'kWh/day', ['firewood_electricity_avoided'], home, [], ['firewood_electricity_avoided']);
view('fireplace_cost', 'Firewood electricity cost avoided', 'Fireplace', 'Retrospective daily model estimates with wood cost set to zero. These are distinct from timing comparisons.', '€/day', ['firewood_savings'], home, [], ['firewood_savings']);
view('learning_temperatures', 'Saved temperatures & reference', 'Home learning', 'The original temperatures and reference supplied to completed learning intervals.', '', [], saved, ['model_controller_phase', 'model_valve_override'], saved);
view('learning_heat', 'Saved hydronic heat input', 'Home learning', 'Saved estimated thermal input from compressor and auxiliary heating together. This is not electrical power or metered heat.', 'kW thermal', ['model_hydronic_heat'], saved, ['model_controller_phase', 'model_valve_override'], ['model_hydronic_heat', 'model_indoor_temperature']);
view('learning_auxiliary', 'Saved auxiliary electricity', 'Home learning', 'Auxiliary electrical input attributed to space heating in the saved interval.', 'kW', ['model_auxiliary_power'], saved, ['model_controller_phase'], ['model_auxiliary_power']);
view('learning_duty', 'Saved compressor duty', 'Home learning', 'The fraction of each saved interval attributed to compressor space heating.', '%', ['model_compressor_duty'], saved, ['model_controller_phase'], ['model_compressor_duty']);
view('learning_solar', 'Saved solar input', 'Home learning', 'Forecast radiation available before the learning interval began; later forecasts do not replace this evidence.', 'W/m²', ['model_solar_radiation'], saved, [], ['model_solar_radiation']);
view('learning_treatment', 'Saved control treatment', 'Home learning', 'Saved ROOM boost and control phase describe requests, not measured warming or compressor activity.', 'Δ°C', ['model_room_boost'], saved, ['model_controller_phase', 'model_valve_override'], ['model_room_boost', 'model_controller_phase', 'model_valve_override']);
for (const [key, info] of Object.entries(MODEL_COEFFICIENT_INFO)) view(key, info.label, 'Home coefficients', info.detail, info.unit, [key], saved, [], [key]);
view('learning_benefit', 'Assessed heating-cycle benefit', 'Home outcomes', 'Saved benefit assessments, distinguishing cycles that included auxiliary recovery.', '€/cycle', ['learning_profit', 'learning_aux_profit'], saved, [], ['learning_profit', 'learning_aux_profit']);
view('learning_error', 'Recovery-cost prediction error', 'Home outcomes', 'Recorded recovery-cost prediction error. Missing eligible assessments remain gaps.', '€/cycle', ['learning_recovery_error'], saved, [], ['learning_recovery_error']);
view('garage_temperatures', 'Garage saved temperatures', 'Garage learning', 'Original normalized rear, front and outdoor inputs with their saved front–rear difference.', 'Δ°C', ['garage_model_difference'], savedGarage, ['garage_model_available'], ['garage_model_difference', ...savedGarage]);
view('garage_activity', 'Garage saved activity', 'Garage learning', 'Compressor and charger activity fractions from saved intervals; these are not electrical power.', 'fraction', ['garage_model_activity', 'garage_model_ev1_active', 'garage_model_ev2_active'], savedGarage, ['garage_model_available'], ['garage_model_activity', 'garage_model_ev1_active', 'garage_model_ev2_active']);
view('garage_cooling', 'Garage cooling coefficients', 'Garage learning', 'Compare replayed front and rear cooling rates. Initial, fitted and retained values remain distinct.', '1/h', ['garage_coefficient_rear_coolingPerHour', 'garage_coefficient_front_coolingPerHour'], savedGarage, [], ['garage_coefficient_rear_coolingPerHour', 'garage_coefficient_front_coolingPerHour']);
view('garage_electricity_model', 'Garage normal-electricity model', 'Garage learning', 'Replayed normal electrical input, with its observed or initial evidence shown on inspection.', 'kW', ['garage_coefficient_native_normalPowerKw'], savedGarage, [], ['garage_coefficient_native_normalPowerKw']);
view('interval_energy', 'Recording-interval energy', 'Recorded evidence', 'Original energy intervals, not fixed-period totals. Charger 2 phase allocations are alternatives to its authoritative total. Garage electricity retains its qualified dedicated-meter basis.', 'kWh / interval', [...PHASE_ENERGY_SIGNALS, 'ev2_energy', 'caravan_energy', 'garage_energy'], [], [], ['property_energy_l1', 'property_energy_l2', 'property_energy_l3', 'ev2_energy']);
view('meter_counter', 'Property meter counter', 'Recorded evidence', 'A cumulative diagnostic meter reading. It does not correct recorded energy or describe period consumption.', 'kWh cumulative', ['property_import_energy_counter'], [], [], ['property_import_energy_counter']);

export const CHART_VIEWS = Object.freeze(views);
export const CHART_VIEW_BY_KEY = Object.freeze(Object.fromEntries(views.map(view => [view.key, view])));
