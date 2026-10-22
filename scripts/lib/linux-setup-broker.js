import mqtt from 'mqtt';
import { randomBytes, randomUUID } from 'node:crypto';
import { DeploymentSafetyError } from './paired-deployment.js';

const messages = {
  invalid_configuration: 'MQTT setup requires a valid broker origin and separate file-supplied credentials.',
  authentication_failed: 'The MQTT broker rejected authentication. Correct the complete private configuration before retrying.',
  unavailable: 'The configured MQTT broker did not accept a connection. Check the private configuration and broker availability.',
  cancelled: 'MQTT setup verification was cancelled.',
};
export class BrokerProbeError extends DeploymentSafetyError {
  constructor(code, { endpointState = 'unknown' } = {}) {
    super(messages[code] ?? messages.unavailable); this.code = Object.hasOwn(messages, code) ? code : 'unavailable';
    this.endpointState = ['refused', 'responded'].includes(endpointState) ? endpointState : 'unknown';
  }
}

export function brokerOrigin(address) {
  let origin; try { origin = new URL(address); } catch { throw new BrokerProbeError('invalid_configuration'); }
  if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(origin.protocol) || !origin.hostname || origin.username || origin.password || origin.search || origin.hash
    || ['mqtt:', 'mqtts:'].includes(origin.protocol) && !['', '/'].includes(origin.pathname)) throw new BrokerProbeError('invalid_configuration');
  return origin;
}

export function canProvisionBroker(address, status) {
  const origin = brokerOrigin(address), host = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const standardLoopback = origin.protocol === 'mqtt:' && ['127.0.0.1', 'localhost'].includes(host) && (!origin.port || origin.port === '1883');
  return standardLoopback && (status?.installed === false || status?.managed === true || status?.stock === true && status?.active === false);
}

export function newBrokerCredentials(connection = {}, { random = randomBytes } = {}) {
  return { user: connection.user || 'st-mq', password: connection.pw || random(32).toString('hex') };
}

export function linuxHAMqttRoute({ sourceOptions, existingRoute, peerUrl, brokerPort, newCredentials } = {}) {
  if (existingRoute?.address) return structuredClone(existingRoute);
  const failure = () => new DeploymentSafetyError('HA configuration import needs an explicit Linux mqtt.ha address and credentials in the complete private draft. Automatic routing supports the standard internal HA MQTT broker with a known fixed host port; other origins, TLS and disabled ports require file review.');
  const source = sourceOptions?.mqtt;
  let origin, peer;
  try { origin = brokerOrigin(source?.ha?.address || source?.address); peer = new URL(peerUrl); } catch { throw failure(); }
  if (origin.protocol !== 'mqtt:' || origin.hostname !== 'core-mosquitto' || !['', '1883'].includes(origin.port)
    || !Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535 || brokerPort === 1883
    || peer.protocol !== 'http:' || peer.username || peer.password || peer.pathname !== '/' || peer.hash || peer.search) throw failure();
  const credentials = newCredentials ?? (source.ha?.address ? source.ha : source);
  return { address: 'mqtt://' + peer.hostname + ':' + brokerPort, user: credentials.user || '', pw: credentials.password ?? credentials.pw ?? '' };
}

/** Authenticate one ephemeral, clean MQTT connection. No subscriptions,
 * publications, will, retained state or reconnect loop are created. */
export async function probeMQTTBroker(connection, { connect = mqtt.connect, timeoutMs = 5000, signal } = {}) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new BrokerProbeError('invalid_configuration');
  brokerOrigin(connection.address);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || ['user', 'pw'].some(key => connection[key] !== undefined && typeof connection[key] !== 'string')
    || connection.pw && !connection.user) throw new BrokerProbeError('invalid_configuration');
  if (signal?.aborted) throw new BrokerProbeError('cancelled');
  return new Promise((resolve, reject) => {
    let client, settled = false, timer;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (client) {
        // Force-close also bounds incomplete TLS/WebSocket handshakes. A clean
        // client has no durable session; no queued action needs delivery.
        try { client.end(true); } catch { /* Never expose raw transport details. */ }
      }
      error ? reject(error) : resolve({ authenticated: true });
    };
    const abort = () => finish(new BrokerProbeError('cancelled'));
    timer = setTimeout(() => finish(new BrokerProbeError('unavailable')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      client = connect(connection.address, {
        protocolVersion: 4, clean: true, clientId: 'st-mq-setup-' + randomUUID(), keepalive: 0,
        reconnectPeriod: 0, connectTimeout: timeoutMs, resubscribe: false, queueQoSZero: false,
        ...(connection.user ? { username: connection.user } : {}), ...(connection.pw ? { password: connection.pw } : {}),
      });
      client.once('connect', () => finish());
      client.on('error', error => finish(new BrokerProbeError([4, 5, 0x86, 0x87].includes(error?.code) ? 'authentication_failed' : 'unavailable',
        { endpointState: error?.code === 'ECONNREFUSED' ? 'refused' : [1, 2, 3, 4, 5, 0x86, 0x87].includes(error?.code) ? 'responded' : 'unknown' })));
      client.once('close', () => finish(new BrokerProbeError('unavailable')));
      if (signal?.aborted) abort();
    } catch { finish(new BrokerProbeError('unavailable')); }
  });
}

export async function verifySetupBrokers(config, { probe = probeMQTTBroker, signal, skipPrimary = false, skipHA = false } = {}) {
  if (!['mqtt', 'providers'].includes(config.input)) return;
  const primary = config.connections?.mqtt;
  if (!primary?.address) return;
  if (!skipPrimary) await probe(primary, { signal });
  if (!skipHA && primary.ha?.address) await probe(primary.ha, { signal });
}
