// Synthetic frontend fixture only. The proxy models HA's URL prefix and status
// metadata; Supervisor imports and trusted-ingress authentication have separate
// server tests. Requires an isolated Chrome DevTools listener, as the learning
// browser smoke does. No household configuration or live providers are used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-ingress-browser-'));
const privatePath = join(directory, 'secrets.json');
const prefix = '/api/hassio_ingress/synthetic-browser-session/';
const uploadPath = '/addon_configs/synthetic_repository_st-mq/secrets.json';
const now = Date.parse('2026-09-07T12:00:00Z');
const requests = [], pending = new Map(), errors = [];
let app, proxy, socket, id = 0, rejectStatus = false, cleanupPending = false, metadataAvailable = true;

try {
  writeFileSync(privatePath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  proxy = createServer(async (request, response) => {
    try {
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      requests.push({ method: request.method, path: request.url, authorization: Boolean(request.headers.authorization) });
      if (!request.url.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
      const path = `/${request.url.slice(prefix.length)}`;
      if (rejectStatus && path === '/api/status') {
        response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"Synthetic expired HA session"}'); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      assert.ok(body.length < 64 * 1024, 'Fixture requests stay bounded');
      const headers = {};
      if (request.headers['content-type']) headers['Content-Type'] = request.headers['content-type'];
      // The upstream is an isolated standalone fixture. Its same-origin checks
      // see its own URL, just as a properly configured proxy presents it.
      if (request.headers.origin) headers.Origin = upstream;
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
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
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
    ['Folder', '/addon_configs/synthetic_repository_st-mq', 'File name', 'secrets.json', 'Full path', uploadPath,
      'Inside add-on', '/config/secrets.json']);
  assert.equal(await evaluate("document.getElementById('settings-location-message').hidden"), true);
  assert.match(instructions, /freshly saved options/);
  assert.match(instructions, /Omitted fields keep saved values/);
  assert.match(instructions, /failed import keeps the file/);
  assert.match(await evaluate("document.getElementById('settings-access').textContent"), /Home Assistant login.*Direct access is disabled/);
  assert.equal(await evaluate("document.getElementById('settings-reload').textContent"), 'Apply configuration');

  writeFileSync(privatePath, '{"controller":{"max_drop_c":0.6}}', { mode: 0o600 });
  cleanupPending = true;
  await evaluate("document.getElementById('settings-reload').click()");
  await until("document.getElementById('settings-reload-message').textContent === 'Configuration applied.' && !document.getElementById('settings-reload').disabled");
  assert.equal(await evaluate("document.getElementById('drop').textContent"), '0.6 °C');
  assert.equal(await evaluate("document.getElementById('settings-import-warning').hidden"), false);
  assert.match(await evaluate("document.getElementById('settings-import-warning').textContent"), /uploaded secrets.json could not be removed/);
  assert.equal(existsSync(privatePath), true, 'Standalone fixture retains its private file');

  await evaluate("document.getElementById('recording-details').open = true; document.getElementById('recording-overview-details').open = true; document.getElementById('energy-audit-details').open = true;");
  await until("document.getElementById('recording-overview-message').textContent.includes('Database snapshot:')");
  await until("document.getElementById('energy-audit-content').children.length > 0");
  for (const path of ['api/status', 'api/chart?', 'api/events?', 'api/settings/reload', 'api/recording-overview', 'api/energy-audits']) {
    assert.ok(requests.some(request => request.path.startsWith(`${prefix}${path}`)), `Browser requested ${path} through ingress`);
  }
  assert.ok(requests.some(request => request.method === 'POST' && request.path === `${prefix}api/settings/reload`));
  assert.ok(requests.some(request => new RegExp(`^${prefix}theme-[a-f0-9]+\\.js$`).test(request.path)), 'Early theme loads inside ingress');
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
    'Restart ST-MQ to load configuration paths, then refresh this page');
  assert.equal(await evaluate("document.getElementById('settings-location').children.length"), 0, 'Missing backend metadata never invents a folder');
  rejectStatus = true;
  await send('Page.reload');
  await until("document.getElementById('error')?.textContent.includes('Reopen ST-MQ from Home Assistant')");
  assert.equal(await evaluate("document.getElementById('auth').hidden"), true, 'Expired HA session never prompts for an ST-MQ token');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ingress-browser-smoke-passed', checks: ['built theme, CSS and module assets under ingress prefix',
    'chart, events, recording, audits and configuration API requests under ingress prefix', 'actual upload path in instructions',
    'Home Assistant login without token prompt', 'Apply configuration updates visible state', 'persistent import cleanup warning', 'explicit restart guidance when backend path metadata is missing',
    'configuration paths fit mobile width', 'expired HA session directs user back to Home Assistant'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
