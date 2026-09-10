import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ControllerAnnouncements } from '../src/pairing/announcements.js';

test('MQTT identity ignores retained, stale, duplicate and different-equipment announcements', async () => {
  const own = { nodeId: randomUUID(), epoch: randomUUID(), platform: 'ubuntu', role: 'primary' };
  const other = { ...own, nodeId: randomUUID(), platform: 'hassio', boot: randomUUID(), heartbeat: 1, at: 1000000, version: 1 };
  const seen = [], client = new EventEmitter(); client.connected = true;
  client.publish = (...args) => seen.push(['sent', ...args]);
  client.subscribe = () => {}; client.end = (force, options, done) => done();
  let connectOptions;
  const guard = new ControllerAnnouncements({ connection: { address: 'mqtt://127.0.0.1', user: 'fixture', pw: 'synthetic-mqtt-password' }, scope: 'fixture-equipment',
    claim: () => own, onConflict: value => seen.push(['conflict', value.nodeId]), clock: () => 1000000,
    connect: (address, options) => { connectOptions = options; return client; } });
  guard.start(); client.emit('connect');
  assert.equal(connectOptions.username, 'fixture'); assert.equal(connectOptions.password, 'synthetic-mqtt-password');
  assert.equal(seen[0][3].retain, false);
  const receive = (value, packet, topic = guard.topic) => guard.receive(topic, Buffer.from(JSON.stringify(value)), packet);
  receive(other, { retain: true }); receive({ ...other, at: 0 }); receive(other, {}, 'unrelated');
  assert.equal(seen.filter(row => row[0] === 'conflict').length, 0);
  receive(other); receive(other); receive({ ...other, heartbeat: 2 });
  assert.equal(seen.filter(row => row[0] === 'conflict').length, 2);
  await guard.close();
});
