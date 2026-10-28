// Full built dashboard, invented provider data and a disposable browser only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { providerFixture } from '../../scripts/lib/provider-fixture.js';
import { Store } from '../../src/storage/store.js';
import { weatherAcquisitionIdentity } from '../../src/acquisition/weather-identity.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-standby-browser-'));
const profile = mkdtempSync(join(tmpdir(), 'stmq-standby-chrome-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-standby-screenshots-'));
const now = Date.parse('2026-10-28T10:00:00Z'), HOUR = 3600_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, socket, id = 0;
const pending = new Map(), errors = [];
try {
  const path = join(directory, 'fixture.json'); writeFileSync(path, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: path, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'providers' }, directory);
  const fixture = providerFixture(now), options = fixture.providerOptions;
  const market = options.market, weather = options.weather;
  options.market = async args => ({ ...await market(args), source: 'entsoe', acquisition: {
    primary: 'entsoe', selected: 'entsoe', fallbackUsed: false, attempts: [{ source: 'entsoe', status: 'ok' }] } });
  options.weather = async args => { const result = await weather(args); result.forecast[0].solarRadiationWm2 = 0; return result; };
  const seed = new Store(config.dbPath);
  try {
    const health = {};
    for (const [key, source, status] of [['outdoor', 'openmeteo', 'ok'], ['weather', 'openmeteo', 'partial'], ['market', 'elering', 'error']])
      health[key] = { acquisitionIdentity: weatherAcquisitionIdentity(fixture.connections),
        standby: { source, status, lastAttemptAt: now - 42 * 60_000, lastCheckedAt: now - 42 * 60_000,
        lastSuccessAt: status === 'ok' ? now - 42 * 60_000 : null, nextAttemptAt: now + 18 * 60_000,
        error: status === 'error' ? 'HTTP-503' : null, solarStatus: key === 'weather' ? 'partial' : null, coverage: null } };
    seed.setState('providers:health', health);
  } finally { seed.close(); }
  app = await start({ config: { ...config, connections: fixture.connections, electricityForecast: { enabled: false } },
    clock: () => now, providerOptions: options });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 200 && !port; i++) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(25);
  }
  assert(port, 'Disposable Chrome starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
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
    const requestId = ++id, timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 20_000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const schedule = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000) globalThis.refreshStandbySmoke = () => callback(...args);
      return schedule(callback, delay, ...args);
    };` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  for (let i = 0; i < 200 && !await evaluate("document.querySelectorAll('.provider-standby-list > li').length === 3"); i++) await pause(25);
  assert.equal(await evaluate("document.querySelectorAll('.provider-standby-list > li').length"), 3);
  await evaluate("document.querySelectorAll('#providers .provider-fold').forEach(node => node.open = ['market','main-temperatures'].includes(node.closest('[data-provider]').dataset.provider))");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.provider-standby-state')].map(node => node.textContent)"),
    ['Check failed', 'Usable at last check', 'Partial coverage']);
  assert.equal(await evaluate("document.querySelector('[data-provider=market] .provider-category-state').textContent"), 'Available');
  assert.match(await evaluate("document.querySelector('[data-provider=market] .provider-category-meta').textContent"), /Backup check needs attention/);
  await evaluate("document.querySelector('[data-check=outdoor] .status-detail-trigger').focus()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  assert.equal(await evaluate("document.querySelector('[data-check=outdoor] .status-detail-trigger').getAttribute('aria-expanded')"), 'true');
  assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /past check does not establish availability now/);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await evaluate("globalThis.standbyFocus = document.activeElement; globalThis.refreshStandbySmoke()");
  assert.equal(await evaluate('document.activeElement === globalThis.standbyFocus'), true, 'Refresh retains focused check trigger');
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] details').open"), true);
  for (const theme of ['light', 'dark']) for (const width of [320, 375, 480, 800, 1280, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await pause(50);
    const overflows = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.provider-standby-list > li')];
      return rows.filter(row => row.scrollWidth > row.clientWidth + 1 || [...row.children].some(child =>
        child.getBoundingClientRect().right > row.getBoundingClientRect().right + 1)).map(row => row.dataset.check);
    })()`);
    assert.deepEqual(overflows, [], `${theme} ${width}px check rows fit their card`);
    if (width === 375 || width === 1280) {
      for (const key of ['market', 'main-temperatures']) {
        await evaluate(`document.querySelector('[data-provider=${key}]').scrollIntoView({block:'start'})`);
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(artifacts, `${theme}-${width}-${key}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'provider-standby-smoke-passed', themes: 2, widths: 6, artifacts,
    checks: ['three scoped feeds', 'separate active and backup status', 'keyboard details', 'focus and disclosure preservation', 'responsive layout'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  browser?.kill(); await app?.close();
  if (browser && browser.exitCode === null) await new Promise(resolve => browser.once('exit', resolve));
  rmSync(profile, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true });
}
