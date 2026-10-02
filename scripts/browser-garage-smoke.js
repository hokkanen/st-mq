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
      const box = (${id ? `document.getElementById('${id}')` : `document.querySelector('.controller-panels')`}).getBoundingClientRect();
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
      configurationStatus: 'confirmed', rescue: false, minimumC: 14,
      configuredProtectionSettings: { version: 'garage-thermal-reserve-v1', approved: true, marginC: 1,
        pipeOutsideDiameterMm: 20, pipeWallMm: 2, heatTransferWPerM2K: 5 } };
    garageFixture.protectionSettings = { ...garageFixture.configuredProtectionSettings };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fixture = status => {
      const f = garageFixture; f.reads++;
      status.readOnly = f.readOnly; status.input = 'providers';
      status.garage = { settings: { enabled: true }, mode: f.mode, normalTargetC: f.normalTargetC, awayTargetC: 5,
        requestedTargetC: f.targetC, effectiveTargetC: f.fallback ? 16 : f.protection === 'active' ? Math.max(f.targetC, f.minimumC) : f.targetC,
        targetConfirmed: f.confirmed && !f.offline, controlAvailable: !f.offline,
        controlReason: f.offline ? 'The heat-pump controller connection is unavailable.' : null,
        warmingWarning: f.warming ? { since: status.now, until: status.now + 86400000,
          message: 'The target has increased. Avoid wet or snowy vehicles and substantial moisture for roughly 24 hours, and longer if contents are still cold.' } : null,
        observations: { rear: { value: 6.5, sourceTime: status.now, receivedAt: status.now, stale: false, quality: [] },
          front: { value: 4, sourceTime: status.now, receivedAt: status.now, stale: false, quality: [] } },
        protection: { available: Boolean(f.protection) && !f.offline, active: f.protection === 'active' && !f.offline, status: f.protection ? 'ready' : 'unavailable',
          configuredSettings: f.configuredProtectionSettings,
          settings: f.protection && !f.offline ? f.protectionSettings : null,
          configuration: { status: f.protection && !f.offline ? f.configurationStatus : 'unknown', attempts: 0,
            reason: f.protection && !f.offline ? f.configurationReason ?? null : 'Waiting for fresh protection sender status.' },
          sender: { available: Boolean(f.protection) && !f.offline,
            protection: { available: Boolean(f.protection) && !f.offline, active: f.protection === 'active',
              minTargetC: f.minimumC, reason: f.uncertain ? 'pipe-history-uncertain' : 'pipe-reserve-low' } },
          locations: { rear: { airC: 6.5, estimatedC: 5, remainingKjPerM: 6, uncertain: false },
            front: { airC: 4, estimatedC: 1.5, remainingKjPerM: 0, uncertain: f.uncertain } } },
        adapter: { connected: !f.offline, observedAt: status.now, health: { deviceOnline: !f.offline, pumpCommunicating: !f.offline },
          control: { sensorTemperatureC: 7.2, sensorAgeMs: f.sensorAgeMs ?? 10000,
            status: f.fallback ? 'frost-unavailable' : f.rescue ? 'frost-rescue' : 'active',
            frostConfigured: Boolean(f.protection) || Boolean(f.fallback), frostAvailable: Boolean(f.protection) && !f.offline,
            frostActive: f.protection === 'active', frostRescue: f.rescue },
          native: { power: 'off', mode: 'heat', targetC: 16, powerAt: status.now,
            readbacks: Object.fromEntries(Object.entries({ power: 'off', mode: 'heat', targetC: 16 }).map(([key, value]) => [key, { value, measuredAt: status.now }])) },
          telemetry: { compressorActive: { value: false, sourceTime: status.now, unit: 'boolean', supported: true, usable: true, quality: [] } } },
        nativeControls: { available: !f.offline, settings: {
          power: { available: !f.offline, usable: !f.offline, supported: true, value: 'off', values: ['on', 'off'] },
          targetC: { available: false, usable: !f.offline, supported: true, value: 16, min: 16, max: 31, step: .5,
            reason: 'Local room regulation is enabled. Use the Normal target.' } } } };
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
        } else throw new Error('Unexpected mutation blocked by synthetic browser fixture');
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
  assert.equal(await evaluate(`(() => {
    const summary = document.querySelector('#garage-manual-controls .heating-summary');
    return summary.querySelectorAll(':scope > .heating-summary-reading').length === 3
      && ['garage-heating-operation', 'garage-current-room', 'garage-protection-summary'].every(id =>
        summary.contains(document.getElementById(id)) && document.getElementById(id).checkVisibility())
      && Boolean(summary.compareDocumentPosition(document.getElementById('garage-target-details')) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !summary.contains(document.getElementById('garage-regulation-temperature'));
  })()`), true, 'Garage exposes operation, effective target and protection before the optional controls');
  assert.equal(await evaluate(`document.getElementById('garage-heating-operation').textContent`), 'Idle',
    'Selected heating mode does not imply the compressor is running');
  assert.equal(await evaluate(`document.getElementById('garage-protection-summary').textContent`), 'Unavailable');
  assert.doesNotMatch(await evaluate(`document.getElementById('garage-manual-controls').textContent`), /Bluetooth room sensor/i);
  for (const [id, evidence] of [['garage-heating-operation', /compressor/i],
    ['garage-current-room', /control target.*not measured room temperature/i],
    ['garage-protection-summary', /unavailable.*temperature.*alone/i]]) {
    await evaluate(`document.querySelector('#${id} .status-detail-trigger').focus()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.querySelector('#${id} .status-detail-trigger').getAttribute('aria-expanded')`), 'true');
    assert.match(await evaluate(`document.getElementById('status-detail-popover').textContent`), evidence,
      `${id} explains its evidence by keyboard`);
    await keyPress('Escape');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('#${id} .status-detail-trigger')`), true);
  }
  await evaluate(`document.getElementById('home-heat-pump-details').open = true`);
  await screenshot('home-garage-1440-dark', null);
  await evaluate(`document.getElementById('home-heat-pump-details').open = false`);
  await evaluate(`for (const id of ['garage-equipment-details', 'garage-controller-details', 'garage-readings-details'])
    document.getElementById(id).open = true`);
  assert.equal(await evaluate(`document.getElementById('garage-regulation-temperature').checkVisibility()`), true);
  assert.equal(await evaluate(`document.getElementById('garage-regulation-temperature').textContent`), '7.2 °C');
  assert.equal(await evaluate(`document.getElementById('garage-temperature').textContent`), '6.5 °C',
    'The controller regulation input does not replace the independent rear observation');
  await evaluate(`document.querySelector('#garage-regulation-temperature .status-detail-trigger').focus()`);
  await keyPress('Enter');
  assert.match(await evaluate(`document.getElementById('status-detail-popover').textContent`),
    /different source.*not an independent room measurement/i);
  await keyPress('Escape');
  await evaluate(`garageFixture.sensorAgeMs = 180000; garageFixture.poll()`);
  await until(`document.getElementById('garage-regulation-temperature').textContent === 'Unavailable'`);
  assert.equal(await evaluate(`document.getElementById('garage-temperature').textContent`), '6.5 °C',
    'An expired regulation input does not invalidate the separate current rear reading');
  await evaluate(`delete garageFixture.sensorAgeMs; garageFixture.poll();
    for (const id of ['garage-equipment-details', 'garage-controller-details', 'garage-readings-details'])
      document.getElementById(id).open = false`);
  assert.equal(await evaluate(`document.getElementById('garage-protection-status').textContent`), 'Unavailable');
  assert.deepEqual(await evaluate(`(() => {
    const fold = document.getElementById('garage-protection-details');
    return [Boolean(fold.closest('#garage-control')), fold.previousElementSibling.id, fold.querySelector(':scope > summary > span').textContent];
  })()`), [true, 'garage-target-details', 'Freeze protection'],
  'Live freeze protection follows Normal temperature in Garage');
  assert.deepEqual(await evaluate(`(() => {
    const fold = document.getElementById('garage-protection-configuration-details');
    return [fold.parentElement.id, fold.previousElementSibling.id, fold.querySelector(':scope > summary > span').textContent];
  })()`), ['connections-details', 'floor-preheat-details', 'Garage freeze protection'],
  'Pipe details and setup have their own configuration fold below Floor preheating');
  await evaluate(`document.querySelector('#garage-protection-details > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('garage-protection-details').open
    && document.getElementById('garage-protection-rear').checkVisibility()
    && document.getElementById('garage-protection-front').checkVisibility()
    && !document.getElementById('connections-details').open`), true,
  'The Garage fold exposes both locations independently of settings');
  await evaluate(`document.querySelector('#garage-protection-details [data-open-garage-protection]').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('connections-details').open
    && document.getElementById('garage-protection-configuration-details').open
    && document.activeElement === document.querySelector('#garage-protection-configuration-details > summary')
    && location.hash === '#garage-protection-configuration-details'`), true,
  'The Garage settings link opens its destination and ancestors and moves keyboard focus');
  await evaluate(`document.getElementById('garage-heating-details').open = false;
    document.getElementById('garage-protection-details').open = false;
    document.querySelector('#garage-protection-configuration-details [data-open-garage-protection]').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('garage-heating-details').open
    && document.getElementById('garage-protection-details').open
    && document.activeElement === document.querySelector('#garage-protection-details > summary')
    && location.hash === '#garage-protection-details'`), true,
  'The return link reveals live protection and restores keyboard focus in Garage');
  for (const id of ['garage-protection-configuration-details', 'garage-protection-details']) {
    await evaluate(`document.getElementById('${id}').open = false; location.hash = '${id}'`);
    await until(`document.getElementById('${id}').open
      && document.activeElement === document.querySelector('#${id} > summary')`);
  }
  await evaluate(`document.querySelector('#garage-protection-setup-details > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('garage-protection-setup-details').open`), true,
    'Sender setup opens by keyboard');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#garage-protection-setup-details a'), link => link.href)`), [
    'https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/sender.md',
    'https://github.com/hokkanen/shelly-cn105-mqtt/blob/main/docs/installation.md',
    'https://github.com/hokkanen/shelly-cn105-mqtt',
  ]);
  await evaluate(`
    document.getElementById('garage-protection-settings-details').open = true; garageFixture.poll()`);
  assert.equal(await evaluate(`document.querySelectorAll('#garage-protection-settings-details input, #garage-protection-settings-details select, #garage-protection-settings-details button, #garage-protection-settings-details form').length`), 0,
    'Protection installation parameters have no dashboard editing controls');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#garage-protection-parameters thead th'), node => node.textContent.trim())`),
    ['Parameter', 'Configured', 'Reported']);
  assert.equal(await evaluate(`document.querySelectorAll('#garage-protection-parameters tbody tr').length`), 5);
  assert.match(await evaluate(`document.getElementById('garage-protection-configured-approved').textContent`), /^Approved$/);
  for (const [key, value] of [['marginC', 1], ['pipeOutsideDiameterMm', 20], ['pipeWallMm', 2], ['heatTransferWPerM2K', 5]]) {
    assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-configured-${key}').textContent`)), value,
      `Configured ${key} remains visible without a protection sender`);
    assert.match(await evaluate(`document.getElementById('garage-protection-reported-${key}').textContent`), /Unavailable/);
  }
  assert.match(await evaluate(`document.getElementById('garage-protection-reported-approved').textContent`), /Unavailable/);
  assert.match(await evaluate(`document.getElementById('garage-protection-settings-status').textContent`), /Waiting for fresh/);
  assert.match(await evaluate(`document.getElementById('garage-protection-settings-details').textContent`), /config/i);
  assert.deepEqual(await evaluate(`garageFixture.calls`), [], 'Opening and refreshing installation parameters sends no commands');
  await evaluate(`document.getElementById('garage-protection-details').open = false;
    document.getElementById('connections-details').open = false`);
  await evaluate(`garageFixture.confirmed = false; document.getElementById('garage-mode-away').click()`);
  await until(`document.getElementById('garage-mode-away').getAttribute('aria-pressed') === 'true'`);
  assert.equal(await evaluate(`document.getElementById('garage-current-room').textContent`), '5 °C');
  assert.equal(await evaluate(`document.getElementById('garage-mode-away-target').textContent`), '5 °C');
  assert.match(await evaluate(`document.getElementById('garage-heating-message').textContent`),
    /Away selected.*Waiting for heat-pump controller confirmation/);
  await evaluate(`garageFixture.confirmed = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-heating-message').textContent.includes('Confirmed by the heat-pump controller')`);
  assert.doesNotMatch(await evaluate(`document.getElementById('garage-heating-message').textContent`), /Waiting/);
  assert.equal(await evaluate(`document.getElementById('garage-warming-warning').hidden`), true);
  await evaluate(`document.getElementById('garage-mode-normal').focus()`); await keyPress('Enter');
  await until(`!document.getElementById('garage-warming-warning').hidden`);
  assert.match(await evaluate(`document.getElementById('garage-warming-warning').textContent`), /wet or snowy.*24 hours/);
  assert.equal(await evaluate(`document.querySelector('dialog[open]')`), null, 'No confirmation interrupts the mode selection');
  assert.equal(await evaluate(`document.getElementById('garage-native-power').textContent`), 'Off', 'Mode selection preserves native OFF');
  await evaluate(`document.getElementById('garage-target-details').open = true`);
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
  await evaluate(`garageFixture.protection = 'ready'; garageFixture.configuredProtectionSettings.approved = false;
    garageFixture.protectionSettings.approved = false; garageFixture.poll();
    document.getElementById('connections-details').open = true;
    document.getElementById('garage-protection-details').open = true;
    document.getElementById('garage-protection-configuration-details').open = true;
    document.getElementById('garage-protection-settings-details').open = true`);
  await until(`document.getElementById('garage-protection-reported-approved').textContent !== 'Unavailable'`);
  for (const owner of ['configured', 'reported']) assert.match(
    await evaluate(`document.getElementById('garage-protection-${owner}-approved').textContent`), /^(Not approved|Unapproved)$/,
    'Explicit false approval is distinct from unavailable readback');
  await evaluate(`garageFixture.protection = 'active'; garageFixture.configuredProtectionSettings.approved = true;
    garageFixture.protectionSettings.approved = true; garageFixture.configuredProtectionSettings.marginC = 1.5;
    garageFixture.configurationStatus = 'mismatch';
    garageFixture.configurationReason = 'The protection sender reports different values. Configuration remains the source of these parameters.';
    garageFixture.poll()`);
  await until(`document.getElementById('garage-protection-status').textContent === 'Minimum target active'`);
  assert.equal(await evaluate(`document.getElementById('garage-protection-summary').textContent`), 'Minimum target active');
  assert.equal(await evaluate(`document.getElementById('garage-current-room').textContent`), '14 °C');
  assert.equal(await evaluate(`document.getElementById('garage-reserve-front').textContent`), '0 kJ/m');
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-configured-marginC').textContent`)), 1.5);
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-reported-marginC').textContent`)), 1);
  assert.match(await evaluate(`document.getElementById('garage-protection-settings-status').textContent`), /reports different values/);
  await evaluate(`garageFixture.protectionSettings = { ...garageFixture.configuredProtectionSettings };
    garageFixture.configurationStatus = 'confirmed';
    garageFixture.configurationReason = 'Configuration confirmed by the protection sender.';
    garageFixture.poll()`);
  await until(`document.getElementById('garage-protection-settings-status').textContent.includes('Configuration confirmed')`);
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-reported-marginC').textContent`)), 1.5);
  assert.equal(await evaluate(`garageFixture.calls.length`), 3, 'Readback updates never issue parameter writes');
  await evaluate(`garageFixture.uncertain = true; garageFixture.rescue = true;
    garageFixture.normalTargetC = 8; garageFixture.targetC = 8; garageFixture.minimumC = 5; garageFixture.poll()`);
  await until(`document.getElementById('garage-pipe-front').textContent === 'Unavailable'
    && document.getElementById('garage-protection-status').textContent === 'Heat/On rescue'`);
  assert.equal(await evaluate(`document.getElementById('garage-protection-summary').textContent`), 'Heat/On rescue');
  for (const [id, target] of [['selected', '8 °C'], ['minimum', '5 °C'], ['effective', '8 °C']])
    assert.equal(await evaluate(`document.getElementById('garage-protection-${id}-target').textContent`), target);
  assert.equal(await evaluate(`document.getElementById('garage-current-room').textContent`), '8 °C');
  assert.match(await evaluate(`document.getElementById('garage-protection-detail').textContent`), /Heat.*On/i);
  assert.match(await evaluate(`document.getElementById('garage-protection-reason').textContent`), /history.*uncertain/i);
  await evaluate(`document.querySelector('#garage-protection-operation-details > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('garage-protection-operation-details').open`), true);
  assert.match(await evaluate(`document.getElementById('garage-protection-operation-details').textContent`), /8 °C selected.*5 °C minimum.*8 °C room target/);
  assert.match(await evaluate(`document.getElementById('garage-protection-operation-details').textContent`), /ten minutes.*powered on/s);
  for (const width of [320, 390, 768, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}')`); await pause(100);
    await checkDashboardLayout({ evaluate, width });
    const overflow = await evaluate(`(() => {
      const garage = document.getElementById('garage-control'), box = garage.getBoundingClientRect();
      return [...garage.querySelectorAll('button,input,label,p,dl,table,th,td,.heating-summary-reading')].filter(node => {
        if (!node.getClientRects().length) return false;
        const rect = node.getBoundingClientRect(); return rect.left < box.left - 1 || rect.right > box.right + 1;
      }).map(node => node.id || node.tagName);
    })()`);
    assert.deepEqual(overflow, [], `${width}px ${theme} controls stay within the Garage card`);
    for (const id of ['garage-protection-details', 'garage-protection-configuration-details'])
      assert.equal(await evaluate(`(() => {
        const panel = document.getElementById('${id}'), box = panel.getBoundingClientRect();
        return panel.checkVisibility() && [...panel.querySelectorAll('summary,p,dl,table,th,td,a,code,h4,h5')]
          .filter(node => node.checkVisibility()).every(node => [...node.getClientRects()]
            .every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1));
      })()`), true, `${width}px ${theme} keeps ${id} content inside its fold`);
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#garage-heating-state > .heating-summary-reading')];
      return rows.length === 3 && rows.every(row => row.scrollWidth <= row.clientWidth + 1);
    })()`), true, `${width}px ${theme} keeps the three heating readings unclipped`);
    await screenshot(`garage-${width}-${theme}`);
    await screenshot(`garage-freeze-protection-${width}-${theme}`, 'garage-protection-details');
    await screenshot(`garage-freeze-setup-${width}-${theme}`, 'garage-protection-configuration-details');
  }
  await evaluate(`garageFixture.protection = false; garageFixture.fallback = true; garageFixture.rescue = false; garageFixture.poll()`);
  await until(`document.getElementById('garage-protection-status').textContent === 'Fallback heating'`);
  assert.match(await evaluate(`document.getElementById('garage-protection-effective-target').textContent`), /16 °C.*native fallback/);
  assert.equal(await evaluate(`document.getElementById('garage-protection-selected-target').textContent`), '8 °C');
  await evaluate(`garageFixture.fallback = false; garageFixture.protection = 'active'; garageFixture.offline = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-mode-away').disabled`);
  assert.equal(await evaluate(`document.getElementById('garage-pipe-rear').textContent`), 'Unavailable');
  assert.equal(await evaluate(`document.getElementById('garage-heating-operation').textContent`), 'Unknown',
    'A lost pump connection never presents stale idle feedback as current');
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-configured-marginC').textContent`)), 1.5);
  assert.match(await evaluate(`document.getElementById('garage-protection-reported-marginC').textContent`), /Unavailable/,
    'Stale readback never replaces configured parameters or looks freshly confirmed');
  await evaluate(`garageFixture.offline = false; garageFixture.readOnly = true; garageFixture.poll()`);
  await until(`document.getElementById('garage-control-detail').textContent.includes('Recorded selection')`);
  assert.equal(await evaluate(`document.querySelectorAll('#garage-protection-settings-details input, #garage-protection-settings-details select, #garage-protection-settings-details button, #garage-protection-settings-details form').length`), 0);
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-configured-marginC').textContent`)), 1.5);
  assert.equal(Number.parseFloat(await evaluate(`document.getElementById('garage-protection-reported-marginC').textContent`)), 1.5);
  assert.equal(await evaluate(`garageFixture.calls.length`), 3);
  assert.doesNotMatch(await evaluate(`document.getElementById('garage-control').textContent`), /\b(?:Pill|Gen\s?[34])\b/i);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'garage-manual-browser-smoke-passed', artifacts,
    checks: ['Normal/Away keyboard and pointer changes', 'Away confirmation replaces pending feedback after polling', 'Persistent target edits and polling focus',
      'Condensation advisory without confirmation gate', 'Native OFF remains OFF', 'Missing protection stays unavailable',
      'Three concise heating readings and keyboard evidence', 'Distinct rear observation and expiring controller regulation input',
      'Read-only configured and reported installation parameters', 'Missing, false, mismatching and confirmed sender readback',
      'Live protection below Normal temperature and separate setup below Floor preheating',
      'Bidirectional keyboard links and hash navigation', 'Generic device roles with a tested sender example',
      '8 °C selected / 5 °C minimum rescue keeps the target at 8 °C', 'Separate native 16 °C fallback',
      'Uncertain/stale estimates remain unavailable',
      '320/390/768/1440px layouts in both themes', 'Read-only controls', 'No browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
