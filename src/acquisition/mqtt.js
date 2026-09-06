import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { createH66Decoder } from '../domain/telemetry.js';

// Only subscribed observations cross this boundary. No physical command transport
// exists here. Credentials and raw broker error messages never enter event logs.
export async function startMqtt({ engine, store, config, connect = mqtt.connect }) {
  const verifiedRegisters = config.h66Verification ? JSON.parse(readFileSync(config.h66Verification, 'utf8')) : {};
  const decoder = createH66Decoder({ deviceId: config.deviceId, verifiedRegisters });
  const { address, user: username, pw: password } = config.connections.mqtt;
  const client = connect(address, { username, password, reconnectPeriod: 5000, clean: true, connectTimeout: 10_000, queueQoSZero: false });
  let lastErrorAt = -Infinity;
  const report = type => {
    const now = engine.clock();
    if (now - lastErrorAt >= 60_000) { store.event(type, { source: 'husdata-h66' }, now); lastErrorAt = now; }
  };
  client.on('connect', () => {
    store.event('mqtt-connected', { device: config.deviceId, readOnly: true }, engine.clock());
    client.subscribe(decoder.subscriptionTopic, { qos: 1 }, error => { if (error) report('mqtt-subscribe-error'); });
  });
  client.on('error', () => report('mqtt-error'));
  client.on('offline', () => report('mqtt-offline'));
  client.on('message', (topic, payload, packet = {}) => {
    try {
      const decoded = decoder.decode({ topic, payload, receivedAt: engine.clock(), retained: packet.retain,
        dup: packet.dup, messageId: packet.messageId });
      if (!decoded || decoded.duplicate) return;
      engine.ingest({ source: decoded.source, device: decoded.deviceId,
        signal: decoded.signal === 'integral' ? 'heating_integral' : decoded.signal,
        value: decoded.value, unit: decoded.unit ?? 'unknown', sourceTime: decoded.sourceAt,
        receivedAt: decoded.receivedAt, quality: decoded.issues, raw: { register: decoded.register, value: decoded.raw,
          verified: decoded.verification, usableForControl: decoded.usableForControl } });
    } catch { report('mqtt-observation-rejected'); }
  });
  return { close: () => new Promise(resolve => client.end(true, {}, resolve)) };
}
