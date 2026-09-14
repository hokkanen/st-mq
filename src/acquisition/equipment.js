import { createHash } from 'node:crypto';
import { createShellyCapture } from './shelly.js';
import { createCaravanEnergy } from './shelly-energy.js';
import { equipmentSignature } from './equipment-config.js';
import { decodeMqttTemperature, temperatureRouteSignature } from './mqtt-temperature.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';

const scalar = value => typeof value === 'number' && Number.isFinite(value);
const property = (object, path) => path?.split('.').reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
const parse = payload => { try { return JSON.parse(payload); } catch { return payload; } };
const stateValue = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value
  : typeof value === 'string' ? ['on', 'open', 'true', '1'].includes(value.toLowerCase()) ? 1
    : ['off', 'closed', 'close', 'false', '0'].includes(value.toLowerCase()) ? 0 : null : null;
const sourceTime = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : null;
const canonicalTemperature = device => device.kind === 'temperature' && [...INDOOR_SIGNALS, 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'].includes(device.temperatureSignal);
const fail = message => new Error(`Equipment ${message}`);

/** One broker, explicit per-device protocol selection, independent capabilities.
 * Event-only contacts preserve last-reported values without inventing heartbeats. */
export function createEquipmentCapture({ engine, store, settings, publish, canControl = () => true, readbackTimeoutMs = 10_000,
  temperatureReportIntervalMs = DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
  temperatureReportGraceMs = DEFAULT_TEMPERATURE_REPORT_GRACE_MS, brokerIdentity = null, refreshSubscriptions = null, topicGroups = [] }) {
  const configured = settings.devices ?? [], enabled = configured.filter(row => row.enabled);
  const native = enabled.some(row => row.protocol === 'shelly') ? createShellyCapture({ engine, store,
    settings: { ...settings, devices: enabled.filter(row => row.protocol === 'shelly') }, publish, canControl, readbackTimeoutMs, brokerIdentity }) : null;
  let connected = false, closed = false, heatingBusy = false, sequence = 0;
  const devices = enabled.filter(row => row.protocol === 'mqtt').map(config => ({ ...config, readings: {}, mappings: config.readings,
    roomRouteSignature: config.kind === 'temperature' && INDOOR_SIGNALS.includes(config.temperatureSignal)
      ? temperatureRouteSignature({ brokerIdentity, topic: config.topic, statePath: config.mqtt.statePath, timestampPath: config.mqtt.timestampPath,
        mappings: config.readings.filter(mapping => mapping.signal === config.temperatureSignal) }) : null,
    online: null, bridgeOnline: null, liveSinceConnect: false, lastAt: null, heartbeatAt: null, waiters: new Set(), checks: new Set(), check: null, invalid: false,
    subscriptionStatus: 'unconfirmed', subscriptionRefresh: null, lastReceivedAt: null, lastLiveAt: null, lastRetainedAt: null }));
  const brokerDigest = createHash('sha256').update(JSON.stringify(brokerIdentity)).digest('hex');
  const temperatures = devices.filter(canonicalTemperature);
  for (const device of temperatures) {
    const garage = ['garage_temperature', 'garage_temperature_2'].includes(device.temperatureSignal);
    if (garage || INDOOR_SIGNALS.includes(device.temperatureSignal)) engine.configureTemperatureReports?.(device.temperatureSignal,
      { reportIntervalMs: garage ? settings.pollIntervalMs : temperatureReportIntervalMs,
        reportGraceMs: garage ? Math.max(0, device.maxAgeMs - settings.pollIntervalMs) : temperatureReportGraceMs });
  }
  const energy = new Map(devices.filter(row => row.metered).map(device => [device.id, createCaravanEnergy({ store,
    device: device.connection, maxGapMs: device.maxAgeMs || settings.maxAgeMs, source: 'mqtt-equipment',
    signal: `${device.id}_energy`, recordDevice: device.id, stateKey: `mqtt:equipment-energy:v1:${device.id}` })]));
  const definitions = device => [
    { signal: device.powerSignal ?? device.stateSignal ?? device.temperatureSignal,
      unit: device.kind === 'power' ? 'W' : device.kind === 'temperature' ? 'degC' : 'state',
      label: device.kind === 'power' ? 'Power' : device.kind === 'temperature' ? 'Temperature' : device.kind === 'door' ? 'Door' : 'Switch', required: true },
    ...(device.metered ? [{ signal: `${device.id}_power`, unit: 'kW', label: 'Power', path: 'power', required: true },
      { signal: `${device.id}_current`, unit: 'A', label: 'Current', path: 'current', required: true }] : []),
  ].map(row => device.mappings.find(mapping => mapping.signal === row.signal) ?? row).concat(device.mappings.filter(mapping =>
    ![device.powerSignal, device.stateSignal, device.temperatureSignal, ...(device.metered ? [`${device.id}_power`, `${device.id}_current`] : [])].includes(mapping.signal)));
  const identity = device => canonicalTemperature(device) ? { source: 'mqtt-temperature', device: device.temperatureSignal } : { source: 'mqtt-equipment', device: device.id };
  const age = device => INDOOR_SIGNALS.includes(device.temperatureSignal) && canonicalTemperature(device)
    ? temperatureReportIntervalMs + temperatureReportGraceMs : device.maxAgeMs;
  const readTopics = device => [...new Set([device.topic, ...device.mappings.map(row => row.topic),
    device.mqtt.availabilityTopic, device.mqtt.bridgeAvailabilityTopic, device.mqtt.heartbeatTopic].filter(Boolean))];
  const recheckMethod = device => device.mqtt.requestTopic ? 'request' : 'subscription';
  const topicDetails = device => [
    { role: device.kind === 'power' ? 'Power' : 'State', topic: device.topic, direction: 'subscribe' },
    ...device.mappings.filter(row => row.topic).map(row => ({ role: row.label, signal: row.signal, topic: row.topic, direction: 'subscribe' })),
    ...(device.mqtt.availabilityTopic ? [{ role: 'Availability', topic: device.mqtt.availabilityTopic, direction: 'subscribe' }] : []),
    ...(device.mqtt.bridgeAvailabilityTopic ? [{ role: 'Bridge availability', topic: device.mqtt.bridgeAvailabilityTopic, direction: 'subscribe' }] : []),
    ...(device.mqtt.heartbeatTopic ? [{ role: 'Heartbeat', topic: device.mqtt.heartbeatTopic, direction: 'subscribe' }] : []),
    ...(device.mqtt.requestTopic ? [{ role: 'Status request', topic: device.mqtt.requestTopic, direction: 'publish' }] : []),
    ...(device.mqtt.commandTopic ? [{ role: 'Switch command', topic: device.mqtt.commandTopic, direction: 'publish' }] : []),
  ];
  function record(device, definition, value, at, receivedAt, quality = [], raw = {}) {
    const previous = device.readings[definition.signal];
    if (scalar(at) && scalar(previous?.observedAt) && at < previous.observedAt) return false;
    const observation = { ...identity(device), signal: definition.signal, value, unit: definition.unit, sourceTime: at, receivedAt, quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status',
        ...(['door', 'power'].includes(device.kind) && device.maxAgeMs === 0 ? { eventOnly: true } : {}), ...raw,
        ...(device.roomRouteSignature ? { temperatureRouteSignature: device.roomRouteSignature } : {}) } };
    if (device.record !== false && definition.record !== false) {
      if (device.id === 'caravan' || ['heat_savings_active', 'garage_relay_active'].includes(definition.signal))
        engine.rememberObservation?.(observation, receivedAt);
      else {
        const result = engine.ingest(observation);
        if (device.roomRouteSignature && (result?.rejectedSourceTime || result?.reason === 'out-of-order-receipt')) return false;
      }
    }
    device.readings[definition.signal] = { value, unit: definition.unit, label: definition.label, observedAt: at, receivedAt, quality,
      ...(observation.raw.eventOnly ? { eventOnly: true } : {}), ...raw };
    if (device.kind === 'door' && value !== null) store.setState?.(`equipment:door:v1:${device.id}`, {
      signature: signature(device.id), reading: device.readings[definition.signal] });
    return true;
  }
  function unavailable(device, reason, receivedAt = engine.clock()) {
    device.liveSinceConnect = false; device.invalid = true;
    for (const waiter of [...device.waiters]) waiter.finish(fail('state confirmation unavailable'));
    for (const check of [...device.checks]) check.finish('unavailable');
    for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal]) {
      const previous = device.readings[definition.signal];
      record(device, definition, null, null, receivedAt, [reason]);
      if (device.kind === 'door' && previous?.value != null) device.readings[definition.signal] = {
        ...previous, unavailable: true, quality: [...new Set([...(previous.quality ?? []), reason, 'last-reported'])] };
    }
  }
  const fresh = (device, reading, now) => Boolean(reading && scalar(reading.value) && scalar(reading.observedAt)
    && reading.observedAt <= now && !reading.retained && !reading.unavailable
    && (!age(device) || now - reading.observedAt < age(device))
    && !reading.quality?.some(flag => /invalid|missing|retained|stale|future|disconnected|offline|unavailable/.test(flag)));
  const availabilityConfirmed = device => device.bridgeOnline !== false && (!device.mqtt.availabilityTopic || device.online === true);
  const healthy = (device, now) => connected && device.liveSinceConnect && availabilityConfirmed(device) && !device.invalid
    && !['failed', 'disconnected'].includes(device.subscriptionStatus)
    && (!device.mqtt.heartbeatMs || scalar(device.heartbeatAt) && now - device.heartbeatAt <= device.mqtt.heartbeatMs)
    && definitions(device).filter(row => row.required).every(definition => fresh(device, device.readings[definition.signal], now));
  function signature(id) {
    const config = enabled.find(row => row.id === id);
    if (!config) return null;
    const target = config.protocol === 'shelly' ? native.signature(id) : equipmentSignature(config);
    return target ? createHash('sha256').update(`${brokerDigest}:${target}`).digest('hex') : null;
  }
  for (const device of devices.filter(row => row.kind === 'door')) {
    const saved = store.getState?.(`equipment:door:v1:${device.id}`);
    if (saved?.signature === signature(device.id) && saved.reading) device.readings[device.stateSignal] = {
      ...saved.reading, unavailable: true, quality: [...new Set([...(saved.reading.quality ?? []), 'last-reported', 'awaiting-report'])] };
  }
  function receiveDevice(device, topic, body, packet, receivedAt) {
    const mapping = device.mqtt;
    device.lastReceivedAt = receivedAt;
    if (packet.retain) device.lastRetainedAt = receivedAt; else device.lastLiveAt = receivedAt;
    for (const check of device.checks) if (packet.retain) check.retainedReceived = true;
    if (topic === mapping.bridgeAvailabilityTopic) {
      if (body === 'offline') { device.bridgeOnline = false; device.online = null; unavailable(device, 'bridge-offline', receivedAt); }
      else if (body === 'online') {
        const needsReadback = device.bridgeOnline === false || !device.liveSinceConnect;
        device.bridgeOnline = true;
        // Bridge birth restores connectivity context, never the child reading.
        // Ask the explicit endpoint once subscriptions are ready to recover it.
        if (!packet.retain && needsReadback && device.subscriptionStatus === 'subscribed' && mapping.requestTopic && !device.checks.size)
          void api.recheck({ deviceId: device.id }).catch(() => {});
        completeChecks(device, receivedAt);
      }
      return;
    }
    if (topic === mapping.availabilityTopic) {
      if (body === mapping.offlinePayload) { device.online = false; unavailable(device, 'device-offline', receivedAt); }
      else if (body === mapping.onlinePayload && !packet.retain) { device.online = true; completeChecks(device, receivedAt); }
      return;
    }
    if (topic === mapping.heartbeatTopic) {
      if (!packet.retain) { device.heartbeatAt = receivedAt; completeChecks(device, receivedAt); }
      return;
    }
    if (packet.retain && canonicalTemperature(device) && device.liveSinceConnect) return;
    const input = parse(body), explicitTimestamp = mapping.timestampPath ? property(input, mapping.timestampPath) : input && typeof input === 'object' ? input.timestamp : undefined;
    const at = explicitTimestamp === undefined ? packet.retain ? null : receivedAt : sourceTime(explicitTimestamp);
    const invalidTime = Boolean(mapping.timestampPath && explicitTimestamp === undefined)
      || explicitTimestamp !== undefined && (!scalar(at) || at < 0 || at > receivedAt);
    const applicable = definitions(device).filter(definition => topic === (definition.topic ?? device.topic));
    if (!applicable.length) return;
    if (packet.retain && !canonicalTemperature(device)) {
      // A retained contact value can be useful context, never fresh state.
      if (device.kind === 'door' && !device.readings[device.stateSignal]) {
        const selected = mapping.statePath ? property(input, mapping.statePath) : input && typeof input === 'object' ? input.value : input;
        const value = stateValue(selected);
        if (value !== null) device.readings[device.stateSignal] = { value, unit: 'state', label: 'Door', observedAt: invalidTime ? null : at,
          receivedAt, retained: true, quality: ['retained', 'last-reported'] };
      }
      return;
    }
    if (invalidTime && !canonicalTemperature(device)) { unavailable(device, 'invalid-source-time', receivedAt); return; }
    let updated = false, invalid = false; const reported = new Set();
    if (canonicalTemperature(device) && topic === device.topic) {
      const selected = mapping.statePath || mapping.timestampPath ? { value: mapping.statePath ? property(input, mapping.statePath) : input?.value,
        ...(explicitTimestamp === undefined ? {} : { timestamp: explicitTimestamp }), ...(input?.unit ? { unit: input.unit } : {}) } : input;
      const periodic = INDOOR_SIGNALS.includes(device.temperatureSignal);
      const observation = decodeMqttTemperature({ signal: device.temperatureSignal, payload: mapping.statePath || mapping.timestampPath ? JSON.stringify(selected) : body, receivedAt, retained: packet.retain,
        reportIntervalMs: periodic ? temperatureReportIntervalMs : device.temperatureSignal === 'garage_temperature' ? settings.pollIntervalMs : null,
        reportGraceMs: periodic ? temperatureReportGraceMs : device.temperatureSignal === 'garage_temperature' ? Math.max(0, device.maxAgeMs - settings.pollIntervalMs) : 0 });
      if (!observation) { unavailable(device, 'invalid-temperature-message', receivedAt); return; }
      const definition = definitions(device)[0];
      updated = record(device, definition, observation.value, observation.sourceTime, receivedAt, observation.quality, observation.raw);
      if (updated && !packet.retain) reported.add(definition.signal);
      invalid = observation.value === null || observation.quality.some(flag => /invalid|missing|future|stale/.test(flag));
    } else for (const definition of applicable) {
      const selectedPath = definition.path ?? (definition.signal === device.powerSignal || definition.signal === device.stateSignal || definition.signal === device.temperatureSignal ? mapping.statePath : null);
      let value = selectedPath ? property(input, selectedPath) : input && typeof input === 'object' ? input.value : input;
      value = definition.unit === 'state' ? stateValue(value) : scalar(value) ? value : null;
      if (value !== null) value = value * (definition.scale ?? 1) + (definition.offset ?? 0);
      if (!scalar(value)) value = null;
      if (definition.signal === 'dhwr_power' && value !== null && (value < 0 || value * (definition.unit === 'kW' ? 1000 : 1) > 100000)) value = null;
      if (['degC', '°C'].includes(definition.unit) && (!scalar(value) || value < -60 || value > 150)) value = null;
      if (value === null && !definition.required && !device.readings[definition.signal]) continue;
      const accepted = record(device, definition, value, at, receivedAt, value === null ? ['invalid-value'] : []);
      if (accepted) reported.add(definition.signal);
      updated = accepted || updated;
      invalid ||= definition.required && value === null;
    }
    if (!updated) return;
    device.lastAt = receivedAt; device.liveSinceConnect = !packet.retain; device.invalid = invalid;
    const counter = device.mappings.find(mapping => mapping.key === 'energy_counter');
    if (device.metered && counter) {
      const reading = device.readings[counter.signal];
      if (topic === (counter.topic ?? device.topic) && fresh(device, reading, receivedAt) && reading.value >= 0)
        energy.get(device.id)?.receive(reading.value / (counter.unit === 'Wh' ? 1000 : 1), reading.observedAt);
    } else if (device.metered && topic === device.topic && scalar(input?.energy) && input.energy >= 0) energy.get(device.id)?.receive(input.energy, at);
    const main = device.readings[device.stateSignal];
    if (fresh(device, main, receivedAt)) for (const waiter of [...device.waiters])
      if (receivedAt >= waiter.at && main.observedAt >= waiter.at && main.value === Number(waiter.on)) {
        waiter.observed = true; if (waiter.published) waiter.finish();
      }
    for (const check of device.checks) if (receivedAt >= check.at) for (const signal of reported) check.reported.add(signal);
    completeChecks(device, receivedAt);
  }
  function completeChecks(device, now) {
    for (const check of [...device.checks]) if (check.ready && definitions(device).filter(row => row.required).every(row => check.reported.has(row.signal))) {
      if (healthy(device, now)) check.finish('available');
      else if (device.invalid) check.finish('needs-attention');
    }
  }
  async function switchDevice(device, on) {
    if (!device || typeof on !== 'boolean') throw fail('invalid switch selection');
    if (!connected || closed || !canControl()) throw fail('control authority unavailable');
    if (device.waiters.size) throw fail('switch operation already in progress');
    await new Promise((resolve, reject) => {
      let completed = false;
      const waiter = { id: ++sequence, at: engine.clock(), on, observed: false, published: false, finish: reason => {
        if (completed) return;
        if (!reason && (!canControl() || !connected || closed)) reason = fail('control authority unavailable');
        completed = true; clearTimeout(timer); device.waiters.delete(waiter); reason ? reject(reason) : resolve();
      } };
      const timer = setTimeout(() => waiter.finish(fail('state confirmation timed out; delivery unconfirmed')), readbackTimeoutMs);
      device.waiters.add(waiter);
      Promise.resolve().then(() => {
        if (!canControl() || !connected || closed) throw fail('control authority unavailable');
        return publish(device.mqtt.commandTopic, on ? device.mqtt.onPayload : device.mqtt.offPayload, { qos: 1, retain: false });
      }).then(() => { waiter.published = true; if (waiter.observed) waiter.finish(); }, () => waiter.finish(fail('switch publication failed; delivery unconfirmed')));
    });
    return { confirmed: true, status: 'confirmed', deviceId: device.id, on, sent: true, acknowledgement: 'mqtt-live-state' };
  }
  const api = {
    topics: [...new Set([...(native?.topics ?? []), ...devices.flatMap(readTopics)])],
    ownsGarage: settings.ownsGarage === true, hasHeating: enabled.some(device => device.controlsHeat), signature,
    setConnected(value) {
      connected = value; native?.setConnected(value);
      for (const device of devices) {
        device.subscriptionRefresh = null;
        device.subscriptionStatus = value ? 'unconfirmed' : 'disconnected';
        if (!value) unavailable(device, 'mqtt-disconnected'); else { device.online = null; device.bridgeOnline = null; device.liveSinceConnect = false; }
      }
    },
    confirmSubscriptions(topics) {
      if (!connected || closed) return;
      const confirmed = new Set(topics);
      const requests = [];
      for (const device of devices) if (readTopics(device).every(topic => confirmed.has(topic))) {
        if (device.subscriptionStatus !== 'subscribed' && device.mqtt.requestTopic) requests.push(device.id);
        device.subscriptionStatus = 'subscribed';
      }
      for (const device of devices.filter(row => row.roomRouteSignature && !row.controlsSwitch && !row.controlsHeat)) {
        if (device.bridgeOnline === false) continue;
        const requiredTopics = [device.topic, device.mqtt.availabilityTopic, device.mqtt.bridgeAvailabilityTopic, device.mqtt.heartbeatTopic,
          ...device.mappings.filter(mapping => mapping.required).map(mapping => mapping.topic)].filter(Boolean);
        if (!requiredTopics.every(topic => confirmed.has(topic))) continue;
        const recovered = engine.confirmTemperatureConnection?.(device.temperatureSignal, {
          reportIntervalMs: temperatureReportIntervalMs, reportGraceMs: temperatureReportGraceMs, routeSignature: device.roomRouteSignature,
        });
        if (!recovered || recovered.signal !== device.temperatureSignal || recovered.source !== 'mqtt-temperature'
          || recovered.device !== device.temperatureSignal || !scalar(recovered.value)
          || !scalar(recovered.sourceTime) || !scalar(recovered.receivedAt) || recovered.receivedAt > engine.clock()
          || recovered.sourceTime > recovered.receivedAt || engine.clock() >= recovered.sourceTime + age(device)) continue;
        const previous = device.readings[device.temperatureSignal];
        if (previous && scalar(previous.observedAt) && previous.observedAt > recovered.sourceTime) continue;
        const definition = definitions(device)[0];
        device.readings[device.temperatureSignal] = { value: recovered.value, unit: recovered.unit, label: definition.label,
          observedAt: recovered.sourceTime, receivedAt: recovered.receivedAt, quality: recovered.quality ?? [],
          ...recovered.raw, reportExpiresAt: recovered.reportExpiresAt };
        device.lastAt = recovered.receivedAt; device.liveSinceConnect = true; device.invalid = false;
      }
      // A successful subscription does not restore a change-only publisher's
      // current state. Ask its explicitly configured endpoint after all of the
      // response topics are subscribed, including on broker reconnection.
      for (const deviceId of requests) void api.recheck({ deviceId }).catch(() => {});
    },
    subscriptionFailed(topic) {
      native?.subscriptionFailed(topic);
      for (const device of devices) if (readTopics(device).includes(topic)) {
        device.subscriptionStatus = 'failed'; unavailable(device, 'mqtt-subscription-failed');
      }
    },
    receive(topic, payload, packet = {}, receivedAt = engine.clock()) {
      if (native?.receive(topic, payload, packet, receivedAt)) return true;
      const selected = devices.filter(device => readTopics(device).includes(topic));
      if (!selected.length) return false;
      if (!connected || closed || packet.dup) return true;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      for (const device of selected) receiveDevice(device, topic, body, packet, receivedAt);
      return true;
    },
    tick(now = engine.clock()) {
      if (closed) return;
      native?.tick(now); for (const accumulator of energy.values()) accumulator.tick(now);
      for (const device of devices) if (device.liveSinceConnect && (device.mqtt.heartbeatMs && scalar(device.heartbeatAt) && now - device.heartbeatAt > device.mqtt.heartbeatMs
        || age(device) > 0 && now - device.lastAt >= age(device))) unavailable(device, 'missing-report');
    },
    async recheck({ deviceId } = {}) {
      if (deviceId && !enabled.some(row => row.id === deviceId)) throw fail('unknown device');
      const tasks = [];
      if (native && (!deviceId || enabled.some(row => row.id === deviceId && row.protocol === 'shelly'))) tasks.push(native.recheck({ deviceId }));
      for (const device of devices.filter(row => !deviceId || row.id === deviceId)) tasks.push(new Promise(resolve => {
        let completed = false;
        const method = recheckMethod(device);
        const check = { at: engine.clock(), reported: new Set(), retainedReceived: false, ready: false, finish: status => {
          if (completed) return; completed = true; clearTimeout(timer); device.checks.delete(check);
          device.check = { checking: false, startedAt: check.at, checkedAt: engine.clock(), status, method,
            subscriptionStatus: device.subscriptionStatus, retainedReceived: check.retainedReceived }; resolve();
        } };
        const timer = setTimeout(() => {
          if (device.subscriptionStatus === 'refreshing') {
            device.subscriptionStatus = 'failed';
            try { unavailable(device, 'mqtt-subscription-failed'); }
            catch { check.finish('unavailable'); }
          } else check.finish(method === 'request' ? 'timeout' : 'unavailable');
        }, readbackTimeoutMs);
        device.checks.add(check); device.check = { checking: true, startedAt: check.at, status: 'checking', method };
        if (!connected || closed) { check.finish('unavailable'); return; }
        Promise.resolve().then(async () => {
          if (refreshSubscriptions) {
            device.subscriptionStatus = 'refreshing'; device.subscriptionRefresh = check;
            try { await refreshSubscriptions(readTopics(device)); }
            catch {
              if (device.subscriptionRefresh === check && connected && !closed) {
                device.subscriptionRefresh = null;
                device.subscriptionStatus = 'failed'; unavailable(device, 'mqtt-subscription-failed');
              }
              throw fail('subscription refresh failed');
            }
            // Retained offline can finish the device check before SUBACK. The
            // subscription still succeeded and must allow later bridge recovery.
            if (device.subscriptionRefresh === check && connected && !closed) {
              device.subscriptionRefresh = null;
              if (device.subscriptionStatus === 'refreshing') device.subscriptionStatus = 'subscribed';
            }
            if (completed || !connected || closed) return;
          }
          if (completed || !connected || closed) return;
          // Reports replayed by subscription refresh are not replies to a later request.
          if (method === 'request') {
            check.reported.clear(); check.at = engine.clock();
            await publish(device.mqtt.requestTopic, device.mqtt.requestPayload, { qos: 1, retain: false });
          }
          check.ready = true; completeChecks(device, engine.clock());
          if (method === 'subscription') check.finish(healthy(device, engine.clock()) ? 'last-reported'
            : check.retainedReceived ? 'retained-only' : 'listening');
        }).catch(() => check.finish('unavailable'));
      }));
      await Promise.all(tasks); return api.status();
    },
    async setSwitch(deviceId, on) {
      const config = enabled.find(row => row.id === deviceId);
      if (!config?.controlsSwitch) throw fail('switch control is not configured');
      return config.protocol === 'shelly' ? native.setSwitch(deviceId, on) : switchDevice(devices.find(row => row.id === deviceId), on);
    },
    async publishHeating(commands) {
      if (!Array.isArray(commands) || !commands.length || commands.some(command => !['heatoff', 'heaton15'].includes(command))) throw fail('invalid heating command');
      if (heatingBusy) throw fail('heating operation already in progress');
      if (!connected || closed || !canControl()) throw fail('control authority unavailable');
      heatingBusy = true;
      try {
        if (native?.hasHeating) await native.publishHeating(commands);
        for (const command of commands) for (const device of devices.filter(row => row.controlsHeat)) await switchDevice(device, command === 'heatoff' ? device.reductionOn : !device.reductionOn);
        return { confirmed: true, status: 'confirmed', sent: true, commands: [...commands], acknowledged: commands.length, acknowledgement: 'equipment-state-readback' };
      } finally { heatingBusy = false; }
    },
    status(now = engine.clock()) {
      const nativeStatus = native?.status(now), rows = [...(nativeStatus?.devices ?? []), ...devices.map(device => ({ id: device.id, role: device.id,
        label: device.label, area: device.area, kind: device.kind, source: 'MQTT', connection: device.connection, available: healthy(device, now),
        observedAt: device.lastAt, controls: { switch: device.controlsSwitch, tariff: device.controlsHeat }, check: device.check,
        topics: topicDetails(device), recheck: { method: recheckMethod(device), requestSupported: Boolean(device.mqtt.requestTopic),
          description: device.mqtt.requestTopic ? 'Refresh subscriptions and send the configured status request.'
            : 'Refresh subscriptions. This publisher has no configured status request; live values arrive on its next report.' },
        mqttStatus: { subscriptionStatus: device.subscriptionStatus, lastReceivedAt: device.lastReceivedAt,
          lastLiveAt: device.lastLiveAt, lastRetainedAt: device.lastRetainedAt },
        readings: Object.fromEntries(Object.entries(device.readings).map(([signal, reading]) => [signal,
          { ...reading, stale: !connected || !device.liveSinceConnect || !availabilityConfirmed(device) || !fresh(device, reading, now)
            || Boolean(device.mqtt.heartbeatMs && (!scalar(device.heartbeatAt) || now - device.heartbeatAt > device.mqtt.heartbeatMs)) }])),
        ...(energy.has(device.id) ? { energy: energy.get(device.id).status(now) } : {}) }))];
      return { configured: configured.length > 0, connected, checking: rows.some(row => row.check?.checking),
        topicGroups,
        lastCheckedAt: Math.max(0, ...rows.map(row => row.check?.checkedAt ?? 0)) || null,
        devices: configured.map(config => rows.find(row => row.id === config.id) ?? { id: config.id, role: config.id, label: config.label,
          area: config.area, kind: config.kind, source: config.source, connection: config.connection, enabled: false, available: false,
          readings: {}, controls: { switch: false, tariff: false }, check: { checking: false, status: 'disabled' } }) };
    },
    close() { if (closed) return; api.setConnected(false); native?.close(); closed = true; },
  };
  return api;
}
