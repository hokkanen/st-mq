import { ENERGY_SIGNALS, SIGNAL_INFO } from './history-series.js';
import { HELD_TEMPERATURE_SIGNALS } from './indoor-sensors.js';

// Recording policy describes the writer, independently of chart/model roles.
// Freshness/report cadence never selects a numeric sampling policy.
const LIVE_ONLY = new Set(['caravan_active', 'caravan_power', 'caravan_current',
  'garage_relay_active', 'blu_ht_battery', 'blu_ht_rssi',
  'garage_temperature_ha', 'garage_power', 'garage_external_temperature', 'heat_pump_power']);
const CARAVAN_RECORDED = new Set(['caravan_energy', 'caravan_temperature', 'caravan_humidity',
  'caravan_dehumidifier_state']);
const EXACT = /(?:_active$|_routing$|_mode$|_code$|_setting$|_hours$|_counter$|^room_influence$|^heating_curve$|^heating_setpoint$|^auxiliary_output$|^garage_native_energy$)/;
const EVENT_SIGNALS = new Set(['controller_phase', 'dhwr_request', 'learning_profit', 'learning_aux_profit',
  'learning_recovery_error', 'learning_indoor_temperature']);
export const RECORDING_POLICIES = Object.freeze({
  'adaptive-value': { label: 'Adaptive measurement', adaptive: true, recorded: true, retention: 'history',
    writeBehavior: 'Initial reading, learned change threshold, or quality/availability change; unchanged readings extend coverage without another value.',
    basis: 'Original observed value; the learned tolerance selects which changes are retained.' },
  'adaptive-energy': { label: 'Adaptive energy', adaptive: true, recorded: true, retention: 'history',
    writeBehavior: 'Energy increments accumulate until a significant power change, measurement-basis change, gap or explicit closure. Charger idle noise uses a 10 W selection floor; all accepted energy is retained.',
    basis: 'Accumulated kWh over the recorded interval; selection uses power. Charger native counters retain exact energy even when instantaneous power and counter increments differ.' },
  'change-only': { label: 'Every change', adaptive: false, recorded: true, retention: 'history',
    writeBehavior: 'Initial reading and every value, quality or availability change; unchanged reports extend coverage without repeating the value.',
    basis: 'Exact reported value or state, including explicit unknown periods; no learned change threshold.' },
  event: { label: 'On event', adaptive: false, recorded: true, retention: 'history',
    writeBehavior: 'When the associated request, control coverage or calculated result changes.',
    basis: 'A controller request or saved calculation; not independent physical feedback.' },
  interval: { label: 'Electrical interval', adaptive: false, recorded: true, retention: 'history',
    writeBehavior: 'Each accepted qualified electrical interval; invalid or missing coverage is not filled.',
    basis: 'Counter differences or integrated measured power, with original interval boundaries and quality.' },
  'hourly-energy': { label: 'Completed hour', adaptive: false, recorded: true, retention: 'history',
    writeBehavior: 'Once for each completed UTC hour containing accepted metered increments; partial coverage remains marked.',
    basis: 'Measured meter-counter increments allocated across UTC-hour boundaries by elapsed time; not adaptive recording.' },
  import: { label: 'Imported history', adaptive: false, recorded: true, retention: 'history',
    writeBehavior: 'Once per accepted source row during supported CSV import; duplicate imports are not added again.',
    basis: 'Original CSV timestamp, value, unit, quality and row provenance.' },
  'live-only': { label: 'Live only', adaptive: false, recorded: false, retention: 'current',
    writeBehavior: 'No telemetry history is written.', basis: 'Live acquisition or a value reconstructed from other stored records.' },
});

export function recordingPolicy(observation = {}, { kind } = {}) {
  const { source, signal, unit } = observation;
  let id;
  if (observation.importId != null || observation.import_id != null || source?.startsWith('csv:')) id = 'import';
  else if (LIVE_ONLY.has(signal) || signal?.startsWith('garage_heat_pump_') || source === 'mqtt-temperature-ha'
    || signal?.startsWith('caravan_') && !CARAVAN_RECORDED.has(signal)
    || source === 'husdata-h66' && ['indoor_temperature', 'outdoor_temperature', 'discharge_temperature', 'brine_pump_active'].includes(signal)
    || observation.raw?.acquisitionOnly || observation.raw?.auditOnly) id = 'live-only';
  else if (observation.raw?.timeBasis === 'completed-hour' && unit === 'kWh') id = 'hourly-energy';
  else if (ENERGY_SIGNALS.includes(signal)) id = 'adaptive-energy';
  else if (signal === 'garage_energy') id = 'interval';
  else if (EVENT_SIGNALS.has(signal)) id = 'event';
  else if (kind === 'state' || observation.recordingPolicy === 'change-only' || ['state', 'code'].includes(unit)
    || ['garage_room_target', 'garage_effective_target'].includes(signal) || EXACT.test(signal ?? '') || HELD_TEMPERATURE_SIGNALS.includes(signal) || signal === 'auxiliary_power') id = 'change-only';
  else id = 'adaptive-value';
  return { id, ...RECORDING_POLICIES[id] };
}

export const isAdaptiveRecording = observation => recordingPolicy(observation).adaptive;

// Units and writer policy are part of the stream identity, including explicitly
// exact custom readings. Recorder statistics and recovered history share it.
export const recordingStreamKey = observation => JSON.stringify([observation.source, observation.device,
  observation.signal, observation.unit, recordingPolicy(observation).id]);

const names = {
  charger1_current_allowance: 'Charger 1 current allowance',
  charger2_current_allowance: 'Charger 2 current allowance',
  controller_phase: 'Requested controller phase', dhwr_request: 'Hot-water circulation request',
  dhwr_active: 'Hot-water circulation feedback', garage_energy: 'Garage heat-pump energy',
  heat_savings_active: 'Tariff-control relay feedback',
  garage_native_defrost: 'Garage heat pump defrost state', garage_native_power: 'Garage native power setting',
  garage_native_energy: 'Garage native energy counter',
  garage_room_target: 'Garage saved room target', garage_effective_target: 'Garage effective room target',
  garage_external_enabled: 'Garage local temperature regulation enabled', garage_frost_active: 'Garage frost protection active',
  garage_frost_available: 'Garage frost protection available', garage_away_mode: 'Requested Garage Away mode',
  garage_pipe_rear_temperature: 'Rear pipe temperature estimate',
  garage_pipe_front_temperature: 'Front pipe temperature estimate',
  learning_profit: 'Space-heating benefit after recovery', learning_aux_profit: 'Space-heating benefit with auxiliary recovery',
  learning_recovery_error: 'Space-heating recovery-cost prediction error', learning_indoor_temperature: 'Learned normal indoor temperature',
};
export function recordedSignalInfo(signal, unit) {
  const info = SIGNAL_INFO[signal];
  return { label: info?.label ?? names[signal] ?? String(signal).replaceAll('_', ' '),
    unit: unit ?? info?.unit ?? '', group: info?.group ?? (signal?.startsWith('floor_') ? 'Floor override contacts' : 'Equipment'),
    basis: ['charger1_current_allowance', 'charger2_current_allowance'].includes(signal) ? 'Nonnegative load-balancing allowance with separate mode, source evidence and restrictions. Unchanged observations extend compact coverage; restart and unobserved periods stay unknown. Retained independently of charging reports; this does not prove physical charging.'
      : signal?.startsWith('floor_') ? 'Reported electrical override contact: 1 on, 0 off, unknown without confirmed readback. This does not prove valve position or water flow.'
      : info?.detail ?? null };
}
