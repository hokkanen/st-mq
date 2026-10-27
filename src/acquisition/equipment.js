import { createMqttAdmission } from './mqtt-admission.js';
import { createMqttReception } from './mqtt-reception.js';
import { createDoorRecording } from './equipment-door-recording.js';
import { retainStorageWithdrawal } from './storage-withdrawal.js';
import { createSourceTimePending } from './source-time-pending.js';
import { classifySourceTime, sourceTimeAdmission, validateAdmittedSourceTime, observationTimeAdmitted } from '../domain/time-evidence.js';
import { createHash } from 'node:crypto';
import { createShellyCapture } from './shelly.js';
import { createCaravanEnergy } from './shelly-energy.js';
import { equipmentSignature, equipmentMeterIdentity, canonicalEquipmentTemperature as canonicalTemperature } from './equipment-config.js';
import { CARAVAN_TEMPERATURE_CONTROL_DEFAULTS as defaultTemperatureControl, validCaravanTemperatureControl as validTemperatureControl } from '../domain/caravan-temperature-control.js';
import { decodeMqttTemperature, temperatureRouteSignature } from './mqtt-temperature.js';
import { INDOOR_SIGNALS } from '../domain/indoor-sensors.js';
import { CARAVAN_DEHUMIDIFIER_STATES } from '../domain/history-series.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../domain/temperature-reports.js';
import { createCaravanProbe, advanceCaravanProbe, abortCaravanProbe } from './caravan-location.js';
import { caravanPowerTimingKey, validateCaravanPowerTiming, observeCaravanPower, caravanPowerRestartAt, CARAVAN_NATIVE_RESTART_DELAY_MS } from '../domain/caravan-power-timing.js';
import { caravanQualificationKey, validateCaravanQualification, createCaravanQualification,
  advanceCaravanQualification, loseCaravanQualification, caravanAssociationProof,
  caravanQualificationCurrentKey, validateCaravanQualificationCurrent } from '../domain/caravan-qualification.js';
import { unsentEquipmentCommand } from '../domain/equipment-command-errors.js';

const scalar = value => typeof value === 'number' && Number.isFinite(value);
const property = (object, path) => path?.split('.').reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
const parse = payload => { try { return JSON.parse(payload); } catch { return payload; } };
const stateValue = value => typeof value === 'boolean' ? Number(value) : [0, 1].includes(value) ? value
  : typeof value === 'string' ? ['on', 'open', 'true', '1'].includes(value.toLowerCase()) ? 1
    : ['off', 'closed', 'close', 'false', '0'].includes(value.toLowerCase()) ? 0 : null : null;
const sourceTime = value => Number.isSafeInteger(value) ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : null;
const fail = message => new Error(`Equipment ${message}`);
const DEHUMIDIFIER_SETTINGS = {
  power: ['off', 'on'], mode: ['auto', 'dehumidify', 'heater', 'fan_only'],
  fanSpeed: ['low', 'medium', 'high', 'auto'], swing: ['fixed_90', 'fixed_45', 'oscillate'],
  targetHumidity: Array.from({ length: 11 }, (_, index) => 30 + index * 5),
};
const DEHUMIDIFIER_HISTORY_STATES = ['off', 'low', 'medium', 'high'];
const dehumidifierState = input => Object.fromEntries(Object.entries(DEHUMIDIFIER_SETTINGS)
  .map(([key, allowed]) => [key, allowed.includes(input?.[key]) ? input[key] : null]));
function dehumidifierCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.entries(input).some(([key, values]) => !Object.hasOwn(DEHUMIDIFIER_SETTINGS, key)
      || !Array.isArray(values) || !values.length || new Set(values).size !== values.length
      || values.some(value => !DEHUMIDIFIER_SETTINGS[key].includes(value)))) return {};
  return Object.fromEntries(Object.entries(input).map(([key, values]) => [key, [...values]]));
}
const dehumidifierMetadata = device => ({ stateLabels: CARAVAN_DEHUMIDIFIER_STATES,
  maxAgeMs: device.maxAgeMs, reportIntervalMs: device.maxAgeMs, reportGraceMs: 0 });
const validDehumidifierIdentity = identity => typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity);

/** Explicit per-device protocol and broker routing, independent capabilities.
 * Event-only contacts preserve last-reported values without inventing heartbeats. */
export function createEquipmentCapture({ engine, store, settings, publish, canControl = () => true, readbackTimeoutMs = 10_000,
  temperatureReportIntervalMs = DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS,
  temperatureReportGraceMs = DEFAULT_TEMPERATURE_REPORT_GRACE_MS, brokerIdentity = null, brokerForDevice = () => 'primary', brokerIdentityForDevice = () => brokerIdentity,
  refreshSubscriptions = null, topicGroups = [], monotonicClock = () => performance.now() }) {
  const configured = settings.devices ?? [], enabled = configured.filter(row => row.enabled);
  const native = enabled.some(row => row.protocol === 'shelly') ? createShellyCapture({ engine, store,
    settings: { ...settings, devices: enabled.filter(row => row.protocol === 'shelly') }, publish, canControl, readbackTimeoutMs, brokerIdentity,
    onSourceTimeChanged: confirmCaravanSources }) : null;
  let connected = false, closed = false, heatingBusy = false, caravanStopping = false, sequence = 0;
  const devices = enabled.filter(row => row.protocol === 'mqtt').map(config => ({ ...config, readings: {}, mappings: config.readings,
    broker: brokerForDevice(config), brokerConnected: false,
    roomRouteSignature: config.kind === 'temperature' && INDOOR_SIGNALS.includes(config.temperatureSignal)
      ? temperatureRouteSignature({ brokerIdentity: brokerIdentityForDevice(config), topic: config.topic, statePath: config.mqtt.statePath, timestampPath: config.mqtt.timestampPath,
        mappings: config.readings.filter(mapping => mapping.signal === config.temperatureSignal) }) : null,
    online: null, bridgeOnline: null, liveSinceConnect: false, lastAt: null, heartbeatAt: null, waiters: new Set(), checks: new Set(), check: null, invalid: false,
    subscriptionStatus: 'unconfirmed', subscriptionRefresh: null, lastReceivedAt: null, lastLiveAt: null, lastRetainedAt: null,
    coverOperation: null, dehumidifierState: dehumidifierState(null), dehumidifierReport: null, dehumidifierOperation: null,
    dehumidifierHistoryAfter: null,
    temperatureGuard: { settings: { ...defaultTemperatureControl }, demand: false, managed: false,
      lastAttemptAt: null, lastAttemptPower: null, recordingSince: null, sourceTimeWait: null, sourceTimeWaitExpiry: null,
      probe: null, meterSignature: null, sessionActive: false, restoration: null,
      qualified: false, boundIdentity: null, recordingGateObserved: false, nativePowerTiming: null,
      qualification: createCaravanQualification(null, engine.clock()), qualificationKey: null,
      qualificationSaved: null,
      nativeRestartMonotonicDeadline: null, nativePowerContinuity: false, nativePowerContinuityLostAt: engine.clock() }, recordingLocation: false }));
  const admission = createMqttAdmission(), doorAdmission = createMqttAdmission();
  const coverDispatches = new Map();
  const temperatures = devices.filter(canonicalTemperature);
  for (const device of temperatures) {
    const garage = ['garage_temperature', 'garage_temperature_2'].includes(device.temperatureSignal);
    if (garage || INDOOR_SIGNALS.includes(device.temperatureSignal)) engine.configureTemperatureReports?.(device.temperatureSignal,
      { reportIntervalMs: garage ? settings.pollIntervalMs : temperatureReportIntervalMs,
        reportGraceMs: garage ? Math.max(0, device.maxAgeMs - settings.pollIntervalMs) : temperatureReportGraceMs });
  }
  const energy = new Map(devices.filter(row => row.metered).map(device => [device.id, createCaravanEnergy({ store, recorder: engine.recorder,
    device: equipmentMeterIdentity({ ...device, readings: device.mappings }, { brokerIdentity: brokerIdentityForDevice(device) }),
    maxGapMs: device.maxAgeMs || settings.maxAgeMs, source: 'mqtt-equipment',
    signal: `${device.id}_energy`, recordDevice: device.id, stateKey: `mqtt:equipment-energy:v1:${device.id}` })]));
  // Door RAM belongs to the live connection, never to a SQLite transaction's
  // rollback snapshot. All other equipment retains committed admission.
  const reception = createMqttReception({ store, engine, admission,
    devices: devices.filter(device => device.kind !== 'door'), meters: energy });
  const doorRecording = createDoorRecording({ store, engine, canControl, run: action => reception.run(action) });
  const dehumidifierDispatches = new Map();
  const write = (action, options = {}) => {
    if (store.runWrite && !store.transactionDepth) return store.runWrite(action, options);
    try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
  };
  let admittedReceptionAt, pendingSequence = 0;
  const pendingFor = device => (device.kind === 'door' ? doorPendingTime : pendingTime).some(row => row.device === device);
  const doorPendingTime = createSourceTimePending({ clock: engine.clock, monotonicClock,
    ordered: row => row.device.id,
    onReject({ device }, reason) { if (reason !== 'cleared') unavailable(device, 'invalid-source-time'); },
    onReady({ device, topic, body, packet, receivedMonotonicAt }, receivedAt, admittedAt) {
      if (closed || !device.brokerConnected || ['failed', 'disconnected'].includes(device.subscriptionStatus)) return;
      const previous = admittedReceptionAt; admittedReceptionAt = admittedAt;
      try { receiveDevice(device, topic, body, packet, receivedAt, receivedMonotonicAt); }
      finally { admittedReceptionAt = previous; }
    } });
  const pendingTime = createSourceTimePending({ clock: engine.clock, dispatch: action => write(() => (store.transaction ?? (fn => fn())).call(store, () => {
    const checkpoint = pendingTime.checkpoint();
    store.afterRollback?.(() => pendingTime.restore(checkpoint)); return action();
  })), ordered: row => row.device.id,
    onReject({ device }, reason) {
      if (reason !== 'cleared' && device.kind !== 'temperature') unavailable(device, 'invalid-source-time');
    },
    onReady({ device, topic, body, packet, receivedMonotonicAt }, receivedAt, admittedAt) {
      if (closed || !device.brokerConnected || ['failed', 'disconnected'].includes(device.subscriptionStatus)) return;
      const previous = admittedReceptionAt; admittedReceptionAt = admittedAt;
      try { reception.run(() => receiveDevice(device, topic, body, packet, receivedAt, receivedMonotonicAt)); }
      finally { admittedReceptionAt = previous; }
    } });
  function drainPending(now) {
    if (!pendingTime.size) return;
    const checkpoint = pendingTime.checkpoint();
    store.afterRollback?.(() => pendingTime.restore(checkpoint));
    pendingTime.drain(now);
  }
  const definitions = device => [
    { signal: device.powerSignal ?? device.stateSignal ?? device.temperatureSignal,
      unit: device.kind === 'power' ? 'W' : device.kind === 'temperature' ? 'degC' : 'state',
      label: device.kind === 'dehumidifier' ? 'State' : device.kind === 'power' ? 'Power' : device.kind === 'temperature' ? 'Temperature' : device.kind === 'door' ? 'Door' : 'Switch', required: true },
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
    if (scalar(at) && scalar(previous?.observedAt) && (at < previous.observedAt
      || device.kind === 'dehumidifier' && at === previous.observedAt && value !== previous.value)) {
      if (device.kind !== 'dehumidifier') return false;
      // A newly received OFF can have a newer power clock but an older clock
      // than or equal to the preceding ON+fan combination. Accept live power independently;
      // history must show a gap instead of backdating the combined transition.
      value = null; at = null; quality = ['state-evidence-unavailable'];
    }
    if (device.kind === 'dehumidifier' && value === null && previous?.value != null)
      device.dehumidifierHistoryAfter = receivedAt;
    const repeatedSource = scalar(at) && at === previous?.observedAt && previous.value !== null && raw.timeBasis === 'source-measured';
    if (repeatedSource && value !== null && value !== previous.value) return false;
    if (!scalar(at) && raw.timeAdmission) { const { timeAdmission: ignored, ...remaining } = raw; raw = remaining; }
    const timeAdmission = sourceTimeAdmission({ sourceTime: at, receivedAt, now: admittedReceptionAt ?? receivedAt, deferred: admittedReceptionAt !== undefined });
    if (timeAdmission) raw = { ...raw, timeAdmission };
    const observation = { ...identity(device), signal: definition.signal, value, unit: definition.unit, sourceTime: at, receivedAt, quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status',
        ...(device.kind === 'dehumidifier' ? dehumidifierMetadata(device) : {}),
        ...(['caravan_temperature', 'caravan_humidity'].includes(definition.signal) && device.maxAgeMs > 0
          ? { reportIntervalMs: device.maxAgeMs, reportGraceMs: 0 } : {}),
        ...(['door', 'power'].includes(device.kind) && device.maxAgeMs === 0 ? { eventOnly: true } : {}), ...raw,
        ...(device.roomRouteSignature ? { temperatureRouteSignature: device.roomRouteSignature } : {}) } };
    // A contact and its availability may arrive in either order. Keep the
    // candidate here, then publish it to the model only when both are live.
    if (device.kind === 'door') {
      if (value === null && device.record !== false && definition.record !== false) doorRecording.save(observation);
    } else if (device.record !== false && definition.record !== false && !(device.kind === 'dehumidifier' && value !== null)) {
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
      ...(device.kind === 'dehumidifier' ? { stateLabels: CARAVAN_DEHUMIDIFIER_STATES } : {}), ...raw };
    if (!repeatedSource && device.kind !== 'door') reception.accept();
    return true;
  }
  function unavailable(device, reason, receivedAt = engine.clock()) {
    coverDispatches.get(device)?.cancellation.abort();
    dehumidifierDispatches.get(device)?.cancellation.abort();
    (device.kind === 'door' ? doorPendingTime : pendingTime).removeWhere(row => row.device === device);
    if (device.kind === 'door') {
      device.liveSinceConnect = false; device.invalid = true;
      if (device.coverOperation && ['publishing', 'published'].includes(device.coverOperation.status)) {
        device.coverOperation.status = 'unconfirmed';
        device.coverOperation.error = 'Door feedback became unavailable. Check its live state.';
      }
      for (const waiter of [...device.waiters]) waiter.finish(fail('state confirmation unavailable'));
      for (const check of [...device.checks]) check.finish('unavailable');
      for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal]) {
        const previous = device.readings[definition.signal];
        record(device, definition, null, null, receivedAt, [reason]);
        if (previous?.value != null) device.readings[definition.signal] = {
          ...previous, unavailable: true, quality: [...new Set([...(previous.quality ?? []), reason, 'last-reported'])] };
      }
      return;
    }
    if (store.runWrite && !store.transactionDepth) {
      reception.invalidate(device);
      // Withdraw authority immediately. The original outage boundary then joins
      // the same ordered writer queue as later reports from this connection.
      retainStorageWithdrawal(store, device, () => {
        device.liveSinceConnect = false; device.invalid = true;
        if (device.temperatureControl) {
          loseCaravanQualification(device.temperatureGuard.qualification, receivedAt);
          device.temperatureGuard.qualified = false;
        }
        for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal])
          engine.rememberObservation?.({ ...identity(device), signal: definition.signal, value: null,
            unit: definition.unit, sourceTime: null, receivedAt, quality: [reason],
            raw: { usableForControl: false, timeBasis: 'availability-transition',
              ...(device.roomRouteSignature ? { temperatureRouteSignature: device.roomRouteSignature } : {}) } }, receivedAt);
      });
      for (const waiter of [...device.waiters]) waiter.finish(fail('state confirmation unavailable'));
      for (const check of [...device.checks]) check.finish('unavailable');
      void write(() => reception.run(() => unavailable(device, reason, receivedAt))).catch(() => {});
      return;
    }
    device.liveSinceConnect = false; device.invalid = true;
    if (device.temperatureControl) {
      const guard = device.temperatureGuard;
      if (guard.probe?.status === 'testing') abortCaravanProbe(guard.probe, reason, receivedAt);
      loseCaravanQualification(guard.qualification, receivedAt);
      persistQualification(device);
      guard.qualified = false; guard.sourceTimeWait = null; guard.sourceTimeWaitExpiry = null;
      guard.recordingGateObserved = false;
      guard.nativeRestartMonotonicDeadline = null; guard.nativePowerContinuity = false;
      guard.nativePowerContinuityLostAt = Math.max(guard.nativePowerContinuityLostAt, receivedAt);
    }
    energy.get(device.id)?.unavailable?.(receivedAt, reason);
    if (device.dehumidifierOperation && ['publishing', 'published'].includes(device.dehumidifierOperation.status)) {
      device.dehumidifierOperation.status = 'unconfirmed';
      device.dehumidifierOperation.error = 'Dehumidifier feedback became unavailable. Check its live state.';
    }
    for (const waiter of [...device.waiters]) reception.afterCommit(() => waiter.finish(fail('state confirmation unavailable')));
    for (const check of [...device.checks]) reception.afterCommit(() => check.finish('unavailable'));
    for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal]) {
      record(device, definition, null, null, receivedAt, [reason]);
    }
    // Source loss pauses current use immediately. Historical association and
    // failed-check latch have separate continuous-outage/recovery boundaries.
    if (device.id === 'caravan') for (const appliance of devices.filter(row => row.temperatureControl && row.area === device.area)) {
      const guard = appliance.temperatureGuard;
      if (guard.probe?.status === 'testing') abortCaravanProbe(guard.probe, 'power-unavailable', receivedAt);
      loseCaravanQualification(guard.qualification, receivedAt);
      persistQualification(appliance);
      guard.qualified = false; guard.sourceTimeWait = null; guard.sourceTimeWaitExpiry = null;
      recordDehumidifierLocation(appliance, receivedAt);
    }
  }
  const fresh = (device, reading, now) => Boolean(reading && scalar(reading.value) && scalar(reading.observedAt)
    && reading.observedAt <= now && !reading.retained && !reading.unavailable
    && (!age(device) || now - Math.min(reading.observedAt, reading.receivedAt ?? reading.observedAt) < age(device))
    && !reading.quality?.some(flag => /invalid|missing|retained|stale|future|disconnected|offline|unavailable/.test(flag)));
  const availabilityConfirmed = device => device.bridgeOnline !== false && (!device.mqtt.availabilityTopic || device.online === true);
  const fieldFresh = (device, field, now) => {
    const at = device.dehumidifierReport?.fieldTimestamps[field];
    return scalar(at) && at >= 0 && at <= now && now - at < device.maxAgeMs;
  };
  const powerFeedbackReady = (device, now, allowPendingTime = false) => (allowPendingTime || !pendingFor(device)) && device.brokerConnected && !closed && device.liveSinceConnect && availabilityConfirmed(device)
    && device.subscriptionStatus === 'subscribed' && validDehumidifierIdentity(device.dehumidifierReport?.identity)
    && fieldFresh(device, 'power', now) && ['on', 'off'].includes(device.dehumidifierState.power)
    && (!device.mqtt.heartbeatMs || scalar(device.heartbeatAt) && now - device.heartbeatAt <= device.mqtt.heartbeatMs);
  const healthy = (device, now, allowPendingTime = false) => device.kind === 'dehumidifier' ? powerFeedbackReady(device, now, allowPendingTime) && !device.invalid
    : (allowPendingTime || device.kind === 'temperature' || !pendingFor(device)) && device.brokerConnected && device.liveSinceConnect && availabilityConfirmed(device) && !device.invalid
    && !['failed', 'disconnected'].includes(device.subscriptionStatus)
    && (!device.mqtt.heartbeatMs || scalar(device.heartbeatAt) && now - device.heartbeatAt <= device.mqtt.heartbeatMs)
    && definitions(device).filter(row => row.required).every(definition => fresh(device, device.readings[definition.signal], now));
  function dehumidifierHistory(device, now, state = device.dehumidifierState, report = device.dehumidifierReport) {
    const fields = state.power === 'on' ? ['power', 'fanSpeed'] : ['power'];
    const clocks = Object.fromEntries(fields.map(field => [field, report?.fieldTimestamps[field]]));
    const value = state.power === 'off' ? 0 : state.power === 'on' && ['low', 'medium', 'high'].includes(state.fanSpeed)
      ? DEHUMIDIFIER_HISTORY_STATES.indexOf(state.fanSpeed) : null;
    const evidenceValid = value !== null && Object.values(clocks).every(at => scalar(at) && at >= 0 && at <= now && now - at < device.maxAgeMs);
    const observedAt = evidenceValid ? Math.max(...Object.values(clocks)) : null;
    const valid = evidenceValid && (device.dehumidifierHistoryAfter === null || observedAt > device.dehumidifierHistoryAfter);
    return { value: valid ? value : null, observedAt: valid ? observedAt : null,
      deadline: valid ? Math.min(...Object.values(clocks)) + device.maxAgeMs : null, fieldTimestamps: clocks };
  }
  // The configured Caravan meter owns the location evidence. Instantaneous watts
  // are live-only; measured counter increments retain their existing recorder.
  function caravanPower(device, now, allowPendingTime = false) {
    const config = enabled.find(row => row.id === 'caravan' && row.area === device.area);
    if (!config) return null;
    const meter = config.protocol === 'shelly' ? native?.status(now).devices.find(row => row.id === config.id)
      : devices.find(row => row.id === config.id);
    const reading = meter?.readings.caravan_power;
    const available = config.protocol === 'shelly' ? (meter?.available || allowPendingTime && native?.sourceTimePending(config.id, now)) && !reading?.stale
      : meter && healthy(meter, now, allowPendingTime) && fresh(meter, reading, now);
    const routeSignature = signature(config.id);
    if (!available || !routeSignature || !scalar(reading?.value) || reading.value < 0
      || !['W', 'kW'].includes(reading.unit) || !scalar(reading.observedAt) || reading.observedAt > now
      || now - reading.observedAt >= (config.maxAgeMs || settings.maxAgeMs)) return null;
    const meterSignature = createHash('sha256').update(JSON.stringify({ routeSignature,
      powerMapping: config.readings.filter(row => row.signal === 'caravan_power') })).digest('hex');
    return { watts: reading.value * (reading.unit === 'kW' ? 1000 : 1), observedAt: reading.observedAt,
      deadline: reading.observedAt + (config.maxAgeMs || settings.maxAgeMs),
      maxAgeMs: config.maxAgeMs || settings.maxAgeMs, signature: meterSignature };
  }
  const qualificationSignature = (device, meterSignature) => createHash('sha256').update(JSON.stringify({
    temperatureControl: temperatureControlSignature(device), meterSignature })).digest('hex');
  function persistQualification(device) {
    const state = device.temperatureGuard, record = state.qualification.record;
    if (!state.qualificationKey || !record) return;
    const serialized = JSON.stringify(record);
    if (serialized === state.qualificationSaved) return;
    validateCaravanQualification(record, record);
    store.setState(state.qualificationKey, record);
    state.qualificationSaved = serialized;
  }
  function ensureQualification(device, meter) {
    const state = device.temperatureGuard, identity = device.dehumidifierReport?.identity;
    if (!validDehumidifierIdentity(identity) || !meter) return;
    const scope = qualificationSignature(device, meter.signature);
    const key = caravanQualificationKey(device.id, identity, scope);
    if (state.qualificationKey === key) return;
    const saved = validateCaravanQualification(store.getState?.(key), { identity, signature: scope, meterSignature: meter.signature });
    const selectionKey = caravanQualificationCurrentKey(device.id);
    const selected = validateCaravanQualificationCurrent(store.getState?.(selectionKey));
    const now = engine.clock();
    if (!selected || selected.identity !== identity || selected.signature !== scope) {
      if (selected) {
        const previousKey = caravanQualificationKey(device.id, selected.identity, selected.signature);
        const previous = validateCaravanQualification(store.getState?.(previousKey), selected);
        if (previous) {
          previous.invalidatedAt = now; previous.revision++;
          store.setState(previousKey, previous);
        }
      }
      if (saved) { saved.invalidatedAt = now; saved.failed = null; saved.revision++; }
      store.setState(selectionKey, { identity, signature: scope });
    }
    if (state.qualificationKey) {
      if (state.probe?.status === 'testing') {
        abortCaravanProbe(state.probe, 'power-unavailable', engine.clock());
        saveLocationResult(device, engine.clock(), false);
      }
      // The separate restoration remains owned. Its old electrical test cannot
      // become proof for the newly selected meter/wiring, even after cleanup.
      state.probe = null;
    }
    state.qualification = createCaravanQualification(saved, state.qualificationKey ? now : state.qualification.startedAt);
    state.qualificationKey = key;
    state.qualificationSaved = null;
    persistQualification(device);
    state.qualified = false; state.sessionActive = false;
    state.meterSignature = meter.signature;
  }
  function passedLocationEvidence(state) {
    const record = state.qualification.record;
    return record?.proof && record.invalidatedAt === null && record.failed === null ? record.proof
      : state.probe?.status === 'passed' ? state.probe.evidence : null;
  }
  function saveLocationResult(device, now, passed) {
    const state = device.temperatureGuard, watch = state.qualification;
    if (!state.qualificationKey || !scalar(watch.lastPowerAt) || !scalar(watch.lastMeterAt)) return;
    if (passed && watch.record?.proof?.completedAt === state.probe.evidence.completedAt) return;
    if (!passed && watch.record?.failed?.at === state.probe.evidence.completedAt) return;
    if (!passed && watch.record && watch.record.failed === null
      && watch.record.invalidatedAt > state.probe.evidence.completedAt) return;
    const record = watch.record ?? { identity: device.dehumidifierReport.identity,
      signature: qualificationSignature(device, state.meterSignature), meterSignature: state.meterSignature,
      proof: null, failed: null, invalidatedAt: now, outageAt: watch.outageAt,
      revision: 0, recheckAt: null,
      lastHealthyAt: Math.max(watch.lastPowerAt, watch.lastMeterAt), powerAt: watch.lastPowerAt, meterAt: watch.lastMeterAt };
    record.revision++; record.recheckAt = null;
    if (passed) {
      record.proof = caravanAssociationProof(state.probe.evidence);
      record.failed = null; record.invalidatedAt = null; record.outageAt = null;
      record.lastHealthyAt = now; record.powerAt = watch.lastPowerAt; record.meterAt = watch.lastMeterAt;
      watch.ready = true;
    } else {
      record.failed = { at: state.probe.evidence.completedAt, reason: state.probe.reason };
      record.invalidatedAt = now; watch.ready = false;
    }
    watch.record = record; persistQualification(device);
  }
  function qualificationLossAt(device, now) {
    const watch = device.temperatureGuard.qualification;
    const meterConfig = enabled.find(row => row.id === 'caravan' && row.area === device.area);
    return Math.min(now, scalar(watch.lastPowerAt) ? watch.lastPowerAt + device.maxAgeMs : now,
      scalar(watch.lastMeterAt) ? watch.lastMeterAt + (meterConfig?.maxAgeMs || settings.maxAgeMs) : now);
  }
  const probeBusy = device => Boolean(device.temperatureGuard.restoration || device.temperatureGuard.probe?.status === 'testing');
  function currentNativePowerTiming(device) {
    const state = device.temperatureGuard, boundary = state.nativePowerTiming;
    return state.nativePowerContinuity && boundary && boundary.identity === device.dehumidifierReport?.identity
      && boundary.signature === signature(device.id) && boundary.power === device.dehumidifierState.power ? boundary : null;
  }
  const validMonotonic = value => scalar(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER - CARAVAN_NATIVE_RESTART_DELAY_MS;
  function monotonicNow() {
    try { const now = monotonicClock(); return validMonotonic(now) ? now : null; } catch { return null; }
  }
  // This restriction belongs to this process and current native connection only.
  // Persisted source/receipt clocks remain the historical transition evidence.
  function restartRemaining(device, now) {
    const boundary = currentNativePowerTiming(device);
    if (!boundary) return null;
    const restartAt = caravanPowerRestartAt(boundary);
    if (restartAt === null) return 0;
    const deadline = device.temperatureGuard.nativeRestartMonotonicDeadline, mono = monotonicNow();
    if (!validMonotonic(deadline) || mono === null || mono < deadline - CARAVAN_NATIVE_RESTART_DELAY_MS) return null;
    return Math.max(0, restartAt - now, deadline - mono);
  }
  function restartNotBefore(device, now) {
    if (currentNativePowerTiming(device)?.power !== 'off') return null;
    const remaining = restartRemaining(device, now);
    return remaining === null ? null : Math.ceil(now + remaining);
  }
  function restartWait(device, now) {
    if (!device.temperatureControl) return false;
    const remaining = restartRemaining(device, now);
    return remaining === null || remaining > 0;
  }
  function assertRestartReady(device, setting, value, now) {
    if (setting !== 'power' || value !== 'on' || !restartWait(device, now)) return;
    const remaining = restartRemaining(device, now);
    throw Object.assign(fail(remaining === null ? 'dehumidifier restart needs a fresh native power transition'
      : `dehumidifier restart is waiting for native drying; wait ${Math.max(1, Math.ceil(remaining / 1000))} seconds`),
    { code: remaining === null ? 'DEHUMIDIFIER_POWER_EVIDENCE_REQUIRED' : 'DEHUMIDIFIER_RESTART_WAITING',
      statusCode: 409, sent: false });
  }
  function caravanCold(device, now) {
    if (!device.temperatureGuard.settings.enabled) return false;
    const sensor = devices.find(row => row.id === device.temperatureControl?.sensorDeviceId);
    const air = sensor?.readings.caravan_temperature;
    return Boolean(sensor && sensor.brokerConnected && sensor.liveSinceConnect && availabilityConfirmed(sensor)
      && sensor.subscriptionStatus === 'subscribed' && fresh(sensor, air, now)
      && air.value <= device.temperatureGuard.settings.offAtC);
  }
  function temperatureGuardStatus(device, now) {
    if (!device.temperatureControl) return null;
    const sensor = devices.find(row => row.id === device.temperatureControl.sensorDeviceId);
    const air = sensor?.readings.caravan_temperature, humidity = sensor?.readings.caravan_humidity;
    // RH is informational. A missing humidity field must not invalidate a fresh
    // independent temperature observation or the meter-based recording gate.
    const airFresh = Boolean(sensor && sensor.brokerConnected && sensor.liveSinceConnect && availabilityConfirmed(sensor)
      && sensor.subscriptionStatus === 'subscribed' && fresh(sensor, air, now));
    const report = device.dehumidifierReport, state = device.temperatureGuard, policy = state.settings;
    const meter = caravanPower(device, now), ready = healthy(device, now);
    const qualified = Boolean(ready && meter && state.qualified && state.meterSignature === meter.signature && !state.restoration);
    const probe = state.probe, association = state.qualification.record;
    const interrupted = (probe?.reason ?? association?.failed?.reason) === 'controller-stopping';
    const evidence = probe?.status === 'testing' ? probe.evidence : passedLocationEvidence(state);
    const testStatus = state.restoration && probe?.status !== 'testing' ? 'restoring'
      : interrupted ? 'waiting' : probe?.status ?? (association?.failed ? 'failed' : evidence ? 'passed' : 'waiting');
    const restartAt = ready ? restartNotBefore(device, now) : null;
    return { configured: true, ...policy, canEdit: !closed && canControl() && !probeBusy(device) && validDehumidifierIdentity(state.boundIdentity),
      sensorDeviceId: device.temperatureControl.sensorDeviceId,
      temperatureC: airFresh ? air.value : null, humidity: sensor && fresh(sensor, humidity, now) ? humidity.value : null,
      applianceTemperatureC: fieldFresh(device, 'temperature', now) && scalar(report?.temperature) ? report.temperature : null,
      applianceHumidity: fieldFresh(device, 'humidity', now) && scalar(report?.humidity) ? report.humidity : null,
      qualified,
      locationTest: { status: testStatus, phase: probe?.phase ?? null, reason: probe?.reason ?? association?.failed?.reason ?? null,
        completedAt: evidence?.completedAt ?? association?.failed?.at ?? null,
        minimumPowerChangeW: 3, powerRiseW: evidence?.powerRiseW ?? null, powerFallW: evidence?.powerFallW ?? null },
      qualification: { signature: association?.signature ?? (state.qualificationKey ? qualificationSignature(device, state.meterSignature) : null),
        revision: association?.revision ?? 0,
        retained: Boolean(association?.proof && association.invalidatedAt === null && !association.failed),
        passedAt: association?.proof?.completedAt ?? null,
        unavailableSince: state.qualification.outageAt,
        stableSince: state.qualification.stable?.startedAt ?? null,
        canRecheck: ready && Boolean(meter) && Boolean(state.qualificationKey) && !closed && canControl() && !probeBusy(device)
          && qualificationSignature(device, meter.signature) === (association?.signature ?? qualificationSignature(device, state.meterSignature))
          && association?.recheckAt == null
          && !['publishing', 'published'].includes(device.dehumidifierOperation?.status) },
      recording: qualified && device.record !== false && scalar(state.recordingSince) && !state.sourceTimeWait
        && dehumidifierHistory(device, now).value !== null
        && device.readings[device.stateSignal]?.observedAt >= state.recordingSince,
      desiredPower: policy.enabled ? state.demand ? 'on' : 'off' : null,
      powerRestartNotBefore: restartAt,
      restartWaiting: restartAt !== null && restartWait(device, now),
      reason: !ready ? 'appliance-unavailable' : testStatus === 'restoring' ? 'restoring-power'
        : !meter ? 'power-unavailable' : !canControl() && !qualified ? 'control-unavailable'
          : !qualified && caravanCold(device, now) ? 'cold'
          : interrupted ? 'power-check-interrupted' : testStatus === 'failed' ? 'power-test-failed'
            : !qualified && probe?.status !== 'testing' ? association?.proof && association.invalidatedAt === null
              ? 'recovering-feedback' : 'waiting-stable-feedback' : !qualified ? 'checking-power'
            : !policy.enabled ? 'disabled' : !airFresh ? 'air-unavailable'
              : air.value <= policy.offAtC ? 'cold' : air.value >= policy.onAtC ? 'warm' : 'hysteresis' };
  }
  const restorationKey = (device, identity = device.temperatureGuard.boundIdentity) => `equipment:caravan-probe-restoration:v1:${device.id}:${identity}`;
  function saveRestoration(device, value) {
    store.setState(restorationKey(device), value);
    device.temperatureGuard.restoration = value;
  }
  function restoreProbePower(device, now) {
    const state = device.temperatureGuard, obligation = state.restoration;
    if (!obligation) return true;
    if (obligation.identity !== device.dehumidifierReport?.identity || obligation.signature !== signature(device.id)) return false;
    if (!powerFeedbackReady(device, now) || !canControl() || closed) return false;
    const powerAt = device.dehumidifierReport.fieldTimestamps.power;
    // Reconcile a persisted intent with independently received native feedback.
    // Neither a publish acknowledgement nor an old cached OFF discharges it.
    if (device.dehumidifierState.power === obligation.power && powerAt > obligation.lastCommandAt) {
      saveRestoration(device, null);
      return true;
    }
    const operation = device.dehumidifierOperation;
    if (operation?.origin === 'location-restoration' && now - operation.requestedAt < 30_000) return false;
    if (now <= obligation.lastCommandAt) return false;
    if (obligation.power === 'on' && restartWait(device, now)) return false;
    saveRestoration(device, { ...obligation, lastCommandAt: now });
    reception.afterCommit(() => { void commandDehumidifier(device, 'power', obligation.power, 'location-restoration').catch(() => {}); });
    return false;
  }
  function checkCaravanLocation(device, now) {
    if (!device.temperatureControl) return;
    const state = device.temperatureGuard, meter = caravanPower(device, now);
    const ready = healthy(device, now);
    if (meter) ensureQualification(device, meter);
    const watch = state.qualification;
    const qualificationNow = engine.clock(), originalLossAt = qualificationLossAt(device, qualificationNow);
    if (originalLossAt < qualificationNow || scalar(watch.lastPowerAt) && qualificationNow >= watch.lastPowerAt + device.maxAgeMs
      || scalar(watch.lastMeterAt) && qualificationNow >= watch.lastMeterAt + (enabled.find(row => row.id === 'caravan' && row.area === device.area)?.maxAgeMs || settings.maxAgeMs))
      loseCaravanQualification(watch, originalLossAt);
    const appliancePending = !ready && pendingFor(device) && healthy(device, now, true);
    const meterPending = !meter && caravanPower(device, now, true);
    const wait = state.sourceTimeWait;
    if (wait) {
      const expiry = state.sourceTimeWaitExpiry;
      const sessionLost = !state.sessionActive || !state.qualified || !passedLocationEvidence(state) || state.restoration
        || device.dehumidifierReport?.identity !== wait.identity || state.meterSignature !== wait.meterSignature
        || !healthy(device, now, true) || caravanPower(device, now, true)?.signature !== wait.meterSignature
        || !expiry || now >= expiry.powerDeadline || now >= expiry.meterDeadline;
      if (sessionLost || now >= wait.deadline || dehumidifierHistory(device, now).value === null) {
        state.sourceTimeWait = null; state.sourceTimeWaitExpiry = null; state.recordingSince = null;
        if (sessionLost) {
          loseCaravanQualification(watch, Math.min(now, expiry?.powerDeadline ?? now, expiry?.meterDeadline ?? now));
          state.qualified = false;
        }
        else {
          // Fan freshness gates history, independently of the electrical test.
          // A later report must cross this real history loss; no new power test.
          device.dehumidifierHistoryAfter = now;
        }
      }
    }
    if (!ready && !appliancePending || !meter && !meterPending || meter && state.meterSignature && state.meterSignature !== meter.signature) {
      if (state.probe?.status === 'testing') abortCaravanProbe(state.probe, !ready ? 'appliance-unavailable' : 'power-unavailable', now);
      loseCaravanQualification(watch, qualificationLossAt(device, now));
      state.qualified = false; state.sourceTimeWait = null; state.sourceTimeWaitExpiry = null;
    }
    if (state.probe?.status === 'testing' && (!canControl() || closed)) {
      abortCaravanProbe(state.probe, 'control-unavailable', now); state.qualified = false;
    }
    if (state.probe?.status === 'testing' && caravanCold(device, now)) {
      abortCaravanProbe(state.probe, 'cold', now);
      // The enabled cold-Off choice supersedes restoring an earlier On.
      if (state.restoration) saveRestoration(device, { ...state.restoration, power: 'off' });
    }
    // Source-time quarantine is not a new connection. Keep the existing test
    // and failure result, but admit no test evidence or test command while waiting.
    if ((appliancePending || meterPending) && state.probe?.status === 'testing') {
      if (now >= state.probe.deadlineAt) advanceCaravanProbe(state.probe, { now });
      else return;
    }
    if (state.probe?.status === 'failed') saveLocationResult(device, now, false);
    // Slightly future input still uses the existing recording-only quarantine.
    // It is not a physical/source outage while the original evidence is fresh.
    if (appliancePending || meterPending) return;
    const recovery = advanceCaravanQualification(watch, { now: qualificationNow,
      healthy: Boolean(healthy(device, qualificationNow) && caravanPower(device, qualificationNow)),
      powerAt: device.dehumidifierReport?.fieldTimestamps.power, meterAt: meter?.observedAt,
      lostAt: qualificationLossAt(device, qualificationNow) });
    persistQualification(device);
    if (state.probe?.status !== 'testing' && !restoreProbePower(device, now)) return;
    if (!ready || !meter) return;
    if (state.probe?.status === 'passed' && watch.record?.proof?.completedAt !== state.probe.evidence.completedAt) {
      saveLocationResult(device, now, true);
      state.qualified = true; state.sessionActive = true; return;
    }
    if (recovery.ready) { state.qualified = true; state.sessionActive = true; return; }
    state.qualified = false;
    if (!canControl() || closed || caravanStopping) return;
    if (watch.record?.failed?.reason === 'controller-stopping' && recovery.testReady) {
      // One new bounded check for this controller interruption, after restoration
      // and independently advancing recovery. A measured retry failure still latches.
      watch.record.failed = null; watch.record.revision++;
      state.probe = null; state.sessionActive = false; persistQualification(device);
    }
    if (watch.record?.failed?.reason === 'cold' && !caravanCold(device, now)) {
      watch.record.failed = null; state.probe = null; state.sessionActive = false; persistQualification(device);
    }
    if (state.probe?.status !== 'testing' && !recovery.testReady) return;
    if (!state.sessionActive) {
      state.probe = null; state.qualified = false; state.managed = false; state.sourceTimeWait = null; state.sourceTimeWaitExpiry = null;
      state.meterSignature = meter.signature; state.sessionActive = true;
    }
    if (state.probe?.status === 'passed' || state.probe?.status === 'failed' && !watch.record?.failed) state.probe = null;
    if (caravanCold(device, now)) return;
    if (state.probe?.reason === 'cold') state.probe = null;
    if (state.probe?.status === 'failed') return;
    if (!device.dehumidifierReport.capabilities.power?.includes('on') || !device.dehumidifierReport.capabilities.power?.includes('off')) return;
    const operation = device.dehumidifierOperation;
    if (operation?.origin === 'location-test' && operation.status === 'publishing' && !scalar(operation.dispatchedAt)) return;
    if (!state.probe) {
      if (['publishing', 'published'].includes(operation?.status)) return;
      state.probe = createCaravanProbe({ now, initialPower: device.dehumidifierState.power });
      state.probe.qualificationSignature = qualificationSignature(device, meter.signature);
    }
    // The native bridge fences command replays by request time.
    if (operation && now <= operation.requestedAt) return;
    const result = advanceCaravanProbe(state.probe, { now, power: device.dehumidifierState.power,
      powerObservedAt: device.dehumidifierReport.fieldTimestamps.power, meterPowerW: meter.watts, meterObservedAt: meter.observedAt,
      canStart: !restartWait(device, now), restartNotBefore: restartNotBefore(device, now) });
    if (state.probe.reason === 'power-changed-externally') {
      saveRestoration(device, null); return;
    }
    if (result.command) {
      const original = state.restoration?.power ?? state.probe.initialPower;
      saveRestoration(device, { signature: signature(device.id), identity: device.dehumidifierReport.identity,
        power: original, lastCommandAt: now });
      const probe = state.probe;
      reception.afterCommit(() => {
        if (device.temperatureGuard.probe !== probe || probe.status !== 'testing') return;
        void commandDehumidifier(device, 'power', result.command, 'location-test').catch(() => {
          if (device.temperatureGuard.probe === probe) abortCaravanProbe(probe, 'command-unconfirmed', engine.clock());
        });
      });
    }
    if (state.probe.status !== 'testing') {
      if (state.probe.status === 'failed') saveLocationResult(device, now, false);
      if (state.probe.status === 'passed') saveLocationResult(device, now, true);
      if (restoreProbePower(device, now) && state.probe.status === 'passed') {
        state.qualified = true;
      }
    }
  }
  function recordDehumidifierLocation(device, now) {
    const location = temperatureGuardStatus(device, now);
    if (!location) return true;
    const state = device.temperatureGuard, qualified = location.qualified;
    // A new capture has no local qualified-to-unqualified edge. Its first
    // admitted, usable appliance report still establishes that recording is
    // blocked; older saved state must not imply a fresh or missing MQTT feed.
    const firstFreshGate = !state.recordingGateObserved && healthy(device, now)
      && dehumidifierHistory(device, now).value !== null;
    if (!qualified && (device.recordingLocation || firstFreshGate)) {
      const reading = device.readings[device.stateSignal], history = dehumidifierHistory(device, now);
      const meter = caravanPower(device, now, true);
      const pending = pendingFor(device) || !caravanPower(device, now) && meter;
      // Only an already recorded state in the same passed session may survive
      // this short quarantine. Real loss, first qualification and expiry need
      // new evidence and retain their existing recording fence.
      if (device.record !== false && pending && state.qualified && state.sessionActive && passedLocationEvidence(state) && !state.restoration
        && healthy(device, now, true) && history.value !== null && reading?.availabilityConfirmed
        && scalar(state.recordingSince) && reading.observedAt >= state.recordingSince
        && meter?.signature === state.meterSignature) {
        state.sourceTimeWait = {
          startedAt: now, recordingSince: state.recordingSince, identity: device.dehumidifierReport.identity,
          meterSignature: meter.signature, deadline: Math.min(history.deadline, meter.deadline) };
        state.sourceTimeWaitExpiry = { powerDeadline: device.dehumidifierReport.fieldTimestamps.power + device.maxAgeMs,
          meterDeadline: meter.deadline };
      }
      if (device.record !== false) engine.ingest({ ...identity(device), signal: device.stateSignal, value: null, unit: 'state',
        sourceTime: null, receivedAt: now, quality: ['location-unconfirmed'],
        raw: { timeBasis: 'availability-transition', ...dehumidifierMetadata(device),
          ...(state.sourceTimeWait ? { sourceTimeWait: { ...state.sourceTimeWait } } : {}) } });
      state.recordingGateObserved = true;
      if (device.readings[device.stateSignal]) device.readings[device.stateSignal].availabilityConfirmed = false;
    }
    if (!qualified) state.recordingSince = state.sourceTimeWait?.recordingSince ?? null;
    else if (!device.recordingLocation && !state.sourceTimeWait) state.recordingSince = now;
    device.recordingLocation = qualified;
    return qualified && dehumidifierHistory(device, now).value !== null
      && device.readings[device.stateSignal]?.observedAt >= state.recordingSince;
  }
  function confirmCaravanSources(now) {
    return reception.run(() => {
      for (const device of devices.filter(row => row.temperatureControl)) {
        confirmDehumidifier(device, now); controlTemperature(device, now);
      }
    });
  }
  function keepTemperatureBaseline(device, guard, now) {
    const state = device.temperatureGuard;
    return Boolean(!guard.qualified && (state.qualification.record?.proof || state.qualified)
      && scalar(guard.temperatureC) && guard.temperatureC > guard.offAtC
      && healthy(device, now, true) && caravanPower(device, now, true));
  }
  function clearTemperatureAttempt(device, at, power) {
    // Reception rollback restores this copied state while preserving the
    // caller's exact operation owner. Clear only its still-current retry slots.
    const state = device.temperatureGuard;
    if (state.lastAttemptAt !== at || state.lastAttemptPower !== power) return;
    state.lastAttemptAt = null; state.lastAttemptPower = null;
  }
  function controlTemperature(device, now) {
    const guard = temperatureGuardStatus(device, now);
    if (!guard?.enabled || probeBusy(device) || caravanStopping) return;
    const state = device.temperatureGuard;
    // Historical proof grants no On permission. Keep the existing native baseline
    // while recovery/retesting is pending or failed; cold/missing air protects Off.
    if (keepTemperatureBaseline(device, guard, now)) return;
    if (state.qualification.record?.proof && state.qualification.record.invalidatedAt === null
      && (!scalar(guard.temperatureC) || guard.temperatureC <= guard.offAtC) && healthy(device, now)) state.managed = true;
    if (guard.qualified && scalar(guard.temperatureC)) {
      if (!closed && canControl()) state.managed = true;
      if (guard.temperatureC <= guard.offAtC) state.demand = false;
      else if (guard.temperatureC >= guard.onAtC) state.demand = true;
    } else state.demand = false;
    // Loss of room evidence stops an appliance previously managed here. A
    // newly discovered appliance elsewhere receives no commands.
    const value = state.demand ? 'on' : 'off';
    if (value === 'on' && restartWait(device, now)) return;
    if (!state.managed || !(value === 'off' ? powerFeedbackReady(device, now) : healthy(device, now)) || !canControl() || closed) return;
    const operation = device.dehumidifierOperation;
    const pending = ['publishing', 'published'].includes(operation?.status);
    const uncertainOn = operation?.setting === 'power' && operation.value === 'on' && operation.status !== 'observed';
    if (operation && now <= operation.requestedAt) return;
    if (pending && (value !== 'off' || operation.setting === 'power' && operation.value === 'off')) return;
    if (device.dehumidifierState.power === value && !(value === 'off' && uncertainOn) || state.lastAttemptPower === value
      && state.lastAttemptAt !== null && now - state.lastAttemptAt < 30_000) return;
    state.lastAttemptAt = now; state.lastAttemptPower = value;
    reception.afterCommit(() => {
      const currentAt = engine.clock(), current = temperatureGuardStatus(device, currentAt);
      if (!current?.enabled || value === 'on' && (!current.qualified || !device.temperatureGuard.demand)) return;
      if (value === 'off' && keepTemperatureBaseline(device, current, currentAt)) {
        if (device.dehumidifierOperation === operation) clearTemperatureAttempt(device, now, value);
        return;
      }
      void commandDehumidifier(device, 'power', value, 'temperature').catch(() => {});
    });
  }
  function confirmDoor(device, now) {
    if (device.kind !== 'door' || !healthy(device, now)) return;
    for (const definition of definitions(device)) {
      const reading = device.readings[definition.signal];
      if (!fresh(device, reading, now) || reading.availabilityConfirmed) continue;
      reading.availabilityConfirmed = true; reading.confirmedAt = now;
      const observation = device.record !== false && definition.record !== false ? { ...identity(device),
        signal: definition.signal, value: reading.value, unit: reading.unit, sourceTime: reading.observedAt,
        receivedAt: now, quality: reading.quality,
        raw: { timeBasis: 'mqtt-live-status', ...(device.maxAgeMs === 0 ? { eventOnly: true } : {}),
          availabilityConfirmed: true, confirmedAt: now,
          ...(reading.timeAdmission ? { timeAdmission: reading.timeAdmission } : {}) } } : null;
      const saved = definition.signal === device.stateSignal ? { key: `equipment:door:v1:${device.id}`,
        value: { signature: signature(device.id), reading } } : null;
      if (observation || saved) doorRecording.save(observation, saved);
    }
    const operation = device.coverOperation, main = device.readings[device.stateSignal];
    if (operation && scalar(operation.dispatchedAt) && operation.action !== 'stop' && !['failed', 'observed'].includes(operation.status)
      && main.revision > operation.dispatchedRevision
      && main.receivedAt >= operation.dispatchedAt && main.observedAt >= operation.dispatchedAt
      && main.coverState === (operation.action === 'open' ? 'open' : 'closed')) {
      operation.observedAt = main.observedAt;
      if (operation.acknowledgedAt !== undefined) { operation.status = 'observed'; delete operation.error; }
    }
  }
  function confirmDehumidifier(device, now) {
    const operation = device.dehumidifierOperation, report = device.dehumidifierReport;
    if (device.temperatureControl && device.temperatureGuard.nativePowerContinuity && !powerFeedbackReady(device, now, true)) {
      device.temperatureGuard.nativeRestartMonotonicDeadline = null; device.temperatureGuard.nativePowerContinuity = false;
      device.temperatureGuard.nativePowerContinuityLostAt = Math.max(device.temperatureGuard.nativePowerContinuityLostAt, now);
    }
    const dispatch = dehumidifierDispatches.get(device);
    if (dispatch?.operation === operation && !scalar(operation.dispatchedAt)
      && ['location-test', 'location-restoration'].includes(operation.origin)
      && powerFeedbackReady(device, now) && report?.identity === operation.identity && report.fieldTimestamps.power > dispatch.powerAt
      && device.dehumidifierState.power !== dispatch.power) {
      // No command has left yet. A newer independent choice must also cancel
      // the captured restoration, or failure would overwrite that choice.
      if (device.temperatureGuard.probe?.status === 'testing')
        abortCaravanProbe(device.temperatureGuard.probe, 'power-changed-externally', now);
      saveRestoration(device, null);
      reception.afterCommit(() => dispatch.cancellation.abort());
    }
    if (operation && operation.status !== 'observed' && scalar(operation.dispatchedAt) && report && report.identity === operation.identity
      && report.receivedAt >= operation.dispatchedAt && fieldFresh(device, operation.setting, now)
      && report.fieldTimestamps[operation.setting] >= operation.dispatchedAt
      && device.dehumidifierState[operation.setting] === operation.value) {
      operation.observedAt = report.fieldTimestamps[operation.setting];
      if (operation.acknowledgedAt !== undefined) { operation.status = 'observed'; delete operation.error; }
    }
    checkCaravanLocation(device, now);
    const history = dehumidifierHistory(device, now);
    if (history.value === null && device.readings[device.stateSignal]?.value != null)
      record(device, definitions(device)[0], null, null, now, ['state-evidence-unavailable']);
    const located = recordDehumidifierLocation(device, now);
    if (!healthy(device, now)) return;
    const reading = device.readings[device.stateSignal];
    const meter = device.temperatureControl ? caravanPower(device, now) : null;
    const locationDeadline = Math.min(history.deadline, meter?.deadline ?? history.deadline);
    if (located && history.value !== null && (!reading.availabilityConfirmed || reading.recordedDeadline !== locationDeadline)) {
      const report = device.dehumidifierReport;
      const wait = device.temperatureGuard.sourceTimeWait;
      const observation = { ...identity(device), signal: device.stateSignal, value: reading.value,
        unit: reading.unit, sourceTime: reading.observedAt, receivedAt: wait ? reading.receivedAt : now, quality: reading.quality,
        raw: { timeBasis: 'mqtt-live-status', ...dehumidifierMetadata(device), availabilityConfirmed: true,
          identity: report.identity, fieldTimestamps: history.fieldTimestamps,
          ...(wait ? { sourceTimeWait: { ...wait }, ...(reading.timeAdmission ? { timeAdmission: reading.timeAdmission } : {}) } : {}),
          ...(meter ? { locationEvidence: { method: 'native-power-cycle-v1',
            ...caravanAssociationProof(passedLocationEvidence(device.temperatureGuard)),
            meterSignature: meter.signature, meterObservedAt: meter.observedAt, maxAgeMs: meter.maxAgeMs } } : {}) } };
      if (wait && device.record !== false) {
        const resumed = engine.recorder?.resumeCaravanRecording(observation, now);
        if (resumed?.changed) engine.rememberObservation?.(resumed.observation, now);
        else {
          // A genuinely newer native state can end the gap through ordinary
          // recording. Keep its actual receipt and delayed admission proof.
          if (reading.observedAt < wait.startedAt) return;
          const result = engine.ingest(observation);
          if (result?.observation?.raw?.recorder?.status !== 'fresh') return;
        }
        device.temperatureGuard.sourceTimeWait = null; device.temperatureGuard.sourceTimeWaitExpiry = null;
      } else if (device.record !== false) engine.ingest(observation);
      reading.availabilityConfirmed = true; reading.recordedDeadline = locationDeadline;
    }
  }

  function signature(id) {
    const config = enabled.find(row => row.id === id);
    if (!config) return null;
    const target = config.protocol === 'shelly' ? native.signature(id) : equipmentSignature(config);
    const brokerDigest = createHash('sha256').update(JSON.stringify(brokerIdentityForDevice(config))).digest('hex');
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
  function loadRestoration(device, identity) {
    const saved = store.getState?.(restorationKey(device, identity));
    if (!saved) return null;
    if (typeof saved !== 'object' || Object.keys(saved).sort().join(',') !== 'identity,lastCommandAt,power,signature'
      || saved.identity !== identity || !validDehumidifierIdentity(saved.signature)
      || !['on', 'off'].includes(saved.power) || !Number.isSafeInteger(saved.lastCommandAt) || saved.lastCommandAt < 0)
      throw fail('saved caravan power restoration is invalid');
    // A changed route cannot inherit authority or overwrite an unresolved
    // physical obligation. Keep it visible until the original route returns.
    return saved;
  }
  function loadNativePowerTiming(device, identity) {
    const route = signature(device.id);
    return validateCaravanPowerTiming(store.getState?.(caravanPowerTimingKey(device.id, identity, route)),
      { identity, signature: route });
  }
  for (const device of devices.filter(row => row.temperatureControl && row.temperatureGuard.boundIdentity))
    { device.temperatureGuard.restoration = loadRestoration(device, device.temperatureGuard.boundIdentity);
      device.temperatureGuard.nativePowerTiming = loadNativePowerTiming(device, device.temperatureGuard.boundIdentity); }
  for (const device of devices.filter(row => row.kind === 'door')) {
    const saved = store.getState?.(`equipment:door:v1:${device.id}`);
    if (saved?.signature === signature(device.id) && saved.reading) device.readings[device.stateSignal] = {
      ...saved.reading, unavailable: true, quality: [...new Set([...(saved.reading.quality ?? []), 'last-reported', 'awaiting-report'])] };
  }
  function receiveDevice(device, topic, body, packet, receivedAt, receivedMonotonicAt) {
    const evaluatedAt = admittedReceptionAt ?? receivedAt;
    const mapping = device.mqtt;
    device.lastReceivedAt = receivedAt;
    if (packet.retain) device.lastRetainedAt = receivedAt; else device.lastLiveAt = receivedAt;
    for (const check of device.checks) if (packet.retain) check.retainedReceived = true;
    if (topic === mapping.bridgeAvailabilityTopic) {
      if (device.kind !== 'door' && ['online', 'offline'].includes(body)) reception.accept();
      if (body === 'offline') { device.bridgeOnline = false; device.online = null; unavailable(device, 'bridge-offline', receivedAt); }
      else if (body === 'online') {
        const needsReadback = device.bridgeOnline === false || !device.liveSinceConnect;
        device.bridgeOnline = true;
        // Bridge birth restores connectivity context, never the child reading.
        // Ask the explicit endpoint once subscriptions are ready to recover it.
        if (!packet.retain && needsReadback && device.subscriptionStatus === 'subscribed' && mapping.requestTopic && !device.checks.size)
          if (device.kind === 'door') void api.recheck({ deviceId: device.id }).catch(() => {});
          else reception.afterCommit(() => { void api.recheck({ deviceId: device.id }).catch(() => {}); });
        completeChecks(device, receivedAt);
      }
      return;
    }
    if (topic === mapping.availabilityTopic) {
      if (device.kind !== 'door' && [mapping.onlinePayload, mapping.offlinePayload].includes(body)) reception.accept();
      if (body === mapping.offlinePayload) { device.online = false; unavailable(device, 'device-offline', receivedAt); }
      else if (body === mapping.onlinePayload && !packet.retain) { device.online = true; completeChecks(device, receivedAt); }
      return;
    }
    if (topic === mapping.heartbeatTopic) {
      if (!packet.retain && device.kind !== 'door') reception.accept();
      if (!packet.retain) { device.heartbeatAt = receivedAt; completeChecks(device, receivedAt); }
      return;
    }
    if (packet.retain && canonicalTemperature(device) && device.liveSinceConnect) return;
    const input = parse(body), explicitTimestamp = mapping.timestampPath ? property(input, mapping.timestampPath) : input && typeof input === 'object' ? input.timestamp : undefined;
    const at = explicitTimestamp === undefined ? packet.retain ? null : receivedAt : sourceTime(explicitTimestamp);
    const invalidTime = Boolean(mapping.timestampPath && explicitTimestamp === undefined)
      || explicitTimestamp !== undefined && !validateAdmittedSourceTime({ sourceTime: at, receivedAt,
        admittedAt: admittedReceptionAt, now: evaluatedAt });
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
          device.dehumidifierHistoryAfter = null;
          Object.assign(device.temperatureGuard, { settings: { ...defaultTemperatureControl }, demand: false, managed: false,
            lastAttemptAt: null, lastAttemptPower: null, recordingSince: null, sourceTimeWait: null, sourceTimeWaitExpiry: null,
            probe: null, meterSignature: null, sessionActive: false, restoration: null, qualified: false, recordingGateObserved: false, nativePowerTiming: null,
            qualification: createCaravanQualification(null, engine.clock()), qualificationKey: null, qualificationSaved: null,
            nativeRestartMonotonicDeadline: null, nativePowerContinuity: false, nativePowerContinuityLostAt: evaluatedAt });
          device.recordingLocation = false;
        }
        device.temperatureGuard.boundIdentity = physicalIdentity;
        if (device.temperatureControl) device.temperatureGuard.nativePowerTiming = loadNativePowerTiming(device, physicalIdentity);
        if (device.temperatureControl) device.temperatureGuard.restoration = loadRestoration(device, physicalIdentity);
        if (device.temperatureControl) store.setState(temperatureControlKey(device), {
          signature: temperatureControlSignature(device), identity: physicalIdentity, settings: device.temperatureGuard.settings });
      }
      // Live power authority remains independent of the recorded state. ON
      // history needs both fresh power and a known, freshly observed fan speed.
      const state = dehumidifierState(mapping.statePath ? property(input, mapping.statePath) : input);
      const reportedSnapshot = mapping.statePath ? property(input, mapping.statePath) : input;
      const capabilities = dehumidifierCapabilities(reportedSnapshot?.capabilities);
      const fieldTimestamps = Object.fromEntries([...Object.keys(DEHUMIDIFIER_SETTINGS), 'temperature', 'humidity'].map(field => {
        // The aggregate snapshot clock only orders messages. It cannot establish
        // received native evidence for a field whose own clock is missing.
        const clock = sourceTime(reportedSnapshot?.fieldTimestamps?.[field]);
        return [field, scalar(clock) && clock >= 0 && clock <= at ? clock : null];
      }));
      const prior = device.dehumidifierReport;
      if (device.temperatureControl && device.temperatureGuard.nativePowerContinuity && scalar(prior?.fieldTimestamps.power)
        && Math.max(evaluatedAt, engine.clock()) - prior.fieldTimestamps.power >= device.maxAgeMs) {
        device.temperatureGuard.nativeRestartMonotonicDeadline = null; device.temperatureGuard.nativePowerContinuity = false;
        device.temperatureGuard.nativePowerContinuityLostAt = Math.max(device.temperatureGuard.nativePowerContinuityLostAt,
          prior.fieldTimestamps.power + device.maxAgeMs);
      }
      if (prior && Object.keys(fieldTimestamps).some(field => {
        const previousAt = prior.fieldTimestamps[field], incomingAt = fieldTimestamps[field];
        const previousValue = Object.hasOwn(DEHUMIDIFIER_SETTINGS, field) ? device.dehumidifierState[field] : prior[field];
        const incomingValue = Object.hasOwn(DEHUMIDIFIER_SETTINGS, field) ? state[field] : reportedSnapshot?.[field];
        return scalar(incomingAt) && scalar(previousAt) && (incomingAt < previousAt
          || incomingAt === previousAt && incomingValue !== previousValue);
      })) return;
      const definition = definitions(device)[0];
      const powerAt = fieldTimestamps.power;
      const stale = powerAt === null || receivedAt - powerAt >= device.maxAgeMs;
      const report = { observedAt: at, receivedAt, temperature: reportedSnapshot?.temperature, humidity: reportedSnapshot?.humidity,
        capabilities, fieldTimestamps, identity: physicalIdentity };
      const history = dehumidifierHistory(device, evaluatedAt, state, report);
      updated = record(device, definition, history.value, history.observedAt, receivedAt,
        stale ? ['stale-report'] : state.power === null ? ['invalid-value'] : history.value === null ? ['state-evidence-unavailable'] : []);
      if (updated) {
        device.dehumidifierState = state; device.dehumidifierReport = report;
        if (device.temperatureControl && !stale && ['off', 'on'].includes(state.power)) {
          const timingAt = Math.max(evaluatedAt, engine.clock());
          const previous = device.temperatureGuard.nativePowerTiming;
          let boundary = observeCaravanPower(previous, { identity: physicalIdentity, signature: signature(device.id),
            power: state.power, sourceAt: powerAt, receivedAt, admittedAt: timingAt, offConfirmation: null });
          const guard = device.temperatureGuard;
          const admittedFresh = timingAt - powerAt < device.maxAgeMs;
          const confirmingContinuity = !guard.nativePowerContinuity;
          if (!admittedFresh && guard.nativePowerContinuity) {
            guard.nativeRestartMonotonicDeadline = null; guard.nativePowerContinuity = false; guard.nativePowerContinuityLostAt = timingAt;
          }
          if (admittedFresh && !guard.nativePowerContinuity && powerAt >= guard.nativePowerContinuityLostAt && boundary.power === state.power) {
            // A new native Off after an unknown connection interval confirms
            // its current state, not an unobserved switch event. Preserve the
            // earlier transition and add one conservative hold per connection.
            if (state.power === 'off' && powerAt >= boundary.sourceAt) {
              const confirmation = { sourceAt: powerAt, receivedAt, admittedAt: timingAt };
              const previousUntil = caravanPowerRestartAt(boundary);
              const candidate = { ...boundary, offConfirmation: confirmation };
              if (caravanPowerRestartAt(candidate) >= previousUntil) boundary = candidate;
            }
            guard.nativePowerContinuity = true;
          }
          if (admittedFresh && guard.nativePowerContinuity && boundary.power === state.power
            && (boundary !== previous || confirmingContinuity || guard.nativeRestartMonotonicDeadline === null)) {
            const mono = monotonicNow();
            guard.nativeRestartMonotonicDeadline = state.power === 'off' && validMonotonic(receivedMonotonicAt)
              && mono !== null && receivedMonotonicAt <= mono ? receivedMonotonicAt + CARAVAN_NATIVE_RESTART_DELAY_MS : null;
          }
          if (boundary !== previous) {
            store.setState(caravanPowerTimingKey(device.id, physicalIdentity, signature(device.id)), boundary);
            device.temperatureGuard.nativePowerTiming = boundary;
          }
        }
        reported.add(definition.signal);
      }
      invalid = stale || state.power === null;
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
        receivedAt, admittedAt: admittedReceptionAt, retained: packet.retain, timestampRequired: Boolean(mapping.timestampPath),
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
    if (device.metered && counter && healthy(device, evaluatedAt)) {
      const reading = device.readings[counter.signal];
      if (topic === (counter.topic ?? device.topic) && fresh(device, reading, evaluatedAt) && reading.value >= 0)
        energy.get(device.id)?.receive(reading.value / (counter.unit === 'Wh' ? 1000 : 1), reading.observedAt);
    } else if (device.metered && !counter && healthy(device, evaluatedAt) && topic === device.topic && scalar(input?.energy) && input.energy >= 0)
      energy.get(device.id)?.receive(input.energy, at);
    for (const check of device.checks) if (receivedAt >= check.at) for (const signal of reported) check.reported.add(signal);
    completeChecks(device, evaluatedAt);
  }
  function completeChecks(device, now) {
    confirmDoor(device, now);
    if (device.kind === 'door') {
      for (const check of [...device.checks]) if (check.ready && definitions(device).filter(row => row.required).every(row => check.reported.has(row.signal))) {
        if (healthy(device, now)) check.finish('available');
        else if (device.invalid) check.finish('needs-attention');
      }
      return;
    }
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
  async function switchDevice(device, on, { beforePublish: validate = () => {} } = {}) {
    if (!device || typeof on !== 'boolean') throw fail('invalid switch selection');
    if (!device.brokerConnected || closed || !canControl()) throw fail('control authority unavailable');
    if (device.waiters.size) throw fail('switch operation already in progress');
    const deadline = engine.clock() + readbackTimeoutMs, monotonicDeadline = performance.now() + readbackTimeoutMs;
    const cancellation = new AbortController();
    await new Promise((resolve, reject) => {
      let completed = false, recordingDeadlineExpired = false;
      const waiter = { id: ++sequence, at: engine.clock(), on, observed: false, published: false, dispatched: false, revision: sequence, finish: (reason, expired = false) => {
        if (completed) return;
        if (!reason && (!canControl() || !device.brokerConnected || closed)) reason = fail('control authority unavailable');
        recordingDeadlineExpired = expired;
        completed = true; clearTimeout(timer); device.waiters.delete(waiter); cancellation.abort();
        reason ? reject(waiter.dispatched ? fail('switch publication or state confirmation failed; delivery unconfirmed')
          : unsentEquipmentCommand(reason, expired)) : resolve();
      } };
      const timer = setTimeout(() => waiter.finish(fail('state confirmation timed out; delivery unconfirmed'), true), readbackTimeoutMs);
      device.waiters.add(waiter);
      const beforePublish = () => {
        validate();
        if (completed || cancellation.signal.aborted || engine.clock() >= deadline || performance.now() >= monotonicDeadline
          || !canControl() || !device.brokerConnected || closed)
          throw fail('switch control is unavailable');
        waiter.dispatched = true; waiter.at = engine.clock(); waiter.revision = sequence;
      };
      Promise.resolve().then(() => publish(device.mqtt.commandTopic, on ? device.mqtt.onPayload : device.mqtt.offPayload,
        { qos: 1, retain: false, noReplay: true, beforePublish, signal: cancellation.signal,
          recordingContext: 'switch-command', recordingDeadlineExpired: () => recordingDeadlineExpired }, device.broker))
        .then(() => { waiter.published = true; if (waiter.observed) waiter.finish(); }, error => waiter.finish(error));
    });
    return { confirmed: true, status: 'confirmed', deviceId: device.id, on, sent: true, acknowledgement: 'mqtt-live-state' };
  }
  async function commandDehumidifier(device, setting, value, origin) {
    if (closed || !canControl() || !validDehumidifierIdentity(device.dehumidifierReport?.identity)
      || !(setting === 'power' && value === 'off' ? powerFeedbackReady(device, engine.clock()) : healthy(device, engine.clock())))
      throw fail('dehumidifier control is unavailable');
    if (!device.dehumidifierReport?.capabilities[setting]?.includes(value))
      throw fail('the dehumidifier has not advertised support for this setting');
    assertRestartReady(device, setting, value, engine.clock());
    const previousOperation = device.dehumidifierOperation;
    if (device.dehumidifierOperation && ['publishing', 'published'].includes(device.dehumidifierOperation.status)) {
      if (!['temperature', 'location-test', 'location-restoration'].includes(origin) || setting !== 'power' || value !== 'off')
        throw fail('dehumidifier operation already in progress; wait for its live report');
      // A cold boundary or missing room evidence must not wait for a pending
      // ON acknowledgement. MQTT publishes retain their original request order.
      device.dehumidifierOperation.status = 'unconfirmed';
      device.dehumidifierOperation.error = 'Superseded by native power restoration or protection Off.';
    }
    dehumidifierDispatches.get(device)?.cancellation.abort();
    const operation = { setting, value, origin, identity: device.dehumidifierReport.identity, status: 'publishing', requestedAt: engine.clock() };
    const expiresAt = operation.requestedAt + Math.min(readbackTimeoutMs, 10_000);
    const cancellation = new AbortController(), probe = device.temperatureGuard.probe;
    let restoration = device.temperatureGuard.restoration;
    const previousValue = device.dehumidifierState[setting], previousAt = device.dehumidifierReport.fieldTimestamps[setting];
    let recordingDeadlineExpired = false;
    const timer = setTimeout(() => { recordingDeadlineExpired = true; cancellation.abort(); }, Math.min(readbackTimeoutMs, 10_000));
    const dispatch = { cancellation, operation, power: device.dehumidifierState.power, powerAt: device.dehumidifierReport.fieldTimestamps.power };
    const attemptAt = device.temperatureGuard.lastAttemptAt;
    let supersededBeforeDispatch = false;
    dehumidifierDispatches.set(device, dispatch);
    device.dehumidifierOperation = operation;
    const validateDispatch = () => {
      const now = engine.clock(), state = device.temperatureGuard;
      if (cancellation.signal.aborted || now >= expiresAt || closed || !canControl()
        || device.dehumidifierOperation !== operation || operation.status !== 'publishing'
        || device.dehumidifierReport?.identity !== operation.identity
        || !(setting === 'power' && value === 'off' ? powerFeedbackReady(device, now) : healthy(device, now)))
        throw fail('dehumidifier control is unavailable');
      if (!device.dehumidifierReport.capabilities[setting]?.includes(value))
        throw fail('the dehumidifier has not advertised support for this setting');
      assertRestartReady(device, setting, value, now);
      if (device.dehumidifierReport.fieldTimestamps[setting] > previousAt && device.dehumidifierState[setting] !== previousValue)
        throw fail('dehumidifier setting changed before dispatch');
      if (origin === 'manual' && (probeBusy(device) || caravanStopping
        || setting === 'power' && device.temperatureControl && state.settings.enabled))
        throw fail('dehumidifier control choice changed before dispatch');
      if (origin === 'location-test' && (caravanStopping || state.probe !== probe || probe?.status !== 'testing'
        || state.restoration !== restoration
        || !caravanPower(device, now) || qualificationSignature(device, caravanPower(device, now).signature) !== probe.qualificationSignature
        || value === 'on' && caravanCold(device, now)))
        throw fail('dehumidifier power check changed before dispatch');
      if (origin === 'location-restoration' && (state.restoration !== restoration || !restoration
        || restoration.power !== value || value === 'on' && caravanCold(device, now)))
        throw fail('dehumidifier restoration changed before dispatch');
      if (origin === 'temperature') {
        const guard = temperatureGuardStatus(device, now);
        if (value === 'off' && keepTemperatureBaseline(device, guard, now)) {
          supersededBeforeDispatch = true;
          throw unsentEquipmentCommand();
        }
        if (!guard?.enabled || probeBusy(device) || caravanStopping || value !== (state.demand ? 'on' : 'off')
          || value === 'on' && (!guard.qualified || !state.demand || !scalar(guard.temperatureC) || caravanCold(device, now)))
          throw fail('dehumidifier temperature demand changed before dispatch');
      }
      return now;
    };
    const beforePublish = () => {
      const now = validateDispatch();
      if (origin === 'location-test') {
        probe.commandAt = now; probe.lastCommandAt = now;
        probe.phaseEvidence[probe.phase].commandAt = now;
      }
      operation.dispatchedAt = now;
    };
    const preparePublish = async () => {
      if (!['location-test', 'location-restoration'].includes(origin) || !restoration) return;
      await write(() => {
        const now = validateDispatch();
        if (now <= restoration.lastCommandAt) return;
        const previous = restoration, obligation = { ...restoration, lastCommandAt: now };
        // Commit the command's recovery obligation before publication. A report
        // that replaces or clears it during this wait revokes dispatch below.
        store.setState(restorationKey(device), obligation);
        store.afterCommit(() => {
          if (device.temperatureGuard.restoration === previous) {
            device.temperatureGuard.restoration = obligation; restoration = obligation;
          }
        });
      }, { priority: 'control', signal: cancellation.signal,
        isCurrent: () => !closed && canControl() && !cancellation.signal.aborted });
    };
    try {
      await publish(device.mqtt.commandTopic, JSON.stringify({ [setting]: value,
        identity: operation.identity, requestedAt: operation.requestedAt, expiresAt }),
      { qos: 1, retain: false, noReplay: true, beforePublish,
        ...(['location-test', 'location-restoration'].includes(origin) && restoration ? { preparePublish } : {}),
        recordingContext: 'caravan-command', recordingKind: 'mutation', recordingDeadlineExpired: () => recordingDeadlineExpired,
        signal: cancellation.signal }, device.broker);
      operation.acknowledgedAt = engine.clock();
      if (operation.status === 'publishing') operation.status = operation.observedAt !== undefined ? 'observed' : 'published';
      if (closed || !canControl() || !device.brokerConnected) {
        operation.status = 'unconfirmed'; operation.error = 'Control connection changed. Check the dehumidifier live state.';
      }
    } catch (error) {
      if (supersededBeforeDispatch && !scalar(operation.dispatchedAt)) {
        const failure = unsentEquipmentCommand(error);
        operation.status = 'failed'; operation.error = failure.message; operation.code = failure.code;
        if (device.dehumidifierOperation === operation && dehumidifierDispatches.get(device) === dispatch) {
          clearTemperatureAttempt(device, attemptAt, value);
          // Cancelling these unsent bytes cannot erase an earlier command's
          // unresolved delivery. Its original callback still owns this receipt.
          if (scalar(previousOperation?.dispatchedAt) && !['observed', 'failed'].includes(previousOperation.status)) {
            previousOperation.status = 'unconfirmed';
            previousOperation.error = 'Dehumidifier command delivery is unconfirmed. Check its live state before trying again.';
            device.dehumidifierOperation = previousOperation;
          }
        }
        throw failure;
      }
      operation.status = 'unconfirmed'; operation.error = 'Dehumidifier command delivery is unconfirmed. Check its live state before trying again.';
      throw fail('dehumidifier command delivery is unconfirmed; check its live state');
    } finally {
      clearTimeout(timer);
      if (dehumidifierDispatches.get(device) === dispatch) dehumidifierDispatches.delete(device);
      cancellation.abort();
    }
    return { ...operation, deviceId: device.id, acknowledgement: 'mqtt-broker', confirmed: operation.status === 'observed' };
  }
  const api = {
    receptionKey(topic, payload, broker) {
      const nativeKey = broker === 'primary' ? native?.receptionKey(topic, payload) : null;
      if (nativeKey) return nativeKey;
      return devices.some(device => device.broker === broker && readTopics(device).includes(topic)) ? JSON.stringify(['equipment-mqtt', topic]) : null;
    },
    isReadRequest(topic, payload, broker) {
      return broker === 'primary' && native?.isReadRequest(topic, payload)
        || devices.some(device => device.broker === broker && topic === device.mqtt.requestTopic
          && String(payload) === device.mqtt.requestPayload);
    },
    isDoorCommand(topic, payload, broker) {
      return devices.some(device => device.kind === 'door' && device.controlsCover && device.broker === broker
        && topic === device.mqtt.commandTopic && ['openPayload', 'closePayload', 'stopPayload']
          .some(field => device.mqtt[field] && String(payload) === device.mqtt[field]));
    },
    topics: [...new Set([...(native?.topics ?? []), ...devices.flatMap(readTopics)])],
    ownsGarage: settings.ownsGarage === true, hasDhwr: Boolean(native?.hasDhwr),
    publishDhwr: (on, options) => native.publishDhwr(on, options), hasHeating: enabled.some(device => device.controlsHeat), signature,
    topicsForBroker(broker) { return [...new Set([...(broker === 'primary' ? native?.topics ?? [] : []),
      ...devices.filter(device => device.broker === broker).flatMap(readTopics)])]; },
    doorTopicsForBroker(broker) { return [...new Set(devices.filter(device => device.kind === 'door' && device.broker === broker).flatMap(readTopics))]; },
    recordedTopicsForBroker(broker) { return [...new Set([...(broker === 'primary' ? native?.topics ?? [] : []),
      ...devices.filter(device => device.kind !== 'door' && device.broker === broker).flatMap(readTopics)])]; },
    setConnected(value, broker = null, group = 'all') {
      const selected = device => group === 'all' || (device.kind === 'door') === (group === 'doors');
      (group === 'doors' ? doorPendingTime : pendingTime).clear();
      if (group === 'all') doorPendingTime.clear();
      const affected = devices.filter(device => selected(device) && (broker === null || device.broker === broker));
      // Every device loses transport authority even if saving one outage fails.
      for (const device of affected) { reception.invalidate(device); device.brokerConnected = value; }
      if (group !== 'doors' && (broker === null || broker === 'primary')) { connected = value; native?.setConnected(value); }
      for (const device of affected) {
        device.subscriptionRefresh = null;
        device.subscriptionStatus = value ? 'unconfirmed' : 'disconnected';
        if (!value) unavailable(device, 'mqtt-disconnected'); else { device.online = null; device.bridgeOnline = null; device.liveSinceConnect = false; }
      }
    },
    confirmSubscriptions(topics, broker = null, group = 'all') {
      if (closed) return;
      const selected = device => group === 'all' || (device.kind === 'door') === (group === 'doors');
      const confirmed = new Set(topics);
      const requests = [];
      for (const device of devices) if (selected(device) && device.brokerConnected && (broker === null || device.broker === broker)
        && readTopics(device).every(topic => confirmed.has(topic))) {
        if (device.subscriptionStatus !== 'subscribed' && device.mqtt.requestTopic) requests.push(device.id);
        device.subscriptionStatus = 'subscribed';
        completeChecks(device, engine.clock());
      }
      for (const device of devices.filter(row => selected(row) && row.brokerConnected && (broker === null || row.broker === broker)
        && row.roomRouteSignature && !row.controlsSwitch && !row.controlsHeat)) {
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
          || !observationTimeAdmitted(recovered, engine.clock())
          || engine.clock() >= Math.min(recovered.sourceTime, recovered.receivedAt) + age(device)) continue;
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
    subscriptionFailed(topic, broker = null, group = 'all') {
      if (group !== 'doors' && (broker === null || broker === 'primary')) native?.subscriptionFailed(topic);
      for (const device of devices) if ((group === 'all' || (device.kind === 'door') === (group === 'doors'))
        && (broker === null || device.broker === broker) && readTopics(device).includes(topic)) {
        device.subscriptionStatus = 'failed'; unavailable(device, 'mqtt-subscription-failed');
      }
    },
    receiveDoors(topic, payload, packet = {}, receivedAt = engine.clock(), broker = null, receivedMonotonicAt = null) {
      if (closed) return false;
      if (admittedReceptionAt === undefined) doorPendingTime.drain(engine.clock());
      const selected = devices.filter(device => device.kind === 'door' && device.brokerConnected
        && (broker === null || device.broker === broker) && readTopics(device).includes(topic));
      if (!selected.length) return false;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (Buffer.byteLength(body) > 65536) return true;
      const input = parse(body);
      for (const device of selected) {
        const at = sourceTime(device.mqtt.timestampPath ? property(input, device.mqtt.timestampPath) : input?.timestamp);
        const timing = classifySourceTime({ sourceTime: at, receivedAt, now: receivedAt });
        if (!doorAdmission.admit(`${device.id}:${topic}`, body, packet, receivedAt,
          { timestamped: ['ready', 'pending'].includes(timing.status) })) continue;
        if (!packet.retain && (timing.status === 'pending' || timing.status === 'ready' && pendingFor(device))) {
          doorPendingTime.defer(++pendingSequence, { device, topic, body, packet, receivedMonotonicAt }, { sourceTime: at, receivedAt });
        } else receiveDevice(device, topic, body, packet, receivedAt, receivedMonotonicAt);
      }
      return true;
    },
    receive(topic, payload, packet = {}, receivedAt = engine.clock(), broker = null, onAccepted = null, receivedMonotonicAt = null) {
      const doors = api.receiveDoors(topic, payload, packet, receivedAt, broker, receivedMonotonicAt);
      return api.receiveRecorded(topic, payload, packet, receivedAt, broker, onAccepted, receivedMonotonicAt) || doors;
    },
    receiveRecorded(topic, payload, packet = {}, receivedAt = engine.clock(), broker = null, onAccepted = null, receivedMonotonicAt = null) {
      if (admittedReceptionAt === undefined) drainPending(engine.clock());
      if ((broker === null || broker === 'primary') && native?.receive(topic, payload, packet, receivedAt, onAccepted)) {
        confirmCaravanSources(engine.clock());
        return true;
      }
      const selected = devices.filter(device => device.kind !== 'door' && device.brokerConnected && (broker === null || device.broker === broker) && readTopics(device).includes(topic));
      if (!selected.length) return false;
      if (closed) return true;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      return reception.run(() => {
        const input = parse(body);
        for (const device of selected) {
          const at = sourceTime(device.mqtt.timestampPath ? property(input, device.mqtt.timestampPath) : input?.timestamp);
          const timing = classifySourceTime({ sourceTime: at, receivedAt, now: receivedAt });
          if (admission.admit(`${device.id}:${topic}`, body, packet, receivedAt,
            { timestamped: ['ready', 'pending'].includes(timing.status) })) {
            if (!packet.retain && (timing.status === 'pending' || timing.status === 'ready' && pendingFor(device))) {
              reception.afterCommit(() => {
                pendingTime.defer(++pendingSequence, { device, topic, body, packet, receivedMonotonicAt }, { sourceTime: at, receivedAt });
                // Persist the dependent recording pause before automatic admission,
                // even when no controller tick or subsequent packet arrives.
                void write(() => confirmCaravanSources(engine.clock())).catch(() => {});
              });
              continue;
            }
            receiveDevice(device, topic, body, packet, receivedAt, receivedMonotonicAt);
          }
        }
        return true;
      }, { onAccepted });
    },
    tickDoors(now = engine.clock()) {
      if (closed) return;
      doorPendingTime.drain(now);
      doorRecording.flush();
      for (const device of devices.filter(row => row.kind === 'door')) {
        if (device.liveSinceConnect && (device.mqtt.heartbeatMs && scalar(device.heartbeatAt) && now - device.heartbeatAt > device.mqtt.heartbeatMs
          || age(device) > 0 && definitions(device).some(definition => definition.required
            && scalar(device.readings[definition.signal]?.observedAt) && now - device.readings[definition.signal].observedAt >= age(device))))
          unavailable(device, 'missing-report');
        if (device.coverOperation?.status === 'published' && device.coverOperation.action !== 'stop' && now - device.coverOperation.requestedAt >= 60_000) {
          device.coverOperation.status = 'unconfirmed';
          device.coverOperation.error = 'The requested door state has not been observed. Check its live state.';
        }
      }
    },
    tick(now = engine.clock()) {
      if (closed) return;
      api.tickDoors(now);
      drainPending(now);
      native?.tick(now); for (const accumulator of energy.values()) accumulator.tick(now);
      for (const device of devices) if (device.kind !== 'door' && device.liveSinceConnect && (device.mqtt.heartbeatMs && scalar(device.heartbeatAt) && now - device.heartbeatAt > device.mqtt.heartbeatMs
        || age(device) > 0 && now - device.lastAt >= age(device))) unavailable(device, 'missing-report');
      for (const device of devices) if (['publishing', 'published'].includes(device.dehumidifierOperation?.status)
        && now - device.dehumidifierOperation.requestedAt >= readbackTimeoutMs) {
        device.dehumidifierOperation.status = 'unconfirmed';
        device.dehumidifierOperation.error = 'The requested setting has not been reported. Check the dehumidifier live state.';
      }
      reception.run(() => {
        for (const device of devices.filter(row => row.kind === 'dehumidifier')) {
          confirmDehumidifier(device, now); controlTemperature(device, now);
        }
      });
    },
    async setDehumidifier(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['deviceId', 'setting', 'value'].includes(key))
        || typeof input.deviceId !== 'string' || typeof input.setting !== 'string' || !Object.hasOwn(DEHUMIDIFIER_SETTINGS, input.setting)
        || !DEHUMIDIFIER_SETTINGS[input.setting].includes(input.value))
        throw fail('choose a configured dehumidifier and a supported setting value');
      const device = devices.find(row => row.id === input.deviceId);
      if (!device?.controlsDehumidifier) throw fail('dehumidifier control is not configured');
      if (probeBusy(device) || caravanStopping) throw fail('dehumidifier power check or restoration is in progress');
      if (device.temperatureControl && device.temperatureGuard.settings.enabled && input.setting === 'power')
        throw fail('power is managed by caravan temperature control');
      return commandDehumidifier(device, input.setting, input.value, 'manual');
    },
    async recheckDehumidifierLocation(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).sort().join(',') !== 'deviceId,identity,revision,signature'
        || typeof input.deviceId !== 'string' || !validDehumidifierIdentity(input.identity)
        || !Number.isSafeInteger(input.revision) || input.revision < 0
        || !validDehumidifierIdentity(input.signature)) throw fail('choose the current appliance and location-check association');
      const device = devices.find(row => row.id === input.deviceId);
      const admissible = () => {
        const guard = device?.temperatureControl && temperatureGuardStatus(device, engine.clock());
        return guard?.qualification.canRecheck && device.dehumidifierReport.identity === input.identity
          && guard.qualification.signature === input.signature && guard.qualification.revision === input.revision;
      };
      if (!admissible()) throw fail('location check needs current identity, fresh sources, authority and settled restoration');
      const operation = device.dehumidifierOperation;
      await write(() => reception.run(() => {
        if (!admissible() || device.dehumidifierOperation !== operation) throw fail('location check scope or native operation changed');
        const state = device.temperatureGuard, now = engine.clock(), meter = caravanPower(device, now);
        const record = state.qualification.record ?? { identity: input.identity, signature: input.signature,
          meterSignature: meter.signature, proof: null, failed: null, outageAt: null,
          revision: 0, recheckAt: null,
          lastHealthyAt: Math.max(device.dehumidifierReport.fieldTimestamps.power, meter.observedAt),
          powerAt: device.dehumidifierReport.fieldTimestamps.power, meterAt: meter.observedAt };
        record.invalidatedAt = now; record.failed = null; record.recheckAt = now; record.revision++;
        state.qualification = createCaravanQualification(record, now);
        state.qualification.outageAt = null;
        state.qualified = false; state.sessionActive = false; state.probe = null;
        state.sourceTimeWait = null; state.sourceTimeWaitExpiry = null;
        persistQualification(device);
        recordDehumidifierLocation(device, now);
      }), { priority: 'control', isCurrent: () => !closed && canControl() });
      return { deviceId: device.id, temperatureControl: temperatureGuardStatus(device, engine.clock()) };
    },
    async setDehumidifierTemperatureControl(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['deviceId', ...Object.keys(defaultTemperatureControl)].includes(key))
        || typeof input.deviceId !== 'string' || Object.keys(input).length < 2)
        throw fail('choose a configured dehumidifier and temperature control settings');
      const device = devices.find(row => row.id === input.deviceId);
      if (!device?.temperatureControl) throw fail('dehumidifier temperature control is not configured');
      if (probeBusy(device) || caravanStopping) throw fail('dehumidifier power check or restoration is in progress');
      if (closed || !canControl()) throw fail('control authority unavailable');
      if (!validDehumidifierIdentity(device.temperatureGuard.boundIdentity)) throw fail('dehumidifier identity is not yet known');
      const { deviceId, ...patch } = input;
      const policy = { ...device.temperatureGuard.settings, ...patch };
      if (!validTemperatureControl(policy))
        throw fail('temperature thresholds must be between -10 and 30 °C in 0.1 °C steps, with ON at least 0.5 °C above OFF');
      const identity = device.temperatureGuard.boundIdentity;
      await write(() => reception.run(() => {
        if (probeBusy(device) || caravanStopping || closed || !canControl()
          || device.temperatureGuard.boundIdentity !== identity) throw fail('control authority or appliance identity changed');
        const previous = device.temperatureGuard.settings;
        store.setState(temperatureControlKey(device), { signature: temperatureControlSignature(device), identity, settings: policy });
        if (Object.keys(defaultTemperatureControl).some(key => previous[key] !== policy[key]))
          store.event('caravan-control-changed', { input: engine.config?.input ?? null,
            ...policy, previous: { ...previous } }, engine.clock());
        if (policy.enabled !== device.temperatureGuard.settings.enabled) {
          device.temperatureGuard.managed = false; device.temperatureGuard.demand = false;
          device.temperatureGuard.lastAttemptAt = null; device.temperatureGuard.lastAttemptPower = null;
        }
        device.temperatureGuard.settings = policy;
        controlTemperature(device, engine.clock());
      }), { priority: 'control', isCurrent: () => !closed && canControl() });
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
      if (closed || !canControl() || device.subscriptionStatus !== 'subscribed' || !healthy(device, engine.clock())) throw fail('door control is unavailable');
      const previousDispatch = coverDispatches.get(device);
      // Cancellation reaches the byte-write gate too: an earlier publication
      // may have passed preflight but still be in MQTT's outgoing store.
      previousDispatch?.cancellation.abort();
      const operation = { action: input.action, status: 'publishing', requestedAt: engine.clock() };
      device.coverOperation = operation;
      const previous = device.readings[device.stateSignal];
      const startingState = { value: previous?.value, coverState: previous?.coverState };
      const deadline = operation.requestedAt + readbackTimeoutMs, monotonicDeadline = performance.now() + readbackTimeoutMs;
      const cancellation = new AbortController();
      const dispatch = { operation, cancellation };
      coverDispatches.set(device, dispatch);
      let expired = false;
      const timer = setTimeout(() => { expired = true; cancellation.abort(); }, readbackTimeoutMs);
      // A newer action cancels an unsent movement. Dispatched outcomes remain uncertain until
      // acknowledged/read back. No command is retried or replayed.
      const validate = () => {
        const now = engine.clock(), reading = device.readings[device.stateSignal];
        if (cancellation.signal.aborted || now >= deadline || performance.now() >= monotonicDeadline || closed || !canControl()
          || device.coverOperation !== operation || device.subscriptionStatus !== 'subscribed' || !healthy(device, now)) throw fail('door control is unavailable');
        if (input.action !== 'stop' && (reading?.value !== startingState.value || reading?.coverState !== startingState.coverState))
          throw fail('door state changed before dispatch');
      };
      const beforePublish = () => { validate(); operation.dispatchedAt = engine.clock(); operation.dispatchedRevision = sequence; };
      const beforeWrite = () => { try { validate(); return true; } catch { return false; } };
      try {
        await publish(device.mqtt.commandTopic, payload,
          { qos: 1, retain: false, noReplay: true, beforePublish, beforeWrite, signal: cancellation.signal,
            recordingContext: 'cover-command', recordingDeadlineExpired: () => expired }, device.broker);
        operation.acknowledgedAt = engine.clock();
        if (operation.status === 'publishing') operation.status = operation.observedAt !== undefined ? 'observed' : 'published';
        if (closed || !canControl() || !device.brokerConnected) {
          operation.status = 'unconfirmed'; operation.error = 'Control connection changed. Check the door live state.';
        }
      } catch (error) {
        if (!scalar(operation.dispatchedAt)) {
          const failure = unsentEquipmentCommand(error, expired);
          operation.status = 'failed'; operation.error = failure.message; operation.code = failure.code;
          throw failure;
        }
        operation.status = 'unconfirmed'; operation.error = 'Door command delivery is unconfirmed. Check its live state before trying again.';
        throw fail('door command delivery is unconfirmed; check its live state');
      } finally {
        clearTimeout(timer);
        if (coverDispatches.get(device) === dispatch) coverDispatches.delete(device);
        cancellation.abort();
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
        if (!device.brokerConnected || closed) { check.finish('unavailable'); return; }
        Promise.resolve().then(async () => {
          if (refreshSubscriptions) {
            device.subscriptionStatus = 'refreshing'; device.subscriptionRefresh = check;
            try { await refreshSubscriptions(readTopics(device), device.broker); }
            catch {
              if (device.subscriptionRefresh === check && device.brokerConnected && !closed) {
                device.subscriptionRefresh = null;
                device.subscriptionStatus = 'failed'; unavailable(device, 'mqtt-subscription-failed');
              }
              throw fail('subscription refresh failed');
            }
            // Retained offline can finish the device check before SUBACK. The
            // subscription still succeeded and must allow later bridge recovery.
            if (device.subscriptionRefresh === check && device.brokerConnected && !closed) {
              device.subscriptionRefresh = null;
              if (device.subscriptionStatus === 'refreshing') device.subscriptionStatus = 'subscribed';
            }
            if (completed || !device.brokerConnected || closed) return;
          }
          if (completed || !device.brokerConnected || closed) return;
          // Reports replayed by subscription refresh are not replies to a later request.
          if (method === 'request') {
            check.reported.clear(); check.at = engine.clock();
            await publish(device.mqtt.requestTopic, device.mqtt.requestPayload, { qos: 1, retain: false }, device.broker);
          }
          check.ready = true; completeChecks(device, engine.clock());
          if (method === 'subscription') check.finish(healthy(device, engine.clock()) ? 'last-reported'
            : check.retainedReceived ? 'retained-only' : 'listening');
        }).catch(() => check.finish('unavailable'));
      }));
      await Promise.all(tasks); return api.status();
    },
    async setSwitch(deviceId, on, { beforePublish: validate = () => {}, restoring = false } = {}) {
      const config = enabled.find(row => row.id === deviceId);
      if (!config?.controlsSwitch) throw fail('switch control is not configured');
      if (config.protocol === 'shelly') return native.setSwitch(deviceId, on, { beforePublish: validate, restoring });
      const device = devices.find(row => row.id === deviceId), previous = device.readings[device.stateSignal]?.value;
      return switchDevice(device, on, { beforePublish: () => {
        validate();
        if (restoring !== true && (!healthy(device, engine.clock()) || device.readings[device.stateSignal]?.value !== previous))
          throw fail('switch state changed or became unavailable before dispatch');
      } });
    },
    async publishHeating(commands, options) {
      if (!Array.isArray(commands) || !commands.length || commands.some(command => !['reduction', 'normal'].includes(command))) throw fail('invalid heating command');
      if (heatingBusy) throw fail('heating operation already in progress');
      if (!connected || closed || !canControl()) throw fail('control authority unavailable');
      heatingBusy = true;
      try {
        if (native?.hasHeating) await native.publishHeating(commands, options);
        for (const command of commands) for (const device of devices.filter(row => row.controlsHeat))
          await switchDevice(device, command === 'reduction' ? device.reductionOn : !device.reductionOn, options);
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
        ...(device.kind === 'door' ? { cover: { available: !closed && canControl() && device.subscriptionStatus === 'subscribed' && healthy(device, now),
          state: device.readings[device.stateSignal]?.coverState ?? null,
          operation: device.coverOperation ? { ...device.coverOperation } : null } } : {}),
        ...(device.kind === 'dehumidifier' ? { dehumidifier: {
          identity: device.dehumidifierReport?.identity ?? null,
          probeBusy: probeBusy(device),
          available: device.controlsDehumidifier && !closed && canControl() && healthy(device, now)
            && validDehumidifierIdentity(device.dehumidifierReport?.identity),
          powerOffAvailable: device.controlsDehumidifier && canControl() && powerFeedbackReady(device, now),
          powerOnAvailable: device.controlsDehumidifier && !closed && canControl() && healthy(device, now) && !restartWait(device, now),
          state: Object.fromEntries(Object.entries(device.dehumidifierState).map(([field, value]) => [field, fieldFresh(device, field, now) ? value : null])),
          capabilities: structuredClone(device.dehumidifierReport?.capabilities ?? {}),
          measurements: Object.fromEntries(['temperature', 'humidity'].map(field => [field, fieldFresh(device, field, now) ? device.dehumidifierReport?.[field] ?? null : null])),
          temperatureControl: temperatureGuardStatus(device, now),
          runningState: healthy(device, now) ? device.dehumidifierState.power : null,
          observedAt: device.dehumidifierReport?.observedAt ?? null,
          operation: device.dehumidifierOperation ? { ...device.dehumidifierOperation } : null } } : {}),
        topics: topicDetails(device), recheck: { method: recheckMethod(device), requestSupported: Boolean(device.mqtt.requestTopic),
          description: device.mqtt.requestTopic ? 'Refresh subscriptions and send the configured status request.'
            : 'Refresh subscriptions. This publisher has no configured status request; live values arrive on its next report.' },
        mqttStatus: { broker: device.broker, brokerConnected: device.brokerConnected, subscriptionStatus: device.subscriptionStatus, lastReceivedAt: device.lastReceivedAt,
          lastLiveAt: device.lastLiveAt, lastRetainedAt: device.lastRetainedAt },
        readings: Object.fromEntries(Object.entries(device.readings).map(([signal, reading]) => [signal,
          { ...reading, stale: !device.brokerConnected || !device.liveSinceConnect || !availabilityConfirmed(device) || !fresh(device, reading, now)
            || device.kind === 'dehumidifier' && dehumidifierHistory(device, now).value === null
            || Boolean(device.mqtt.heartbeatMs && (!scalar(device.heartbeatAt) || now - device.heartbeatAt > device.mqtt.heartbeatMs)) }])),
        ...(energy.has(device.id) ? { energy: energy.get(device.id).status(now) } : {}) }))];
      return { configured: configured.length > 0, connected, checking: rows.some(row => row.check?.checking),
        topicGroups, brokers: api.brokerStatus?.(),
        lastCheckedAt: Math.max(0, ...rows.map(row => row.check?.checkedAt ?? 0)) || null,
        devices: configured.map(config => rows.find(row => row.id === config.id) ?? { id: config.id, role: config.id, label: config.label,
          area: config.area, kind: config.kind, source: config.source, connection: config.connection, enabled: false, available: false,
          readings: {}, controls: { switch: false, tariff: false }, check: { checking: false, status: 'disabled' } }) };
    },
    async restoreCaravanProbes({ timeoutMs = readbackTimeoutMs, resume = true } = {}) {
      const appliances = devices.filter(row => row.temperatureControl);
      if (!appliances.length) return { restorationPending: false };
      caravanStopping = true;
      const pending = () => appliances.some(row => row.temperatureGuard.restoration);
      const deadline = Date.now() + Math.max(0, timeoutMs), cancellation = new AbortController();
      const timeout = setTimeout(() => cancellation.abort(), Math.max(1, timeoutMs));
      const admitted = action => write(action, { priority: 'control', signal: cancellation.signal, isCurrent: () => !closed && canControl() });
      try {
        await admitted(() => reception.run(() => {
          for (const device of appliances) {
            if (device.temperatureGuard.probe?.status === 'testing') {
              abortCaravanProbe(device.temperatureGuard.probe, 'controller-stopping', engine.clock());
              device.temperatureGuard.qualification.stable = null;
            }
            confirmDehumidifier(device, engine.clock());
          }
        }));
        while (pending() && appliances.some(device => device.brokerConnected) && !closed && canControl() && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
          await admitted(() => reception.run(() => {
            for (const device of appliances) confirmDehumidifier(device, engine.clock());
          }));
        }
        return { restorationPending: pending() };
      } finally { clearTimeout(timeout); if (resume) caravanStopping = false; }
    },
    close() { if (closed) return; api.setConnected(false); native?.close(); closed = true; doorRecording.close(); },
  };
  return api;
}
