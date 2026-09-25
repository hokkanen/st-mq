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
const screenshotDirectory = process.env.STMQ_ACCESS_SCREENSHOT_DIR;
const layoutReport = [], layoutFailures = [];
const writes = [];
let app, browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  const configuration = join(directory, 'fixture.json');
  await writeFile(configuration, '{}');
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_INPUT: 'simulated', STMQ_PORT: '0', STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family }, directory);
  const pairing = { enabled: true, role: 'primary', canControl: true, busy: false,
    peer: { reachable: true, role: 'replica', lastSeenAt: now }, vip: { owned: true, ready: true },
    recovery: { state: 'idle' }, actions: { 'check-recovery': true, recover: false, rejoin: false, handover: true, promote: false } };
  app = await start({ config, clock: () => now, pairContext: { status: () => pairing,
    canControl: () => true, recovering: () => false,
    requestAction: () => { throw new Error('The browser fixture must never dispatch pairing operations.'); } } });
  app.server.on('request', request => { if (request.method !== 'GET' && request.method !== 'HEAD') writes.push(request.url); });
  // Only enrich display evidence. The runtime remains an isolated simulation;
  // this does not install transports or grant native device command capability.
  const originalStatus = app.engine.status.bind(app.engine);
  app.engine.status = () => {
    const status = originalStatus();
    const values = { power: 'on', mode: 'heat', targetC: 22, fan: 'auto', vane: 'auto', wideVane: 'center' };
    const choices = { power: ['on', 'off'], mode: ['heat', 'cool', 'auto', 'dry', 'fan'],
      fan: ['auto', 'quiet', 1, 2, 3, 4], vane: ['auto', 1, 2, 3, 4, 5, 'swing'],
      wideVane: ['far-left', 'left', 'center', 'right', 'far-right', 'split', 'swing'] };
    status.garage.adapter = { ...status.garage.adapter, connected: true,
      health: { deviceOnline: true, pumpCommunicating: true, driverProgressing: true },
      native: { ...values, powerAt: now, readbacks: Object.fromEntries(Object.entries(values)
        .map(([key, value]) => [key, { value, measuredAt: now }])) } };
    status.garage.nativeControls = { available: true, busy: false, pending: false,
      settings: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
        value, measuredAt: now, supported: true, usable: true, available: true,
        ...(key === 'targetC' ? { min: 8, max: 31, step: 0.5 } : { values: choices[key] }),
      }])) };
    const reading = (value, unit) => ({ value, unit, observedAt: now, stale: false });
    status.equipment = { configured: true, connected: true, devices: [
      ...(status.equipment?.devices ?? []),
      { id: 'synthetic-relay', label: 'Utility switch', area: 'home', kind: 'switch', available: true,
        controls: { switch: true }, readings: { synthetic_active: reading(0, 'state') } },
      { id: 'synthetic-cover', label: 'Garden door', area: 'home', kind: 'door', available: true,
        controls: { cover: { open: true, close: true, stop: true } }, cover: { available: true, state: 'closed' },
        readings: { synthetic_open: reading(0, 'state') } },
      { id: 'caravan', label: 'Caravan', area: 'garage', kind: 'metered_switch', available: true,
        controls: { switch: true }, readings: { caravan_active: reading(1, 'state'), caravan_power: reading(0.35, 'kW') } },
      { id: 'caravan_dehumidifier', label: 'Caravan dehumidifier', area: 'garage', kind: 'dehumidifier', available: true,
        controls: { dehumidifier: true }, readings: {}, dehumidifier: { available: true, observedAt: now, runningState: 'low',
          state: { power: 'on', mode: 'dehumidify', targetHumidity: 55, fanSpeed: 'low', swing: 'fixed_90' } } },
    ] };
    status.equipmentControls = { available: true, busy: false };
    status.providers.easee = { status: 'ok', currentReadings: { charger: { qualityIssues: [], lastSuccessAt: now },
      property: { qualityIssues: [], lastSuccessAt: now } }, localOcpp: { configured: true, connected: false, available: false,
      setup: { state: 'blocked', reason: 'foreign-configuration', endpointSource: 'configured', canAdopt: true, revision: 'a'.repeat(64) } } };
    for (const charger of status.charging.chargers) {
      charger.capabilities.scheduling = true; charger.readOnly = false;
      charger.settings.enabled = true; charger.controls = { enabled: true, revision: 1 };
      charger.identification = { available: true, active: false, phase: 'identified' };
      charger.association = `synthetic-browser-${charger.id}`;
      charger.request = { sessionId: `synthetic-session-${charger.id}`, revision: 1, overrides: {} };
      charger.values.connected = { value: true, available: true };
      charger.values.charging = { value: false, available: true };
      charger.control = { phase: 'yielded', manual: { kind: 'window', resumeAt: now + 3600_000 } };
      if (charger.id === 'charger1') {
        charger.vehicle = { state: 'identified', id: 'bmw', label: 'BMW', source: 'bmw-cardata' };
        const selected = { value: 80, source: 'bmw-cardata', measuredAt: now, receivedAt: now, readingId: 'synthetic-target' };
        charger.targetSelection = { connectedAt: now, mode: 'automatic', selected, lower: selected, raw: selected };
      }
    }
    return status;
  };
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
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async (name, selector) => {
    const geometry = await evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root || !root.checkVisibility()) return { missing: true };
      const bounds = root.getBoundingClientRect();
      const controls = [...root.querySelectorAll('input,select,button')].filter(node => node.checkVisibility()).map(node => {
        const box = node.getBoundingClientRect();
        const name = node.getAttribute('aria-label') || node.textContent.trim() || node.labels?.[0]?.textContent.trim();
        return { id: node.id, tag: node.tagName, disabled: node.disabled, name,
          x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      });
      const overflow = controls.filter(box => box.x < bounds.x - 2 || box.right > bounds.right + 2).map(box => box.id || box.tag);
      const input = document.getElementById('token').getBoundingClientRect();
      const eye = document.getElementById('password-visibility').getBoundingClientRect();
      const pairs = [
        ['h66-test-register', 'h66-test-value'], ['garage-native-setting', 'garage-native-temperature'],
        ['sensor-change-signal', 'sensor-change-reason'], ['floor-preheat-guide', 'floor-preheat-script'],
      ].flatMap(([first, second]) => {
        const left = controls.find(control => control.id === first), right = controls.find(control => control.id === second);
        if (!left || !right || right.x < left.right - 1 || Math.abs(left.y - right.y) > Math.max(left.height, right.height)) return [];
        return [{ first, second, topDifference: Math.abs(left.y - right.y) }];
      });
      const wordBreaks = [...root.querySelectorAll('button')].filter(node => node.checkVisibility()
        && /^\\w+$/.test(node.textContent.trim())).flatMap(node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), boxes = [];
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          const range = document.createRange(); range.selectNodeContents(text); boxes.push(...range.getClientRects());
        }
        return boxes.length > 1 && Math.max(...boxes.map(box => box.y)) - Math.min(...boxes.map(box => box.y)) > 5
          ? [node.id || node.textContent.trim()] : [];
      });
      const misplacedNotes = [...root.querySelectorAll('.family-access-note')].filter(node => node.checkVisibility()
        && node.closest('button,label,form,.equipment-switch-buttons,.equipment-cover-buttons,.caravan-dehumidifier-controls'))
        .map(node => node.textContent.trim());
      return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
        root: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, controls, overflow, pairs, wordBreaks, misplacedNotes,
        eye: { inline: eye.x >= input.x && eye.right <= input.right + 1 && eye.y >= input.y - 1 && eye.bottom <= input.bottom + 1,
          width: eye.width, height: eye.height, name: document.getElementById('password-visibility').getAttribute('aria-label'),
          svg: Boolean(document.querySelector('#password-visibility svg')) } };
    })()`);
    layoutReport.push({ name, selector, ...geometry });
    if (geometry.missing) layoutFailures.push(`${name}: selected panel is hidden`);
    else {
      if (geometry.pageWidth > geometry.viewport + 2) layoutFailures.push(`${name}: document overflows by ${geometry.pageWidth - geometry.viewport}px`);
      if (geometry.overflow.length) layoutFailures.push(`${name}: controls escape panel: ${geometry.overflow.join(', ')}`);
      for (const pair of geometry.pairs) if (pair.topDifference > 2)
        layoutFailures.push(`${name}: ${pair.first} and ${pair.second} differ vertically by ${pair.topDifference}px`);
      if (geometry.wordBreaks.length) layoutFailures.push(`${name}: button words split across lines: ${geometry.wordBreaks.join(', ')}`);
      if (geometry.misplacedNotes.length) layoutFailures.push(`${name}: access notes interrupt a control grid`);
      if (name.startsWith('login-') || name.startsWith('password-error-')) {
        if (!geometry.eye.inline || !geometry.eye.svg || geometry.eye.width < 43 || geometry.eye.height < 43 || !geometry.eye.name)
          layoutFailures.push(`${name}: password visibility needs an inline labeled SVG and a 44px touch target`);
      }
    }
    if (screenshotDirectory) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(screenshotDirectory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    }
  };
  const auditLayout = async role => {
    if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
    const panels = role === 'login' || role === 'password-error' ? [['login', '#auth']] : [
      ['home-controls', '#temporary-form'], ['home-pump-settings', '#h66-test-form'],
      ['sensor-changes', '#sensor-change-details'], ['garage-pump-settings', '#garage-native-form'],
      ['configuration', '.web-access-session'], ['floor-downloads', '.floor-preheat-downloads'],
      ['database-export', '#database-export-details'], ['firewood', '#fireplace-dialog'],
    ];
    for (const width of [320, 390, 768, 1440]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)});true`);
      for (const [panel, selector] of panels) {
        await evaluate(`(() => {
          for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
          for (const fold of document.querySelectorAll('details[open]')) fold.open = false;
          const root = document.querySelector(${JSON.stringify(selector)});
          for (let parent = root; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
          if (${JSON.stringify(panel)} === 'firewood') document.getElementById('fireplace-shortcut').click();
          if (${JSON.stringify(panel)} === 'garage-pump-settings') {
            const setting = document.getElementById('garage-native-setting');
            setting.value = 'targetC'; setting.dispatchEvent(new Event('change'));
          }
          if (root && root.tagName !== 'DIALOG') root.scrollIntoView({ block: 'center', behavior: 'instant' });
          return true;
        })()`);
        await settle();
        await capture(`${role}-${width}-${theme}-${panel}`, selector);
      }
    }
    await evaluate("for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); window.scrollTo(0,0);true");
    if (screenshotDirectory) await writeFile(join(screenshotDirectory, 'geometry.json'), JSON.stringify({ reports: layoutReport, failures: layoutFailures }, null, 2));
    console.log(`Layout audit captured ${role}: 4 widths × 2 themes${screenshotDirectory ? ` in ${screenshotDirectory}` : ''}.`);
  };
  const auditDynamicLayout = async role => {
    const before = writes.length;
    const panels = [
      ['equipment-switch', '#home-equipment-readings [data-device-id="synthetic-relay"]'],
      ['other-door', '#home-equipment-readings [data-device-id="synthetic-cover"]'],
      ['caravan', '#garage-equipment-readings [data-device-id="caravan"]'],
      ['pairing', '#pairing-panel'],
      ['charging', '#charger1-device'],
      ['charger-setup', '[data-provider="electricity"] .provider-local-connection'],
    ];
    for (const width of [320, 768]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)});true`);
      for (const [panel, selector] of panels) {
        await evaluate(`(() => {
          for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
          for (const fold of document.querySelectorAll('details[open]')) fold.open = false;
          const root = document.querySelector(${JSON.stringify(selector)});
          for (let parent = root; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
          if (${JSON.stringify(panel)} === 'pairing') document.getElementById('pairing-details').open = true;
          root?.scrollIntoView({ block: 'start', behavior: 'instant' }); return true;
        })()`);
        await settle();
        await capture(`${role}-${width}-${theme}-${panel}`, selector);
      }
    }
    for (const selector of ['#home-equipment-readings [data-device-id="synthetic-relay"] .equipment-switch-buttons button',
      '#home-equipment-readings [data-device-id="synthetic-cover"] [data-cover-action]', '.caravan-dehumidifier-controls button,.caravan-dehumidifier-controls select']) {
      const states = await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(node=>node.disabled)`);
      assert(states.length > 0);
      assert.equal(states.every(Boolean), role === 'family', `${role}: ${selector}`);
    }
    for (const selector of ['#pairing-check-recovery', '#pairing-handover', '.provider-local-adopt'])
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), role === 'family', `${role}: ${selector}`);
    for (const id of ['charger1-charge-now', 'charger1-enabled', 'charger1-resume', 'charger1-target-toggle', 'charger1-identify',
      'charger1-setting-readyBy', 'charger1-setting-manualSoc', 'charger1-setting-minimumSoc', 'charger1-setting-capacityKwh'])
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`), false, `${role}: EV card ${id} remains available`);
    await evaluate(`(() => {
      const field = document.getElementById('charger1-setting-readyBy'); field.value='18:45'; field.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('charger1-shared-priority').click(); return true;
    })()`);
    assert.equal(await evaluate("document.getElementById('charger1-settings-save').disabled"), false, `${role}: EV session save is available after editing`);
    assert.equal(await evaluate("document.getElementById('charging-priority-dialog').open"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('#charging-priority-dialog input')].every(node=>!node.disabled)"), true);
    await capture(`${role}-768-light-charging-priority`, '#charging-priority-dialog');
    await evaluate("document.getElementById('charging-priority-cancel').click();true");
    assert.equal(writes.length, before, 'Layout review and draft edits dispatch no control writes');
    if (screenshotDirectory) await writeFile(join(screenshotDirectory, 'geometry.json'), JSON.stringify({ reports: layoutReport, failures: layoutFailures }, null, 2));
    console.log(`Dynamic access layouts captured ${role}: equipment, doors, Caravan, pairing, EV cards and setup.`);
  };
  const auditShortLogin = async () => {
    for (const [width, height] of [[640, 360], [390, 440]]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)});document.getElementById('auth').scrollIntoView({block:'start',behavior:'instant'});true`);
      await settle();
      await capture(`login-${width}x${height}-${theme}-short`, '#auth');
      for (const selector of ['#token', '#password-visibility', '#auth button[type="submit"]']) {
        assert.equal(await evaluate(`(() => {
          const control=document.querySelector(${JSON.stringify(selector)});control.scrollIntoView({block:'center',behavior:'instant'});
          const box=control.getBoundingClientRect();return box.top>=-1&&box.bottom<=innerHeight+1;
        })()`), true, `${width}×${height}: ${selector} is reachable with scrolling`);
      }
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('token').value='example';document.getElementById('token').focus();document.getElementById('token').setSelectionRange(1,4);true");
    const point = await evaluate("(()=>{const r=document.getElementById('password-visibility').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    assert.deepEqual(await evaluate("(()=>{const field=document.getElementById('token');return [document.activeElement===field,field.value,field.selectionStart,field.selectionEnd,field.type];})()"),
      [true, 'example', 1, 4, 'text'], 'Eye pointer keeps input focus, selection and value');
    await capture('login-390-light-eye-hide-state', '#auth');
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle();
    assert.deepEqual(await evaluate("(()=>{const field=document.getElementById('token');return [document.activeElement===field,field.value,field.selectionStart,field.selectionEnd,field.type];})()"),
      [true, 'example', 1, 4, 'password'], 'Eye touch keeps input focus, selection and value');
    await evaluate("document.getElementById('token').value='';true");
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden");
  assert.equal(await evaluate("document.body.dataset.authenticated"), 'false');
  await auditLayout('login');
  await auditShortLogin();
  await evaluate("document.getElementById('password-visibility').click();true");
  assert.equal(await evaluate("document.getElementById('token').type"), 'text');
  {
    assert.equal(await evaluate("document.getElementById('password-visibility').getAttribute('aria-label')"), 'Hide password');
    assert.equal(await evaluate("document.getElementById('password-visibility').getAttribute('aria-pressed')"), 'true');
    assert.equal(await evaluate("Boolean(document.querySelector('#password-visibility svg'))"), true, 'Toggling preserves the eye icon');
    await evaluate("document.getElementById('password-visibility').focus();true");
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    assert.equal(await evaluate("document.getElementById('token').type"), 'password', 'Keyboard activation toggles visibility');
    await evaluate("document.getElementById('token').value='synthetic-incorrect-browser-password';document.getElementById('auth').requestSubmit();true");
    await until("document.getElementById('auth-error') && !document.getElementById('auth-error').hidden && !sessionStorage.getItem('stmq-token')");
    assert.match(await evaluate("document.getElementById('auth-error').textContent"), /password.*(?:not recognised|incorrect)|try again/i);
    assert.equal(await evaluate("document.body.dataset.authenticated"), 'false', 'Rejected password never reveals installation data');
    await auditLayout('password-error');
  }
  await login(family);
  assert.match(await evaluate("document.getElementById('web-access-role').textContent"), /Family/);
  assert.equal(await evaluate("document.getElementById('token').type"), 'password');
  await auditLayout('family');
  await auditDynamicLayout('family');
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
  await auditLayout('admin');
  await auditDynamicLayout('admin');
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
  assert.deepEqual(layoutFailures, [], `Layout failures${screenshotDirectory ? `; inspect ${screenshotDirectory}/geometry.json` : ''}`);
  console.log('Access browser checks passed: password visibility, family controls, restricted downloads, firewood window, logout, admin login and credential revocation.');
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
