import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

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
    client.emit('connect');
    assert.deepEqual(topics, ['teslamate/invented/cars/2/#']);
    const send = (name, value) => client.emit('message', `teslamate/invented/cars/2/${name}`, Buffer.from(String(value)));
    send('charging_state', 'Disconnected'); send('charge_energy_added', 0); send('geofence', 'Home');
    send('healthy', true); send('since', new Date(now).toISOString()); send('charging_state', 'Charging'); send('charger_power', 11);
    app.engine.teslamate.tick(now);
    now += 20_000; app.engine.teslamate.tick(now);
    app.engine.recorder.flush(now, { force: true });
    const rows = app.store.db.prepare("SELECT signal,value FROM observations WHERE source='teslamate' AND value IS NOT NULL").all();
    assert.equal(rows.length, 1); assert.equal(rows[0].signal, 'ev2_energy');
    assert(Math.abs(rows[0].value - 11 * 20 / 3600) < 1e-10);
    assert.deepEqual(publications, [], 'Tesla acquisition never sends device commands');
    client.emit('offline'); assert.equal(app.engine.teslamate.status().connected, false);
  } finally { await app.close(); }
});
