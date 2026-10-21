import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebAccess, LAN_HTTP_WARNING } from '../src/app/web-access.js';
import { loadConfig as readConfig, webConfiguration } from '../src/app/config.js';
import { configurationRestartRequired } from '../src/app/configuration-preview.js';
import { Store } from '../src/storage/store.js';

const loadConfig = (env = {}, cwd) => readConfig({ HOME: '/missing-stmq-test-home', ...env }, cwd);

const admin = 'synthetic-admin-password-long-enough';
const family = 'synthetic-family-password-long-enough';
const hostname = 'synthetic-node.example.test';
const authorization = token => ({ Authorization: `Bearer ${token}` });
const config = extra => ({ host: '127.0.0.1', port: 0, token: admin, familyToken: family,
  addon: false, web: { httpsHost: '127.0.0.1', httpsPort: 0, lanHttpHost: '127.0.0.1', lanHttpPort: 0,
    lanHttpEnabled: false, lanResolver: '' }, ...extra });
const endpoint = server => `http://127.0.0.1:${server.address().port}`;

function certificate(t, label = 'first') {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-synthetic-tls-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
    '-keyout', join(directory, `${label}.key`), '-out', join(directory, `${label}.crt`)], { stdio: 'ignore' });
  return { hostname, generation: label, certificate: {
    cert: readFileSync(join(directory, `${label}.crt`)), key: readFileSync(join(directory, `${label}.key`)) } };
}
async function setup(t, initial = config(), extra = {}) {
  const actions = [];
  const store = extra.store ?? new Store(':memory:');
  const manager = { start() {}, configure() {}, close() {},
    status: () => ({ enabled: true, phase: 'ready', privateDiagnostic: 'admin-only' }),
    action: input => { actions.push(input); return { id: 'synthetic-operation', state: 'pending' }; } };
  const access = createWebAccess({ config: initial, engine: { status: () => ({ environment: 'history' }) },
    store, chartService: { overview: async () => ({}) }, httpsManagerFactory: () => manager, ...extra });
  await access.start();
  t.after(async () => { await access.close(); if (!extra.store) await store.close(); });
  return { access, actions, manager };
}
function tlsGet(server, material, path = '/api/status', extra = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ host: '127.0.0.1', port: server.address().port,
      servername: hostname, ca: material.certificate.cert, agent: false, path,
      headers: { Host: `${hostname}:${server.address().port}`, ...authorization(admin), ...extra } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject); request.end();
  });
}

test('native HTTPS shares ordinary authentication, pins hostname and scheme, and rotates without closing recovery', async t => {
  const first = certificate(t), second = certificate(t, 'second');
  const { access } = await setup(t);
  const recovery = access.server;
  const installed = await access.installCertificate(first);
  assert.equal(installed.listening, true);
  const server = access.httpsServer;
  assert.equal((await tlsGet(server, first)).status, 200);
  assert.equal((await tlsGet(server, first, '/api/status', { Authorization: '' })).status, 401);
  assert.equal((await tlsGet(server, first, '/api/status', { Host: 'wrong.example.test' })).status, 403);
  assert.equal((await tlsGet(server, first, '/api/status', { Origin: `http://${hostname}:${server.address().port}` })).status, 403);
  const rotated = await access.installCertificate(second);
  assert.equal(rotated.listening, true);
  assert.notEqual(rotated.fingerprint, installed.fingerprint);
  assert.equal(access.httpsServer, server);
  assert.equal((await tlsGet(server, second)).status, 200);
  await assert.rejects(tlsGet(server, first), /self-signed|certificate/);
  assert.equal(access.server, recovery);
  assert.equal((await fetch(`${endpoint(recovery)}/api/status`, { headers: authorization(admin) })).status, 200);
  const invalid = await access.installCertificate({ ...second, hostname: 'wrong.example.test' });
  assert.equal(invalid.listening, false);
  assert.equal((await tlsGet(server, second)).status, 200, 'Rejected candidates preserve the working certificate');
  await access.installCertificate(null);
  assert.equal(access.status().https.enabled, false);
  assert.equal(access.server, recovery);
});

test('credential rotation revokes pending private reads on HTTPS and LAN HTTP together', async t => {
  const initial = config(); initial.web.lanHttpEnabled = true;
  const waiting = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const { access } = await setup(t, initial, { chartService: { overview: () => new Promise(resolve => {
    waiting.push(resolve); if (waiting.length === 2) ready();
  }) } });
  const material = certificate(t);
  assert.equal((await access.installCertificate(material)).listening, true);
  const secureRead = tlsGet(access.httpsServer, material, '/api/recording-overview');
  const plainRead = fetch(`${endpoint(access.lanHttpServer)}/api/recording-overview`, { headers: authorization(admin) });
  await started;
  const replacement = 'synthetic-replacement-admin-password';
  await access.apply({ ...initial, token: replacement });
  waiting.forEach(resolve => resolve({ sensitiveHouseholdValue: 123 }));
  const [secure, plain] = await Promise.all([secureRead, plainRead]);
  assert.equal(secure.status, 401); assert.equal(plain.status, 401);
  assert.doesNotMatch(JSON.stringify(secure.body), /sensitiveHouseholdValue/);
  assert.doesNotMatch(await plain.text(), /sensitiveHouseholdValue/);
  assert.equal((await tlsGet(access.httpsServer, material, '/api/status', authorization(replacement))).status, 200);
});

test('an occupied optional TLS port cannot stop recovery or open HTTP automatically', async t => {
  const blocker = createHttpServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const initial = config(); initial.web.httpsPort = blocker.address().port;
  const { access } = await setup(t, initial);
  assert.deepEqual(await access.installCertificate(certificate(t)), { listening: false, error: 'tls_port_unavailable' });
  assert.equal(access.status().recovery.enabled, true);
  assert.equal(access.status().lanHttp.enabled, false);
  assert.equal((await fetch(`${endpoint(access.server)}/api/status`, { headers: authorization(admin) })).status, 200);
});

test('LAN HTTP requires explicit configuration and authentication and carries a persistent warning', async t => {
  const initial = config(); initial.web.lanHttpEnabled = true;
  const { access } = await setup(t, initial);
  assert.equal(access.status().lanHttp.warning, LAN_HTTP_WARNING);
  assert.equal((await fetch(`${endpoint(access.lanHttpServer)}/api/status`)).status, 401);
  const response = await fetch(`${endpoint(access.lanHttpServer)}/api/status`, { headers: authorization(family) });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.deepEqual(state.webTransport, { enabled: true, phase: 'ready', certificate: null, secure: false, warning: LAN_HTTP_WARNING });
  assert.doesNotMatch(JSON.stringify(state.webTransport), /privateDiagnostic/);
  assert.throws(() => createWebAccess({ config: { ...initial, token: '', familyToken: '' } }), /at least 24/);
});

test('optional LAN HTTP bind failure is reported while recovery starts', async t => {
  const blocker = createHttpServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const initial = config(); initial.web.lanHttpEnabled = true; initial.web.lanHttpPort = blocker.address().port;
  const { access } = await setup(t, initial);
  assert.equal(access.status().lanHttp.error, 'http_port_unavailable');
  assert.equal(access.status().recovery.enabled, true);
});

test('admin HTTPS setup works on standby and with failed dashboard data while family management remains forbidden', async t => {
  const { access, actions } = await setup(t, config(), { role: 'slave',
    pairContext: { canControl: () => false }, engine: { status: () => { throw new Error('Synthetic missing dashboard'); } } });
  const url = `${endpoint(access.server)}/api/web-access`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: authorization(family) })).status, 403);
  const response = await fetch(url, { headers: authorization(admin) });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.webAccess.role, 'admin');
  assert.equal(state.transport.recovery.enabled, true);
  const change = await fetch(url, { method: 'POST', headers: { ...authorization(admin), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enable' }) });
  assert.equal(change.status, 202); assert.equal(actions.length, 1);
  const denied = await fetch(url, { method: 'POST', headers: { ...authorization(family), 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'enable' }) });
  assert.equal(denied.status, 403); assert.equal(actions.length, 1);
});

test('manager startup and shutdown errors remain isolated from recovery', async t => {
  const { access } = await setup(t, config(), { httpsManagerFactory: () => ({
    start: async () => { throw new Error('/synthetic/private/path'); },
    status: () => ({ enabled: false, phase: 'unavailable' }), close: async () => { throw new Error('Synthetic cleanup'); } }) });
  await new Promise(resolve => setImmediate(resolve));
  const response = await fetch(`${endpoint(access.server)}/api/web-access`, { headers: authorization(admin) });
  const body = await response.json();
  assert.equal(body.managementError, 'https_management_unavailable');
  assert.doesNotMatch(JSON.stringify(body), /private\/path/);
  await access.close();
});

test('network config stays optional, rejects retired or unsupported fields, and does not silently expose recovery', t => {
  assert.deepEqual(webConfiguration(), { httpsHost: '0.0.0.0', httpsPort: 8443, lanHttpEnabled: false,
    httpsDirectory: '', lanHttpHost: '0.0.0.0', lanHttpPort: 1236, lanResolver: '' });
  for (const input of [{ unknown: 'synthetic-secret' }, { https_port: 0 }, { https_host: '::' },
    { lan_http_enabled: 'true' }, { lan_resolver: 'router.example.test' }, { https_port: 1236 },
    { https_directory: 'inside-checkout' }, { https_directory: null }, { https_host: null }, { lan_http_enabled: null }])
    assert.throws(() => webConfiguration(input));
  assert.throws(() => loadConfig({ STMQ_HOST: '0.0.0.0', STMQ_API_TOKEN: admin }, '/missing-repository'), /loopback/);
  const directory = mkdtempSync(join(tmpdir(), 'stmq-web-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'settings.json');
  writeFileSync(file, JSON.stringify({ web: { lan_http_enabled: true } }));
  assert.throws(() => loadConfig({ STMQ_CONFIG: file }, directory), /at least 24/);
  const cfg = loadConfig({ STMQ_CONFIG: file, STMQ_API_TOKEN: admin }, directory);
  assert.equal(cfg.host, '127.0.0.1'); assert.equal(cfg.web.lanHttpEnabled, true);
  assert.deepEqual(configurationRestartRequired(cfg, { ...cfg, web: { ...cfg.web, httpsPort: 9443 } }), ['web']);
  assert.deepEqual(configurationRestartRequired(cfg, { ...cfg, web: { ...cfg.web, httpsDirectory: '/tmp/other-private-https' } }), ['web']);
});
