import { createEquipmentCapture } from './equipment.js';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { gateMqttPublications } from '../control/mqtt-publication-gate.js';
import { createH66Decoder, H66_REGISTERS } from '../domain/telemetry.js';
import { createH66Controller, H66_WRITABLE_REGISTERS } from '../control/h66.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';
import { createFloorOverride, floorOverrideConfiguration } from '../control/floor-override.js';
import { createGarageAdapter } from '../garage/adapter.js';
import { createGarageSender, validateGarageSenderSnapshot } from '../garage/sender.js';
import { validateGarageAdapterSnapshot } from '../garage/contract.js';
import { createShellyCn105Transport } from '../garage/shelly-cn105.js';
import { teslamateConfiguration } from '../app/config.js';
import { createShellyEvseAdapter } from '../charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../charging/teslamate.js';
import { mqttRouting } from './mqtt-routing.js';

export { decodeMqttTemperature } from './mqtt-temperature.js';

// Each integration owns one explicit MQTT route for observations and commands.
// Credentials and raw broker errors never enter event logs.
export async function startMqtt({ engine, store, config, connect = mqtt.connect, canControl = () => true,
  reportStorageFailure = diagnostic => process.stderr.write(`${JSON.stringify(diagnostic)}\n`) }) {
  validateGarageAdapterSnapshot(store.getState?.(`garage:adapter:${config.input}`));
  validateGarageSenderSnapshot(store.getState?.(`garage:sender:${config.input}`));
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
  const routing = mqttRouting(config);
  const equipmentSettings = config.connections.equipment;
  const equipmentOwnedSignals = equipmentSettings?.ownedSignals ?? [];
  const teslaSettings = teslamateConfiguration(config.connections.teslamate);
  const teslamate = teslaSettings.enabled ? createChargingTeslaCapture({ settings: teslaSettings,
    clock: () => engine.clock(), initialState: store.getState('charging:teslamate'),
    brokerIdentity: routing.identity('ha'), saveState: state => store.setState('charging:teslamate', state),
    onBoundary: event => engine.charging?.receiveVehicleBoundary?.('tesla', event) }) : null;
  const chargingTesla = teslamate;
  if (chargingTesla && engine.charging) engine.charging.teslaCapture = chargingTesla;
  const topicGroups = [
    ...(engine.charging?.mqttRoutes() ?? []).map(route => ({ id: `vehicle:${route.id}`, vehicleFeedId: route.id, label: route.label, broker: routing.vehicleBroker(route),
      source: route.provider === 'bmw-cardata' ? 'BMW CarData' : 'MQTT', topics: [
      { role: 'Timestamped vehicle readings', topic: route.topic, direction: 'subscribe' },
    ] })),
    { id: 'dhwr', label: 'Hot-water circulation commands', source: 'MQTT', topics: [
      { role: 'Timed ON/OFF command', topic: config.connections.mqtt.dhwr_topic || 'stmq/home/dhwr/command/switch', direction: 'publish' },
    ] },
    ...(decoder ? [{ id: 'h66', label: 'Heat pump · H66', source: 'MQTT', topics: [
      { role: 'Telemetry subscription', topic: `${deviceId}/HP/#`, direction: 'subscribe' },
      { role: 'Status request', topic: `${deviceId}/HP/CMD`, direction: 'publish' },
      ...(settings.writeEnabled === true ? H66_WRITABLE_REGISTERS.map(index => ({ role: `Setting ${index}`, topic: `${deviceId}/HP/SET/${index}`, direction: 'publish' })) : []),
    ] }] : []),
    ...(teslamate ? [{ id: 'vehicle:tesla', vehicleFeedId: 'tesla', label: 'Tesla', source: 'TeslaMate', broker: routing.teslaBroker, topics: [
      { role: 'Vehicle subscription', topic: teslamate.topic, direction: 'subscribe' },
    ] }] : []),
  ];
  if (teslamate) engine.teslamate = teslamate;
  // Every connect explicitly subscribes below. MQTT.js automatic resubscription
  // can otherwise report cached success before the broker acknowledges a route.
  const channels = new Map();
  let stopping = false, stopped = false, disconnectedRecorded = false, lastSnapshotRequestedAt = null, lastGatewayStatusAt = null;
  for (const [id, connection] of [['primary', config.connections.mqtt], ...(routing.ha ? [['ha', routing.ha]] : [])]) {
    const client = connect(connection.address, { username: connection.user, password: connection.pw,
      reconnectPeriod: 5000, clean: true, connectTimeout: 10_000, queueQoSZero: false, resubscribe: false });
    channels.set(id, { id, client, gate: gateMqttPublications(client, { canControl, timeoutMs: settings.readbackTimeoutMs ?? 10_000 }),
      connected: false, generation: 0, ready: false, readinessFailed: false, readinessWaiters: new Set(),
      vehicleSubscriptions: new Map(), equipmentSubscriptionBuffer: null, teslaSubscriptionBuffer: null, teslaSubscriptionOverflow: false,
      pendingPublications: new Set(), pendingSubscriptions: new Set() });
  }
  const primary = channels.get('primary'), client = primary.client;
  const evseConfig = engine.charging?.configuration?.chargers?.charger2;
  const primaryIdentity = routing.identity('primary');
  const evse = evseConfig?.enabled ? createShellyEvseAdapter({ config: evseConfig,
    broker: { address: primaryIdentity.address, user: primaryIdentity.username }, client, store, engine, clock: () => engine.clock(), canControl }) : null;
  if (evse) void engine.charging.setAdapter('charger2', evse);
  const source = decoder ? 'husdata-h66' : teslamate ? 'teslamate' : 'mqtt-temperature';
  const h66Signals = decoder ? Object.values(H66_REGISTERS).map(({ signal, unit }) => ({
    source: 'husdata-h66', device: deviceId, signal: signal === 'integral' ? 'heating_integral' : signal, unit,
  })).filter(row => !equipmentOwnedSignals.includes(row.signal)) : [];
  const markUnavailable = (signals, quality) => {
    const at = engine.clock(), observations = [];
    const record = () => {
      for (const signal of signals) {
        const raw = { usableForControl: false, timeBasis: 'availability-transition' };
        engine.recorder?.recordFailure({ ...signal, at, quality, raw });
        observations.push({ ...signal, value: null, sourceTime: null, receivedAt: at, quality, raw });
      }
    };
    if (store.transaction) store.transaction(record); else record();
    for (const observation of observations) engine.rememberObservation?.(observation, at);
  };
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
  const publish = (topic, payload, options, broker = 'primary') => new Promise((resolve, reject) => {
    const channel = channels.get(broker);
    if (!channel?.connected || stopped) { reject(new Error('MQTT unavailable')); return; }
    if (!canControl()) { reject(new Error('This instance no longer owns device control')); return; }
    const { client, pendingPublications } = channel;
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
  const refreshSubscriptions = (topics, broker = 'primary') => Promise.all([...new Set(topics)].map(topic => new Promise((resolve, reject) => {
    const channel = channels.get(broker);
    if (!channel?.connected || stopping || stopped) { reject(new Error('MQTT unavailable')); return; }
    const { client, pendingSubscriptions } = channel;
    const generation = channel.generation; let finished = false;
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
        || !channel.connected || stopping || stopped || generation !== channel.generation ? new Error('MQTT subscription unavailable') : null));
    } catch { finish(new Error('MQTT subscription failed')); }
  })));
  const floorOverride = createFloorOverride({ store, settings: config.floorPreheat ?? floorOverrideConfiguration() });
  engine.floorOverride = floorOverride;
  if (engine.executor) engine.executor.floorOverride = floorOverride;
  const equipment = equipmentSettings ? createEquipmentCapture({ engine, store, settings: equipmentSettings, publish, canControl,
    brokerIdentity: primaryIdentity, brokerForDevice: routing.equipmentBroker,
    brokerIdentityForDevice: routing.equipmentIdentity, refreshSubscriptions, topicGroups, readbackTimeoutMs: settings.readbackTimeoutMs ?? 10_000,
    temperatureReportIntervalMs: config.connections.mqtt.temperatureReportIntervalMs ?? DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
    temperatureReportGraceMs: config.connections.mqtt.temperatureReportGraceMs ?? DEFAULT_TEMPERATURE_REPORT_GRACE_MS }) : null;
  const shelly = equipment;
  if (equipment) engine.equipment = equipment;
  // The heat-pump controller owns local regulation; MQTT carries explicit owner edits.
  const garage = engine.garage || config.garage?.adapter ? createGarageAdapter({
    settings: config.garage?.adapter, clock: () => engine.clock(), canControl,
    productionTransport: createShellyCn105Transport({ settings: config.garage?.adapter, publish }),
    persisted: store.getState?.(`garage:adapter:${config.input}`),
    onObservation: observation => engine.ingest(observation),
    onEnergy: observation => engine.ingestEnergy?.(observation),
    onDiagnostic: (diagnostic, at, snapshot) => store.transaction(() => {
      store.event('garage-external-temperature-diagnostic', diagnostic, at);
      store.setState(`garage:adapter:${config.input}`, snapshot);
    }),
    onEquipmentDiagnostic: (diagnostic, at, snapshot) => store.transaction(() => {
      store.event('garage-pump-diagnostic', diagnostic, at);
      store.setState(`garage:adapter:${config.input}`, snapshot);
    }),
    onState: snapshot => engine.garage?.adapterChanged?.(snapshot),
  }) : null;
  if (garage) {
    engine.garage?.setAdapter?.(garage);
    if (garage.topics.length) topicGroups.push({ id: 'garage-adapter',
      label: 'Garage adapter · Shelly CN105', source: 'MQTT',
      topics: [...garage.topics.map(topic => ({ role: 'Native telemetry subscription', topic, direction: 'subscribe' })),
        ...(config.garage?.adapter?.commandTopic ? [{ role: 'Explicit pump and room-target commands', topic: config.garage.adapter.commandTopic, direction: 'publish' }] : [])] });
  }
  const garageSender = config.garage?.sender ? createGarageSender({ settings: config.garage.sender,
    protection: config.garage.protection, enabled: config.garage.enabled === true,
    publish, clock: () => engine.clock(), canControl: () => config.input !== 'offline' && canControl(),
    persisted: store.getState?.(`garage:sender:${config.input}`),
    onState: snapshot => engine.garage?.senderChanged?.(snapshot),
    onObservation: observation => engine.ingest(observation) }) : null;
  if (garageSender) {
    engine.garage?.setSender?.(garageSender);
    if (garageSender.topics.length) topicGroups.push({ id: 'garage-sender', label: 'Garage local frost protection', source: 'MQTT',
      topics: [...garageSender.topics.map(topic => ({ role: 'Sender status and protection readback', topic, direction: 'subscribe' })),
        ...(config.garage.sender.commandTopic ? [{ role: 'Configured protection parameters', topic: config.garage.sender.commandTopic, direction: 'publish' }] : [])] });
  }
  const requestSnapshot = async () => {
    if (!decoder) return;
    // GETALL republishes the gateway's known values. It cannot prove a new sensor measurement.
    lastSnapshotRequestedAt = engine.clock();
    await publish(`${deviceId}/HP/CMD`, 'GETALL', { qos: 0, retain: false });
  };
  const h66 = decoder ? createH66Controller({ deviceId, publish, requestSnapshot, store, clock: () => engine.clock(), config: settings }) : null;
  const matchesTopic = (topic, subscription) => subscription.endsWith('/#')
    ? topic.startsWith(subscription.slice(0, -1)) : subscription === topic;
  const finishReadiness = (channel, failed = false) => {
    channel.readinessFailed ||= failed;
    channel.ready = channel.connected && !channel.readinessFailed;
    for (const finish of [...channel.readinessWaiters]) finish(channel.ready ? null : new Error('MQTT primary subscriptions unavailable'));
  };
  const primaryReady = () => new Promise((resolve, reject) => {
    if (primary.ready) { resolve(); return; }
    if (stopped || stopping || primary.readinessFailed) { reject(new Error('MQTT primary subscriptions unavailable')); return; }
    const finish = error => { clearTimeout(timer); primary.readinessWaiters.delete(finish); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error('MQTT primary subscription readiness timed out')), 10_000);
    primary.readinessWaiters.add(finish);
  });
  const ready = async () => {
    const deadline = Date.now() + 10_000;
    await primaryReady();
    // Shelly owns its RPC subscriptions directly on the primary client. Wait
    // for their SUBACK as well, without waiting for a device to be online.
    while (evse && evse.snapshot().mqtt.subscriptionStatus !== 'subscribed') {
      if (stopped || stopping || !primary.connected || evse.snapshot().mqtt.subscriptionStatus === 'failed' || Date.now() >= deadline)
        throw new Error('MQTT primary charger subscriptions unavailable');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (stopped || stopping || !primary.connected || !primary.ready)
      throw new Error('MQTT primary subscriptions unavailable');
  };
  for (const channel of channels.values()) {
    const { client, vehicleSubscriptions } = channel;
    const isPrimary = channel.id === 'primary', ownsTesla = channel.id === routing.teslaBroker;
    const equipmentTopics = shelly?.topicsForBroker(channel.id) ?? [];
    const connectedHandler = () => {
      if (channel.connected || stopped || stopping) return;
      const generation = ++channel.generation;
      channel.connected = true; channel.ready = false; channel.readinessFailed = false;
      const currentSubscription = () => channel.connected && !stopped && !stopping && generation === channel.generation;
      let pending = 1;
      const subscribe = (topic, options, callback) => {
        pending++;
        let acknowledged = false;
        const done = (error, granted) => {
          if (acknowledged || !currentSubscription()) return;
          acknowledged = true;
          channel.readinessFailed ||= subscriptionRejected(topic, error, granted);
          try { callback(error, granted); }
          finally { if (--pending === 0) finishReadiness(channel); }
        };
        try { client.subscribe(topic, options, done); }
        catch { done(new Error('MQTT subscription failed')); }
      };
      for (const { id, topic } of (engine.charging?.mqttRoutes() ?? []).filter(route => routing.vehicleBroker(route) === channel.id)) {
        const subscription = { subscribed: false, messages: [] };
        vehicleSubscriptions.set(topic, subscription);
        engine.charging.setMqttStatus({ connected: true, subscribed: false, reason: 'awaiting-subscription', broker: channel.id }, id);
        subscribe(topic, { qos: 1 }, (error, granted) => {
          const rejected = subscriptionRejected(topic, error, granted);
          subscription.subscribed = !rejected;
          engine.charging.setMqttStatus({ connected: true, subscribed: !rejected, reason: rejected ? 'mqtt-subscription-failed' : null, broker: channel.id }, id);
          const buffered = subscription.messages; subscription.messages = null;
          if (!rejected) for (const message of buffered ?? []) {
            try { engine.charging.receiveSoc(topic, message.payload, message.packet, message.at); }
            catch { report('mqtt-observation-rejected'); }
          }
        });
      }
      if (isPrimary) {
        disconnectedRecorded = false; h66?.setConnected(true);
        garage?.setConnected(true); garageSender?.setConnected(true);
        let floorSubscriptions = floorOverride.topics.length, floorSubscriptionFailed = false;
        for (const topic of floorOverride.topics) subscribe(topic, { qos: 1 }, (error, granted) => {
          if (subscriptionRejected(topic, error, granted)) floorSubscriptionFailed = true;
          if (--floorSubscriptions === 0) {
            floorOverride.setConnected(!floorSubscriptionFailed);
            floorOverride.tick(engine.clock()).catch(() => report('mqtt-floor-unavailable'));
          }
        });
        if (h66) subscribe(`${deviceId}/HP/#`, { qos: 0 }, (error, granted) => {
          if (subscriptionRejected(`${deviceId}/HP/#`, error, granted)) { markUnavailable(h66Signals, ['mqtt-subscription-failed']); report('mqtt-subscribe-error'); return; }
          requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
        });
        for (const topic of garage?.topics ?? []) subscribe(topic, { qos: 1 }, (error, granted) => {
          if (subscriptionRejected(topic, error, granted)) { garage.subscriptionFailed(); report('mqtt-garage-subscribe-error'); }
        });
        for (const topic of garageSender?.topics ?? []) subscribe(topic, { qos: 1 }, (error, granted) => {
          if (subscriptionRejected(topic, error, granted)) { garageSender.subscriptionFailed(); report('mqtt-garage-sender-subscribe-error'); }
        });
      }
      store.event('mqtt-connected', { source, broker: channel.id, writesEnabled: Boolean(isPrimary && h66 && settings.writeEnabled === true) }, engine.clock());
      if (shelly) {
        let subscriptions = equipmentTopics.length; const failedTopics = [], confirmedTopics = [];
        const buffered = { messages: [], bytes: 0, overflow: new Set() };
        channel.equipmentSubscriptionBuffer = subscriptions ? buffered : null;
        if (!subscriptions) shelly.setConnected(true, channel.id);
        for (const topic of equipmentTopics) subscribe(topic, { qos: 1 }, (error, granted) => {
          if (subscriptionRejected(topic, error, granted)) { failedTopics.push(topic); report('mqtt-shelly-subscribe-error'); }
          else confirmedTopics.push(topic);
          if (--subscriptions === 0) {
            channel.equipmentSubscriptionBuffer = null;
            shelly.setConnected(true, channel.id);
            // Retain original receipt clocks across SUBACK buffering.
            for (const message of buffered.messages) {
              try { shelly.receive(message.topic, message.payload, message.packet, message.receivedAt, channel.id); }
              catch { report('mqtt-observation-rejected'); }
            }
            for (const failed of [...failedTopics, ...buffered.overflow]) shelly.subscriptionFailed(failed, channel.id);
            try { shelly.confirmSubscriptions?.(confirmedTopics.filter(topic => !buffered.overflow.has(topic)), channel.id); }
            catch (error) { report('mqtt-temperature-recovery-failed', error); }
          }
        });
      }
      if (teslamate && ownsTesla) {
        chargingTesla.setConnected(false, 'awaiting-subscription'); channel.teslaSubscriptionBuffer = []; channel.teslaSubscriptionOverflow = false;
        subscribe(teslamate.topic, { qos: 0 }, (error, granted) => {
          const buffered = channel.teslaSubscriptionBuffer; channel.teslaSubscriptionBuffer = null;
          if (channel.teslaSubscriptionOverflow || !Array.isArray(granted) || subscriptionRejected(teslamate.topic, error, granted)) {
            chargingTesla.setConnected(false, 'subscription-failed'); report('mqtt-teslamate-subscribe-error');
          } else {
            chargingTesla.setConnected(true);
            for (const message of buffered ?? []) {
              try { chargingTesla.receive(message.topic, message.payload, message.packet, message.at); }
              catch { report('mqtt-observation-rejected'); }
            }
          }
        });
      }
      if (--pending === 0) finishReadiness(channel);
    };
    const disconnected = () => {
      if (stopped) return;
      channel.connected = false; channel.ready = false; channel.generation++; vehicleSubscriptions.clear();
      channel.equipmentSubscriptionBuffer = null; channel.teslaSubscriptionBuffer = null;
      if (ownsTesla) chargingTesla?.setConnected(false);
      for (const route of engine.charging?.mqttRoutes() ?? []) if (routing.vehicleBroker(route) === channel.id)
        engine.charging.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected', broker: channel.id }, route.id);
      shelly?.setConnected(false, channel.id);
      for (const finish of [...channel.pendingPublications]) finish(new Error('MQTT disconnected'));
      for (const finish of [...channel.pendingSubscriptions]) finish(new Error('MQTT disconnected'));
      if (isPrimary) {
        h66?.setConnected(false); garage?.setConnected(false); garageSender?.setConnected(false); floorOverride.setConnected(false);
        if (!disconnectedRecorded) { markUnavailable(h66Signals, ['mqtt-disconnected']); disconnectedRecorded = true; }
      }
      report(isPrimary ? 'mqtt-offline' : 'mqtt-ha-offline');
    };
    client.on('connect', connectedHandler);
    client.on('error', () => report(isPrimary ? 'mqtt-error' : 'mqtt-ha-error'));
    client.on('offline', disconnected); client.on('close', disconnected);
    client.on('message', (topic, payload, packet = {}) => {
      if (!channel.connected || stopped || stopping) return;
      try {
        const vehicleSubscription = vehicleSubscriptions.get(topic);
        if (vehicleSubscription) {
          if (vehicleSubscription.messages) {
            if (vehicleSubscription.messages.length >= 32) vehicleSubscription.messages.shift();
            vehicleSubscription.messages.push({ payload: Buffer.from(payload.subarray(0, 4097)),
              packet: { retain: packet.retain, dup: packet.dup, qos: packet.qos, messageId: packet.messageId }, at: engine.clock() });
          } else if (vehicleSubscription.subscribed) engine.charging.receiveSoc(topic, payload, packet, engine.clock());
          return;
        }
        if (ownsTesla && chargingTesla) {
          if (channel.teslaSubscriptionBuffer && matchesTopic(topic, teslamate.topic)) {
            if (!channel.teslaSubscriptionOverflow && Buffer.byteLength(payload) <= 4096 && channel.teslaSubscriptionBuffer.length < 128)
              channel.teslaSubscriptionBuffer.push({ topic, payload: Buffer.from(payload),
                packet: { retain: packet.retain, dup: packet.dup, qos: packet.qos, messageId: packet.messageId }, at: engine.clock() });
            else { channel.teslaSubscriptionOverflow = true; channel.teslaSubscriptionBuffer = []; chargingTesla.setConnected(false, 'subscription-overflow'); }
            return;
          }
          if (chargingTesla.receive(topic, payload, packet, engine.clock())) return;
        }
        if (isPrimary) {
          if (floorOverride.ingest(topic, payload, packet, engine.clock())) return;
          if (garage?.receive(topic, payload, packet, engine.clock())) return;
          if (garageSender?.receive(topic, payload, packet, engine.clock())) return;
        }
        if (channel.equipmentSubscriptionBuffer) {
          const matched = equipmentTopics.filter(subscription => matchesTopic(topic, subscription));
          if (matched.length) {
            const buffered = channel.equipmentSubscriptionBuffer, bytes = Buffer.byteLength(payload);
            if (buffered.messages.length >= 256 || bytes > 65_536 || buffered.bytes + bytes > 262_144)
              for (const subscription of matched) buffered.overflow.add(subscription);
            else { buffered.messages.push({ topic, payload: Buffer.from(payload),
              packet: { retain: packet.retain, dup: packet.dup, qos: packet.qos, messageId: packet.messageId }, receivedAt: engine.clock() }); buffered.bytes += bytes; }
            return;
          }
        }
        if (shelly?.receive(topic, payload, packet, engine.clock(), channel.id)) return;
        if (!isPrimary) return;
      if (!decoder) return;
      if (topic.startsWith(`${deviceId}/HP/STATUS`) && !packet.retain) lastGatewayStatusAt = engine.clock();
      const decoderCheckpoint = decoder.checkpoint(), held = engine.ingestionCheckpoint?.();
      const controllerCheckpoint = h66.ingestionCheckpoint(), effects = [];
      const accept = () => {
        const decoded = decoder.decode({ topic, payload, receivedAt: engine.clock(), retained: packet.retain,
          dup: packet.dup, messageId: packet.messageId });
        if (!decoded || decoded.duplicate || decoded.signal === 'unknown') return;
        // A configured equipment or temperature source owns its logical signal.
        if (!equipmentOwnedSignals.includes(decoded.signal)) engine.ingest({ source: decoded.source, device: decoded.deviceId,
          signal: decoded.signal === 'integral' ? 'heating_integral' : decoded.signal,
          value: decoded.value, unit: decoded.unit ?? 'unknown', sourceTime: decoded.observedAt,
          receivedAt: decoded.receivedAt, quality: decoded.issues, raw: { register: decoded.register, value: decoded.raw,
            verified: Boolean(decoded.verification), verificationEvidence: decoded.verification,
            installationVerified: decoded.installationVerified,
            usableForControl: decoded.usableForControl, timeBasis: decoded.timeBasis,
            sensorMeasuredAt: decoded.sensorMeasuredAt, cached: decoded.cached,
            retained: decoded.retained, publicationMayUseGatewayCache: decoded.sourceAt == null,
            snapshotRequestedAt: lastSnapshotRequestedAt } });
        h66.ingest(decoded, { afterCommit: effect => effects.push(effect) });
      };
      try { if (store.transaction) store.transaction(accept); else accept(); }
      catch (error) {
        decoder.restore(decoderCheckpoint);
        if (held) engine.restoreIngestionCheckpoint(held);
        h66.restoreIngestionCheckpoint(controllerCheckpoint);
        throw error;
      }
      for (const effect of effects) effect();
      } catch { report('mqtt-observation-rejected'); }
    });
    channel.startIfConnected = () => { if (client.connected) connectedHandler(); };
  }
  const maintenance = h66 ? setInterval(() => {
    if (!primary.connected || stopped) return;
    requestSnapshot().catch(() => report('mqtt-snapshot-request-failed'));
    h66.reconcile({ now: engine.clock() }).catch(() => {});
  }, intervalMs) : null;
  maintenance?.unref?.();
  const shellyMaintenance = shelly ? setInterval(() => {
    if (stopped) return;
    try { shelly.tick(engine.clock()); } catch (error) { report('mqtt-shelly-capture-failed', error); }
  }, 5000) : null;
  shellyMaintenance?.unref?.();
  const floorMaintenance = setInterval(() => {
    if (!stopped && !stopping) floorOverride.tick(engine.clock()).catch(() => report('mqtt-floor-unavailable'));
  }, 30_000);
  floorMaintenance.unref?.();
  for (const channel of channels.values()) channel.startIfConnected();
  const brokerStatus = () => Object.fromEntries([...channels].map(([id, channel]) => [id, { connected: channel.connected,
    ready: channel.ready && (id !== 'primary' || !evse || evse.snapshot().mqtt.subscriptionStatus === 'subscribed') }]));
  if (equipment) equipment.brokerStatus = brokerStatus;
  return { h66, garage, floorOverride, equipment, ready, revoke: () => { for (const channel of channels.values()) channel.gate.revoke(); },
    status: () => ({ ...(h66?.status() ?? { connected: primary.connected, writesEnabled: false }), brokers: brokerStatus(), lastSnapshotRequestedAt, lastGatewayStatusAt }),
    ...(h66 ? { setPhase: args => h66.setPhase(args), writeSettings: (...args) => h66.writeSettings(...args),
      restore: args => h66.restore(args), test: args => h66.test(args), requestSnapshot } : {}),
    close: async ({ restore = true } = {}) => {
      if (stopped || stopping) return;
      // Native power confirmation still needs the normal message handler and
      // publication authority. Stop discovery before disabling either path.
      if (restore && canControl() && equipment) {
        try {
          const result = await equipment.restoreCaravanProbes({ resume: false });
          if (result.restorationPending) report('caravan-shutdown-restoration-pending');
        } catch { report('caravan-shutdown-restoration-pending'); }
      }
      if (restore && canControl()) await floorOverride.release({ reason: 'application-shutdown', now: engine.clock() }).catch(() => report('floor-shutdown-restoration-pending'));
      stopping = true;
      for (const channel of channels.values()) {
        channel.generation++; channel.vehicleSubscriptions.clear(); channel.equipmentSubscriptionBuffer = null; channel.teslaSubscriptionBuffer = null;
        for (const finish of [...channel.pendingSubscriptions, ...channel.readinessWaiters]) finish(new Error('MQTT closed'));
      }
      clearInterval(maintenance);
      clearInterval(shellyMaintenance);
      clearInterval(floorMaintenance);
      await floorOverride.close({ restore: false });
      // Physical release duties still guard heating while MQTT is unavailable.
      const floorUnavailable = createFloorOverride({ store, settings: config.floorPreheat });
      if (engine.floorOverride === floorOverride) engine.floorOverride = floorUnavailable;
      if (engine.executor?.floorOverride === floorOverride) engine.executor.floorOverride = floorUnavailable;
      await garage?.close();
      await garageSender?.close();
      if (garage) engine.garage?.setAdapter?.(null);
      shelly?.close();
      if (engine.equipment === equipment) engine.equipment = null;
      evse?.close();
      teslamate?.close();
      chargingTesla?.setConnected(false);
      if (engine.charging) {
        engine.charging.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
      }
      if (engine.teslamate === teslamate) engine.teslamate = null;
      if (restore && canControl() && h66 && primary.connected && settings.writeEnabled === true) {
        try { await h66.restore({ now: engine.clock(), reason: 'application-shutdown' }); }
        catch { report('h66-shutdown-restoration-pending'); }
      }
      stopped = true;
      for (const channel of channels.values()) {
        channel.gate.revoke(); channel.connected = false; channel.ready = false;
        for (const finish of [...channel.pendingPublications]) finish(new Error('MQTT closed'));
      }
      await h66?.close();
      await Promise.all([...channels.values()].map(({ client }) => new Promise(resolve => {
        const timer = setTimeout(() => { try { client.stream?.destroy(); } catch {} resolve(); }, 1000);
        try { client.end(true, {}, () => { clearTimeout(timer); resolve(); }); }
        catch { clearTimeout(timer); resolve(); }
      })));
    } };
}
