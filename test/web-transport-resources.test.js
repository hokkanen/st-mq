import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebAccess } from '../src/app/web-access.js';

const hostname = 'synthetic-resource.example.test';
const token = 'synthetic-resource-test-admin-password';
async function fixture(t, lanHttpEnabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-tls-resources-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  const material = { hostname, generation: 'synthetic-resource-generation', certificate: {
    key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) } };
  const access = createWebAccess({ config: { host: '127.0.0.1', port: 0, token, addon: false,
    web: { httpsHost: '127.0.0.1', httpsPort: 0, lanHttpHost: '127.0.0.1', lanHttpPort: 0, lanHttpEnabled } },
    engine: { status: () => ({ environment: 'history' }) }, store: {}, chartService: { overview: async () => ({}) },
    httpsManagerFactory: () => ({ start() {}, configure() {}, close() {}, status: () => ({ enabled: true, phase: 'ready' }) }) });
  await access.start();
  t.after(() => access.close());
  assert.equal((await access.installCertificate(material)).listening, true);
  return { access, material };
}
async function tcp(t, server) {
  const socket = connect({ host: '127.0.0.1', port: server.address().port });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return socket;
}
async function bounded(operation, milliseconds = 500) {
  let deadline;
  try { await Promise.race([operation, new Promise((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Transport cleanup exceeded its deadline.')), milliseconds);
  })]); } finally { clearTimeout(deadline); }
}
function secureStatus(server, material) {
  return new Promise((resolve, reject) => {
    const connection = request({ host: '127.0.0.1', port: server.address().port, servername: hostname,
      ca: material.certificate.cert, agent: false, path: '/api/status',
      headers: { Host: `${hostname}:${server.address().port}`, Authorization: `Bearer ${token}` } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    connection.on('error', reject); connection.end();
  });
}

test('HTTPS disable and shutdown close silent TCP clients before they send a ClientHello', async t => {
  const { access, material } = await fixture(t);
  const recovery = access.server;
  let silent = await tcp(t, access.httpsServer);
  const initial = performance.now();
  await bounded(access.installCertificate(null));
  assert.ok(performance.now() - initial < 500);
  await new Promise(resolve => silent.destroyed ? resolve() : silent.once('close', resolve));
  assert.equal(access.server, recovery);
  assert.equal(recovery.listening, true);
  assert.equal((await access.installCertificate(material)).listening, true);
  silent = await tcp(t, access.httpsServer);
  await bounded(access.close());
  await new Promise(resolve => silent.destroyed ? resolve() : silent.once('close', resolve));
  assert.equal(recovery.listening, false);
});

test('incomplete TLS clients have a connection bound and cannot delay shutdown', async t => {
  const { access } = await fixture(t);
  const server = access.httpsServer;
  await Promise.all(Array.from({ length: 160 }, () => tcp(t, server)));
  await new Promise(resolve => setTimeout(resolve, 50));
  const active = await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.ok(active > 0 && active <= 128, `Accepted ${active} pending clients`);
  await bounded(access.close());
});

test('malformed TLS traffic and ordinary handshakes leave the local event loop responsive', async t => {
  const { access, material } = await fixture(t);
  const server = access.httpsServer;
  const delays = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); delays.push(Math.max(0, now - previous - 10)); previous = now;
  }, 10);
  t.after(() => clearInterval(timer));
  const malformed = Promise.all(Array.from({ length: 64 }, async () => {
    const socket = await tcp(t, server);
    const ended = new Promise(resolve => socket.once('close', resolve));
    socket.write(Buffer.alloc(128, 0x41));
    await ended;
  }));
  const statuses = Promise.all(Array.from({ length: 32 }, () => secureStatus(server, material)));
  await Promise.all([malformed, statuses]);
  await new Promise(resolve => setTimeout(resolve, 30));
  clearInterval(timer);
  assert.equal((await statuses).every(code => code === 200), true);
  assert.ok(delays.length > 0, 'The heartbeat ran while network work was pending');
  const maximum = Math.max(...delays);
  t.diagnostic(`Synthetic local TLS burst: ${delays.length} heartbeat samples, maximum timer delay ${maximum.toFixed(1)} ms`);
  assert.ok(maximum < 250, 'Bounded TLS traffic must not stall the local heartbeat for 250 ms');
  assert.equal((await fetch(`http://127.0.0.1:${access.server.address().port}/api/status`, {
    headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test('post-listen TLS and LAN HTTP errors revoke only the affected optional listener', async t => {
  const { access } = await fixture(t, true);
  access.httpsServer.emit('error', new Error('/synthetic/private/tls/path'));
  assert.equal(access.status().https.enabled, false);
  assert.equal(access.status().https.error, 'tls_listener_failed');
  assert.equal(access.status().lanHttp.enabled, true);
  access.lanHttpServer.emit('error', new Error('/synthetic/private/http/path'));
  assert.equal(access.status().lanHttp.enabled, false);
  assert.equal(access.status().lanHttp.error, 'http_listener_failed');
  const response = await fetch(`http://127.0.0.1:${access.server.address().port}/api/web-access`, {
    headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /synthetic\/private/);
});

test('authenticated streaming backup uploads retain their owner budget while stalled JSON input is bounded', async t => {
  const [{ createAppServer }, { request: httpRequest }] = await Promise.all([
    import('../src/app/server.js'), import('node:http'),
  ]);
  let bytes = 0, controls = 0;
  const server = createAppServer({ token, engine: { status: () => ({ environment: 'history' }),
    setTemporary: () => { controls++; return {}; } }, store: {}, chartService: { overview: async () => ({}) },
    transportLimits: { requestTimeout: 3600000, headersTimeout: 10000, bodyTimeoutMs: 50, connectionsCheckingInterval: 1000 },
    historyRecovery: { async upload(input, authorized) {
      assert.equal(authorized(), true);
      for await (const chunk of input) bytes += chunk.length;
      assert.equal(authorized(), true); return { uploaded: true, bytes };
    } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const options = path => ({ host: '127.0.0.1', port: server.address().port, path, method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Length': '2' } });
  const uploaded = new Promise((resolve, reject) => {
    const connection = httpRequest(options('/api/history-recovery/upload'), response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ code: response.statusCode, result: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    connection.on('error', reject);
    connection.write('a');
    setTimeout(() => connection.end('b'), 150);
  });
  assert.deepEqual(await uploaded, { code: 201, result: { uploaded: true, bytes: 2 } });
  const refused = new Promise(resolve => {
    const connection = httpRequest({ ...options('/api/temporary'), headers: { ...options('/api/temporary').headers,
      'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    connection.on('error', error => resolve(error.code)); connection.write('{');
  });
  assert.equal(await refused, 'ECONNRESET');
  assert.equal(controls, 0, 'Incomplete timed-out JSON never dispatches a control');
});

test('unauthorized unfinished request bodies receive an error and promptly release their connection', async t => {
  const { access } = await fixture(t);
  const server = access.server;
  const socket = connect({ host: '127.0.0.1', port: server.address().port, allowHalfOpen: true });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  let response = '';
  const ended = new Promise(resolve => socket.once('end', resolve));
  socket.on('data', chunk => { response += chunk.toString(); });
  socket.write(`POST /api/web-access HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\nConnection: keep-alive\r\n\r\n{`);
  await bounded(ended);
  assert.match(response, /^HTTP\/1\.1 401/);
  assert.match(response, /Connection: close/i);
  assert.match(response, /Authentication required/);
  const active = await new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  assert.equal(active, 0, 'A rejected client cannot retain one of the bounded listener slots');
});
