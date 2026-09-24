import { createMqttAdmission } from './mqtt-admission.js';
import { createMqttReception } from './mqtt-reception.js';
import { randomUUID, createHash } from 'node:crypto';
import { createCaravanEnergy } from './shelly-energy.js';
import { equipmentSignature, equipmentMeterIdentity } from './equipment-config.js';
import { GARAGE_TEMPERATURE_POLL_MS, GARAGE_TEMPERATURE_MAX_AGE_MS } from '../garage/permission.js';

const scalar = value => typeof value === 'number' && Number.isFinite(value);
const valid = (value, min, max) => scalar(value) && value >= min && value <= max;
const error = message => new Error(`Shelly ${message}`);
const stateName = device => device.stateSignal;
const hasTemperature = device => device.hasTemperature === true;
const metered = device => device.metered === true;
const tempName = device => device.temperatureSignal;
const definitions = device => [
  ...(stateName(device) ? [{ signal: stateName(device), unit: 'state', label: device.kind === 'door' ? 'Door' : 'Switch', required: true }] : []),
  ...(hasTemperature(device) ? [{ signal: tempName(device), unit: 'degC', label: device.role === 'garage' ? 'Garage rear' : 'Temperature', required: true }] : []),
  ...(metered(device) ? [{ signal: `${device.role}_power`, unit: 'kW', label: 'Power', required: true },
    { signal: `${device.role}_current`, unit: 'A', label: 'Current', required: true }] : []),
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
  const admission = createMqttAdmission();
  const source = `stmq-shelly-${randomUUID()}`, replyTopic = `${source}/rpc`, requests = new Map();
  let sequence = 0, commandSequence = 0, connected = false, closed = false, heatingBusy = false;
  const energies = new Map();
  const reception = createMqttReception({ store, engine, admission, devices, meters: energies, requests });
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
  const emit = (device, signal, value, unit, at, quality = [], raw = {}) => {
    if (scalar(at) && scalar(device.readings[signal]?.observedAt) && at < device.readings[signal].observedAt) return;
    const definition = definitions(device).find(row => row.signal === signal);
    const observation = { source: 'shelly-mqtt', device: device.role, signal, value, unit,
      sourceTime: at, receivedAt: engine.clock(), quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status',
        ...((unit === 'degC' || unit === '°C') ? { reportIntervalMs: pollInterval(device),
          reportGraceMs: Math.max(0, maxAge(device) - pollInterval(device)) } : {}), ...raw } };
    if (device.role === 'caravan' || ['heat_savings_active', 'garage_relay_active'].includes(signal))
      engine.rememberObservation?.(observation, engine.clock());
    else engine.ingest(observation);
    device.readings[signal] = { value, unit, label: definition?.label ?? signal, observedAt: at, quality, ...raw };
  };
  const unavailable = (device, reason) => {
    energies.get(device.id)?.unavailable?.(engine.clock(), reason);
    const previous = device.available;
    device.available = false; device.state = null;
    for (const waiter of [...device.waiters]) reception.afterCommit(() => waiter.reject(error('relay readback unavailable')));
    for (const check of [...device.checks]) reception.afterCommit(() => check.finish('unavailable'));
    if (!previous && Object.values(device.readings).every(row => row.value === null)) return;
    for (const definition of definitions(device)) if (definition.required || device.readings[definition.signal])
      emit(device, definition.signal, null, definition.unit, null, [reason], { usableForControl: false });
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
  function switchStatus(device, status, at, { full = false, readback = false, commandId = null } = {}) {
    const signal = stateName(device);
    if (!signal) return;
    if (!status || typeof status !== 'object') {
      if (full) emit(device, signal, null, 'state', at, ['missing']);
      return;
    }
    if (device.generation > 1 && status.id !== device.switchId) return;
    if (scalar(device.readings[signal]?.observedAt) && at < device.readings[signal].observedAt) return;
    if (Array.isArray(status.errors) && status.errors.length) { unavailable(device, 'device-error'); return; }
    const output = device.kind === 'door' ? status.state : status.output ?? status.ison;
    if (typeof output === 'boolean') {
      device.state = output; emit(device, signal, Number(output), 'state', at);
      if (readback) for (const waiter of [...device.waiters])
        if (waiter.at <= at && waiter.output === output && (device.generation === 1 || waiter.commandId === commandId)) reception.afterCommit(() => waiter.resolve());
    } else if (full) { device.state = null; emit(device, signal, null, 'state', at, ['missing']); }
    if (!metered(device)) return;
    if (Object.hasOwn(status, 'apower') || full) emit(device, `${device.role}_power`, valid(status.apower, 0, 25000) ? status.apower / 1000 : null,
      'kW', at, valid(status.apower, 0, 25000) ? [] : ['missing']);
    if (Object.hasOwn(status, 'current') || full) emit(device, `${device.role}_current`, valid(status.current, 0, 100) ? status.current : null,
      'A', at, valid(status.current, 0, 100) ? [] : ['missing']);
    if (!device.customReadings.some(mapping => mapping.key === 'energy_counter') && valid(status.aenergy?.total, 0, 1e12)) energyFor(device)?.receive(status.aenergy.total / 1000, at);
  }
  function temperatureStatus(device, status, at, full) {
    if (!hasTemperature(device) || !status && !full) return;
    if (status && device.generation > 1 && status.id !== device.temperatureId) return;
    if (!full && status && !Object.hasOwn(status, 'tC') && !status.errors?.length) return;
    const good = valid(status?.tC, -60, 100) && !status.errors?.length;
    emit(device, tempName(device), good ? status.tC : null, 'degC', at, good ? [] : ['invalid-temperature']);
  }
  function customStatus(device, result, at, full) {
    let found = false;
    for (const mapping of device.customReadings) {
      const component = result[mapping.component];
      if (!component && !full) continue;
      if (!component && !mapping.required && !device.readings[mapping.signal]) continue;
      const defaultPath = mapping.component?.startsWith('temperature:') ? 'tC' : mapping.component?.startsWith('input:') ? 'state'
        : mapping.component?.startsWith('switch:') ? 'output' : mapping.component?.startsWith('humidity:') ? 'rh' : 'value';
      let value = property(component, mapping.path ?? defaultPath);
      if (component && device.generation > 1 && component.id !== Number(mapping.component.split(':')[1])) continue;
      if (!full && value === undefined && !component?.errors?.length) continue;
      if (typeof value === 'boolean') value = Number(value);
      if (scalar(value)) value = value * (mapping.scale ?? 1) + (mapping.offset ?? 0);
      const good = scalar(value) && !component?.errors?.length && (!['degC', '°C'].includes(mapping.unit) || valid(value, -60, 150));
      emit(device, mapping.signal, good ? value : null, mapping.unit, at, good ? [] : ['missing']); found ||= Boolean(component);
      if (mapping.key === 'energy_counter' && good && value >= 0) energyFor(device)?.receive(value / (mapping.unit === 'Wh' ? 1000 : 1), at);
    }
    return found;
  }
  function fullStatus(device, result, at) {
    if (stateName(device)) switchStatus(device, result[`${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`], at, { full: true });
    temperatureStatus(device, result[`temperature:${device.temperatureId}`], at, true);
    customStatus(device, result, at, true);
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
      const watts = payload.trim() ? Number(payload) : NaN, voltage = device.nominalVoltage ?? 230;
      emit(device, `${device.role}_power`, valid(watts, 0, 25000) ? watts / 1000 : null, 'kW', at, valid(watts, 0, 25000) ? [] : ['invalid-value']);
      emit(device, `${device.role}_current`, valid(watts, 0, 25000) ? watts / voltage : null, 'A', at,
        valid(watts, 0, 25000) ? ['estimated'] : ['invalid-value'], { basis: 'power-over-nominal-voltage', estimated: true }); return true;
    }
    if (metered(device) && suffix === `${switchPath}/energy`) {
      const wattMinutes = payload.trim() ? Number(payload) : NaN;
      if (valid(wattMinutes, 0, 1e15)) energyFor(device)?.receive(wattMinutes / 60000, at);
      return true;
    }
    return false;
  }
  const available = (device, now) => connected && device.available && (maxAge(device) === 0 || now - device.lastAt < maxAge(device))
    && definitions(device).filter(row => row.required).every(row => scalar(device.readings[row.signal]?.value)
      && (maxAge(device) === 0 || now - device.readings[row.signal].observedAt < maxAge(device)));
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
    topics: [...devices.map(device => `${device.prefix}/#`), replyTopic],
    hasHeating: devices.some(device => device.controlsHeat),
    ownsGarage: devices.some(device => tempName(device) === 'garage_temperature' && hasTemperature(device)),
    signature(id) { const device = devices.find(row => row.id === id); return device && (!needsIdentity(device) || device.identity) ? createHash('sha256').update(JSON.stringify({ brokerIdentity, nativeIdentity: device.identity, target: equipmentSignature({ ...device, readings: device.customReadings, protocol: 'shelly', connection: `shelly:${device.prefix}` }) })).digest('hex') : null; },
    setConnected(value) {
      connected = value;
      for (const device of devices) { device.connected = false; clearIdentity(device); if (!value) unavailable(device, 'mqtt-disconnected'); }
      if (value) { for (const device of devices) { identify(device); device.lastPollAt = -Infinity; } api.tick(engine.clock()); }
      else { for (const request of requests.values()) request.complete?.('unavailable'); requests.clear(); }
    },
    subscriptionFailed(topic) { for (const device of devices) if (topic === replyTopic || topic === `${device.prefix}/#`) unavailable(device, 'mqtt-subscription-failed'); },
    receive(topic, payload, packet = {}, receivedAt = engine.clock()) {
      const device = devices.find(row => topic.startsWith(`${row.prefix}/`));
      if (!device && topic !== replyTopic) return false;
      if (!connected || closed) return true;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      let delivery; try { delivery = JSON.parse(body); } catch { delivery = null; }
      const sourceAt = delivery?.params?.ts * 1000;
      if (!admission.admit(topic, body, packet, receivedAt, {
        timestamped: Number.isFinite(sourceAt) && sourceAt >= 0 && sourceAt <= receivedAt,
        correlated: topic === replyTopic && requests.has(delivery?.id),
      })) return true;
      const suffix = device ? topic.slice(device.prefix.length + 1) : '';
      if (suffix === 'online') {
        if (body === 'false') { device.connected = false; clearIdentity(device); unavailable(device, 'device-offline'); }
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
          request.device.identity = validIdentity ? result.id : null; reception.afterCommit(() => request.complete?.(validIdentity ? 'received' : 'invalid')); return true;
        }
        if (['Shelly.GetStatus', 'Switch.GetStatus'].includes(request.method)) {
          if (frame.id < Math.max(request.device.writeOrder, request.device.observationOrder)) { reception.afterCommit(() => request.complete?.('superseded')); return true; }
          if (request.method === 'Switch.GetStatus' && result.id !== request.device.switchId) { reception.afterCommit(() => request.complete?.('invalid')); return true; }
          request.device.observationOrder = frame.id;
        }
        request.device.lastAt = receivedAt; request.device.connected = request.device.available = true;
        if (request.method === 'Shelly.GetStatus') fullStatus(request.device, result, request.at);
        else if (request.method === 'Switch.GetStatus') switchStatus(request.device, result, request.at,
          { full: true, readback: request.purpose === 'readback', commandId: request.commandId });
        else if (request.method === 'Switch.Set') reception.afterCommit(() => { send(request.device, 'Switch.GetStatus', { id: request.device.switchId },
          { purpose: 'readback', commandId: request.commandId }).catch(() => {}); });
        reception.afterCommit(() => request.complete?.('received')); return true;
      }
      let at = receivedAt;
      if (['NotifyStatus', 'NotifyFullStatus'].includes(frame.method)) {
        if (!device.identity || frame.src !== device.identity) return true;
        const params = frame.params;
        if (!params || typeof params !== 'object') return true;
        if (params.ts != null) {
          at = Math.round(params.ts * 1000);
          if (!Number.isSafeInteger(at) || at > receivedAt || receivedAt - at > (maxAge(device) || settings.maxAgeMs)) return true;
        }
        const full = frame.method === 'NotifyFullStatus', switchValue = params[`${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`];
        const temperatureValue = params[`temperature:${device.temperatureId}`];
        if (switchValue || full) switchStatus(device, switchValue, at, { full });
        temperatureStatus(device, temperatureValue, at, full);
        const custom = customStatus(device, params, at, full);
        if (!switchValue && !temperatureValue && !custom) return true;
      } else if (suffix === `status/${device.kind === 'door' ? 'input' : 'switch'}:${device.switchId}`) switchStatus(device, frame, at, { full: true });
      else if (hasTemperature(device) && suffix === `status/temperature:${device.temperatureId}`) temperatureStatus(device, frame, at, true);
      else if (device.customReadings.some(mapping => suffix === `status/${mapping.component}`)) customStatus(device, { [suffix.slice(7)]: frame }, at, false);
      else return true;
      device.observationOrder = ++sequence;
      device.lastAt = receivedAt; device.connected = device.available = true; return true;
    },
    tick(now = engine.clock()) {
      if (closed) return;
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
            { ...reading, stale: !connected || !device.available || !scalar(reading.value) || !scalar(reading.observedAt) || maxAge(device) > 0 && now - reading.observedAt >= maxAge(device) }])),
          ...(energies.has(device.id) ? { energy: energies.get(device.id).status(now) } : {}) })) };
    },
    close() { api.setConnected(false); closed = true; requests.clear(); },
  };
  const receive = api.receive;
  api.receive = (topic, ...args) => topic !== replyTopic && !devices.some(device => topic.startsWith(`${device.prefix}/`))
    ? false : reception.run(() => receive(topic, ...args));
  return api;
}
