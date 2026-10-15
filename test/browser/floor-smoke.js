// Run after npm run build. Uses only a disposable simulated app and browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { checkDashboardDisclosures } from '../../scripts/lib/dashboard-browser-checks.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-floor-manual-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-floor-manual-screenshots-'));
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
      if (attempt > 0 && attempt % 10 === 0) await evaluate('globalThis.floorFixture?.poll?.()');
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
  const screenshot = async (name, id = 'home-equipment-details') => {
    await evaluate('window.scrollTo(0, 0)');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const clip = await evaluate(`(() => {
      const box = (${id ? `document.getElementById('${id}')` : `document.querySelector('.controller-panels')`}).getBoundingClientRect();
      // A mobile element clip can make Chromium recalculate scrollbar geometry
      // while capturing beyond the viewport. Keep the original viewport width.
      return { x: innerWidth <= 768 ? 0 : box.x, y: box.y,
        width: innerWidth <= 768 ? innerWidth : box.width, height: box.height, scale: 1 };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  // The app and database are disposable simulations. Every mutation is
  // intercepted before dispatch; this suite cannot send a device command.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.floorFixture = { mask: 0, mode: null, offline: false, readOnly: false, calls: [], reads: 0, pending: false, receipts: {} };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fixture = status => {
      const f = floorFixture; f.reads++;
      status.readOnly = f.readOnly;
      status.webAccess = { ...status.webAccess, role: f.family ? 'family' : 'admin' };
      status.preheatValves = { enabled: true, commissioned: true, configured: true, integrationSupported: true,
        connected: !f.offline, available: !f.offline, manualAvailable: !f.offline && !f.pending && f.mode !== 'automatic',
        commandScope: 'synthetic-floor-device-scope', active: f.mode === 'automatic', mode: f.mode,
        manualUntil: f.mode === 'manual' ? status.now + 900000 : null,
        leaseUntil: f.mask ? status.now + 900000 : null,
        restorationPending: f.pending, manualResult: f.manualResult ?? null, reason: f.offline ? 'feedback-stale' : f.pending ? 'restoration-pending' : 'ready',
        manualReason: f.mode === 'automatic' ? 'automatic-treatment-active' : null, renewSeconds: 300, leaseSeconds: 900,
        topics: [{ role: 'Lease requests', direction: 'publish', topic: 'cmnd/sonoff4chpro/LEASE' },
          { role: 'Output feedback', direction: 'subscribe', topic: 'stat/sonoff4chpro/LEASE' },
          { role: 'Availability', direction: 'subscribe', topic: 'tele/sonoff4chpro/LWT' }],
        mqttStatus: { broker: 'primary', brokerConnected: !f.offline, subscriptionStatus: 'subscribed', lastLiveAt: status.now },
        devices: [{ group: 'groundfloor', available: !f.offline, at: status.now,
          firmwareBuild: 'Synthetic current firmware', stateEvidence: 'gpio_output_readback',
          channels: [1,2,3,4].map(id => ({ id, output: Boolean(f.mask & (1 << (id - 1))), at: status.now,
            outputEvidence: 'gpio_output_readback', quality: f.offline ? ['floor-feedback-stale'] : [],
            lastResult: f.receipts[id] ?? null, manualSelected: f.mode === 'manual' && Boolean(f.mask & (1 << (id - 1))) })) }] };
      return status;
    };
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        if (path !== '/api/equipment/floor') throw new Error('Unexpected mutation blocked by synthetic browser fixture');
        const body = JSON.parse(options.body); floorFixture.calls.push([path, body]);
        if (floorFixture.hold) await new Promise(resolve => { floorFixture.finish = resolve; });
        floorFixture.mask = body.enabled ? floorFixture.mask | (1 << (body.channel - 1)) : floorFixture.mask & ~(1 << (body.channel - 1));
        floorFixture.mode = floorFixture.mask ? 'manual' : null;
        floorFixture.manualResult = { channel: body.channel, enabled: body.enabled, at: ${now}, status: 'confirmed', confirmed: true };
        floorFixture.receipts[body.channel] = floorFixture.manualResult;
        return new Response(JSON.stringify(fixture(await nativeFetch('/api/status').then(r => r.json()))),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      return new Response(JSON.stringify(fixture(await response.json())), { status: response.status, headers: response.headers });
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) floorFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until(`globalThis.floorFixture?.poll && document.getElementById('floor-preheat-state')?.textContent === 'Ready'`);
  await checkDashboardDisclosures({ evaluate, keyPress, until });
  const root = `[data-device-id="floor-override:groundfloor"].equipment-device`;
  const on = channel => `${root} [data-floor-channel="${channel}"] [data-floor-action="on"]`;
  const release = channel => `${root} [data-floor-channel="${channel}"] [data-floor-action="release"]`;
  await evaluate(`document.getElementById('home-equipment-details').open = true; document.querySelector('${root}').open = true`);
  assert.equal(await evaluate(`document.querySelectorAll('${root} .floor-control-row').length`), 4);
  assert.equal(await evaluate(`document.querySelectorAll('${root} button[data-floor-action]').length`), 8);
  assert.match(await evaluate(`document.querySelector('${root}').textContent`), /15 minutes.*Living.*106 m.*Living.*62 m.*Storage.*38 m.*Storage.*80 m/s);
  assert.match(await evaluate(`document.querySelector('${root} .floor-output-evidence').textContent`), /GPIO.*not measured/);
  await evaluate(`document.querySelector('${on(1)}').focus(); floorFixture.hold = true`);
  await keyPress('Enter');
  await until(`floorFixture.calls.length === 1 && floorFixture.finish`);
  assert.equal(await evaluate(`document.querySelector('${on(2)}').disabled`), true, 'Pending mutation locks every competing floor action');
  await evaluate(`document.querySelector('${on(2)}').click(); floorFixture.poll()`);
  assert.equal(await evaluate(`floorFixture.calls.length`), 1);
  await evaluate(`floorFixture.hold = false; floorFixture.finish()`);
  await until(`document.querySelector('${release(1)}').disabled === false`);
  assert.match(await evaluate(`document.querySelector('${root} [data-floor-channel="1"] .floor-output-state').textContent`), /Override on/);
  assert.match(await evaluate(`document.querySelector('${root} .floor-control-scope').textContent`), /end together.*keeps this deadline/);
  const request = await evaluate('floorFixture.calls[0]');
  assert.equal(request[0], '/api/equipment/floor');
  assert.deepEqual({ ...request[1], requestId: undefined }, { channel: 1, enabled: true, durationSeconds: 900,
    scope: 'synthetic-floor-device-scope', requestId: undefined });
  assert.match(request[1].requestId, /^[a-f0-9-]{36}$/);
  await evaluate(`document.querySelector('${on(2)}').focus(); globalThis.floorFocused = document.activeElement; floorFixture.poll()`);
  await pause(150);
  assert.equal(await evaluate('document.activeElement === floorFocused && floorFocused.isConnected'), true, 'Polling preserves the actual focused button');
  assert.equal(await evaluate(`document.querySelector('${root}').open`), true, 'Polling preserves the open device fold');
  await keyPress('Enter');
  await until(`floorFixture.calls.length === 2 && document.querySelector('${release(2)}').disabled === false`);
  await evaluate(`document.querySelector('${release(1)}').click()`);
  await until(`floorFixture.calls.length === 3 && document.querySelector('${on(1)}').disabled === false`);
  assert.equal(await evaluate('floorFixture.mask'), 2, 'Releasing one channel leaves the selected peer active');
  assert.match(await evaluate(`document.querySelector('${root} [data-floor-channel="1"] .floor-output-state').textContent`), /Override off/);
  await evaluate(`document.querySelector('${root} [data-open-floor-setup]').focus()`); await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('floor-preheat-details').open && document.getElementById('connections-details').open`), true);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('#floor-preheat-details > summary')`), true);
  await evaluate(`document.querySelector('[data-open-floor-controls]').focus()`); await keyPress('Enter');
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${root} > summary')`), true);
  await evaluate(`document.querySelector('${root} [data-open-floor-setup]').click(); document.getElementById('floor-commissioning-details').open = true`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#floor-preheat-details a[href^="https://github.com/hokkanen/sonoff-"]')].map(a => a.href)`), [
    'https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/compatibility.md',
    'https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/operations.md',
    'https://github.com/hokkanen/sonoff-4chpro-mqtt',
    'https://github.com/hokkanen/sonoff-4chpro-mqtt/blob/main/docs/protocol.md',
  ]);
  assert.doesNotMatch(await evaluate(`document.getElementById('floor-preheat-details').textContent`), /integration unavailable|planned to preheat|no supported device/i);
  await evaluate(`document.getElementById('mqtt-devices-details').open = true;
    document.querySelector('#equipment-connections [data-device-id="floor-override:groundfloor"]').open = true`);
  assert.match(await evaluate(`document.querySelector('#equipment-connections [data-device-id="floor-override:groundfloor"]').textContent`), /stat\/sonoff4chpro\/LEASE.*cmnd\/sonoff4chpro\/LEASE/s);
  for (const width of [320, 390, 768, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}')`); await pause(80);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px has no horizontal page overflow`);
    for (const id of ['floor-preheat-details', 'home-equipment-details', 'mqtt-devices-details']) {
      assert.deepEqual(await evaluate(`(() => {
        const parent = document.getElementById('${id}'), box = parent.getBoundingClientRect();
        return [...parent.querySelectorAll('button, th, td, code, .floor-control-identity, .floor-control-reading')]
          .filter(node => node.checkVisibility()).filter(node => { const rect = node.getBoundingClientRect();
            return rect.left < box.left - 1 || rect.right > box.right + 1; }).map(node => node.textContent);
      })()`), [], `${width}px ${theme} ${id} content stays inside its card`);
    }
    await screenshot(`floor-home-${width}-${theme}`, 'home-equipment-details');
    await screenshot(`floor-setup-${width}-${theme}`, 'floor-preheat-details');
    if (width === 390) {
      await evaluate(`document.getElementById('home-equipment-details').scrollIntoView({block:'start'})`);
      await pause(80);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(artifacts, `floor-mobile-viewport-${theme}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await evaluate(`floorFixture.offline = true; floorFixture.poll()`);
  await until(`document.querySelector('${on(1)}').disabled && document.getElementById('floor-preheat-state').textContent === 'Needs attention'`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('${root} .floor-output-state')].map(n => n.textContent)`), ['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  assert.match(await evaluate(`document.querySelector('${root} [data-floor-channel="1"] .floor-channel-receipt').textContent`), /Release requested · GPIO confirmed/);
  assert.match(await evaluate(`document.querySelector('${root} [data-floor-channel="2"] .floor-channel-receipt').textContent`), /Override requested · GPIO confirmed/);
  for (const width of [390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await pause(80);
    await screenshot(`floor-unavailable-home-${width}`, 'home-equipment-details');
    await screenshot(`floor-unavailable-setup-${width}`, 'floor-preheat-details');
  }
  await evaluate(`floorFixture.offline = false; floorFixture.pending = true; floorFixture.poll()`);
  await until(`document.getElementById('floor-preheat-state').textContent === 'Release pending'`);
  await evaluate(`floorFixture.pending = false; floorFixture.mode = 'automatic'; floorFixture.mask = 15; floorFixture.poll()`);
  await until(`document.getElementById('floor-preheat-state').textContent === 'Preheating'`);
  assert.equal(await evaluate(`document.querySelectorAll('${root} button[data-floor-action]:not(:disabled)').length`), 0);
  assert.match(await evaluate(`document.querySelector('${root} .floor-control-scope').textContent`), /Select Normal/);
  await evaluate(`floorFixture.readOnly = true; floorFixture.poll()`);
  await until(`document.getElementById('floor-preheat-state').textContent === 'Recorded snapshot'`);
  assert.equal(await evaluate(`document.querySelectorAll('${root} button[data-floor-action]:not(:disabled)').length`), 0);
  await evaluate(`floorFixture.readOnly = false; floorFixture.mode = null; floorFixture.mask = 0; floorFixture.family = true; floorFixture.poll()`);
  await until(`document.body.dataset.accessRole === 'family' && document.getElementById('floor-preheat-state').textContent === 'Ready'`);
  assert.equal(await evaluate(`document.querySelectorAll('${root} button[data-floor-action]:not(:disabled)').length`), 0, 'Actual access gates disable every individual valve action for Family');
  assert.equal(await evaluate(`document.querySelector('${root} .floor-controls .family-access-note').checkVisibility()`), true);
  await evaluate(`document.querySelector('${on(1)}').click(); document.querySelector('${on(1)}').dispatchEvent(new MouseEvent('click', {bubbles:true}))`);
  assert.equal(await evaluate('floorFixture.calls.length'), 3, 'Family cannot invoke a floor mutation through a stale action');
  await evaluate(`floorFixture.family = false; floorFixture.poll()`);
  await until(`document.body.dataset.accessRole === 'admin' && !document.querySelector('${on(1)}').disabled`);
  assert.equal(await evaluate('floorFixture.calls.length'), 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'floor-browser-smoke-passed', artifacts,
    checks: ['Four independent bounded controls', 'Keyboard actions', 'Duplicate mutation blocked',
      'Per-channel release retains peer override', 'Focus and disclosure preserved during polling',
      'Bidirectional setup navigation', 'Sonoff references and MQTT routes',
      '320/390/768/1440px both themes', 'Stale and pending release evidence', 'Pooled/manual exclusion', 'Read-only controls', 'Real Family/Admin access gates'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
