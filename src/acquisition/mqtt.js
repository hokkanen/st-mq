import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { createH66Decoder } from '../domain/telemetry.js';
import { createH66Controller } from '../control/h66.js';

// Observations and the four permitted native-setting writes share this connection.
// Credentials and raw broker errors never enter event logs.
export async function startMqtt({ engine, store, config, connect = mqtt.connect }) {
  const settings = { ...(config.h66 ?? {}) };
  const intervalMs = settings.snapshotIntervalMs ?? 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new RangeError('H66 snapshot interval must be at least one second');
  const deviceId = settings.deviceId ?? config.deviceId;
  const verifiedRegisters = { ...(config.h66Verification ? JSON.parse(readFileSync(config.h66Verification, 'utf8')) : {}),
    ...(settings.verification ?? {}) };
  settings.verification = verifiedRegisters;
  const decoder = createH66Decoder({ deviceId, verifiedRegisters, maxAgeMs: settings.maxAgeMs,
    mqttScaleByRegister: settings.mqttScaleByRegister });
  const { address, user: username, pw: password } = config.connections.mqtt;
  const client = connect(address, { username, password, reconnectPeriod: 5000, clean: true, connectTimeout: 10_000, queueQoSZero: false });
  let connected = false, stopped = false, lastSnapshotRequestedAt = null, lastGatewayStatusAt = null;
  const pendingPublications = new Set();
  const lastErrorAt = new Map();
  const report = type => {
    const now = engine.clock();
    if (now - (lastErrorAt.get(type) ?? -Infinity) >= 60_000) {
      store.event(type, { source: 'husdata-h66' }, now); lastErrorAt.set(type, now);
    }
  };
  const publish = (topic, payload, options) => new Promise((resolve, reject) => {
    if (!connected || stopped) { reject(new Error('MQTT unavailable')); return; }
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); pendingPublications.delete(finish);
      if (error) reject(new Error('MQTT publication failed')); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('MQTT timeout')), settings.readbackTimeoutMs ?? 10_000);
    pendingPublications.add(finish);
    try { client.publish(topic, payload, options, finish); } catch { finish(new Error('MQTT publication failed')); }
  });
  const requestSnapshot = async () => {
    // GETALL republishes the gateway's known values. It cannot prove a new sensor measurement.
    lastSnapshotRequestedAt = engine.clock();
    await publish(`${deviceId}/HP/CMD`, 'GETALL', { qos: 0, retain: false });
  };
  const h66 = createH66Controller({ deviceId, publish, requestSnapshot, store, clock: () => engine.clock(), config: settings });
  const connectedHandler = () => {
    if (connected || stopped) return;
    connected = true; h66.setConnected(true);
    store.event('mqtt-connected', { source: 'husdata-h66', writesEnabled: settings.writeEnabled === true }, engine.clock());
    client.subscribe(`${deviceId}/HP/#`, { qos: 0 }, error => {
      if (error) { report('mqtt-subscribe-error'); return; }
      requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    });
  };
  client.on('connect', connectedHandler);
  client.on('error', () => report('mqtt-error'));
  const disconnected = () => {
    connected = false; h66.setConnected(false);
    for (const finish of [...pendingPublications]) finish(new Error('MQTT disconnected'));
    report('mqtt-offline');
  };
  client.on('offline', disconnected);
  client.on('close', disconnected);
  client.on('message', (topic, payload, packet = {}) => {
    try {
      if (topic.startsWith(`${deviceId}/HP/STATUS`) && !packet.retain) lastGatewayStatusAt = engine.clock();
      const decoded = decoder.decode({ topic, payload, receivedAt: engine.clock(), retained: packet.retain,
        dup: packet.dup, messageId: packet.messageId });
      if (!decoded || decoded.duplicate) return;
      h66.ingest(decoded);
      engine.ingest({ source: decoded.source, device: decoded.deviceId,
        signal: decoded.signal === 'integral' ? 'heating_integral' : decoded.signal,
        value: decoded.value, unit: decoded.unit ?? 'unknown', sourceTime: decoded.observedAt,
        receivedAt: decoded.receivedAt, quality: decoded.issues, raw: { register: decoded.register, value: decoded.raw,
          verified: Boolean(decoded.verification), verificationEvidence: decoded.verification,
          installationVerified: decoded.installationVerified,
          usableForControl: decoded.usableForControl, timeBasis: decoded.timeBasis,
          sensorMeasuredAt: decoded.sensorMeasuredAt, cached: decoded.cached,
          retained: decoded.retained, publicationMayUseGatewayCache: decoded.sourceAt == null,
          snapshotRequestedAt: lastSnapshotRequestedAt } });
    } catch { report('mqtt-observation-rejected'); }
  });
  const maintenance = setInterval(() => {
    if (!connected || stopped) return;
    requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    h66.reconcile({ now: engine.clock() }).catch(() => {});
  }, intervalMs);
  maintenance.unref?.();
  if (client.connected) connectedHandler();
  return { h66, status: () => ({ ...h66.status(), lastSnapshotRequestedAt, lastGatewayStatusAt }),
    setPhase: args => h66.setPhase(args), writeSettings: (...args) => h66.writeSettings(...args),
    restore: args => h66.restore(args), test: args => h66.test(args), requestSnapshot,
    close: async () => {
      if (stopped) return;
      clearInterval(maintenance);
      if (connected && settings.writeEnabled === true) {
        try { await h66.restore({ now: engine.clock(), reason: 'application-shutdown' }); }
        catch { report('h66-shutdown-restoration-pending'); }
      }
      stopped = true;
      for (const finish of [...pendingPublications]) finish(new Error('MQTT closed'));
      await h66.close();
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { client.stream?.destroy(); } catch {} resolve(); }, 1000);
        try { client.end(true, {}, () => { clearTimeout(timer); resolve(); }); }
        catch { clearTimeout(timer); resolve(); }
      });
    } };
}
