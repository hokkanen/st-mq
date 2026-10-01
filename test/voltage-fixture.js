import { Store } from '../src/storage/store.js';

/** Explicit synthetic history evidence; never a production voltage default. */
export function seedVoltage(store, at, voltages = [230, 230, 230], { input = 'providers', receivedAt = at, mature = true,
  inputs = input === 'simulated' ? 8 : 4, latestInput = inputs } = {}) {
  for (const [phase, value] of voltages.entries()) store.observation({ source: 'voltage-estimate', device: input,
    signal: `voltage_estimate_l${phase + 1}`, value, unit: 'V', sourceTime: at, receivedAt,
    quality: ['estimated'], raw: { basis: 'time-weighted-voltage-estimate', voltageMature: mature,
      voltageSource: 'synthetic-meter', voltageAvailability: 'reporting',
      voltageEstimate: { inputs, input: latestInput, phase: phase + 1, coverageMs: mature ? 3600_000 : 0 } } });
}

export function voltageStore() {
  const store = new Store(':memory:');
  seedVoltage(store, 0);
  return store;
}
