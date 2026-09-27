import { SIGNAL_INFO } from './history-series.js';

// Measurements and temperature estimates are continuous quantities. A setting
// expressed in °C is still a discrete command and must keep its actual steps.
const continuous = new Set([
  ...Object.entries(SIGNAL_INFO).filter(([key, info]) => info.unit === '°C'
    && (info.group === 'Home temperatures' || key.endsWith('_temperature'))).map(([key]) => key),
  'model_indoor_temperature', 'model_outdoor_temperature', 'outdoor_forecast',
  'garage_model_rear', 'garage_model_front', 'garage_model_difference', 'garage_model_outdoor',
]);

export const isInterpolatedTemperature = key => continuous.has(key);
