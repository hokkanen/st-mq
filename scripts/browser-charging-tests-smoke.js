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
  const screenshot = async (name, selector, { preserveScroll = false } = {}) => {
    // Fixed-position dialogs must be captured at document scroll zero: Chrome
    // otherwise clips background content at the dialog's document coordinates.
    await evaluate(`window.scrollTo(0, 0); ${preserveScroll ? '' : `document.querySelector(${JSON.stringify(selector)}).scrollTop = 0;`} true`);
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
    globalThis.chargingFixture = { reads: 0, mutations: [], runs: [], readOnly: false, connected: false, archived: false,
      diagnosticsAvailable: true, recent: [], second: { current: null, recent: [] } };
    const N = ${now};
    const field = (value, receipt = false) => ({ value, available: true, measuredAt: receipt ? null : N - 60000,
      receivedAt: N - 30000, retained: false, timeBasis: receipt ? 'receipt-only' : 'measurement' });
    chargingFixture.report = { id: 'report-fixture', startedAt: N - 7200000, endedAt: null, evaluatedAt: N,
      vehicleId: null, outcome: { state: 'in-progress' }, behavior: 'attention', attentionCount: 1, recoveredCount: 0,
      current: { automaticEnabled: false, chargeNow: false, scheduleState: 'none', physicalFresh: true,
        vehicleId: null, vehicleSoc: false, soc: { value: 20, source: 'manual-fallback', assumed: true },
        power: { value: 0, source: 'easee-ocpp', measuredAt: N - 45000, receivedAt: N - 30000 },
        powerKw: 0, charging: false, reportedCharging: true },
      coverage: { identification: { state: 'not-exercised' }, initialRelease: { state: 'not-exercised' }, pause: { state: 'not-exercised' },
        resume: { state: 'not-exercised' }, completion: { state: 'not-exercised' }, energy: { state: 'insufficient-evidence' } },
      findings: [{ code: 'control-unconfirmed', severity: 'attention', firstAt: N - 1800000, resolvedAt: null }],
      timeline: [{ kind: 'session', code: 'observation-started', at: N - 3600000 },
        { kind: 'physical', code: 'not-charging-observed', at: N - 3500000, powerKw: 0, source: 'easee-ocpp',
          measuredAt: N - 3530000, receivedAt: N - 3510000 },
        { kind: 'charger-status', code: 'charger-reports-charging', at: N - 3500000, powerKw: 0, source: 'easee-ocpp',
          measuredAt: N - 3540000, receivedAt: N - 3530000, powerMeasuredAt: N - 3530000, powerReceivedAt: N - 3510000 },
        { kind: 'plan', code: 'target-update', at: N - 2400000, changes: [{ field: 'target', before: 80, after: 85 }] },
        { kind: 'finding', code: 'control-unconfirmed', at: N - 1800000 }],
      plans: [{ at: N - 3600000, reason: 'initial-plan', deadlineAt: N + 3600000, feasible: null,
        automatic: false, chargeNow: false, scheduleState: 'none', state: 'disabled', changes: [], vehicleId: null,
        inputs: { soc: { value: 20, source: 'manual-fallback', assumed: true }, target: { value: 80, source: 'manual-fallback' },
          capacity: { value: 74, source: 'manual-fallback', assumed: true } }, periods: [] },
      { at: N - 2400000, reason: 'target-update', deadlineAt: N + 3600000, feasible: null,
        automatic: false, chargeNow: false, scheduleState: 'none', state: 'disabled',
        changes: [{ field: 'target', before: 80, after: 85 }], vehicleId: null,
        inputs: { soc: { value: 20, source: 'manual-fallback', assumed: true }, target: { value: 85, source: 'session-request' },
          capacity: { value: 74, source: 'manual-fallback', assumed: true } }, periods: [] }], truncated: {} };
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
      status.charging.diagnostics = { available: chargingFixture.diagnosticsAvailable, chargers: [{ id: 'charger1',
        current: chargingFixture.archived ? null : chargingFixture.report,
        recent: chargingFixture.archived ? [chargingFixture.report, ...chargingFixture.recent] : chargingFixture.recent },
        { id: 'charger2', current: chargingFixture.second.current, recent: chargingFixture.second.recent }] };
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
  const reportFacts = await evaluate("document.querySelector('.charging-report-facts').textContent");
  assert.match(reportFacts, /Automatic charging off.*No controller charging schedule/);
  assert.match(reportFacts, /Actual vehicle battery charge is unconfirmed.*20% · configured assumption/);
  assert.match(reportFacts, /0 kW measured.*Charger status reports charging/);
  assert.match(reportFacts, /Earlier charging is not covered by this report/);
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = true");
  assert.match(await evaluate("document.querySelector('.charging-report-timeline').innerText"), /Requested target: 80% → 85%.*Charging periods unchanged/s);
  assert.match(await evaluate("document.querySelector('.charging-report-plans').textContent"), /No controller charging schedule/);
  assert.doesNotMatch(await evaluate("document.querySelector('.charging-report-timeline').textContent"), /Physical charging observed|Physical charging stopped|Plan updated/);
  assert.match(await evaluate("document.querySelector('.charging-report-timeline').textContent"), /Local OCPP.*Measured.*Received/);
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = false");
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

  // Report inspection is scoped to the selected physical charger, including
  // empty and expired histories. All cases below remain read-only browser work.
  const inspectionMutations = await evaluate('chargingFixture.mutations.length');
  await evaluate("document.getElementById('charger2-session-report').focus()");
  await keyPress('Enter');
  await until("document.getElementById('charging-report-dialog').open");
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 2/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 0,
    'An empty Charger 2 never offers Charger 1 reports');
  assert.equal(await evaluate("document.getElementById('charging-report-session').disabled"), true);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /No .*session|No .*report/i);
  await keyPress('Escape'); await until("document.activeElement.id === 'charger2-session-report'");
  await evaluate(`(() => {
    const f = chargingFixture, baseline = structuredClone(f.report);
    f.archived = false; f.report.endedAt = null; f.report.outcome = { state:'in-progress' };
    f.recent = [{ ...structuredClone(baseline), id:'charger1-previous', startedAt:${now - 172_800_000},
      endedAt:${now - 165_600_000}, vehicleId:'bmw', outcome:{state:'target-confirmed'} }];
    f.second = { current:{ ...structuredClone(baseline), id:'charger2-current', startedAt:${now - 10_800_000}, endedAt:null,
      vehicleId:'tesla', behavior:'expected', attentionCount:0, recoveredCount:0, findings:[], outcome:{state:'target-confirmed'},
      current:{ ...structuredClone(baseline.current), vehicleId:'tesla', vehicleSoc:true, reportedCharging:false,
        soc:{value:80, source:'teslamate', measuredAt:${now - 60_000}, receivedAt:${now - 30_000}} } },
      recent:[{ ...structuredClone(baseline), id:'charger2-previous', startedAt:${now - 86_400_000}, endedAt:${now - 79_200_000},
        vehicleId:'tesla', outcome:{state:'deadline-missed'} }] };
    globalThis.savedSecondReports = structuredClone(f.second);
  })()`);
  await poll();
  await click('#charger1-session-report');
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 1/);
  assert.deepEqual(await evaluate("[...document.getElementById('charging-report-session').options].map(option => option.value)"),
    ['report-fixture', 'charger1-previous'], 'Charger 1 offers only its current and retained reports');
  await evaluate("document.getElementById('charging-report-session').value='charger1-previous'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /Target confirmed/);
  await evaluate('chargingFixture.report.evaluatedAt += 1000'); await poll();
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'charger1-previous');
  await evaluate('chargingFixture.recent = []'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /no longer retained/i);
  assert.notEqual(await evaluate("document.getElementById('charging-report-session').value"), 'report-fixture',
    'An expired selected report never silently switches to the current physical connection');
  await keyPress('Escape'); await click('#charger2-session-report');
  assert.deepEqual(await evaluate("[...document.getElementById('charging-report-session').options].map(option => option.value)"),
    ['charger2-current', 'charger2-previous'], 'Charger 2 offers only its current and retained reports');
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'charger2-current');
  await evaluate("document.getElementById('charging-report-session').value='charger2-previous'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /not reached by ready-by/i);
  await keyPress('Escape'); await click('#charger2-session-report');
  await evaluate('chargingFixture.second.current.evidenceStale = true'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /no longer current|incomplete/i);
  await evaluate('chargingFixture.diagnosticsAvailable = false'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /could not be saved|unavailable/i);
  await evaluate('chargingFixture.diagnosticsAvailable = true; chargingFixture.second = { current:null, recent:[] }');
  await poll(); await keyPress('Escape'); await click('#charger2-session-report');
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 0);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /No .*session|No .*report/i);
  await keyPress('Escape');

  // Meaningful rows are presented compactly, with the unchanged raw evidence
  // available only when the user opens a group or a planning snapshot.
  await evaluate(`(() => {
    const report = chargingFixture.report, N = ${now};
    const idle = { automaticEnabled:false, chargeNow:false, scheduleState:'none', identificationActive:false,
      expectation:'observe', pending:false, error:false, confirmed:false };
    for (let index = 0; index < 4; index++) {
      const at = N - 1200000 + index * 1000;
      report.timeline.push({ kind:'control', code:index % 2 ? 'off' : 'unavailable', at, physicalKnown:false, ...idle });
    }
    for (let index = 0; index < 4; index++) {
      const at = N - 600000 + index * 1000;
      report.timeline.push({ kind:'charger-status', code:index % 2 ? 'charger-reports-not-charging' : 'charger-reports-charging',
        at, source:'easee-ocpp', powerKw:0, measuredAt:at - 2000, receivedAt:at - 1000,
        powerMeasuredAt:at - 2000, powerReceivedAt:at - 1000, physicalKnown:true, ...idle });
    }
    const baseline = structuredClone(report.plans.at(-1));
    report.plans.push({ ...structuredClone(baseline), at:N - 2350000, reason:'session-settings', changes:[] },
      { ...structuredClone(baseline), at:N - 2300000, reason:'price-update', changes:[] });
    const before = Array.from({length:8}, (_, index) => ({ startAt:N + index * 900000,
      endAt:N + (index + 1) * 900000, priceCtPerKwh:3.1234 + index / 10 }));
    const after = before.map(row => ({...row, priceCtPerKwh:row.priceCtPerKwh + 1}));
    const rateChange = {field:'prices', before, after, omitted:2};
    report.plans.push({ ...structuredClone(baseline), at:N - 2200000, reason:'price-update', changes:[rateChange] });
    report.timeline.push({kind:'plan', code:'session-settings', at:N - 2350000, changes:[]},
      {kind:'plan', code:'price-update', at:N - 2300000, changes:[]},
      {kind:'plan', code:'price-update', at:N - 2200000, changes:[structuredClone(rateChange)]});
    report.timeline.sort((a,b) => a.at - b.at);
    globalThis.originalHistory = JSON.stringify({timeline:report.timeline, plans:report.plans});
  })()`);
  await poll(); await click('#charger1-session-report');
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = true");
  assert.equal(await evaluate("document.querySelectorAll('.charging-report-fold > .charging-report-plans > li[data-plan-key]').length"), 3,
    'Initial and actual changed planning snapshots remain; two unchanged snapshots stay hidden');
  assert.equal(await evaluate("document.querySelectorAll('.charging-report-timeline > li[data-history-key]').length < chargingFixture.report.timeline.length"), true,
    'Repeated idle control and zero-power charger status events are combined');
  assert.equal(await evaluate("JSON.stringify({timeline:chargingFixture.report.timeline, plans:chargingFixture.report.plans}) === originalHistory"), true,
    'Grouping does not mutate the recorded timeline or planning inputs');
  assert.equal(await evaluate("document.querySelector('.charging-report-routine').open"), false,
    'Unchanged planning snapshots remain collapsed when meaningful history is opened');
  assert.match(await evaluate("document.querySelector('.charging-report-routine > summary').textContent"), /2 routine planning records/);
  await until("document.querySelector('.charging-report-timeline details[data-history-key]') !== null");
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.charging-report-timeline > li[data-history-key]')]
      .find(node => /2 brief charger-status changes/i.test(node.querySelector(':scope > strong')?.textContent));
    const group = row?.querySelector('details[data-history-key]');
    if (!group || group.open || group.querySelectorAll('.charging-report-raw > li').length !== 4)
      throw new Error('The paired zero-power status changes must preserve four collapsed original events');
    globalThis.savedHistoryGroup = group;
    globalThis.savedHistorySummary = group.querySelector('summary');
    savedHistorySummary.focus();
  })()`);
  await keyPress('Enter');
  assert.equal(await evaluate('savedHistoryGroup.open'), true, 'Enter opens grouped original evidence');
  await evaluate(`(() => {
    savedHistorySummary.scrollIntoView({block:'center'});
    globalThis.savedReportScroll = document.getElementById('charging-report-dialog').scrollTop;
    chargingFixture.report.evaluatedAt += 1000;
    chargingFixture.report.current.power.measuredAt += 1000;
  })()`);
  await poll();
  assert.equal(await evaluate("savedHistoryGroup.isConnected && savedHistoryGroup.open && document.activeElement === savedHistorySummary"), true,
    'Current-reading polls preserve the expanded group and exact focused summary node');
  assert.equal(await evaluate("Math.abs(document.getElementById('charging-report-dialog').scrollTop - savedReportScroll) <= 2"), true,
    'Current-reading polls do not reset report scroll');
  await evaluate(`chargingFixture.report.timeline.push({kind:'evidence',code:'observation-gap',at:${now + 1000}})`);
  await poll();
  assert.equal(await evaluate("savedHistoryGroup.isConnected && savedHistoryGroup.open && document.activeElement === savedHistorySummary && document.getElementById('charging-report-dialog').scrollTop > 0"), true,
    'A newly recorded group preserves the open evidence and focus without resetting to the top');
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.charging-report-fold > .charging-report-plans > li[data-plan-key]')]
      .find(node => /4\\.1234/.test(node.textContent));
    const details = row?.querySelector('.charging-report-plan-detail');
    const rates = row?.querySelector('.charging-report-change');
    if (!details || !rates) throw new Error('No planning snapshot with exact changed electricity rates');
    details.open = true; rates.open = true;
    globalThis.savedPlanDetails = details;
    globalThis.savedPlanRates = rates;
    globalThis.savedPlanSummary = rates.querySelector('summary');
    savedPlanSummary.focus();
    globalThis.savedPlanScroll = document.getElementById('charging-report-dialog').scrollTop;
    chargingFixture.report.evaluatedAt += 1000;
  })()`);
  await poll();
  assert.equal(await evaluate("savedPlanDetails.isConnected && savedPlanDetails.open && savedPlanRates.isConnected && savedPlanRates.open && document.activeElement === savedPlanSummary"), true,
    'Expanded planning and nested exact-rate evidence survive polling');
  assert.equal(await evaluate("Math.abs(document.getElementById('charging-report-dialog').scrollTop - savedPlanScroll) <= 2"), true);

  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme='${theme}';
      for (const fold of document.querySelectorAll('#charging-report-dialog details')) fold.open = true;`);
    await fits('#charging-report-dialog');
    await screenshot(`report-expanded-${width}-${theme}`, '#charging-report-dialog');
    await evaluate("savedHistorySummary.scrollIntoView({block:'start'})");
    await screenshot(`report-timeline-${width}-${theme}`, '#charging-report-dialog', { preserveScroll: true });
    await evaluate("savedPlanRates.scrollIntoView({block:'start'})");
    await screenshot(`report-rates-${width}-${theme}`, '#charging-report-dialog', { preserveScroll: true });
    assert.equal(await evaluate(`(() => {
      const button = document.querySelector('.charging-report-heading button').getBoundingClientRect();
      const dialog = document.getElementById('charging-report-dialog').getBoundingClientRect();
      return button.top >= dialog.top && button.bottom <= dialog.bottom && button.height >= 44;
    })()`), true, 'The close action stays reachable while inspecting expanded history');
    assert.equal(await evaluate(`savedPlanSummary.getBoundingClientRect().top >=
      document.querySelector('.charging-report-heading').getBoundingClientRect().bottom`), true,
    'Scrolled-to rate details stay visible below the sticky heading');
  }
  await keyPress('Escape'); await until("document.activeElement.id === 'charger1-session-report'");

  // Switching between the report and its linked guided assessment must leave
  // keyboard focus in the only open modal and follow the exact recorded run,
  // even when a newer assessment of the same vehicle is already active.
  await evaluate(`(() => {
    const f = chargingFixture, completed = structuredClone(f.runs.find(run => run.id === 'run-1'));
    f.recent = [{...structuredClone(f.report), id:'report-bmw-old', startedAt:${now - 86_400_000}, endedAt:${now - 79_200_000},
      outcome:{state:'target-confirmed'}}];
    Object.assign(completed, {id:'completed-bmw-test', phase:'completed', report:{id:'report-bmw-old'}, sessionId:'previous-bmw-session'});
    const latest = {...structuredClone(completed), id:'newer-bmw-test', phase:'armed', report:null, sessionId:null};
    f.runs.unshift(latest, completed);
  })()`);
  await poll();
  await click('#charger1-session-report');
  await evaluate("document.getElementById('charging-report-session').value='report-bmw-old'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  await click('.charging-report-guided button');
  await until("document.getElementById('charging-test-dialog').open && !document.getElementById('charging-report-dialog').open");
  assert.equal(await evaluate("document.getElementById('charging-test-dialog').contains(document.activeElement)"), true);
  assert.equal(await evaluate("document.querySelector('[data-test-phase]').textContent"), 'Assessment complete',
    'An old report opens its completed guided assessment, not a newer active test of the same vehicle');
  await click('[data-test-report]');
  await until("document.getElementById('charging-report-dialog').open && !document.getElementById('charging-test-dialog').open");
  assert.equal(await evaluate("document.getElementById('charging-report-dialog').contains(document.activeElement)"), true);
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 1/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'report-bmw-old',
    'Returning from the completed assessment restores its exact retained report');
  await keyPress('Escape');

  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("for (const fold of document.querySelectorAll('#charging-setup-bmw-details details')) fold.open = true");
  await fits('#charging-setup-content'); await screenshot('setup-descriptors-320', '#charging-setup-details');
  assert.equal(await evaluate("chargingFixture.mutations.every(row => row.path.startsWith('/api/charging/tests/'))"), true,
    'No tested guide action calls a charger settings or command endpoint');
  assert.equal(await evaluate('chargingFixture.mutations.length'), inspectionMutations, 'All report history inspection remains read-only');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'charging-browser-smoke-passed', artifacts, checks: [
    'keyboard-disclosures-and-Escape-focus', 'draft-preservation-through-status-polls', 'normal-and-delayed-action-payloads',
    'timer-declarations-in-installation-timezone', 'passive-report-no-mutations', 'read-only-controls', 'retained-report-and-recovered-issue',
    'automatic-off-no-controller-schedule', 'unidentified-fallback-battery-input', 'partial-observation-history', 'semantic-input-deltas', 'measured-zero-distinct-from-charger-status',
    'charger-scoped-current-and-retained-reports', 'empty-charger-does-not-borrow-peer-history', 'expired-selected-report', 'stale-and-unavailable-report-states',
    'grouped-zero-power-status-and-idle-control', 'no-op-planning-snapshots-hidden', 'expanded-history-focus-and-scroll-during-polls',
    'modal-switching-focus-and-exact-linked-run', 'long-expanded-details-fit-all-viewports', 'sticky-heading-keeps-history-and-close-action-visible',
    '320-390-1440-light-dark-layouts' ] }));
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
