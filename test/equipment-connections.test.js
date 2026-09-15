import test from 'node:test';
import assert from 'node:assert/strict';
import { equipmentConnections, equipmentConnectionSummary, equipmentTopicGroups } from '../chart/equipment.js';

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
  assert.deepEqual(rows.map(row => row.id), ['connection:h66:home', ...temperatures.map(device => device.id), circulation.id, 'fixture-tariff']);
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
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => [row.area, equipmentTopicGroups(row.topics).flatMap(group => group.topics.map(row => row.topic))]), [
    ['home', ['fixture/upstairs']], ['home', ['fixture/bedroom']], ['garage', ['fixture/garage-front']],
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
  assert.equal(commands.length, 1);
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
