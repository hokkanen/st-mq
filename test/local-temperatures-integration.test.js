import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/app/config.js';
import { Engine } from '../src/app/engine.js';
import { getChartData } from '../src/app/chart-data.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { startProviders } from '../src/acquisition/providers.js';
import { Store } from '../src/storage/store.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../src/domain/temperature-reports.js';
import { dashboardProviders } from '../chart/provider-status.js';

const ROOM_MAX_AGE = DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS + DEFAULT_TEMPERATURE_REPORT_GRACE_MS;
const MINUTE = 60_000, initial = Date.parse('2026-09-09T10:00:00Z');
function fixture(t, input) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-local-temperatures-'));
  const path = join(directory, 'fixture.json');
  writeFileSync(path, JSON.stringify({
    geoloc: { country_code: '' }, teslamate: { enabled: false, charger_identification: false },
    controller: { input, h66_device: 'invented-h66' },
    equipment: { devices: [
      { id: 'upstairs', kind: 'temperature', signal: 'indoor_temperature', connection: 'mqtt:invented/smoke/1' },
      { id: 'bedroom', kind: 'temperature', signal: 'bedroom_temperature', connection: 'mqtt:invented/smoke/2' },
      { id: 'downstairs', kind: 'temperature', signal: 'downstairs_temperature', connection: 'mqtt:invented/smoke/3' },
      { id: 'garage', kind: 'temperature', signal: 'garage_temperature', connection: 'mqtt:invented/garage' },
    ] },
    mqtt: { address: 'mqtt://invented.invalid',
      indoor_temperature_topic: 'invented/smoke/1', bedroom_temperature_topic: 'invented/smoke/2',
      downstairs_temperature_topic: 'invented/smoke/3', garage_temperature_topic: 'invented/garage' },
  }), { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory }, directory);
  const store = new Store(config.dbPath);
  let now = initial;
  const clock = () => now, engine = new Engine({ store, config, clock }), calls = [];
  const http = { async json(url) { calls.push(url); throw new Error('Temperature acquisition must not use HTTP'); } };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { config, store, clock, engine, http, calls, setTime: at => { now = at; } };
}

async function connect(f) {
  const client = new EventEmitter(), subscriptions = [];
  client.subscribe = (topic, options, done) => { subscriptions.push(topic); done(); };
  client.publish = (topic, payload, options, done) => done();
  client.end = (force, options, done) => done();
  const mqtt = await startMqtt({ ...f, connect: () => client });
  f.engine.h66Status = mqtt.status;
  client.emit('connect');
  const publish = (topic, value, timestamp = f.clock(), retained = false) => client.emit('message', topic,
    Buffer.from(JSON.stringify({ value, unit: 'C', timestamp })), { retain: retained });
  return { client, subscriptions, mqtt, publish };
}

for (const input of ['providers', 'mqtt']) test(`${input} uses three local room channels for the model average alongside H66 without HTTP`, async t => {
  const f = fixture(t, input), m = await connect(f);
  const providers = startProviders({ ...f, automatic: false });
  try {
    assert(m.subscriptions.includes('invented/smoke/1'));
    assert(m.subscriptions.includes('invented/smoke/2'));
    assert(m.subscriptions.includes('invented/smoke/3'));
    m.publish('invented/smoke/1', 22, initial - MINUTE);
    m.publish('invented/smoke/2', 21, initial - MINUTE);
    m.publish('invented/smoke/3', 20, initial - MINUTE);
    m.publish('invented/garage', 10, initial - MINUTE);
    m.client.emit('message', 'invented-h66/HP/0007', Buffer.from('5.2'));
    await providers.runDue();
    let status = f.engine.status();
    for (const [key, value, signal] of [['upstairs', 22, 'indoor_temperature'], ['bedroom', 21, 'bedroom_temperature'],
      ['downstairs', 20, 'downstairs_temperature'], ['garage', 10, 'garage_temperature']]) {
      assert.equal(status.observations[key].value, value);
      assert.equal(status.observations[key].source, 'mqtt-temperature');
      assert.equal(status.observations[key].observedAt, initial - MINUTE);
      assert.equal(status.observations[key].stale, false);
      const rows = f.store.observations({ signal });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].value, value);
      assert.equal(rows[0].source, 'mqtt-temperature');
    }
    assert.equal(status.observations.indoor.value, 21);
    assert.equal(status.observations.indoor.source, 'indoor-average');
    assert.equal(status.observations.outdoor.source, 'husdata-h66');
    assert.equal(status.observations.outdoor.value, 5.2);
    assert.equal(status.providers.temperatures.status, 'not-configured');
    const grouped = dashboardProviders(status, { now: f.clock(), formatTime: at => new Date(at).toISOString() })
      .find(row => row.key === 'main-temperatures');
    assert.equal(grouped.display.title, 'Main temperatures · MQTT, H66');
    assert.equal(grouped.display.state, 'Available');
    const chart = getChartData({ store: f.store, now: f.clock(), startDate: '2026-09-09', endDate: '2026-09-09', input });
    for (const [signal, value] of [['indoor_temperature', 22], ['bedroom_temperature', 21],
      ['downstairs_temperature', 20], ['garage_temperature', 10]]) assert(chart.series[signal].some(point => point.y === value));
    f.setTime(initial + MINUTE);
    m.publish('invented/smoke/2', 24);
    status = f.engine.status();
    assert.equal(status.observations.indoor.value, 22);
    assert.equal(status.observations.upstairs.value, 22);
    assert.equal(status.observations.downstairs.value, 20);
    f.setTime(initial + 5 * MINUTE);
    await providers.runDue();
    assert.deepEqual(f.calls, []);
  } finally { await providers.close(); await m.mqtt.close(); }
});

test('repeated timestamped retained MQTT publications preserve sensor age and missing room input invalidates the average', async t => {
  const f = fixture(t, 'mqtt'), m = await connect(f);
  try {
    const sendRooms = () => {
      for (const [channel, value] of [[1, 22], [2, 21], [3, 20]]) m.publish(`invented/smoke/${channel}`, value, initial - MINUTE, true);
    };
    sendRooms();
    assert.equal(f.engine.status().observations.indoor.value, null, 'Retained values cannot establish genuine report coverage');
    f.setTime(initial + 31 * MINUTE);
    sendRooms();
    const status = f.engine.status();
    for (const key of ['upstairs', 'bedroom', 'downstairs']) {
      assert.equal(status.observations[key].observedAt, initial - MINUTE);
      assert.equal(status.observations[key].stale, true);
    }
    assert.equal(status.observations.indoor.stale, true);
    m.publish('invented/smoke/1', 22);
    m.publish('invented/smoke/3', 20);
    assert.equal(f.engine.status().observations.indoor.stale, true, 'A stale bedroom cannot silently disappear from the configured average');
    m.publish('invented/smoke/2', 21);
    assert.equal(f.engine.status().observations.indoor.value, 21);
    assert.equal(f.engine.status().observations.indoor.stale, false);
  } finally { await m.mqtt.close(); }
});

test('untimestamped retained room values cannot become fresh model inputs after connecting', async t => {
  const f = fixture(t, 'mqtt'), m = await connect(f);
  try {
    for (const [channel, value] of [[1, 22], [2, 21], [3, 20]])
      m.client.emit('message', `invented/smoke/${channel}`, Buffer.from(String(value)), { retain: true });
    let status = f.engine.status();
    for (const key of ['upstairs', 'bedroom', 'downstairs']) {
      assert.equal(status.observations[key].observedAt, null);
      assert.equal(status.observations[key].stale, true);
    }
    assert.equal(status.observations.indoor.stale, true);
    for (const [channel, value] of [[1, 22], [2, 21], [3, 20]]) m.publish(`invented/smoke/${channel}`, value);
    status = f.engine.status();
    assert.equal(status.observations.indoor.value, 21);
    assert.equal(status.observations.indoor.stale, false);
  } finally { await m.mqtt.close(); }
});

test('unchanged room reports survive compression and restart, then expire independently and recover', async t => {
  const f = fixture(t, 'mqtt'), m = await connect(f);
  try {
    const rooms = () => {
      for (const [channel, value] of [[1, 22], [2, 21], [3, 20]]) m.publish(`invented/smoke/${channel}`, value);
    };
    for (let minute = 0; minute <= 180; minute += 15) {
      f.setTime(initial + minute * MINUTE); rooms();
    }
    for (const signal of ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature']) {
      assert.equal(f.store.observations({ signal }).length, 1, 'Equal genuine reports extend coverage instead of inserting temperature rows');
    }
    const restored = new Engine({ store: f.store, config: f.config, clock: f.clock });
    const resumed = restored.status();
    assert.equal(resumed.observations.indoor.value, 21);
    assert.equal(resumed.observations.indoor.stale, false);
    assert.equal(resumed.observations.upstairs.observedAt, initial, 'Restoring compressed coverage preserves original value time');
    f.setTime(initial + 180 * MINUTE + ROOM_MAX_AGE);
    assert.equal(f.engine.status().observations.indoor.value, null);
    assert.equal(restored.status().observations.indoor.value, null, 'Restart cannot extend a report deadline');
    m.publish('invented/smoke/1', 22); m.publish('invented/smoke/3', 20);
    assert.equal(f.engine.status().observations.indoor.value, null, 'Bedroom remains a required contributor');
    m.publish('invented/smoke/2', 21);
    assert.equal(f.engine.status().observations.indoor.value, 21);
    m.client.emit('message', 'invented/smoke/2', Buffer.from('invalid JSON'));
    assert.equal(f.engine.status().observations.indoor.value, null, 'Malformed reports interrupt the affected source immediately');
    f.setTime(f.clock() + MINUTE); m.publish('invented/smoke/2', 21);
    assert.equal(f.engine.status().observations.indoor.stale, false);
  } finally { await m.mqtt.close(); }
});

test('retransmissions and cached timestamps cannot renew a periodic report deadline', async t => {
  const f = fixture(t, 'mqtt'), m = await connect(f);
  try {
    for (const channel of [1, 2, 3]) m.publish(`invented/smoke/${channel}`, 21);
    f.setTime(initial + ROOM_MAX_AGE - MINUTE);
    for (const channel of [1, 2, 3]) {
      m.client.emit('message', `invented/smoke/${channel}`, Buffer.from('21'), { dup: true });
      m.publish(`invented/smoke/${channel}`, 21, initial);
    }
    f.setTime(initial + ROOM_MAX_AGE);
    assert.equal(f.engine.status().observations.indoor.value, null);
    for (const signal of ['indoor_temperature', 'bedroom_temperature', 'downstairs_temperature'])
      assert.equal(f.store.observations({ signal }).length, 1);
  } finally { await m.mqtt.close(); }
});
