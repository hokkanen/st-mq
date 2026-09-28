import { createMqttAdmission } from './mqtt-admission.js';
import { createMqttReception } from './mqtt-reception.js';
import { createHash } from 'node:crypto';
import { createShellyCapture } from './shelly.js';
import { createCaravanEnergy } from './shelly-energy.js';
import { equipmentSignature, equipmentMeterIdentity } from './equipment-config.js';
import { decodeMqttTemperature, temperatureRouteSignature } from './mqtt-temperature.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';
import { Recorder } from '../storage/recorder.js';

const scalar = value => typeof value === 'number' && Number.isFinite(value);
const property = (object, path) => path?.split('.').reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
const parse = payload => { try { return JSON.parse(payload); } catch { return payload; } };
const stateValue = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value
  : typeof value === 'string' ? ['on', 'open', 'true', '1'].includes(value.toLowerCase()) ? 1
    : ['off', 'closed', 'close', 'false', '0'].includes(value.toLowerCase()) ? 0 : null : null;
const sourceTime = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : null;
const canonicalTemperature = device => device.kind === 'temperature' && [...INDOOR_SIGNALS, 'garage_temperature', 'garage_temperature_2', 'outdoor_temperature'].includes(device.temperatureSignal);
const fail = message => new Error(`Equipment ${message}`);
const DEHUMIDIFIER_SETTINGS = {
  power: ['off', 'on'], mode: ['auto', 'dehumidify', 'heater', 'fan_only'],
  fanSpeed: ['low', 'medium', 'high', 'auto'], swing: ['fixed_90', 'fixed_45', 'oscillate'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5),
};
const RUNNING_STATES = ['off', 'low', 'medium', 'high', 'auto'];
const runningStateLabels = Object.fromEntries(RUNNING_STATES.map((state, index) => [index, state[0].toUpperCase() + state.slice(1)]));
const dehumidifierState = input => Object.fromEntries(Object.entries(DEHUMIDIFIER_SETTINGS)
  .map(([key, allowed]) => [key, allowed.includes(input?.[key]) ? input[key] : null]));
function dehumidifierCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.entries(input).some(([key, values]) => !Object.hasOwn(DEHUMIDIFIER_SETTINGS, key)
      || !Array.isArray(values) || !values.length || new Set(values).size !== values.length
      || values.some(value => !DEHUMIDIFIER_SETTINGS[key].includes(value)))) return {};
  return Object.fromEntries(Object.entries(input).map(([key, values]) => [key, [...values]]));
}
const dehumidifierMetadata = (device, value) => ({ stateLabels: runningStateLabels, runningState: RUNNING_STATES[value] ?? null,
  maxAgeMs: device.maxAgeMs, reportIntervalMs: device.maxAgeMs, reportGraceMs: 0 });
const defaultTemperatureControl = { enabled: true, offAtC: 1, onAtC: 2 };
const validDehumidifierIdentity = identity => typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity);
const validTemperatureControl = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 3 && Object.keys(value).every(key => Object.hasOwn(defaultTemperatureControl, key))
  && typeof value.enabled === 'boolean' && [value.offAtC, value.onAtC].every(temperature => scalar(temperature)
    && temperature >= -10 && temperature <= 30 && Math.abs(temperature * 10 - Math.round(temperature * 10)) < 1e-8)
  && value.onAtC - value.offAtC >= 0.5 - 1e-8;

/** One broker, explicit per-device protocol selection, independent capabilities.
 * Event-only contacts preserve last-reported values without inventing heartbeats. */
export function createEquipmentCapture({ engine, store, settings, publish, canControl = () => true, readbackTimeoutMs = 10_000,
  temperatureReportIntervalMs = DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
  temperatureReportGraceMs = DEFAULT_TEMPERATURE_REPORT_GRACE_MS, brokerIdentity = null, refreshSubscriptions = null, topicGroups = [] }) {
  const configured = settings.devices ?? [], enabled = configured.filter(row => row.enabled);
  const feedbackRecorder = enabled.some(row => row.id === 'dhwr')
    ? engine.recorder ?? new Recorder(store, { clock: engine.clock }) : null;
  const native = enabled.some(row => row.protocol === 'shelly') ? createShellyCapture({ engine, store,
    settings: { ...settings, devices: enabled.filter(row => row.protocol === 'shelly') }, publish, canControl, readbackTimeoutMs, brokerIdentity }) : null;
  let connected = false, closed = false, heatingBusy = false, sequence = 0;
  const devices = enabled.filter(row => row.protocol === 'mqtt').map(config => ({ ...config, readings: {}, mappings: config.readings,
    roomRouteSignature: config.kind === 'temperature' && INDOOR_SIGNALS.includes(config.temperatureSignal)
      ? temperatureRouteSignature({ brokerIdentity, topic: config.topic, statePath: config.mqtt.statePath, timestampPath: config.mqtt.timestampPath,
        mappings: config.readings.filter(mapping => mapping.signal === config.temperatureSignal) }) : null,
    online: null, bridgeOnline: null, liveSinceConnect: false, lastAt: null, heartbeatAt: null, waiters: new Set(), checks: new Set(), check: null, invalid: false,
    subscriptionStatus: 'unconfirmed', subscriptionRefresh: null, lastReceivedAt: null, lastLiveAt: null, lastRetainedAt: null,
    coverOperation: null, dehumidifierState: dehumidifierState(null), dehumidifierReport: null, dehumidifierOperation: null,
    temperatureGuard: { settings: { ...defaultTemperatureControl }, demand: false, managed: false,
      lastAttemptAt: null, lastAttemptPower: null, recordingSince: null,
      matchingSince: null, matchedAirAt: null, matchedApplianceAt: null, qualified: false, boundIdentity: null }, recordingLocation: false }));
  const admission = createMqttAdmission();
  const brokerDigest = createHash('sha256').update(JSON.stringify(brokerIdentity)).digest('hex');
  const temperatures = devices.filter(canonicalTemperature);
  for (const device of temperatures) {
    const garage = ['garage_temperature', 'garage_temperature_2'].includes(device.temperatureSignal);
    if (garage || INDOOR_SIGNALS.includes(device.temperatureSignal)) engine.configureTemperatureReports?.(device.temperatureSignal,
      { reportIntervalMs: garage ? settings.pollIntervalMs : temperatureReportIntervalMs,
        reportGraceMs: garage ? Math.max(0, device.maxAgeMs - settings.pollIntervalMs) : temperatureReportGraceMs });
  }
  const energy = new Map(devices.filter(row => row.metered).map(device => [device.id, createCaravanEnergy({ store, recorder: engine.recorder,
    device: equipmentMeterIdentity({ ...device, readings: device.mappings }, { brokerIdentity }),
    maxGapMs: device.maxAgeMs || settings.maxAgeMs, source: 'mqtt-equipment',
    signal: `${device.id}_energy`, recordDevice: device.id, stateKey: `mqtt:equipment-energy:v1:${device.id}` })]));
  const reception = createMqttReception({ store, engine, admission, devices, meters: energy });
  const definitions = device => [
    { signal: device.powerSignal ?? device.stateSignal ?? device.temperatureSignal,
      unit: device.kind === 'power' ? 'W' : device.kind === 'temperature' ? 'degC' : 'state',
      label: device.kind === 'dehumidifier' ? 'Running state' : device.kind === 'power' ? 'Power' : device.kind === 'temperature' ? 'Temperature' : device.kind === 'door' ? 'Door' : 'Switch', required: true },
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
    ...(device.mqtt.commandTopic ? [{ role: device.kind === 'dehumidifier' ? 'Dehumidifier command' : device.kind === 'door' ? 'Door command' : 'Switch command', topic: device.mqtt.commandTopic, direction: 'publish' }] : []),
  ];
  function record(device, definition, value, at, receivedAt, quality = [], raw = {}) {
    const previous = device.readings[definition.signal];
    if (scalar(at) && scalar(previous?.observedAt) && at < previous.observedAt) return false;
    const repeatedSource = scalar(at) && at === previous?.observedAt && previous.value !== null && raw.timeBasis === 'source-measured';
    if (repeatedSource && value !== null && value !== previous.value) return false;
    const observation = { ...identity(device), signal: definition.signal, value, unit: definition.unit, sourceTime: at, receivedAt, quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status',
        ...(device.kind === 'dehumidifier' ? dehumidifierMetadata(device, value) : {}),
        ...(['caravan_temperature', 'caravan_humidity'].includes(definition.signal) && device.maxAgeMs > 0
          ? { reportIntervalMs: device.maxAgeMs, reportGraceMs: 0 } : {}),
        ...(['door', 'power'].includes(device.kind) && device.maxAgeMs === 0 ? { eventOnly: true } : {}), ...raw,
        ...(device.roomRouteSignature ? { temperatureRouteSignature: device.roomRouteSignature } : {}) } };
    // A contact and its availability may arrive in either order. Keep the
    // candidate here, then publish it to the model only when both are live.
    if (device.record !== false && definition.record !== false && !(['door', 'dehumidifier'].includes(device.kind) && value !== null)) {
      if (device.id === 'caravan' || definition.signal === 'garage_relay_active')
        engine.rememberObservation?.(observation, receivedAt);
      else {
        const result = engine.ingest(observation);
        if (canonicalTemperature(device) && (result?.rejectedSourceTime || result?.reason === 'out-of-order-receipt')) return false;
      }
    }
    device.readings[definition.signal] = { value, unit: definition.unit, label: definition.label, observedAt: at, receivedAt, quality,
      revision: repeatedSource ? previous.revision : ++sequence,
      ...(observation.raw.eventOnly ? { eventOnly: true } : {}),
      ...(device.kind === 'dehumidifier' ? { stateLabels: runningStateLabels } : {}), ...raw };
    // The pump's measured load is its operational ON/OFF feedback. Keep this
    // compact state history even when the raw watts are configured live-only.
    const powerFeedback = device.kind === 'power' || device.mappings.some(row => row.signal === 'dhwr_power');
    if (device.id === 'dhwr' && definition.signal === (powerFeedback ? 'dhwr_power' : 'dhwr_active')) {
      feedbackRecorder.record({ source: 'mqtt-equipment', device: 'dhwr', signal: 'dhwr_active',
        value: value === null ? null : Number(value > 0), unit: 'state', sourceTime: at ?? receivedAt, receivedAt, quality,
        raw: { basis: powerFeedback ? 'measured-power' : 'reported-switch', eventOnly: device.maxAgeMs === 0,
          timeBasis: observation.raw.timeBasis,
          reportIntervalMs: device.maxAgeMs, reportGraceMs: 0,
          maxAgeMs: device.maxAgeMs, verified: value !== null } });
    }
    if (device.kind === 'door' && value !== null) store.setState?.(`equipment:door:v1:${device.id}`, {
      signature: signature(device.id), reading: device.readings[definition.signal] });
    return true;
  }
  function unavailable(device, reason, receivedAt = engine.clock()) {
    device.liveSinceConnect = false; device.invalid = true;
    energy.get(device.id)?.unavailable?.(receivedAt, reason);
    if (device.coverOperation && ['publishing', 'published'].includes(device.coverOperation.status)) {
      device.coverOperation.status = 'unconfirmed';
      device.coverOperation.error = 'Door feedback became unavailable. Check its live state.';
    }
    if (device.dehumidifierOperation && ['publishing', 'published'].includes(device.dehumidifierOperation.status)) {
      device.dehumidifierOperation.status = 'unconfirmed';
      device.dehumidifierOperation.error = 'Dehumidifier feedback became unavailable. Check its live state.';
    }
    for (const waiter of [...device.waiters]) reception.afterCommit(() => waiter.finish(fail('state confirmation unavailable')));
    for (const check of [...device.checks]) reception.afterCommit(() => check.finish('unavailable'));
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
  const fieldFresh = (device, field, now) => {
    const at = device.dehumidifierReport?.fieldTimestamps[field];
    return scalar(at) && at >= 0 && at <= now && now - at < device.maxAgeMs;
  };
  const powerFeedbackReady = (device, now) => connected && !closed && device.liveSinceConnect && availabilityConfirmed(device)
    && device.subscriptionStatus === 'subscribed' && validDehumidifierIdentity(device.dehumidifierReport?.identity)
    && fieldFresh(device, 'power', now) && ['on', 'off'].includes(device.dehumidifierState.power)
    && (!device.mqtt.heartbeatMs || scalar(device.heartbeatAt) && now - device.heartbeatAt <= device.mqtt.heartbeatMs);
  const healthy = (device, now) => connected && device.liveSinceConnect && availabilityConfirmed(device) && !device.invalid
    && !['failed', 'disconnected'].includes(device.subscriptionStatus)
    && (device.kind !== 'dehumidifier' || device.subscriptionStatus === 'subscribed'
      && validDehumidifierIdentity(device.dehumidifierReport?.identity))
    && (device.kind !== 'dehumidifier' || fieldFresh(device, 'power', now)
      && (device.dehumidifierState.power === 'off' || fieldFresh(device, 'fanSpeed', now)))
    && (!device.mqtt.heartbeatMs || scalar(device.heartbeatAt) && now - device.heartbeatAt <= device.mqtt.heartbeatMs)
    && definitions(device).filter(row => row.required).every(definition => fresh(device, device.readings[definition.signal], now));
  function temperatureGuardStatus(device, now) {
    if (!device.temperatureControl) return null;
    const sensor = devices.find(row => row.id === device.temperatureControl.sensorDeviceId);
    const air = sensor?.readings.caravan_temperature, humidity = sensor?.readings.caravan_humidity;
    const report = device.dehumidifierReport;
    const airFresh = sensor && healthy(sensor, now) && fresh(sensor, air, now) && fresh(sensor, humidity, now)
      && humidity.value >= 0 && humidity.value <= 100;
    const temperatureCompared = report?.temperature !== null && report?.temperature !== undefined;
    const identityKnown = validDehumidifierIdentity(report?.identity);
    const applianceReadingsFresh = identityKnown && healthy(device, now) && fieldFresh(device, 'humidity', now)
      && scalar(report?.humidity) && report.humidity >= 0 && report.humidity <= 100
      && (!temperatureCompared || fieldFresh(device, 'temperature', now) && scalar(report.temperature)
        && report.temperature >= -60 && report.temperature <= 70);
    const readingsMatch = Boolean(airFresh && applianceReadingsFresh
      && (!temperatureCompared || Math.abs(air.value - report.temperature) <= 4)
      && Math.abs(humidity.value - report.humidity) <= 10);
    const policy = device.temperatureGuard.settings;
    return { configured: true, ...policy, canEdit: !closed && canControl() && validDehumidifierIdentity(device.temperatureGuard.boundIdentity),
      sensorDeviceId: device.temperatureControl.sensorDeviceId,
      temperatureC: airFresh ? air.value : null, humidity: airFresh ? humidity.value : null,
      applianceTemperatureC: fieldFresh(device, 'temperature', now) && scalar(report?.temperature) ? report.temperature : null,
      applianceHumidity: fieldFresh(device, 'humidity', now) && scalar(report?.humidity) ? report.humidity : null,
      comparison: temperatureCompared ? 'temperature-humidity' : 'humidity',
      maxTemperatureDifferenceC: 4, maxHumidityDifference: 10, readingsMatch,
      qualified: readingsMatch && device.temperatureGuard.qualified,
      matchingForMs: readingsMatch && scalar(device.temperatureGuard.matchingSince) ? now - device.temperatureGuard.matchingSince : 0,
      requiredMatchingMs: 120_000,
      recording: readingsMatch && device.temperatureGuard.qualified && device.record !== false && scalar(device.temperatureGuard.recordingSince)
        && device.readings[device.stateSignal].observedAt >= device.temperatureGuard.recordingSince,
      desiredPower: policy.enabled ? device.temperatureGuard.demand ? 'on' : 'off' : null,
      reason: !healthy(device, now) ? 'appliance-unavailable' : !airFresh ? 'air-unavailable'
        : !identityKnown ? 'identity-unavailable' : !applianceReadingsFresh ? 'appliance-readings-unavailable' : !readingsMatch ? 'readings-mismatch'
          : !device.temperatureGuard.qualified ? 'checking-readings' : !policy.enabled ? 'disabled'
          : air.value <= policy.offAtC ? 'cold' : air.value >= policy.onAtC ? 'warm' : 'hysteresis' };
  }
  function recordDehumidifierLocation(device, now) {
    const location = temperatureGuardStatus(device, now);
    if (!location) return true;
    const state = device.temperatureGuard;
    if (!location.readingsMatch) {
      state.matchingSince = null; state.matchedAirAt = null; state.matchedApplianceAt = null; state.qualified = false;
    } else {
      const sensor = devices.find(row => row.id === device.temperatureControl.sensorDeviceId);
      const airAt = Math.min(sensor.readings.caravan_temperature.observedAt, sensor.readings.caravan_humidity.observedAt);
      const applianceAt = device.dehumidifierReport.fieldTimestamps.humidity;
      if (state.matchingSince === null) state.matchingSince = now;
      if (state.matchedAirAt === null || airAt > state.matchedAirAt && applianceAt > state.matchedApplianceAt) {
        if (state.matchedAirAt !== null && now - state.matchingSince >= 120_000) state.qualified = true;
        state.matchedAirAt = airAt; state.matchedApplianceAt = applianceAt;
      }
    }
    const qualified = location.readingsMatch && state.qualified;
    if (!qualified && device.recordingLocation) {
      if (device.record !== false) engine.ingest({ ...identity(device), signal: device.stateSignal, value: null, unit: 'state',
        sourceTime: null, receivedAt: now, quality: ['location-unconfirmed'],
        raw: { timeBasis: 'availability-transition', ...dehumidifierMetadata(device, null) } });
      if (device.readings[device.stateSignal]) device.readings[device.stateSignal].availabilityConfirmed = false;
    }
    if (!qualified) state.recordingSince = null;
    else if (!device.recordingLocation) state.recordingSince = now;
    device.recordingLocation = qualified;
    // After a mismatch, only a new appliance observation may resume history.
    // A later BLU reading cannot move an old appliance sample past the gap.
    return qualified && device.readings[device.stateSignal].observedAt >= state.recordingSince;
  }
  function controlTemperature(device, now) {
    const guard = temperatureGuardStatus(device, now);
    if (!guard?.enabled) return;
    const state = device.temperatureGuard;
    if (guard.qualified) {
      if (!closed && canControl()) state.managed = true;
      if (guard.temperatureC <= guard.offAtC) state.demand = false;
      else if (guard.temperatureC >= guard.onAtC) state.demand = true;
    } else state.demand = false;
    // Loss of room evidence stops an appliance previously managed here. A
    // newly discovered appliance elsewhere receives no commands.
    const value = state.demand ? 'on' : 'off';
    if (!state.managed || !(value === 'off' ? powerFeedbackReady(device, now) : healthy(device, now)) || !canControl() || closed) return;
    const operation = device.dehumidifierOperation;
    const pending = ['publishing', 'published'].includes(operation?.status);
    const uncertainOn = operation?.setting === 'power' && operation.value === 'on' && operation.status !== 'observed';
    if (pending && (value !== 'off' || operation.setting === 'power' && operation.value === 'off')) return;
    if (device.dehumidifierState.power === value && !(value === 'off' && uncertainOn) || state.lastAttemptPower === value
      && state.lastAttemptAt !== null && now - state.lastAttemptAt < 30_000) return;
    state.lastAttemptAt = now; state.lastAttemptPower = value;
    reception.afterCommit(() => {
      const current = temperatureGuardStatus(device, engine.clock());
      if (!current?.enabled || value === 'on' && (!current.qualified || !device.temperatureGuard.demand)) return;
      void commandDehumidifier(device, 'power', value, 'temperature').catch(() => {});
    });
  }
  function confirmDoor(device, now) {
    if (device.kind !== 'door' || !healthy(device, now)) return;
    for (const definition of definitions(device)) {
      const reading = device.readings[definition.signal];
      if (!fresh(device, reading, now) || reading.availabilityConfirmed) continue;
      reading.availabilityConfirmed = true; reading.confirmedAt = now;
      if (device.record !== false && definition.record !== false) engine.ingest({ ...identity(device),
        signal: definition.signal, value: reading.value, unit: reading.unit, sourceTime: reading.observedAt,
        receivedAt: now, quality: reading.quality,
        raw: { timeBasis: 'mqtt-live-status', ...(device.maxAgeMs === 0 ? { eventOnly: true } : {}),
          availabilityConfirmed: true, confirmedAt: now } });
      if (definition.signal === device.stateSignal) store.setState?.(`equipment:door:v1:${device.id}`, {
        signature: signature(device.id), reading });
    }
    const operation = device.coverOperation, main = device.readings[device.stateSignal];
    if (operation && operation.action !== 'stop' && !['failed', 'observed'].includes(operation.status)
      && main.receivedAt >= operation.requestedAt && main.observedAt >= operation.requestedAt
      && main.coverState === (operation.action === 'open' ? 'open' : 'closed')) {
      operation.observedAt = main.observedAt;
      if (operation.acknowledgedAt !== undefined) { operation.status = 'observed'; delete operation.error; }
    }
  }
  function confirmDehumidifier(device, now) {
    const located = recordDehumidifierLocation(device, now);
    if (!healthy(device, now)) return;
    const reading = device.readings[device.stateSignal];
    if (located && !reading.availabilityConfirmed) {
      reading.availabilityConfirmed = true;
      const sensor = devices.find(row => row.id === device.temperatureControl?.sensorDeviceId);
      const report = device.dehumidifierReport;
      const applianceDeadline = Math.min(...['power', ...(device.dehumidifierState.power === 'on' ? ['fanSpeed'] : [])]
        .map(field => report.fieldTimestamps[field] + device.maxAgeMs));
      const locationDeadline = sensor ? Math.min(...['caravan_temperature', 'caravan_humidity']
        .map(signal => sensor.readings[signal].observedAt + age(sensor)), applianceDeadline,
        report.fieldTimestamps.humidity + device.maxAgeMs,
        ...(report.temperature === null || report.temperature === undefined ? [] : [report.fieldTimestamps.temperature + device.maxAgeMs])) : applianceDeadline;
      if (device.record !== false) engine.ingest({ ...identity(device), signal: device.stateSignal, value: reading.value,
        unit: reading.unit, sourceTime: reading.observedAt, receivedAt: now, quality: reading.quality,
        raw: { timeBasis: 'mqtt-live-status', ...dehumidifierMetadata(device, reading.value), availabilityConfirmed: true,
          identity: report.identity, fieldTimestamps: { ...report.fieldTimestamps },
          reportIntervalMs: locationDeadline - reading.observedAt,
          ...(sensor ? { readingsMatch: true, sensorDeviceId: sensor.id,
            airObservedAt: sensor.readings.caravan_temperature.observedAt,
            humidityObservedAt: sensor.readings.caravan_humidity.observedAt,
            applianceHumidityObservedAt: report.fieldTimestamps.humidity } : {}) } });
    }
    const operation = device.dehumidifierOperation, report = device.dehumidifierReport;
    if (!operation || operation.status === 'observed' || !report
      || report.identity !== operation.identity
      || report.receivedAt < operation.requestedAt || !fieldFresh(device, operation.setting, now)
      || report.fieldTimestamps[operation.setting] < operation.requestedAt
      || device.dehumidifierState[operation.setting] !== operation.value) return;
    operation.observedAt = report.fieldTimestamps[operation.setting];
    if (operation.acknowledgedAt !== undefined) { operation.status = 'observed'; delete operation.error; }
  }
  function signature(id) {
    const config = enabled.find(row => row.id === id);
    if (!config) return null;
    const target = config.protocol === 'shelly' ? native.signature(id) : equipmentSignature(config);
    return target ? createHash('sha256').update(`${brokerDigest}:${target}`).digest('hex') : null;
  }
  const temperatureControlKey = device => `equipment:dehumidifier-temperature-control:v1:${device.id}`;
  const temperatureControlSignature = device => createHash('sha256').update(JSON.stringify({
    appliance: signature(device.id), sensorDeviceId: device.temperatureControl.sensorDeviceId,
    sensor: signature(device.temperatureControl.sensorDeviceId) })).digest('hex');
  for (const device of devices.filter(row => row.temperatureControl)) {
    const saved = store.getState?.(temperatureControlKey(device));
    if (saved?.signature !== temperatureControlSignature(device)) continue;
    if (!validTemperatureControl(saved.settings) || !validDehumidifierIdentity(saved.identity)
      || Object.keys(saved).some(key => !['signature', 'identity', 'settings'].includes(key)))
      throw fail('saved dehumidifier temperature control is invalid');
    device.temperatureGuard.settings = { ...saved.settings };
    device.temperatureGuard.boundIdentity = saved.identity;
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
          reception.afterCommit(() => { void api.recheck({ deviceId: device.id }).catch(() => {}); });
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
    if (invalidTime) { unavailable(device, 'invalid-source-time', receivedAt); return; }
    let updated = false, invalid = false; const reported = new Set();
    if (device.kind === 'dehumidifier') {
      const snapshot = mapping.statePath ? property(input, mapping.statePath) : input;
      const physicalIdentity = validDehumidifierIdentity(snapshot?.identity) ? snapshot.identity : null;
      if (!physicalIdentity) { unavailable(device, 'invalid-device-identity', receivedAt); completeChecks(device, receivedAt); return; }
      if (device.dehumidifierReport && (at < device.dehumidifierReport.observedAt
        || at === device.dehumidifierReport.observedAt && physicalIdentity !== device.dehumidifierReport.identity)) return;
      const previousIdentity = device.temperatureGuard.boundIdentity;
      if (physicalIdentity && physicalIdentity !== previousIdentity) {
        if (previousIdentity) {
          unavailable(device, 'device-replaced', receivedAt);
          device.dehumidifierReport = null; device.dehumidifierState = dehumidifierState(null); device.dehumidifierOperation = null;
          Object.assign(device.temperatureGuard, { settings: { ...defaultTemperatureControl }, demand: false, managed: false,
            lastAttemptAt: null, lastAttemptPower: null, recordingSince: null,
            matchingSince: null, matchedAirAt: null, matchedApplianceAt: null, qualified: false });
          device.recordingLocation = false;
        }
        device.temperatureGuard.boundIdentity = physicalIdentity;
        if (device.temperatureControl) store.setState(temperatureControlKey(device), {
          signature: temperatureControlSignature(device), identity: physicalIdentity, settings: device.temperatureGuard.settings });
      }
      // Each report is a complete snapshot. Never combine a new power value
      // with a fan setting left over from an older message.
      const state = dehumidifierState(mapping.statePath ? property(input, mapping.statePath) : input);
      const reportedSnapshot = mapping.statePath ? property(input, mapping.statePath) : input;
      const capabilities = dehumidifierCapabilities(reportedSnapshot?.capabilities);
      const fieldTimestamps = Object.fromEntries([...Object.keys(DEHUMIDIFIER_SETTINGS), 'temperature', 'humidity'].map(field => {
        const clock = reportedSnapshot?.fieldTimestamps === undefined ? at : sourceTime(reportedSnapshot.fieldTimestamps?.[field]);
        return [field, scalar(clock) && clock >= 0 && clock <= at ? clock : null];
      }));
      const prior = device.dehumidifierReport;
      if (prior && Object.keys(fieldTimestamps).some(field => {
        const previousAt = prior.fieldTimestamps[field], incomingAt = fieldTimestamps[field];
        const previousValue = Object.hasOwn(DEHUMIDIFIER_SETTINGS, field) ? device.dehumidifierState[field] : prior[field];
        const incomingValue = Object.hasOwn(DEHUMIDIFIER_SETTINGS, field) ? state[field] : reportedSnapshot?.[field];
        return scalar(incomingAt) && scalar(previousAt) && (incomingAt < previousAt
          || incomingAt === previousAt && incomingValue !== previousValue);
      })) return;
      if (at === prior?.observedAt && JSON.stringify(capabilities) !== JSON.stringify(prior.capabilities)) return;
      const runningState = state.power === 'off' ? 'off' : state.power === 'on' ? state.fanSpeed : null;
      const value = runningState === null ? null : RUNNING_STATES.indexOf(runningState);
      const definition = definitions(device)[0];
      const stateFields = ['power', ...(state.power === 'on' ? ['fanSpeed'] : [])];
      const stale = stateFields.some(field => fieldTimestamps[field] === null || receivedAt - fieldTimestamps[field] >= device.maxAgeMs);
      updated = record(device, definition, stale ? null : value, at, receivedAt,
        stale ? ['stale-report'] : value === null ? ['invalid-value'] : []);
      if (updated) {
        const report = mapping.statePath ? property(input, mapping.statePath) : input;
        device.dehumidifierState = state; device.dehumidifierReport = { observedAt: at, receivedAt,
          temperature: report?.temperature, humidity: report?.humidity, capabilities, fieldTimestamps, identity: physicalIdentity };
        reported.add(definition.signal);
      }
      invalid = stale || value === null;
    } else if (canonicalTemperature(device) && topic === (definitions(device)[0].topic ?? device.topic)) {
      const definition = definitions(device)[0];
      const selectedPath = definition.path ?? mapping.statePath;
      const selected = { value: selectedPath ? property(input, selectedPath)
        : input && typeof input === 'object' ? input.value : input,
        ...(explicitTimestamp === undefined ? {} : { timestamp: explicitTimestamp }),
        unit: input?.unit ?? definition.unit };
      const periodic = INDOOR_SIGNALS.includes(device.temperatureSignal);
      const garage = ['garage_temperature', 'garage_temperature_2'].includes(device.temperatureSignal);
      const observation = decodeMqttTemperature({ signal: device.temperatureSignal, payload: JSON.stringify(selected),
        receivedAt, retained: packet.retain, timestampRequired: Boolean(mapping.timestampPath),
        scale: definition.scale ?? 1, offset: definition.offset ?? 0,
        reportIntervalMs: periodic ? temperatureReportIntervalMs : garage ? settings.pollIntervalMs : null,
        reportGraceMs: periodic ? temperatureReportGraceMs : garage ? Math.max(0, device.maxAgeMs - settings.pollIntervalMs) : 0 });
      if (!observation) { unavailable(device, 'invalid-temperature-message', receivedAt); return; }
      updated = record(device, definition, observation.value, observation.sourceTime, receivedAt, observation.quality, observation.raw);
      if (updated && !packet.retain) reported.add(definition.signal);
      invalid = observation.value === null || observation.quality.some(flag => /invalid|missing|future|stale|source_time_unknown/.test(flag));
    }
    if (device.kind !== 'dehumidifier') for (const definition of applicable.filter(row =>
      !(canonicalTemperature(device) && row.signal === device.temperatureSignal))) {
      const selectedPath = definition.path ?? (definition.signal === device.powerSignal || definition.signal === device.stateSignal || definition.signal === device.temperatureSignal ? mapping.statePath : null);
      let value = selectedPath ? property(input, selectedPath) : input && typeof input === 'object' ? input.value : input;
      value = definition.unit === 'state' ? stateValue(value) : scalar(value) ? value : null;
      if (value !== null) value = value * (definition.scale ?? 1) + (definition.offset ?? 0);
      if (!scalar(value)) value = null;
      if (definition.signal === 'dhwr_power' && value !== null && (value < 0 || value * (definition.unit === 'kW' ? 1000 : 1) > 100000)) value = null;
      if (['degC', '°C'].includes(definition.unit) && (!scalar(value) || value < -60 || value > 150)) value = null;
      if (value === null && !definition.required && !device.readings[definition.signal]) continue;
      const coverState = device.kind === 'door' && definition.signal === device.stateSignal
        ? property(input, mapping.coverStatePath) : null;
      const accepted = record(device, definition, value, at, receivedAt, value === null ? ['invalid-value'] : [],
        { timeBasis: value === null ? 'availability-transition' : explicitTimestamp === undefined ? 'mqtt-received' : 'source-measured',
          ...(device.kind === 'door' ? { coverState: ['open', 'closed', 'opening', 'closing'].includes(coverState) ? coverState : null } : {}) });
      if (accepted) reported.add(definition.signal);
      updated = accepted || updated;
      invalid ||= definition.required && value === null;
    }
    if (!updated) return;
    device.lastAt = receivedAt; device.liveSinceConnect = !packet.retain; device.invalid = invalid;
    const counter = device.mappings.find(mapping => mapping.key === 'energy_counter');
    if (device.metered && counter && healthy(device, receivedAt)) {
      const reading = device.readings[counter.signal];
      if (topic === (counter.topic ?? device.topic) && fresh(device, reading, receivedAt) && reading.value >= 0)
        energy.get(device.id)?.receive(reading.value / (counter.unit === 'Wh' ? 1000 : 1), reading.observedAt);
    } else if (device.metered && !counter && healthy(device, receivedAt) && topic === device.topic && scalar(input?.energy) && input.energy >= 0)
      energy.get(device.id)?.receive(input.energy, at);
    for (const check of device.checks) if (receivedAt >= check.at) for (const signal of reported) check.reported.add(signal);
    completeChecks(device, receivedAt);
  }
  function completeChecks(device, now) {
    confirmDoor(device, now);
    if (device.kind === 'dehumidifier') confirmDehumidifier(device, now);
    const main = device.readings[device.stateSignal];
    if (device.subscriptionStatus === 'subscribed' && healthy(device, now) && fresh(device, main, now)) for (const waiter of [...device.waiters])
      if (waiter.dispatched && main.revision > waiter.revision && main.receivedAt >= waiter.at
        && main.observedAt >= waiter.at && main.value === Number(waiter.on)) {
        reception.afterCommit(() => { waiter.observed = true; if (waiter.published) waiter.finish(); });
      }
    for (const check of [...device.checks]) if (check.ready && definitions(device).filter(row => row.required).every(row => check.reported.has(row.signal))) {
      if (healthy(device, now)) reception.afterCommit(() => check.finish('available'));
      else if (device.invalid) reception.afterCommit(() => check.finish('needs-attention'));
    }
    for (const appliance of devices.filter(row => row.temperatureControl)) {
      confirmDehumidifier(appliance, now);
      controlTemperature(appliance, now);
    }
  }
  async function switchDevice(device, on) {
    if (!device || typeof on !== 'boolean') throw fail('invalid switch selection');
    if (!connected || closed || !canControl()) throw fail('control authority unavailable');
    if (device.waiters.size) throw fail('switch operation already in progress');
    await new Promise((resolve, reject) => {
      let completed = false;
      const waiter = { id: ++sequence, at: engine.clock(), on, observed: false, published: false, dispatched: false, revision: sequence, finish: reason => {
        if (completed) return;
        if (!reason && (!canControl() || !connected || closed)) reason = fail('control authority unavailable');
        completed = true; clearTimeout(timer); device.waiters.delete(waiter); reason ? reject(reason) : resolve();
      } };
      const timer = setTimeout(() => waiter.finish(fail('state confirmation timed out; delivery unconfirmed')), readbackTimeoutMs);
      device.waiters.add(waiter);
      Promise.resolve().then(() => {
        if (!canControl() || !connected || closed) throw fail('control authority unavailable');
        waiter.dispatched = true; waiter.at = engine.clock(); waiter.revision = sequence;
        return publish(device.mqtt.commandTopic, on ? device.mqtt.onPayload : device.mqtt.offPayload, { qos: 1, retain: false, noReplay: true });
      }).then(() => { waiter.published = true; if (waiter.observed) waiter.finish(); }, () => waiter.finish(fail('switch publication failed; delivery unconfirmed')));
    });
    return { confirmed: true, status: 'confirmed', deviceId: device.id, on, sent: true, acknowledgement: 'mqtt-live-state' };
  }
  async function commandDehumidifier(device, setting, value, origin) {
    if (closed || !canControl() || !validDehumidifierIdentity(device.dehumidifierReport?.identity)
      || !(setting === 'power' && value === 'off' ? powerFeedbackReady(device, engine.clock()) : healthy(device, engine.clock())))
      throw fail('dehumidifier control is unavailable');
    if (!device.dehumidifierReport?.capabilities[setting]?.includes(value))
      throw fail('the dehumidifier has not advertised support for this setting');
    if (device.dehumidifierOperation && ['publishing', 'published'].includes(device.dehumidifierOperation.status)) {
      if (origin !== 'temperature' || setting !== 'power' || value !== 'off')
        throw fail('dehumidifier operation already in progress; wait for its live report');
      // A cold boundary or missing room evidence must not wait for a pending
      // ON acknowledgement. MQTT publishes retain their original request order.
      device.dehumidifierOperation.status = 'unconfirmed';
      device.dehumidifierOperation.error = 'Superseded by temperature protection OFF.';
    }
    const operation = { setting, value, origin, identity: device.dehumidifierReport.identity, status: 'publishing', requestedAt: engine.clock() };
    device.dehumidifierOperation = operation;
    try {
      await publish(device.mqtt.commandTopic, JSON.stringify({ [setting]: value,
        identity: operation.identity, requestedAt: operation.requestedAt, expiresAt: operation.requestedAt + Math.min(readbackTimeoutMs, 10_000) }),
      { qos: 1, retain: false, noReplay: true });
      operation.acknowledgedAt = engine.clock();
      if (operation.status === 'publishing') operation.status = operation.observedAt !== undefined ? 'observed' : 'published';
      if (closed || !canControl() || !connected) {
        operation.status = 'unconfirmed'; operation.error = 'Control connection changed. Check the dehumidifier live state.';
      }
    } catch {
      operation.status = 'unconfirmed'; operation.error = 'Dehumidifier command delivery is unconfirmed. Check its live state before trying again.';
      throw fail('dehumidifier command delivery is unconfirmed; check its live state');
    }
    return { ...operation, deviceId: device.id, acknowledgement: 'mqtt-broker', confirmed: operation.status === 'observed' };
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
        completeChecks(device, engine.clock());
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
      if (!connected || closed) return true;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      return reception.run(() => {
        const input = parse(body);
        for (const device of selected) {
          const at = sourceTime(device.mqtt.timestampPath ? property(input, device.mqtt.timestampPath) : input?.timestamp);
          if (admission.admit(`${device.id}:${topic}`, body, packet, receivedAt,
            { timestamped: scalar(at) && at >= 0 && at <= receivedAt })) receiveDevice(device, topic, body, packet, receivedAt);
        }
        return true;
      });
    },
    tick(now = engine.clock()) {
      if (closed) return;
      native?.tick(now); for (const accumulator of energy.values()) accumulator.tick(now);
      for (const device of devices) if (device.liveSinceConnect && (device.mqtt.heartbeatMs && scalar(device.heartbeatAt) && now - device.heartbeatAt > device.mqtt.heartbeatMs
        || age(device) > 0 && (now - device.lastAt >= age(device) || device.kind === 'door' && definitions(device).some(definition => {
          const reading = device.readings[definition.signal];
          return definition.required && scalar(reading?.observedAt) && now - reading.observedAt >= age(device);
        })))) unavailable(device, 'missing-report');
      for (const device of devices) if (device.coverOperation?.status === 'published' && device.coverOperation.action !== 'stop'
        && now - device.coverOperation.requestedAt >= 60_000) {
        device.coverOperation.status = 'unconfirmed';
        device.coverOperation.error = 'The requested door state has not been observed. Check its live state.';
      }
      for (const device of devices) if (device.dehumidifierOperation?.status === 'published'
        && now - device.dehumidifierOperation.requestedAt >= readbackTimeoutMs) {
        device.dehumidifierOperation.status = 'unconfirmed';
        device.dehumidifierOperation.error = 'The requested setting has not been reported. Check the dehumidifier live state.';
      }
      for (const device of devices.filter(row => row.temperatureControl)) {
        confirmDehumidifier(device, now); controlTemperature(device, now);
      }
    },
    async setDehumidifier(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['deviceId', 'setting', 'value'].includes(key))
        || typeof input.deviceId !== 'string' || typeof input.setting !== 'string' || !Object.hasOwn(DEHUMIDIFIER_SETTINGS, input.setting)
        || !DEHUMIDIFIER_SETTINGS[input.setting].includes(input.value))
        throw fail('choose a configured dehumidifier and a supported setting value');
      const device = devices.find(row => row.id === input.deviceId);
      if (!device?.controlsDehumidifier) throw fail('dehumidifier control is not configured');
      if (device.temperatureControl && device.temperatureGuard.settings.enabled && input.setting === 'power')
        throw fail('power is managed by caravan temperature control');
      return commandDehumidifier(device, input.setting, input.value, 'manual');
    },
    async setDehumidifierTemperatureControl(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['deviceId', ...Object.keys(defaultTemperatureControl)].includes(key))
        || typeof input.deviceId !== 'string' || Object.keys(input).length < 2)
        throw fail('choose a configured dehumidifier and temperature control settings');
      const device = devices.find(row => row.id === input.deviceId);
      if (!device?.temperatureControl) throw fail('dehumidifier temperature control is not configured');
      if (closed || !canControl()) throw fail('control authority unavailable');
      if (!validDehumidifierIdentity(device.temperatureGuard.boundIdentity)) throw fail('dehumidifier identity is not yet known');
      const { deviceId, ...patch } = input;
      const policy = { ...device.temperatureGuard.settings, ...patch };
      if (!validTemperatureControl(policy))
        throw fail('temperature thresholds must be between -10 and 30 °C in 0.1 °C steps, with ON at least 0.5 °C above OFF');
      store.setState(temperatureControlKey(device), { signature: temperatureControlSignature(device),
        identity: device.temperatureGuard.boundIdentity, settings: policy });
      if (policy.enabled !== device.temperatureGuard.settings.enabled) {
        device.temperatureGuard.managed = false; device.temperatureGuard.demand = false;
        device.temperatureGuard.lastAttemptAt = null; device.temperatureGuard.lastAttemptPower = null;
      }
      device.temperatureGuard.settings = policy;
      controlTemperature(device, engine.clock());
      return { deviceId, temperatureControl: temperatureGuardStatus(device, engine.clock()) };
    },
    async setCover(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['deviceId', 'action'].includes(key))
        || typeof input.deviceId !== 'string' || !['open', 'close', 'stop'].includes(input.action))
        throw fail('choose a configured door and open, close or supported stop');
      const device = devices.find(row => row.id === input.deviceId);
      const payload = device?.mqtt[`${input.action}Payload`];
      if (!device?.controlsCover || !payload) throw fail('door action is not configured');
      if (closed || !canControl() || !healthy(device, engine.clock())) throw fail('door control is unavailable');
      const operation = { action: input.action, status: 'publishing', requestedAt: engine.clock() };
      device.coverOperation = operation;
      // Publish immediately in request order. Do not hold a movement-wide lock:
      // an explicitly supported Stop must remain usable while opening/closing.
      // Each callback belongs to this request, so older replies cannot replace
      // the visible result of a later command. Nothing is replayed on restart.
      try {
        await publish(device.mqtt.commandTopic, payload, { qos: 1, retain: false, noReplay: true });
        operation.acknowledgedAt = engine.clock();
        if (operation.status === 'publishing') operation.status = operation.observedAt !== undefined ? 'observed' : 'published';
        if (closed || !canControl() || !connected) {
          operation.status = 'unconfirmed'; operation.error = 'Control connection changed. Check the door live state.';
        }
      } catch {
        operation.status = 'unconfirmed'; operation.error = 'Door command delivery is unconfirmed. Check its live state before trying again.';
        throw fail('door command delivery is unconfirmed; check its live state');
      }
      return { ...operation, deviceId: device.id, acknowledgement: 'mqtt-broker', confirmed: operation.status === 'observed' };
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
          if (device.kind === 'door' && method === 'request' && ['timeout', 'unavailable'].includes(status) && device.liveSinceConnect) {
            // Event-only state has no age expiry, but an explicitly unanswered
            // query is evidence that this route can no longer confirm it.
            try { unavailable(device, status === 'timeout' ? 'status-request-timeout' : 'status-request-failed'); }
            catch { /* The device was invalidated before recording the transition. */ }
          }
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
      if (!Array.isArray(commands) || !commands.length || commands.some(command => !['reduction', 'normal'].includes(command))) throw fail('invalid heating command');
      if (heatingBusy) throw fail('heating operation already in progress');
      if (!connected || closed || !canControl()) throw fail('control authority unavailable');
      heatingBusy = true;
      try {
        if (native?.hasHeating) await native.publishHeating(commands);
        for (const command of commands) for (const device of devices.filter(row => row.controlsHeat)) await switchDevice(device, command === 'reduction' ? device.reductionOn : !device.reductionOn);
        return { confirmed: true, status: 'confirmed', sent: true, commands: [...commands], acknowledged: commands.length, acknowledgement: 'equipment-state-readback' };
      } finally { heatingBusy = false; }
    },
    status(now = engine.clock()) {
      const nativeStatus = native?.status(now), rows = [...(nativeStatus?.devices ?? []), ...devices.map(device => ({ id: device.id, role: device.id,
        label: device.label, area: device.area, kind: device.kind, source: device.source, connection: device.connection, available: healthy(device, now),
        observedAt: device.lastAt, controls: { switch: device.controlsSwitch, tariff: device.controlsHeat,
          ...(device.kind === 'dehumidifier' ? { dehumidifier: device.controlsDehumidifier } : {}),
          ...(device.kind === 'door' ? { cover: { open: device.controlsCover, close: device.controlsCover,
            stop: Boolean(device.controlsCover && device.mqtt.stopPayload) } } : {}) }, check: device.check,
        ...(device.kind === 'door' ? { cover: { available: !closed && canControl() && healthy(device, now),
          state: device.readings[device.stateSignal]?.coverState ?? null,
          operation: device.coverOperation ? { ...device.coverOperation } : null } } : {}),
        ...(device.kind === 'dehumidifier' ? { dehumidifier: {
          available: device.controlsDehumidifier && !closed && canControl() && healthy(device, now)
            && validDehumidifierIdentity(device.dehumidifierReport?.identity),
          powerOffAvailable: device.controlsDehumidifier && canControl() && powerFeedbackReady(device, now),
          state: { ...device.dehumidifierState },
          capabilities: structuredClone(device.dehumidifierReport?.capabilities ?? {}),
          measurements: { temperature: device.dehumidifierReport?.temperature ?? null, humidity: device.dehumidifierReport?.humidity ?? null },
          temperatureControl: temperatureGuardStatus(device, now),
          runningState: healthy(device, now) ? RUNNING_STATES[device.readings[device.stateSignal]?.value] ?? null : null,
          observedAt: device.dehumidifierReport?.observedAt ?? null,
          operation: device.dehumidifierOperation ? { ...device.dehumidifierOperation } : null } } : {}),
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
