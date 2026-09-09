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
import { dashboardProviders } from '../chart/provider-status.js';

const MINUTE = 60_000, initial = Date.parse('2026-09-09T10:00:00Z');
function fixture(t, input) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-smartthings-integration-'));
  const path = join(directory, 'options.json');
  writeFileSync(path, JSON.stringify({
    controller: { input, h66_device: 'invented-h66' },
    smartthings: { token: 'synthetic-smartthings-token', inside_temp_dev_id: 'invented/indoor',
      garage_temp_dev_id: 'invented/garage', outside_temp_dev_id: 'invented/unused-outdoor' },
    mqtt: { address: 'mqtt://invented.invalid', indoor_temperature_topic: 'invented/indoor',
      garage_temperature_topic: 'invented/garage' },
  }));
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory }, directory);
  const store = new Store(config.dbPath);
  let now = initial;
  const clock = () => now, engine = new Engine({ store, config, clock }), calls = [];
  const http = { async json(url, options) {
    calls.push({ url, method: options.method });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-smartthings-token');
    const garage = url.includes('garage');
    return { components: { main: { temperatureMeasurement: { temperature: {
      value: garage ? 50 : 21.4, unit: garage ? 'F' : 'C', timestamp: new Date(initial - MINUTE).toISOString(),
    } } } } };
  } };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { config, store, clock, engine, http, calls, setTime: at => { now = at; } };
}

for (const input of ['providers', 'mqtt']) test(`${input} configuration restores SmartThings history and live readings alongside H66 and MQTT`, async t => {
  const f = fixture(t, input), client = new EventEmitter();
  client.subscribe = (topic, options, done) => done();
  client.publish = (topic, payload, options, done) => done();
  client.end = (force, options, done) => done();
  const mqtt = await startMqtt({ ...f, connect: () => client });
  f.engine.h66Status = mqtt.status;
  const providers = startProviders({ ...f, automatic: false });
  try {
    client.emit('connect');
    client.emit('message', 'invented-h66/HP/0007', Buffer.from('5.2'));
    await providers.runDue();
    assert.deepEqual(f.calls, [
      { url: 'https://api.smartthings.com/v1/devices/invented%2Findoor/status', method: 'GET' },
      { url: 'https://api.smartthings.com/v1/devices/invented%2Fgarage/status', method: 'GET' },
    ]);
    let status = f.engine.status();
    for (const [key, value] of [['indoor', 21.4], ['garage', 10]]) {
      assert.equal(status.observations[key].value, value);
      assert.equal(status.observations[key].source, 'smartthings');
      assert.equal(status.observations[key].observedAt, initial - MINUTE);
      assert.equal(status.observations[key].stale, false);
      const rows = f.store.observations({ signal: `${key}_temperature` });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].value, value);
      assert.equal(rows[0].source, 'smartthings');
    }
    assert.equal(status.observations.outdoor.source, 'husdata-h66');
    assert.equal(status.observations.outdoor.value, 5.2);
    assert.equal(status.observations.outdoor.stale, false);
    assert.equal(status.providers.temperatures.status, 'ok');
    assert.equal(f.store.getState('provider:observations').length, 2);
    const grouped = dashboardProviders(status, { now: f.clock(), formatTime: at => new Date(at).toISOString() })
      .find(row => row.key === 'main-temperatures');
    assert.equal(grouped.display.title, 'Main temperatures · SmartThings, H66');
    assert.equal(grouped.display.state, 'Available');
    const chart = getChartData({ store: f.store, now: f.clock(), startDate: '2026-09-09', endDate: '2026-09-09', input });
    assert(chart.series.indoor_temperature.some(point => point.y === 21.4));
    assert(chart.series.garage_temperature.some(point => point.y === 10));

    f.setTime(initial + MINUTE);
    client.emit('message', 'invented/indoor', Buffer.from('22'));
    client.emit('message', 'invented/garage', Buffer.from('11'));
    f.setTime(initial + 5 * MINUTE);
    await providers.runDue();
    assert.equal(f.calls.length, 4, 'Configured MQTT topics do not disable SmartThings polling');
    status = f.engine.status();
    assert.equal(status.observations.indoor.source, 'mqtt-temperature');
    assert.equal(status.observations.indoor.value, 22);
    assert.equal(status.observations.garage.source, 'mqtt-temperature');
    assert.equal(status.observations.garage.value, 11);
  } finally { await providers.close(); await mqtt.close(); }
});

test('SmartThings repeated downloads and restart preserve original sensor age', async t => {
  const f = fixture(t, 'providers');
  const providers = startProviders({ ...f, automatic: false });
  try {
    await providers.runDue();
    f.setTime(initial + 31 * MINUTE);
    await providers.runDue();
    const restored = new Engine({ store: f.store, config: f.config, clock: f.clock });
    for (const engine of [f.engine, restored]) {
      const status = engine.status();
      for (const key of ['indoor', 'garage']) {
        assert.equal(status.observations[key].source, 'smartthings');
        assert.equal(status.observations[key].observedAt, initial - MINUTE);
        assert.equal(status.observations[key].stale, true);
      }
    }
    assert(f.store.getState('provider:observations').every(row => row.sourceTime === initial - MINUTE));
    for (const signal of ['indoor_temperature', 'garage_temperature'])
      assert(f.store.observations({ signal }).every(row => row.sourceTime === initial - MINUTE));
  } finally { await providers.close(); }
});
