// Run after npm run build. Every provider/status/action below is synthetic;
// the isolated application and disposable browser never load household config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-charging-screenshots-'));
const now = Date.parse('2026-09-30T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
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
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; browser errors: ${errors.join(', ')}`);
  };
  const keyPress = async key => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const poll = () => evaluate('chargingFixture.poll()');
  const setFields = values => evaluate(`(() => {
    const form = document.getElementById('charging-test-form');
    for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
      const input = form.elements.namedItem(name);
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  const screenshot = async (name, selector) => {
    // Fixed-position dialogs must be captured at document scroll zero: Chrome
    // otherwise clips background content at the dialog's document coordinates.
    await evaluate(`window.scrollTo(0, 0); document.querySelector(${JSON.stringify(selector)}).scrollTop = 0; true`);
    await pause(80);
    const clip = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const fits = async selector => assert.equal(await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1
      && r.left >= -1 && r.right <= innerWidth + 1;
  })()`), true, `${selector} fits the viewport without horizontal overflow`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.chargingFixture = { reads: 0, mutations: [], runs: [], readOnly: false, connected: false, archived: false };
    const N = ${now};
    const field = (value, receipt = false) => ({ value, available: true, measuredAt: receipt ? null : N - 60000,
      receivedAt: N - 30000, retained: false, timeBasis: receipt ? 'receipt-only' : 'measurement' });
    chargingFixture.report = { id: 'report-fixture', startedAt: N - 7200000, endedAt: null, evaluatedAt: N,
      vehicleId: 'bmw', outcome: { state: 'in-progress' }, behavior: 'attention', attentionCount: 1, recoveredCount: 0,
      coverage: { identification: { state: 'verified' }, initialRelease: { state: 'verified' }, pause: { state: 'verified' },
        resume: { state: 'not-exercised' }, completion: { state: 'not-exercised' }, energy: { state: 'insufficient-evidence' } },
      findings: [{ code: 'control-unconfirmed', severity: 'attention', firstAt: N - 1800000, resolvedAt: null }],
      timeline: [{ kind: 'connection', code: 'connected', at: N - 7200000 },
        { kind: 'identity', code: 'identified', vehicleId: 'bmw', at: N - 7140000, measuredAt: N - 7150000, receivedAt: N - 7140000 },
        { kind: 'finding', code: 'control-unconfirmed', at: N - 1800000 }],
      plans: [{ at: N - 7100000, reason: 'vehicle-identification', deadlineAt: N + 3600000, feasible: true,
        inputs: { soc: { value: 35, source: 'bmw-cardata' }, target: { value: 80 }, capacity: { value: 74 } },
        periods: [{ startAt: N - 7000000, endAt: N - 5400000 }, { startAt: N + 600000, endAt: null }] }], truncated: {} };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        const body = JSON.parse(options.body ?? '{}'); chargingFixture.mutations.push({ path, body });
        if (path === '/api/charging/tests/preview') return new Response(JSON.stringify({ eligible: true,
          headroom: { minutes: 180, capacityKwh: body.vehicleId === 'bmw' ? 74 : 57, powerKw: 11,
            minimumMinutes: body.program === 'immediate' ? 30 : 60 },
          gates: [{ state: 'ready', message: 'The physical charger is unplugged and ready.' },
            { state: 'ready', message: 'Vehicle feed available; physical identity remains unconfirmed.' }] }), { headers: { 'Content-Type': 'application/json' } });
        if (path === '/api/charging/tests/start') {
          chargingFixture.runs.unshift({ id: 'run-' + (chargingFixture.runs.length + 1), association: body.association,
            vehicleId: body.vehicleId, chargerId: body.chargerId, program: body.program, phase: 'armed', sessionId: null,
            expectations: { soc: body.soc, nativeTargetSoc: body.nativeTargetSoc, vehicleStartAt: body.vehicleStartAt ?? null },
            milestones: { identification: null, initialPlan: null }, findings: [] });
        } else if (path === '/api/charging/tests/schedule') {
          const run = chargingFixture.runs.find(item => item.id === body.id); run.phase = 'observing';
          run.expectations.vehicleStartAt = body.startAt;
          run.milestones.vehicleTimer = { message: 'User declared the native timer; awaiting actual charging evidence.' };
          run.restorationReminder = 'Restore the vehicle timer after this test.';
        } else if (path === '/api/charging/tests/cancel') {
          const run = chargingFixture.runs.find(item => item.id === body.id); run.phase = 'cancelled';
        } else throw new Error('Unexpected mutation in charging browser fixture: ' + path);
        return globalThis.fetch('/api/status');
      }
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      const status = await response.json(); chargingFixture.reads++;
      status.readOnly = chargingFixture.readOnly;
      status.charging.physicalTests = { available: true, canManage: !chargingFixture.readOnly, runs: chargingFixture.runs };
      for (const charger of status.charging.chargers) {
        charger.association = charger.id + '-fixture-association';
        charger.settings.enabled = true;
        charger.values.connected = field(chargingFixture.connected && charger.id === 'charger1');
        charger.values.charging = field(false); charger.control = { phase: 'off' };
      }
      status.charging.vehicleFeeds = ['bmw', 'tesla'].map(id => ({ id, label: id === 'bmw' ? 'BMW' : 'Tesla',
        provider: id === 'bmw' ? 'bmw-cardata' : 'teslamate', usedByChargerId: null,
        reception: { brokerConnected: true, subscribed: true, ...(id === 'bmw' ? { available: true } : {}) },
        setup: { available: true, healthy: true, state: id === 'tesla' ? 'asleep' : null,
          fields: { soc: field(35, id === 'tesla'), minimumSoc: field(80, id === 'tesla'), capacityKwh: field(74),
            atHome: field(true, id === 'tesla'), pluggedIn: field(false, id === 'tesla'), charging: field(false, id === 'tesla'),
            powerKw: field(0, true), requestedCurrentA: field(16, true), maxCurrentA: field(16, true) } } }));
      status.charging.diagnostics = { available: true, chargers: [{ id: 'charger1',
        current: chargingFixture.archived ? null : chargingFixture.report,
        recent: chargingFixture.archived ? [chargingFixture.report] : [] }, { id: 'charger2', current: null, recent: [] }] };
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) chargingFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("chargingFixture.poll && document.getElementById('charging-setup-tesla-state')?.textContent === 'Healthy · Sleeping'");
  assert.deepEqual(errors, []);
  await evaluate("document.getElementById('connections-details').open = true; document.querySelector('#charging-setup-details > summary').focus()");
  await keyPress('Enter');
  assert.equal(await evaluate("document.getElementById('charging-setup-details').open"), true);
  await evaluate("document.getElementById('charging-setup-bmw-details').open = true; document.getElementById('charging-setup-bmw-test').focus()");
  await keyPress('Enter');
  await until("document.getElementById('charging-test-dialog').open");
  await keyPress('Escape');
  await until("!document.getElementById('charging-test-dialog').open");
  assert.equal(await evaluate('document.activeElement.id'), 'charging-setup-bmw-test', 'Escape returns focus to the setup button');
  assert.equal(await evaluate('chargingFixture.mutations.length'), 0, 'Opening and closing guides never commands a charger');

  await click('#charging-setup-bmw-test');
  await setFields({ vehicleId: 'bmw', chargerId: 'charger1', program: 'immediate', soc: '35', nativeTargetSoc: '80', prepared: true });
  await evaluate("document.querySelector('[name=soc]').focus(); globalThis.savedSocInput = document.querySelector('[name=soc]')");
  await poll();
  assert.equal(await evaluate("document.querySelector('[name=soc]').value === '35' && document.activeElement === savedSocInput && savedSocInput === document.querySelector('[name=soc]')"), true,
    'Normal test drafts and field focus survive a status poll');
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await fits('#charging-test-dialog'); await screenshot(`preparation-${width}-${theme}`, '#charging-test-dialog');
  }
  await until("!document.querySelector('[data-test-preview]').disabled");
  await click('[data-test-preview]');
  await until("!document.querySelector('[data-test-arm]').disabled");
  const immediate = { chargerId: 'charger1', vehicleId: 'bmw', program: 'immediate', association: 'charger1-fixture-association', soc: 35, nativeTargetSoc: 80, prepared: true };
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/preview', body: immediate });
  await click('[data-test-arm]');
  await until("document.querySelector('[data-test-phase]').textContent === 'Ready to plug in'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/start', body: immediate });
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  assert.equal(await evaluate("document.querySelector('[data-test-phase]').textContent"), 'Ready to plug in', 'An armed test survives closing the window');
  await evaluate("chargingFixture.runs[0].sessionId='session-fixture-1'; chargingFixture.runs[0].report={id:'report-fixture'}; chargingFixture.runs[0].phase='observing'; chargingFixture.connected=true");
  await poll(); await until("!document.querySelector('[data-test-report]').disabled");
  const mutationCount = await evaluate('chargingFixture.mutations.length');
  await click('[data-test-report]');
  await until("document.getElementById('charging-report-dialog').open");
  assert.equal(await evaluate('chargingFixture.mutations.length'), mutationCount, 'Session reports make no control requests');
  assert.equal(await evaluate("document.querySelector('.charging-report-result').dataset.state"), 'attention');
  assert.match(await evaluate("document.querySelector('.charging-report-findings').textContent"), /Control remained unconfirmed/);
  await keyPress('Escape');
  await until("!document.getElementById('charging-report-dialog').open");
  await until("document.activeElement.id === 'charger1-session-report'");
  assert.equal(await evaluate('document.activeElement.id'), 'charger1-session-report');
  const expanded = await evaluate("document.getElementById('charger1-device-summary').parentElement.open");
  await click('#charger1-session-report');
  assert.equal(await evaluate("document.getElementById('charger1-device-summary').parentElement.open"), expanded, 'Report button does not toggle charger details');
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  await click('[data-test-cancel]');
  await until("document.querySelector('[data-test-phase]').textContent === 'Assessment cancelled'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/cancel', body: { id: 'run-1', association: 'charger1-fixture-association' } });
  await keyPress('Escape');

  await evaluate("document.getElementById('charging-setup-tesla-details').open = true");
  await click('#charging-setup-tesla-test');
  await setFields({ vehicleId: 'tesla', chargerId: 'charger2', program: 'vehicle-schedule', soc: '40', nativeTargetSoc: '80',
    vehicleStartAt: '2026-10-01T01:00', prepared: true });
  await until("!document.querySelector('[data-test-preview]').disabled");
  await click('[data-test-preview]'); await until("!document.querySelector('[data-test-arm]').disabled");
  const delayed = { chargerId: 'charger2', vehicleId: 'tesla', program: 'vehicle-schedule', association: 'charger2-fixture-association',
    soc: 40, nativeTargetSoc: 80, prepared: true, vehicleStartAt: Date.parse('2026-09-30T22:00:00Z') };
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/preview', body: delayed });
  await click('[data-test-arm]'); await until("document.querySelector('[data-test-phase]').textContent === 'Ready to plug in'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/start', body: delayed });
  await evaluate(`Object.assign(chargingFixture.runs[0], { sessionId:'session-fixture-2', phase:'awaiting-vehicle-schedule',
    recommendation: { state:'available', startAt:${Date.parse('2026-09-30T22:30:00Z')}, message:'The observed production plan starts at 01:00. A vehicle start at 01:30 exercises delayed charging.' } })`);
  await poll(); await until("!document.querySelector('[data-test-timer]').hidden");
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '2026-10-01T01:30', 'A new suggestion fills the untouched timer field');
  await evaluate("document.querySelector('[data-test-confirm-time]').value = '2026-10-01T01:45'; document.querySelector('[data-test-confirm-time]').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-test-confirm-time]').focus()");
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '2026-10-01T01:45', 'Timer draft survives polling');
  await click('[data-test-confirm]');
  await until("document.querySelector('[data-test-message]').textContent.includes('Vehicle timer recorded')");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/schedule', body: {
    id: 'run-2', association: 'charger2-fixture-association', sessionId: 'session-fixture-2', startAt: Date.parse('2026-09-30T22:45:00Z') } });

  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await fits('#charging-test-dialog'); await screenshot(`test-${width}-${theme}`, '#charging-test-dialog');
    await keyPress('Escape');
    await evaluate("document.getElementById('charging-setup-details').open=true; document.getElementById('charging-setup-bmw-details').open=true; document.getElementById('charging-setup-tesla-details').open=true");
    await fits('#charging-setup-content'); await screenshot(`setup-${width}-${theme}`, '#charging-setup-details');
    await click('#charger1-session-report');
    await fits('#charging-report-dialog'); await screenshot(`report-${width}-${theme}`, '#charging-report-dialog');
    await keyPress('Escape'); await click('#charging-setup-tesla-test');
  }
  await evaluate('chargingFixture.readOnly = true'); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm]').disabled && document.querySelector('[data-test-cancel]').disabled"), true,
    'Read-only status disables guided assessment mutations');
  assert.match(await evaluate("document.querySelector('[data-test-message]').textContent"), /live controller/);
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  await click('[data-test-new]');
  assert.equal(await evaluate("document.querySelector('[data-test-preview]').disabled && document.querySelector('[data-test-arm]').disabled"), true);
  await keyPress('Escape');
  await evaluate(`chargingFixture.archived=true; chargingFixture.report.endedAt=${now}; chargingFixture.connected=false;
    chargingFixture.report.outcome={state:'completion-unknown'}; chargingFixture.report.findings[0].resolvedAt=${now - 60000};
    chargingFixture.report.attentionCount=0; chargingFixture.report.recoveredCount=1; chargingFixture.report.behavior='explained'`);
  await poll(); await until("document.getElementById('charger1-session-report').textContent.includes('Recovered issue')");
  await click('#charger1-session-report');
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /Unplugged · completion unconfirmed/);
  assert.match(await evaluate("document.querySelector('.charging-report-findings').textContent"), /Recovered/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 1, 'Completed reports remain inspectable after unplugging');
  await keyPress('Escape');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("for (const fold of document.querySelectorAll('#charging-setup-bmw-details details')) fold.open = true");
  await fits('#charging-setup-content'); await screenshot('setup-descriptors-320', '#charging-setup-details');
  assert.equal(await evaluate("chargingFixture.mutations.every(row => row.path.startsWith('/api/charging/tests/'))"), true,
    'No tested guide action calls a charger settings or command endpoint');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'charging-browser-smoke-passed', artifacts, checks: [
    'keyboard-disclosures-and-Escape-focus', 'draft-preservation-through-status-polls', 'normal-and-delayed-action-payloads',
    'timer-declarations-in-installation-timezone', 'passive-report-no-mutations', 'read-only-controls', 'retained-report-and-recovered-issue',
    '320-390-1440-light-dark-layouts' ] }));
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
