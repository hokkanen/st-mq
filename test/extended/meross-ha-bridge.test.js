import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import mqtt from 'mqtt';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await delay(20); }
}
async function port() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}

test('HA garage bridge routes once and drops commands issued while the remote broker is disconnected', { timeout: 30000 }, async t => {
  const installed = spawnSync('mosquitto', ['-h'], { stdio: 'ignore' });
  if (installed.error?.code === 'ENOENT' && process.env.STMQ_REQUIRE_MQTT_TESTS !== '1') {
    t.skip('Install Mosquitto for this isolated bridge regression'); return;
  }
  assert.equal(installed.error, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'stmq-garage-bridge-'));
  const children = new Set(), clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.endAsync(true)));
    await Promise.all([...children].map(async child => { const closed = once(child, 'close'); child.kill(); await closed; }));
    await rm(directory, { recursive: true, force: true });
  });
  const haPort = await port(), linuxPort = await port();
  const bridge = (await readFile(new URL('../../integrations/homeassistant/meross-ha-bridge.conf.example', import.meta.url), 'utf8'))
    .replace('192.0.2.20:1885', `127.0.0.1:${haPort}`);
  async function broker(name, listenPort, extra = '') {
    const path = join(directory, name + '.conf');
    await writeFile(path, `listener ${listenPort} 127.0.0.1\nallow_anonymous true\npersistence false\n${extra}`);
    let child;
    return {
      async start() {
        child = spawn('mosquitto', ['-c', path], { stdio: ['ignore', 'ignore', 'pipe'] }); children.add(child);
        await new Promise((resolve, reject) => {
          child.once('error', reject); child.once('exit', code => reject(Error(`Fixture broker exited (${code})`)));
          child.stderr.on('data', b => { if (b.toString().includes('running')) resolve(); });
        });
      },
      async stop() { const closed = once(child, 'close'); child.kill(); await closed; children.delete(child); },
    };
  }
  async function client(listenPort, topics) {
    const c = mqtt.connect(`mqtt://127.0.0.1:${listenPort}`, { clean: true, reconnectPeriod: 100, queueQoSZero: false });
    clients.push(c); c.on('error', () => {});
    const result = { c, messages: [], ready: false };
    c.on('message', (topic, body) => result.messages.push({ topic, body: body.toString() }));
    c.on('close', () => { result.ready = false; });
    c.on('connect', async () => { try { await c.subscribeAsync(topics, { qos: 1 }); result.ready = true; } catch {} });
    await until(() => result.ready); return result;
  }
  const ha = await broker('ha', haPort), linux = await broker('linux', linuxPort, bridge);
  await ha.start(); await linux.start();
  const command = 'stmq/garage/door2/command/cover', contact = 'stmq/garage/door2/status/contact';
  const remote = await client(haPort, [command, '/appliance/fixture/subscribe']);
  const local = await client(linuxPort, [contact, 'stmq/bridge/ha_garage/status']);
  const bridgeState = value => local.messages.some(m => m.topic === 'stmq/bridge/ha_garage/status' && m.body === value);
  await until(() => bridgeState('1'));
  await local.c.publishAsync(command, 'first', { qos: 1, retain: false });
  await until(() => remote.messages.some(m => m.body === 'first'));
  const payload = JSON.stringify({ value: 'closed', timestamp: '2026-01-01T00:00:00Z' });
  await remote.c.publishAsync(contact, payload, { qos: 1, retain: false });
  await until(() => local.messages.some(m => m.topic === contact && m.body === payload));
  await ha.stop(); await until(() => bridgeState('0'));
  await local.c.publishAsync(command, 'must-not-replay', { qos: 1, retain: false });
  await ha.start(); await until(() => remote.ready);
  await until(() => local.messages.filter(m => m.topic === 'stmq/bridge/ha_garage/status' && m.body === '1').length === 2);
  await local.c.publishAsync(command, 'fresh', { qos: 1, retain: false });
  await until(() => remote.messages.some(m => m.body === 'fresh'));
  await local.c.publishAsync('/appliance/fixture/subscribe', 'native-must-stay-local', { qos: 1, retain: false });
  await delay(300);
  assert.deepEqual(remote.messages.filter(m => m.topic === command).map(m => m.body), ['first', 'fresh']);
  assert.ok(!remote.messages.some(m => m.body === 'native-must-stay-local'));
});
