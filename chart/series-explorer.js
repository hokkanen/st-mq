import { HISTORY_AXES, SIGNAL_INFO, ENERGY_SIGNALS, SESSION_CHECK_INFO, MODEL_INPUT_INFO,
  MODEL_COEFFICIENT_INFO, GARAGE_INPUT_INFO, GARAGE_COEFFICIENT_INFO } from '../src/domain/history-series.js';

const definitions = { ...SIGNAL_INFO, ...SESSION_CHECK_INFO, ...MODEL_INPUT_INFO,
  ...MODEL_COEFFICIENT_INFO, ...GARAGE_INPUT_INFO, ...GARAGE_COEFFICIENT_INFO };
const descriptions = {
  model_fireplace_release: 'Calculated from corrected firewood additions; fuel-equivalent release, not measured heat.',
  controller_phase: 'Requested heating phase, bounded by the next request or expiry; not proof of equipment operation.',
  dhwr_request: 'Requested recirculation pulse; not confirmed pump operation or water flow.',
  spot_price: 'Market electricity price, excluding VAT and other charges.',
  all_in_price: 'Calculated electricity price with the applicable historical tariff; inspect points for assumed prices.',
  heat_pump_power: 'Reconstructed whole heat-pump electricity estimate, including auxiliary heating.',
  learning_profit: 'Saved rolling assessment of completed space-heating cycles after recovery; hot-water service excluded.',
  learning_aux_profit: 'Saved rolling assessment of space-heating cycles with auxiliary recovery.',
  learning_recovery_error: 'Saved rolling mean absolute recovery-cost prediction error; lower is better.',
  learning_indoor_temperature: 'Learned normal indoor reference, not a thermostat command.',
  solar_radiation: 'Latest valid weather estimate known at each historical time; not a solar sensor reading or a later revised forecast.',
};

function meaning(signal, info) {
  if (ENERGY_SIGNALS.includes(signal) || signal === 'garage_energy') return ['recording-interval-energy', 'Recording-interval energy'];
  if (signal.endsWith('_counter') || signal === 'garage_native_energy') return ['cumulative-energy', 'Cumulative meter counter'];
  if (signal.endsWith('_hours')) return ['cumulative-runtime', 'Cumulative runtime counter'];
  if (SESSION_CHECK_INFO[signal]) return ['completed-session-energy', 'Completed-session reading'];
  if (signal === 'firewood_load') return ['manual-addition', 'Corrected manual addition'];
  if (signal === 'model_fireplace_release') return ['fireplace-release', 'Calculated fireplace release'];
  if (signal.startsWith('firewood_')) return [signal, 'Retrospective daily model estimate'];
  if (MODEL_COEFFICIENT_INFO[signal] || GARAGE_COEFFICIENT_INFO[signal]) return [`coefficient:${info.unit}`, 'Replayed model coefficient'];
  if (['model_room_boost', 'garage_model_difference'].includes(signal)) return ['saved-temperature-difference', 'Saved temperature difference'];
  if (MODEL_INPUT_INFO[signal] || GARAGE_INPUT_INFO[signal]) return [`saved-input:${info.unit}`, 'Saved learning input'];
  if (signal.startsWith('learning_')) return [signal === 'learning_indoor_temperature' ? 'temperature' : `assessed-cycle:${info.unit}`, 'Saved model assessment'];
  if (signal === 'solar_radiation') return ['historical-solar-estimate', 'Historical solar estimate'];
  if (signal.includes('forecast')) return [`forecast:${info.unit}`, 'Weather forecast'];
  if (['controller_phase', 'dhwr_request'].includes(signal)) return [`state:${signal}`, 'Recorded control request'];
  if (info.unit === 'state' || info.unit === 'code') return [`state:${signal}`, 'Recorded state'];
  if (info.unit === '°C') return ['temperature', /setting|setpoint|curve/.test(signal) ? 'Recorded temperature setting' : 'Recorded temperature'];
  if (info.unit === 'kW') return ['electrical-power', info.kind === 'Calculated' ? 'Calculated electrical power' : 'Recorded electrical power'];
  if (info.unit === 'A') return ['phase-current', 'Recorded current / interval estimate'];
  if (info.unit === '%') return [signal === 'caravan_humidity' ? 'relative-humidity' : 'equipment-output', 'Recorded measurement'];
  return [`${info.group}:${info.unit}`, info.kind === 'Calculated' ? 'Supported calculation' : 'Recorded value'];
}

// Every entry names a supported historical projection. Current-state JSON,
// configuration, identifiers and undeclared numeric fields are not chart data.
export const EXPLORER_SERIES = Object.freeze([...new Set(HISTORY_AXES.flatMap(axis => axis.signals))].map(signal => {
  const axis = HISTORY_AXES.find(row => row.signals.length === 1 && row.signals[0] === signal)
    ?? HISTORY_AXES.find(row => row.signals.includes(signal));
  const info = definitions[signal] ?? axis;
  const [compatibilityKey, basis] = meaning(signal, info);
  const description = descriptions[signal] ?? info.detail ?? basis;
  return Object.freeze({ key: signal, signal, requestKey: axis.key, label: info.label,
    unit: info.unit, group: info.group, kind: info.kind, basis, compatibilityKey,
    description,
    searchText: [signal, axis.key, info.label, info.group, info.unit, basis, description].filter(Boolean).join(' ').toLowerCase() });
}));

export const EXPLORER_SERIES_BY_KEY = Object.freeze(Object.fromEntries(EXPLORER_SERIES.map(row => [row.key, row])));

export function filterExplorerSeries(query = '') {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return EXPLORER_SERIES.filter(row => terms.every(term => row.searchText.includes(term)));
}

export function compatibleExplorerSeries(first, second) {
  const a = typeof first === 'string' ? Object.hasOwn(EXPLORER_SERIES_BY_KEY, first) && EXPLORER_SERIES_BY_KEY[first] : first;
  const b = typeof second === 'string' ? Object.hasOwn(EXPLORER_SERIES_BY_KEY, second) && EXPLORER_SERIES_BY_KEY[second] : second;
  return Boolean(a && b && a.unit === b.unit && a.compatibilityKey === b.compatibilityKey);
}

export function explorerSelection(key) {
  const row = Object.hasOwn(EXPLORER_SERIES_BY_KEY, key) && EXPLORER_SERIES_BY_KEY[key];
  if (!row) throw new RangeError('Choose a supported historical series.');
  const categorical = ['state', 'code'].includes(row.unit);
  const prices = ['all_in_price', 'spot_price'];
  const price = prices.includes(row.signal);
  const temperature = row.unit === '°C' && row.compatibilityKey !== 'saved-temperature-difference';
  return { key: `series:${row.key}`, label: row.label, group: 'Series explorer',
    requestKey: row.requestKey, description: `${row.basis}. ${row.description === row.basis ? '' : row.description}`.trim(),
    leftSignals: price ? prices : categorical || temperature ? [] : [row.signal],
    rightSignals: price ? [] : [...(temperature ? [row.signal] : []), ...prices],
    tracks: categorical ? [row.signal] : [], defaults: {},
    unit: row.compatibilityKey === 'saved-temperature-difference' ? 'Δ°C' : row.unit, stackPower: false };
}
