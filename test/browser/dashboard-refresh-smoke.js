// Exercise the complete built dashboard, including errors caught and displayed
// by refresh(). Disposable simulation only; no household configuration or devices.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { comparisonPeriod } from '../../chart/comparison-range.js';

const directory = await mkdtemp(join(tmpdir(), 'dashboard-refresh-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], pending = new Map();
const comparisons = [];
let app, proxy, browser, socket, sequence = 0, mode = 'master', generation = 1;
let statusReads = 0, eventReads = 0, energyReads = 0;
const now = Date.now();
try {
  const configPath = join(directory, 'synthetic.json');
  await writeFile(configPath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory,
    STMQ_HOST: '127.0.0.1', STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now });
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  proxy = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'GET', 'The dashboard refresh check sends no mutations');
      const result = await fetch(upstream + request.url);
      const headers = Object.fromEntries([...result.headers].filter(([key]) =>
        !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      if (request.url === '/api/status') {
        const status = await result.json();
        statusReads++;
        if (mode === 'slave') {
          status.topology = 'mirror'; status.role = 'slave'; status.readOnly = true;
          status.sync = { state: 'ready', generation: `synthetic-${generation}`, sourceAt: now, snapshotAt: now };
          status.recordingHealth.scope = 'snapshot'; status.recordingHealth.contextId = 'synthetic-fixed-file';
          status.recordingHealth.recording.state = 'read-only';
          status.settingsReload = { available: false, busy: false, reason: 'Read-only slave' };
        }
        response.writeHead(result.status, headers); response.end(JSON.stringify(status));
      } else {
        const url = new URL(request.url, 'http://fixture');
        if (url.pathname === '/api/chart' && url.searchParams.get('summary') === '1')
          comparisons.push({ startDate: url.searchParams.get('start'), endDate: url.searchParams.get('end') });
        if (request.url.startsWith('/api/events?')) eventReads++;
        if (new URL(request.url, 'http://fixture').pathname === '/api/energy-audits') energyReads++;
        response.writeHead(result.status, headers); response.end(Buffer.from(await result.arrayBuffer()));
      }
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"Synthetic dashboard proxy failed"}');
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Chrome starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(value => value.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, 'Browser evaluation succeeds'); return result.result.value;
  };
  const until = async condition => {
    for (let i = 0; i < 400; i++) { if (await condition()) return; await pause(30); }
    assert.fail('Dashboard refresh did not complete');
  };
  const healthy = async label => {
    const banner = await evaluate("({hidden:document.getElementById('error').hidden,text:document.getElementById('error').textContent})");
    assert.equal(banner.hidden, true, `${label}: handled dashboard errors must fail the check: ${banner.text}`);
    assert.deepEqual(errors, [], `${label}: no uncaught browser or proxy errors`);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${proxy.address().port}/` });
  await until(() => evaluate("document.body?.dataset.authenticated==='true'"));
  await pause(50);
  await healthy('Initial master render');
  await until(() => eventReads > 0);
  await evaluate("document.getElementById('recording-details').open=true;document.getElementById('energy-audit-details').open=true;true");
  await until(() => evaluate("document.querySelectorAll('#energy-audit-content .energy-check').length===2"));
  const week = comparisonPeriod('week', now);
  const checkDefaultPeriod = async () => {
    assert.deepEqual(await evaluate("({startDate:document.getElementById('comparison-date-start').value,endDate:document.getElementById('comparison-date-end').value})"), week,
      'Comparisons initially show the same seven Finnish dates as Energy checks');
    assert.deepEqual(await evaluate("({startDate:document.getElementById('energy-check-date-start').value,endDate:document.getElementById('energy-check-date-end').value})"), week);
    assert.equal(await evaluate("document.getElementById('comparison-period-week').getAttribute('aria-pressed')"), 'true');
  };
  await checkDefaultPeriod();
  assert.equal(comparisons.length, 0, 'Collapsed comparisons do not query seven days of history');
  await evaluate("document.getElementById('comparison-toggle').click();true");
  await until(() => evaluate("document.getElementById('comparison-range-form').dataset.state==='ready'"));
  assert(comparisons.length > 0, 'Opening comparisons loads the selected period');
  assert(comparisons.every(dates => dates.startDate === week.startDate && dates.endDate === week.endDate));
  await evaluate("document.getElementById('comparison-toggle').click();true");
  for (const nextMode of ['master', 'slave', 'slave']) {
    mode = nextMode; generation++;
    const previousStatus = statusReads, previousEvents = eventReads, previousEnergy = energyReads;
    await evaluate("window.dispatchEvent(new Event('online'));true");
    await until(() => statusReads > previousStatus);
    await pause(50);
    await healthy(`${mode} generation ${generation}`);
    if (mode === 'slave') {
      assert.match(await evaluate("document.getElementById('settings-location-message').textContent"), /read-only view.*locations are unavailable/);
      assert.equal(await evaluate("document.getElementById('settings-access').hidden"), true,
        'A replica does not leave an empty access notice when local entrance metadata is unavailable');
    }
    await until(() => eventReads > previousEvents);
    if (mode === 'slave') await until(() => energyReads > previousEnergy);
  }
  await send('Page.reload');
  await until(() => evaluate("document.body?.dataset.authenticated==='true'"));
  await pause(50); await healthy('Reloaded standby');
  await checkDefaultPeriod();
  console.log('Dashboard refresh browser passed: matching seven-day defaults, lazy comparison requests, initial render, master polling, role change, advancing replica snapshots, energy refresh and reload; handled banners and uncaught errors checked.');
} finally {
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) {
    const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited;
  }
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await app?.close(); await rm(directory, { recursive: true, force: true });
}
