import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Engine } from '../src/app/engine.js';

test('Tesla-only MQTT opt-in starts without H66 and stores total energy through the existing subscriber', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-teslamate-mqtt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = new EventEmitter(), topics = [], publications = [];
  client.subscribe = (topic, options, done) => { topics.push(topic); done(); };
  client.publish = (topic, payload, options, done) => { publications.push(topic); done?.(); };
  client.end = (force, options, done) => done();
  let now = Date.parse('2026-01-01T12:00:00Z');
  const config = { ...loadConfig({ STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory), input: 'mqtt', deviceId: null,
    connections: { mqtt: { address: 'mqtt://invented.invalid' }, teslamate: { enabled: true, carId: '2', namespace: 'invented' } } };
  const app = await start({ config, clock: () => now, mqttOptions: { connect: () => client }, providerOptions: { automatic: false } });
  try {
    assert.equal(app.engine.status().providers.teslamate.reason, 'mqtt-disconnected');
    client.emit('connect');
    assert.deepEqual(topics, ['teslamate/invented/cars/2/#']);
    assert.equal(app.engine.status().providers.teslamate.reason, 'awaiting-readings');
    const send = (name, value) => client.emit('message', `teslamate/invented/cars/2/${name}`, Buffer.from(String(value)));
    send('charging_state', 'Disconnected'); send('charge_energy_added', 0); send('geofence', 'Home');
    send('healthy', true); send('since', new Date(now).toISOString()); send('charging_state', 'Charging'); send('charger_power', 11);
    app.engine.teslamate.tick(now);
    now += 20_000; app.engine.teslamate.tick(now);
    app.engine.recorder.flush(now, { force: true });
    const rows = app.store.db.prepare("SELECT signal,value FROM observations WHERE source='teslamate' AND value IS NOT NULL").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].signal, 'ev2_energy');
    assert(Math.abs(rows[0].value - 11 * 20 / 3600) < 1e-10);
    const status = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`)).json();
    assert.equal(status.providers.teslamate.source, 'teslamate');
    assert.equal(status.providers.teslamate.enabled, true);
    assert.equal(status.providers.teslamate.recording, true);
    assert.equal(status.providers.teslamate.lastMessageAt, now - 20_000);
    assert(!JSON.stringify(status.providers.teslamate).includes('invented'));
    assert.equal(app.store.getState('providers:health')?.teslamate, undefined, 'Live MQTT health is never saved as provider history');
    assert.deepEqual(publications, [], 'Tesla acquisition never sends device commands');
    client.emit('offline'); assert.equal(app.engine.teslamate.status().connected, false);
    assert.equal(app.engine.status().providers.teslamate.reason, 'mqtt-disconnected');
  } finally { await app.close(); }
});

test('provider status includes disabled live acquisition and omits absent acquisition in offline and simulated modes', () => {
  const saved = { market: { status: 'ok' } };
  const engine = { store: { getState: () => saved }, config: { input: 'mqtt', connections: {} } };
  const status = () => Engine.prototype.providerStatus.call(engine);
  assert.equal(status().teslamate.status, 'disabled');
  engine.config.connections.teslamate = { enabled: true };
  assert.equal(status().teslamate.reason, 'awaiting-mqtt');
  for (const input of ['offline', 'simulated']) {
    engine.config.input = input;
    assert.equal(status().teslamate, undefined);
  }
  engine.teslamate = { status: () => ({ connected: true, status: 'ok', reason: 'not-charging' }) };
  assert.equal(status().teslamate.enabled, true);
  assert.equal(status().teslamate.connected, true);
  assert.deepEqual(saved, { market: { status: 'ok' } });
});
