import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { start } from '../src/main.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { loadConfig } from '../src/app/config.js';
import { CONTROL_SCOPE, standaloneAuthority } from '../src/control/authority.js';
import { idleIdentityClient, identityConnection } from './helpers/identity-mqtt.js';

test('retired standalone authority is rejected without replacing its identity or opening MQTT', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'stmq-retired-authority-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, 'controller-authority'); await mkdir(directory);
  const path = join(directory, 'identity.json');
  const raw = JSON.stringify({ nodeId: randomUUID(), epoch: randomUUID(), role: 'primary', platform: 'ubuntu', blocked: true });
  await writeFile(path, raw);
  await assert.rejects(standaloneAuthority({ config: { dataDir }, connect: () => assert.fail('No connection is authorized') }),
    /Preserve.*fresh data directory/);
  assert.equal(await readFile(path, 'utf8'), raw);
  assert.deepEqual(await readdir(directory), ['identity.json']);
});

test('standalone MQTT authority loss stops writes, retains a read-only dashboard and survives restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-controller-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = idleIdentityClient(), publications = [];
  client.publish = (topic, payload, options, done) => { publications.push(topic); done?.(); };
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory),
    input: 'mqtt', connections: { mqtt: { address: 'mqtt://invented.invalid' } } };
  let connections = 0;
  const options = { config, installSignalHandlers: false, providerOptions: { automatic: false },
    mqttOptions: { connect: () => { connections++; return client; } } };
  const app = await start(options);
  try {
    const endpoint = `http://127.0.0.1:${app.server.address().port}`;
    client.connected = true; client.emit('connect');
    const topic = `st-mq/control-authority/${createHash('sha256').update(CONTROL_SCOPE).digest('hex').slice(0, 32)}`;
    client.emit('message', topic, Buffer.from(JSON.stringify({ version: 1, nodeId: randomUUID(), epoch: randomUUID(),
      role: 'master', platform: 'hassio', at: Date.now(), boot: randomUUID(), heartbeat: 1 })), {});
    const status = await (await fetch(`${endpoint}/api/status`)).json();
    assert.equal(status.readOnly, true, JSON.stringify(status));
    assert.equal(status.controlAuthority.state, 'protected'); assert.ok(status.controlAuthority.stoppedAt > 0);
    assert.equal((await fetch(`${endpoint}/api/settings/reload`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
    assert.equal((await fetch(`${endpoint}/`)).status, 200);
    const identityPath = join(directory, 'controller-authority/identity.json');
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await readFile(identityPath, 'utf8')).blocked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(JSON.parse(await readFile(identityPath, 'utf8')).blocked, true);
    assert.ok(publications.every(value => value === topic), 'loss and shutdown send no equipment restoration');
  } finally { await app.close(); }
  const previousConnections = connections, restarted = await start(options);
  try {
    assert.equal(restarted.engine, undefined); assert.equal(connections, previousConnections);
    const status = await (await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/status`)).json();
    assert.equal(status.readOnly, true, JSON.stringify(status)); assert.equal(status.controlAuthority.state, 'protected');
  } finally { await restarted.close(); }
});

test('authority loss invalidates a delayed settings reload without recreating acquisition or writing later observations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-authority-reload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let releaseRead, enteredRead, identity;
  const waiting = new Promise(resolve => { releaseRead = resolve; });
  const entered = new Promise(resolve => { enteredRead = resolve; });
  const clients = [];
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory),
    input: 'mqtt', connections: { mqtt: { address: 'mqtt://invented.invalid' },
      equipment: equipmentConfiguration({devices:[{id:'indoor',kind:'temperature',connection:'mqtt:invented/temperature'}]}) } };
  const app = await start({ config, installSignalHandlers: false, providerOptions: { automatic: false },
    readConfig: async () => { enteredRead(); await waiting; return config; },
    mqttOptions: { connect: (_address, options) => {
      const client = idleIdentityClient(); clients.push(client);
      if (identityConnection(options)) identity = client;
      return client;
    } } });
  t.after(() => app.close());
  const oldEngine = app.engine, oldClients = clients.length;
  const reload = app.reloadSettings(), rejected = assert.rejects(reload, /authority was revoked/);
  await entered;
  const topic = `st-mq/control-authority/${createHash('sha256').update(CONTROL_SCOPE).digest('hex').slice(0, 32)}`;
  identity.emit('message', topic, Buffer.from(JSON.stringify({ version: 1, nodeId: randomUUID(), epoch: randomUUID(),
    role: 'master', platform: 'hassio', at: Date.now(), boot: randomUUID(), heartbeat: 1 })), {});
  releaseRead();
  await rejected;
  for (let i = 0; i < 100 && !oldEngine.executor.closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.engine, oldEngine); assert.equal(oldEngine.suspended, true);
  assert.equal(oldEngine.executor.closed, true); assert.equal(clients.length, oldClients);
  const changes = app.store.db.prepare('SELECT total_changes() n').get().n;
  for (const client of clients) client.emit('message', 'invented/temperature', Buffer.from('20'), {});
  app.engine.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.store.db.prepare('SELECT total_changes() n').get().n, changes);
  const status = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`)).json();
  assert.equal(status.readOnly, true, JSON.stringify(status)); assert.equal(status.controlAuthority.state, 'protected');
  await assert.rejects(app.reloadSettings(), /authority was revoked/);
});
