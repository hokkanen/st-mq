import { randomUUID } from 'node:crypto';
import { createCaravanEnergy } from './shelly-energy.js';

const LABELS = { garage: 'Garage Shelly relay', heat_savings: 'Heat savings Shelly', caravan: 'Caravan Shelly Plug' };
const scalar = value => typeof value === 'number' && Number.isFinite(value);
const valid = (value, min, max) => scalar(value) && value >= min && value <= max;
const signals = role => role === 'caravan' ? [['caravan_active', 'state'], ['caravan_power', 'kW'], ['caravan_current', 'A']]
  : role === 'garage' ? [['garage_temperature', 'degC'], ['garage_relay_active', 'state']] : [['heat_savings_active', 'state']];
const error = text => new Error(`Shelly ${text}`);

/** Dedicated native topics on the existing broker; never changes HA discovery,
 * device configuration, schedules, or cloud settings. No retained writes. */
export function createShellyCapture({ engine, store, settings, publish, canControl = () => true, readbackTimeoutMs = 10_000 }) {
  const devices = settings.devices.map(config => ({ ...config, connected: false, available: false, lastAt: null,
    readings: {}, state: null, waiters: new Set() }));
  const source = `stmq-shelly-${randomUUID()}`, replyTopic = `${source}/rpc`;
  const requests = new Map(); let sequence = 0, commandSequence = 0, connected = false, closed = false, lastPollAt = -Infinity, heatingBusy = false;
  const caravan = devices.find(row => row.role === 'caravan');
  const energy = caravan ? createCaravanEnergy({ store, device: caravan.prefix, maxGapMs: settings.maxAgeMs }) : null;
  const emit = (device, signal, value, unit, at, quality = [], raw = {}) => {
    if (Number.isFinite(at) && Number.isFinite(device.readings[signal]?.observedAt) && at < device.readings[signal].observedAt) return;
    device.readings[signal] = { value, observedAt: at, quality, ...raw };
    engine.ingest({ source: 'shelly-mqtt', device: device.role, signal, value, unit,
      sourceTime: at, receivedAt: engine.clock(), quality,
      raw: { timeBasis: value === null ? 'availability-transition' : 'mqtt-live-status', ...(/temperature$/.test(signal)
        ? { reportIntervalMs: settings.pollIntervalMs, reportGraceMs: settings.maxAgeMs - settings.pollIntervalMs } : {}), ...raw } });
  };
  const unavailable = (device, reason) => {
    const previous = device.available;
    device.available = false; device.state = null;
    for (const waiter of [...device.waiters]) waiter.reject(error('relay readback unavailable'));
    if (!previous && Object.values(device.readings).every(row => row.value === null)) return;
    for (const [signal, unit] of signals(device.role)) emit(device, signal, null, unit, null, [reason], { usableForControl: false });
  };
  const send = async (device, method, params = {}, purpose = 'status', commandId = null) => {
    if (!connected || closed || !canControl()) throw error('MQTT unavailable');
    const id = ++sequence;
    requests.set(id, { device, method, at: engine.clock(), purpose, commandId });
    try { await publish(`${device.prefix}/rpc`, JSON.stringify({ id, src: source, method, params }), { qos: 1, retain: false }); }
    catch (cause) { requests.delete(id); throw error('publication failed'); }
    return id;
  };
  const requestStatus = async device => {
    if (!connected || closed) return;
    if (device.generation === 1) await publish(`${device.prefix}/command`, 'update', { qos: 0, retain: false });
    else await send(device, 'Shelly.GetStatus');
  };
  function switchStatus(device, status, at, { full = false, readback = false, commandId = null } = {}) {
    if (!status || typeof status !== 'object') {
      if (full) emit(device, device.role === 'caravan' ? 'caravan_active' : device.role === 'garage' ? 'garage_relay_active' : 'heat_savings_active', null, 'state', at, ['missing']);
      return;
    }
    if (Array.isArray(status.errors) && status.errors.length) { unavailable(device, 'device-error'); return; }
    const output = status.output ?? status.ison;
    if (typeof output === 'boolean') {
      device.state = output;
      emit(device, device.role === 'caravan' ? 'caravan_active' : `${device.role}_relay_active`.replace('heat_savings_relay', 'heat_savings'), Number(output), 'state', at);
      if (readback) for (const waiter of [...device.waiters])
        if (waiter.at <= at && waiter.output === output
          && (device.generation === 1 || waiter.commandId === commandId)) waiter.resolve();
    } else if (full) {
      device.state = null;
      emit(device, device.role === 'caravan' ? 'caravan_active' : device.role === 'garage' ? 'garage_relay_active' : 'heat_savings_active', null, 'state', at, ['missing']);
    }
    if (device.role !== 'caravan') return;
    if (Object.hasOwn(status, 'apower') || full) emit(device, 'caravan_power', valid(status.apower, 0, 25000) ? status.apower / 1000 : null, 'kW', at,
      valid(status.apower, 0, 25000) ? [] : ['missing']);
    if (Object.hasOwn(status, 'current') || full) emit(device, 'caravan_current', valid(status.current, 0, 100) ? status.current : null, 'A', at,
      valid(status.current, 0, 100) ? [] : ['missing']);
    if (valid(status.aenergy?.total, 0, 1e12)) energy.receive(status.aenergy.total / 1000, at);
  }
  function temperatureStatus(device, status, at, full) {
    if (device.role !== 'garage' || !status && !full) return;
    const good = valid(status?.tC, -60, 70) && !status.errors?.length;
    emit(device, 'garage_temperature', good ? status.tC : null, 'degC', at, good ? [] : ['invalid-temperature']);
  }
  function fullStatus(device, result, at, readback = false) {
    switchStatus(device, result[`switch:${device.switchId}`], at, { full: true, readback });
    temperatureStatus(device, result[`temperature:${device.temperatureId}`], at, true);
  }
  function gen1(device, suffix, payload, at) {
    const switchPath = `relay/${device.switchId}`;
    if (suffix === switchPath && ['on', 'off'].includes(payload)) {
      switchStatus(device, { output: payload === 'on' }, at, { readback: true }); return true;
    }
    if (device.role === 'garage' && suffix === `ext_temperature/${device.temperatureId}`) {
      const value = payload.trim() ? Number(payload) : NaN;
      temperatureStatus(device, { tC: value }, at, true); return true;
    }
    if (device.role === 'caravan' && suffix === `${switchPath}/power`) {
      const watts = payload.trim() ? Number(payload) : NaN;
      emit(device, 'caravan_power', valid(watts, 0, 25000) ? watts / 1000 : null, 'kW', at, valid(watts, 0, 25000) ? [] : ['invalid-value']);
      emit(device, 'caravan_current', valid(watts, 0, 25000) ? watts / device.nominalVoltage : null, 'A', at,
        valid(watts, 0, 25000) ? ['estimated'] : ['invalid-value'], { basis: 'power-over-nominal-voltage', estimated: true }); return true;
    }
    if (device.role === 'caravan' && suffix === `${switchPath}/energy`) {
      const wattMinutes = payload.trim() ? Number(payload) : NaN;
      if (valid(wattMinutes, 0, 1e15)) energy.receive(wattMinutes / 60000, at);
      return true;
    }
    return false;
  }
  const api = {
    topics: [...devices.map(device => `${device.prefix}/#`), replyTopic],
    hasHeating: devices.some(device => device.controlsHeat),
    ownsGarage: devices.some(device => device.role === 'garage'),
    setConnected(value) {
      connected = value;
      for (const device of devices) {
        device.connected = false;
        if (!value) unavailable(device, 'mqtt-disconnected');
      }
      if (value) { lastPollAt = -Infinity; api.tick(engine.clock()); }
      else requests.clear();
    },
    subscriptionFailed(topic) {
      for (const device of devices) if (topic === replyTopic || topic === `${device.prefix}/#`) unavailable(device, 'mqtt-subscription-failed');
    },
    receive(topic, payload, packet = {}, receivedAt = engine.clock()) {
      const device = devices.find(row => topic.startsWith(`${row.prefix}/`));
      if (!device && topic !== replyTopic) return false;
      if (!connected || closed || packet.dup) return true;
      const body = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');
      if (body.length > 65536) return true;
      const suffix = device ? topic.slice(device.prefix.length + 1) : '';
      if (suffix === 'online') {
        if (body === 'false') { device.connected = false; unavailable(device, 'device-offline'); }
        else if (body === 'true' && !packet.retain) { device.connected = true; requestStatus(device).catch(() => {}); }
        return true;
      }
      // Retained values are not proof that this powered device is alive now.
      if (packet.retain) return true;
      if (device?.generation === 1) {
        if (gen1(device, suffix, body, receivedAt)) {
          device.lastAt = receivedAt; device.connected = device.available = true;
        }
        return true;
      }
      let frame;
      try { frame = JSON.parse(body); } catch { return true; }
      if (!frame || typeof frame !== 'object') return true;
      if (topic === replyTopic) {
        const request = requests.get(frame.id);
        if (!request || receivedAt - request.at > readbackTimeoutMs || frame.dst !== source) return true;
        requests.delete(frame.id);
        if (frame.error) { unavailable(request.device, 'device-rpc-error'); return true; }
        const result = frame.result;
        if (!result || typeof result !== 'object') return true;
        request.device.lastAt = receivedAt; request.device.connected = request.device.available = true;
        if (request.method === 'Shelly.GetStatus') fullStatus(request.device, result, receivedAt, false);
        else if (request.method === 'Switch.GetStatus') switchStatus(request.device, result, receivedAt, { full: true, readback: request.purpose === 'readback', commandId: request.commandId });
        else if (request.method === 'Switch.Set') send(request.device, 'Switch.GetStatus', { id: request.device.switchId }, 'readback', request.commandId).catch(() => {});
        return true;
      }
      let at = receivedAt;
      if (['NotifyStatus', 'NotifyFullStatus'].includes(frame.method)) {
        const params = frame.params;
        if (!params || typeof params !== 'object') return true;
        if (params.ts != null) {
          at = Math.round(params.ts * 1000);
          if (!Number.isSafeInteger(at) || at > receivedAt || receivedAt - at > settings.maxAgeMs) return true;
        }
        const full = frame.method === 'NotifyFullStatus';
        const switchValue = params[`switch:${device.switchId}`], temperatureValue = params[`temperature:${device.temperatureId}`];
        if (switchValue) switchStatus(device, switchValue, at, { full });
        temperatureStatus(device, temperatureValue, at, full);
        // Partial notifications refresh only the components they contain.
        if (!switchValue && !temperatureValue) return true;
      } else if (suffix === `status/switch:${device.switchId}`) switchStatus(device, frame, at, { full: true });
      else if (device.role === 'garage' && suffix === `status/temperature:${device.temperatureId}`) temperatureStatus(device, frame, at, true);
      else return true;
      device.lastAt = receivedAt; device.connected = device.available = true;
      return true;
    },
    tick(now = engine.clock()) {
      if (closed) return;
      energy?.tick(now);
      for (const [id, request] of requests) if (now - request.at > readbackTimeoutMs) requests.delete(id);
      for (const device of devices) if (device.available && now - device.lastAt > settings.maxAgeMs) unavailable(device, 'missing-report');
      if (connected && now - lastPollAt >= settings.pollIntervalMs) {
        lastPollAt = now;
        for (const device of devices) requestStatus(device).catch(() => {});
      }
    },
    async publishHeating(commands) {
      if (!Array.isArray(commands) || !commands.length || commands.some(command => !['heatoff', 'heaton15'].includes(command))) throw error('invalid heating command');
      if (heatingBusy) throw error('heating operation already in progress');
      if (!connected || closed || !canControl()) throw error('MQTT unavailable');
      heatingBusy = true;
      try {
        for (const command of commands) for (const device of devices.filter(row => row.controlsHeat)) {
          if (!connected || closed || !canControl()) throw error('control authority unavailable');
          const output = command === 'heatoff' ? device.reductionOn : !device.reductionOn;
          await new Promise((resolve, reject) => {
            const waiter = { output, commandId: ++commandSequence, at: engine.clock(), resolve: () => finish(canControl() && connected && !closed ? null : error('control authority unavailable')), reject: reason => finish(reason) };
            let done = false;
            const finish = reason => { if (done) return; done = true; clearTimeout(timer); device.waiters.delete(waiter); reason ? reject(reason) : resolve(); };
            const timer = setTimeout(() => finish(error('relay readback timed out; delivery unconfirmed')), readbackTimeoutMs);
            device.waiters.add(waiter);
            const action = device.generation === 1
              ? publish(`${device.prefix}/relay/${device.switchId}/command`, output ? 'on' : 'off', { qos: 1, retain: false }).then(() => requestStatus(device))
              : send(device, 'Switch.Set', { id: device.switchId, on: output }, 'write', waiter.commandId);
            action.catch(() => finish(error('relay command failed; delivery unconfirmed')));
          });
        }
        return { status: 'confirmed', sent: true, commands: [...commands], acknowledged: commands.length,
          acknowledgement: devices.filter(device => device.controlsHeat).every(device => device.generation > 1)
            ? 'shelly-live-relay-readback' : 'shelly-live-relay-state' };
      } finally { heatingBusy = false; }
    },
    status(now = engine.clock()) {
      return { configured: devices.length > 0, connected,
        devices: devices.map(device => ({ role: device.role, label: LABELS[device.role], controlsHeat: device.controlsHeat,
          available: connected && device.available && now - device.lastAt <= settings.maxAgeMs
            && signals(device.role).every(([signal]) => scalar(device.readings[signal]?.value)
              && now - device.readings[signal].observedAt <= settings.maxAgeMs),
          observedAt: device.lastAt, readings: Object.fromEntries(Object.entries(device.readings).map(([signal, reading]) => [signal,
            { ...reading, stale: !connected || !device.available || !Number.isFinite(reading.observedAt) || now - reading.observedAt > settings.maxAgeMs }])),
          ...(device.role === 'caravan' ? { energy: energy.status(now) } : {}) })) };
    },
    close() { api.setConnected(false); closed = true; requests.clear(); },
  };
  return api;
}
