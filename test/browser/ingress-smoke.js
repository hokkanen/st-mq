// Synthetic HA fixture: real add-on runtime, ingress listener and configuration
// imports behind a local proxy, with an in-memory Supervisor API. Requires an
// isolated Chrome DevTools listener. No household configuration or live providers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../../src/main.js';
import { configurationSource, loadConfig } from '../../src/app/config.js';
import { createConfigurationSource } from '../../src/app/configuration-source.js';
import { seedChartFixture } from '../../scripts/lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-ingress-browser-'));
const privatePath = join(directory, 'supervisor-options.json');
const importPath = join(directory, 'secrets.json');
const prefix = '/api/hassio_ingress/synthetic-browser-session/';
const uploadPath = '/app_configs/synthetic_repository_st-mq/secrets.json';
const now = Date.parse('2026-09-07T12:00:00Z');
const requests = [], pending = new Map(), errors = [];
let app, proxy, socket, id = 0, rejectStatus = false, cleanupPending = false, metadataAvailable = true, stallReads = null;

try {
  writeFileSync(privatePath, '{}', { mode: 0o600 });
  const env = { STMQ_ADDON: '1', STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory,
    STMQ_DATABASE_DIR: directory, STMQ_HOST: '127.0.0.1', STMQ_PORT: '0', STMQ_INPUT: 'simulated',
    STMQ_INGRESS_HOST: '127.0.0.1', STMQ_INGRESS_PORT: '0', SUPERVISOR_TOKEN: 'fixture-supervisor-token' };
  const config = loadConfig(env, directory);
  let savedOptions = {};
  const source = createConfigurationSource({ env, cwd: directory,
    paths: { defaultsPath: fileURLToPath(new URL('../../config.json', import.meta.url)), privatePath, importPath,
      receiptPath: join(directory, 'configuration-import.json') },
    buildConfig(options, information) {
      const candidatePath = join(directory, 'candidate.json');
      writeFileSync(candidatePath, JSON.stringify(options), { mode: 0o600 });
      const candidate = loadConfig({ ...env, STMQ_CONFIG: candidatePath }, directory);
      candidate.configuration = information;
      return candidate;
    },
    async fetchImpl(url, request) {
      assert.equal(request.headers.Authorization, 'Bearer fixture-supervisor-token');
      assert.equal(url, `http://supervisor/addons/self/${request.method === 'POST' ? 'options' : 'info'}`);
      if (request.method === 'POST') savedOptions = JSON.parse(request.body).options;
      return { ok: true, json: async () => ({ result: 'ok', data: request.method === 'POST' ? {}
        : { slug: 'synthetic_repository_st-mq', options: structuredClone(savedOptions) } }) };
    },
  });
  configurationSource(config).prepare = args => source.prepare(args);
  app = await start({ config, clock: () => now });
  assert.equal(app.webAccess.status().ingress.enabled, true);
  assert.equal(app.webAccess.status().direct.enabled, false);
  // Model the trusted Supervisor TCP peer; spoofed headers cannot grant this.
  app.webAccess.ingressServer.on('connection', connection =>
    Object.defineProperty(connection, 'remoteAddress', { value: '172.30.32.2' }));
  seedChartFixture(app.store, now);
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  proxy = createServer(async (request, response) => {
    try {
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      requests.push({ method: request.method, path: request.url, authorization: Boolean(request.headers.authorization) });
      if (!request.url.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const path = `/${request.url.slice(prefix.length)}`;
      if (stallReads === 'chart-events' && (path.startsWith('/api/chart?') || path.startsWith('/api/events?'))) return;
      if (stallReads === 'status-body' && path === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{'); return;
      }
      if (rejectStatus && path === '/api/status') {
        response.writeHead(401, { 'Content-Type': 'text/plain' }); response.end('401: Unauthorized'); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.ok(body.length < 64 * 1024, 'Fixture requests stay bounded');
      const headers = { 'X-Forwarded-Host': request.headers.host, 'X-Forwarded-Proto': 'http',
        'X-Ingress-Path': prefix.slice(0, -1) };
      if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type'];
      if (request.headers.origin) headers.Origin = request.headers.origin;
      const result = await fetch(`${upstream}${path}`, { method: request.method, headers,
        ...(body.length ? { body } : {}), signal: AbortSignal.timeout(10_000) });
      const forwarded = Object.fromEntries([...result.headers].filter(([key]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      if (path === '/api/status' || path === '/api/settings/reload') {
        const status = await result.json();
        if (result.ok) {
          status.settingsReload.configuration = { environment: 'home-assistant', defaultsPath: '/st-mq/config.json',
            privatePath: '/data/options.json', importPath: '/config/secrets.json', externalImportPath: uploadPath };
          if (!metadataAvailable) delete status.settingsReload.configuration;
          status.settingsReload.access = { ingress: { enabled: true }, direct: { enabled: false, tokenRequired: true } };
          status.settingsReload.result = { cleanupPending };
        }
        response.writeHead(result.status, forwarded); response.end(JSON.stringify(status));
      } else {
        response.writeHead(result.status, forwarded); response.end(Buffer.from(await result.arrayBuffer()));
      }
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"error":"Synthetic proxy failure"}');
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const endpoint = process.argv[2] ?? 'http://127.0.0.1:39125';
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(10_000) }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, attempts = 200) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}. ${errors.join('; ')}`);
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.bringToFront');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${origin}${prefix}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  assert.equal(await evaluate("document.getElementById('auth').hidden"), true);
  assert.equal(await evaluate("document.getElementById('history').getBoundingClientRect().height > 100"), true);
  await evaluate("document.getElementById('connections-details').open = true; document.getElementById('controls-details').open = true;");
  const instructions = await evaluate("document.getElementById('settings-configuration-steps').textContent");
  assert.ok(instructions.includes(uploadPath), 'UI renders the actual Supervisor slug supplied by status');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#settings-location dt, #settings-location dd')].map(node => node.textContent)"),
    ['Folder', '/app_configs/synthetic_repository_st-mq', 'File name', 'secrets.json', 'Full path', uploadPath,
      'Inside app', '/config/secrets.json']);
  assert.equal(await evaluate("document.getElementById('settings-location-message').hidden"), true);
  assert.match(instructions, /freshly saved options/);
  assert.match(instructions, /Omitted fields keep saved values/);
  assert.match(instructions, /failed import keeps the file/);
  assert.match(await evaluate("document.getElementById('settings-access').textContent"), /Host dashboard access.*host login.*Direct access is disabled/);
  assert.equal(await evaluate("document.getElementById('settings-reload').textContent"), 'Check & review configuration');

  writeFileSync(importPath, '{"controller":{"max_drop_c":0.6}}', { mode: 0o600 });
  cleanupPending = true;
  await evaluate("document.getElementById('settings-reload').click()");
  await until("!document.getElementById('settings-review').hidden && !document.getElementById('settings-review-apply').disabled");
  await evaluate("document.getElementById('settings-review-apply').click()");
  await until("document.getElementById('settings-reload-message').textContent === 'Configuration applied.' && !document.getElementById('settings-reload').disabled");
  assert.equal(await evaluate("document.getElementById('drop').textContent"), '0.6 °C');
  assert.equal(await evaluate("document.getElementById('settings-import-warning').hidden"), false);
  assert.match(await evaluate("document.getElementById('settings-import-warning').textContent"), /uploaded secrets.json could not be removed/);
  assert.equal(savedOptions.controller.max_drop_c, 0.6, 'Reviewed import is saved to Supervisor');
  assert.equal(existsSync(importPath), false, 'Successful import removes only the uploaded file');
  assert.equal(existsSync(privatePath), true, 'Supervisor startup export remains intact');

  await evaluate("document.getElementById('recording-details').open = true; document.getElementById('recording-overview-details').open = true; document.getElementById('energy-audit-details').open = true;");
  await until("document.getElementById('recording-overview-message').textContent.includes('Database snapshot:')");
  await until("document.getElementById('energy-audit-content').children.length > 0");
  for (const path of ['api/status', 'api/chart?', 'api/events?', 'api/settings/preview', 'api/settings/reload', 'api/recording-overview', 'api/energy-audits']) {
    assert.ok(requests.some(request => request.path.startsWith(`${prefix}${path}`)), `Browser requested ${path} through ingress`);
  }
  assert.ok(requests.some(request => request.method === 'POST' && request.path === `${prefix}api/settings/reload`));
  assert.ok(requests.some(request => request.path.startsWith(`${prefix}theme-`) && request.path.endsWith('.js')), 'Early theme loads inside ingress');
  assert.ok(requests.some(request => request.path.startsWith(`${prefix}index-`) && request.path.endsWith('.js')), 'Built application module loads inside ingress');
  assert.ok(requests.some(request => request.path.startsWith(`${prefix}index-`) && request.path.endsWith('.css')), 'Built styles load inside ingress');
  assert.ok(requests.every(request => request.path.startsWith(prefix)), 'All application requests retain the ingress prefix');
  assert.ok(requests.every(request => !request.authorization), 'Ingress uses the HA session without an application bearer token');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Long configuration paths fit mobile width');

  await send('Page.reload');
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('settings-import-warning').hidden"), false, 'Cleanup warning survives a page reload');
  metadataAvailable = false;
  await send('Page.reload');
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('settings-location-message').hidden"), false);
  assert.equal(await evaluate("document.getElementById('settings-location-message').textContent"),
    'Restart the controller to load configuration paths, then refresh this page');
  assert.equal(await evaluate("document.getElementById('settings-location').children.length"), 0, 'Missing backend metadata never invents a folder');
  // Real browser timers and network: stalled initial auxiliary reads cannot
  // prevent status polling; a body that never completes cannot hold its latch.
  stallReads = 'chart-events'; requests.length = 0;
  await send('Page.reload');
  for (let attempt = 0; attempt < 400 && requests.filter(row => row.path === `${prefix}api/status`).length < 2; attempt++)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(requests.filter(row => row.path === `${prefix}api/status`).length >= 2,
    'Status polling continues while the first chart/event reads are stalled');
  stallReads = null;
  await until("document.getElementById('history')?.dataset.ready === 'true'", 1400);
  stallReads = 'status-body'; requests.length = 0;
  await send('Page.reload');
  await until("document.getElementById('connection')?.textContent.includes('Monitoring is stale')", 1800);
  assert.ok(requests.filter(row => row.path === `${prefix}api/status`).length >= 2,
    'A stalled JSON body expires and later status polling retries');
  stallReads = null;
  await evaluate("window.dispatchEvent(new Event('online'))");
  await until("document.getElementById('history')?.dataset.ready === 'true'", 400);
  assert.equal(await evaluate("document.getElementById('connection').textContent.includes('Monitoring is stale')"), false);
  rejectStatus = true;
  await send('Page.reload');
  await until("document.getElementById('error')?.textContent.includes('Reopen this application from the host dashboard')");
  assert.equal(await evaluate("document.getElementById('auth').hidden"), true, 'Expired HA session never prompts for an ST-MQ token');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ingress-browser-smoke-passed', checks: ['built theme, CSS and module assets under ingress prefix',
    'chart, events, recording, audits and configuration API requests under ingress prefix', 'actual upload path in instructions',
    'trusted ingress listener without direct access or token prompt', 'reviewed configuration import saves to Supervisor and updates visible state', 'persistent import cleanup warning', 'explicit restart guidance when backend path metadata is missing',
    'configuration paths fit mobile width', 'stalled initial chart/events do not block status polling',
    'whole-body read timeout retries and monitoring staleness recovers online', 'expired HA session directs user back to Home Assistant'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
