import { resolve, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { lookup } from 'node:dns/promises';

const invalid = name => new Error(`Invalid pair setting: ${name}`);

/** Private, machine-local settings. None of these enter the mirrored database. */
export function pairConfiguration(input = {}, env = {}, config = {}) {
  if (Object.hasOwn(input, 'enabled') || Object.hasOwn(env, 'STMQ_PAIR_ENABLED'))
    throw new Error('Pair enable flags are retired; select controller.topology / STMQ_TOPOLOGY instead.');
  if (Object.hasOwn(input, 'role'))
    throw new Error('pair.role is unsupported; use manual promotion and handover to change pair roles.');
  if (config.topology !== 'pair') return {};
  const text = (value, name) => {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(name);
    return value;
  };
  const number = (value, fallback, min, max, name) => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw invalid(name);
    return result;
  };
  const directory = resolve(text(env.STMQ_PAIR_DIR ?? (input.directory || resolve(config.dataDir ?? '.', 'pairing')), 'directory'));
  const settings = {
    directory,
    snapshotDirectory: resolve(text(env.STMQ_PAIR_SNAPSHOT_DIR
      ?? (input.snapshot_directory || resolve(config.databaseDir ?? '.', 'pair-snapshots')), 'snapshot_directory')),
    databasePath: config.dbPath, sourceDirectory: resolve(directory, 'work'),
    platform: config.addon ? 'hassio' : 'ubuntu',
    scope: 'from_stmq/heat/action',
    pairId: text(env.STMQ_PAIR_ID ?? input.pair_id ?? '', 'pair_id'),
    token: text(env.STMQ_PAIR_TOKEN ?? input.token ?? '', 'token'),
    peerUrl: text(env.STMQ_PAIR_PEER_URL ?? input.peer_url ?? '', 'peer_url'),
    listenHost: text(env.STMQ_PAIR_HOST ?? input.listen_host ?? '0.0.0.0', 'listen_host'),
    port: number(env.STMQ_PAIR_PORT ?? input.port, 1244, 1, 65535, 'port'),
    intervalMs: number(env.STMQ_PAIR_INTERVAL_SECONDS ?? input.interval_seconds, 60, 10, 86400, 'interval_seconds') * 1000,
    timeoutMs: number(env.STMQ_PAIR_TIMEOUT_SECONDS ?? input.timeout_seconds, 3600, 30, 86400, 'timeout_seconds') * 1000,
    staleAfterMs: number(env.STMQ_PAIR_STALE_SECONDS ?? input.stale_seconds, 180, 30, 604800, 'stale_seconds') * 1000,
    vip: {
      interface: text(env.STMQ_PAIR_VIP_INTERFACE ?? input.vip_interface ?? '', 'vip_interface'),
      address: text(env.STMQ_PAIR_VIP_ADDRESS ?? input.vip_address ?? '', 'vip_address'),
      prefixLength: number(env.STMQ_PAIR_VIP_PREFIX ?? input.vip_prefix, 24, 1, 30, 'vip_prefix'),
      helperPath: text(env.STMQ_PAIR_VIP_HELPER ?? input.vip_helper ?? '/usr/local/bin/st-mq-vip', 'vip_helper'),
      socketPath: text(env.STMQ_PAIR_VIP_SOCKET ?? (input.vip_socket || (config.addon ? '' : '/run/st-mq-vip/socket')), 'vip_socket'),
    },
    mqtt: config.connections?.mqtt,
  };
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(settings.pairId)) throw invalid('pair_id');
  if (settings.token.length < 32) throw new Error('Pair mode requires a shared private token of at least 32 characters');
  let peer;
  try { peer = new URL(settings.peerUrl); } catch { throw invalid('peer_url'); }
  if (peer.protocol !== 'http:' || peer.username || peer.password || peer.pathname !== '/' || peer.search || peer.hash)
    throw new Error('Pair peer_url must be an HTTP origin using the other machine’s fixed address');
  if (!settings.listenHost || /[\s/]/.test(settings.listenHost)) throw invalid('listen_host');
  if (settings.port === config.port || config.addon && settings.port === config.ingressPort) throw invalid('port');
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(settings.vip.interface) || settings.vip.interface.startsWith('-')) throw invalid('vip_interface');
  if (isIP(settings.vip.address) !== 4 || /^(0|127|22[4-9]|23\d|24\d|25[0-5])\./.test(settings.vip.address)) throw invalid('vip_address');
  if (!isAbsolute(settings.vip.helperPath)) throw invalid('vip_helper');
  if (settings.vip.socketPath && !isAbsolute(settings.vip.socketPath)) throw invalid('vip_socket');
  if (peer.hostname === settings.vip.address) throw new Error('Pair peers must use fixed addresses, not the virtual IP');
  if (!['mqtt', 'providers'].includes(config.input) || !settings.mqtt?.address)
    throw new Error('Paired controllers require live input and a local MQTT broker on each machine');
  if (directory === settings.snapshotDirectory || directory === resolve(config.databaseDir)) throw invalid('directory');
  if (settings.snapshotDirectory === resolve(config.databaseDir)) throw invalid('snapshot_directory');
  return settings;
}

/** Resolve once before opening a controlling runtime; never trust a label alone. */
export async function requireLocalBroker(connection, { addon = false, resolveHost = lookup,
  interfaces = networkInterfaces, vipAddress } = {}) {
  const failure = (code, message) => Object.assign(new Error(message), { code });
  let broker;
  try { broker = new URL(connection?.address); } catch { throw failure('mqtt_local_required', 'A local MQTT broker address is required'); }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(broker.protocol) || broker.username || broker.password)
    throw failure('mqtt_local_required', 'Configure local MQTT credentials separately from its address');
  const hostname = broker.hostname.replace(/^\[|\]$/g, '');
  if (hostname === vipAddress) throw failure('mqtt_local_required', 'The controller must connect to its local broker; devices use the virtual IP');
  // Supervisor provisions this sibling add-on alias on the same HA host.
  if (addon && hostname === 'core-mosquitto') return;
  let addresses, timer;
  try { addresses = isIP(hostname) ? [{ address: hostname }] : await Promise.race([
    resolveHost(hostname, { all: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('resolution_timeout')), 5000); }),
  ]); }
  catch { throw failure('mqtt_resolution_failed', 'The configured local MQTT broker could not be resolved'); }
  finally { clearTimeout(timer); }
  if (addresses.some(value => value.address === vipAddress))
    throw failure('mqtt_local_required', 'The controller must connect to its local broker; devices use the virtual IP');
  const local = new Set(['127.0.0.1', '::1', ...Object.values(interfaces()).flat().filter(Boolean).map(value => value.address)]);
  if (!addresses.length || addresses.some(value => !local.has(value.address)))
    throw failure('mqtt_local_required', 'Paired control requires MQTT on this machine (loopback, a local interface, or the Home Assistant Mosquitto add-on)');
}
