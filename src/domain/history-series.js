// Shared chart catalogue. Recorder priority is deliberately absent: every
// included measurement receives the same normalized reconstruction objective.
const h66 = [
  ['return_temperature', 'Heating return', '°C', 'Heating', 'Equipment context'],
  ['supply_temperature', 'Heating supply', '°C', 'Heating', 'Equipment context'],
  ['brine_in_temperature', 'Brine in', '°C', 'Ground loop', 'History only'],
  ['brine_out_temperature', 'Brine out', '°C', 'Ground loop', 'History only'],
  ['outdoor_temperature', 'Outdoor temperature', '°C', 'Home temperatures', 'House input'],
  ['indoor_temperature', 'Indoor temperature', '°C', 'Home temperatures', 'House input'],
  ['dhw_temperature', 'Hot-water temperature', '°C', 'Hot water', 'Equipment context'],
  ['heating_setpoint', 'Supply target', '°C', 'Heating', 'Equipment context'],
  ['heating_integral', 'Heating integral', '°min', 'Heating', 'Equipment context'],
  ['auxiliary_output', 'Auxiliary output', '%', 'Heating', 'Equipment context'],
  ['compressor_hours', 'Compressor runtime', 'h', 'Runtime counters', 'History only'],
  ['auxiliary_3kw_hours', 'Auxiliary 3 kW runtime', 'h', 'Runtime counters', 'History only'],
  ['auxiliary_6kw_hours', 'Auxiliary 6 kW runtime', 'h', 'Runtime counters', 'History only'],
  ['dhw_hours', 'Hot-water runtime', 'h', 'Runtime counters', 'History only'],
  ['compressor_active', 'Compressor active', 'state', 'Equipment states', 'Equipment context'],
  ['heating_pump_active', 'Heating pump active', 'state', 'Equipment states', 'Equipment context'],
  ['dhw_routing', 'Hot-water routing', 'state', 'Hot water', 'Equipment context'],
  ['heating_pump_speed', 'Heating pump speed', '%', 'Heating', 'History only'],
  ['brine_pump_speed', 'Brine pump speed', '%', 'Ground loop', 'History only'],
  ['room_setting', 'Room setting', '°C', 'Settings', 'Equipment context'],
  ['dhw_stop_setting', 'Hot-water stop setting', '°C', 'Hot water', 'Equipment context'],
  ['dhw_start_setting', 'Hot-water start setting', '°C', 'Hot water', 'Equipment context'],
  ['operating_mode', 'Operating mode', 'state', 'Equipment states', 'Equipment context'],
  ['room_influence', 'Room influence', 'factor', 'Settings', 'Equipment context'],
  ['heating_curve', 'Heating curve', '°C', 'Settings', 'Equipment context'],
  ['maximum_supply_setting', 'Maximum supply setting', '°C', 'Settings', 'Equipment context'],
  ['heat_stop_setting', 'Heat-stop setting', '°C', 'Settings', 'Equipment context'],
  ['tariff_reduction_setting', 'Tariff reduction setting', '°C', 'Settings', 'Equipment context'],
  ['alarm_active', 'Alarm active', 'state', 'Equipment states', 'Equipment context'],
  ['alarm_code', 'Alarm code', 'code', 'Equipment states', 'Equipment context'],
];

export const H66_HISTORY_SIGNALS = Object.freeze(h66.map(([signal]) => signal));
export const PHASE_ENERGY_SIGNALS = Object.freeze(['property', 'ev1'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_energy_l${phase}`)));
export const AUDIT_SIGNALS = Object.freeze(['ev1_lifetime_energy_counter','ev1_session_energy_counter','property_import_energy_counter']);
export const SIGNAL_INFO = Object.freeze(Object.fromEntries([
  ...h66.map(([signal, label, unit, group, role]) => [signal, { label, unit, group, role, kind: 'Recorded' }]),
  ['garage_temperature', { label: 'Garage temperature', unit: '°C', group: 'Home temperatures', role: 'History only', kind: 'Recorded' }],
  ...PHASE_ENERGY_SIGNALS.map(signal => [signal, { label: `${signal.startsWith('property') ? 'Property' : 'Charger'} L${signal.at(-1)} energy`, unit: 'kWh', group: 'Electricity', role: 'Recorded energy', kind: 'Recorded', detail: 'Estimated energy over the recorded interval' }]),
  ...AUDIT_SIGNALS.map(signal=>[signal,{label:signal.startsWith('property')?'Property meter counter':signal.includes('session')?'Charger session counter':'Charger lifetime counter',unit:'kWh',group:'Meter checks',role:'Audit only',kind:'Recorded',detail:'Reported cumulative meter value; never used to correct energy or train'}]),
]));

const basic = [
  ['power', 'Power', 'Electricity', ['property_power', 'auxiliary_power', 'charger_power'], 'kW', 'Calculated'],
  ['phases', 'Phase currents', 'Electricity', ['property_current_l1', 'property_current_l2', 'property_current_l3', 'ev1_current_l1', 'ev1_current_l2', 'ev1_current_l3'], 'A', 'Calculated'],
  ['phase_energy', 'Phase energy per interval', 'Electricity', PHASE_ENERGY_SIGNALS, 'kWh', 'Recorded'],
  ['solar_radiation', 'Solar radiation', 'Weather', ['solar_radiation', 'solar_forecast'], 'W/m²', 'Forecast'],
  ['outdoor_forecast', 'Outdoor temperature forecast', 'Weather', ['outdoor_forecast'], '°C', 'Forecast'],
  ['spot_price','Spot price','Electricity',['spot_price'],'c/kWh','Recorded'],
  ['all_in_price','All-in price','Electricity',['all_in_price'],'c/kWh','Calculated'],
  ['learning_profit', 'Profit after recovery', 'Learning', ['learning_profit'], '€/cycle', 'Calculated'],
  ['learning_aux_profit', 'Profit with auxiliary recovery', 'Learning', ['learning_aux_profit'], '€/cycle', 'Calculated'],
  ['learning_recovery_error', 'Recovery-cost prediction error', 'Learning', ['learning_recovery_error'], '€/cycle', 'Calculated'],
  ['learning_indoor_temperature', 'Learned normal temperature', 'Learning', ['learning_indoor_temperature'], '°C', 'Calculated'],
  ['heat_pump_power', 'Heat-pump power estimate', 'Electricity', ['heat_pump_power'], 'kW', 'Calculated'],
  ['controller_phase', 'Requested controller phase', 'Control', ['controller_phase'], 'state', 'Recorded'],
  ['dhwr_request', 'Hot-water recirculation request', 'Control', ['dhwr_request'], 'state', 'Recorded'],
];

export const HISTORY_AXES = Object.freeze([
  ...basic.map(([key, label, group, signals, unit, kind]) => ({ key, label, group, signals, unit, kind })),
  ...Object.entries(SIGNAL_INFO).filter(([signal]) => !PHASE_ENERGY_SIGNALS.includes(signal)).map(([signal, info]) => ({
    key: signal === 'heating_integral' ? 'integral' : signal, ...info, signals: [signal],
  })),
]);
export const HISTORY_AXIS_BY_KEY = Object.freeze(Object.fromEntries(HISTORY_AXES.map(axis => [axis.key, axis])));
export const HISTORY_GROUPS = Object.freeze(['Electricity', 'Home temperatures', 'Heating', 'Ground loop', 'Hot water', 'Equipment states', 'Settings', 'Runtime counters', 'Control', 'Weather', 'Learning', 'Meter checks']);
