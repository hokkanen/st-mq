import { isReadOnlyReplica } from './replica-status.js';
import { setStatusDetail } from './status-details.js';
import { temperatureReadingStatus } from './temperature-status.js';
import { TEMPERATURE_SENSORS } from '../src/domain/indoor-sensors.js';

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' });
const labels = { temperature: 'Temperatures', door: 'Door', switch: 'Switch', power: 'Power meter', metered_switch: 'Caravan', heat_pump: 'Heat pump', vehicle: 'Vehicle', floor_override: 'Switch' };
const pretty = text => String(text ?? '').replaceAll(/[_-]/g, ' ');
const RESULT_NOTICE_MS = 60_000;
const recentResult = (at, now) => !Number.isFinite(now)
  || Number.isFinite(at) && at <= now && now - at < RESULT_NOTICE_MS;
function equipmentStateReading(device, now) {
  const readings = Object.values(device?.readings ?? {}).filter(reading => reading.unit === 'state');
  const reading = readings.length === 1 ? readings[0] : null;
  return device?.available && reading?.stale === false && [0, 1].includes(reading.value)
    && Number.isFinite(reading.observedAt) && (!Number.isFinite(now) || reading.observedAt <= now) ? reading : null;
}
export const equipmentSource = device => ['Shelly', 'MQTT-shelly', 'shelly-mqtt'].includes(device.source) ? 'Shelly'
  : ['H66', 'Mitsubishi', 'Simulation', 'TeslaMate', 'BMW CarData'].includes(device.source) ? device.source : 'MQTT';
const temperatureKeys = { indoor_temperature: 'upstairs', downstairs_temperature: 'downstairs', bedroom_temperature: 'bedroom',
  garage_temperature: 'garage', garage_temperature_2: 'garageFront', outdoor_temperature: 'outdoor' };
const temperatureIds = { upstairs: 'indoor_temperature', indoor: 'indoor_temperature', downstairs: 'downstairs_temperature',
  bedroom: 'bedroom_temperature', garage: 'garage_temperature', garage_front: 'garage_temperature_2' };
/** Legacy Shelly captures are separate only when the equipment adapter is absent.
 * Keep actual device identities separate from the read-only inventory below. */
export function equipmentDevices(status = {}) {
  const devices = new Map();
  for (const device of [...(status.shelly?.devices ?? []), ...(status.equipment?.devices ?? [])]) {
    if (!device?.id) continue;
    devices.set(device.id, { ...device, area: device.area ?? (device.controls?.tariff || device.controlsHeat
      || device.role === 'heat_savings' ? 'home' : 'garage') });
  }
  const floor = status.preheatValves ?? { enabled: false, commissioned: false, devices: [] };
  for (const group of ['living', 'storage']) {
    const reported = floor.devices?.find(device => device.group === group);
    const enabled = floor.enabled === true, commissioned = floor.commissioned === true;
    const available = reported?.available === true;
    const label = group === 'storage' ? 'Storage area floor valves' : 'Living area floor valves';
    const leaseMinutes = (floor.leaseSeconds ?? 900) / 60;
    const renewMinutes = (floor.renewSeconds ?? 300) / 60;
    devices.set(`floor-override:${group}`, { id: `floor-override:${group}`, label,
      group, area: 'home', kind: 'floor_override', source: 'Shelly', model: 'Shelly Pro 2 v0',
      enabled, commissioned, available, topics: [], controls: { switch: false, tariff: false },
      lastReportAt: reported?.at,
      connectionState: !enabled ? { label: 'Not enabled', state: 'pending' }
        : !commissioned ? { label: 'Needs commissioning', state: 'pending' }
          : floor.restorationPending ? { label: 'Release pending', state: 'attention' }
            : !available ? { label: 'Awaiting local-script readback', state: 'attention' }
              : { label: floor.active ? 'Preheating' : 'Ready', state: 'available' },
      recent: !reported ? 'Device mapping not configured' : 'Waiting for a live script report',
      connectionDetail: 'Each output (0 and 1) overrides one thermostat, so this device overrides two thermostats. '
        + 'Both floor-valve devices preheat together, overriding four thermostats in total. '
        + (!enabled ? 'Disabled until device mapping and commissioning are complete. '
          : !commissioned ? 'Local expiry and native thermostat failback need commissioning. ' : '')
        + `The override renews every ${renewMinutes} minutes and ends locally after at most ${leaseMinutes} minutes without renewal, or at the planned end. `
        + 'OFF restores thermostat control. Relay readback does not prove valve movement or water flow. Local expiry does not restore the heat-pump ROOM setting. '
        + [0, 1].map(id => {
          const output = available ? reported?.channels?.find(channel => channel.id === id)?.output : null;
          return `Output ${id}: ${output === true ? 'override on' : output === false ? 'thermostat control' : 'unknown'}`;
        }).join('; ') + '.',
      readings: Object.fromEntries([0, 1].map(id => {
        const output = reported?.channels?.find(channel => channel.id === id)?.output;
        return [`floor_${group}_${id}_active`, { label: `Output ${id}`, unit: 'state',
          value: typeof output === 'boolean' ? Number(output) : null, stale: !available, observedAt: reported?.at }];
      })),
    });
  }
  return [...devices.values()];
}

/** Public observations also contain legacy room feeds and garage pump temperatures.
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
  const garageReadings = {};
  for (const [signal, label] of [['garage_native_indoor_temperature', 'Pump indoor'], ['garage_native_outdoor_temperature', 'Pump outdoor']]) {
    const reading = status.garage?.adapter?.telemetry?.[signal];
    if (!reading?.supported || represented.has(signal)) continue;
    const usable = reading.usable === true && Number.isFinite(reading.value);
    garageReadings[signal] = { ...reading, label, unit: 'degC', observedAt: reading.sourceTime,
      displayStatus: { usable, attention: !usable, detail: usable
        ? `Reported by the Mitsubishi heat pump${Number.isFinite(reading.sourceTime) ? ` · ${clock.format(reading.sourceTime)}` : ''}.`
        : 'The Mitsubishi temperature reading is unavailable or not qualified for use.' } };
  }
  append('garage-pump-temperatures', 'Mitsubishi temperatures', 'garage', 'Mitsubishi', garageReadings);
  return inventory;
}
const isState = (signal, reading) => reading.unit === 'state' || /_(active|open)$/.test(signal) || typeof reading.value === 'boolean';
const stateNumber = value => value === true || value === 'open' || value === 'on' ? 1
  : value === false || value === 'closed' || value === 'off' ? 0 : value;
function valueText(signal, reading, device) {
  const value = stateNumber(reading.value);
  if (isState(signal, reading) && device.kind === 'floor_override') return value === 1 ? 'Override on' : value === 0 ? 'Thermostat control' : 'Unknown';
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
    const motion = device.kind === 'door' && state && fresh && known && ['opening', 'closing'].includes(reading.coverState)
      ? reading.coverState : null;
    const observed = Number.isFinite(reading.observedAt) ? clock.format(reading.observedAt) : 'time unavailable';
    return { signal, label: device.kind === 'heat_pump' && /_active$/.test(signal) ? 'Power enabled'
      : `${reading.label ?? pretty(signal)}${reading.estimated ? ' (estimate)' : ''}`,
      value: motion ? motion[0].toUpperCase() + motion.slice(1) : fresh ? last : state ? 'Unknown' : 'Unavailable', stale: !fresh,
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
    actionKind = path.endsWith('/recheck') ? 'recheck' : path.endsWith('/switch') ? 'control' : path.endsWith('/cover') ? 'cover' : 'test';
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
          : actionKind === 'cover' ? device?.cover?.operation : null;
        const reported = reading && reading.observedAt > messageAt
          && (actionKind === 'control' || actionKind === 'cover' && ['open', 'closed'].includes(reading.coverState));
        const returned = latest && (latest.at ?? latest.requestedAt) >= messageAt;
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

/** A saved command receipt is temporary feedback; current readings and active
 * operations describe the device after that receipt is no longer relevant. */
export function equipmentControlResult(status, device) {
  const last = status.equipmentControls?.lastResult;
  if (last?.deviceId !== device.id || typeof last.on !== 'boolean') return '';
  const pending = last.status === 'pending' && status.equipmentControls?.busy;
  if (!pending) {
    if (!recentResult(last.at, status.now ?? Date.now())) return '';
    const reading = equipmentStateReading(device, status.now);
    if (reading && reading.observedAt > (last.confirmedAt ?? last.at)
      && (reading.value !== Number(last.on) || last.confirmed !== true)) return '';
  }
  return `${last.on ? 'On' : 'Off'} requested · ${last.confirmed === true ? 'device confirmed'
    : last.sent ? 'sent; awaiting device confirmation' : pretty(last.status ?? 'not sent')}${Number.isFinite(last.at) ? ` · ${clock.format(last.at)}` : ''}`;
}

export function equipmentCoverResult(device, now) {
  const operation = device.cover?.operation;
  if (!operation || !['open', 'close', 'stop'].includes(operation.action) || operation.status === 'observed') return '';
  if (operation.status !== 'publishing') {
    if (!recentResult(operation.requestedAt, now)) return '';
    const reading = equipmentStateReading(device, now);
    if (reading && reading.observedAt > operation.requestedAt && ['open', 'closed'].includes(reading.coverState)
      && (operation.action === 'stop' || ['failed', 'unconfirmed'].includes(operation.status))) return '';
  }
  const result = { publishing: 'sending…', published: 'sent; position unconfirmed', observed: 'state reported',
    failed: 'could not send; check the door', unconfirmed: 'no new position report' }[operation.status] ?? 'position unconfirmed';
  const detail = operation.action === 'stop' && operation.status === 'published' ? 'sent; stopping unconfirmed' : result;
  return `${pretty(operation.action).replace(/^./, letter => letter.toUpperCase())} requested · ${detail}`;
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
            : connected === true && (subscribed || Number.isFinite(lastMessageAt)) ? { label: 'Connected', state: 'available' }
              : { label: 'Awaiting subscription', state: 'pending' },
    recent: Number.isFinite(lastMessageAt) ? `Received ${clock.format(lastMessageAt)}`
      : subscribed ? 'Waiting for the first vehicle report' : 'No vehicle report yet',
    connectionDetail: `Vehicle data for charging. Used automatically when this vehicle is identified at a charger. ${detail}${usedBy ? ` Used by: ${usedBy}.` : ''}`,
    packetDetail: [invalidReason ? 'The latest vehicle report could not be used; previous accepted readings keep their original timestamps.' : '',
      Number.isFinite(lastLiveAt) ? `Latest live report: ${clock.format(lastLiveAt)}.`
        : Number.isFinite(lastRetainedAt) ? `Saved broker reading received ${clock.format(lastRetainedAt)}; no live vehicle report received yet.`
          : 'Connection status follows the MQTT subscription; vehicle charge readings keep their own timestamps.'].filter(Boolean).join(' '),
  };
}

/** Fold supplemental routes into their device once; unowned routes remain
 * separate connections with an explicit, evidence-based monitoring state. */
export function equipmentConnections(status = {}, devices = equipmentDevices(status), inventory = equipmentInventory(status)) {
  const rows = devices.map(device => ({ ...device,
    needsAttention: device.needsAttention || inventory.find(row => row.id === device.id)?.needsAttention,
    topics: device.topics?.length ? [...device.topics]
    : device.connection ? [{ role: 'Connection', topic: device.connection, direction: 'subscribe' }] : [] }));
  const owner = new Map(rows.flatMap(row => row.topics.map(topic => [topicKey(topic), row])));
  const groups = new Map();
  for (const group of [...(status.shelly?.topicGroups ?? []), ...(status.equipment?.topicGroups ?? [])]) {
    const prior = groups.get(group.id);
    groups.set(group.id, { ...group, topics: [...(prior?.topics ?? []), ...(group.topics ?? [])] });
  }
  const vehicleFeeds = status.charging?.vehicleFeeds ?? [];
  const vehicleFeedFor = group => vehicleFeeds.find(feed => feed.id === group.vehicleFeedId || group.id === `vehicle:${feed.id}`
    || feed.topic && group.topics.some(topic => topic.topic === feed.topic)
    || group.id === 'teslamate' && feed.provider === 'teslamate');
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
      : [{ area: group.id === 'garage-adapter' ? 'garage' : ['h66', 'dhwr', 'heating'].includes(group.id) ? 'home' : 'other', topics: remaining }];
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
        Object.assign(row, vehicleConnection({ label: feed.label, source, enabled: feed.enabled, reception: feed.reception, usedBy,
          detail: feed.provider === 'teslamate' ? 'A sleeping or idle vehicle can remain quiet while MQTT stays connected.'
            : 'Vehicle readings keep their original measurement timestamps. A quiet vehicle does not mean the MQTT connection is lost.' }));
      } else if (group.id === 'teslamate') {
        const provider = status.providers?.teslamate ?? {};
        const reception = provider.reception ?? status.charging?.chargers?.find(charger => charger.id === 'charger2')?.mqtt ?? {};
        Object.assign(row, vehicleConnection({ enabled: provider.enabled, source: 'TeslaMate', label: 'Tesla',
          reception: { ...reception, connected: reception.connected ?? provider.connected,
            lastMessageAt: reception.lastMessageAt ?? provider.lastMessageAt },
          detail: 'A sleeping or idle vehicle can remain quiet while MQTT stays connected.' }));
      } else if (typeof group.id === 'string' && group.id.endsWith('-vehicle')) {
        const id = group.id.slice(0, -'-vehicle'.length);
        const charger = status.charging?.chargers?.find(charger => charger.id === id);
        const reception = charger?.vehicleMqtt ?? charger?.mqtt ?? {};
        const bmw = reception.provider === 'bmw-cardata';
        Object.assign(row, vehicleConnection({ reception, label: bmw ? 'BMW' : 'Vehicle',
          source: bmw ? 'BMW CarData' : 'MQTT',
          detail: bmw ? 'BMW CarData supplies charge, charge target and usable battery capacity. MQTT reception is separate from each measurement’s original timestamp.'
            : 'Vehicle readings received over MQTT keep their original measurement timestamps. A quiet vehicle does not mean the MQTT connection is lost.' }));
      } else if (group.id === 'dhwr' || group.id === 'heating') {
        row.kind = 'control'; row.connectionState = { label: 'Commands configured', state: 'pending' };
        row.recent = 'Delivery is confirmed separately';
        row.connectionDetail = group.id === 'dhwr' ? 'Hot-water circulation uses this timed ON/OFF command route.'
          : 'Heating mode requests use this command route; a configured topic does not confirm device delivery.';
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
  const order = row => row.kind === 'floor_override' ? 6 : row.area !== 'home' ? 4 : row.source === 'H66' ? 0 : row.kind === 'temperature' ? 1
    : row.id === status.dhwr?.feedback?.deviceId || row.id === 'connection:dhwr:home' ? 2
      : row.controls?.tariff || row.controlsHeat || row.role === 'heat_savings' || row.id === 'connection:heating:home' ? 3 : 4;
  return rows.sort((a, b) => order(a) - order(b));
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
  return { state, power, summary, attention: dhwr.attention === true,
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

export function createEquipmentPanel({ document, request, onStatus, beforeRequest, onBusy = () => {}, blocked = () => false }) {
  const $ = id => document.getElementById(id), connectionNodes = new Map(), connectionGroups = new Map(), restoreNodes = new Map(), readingNodes = new Map();
  let current;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const button = (text, action) => {
    const node = make('button', text, 'secondary-button'); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const actions = createEquipmentActions({ request, onStatus, beforeRequest, onChange(snapshot) {
    current = snapshot; onBusy(snapshot.busy); render(snapshot);
  } });
  function renderReadingList(root, devices, snapshot) {
    const { status, busy, message, error, actionKind, actionDeviceId } = snapshot;
    for (const [index, device] of devices.entries()) {
      const staticReadings = device.kind === 'temperature' && !device.controls?.switch
        && !Object.values(device.controls?.cover ?? {}).some(Boolean);
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
        const help = make('p', '', 'muted'), result = make('p', '', 'equipment-control-result');
        result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite');
        buttons.append(on, off); controls.append(buttons, help, result);
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
        coverHelp.id = `equipment-cover-${device.id}-help`;
        coverResult.setAttribute('role', 'status'); coverResult.setAttribute('aria-live', 'polite');
        coverControls.append(coverButtons, coverHelp, coverResult);
        heading.append(title, metadata); health.append(source, recent);
        if (staticReadings) {
          summary.append(heading, health, list, empty); section.append(summary);
        } else {
          summary.append(heading, preview, health);
          body.append(list, empty, controls, coverControls); section.append(summary, body);
        }
        node = { section, staticReadings, title, metadata, preview, source, recent, list, empty, controls, buttons, on, off, help, result,
          coverControls, coverButtons, coverActions, coverHelp, coverResult, rows: new Map() }; readingNodes.set(device.id, node);
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
      for (const [index, row] of rows.entries()) {
        let cells = node.rows.get(row.signal);
        if (!cells) {
          const term = make('dt'), description = make('dd'), value = make('strong'), qualifier = make('small', '', 'equipment-reading-qualifier');
          description.append(value, qualifier); cells = { term, description, value, qualifier }; node.rows.set(row.signal, cells);
        }
        cells.term.textContent = row.label; cells.value.className = row.stale ? 'stale' : '';
        const relayNote = device.kind === 'heat_pump' && /_active$/.test(row.signal)
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
        : isReadOnlyReplica(status) ? 'Controls are available on the primary computer.'
          : busy || blocked() || status.equipmentControls?.busy ? 'Another request is in progress.'
            : !device.available ? 'A current switch report is needed to control this device.'
              : status.equipmentControls?.reason ?? 'Manual control is unavailable.';
      const last = status.equipmentControls?.lastResult;
      const scoped = actionKind === 'control' && actionDeviceId === device.id;
      let result = equipmentControlResult(status, device);
      const controlRequest = last?.deviceId === device.id ? `${last.at}:${last.on}` : null;
      if (!result && controlRequest) node.dismissedControlRequest = controlRequest;
      if (controlRequest && node.dismissedControlRequest === controlRequest) result = '';
      node.result.textContent = scoped && (busy || error) ? message : result;
      node.result.hidden = !node.result.textContent;
      node.result.classList.toggle('form-error', Boolean(scoped && error || last?.deviceId === device.id && last.confirmed !== true && ['failed', 'unconfirmed'].includes(last.status)));
      const hasCoverControls = device.kind === 'door' && ['open', 'close', 'stop'].some(action => device.controls?.cover?.[action] === true);
      node.coverControls.hidden = !hasCoverControls;
      node.coverButtons.setAttribute('aria-label', `${device.label ?? 'Door'} operation`);
      for (const [action, control] of Object.entries(node.coverActions)) {
        control.hidden = device.controls?.cover?.[action] !== true;
        control.disabled = !equipmentCoverAllowed(status, device, action, busy || blocked());
        control.setAttribute('aria-label', `${action[0].toUpperCase() + action.slice(1)} ${device.label ?? 'door'}`);
        control.setAttribute('aria-describedby', node.coverHelp.id);
      }
      const coverScoped = actionKind === 'cover' && actionDeviceId === device.id;
      node.coverHelp.textContent = isReadOnlyReplica(status) ? 'Controls are available on the primary computer.'
        : busy || blocked() ? 'Another request is in progress.'
          : !device.cover?.available ? 'Door control is unavailable. Check the connection.'
            : 'Open means the door is not fully closed.';
      let coverResult = equipmentCoverResult(device, status.now ?? Date.now());
      const operation = device.cover?.operation;
      const coverRequest = operation ? `${operation.requestedAt}:${operation.action}` : null;
      if (!coverResult && coverRequest) node.dismissedCoverRequest = coverRequest;
      if (coverRequest && node.dismissedCoverRequest === coverRequest) coverResult = '';
      node.coverResult.textContent = coverScoped && (busy || error) ? message : coverResult;
      node.coverResult.hidden = !node.coverResult.textContent;
      node.coverResult.classList.toggle('form-error', Boolean(coverScoped && error || ['failed', 'unconfirmed'].includes(device.cover?.operation?.status)));
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
    const devices = equipmentDevices(status), inventory = equipmentInventory(status), active = status.equipmentTests?.active;
    const connections = equipmentConnections(status, devices, inventory);
    const readOnly = isReadOnlyReplica(status), locked = busy || blocked();
    for (const area of ['home', 'garage']) {
      const members = inventory.filter(device => device.area === area);
      renderReadingList($(`${area}-equipment-readings`), members.filter(device => device.id !== status.dhwr?.feedback?.deviceId)
        .sort((a, b) => area === 'garage' ? Number(b.kind === 'temperature') - Number(a.kind === 'temperature') : 0), snapshot);
      if (!members.length && area === 'garage') $(`${area}-equipment-readings`).append(make('p', 'No garage devices enabled.', 'muted equipment-empty'));
      const overview = $(`${area}-equipment-status`), unavailable = members.filter(device => !device.available || device.needsAttention).length;
      if (overview) {
        overview.textContent = !members.length ? '' : unavailable ? `${unavailable} ${unavailable === 1 ? 'needs' : 'need'} attention`
          : `${members.length} available`;
        overview.dataset.state = unavailable ? 'attention' : members.length ? 'available' : 'pending';
      }
      const activeNode = $(`${area}-active-test`), activeDevice = devices.find(device => device.id === active?.deviceId);
      activeNode.hidden = !active || (activeDevice?.area ?? 'garage') !== area;
      if (!activeNode.hidden) activeNode.textContent = `${activeDevice?.label ?? 'Device'} · ${pretty(active.status ?? 'temporary override')}`;
      $(`${area}-test-notice`).hidden = activeNode.hidden;
      let restore = restoreNodes.get(area);
      if (!restore) {
        restore = button('Restore previous state', () => { if (!blocked()) void actions.restore(); });
        restore.classList.add('equipment-restore'); restoreNodes.set(area, restore); $(`${area}-test-notice`).append(restore);
      }
      restore.hidden = activeNode.hidden; restore.disabled = activeNode.hidden || readOnly || locked;
      const result = $(`${area}-equipment-result`);
      const actionArea = devices.find(device => device.id === snapshot.actionDeviceId)?.area ?? 'garage';
      result.textContent = actionKind === 'test' && actionArea === area ? message : '';
      result.hidden = !result.textContent; result.classList.toggle('form-error', error);
    }
    const connectionRoot = $('equipment-connections');
    let groupIndex = 0;
    for (const [area, label] of [['home', 'Home'], ['garage', 'Garage'], ['other', 'Other']]) {
      const members = connections.filter(device => (['home', 'garage'].includes(device.area) ? device.area : 'other') === area);
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
        const checked = make('small', '', 'muted'), detail = make('p', '', 'muted equipment-check-detail');
        const topics = make('div', '', 'equipment-topic-groups'), diagnostics = make('details', '', 'equipment-packet-details');
        const packets = make('p', '', 'muted equipment-packet-status');
        diagnostics.append(make('summary', 'Packet diagnostics'), packets);
        check.append(detail, checked); body.append(check, topics, diagnostics); row.append(summary, body);
        node = { row, name, metadata, state, recent, checked, detail, topics, diagnostics, packets }; connectionNodes.set(device.id, node);
      }
      if (group.list.children[index] !== node.row) group.list.insertBefore(node.row, group.list.children[index] ?? null);
      node.name.textContent = device.label ?? labels[device.kind] ?? 'MQTT connection';
      node.metadata.textContent = [labels[device.kind] ?? pretty(device.kind || 'connection'), equipmentSource(device)].join(' · ');
      renderTopics(node.topics, device.topics); node.topics.hidden = !device.topics.length;
      const mqtt = device.mqttStatus;
      node.packets.textContent = [mqtt?.subscriptionStatus ? `Subscription: ${pretty(mqtt.subscriptionStatus)}` : '',
        Number.isFinite(mqtt?.lastLiveAt) ? `Last live packet: ${clock.format(mqtt.lastLiveAt)}` : mqtt ? 'No live packet received' : '',
        Number.isFinite(mqtt?.lastRetainedAt) ? `Saved broker packet: ${clock.format(mqtt.lastRetainedAt)}` : '',
        device.packetDetail ?? '', device.recheck?.description ?? ''].filter(Boolean).join(' · ');
      node.diagnostics.hidden = !node.packets.textContent;
      const summary = equipmentConnectionSummary(device);
      node.state.textContent = summary.label; node.state.dataset.state = summary.state; node.recent.textContent = summary.recent;
      node.detail.textContent = device.connectionDetail ?? (Number.isFinite(device.check?.checkedAt) ? equipmentCheckText(device)
        : device.enabled === false ? 'Disabled in configuration.' : device.available && !device.needsAttention
          ? 'Device reports are available.' : 'Waiting for a usable device report.');
      node.checked.textContent = Number.isFinite(device.check?.checkedAt) ? `Checked ${clock.format(device.check.checkedAt)}` : '';
      node.checked.hidden = !node.checked.textContent;
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
  return { update: status => actions.update(status), refreshControls: () => current && render(current), actions };
}
