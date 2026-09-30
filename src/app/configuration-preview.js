import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

// Source values never become properties of the runtime configuration or status.
const snapshots = new WeakMap();
const schema = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8')).schema;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hidden = '[redacted]';
const stale = () => Object.assign(new Error('Configuration review expired or settings changed. Review the configuration again before applying.'), { statusCode: 409 });

export function rememberConfigurationOptions(config, options) { snapshots.set(config, structuredClone(options)); }
export function inheritConfigurationSnapshot(from, to) {
  if (snapshots.has(from)) snapshots.set(to, snapshots.get(from));
  return to;
}

// Environment settings have no file field for listening/storage overrides.
// Known file fields retain their actual names when an environment override wins.
const effectiveFields = [
  ['controller.input', c => c.input], ['controller.topology', c => c.topology],
  ['mirror.role', c => c.role], ['controller.web_token', c => c.token],
  ['controller.web_family_token', c => c.familyToken],
  ['controller.max_drop_c', c => c.settings?.comfort?.maxDropC],
  ['controller.h66_device', c => c.deviceId], ['controller.h66_verification_file', c => c.h66Verification],
  ...Object.entries({ directory: 'directory', ssh_host: 'sshHost', ssh_config: 'sshConfigPath', remote_directory: 'remoteDirectory',
    receiver_path: 'receiverPath', node_path: 'nodePath', rsync_path: 'rsyncPath', remote_rsync_path: 'remoteRsyncPath' })
    .map(([field, key]) => [`mirror.${field}`, c => c.mirror?.[key]]),
  ...Object.entries({ directory: 'directory', snapshot_directory: 'snapshotDirectory', pair_id: 'pairId', token: 'token',
    peer_url: 'peerUrl', listen_host: 'listenHost', port: 'port' }).map(([field, key]) => [`pair.${field}`, c => c.pair?.[key]]),
  ...['mirror', 'pair'].flatMap(section => Object.entries({ interval_seconds: 'intervalMs', timeout_seconds: 'timeoutMs', stale_seconds: 'staleAfterMs' })
    .map(([field, key]) => [`${section}.${field}`, c => c[section]?.[key] === undefined ? undefined : c[section][key] / 1000])),
  ...Object.entries({ vip_interface: 'interface', vip_address: 'address', vip_prefix: 'prefixLength', vip_helper: 'helperPath', vip_socket: 'socketPath' })
    .map(([field, key]) => [`pair.${field}`, c => c.pair?.vip?.[key]]),
  ['runtime.mirror.sourceDirectory', c => c.mirror?.sourceDirectory],
  ...['host', 'port', 'ingressHost', 'ingressPort', 'dataDir', 'databaseDir', 'dbPath', 'addon'].map(key => [`runtime.${key}`, c => c[key]]),
];
const startupKeys = ['topology', 'role', 'input', 'host', 'port', 'ingressHost', 'ingressPort', 'dataDir', 'databaseDir', 'dbPath', 'addon', 'mirror', 'pair'];
export function configurationRestartRequired(before, after) {
  return startupKeys.filter(key => !isDeepStrictEqual(before[key], after[key]));
}
const effectiveSnapshot = config => {
  const { configuration: _information, ...runtime } = config;
  return structuredClone(runtime);
};
function ruleAt(path) {
  let rule = schema;
  for (const part of path.split('.')) rule = Array.isArray(rule) ? rule[0] : rule?.[part];
  return rule;
}
function publicValue(value, rule, path) {
  // Numeric identifiers and locations remain private too. Only declared scalar
  // engineering values, switches and enumerations can appear in a review.
  if (/(?:^|\.)(?:geoloc|id|carId|serviceId|associationVersion|switch_id|temperature_id)(?:\.|$)/i.test(path)) return false;
  if (value === undefined || value === null) return true;
  if (typeof rule !== 'string') return false;
  if (typeof value === 'boolean') return /^bool\??$/.test(rule);
  if (typeof value === 'number') return /^(int|float)(?:\(|\?|$)/.test(rule) && Number.isFinite(value);
  return typeof value === 'string' && /^list\(/.test(rule) && rule.replace(/\?$/, '').slice(5, -1).split('|').includes(value);
}
function changesBetween(before, after, rule, path = '', changes = []) {
  if (isDeepStrictEqual(before, after)) return changes;
  if (object(rule) && (object(before) || object(after))) {
    // Iterate trusted schema labels only; even property names can contain private text.
    for (const key of Object.keys(rule)) changesBetween(before?.[key], after?.[key], rule[key], path ? `${path}.${key}` : key, changes);
    if ([before, after].some(value => object(value) && Object.keys(value).some(key => !Object.hasOwn(rule, key))))
      changes.push({ path: `${path ? `${path}.` : ''}[unsupported field]`, before: hidden, after: hidden, redacted: true });
  } else if (Array.isArray(rule) && (Array.isArray(before) || Array.isArray(after))) {
    for (let index = 0; index < Math.max(before?.length ?? 0, after?.length ?? 0); index++)
      changesBetween(before?.[index], after?.[index], rule[0], `${path}.${index}`, changes);
  } else {
    const redacted = !publicValue(before, rule, path) || !publicValue(after, rule, path);
    changes.push({ path, before: before == null ? null : redacted ? hidden : before,
      after: after == null ? null : redacted ? hidden : after, redacted });
  }
  return changes;
}
function sourceValue(options, path) { return path.split('.').reduce((value, key) => value?.[key], options); }

export function configurationValidationMessage(error) {
  if (error?.code || typeof error?.message !== 'string') return 'Check the configuration source.';
  // File and parser errors must never expose a path, JSON fragment or value.
  if (/^(?:ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|Unexpected token)/.test(error.message)) return 'Check the configuration source.';
  // Source validators use trusted schema paths and conceal unknown field names.
  return error.message;
}

export function createConfigurationReviews({ clock = Date.now, ttlMs = 300_000, limit = 8 } = {}) {
  const reviews = new Map();
  const prune = () => { for (const [id, value] of reviews) if (value.expires <= clock()) reviews.delete(id); };
  return {
    preview(baseline, candidate, imported = false) {
      prune();
      const before = snapshots.get(baseline), after = snapshots.get(candidate);
      const changes = before && after ? changesBetween(before, after, schema) : [];
      for (const [path, read] of effectiveFields) {
        const sourceChanged = changes.some(change => change.path === path);
        const matchesSource = before && after && isDeepStrictEqual(sourceValue(before, path), read(baseline))
          && isDeepStrictEqual(sourceValue(after, path), read(candidate));
        if (sourceChanged && matchesSource || !sourceChanged && isDeepStrictEqual(read(baseline), read(candidate))) continue;
        const rule = ruleAt(path), redacted = !publicValue(read(baseline), rule, path) || !publicValue(read(candidate), rule, path);
        changes.push({ path: `${before && after ? 'effective.' : ''}${path}`,
          before: read(baseline) == null ? null : redacted ? hidden : read(baseline),
          after: read(candidate) == null ? null : redacted ? hidden : read(candidate), redacted });
      }
      // Injected configurations have no trusted source fields; report any other
      // effective differences as a concealed row instead of exposing arbitrary keys.
      if ((!before || !after) && !isDeepStrictEqual(effectiveSnapshot(baseline), effectiveSnapshot(candidate)))
        changes.push({ path: 'runtime.settings', before: hidden, after: hidden, redacted: true });
      const restartRequired = configurationRestartRequired(baseline, candidate);
      const reviewId = randomUUID();
      while (reviews.size >= limit) reviews.delete(reviews.keys().next().value);
      reviews.set(reviewId, { baseline, current: effectiveSnapshot(baseline), next: effectiveSnapshot(candidate),
        options: structuredClone(after), imported, expires: clock() + ttlMs });
      return { reviewId, valid: true, canApply: restartRequired.length === 0, changes, restartRequired, imported };
    },
    consume(reviewId, baseline, candidate, imported = false) {
      prune();
      const review = reviews.get(reviewId);
      reviews.delete(reviewId);
      if (!review || review.baseline !== baseline || !isDeepStrictEqual(review.current, effectiveSnapshot(baseline))
        || !isDeepStrictEqual(review.next, effectiveSnapshot(candidate)) || !isDeepStrictEqual(review.options, snapshots.get(candidate))
        || review.imported !== imported) throw stale();
    },
    clear() { reviews.clear(); },
  };
}
