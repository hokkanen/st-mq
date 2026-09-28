import { createHash } from 'node:crypto';

const KINDS = ['temperature', 'switch', 'metered_switch', 'door', 'power', 'dehumidifier'];
const DEVICE_KEYS = ['id', 'label', 'area', 'kind', 'connection', 'enabled', 'signal', 'generation', 'switch_id', 'temperature_id',
  'switch_control', 'cover_control', 'dehumidifier_control', 'temperature_control', 'manufacturer', 'tariff_control', 'reduction_on', 'max_age_seconds', 'record', 'readings', 'mqtt'];
const MQTT_KEYS = ['command_topic', 'on_payload', 'off_payload', 'state_path', 'timestamp_path', 'availability_topic', 'bridge_availability_topic',
  'online_payload', 'offline_payload', 'heartbeat_topic', 'heartbeat_seconds', 'request_topic', 'request_payload',
  'open_payload', 'close_payload', 'stop_payload', 'cover_state_path'];
const READING_KEYS = ['key', 'label', 'signal', 'unit', 'path', 'topic', 'component', 'required', 'record', 'scale', 'offset'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const schema = (value, keys, context) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${context} fields`);
};
const text = (value, fallback, length = 120) => {
  value ??= fallback;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > length || /[\u0000-\u001f]/.test(value))
    throw new Error('Equipment text must be a nonempty printable string');
  return value;
};
const bool = (value, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('Equipment boolean setting must be true or false');
  return value;
};
const number = (value, fallback, min, max, integer = false) => {
  value ??= fallback;
  if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error('Equipment numeric setting is outside supported bounds');
  return value;
};
const signal = (value, fallback) => {
  value = text(value, fallback, 100);
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Equipment signals must use lowercase letters, numbers and underscores');
  return value;
};
export function exactEquipmentTopic(value, optional = false) {
  if (optional && (value == null || value === '')) return null;
  value = text(value, undefined, 300);
  if (/[+#\u0000]/.test(value)) throw new Error('Equipment MQTT topics must be exact, without wildcards');
  return value;
}
const path = value => {
  if (value == null || value === '') return null;
  value = text(value, undefined, 200);
  if (!value.split('.').every(part => /^[a-zA-Z0-9_:-]+$/.test(part) && !['__proto__', 'prototype', 'constructor'].includes(part)))
    throw new Error('Equipment JSON paths must use safe dotted property names');
  return value;
};
function reading(input, id) {
  schema(input, READING_KEYS, 'equipment reading');
  const key = signal(input.key, undefined), component = input.component || null;
  if (component !== null && (typeof component !== 'string' || !/^(temperature|switch|input|humidity|voltmeter|pm1):\d{1,3}$/.test(component)))
    throw new Error('Equipment component mapping must specify a supported native component and numeric ID');
  return { key, signal: signal(input.signal, `${id}_${key}`), label: text(input.label, key.replaceAll('_', ' ')),
    unit: text(input.unit, key.startsWith('temperature') ? 'degC' : 'state', 30), path: path(input.path),
    topic: exactEquipmentTopic(input.topic, true), component,
    required: bool(input.required, false), record: bool(input.record, true),
    scale: number(input.scale, 1, -1e6, 1e6), offset: number(input.offset, 0, -1e6, 1e6) };
}

export function equipmentSignature(device) {
  if (!device) return null;
  return createHash('sha256').update(JSON.stringify({ protocol: device.protocol, connection: device.connection,
    generation: device.generation, switchId: device.switchId, controlsSwitch: device.controlsSwitch,
    controlsHeat: device.controlsHeat, ...(device.controlsCover ? { controlsCover: true } : {}),
    ...(device.controlsDehumidifier ? { controlsDehumidifier: true } : {}), reductionOn: device.reductionOn, stateSignal: device.stateSignal,
    mqtt: device.protocol === 'mqtt' ? Object.fromEntries(Object.entries(device.mqtt).filter(([key, value]) =>
      !['openPayload', 'closePayload', 'stopPayload', 'coverStatePath'].includes(key) || value !== null)) : null,
    stateMapping: (device.readings ?? []).filter(row => row.signal === device.stateSignal).map(({ label, record, ...row }) => row) })).digest('hex');
}

export function equipmentMeterIdentity(device, { brokerIdentity = null, nativeIdentity = null } = {}) {
  return createHash('sha256').update(JSON.stringify({ version: 1, brokerIdentity, nativeIdentity,
    protocol: device.protocol, connection: device.connection, generation: device.generation,
    switchId: device.switchId, timestampPath: device.mqtt?.timestampPath ?? null,
    counter: (device.readings ?? []).filter(row => row.key === 'energy_counter')
      .map(({ topic, component, path, unit, scale, offset }) => ({ topic, component, path, unit, scale, offset })) })).digest('hex');
}

/** Connection syntax selects the protocol. No host/topic inspection or failed
 * protocol probes can silently select a different source. */
export function equipmentConfiguration(input = {}) {
  schema(input, ['poll_seconds', 'max_age_seconds', 'devices'], 'equipment configuration');
  const pollIntervalMs = Math.round(number(input.poll_seconds, 30, 5, 300) * 1000);
  const maxAgeMs = Math.round(number(input.max_age_seconds, 120, 30, 3600) * 1000);
  if (maxAgeMs < 2 * pollIntervalMs) throw new Error('Equipment maximum age must allow at least two polls');
  if (input.devices != null && !Array.isArray(input.devices) || input.devices?.length > 100) throw new Error('Equipment devices must be an array of at most 100 entries');
  const devices = (input.devices ?? []).map(row => {
    schema(row, DEVICE_KEYS, 'equipment device');
    const id = signal(row.id, undefined), label = text(row.label, id.replaceAll('_', ' '));
    const area = row.area ?? 'home', kind = row.kind ?? 'switch', enabled = bool(row.enabled, true);
    if (!['home', 'garage'].includes(area) || !KINDS.includes(kind)) throw new Error('Invalid equipment area or kind');
    const connection = text(row.connection, undefined, 310), separator = connection.indexOf(':');
    const protocol = connection.slice(0, separator), address = exactEquipmentTopic(connection.slice(separator + 1));
    if (!['shelly', 'mqtt'].includes(protocol) || separator < 1) throw new Error('Equipment connection must start with shelly: or mqtt:');
    if (protocol === 'shelly' && (address.startsWith('/') || address.endsWith('/') || /[\s%?]/.test(address))) throw new Error('Shelly connection must contain its exact native topic prefix');
    const generation = number(row.generation, 2, 1, 4, true), switchId = number(row.switch_id, 0, 0, 255, true);
    const temperatureId = number(row.temperature_id, generation === 1 ? 0 : 100, 0, 255, true);
    const controlsSwitch = bool(row.switch_control, false), controlsHeat = bool(row.tariff_control, false);
    const controlsCover = bool(row.cover_control, false);
    const controlsDehumidifier = bool(row.dehumidifier_control, false);
    const manufacturer = row.manufacturer === undefined ? null : text(row.manufacturer, undefined, 60);
    let temperatureControl = null;
    if (row.temperature_control !== undefined) {
      schema(row.temperature_control, ['sensor_device_id'], 'dehumidifier temperature control');
      if (kind !== 'dehumidifier' || !controlsDehumidifier) throw new Error('Temperature control requires a controllable dehumidifier');
      temperatureControl = { sensorDeviceId: signal(row.temperature_control.sensor_device_id) };
    }
    if (controlsCover && (kind !== 'door' || protocol !== 'mqtt')) throw new Error('Cover control requires MQTT door equipment');
    if (kind === 'dehumidifier' && protocol !== 'mqtt' || controlsDehumidifier && kind !== 'dehumidifier')
      throw new Error('Dehumidifier control requires MQTT dehumidifier equipment');
    if ((controlsSwitch || controlsHeat) && !['switch', 'metered_switch'].includes(kind)) throw new Error('Only configured switch equipment can accept control');
    // DHWR commands belong to the executor's durable timed ON/OFF path. Its
    // equipment entry supplies independent device feedback, never another writer.
    if (kind === 'power' && protocol !== 'mqtt') throw new Error('Power-only equipment requires an MQTT measurement topic');
    if (id === 'dhwr' && (protocol !== 'mqtt' || !['switch', 'power'].includes(kind) || controlsSwitch || controlsHeat
      || row.signal && row.signal !== (kind === 'power' ? 'dhwr_power' : 'dhwr_active')))
      throw new Error('DHWR feedback requires monitoring-only MQTT power or switch feedback with its DHWR signal');
    const record = bool(row.record, id !== 'dhwr');
    if (!record && (protocol !== 'mqtt' || !['switch', 'power'].includes(kind)))
      throw new Error('Live-only equipment recording requires an MQTT switch or power sensor');
    if (id === 'dhwr' && record) throw new Error('DHWR raw telemetry must stay live-only; derived circulation feedback changes and availability are recorded separately');
    const reductionOn = bool(row.reduction_on, true), age = Math.round(number(row.max_age_seconds, ['door', 'power'].includes(kind) ? 0 : maxAgeMs / 1000, 0, 86400) * 1000);
    if (!(kind === 'door' || kind === 'power' && age === 0) && age < pollIntervalMs) throw new Error('Equipment maximum age must allow its poll interval');
    schema(row.mqtt ?? {}, MQTT_KEYS, 'equipment MQTT mapping');
    const mapping = row.mqtt ?? {};
    const mqtt = { statePath: path(mapping.state_path), timestampPath: path(mapping.timestamp_path),
      commandTopic: exactEquipmentTopic(mapping.command_topic, true), onPayload: mapping.on_payload ?? null, offPayload: mapping.off_payload ?? null,
      openPayload: mapping.open_payload ?? null, closePayload: mapping.close_payload ?? null, stopPayload: mapping.stop_payload ?? null,
      coverStatePath: path(mapping.cover_state_path),
      availabilityTopic: exactEquipmentTopic(mapping.availability_topic, true), onlinePayload: mapping.online_payload ?? 'online', offlinePayload: mapping.offline_payload ?? 'offline',
      bridgeAvailabilityTopic: exactEquipmentTopic(mapping.bridge_availability_topic, true),
      heartbeatTopic: exactEquipmentTopic(mapping.heartbeat_topic, true), heartbeatMs: Math.round(number(mapping.heartbeat_seconds, 0, 0, 86400) * 1000),
      requestTopic: exactEquipmentTopic(mapping.request_topic, true), requestPayload: mapping.request_payload ?? null };
    for (const value of [mqtt.onPayload, mqtt.offPayload, mqtt.openPayload, mqtt.closePayload, mqtt.stopPayload, mqtt.requestPayload, mqtt.onlinePayload, mqtt.offlinePayload])
      if (value !== null && (typeof value !== 'string' || value.length > 4096 || value.includes('\u0000'))) throw new Error('Equipment MQTT payload mappings must be bounded strings');
    if (mqtt.heartbeatTopic && !mqtt.heartbeatMs) throw new Error('An equipment heartbeat requires a positive heartbeat interval');
    if (mqtt.requestTopic && mqtt.requestPayload === null) throw new Error('A read-only request requires an explicit payload');
    if (mqtt.requestTopic && mqtt.requestTopic === mqtt.commandTopic) throw new Error('Read-only requests must use a separate topic from switch commands');
    if (protocol === 'mqtt' && (controlsSwitch || controlsHeat) && (!mqtt.commandTopic || !nonempty(mqtt.onPayload) || !nonempty(mqtt.offPayload) || mqtt.onPayload === mqtt.offPayload))
      throw new Error('Controllable MQTT equipment needs explicit command topic and distinct ON/OFF payloads');
    const coverPayloads = [mqtt.openPayload, mqtt.closePayload, ...(mqtt.stopPayload === null ? [] : [mqtt.stopPayload])];
    if (controlsCover && (!mqtt.commandTopic || coverPayloads.some(value => !nonempty(value)) || new Set(coverPayloads).size !== coverPayloads.length))
      throw new Error('Controllable MQTT doors need an explicit command topic and distinct open/close and optional stop payloads');
    if (kind === 'dehumidifier' && (!mqtt.timestampPath || !mqtt.availabilityTopic || controlsDehumidifier && !mqtt.commandTopic))
      throw new Error('MQTT dehumidifiers need timestamp and availability mappings, and an explicit topic for control');
    if (!Array.isArray(row.readings ?? []) || row.readings?.length > 32) throw new Error('Equipment readings must be an array of at most 32 mappings');
    const readings = (row.readings ?? []).map(value => reading(value, id));
    if (kind === 'dehumidifier' && readings.length)
      throw new Error('Dehumidifiers record one Off/Low/Medium/High state; other settings remain live-only');
    if (kind === 'dehumidifier' && row.signal != null && row.signal !== `${id}_state`)
      throw new Error('Dehumidifier history must use its current <device_id>_state signal');
    if (readings.some(value => !value.record && (protocol !== 'mqtt' || value.key === 'energy_counter')))
      throw new Error('Live-only reading mappings require MQTT and cannot disable cumulative energy accounting');
    if (protocol === 'mqtt' && readings.some(value => value.component) || protocol === 'shelly' && readings.some(value => value.topic || !value.component))
      throw new Error('Equipment mapping must match its selected connection protocol');
    const mainSignal = signal(row.signal || undefined, kind === 'temperature' ? id === 'garage' ? 'garage_temperature' : `${id}_temperature`
      : kind === 'dehumidifier' ? `${id}_state` : kind === 'power' ? `${id}_power` : kind === 'door' ? `${id}_open` : id === 'garage' ? 'garage_relay_active' : `${id}_active`);
    const stateSignal = ['temperature', 'power'].includes(kind) ? null : mainSignal;
    const powerSignal = kind === 'power' ? mainSignal : null;
    const temperatureSignal = kind === 'power' ? null : kind === 'temperature' ? mainSignal : id === 'garage' ? 'garage_temperature' : `${id}_temperature`;
    const hasTemperature = kind === 'temperature' || id === 'garage';
    const metered = kind === 'metered_switch';
    if (hasTemperature && (!record || readings.some(value => value.signal === temperatureSignal && !value.record)))
      throw new Error('Main temperature readings must preserve recorded history');
    if (readings.some(value => ['garage_temperature', 'garage_temperature_2'].includes(value.signal) && !value.record))
      throw new Error('Garage protection readings must preserve recorded history');
    if (id === 'dhwr' && readings.some(value => value.signal === 'dhwr_power' && !['W', 'kW'].includes(value.unit)))
      throw new Error('DHWR power feedback must declare W or kW units');
    const counters = readings.filter(mapping => mapping.key === 'energy_counter');
    if (counters.length > 1 || counters.some(mapping => !metered || !['kWh', 'Wh'].includes(mapping.unit)))
      throw new Error('Energy counter mapping requires metered equipment and kWh or Wh units');
    if (protocol === 'mqtt') {
      const readTopics = [address, ...readings.map(value => value.topic).filter(Boolean)];
      if (mqtt.requestTopic && [...readTopics, mqtt.availabilityTopic, mqtt.heartbeatTopic].includes(mqtt.requestTopic))
        throw new Error('Read-only requests must use a separate topic from readings, availability and heartbeat');
      if (mqtt.commandTopic && readTopics.includes(mqtt.commandTopic)) throw new Error('Switch commands require a separate topic from state confirmation');
      if (mqtt.commandTopic && [mqtt.availabilityTopic, mqtt.heartbeatTopic, mqtt.requestTopic].includes(mqtt.commandTopic))
        throw new Error('Device commands must use a separate topic from availability and heartbeat');
      if ([mqtt.availabilityTopic, mqtt.bridgeAvailabilityTopic, mqtt.heartbeatTopic].some(topic => topic && readTopics.includes(topic))) throw new Error('Availability and heartbeat must use separate topics from equipment readings');
      if (mqtt.bridgeAvailabilityTopic && [mqtt.availabilityTopic, mqtt.heartbeatTopic, mqtt.commandTopic, mqtt.requestTopic].includes(mqtt.bridgeAvailabilityTopic))
        throw new Error('Bridge availability must use a separate topic from device availability, heartbeat and commands');
    }
    const defaultSignals = [...(powerSignal ? [powerSignal] : []), ...(stateSignal ? [stateSignal] : []), ...(hasTemperature ? [temperatureSignal] : []),
      ...(metered ? [`${id}_power`, `${id}_current`, `${id}_energy`] : [])];
    if (new Set(readings.map(value => value.signal)).size !== readings.length) throw new Error('Equipment reading signals must be distinct');
    for (const mapping of readings) if (defaultSignals.includes(mapping.signal)) {
      if (protocol === 'shelly') throw new Error('Native built-in readings use their explicit switch/temperature component IDs');
      const expected = mapping.signal === powerSignal ? 'W' : mapping.signal === stateSignal ? 'state' : mapping.signal === temperatureSignal ? 'degC'
        : mapping.signal.endsWith('_power') ? 'kW' : mapping.signal.endsWith('_current') ? 'A' : 'kWh';
      if (mapping.unit !== expected || mapping.signal.endsWith('_energy')) throw new Error('Equipment built-in reading mapping must preserve its unit and energy counter semantics');
      mapping.required = true;
    }
    const ownedSignals = [...new Set([...defaultSignals, ...readings.map(value => value.signal)])];
    return { id, role: id, label, area, kind, enabled, connection, protocol, manufacturer,
      source: manufacturer ?? (protocol === 'shelly' ? 'Shelly' : 'MQTT'), temperatureControl,
      prefix: protocol === 'shelly' ? address : null, topic: protocol === 'mqtt' ? address : null,
      generation, switchId, temperatureId, controlsSwitch, controlsHeat, controlsCover, controlsDehumidifier, reductionOn, maxAgeMs: age, record,
      stateSignal, powerSignal, temperatureSignal, hasTemperature, metered, readings, mqtt, ownedSignals };
  });
  if (new Set(devices.map(row => row.id)).size !== devices.length) throw new Error('Equipment IDs must be unique');
  const enabled = devices.filter(row => row.enabled), ownedSignals = enabled.flatMap(row => row.ownedSignals);
  for (const device of enabled.filter(row => row.temperatureControl)) {
    const sensor = enabled.find(row => row.id === device.temperatureControl.sensorDeviceId);
    if (!sensor || sensor.protocol !== 'mqtt' || sensor.kind !== 'temperature' || sensor.area !== device.area
      || !sensor.ownedSignals.includes('caravan_temperature') || !sensor.ownedSignals.includes('caravan_humidity'))
      throw new Error('Temperature control requires the enabled caravan air temperature and humidity sensor in the same area');
  }
  if (new Set(ownedSignals).size !== ownedSignals.length) throw new Error('Enabled equipment cannot own the same recorded signal');
  for (const [index, device] of enabled.entries()) for (const other of enabled.slice(index + 1)) {
    if (device.protocol === 'shelly' && other.protocol === 'shelly'
      && (device.prefix === other.prefix || device.prefix.startsWith(`${other.prefix}/`) || other.prefix.startsWith(`${device.prefix}/`)))
      throw new Error('Native equipment prefixes must be distinct and non-overlapping');
    const topics = row => row.protocol === 'mqtt' ? [row.topic, ...row.readings.map(value => value.topic).filter(Boolean)] : [];
    if (topics(device).some(topic => topics(other).includes(topic))) throw new Error('Enabled MQTT equipment cannot share a state topic');
    if ([device, other].some((row, i) => row.mqtt.requestTopic && [...topics([device, other][1 - i]),
      [device, other][1 - i].mqtt.availabilityTopic, [device, other][1 - i].mqtt.bridgeAvailabilityTopic,
      [device, other][1 - i].mqtt.heartbeatTopic].includes(row.mqtt.requestTopic)))
      throw new Error('Read-only query topics must be separate from other equipment readings and availability');
    if ([device, other].some((row, i) => row.mqtt.commandTopic
      && [...topics([device, other][1 - i]), [device, other][1 - i].mqtt.commandTopic,
        [device, other][1 - i].mqtt.requestTopic, [device, other][1 - i].mqtt.availabilityTopic,
        [device, other][1 - i].mqtt.bridgeAvailabilityTopic, [device, other][1 - i].mqtt.heartbeatTopic].includes(row.mqtt.commandTopic)))
      throw new Error('Device command topics must be dedicated to one configured device');
    if ([device, other].some((native, i) => native.protocol === 'shelly' && [...topics([device, other][1 - i]), [device, other][1 - i].mqtt.availabilityTopic, [device, other][1 - i].mqtt.bridgeAvailabilityTopic, [device, other][1 - i].mqtt.heartbeatTopic, [device, other][1 - i].mqtt.commandTopic, [device, other][1 - i].mqtt.requestTopic].filter(Boolean).some(topic => topic === native.prefix || topic.startsWith(`${native.prefix}/`))))
      throw new Error('MQTT equipment topics cannot overlap a native equipment prefix');
  }
  return { configured: devices.length > 0, devices, pollIntervalMs, maxAgeMs,
    ownsGarage: enabled.some(row => row.ownedSignals.includes('garage_temperature')), ownedSignals };
}
