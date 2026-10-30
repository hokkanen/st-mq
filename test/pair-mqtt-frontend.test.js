import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { MqttFrontend } from '../src/pairing/mqtt-frontend.js';

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Synthetic socket state did not settle');
}

async function broker(t, { echo = true } = {}) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (echo) socket.pipe(socket); else socket.pause();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, sockets, port: server.address().port };
}

function frontend(t, upstream, { port = 0, ...options } = {}) {
  const result = new MqttFrontend({ connection: { address: `mqtt://127.0.0.1:${upstream.port}` },
    vip: { address: '127.0.0.2', interface: 'synthetic' } }, {
    port, interfaces: () => ({ synthetic: [{ address: '127.0.0.3', internal: false }] }), ...options });
  t.after(() => result.stop());
  return result;
}

async function client(t, host, port) {
  const socket = createConnection({ host, port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}

async function echo(socket, bytes = Buffer.from('synthetic MQTT bytes')) {
  const received = once(socket, 'data');
  socket.write(bytes);
  assert.deepEqual((await received)[0], bytes);
}

test('both handover directions close VIP sessions and leave fixed broker clients connected', async t => {
  const ha = await broker(t), ubuntu = await broker(t);
  const fixed = await client(t, '127.0.0.1', ha.port);
  const first = frontend(t, ha);
  await first.prepare(); await first.start();
  const port = first.server.address().port;
  const second = frontend(t, ubuntu, { port });
  let active = first, standby = second;
  // The opaque frontend preserves binary data as well as ordinary MQTT bytes.
  const binary = Buffer.from([0x16, 0x03, 0x03, 0, 4, 0, 0xff, 0x82, 1]);
  for (let direction = 0; direction < 2; direction++) {
    const device = await client(t, '127.0.0.2', port);
    await echo(device, binary);
    assert.equal(active.status().connections, 1);
    await standby.prepare();
    const closed = once(device, 'close');
    const stopping = active.stop();
    assert.equal(active.status().listening, false, 'acceptance fences synchronously');
    await stopping; await closed;
    assert.equal(active.status().connections, 0);
    await echo(fixed, Buffer.from('HA fixed connection survives'));
    await standby.start();
    [active, standby] = [standby, active];
    // Ephemeral port is only a fixture convenience; both masters use one port.
    standby.port = port;
  }
  await echo(await client(t, '127.0.0.2', port));
  assert.equal(fixed.destroyed, false);
});

test('preflight permits a loopback broker but rejects a conflicting fixed listener and unavailable upstream', async t => {
  const upstream = await broker(t);
  const proxy = frontend(t, upstream, { port: upstream.port });
  await proxy.prepare();
  const blocker = createServer(socket => socket.destroy());
  blocker.listen(upstream.port, '127.0.0.3'); await once(blocker, 'listening');
  try { await assert.rejects(proxy.prepare(), { code: 'mqtt_frontend_unavailable' }); }
  finally { await new Promise(resolve => blocker.close(resolve)); }
  await proxy.prepare();
  const missing = frontend(t, { port: upstream.port });
  await new Promise(resolve => upstream.server.close(resolve));
  await assert.rejects(missing.prepare(), { code: 'mqtt_upstream_unavailable' });
  assert.equal(missing.status().ready, false);
});

test('session cap rejects excess clients and upstream failures close their clients without replay', async t => {
  const upstream = await broker(t), proxy = frontend(t, upstream, { maxConnections: 1 });
  await proxy.start();
  const port = proxy.server.address().port;
  const first = await client(t, '127.0.0.2', port); await echo(first);
  const extra = await client(t, '127.0.0.2', port); await until(() => extra.destroyed);
  assert.equal(proxy.status().connections, 1);
  for (const socket of upstream.sockets) socket.destroy();
  await until(() => first.destroyed && proxy.status().connections === 0);
  const replacement = await client(t, '127.0.0.2', port); await echo(replacement, Buffer.from('new session only'));
  assert.equal(proxy.status().connections, 1);
});

test('a stalled broker applies backpressure with bounded frontend buffers and stop closes both sides', async t => {
  const upstream = await broker(t, { echo: false }), proxy = frontend(t, upstream);
  await proxy.start();
  const socket = await client(t, '127.0.0.2', proxy.server.address().port);
  await until(() => proxy.status().connections === 1);
  assert.equal(socket.write(Buffer.alloc(8 * 1024 * 1024, 0x5a)), false);
  await new Promise(resolve => setTimeout(resolve, 50));
  const [{ client: downstream, upstream: outgoing }] = [...proxy.connections];
  assert.ok(downstream.readableLength + outgoing.writableLength < 256 * 1024,
    'frontend does not accumulate the multi-megabyte publisher backlog');
  await proxy.stop();
  await until(() => socket.destroyed);
  assert.equal(downstream.closed, true);
  assert.equal(outgoing.closed, true);
});

test('stop cancels a pending listener startup and a later explicit start is clean', async t => {
  const upstream = await broker(t), proxy = frontend(t, upstream);
  const pending = proxy.start();
  await proxy.stop();
  await assert.rejects(pending, { code: 'stopped' });
  assert.equal(proxy.status().listening, false);
  await proxy.start();
  await proxy.start();
  await Promise.all([proxy.start(), proxy.start()]);
  await echo(await client(t, '127.0.0.2', proxy.server.address().port));
  await proxy.stop();
  assert.equal(proxy.status().connections, 0);
});

test('optional TLS listener forwards opaque bytes and fences both listeners together', async t => {
  const plain = await broker(t), tls = await broker(t);
  const f = new MqttFrontend({ connection: { address: `mqtt://127.0.0.1:${plain.port}` },
    vip: { address: '127.0.0.2', interface: 'synthetic', tlsUpstreamPort: tls.port } }, {
    port: 0, interfaces: () => ({ synthetic: [{ address: '127.0.0.3', internal: false }] }) });
  // Use an ephemeral fixture port rather than the installation's 8883.
  f.tlsFrontend.port = 0;
  t.after(() => f.stop());
  await f.prepare(); await f.start();
  assert.equal(f.status().tls.ready, true);
  assert.equal(f.handoverRequirements().tls.protocol, 'mqtts:');
  const a = await client(t, '127.0.0.2', f.server.address().port);
  const b = await client(t, '127.0.0.2', f.tlsFrontend.server.address().port);
  await echo(a); await echo(b, Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01]));
  await f.stop();
  await until(() => a.destroyed && b.destroyed);
  assert.equal(f.status().ready, false);
  assert.equal(f.status().tls.ready, false);
});

test('TLS preflight preserves a distinct fixed-address listener and still rejects wildcard conflicts', async t => {
  const upstream = await broker(t);
  const fixed = createServer(socket => socket.destroy());
  fixed.listen(0, '127.0.0.3'); await once(fixed, 'listening');
  t.after(() => new Promise(resolve => fixed.close(resolve)));
  const f = new MqttFrontend({ connection: { address: `mqtt://127.0.0.1:${upstream.port}` },
    vip: { address: '127.0.0.2', interface: 'synthetic', tlsUpstreamPort: upstream.port } },
  { port: 0, interfaces: () => ({ synthetic: [{ address: '127.0.0.3', internal: false }] }) });
  f.tlsFrontend.port = fixed.address().port;
  t.after(() => f.stop());
  await f.prepare(); await f.start();
  assert.equal(f.status().tls.ready, true);
  await f.stop();
  const wildcard = createServer(socket => socket.destroy());
  wildcard.listen(0, '0.0.0.0'); await once(wildcard, 'listening');
  t.after(() => new Promise(resolve => wildcard.close(resolve)));
  f.tlsFrontend.port = wildcard.address().port;
  await assert.rejects(f.prepare(), error => error.code === 'mqtt_frontend_unavailable');
});
