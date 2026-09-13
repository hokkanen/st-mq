import { decodeMqttTemperature } from './mqtt-temperature.js';
import { createShellyCapture } from './shelly.js';
import { createEquipmentCapture } from './equipment.js';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { createH66Decoder, H66_REGISTERS } from '../domain/telemetry.js';
import { createH66Controller } from '../control/h66.js';
import { createTeslaMateCapture } from './teslamate.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';

export { decodeMqttTemperature } from './mqtt-temperature.js';

// Observations and the four permitted native-setting writes share this connection.
// Credentials and raw broker errors never enter event logs.
export async function startMqtt({ engine, store, config, connect = mqtt.connect, canControl = () => true,
  reportStorageFailure = diagnostic => process.stderr.write(`${JSON.stringify(diagnostic)}\n`) }) {
  const settings = { ...(config.h66 ?? {}) };
  const intervalMs = settings.snapshotIntervalMs ?? 60_000;
  const deviceId = settings.deviceId ?? config.deviceId;
  let decoder = null;
  if (deviceId) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) throw new RangeError('H66 snapshot interval must be at least one second');
    const verifiedRegisters = { ...(config.h66Verification ? JSON.parse(readFileSync(config.h66Verification, 'utf8')) : {}),
      ...(settings.verification ?? {}) };
    settings.verification = verifiedRegisters;
    decoder = createH66Decoder({ deviceId, verifiedRegisters, maxAgeMs: settings.maxAgeMs,
      mqttScaleByRegister: settings.mqttScaleByRegister });
  }
  const { address, user: username, pw: password } = config.connections.mqtt;
  const equipmentSettings = config.connections.equipment?.devices?.length === 0 && config.connections.shelly?.devices?.length
    ? null : config.connections.equipment;
  const equipmentOwnedSignals = equipmentSettings?.ownedSignals ?? [];
  const directGarage = equipmentSettings ? equipmentSettings.ownsGarage : config.connections.shelly?.devices?.some(device => device.role === 'garage');
  const temperatureTopics = Object.entries(config.connections.mqtt.temperatureTopics ?? {})
    .filter(([signal, topic]) => ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'outdoor_temperature'].includes(signal)
      && typeof topic === 'string' && topic.length > 0 && !/[+#\u0000]/.test(topic))
    .map(([signal, topic]) => [directGarage && signal === 'garage_temperature' ? 'garage_temperature_ha' : signal, topic])
    .filter(([signal]) => !equipmentOwnedSignals.includes(signal));
  for (const [signal] of temperatureTopics) if (INDOOR_SIGNALS.includes(signal))
    engine.configureTemperatureReports?.(signal, {
      reportIntervalMs: config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
      reportGraceMs: config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS,
    });
  const teslamate = config.connections.teslamate?.enabled === true
    ? createTeslaMateCapture({ engine, store, settings: config.connections.teslamate }) : null;
  if (teslamate) engine.teslamate = teslamate;
  const client = connect(address, { username, password, reconnectPeriod: 5000, clean: true, connectTimeout: 10_000, queueQoSZero: false });
  let connected = false, stopped = false, disconnectedRecorded = false, lastSnapshotRequestedAt = null, lastGatewayStatusAt = null;
  const source = decoder ? 'husdata-h66' : teslamate ? 'teslamate' : 'mqtt-temperature';
  const h66Signals = decoder ? Object.values(H66_REGISTERS).map(({ signal, unit }) => ({
    source: 'husdata-h66', device: deviceId, signal: signal === 'integral' ? 'heating_integral' : signal, unit,
  })).filter(row => !(directGarage && row.signal === 'garage_temperature') && !temperatureTopics.some(([signal]) => signal === row.signal) && !equipmentOwnedSignals.includes(row.signal)) : [];
  const temperatureSignals = temperatureTopics.map(([signal]) => ({
    source: signal === 'garage_temperature_ha' ? 'mqtt-temperature-ha' : 'mqtt-temperature',
    device: signal === 'garage_temperature_ha' ? 'garage-ha' : signal, signal, unit: 'degC' }));
  const markUnavailable = (signals, quality) => {
    const at = engine.clock(), observations = [];
    const record = () => {
      for (const signal of signals) {
        engine.recorder?.recordFailure({ ...signal, at, quality });
        observations.push({ ...signal, value: null, sourceTime: null, receivedAt: at, quality,
          raw: { usableForControl: false, timeBasis: 'availability-transition' } });
      }
    };
    if (store.transaction) store.transaction(record); else record();
    for (const observation of observations) engine.rememberObservation?.(observation, at);
  };
  const pendingPublications = new Set();
  const lastErrorAt = new Map();
  const report = (type, cause) => {
    const now = engine.clock();
    if (now - (lastErrorAt.get(type) ?? -Infinity) >= 60_000) {
      // Diagnostic failures must not escape a timer or reject its catch handler.
      // Rate-limit failed attempts too; never recursively log into a busy DB.
      lastErrorAt.set(type, now);
      const errorCode = Number.isSafeInteger(cause?.errcode) ? cause.errcode : undefined;
      try { store.event(type, { source, ...(errorCode === undefined ? {} : { errorCode }) }, now); }
      catch (error) {
        const busy = Number.isSafeInteger(error?.errcode) && [5, 6].includes(error.errcode & 255);
        try { reportStorageFailure({ event: 'mqtt-event-write-failed', source, attemptedEvent: type,
          reason: busy ? 'database-busy' : 'storage-write-failed',
          ...(errorCode === undefined ? {} : { captureErrorCode: errorCode }) }); }
        catch { /* A failed diagnostic sink cannot terminate acquisition either. */ }
      }
    }
  };
  const publish = (topic, payload, options) => new Promise((resolve, reject) => {
    if (!connected || stopped) { reject(new Error('MQTT unavailable')); return; }
    if (!canControl()) { reject(new Error('This instance no longer owns device control')); return; }
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
  const equipment = equipmentSettings ? createEquipmentCapture({ engine, store, settings: equipmentSettings, publish, canControl,
    brokerIdentity: { address, username }, readbackTimeoutMs: settings.readbackTimeoutMs ?? 10_000,
    temperatureReportIntervalMs: config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
    temperatureReportGraceMs: config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS }) : null;
  const shelly = equipment ?? (config.connections.shelly?.devices?.length ? createShellyCapture({ engine, store,
    settings: config.connections.shelly, publish, canControl, brokerIdentity: { address, username },
    readbackTimeoutMs: settings.readbackTimeoutMs ?? 10_000 }) : null);
  if (shelly) engine.shelly = shelly;
  const requestSnapshot = async () => {
    if (!decoder) return;
    // GETALL republishes the gateway's known values. It cannot prove a new sensor measurement.
    lastSnapshotRequestedAt = engine.clock();
    await publish(`${deviceId}/HP/CMD`, 'GETALL', { qos: 0, retain: false });
  };
  const h66 = decoder ? createH66Controller({ deviceId, publish, requestSnapshot, store, clock: () => engine.clock(), config: settings }) : null;
  const connectedHandler = () => {
    if (connected || stopped) return;
    connected = true; disconnectedRecorded = false; h66?.setConnected(true);
    store.event('mqtt-connected', { source, writesEnabled: Boolean(h66 && settings.writeEnabled === true) }, engine.clock());
    if (h66) client.subscribe(`${deviceId}/HP/#`, { qos: 0 }, error => {
      if (error) { markUnavailable(h66Signals, ['mqtt-subscription-failed']); report('mqtt-subscribe-error'); return; }
      requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    });
    for (const [signal, topic] of temperatureTopics) client.subscribe(topic, { qos: 0 }, error => {
      if (error) {
        markUnavailable(temperatureSignals.filter(row => row.signal === signal), ['mqtt-subscription-failed']);
        report('mqtt-temperature-subscribe-error');
      }
    });
    if (shelly) {
      let subscriptions = shelly.topics.length; const failedTopics = [];
      if (!subscriptions) shelly.setConnected(true);
      for (const topic of shelly.topics) client.subscribe(topic, { qos: 1 }, error => {
        if (error) { failedTopics.push(topic); report('mqtt-shelly-subscribe-error'); }
        if (--subscriptions === 0) {
          shelly.setConnected(true);
          for (const failed of failedTopics) shelly.subscriptionFailed(failed);
        }
      });
    }
    if (teslamate) client.subscribe(teslamate.topic, { qos: 0 }, error => {
      if (error) { teslamate.setConnected(false); report('mqtt-teslamate-subscribe-error'); }
      else teslamate.setConnected(true);
    });
  };
  client.on('connect', connectedHandler);
  client.on('error', () => report('mqtt-error'));
  const disconnected = () => {
    if (stopped) return;
    connected = false; h66?.setConnected(false);
    teslamate?.setConnected(false);
    shelly?.setConnected(false);
    for (const finish of [...pendingPublications]) finish(new Error('MQTT disconnected'));
    if (!disconnectedRecorded) {
      markUnavailable([...h66Signals, ...temperatureSignals], ['mqtt-disconnected']);
      disconnectedRecorded = true;
    }
    report('mqtt-offline');
  };
  client.on('offline', disconnected);
  client.on('close', disconnected);
  client.on('message', (topic, payload, packet = {}) => {
    if (!connected || stopped) return;
    try {
      if (shelly?.receive(topic, payload, packet, engine.clock())) return;
      if (teslamate?.receive(topic, payload, packet, engine.clock())) return;
      const temperature = temperatureTopics.find(([, configured]) => configured === topic);
      if (temperature) {
        // MQTT retransmissions cannot serve as new evidence from the sensor.
        if (packet.dup) return;
        const periodic = INDOOR_SIGNALS.includes(temperature[0]);
        const observation = decodeMqttTemperature({ signal: temperature[0] === 'garage_temperature_ha' ? 'garage_temperature' : temperature[0], payload, receivedAt: engine.clock(), retained: packet.retain,
          reportIntervalMs: periodic ? config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS : null,
          reportGraceMs: periodic ? config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS : 0 });
        if (observation) engine.ingest(temperature[0] === 'garage_temperature_ha'
          ? { ...observation, signal: 'garage_temperature_ha', device: 'garage-ha', source: 'mqtt-temperature-ha' } : observation);
        else markUnavailable(temperatureSignals.filter(row => row.signal === temperature[0]), ['invalid-temperature-message']);
        return;
      }
      if (!decoder) return;
      if (topic.startsWith(`${deviceId}/HP/STATUS`) && !packet.retain) lastGatewayStatusAt = engine.clock();
      const decoded = decoder.decode({ topic, payload, receivedAt: engine.clock(), retained: packet.retain,
        dup: packet.dup, messageId: packet.messageId });
      if (!decoded || decoded.duplicate || decoded.signal === 'unknown') return;
      h66.ingest(decoded);
      // An explicitly configured room sensor owns its logical temperature.
      // Keep the gateway register available to H66 diagnostics, but do not mix
      // its measurements into that room's recording or model input.
      if (directGarage && decoded.signal === 'garage_temperature' || temperatureTopics.some(([signal]) => signal === decoded.signal) || equipmentOwnedSignals.includes(decoded.signal)) return;
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
  const maintenance = h66 ? setInterval(() => {
    if (!connected || stopped) return;
    requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    h66.reconcile({ now: engine.clock() }).catch(() => {});
  }, intervalMs) : null;
  maintenance?.unref?.();
  const shellyMaintenance = shelly ? setInterval(() => {
    if (stopped) return;
    try { shelly.tick(engine.clock()); } catch (error) { report('mqtt-shelly-capture-failed', error); }
  }, 5000) : null;
  shellyMaintenance?.unref?.();
  const teslaMaintenance = teslamate ? setInterval(() => {
    if (stopped) return;
    try { teslamate.tick(engine.clock()); } catch (error) { report('mqtt-teslamate-capture-failed', error); }
  }, 5000) : null;
  teslaMaintenance?.unref?.();
  if (client.connected) connectedHandler();
  return { h66, shelly, equipment: equipment ?? shelly, status: () => ({ ...(h66?.status() ?? { connected, writesEnabled: false }), lastSnapshotRequestedAt, lastGatewayStatusAt }),
    ...(h66 ? { setPhase: args => h66.setPhase(args), writeSettings: (...args) => h66.writeSettings(...args),
      restore: args => h66.restore(args), test: args => h66.test(args), requestSnapshot } : {}),
    close: async ({ restore = true } = {}) => {
      if (stopped) return;
      clearInterval(maintenance);
      clearInterval(teslaMaintenance);
      clearInterval(shellyMaintenance);
      shelly?.close();
      if (engine.shelly === shelly) engine.shelly = null;
      teslamate?.close();
      if (engine.teslamate === teslamate) engine.teslamate = null;
      if (restore && canControl() && h66 && connected && settings.writeEnabled === true) {
        try { await h66.restore({ now: engine.clock(), reason: 'application-shutdown' }); }
        catch { report('h66-shutdown-restoration-pending'); }
      }
      stopped = true;
      for (const finish of [...pendingPublications]) finish(new Error('MQTT closed'));
      await h66?.close();
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { client.stream?.destroy(); } catch {} resolve(); }, 1000);
        try { client.end(true, {}, () => { clearTimeout(timer); resolve(); }); }
        catch { clearTimeout(timer); resolve(); }
      });
    } };
}
