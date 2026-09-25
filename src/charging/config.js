import { DEFAULT_CHARGING_DEFAULTS, chargingDefaults } from './settings.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const strict = (value, allowed, label) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label}; use the current physical-EVSE configuration`);
};
const topic = value => value === '' || value === null || typeof value === 'string' && value.length <= 256 && !/[+#\u0000-\u0020]/.test(value);
export const DEFAULT_CHARGING_CONFIGURATION = Object.freeze({
  defaults: DEFAULT_CHARGING_DEFAULTS,
  chargers: { charger1: {}, charger2: {
    enabled: false, profile: 'top-ac-portable', deviceId: '', model: '', firmware: '', topicPrefix: '',
    associationVersion: 1, verified: false, serviceId: 0, minimumCurrentA: 6, maximumCurrentA: 16, currentStepA: 1,
    limiterEnabled: false, fallbackCurrentA: 12, mainFuseA: [25, 25, 25], marginA: [1, 1, 1],
    phaseMap: [0, 1, 2], additiveCurrentVerified: false, maxAgeMs: 15000, maxSkewMs: 5000,
    dwellMs: 30000, rampA: 2, connectedStates: [], disconnectedStates: [], chargingStates: [],
  } },
  vehicles: {
    bmw: { label: 'BMW', provider: 'bmw-cardata', mqttTopic: 'stmq/vehicles/bmw', defaults: { capacityKwh: 74 } },
    tesla: { label: 'Tesla', provider: 'teslamate', defaults: { capacityKwh: 57 } },
  },
});
export function chargingConfiguration(input = {}) {
  strict(input, ['defaults', 'chargers', 'vehicles'], 'charging configuration');
  const generalDefaults = chargingDefaults(input.defaults);
  strict(input.chargers ?? {}, ['charger1', 'charger2'], 'chargers');
  strict(input.chargers?.charger1 ?? {}, [], 'Easee configuration');
  const c1 = { ...DEFAULT_CHARGING_CONFIGURATION.chargers.charger1, ...input.chargers?.charger1 };
  const defaults = DEFAULT_CHARGING_CONFIGURATION.chargers.charger2, supplied = input.chargers?.charger2 ?? {};
  strict(supplied, Object.keys(defaults), 'Shelly EVSE configuration');
  const c2 = { ...structuredClone(defaults), ...supplied };
  for (const key of ['enabled', 'verified', 'limiterEnabled', 'additiveCurrentVerified']) if (typeof c2[key] !== 'boolean') throw new Error(`Invalid EVSE ${key}`);
  if (c2.profile !== 'top-ac-portable' || !topic(c2.topicPrefix) || !topic(c2.deviceId)) throw new Error('Unsupported EVSE profile or topic');
  for (const key of ['model', 'firmware']) if (typeof c2[key] !== 'string' || c2[key].length > 100 || /[\u0000-\u001f]/.test(c2[key])) throw new Error(`Invalid EVSE ${key}`);
  for (const key of ['associationVersion', 'serviceId', 'minimumCurrentA', 'maximumCurrentA', 'currentStepA', 'fallbackCurrentA', 'maxAgeMs', 'maxSkewMs', 'dwellMs', 'rampA'])
    if (!Number.isFinite(c2[key]) || c2[key] < (key === 'serviceId' || key === 'dwellMs' ? 0 : 1)) throw new Error(`Invalid EVSE ${key}`);
  if (c2.minimumCurrentA !== 6 || c2.currentStepA !== 1) throw new Error('The current EVSE profile requires a 6 A minimum and 1 A current step');
  if (!Number.isSafeInteger(c2.associationVersion) || !Number.isSafeInteger(c2.serviceId) || c2.serviceId !== 0
    || c2.minimumCurrentA < 6 || c2.maximumCurrentA < c2.minimumCurrentA || c2.maximumCurrentA > 16
    || c2.fallbackCurrentA > c2.maximumCurrentA || c2.currentStepA > c2.maximumCurrentA || c2.rampA > c2.maximumCurrentA || c2.rampA < c2.currentStepA
    || c2.maxAgeMs > 60000 || c2.maxSkewMs > c2.maxAgeMs || c2.dwellMs > 300000) throw new Error('Invalid EVSE current or timing limits');
  for (const key of ['mainFuseA', 'marginA']) if (!Array.isArray(c2[key]) || c2[key].length !== 3 || c2[key].some(v => !Number.isFinite(v) || v < 0 || v > 200)) throw new Error(`Invalid EVSE ${key}`);
  if (c2.mainFuseA.some((v, p) => v <= c2.marginA[p])) throw new Error('EVSE margin must be below each main fuse');
  if (!Array.isArray(c2.phaseMap) || [...c2.phaseMap].sort().join(',') !== '0,1,2') throw new Error('EVSE phase map must be a permutation');
  const states = new Set();
  for (const key of ['connectedStates', 'disconnectedStates', 'chargingStates']) {
    if (!Array.isArray(c2[key]) || c2[key].length > 32 || c2[key].some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v))) throw new Error(`Invalid EVSE ${key}`);
    for (const value of c2[key]) { if (states.has(value)) throw new Error('EVSE working-state mappings must be disjoint'); states.add(value); }
  }
  if (c2.enabled && (!c2.topicPrefix || !c2.deviceId)) throw new Error('An enabled EVSE needs a device identity and topic');
  if (c2.verified && (!c2.model || !c2.firmware || !c2.disconnectedStates.length || !c2.chargingStates.length || !c2.connectedStates.length)) throw new Error('EVSE commissioning requires model, firmware and verified state semantics');
  strict(input.vehicles ?? {}, ['bmw', 'tesla'], 'vehicles');
  const vehicles = {};
  for (const [id, defaults] of Object.entries(DEFAULT_CHARGING_CONFIGURATION.vehicles)) {
    const supplied = input.vehicles?.[id] ?? {};
    strict(supplied, Object.keys(defaults), `${id} vehicle configuration`);
    const vehicle = { ...defaults, ...supplied,
      defaults: chargingDefaults({ ...defaults.defaults, ...chargingDefaults(supplied.defaults, { partial: true }) }, { partial: true }) };
    if (typeof vehicle.label !== 'string' || !vehicle.label.trim() || vehicle.label.length > 80
      || vehicle.provider !== defaults.provider) throw new Error(`Invalid ${id} vehicle configuration`);
    if (id === 'bmw') {
      if (!topic(vehicle.mqttTopic)) throw new Error('Invalid BMW vehicle configuration');
      if (vehicle.mqttTopic === '') vehicle.mqttTopic = null;
    }
    vehicles[id] = vehicle;
  }
  return { defaults: generalDefaults, chargers: { charger1: c1, charger2: c2 }, vehicles };
}
