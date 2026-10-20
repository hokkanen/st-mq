// Isolated simulation and browser profile; never opens household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { addFireplace } from '../../src/app/fireplace.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-access-browser-'));
const admin = 'synthetic-browser-admin-access-token';
const family = 'synthetic-browser-family-access-token';
const now = Date.parse('2026-09-25T12:00:00Z');
const screenshotDirectory = process.env.STMQ_ACCESS_SCREENSHOT_DIR;
const layoutReport = [], layoutFailures = [];
const writes = [];
let app, browser, socket, sequence = 0, dashboardUnavailable = false, pairingUnavailable = false, heldLoginRequest, rememberRequests = 0;
const pending = new Map(), errors = [];
try {
  const configuration = join(directory, 'fixture.json');
  await writeFile(configuration, '{}');
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_INPUT: 'simulated', STMQ_PORT: '0', STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family }, directory);
  config.topology = 'pair'; // Synthetic pairContext below owns authority; no peer transport starts.
  config.web.httpsHost = '127.0.0.1'; config.web.httpsPort = 0;
  const pair = { role: 'master', canControl: true, busy: false,
    peer: { reachable: true, role: 'slave', lastSeenAt: now }, vip: { owned: true, ready: true },
    recovery: { state: 'idle' }, reset: { token: 'b'.repeat(64) }, actions: { 'check-recovery': true, recover: false, rejoin: false, handover: true, promote: false, reset: true } };
  app = await start({ config, clock: () => now, pairContext: { status: () => {
    if (pairingUnavailable) throw new Error('Synthetic pairing status failure');
    return pair;
  }, canControl: () => pair.canControl, recovering: () => false,
    requestAction: () => { throw new Error('The browser fixture must never dispatch pairing operations.'); } } });
  app.server.on('request', request => { if (request.method !== 'GET' && request.method !== 'HEAD') writes.push(request.url); });
  // Only enrich display evidence. The runtime remains an isolated simulation;
  // this does not install transports or grant native device command capability.
  const originalStatus = app.engine.status.bind(app.engine);
  app.engine.status = () => {
    if (dashboardUnavailable) throw new Error('Unsupported voltage estimate state; start a fresh development database');
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
        mqttStatus: { subscriptionStatus: 'subscribed', lastLiveAt: now },
        controls: { dehumidifier: true }, readings: {}, dehumidifier: { available: true, observedAt: now, runningState: 'on',
          capabilities: { power: ['off', 'on'], targetHumidity: [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80], fanSpeed: ['low', 'medium', 'high'] },
          temperatureControl: { configured: true, enabled: true, canEdit: true, offAtC: 1, onAtC: 2,
            recording: false, qualified: false, reason: 'power-test-failed', humidity: 63, applianceHumidity: 40,
            locationTest: { status: 'failed', phase: null, reason: 'power-test-failed', minimumPowerChangeW: 3, powerRiseW: 0, powerFallW: 0 } },
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
        const raw = { value: 80, measuredAt: now, receivedAt: now, readingId: 'synthetic-target' };
        charger.targetSelection = { connectedAt: now, conflict: false, selected: { ...raw, source: 'bmw-cardata' }, lower: raw, raw };
      }
    }
    return status;
  };
  addFireplace(app.store, 'simulated', { requestId: 'synthetic-browser-old-firewood', kg: 2 }, now - 16 * 60_000);
  const profile = join(directory, 'browser');
  const fixtureHostname = 'remembered-login.fixture.invalid';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', `/CN=${fixtureHostname}`,
    '-addext', `subjectAltName=DNS:${fixtureHostname}`], { stdio: 'ignore' });
  const cert = await readFile(join(directory, 'cert.pem')), key = await readFile(join(directory, 'key.pem'));
  const pin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  await app.webAccess.installCertificate({ hostname: fixtureHostname, cert, key });
  assert(app.webAccess.httpsServer?.listening, 'Isolated HTTPS fixture is listening');
  app.webAccess.httpsServer.on('request', request => { if (request.url === '/api/session/remember') rememberRequests++; });
  await mkdir(profile);
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    `--host-resolver-rules=MAP ${fixtureHostname} 127.0.0.1`, `--ignore-certificate-errors-spki-list=${pin}`,
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
    else if (message.method === 'Fetch.requestPaused') heldLoginRequest = message.params;
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
        ['sensor-change-signal', 'sensor-change-reason'],
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
      ['caravan-settings', '.caravan-policy-details'],
      ['caravan-recording', '.caravan-recording-details'],
      ['pairing', '#pairing-panel'],
      ['charging', '#charger1-device'],
      ['charger-setup', '#charging-setup-ocpp .provider-local-connection'],
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
      '#home-equipment-readings [data-device-id="synthetic-cover"] [data-cover-action]', '.caravan-dehumidifier-controls button,.caravan-dehumidifier-controls select',
      '.caravan-temperature-control input,.caravan-temperature-control button']) {
      const states = await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(node=>node.disabled)`);
      assert(states.length > 0);
      assert.equal(states.every(Boolean), role === 'family', `${role}: ${selector}`);
    }
    for (const selector of ['#pairing-history-recovery', '#pairing-handover', '#pairing-reset', '.provider-local-adopt']) {
      const control = await evaluate(`(() => {const node = document.querySelector(${JSON.stringify(selector)});
        return {exists: Boolean(node), disabled: node?.disabled};})()`);
      assert.equal(control.exists, true, `${role}: ${selector} is mounted`);
      assert.equal(control.disabled, role === 'family', `${role}: ${selector}`);
    }
    if (role === 'family') {
      await evaluate("document.getElementById('pairing-reset').dispatchEvent(new MouseEvent('click', { bubbles: true })); true");
      assert.equal(await evaluate("document.getElementById('pairing-reset-dialog').open"), false, 'Family synthetic clicks cannot open reset');
    } else {
      await evaluate("document.getElementById('pairing-reset').click(); true");
      assert.equal(await evaluate("document.getElementById('pairing-reset-dialog').open"), true, 'Admin can review reset choices');
      assert.equal(await evaluate("document.getElementById('pairing-reset-keep').disabled"), false);
      assert.equal(await evaluate("document.getElementById('pairing-reset-fresh').disabled"), true, 'Consent is required even for admin');
      await evaluate("document.getElementById('pairing-reset-cancel').click(); true");
    }
    for (const id of ['charger1-charge-now', 'charger1-enabled', 'charger1-setting-readyBy-choose', 'charger1-identify',
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
  assert.equal(await evaluate("document.getElementById('remember-login-option').checkVisibility()"), false, 'HTTP has no remembered-login row or spacing');
  assert.equal(await evaluate("document.getElementById('remember-login').disabled"), true, 'HTTP cannot focus or submit the hidden option');
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
  for (const id of ['database-export-download', 'database-export-save', 'settings-reload', 'floor-preheat-guide'])
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

  // A fresh document has never received /api/status, so pairing must establish
  // authenticated management access without unblocking ordinary commands.
  dashboardUnavailable = true;
  Object.assign(pair, { role: 'protected', canControl: false, reason: 'activation_failed', error: 'database_state_incompatible' });
  await send('Page.reload');
  await until("document.body.dataset.authenticated === 'true' && document.getElementById('pairing-panel').checkVisibility()");
  assert.match(await evaluate("document.getElementById('error').textContent"), /Unsupported voltage estimate state/);
  assert.equal(await evaluate("document.body.dataset.accessRole"), 'family');
  assert.equal(await evaluate("document.getElementById('pairing-reset').disabled"), true, 'Recovery does not give family users admin access');
  await evaluate("document.getElementById('web-logout').click();true");
  await until("document.body.dataset.authenticated === 'false' && !document.getElementById('auth').hidden");
  await login('synthetic-browser-rotated-admin-access-token');
  await until("!document.getElementById('pairing-reset').disabled");
  assert.equal(await evaluate("[...document.querySelectorAll('[data-write-control]')].flatMap(node => node.matches('button,input,select,textarea') ? [node] : [...node.querySelectorAll('button,input,select,textarea')]).every(node => node.disabled)"), true,
    'Management access cannot enable equipment or ordinary configuration controls');
  const writesBeforeRecovery = writes.length;
  await evaluate("document.getElementById('pairing-details').open=true;true");
  for (const width of [320, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)}); document.getElementById('pairing-reset').click();true`);
    await until("document.getElementById('pairing-reset-dialog').open");
    assert.equal(await evaluate("document.getElementById('pairing-reset-fresh').disabled"), true, 'Existing restoration acknowledgement remains required');
    await evaluate("document.getElementById('pairing-reset-restoration').click();true");
    assert.equal(await evaluate("document.getElementById('pairing-reset-fresh').disabled"), false, 'Start fresh is reachable while dashboard status fails');
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.equal(await evaluate("(() => { const dialog=document.getElementById('pairing-reset-dialog'); return dialog.scrollWidth <= dialog.clientWidth; })()"), true);
    await evaluate("document.getElementById('pairing-reset-cancel').click();true");
  }
  assert.equal(writes.length, writesBeforeRecovery, 'Reviewing recovery sends no mutation');
  pairingUnavailable = true;
  await until("document.getElementById('pairing-reset').disabled");
  pairingUnavailable = false;
  await until("!document.getElementById('pairing-reset').disabled");
  assert.match(await evaluate("document.getElementById('error').textContent"), /Unsupported voltage estimate state/);
  dashboardUnavailable = false;
  Object.assign(pair, { role: 'master', canControl: true, reason: null, error: null });
  const httpsUrl = `https://${fixtureHostname}:${app.webAccess.httpsServer.address().port}/`;
  await send('Page.navigate', { url: httpsUrl });
  await until("!document.getElementById('auth')?.hidden");
  const rememberGeometry = () => evaluate(`(() => {
    const label = document.querySelector('.remember-login'), box = document.getElementById('remember-login');
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.remember-login-text'));
    const firstLine = range.getClientRects()[0], check = box.getBoundingClientRect();
    const password = document.getElementById('token').getBoundingClientRect(), row = label.getBoundingClientRect();
    const eye = document.getElementById('password-visibility').getBoundingClientRect();
    const form = document.getElementById('auth').getBoundingClientRect(), submit = document.querySelector('#auth [type="submit"]').getBoundingClientRect();
    return { sameRow: Math.abs(check.top + check.height / 2 - firstLine.top - firstLine.height / 2) < 4,
      beforeText: check.right + 4 <= firstLine.left, boxWidth: check.width, boxHeight: check.height, targetHeight: row.height,
      passwordGap: row.top - password.bottom, buttonGap: submit.top - row.bottom, formHeight: form.height, buttonTop: submit.top + scrollY,
      aligned: Math.abs(password.left - row.left) < 1 && Math.abs(password.left - submit.left) < 1
        && Math.abs(password.width - submit.width) < 1 && Math.abs(form.right - password.right - password.left + form.left) < 1,
      eyeCentered: Math.abs(eye.top + eye.height / 2 - password.top - password.height / 2) < 1,
      textContained: [...range.getClientRects()].every(rect => rect.right <= row.right + 1),
      noOverflow: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  const auditRememberedLayout = async (width, theme, scale = 1, height = 900) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 480 || height <= 400 });
    await evaluate(`window.homeEnergyTheme.setTheme(${JSON.stringify(theme)});true`);
    // Browser-only text enlargement retains fixed viewport and native control
    // sizes, so wrapping and first-line alignment are checked independently.
    await evaluate(`(() => {
      const nodes = [...document.querySelectorAll('#auth h2, #auth .auth-intro, #auth > label, #token, #auth .remember-login, #auth button, #auth-help, #auth-error')];
      for (const node of nodes) node.style.fontSize = '';
      const sizes = nodes.map(node => getComputedStyle(node).fontSize);
      nodes.forEach((node, index) => node.style.fontSize = parseFloat(sizes[index]) * ${scale} + 'px');
      window.scrollTo(0,0);
    })()`);
    let previous;
    for (const checked of [false, true]) {
      await evaluate(`document.getElementById('remember-login').checked=${checked};true`);
      await settle();
      const name = `login-https-${width}-${theme}-${scale}x-${height}-${checked ? 'checked' : 'unchecked'}`;
      await capture(name, '#auth');
      const geometry = await rememberGeometry();
      assert(geometry.sameRow && geometry.beforeText, name + ': checkbox sits beside the first text line');
      assert.equal(geometry.boxWidth, 18, name + ': native checkbox keeps its intended size');
      assert.equal(geometry.boxHeight, 18, name + ': checkbox is square');
      assert(geometry.targetHeight >= 44, name + ': whole row is a touch target');
      assert(geometry.passwordGap >= 8 && geometry.buttonGap >= 12, name + ': field, option and button have breathing room');
      assert(geometry.aligned && geometry.eyeCentered && geometry.textContained && geometry.noOverflow, name + ': balanced, contained controls');
      if (previous) {
        assert.equal(geometry.formHeight, previous.formHeight, name + ': selecting the option does not resize the card');
        assert.equal(geometry.buttonTop, previous.buttonTop, name + ': selection does not move the sign-in button');
      }
      previous = geometry;
      if (height <= 400) for (const selector of ['#token', '#remember-login', '#auth [type="submit"]']) {
        assert.equal(await evaluate(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center',behavior:'instant'});
          const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight;
        })()`), true, name + ': controls remain reachable in a short or landscape viewport');
      }
    }
  };
  assert.deepEqual(await evaluate("[document.getElementById('remember-login-option').checkVisibility(),document.getElementById('remember-login').disabled,document.getElementById('remember-login').checked]"), [true, false, false]);
  for (const width of [320, 360, 390, 412, 480, 768, 1440]) for (const theme of ['dark', 'light'])
    await auditRememberedLayout(width, theme);
  for (const width of [320, 390, 768]) for (const theme of ['dark', 'light']) for (const scale of [1.5, 2])
    await auditRememberedLayout(width, theme, scale);
  for (const theme of ['dark', 'light']) await auditRememberedLayout(390, theme, 1, 320);
  for (const theme of ['dark', 'light']) await auditRememberedLayout(844, theme, 1, 390);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelectorAll('#auth [style]').forEach(node=>node.style.fontSize='');document.getElementById('remember-login').checked=false;document.getElementById('password-visibility').focus();true");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.id"), 'remember-login', 'Keyboard order follows password visibility, remember option, sign-in');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(await evaluate("document.getElementById('remember-login').checked"), true, 'Space toggles the native checkbox');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.remember-login')).outlineStyle"), 'solid', 'Keyboard focus outlines the complete option');
  await capture('login-https-keyboard-focus', '#auth');
  await evaluate("document.querySelector('.remember-login').scrollIntoView({block:'center'});true");
  const tap = await evaluate("(()=>{const r=document.querySelector('.remember-login').getBoundingClientRect();return {x:r.right-6,y:r.bottom-4};})()");
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...tap, radiusX: 1, radiusY: 1 }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until("!document.getElementById('remember-login').checked");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement.type"), 'submit', 'The option has no extra keyboard stops');
  await send('Fetch.enable', { patterns: [{ urlPattern: httpsUrl + 'api/session/remember', requestStage: 'Request' }] });
  await evaluate("document.getElementById('token').value='synthetic-rejected-remember-password';document.getElementById('remember-login').checked=true;document.getElementById('auth').requestSubmit();true");
  for (let attempt = 0; attempt < 100 && !heldLoginRequest; attempt++) await new Promise(resolve=>setTimeout(resolve,20));
  assert(heldLoginRequest, 'A deliberately held sign-in request exercises pending controls');
  assert.deepEqual(await evaluate("[document.getElementById('auth').getAttribute('aria-busy'),document.getElementById('token').readOnly,document.getElementById('remember-login').disabled,document.getElementById('password-visibility').disabled,document.querySelector('#auth [type=submit]').textContent]"),
    ['true', true, true, true, 'Signing in…']);
  await capture('login-https-pending', '#auth');
  const requestsBeforeFailure = rememberRequests;
  await evaluate("document.getElementById('auth').requestSubmit();true");
  await send('Fetch.continueRequest', { requestId: heldLoginRequest.requestId });
  await until("!document.getElementById('auth-error').hidden && document.getElementById('auth').getAttribute('aria-busy')==='false'");
  await send('Fetch.disable'); heldLoginRequest = undefined;
  assert.equal(rememberRequests, requestsBeforeFailure + 1, 'Repeated submission cannot send a second remembered-login request');
  assert.deepEqual(await evaluate("[document.getElementById('remember-login').checked,document.getElementById('remember-login').disabled,document.getElementById('token').readOnly,document.getElementById('token').getAttribute('aria-invalid'),document.activeElement.id,document.querySelector('#auth [type=submit]').textContent]"),
    [true, false, false, 'true', 'token', 'Sign in'], 'Rejected password restores editing, focus and the selected login scope');
  await capture('login-https-password-error', '#auth');
  await login(family);
  assert.equal(await evaluate("sessionStorage.getItem('stmq-token')"), null, 'Remembered login stores no password in tab storage');
  const cookies = (await send('Network.getCookies', { urls: [httpsUrl] })).cookies;
  const remembered = cookies.find(value => value.name === '__Host-stmq-session');
  assert(remembered?.secure && remembered.httpOnly && remembered.sameSite === 'Strict');
  assert(Math.abs(remembered.expires - (now + 360 * 86400_000) / 1000) < 1,
    'Browser Date-header clock compensation stays within one second of the fixed server expiry');
  const handler = socket.onmessage;
  socket.close();
  const fresh = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(fresh.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = handler;
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate', { url: httpsUrl });
  await until("document.body.dataset.authenticated === 'true' && document.body.dataset.accessRole === 'family'");
  assert.equal(await evaluate("sessionStorage.getItem('stmq-token')"), null, 'A new tab signs in from its protected cookie');
  assert.equal((await send('Network.getCookies', { urls: [httpsUrl] })).cookies.find(value => value.name === remembered.name).expires,
    remembered.expires, 'New tabs and polling do not renew the original expiry');
  await evaluate("document.getElementById('web-logout').click();true");
  await until("document.body.dataset.authenticated === 'false' && !document.getElementById('auth').hidden");
  assert.equal((await send('Network.getCookies', { urls: [httpsUrl] })).cookies.some(value => value.name === remembered.name), false);
  await evaluate("document.getElementById('remember-login').click();true");
  await login('synthetic-browser-rotated-admin-access-token');
  await until("!document.getElementById('web-revoke-sessions').hidden");
  await evaluate("document.getElementById('web-revoke-sessions').click();true");
  await until("document.body.dataset.authenticated === 'false' && !document.getElementById('auth').hidden");
  assert.equal((await send('Network.getCookies', { urls: [httpsUrl] })).cookies.some(value => value.name === remembered.name), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(layoutFailures, [], `Layout failures${screenshotDirectory ? `; inspect ${screenshotDirectory}/geometry.json` : ''}`);
  console.log('Access browser checks passed: 60 HTTPS checkbox layout states, HTTP hiding, enlarged text, short/landscape screens, touch/keyboard, pending/duplicate/error recovery, family permissions, pairing recovery, fixed cookie expiry, fresh-tab login and revocation.');
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
