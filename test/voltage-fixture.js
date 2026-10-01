import { Store } from '../src/storage/store.js';

/** Explicit synthetic history evidence; never a production voltage default. */
export function seedVoltage(store, at, voltages = [230, 230, 230], { input = 'providers', receivedAt = at, mature = true } = {}) {
  for (const [phase, value] of voltages.entries()) store.observation({ source: 'voltage-estimate', device: input,
    signal: `voltage_estimate_l${phase + 1}`, value, unit: 'V', sourceTime: at, receivedAt,
    quality: ['estimated'], raw: { basis: 'time-weighted-voltage-estimate', voltageMature: mature,
      voltageSource: 'synthetic-meter', voltageAvailability: 'reporting' } });
}

export function voltageStore() {
  const store = new Store(':memory:');
  seedVoltage(store, 0);
  return store;
}
