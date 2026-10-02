// Generate a Bluetooth-capable Shelly Gen2/Gen3 script. Addresses belong in the installed
// script/private configuration, never in a committed household example.
export function bluHtEquipment({ id = 'blu_ht', label = 'Caravan air', area = 'garage', prefix = 'stmq/garage/caravan_air',
  temperatureSignal = id === 'blu_ht' ? 'caravan_temperature' : `${id}_temperature`,
  humiditySignal = id === 'blu_ht' ? 'caravan_humidity' : `${id}_humidity` } = {}) {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(id) || !['home', 'garage'].includes(area)
    || typeof label !== 'string' || !label.trim() || label.length > 120) throw new Error('Invalid BLU sensor identity');
  validatePrefix(prefix);
  if (![temperatureSignal, humiditySignal].every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value))
    || temperatureSignal === humiditySignal) throw new Error('Invalid BLU sensor signals');
  return { id, label, area, kind: 'temperature', manufacturer: 'Shelly', signal: temperatureSignal, connection: `mqtt:${prefix}/state`,
    max_age_seconds: 180,
    mqtt: { state_path: 'temperature', timestamp_path: 'timestamp', request_topic: `${prefix}/get`, request_payload: 'status' },
    readings: [
      { key: 'humidity', signal: humiditySignal, label: 'Relative humidity', unit: '%', path: 'humidity', required: true },
      { key: 'battery', label: 'Battery', unit: '%', path: 'battery', record: false },
      { key: 'rssi', label: 'Bluetooth signal', unit: 'dBm', path: 'rssi', record: false },
    ] };
}
function validatePrefix(prefix) {
  if (typeof prefix !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(prefix) || prefix.length > 200)
    throw new Error('BLU MQTT prefix must be an exact topic prefix');
}
export function bluHtScript({ address, prefix = 'stmq/garage/caravan_air' }) {
  if (typeof address !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(address)) throw new Error('Invalid Bluetooth address');
  validatePrefix(prefix);
  // Stay within the Gen2 scripting subset: let declarations and braced else
  // branches also work on Plus Plug S firmware 0.13.0.
  return `// ST-MQ BLU H&T bridge: passive broadcasts, no relay operations.
// Polling returns the last received report with its ORIGINAL timestamp.
let SENSOR = ${JSON.stringify(address.toLowerCase())};
let PREFIX = ${JSON.stringify(prefix)};
let latest = null;
let previousData = null;
let previousUptime = -100;
let stats = {reports:0, published:0, requests:0};
function decode(data) {
  if (typeof data !== "string" || data.length < 2 || data.length > 64) return null;
  let flags = data.charCodeAt(0);
  if ((flags >> 5) !== 2 || (flags & 1)) return null;
  let sample = {};
  let i = 1;
  while (i < data.length) {
    let id = data.charCodeAt(i++);
    let size = 0;
    if (id === 0 || id === 1 || id === 46 || id === 58) { size = 1; }
    else if (id === 2 || id === 3 || id === 69 || id === 240) { size = 2; }
    else if (id === 241) { size = 4; }
    else if (id === 242) { size = 3; }
    else { return null; }
    if (i + size > data.length) return null;
    let v = data.charCodeAt(i);
    if (size === 2) v += data.charCodeAt(i + 1) * 256;
    if (id === 2 || id === 69) {
      if (v > 32767) v -= 65536;
      sample.temperature = v / (id === 2 ? 100 : 10);
    } else if (id === 3 || id === 46) { sample.humidity = v / (id === 3 ? 100 : 1); }
    else if (id === 1) { sample.battery = v; }
    i += size;
  }
  if (typeof sample.temperature !== "number" || typeof sample.humidity !== "number"
      || sample.temperature < -60 || sample.temperature > 150
      || sample.humidity < 0 || sample.humidity > 100
      || (typeof sample.battery === "number" && sample.battery > 100)) return null;
  return sample;
}
function publishLatest() {
  if (latest !== null && MQTT.isConnected()) {
    if (MQTT.publish(PREFIX + "/state", JSON.stringify(latest), 1, false)) stats.published++;
  }
}
function receive(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT || !result || result.addr !== SENSOR || !result.service_data) return;
  let data = result.service_data["fcd2"];
  let sample = decode(data);
  if (sample === null) return;
  let sys = Shelly.getComponentStatus("sys");
  if (!sys || typeof sys.unixtime !== "number" || sys.unixtime < 1700000000) return;
  // Suppress repeated advertising packets in one burst, but preserve each
  // minute's genuine report even when all measured values are unchanged.
  if (data === previousData && sys.uptime - previousUptime < 10) return;
  previousData = data;
  previousUptime = sys.uptime;
  sample.timestamp = sys.unixtime * 1000;
  sample.time_basis = "blu-received";
  sample.rssi = result.rssi;
  latest = sample;
  stats.reports++;
  publishLatest();
}
MQTT.subscribe(PREFIX + "/get", function(topic, message) {
  if (message === "status") { stats.requests++; publishLatest(); }
});
BLE.Scanner.Subscribe(receive);
if (!BLE.Scanner.Start({duration_ms:BLE.Scanner.INFINITE_SCAN, active:false})) {
  print("BLU scanner could not start");
  Shelly.call("Script.Stop", {id:Shelly.getCurrentScriptId()});
}
`;
}
