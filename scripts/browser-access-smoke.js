// Isolated simulation and browser profile; never opens household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { addFireplace } from '../src/app/fireplace.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-access-browser-'));
const admin = 'synthetic-browser-admin-access-token';
const family = 'synthetic-browser-family-access-token';
const now = Date.parse('2026-09-25T12:00:00Z');
let app, browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  const configuration = join(directory, 'fixture.json');
  await writeFile(configuration, '{}');
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_INPUT: 'simulated', STMQ_PORT: '0', STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family }, directory);
  app = await start({ config, clock: () => now });
  addFireplace(app.store, 'simulated', { requestId: 'synthetic-browser-old-firewood', kg: 2 }, now - 16 * 60_000);
  const profile = join(directory, 'browser');
  await mkdir(profile);
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert(port, 'Chromium starts with an isolated profile');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if (await evaluate(`Boolean(document.body && (${expression}))`)) return;
      } catch (error) {
        if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const login = async credential => {
    await evaluate(`document.getElementById('token').value=${JSON.stringify(credential)};document.getElementById('auth').requestSubmit();true`);
    await until("document.body.dataset.authenticated === 'true'");
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden");
  assert.equal(await evaluate("document.body.dataset.authenticated"), 'false');
  await evaluate("document.getElementById('password-visibility').click();true");
  assert.equal(await evaluate("document.getElementById('token').type"), 'text');
  await login(family);
  assert.match(await evaluate("document.getElementById('web-access-role').textContent"), /Family/);
  assert.equal(await evaluate("document.getElementById('token').type"), 'password');
  for (const id of ['database-export-download', 'database-export-save', 'settings-reload', 'floor-preheat-guide', 'floor-preheat-script'])
    assert.equal(await evaluate(`document.getElementById('${id}').disabled`), true, `${id} requires admin`);
  for (const id of ['away-until', 'pause-until'])
    assert.equal(await evaluate(`document.getElementById('${id}').disabled`), false, `${id} stays available to family`);
  await evaluate("document.getElementById('fireplace-shortcut').click();true");
  assert.equal(await evaluate("document.querySelector('.fireplace-remove').disabled"), true, 'Old entries require admin');
  await evaluate("document.getElementById('fireplace-kg').value='4';document.getElementById('fireplace-submit').click();true");
  await until("document.querySelectorAll('.fireplace-remove').length === 2");
  assert.equal(await evaluate("document.querySelector('.fireplace-remove').disabled"), false, 'Fresh entries can be removed');
  await evaluate("document.getElementById('fireplace-close').click();sessionStorage.setItem('stmq-fireplace-pending','synthetic pending');document.getElementById('web-logout').click();true");
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden && !sessionStorage.getItem('stmq-token')");
  assert.equal(await evaluate("document.body.dataset.authenticated"), 'false');
  assert.equal(await evaluate("sessionStorage.getItem('stmq-fireplace-pending')"), null);
  await send('Page.reload');
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden");
  assert.equal(await evaluate("document.body.dataset.authenticated"), 'false', 'Reload does not undo logout');
  await login(admin);
  assert.match(await evaluate("document.getElementById('web-access-role').textContent"), /Admin/);
  assert.equal(await evaluate("document.getElementById('database-export-download').disabled"), false);
  assert.equal(await evaluate("document.getElementById('floor-preheat-guide').disabled"), false);
  await evaluate("document.getElementById('fireplace-shortcut').click();true");
  assert.equal(await evaluate("[...document.querySelectorAll('.fireplace-remove')].every(button=>!button.disabled)"), true);
  await evaluate(`(() => {
    document.getElementById('fireplace-close').click();
    const trigger = document.querySelector('.status-detail-trigger');
    for (let parent = trigger.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    trigger.click(); return true;
  })()`);
  await until("document.getElementById('status-detail-popover').checkVisibility()");
  await app.webAccess.apply({ ...config, token: 'synthetic-browser-rotated-admin-access-token' });
  await evaluate("window.dispatchEvent(new Event('online'));true");
  await until("document.body.dataset.authenticated === 'false' && !document.getElementById('auth').hidden");
  assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), false,
    'Expired credentials also hide an already open reading popover');
  assert.equal(await evaluate("sessionStorage.getItem('stmq-token')"), null);
  await login(family);
  assert.equal(await evaluate("document.getElementById('database-export-download').disabled"), true,
    'Returning from revoked admin to family restores restrictions');
  assert.deepEqual(errors, []);
  console.log('Access browser checks passed: password visibility, family controls, restricted downloads, firewood window, logout, admin login and credential revocation.');
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
