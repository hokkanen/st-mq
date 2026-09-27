import { SIGNAL_INFO, MODEL_INPUT_INFO, GARAGE_INPUT_INFO, GARAGE_OUTCOME_INFO } from './history-series.js';

// The chart uses one display rule for every temperature-valued quantity,
// including references and settings. This does not change stored observations
// or imply that a command transitioned continuously in the equipment.
const continuous = new Set([
  ...Object.entries({ ...SIGNAL_INFO, ...MODEL_INPUT_INFO, ...GARAGE_INPUT_INFO, ...GARAGE_OUTCOME_INFO })
    .filter(([, info]) => info.unit === '°C').map(([key]) => key),
  'learning_indoor_temperature', 'outdoor_forecast',
]);

export const isInterpolatedTemperature = key => continuous.has(key);
