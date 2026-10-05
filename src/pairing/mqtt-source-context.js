import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { durableJson } from '../replication/publication.js';
import { pairError } from './state.js';

export const MQTT_SOURCE_CONTEXT_KEY = 'pair:mqtt-source-context';
const SOURCE_CONTRACT = 'primary-and-ha-teslamate-bmw-garage-doors-tuya-v1';
const identities = new WeakMap();
const digestPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = () => pairError('mqtt_source_context_invalid');
const actualIdentity = connection => ({ address: connection?.address, username: connection?.user });
const actualIdentities = config => ({ primary: actualIdentity(config.connections?.mqtt),
  ha: actualIdentity(config.connections?.mqtt?.ha?.address ? config.connections.mqtt.ha : config.connections?.mqtt) });

/** Source identity is distinct from this runtime's actual transport endpoint.
 * Only a verified current pair binding may attach an inherited identity. */
export function mqttSourceIdentity(config, source = 'primary') {
  if (!['primary', 'ha'].includes(source)) throw fail();
  const selected = identities.get(config)?.[source] ?? actualIdentities(config)[source];
  // Preserve the established address/username shape and property order. An
  // omitted username remains omitted by JSON serialization, never defaulted.
  return { address: selected.address, username: selected.username };
}

function pairIdentity(config) { return digest([config.pair?.pairId, config.pair?.token]); }
function sourceContract(config) {
  // These are effective, current integration definitions. Machine endpoints,
  // credentials, storage paths, port bindings and configuration defaults for
  // economic requests do not identify the physical inputs or command routes.
  const charging = config.charging ?? {};
  const devices = config.connections?.equipment ?? {};
  const easee = config.connections?.easee ?? {};
  return digest({ input: config.input, deviceId: config.deviceId ?? config.h66?.deviceId ?? null,
    equipment: devices, teslamate: config.connections?.teslamate ?? null,
    vehicles: Object.fromEntries(Object.entries(charging.vehicles ?? {}).map(([id, value]) => [id,
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'defaults'))])),
    chargers: charging.chargers ?? {},
    easee: { charger_id: easee.charger_id, equalizer_id: easee.equalizer_id },
    garage: { adapter: config.garage?.adapter, sender: config.garage?.sender },
    dhwr: config.connections?.mqtt?.dhwr_topic, floor: config.floorPreheat });
}
export const mqttSourceContract = sourceContract;
function routeDigest(config) {
  return digest({ sources: actualIdentities(config), secondary: Boolean(config.connections?.mqtt?.ha?.address),
    vip: config.pair?.vip?.address });
}
function seedDigest(seed) {
  const { configurationContract: _configurationContract, ...identitySeed } = seed;
  return digest(identitySeed);
}
function validIdentity(value) {
  return object(value) && Object.keys(value).every(key => ['address', 'username'].includes(key))
    && typeof value.address === 'string' && value.address.length > 0 && value.address.length <= 2048
    && (value.username === undefined || typeof value.username === 'string' && value.username.length <= 65535);
}
function validateSeed(value, config) {
  if (!keys(value, ['version', 'pair', 'sourceContract', 'identities', 'configurationContract']) || value.version !== 1
    || value.pair !== pairIdentity(config) || value.sourceContract !== SOURCE_CONTRACT
    || !digestPattern.test(value.configurationContract ?? '') || !keys(value.identities, ['primary', 'ha'])
    || !validIdentity(value.identities.primary) || !validIdentity(value.identities.ha)) throw fail();
  return value;
}
function requirementsFor(seed) {
  return { version: 1, pair: seed.pair, seedDigest: seedDigest(seed), contract: seed.configurationContract };
}
function validateRequirements(value, config) {
  if (!keys(value, ['version', 'pair', 'seedDigest', 'contract']) || value.version !== 1
    || value.pair !== pairIdentity(config) || !digestPattern.test(value.seedDigest ?? '')
    || value.contract !== sourceContract(config)) throw fail();
  return value;
}
function readJson(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_384) throw fail();
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function snapshotSeed(dbPath, config) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(MQTT_SOURCE_CONTEXT_KEY);
    return validateSeed(row ? JSON.parse(row.value) : null, config);
  } catch { throw fail(); }
  finally { db?.close(); }
}

/** The mirrored record contains source context, never command authority. The
 * separate local pin proves which actual route was explicitly bound here. */
export function createMqttSourceContext({ configuration, directory }) {
  const path = join(directory, 'mqtt-source-context.json');
  let active = null, lock = Promise.resolve();
  const serialized = work => { const result = lock.then(work); lock = result.catch(() => {}); return result; };
  function readPins(config) {
    const value = readJson(path);
    if (value === undefined) return { version: 1, pair: pairIdentity(config), binding: null, pending: null };
    if (!keys(value, ['version', 'pair', 'binding', 'pending']) || value.version !== 1 || value.pair !== pairIdentity(config)) throw fail();
    if (value.binding !== null && (!keys(value.binding, ['seedDigest', 'routeDigest', 'token', 'contract'])
      || value.binding.token !== null && !tokenPattern.test(value.binding.token ?? '')
      || ![value.binding.seedDigest, value.binding.routeDigest, value.binding.contract].every(item => digestPattern.test(item ?? '')))) throw fail();
    const pending = value.pending;
    if (pending !== null && (!keys(pending, ['kind', 'token', 'seedDigest', 'routeDigest', 'contract'])
      || !['initialize', 'handover'].includes(pending.kind)
      || (pending.kind === 'initialize' ? pending.token !== null : !tokenPattern.test(pending.token ?? ''))
      || ![pending.seedDigest, pending.routeDigest, pending.contract].every(item => digestPattern.test(item ?? '')))) throw fail();
    return value;
  }
  async function savePins(value) {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail();
      await durableJson(path, value);
    } catch { throw fail(); }
  }
  function checkedSnapshot({ dbPath, requirements, token }) {
    const config = configuration();
    validateRequirements(requirements, config);
    if (!tokenPattern.test(token ?? '')) throw fail();
    const seed = snapshotSeed(dbPath, config), pins = readPins(config), witness = pins.pending ?? pins.binding;
    if (digest(requirementsFor(seed)) !== digest(requirements)
      || pins.pending && pins.pending.kind !== 'handover' || witness?.token !== token
      || witness.seedDigest !== requirements.seedDigest || witness.contract !== requirements.contract
      || witness.routeDigest !== routeDigest(config)) throw fail();
    return { seed, pins, config };
  }
  return {
    async activate(config, store, { allowSeed = false } = {}) {
      return serialized(async () => {
        if (config.topology !== 'pair') throw fail();
        const pins = readPins(config), route = routeDigest(config);
        let seed;
        try {
          seed = store.getState(MQTT_SOURCE_CONTEXT_KEY);
          if (seed == null && store.db?.prepare('SELECT 1 AS present FROM state WHERE key = ?').get(MQTT_SOURCE_CONTEXT_KEY)) throw fail();
        } catch { throw fail(); }
        if (seed === null || seed === undefined) {
          if (!allowSeed || pins.binding || pins.pending && pins.pending.kind !== 'initialize') throw fail();
          seed = { version: 1, pair: pairIdentity(config), sourceContract: SOURCE_CONTRACT,
            identities: actualIdentities(config), configurationContract: sourceContract(config) };
          validateSeed(seed, config);
          const pending = { kind: 'initialize', token: null, seedDigest: seedDigest(seed), routeDigest: route,
            contract: seed.configurationContract };
          if (pins.pending && digest(pins.pending) !== digest(pending)) throw fail();
          pins.pending = pending;
          await savePins(pins);
          // This writes only genuinely absent current context. It does not scan,
          // rewrite or translate any existing equipment or evidence state.
          store.setState(MQTT_SOURCE_CONTEXT_KEY, seed);
        } else validateSeed(seed, config);
        const fingerprint = seedDigest(seed);
        if (allowSeed && pins.pending?.kind === 'initialize' && pins.pending.seedDigest === fingerprint
          && pins.pending.routeDigest === route && pins.pending.contract === sourceContract(config)) {
          pins.binding = { seedDigest: fingerprint, routeDigest: route, token: null, contract: seed.configurationContract }; pins.pending = null;
          await savePins(pins);
        }
        if (pins.binding?.seedDigest !== fingerprint || pins.binding.routeDigest !== route) throw fail();
        // Current equipment edits still establish their own native identity
        // boundaries. Mirror their current definitions for the next promotion.
        const contract = sourceContract(config);
        if (seed.configurationContract !== contract) {
          seed = { ...seed, configurationContract: contract };
          store.setState(MQTT_SOURCE_CONTEXT_KEY, seed);
        }
        identities.set(config, structuredClone(seed.identities));
        active = { seedDigest: fingerprint, routeDigest: route };
      });
    },
    requirements(store) {
      const config = configuration();
      let seed;
      try { seed = validateSeed(store?.getState(MQTT_SOURCE_CONTEXT_KEY), config); } catch { throw fail(); }
      if (!active || active.seedDigest !== seedDigest(seed) || active.routeDigest !== routeDigest(config)
        || seed.configurationContract !== sourceContract(config)) throw fail();
      return requirementsFor(seed);
    },
    prepare({ requirements, token }) {
      return serialized(async () => {
        const config = configuration(); validateRequirements(requirements, config);
        if (!tokenPattern.test(token ?? '')) throw fail();
        const pins = readPins(config);
        pins.pending = { kind: 'handover', token, seedDigest: requirements.seedDigest,
          routeDigest: routeDigest(config), contract: requirements.contract };
        await savePins(pins);
      });
    },
    verify(args) { checkedSnapshot(args); },
    authorize(args) {
      return serialized(async () => {
        const { pins, config } = checkedSnapshot(args);
        pins.binding = { seedDigest: args.requirements.seedDigest, routeDigest: routeDigest(config),
          token: args.token, contract: args.requirements.contract };
        pins.pending = null;
        await savePins(pins);
      });
    },
    authorizePromotion({ dbPath }) {
      return serialized(async () => {
        const config = configuration(), seed = snapshotSeed(dbPath, config);
        validateRequirements(requirementsFor(seed), config);
        const pins = readPins(config);
        pins.binding = { seedDigest: seedDigest(seed), routeDigest: routeDigest(config), token: null,
          contract: seed.configurationContract }; pins.pending = null;
        await savePins(pins);
      });
    },
  };
}
