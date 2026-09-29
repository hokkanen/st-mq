import { createGarageAdapter } from '../../src/garage/adapter.js';
import { createShellyCn105Transport } from '../../src/garage/shelly-cn105.js';
import { SHELLY_CN105_CONTRACT } from '../../src/garage/contract.js';
export const GARAGE_TEST_AT = 1_800_000_000_000;
export const GARAGE_TEST_ADAPTER = { driver: 'shelly-cn105', stateTopic: 'test/pill/state',
  telemetryTopic: 'test/pill/telemetry', commandTopic: 'test/pill/command', maxAgeMs: 120_000, electricalSource: 'none' };
export function garageV2Fixture(options = {}) {
  let now = GARAGE_TEST_AT, sequence = 0;
  const publications = [], observations = [], snapshots = [];
  const adapter = createGarageAdapter({ settings: GARAGE_TEST_ADAPTER, clock: () => now,
    productionTransport: createShellyCn105Transport({ settings: GARAGE_TEST_ADAPTER,
      publish: async (topic, payload, settings) => { publications.push({ topic, ...JSON.parse(payload), settings }); } }),
    onObservation: row => observations.push(row), onState: value => snapshots.push(value), ...options });
  const state = { schema: SHELLY_CN105_CONTRACT, deviceId: 'synthetic-pill', bootId: 'boot-one',
    control: { targetC: 10, externalEnabled: true, effectiveTargetC: 10, status: 'active',
      sensorTemperatureC: 8, sensorAgeMs: 1000, externalTemperatureC: 15, externalAcknowledged: true,
      frostConfigured: false, frostAvailable: false, frostActive: false, frostRescue: false },
    health: { nativeFresh: true, pumpAgeMs: 100 }, readback: { complete: true, fresh: true, ageMs: 100 },
    capabilities: { manualControls: ['power', 'mode', 'fan', 'vane'], manualOptions: { fan: ['auto', 1, 2, 3, 4] } } };
  const update = (overrides = {}, packet = {}) => {
    const native = Object.fromEntries(Object.entries({ power: 'off', mode: 'heat', targetC: 17, fan: 'auto', vane: 'auto' })
      .map(([key, value]) => [key, { value, measuredAt: now - 100 }]));
    const value = { ...state, sequence: ++sequence, observedAt: now, native, challenge: { value: `challenge-${sequence}` },
      ...overrides, control: { ...state.control, ...overrides.control },
      health: { ...state.health, ...overrides.health }, readback: { ...state.readback, ...overrides.readback } };
    return adapter.receive(GARAGE_TEST_ADAPTER.stateTopic, JSON.stringify(value), packet, now);
  };
  adapter.setConnected(true);
  return { adapter, publications, observations, snapshots, update, now: () => now, at: value => { now = value; } };
}
