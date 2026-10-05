import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import mqtt from 'mqtt';
import { MqttFrontend } from '../../src/pairing/mqtt-frontend.js';

const until = async (predicate, message) => {
  const end = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
async function freePort(host = '127.0.0.1') {
  const server = createServer();
  server.listen(0, host); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Real MQTT clients and independent brokers; all addresses/data are synthetic.
// This establishes transport behavior, not physical device reconnect timing.
test('VIP MQTT handovers preserve fixed HA sessions and independent operation during HA loss', { timeout: 35_000 }, async t => {
  const installed = spawnSync('mosquitto', ['-h'], { stdio: 'ignore' });
  if (installed.error?.code === 'ENOENT' && process.env.STMQ_REQUIRE_MQTT_TESTS !== '1') {
    t.skip('Install mosquitto for the isolated handover regression'); return;
  }
  assert.equal(installed.error, undefined);
  const directory = await mkdtemp(join(tmpdir(), 'stmq-vip-mqtt-'));
  const children = new Set(), clients = [], frontends = [];
  t.after(async () => {
    await Promise.all(frontends.map(frontend => frontend.stop()));
    await Promise.all(clients.map(client => client.endAsync(true)));
    await Promise.all([...children].map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('close', resolve); child.kill('SIGTERM');
    })));
    await rm(directory, { recursive: true, force: true });
  });
  async function broker(name) {
    const port = await freePort(), path = join(directory, name + '.conf');
    await writeFile(path, `listener ${port} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
    let child;
    return { port, address: `mqtt://127.0.0.1:${port}`,
      async start() {
        child = spawn('mosquitto', ['-c', path], { stdio: ['ignore', 'ignore', 'pipe'] });
        children.add(child);
        await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', code => reject(Error(`Fixture broker exited (${code})`)));
          child.stderr.on('data', chunk => { if (chunk.toString().includes('running')) resolve(); });
        });
      },
      async stop() { const stopped = once(child, 'close'); child.kill('SIGTERM'); await stopped; children.delete(child); },
    };
  }
  async function client(address, topics = []) {
    const instance = mqtt.connect(address, { clean: true, reconnectPeriod: 100,
      connectTimeout: 1000, queueQoSZero: false });
    clients.push(instance);
    instance.on('error', () => {});
    const result = { instance, connects: 0, closes: 0, messages: [], ready: false };
    instance.on('connect', async () => {
      result.connects++;
      try { if (topics.length) await instance.subscribeAsync(topics, { qos: 1 }); result.ready = true; }
      catch { /* Reconnect may supersede a fixture subscription. */ }
    });
    instance.on('close', () => { result.closes++; result.ready = false; });
    instance.on('message', (topic, payload, packet) => result.messages.push({ topic,
      payload: payload.toString(), retained: packet.retain }));
    await until(() => result.ready, 'fixture MQTT connection ready');
    return result;
  }
  const ha = await broker('ha'), ubuntu = await broker('ubuntu');
  await ha.start(); await ubuntu.start();
  const fixedHa = await client(ha.address, ['fixture/ha-feed']);
  const haObserver = await client(ha.address, ['fixture/device']);
  const ubuntuObserver = await client(ubuntu.address, ['fixture/device']);
  const vip = { address: '127.0.0.2', interface: 'fixture' }, port = await freePort(vip.address);
  const makeFrontend = source => {
    const frontend = new MqttFrontend({ connection: { address: source.address }, vip }, { port,
      interfaces: () => ({ fixture: [{ address: '127.0.0.3', internal: false }] }) });
    frontends.push(frontend); return frontend;
  };
  const haFrontend = makeFrontend(ha), ubuntuFrontend = makeFrontend(ubuntu);
  await haFrontend.prepare(); await ubuntuFrontend.prepare();
  await haFrontend.start();
  const device = await client(`mqtt://${vip.address}:${port}`, ['fixture/request']);
  async function evidence(observer, marker) {
    await device.instance.publishAsync('fixture/device', marker, { qos: 1 });
    await until(() => observer.messages.some(message => message.payload === marker), 'fresh device packet on expected broker');
    assert.equal(observer.messages.find(message => message.payload === marker).retained, false);
  }
  await evidence(haObserver, 'before');
  for (const [oldFrontend, nextFrontend, observer, marker] of [
    [haFrontend, ubuntuFrontend, ubuntuObserver, 'ubuntu'],
    [ubuntuFrontend, haFrontend, haObserver, 'ha-again'],
    [haFrontend, ubuntuFrontend, ubuntuObserver, 'ubuntu-again'],
  ]) {
    const before = device.connects;
    await oldFrontend.stop();
    assert.equal(oldFrontend.status().connections, 0);
    assert.equal(oldFrontend.status().listening, false);
    await nextFrontend.start();
    await until(() => device.ready && device.connects > before, 'device reconnected through same VIP endpoint');
    await evidence(observer, marker);
    assert.equal(fixedHa.connects, 1, 'native HA client never reconnects during handover');
    assert.equal(fixedHa.closes, 0, 'native HA client remains connected');
    await fixedHa.instance.publishAsync('fixture/ha-feed', marker, { qos: 1 });
    await until(() => fixedHa.messages.some(message => message.payload === marker), 'native HA traffic continues');
  }
  assert.deepEqual(haObserver.messages.map(message => message.payload), ['before', 'ha-again']);
  assert.deepEqual(ubuntuObserver.messages.map(message => message.payload), ['ubuntu', 'ubuntu-again']);
  const deviceConnections = device.connects;
  await ha.stop();
  await until(() => !fixedHa.instance.connected, 'HA broker loss observed');
  await evidence(ubuntuObserver, 'ha-unavailable');
  assert.equal(device.connects, deviceConnections, 'HA outage does not reconnect independent device');
  assert.equal(ubuntuFrontend.status().listening, true);
  await ha.start();
  await until(() => fixedHa.ready && fixedHa.connects === 2, 'HA client recovers on its original broker');
  await evidence(ubuntuObserver, 'ha-recovered');
  assert.equal(device.connects, deviceConnections);
});
