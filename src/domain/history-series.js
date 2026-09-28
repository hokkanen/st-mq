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
export const ENERGY_SIGNALS = Object.freeze([...PHASE_ENERGY_SIGNALS, 'ev2_energy', 'caravan_energy']);
export const AUDIT_SIGNALS = Object.freeze(['property_import_energy_counter']);
export const COUNTER_SIGNALS = Object.freeze([...h66.filter(([, , unit]) => unit === 'h').map(([signal]) => signal),
  ...AUDIT_SIGNALS, 'garage_native_energy']);
export const RECORDED_EVIDENCE_SIGNALS = Object.freeze(['dhwr_active', 'heat_savings_active',
  ...['living', 'storage'].flatMap(group => [0, 1].map(output => `floor_${group}_${output}_active`)),
  'garage_native_defrost', 'garage_native_energy', 'garage_energy']);
export const CARAVAN_POWER_STATES = Object.freeze({ 0: 'Off', 1: 'On' });
export const SESSION_CHECK_INFO = Object.freeze({
  ev1_session_energy_check: { label: 'Charger 1', source: 'easee', color: 'ev', unit: 'kWh', group: 'Meter checks', role: 'Audit only', kind: 'Recorded',
    detail: 'Final session electricity reading; each point represents one completed session' },
  shelly_session_energy_check: { label: 'Charger 2', source: 'shelly-evse', color: 'ev2', unit: 'kWh', group: 'Meter checks', role: 'Audit only', kind: 'Recorded',
    detail: 'Final physical Charger 2 electricity reading; incomplete boundaries are excluded' },
});
export const SIGNAL_INFO = Object.freeze(Object.fromEntries([
  ...h66.map(([signal, label, unit, group, role]) => [signal, { label, unit, group, role, kind: 'Recorded' }]),
  ['indoor_temperature', { label: 'Upstairs', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ['downstairs_temperature', { label: 'Downstairs', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ['bedroom_temperature', { label: 'Bedroom', unit: '°C', group: 'Home temperatures', role: 'House input', kind: 'Recorded' }],
  ['caravan_energy', { label: 'Caravan energy', unit: 'kWh', group: 'Electricity', role: 'History only', kind: 'Recorded', detail: 'Measured meter-counter increments over adaptive recording intervals; excluded from house and garage learning' }],
  ['caravan_temperature', { label: 'Caravan air temperature', unit: '°C', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Shelly BLU air temperature; excluded from house and garage learning' }],
  ['caravan_humidity', { label: 'Caravan relative humidity', unit: '%', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Shelly BLU relative humidity; battery and Bluetooth signal remain live details' }],
  ['caravan_dehumidifier_active', { label: 'Caravan dehumidifier power', unit: 'state', group: 'Caravan', role: 'History only', kind: 'Recorded', detail: 'Reported appliance power: Off or On; missing reports remain gaps. Fan and other settings stay live-only, and commands do not create readings' }],
  ['garage_temperature_2', { label: 'Garage front temperature', unit: '°C', group: 'Home temperatures', role: 'Garage protection input', kind: 'Recorded', detail: 'Front pipe-location sensor; separate exposure and garage learning input' }],
  ...[1, 2].map(index => [`garage_door${index}_open`, { label: `Garage door ${index}`, unit: 'state', group: 'Equipment states', role: 'History only', kind: 'Recorded', detail: 'Reported open or closed state; no age-based change is inferred for an event-only contact' }]),
  ['garage_temperature', { label: 'Garage rear temperature', unit: '°C', group: 'Home temperatures', role: 'Garage protection input', kind: 'Recorded' }],
  ['garage_native_indoor_temperature', { label: 'Pump interpreted indoor temperature', unit: '°C', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Temperature reported by the pump; it may reflect its internal sensor or the supplied external value and native processing, not an independent room measurement' }],
  ['garage_compressor_frequency', { label: 'Compressor frequency', unit: 'Hz', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Native compressor frequency; not electrical power' }],
  ['garage_compressor_active', { label: 'Compressor running', unit: 'state', group: 'Garage heat pump', role: 'History only', kind: 'Recorded', detail: 'Native compressor operation; missing or expired reports remain unknown' }],
  ['garage_native_defrost', { label: 'Garage defrost', unit: 'state', group: 'Garage heat pump', role: 'Equipment context', kind: 'Recorded', detail: 'Supported native defrost reports; unsupported, expired and unavailable reports remain unknown' }],
  ['garage_native_energy', { label: 'Garage native energy counter', unit: 'kWh', group: 'Meter checks', role: 'Audit only', kind: 'Recorded', detail: 'Native cumulative energy counter; not interval consumption, verified electricity or delivered heat' }],
  ['garage_energy', { label: 'Garage heat-pump interval energy', unit: 'kWh', group: 'Garage heat pump', role: 'Recorded energy', kind: 'Recorded', detail: 'Dedicated garage electricity over each recorded interval, from counter differences or integrated power. Native accuracy and provisional evidence remain explicit' }],
  ['dhwr_active', { label: 'Hot-water circulation feedback', unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded', detail: 'Measured electrical load or reported switch state, kept separate from circulation requests; neither proves water flow' }],
  ['heat_savings_active', { label: 'Tariff-control relay feedback', unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded', detail: 'Reported tariff-control contact; not a measurement of compressor activity or heat delivery' }],
  ...['living', 'storage'].flatMap(group => [0, 1].map(output => [`floor_${group}_${output}_active`, {
    label: `${group === 'living' ? 'Living' : 'Storage'} floor override · output ${output}`, unit: 'state', group: 'Control', role: 'Equipment context', kind: 'Recorded',
    detail: 'Reported electrical override contact: 1 on, 0 off; missing readback remains unknown. This does not prove valve position or water flow',
  }])),
  ['auxiliary_power', { label: 'Auxiliary power estimate', unit: 'kW', group: 'Electricity', role: 'Equipment context', kind: 'Calculated', detail: 'Saved estimate from verified auxiliary output and rated capacity' }],
  ...PHASE_ENERGY_SIGNALS.map(signal => [signal, { label: `${signal.startsWith('property') ? 'Property' : signal.startsWith('ev2') ? 'Charger 2' : 'Charger 1'} L${signal.at(-1)} energy`, unit: 'kWh', group: 'Electricity', role: 'Recorded energy', kind: 'Recorded', detail: signal.startsWith('ev2') ? 'Native total meter energy allocated using measured phase-power shares; estimated phase energy, never an additional contribution to total consumption' : 'Estimated energy over the recorded interval' }]),
  ['ev2_energy', { label: 'Charger 2 total energy', unit: 'kWh', group: 'Electricity', role: 'Recorded energy', kind: 'Recorded', detail: 'Authoritative native Charger 2 electricity counter differences over the recorded interval' }],
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

// Garage uses its own journal, fitted model and protection locations.
export const GARAGE_INPUT_INFO = Object.freeze(Object.fromEntries([
  ['rear', 'Rear protection input', '°C', 'rearC', 'rear'],
  ['front', 'Front protection input', '°C', 'frontC', 'front'],
  ['difference', 'Front–rear difference input', '°C', 'differenceC'],
  ['outdoor', 'Outdoor input', '°C', 'outdoorC', 'outdoor'],
  ['power', 'Qualified electrical input', 'kW', 'powerKw'],
  ['activity', 'Compressor activity input', 'fraction', 'activity', undefined,
    'Recorded compressor activity from 0 to 1; reported off/on is 0/1. This describes equipment activity, not measured watts or delivered heat.'],
  ['available', 'Pump power readback', 'state', 'available', undefined,
    'Fresh native pump On/Off readback sampled when the garage learning input was recorded. This is not compressor activity or a continuous archive of native power reports.'],
  ['managed_pause', 'Managed heating pause', 'state', 'managedPause', undefined,
    'Saved confirmed managed-pause phase, including managed savings or timed-off periods. This does not distinguish automatic from manual pauses or measure money saved. Missing samples remain unknown.'],
  ['ev1', 'Charger 1 input', 'kW', 'ev1Kw'], ['ev2', 'Charger 2 input', 'kW', 'ev2Kw'],
  ['ev1_active', 'Charger 1 activity input', 'fraction', 'ev1Active', undefined,
    'Recorded charger 1 activity from 0 to 1; reported off/on is 0/1. Indicates charging disturbance when electrical input is unavailable; it is not converted into heat.'],
  ['ev2_active', 'Charger 2 activity input', 'fraction', 'ev2Active', undefined,
    'Recorded charger 2 activity from 0 to 1; reported off/on is 0/1. Indicates charging disturbance when electrical input is unavailable; it is not converted into heat.'],
].map(([name, label, unit, field, location, detail]) => [`garage_model_${name}`, { label: `Garage · ${label}`,
  unit, field, location, color: location === 'outdoor' ? 'outdoor' : name.startsWith('ev') ? 'ev' : name === 'managed_pause' ? 'heatOff' : 'garage',
  kind: 'Calculated', group: 'Garage model inputs', detail: detail ?? 'Original normalized garage learning input; missing or unqualified evidence remains unknown.' }])));
export const GARAGE_COEFFICIENT_INFO = Object.freeze(Object.fromEntries([
  ['rear', 'coolingPerHour', 'Cooling rate', '1/h'],
  ['front', 'coolingPerHour', 'Cooling rate', '1/h'],
  ['native', 'normalPowerKw', 'Normal electricity estimate', 'kW'],
].map(([location, parameter, label, unit]) => [`garage_coefficient_${location}_${parameter}`, {
  label: `Garage ${location} · ${label}`, location, parameter, unit, digits: 4, color: 'garage', fixed: location === 'native',
  kind: 'Calculated', group: 'Garage model coefficients', detail: 'Versioned garage model replay; fitted cooling, observed electricity and initial assumptions remain distinct.' }])));

export const GARAGE_OUTCOME_INFO = Object.freeze(Object.fromEntries([
  ...['rear', 'front'].map(location => [`garage_outcome_${location}_reference`, {
    label: `Garage ${location} · Achieved normal temperature`, unit: '°C', location, outcome: 'reference',
    color: location === 'rear' ? 'garage' : 'garageFront', kind: 'Calculated',
    detail: 'Replayed achieved temperature during qualified normal heating. The selected room setting is not shown as measured achievement; resets remain gaps until a new reference qualifies.',
  }]),
  ...['rear', 'front'].map(location => [`garage_outcome_${location}_error`, {
    label: `Garage ${location} · Held-out cooling error`, unit: 'Δ°C', location, outcome: 'error',
    color: location === 'rear' ? 'garage' : 'garageFront', kind: 'Calculated',
    detail: 'Rolling root mean square prediction error across clean held-out OFF episodes, including failed validation. Lower is better; no eligible episodes remains unknown.',
  }]),
  ['garage_outcome_benefit', {
    label: 'Garage · Assessed episode benefit', unit: '€/episode', outcome: 'benefit', color: 'learning', kind: 'episode',
    detail: 'Frozen normal-reference assessment at each completed garage episode. Negative and zero estimates remain visible; the result is provisional and separate from electricity timing comparisons.',
  }],
].map(([signal, info]) => [signal, { ...info, group: 'Garage model outcomes' }])));

export const RIGHT_AXIS_SIGNALS = Object.freeze(['model_indoor_temperature', 'garage_temperature', 'outdoor_temperature', 'outdoor_forecast', 'all_in_price', 'spot_price']);

const basic = [
  ['power', 'Power', 'Electricity', ['property_power', 'auxiliary_power', 'charger_power', 'charger2_power'], 'kW', 'Calculated'],
  ['temperatures', 'Home and garage temperatures', 'Home temperatures', ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'garage_temperature', 'garage_temperature_2'], '°C', 'Recorded'],
  ['phases', 'Phase currents / interval estimates', 'Electricity', ['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => `${prefix}_current_l${phase}`)), 'A', 'Calculated'],
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
  ...Object.entries({ ...GARAGE_INPUT_INFO, ...GARAGE_COEFFICIENT_INFO, ...GARAGE_OUTCOME_INFO }).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...Object.entries(SESSION_CHECK_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...Object.entries(MODEL_INPUT_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...Object.entries(MODEL_COEFFICIENT_INFO).map(([signal, info]) => ({ key: signal, ...info, signals: [signal] })),
  ...[
    ['property_power', 'Property electrical power', 'kW', 'Interval-average electricity; supported older current snapshots use 230 V'],
    ['charger_power', 'Charger 1 electrical power', 'kW', 'Interval-average electricity; supported older current snapshots use 230 V'],
    ['charger2_power', 'Charger 2 electrical power', 'kW', 'Authoritative native energy divided by its recording interval'],
    ...['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => [`${prefix}_current_l${phase}`,
      `${prefix === 'property' ? 'Property' : prefix === 'ev1' ? 'Charger 1' : 'Charger 2'} L${phase} current`, 'A',
      'Equivalent interval-average current at 230 V from phase energy; supported older current snapshots retain their observed values'])),
    ['solar_forecast', 'Solar forecast from now', 'W/m²', 'Forecast radiation; not a measurement at the house'],
  ].map(([key, label, unit, detail]) => ({ key, label, unit, detail, signals: [key],
    group: key === 'solar_forecast' ? 'Weather' : 'Electricity', kind: key === 'solar_forecast' ? 'Forecast' : 'Calculated' })),
]);
export const HISTORY_AXIS_BY_KEY = Object.freeze(Object.fromEntries(HISTORY_AXES.map(axis => [axis.key, axis])));
export const HISTORY_GROUPS = Object.freeze(['Electricity', 'Home temperatures', 'Caravan', 'Garage heat pump', 'Heating', 'Ground loop', 'Hot water', 'Equipment states', 'Settings', 'Runtime counters', 'Control', 'Weather', 'Model inputs', 'Model coefficients', 'Learning', 'Meter checks', 'Garage model inputs', 'Garage model coefficients', 'Garage model outcomes']);
