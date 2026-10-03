// Run after npm run build. All configuration, runtime and browser data are synthetic.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-configuration-browser-'));
const screenshots = process.env.STMQ_CONFIGURATION_SCREENSHOT_DIR;
const admin = 'synthetic-browser-configuration-admin';
const family = 'synthetic-browser-configuration-family';
const now = Date.parse('2026-09-30T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [], errors = [], layouts = [], pending = new Map();
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture-config.json');
  const initial = {
    controller: { input: 'simulated', web_token: admin, web_family_token: family, max_drop_c: 1.5 },
    equipment: { devices: [] },
    garage: { enabled: false, adapter: { driver: 'shelly-cn105', stateTopic: '', telemetryTopic: '', commandTopic: '' },
      sender: { stateTopic: '', commandTopic: '' } },
    teslamate: { enabled: false },
  };
  const write = options => writeFile(configuration, JSON.stringify(options), { mode: 0o600 });
  await write(initial);
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory);
  app = await start({ config, clock: () => now, providerOptions: { automatic: false }, installSignalHandlers: false });
  app.server.on('request', request => requests.push({ method: request.method, path: request.url }));
  const reloads = () => app.store.events().filter(event => event.type === 'settings-reloaded').length;
  const applyRequests = () => requests.filter(request => request.path === '/api/settings/reload').length;
  const profile = join(directory, 'chromium');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if (await evaluate(`Boolean(document.body && (${expression}))`)) return; }
      catch (error) {
        if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error;
      }
      await pause(50);
    }
    throw new Error(`UI did not settle: ${expression}; browser exceptions: ${errors.length}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const keyPress = async key => {
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], ' ': ['Space', 32], Tab: ['Tab', 9] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const login = async credential => {
    await evaluate(`document.getElementById('token').value=${JSON.stringify(credential)};document.getElementById('auth').requestSubmit();true`);
    await until("document.body.dataset.authenticated === 'true'");
    await evaluate(`(() => {
      const root = document.getElementById('controls-details');
      for (let parent = root; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      root.scrollIntoView({block:'start',behavior:'instant'});return true;
    })()`);
  };
  const preview = async () => {
    await until("!document.getElementById('settings-reload').disabled");
    const previous = await evaluate('configurationBrowser.previewReplies');
    await evaluate("document.getElementById('settings-reload').focus();true");
    await keyPress('Enter');
    await until(`configurationBrowser.previewReplies > ${previous} && document.getElementById('settings-reload').getAttribute('aria-busy') !== 'true'`);
    await settle();
  };
  const cancel = async () => {
    const before = applyRequests();
    await evaluate("document.getElementById('settings-review-cancel').focus();true");
    await keyPress(' ');
    await until("document.getElementById('settings-review').hidden");
    assert.equal(await evaluate("document.activeElement.id"), 'settings-reload', 'Cancel restores focus to the review opener');
    assert.equal(applyRequests(), before, 'Cancel never applies configuration');
  };
  const capture = async name => {
    await evaluate("document.getElementById('settings-review').scrollIntoView({block:'start',behavior:'instant'});true");
    await settle();
    const geometry = await evaluate(`(() => {
      const panel = document.getElementById('settings-review'), box = panel.getBoundingClientRect();
      const escapes = [...panel.querySelectorAll('table,th,td,button')].filter(node => node.checkVisibility()).filter(node => {
        const bounds = node.getBoundingClientRect();return bounds.x < box.x - 2 || bounds.right > box.right + 2;
      }).map(node => node.id || node.tagName);
      const splitWords = [...panel.querySelectorAll('th,td')].filter(node => node.checkVisibility()
        && (!node.closest('thead') || node.closest('thead').getBoundingClientRect().width > 2)
        && /^(Hidden|Current|Proposed)$/.test(node.textContent.trim())).filter(node => {
        const range = document.createRange();range.selectNodeContents(node);
        const boxes = [...range.getClientRects()];
        return boxes.length > 1 && Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) > 5;
      }).map(node => node.textContent.trim());
      return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,panelWidth:box.width,
        visible:panel.checkVisibility(),escapes,splitWords};
    })()`);
    layouts.push({ name, ...geometry });
    assert.equal(geometry.visible, true, `${name}: review is visible`);
    assert(geometry.pageWidth <= geometry.viewport + 2, `${name}: document does not overflow`);
    assert.deepEqual(geometry.escapes, [], `${name}: values and buttons remain inside the review`);
    assert.deepEqual(geometry.splitWords, [], `${name}: short column labels and values stay legible`);
    for (const id of ['settings-review-apply', 'settings-review-cancel']) {
      assert.equal(await evaluate(`(() => {
        const button = document.getElementById('${id}');button.scrollIntoView({block:'center',behavior:'instant'});
        const box = button.getBoundingClientRect();return box.top >= -1 && box.bottom <= innerHeight + 1;
      })()`), true, `${name}: ${id} is reachable by scrolling`);
    }
    if (screenshots) {
      await evaluate("document.getElementById('settings-review').scrollIntoView({block:'start',behavior:'instant'});true");
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(screenshots, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
  };

  await send('Runtime.enable'); await send('Page.enable');
  // Observe real requests without replacing the preview or apply implementations.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.configurationBrowser = { previewReplies:0,statusReplies:0,preview:null };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url,location.href).pathname;
      if(path === '/api/settings/preview') {
        configurationBrowser.preview = await response.clone().json();
        configurationBrowser.previewReplies++;
      }
      if(path === '/api/status') configurationBrowser.statusReplies++;
      return response;
    };
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden");
  await login(family);
  assert.equal(await evaluate("document.getElementById('settings-reload').checkVisibility()"), false,
    'Family cannot see the admin configuration review opener');
  assert.equal(await evaluate("document.getElementById('settings-review').checkVisibility()"), false,
    'Family cannot see configuration differences');
  assert.equal(await evaluate(`fetch('/api/settings/preview',{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:'Bearer '+sessionStorage.getItem('stmq-token')},body:'{}'}).then(response=>response.status)`), 403,
    'The API also rejects family preview requests');
  assert.equal(reloads(), 0);
  await evaluate("document.getElementById('web-logout').click();true");
  await until("!document.getElementById('auth').hidden");
  await login(admin);
  assert.match(await evaluate("document.getElementById('settings-reload').textContent"), /check.*review/i);

  const applied = structuredClone(initial);
  applied.controller.max_drop_c = 0.75;
  applied.mqtt = { pw: 'synthetic-configuration-secret-never-rendered' };
  applied.geoloc = { latitude: '10', longitude: '20' };
  const originalEngine = app.engine;
  await write(applied);
  const originalFile = await readFile(configuration, 'utf8');
  await preview();
  assert.equal(await evaluate("document.getElementById('settings-review').checkVisibility()"), true);
  assert.equal(await evaluate('document.activeElement.id'), 'settings-review-title', 'Keyboard preview moves focus to the review heading');
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'settings-review-cancel', 'Tab reaches Cancel from the review heading');
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'settings-review-apply', 'Tab reaches the explicit application action');
  const review = await evaluate('configurationBrowser.preview');
  assert.equal(review.valid, true);
  assert.equal(review.canApply, true);
  assert(review.changes.some(change => change.path === 'controller.max_drop_c' && change.before === 1.5 && change.after === 0.75));
  assert(review.changes.some(change => change.path === 'mqtt.pw' && change.redacted === true));
  assert.equal(review.changes.filter(change => change.path.startsWith('geoloc.')).length, 2);
  assert(review.changes.filter(change => change.path.startsWith('geoloc.')).every(change => change.redacted === true),
    'Coordinate values are masked in the preview response');
  assert.doesNotMatch(await evaluate("document.getElementById('settings-review').textContent"), /synthetic-configuration-secret-never-rendered/);
  assert.equal(app.engine, originalEngine, 'Preview preserves the running engine');
  assert.equal(app.engine.settings.comfort.maxDropC, 1.5);
  assert.equal(reloads(), 0, 'Preview writes no configuration application event');
  assert.equal(await readFile(configuration, 'utf8'), originalFile, 'Preview preserves the source file');

  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)});true`);
    await capture(`review-${width}-${theme}`);
  }
  await evaluate("document.getElementById('settings-review-apply').focus();configurationBrowser.row = document.querySelector('#settings-review-changes tr');true");
  const polls = await evaluate('configurationBrowser.statusReplies');
  await evaluate("window.dispatchEvent(new Event('online'));true");
  await until(`configurationBrowser.statusReplies > ${polls}`);
  await settle();
  assert.equal(await evaluate('document.activeElement.id'), 'settings-review-apply', 'Status polling preserves keyboard focus');
  assert.equal(await evaluate("configurationBrowser.row === document.querySelector('#settings-review-changes tr')"), true,
    'Status polling preserves the reviewed difference rows');
  await keyPress('Enter');
  await until("document.getElementById('settings-review').hidden && /applied/i.test(document.getElementById('settings-reload-message').textContent)");
  assert.equal(app.engine.settings.comfort.maxDropC, 0.75, 'Explicit approval applies the reviewed candidate');
  assert.equal(reloads(), 1);
  assert.equal(await readFile(configuration, 'utf8'), originalFile, 'Applying a local file does not rewrite it');
  assert.equal(await evaluate('document.activeElement.id'), 'settings-reload', 'Application restores keyboard focus');

  const cancelled = structuredClone(applied); cancelled.controller.max_drop_c = 0.5;
  await write(cancelled);
  await preview();
  await cancel();
  assert.equal(app.engine.settings.comfort.maxDropC, 0.75, 'Cancel leaves running settings intact');
  assert.equal(reloads(), 1);

  await writeFile(configuration, '{"private":"synthetic-malformed-secret" BROKEN', { mode: 0o600 });
  await preview();
  assert.equal(await evaluate("document.getElementById('settings-review').hidden"), true);
  assert.match(await evaluate("document.getElementById('settings-reload-message').textContent"), /read|valid|JSON/i);
  assert.doesNotMatch(await evaluate("document.getElementById('settings-reload-message').textContent"), /synthetic-malformed-secret|fixture-config/);
  assert.equal(app.engine.settings.comfort.maxDropC, 0.75);

  await write(cancelled);
  await preview();
  const stale = structuredClone(applied); stale.controller.max_drop_c = 0.25;
  await write(stale);
  await evaluate("document.getElementById('settings-review-apply').click();true");
  await until("/changed|stale|review again/i.test(document.getElementById('settings-reload-message').textContent)");
  assert.equal(app.engine.settings.comfort.maxDropC, 0.75, 'A stale approval cannot apply the replacement candidate');
  assert.equal(reloads(), 1);

  await write(applied);
  await preview();
  assert.equal(await evaluate('configurationBrowser.preview.changes.length'), 0);
  assert.equal(await evaluate("document.getElementById('settings-review-apply').disabled"), false,
    'An unchanged reviewed configuration retains the explicit reconnect action');
  assert.match(await evaluate("document.getElementById('settings-review-summary').textContent"), /no.*change|already|unchanged/i);
  await cancel();

  const restart = structuredClone(applied); restart.controller.input = 'offline';
  await write(restart);
  await preview();
  assert.equal(await evaluate('configurationBrowser.preview.canApply'), false);
  assert.equal(await evaluate('configurationBrowser.preview.restartRequired.length > 0'), true);
  assert.equal(await evaluate("document.getElementById('settings-review-apply').disabled"), true);
  assert.match(await evaluate("document.getElementById('settings-review-restart').textContent"), /input|restart/i);
  await capture('restart-required');
  await cancel();
  assert.equal(app.engine.config.input, 'simulated');
  assert.equal(reloads(), 1);

  // An existing administrator review must disappear when the next session is family.
  await write(cancelled);
  await preview();
  await evaluate("document.getElementById('web-logout').click();true");
  await until("!document.getElementById('auth').hidden");
  await login(family);
  assert.equal(await evaluate("document.getElementById('settings-review').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('settings-reload').checkVisibility()"), false);
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  if (screenshots) await writeFile(join(screenshots, 'geometry.json'), JSON.stringify(layouts, null, 2));
  console.log(`Configuration browser checks passed: admin review/apply, redaction, invalid JSON, stale review, unchanged settings, restart gating, cancel, role changes, polling focus and 320/390/1440px in both themes.${screenshots ? ` Synthetic screenshots: ${screenshots}` : ''}`);
} finally {
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
