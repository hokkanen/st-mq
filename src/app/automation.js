import { createHash, randomUUID } from 'node:crypto';
import { equipmentSignature } from '../acquisition/equipment-config.js';
import { mqttSourceIdentity } from '../pairing/mqtt-source-context.js';

const FEATURES = ['home'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Permissions belong to the configured equipment, never to a global operating
// mode. Broker/account changes also select a new physical command destination.
export function heatingAutomationIdentity(config, feature) {
  const source = mqttSourceIdentity(config, 'primary');
  const broker = { address: source.address ?? null, user: source.username ?? null };
  if (feature !== 'home') throw new Error('Unknown heating feature.');
  return digest({ input: config.input, broker, native: config.deviceId ?? config.h66?.deviceId ?? null,
    tariff: (config.connections?.equipment?.devices ?? []).filter(device => device.enabled !== false && device.controlsHeat)
      .map(device => ({ id: device.id, signature: equipmentSignature(device) })).sort((a, b) => a.id.localeCompare(b.id)),
    floor: config.floorPreheat?.enabled ? config.floorPreheat.devices : null });
}

export function validateHeatingAutomationState(saved) {
  if (saved != null && (!object(saved) || Object.keys(saved).sort().join(',') !== 'features,version'
      || saved.version !== 3 || !object(saved.features) || Object.keys(saved.features).sort().join(',') !== 'home'
      || FEATURES.some(feature => {
        const row = saved.features[feature];
        return !object(row) || Object.keys(row).sort().join(',') !== 'enabled,identity,pause,revision,targetIdentity'
          || typeof row.enabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(row.identity)
          || row.targetIdentity !== null && !/^[a-f0-9]{64}$/.test(row.targetIdentity)
          || row.enabled && row.targetIdentity === null
          || (row.enabled ? row.pause !== null : !object(row.pause)
            || Object.keys(row.pause).sort().join(',') !== 'createdAt,expiresAt,id'
            || typeof row.pause.id !== 'string' || !row.pause.id
            || !Number.isFinite(row.pause.createdAt)
            || row.pause.expiresAt !== null && (!Number.isFinite(row.pause.expiresAt)
              || row.pause.expiresAt <= row.pause.createdAt || row.targetIdentity === null))
          || !Number.isSafeInteger(row.revision) || row.revision < 0;
      }))) throw new Error('Unsupported saved heating automation controls; start a fresh development database.');
  return saved;
}

export class HeatingAutomation {
  constructor({ store, config, targetIdentity = () => null, clock = Date.now }) {
    this.store = store;
    this.targetIdentity = targetIdentity;
    this.clock = clock;
    this.key = `automation:${config.input}`;
    const saved = validateHeatingAutomationState(store.getState(this.key));
    this.features = Object.fromEntries(FEATURES.map(feature => {
      const identity = heatingAutomationIdentity(config, feature), previous = saved?.features[feature];
      return [feature, previous?.identity === identity ? previous : { identity, enabled: false, revision: 0, targetIdentity: null,
        pause: { id: randomUUID(), createdAt: clock(), expiresAt: null } }];
    }));
  }
  save() { this.store.setState(this.key, { version: 3, features: this.features }); }
  set(feature, enabled, { pauseUntil = null, now = this.clock(), targetIdentity: savedTarget, replacePause = false } = {}) {
    const prior = this.features[feature];
    if (!prior || typeof enabled !== 'boolean') throw new Error('Invalid heating automation permission.');
    const targetIdentity = savedTarget ?? this.targetIdentity(feature);
    if ((enabled || pauseUntil !== null) && !/^[a-f0-9]{64}$/.test(targetIdentity)) throw new Error('Wait for a current heating equipment identity before enabling or scheduling Automatic heating.');
    if (pauseUntil !== null && (!Number.isFinite(pauseUntil) || pauseUntil <= now || pauseUntil - now > 366 * 86_400_000))
      throw new Error('Choose a future pause end within the next 366 days.');
    const features = { ...this.features, [feature]: { ...prior, enabled, revision: prior.revision + 1,
      targetIdentity: targetIdentity ?? prior.targetIdentity,
      pause: enabled ? null : { ...(!replacePause && prior.pause || { id: randomUUID(), createdAt: now }), expiresAt: pauseUntil } } };
    this.store.setState(this.key, { version: 3, features });
    this.features = features;
  }
  reconcileTargets() {
    for (const feature of FEATURES) {
      const saved = this.features[feature], current = this.targetIdentity(feature);
      if (saved.targetIdentity && current && current !== saved.targetIdentity) {
        this.set(feature, false, { replacePause: true });
      }
    }
  }
}
