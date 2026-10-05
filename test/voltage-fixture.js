import { Store } from '../src/storage/store.js';
import { VOLTAGE_VERSION } from '../src/storage/voltage.js';

/** Explicit synthetic history evidence; never a production voltage default. */
export function seedVoltage(store, at, voltages = [230, 230, 230], { input = 'providers', receivedAt = at, coverageMs = 0,
  inputs = input === 'simulated' ? 8 : 4, latestInput = inputs } = {}) {
  for (const [phase, value] of voltages.entries()) store.observation({ source: 'voltage-estimate', device: input,
    signal: `voltage_estimate_l${phase + 1}`, value, unit: 'V', sourceTime: at, receivedAt,
    quality: ['estimated'], raw: { basis: 'time-weighted-voltage-estimate',
      voltageSource: 'synthetic-meter', voltageAvailability: 'reporting',
      voltageEstimate: { version: VOLTAGE_VERSION, inputs, input: latestInput, phase: phase + 1, coverageMs } } });
}

export function voltageStore() {
  const store = new Store(':memory:');
  seedVoltage(store, 0);
  return store;
}
