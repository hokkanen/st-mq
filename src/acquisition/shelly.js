import { createMqttAdmission } from './mqtt-admission.js';
import { createMqttReception } from './mqtt-reception.js';
import { createSourceTimePending } from './source-time-pending.js';
import { classifySourceTime, sourceTimeAdmission, validateAdmittedSourceTime } from '../domain/time-evidence.js';
import { randomUUID, createHash } from 'node:crypto';
import { createCaravanEnergy } from './shelly-energy.js';
import { equipmentSignature, equipmentMeterIdentity } from './equipment-config.js';
import { GARAGE_TEMPERATURE_POLL_MS, GARAGE_TEMPERATURE_MAX_AGE_MS } from '../domain/temperature-reports.js';
import { Recorder } from '../storage/recorder.js';
import { readPlanningVoltage } from '../storage/voltage.js';

const scalar = value => typeof value === 'number' && Number.isFinite(value);
const valid = (value, min, max) => scalar(value) && value >= min && value <= max;
const ERROR_CODES = {
  'MQTT unavailable': 'MQTT_UNAVAILABLE',
  'publication failed': 'MQTT_UNAVAILABLE',
  'heating operation already in progress': 'MQTT_BUSY',
  'switch operation already in progress': 'MQTT_BUSY',
  'control authority unavailable': 'MQTT_AUTHORITY_LOST',
  'device identity unavailable': 'SHELLY_IDENTITY_UNAVAILABLE',
  'relay readback unavailable': 'SHELLY_READBACK_UNAVAILABLE',
  'relay readback timed out; delivery unconfirmed': 'SHELLY_READBACK_TIMEOUT',
  'relay command failed; delivery unconfirmed': 'SHELLY_COMMAND_UNCONFIRMED',
};
const error = message => Object.assign(new Error(`Shelly ${message}`), { code: ERROR_CODES[message] ?? 'SHELLY_CONTROL_FAILED' });
const stateName = device => device.stateSignal;
const hasTemperature = device => device.hasTemperature === true;
const metered = device => device.metered === true;
const tempName = device => device.temperatureSignal;
const definitions = device => [
  ...(stateName(device) ? [{ signal: stateName(device), unit: 'state', label: device.kind === 'door' ? 'Door' : 'Switch', required: true }] : []),
  ...(hasTemperature(device) ? [{ signal: tempName(device), unit: 'degC', label: device.role === 'garage' ? 'Garage rear' : 'Temperature', required: true }] : []),
  ...(metered(device) ? [{ signal: `${device.role}_power`, unit: 'kW', label: 'Power', required: true },
    { signal: `${device.role}_current`, unit: 'A', label: 'Current', required: device.generation > 1 }] : []),
  ...device.customReadings,
];
const property = (object, path) => path?.split('.').reduce((value, key) => value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
const protectsGarage = device => definitions(device).some(row => ['garage_temperature', 'garage_temperature_2'].includes(row.signal));

/** Native protocol is selected by configuration; no host detection or fallback.
 * Modern command readbacks retain the exact command identity through both RPCs. */
export function createShellyCapture({ engine, store, settings, publish, canControl = () => true, readbackTimeoutMs = 10_000, brokerIdentity = null, topicGroups = [] }) {
  const devices = settings.devices.filter(config => config.enabled !== false).map(config => ({ ...config,
    customReadings: config.readings, connected: false,
    available: false, lastAt: null, lastPollAt: -Infinity, readings: {}, state: null, identity: null, identityPending: null,
    observationOrder: 0, writeOrder: 0, waiters: new Set(), checks: new Set(), check: null }));
  const feedbackRecorder = devices.some(device => device.id === 'dhwr')
    ? engine.recorder ?? new Recorder(store, { clock: engine.clock }) : null;
  const admission = createMqttAdmission();
  const source = `stmq-shelly-${randomUUID()}`, replyTopic = `${source}/rpc`, requests = new Map();
  let sequence = 0, commandSequence = 0, connected = false, closed = false, heatingBusy = false;
  const energies = new Map();
  const reception = createMqttReception({ store, engine, admission, devices, meters: energies, requests });
  let receptionAt = null;
  let admittedReceptionAt, pendingSequence = 0;
  const receivedNow = () => receptionAt ?? engine.clock();
  const pendingFor = device => pendingTime.some(row => row.device === device);
  const pendingTime = createSourceTimePending({ clock: engine.clock, ordered: row => row.device.id,
    dispatch: action => {
      const apply = () => (store.transaction ?? (fn => fn())).call(store, () => { const checkpoint = pendingTime.checkpoint();
        store.afterRollback?.(() => pendingTime.restore(checkpoint)); return action(); });
      return store.runWrite && !store.transactionDepth ? store.runWrite(apply) : apply();
    },
    onReject({ device }, reason) {
      if (reason !== 'cleared' && device.stateName) unavailable(device, 'invalid-source-time');
    },
    onReady({ topic, body, packet }, receivedAt, admittedAt) {
      if (closed || !connected) return;
      const previous = admittedReceptionAt; admittedReceptionAt = admittedAt;
      try { api.receive(topic, body, packet, receivedAt); }
      finally { admittedReceptionAt = previous; }
    } });
  const energyFor = device => {
    if (!metered(device) || device.generation > 1 && !device.identity) return null;
    const lineage = equipmentMeterIdentity({ ...device, readings: device.customReadings }, { brokerIdentity, nativeIdentity: device.identity });
    const saved = energies.get(device.id);
    if (saved?.lineage === lineage) return saved;
    const meter = createCaravanEnergy({ store, recorder: engine.recorder, device: lineage,
      maxGapMs: device.maxAgeMs ?? settings.maxAgeMs, signal: `${device.role}_energy`, recordDevice: device.role,
      ...(device.role === 'caravan' ? {} : { stateKey: `shelly:equipment-energy:v1:${device.id}` }) });
    meter.lineage = lineage; energies.set(device.id, meter); return meter;
  };
  const pollInterval = device => protectsGarage(device) ? GARAGE_TEMPERATURE_POLL_MS : settings.pollIntervalMs;
  const maxAge = device => {
    const configured = device.maxAgeMs ?? settings.maxAgeMs;
    return protectsGarage(device) ? Math.min(configured || GARAGE_TEMPERATURE_MAX_AGE_MS, GARAGE_TEMPERATURE_MAX_AGE_MS) : configured;
  };
  const topicDetails = device => {
    const subscribe = (role, suffix) => ({ role, topic: `${device.prefix}/${suffix}`, direction: 'subscribe' });
    const publishTopic = (role, suffix) => ({ role, topic: `${device.prefix}/${suffix}`, direction: 'publish' });
    return [subscribe('Device subscription', '#'), subscribe('Availability', 'online'), ...(device.generation === 1 ? [
      ...(stateName(device) ? [subscribe('State', `relay/${device.switchId}`)] : []),
      ...(hasTemperature(device) ? [subscribe('Temperature', `ext_temperature/${device.temperatureId}`)] : []),
      ...(metered(device) ? [subscribe('Power', `relay/${device.switchId}/power`), subscribe('Energy counter', `relay/${device.switchId}/energy`)] : []),
      ...device.customReadings.filter(row => row.component?.startsWith('temperature:')).map(row => subscribe(row.label, `ext_temperature/${row.component.split(':')[1]}`)),
      publishTopic('Status request', 'command'),
      ...(device.controlsSwitch || device.controlsHeat ? [publishTopic('Switch command', `relay/${device.switchId}/command`)] : []),
    ] : [
      subscribe('Status notifications', 'events/rpc'),
      ...(stateName(device) ? [subscribe('State', `status/${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`)] : []),
      ...(hasTemperature(device) ? [subscribe('Temperature', `status/temperature:${device.temperatureId}`)] : []),
      ...device.customReadings.map(row => subscribe(row.label, `status/${row.component}`)),
      publishTopic('RPC requests', 'rpc'), { role: 'RPC replies', topic: replyTopic, direction: 'subscribe' },
    ])];
  };
  const receiptDevices = new Map();
  for (const device of devices) for (const detail of topicDetails(device)) {
    if (detail.direction === 'subscribe' && !detail.topic.endsWith('/#') && !receiptDevices.has(detail.topic))
      receiptDevices.set(detail.topic, device);
  }
  const temperatureSignature = (device, signal) => {
    if (!['garage_temperature', 'garage_temperature_2'].includes(signal)) return null;
    if (device.generation > 1 && !device.identity) return device.readings[signal]?.temperatureRouteSignature ?? null;
    return createHash('sha256').update(JSON.stringify({ brokerIdentity, nativeIdentity: device.identity,
      target: equipmentSignature({ ...device, readings: device.customReadings, protocol: 'shelly', connection: `shelly:${device.prefix}` }),
      signal })).digest('hex');
  };
  const emit = (device, signal, value, unit, at, quality = [], raw = {}) => {
    // A rejected notification clock can report a fault, but cannot establish
    // a measurement or renew any previously accepted observation.
    if (value !== null && !scalar(at)) return;
    if (scalar(at) && scalar(device.readings[signal]?.observedAt) && at < device.readings[signal].observedAt) return;
    // A topic alone cannot bind a Garage permission to a native Shelly. Obtain
    // GetDeviceInfo first; the subsequent status request supplies the reading.
    if (value !== null && ['garage_temperature', 'garage_temperature_2'].includes(signal)
      && device.generation > 1 && !device.identity) return;
    const signature = temperatureSignature(device, signal);
    if (signature) raw = { ...raw, temperatureRouteSignature: signature };
    const definition = definitions(device).find(row => row.signal === signal);
    const timeAdmission = sourceTimeAdmission({ sourceTime: at, receivedAt: receivedNow(), now: admittedReceptionAt ?? receivedNow(), deferred: admittedReceptionAt !== undefined });
    if (timeAdmission) raw = { ...raw, timeAdmission };
    const observation = { source: 'shelly-mqtt', device: device.role, signal, value, unit,
      sourceTime: at, receivedAt: receivedNow(), quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status',
        ...((unit === 'degC' || unit === '°C') ? { reportIntervalMs: pollInterval(device),
          reportGraceMs: Math.max(0, maxAge(device) - pollInterval(device)) } : {}), ...raw } };
    if (device.record !== false && definition?.record !== false) {
      if (device.role === 'caravan' || signal === 'garage_relay_active')
        engine.rememberObservation?.(observation, receivedNow());
      else engine.ingest(observation);
    }
    const powerFeedback = device.customReadings.some(row => row.signal === 'dhwr_power');
    if (device.id === 'dhwr' && signal === (powerFeedback ? 'dhwr_power' : 'dhwr_active'))
      feedbackRecorder.record({ ...observation, signal: 'dhwr_active', unit: 'state',
        value: value === null ? null : Number(value > 0), sourceTime: at ?? receivedNow(),
        raw: { ...observation.raw, basis: powerFeedback ? 'measured-power' : 'reported-switch',
          reportIntervalMs: maxAge(device), reportGraceMs: 0, maxAgeMs: maxAge(device), verified: value !== null } });
    device.readings[signal] = { value, unit, label: definition?.label ?? signal, observedAt: at, receivedAt: receivedNow(), quality, ...raw };
    reception.accept();
  };
  const unavailable = (device, reason, receivedAt = receivedNow()) => {
    pendingTime.removeWhere(row => row.device === device);
    if (store.runWrite && !store.transactionDepth) {
      device.available = false; device.state = null;
      for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal]) {
        const signature = temperatureSignature(device, definition.signal);
        engine.rememberObservation?.({ source: 'shelly-mqtt', device: device.role, signal: definition.signal,
          value: null, unit: definition.unit, sourceTime: null, receivedAt, quality: [reason],
          raw: { usableForControl: false, timeBasis: 'availability-transition',
            ...(signature ? { temperatureRouteSignature: signature } : {}) } }, receivedAt);
      }
      for (const waiter of [...device.waiters]) waiter.reject(error('relay readback unavailable'));
      for (const check of [...device.checks]) check.finish('unavailable');
      void store.runWrite(() => reception.run(() => unavailable(device, reason, receivedAt))).catch(() => {});
      return;
    }
    energies.get(device.id)?.unavailable?.(receivedAt, reason);
    const previous = device.available;
    device.available = false; device.state = null;
    for (const waiter of [...device.waiters]) reception.afterCommit(() => waiter.reject(error('relay readback unavailable')));
    for (const check of [...device.checks]) reception.afterCommit(() => check.finish('unavailable'));
    // A sensor/identity fault must still supersede a prior transport-only gap.
    if (!previous && Object.values(device.readings).every(row => row.value === null && row.quality?.includes(reason))) return;
    const before = receptionAt; receptionAt = receivedAt;
    try {
      for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal])
        emit(device, definition.signal, null, definition.unit, null, [reason], { usableForControl: false });
    } finally { receptionAt = before; }
  };
  const send = async (device, method, params = {}, { purpose = 'status', commandId = null, complete = null } = {}) => {
    if (!connected || closed || !canControl()) throw error('MQTT unavailable');
    const id = ++sequence;
    if (purpose === 'write') device.writeOrder = id;
    requests.set(id, { device, method, at: engine.clock(), purpose, commandId, complete });
    try { await publish(`${device.prefix}/rpc`, JSON.stringify({ id, src: source, method, params }), { qos: 1, retain: false, ...(purpose === 'write' ? { noReplay: true } : {}) }); }
    catch { requests.delete(id); throw error('publication failed'); }
    return id;
  };
  const requestStatus = device => device.generation === 1
    ? publish(`${device.prefix}/command`, 'update', { qos: 0, retain: false }) : send(device, 'Shelly.GetStatus');
  const clearIdentity = device => {
    device.identity = null;
    for (const [id, request] of requests) if (request.device === device) { requests.delete(id); reception.afterCommit(() => request.complete?.('unavailable')); }
    device.identityPending = null;
  };
  const needsIdentity = device => device.protocol === 'shelly' && device.generation > 1;
  const identify = device => {
    if (!needsIdentity(device) || device.identity) return Promise.resolve();
    if (device.identityPending) return device.identityPending;
    device.identityPending = new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); device.identityPending = null; resolve(); };
      const timer = setTimeout(finish, readbackTimeoutMs);
      send(device, 'Shelly.GetDeviceInfo', {}, { purpose: 'identity', complete: finish }).catch(finish);
    });
    return device.identityPending;
  };
  function switchStatus(device, status, at, { full = false, readback = false, commandId = null, preserveObservation = false } = {}) {
    const signal = stateName(device);
    if (!signal) return;
    if (!status || typeof status !== 'object') {
      if (full) emit(device, signal, null, 'state', at, ['missing']);
      return;
    }
    if (device.generation > 1 && status.id !== device.switchId) return;
    if (Array.isArray(status.errors) && status.errors.length) { unavailable(device, 'device-error'); return; }
    const output = device.kind === 'door' ? status.state : status.output ?? status.ison;
    const older = preserveObservation || scalar(at) && scalar(device.readings[signal]?.observedAt) && at < device.readings[signal].observedAt;
    // A matching command reply can arrive after the relay's push notification.
    // Confirm an unchanged output without replacing that newer observation.
    if (older && (!readback || output !== device.state)) return;
    if (typeof output === 'boolean') {
      if (scalar(at)) {
        if (!older) { device.state = output; emit(device, signal, Number(output), 'state', at); }
        if (readback) for (const waiter of [...device.waiters])
          if (waiter.at <= at && waiter.output === output && (device.generation === 1 || waiter.commandId === commandId)) reception.afterCommit(() => waiter.resolve());
      }
    } else if (full) { device.state = null; emit(device, signal, null, 'state', at, ['missing']); }
    if (older || !metered(device)) return;
    if (Object.hasOwn(status, 'apower') || full) emit(device, `${device.role}_power`, valid(status.apower, 0, 25000) ? status.apower / 1000 : null,
      'kW', at, valid(status.apower, 0, 25000) ? [] : ['missing']);
    if (Object.hasOwn(status, 'current') || full) emit(device, `${device.role}_current`, valid(status.current, 0, 100) ? status.current : null,
      'A', at, valid(status.current, 0, 100) ? [] : ['missing']);
    if (scalar(at) && !device.customReadings.some(mapping => mapping.key === 'energy_counter') && valid(status.aenergy?.total, 0, 1e12)) energyFor(device)?.receive(status.aenergy.total / 1000, at);
  }
  function temperatureStatus(device, status, at, full) {
    if (!hasTemperature(device) || !status && !full) return;
    if (status && device.generation > 1 && status.id !== undefined && status.id !== device.temperatureId) return;
    if (!full && status && !Object.hasOwn(status, 'tC') && !status.errors?.length) return;
    const good = valid(status?.tC, -60, 100) && !status.errors?.length;
    emit(device, tempName(device), good ? status.tC : null, 'degC', at, good ? [] : ['invalid-temperature']);
  }
  function customStatus(device, result, at, full, temperaturesOnly = false, selectedComponent = null) {
    let found = false;
    for (const mapping of device.customReadings) {
      if (selectedComponent && mapping.component !== selectedComponent) continue;
      if (temperaturesOnly && !mapping.component?.startsWith('temperature:')) continue;
      const component = result[mapping.component];
      if (!component && !full) continue;
      if (!component && !mapping.required && !device.readings[mapping.signal]) continue;
      const defaultPath = mapping.component?.startsWith('temperature:') ? 'tC' : mapping.component?.startsWith('input:') ? 'state'
        : mapping.component?.startsWith('switch:') ? 'output' : mapping.component?.startsWith('humidity:') ? 'rh' : 'value';
      let value = property(component, mapping.path ?? defaultPath);
      // NotifyStatus identifies partial components by their object key and may
      // omit the redundant id; an explicitly different id is still rejected.
      if (component && device.generation > 1 && component.id !== undefined && component.id !== Number(mapping.component.split(':')[1])) continue;
      if (!full && value === undefined && !component?.errors?.length) continue;
      if (typeof value === 'boolean' && mapping.signal !== 'dhwr_power') value = Number(value);
      if (scalar(value)) value = value * (mapping.scale ?? 1) + (mapping.offset ?? 0);
      const good = scalar(value) && !component?.errors?.length && (!['degC', '°C'].includes(mapping.unit) || valid(value, -60, 150))
        && (mapping.signal !== 'dhwr_power' || valid(value * (mapping.unit === 'kW' ? 1000 : 1), 0, 100000));
      emit(device, mapping.signal, good ? value : null, mapping.unit, at, good ? [] : ['missing']); found ||= Boolean(component);
      if (scalar(at) && mapping.key === 'energy_counter' && good && value >= 0) energyFor(device)?.receive(value / (mapping.unit === 'Wh' ? 1000 : 1), at);
    }
    return found;
  }
  function fullStatus(device, result, at, temperaturesOnly = false) {
    if (stateName(device) && !temperaturesOnly) switchStatus(device, result[`${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`], at, { full: true });
    temperatureStatus(device, result[`temperature:${device.temperatureId}`], at, true);
    customStatus(device, result, at, true, temperaturesOnly);
  }
  function gen1(device, suffix, payload, at) {
    const switchPath = `relay/${device.switchId}`;
    if (suffix === switchPath && ['on', 'off'].includes(payload)) {
      switchStatus(device, { output: payload === 'on' }, at, { readback: true }); return true;
    }
    if (hasTemperature(device) && suffix === `ext_temperature/${device.temperatureId}`) {
      temperatureStatus(device, { tC: payload.trim() ? Number(payload) : NaN }, at, true); return true;
    }
    for (const mapping of device.customReadings) if (mapping.component?.startsWith('temperature:') && suffix === `ext_temperature/${mapping.component.split(':')[1]}`) {
      const value = payload.trim() ? Number(payload) : NaN;
      customStatus(device, { [mapping.component]: { tC: value } }, at, false); return true;
    }
    if (metered(device) && suffix === `${switchPath}/power`) {
      const watts = payload.trim() ? Number(payload) : NaN;
      // Gen1 reports watts but no current or phase identity. Its display-only
      // equivalent current uses the established mean supply estimate, with the
      // unknown phase and unity-power-factor assumption kept explicit.
      const estimate = readPlanningVoltage(store, { input: engine.config?.input ?? 'live', now: at });
      const voltage = estimate.voltageV.every(value => Number.isFinite(value) && value > 0)
        ? estimate.voltageV.reduce((sum, value) => sum + value, 0) / 3 : null;
      emit(device, `${device.role}_power`, valid(watts, 0, 25000) ? watts / 1000 : null, 'kW', at, valid(watts, 0, 25000) ? [] : ['invalid-value']);
      emit(device, `${device.role}_current`, valid(watts, 0, 25000) && voltage !== null ? watts / voltage : null, 'A', at,
        !valid(watts, 0, 25000) ? ['invalid-value'] : voltage === null ? ['voltage-estimate-unavailable'] : ['estimated'],
        { basis: 'power-over-estimated-mean-voltage', estimated: true, voltageV: voltage,
          voltageBasis: estimate.basis, phase: 'unknown', powerFactorAssumed: 1 }); return true;
    }
    if (metered(device) && suffix === `${switchPath}/energy`) {
      const wattMinutes = payload.trim() ? Number(payload) : NaN;
      if (valid(wattMinutes, 0, 1e15)) energyFor(device)?.receive(wattMinutes / 60000, at);
      return true;
    }
    return false;
  }
  const available = (device, now) => connected && device.available && (!stateName(device) || !pendingFor(device))
    && device.lastAt <= now && (maxAge(device) === 0 || now - device.lastAt < maxAge(device))
    && definitions(device).filter(row => row.required).every(row => scalar(device.readings[row.signal]?.value)
      && device.readings[row.signal].observedAt <= now
      && (maxAge(device) === 0 || now - Math.min(device.readings[row.signal].observedAt,
        device.readings[row.signal].receivedAt ?? device.readings[row.signal].observedAt) < maxAge(device)));
  async function switchDevice(device, output) {
    if (!device || typeof output !== 'boolean') throw error('invalid switch selection');
    if (device.waiters.size) throw error('switch operation already in progress');
    if (needsIdentity(device) && !device.identity) throw error('device identity unavailable');
    if (!connected || closed || !canControl()) throw error('control authority unavailable');
    await new Promise((resolve, reject) => {
      const waiter = { output, commandId: ++commandSequence, at: engine.clock(),
        resolve: () => finish(canControl() && connected && !closed ? null : error('control authority unavailable')), reject: reason => finish(reason) };
      let done = false;
      const finish = reason => { if (done) return; done = true; clearTimeout(timer); device.waiters.delete(waiter); reason ? reject(reason) : resolve(); };
      const timer = setTimeout(() => finish(error('relay readback timed out; delivery unconfirmed')), readbackTimeoutMs);
      device.waiters.add(waiter);
      const action = device.generation === 1
        ? publish(`${device.prefix}/relay/${device.switchId}/command`, output ? 'on' : 'off', { qos: 1, retain: false, noReplay: true }).then(() => requestStatus(device))
        : send(device, 'Switch.Set', { id: device.switchId, on: output }, { purpose: 'write', commandId: waiter.commandId });
      action.catch(() => finish(error('relay command failed; delivery unconfirmed')));
    });
    return { confirmed: true, status: 'confirmed', sent: true, deviceId: device.id, on: output,
      acknowledgement: device.generation > 1 ? 'shelly-live-relay-readback' : 'shelly-live-relay-state' };
  }
  const api = {
    receptionKey(topic, payload) {
      if (topic === replyTopic) {
        let frame; try { frame = JSON.parse(String(payload)); } catch { return null; }
        const request = requests.get(frame?.id);
        return request && frame?.dst === source ? JSON.stringify(['equipment-shelly', request.device.id]) : null;
      }
      const device = receiptDevices.get(topic);
      return device ? JSON.stringify(['equipment-shelly', device.id]) : null;
    },
    isReadRequest(topic, payload) {
      const device = devices.find(row => topic === `${row.prefix}/${row.generation === 1 ? 'command' : 'rpc'}`);
      if (!device) return false;
      if (device.generation === 1) return String(payload) === 'update';
      let frame; try { frame = JSON.parse(String(payload)); } catch { return false; }
      return ['Shelly.GetDeviceInfo', 'Shelly.GetStatus', 'Switch.GetStatus'].includes(frame?.method);
    },
    topics: [...devices.map(device => `${device.prefix}/#`), replyTopic],
    hasHeating: devices.some(device => device.controlsHeat),
    hasDhwr: devices.some(device => device.id === 'dhwr'),
    async publishDhwr(on) {
      const device = devices.find(device => device.id === 'dhwr');
      if (on && device?.identity && !available(device, engine.clock())) throw error('circulation feedback unavailable');
      return switchDevice(device, on);
    },
    ownsGarage: devices.some(device => tempName(device) === 'garage_temperature' && hasTemperature(device)),
    signature(id) { const device = devices.find(row => row.id === id); return device && (!needsIdentity(device) || device.identity) ? createHash('sha256').update(JSON.stringify({ brokerIdentity, nativeIdentity: device.identity, target: equipmentSignature({ ...device, readings: device.customReadings, protocol: 'shelly', connection: `shelly:${device.prefix}` }) })).digest('hex') : null; },
    setConnected(value) {
      pendingTime.clear();
      connected = value;
      for (const device of devices) device.connected = false;
      for (const device of devices) { if (!value) unavailable(device, 'mqtt-disconnected'); clearIdentity(device); }
      if (value) { for (const device of devices) { identify(device); device.lastPollAt = -Infinity; } api.tick(engine.clock()); }
      else { for (const request of requests.values()) request.complete?.('unavailable'); requests.clear(); }
    },
    subscriptionFailed(topic) { for (const device of devices) if (topic === replyTopic || topic === `${device.prefix}/#`) unavailable(device, 'mqtt-subscription-failed'); },
    receive(topic, payload, packet = {}, receivedAt = engine.clock()) {
      const device = devices.find(row => topic.startsWith(`${row.prefix}/`));
      if (!device && topic !== replyTopic) return false;
      if (!connected || closed) return true;
      if (admittedReceptionAt === undefined) pendingTime.drain(engine.clock());
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      let delivery; try { delivery = JSON.parse(body); } catch { delivery = null; }
      const sourceAt = scalar(delivery?.params?.ts) ? delivery.params.ts * 1000 : NaN;
      if (admittedReceptionAt === undefined && !admission.admit(topic, body, packet, receivedAt, {
        timestamped: ['ready', 'pending'].includes(classifySourceTime({ sourceTime: Math.round(sourceAt), receivedAt, now: receivedAt }).status),
        correlated: topic === replyTopic && requests.has(delivery?.id),
      })) return true;
      const suffix = device ? topic.slice(device.prefix.length + 1) : '';
      if (suffix === 'online') {
        if (body === 'false') { device.connected = false; unavailable(device, 'device-offline'); clearIdentity(device); }
        else if (body === 'true' && !packet.retain) { device.connected = true; clearIdentity(device); reception.afterCommit(() => { identify(device); requestStatus(device).catch(() => {}); }); }
        return true;
      }
      if (packet.retain) return true;
      if (device?.generation === 1) {
        if (gen1(device, suffix, body, receivedAt)) {
          device.lastAt = receivedAt; device.connected = device.available = true;
          for (const check of [...device.checks]) if (available(device, receivedAt)) reception.afterCommit(() => check.finish('received'));
        }
        return true;
      }
      let frame; try { frame = JSON.parse(body); } catch { return true; }
      if (!frame || typeof frame !== 'object') return true;
      if (topic === replyTopic) {
        const request = requests.get(frame.id);
        if (!request || receivedAt - request.at > readbackTimeoutMs || frame.dst !== source) return true;
        requests.delete(frame.id);
        if (frame.error) { unavailable(request.device, 'device-rpc-error'); reception.afterCommit(() => request.complete?.('error')); return true; }
        if (request.method !== 'Shelly.GetDeviceInfo' && (!request.device.identity || frame.src !== request.device.identity)) {
          reception.afterCommit(() => request.complete?.('invalid')); return true;
        }
        const result = frame.result;
        if (!result || typeof result !== 'object') { reception.afterCommit(() => request.complete?.('invalid')); return true; }
        if (request.method === 'Shelly.GetDeviceInfo') {
          const validIdentity = typeof result.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,119}$/.test(result.id)
            && (result.gen === undefined || [2, 3, 4].includes(result.gen))
            && frame.src === result.id;
          request.device.identity = validIdentity ? result.id : null;
          for (const definition of definitions(request.device)) {
            const previous = request.device.readings[definition.signal]?.temperatureRouteSignature;
            const current = temperatureSignature(request.device, definition.signal);
            if (previous && (!validIdentity || current !== previous)) emit(request.device, definition.signal, null, definition.unit,
              null, [validIdentity ? 'sensor-identity-changed' : 'device-identity-unavailable'], { usableForControl: false });
          }
          reception.afterCommit(() => {
            request.complete?.(validIdentity ? 'received' : 'invalid');
            // Initial status can win the identity RPC race and be rejected.
            // Immediately obtain an authenticated snapshot after identification.
            if (validIdentity) requestStatus(request.device).catch(() => {});
          }); return true;
        }
        if (['Shelly.GetStatus', 'Switch.GetStatus'].includes(request.method)) {
          // An unrelated partial notification must not discard this complete
          // snapshot. emit() compares each component's own evidence clock.
          if (frame.id < request.device.writeOrder || request.method === 'Switch.GetStatus'
            && frame.id < request.device.observationOrder
            && (request.purpose !== 'readback' || result.output !== request.device.state)) {
            reception.afterCommit(() => request.complete?.('superseded')); return true;
          }
          if (request.method === 'Switch.GetStatus' && result.id !== request.device.switchId) { reception.afterCommit(() => request.complete?.('invalid')); return true; }
          // Relay evidence retains its packet-order fence even when a probe
          // from this complete snapshot can still supply newer source evidence.
        }
        request.device.lastAt = receivedAt; request.device.connected = request.device.available = true;
        if (request.method === 'Shelly.GetStatus') fullStatus(request.device, result, request.at,
          frame.id < request.device.observationOrder);
        else if (request.method === 'Switch.GetStatus') {
          const preserveObservation = frame.id < request.device.observationOrder;
          switchStatus(request.device, result, request.at,
            { full: true, readback: request.purpose === 'readback', commandId: request.commandId, preserveObservation });
          if (!preserveObservation) customStatus(request.device, { [`switch:${request.device.switchId}`]: result }, request.at, true, false, `switch:${request.device.switchId}`);
        }
        else if (request.method === 'Switch.Set') reception.afterCommit(() => { send(request.device, 'Switch.GetStatus', { id: request.device.switchId },
          { purpose: 'readback', commandId: request.commandId }).catch(() => {}); });
        request.device.observationOrder = Math.max(request.device.observationOrder, frame.id);
        reception.afterCommit(() => request.complete?.('received')); return true;
      }
      let at = receivedAt;
      if (['NotifyStatus', 'NotifyFullStatus'].includes(frame.method)) {
        if (!device.identity || frame.src !== device.identity) return true;
        const params = frame.params;
        if (!params || typeof params !== 'object') return true;
        if (Object.hasOwn(params, 'ts')) {
          at = scalar(params.ts) ? Math.round(params.ts * 1000) : null;
          const timing = classifySourceTime({ sourceTime: at, receivedAt, now: admittedReceptionAt ?? receivedAt });
          if ((timing.status === 'pending' || timing.status === 'ready' && pendingFor(device)) && admittedReceptionAt === undefined) {
            const queuedSourceTime = at;
            reception.afterCommit(() => pendingTime.defer(++pendingSequence, { device, topic, body, packet }, { sourceTime: queuedSourceTime, receivedAt }));
            at = null;
          }
          // Reject this source clock without erasing unrelated, still-bounded
          // evidence. Explicit faults below still invalidate their components;
          // null time grants no measurement, readback, energy or liveness credit.
          if (!validateAdmittedSourceTime({ sourceTime: at, receivedAt, admittedAt: admittedReceptionAt,
            now: admittedReceptionAt ?? receivedAt })) at = null;
          else if (receivedAt - at > (maxAge(device) || settings.maxAgeMs)) return true;
        }
        const full = frame.method === 'NotifyFullStatus', switchValue = params[`${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`];
        const temperatureValue = params[`temperature:${device.temperatureId}`];
        if (switchValue || full) switchStatus(device, switchValue, at, { full });
        temperatureStatus(device, temperatureValue, at, full);
        const custom = customStatus(device, params, at, full);
        if (at === null || !switchValue && !temperatureValue && !custom) return true;
      } else if (suffix === `status/${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`) {
        switchStatus(device, frame, at, { full: true });
        customStatus(device, { [suffix.slice(7)]: frame }, at, true, false, suffix.slice(7));
      }
      else if (hasTemperature(device) && suffix === `status/temperature:${device.temperatureId}`) temperatureStatus(device, frame, at, true);
      else if (device.customReadings.some(mapping => suffix === `status/${mapping.component}`)) customStatus(device, { [suffix.slice(7)]: frame }, at, false);
      else return true;
      device.observationOrder = ++sequence;
      device.lastAt = receivedAt; device.connected = device.available = true; return true;
    },
    tick(now = engine.clock()) {
      if (closed) return;
      pendingTime.drain(now);
      for (const energy of energies.values()) energy.tick(now);
      for (const [id, request] of requests) if (now - request.at > readbackTimeoutMs) { requests.delete(id); request.complete?.('timeout'); }
      for (const device of devices) if (device.available && maxAge(device) > 0 && now - device.lastAt >= maxAge(device)) unavailable(device, 'missing-report');
      if (connected) for (const device of devices) if (now - device.lastPollAt >= pollInterval(device)) {
        device.lastPollAt = now; identify(device); requestStatus(device).catch(() => {});
      }
    },
    async recheck({ deviceId } = {}) {
      const selected = devices.filter(device => !deviceId || device.id === deviceId);
      if (deviceId && !selected.length) throw error('unknown equipment');
      const identities = selected.map(device => identify(device));
      await Promise.all([...identities, ...selected.map(device => new Promise(resolve => {
        const startedAt = engine.clock(); let finished = false;
        const check = { finish: reason => {
          if (finished) return; finished = true; clearTimeout(timer); device.checks.delete(check);
          device.check = { checking: false, checkedAt: engine.clock(), method: 'native', status: reason === 'received' ? available(device, engine.clock()) ? 'available' : 'needs-attention' : reason };
          resolve();
        } };
        const timer = setTimeout(() => check.finish('timeout'), readbackTimeoutMs);
        device.checks.add(check); device.check = { checking: true, startedAt, status: 'checking', method: 'native' };
        if (!connected || closed) { check.finish('unavailable'); return; }
        const request = device.generation === 1 ? requestStatus(device) : send(device, 'Shelly.GetStatus', {}, { purpose: 'check', complete: check.finish });
        request.catch(() => check.finish('unavailable'));
      }))]);
      return api.status();
    },
    async setSwitch(deviceId, on) {
      const device = devices.find(row => row.id === deviceId);
      if (!device?.controlsSwitch) throw error('switch control is not configured');
      return switchDevice(device, on);
    },
    async publishHeating(commands) {
      if (!Array.isArray(commands) || !commands.length || commands.some(command => !['reduction', 'normal'].includes(command))) throw error('invalid heating command');
      if (heatingBusy) throw error('heating operation already in progress');
      if (!connected || closed || !canControl()) throw error('MQTT unavailable');
      heatingBusy = true;
      try {
        for (const command of commands) for (const device of devices.filter(row => row.controlsHeat)) await switchDevice(device, command === 'reduction' ? device.reductionOn : !device.reductionOn);
        return { confirmed: true, status: 'confirmed', sent: true, commands: [...commands], acknowledged: commands.length,
          acknowledgement: devices.filter(device => device.controlsHeat).every(device => device.generation > 1) ? 'shelly-live-relay-readback' : 'shelly-live-relay-state' };
      } finally { heatingBusy = false; }
    },
    status(now = engine.clock()) {
      return { configured: devices.length > 0, connected, checking: devices.some(device => device.check?.checking),
        topicGroups,
        lastCheckedAt: Math.max(0, ...devices.map(device => device.check?.checkedAt ?? 0)) || null,
        devices: devices.map(device => ({ id: device.id, role: device.role, label: device.label,
          area: device.area ?? (device.role === 'heat_savings' ? 'home' : 'garage'), kind: device.kind ?? (metered(device) ? 'metered_switch' : 'switch'),
          source: 'Shelly', connection: `shelly:${device.prefix}`, controlsHeat: Boolean(device.controlsHeat),
          topics: topicDetails(device), recheck: { method: 'native', requestSupported: true,
            description: device.generation === 1 ? 'Request native status and wait for live readings.' : 'Request native status and wait for its matching RPC reply.' },
          controls: { switch: device.controlsSwitch === true && (!needsIdentity(device) || Boolean(device.identity)), tariff: device.controlsHeat === true }, available: available(device, now), observedAt: device.lastAt, check: device.check,
          readings: Object.fromEntries(Object.entries(device.readings).map(([signal, reading]) => [signal,
            { ...reading, stale: !connected || !device.available || !scalar(reading.value) || !scalar(reading.observedAt)
              || reading.observedAt > now || maxAge(device) > 0 && now - Math.min(reading.observedAt, reading.receivedAt ?? reading.observedAt) >= maxAge(device) }])),
          ...(energies.has(device.id) ? { energy: energies.get(device.id).status(now) } : {}) })) };
    },
    close() { api.setConnected(false); closed = true; requests.clear(); },
  };
  const receive = api.receive;
  api.receive = (topic, payload, packet = {}, receivedAt = engine.clock(), onAccepted = null) => {
    if (topic !== replyTopic && !devices.some(device => topic.startsWith(`${device.prefix}/`))) return false;
    const before = receptionAt; receptionAt = receivedAt;
    try { return reception.run(() => receive(topic, payload, packet, receivedAt), { onAccepted }); }
    finally { receptionAt = before; }
  };
  return api;
}
