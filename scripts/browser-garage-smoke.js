// Run after npm run build. Uses only a disposable simulated app and browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { checkDashboardDisclosures, checkDashboardLayout } from './lib/dashboard-browser-checks.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-garage-manual-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-garage-manual-screenshots-'));
const now = Date.parse('2026-09-21T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture-config.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chromium')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(directory, 'chromium', 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
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
    const result = await send('Runtime.evaluate', {
      expression: expression.includes('await ') ? `(async () => { ${expression} })()` : expression,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      if (attempt > 0 && attempt % 10 === 0) await evaluate('globalThis.garageFixture?.poll?.()');
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${errors.join(', ')}`);
  };
  const keyPress = async key => {
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], ' ': ['Space', 32], Tab: ['Tab', 9], Escape: ['Escape', 27] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const screenshot = async (name, id = 'garage-control') => {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate(`(() => {
      const box = document.getElementById('${id}').getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  // The production page handles synthetic status. Every mutation is intercepted
  // before network dispatch: no real integration can receive a browser action.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.garageFixture = { mode: 'normal', normalTargetC: 10, targetC: 10, confirmed: true,
      protection: false, uncertain: false, offline: false, readOnly: false, calls: [], reads: 0,
      protectionSettings: { version: 'garage-thermal-reserve-v1', approved: true, marginC: 1,
        pipeOutsideDiameterMm: 20, pipeWallMm: 2, heatTransferWPerM2K: 5 } };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fixture = status => {
      const f = garageFixture; f.reads++;
      status.readOnly = f.readOnly; status.input = 'providers';
      status.garage = { settings: { enabled: true }, mode: f.mode, normalTargetC: f.normalTargetC, awayTargetC: 5,
        requestedTargetC: f.targetC, effectiveTargetC: f.protection === 'active' ? 14 : f.targetC,
        targetConfirmed: f.confirmed && !f.offline, controlAvailable: !f.offline,
        controlReason: f.offline ? 'The Pill connection is unavailable.' : null,
        warmingWarning: f.warming ? { since: status.now, until: status.now + 86400000,
          message: 'The target has increased. Avoid wet or snowy vehicles and substantial moisture for roughly 24 hours, and longer if contents are still cold.' } : null,
        observations: { rear: { value: 6.5, sourceTime: status.now, receivedAt: status.now, stale: false, quality: [] },
          front: { value: 4, sourceTime: status.now, receivedAt: status.now, stale: false, quality: [] } },
        protection: { available: Boolean(f.protection), active: f.protection === 'active', status: f.protection ? 'ready' : 'unavailable',
          settingsAvailable: Boolean(f.protection) && !f.offline, settings: f.protection ? f.protectionSettings : null,
          sender: { available: Boolean(f.protection) && !f.offline },
          locations: { rear: { airC: 6.5, estimatedC: 5, remainingKjPerM: 6, uncertain: false },
            front: { airC: 4, estimatedC: 1.5, remainingKjPerM: 0, uncertain: f.uncertain } } },
        adapter: { connected: !f.offline, observedAt: status.now, health: { deviceOnline: !f.offline, pumpCommunicating: !f.offline },
          control: { sensorTemperatureC: 6.5, sensorAgeMs: 10000 },
          native: { power: 'off', mode: 'heat', targetC: 16, powerAt: status.now,
            readbacks: Object.fromEntries(Object.entries({ power: 'off', mode: 'heat', targetC: 16 }).map(([key, value]) => [key, { value, measuredAt: status.now }])) },
          telemetry: { compressorActive: { value: false, sourceTime: status.now, unit: 'boolean', supported: true, usable: true, quality: [] } } },
        nativeControls: { available: !f.offline, settings: {
          power: { available: !f.offline, usable: !f.offline, supported: true, value: 'off', values: ['on', 'off'] },
          targetC: { available: false, usable: !f.offline, supported: true, value: 16, min: 16, max: 31, step: .5,
            reason: 'Room temperature is controlled by the Pill. Use the Normal target.' } } } };
      return status;
    };
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        const body = JSON.parse(options.body); garageFixture.calls.push([path, body]);
        if (path === '/api/garage/heating') {
          const before = garageFixture.targetC;
          garageFixture.mode = body.mode;
          if (body.targetC !== undefined) garageFixture.normalTargetC = body.targetC;
          garageFixture.targetC = body.mode === 'away' ? 5 : garageFixture.normalTargetC;
          garageFixture.warming = garageFixture.targetC > before;
        } else if (path === '/api/garage/protection') garageFixture.protectionSettings = body;
        else throw new Error('Unexpected mutation blocked by synthetic browser fixture');
        return new Response(JSON.stringify(fixture(await nativeFetch('/api/status').then(r => r.json()))),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      return new Response(JSON.stringify(fixture(await response.json())), { status: response.status, headers: response.headers });
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) garageFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until(`globalThis.garageFixture?.poll && document.getElementById('garage-mode-normal-target')?.textContent === '10 °C'`);
  await checkDashboardDisclosures({ evaluate, keyPress, until });
  assert.equal(await evaluate(`document.getElementById('garage-heating-details').open`), false);
  await evaluate(`document.getElementById('garage-heating-details').open = true`);
  assert.equal(await evaluate(`document.getElementById('garage-protection-status').textContent`), 'Unavailable');
  assert.equal(await evaluate(`document.getElementById('garage-protection-marginC').value`), '');
  assert.equal(await evaluate(`document.getElementById('garage-protection-submit').disabled`), true);
  await evaluate(`document.getElementById('garage-mode-away').click()`);
  await until(`document.getElementById('garage-mode-away').getAttribute('aria-pressed') === 'true'`);
  assert.equal(await evaluate(`document.getElementById('garage-current-control').textContent`), 'Away · 5 °C');
  assert.equal(await evaluate(`document.getElementById('garage-warming-warning').hidden`), true);
  await evaluate(`document.getElementById('garage-mode-normal').focus()`); await keyPress('Enter');
  await until(`!document.getElementById('garage-warming-warning').hidden`);
  assert.match(await evaluate(`document.getElementById('garage-warming-warning').textContent`), /wet or snowy.*24 hours/);
  assert.equal(await evaluate(`document.querySelector('dialog[open]')`), null, 'No confirmation interrupts the mode selection');
  assert.equal(await evaluate(`document.getElementById('garage-native-power').textContent`), 'Off', 'Mode selection preserves native OFF');
  await evaluate(`const input = document.getElementById('garage-normal-target'); input.value = '9.5'; input.dispatchEvent(new Event('input')); input.focus(); garageFixture.poll()`);
  await pause(100);
  assert.equal(await evaluate(`document.getElementById('garage-normal-target').value`), '9.5');
  assert.equal(await evaluate(`document.activeElement.id`), 'garage-normal-target');
  await evaluate(`document.getElementById('garage-target-submit').click()`);
  await until(`document.getElementById('garage-mode-normal-target').textContent === '9.5 °C'`);
  assert.deepEqual(await evaluate(`garageFixture.calls`), [
    ['/api/garage/heating', { mode: 'away' }], ['/api/garage/heating', { mode: 'normal' }],
    ['/api/garage/heating', { mode: 'normal', targetC: 9.5 }],
  ]);
  await evaluate(`garageFixture.protection = 'active'; garageFixture.poll(); document.getElementById('garage-protection-details').open = true; document.getElementById('garage-protection-settings-details').open = true`);
  await until(`document.getElementById('garage-protection-status').textContent === 'Heating override active'`);
  assert.equal(await evaluate(`document.getElementById('garage-current-room').textContent`), '14 °C');
  assert.equal(await evaluate(`document.getElementById('garage-reserve-front').textContent`), '0 kJ/m');
  await evaluate(`document.getElementById('garage-protection-marginC').value = '1.5'; document.getElementById('garage-protection-marginC').dispatchEvent(new Event('input')); document.getElementById('garage-protection-submit').click()`);
  await until(`garageFixture.calls.length === 4`);
  assert.equal(await evaluate(`garageFixture.calls[3][0]`), '/api/garage/protection');
  assert.equal(await evaluate(`garageFixture.calls[3][1].marginC`), 1.5);
  await evaluate(`garageFixture.uncertain = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-pipe-front').textContent === 'Unavailable'`);
  for (const width of [320, 390, 768, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}')`); await pause(100);
    await checkDashboardLayout({ evaluate, width });
    const overflow = await evaluate(`(() => {
      const garage = document.getElementById('garage-control'), box = garage.getBoundingClientRect();
      return [...garage.querySelectorAll('button,input,label,p,dl')].filter(node => {
        if (!node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1;
      }).map(node => node.id || node.tagName);
    })()`);
    assert.deepEqual(overflow, [], `${width}px ${theme} controls stay within the Garage card`);
    await screenshot(`garage-${width}-${theme}`);
  }
  await evaluate(`garageFixture.offline = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-mode-away').disabled`);
  assert.equal(await evaluate(`document.getElementById('garage-pipe-rear').textContent`), 'Unavailable');
  await evaluate(`garageFixture.offline = false; garageFixture.readOnly = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-control-detail').textContent.includes('Recorded selection')`);
  assert.equal(await evaluate(`document.getElementById('garage-protection-submit').disabled`), true);
  assert.equal(await evaluate(`garageFixture.calls.length`), 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'garage-manual-browser-smoke-passed', artifacts,
    checks: ['Normal/Away keyboard and pointer changes', 'Persistent target edits and polling focus',
      'Condensation advisory without confirmation gate', 'Native OFF remains OFF', 'Missing protection stays unavailable',
      'Separate sender settings and confirmed estimates', 'Uncertain/stale estimates remain unavailable',
      '320/390/768/1440px layouts in both themes', 'Read-only controls', 'No browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
