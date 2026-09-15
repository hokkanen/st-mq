import { decodeMqttTemperature, temperatureRouteSignature } from './mqtt-temperature.js';
import { createShellyCapture } from './shelly.js';
import { createEquipmentCapture } from './equipment.js';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { createH66Decoder, H66_REGISTERS } from '../domain/telemetry.js';
import { createH66Controller, H66_WRITABLE_REGISTERS } from '../control/h66.js';
import { createTeslaMateCapture } from './teslamate.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';
import { createGarageAdapter } from '../garage/adapter.js';
import { createChargingTeslaCapture } from '../charging/teslamate.js';

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
  const equipmentOwnedSignals = equipmentSettings?.ownedSignals ?? (config.connections.shelly?.devices?.some(device => device.role === 'garage') ? ['garage_temperature'] : []);
  const temperatureTopics = Object.entries(config.connections.mqtt.temperatureTopics ?? {})
    .filter(([signal, topic]) => ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'].includes(signal)
      && typeof topic === 'string' && topic.length > 0 && !/[+#\u0000]/.test(topic))
    .filter(([signal]) => !equipmentOwnedSignals.includes(signal));
  const roomRoutes = new Map(temperatureTopics.filter(([signal]) => INDOOR_SIGNALS.includes(signal)).map(([signal, topic]) => [signal,
    { reportIntervalMs: config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
      reportGraceMs: config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS,
      routeSignature: temperatureRouteSignature({ brokerIdentity: { address, username }, topic }) }]));
  for (const [signal] of temperatureTopics) if (INDOOR_SIGNALS.includes(signal) || ['garage_temperature', 'garage_temperature_2'].includes(signal))
    engine.configureTemperatureReports?.(signal, {
      reportIntervalMs: signal.startsWith('garage_') ? 30_000 : config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
      reportGraceMs: signal.startsWith('garage_') ? 90_000 : config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS,
    });
  const teslamate = config.connections.teslamate?.enabled === true
    ? createTeslaMateCapture({ engine, store, settings: config.connections.teslamate }) : null;
  const chargingTesla = teslamate && engine.charging ? createChargingTeslaCapture({ settings: config.connections.teslamate,
    clock: () => engine.clock() }) : null;
  if (chargingTesla) engine.charging.teslaCapture = chargingTesla;
  const hasEquipmentHeating = (equipmentSettings?.devices ?? config.connections.shelly?.devices ?? [])
    .some(device => device.enabled !== false && device.controlsHeat);
  const topicGroups = [
    ...(engine.charging ? [{ id: 'charger1-vehicle', label: 'Charger 1 vehicle', source: 'MQTT', topics: [
      { role: 'Timestamped state of charge', topic: engine.charging.settings.mqttTopic, direction: 'subscribe' },
    ] }] : []),
    { id: 'dhwr', label: 'Hot-water circulation commands', source: 'MQTT', topics: [
      { role: 'Timed ON/OFF command', topic: config.connections.mqtt.dhwr_topic || 'stmq/home/dhwr/command/switch', direction: 'publish' },
    ] },
    ...(decoder ? [{ id: 'h66', label: 'Heat pump · H66', source: 'MQTT', topics: [
      { role: 'Telemetry subscription', topic: `${deviceId}/HP/#`, direction: 'subscribe' },
      { role: 'Status request', topic: `${deviceId}/HP/CMD`, direction: 'publish' },
      ...(settings.writeEnabled === true ? H66_WRITABLE_REGISTERS.map(index => ({ role: `Setting ${index}`, topic: `${deviceId}/HP/SET/${index}`, direction: 'publish' })) : []),
    ] }] : []),
    ...(temperatureTopics.length ? [{ id: 'temperatures', label: 'Temperature feeds', source: 'MQTT', topics: temperatureTopics.map(([signal, topic]) => ({
      role: { indoor_temperature: 'Upstairs', downstairs_temperature: 'Downstairs', bedroom_temperature: 'Bedroom',
        garage_temperature: 'Garage rear', garage_temperature_2: 'Garage front', outdoor_temperature: 'Outdoor' }[signal], signal, topic, direction: 'subscribe',
    })) }] : []),
    ...(teslamate ? [{ id: 'teslamate', label: 'TeslaMate', source: 'MQTT', topics: [
      { role: 'Vehicle subscription', topic: teslamate.topic, direction: 'subscribe' },
    ] }] : []),
    ...(!hasEquipmentHeating ? [{ id: 'heating', label: 'Heating commands', source: 'MQTT', topics: [
      { role: 'Heating mode command', topic: 'from_stmq/heat/action', direction: 'publish' },
    ] }] : []),
  ];
  if (teslamate) engine.teslamate = teslamate;
  // Every connect explicitly subscribes below. MQTT.js automatic resubscription
  // can otherwise report cached success before the broker acknowledges a route.
  const client = connect(address, { username, password, reconnectPeriod: 5000, clean: true, connectTimeout: 10_000, queueQoSZero: false, resubscribe: false });
  let connectionGeneration = 0, stopping = false, equipmentSubscriptionBuffer = null;
  let connected = false, stopped = false, disconnectedRecorded = false, lastSnapshotRequestedAt = null, lastGatewayStatusAt = null;
  const source = decoder ? 'husdata-h66' : teslamate ? 'teslamate' : 'mqtt-temperature';
  const h66Signals = decoder ? Object.values(H66_REGISTERS).map(({ signal, unit }) => ({
    source: 'husdata-h66', device: deviceId, signal: signal === 'integral' ? 'heating_integral' : signal, unit,
  })).filter(row => !temperatureTopics.some(([signal]) => signal === row.signal) && !equipmentOwnedSignals.includes(row.signal)) : [];
  const temperatureSignals = temperatureTopics.map(([signal]) => ({
    source: 'mqtt-temperature', device: signal, signal, unit: 'degC' }));
  const markUnavailable = (signals, quality) => {
    const at = engine.clock(), observations = [];
    const record = () => {
      for (const signal of signals) {
        const raw = { usableForControl: false, timeBasis: 'availability-transition',
          ...(roomRoutes.has(signal.signal) ? { temperatureRouteSignature: roomRoutes.get(signal.signal).routeSignature } : {}) };
        engine.recorder?.recordFailure({ ...signal, at, quality, raw });
        observations.push({ ...signal, value: null, sourceTime: null, receivedAt: at, quality, raw });
      }
    };
    if (store.transaction) store.transaction(record); else record();
    for (const observation of observations) engine.rememberObservation?.(observation, at);
  };
  const pendingPublications = new Set(), pendingSubscriptions = new Set();
  const subscriptionRejected = (topic, error, granted) => Boolean(error || Array.isArray(granted)
    && (!granted.length || !granted.some(row => row.topic === topic && [0, 1, 2].includes(row.qos))));
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
    const { noReplay = false, ...publicationOptions } = options ?? {};
    // MQTT.js can defer ID allocation while replaying its outgoing store. Do
    // not enqueue a new movement during that phase. These queue guards match
    // the pinned client's publish implementation; ordinary telemetry is unchanged.
    if (noReplay && (client.connected === false || client._storeProcessing || client._storeProcessingQueue?.length)) {
      reject(new Error('MQTT door command route is reconnecting')); return;
    }
    let finished = false, failed = false, outgoingId = null, outgoingRemoved = false;
    const removeOutgoing = () => {
      if (!failed || !noReplay || outgoingRemoved || !Number.isInteger(outgoingId)) return;
      outgoingRemoved = true; client.removeOutgoingMessage?.(outgoingId);
    };
    const capturePacket = packet => {
      if (packet.cmd !== 'publish' || packet.topic !== topic || String(packet.payload) !== String(payload)) return;
      outgoingId = packet.messageId;
      client.off?.('packetsend', capturePacket);
    };
    const finish = error => {
      if (finished) return;
      finished = true; failed = Boolean(error); clearTimeout(timer); pendingPublications.delete(finish);
      client.off?.('packetsend', capturePacket);
      // MQTT.js normally retransmits unacknowledged QoS 1 packets after its
      // connection recovers. A manual door movement must require a new request.
      removeOutgoing();
      if (error) reject(new Error('MQTT publication failed')); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('MQTT timeout')), settings.readbackTimeoutMs ?? 10_000);
    pendingPublications.add(finish);
    if (noReplay) client.on?.('packetsend', capturePacket);
    const previousId = noReplay ? client.getLastMessageId?.() : null;
    try { client.publish(topic, payload, publicationOptions, finish); } catch { finish(new Error('MQTT publication failed')); }
    if (noReplay) {
      const allocatedId = client.getLastMessageId?.();
      if (Number.isInteger(allocatedId) && allocatedId !== previousId) {
        outgoingId = allocatedId; client.off?.('packetsend', capturePacket);
      }
      // Disconnect can occur inside publish before any packet reaches the wire.
      // The allocated ID still lets us remove that unsent outgoing-store entry.
      removeOutgoing();
    }
  });
  const refreshSubscriptions = topics => Promise.all([...new Set(topics)].map(topic => new Promise((resolve, reject) => {
    if (!connected || stopping || stopped) { reject(new Error('MQTT unavailable')); return; }
    const generation = connectionGeneration; let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); pendingSubscriptions.delete(finish);
      if (error) reject(new Error('MQTT subscription refresh failed')); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('MQTT subscription timeout')), settings.readbackTimeoutMs ?? 10_000);
    pendingSubscriptions.add(finish);
    try {
      // Re-subscribing asks the broker to confirm this exact route and may replay
      // retained context. It does not request a new measurement from a publisher.
      client.subscribe(topic, { qos: 1 }, (error, granted) => finish(subscriptionRejected(topic, error, granted)
        || !connected || stopping || stopped || generation !== connectionGeneration ? new Error('MQTT subscription unavailable') : null));
    } catch { finish(new Error('MQTT subscription failed')); }
  })));
  const equipment = equipmentSettings ? createEquipmentCapture({ engine, store, settings: equipmentSettings, publish, canControl,
    brokerIdentity: { address, username }, refreshSubscriptions, topicGroups, readbackTimeoutMs: settings.readbackTimeoutMs ?? 10_000,
    temperatureReportIntervalMs: config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
    temperatureReportGraceMs: config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS }) : null;
  const shelly = equipment ?? (config.connections.shelly?.devices?.length ? createShellyCapture({ engine, store,
    settings: config.connections.shelly, publish, canControl, brokerIdentity: { address, username }, topicGroups,
    readbackTimeoutMs: settings.readbackTimeoutMs ?? 10_000 }) : null);
  if (shelly) engine.shelly = shelly;
  // The only installed garage contract is a provisional read-only consumer.
  // Deliberately do not pass publish or any simulation transport here.
  const garage = engine.garage || config.garage?.adapter ? createGarageAdapter({
    settings: config.garage?.adapter, baselineC: config.garage?.baselineC ?? 10, clock: () => engine.clock(), canControl,
    persisted: store.getState?.(`garage:adapter:${config.input}`),
    onObservation: observation => engine.ingest(observation),
    onEnergy: observation => engine.ingestEnergy?.(observation),
    onState: snapshot => engine.garage?.adapterChanged?.(snapshot),
  }) : null;
  if (garage) {
    engine.garage?.setAdapter?.(garage);
    if (garage.topics.length) topicGroups.push({ id: 'garage-adapter', label: 'Garage adapter · provisional monitoring', source: 'MQTT',
      topics: garage.topics.map(topic => ({ role: 'Provisional telemetry subscription', topic, direction: 'subscribe' })) });
  }
  const requestSnapshot = async () => {
    if (!decoder) return;
    // GETALL republishes the gateway's known values. It cannot prove a new sensor measurement.
    lastSnapshotRequestedAt = engine.clock();
    await publish(`${deviceId}/HP/CMD`, 'GETALL', { qos: 0, retain: false });
  };
  const h66 = decoder ? createH66Controller({ deviceId, publish, requestSnapshot, store, clock: () => engine.clock(), config: settings }) : null;
  const subscribeChargingSoc = () => {
    if (!engine.charging || !connected || stopped || stopping) return;
    const generation = connectionGeneration, topic = engine.charging.settings.mqttTopic;
    engine.charging.setMqttStatus({ connected: true, subscribed: false, reason: 'awaiting-subscription' });
    client.subscribe(topic, { qos: 1 }, (error, granted) => {
      if (!connected || stopped || stopping || generation !== connectionGeneration || topic !== engine.charging.settings.mqttTopic) return;
      const rejected = subscriptionRejected(topic, error, granted);
      engine.charging.setMqttStatus({ connected: true, subscribed: !rejected, reason: rejected ? 'mqtt-subscription-failed' : null });
    });
  };
  if (engine.charging) engine.charging.onMqttTopicChange = (topic, previous) => {
    // Old deliveries cannot match the new selected route, even before UNSUBACK.
    if (connected) client.unsubscribe?.(previous, () => {});
    const group = topicGroups.find(group => group.id === 'charger1-vehicle');
    if (group) group.topics[0].topic = topic;
    subscribeChargingSoc();
  };
  const connectedHandler = () => {
    if (connected || stopped || stopping) return;
    const generation = ++connectionGeneration;
    const currentSubscription = () => connected && !stopped && !stopping && generation === connectionGeneration;
    connected = true; disconnectedRecorded = false; h66?.setConnected(true);
    subscribeChargingSoc();
    garage?.setConnected(true);
    store.event('mqtt-connected', { source, writesEnabled: Boolean(h66 && settings.writeEnabled === true) }, engine.clock());
    if (h66) client.subscribe(`${deviceId}/HP/#`, { qos: 0 }, error => {
      if (!currentSubscription()) return;
      if (error) { markUnavailable(h66Signals, ['mqtt-subscription-failed']); report('mqtt-subscribe-error'); return; }
      requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    });
    for (const [signal, topic] of temperatureTopics) client.subscribe(topic, { qos: 0 }, error => {
      if (!currentSubscription()) return;
      if (error) {
        markUnavailable(temperatureSignals.filter(row => row.signal === signal), ['mqtt-subscription-failed']);
        report('mqtt-temperature-subscribe-error');
      } else if (roomRoutes.has(signal)) {
        try { engine.confirmTemperatureConnection?.(signal, roomRoutes.get(signal)); }
        catch (error) { report('mqtt-temperature-recovery-failed', error); }
      }
    });
    if (shelly) {
      let subscriptions = shelly.topics.length; const failedTopics = [], confirmedTopics = [];
      const buffered = { messages: [], bytes: 0, overflow: new Set() };
      equipmentSubscriptionBuffer = subscriptions ? buffered : null;
      if (!subscriptions) shelly.setConnected(true);
      for (const topic of shelly.topics) client.subscribe(topic, { qos: 1 }, (error, granted) => {
        if (!currentSubscription()) return;
        if (subscriptionRejected(topic, error, granted)) { failedTopics.push(topic); report('mqtt-shelly-subscribe-error'); }
        else confirmedTopics.push(topic);
        if (--subscriptions === 0) {
          equipmentSubscriptionBuffer = null;
          shelly.setConnected(true);
          // Packets can arrive after their own SUBACK while unrelated routes
          // still subscribe. Keep their original receipt clocks when replaying.
          for (const message of buffered.messages) {
            try { shelly.receive(message.topic, message.payload, message.packet, message.receivedAt); }
            catch { report('mqtt-observation-rejected'); }
          }
          for (const failed of [...failedTopics, ...buffered.overflow]) shelly.subscriptionFailed(failed);
          try { shelly.confirmSubscriptions?.(confirmedTopics.filter(topic => !buffered.overflow.has(topic))); }
          catch (error) { report('mqtt-temperature-recovery-failed', error); }
        }
      });
    }
    if (teslamate) client.subscribe(teslamate.topic, { qos: 0 }, error => {
      if (!currentSubscription()) return;
      if (error) { teslamate.setConnected(false); chargingTesla?.setConnected(false); report('mqtt-teslamate-subscribe-error'); }
      else { teslamate.setConnected(true); chargingTesla?.setConnected(true); }
    });
    for (const topic of garage?.topics ?? []) client.subscribe(topic, { qos: 1 }, (error, granted) => {
      if (!currentSubscription()) return;
      if (subscriptionRejected(topic, error, granted)) { garage.subscriptionFailed(); report('mqtt-garage-subscribe-error'); }
    });
  };
  client.on('connect', connectedHandler);
  client.on('error', () => report('mqtt-error'));
  const disconnected = () => {
    if (stopped) return;
    connected = false; connectionGeneration++; equipmentSubscriptionBuffer = null; h66?.setConnected(false);
    teslamate?.setConnected(false);
    chargingTesla?.setConnected(false);
    engine.charging?.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
    shelly?.setConnected(false);
    garage?.setConnected(false);
    for (const finish of [...pendingPublications]) finish(new Error('MQTT disconnected'));
    for (const finish of [...pendingSubscriptions]) finish(new Error('MQTT disconnected'));
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
      if (engine.charging?.receiveSoc(topic, payload, packet, engine.clock())) return;
      chargingTesla?.receive(topic, payload, packet, engine.clock());
      if (garage?.receive(topic, payload, packet, engine.clock())) return;
      if (equipmentSubscriptionBuffer) {
        const matched = shelly.topics.filter(subscription => subscription.endsWith('/#')
          ? topic.startsWith(subscription.slice(0, -1)) : subscription === topic);
        if (matched.length) {
          const buffered = equipmentSubscriptionBuffer, bytes = Buffer.byteLength(payload);
          if (buffered.messages.length >= 256 || bytes > 65_536 || buffered.bytes + bytes > 262_144)
            for (const subscription of matched) buffered.overflow.add(subscription);
          else { buffered.messages.push({ topic, payload: Buffer.from(payload), packet: { retain: packet.retain, dup: packet.dup }, receivedAt: engine.clock() }); buffered.bytes += bytes; }
          return;
        }
      }
      if (shelly?.receive(topic, payload, packet, engine.clock())) return;
      if (teslamate?.receive(topic, payload, packet, engine.clock())) return;
      const temperature = temperatureTopics.find(([, configured]) => configured === topic);
      if (temperature) {
        // MQTT retransmissions cannot serve as new evidence from the sensor.
        if (packet.dup) return;
        const periodic = INDOOR_SIGNALS.includes(temperature[0]);
        const observation = decodeMqttTemperature({ signal: temperature[0], payload, receivedAt: engine.clock(), retained: packet.retain,
          reportIntervalMs: periodic ? config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS : temperature[0].startsWith('garage_') ? 30_000 : null,
          reportGraceMs: periodic ? config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS : temperature[0].startsWith('garage_') ? 90_000 : 0 });
        if (observation) engine.ingest(roomRoutes.has(temperature[0]) ? { ...observation,
          raw: { ...observation.raw, temperatureRouteSignature: roomRoutes.get(temperature[0]).routeSignature } } : observation);
        else markUnavailable(temperatureSignals.filter(row => row.signal === temperature[0]), ['invalid-temperature-message']);
        return;
      }
      if (!decoder) return;
      if (topic.startsWith(`${deviceId}/HP/STATUS`) && !packet.retain) lastGatewayStatusAt = engine.clock();
      const decoded = decoder.decode({ topic, payload, receivedAt: engine.clock(), retained: packet.retain,
        dup: packet.dup, messageId: packet.messageId });
      if (!decoded || decoded.duplicate || decoded.signal === 'unknown') return;
      h66.ingest(decoded);
      // A configured equipment or temperature source owns its logical signal.
      if (temperatureTopics.some(([signal]) => signal === decoded.signal) || equipmentOwnedSignals.includes(decoded.signal)) return;
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
  return { h66, shelly, garage, equipment: equipment ?? shelly, status: () => ({ ...(h66?.status() ?? { connected, writesEnabled: false }), lastSnapshotRequestedAt, lastGatewayStatusAt }),
    ...(h66 ? { setPhase: args => h66.setPhase(args), writeSettings: (...args) => h66.writeSettings(...args),
      restore: args => h66.restore(args), test: args => h66.test(args), requestSnapshot } : {}),
    close: async ({ restore = true } = {}) => {
      if (stopped || stopping) return;
      stopping = true; connectionGeneration++; equipmentSubscriptionBuffer = null;
      for (const finish of [...pendingSubscriptions]) finish(new Error('MQTT closed'));
      clearInterval(maintenance);
      clearInterval(teslaMaintenance);
      clearInterval(shellyMaintenance);
      await garage?.close({ restore: restore && canControl(), now: engine.clock() });
      if (garage) engine.garage?.setAdapter?.(null);
      shelly?.close();
      if (engine.shelly === shelly) engine.shelly = null;
      teslamate?.close();
      chargingTesla?.setConnected(false);
      if (engine.charging) {
        engine.charging.onMqttTopicChange = null;
        engine.charging.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
      }
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
