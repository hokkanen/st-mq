import { actionReceiptRecent, createReceiptTracker } from './action-receipts.js';
import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';
import { temperatureReadingStatus } from './temperature-status.js';
import { TEMPERATURE_SENSORS } from '../src/domain/indoor-sensors.js';
import { FLOOR_PREHEAT_DEVICE, FLOOR_PREHEAT_CIRCUITS } from '../src/domain/floor-circuits.js';
import { createCaravanContents, dehumidifierCommandAllowed, temperatureControlAllowed, temperatureControlValueAllowed } from './caravan.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const labels = { temperature: 'Temperatures', door: 'Door', switch: 'Switch', power: 'Power meter', metered_switch: 'Energy meter', dehumidifier: 'Dehumidifier', heat_pump: 'Heat pump', vehicle: 'Vehicle', charger: 'Charger', sender: 'Sender', floor_override: 'Floor preheating' };
const pretty = text => String(text ?? '').replaceAll(/[_-]/g, ' ');
const recentResult = actionReceiptRecent;
function equipmentStateReading(device, now) {
  const readings = Object.values(device?.readings ?? {}).filter(reading => reading.unit === 'state');
  const reading = readings.length === 1 ? readings[0] : null;
  return device?.available && reading?.stale === false && [0, 1].includes(reading.value)
    && Number.isFinite(reading.observedAt) && (!Number.isFinite(now) || reading.observedAt <= now) ? reading : null;
}
export const equipmentSource = device => ['Shelly', 'MQTT-shelly', 'shelly-mqtt'].includes(device.source) ? 'Shelly'
  : ['H66', 'Mitsubishi', 'Simulation', 'TeslaMate', 'BMW CarData', 'Shelly EVSE', 'SONOFF'].includes(device.source) ? device.source : 'MQTT';
const temperatureKeys = { indoor_temperature: 'upstairs', downstairs_temperature: 'downstairs', bedroom_temperature: 'bedroom',
  garage_temperature: 'garage', garage_temperature_2: 'garageFront', outdoor_temperature: 'outdoor' };
const temperatureIds = { upstairs: 'indoor_temperature', indoor: 'indoor_temperature', downstairs: 'downstairs_temperature',
  bedroom: 'bedroom_temperature', garage: 'garage_temperature', garage_front: 'garage_temperature_2' };
/** Keep actual device identities separate from the read-only inventory below. */
export function equipmentDevices(status = {}) {
  const devices = new Map();
  for (const device of status.equipment?.devices ?? []) {
    if (!device?.id) continue;
    devices.set(device.id, { ...device, area: device.area });
  }
  const floor = status.preheatValves ?? {};
  const floorId = `floor-override:${FLOOR_PREHEAT_DEVICE.group}`;
  devices.set(floorId, { ...FLOOR_PREHEAT_DEVICE, id: floorId, area: 'home', kind: 'floor_override',
    enabled: false, commissioned: false, available: false, topics: [], readings: {},
    controls: { switch: false, tariff: false },
    connectionState: floor.restorationPending ? { label: 'Release pending', state: 'attention' }
      : { label: floor.integrationSupported === false ? 'Setup pending' : 'Status unavailable', state: 'pending' },
    recent: floor.restorationPending ? 'Previous override release is unconfirmed' : '1 device · 4 floor circuits',
    connectionDetail: FLOOR_PREHEAT_CIRCUITS.map(circuit =>
      `${circuit.id}: ${circuit.label} · ${circuit.lengthM} m`).join('; ') + '. Lengths describe pipe inside the floor.',
  });
  return [...devices.values()];
}

/** Public observations also contain legacy room feeds.
 * These views have no control or connection-check route of their own. */
export function equipmentInventory(status = {}) {
  const now = status.now ?? Date.now(), observations = status.observations ?? {};
  const sensorSignals = device => [...(device.ownedSignals ?? []), ...(device.topics ?? []).map(topic => topic.signal).filter(Boolean),
    ...(device.kind === 'temperature' ? [temperatureIds[device.id] ?? (Object.hasOwn(temperatureKeys, device.id) ? device.id : null)].filter(Boolean) : [])];
  const observation = signal => observations[temperatureKeys[signal]] ?? (signal.startsWith('garage_')
    ? status.garage?.observations?.[signal === 'garage_temperature' ? 'rear' : 'front'] : null);
  const sensorReading = (signal, reading, label) => {
    const displayStatus = temperatureReadingStatus(reading, { now, formatTime: value => clock.format(value),
      outdoor: signal === 'outdoor_temperature' });
    return { ...reading, label, unit: 'degC', displayStatus };
  };
  const inventory = equipmentDevices(status).filter(device => device.enabled !== false).map(device => {
    const deviceReadings = { ...device.readings };
    for (const signal of sensorSignals(device)) if (Object.hasOwn(temperatureKeys, signal) && !deviceReadings[signal])
      deviceReadings[signal] = { label: TEMPERATURE_SENSORS[signal] };
    const readings = Object.fromEntries(Object.entries(deviceReadings).map(([signal, reading]) => {
      if (!Object.hasOwn(temperatureKeys, signal)) return [signal, reading];
      const observed = observation(signal);
      return [signal, sensorReading(signal, observed ?? { ...reading, source: device.source }, reading.label ?? TEMPERATURE_SENSORS[signal])];
    }));
    return { ...device, readings, needsAttention: Object.values(readings).some(reading => reading.displayStatus?.attention) };
  });
  const represented = new Set(inventory.flatMap(device => [...Object.keys(device.readings), ...sensorSignals(device)]));
  const append = (id, label, area, source, readings) => {
    if (!Object.keys(readings).length) return;
    const rows = Object.values(readings);
    inventory.push({ id: `inventory:${id}`, label, area, source, kind: 'temperature', inventoryOnly: true,
      available: rows.every(reading => reading.displayStatus?.usable === true),
      needsAttention: rows.some(reading => reading.displayStatus?.attention), readings,
      controls: { switch: false, tariff: false } });
    for (const signal of Object.keys(readings)) represented.add(signal);
  };
  const sensors = new Map((status.sensorChanges?.sensors ?? []).map(sensor => [sensor.signal, sensor]));
  for (const signal of Object.keys(temperatureKeys)) {
    if (represented.has(signal)) continue;
    const garage = signal.startsWith('garage_');
    const reading = observation(signal);
    const sensor = sensors.get(signal), observed = Number.isFinite(reading?.value) || Number.isFinite(reading?.observedAt);
    if (sensor?.configured !== true && !observed) continue;
    // H66 temperatures and weather already have dedicated readings; do not
    // repeat them as separate equipment in the inventory.
    if (signal === 'outdoor_temperature' && !['mqtt-temperature', 'mqtt-equipment', 'shelly-mqtt'].includes(reading?.source)) continue;
    const source = reading?.source === 'simulation' ? 'Simulation' : reading?.source;
    append(`sensor:${signal}`, `${sensor?.label ?? TEMPERATURE_SENSORS[signal]} temperature`, garage ? 'garage' : 'home', source,
      { [signal]: sensorReading(signal, reading ?? {}, 'Temperature') });
  }
  return inventory;
}
const isState = (signal, reading) => reading.unit === 'state' || /_(active|open)$/.test(signal) || typeof reading.value === 'boolean';
const stateNumber = value => value === true || value === 'open' || value === 'on' ? 1
  : value === false || value === 'closed' || value === 'off' ? 0 : value;
function valueText(signal, reading, device) {
  const value = stateNumber(reading.value);
  if (reading.stateLabels && typeof reading.stateLabels === 'object') {
    const label = Number.isInteger(reading.value) && Object.hasOwn(reading.stateLabels, reading.value)
      ? reading.stateLabels[reading.value] : null;
    return typeof label === 'string' && label.length > 0 && label.length <= 80 ? label : 'Unknown';
  }
  if (isState(signal, reading) && device.kind === 'floor_override') return value === 1 ? 'Override on' : value === 0 ? 'Override off' : 'Unknown';
  if (isState(signal, reading)) return value === 1 ? device.kind === 'door' || signal.endsWith('_open') ? 'Open' : 'On'
    : value === 0 ? device.kind === 'door' || signal.endsWith('_open') ? 'Closed' : 'Off' : 'Unknown';
  if (Number.isFinite(reading.value)) {
    const unit = reading.unit === 'degC' ? '°C' : reading.unit ?? '';
    return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: unit === '°C' ? 1 : 3 }).format(reading.value)}${unit ? ` ${unit}` : ''}`;
  }
  return typeof reading.value === 'string' && reading.value.length <= 80 ? reading.value : 'Unavailable';
}

/** Arrival time describes the last event, not the health of a quiet door. The
 * acquisition layer owns health; the browser must not invent an age timeout. */
export function equipmentReadingRows(device) {
  const rows = Object.entries(device.readings ?? {}).map(([signal, reading]) => {
    const state = isState(signal, reading), projected = reading.displayStatus;
    const fresh = projected ? projected.usable : reading.stale === false || (reading.stale === undefined && device.available);
    const last = valueText(signal, reading, device), known = !['Unknown', 'Unavailable'].includes(last);
    const recorded = (device.readOnly === true || reading.readOnly === true) && known && Number.isFinite(reading.observedAt)
      && !(reading.quality ?? []).some(flag => /invalid|unknown|unsupported|sentinel|units-unverified/i.test(flag));
    const motion = device.kind === 'door' && state && fresh && known && ['opening', 'closing'].includes(reading.coverState)
      ? reading.coverState : null;
    const observed = Number.isFinite(reading.observedAt) ? clock.format(reading.observedAt) : 'time unavailable';
    return { signal, label: device.kind === 'heat_pump' && /_active$/.test(signal) ? 'Power enabled'
      : `${reading.label ?? pretty(signal)}${reading.estimated ? ' (estimate)' : ''}`,
      value: motion ? motion[0].toUpperCase() + motion.slice(1) : fresh || recorded ? last : state ? 'Unknown' : 'Unavailable', stale: !fresh,
      ...(recorded ? { qualifier: 'Recorded', recorded: true } : {}),
      ...(projected?.attention && fresh ? { qualifier: 'Needs attention' } : {}),
      detail: projected?.detail ?? (motion ? `Reported ${motion} · ${observed}`
        : known ? `${fresh ? 'Last reported' : `Last reported ${last}`} · ${observed}` : 'No usable reading received'),
    };
  });
  if (device.energy) {
    const energy = device.energy, available = Number.isFinite(energy.dailyKwh) && Number.isFinite(energy.observedAt);
    rows.push({ signal: 'daily_energy', label: 'Energy today', qualifier: energy.partial && available ? 'Partial' : '', value: available ? `${energy.dailyKwh.toFixed(3)} kWh` : 'Unavailable',
      stale: !available, detail: available ? `Finnish day${energy.partial ? ' · partial coverage' : ''} · updated ${clock.format(energy.observedAt)}` : 'Awaiting meter readings' });
  }
  return rows;
}

export function equipmentTestAllowed(status, device, busy = false) {
  if (!status || isReadOnlyReplica(status) || busy || status.equipmentTests?.busy || status.equipmentTests?.active
    || !status.equipmentTests?.available || !device?.available || !device.controls?.switch || device.controls?.tariff) return false;
  const states = Object.values(device.readings ?? {}).filter(reading => reading.unit === 'state');
  return states.length === 1 && states[0].stale === false && Number.isFinite(states[0].observedAt)
    && states[0].observedAt <= status.now && [0, 1].includes(states[0].value);
}

/** Independent action state allows duplicate-click and stale-status protection
 * to be verified without replacing real DOM interaction with implementation tests. */
export function createEquipmentActions({ request, onChange = () => {}, onStatus = () => {}, beforeRequest = () => {} }) {
  let status, busy = false, message = '', error = false, actionKind = null, actionDeviceId = null;
  let messageAt = null;
  const snapshot = () => ({ status, busy, message, error, actionKind, actionDeviceId });
  const emit = () => onChange(snapshot());
  async function send(path, body, success) {
    if (!status || isReadOnlyReplica(status) || busy) return false;
    actionKind = path.endsWith('/recheck') ? 'recheck' : path.endsWith('/switch') ? 'control'
      : path.endsWith('/dehumidifier') ? 'dehumidifier' : path.endsWith('/dehumidifier/temperature-control') ? 'dehumidifier-temperature-control'
        : path.endsWith('/cover') ? 'cover' : 'test';
    actionDeviceId = body.deviceId ?? status.equipmentTests?.active?.deviceId ?? null;
    messageAt = status.now ?? Date.now();
    busy = true; error = false; message = path.endsWith('/recheck') ? 'Checking configured connections…' : 'Applying request…';
    beforeRequest(); emit();
    try {
      const result = await request(path, body);
      status = result; messageAt = result.now ?? Date.now(); message = success; onStatus(result); return true;
    } catch {
      error = true;
      message = path.endsWith('/recheck') ? 'Could not recheck devices. Existing readings are retained.'
        : 'Could not confirm the control request. Check the reported device state before trying again.';
      return false;
    } finally { busy = false; emit(); }
  }
  return {
    snapshot,
    update(next) {
      if (!busy) {
        const device = next.equipment?.devices?.find(device => device.id === actionDeviceId);
        const reading = equipmentStateReading(device, next.now);
        const latest = actionKind === 'control' ? next.equipmentControls?.lastResult
          : actionKind === 'cover' ? device?.cover?.operation
            : actionKind === 'dehumidifier' ? device?.dehumidifier?.operation : null;
        const reported = reading && reading.observedAt > messageAt
          && (actionKind === 'control' || actionKind === 'cover' && ['open', 'closed'].includes(reading.coverState));
        const returned = latest && (actionKind !== 'control' || latest.deviceId === actionDeviceId)
          && (latest.at ?? latest.requestedAt) >= messageAt;
        if (!recentResult(messageAt, next.now ?? Date.now()) || error && (reported || returned)
          || !error && JSON.stringify(next.equipmentTests?.lastResult) !== JSON.stringify(status?.equipmentTests?.lastResult)) {
          message = ''; error = false;
        }
        status = next;
      }
      emit();
    },
    recheck(deviceId) {
      if (deviceId !== undefined && !status?.equipment?.devices?.some(device => device.id === deviceId)) return Promise.resolve(false);
      return send('/api/equipment/recheck', deviceId === undefined ? {} : { deviceId }, 'Connections checked. See each connection’s result below.');
    },
    switch(deviceId, on) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!equipmentControlAllowed(status, device, busy) || typeof on !== 'boolean') return Promise.resolve(false);
      return send('/api/equipment/switch', { deviceId, on }, 'Request completed. The reported state is shown above.');
    },
    cover(deviceId, action) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!equipmentCoverAllowed(status, device, action, busy)) return Promise.resolve(false);
      return send('/api/equipment/cover', { deviceId, action }, 'Door request sent. Check the reported state.');
    },
    dehumidifier(deviceId, setting, value) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!dehumidifierCommandAllowed(status, device, setting, value, busy)) return Promise.resolve(false);
      return send('/api/equipment/dehumidifier', { deviceId, setting, value }, 'Request sent; awaiting a live device report.');
    },
    dehumidifierTemperatureControl(deviceId, values) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!temperatureControlAllowed(status, device, busy) || !temperatureControlValueAllowed(values)) return Promise.resolve(false);
      const { enabled, offAtC, onAtC } = values;
      return send('/api/equipment/dehumidifier/temperature-control', { deviceId, enabled, offAtC, onAtC }, 'Power control settings saved for this dehumidifier.');
    },
    test(deviceId, on, durationMinutes) {
      const device = status?.equipment?.devices?.find(device => device.id === deviceId);
      if (!equipmentTestAllowed(status, device, busy) || typeof on !== 'boolean'
        || !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 15) return Promise.resolve(false);
      return send('/api/equipment/test', { deviceId, on, durationMinutes }, 'Timed test requested. Check the reported device state below.');
    },
    restore() {
      if (!status?.equipmentTests?.active) return Promise.resolve(false);
      return send('/api/equipment/test/restore', {}, 'Restoration requested. Check the reported device state.');
    },
  };
}

export function equipmentControlAllowed(status, device, busy = false) {
  return equipmentTestAllowed({ ...status, equipmentTests: { ...status?.equipmentTests,
    available: status?.equipmentControls?.available === true,
    busy: status?.equipmentControls?.busy || status?.equipmentTests?.busy } }, device, busy);
}

export function equipmentCoverAllowed(status, device, action, busy = false) {
  return Boolean(status && !isReadOnlyReplica(status) && !busy && device?.enabled !== false && device?.kind === 'door'
    && ['open', 'close', 'stop'].includes(action) && device.controls?.cover?.[action] === true && device.cover?.available === true);
}

/** Historical receipts remain for a day and reconcile with fresh device reports. */
export function equipmentControlReceipt(status, device) {
  const last = status.equipmentControls?.lastResult, now = status.now ?? Date.now();
  if (last?.deviceId !== device.id || typeof last.on !== 'boolean' || !recentResult(last.at, now)) return null;
  const reading = equipmentStateReading(device, now);
  const fresh = reading && reading.observedAt >= (last.requestedAt ?? last.at);
  return { ...last, evidenceAt: fresh ? reading.observedAt : null, observedValue: fresh ? reading.value : null,
    confirmed: fresh ? reading.value === Number(last.on) : last.confirmed === true,
    superseded: Boolean(fresh && reading.value !== Number(last.on)) };
}
function controlReceiptText(last) {
  if (!last) return '';
  const outcome = last.superseded ? `latest device report: ${last.observedValue ? 'On' : 'Off'}; request superseded`
    : last.confirmed ? 'device confirmed' : last.status === 'pending' ? 'sending…'
      : ['failed', 'unconfirmed'].includes(last.status) ? 'no confirming device report'
        : last.sent ? 'sent; awaiting device confirmation' : pretty(last.status ?? 'not sent');
  return `${last.on ? 'On' : 'Off'} requested · ${outcome} · ${clock.format(last.at)}`;
}
export function equipmentControlResult(status, device) {
  return controlReceiptText(equipmentControlReceipt(status, device));
}
export function equipmentCoverReceipt(device, now) {
  const operation = device.cover?.operation;
  if (!operation || !['open', 'close', 'stop'].includes(operation.action) || !recentResult(operation.requestedAt, now)) return null;
  const reading = equipmentStateReading(device, now);
  const fresh = reading && reading.observedAt > operation.requestedAt && ['open', 'closed'].includes(reading.coverState);
  const matches = fresh && (operation.action === 'stop' || reading.coverState === (operation.action === 'open' ? 'open' : 'closed'));
  return { ...operation, pending: operation.status === 'publishing' || operation.status === 'published' && now - operation.requestedAt < 60_000,
    evidenceAt: fresh ? reading.observedAt : null, observedValue: fresh ? reading.coverState : null,
    confirmed: operation.status === 'observed' || Boolean(matches),
    superseded: Boolean(fresh && !matches && ['failed', 'unconfirmed', 'observed'].includes(operation.status)) };
}
function coverReceiptText(operation) {
  if (!operation) return '';
  const result = operation.status === 'published' && !operation.pending && !operation.confirmed ? 'no new position report' : operation.superseded ? `latest device report: ${operation.observedValue}; request superseded`
    : operation.confirmed ? `state reported${operation.observedValue ? `: ${operation.observedValue}` : ''}`
      : { publishing: 'sending…', published: 'sent; position unconfirmed', observed: 'state reported',
        failed: 'could not send; check the door', unconfirmed: 'no new position report' }[operation.status] ?? 'position unconfirmed';
  const detail = operation.pending && !operation.confirmed && operation.action === 'stop' && operation.status === 'published' ? 'sent; stopping unconfirmed' : result;
  return `${pretty(operation.action).replace(/^./, letter => letter.toUpperCase())} requested · ${detail}`;
}
export function equipmentCoverResult(device, now) {
  return coverReceiptText(equipmentCoverReceipt(device, now));
}

export function equipmentCheckText(device) {
  const check = device.check;
  if (check?.checking) return 'Checking connection…';
  if (device.available && Number.isFinite(device.mqttStatus?.lastLiveAt)
    && Number.isFinite(check?.checkedAt) && device.mqttStatus.lastLiveAt > check.checkedAt) return 'Live reports received since the connection check';
  const states = {
    listening: 'subscriptions confirmed; waiting for a device report',
    'retained-only': 'saved broker value received; live state unconfirmed',
    timeout: 'status requested; no complete live response',
    available: 'live readings received',
    'last-reported': 'previous live readings were still usable',
    'needs-attention': 'readings needed attention',
    unavailable: 'connection unavailable',
    'awaiting-report': 'waiting for a device report',
  };
  return states[check?.status] ? `Last check: ${states[check.status]}` : device.enabled === false
    ? 'Disabled in configuration' : 'Not checked yet';

}

const topicKey = row => `${row.direction === 'publish' ? 'publish' : 'subscribe'}:${row.topic}`;
/** One topic can carry several fields, or both RPC checks and commands. */
export function equipmentTopicGroups(topics = []) {
  const unique = new Map();
  for (const row of topics) {
    if (typeof row?.topic !== 'string' || !row.topic) continue;
    const key = topicKey(row), existing = unique.get(key);
    if (existing) existing.roles.add(pretty(row.role || 'Topic'));
    else unique.set(key, { ...row, roles: new Set([pretty(row.role || 'Topic')]) });
  }
  const groups = new Map();
  for (const row of unique.values()) {
    const roles = [...row.roles], statusRequest = roles.some(role => /status request|read request|query/i.test(role));
    const command = roles.some(role => /command|setting|rpc requests/i.test(role));
    const label = row.direction !== 'publish' ? 'Incoming' : /rpc requests/i.test(roles.join(' ')) || statusRequest && command
      ? 'Requests & commands' : statusRequest ? 'Status requests' : 'Commands';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ role: roles.join(' / '), topic: row.topic, direction: row.direction });
  }
  return ['Incoming', 'Status requests', 'Commands', 'Requests & commands']
    .filter(label => groups.has(label)).map(label => ({ label, topics: groups.get(label) }));
}

export function equipmentConnectionSummary(device) {
  const mqtt = device.mqttStatus, check = device.check;
  let label = device.connectionState?.label, state = device.connectionState?.state;
  if (!label) {
    [label, state] = device.enabled === false ? ['Not enabled', 'pending']
      : check?.checking ? ['Checking', 'pending'] : device.available && !device.needsAttention ? ['Available', 'available']
        : mqtt?.subscriptionStatus === 'disconnected' ? ['Disconnected', 'attention']
          : check?.status === 'retained-only' ? ['Live state unconfirmed', 'attention']
            : check?.status === 'timeout' ? ['No live response', 'attention']
              : ['listening', 'awaiting-report'].includes(check?.status) ? ['Waiting for report', 'pending']
                : ['failed', 'denied'].includes(mqtt?.subscriptionStatus) || check?.status === 'unavailable'
                  ? ['Connection issue', 'attention'] : ['Needs attention', 'attention'];
  }
  const reportedAt = device.lastReportAt ?? mqtt?.lastLiveAt ?? Math.max(...Object.values(device.readings ?? {})
    .map(reading => reading.observedAt ?? reading.receivedAt).filter(Number.isFinite));
  const checkedAt = check?.checkedAt;
  const recent = check?.checking ? 'Checking connection…'
    : Number.isFinite(checkedAt) && (!Number.isFinite(reportedAt) || checkedAt > reportedAt) ? `Checked ${clock.format(checkedAt)}`
      : Number.isFinite(reportedAt) ? `Reported ${clock.format(reportedAt)}`
        : Number.isFinite(mqtt?.lastRetainedAt) ? 'Saved broker value only' : device.recent ?? 'No live report yet';
  return { label, state, recent };
}

function vehicleConnection({ reception = {}, enabled = true, label, source, detail, usedBy }) {
  reception ??= {};
  const connected = reception.brokerConnected ?? reception.connected;
  const subscribed = reception.subscribed === true || reception.subscriptionStatus === 'subscribed';
  const failed = ['failed', 'denied', 'error'].includes(reception.subscriptionStatus);
  const { lastLiveAt, lastRetainedAt, lastMessageAt, invalidReason } = reception;
  return { label, kind: 'vehicle', source, mqttStatus: reception,
    lastReportAt: lastLiveAt,
    connectionState: enabled === false ? { label: 'Not enabled', state: 'pending' }
      : connected === false ? { label: 'Disconnected', state: 'attention' }
        : failed ? { label: 'Subscription failed', state: 'attention' }
          : invalidReason ? { label: 'Invalid vehicle report', state: 'attention' }
            : reception.available === false && subscribed ? { label: reception.reason === 'vehicle-feed-stale' ? 'Vehicle feed stale' : 'Awaiting live vehicle report', state: 'attention' }
            : connected === true && (subscribed || Number.isFinite(lastMessageAt)) ? { label: 'Connected', state: 'available' }
              : { label: 'Awaiting subscription', state: 'pending' },
    recent: Number.isFinite(lastMessageAt) ? `Received ${clock.format(lastMessageAt)}`
      : subscribed ? 'Waiting for the first vehicle report' : 'No vehicle report yet',
    feedDetail: `${detail}${usedBy ? ` Used by ${usedBy}.` : ''}`,
    connectionDetail: `${source} sends vehicle reports through this MQTT subscription. Connection status and packet diagnostics show whether the publisher is reporting. A sleeping or idle vehicle can remain quiet while MQTT stays connected.`,
    packetDetail: [invalidReason ? 'The latest vehicle report could not be used; previous accepted readings keep their original timestamps.' : '',
      reception.reason === 'vehicle-feed-stale' ? 'The MQTT broker is connected, but the vehicle publisher has stopped reporting. Automatic vehicle inputs await a valid live report.' : '',
      Number.isFinite(lastLiveAt) ? ''
        : Number.isFinite(lastRetainedAt) ? 'Saved broker context only; no live vehicle report received yet.'
          : 'Connection status follows the MQTT subscription; vehicle charge readings keep their own timestamps.'].filter(Boolean).join(' '),
  };
}

/** Device purpose stays separate from changing connection-check results. */
export function equipmentConnectionIntroduction(device) {
  if (device.kind === 'floor_override') return 'One SONOFF 4CH PRO R3 is planned for the four ground-floor heating circuits. Preheating remains unavailable until communication and automatic release are verified.';
  if (device.connectionDetail) return device.connectionDetail;
  if (device.controls?.tariff || device.controlsHeat || device.role === 'heat_savings')
    return 'Heating requests and relay readback use MQTT. Reported relay state confirms whether the requested mode was applied.';
  return ({
    temperature: 'Temperature readings arrive over MQTT. Each sensor keeps its own reading and availability.',
    door: 'Door position reports arrive over MQTT. Configured commands operate the door; a new position report confirms its state.',
    switch: 'Switch reports and configured commands use MQTT. A new device report confirms the requested state.',
    power: 'Power readings arrive over MQTT. Their reported times and availability remain visible alongside each reading.',
    metered_switch: 'Power and switch reports arrive over MQTT and support energy history. A new device report confirms the requested switch state.',
    dehumidifier: 'Dehumidifier status and configured commands use MQTT. New device reports confirm requested settings.',
    heat_pump: 'Heat-pump readings and configured commands use MQTT. Reported device state confirms operation.',
  })[device.kind] ?? 'Device reports and configured requests use MQTT. Connection status follows the available device evidence.';
}

function shellyChargerConnection(status) {
  const health = status.providers?.['shelly-evse'];
  if (!health) return null;
  const mqtt = health.mqttStatus;
  const [label, state] = health.enabled === false || health.status === 'disabled' ? ['Not enabled', 'pending']
    : mqtt?.brokerConnected === false || mqtt?.subscriptionStatus === 'disconnected' ? ['Disconnected', 'attention']
      : ['failed', 'denied', 'error', 'rejected'].includes(mqtt?.subscriptionStatus) ? ['Subscription failed', 'attention']
        : health.status === 'degraded' ? ['Needs attention', 'attention']
          : health.status === 'error' ? ['Needs attention', 'attention']
            : health.connected === true ? [health.status === 'ok' ? 'Available' : 'Connected', 'available']
              : ['not-configured', 'unconfigured'].includes(health.status) ? ['Not configured', 'pending']
                : ['Waiting for device', 'pending'];
  return { id: 'connection:shelly-evse:garage', label: 'Charger 2', area: 'garage', kind: 'charger', source: 'Shelly EVSE',
    enabled: health.enabled, topics: health.topics ?? [], mqttStatus: mqtt, lastReportAt: mqtt?.lastLiveAt,
    connectionState: { label, state },
    connectionDetail: 'Charger 2 reports electricity use and charger state through its local Shelly MQTT connection. RPC requests read device status and apply charging settings.',
    packetDetail: mqtt ? `Broker connection: ${mqtt.brokerConnected === true ? 'connected' : mqtt.brokerConnected === false ? 'disconnected' : 'unknown'}.` : '',
  };
}

/** Vehicle feeds share the connection descriptors used by their detailed cards. */
export const vehicleConnections = status => equipmentConnections(status).filter(device => device.kind === 'vehicle');

/** Fold supplemental routes into their device once; unowned routes remain
 * separate connections with an explicit, evidence-based monitoring state. */
export function equipmentConnections(status = {}, devices = equipmentDevices(status), inventory = equipmentInventory(status)) {
  const rows = devices.map(device => ({ ...device,
    needsAttention: device.needsAttention || inventory.find(row => row.id === device.id)?.needsAttention,
    topics: device.topics?.length ? [...device.topics]
    : device.connection ? [{ role: 'Connection', topic: device.connection, direction: 'subscribe' }] : [] }));
  for (const [broker, health] of Object.entries(status.equipment?.brokers ?? {})) rows.push({
    id: `mqtt-broker:${broker}`, label: broker === 'ha' ? 'Home Assistant MQTT' : 'Primary MQTT',
    kind: 'broker', area: 'other', source: 'MQTT', topics: [],
    mqttStatus: { broker, brokerConnected: health.connected },
    connectionState: !health.connected ? { label: 'Disconnected', state: 'attention' }
      : health.ready ? { label: 'Connected', state: 'available' } : { label: 'Awaiting subscriptions', state: 'pending' },
    connectionDetail: broker === 'ha' ? 'TeslaMate, BMW CarData, garage doors and the Tuya bridge use this connection.'
      : 'Direct devices use this connection. HA services also use it when no separate HA broker is configured.',
  });
  const charger = shellyChargerConnection(status);
  if (charger) rows.push(charger);
  const owner = new Map(rows.flatMap(row => row.topics.map(topic => [topicKey(topic), row])));
  const groups = new Map();
  for (const group of status.equipment?.topicGroups ?? []) {
    const prior = groups.get(group.id);
    groups.set(group.id, { ...group, topics: [...(prior?.topics ?? []), ...(group.topics ?? [])] });
  }
  const vehicleFeeds = status.charging?.vehicleFeeds ?? [];
  const vehicleFeedFor = group => vehicleFeeds.find(feed => feed.id === group.vehicleFeedId || group.id === `vehicle:${feed.id}`
    || feed.topic && group.topics.some(topic => topic.topic === feed.topic));
  for (const feed of vehicleFeeds) if (feed.topic && ![...groups.values()].some(group => vehicleFeedFor(group) === feed)) {
    groups.set(`vehicle:${feed.id}`, { id: `vehicle:${feed.id}`, vehicleFeedId: feed.id,
      topics: [{ role: feed.provider === 'teslamate' ? 'Vehicle subscription' : 'Timestamped vehicle readings', topic: feed.topic, direction: 'subscribe' }] });
  }
  if (status.dhwr?.commandTopic) {
    const prior = groups.get('dhwr');
    groups.set('dhwr', { id: 'dhwr', label: 'Hot-water circulation', ...prior,
      topics: [...(prior?.topics ?? []), { role: 'Circulation command', topic: status.dhwr.commandTopic, direction: 'publish' }] });
  }
  for (const group of groups.values()) {
    const attached = rows.find(row => row.id === (group.id === 'dhwr' ? status.dhwr?.feedback?.deviceId : group.id));
    const remaining = [];
    for (const topic of group.topics) {
      const existing = owner.get(topicKey(topic)) ?? attached;
      if (existing) { existing.topics.push(topic); owner.set(topicKey(topic), existing); }
      else remaining.push(topic);
    }
    if (!remaining.length) continue;
    const parts = group.id === 'temperatures' ? ['home', 'garage'].map(area => ({ area,
      topics: remaining.filter(topic => (topic.signal?.startsWith('garage_') ? 'garage' : 'home') === area) }))
      : [{ area: ['garage-adapter', 'garage-sender'].includes(group.id) ? 'garage' : ['h66', 'dhwr', 'heating'].includes(group.id) ? 'home' : 'other', topics: remaining }];
    for (const part of parts) {
      if (!part.topics.length) continue;
      const row = { id: `connection:${group.id}:${part.area}`, label: group.label ?? pretty(group.id), area: part.area,
        source: group.source ?? 'MQTT', kind: 'connection', supplemental: true, topics: [],
        connectionState: { label: 'Configured', state: 'pending' }, recent: 'No live report yet',
        connectionDetail: 'Configured MQTT routes. Connection health is shown only when device reports are available.' };
      if (group.id === 'h66') {
        const native = status.h66 ?? {};
        Object.assign(row, { kind: 'heat_pump', source: 'H66', lastReportAt: native.lastPublicationAt,
          connectionState: native.enabled === false ? { label: 'Not enabled', state: 'pending' }
            : native.available && native.brokerConnected !== false ? { label: 'Live reports', state: 'available' }
              : native.brokerConnected === false ? { label: 'Disconnected', state: 'attention' }
                : { label: 'Awaiting pump reports', state: 'pending' },
          connectionDetail: 'Heat-pump readings, status requests and native parameter commands.',
          packetDetail: `Broker connection: ${native.brokerConnected === true ? 'connected' : native.brokerConnected === false ? 'disconnected' : 'unknown'}.` });
      } else if (vehicleFeedFor(group)) {
        const feed = vehicleFeedFor(group);
        const source = ({ 'bmw-cardata': 'BMW CarData', teslamate: 'TeslaMate' })[feed.provider] ?? 'MQTT';
        const usedBy = status.charging?.chargers?.find(charger => charger.id === feed.usedByChargerId)?.label;
        Object.assign(row, vehicleConnection({ label: feed.label, source, enabled: feed.enabled, reception: { ...feed.reception, broker: group.broker ?? feed.reception?.broker }, usedBy,
          detail: feed.provider === 'teslamate' ? 'TeslaMate supplies charge and charge target, plus vehicle state for charger identification. Times show when each reading was first received.'
            : feed.provider === 'bmw-cardata' ? 'BMW CarData supplies charge, charge target and usable battery capacity, with the original measurement time for each reading.'
              : 'Available charge, charge target and battery capacity support charging when this vehicle is identified at a charger. Each reading keeps its original measurement time.' }));
      } else if (group.id === 'dhwr' || group.id === 'heating') {
        row.kind = 'control'; row.connectionState = { label: 'Commands configured', state: 'pending' };
        row.recent = 'Delivery is confirmed separately';
        row.connectionDetail = group.id === 'dhwr' ? 'Hot-water circulation uses this timed ON/OFF command route.'
          : 'Heating mode requests use this command route; a configured topic does not confirm device delivery.';
      } else if (group.id === 'garage-sender') {
        Object.assign(row, { kind: 'sender', source: 'Shelly' });
      } else if (group.id === 'garage-adapter') {
        const native = status.garage?.adapter ?? {};
        const communicating = native.connected === true && native.health?.deviceOnline === true
          && native.health?.driverProgressing === true && native.health?.pumpCommunicating === true;
        Object.assign(row, { label: 'Garage heat pump', kind: 'heat_pump', source: 'Mitsubishi',
          lastReportAt: native.native?.powerAt,
          connectionState: communicating ? { label: 'Pump communicating', state: 'available' }
            : native.connected === false ? { label: 'Disconnected', state: 'attention' }
              : native.health?.deviceOnline === false ? { label: 'Device offline', state: 'attention' }
                : native.health?.driverProgressing === false ? { label: 'Driver not reporting', state: 'attention' }
                  : { label: 'Awaiting pump reports', state: 'pending' },
          connectionDetail: native.liveControlSupported ? 'Garage heat-pump monitoring and control.' : 'Garage heat-pump monitoring. Direct control is not available on this installation yet.' });
      } else if (group.id === 'temperatures') {
        const readings = part.topics.map(topic => inventory.flatMap(device => Object.entries(device.readings ?? {}))
          .find(([signal]) => signal === topic.signal)?.[1]).filter(Boolean);
        const usable = readings.length === part.topics.length && readings.every(reading => reading.displayStatus?.usable === true);
        Object.assign(row, { kind: 'temperature', readings: Object.fromEntries(readings.map((reading, index) => [index, reading])),
          connectionState: usable ? { label: 'Available', state: 'available' } : { label: 'Needs attention', state: 'attention' },
          connectionDetail: 'Temperature feeds reported directly over MQTT. Each configured probe keeps its own reading and freshness status.' });
      }
      for (const topic of part.topics) {
        const existing = owner.get(topicKey(topic));
        if (existing) existing.topics.push(topic);
        else { row.topics.push(topic); owner.set(topicKey(topic), row); }
      }
      if (row.topics.length) rows.push(row);
    }
  }
  // Stable sorting keeps room temperatures in their configured order.
  const order = row => row.area === 'garage' ? garageEquipmentOrder(row) : row.kind === 'floor_override' ? 6 : row.area !== 'home' ? 4 : row.source === 'H66' ? 0 : row.kind === 'temperature' ? 1
    : row.id === status.dhwr?.feedback?.deviceId || row.id === 'connection:dhwr:home' ? 2
      : row.controls?.tariff || row.controlsHeat || row.role === 'heat_savings' || row.id === 'connection:heating:home' ? 3 : 4;
  return rows.sort((a, b) => order(a) - order(b));
}

function garageEquipmentOrder(device) {
  return device.kind === 'heat_pump' ? 0 : device.id === 'connection:garage-sender:garage' ? 0.5 : device.kind === 'charger' ? 1.5 : device.id === 'blu_ht' ? 2 : device.kind === 'temperature' ? 1
    : device.id === 'caravan' ? 3 : device.kind === 'door' ? 4 + Number(device.id.match(/door([12])$/)?.[1] ?? 0) / 10
      : device.kind === 'dehumidifier' ? 2.5 : 6;
}

export function dhwrReadingSummary(status) {
  const dhwr = status.dhwr ?? {}, feedback = dhwr.feedback ?? {};
  const stateConfigured = feedback.stateConfigured ?? feedback.configured === true;
  const powerConfigured = feedback.powerConfigured ?? feedback.configured === true;
  const reading = (value, signal, configured) => {
    if (feedback.configured && !configured) return { value: 'Not configured', stale: false,
      detail: signal === 'state' ? 'Circulation feedback is not configured.'
        : 'Power feedback is not configured.' };
    return value ? equipmentReadingRows({ kind: 'switch', available: feedback.available,
      readings: { [signal]: value } })[0] : { value: signal === 'state' ? 'Unknown' : 'Unavailable', stale: true,
      detail: configured ? 'Waiting for a live MQTT report.' : 'Configure DHWR MQTT feedback to see device reports.' };
  };
  const state = reading(feedback.state, 'state', stateConfigured), power = reading(feedback.power, 'power', powerConfigured);
  const powerBasis = feedback.basis === 'power';
  if (powerBasis) state.detail += '. Positive power means circulation is on; zero power means it is off.';
  const eventOnly = feedback.power?.eventOnly === true;
  if (eventOnly) power.detail += '. Updated when power changes; there is no periodic measurement guarantee.';
  const powerOnly = powerBasis || !stateConfigured && powerConfigured;
  const reported = typeof dhwr.actualOn === 'boolean' ? `${dhwr.actualOn ? 'On' : 'Off'} · ${powerBasis ? 'power' : 'device'} reported` : '';
  const summary = dhwr.restorationPending ? ['Stop delivery pending', reported].filter(Boolean).join(' · ')
    : dhwr.attention ? [reported || (dhwr.active ? 'On requested' : 'Off requested'), 'needs attention'].join(' · ')
    : reported || (dhwr.active ? 'On requested · state unknown' : 'No request · state unknown');
  return { state, power, summary,
    summaryValue: dhwr.restorationPending ? 'Stop pending'
      : typeof dhwr.actualOn === 'boolean' ? dhwr.actualOn ? 'On' : 'Off' : dhwr.active ? 'On requested' : 'Unknown',
    summaryNote: dhwr.restorationPending ? reported || 'Delivery not confirmed'
      : dhwr.attention ? 'Needs attention'
        : typeof dhwr.actualOn === 'boolean' ? powerBasis ? 'Power reported' : 'Device reported'
          : dhwr.active ? 'Not confirmed' : 'No device readback',
    attention: dhwr.attention === true,
    powerLabel: eventOnly ? 'Last reported power' : 'Live power',
    powerReportedAt: eventOnly && Number.isFinite(feedback.power.observedAt) ? `Reported ${clock.format(feedback.power.observedAt)}` : '',
    feedbackLabel: dhwr.attention ? 'Needs attention' : !feedback.configured ? 'Feedback not configured' : powerOnly
      ? feedback.available ? eventOnly ? 'Power reported' : 'Power available' : feedback.power ? 'Power unavailable' : 'Waiting for power'
      : feedback.available ? 'Available' : 'Needs attention',
    request: dhwr.restorationPending ? 'Stop requested · delivery pending'
      : dhwr.reason || (dhwr.active ? 'Circulation requested' : 'No circulation requested'),
    duration: dhwr.durationMinutes ?? 10,
    available: feedback.available === true, configured: feedback.configured === true };
}

export function createEquipmentPanel({ document, request, onStatus, beforeRequest, onBusy = () => {}, onChange = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), connectionNodes = new Map(), connectionGroups = new Map(), restoreNodes = new Map(), readingNodes = new Map();
  let current;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const button = (text, action) => {
    const node = make('button', text, 'secondary-button'); node.setAttribute('data-write-control', ''); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const floorSetupLink = () => {
    const paragraph = make('p', '', 'floor-setup-link');
    const link = make('a', 'Home floor preheating status & setup →');
    link.href = '#floor-preheat-details'; link.setAttribute('data-open-floor-setup', '');
    link.addEventListener('click', event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (document.defaultView?.location?.hash !== '#floor-preheat-details')
        document.defaultView?.history?.pushState(null, '', '#floor-preheat-details');
      openSetup('floor-preheat-details');
    });
    paragraph.append(link);
    return paragraph;
  };
  function openSetup(id) {
    const target = $(id);
    if (!target) return;
    for (let fold = target; fold; fold = fold.parentElement?.closest('details')) fold.open = true;
    target.querySelector('summary')?.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'start' });
  }
  const openSetupHash = () => {
    const id = document.defaultView?.location?.hash?.slice(1);
    if (['floor-preheat-details', 'garage-protection-details', 'garage-protection-settings-details',
      'garage-protection-configuration-details'].includes(id)) openSetup(id);
  };
  document.defaultView?.addEventListener('hashchange', openSetupHash);
  openSetupHash();
  const actions = createEquipmentActions({ request, onStatus, beforeRequest, onChange(snapshot) {
    current = snapshot; onBusy(snapshot.busy); render(snapshot);
  } });
  function renderReadingList(root, devices, snapshot) {
    const { status, busy, message, error, actionKind, actionDeviceId } = snapshot;
    for (const [index, device] of devices.entries()) {
      const staticReadings = (device.kind === 'temperature' && !device.controls?.switch
        || device.controls?.tariff === true) && !Object.values(device.controls?.cover ?? {}).some(Boolean);
      let node = readingNodes.get(device.id);
      if (node && node.staticReadings !== staticReadings) {
        node.section.remove(); readingNodes.delete(device.id); node = null;
      }
      if (!node) {
        const section = make(staticReadings ? 'section' : 'details', '', `equipment-device${staticReadings ? ' equipment-device-static' : ''}`);
        const summary = make(staticReadings ? 'div' : 'summary', '', 'equipment-device-summary');
        const heading = make('div', '', 'equipment-device-heading'), body = make('div', '', 'equipment-device-body');
        section.dataset.deviceId = device.id;
        const title = make('h4'), metadata = make('small', '', 'equipment-device-meta');
        const preview = make('span', '', 'equipment-device-preview'), health = make('span', '', 'equipment-device-health');
        const source = make('span', '', 'equipment-source'), recent = make('small', '', 'equipment-device-recent');
        const list = make('dl', '', 'equipment-readings'), empty = make('p', 'Waiting for readings', 'muted');
        const controls = make('div', '', 'equipment-inline-controls'), buttons = make('div', '', 'equipment-switch-buttons');
        buttons.setAttribute('role', 'group');
        const on = button('Turn on', () => { if (!blocked()) void actions.switch(device.id, true); });
        const off = button('Turn off', () => { if (!blocked()) void actions.switch(device.id, false); });
        buttons.setAttribute('data-admin-only', '');
        const help = make('p', '', 'muted'), result = make('p', '', 'equipment-control-result');
        const switchAccess = make('p', 'Admin access is required to switch this device on or off.', 'family-access-note');
        result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        buttons.append(on, off); controls.append(buttons, switchAccess, help, result);
        const coverControls = make('div', '', 'equipment-inline-controls equipment-cover-controls');
        const coverButtons = make('div', '', 'equipment-cover-buttons'), coverActions = {};
        coverButtons.setAttribute('role', 'group');
        for (const [action, text, path] of [['open', 'Open', 'm5 14 7-7 7 7'], ['close', 'Close', 'm5 10 7 7 7-7'], ['stop', 'Stop', 'M6 6h12v12H6z']]) {
          const control = button('', () => { if (!blocked()) void actions.cover(device.id, action); });
          control.dataset.coverAction = action;
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
          const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path); icon.append(shape);
          control.append(icon, make('span', text)); coverButtons.append(control); coverActions[action] = control;
        }
        const coverHelp = make('p', '', 'muted'), coverResult = make('p', '', 'equipment-control-result');
        const coverAccess = make('p', 'Admin access is required to operate doors outside the garage.', 'family-access-note');
        coverHelp.id = `equipment-cover-${device.id}-help`;
        coverResult.setAttribute('role', 'status'); coverResult.setAttribute('aria-live', 'polite');
        coverControls.append(coverButtons, coverAccess, coverHelp, coverResult);
        const caravan = device.id === 'caravan' ? createCaravanContents({ document, actions, blocked,
          readingsFor: equipmentReadingRows, summaryFor: equipmentConnectionSummary }) : null;
        const energyTitle = make('h5', 'Energy', 'caravan-energy-title');
        heading.append(title, metadata); health.append(source, recent);
        if (staticReadings) {
          summary.append(heading, health, list, empty); section.append(summary);
        } else {
          summary.append(heading, preview, health);
          if (caravan) body.append(caravan.air, energyTitle);
          body.append(list, empty, controls, coverControls);
          if (device.kind === 'floor_override') body.append(floorSetupLink());
          if (caravan) body.append(caravan.dehumidifier);
          section.append(summary, body);
        }
        node = { section, staticReadings, title, metadata, preview, source, recent, list, empty, controls, buttons, on, off, help, result,
          coverControls, coverButtons, coverActions, coverHelp, coverResult, coverAccess, caravan, energyTitle, rows: new Map() }; readingNodes.set(device.id, node);
      }
      if (root.children[index] !== node.section) {
        // Moving a details element preserves its open state. Keep keyboard focus
        // on its current control too when a status update changes device order.
        const focused = node.section.contains(document.activeElement) ? document.activeElement : null;
        root.insertBefore(node.section, root.children[index] ?? null);
        focused?.focus({ preventScroll: true });
      }
      node.title.textContent = device.label ?? labels[device.kind] ?? 'Device';
      node.metadata.textContent = [labels[device.kind] ?? pretty(device.kind || 'device'), equipmentSource(device)].join(' · ');
      const connection = equipmentConnectionSummary(device);
      node.source.textContent = connection.label;
      node.source.dataset.state = connection.state;
      node.section.dataset.state = connection.state;
      node.recent.textContent = connection.recent;
      const rows = equipmentReadingRows(device);
      node.preview.textContent = rows.slice(0, 2).map(row => `${rows.length > 1 || device.kind === 'heat_pump' ? `${row.label}: ` : ''}${row.value}${row.qualifier ? ` (${row.qualifier})` : ''}`).join(' · ');
      node.preview.hidden = !rows.length;
      node.empty.hidden = rows.length > 0; node.list.hidden = !rows.length;
      if (node.caravan) {
        const garageDevices = status.equipment?.devices?.filter(device => device.area === 'garage' && device.enabled !== false) ?? [];
        const air = garageDevices.find(device => device.id === 'blu_ht'), dehumidifier = garageDevices.find(device => device.id === 'caravan_dehumidifier');
        node.caravan.update(snapshot, air, dehumidifier);
        node.title.textContent = 'Caravan';
        node.metadata.textContent = [air ? 'Air' : null, rows.length ? 'Energy' : null, dehumidifier ? 'Dehumidifier' : null].filter(Boolean).join(' · ');
        node.energyTitle.hidden = !rows.length || !air && !dehumidifier;
        if (air) {
          const airRows = equipmentReadingRows(air).filter(row => /(?:^|_)(?:temperature|humidity)$/.test(row.signal));
          const power = rows.find(row => row.signal === 'caravan_power');
          node.preview.textContent = [...airRows.map(row => row.value), ...(power ? [power.value] : [])].join(' · ');
          node.preview.hidden = !node.preview.textContent;
        }
        if (!rows.length) { node.empty.hidden = true; node.source.textContent = ''; node.recent.textContent = ''; }
      }
      for (const [index, row] of rows.entries()) {
        let cells = node.rows.get(row.signal);
        if (!cells) {
          const term = make('dt'), description = make('dd'), value = make('strong'), qualifier = make('small', '', 'equipment-reading-qualifier');
          description.append(value, qualifier); cells = { term, description, value, qualifier }; node.rows.set(row.signal, cells);
        }
        cells.term.textContent = row.label; cells.value.className = row.stale ? 'stale' : '';
        const relayNote = device.kind === 'floor_override'
          ? ' Contact readback only; valve movement, water flow and thermostat restoration require physical verification.'
          : device.kind === 'heat_pump' && /_active$/.test(row.signal)
          ? ' Power enabled describes the relay, not compressor activity.' : '';
        setStatusDetail(cells.value, { label: row.value, title: `${device.label ?? 'Device'} · ${row.label}`,
          detail: row.detail + relayNote, key: `equipment:${device.id}:${row.signal}` });
        cells.qualifier.textContent = row.qualifier ?? ''; cells.qualifier.hidden = !row.qualifier;
        if (node.list.children[index * 2] !== cells.term) node.list.insertBefore(cells.term, node.list.children[index * 2] ?? null);
        if (node.list.children[index * 2 + 1] !== cells.description) node.list.insertBefore(cells.description, node.list.children[index * 2 + 1] ?? null);
      }
      for (const [signal, cells] of node.rows) if (!rows.some(row => row.signal === signal)) {
        cells.term.remove(); cells.description.remove(); node.rows.delete(signal);
      }
      node.controls.hidden = !device.controls?.switch || Boolean(device.controls?.tariff);
      node.buttons.setAttribute('aria-label', `${device.label ?? 'Device'} switch`);
      const allowed = equipmentControlAllowed(status, device, busy || blocked());
      const states = Object.values(device.readings ?? {}).filter(reading => reading.unit === 'state');
      const state = states.length === 1 && states[0].stale === false ? states[0].value : null;
      node.on.setAttribute('aria-pressed', state === 1 ? 'true' : 'false');
      node.off.setAttribute('aria-pressed', state === 0 ? 'true' : 'false');
      node.on.disabled = !allowed || state === 1; node.off.disabled = !allowed || state === 0;
      node.help.textContent = allowed ? 'Changes stay in effect until changed again.'
        : isReadOnlyReplica(status) ? 'Controls are available on the master computer.'
          : busy || blocked() || status.equipmentControls?.busy ? 'Another request is in progress.'
            : !device.available ? 'A current switch report is needed to control this device.'
              : status.equipmentControls?.reason ?? 'Manual control is unavailable.';
      const last = status.equipmentControls?.lastResult;
      const scoped = actionKind === 'control' && actionDeviceId === device.id;
      node.controlReceipt ??= createReceiptTracker();
      const receipt = node.controlReceipt(last && `${last.at}:${last.on}`, equipmentControlReceipt(status, device), status.now);
      const result = controlReceiptText(receipt);
      node.result.textContent = scoped && (busy || error) ? message : result;
      node.result.hidden = !node.result.textContent;
      node.result.classList.toggle('form-error', Boolean(scoped && error || receipt && !receipt.confirmed && !receipt.superseded && ['failed', 'unconfirmed'].includes(receipt.status)));
      const hasCoverControls = device.kind === 'door' && ['open', 'close', 'stop'].some(action => device.controls?.cover?.[action] === true);
      node.coverControls.hidden = !hasCoverControls;
      node.coverButtons.setAttribute('aria-label', `${device.label ?? 'Door'} operation`);
      node.coverAccess.hidden = device.area === 'garage' && device.kind === 'door';
      for (const [action, control] of Object.entries(node.coverActions)) {
        if (device.area !== 'garage' || device.kind !== 'door') control.setAttribute('data-admin-only', '');
        else control.removeAttribute('data-admin-only');
        control.hidden = device.controls?.cover?.[action] !== true;
        control.disabled = !equipmentCoverAllowed(status, device, action, busy || blocked());
        control.setAttribute('aria-label', `${action[0].toUpperCase() + action.slice(1)} ${device.label ?? 'door'}`);
        control.setAttribute('aria-describedby', node.coverHelp.id);
      }
      const coverScoped = actionKind === 'cover' && actionDeviceId === device.id;
      node.coverHelp.textContent = isReadOnlyReplica(status) ? 'Controls are available on the master computer.'
        : busy || blocked() ? 'Another request is in progress.'
          : !device.cover?.available ? 'Door control is unavailable. Check the connection.'
            : 'Open means the door is not fully closed.';
      const operation = device.cover?.operation;
      node.coverReceipt ??= createReceiptTracker();
      const coverReceipt = node.coverReceipt(operation && `${operation.requestedAt}:${operation.action}`, equipmentCoverReceipt(device, status.now ?? Date.now()), status.now);
      const coverResult = coverReceiptText(coverReceipt);
      node.coverResult.textContent = coverScoped && (busy || error) ? message : coverResult;
      node.coverResult.hidden = !node.coverResult.textContent;
      node.coverResult.classList.toggle('form-error', Boolean(coverScoped && error || coverReceipt && !coverReceipt.confirmed && !coverReceipt.superseded && ['failed', 'unconfirmed'].includes(coverReceipt.status)));
    }
    for (const child of [...root.children]) if (!devices.some(device => device.id === child.dataset.deviceId)) child.remove();
  }
  function renderTopics(root, topics) {
    const signature = JSON.stringify(topics);
    if (root.dataset.topics === signature) return;
    root.dataset.topics = signature; root.replaceChildren();
    for (const group of equipmentTopicGroups(topics)) {
      const section = make('section', '', 'equipment-topic-group'), list = make('dl', '', 'equipment-topic-list');
      section.append(make('h5', group.label), list);
      for (const row of group.topics) {
        const item = make('div'), term = make('dt', row.role), description = make('dd');
        description.append(make('code', row.topic)); item.append(term, description); list.append(item);
      }
      root.append(section);
    }
  }
  function render(snapshot) {
    const { status, busy, message, error, actionKind } = snapshot;
    if (!status) return;
    onChange(snapshot);
    const devices = equipmentDevices(status), inventory = equipmentInventory(status), active = status.equipmentTests?.active;
    const connections = equipmentConnections(status, devices, inventory);
    const isCaravanMember = device => device.area === 'garage' && ['blu_ht', 'caravan_dehumidifier'].includes(device.id);
    if (inventory.some(isCaravanMember) && !inventory.some(device => device.id === 'caravan')) inventory.push({
      id: 'caravan', label: 'Caravan', area: 'garage', kind: 'caravan_group', readings: {}, controls: {}, available: true, inventoryOnly: true,
    });
    const readOnly = isReadOnlyReplica(status), locked = busy || blocked();
    for (const area of ['home', 'garage']) {
      const members = inventory.filter(device => device.area === area);
      renderReadingList($(`${area}-equipment-readings`), members.filter(device => device.id !== status.dhwr?.feedback?.deviceId && !isCaravanMember(device))
        .sort((a, b) => area === 'garage' ? garageEquipmentOrder(a) - garageEquipmentOrder(b) : 0), snapshot);
      if (!members.length && area === 'garage') $(`${area}-equipment-readings`).append(make('p', 'No garage devices enabled.', 'muted equipment-empty'));
      const overview = $(`${area}-equipment-status`), unavailable = members.filter(device => !device.available || device.needsAttention).length;
      if (overview) {
        overview.textContent = !members.length ? '' : isReadOnlyReplica(status) ? `${members.length} recorded` : unavailable ? `${unavailable} ${unavailable === 1 ? 'needs' : 'need'} attention`
          : `${members.length} available`;
        overview.dataset.state = isReadOnlyReplica(status) ? 'pending' : unavailable ? 'attention' : members.length ? 'available' : 'pending';
      }
      const activeNode = $(`${area}-active-test`), activeDevice = devices.find(device => device.id === active?.deviceId);
      activeNode.hidden = !active || (activeDevice?.area ?? 'garage') !== area;
      if (!activeNode.hidden) activeNode.textContent = `${activeDevice?.label ?? 'Device'} · ${pretty(active.status ?? 'temporary override')}`;
      $(`${area}-test-notice`).hidden = activeNode.hidden;
      let restore = restoreNodes.get(area);
      if (!restore) {
        restore = button('Restore previous state', () => { if (!blocked()) void actions.restore(); });
        restore.setAttribute('data-admin-only', '');
        const access = make('p', 'Admin access is required to restore an equipment test.', 'family-access-note');
        restore.classList.add('equipment-restore'); restoreNodes.set(area, restore); $(`${area}-test-notice`).append(restore, access);
      }
      restore.hidden = activeNode.hidden; restore.disabled = activeNode.hidden || readOnly || locked;
      const result = $(`${area}-equipment-result`);
      const actionArea = devices.find(device => device.id === snapshot.actionDeviceId)?.area ?? 'garage';
      result.textContent = actionKind === 'test' && actionArea === area ? message : '';
      result.hidden = !result.textContent; result.classList.toggle('form-error', error);
    }
    const connectionRoot = $('equipment-connections');
    let groupIndex = 0;
    for (const [area, label] of [['home', 'Home'], ['garage', 'Garage'], ['other', 'Other'], ['vehicles', 'Vehicles']]) {
      const members = connections.filter(device => (device.kind === 'vehicle' ? 'vehicles'
        : ['home', 'garage'].includes(device.area) ? device.area : 'other') === area);
      let group = connectionGroups.get(area);
      if (!members.length) { group?.section.remove(); continue; }
      if (!group) {
        const section = make('section', '', 'equipment-connection-group'), list = make('div', '', 'equipment-connection-list');
        section.dataset.connectionArea = area;
        section.append(make('h4', label, 'equipment-connection-group-title'), list);
        group = { section, list }; connectionGroups.set(area, group);
      }
      if (connectionRoot.children[groupIndex] !== group.section) connectionRoot.insertBefore(group.section, connectionRoot.children[groupIndex] ?? null);
      groupIndex++;
      for (const [index, device] of members.entries()) {
      let node = connectionNodes.get(device.id);
      if (!node) {
        const row = make('details', '', 'equipment-connection-fold'), summary = make('summary', '', 'equipment-connection-summary');
        row.dataset.deviceId = device.id;
        const identity = make('span', '', 'equipment-connection-identity'), health = make('span', '', 'equipment-connection-health');
        const name = make('strong', '', 'equipment-connection-name'), metadata = make('small', '', 'equipment-connection-meta');
        const state = make('span', '', 'equipment-device-status'), recent = make('small', '', 'equipment-connection-recent');
        identity.append(name, metadata); health.append(state, recent); summary.append(identity, health);
        const body = make('div', '', 'equipment-connection-body'), check = make('div', '', 'equipment-connection-check');
        const intro = make('p', '', 'muted equipment-connection-intro');
        const checked = make('small', '', 'muted'), detail = make('p', '', 'muted equipment-check-detail');
        const topics = make('div', '', 'equipment-topic-groups'), diagnostics = make('details', '', 'equipment-packet-details');
        const packets = make('p', '', 'muted equipment-packet-status');
        diagnostics.append(make('summary', 'Packet diagnostics'), packets);
        check.append(detail, checked); body.append(intro, check);
        if (device.kind === 'floor_override') body.append(floorSetupLink());
        body.append(topics, diagnostics); row.append(summary, body);
        node = { row, name, metadata, state, recent, intro, check, checked, detail, topics, diagnostics, packets }; connectionNodes.set(device.id, node);
      }
      if (group.list.children[index] !== node.row) group.list.insertBefore(node.row, group.list.children[index] ?? null);
      node.name.textContent = device.label ?? labels[device.kind] ?? 'MQTT connection';
      node.metadata.textContent = [labels[device.kind] ?? pretty(device.kind || 'connection'),
        device.kind === 'floor_override' ? device.model : equipmentSource(device)].join(' · ');
      renderTopics(node.topics, device.topics); node.topics.hidden = !device.topics.length;
      const mqtt = device.mqttStatus;
      node.packets.textContent = [mqtt?.broker ? `Broker: ${mqtt.broker === 'ha' ? 'Home Assistant' : 'Primary'}${mqtt.brokerConnected === false ? ' (disconnected)' : ''}` : '',
        mqtt?.subscriptionStatus ? `Subscription: ${pretty(mqtt.subscriptionStatus)}` : '',
        Number.isFinite(mqtt?.lastLiveAt) ? `Last live packet: ${clock.format(mqtt.lastLiveAt)}` : mqtt ? 'No live packet received' : '',
        Number.isFinite(mqtt?.lastRetainedAt) ? `Saved broker packet: ${clock.format(mqtt.lastRetainedAt)}` : '',
        device.packetDetail ?? '', device.recheck?.description ?? ''].filter(Boolean).join(' · ');
      node.diagnostics.hidden = !node.packets.textContent;
      const summary = equipmentConnectionSummary(device);
      node.state.textContent = summary.label; node.state.dataset.state = summary.state; node.recent.textContent = summary.recent;
      node.intro.textContent = equipmentConnectionIntroduction(device);
      node.detail.textContent = device.kind === 'floor_override' ? device.connectionDetail
        : Number.isFinite(device.check?.checkedAt) ? equipmentCheckText(device) : '';
      node.detail.hidden = !node.detail.textContent;
      node.checked.textContent = Number.isFinite(device.check?.checkedAt) ? `Checked ${clock.format(device.check.checkedAt)}` : '';
      node.checked.hidden = !node.checked.textContent;
      node.check.hidden = node.detail.hidden && node.checked.hidden;
      node.row.dataset.state = summary.state;
      }
    }
    for (const [id, node] of connectionNodes) if (!connections.some(device => device.id === id)) { node.row.remove(); connectionNodes.delete(id); }
    for (const [id, node] of readingNodes) if (!inventory.some(device => device.id === id)) { node.section.remove(); readingNodes.delete(id); }
    const dhwrDevice = devices.find(device => device.id === status.dhwr?.feedback?.deviceId);
    const dhwrArea = dhwrDevice?.area === 'garage' ? 'garage' : 'home';
    const dhwrNode = $('dhwr-device'), dhwrAnchor = $(`${dhwrArea}-test-notice`);
    if (dhwrNode.parentElement !== dhwrAnchor.parentElement) dhwrAnchor.parentElement.insertBefore(dhwrNode, dhwrAnchor);
    $('dhwr-title').textContent = dhwrDevice?.label ?? 'Hot-water circulation';
    const dhwr = dhwrReadingSummary(status);
    const dhwrPreview = $('dhwr-preview');
    if (dhwrPreview) dhwrPreview.textContent = `${dhwr.state.value} · ${dhwr.powerLabel}: ${dhwr.power.value}`;
    $('dhwr-live-power-label').textContent = dhwr.powerLabel;
    $('dhwr-live-power-time').textContent = dhwr.powerReportedAt;
    $('dhwr-live-power-time').hidden = !dhwr.powerReportedAt;
    for (const [key, row] of [['state', dhwr.state], ['power', dhwr.power]]) {
      const root = $(`dhwr-live-${key}`); root.classList.toggle('stale', row.stale);
      setStatusDetail(root, { key: `dhwr-live-${key}`, label: row.value,
        title: key === 'state' ? 'Circulation · reported operation' : `Circulation · ${dhwr.powerLabel.toLowerCase()}`,
        detail: row.detail + (key === 'power' ? ' Power readings also determine the circulation shading in history.' : '') });
    }
    $('dhwr-feedback-status').textContent = dhwr.feedbackLabel;
    $('dhwr-feedback-status').dataset.state = dhwr.attention ? 'attention' : dhwr.available ? 'available' : dhwr.configured ? 'attention' : 'pending';
    $('dhwr-request-state').textContent = dhwr.request;
    $('dhwr-request-state').classList.toggle('stale', dhwr.attention);
    $('dhwr-control-help').textContent = `Each click starts a full ${dhwr.duration}-minute run, whether price control is paused or not. Stop ends it immediately.`;
    const commandRoot = $('heating-mqtt-topics');
    commandRoot.replaceChildren(); commandRoot.hidden = true;
    const checkMessage = actionKind === 'recheck' ? message : '';
    $('equipment-check-message').textContent = checkMessage || (connections.length ? '' : 'No MQTT devices configured.');
    $('equipment-check-message').hidden = !checkMessage && connections.length > 0;
    $('equipment-check-message').classList.toggle('form-error', Boolean(checkMessage && error));
  }
  for (const link of document.querySelectorAll('[data-open-mqtt-settings], [data-open-configuration]')) link.addEventListener('click', () => {
    $('connections-details').open = true;
    $(link.hasAttribute('data-open-configuration') ? 'controls-details' : 'mqtt-devices-details').open = true;
  });
  for (const link of document.querySelectorAll('[data-open-garage-protection]')) link.addEventListener('click', event => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const id = link.getAttribute('href').slice(1);
    if (document.defaultView?.location?.hash !== `#${id}`)
      document.defaultView?.history?.pushState(null, '', `#${id}`);
    openSetup(id);
  });
  return { update: status => actions.update(status), refreshControls: () => current && render(current), actions };
}
