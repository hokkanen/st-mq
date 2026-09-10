export const TEMPERATURE_SENSORS = Object.freeze({
  indoor_temperature: 'Upstairs',
  downstairs_temperature: 'Downstairs',
  bedroom_temperature: 'Bedroom',
  garage_temperature: 'Garage',
  outdoor_temperature: 'Outdoor',
});
export const INDOOR_SIGNALS = Object.freeze(['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature']);
export const SENSOR_SETTLING_MS = 30 * 60_000;

/** Membership is configuration, never inferred from which sensors answer a poll. */
export function indoorWeights(config = {}) {
  const weights = config.indoorSensorWeights ?? { indoor_temperature: 1 };
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)
    || Object.entries(weights).some(([signal, weight]) => !INDOOR_SIGNALS.includes(signal)
      || !Number.isFinite(weight) || weight < 0)) throw new TypeError('Invalid indoor sensor weights');
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || !(total > 0)) throw new TypeError('Indoor sensor weights must have a positive total');
  return Object.fromEntries(INDOOR_SIGNALS.filter(signal => weights[signal] > 0)
    .map(signal => [signal, weights[signal] / total]));
}

export function indoorAverage(readings, config = {}) {
  const weights = indoorWeights(config), signals = Object.keys(weights);
  const known = signals.every(signal => Number.isFinite(readings[signal]?.value)
    && readings[signal].value > 2 && readings[signal].value < 40);
  const usable = known && signals.every(signal => !readings[signal].stale);
  return { value: known ? signals.reduce((sum, signal) => sum + readings[signal].value * weights[signal], 0) : null,
    observedAt: known ? Math.min(...signals.map(signal => readings[signal].observedAt)) : null,
    stale: !usable, source: signals.length === 1 ? readings[signals[0]]?.source ?? 'indoor-average' : 'indoor-average',
    quality: usable ? [...new Set(signals.flatMap(signal => readings[signal].quality ?? []))] : ['missing'], weights };
}
