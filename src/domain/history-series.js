import { FLOOR_PREHEAT_CIRCUITS, FLOOR_PREHEAT_SIGNALS } from './floor-circuits.js';

// Shared chart catalogue. Recorder priority is deliberately absent: every
// included measurement receives the same normalized reconstruction objective.
const h66 = [
  ['return_temperature', 'Heating return', '°C', 'Heating', 'Equipment context'],
  ['supply_temperature', 'Heating supply', '°C', 'Heating', 'Equipment context'],
  ['brine_in_temperature', 'Brine in', '°C', 'Ground loop', 'Equipment context'],
  ['brine_out_temperature', 'Brine out', '°C', 'Ground loop', 'History only'],
  ['outdoor_temperature', 'Outdoor temperature', '°C', 'Home temperatures', 'House input'],
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
export const PHASE_ENERGY_SIGNALS = Object.freeze(['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_energy_l${phase}`)));
export const ENERGY_SIGNALS = Object.freeze([...PHASE_ENERGY_SIGNALS, 'caravan_energy']);
export const AUDIT_SIGNALS = Object.freeze(['property_import_energy_counter']);
export const COUNTER_SIGNALS = Object.freeze([...h66.filter(([, , unit]) => unit === 'h').map(([signal]) => signal),
  ...AUDIT_SIGNALS, 'garage_native_energy']);
export const RECORDED_EVIDENCE_SIGNALS = Object.freeze(['dhwr_active', 'heat_savings_active',
  ...FLOOR_PREHEAT_SIGNALS,
  'garage_native_defrost', 'garage_native_energy', 'garage_energy']);
export const CARAVAN_DEHUMIDIFIER_STATES = Object.freeze({ 0: 'Off', 1: 'Low', 2: 'Medium', 3: 'High' });
export const SESSION_CHECK_INFO = Object.freeze({
  ev1_session_energy_check: { label: 'Charger 1', source: 'easee', color: 'ev', unit: 'kWh', group: 'Meter checks', role: 'Audit only', kind: 'Recorded',
    detail: 'Final session electricity reading; each point represents one completed session' },
});
export const SIGNAL_INFO = Object.freeze(Object.fromEntries([
  ...h66.map(([signal, label, unit, group, role]) => [signal, { label, unit, group, role, kind: 'Recorded' }]),
  ['indoor_temperature', { label: 'Upstairs', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ['downstairs_temperature', { label: 'Downstairs', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ...[1, 2, 3].map(phase => [`voltage_estimate_l${phase}`, { label: `Voltage estimate L${phase}`, color: `phase${phase}`, unit: 'V', group: 'Electricity', role: 'Forecast input', kind: 'Estimated',
    detail: 'Voltage estimate with a six-hour smoothing half-life, usable from the first valid reading. Early estimates have less observed history; adaptive recording uses a 0.5 V minimum change. The saved estimate remains applicable until replaced, including across outages; not a live voltage measurement' }]),
  ['bedroom_temperature', { label: 'Bedroom', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ['caravan_energy', { label: 'Caravan energy', unit: 'kWh', group: 'Electricity', role: 'History only', kind: 'Recorded', detail: 'Measured meter-counter increments over adaptive recording intervals; excluded from house learning' }],
  ['caravan_temperature', { label: 'Caravan air temperature', unit: '°C', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Measured caravan air temperature; excluded from house learning' }],
  ['caravan_humidity', { label: 'Caravan relative humidity', unit: '%', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Measured caravan relative humidity; battery and signal remain live details' }],
  ['caravan_dehumidifier_state', { label: 'Caravan dehumidifier state', unit: 'state', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Reported appliance state: Off, Low, Medium or High. The fan level requires reported power on and fresh fan readback; missing evidence remains a gap. This does not prove water removal, and commands do not create readings' }],
  ['garage_temperature_2', { label: 'Garage front temperature', color: 'garageFront', unit: '°C', group: 'Home temperatures', role: 'Garage protection input', kind: 'Recorded', detail: 'Front pipe-location air measurement; separate from estimated pipe temperature' }],
  ...[1, 2].map(index => [`garage_door${index}_open`, { label: `Garage door ${index}`, color: index === 1 ? 'garage' : 'garageFront', unit: 'state', group: 'Equipment states', role: 'History only', kind: 'Recorded', detail: 'Reported open or closed state; no age-based change is inferred for an event-only contact' }]),
  ['garage_temperature', { label: 'Garage rear temperature', color: 'garage', unit: '°C', group: 'Home temperatures', role: 'Garage protection input', kind: 'Recorded' }],
  ['garage_room_target', { label: 'Garage saved room target', color: 'reference', unit: '°C', group: 'Garage heat pump', role: 'Control readback', kind: 'Recorded', detail: 'Durable room target reported by the heat-pump controller; separate from its native thermostat and measured air temperature' }],
  ['garage_effective_target', { label: 'Garage effective room target', color: 'auxiliary', unit: '°C', group: 'Garage heat pump', role: 'Control readback', kind: 'Recorded', detail: 'Effective target reported by the heat-pump controller, including an independent protection override when active; not measured temperature' }],
  ...['rear', 'front'].map(location => [`garage_pipe_${location}_temperature`, { label: `Garage ${location} pipe estimate`, color: location === 'rear' ? 'garagePipeRear' : 'garagePipeFront', unit: '°C', group: 'Garage protection', role: 'Protection estimate', kind: 'Estimated', detail: 'Conservative pipe temperature estimated by the local frost-protection unit; not a direct pipe measurement. Unknown history remains a gap.' }]),
  ['garage_native_power', { label: 'Garage heat-pump power setting', color: 'garagePump', unit: 'state', group: 'Garage heat pump', role: 'Equipment readback', kind: 'Recorded', detail: 'Native ON/OFF readback; ON makes heating available but does not establish compressor operation' }],
  ['garage_external_enabled', { label: 'Garage local room regulation', color: 'garagePump', unit: 'state', group: 'Garage heat pump', role: 'Control readback', kind: 'Recorded', detail: 'Heat-pump controller readback of local room regulation enablement; its temperature input still requires fresh sensor reports' }],
  ['garage_frost_active', { label: 'Garage frost override', color: 'auxiliary', unit: 'state', group: 'Garage protection', role: 'Control readback', kind: 'Recorded', detail: 'Independent frost override reported by the heat-pump controller; missing protection data is unknown rather than inactive' }],
  ['garage_frost_available', { label: 'Garage frost protection available', color: 'reference', unit: 'state', group: 'Garage protection', role: 'Protection readback', kind: 'Recorded', detail: 'The heat-pump controller has a usable frost-protection feed from the configured local protection unit. Unavailable does not mean no freezing risk.' }],
  ['garage_away_mode', { label: 'Garage temperature selection', color: 'garage', unit: 'state', group: 'Garage heat pump', role: 'Saved selection', kind: 'Recorded', detail: 'Application choice: Normal or Away. This is durable user intent, not proof that the target reached the heat-pump controller or that heating is running.' }],
  ['garage_native_indoor_temperature', { label: 'Pump interpreted indoor temperature', color: 'garagePump', unit: '°C', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Temperature reported by the pump; it may reflect its internal sensor or the supplied external value and native processing, not an independent room measurement' }],
  ['garage_compressor_frequency', { label: 'Compressor frequency', color: 'garage', unit: 'Hz', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Native compressor frequency; not electrical power' }],
  ['garage_compressor_active', { label: 'Compressor running', color: 'garage', unit: 'state', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Native compressor operation; missing or expired reports remain unknown' }],
  ['garage_native_defrost', { label: 'Garage heat-pump defrost', color: 'garagePump', unit: 'state', group: 'Garage heat pump', role: 'Equipment context', kind: 'Recorded', detail: 'Native heat-pump defrost reports; unsupported, expired and unavailable reports remain unknown' }],
  ['garage_native_energy', { label: 'Garage native energy counter', color: 'garagePump', unit: 'kWh', group: 'Meter checks', role: 'Audit only', kind: 'Recorded', detail: 'Native cumulative energy counter; not interval consumption, verified electricity or delivered heat' }],
  ['garage_energy', { label: 'Garage heat-pump interval energy', color: 'garagePump', unit: 'kWh', group: 'Garage heat pump', role: 'Recorded energy', kind: 'Recorded', detail: 'Dedicated garage electricity over each recorded interval, from counter differences or integrated power. Native accuracy and provisional evidence remain explicit' }],
  ['dhwr_active', { label: 'Hot-water circulation feedback', unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded', detail: 'Measured electrical load or reported switch state, kept separate from circulation requests; neither proves water flow' }],
  ['heat_savings_active', { label: 'Tariff-control relay feedback', unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded', detail: 'Reported tariff-control contact; not a measurement of compressor activity or heat delivery' }],
  ...FLOOR_PREHEAT_CIRCUITS.map(({ id, label, lengthM }) => [`floor_groundfloor_${id}_active`, {
    label: `${label} ${lengthM} m · floor circuit ${id}`, unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded',
    detail: 'Reported electrical override contact: 1 on, 0 off; missing readback remains unknown. This does not prove valve position or water flow',
  }]),
  ['auxiliary_power', { label: 'Auxiliary power estimate', unit: 'kW', group: 'Electricity', role: 'Equipment context', kind: 'Calculated', detail: 'Saved estimate from verified auxiliary output and rated capacity' }],
  ...PHASE_ENERGY_SIGNALS.map(signal => [signal, { label: `${signal.startsWith('property') ? 'Property' : signal.startsWith('ev2') ? 'Charger 2' : 'Charger 1'} L${signal.at(-1)} energy`, unit: 'kWh', group: 'Electricity', role: 'Recorded energy', kind: 'Recorded', detail: signal.startsWith('ev2') ? 'Native total meter energy allocated using measured phase-power shares; estimated phase distribution whose three-phase sum preserves measured total consumption' : 'Estimated energy over the recorded interval' }]),
  ...AUDIT_SIGNALS.map(signal=>[signal,{label:'Property meter counter',unit:'kWh',group:'Meter checks',role:'Audit only',kind:'Recorded',detail:'Reported cumulative meter value; never used to correct energy or train'}]),
]));

// These describe values resolved for learning, not additional recorder channels.
// Keep them separate from SIGNAL_INFO so Recording details remains a storage view.
export const MODEL_INPUT_INFO = Object.freeze(Object.fromEntries([
  ['model_indoor_temperature', 'Average indoor', '°C', 'indoor', 'The configured indoor average saved at the end of each completed learning interval. Missing inputs remain gaps. Imported learning keeps its original upstairs-only temperature.'],
  ['model_outdoor_temperature', 'Outdoor temperature input', '°C', 'outdoor', 'Recorded outdoor values used within the completed interval, split at source and value changes.'],
  ['model_solar_radiation', 'Solar estimate input', 'W/m²', 'solar', 'Historical radiation estimate from the forecast available before the interval began. Missing forecasts remain unknown; later forecast updates do not rewrite this input.'],
  ['model_compressor_duty', 'Space-heating compressor duty', '%', 'auxiliary', 'The fraction of the interval with observed compressor activity routed to space heating. Hot-water operation contributes zero; unavailable attribution remains unknown.'],
  ['model_hydronic_heat', 'Combined hydronic heat estimate', 'kW thermal', 'compressorSpace', 'Estimated compressor heat plus resistance-heater heat attributed to space heating. The saved manufacturer performance map supplies compressor output; this is not heat metering. Unknown routing remains unknown.'],
  ['model_valve_override', 'Floor valve override input', 'state', 'learning', 'Pooled relay-output mode saved with the learning interval. Feedback confirms the electrical override, not valve movement or flow. Opening circuits changes heat allocation; it does not create heat or reset stored energy. Unknown confirmation remains unknown.'],
  ['model_auxiliary_power', 'Space-heating auxiliary input', 'kW', 'auxiliary', 'Auxiliary electrical input attributed to space heating within the interval, estimated from recorded output and the rated capacity in effect. Changes retain their own segment boundaries.'],
  ['model_controller_phase', 'Requested control phase input', 'state', 'learning', 'The controller phase saved with the interval: normal, preheat, tariff reduction or recovery. A reduction request does not prove that the compressor stopped.'],
  ['model_room_boost', 'ROOM boost input', '°C', 'integral', 'The temporary room-setting increase saved with the learning interval. It describes requested control, not measured indoor warming.'],
  ['model_target_temperature', 'Reference temperature input', '°C', 'indoor', 'The comfort reference saved when the interval was processed. Later changes do not rewrite the earlier reference.'],
  ['firewood_load', 'Manually recorded firewood additions', 'kg', 'firewood', 'Manually reported additions of dry firewood, shown as events; additions at exactly the same time are grouped. Mistaken entries are excluded after correction; each point is fuel added, not delivered heat.', 'Recorded manual'],
  ['model_fireplace_release', 'Fireplace release input', 'kg/h', 'firewood', 'The delayed response to recorded firewood, expressed as fuel-equivalent kilograms per hour. This is a calculated input to the thermal model, not a measured burn rate or heat output.'],
].map(([signal, label, unit, color, detail, kind = 'Calculated']) => [signal, { label, unit, color, detail, kind, group: 'Model inputs' }])));

// Reconstructed from the learning journal in memory, never recorder channels.
export const MODEL_COEFFICIENT_INFO = Object.freeze(Object.fromEntries([
  ['model_coefficient_heat_loss', 'Heat loss', '1/h', 'outdoor', 'lossPerHour', 4, 'Heat loss per degree of indoor–outdoor temperature difference. Multiply by that difference to get the modeled cooling contribution in °C/h.'],
  ['model_coefficient_hydronic_response', 'Combined compressor + auxiliary response', '°C/kWh thermal', 'compressorSpace', 'hydronicCPerKwh', 4, 'Effective temperature response per estimated thermal kWh supplied by the compressor and resistance heater together. Heat enters the slow reserve before it reaches indoor air. This is a house response, not COP or measured heat capacity.'],
  ['model_coefficient_solar_response', 'Solar response', '°C/h per kW/m²', 'solar', 'solarCPerHourPerKwM2', 3, 'Temperature response to forecast solar radiation. Radiation forecasts enter in W/m² and are converted to kW/m²; no house radiation sensor is implied.'],
  ['model_coefficient_fireplace_response', 'Fireplace response', '°C/kg', 'firewood', 'fireplaceCPerKg', 3, 'Effective temperature contribution per logged kilogram after the delayed masonry release. This is a house-model coefficient, not measured fireplace efficiency or delivered kWh.'],
].map(([signal, label, unit, color, parameter, digits, detail]) => [signal,
  { label, unit, color, parameter, digits, detail, kind: 'Calculated', group: 'Model coefficients' }])));

export const RIGHT_AXIS_SIGNALS = Object.freeze(['model_indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast', 'all_in_price', 'spot_price']);

const basic = [
  ['power', 'Power', 'Electricity', ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power'], 'kW', 'Calculated'],
  ['temperatures', 'Home and garage temperatures', 'Home temperatures', ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'garage_temperature', 'garage_temperature_2'], '°C', 'Recorded'],
  ['phases', 'Phase currents / interval estimates', 'Electricity', ['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)), 'A', 'Calculated'],
  ['voltage_estimates', 'Phase voltage estimates', 'Electricity', [1, 2, 3].map(phase => `voltage_estimate_l${phase}`), 'V', 'Estimated'],
  ['phase_energy', 'Phase energy per interval', 'Electricity', PHASE_ENERGY_SIGNALS, 'kWh', 'Recorded'],
  ['solar_radiation', 'Solar estimate', 'Weather', ['solar_radiation', 'solar_forecast'], 'W/m²', 'Estimated'],
  ['outdoor_forecast', 'Outdoor forecast from now', 'Weather', ['outdoor_forecast'], '°C', 'Forecast'],
  ['spot_price','Spot price','Electricity',['spot_price'],'c/kWh','Recorded'],
  ['all_in_price','All-in price','Electricity',['all_in_price'],'c/kWh','Calculated'],
  ['learning_profit', 'Space-heating benefit after recovery', 'Learning', ['learning_profit'], '€/cycle', 'Calculated'],
  ['learning_aux_profit', 'Space-heating benefit with auxiliary recovery', 'Learning', ['learning_aux_profit'], '€/cycle', 'Calculated'],
  ['learning_recovery_error', 'Space-heating recovery-cost prediction error', 'Learning', ['learning_recovery_error'], '€/cycle', 'Calculated'],
  ['learning_indoor_temperature', 'Learned normal temperature', 'Learning', ['learning_indoor_temperature'], '°C', 'Calculated'],
  ['firewood_savings', 'Firewood electricity cost avoided', 'Learning', ['firewood_savings'], '€/day', 'Calculated'],
  ['firewood_electricity_avoided', 'Firewood electricity avoided', 'Learning', ['firewood_electricity_avoided'], 'kWh/day', 'Calculated'],
  ['heat_pump_power', 'Heat-pump power estimate', 'Electricity', ['heat_pump_power'], 'kW', 'Calculated'],
  ['caravan_power', 'Caravan power', 'Caravan', ['caravan_power'], 'kW', 'Calculated', 'Average power derived from measured energy over each original recording interval; not instantaneous power'],
  ['controller_phase', 'Requested controller phase', 'Control', ['controller_phase'], 'state', 'Recorded'],
  ['dhwr_request', 'Hot-water circulation request', 'Control', ['dhwr_request'], 'state', 'Recorded'],
];

export const HISTORY_AXES = Object.freeze([
  ...basic.map(([key, label, group, signals, unit, kind, detail]) => ({ key, label, group, signals, unit, kind, ...(detail ? { detail } : {}) })),
  ...Object.entries(SIGNAL_INFO).map(([signal, info]) => ({
    key: signal === 'heating_integral' ? 'integral' : signal, ...info, signals: [signal],
  })),
  ...Object.entries(SESSION_CHECK_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...Object.entries(MODEL_INPUT_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...Object.entries(MODEL_COEFFICIENT_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...[
    ['property_power', 'Property electrical power', 'kW', 'Interval-average electricity; current snapshots use historical phase-voltage estimates, with retrospective first usable estimates for earlier CSV history'],
    ['charger_power', 'Charger 1 electrical power', 'kW', 'Interval-average electricity; current snapshots use historical phase-voltage estimates, with retrospective first usable estimates for earlier CSV history'],
    ['charger2_power', 'Charger 2 electrical power', 'kW', 'Sum of recorded phase energies divided by their shared interval; native meter increments preserve measured total consumption'],
    ['property_current_max', 'Property highest phase', 'A', 'Highest of the three simultaneous property phase-current estimates from recorded energy and historical voltage; an interval average, not an instantaneous peak. Missing phase evidence leaves a gap'],
    ['ev1_current_allowance', 'Charger 1 allowance', 'A', 'Recorded minimum native Equalizer allowance across all three phases, capped by fixed equipment limits; not measured draw or charging permission'],
    ['ev2_current_allowance', 'Charger 2 allowance', 'A', 'Recorded controller load-balancing allowance for the limiting phase; native current setting and charging permission remain separate. Missing evidence leaves a gap'],
    ['ev2_current_fallback', 'Charger 2 fallback', 'A', 'Recorded fallback current cap when load evidence is unavailable, shown separately from verified allowance; nonnegative amperes including zero'],
    ...['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => [`${prefix}_current_l${phase}`,
      `${prefix === 'property' ? 'Property' : prefix === 'ev1' ? 'Charger 1' : 'Charger 2'} L${phase} current`, 'A',
      'Equivalent interval-average current from phase energy and historical phase-voltage estimates, assuming unity power factor; supported older current snapshots retain their observed values'])),
    ['solar_forecast', 'Solar forecast from now', 'W/m²', 'Forecast radiation; not a measurement at the house'],
  ].map(([key, label, unit, detail]) => ({ key, label, unit, detail, signals: [key],
    group: key === 'solar_forecast' ? 'Weather' : 'Electricity', kind: key === 'solar_forecast' ? 'Forecast' : 'Calculated' })),
]);
export const HISTORY_AXIS_BY_KEY = Object.freeze(Object.fromEntries(HISTORY_AXES.map(axis => [axis.key, axis])));
export const HISTORY_GROUPS = Object.freeze(['Electricity', 'Home temperatures', 'Caravan', 'Garage heat pump', 'Garage protection', 'Heating', 'Ground loop', 'Hot water', 'Equipment states', 'Settings', 'Runtime counters', 'Control', 'Weather', 'Model inputs', 'Model coefficients', 'Learning', 'Meter checks']);
