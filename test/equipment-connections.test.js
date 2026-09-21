import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentConnections, equipmentConnectionSummary, equipmentSource, equipmentTopicGroups } from '../chart/equipment.js';
import { dashboardProviders } from '../chart/provider-status.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const topic = (role, value, direction = 'subscribe') => ({ role, topic: value, direction });
const circulation = { id: 'fixture-circulation', label: 'Hot-water circulation', area: 'home', source: 'MQTT',
  kind: 'switch', available: true, topics: [topic('State', 'fixture/circulation/state')], readings: {} };

test('home connections show pump, temperatures in configured order, circulation and tariff while preserving MQTT routes', () => {
  const temperatures = ['Upstairs', 'Downstairs', 'Bedroom'].map(label => ({ id: `fixture-${label.toLowerCase()}`,
    label, area: 'home', kind: 'temperature', source: 'MQTT',
    topics: [topic(label, `fixture/${label.toLowerCase()}`)], readings: {} }));
  const groups = [{ id: 'dhwr', label: 'Circulation commands', topics: [topic('Timed ON/OFF command', 'fixture/circulation/set', 'publish')] },
    { id: 'h66', label: 'Heat pump · H66', topics: [topic('Telemetry subscription', 'fixture/h66/HP/#'),
      topic('Status request', 'fixture/h66/HP/CMD', 'publish'), topic('Setting 0203', 'fixture/h66/HP/SET/0203', 'publish')] }];
  const rows = equipmentConnections({ now: NOW, equipment: { devices: [{ id: 'fixture-tariff', area: 'home', controls: { tariff: true },
    topics: [topic('State', 'fixture/tariff/state')] }, circulation, ...temperatures], topicGroups: groups },
    shelly: { topicGroups: groups }, dhwr: { feedback: { deviceId: circulation.id }, commandTopic: 'fixture/circulation/set' },
    h66: { available: true, brokerConnected: true, lastPublicationAt: NOW } });
  assert.deepEqual(rows.map(row => row.id), ['connection:h66:home', ...temperatures.map(device => device.id), circulation.id, 'fixture-tariff', 'floor-override:living', 'floor-override:storage']);
  const device = rows.find(row => row.id === circulation.id);
  const deviceTopics = equipmentTopicGroups(device.topics).flatMap(group => group.topics);
  assert.deepEqual(deviceTopics.map(row => row.topic), ['fixture/circulation/state', 'fixture/circulation/set']);
  const native = rows.find(row => row.source === 'H66');
  assert.equal(native.area, 'home');
  assert.deepEqual(equipmentTopicGroups(native.topics).map(group => [group.label, group.topics.map(row => row.topic)]), [
    ['Incoming', ['fixture/h66/HP/#']], ['Status requests', ['fixture/h66/HP/CMD']], ['Commands', ['fixture/h66/HP/SET/0203']],
  ]);
  assert.equal(equipmentConnectionSummary(native).state, 'available');
});

test('shared groups do not repeat owned feeds and separate Home and Garage legacy probes', () => {
  const own = { ...circulation, id: 'fixture-temperature', kind: 'temperature',
    topics: [topic('Upstairs', 'fixture/upstairs')], readings: {} };
  const rows = equipmentConnections({ now: NOW, equipment: { devices: [own], topicGroups: [{ id: 'temperatures', label: 'Temperature feeds', topics: [
    { ...topic('Upstairs', 'fixture/upstairs'), signal: 'indoor_temperature' },
    { ...topic('Bedroom', 'fixture/bedroom'), signal: 'bedroom_temperature' },
    { ...topic('Garage front', 'fixture/garage-front'), signal: 'garage_temperature_2' },
  ] }] } });
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(row => [row.area, equipmentTopicGroups(row.topics).flatMap(group => group.topics.map(row => row.topic))]), [
    ['home', ['fixture/upstairs']], ['home', ['fixture/bedroom']], ['garage', ['fixture/garage-front']], ['home', []], ['home', []],
  ]);
});

test('connection health distinguishes quiet healthy devices, retained values and configuration-only command routes', () => {
  const quiet = { ...circulation, kind: 'door', mqttStatus: { lastLiveAt: NOW - 7 * 86_400_000 } };
  assert.equal(equipmentConnectionSummary(quiet).label, 'Available', 'the browser must not invent a door timeout');
  assert.equal(equipmentConnectionSummary({ ...quiet, needsAttention: true }).state, 'attention');
  const retained = { ...quiet, available: false, check: { status: 'retained-only' }, mqttStatus: { lastRetainedAt: NOW } };
  assert.equal(equipmentConnectionSummary(retained).label, 'Live state unconfirmed');
  assert.equal(equipmentConnectionSummary(retained).state, 'attention');
  const commands = equipmentConnections({ now: NOW, dhwr: { commandTopic: 'fixture/circulation/set' } });
  assert.equal(commands.length, 3);
  assert.equal(equipmentConnectionSummary(commands[0]).label, 'Commands configured');
  assert.equal(equipmentConnectionSummary(commands[0]).state, 'pending');
});

test('topic groups keep shared RPC requests and commands honest and deduplicate repeated topic labels', () => {
  const groups = equipmentTopicGroups([
    topic('RPC replies', 'fixture/replies/rpc'),
    topic('RPC requests', 'fixture/device/rpc', 'publish'),
    topic('RPC requests', 'fixture/device/rpc', 'publish'),
    topic('Status request', 'fixture/shared/request', 'publish'),
    topic('Switch command', 'fixture/shared/request', 'publish'),
  ]);
  assert.deepEqual(groups.map(group => group.label), ['Incoming', 'Requests & commands']);
  assert.equal(groups[1].topics.length, 2);
  assert.equal(groups[1].topics[0].role, 'RPC requests');
  assert.match(groups[1].topics[1].role, /Status request.*Switch command/);
});

test('checks remain historical diagnostics while the summary prefers newer live reports', () => {
  const device = { ...circulation, mqttStatus: { lastLiveAt: NOW }, check: { checkedAt: NOW - 60_000, status: 'timeout' } };
  assert.match(equipmentConnectionSummary(device).recent, /^Reported /);
  device.check.checkedAt = NOW + 60_000;
  assert.match(equipmentConnectionSummary(device).recent, /^Checked /);
  device.enabled = false;
  assert.equal(equipmentConnectionSummary(device).label, 'Not enabled');
});

test('garage adapter requires the connection and all device health evidence before showing available', () => {
  const healthy = { connected: true, health: { deviceOnline: true, driverProgressing: true, pumpCommunicating: true } };
  const summary = adapter => equipmentConnectionSummary(equipmentConnections({ now: NOW, garage: { adapter },
    equipment: { topicGroups: [{ id: 'garage-adapter', topics: [topic('Telemetry', 'fixture/garage/status')] }] } })[0]);
  assert.equal(summary(healthy).state, 'available');
  assert.equal(summary({ ...healthy, connected: false }).state, 'attention');
  for (const key of ['deviceOnline', 'driverProgressing', 'pumpCommunicating'])
    assert.notEqual(summary({ ...healthy, health: { ...healthy.health, [key]: false } }).state, 'available');
});

test('TeslaMate connection follows its vehicle subscription rather than idle charging or recorder health', () => {
  const connection = reception => equipmentConnections({ now: NOW,
    providers: { teslamate: { enabled: true, status: 'idle', healthy: false, recording: false, reception } },
    equipment: { topicGroups: [{ id: 'teslamate', topics: [topic('Vehicle subscription', 'teslamate/cars/7/#')] }] } })[0];
  const live = connection({ brokerConnected: true, subscriptionStatus: 'subscribed', lastLiveAt: NOW - 86_400_000, lastMessageAt: NOW - 86_400_000 });
  assert.equal(live.area, 'other');
  assert.equal(live.id, 'connection:teslamate:other');
  assert.equal(live.label, 'Tesla');
  assert.equal(live.source, 'TeslaMate');
  assert.equal(equipmentConnectionSummary(live).label, 'Connected');
  assert.match(equipmentConnectionSummary(live).recent, /^Reported /);
  assert.match(live.connectionDetail, /Vehicle data for charging.*sleeping or idle/);
  assert.doesNotMatch(JSON.stringify(live), /No live report yet/);
  const retained = connection({ brokerConnected: true, subscriptionStatus: 'subscribed', lastRetainedAt: NOW, lastMessageAt: NOW });
  assert.equal(equipmentConnectionSummary(retained).label, 'Connected');
  assert.equal(equipmentConnectionSummary(retained).recent, 'Saved broker value only');
  assert.match(retained.packetDetail, /no live vehicle report received yet/);
  const waiting = connection({ brokerConnected: true, subscriptionStatus: 'subscribed' });
  assert.equal(equipmentConnectionSummary(waiting).recent, 'Waiting for the first vehicle report');
  assert.equal(equipmentConnectionSummary(connection({ brokerConnected: false, subscriptionStatus: 'disconnected', lastLiveAt: NOW })).label, 'Disconnected');
  assert.equal(equipmentConnectionSummary(connection({ brokerConnected: true, subscriptionStatus: 'denied' })).label, 'Subscription failed');
  assert.doesNotMatch(connection({ brokerConnected: true, subscriptionStatus: 'subscribed', chargerId: 'charger1' }).connectionDetail, /Configured vehicle feed for Charger/);
  assert.equal(connection({ brokerConnected: true, subscriptionStatus: 'subscribed', chargerId: 'charger1' }).label, 'Tesla');
});

test('BMW vehicle MQTT displays source, real reception and feed problems independently of consumption', () => {
  const status = mqtt => ({ now: NOW, input: 'mqtt',
    charging: { chargers: [{ id: 'charger1', label: 'Charger 1', mqtt }] },
    equipment: { topicGroups: [{ id: 'charger1-vehicle', label: 'Charger 1 vehicle',
      topics: [topic('Timestamped vehicle readings', 'fixture/bmw/vehicle')] }] },
    providers: { easee: { status: 'ok' }, teslamate: { enabled: true, status: 'idle' } },
  });
  const connected = { provider: 'bmw-cardata', brokerConnected: true, subscriptionStatus: 'subscribed', subscribed: true };
  const row = mqtt => equipmentConnections(status(mqtt))[0];
  const live = row({ ...connected, lastMessageAt: NOW, lastLiveAt: NOW });
  assert.equal(live.label, 'BMW');
  assert.equal(live.kind, 'vehicle');
  assert.equal(equipmentSource(live), 'BMW CarData');
  assert.equal(equipmentConnectionSummary(live).label, 'Connected');
  assert.match(equipmentConnectionSummary(live).recent, /^Reported /);
  assert.match(live.connectionDetail, /BMW CarData.*charge.*target.*capacity/);
  assert.doesNotMatch(live.connectionDetail, /Home Assistant/);
  assert.deepEqual(live.topics.map(item => item.topic), ['fixture/bmw/vehicle']);
  const retained = row({ ...connected, lastMessageAt: NOW, lastRetainedAt: NOW });
  assert.equal(equipmentConnectionSummary(retained).recent, 'Saved broker value only');
  assert.match(retained.packetDetail, /no live vehicle report received yet/);
  assert.equal(equipmentConnectionSummary(row(connected)).recent, 'Waiting for the first vehicle report');
  assert.equal(equipmentConnectionSummary(row({ ...connected, brokerConnected: false })).label, 'Disconnected');
  assert.equal(equipmentConnectionSummary(row({ ...connected, subscriptionStatus: 'failed', subscribed: false })).label, 'Subscription failed');
  const invalid = row({ ...connected, lastLiveAt: NOW, invalidReason: 'invalid-soc' });
  assert.equal(equipmentConnectionSummary(invalid).state, 'attention');
  assert.equal(equipmentConnectionSummary(invalid).label, 'Invalid vehicle report');
  assert.match(invalid.packetDetail, /previous accepted readings keep their original timestamps/);
  assert.equal(equipmentSource(row({ ...connected, provider: null })), 'MQTT', 'a charger topic alone does not identify BMW');
  const electricity = dashboardProviders(status(connected), { now: NOW }).find(item => item.key === 'electricity');
  assert.equal(electricity.source, 'Easee, Teslamate');
  assert.doesNotMatch(JSON.stringify(electricity), /BMW|CarData|bmw-cardata/);
  const other = status(connected);
  other.charging.chargers[0] = { id: 'charger2', label: 'Charger 2',
    mqtt: { connected: true, subscriptionStatus: 'subscribed' },
    vehicleMqtt: { provider: 'bmw-cardata', brokerConnected: false, subscriptionStatus: 'disconnected' } };
  other.equipment.topicGroups[0].id = 'charger2-vehicle';
  const separate = equipmentConnections(other)[0];
  assert.equal(equipmentSource(separate), 'BMW CarData');
  assert.equal(equipmentConnectionSummary(separate).label, 'Disconnected', 'a separate Tesla subscription cannot confirm the BMW feed');
});

test('both floor Shellys are visible before device IDs are supplied and have no bypass controls', () => {
  const floor = equipmentConnections({}).filter(device => device.kind === 'floor_override');
  assert.deepEqual(floor.map(device => device.id), ['floor-override:living', 'floor-override:storage']);
  assert(floor.every(device => device.area === 'home' && equipmentSource(device) === 'Shelly'));
  assert(floor.every(device => device.enabled === false && device.controls.switch === false && device.topics.length === 0));
  assert(floor.every(device => equipmentConnectionSummary(device).label === 'Not enabled'));
  assert.match(floor[0].connectionDetail, /5 minutes.*15 minutes/);
  assert.match(floor[0].connectionDetail, /OFF restores thermostat control/);
});

test('floor MQTT cards distinguish commissioning, confirmed preheating, missing readback and pending release', () => {
  const view = extra => equipmentConnections({ now: NOW, preheatValves: { enabled: true, commissioned: true,
    devices: [{ group: 'living', available: true, at: NOW, channels: [{ id: 0, output: true }, { id: 1, output: true }] }], ...extra } })
    .filter(device => device.kind === 'floor_override');
  assert.equal(equipmentConnectionSummary(view({ commissioned: false })[0]).label, 'Needs commissioning');
  const active = view({ active: true });
  assert.equal(equipmentConnectionSummary(active[0]).label, 'Preheating');
  assert.match(active[0].connectionDetail, /Output 0: override on; Output 1: override on/);
  assert.equal(equipmentConnectionSummary(active[1]).label, 'Awaiting local-script readback');
  assert.equal(equipmentConnectionSummary(view({ restorationPending: true })[0]).label, 'Release pending');
});

test('configured vehicle feeds retain independent names before reports and follow a vehicle between chargers', () => {
  const status = { now: NOW, charging: { chargers: [{ id: 'charger1', label: 'Charger 1' }, { id: 'charger2', label: 'Charger 2' }],
    vehicleFeeds: [{ id: 'bmw', label: 'BMW', provider: 'bmw-cardata', topic: 'fixture/vehicles/bmw',
      reception: { connected: true, subscriptionStatus: 'subscribed' } },
    { id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: 'fixture/teslamate/cars/7/#', usedByChargerId: 'charger1',
      reception: { connected: true, subscriptionStatus: 'subscribed', lastLiveAt: NOW } }] },
    equipment: { topicGroups: [{ id: 'vehicle:bmw', vehicleFeedId: 'bmw', topics: [topic('Timestamped vehicle readings', 'fixture/vehicles/bmw')] },
      { id: 'vehicle:tesla', vehicleFeedId: 'tesla', topics: [topic('Vehicle subscription', 'fixture/teslamate/cars/7/#')] }] } };
  const rows = equipmentConnections(status).filter(row => row.kind === 'vehicle');
  assert.deepEqual(rows.map(row => [row.label, equipmentSource(row)]), [['BMW', 'BMW CarData'], ['Tesla', 'TeslaMate']]);
  assert.equal(equipmentConnectionSummary(rows[0]).recent, 'Waiting for the first vehicle report');
  assert.match(rows[1].connectionDetail, /Used by: Charger 1/);
  assert.doesNotMatch(JSON.stringify(rows), /Configured vehicle feed for Charger|via Home Assistant/);
  status.charging.vehicleFeeds[1].usedByChargerId = 'charger2';
  assert.match(equipmentConnections(status)[1].connectionDetail, /Used by: Charger 2/);
  const synthetic = equipmentConnections({ now: NOW, charging: status.charging }).filter(row => row.kind === 'vehicle');
  assert.deepEqual(synthetic.map(row => [row.label, row.topics[0].topic]), rows.map(row => [row.label, row.topics[0].topic]));
  status.charging.vehicleFeeds[0].reception = null;
  const starting = equipmentConnections(status)[0];
  assert.equal(starting.label, 'BMW'); assert.equal(equipmentSource(starting), 'BMW CarData');
  assert.equal(equipmentConnectionSummary(starting).label, 'Awaiting subscription');
});

test('Garage MQTT order puts heat pump and temperatures before Caravan air, energy and both doors', () => {
  const devices = [
    { id: 'door2', kind: 'door' }, { id: 'caravan_dehumidifier', kind: 'dehumidifier' }, { id: 'caravan', kind: 'metered_switch' },
    { id: 'blu_ht', kind: 'temperature' }, { id: 'door1', kind: 'door' }, { id: 'garage-probes', kind: 'temperature' },
  ].map(device => ({ ...device, area: 'garage', topics: [] }));
  const rows = equipmentConnections({ equipment: { devices, topicGroups: [{ id: 'garage-adapter',
    topics: [{ role: 'Status', topic: 'invented/pump/state', direction: 'subscribe' }] }] } });
  assert.deepEqual(rows.filter(device => device.area === 'garage').map(device => device.id),
    ['connection:garage-adapter:garage', 'garage-probes', 'blu_ht', 'caravan', 'door1', 'door2', 'caravan_dehumidifier']);
});
