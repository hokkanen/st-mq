import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { providerFixture } from '../scripts/lib/provider-fixture.js';
import { identityConnection, idleIdentityClient } from './helpers/identity-mqtt.js';

test('live test transport stays idle until a POST and shutdown records an unconfirmed pending command before closing storage', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-heating-lifecycle-'));
  const now = Date.parse('2026-09-07T12:00Z');
  const fixture = providerFixture(now);
  const connection = { address: 'mqtt://fixture.invalid', user: 'synthetic-user', pw: 'synthetic-private-password' };
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_PORT: '0', STMQ_DATA_DIR: directory }, directory),
    input: 'providers', dbPath: join(directory, 'st-mq.sqlite'), legacyDbPath: join(directory, 'st-mq.sqlite'),
    connections: { ...fixture.connections, mqtt: connection } };
  const clients = [], packets = [], published = new EventEmitter();
  const connect = (address, options) => {
    if (identityConnection(options)) return idleIdentityClient();
    assert.equal(address, connection.address);
    assert.equal(options.username, connection.user);
    assert.equal(options.password, connection.pw);
    const client = new EventEmitter();
    client.connected = true;
    client.endCalls = 0;
    client.publish = (topic, command, publishOptions, acknowledge) => {
      const packet = { client, topic, command, publishOptions, acknowledge };
      packets.push(packet);
      published.emit('publish', packet);
    };
    client.end = (force, options, done) => { assert.equal(force, true); client.endCalls++; done(); };
    clients.push(client);
    return client;
  };
  let app;
  t.after(async () => {
    try { await app?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  app = await start({ config, clock: () => now, providerOptions: fixture.providerOptions, mqttOptions: { connect } });
  const endpoint = `http://127.0.0.1:${app.server.address().port}`;
  const status = await (await fetch(`${endpoint}/api/status`)).json();
  assert.equal(status.heatingTests.available, true);
  assert.equal(status.liveWrites, false);
  app.engine.setOverride(60);
  app.engine.tick();
  assert.equal(clients.length, 0, 'Startup, status, temporary controls and automatic ticks never connect the publisher');
  const post = command => fetch(`${endpoint}/api/heating-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }),
  });
  const nextPacket = () => new Promise(resolve => published.once('publish', resolve));

  const firstPacket = nextPacket();
  const firstResponse = post('heatoff');
  const first = await firstPacket;
  assert.equal(clients.length, 1);
  assert.equal(first.topic, 'from_stmq/heat/action');
  assert.equal(first.command, 'heatoff');
  assert.deepEqual(first.publishOptions, { qos: 1, retain: false });
  assert.equal(app.store.events().some(event => event.type === 'heating-test-sent'), false);
  first.acknowledge();
  const success = await firstResponse;
  assert.equal(success.status, 200);
  assert.equal((await success.json()).sent, true);
  assert.equal(first.client.endCalls, 1);

  const pendingPacket = nextPacket();
  const pendingResponse = post('heaton60');
  const pending = await pendingPacket;
  assert.equal(clients.length, 2, 'Each explicit test has its own connection');
  assert.equal(pending.command, 'heaton60');
  let stateAtClose;
  const closeStore = app.store.close.bind(app.store);
  app.store.close = () => {
    stateAtClose = app.store.getState('heating-test:providers');
    closeStore();
  };
  const [failure] = await Promise.all([pendingResponse, app.close()]);
  assert.equal(failure.status, 400);
  const failureBody = await failure.json();
  assert.match(failureBody.error, /closed|unconfirmed/i);
  assert.equal(pending.client.endCalls, 1);
  assert.equal(stateAtClose.command, 'heaton60');
  assert.equal(stateAtClose.status, 'failed');
  assert.equal(stateAtClose.sent, false);
  assert.equal(stateAtClose.actual, null);
  assert.equal(app.engine.heatingTestBusy, false);

  pending.acknowledge();
  pending.client.emit('connect');
  pending.client.emit('error', new Error(connection.pw));
  assert.equal(packets.length, 2, 'Late callbacks cannot publish a command after shutdown');
  const reopened = new Store(config.dbPath);
  try {
    assert.deepEqual(reopened.getState('heating-test:providers'), stateAtClose);
    const events = reopened.events().filter(event => event.type.startsWith('heating-test'));
    assert.deepEqual(events.map(event => event.type), [
      'heating-test-requested', 'heating-test-sent', 'heating-test-requested', 'heating-test-failed',
    ]);
    assert.doesNotMatch(JSON.stringify({ events, failureBody, stateAtClose }), /synthetic-private-password|fixture\.invalid/);
  } finally { reopened.close(); }
});
