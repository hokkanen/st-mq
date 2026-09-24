// Local synthetic fixture and disposable browser profile; no household services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';
import { checkDashboardDisclosures, checkDashboardLayout } from './lib/dashboard-browser-checks.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-garage-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-garage-screenshots-'));
const profile = join(directory, 'chrome'); mkdirSync(profile);
const now = Date.parse('2026-09-07T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  const configPath = join(directory, 'synthetic.json'); writeFileSync(configPath, '{}');
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const store = new Store(config.dbPath);
  seedChartFixture(store, now);
  for (let index = 0; index < 30; index++) {
    const at = now - (31 - index) * 60_000;
    appendGarageEntry(store, 'simulated', 'sample', { at, rearAt: at, rearC: 8 - index * .004,
      frontAt: at, frontC: 7.5 - index * .006, outdoorAt: at, outdoorC: 4, outdoorSource: 'simulation',
      available: true, powerKw: .4, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0 }, garageSettings(), at);
  }
  store.cycle('simulated', { id: 'synthetic-home-browser-cycle', status: 'completed', startedAt: now - 7_200_000,
    endedAt: now - 3_600_000, assessment: { basis: 'estimated-space-heating-execution-and-reference', profitCents: 300 } });
  store.cycle('garage:simulated', { id: 'synthetic-garage-browser-cycle', status: 'completed', startedAt: now - 7_200_000,
    endedAt: now - 3_600_000, assessment: { basis: 'garage-frozen-normal-reference', profitCents: -100, includesGarageOnly: true, provisional: true } });
  store.close(); app = await start({ config, clock: () => now });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox',
    '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Isolated Chromium DevTools listener started');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(expression)) return; await pause(30); }
    throw new Error(`Garage UI did not settle: ${expression}`);
  };
  const keyPress = async key => {
    const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : 'Space', virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 32;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: virtualKey, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
  };
  const clickSummaryPadding = async id => {
    const point = await evaluate(`(() => {
      const summary = document.querySelector('#${id} > summary');
      summary.scrollIntoView({block: 'center'});
      const box = summary.getBoundingClientRect();
      return {x: box.left + 6, y: box.bottom - 6};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Exercise the real status-render path without waiting for the next 15-second poll.
  // Response edits are confined to this disposable page and synthetic server.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const scheduleInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000) globalThis.refreshLearningSmokeStatus = () => callback(...args);
      return scheduleInterval(callback, delay, ...args);
    };
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      if (new URL(input.url ?? String(input), location.href).pathname !== '/api/status'
        || (!globalThis.learningSmokeValues && !globalThis.garageBudgetSmokeState && !globalThis.chargingSmokeValues && !globalThis.nativePumpSmokeValues)) return response;
      const status = await response.json();
      if (globalThis.nativePumpSmokeValues) {
        const at = status.now, reading = value => ({ value, available: true, observedAt: at });
        status.h66 = { ...status.h66, connected: true, brokerConnected: true,
          compressorState: { value: 1, since: at - 75 * 60_000, transitionObserved: false },
          readings: { '1A01': reading(1), '0203': reading(21), '0212': reading(44), '0208': reading(60), '2201': reading(1) } };
        status.garage.adapter = { ...status.garage.adapter, connected: true,
          health: { deviceOnline: true, driverProgressing: true, pumpCommunicating: true },
          native: { power: 'on', powerAt: at, mode: 'heat', targetC: 10,
            readbacks: Object.fromEntries(['power', 'mode', 'targetC'].map(field => [field, { measuredAt: at }])) } };
        status.garage.heatingControls = { ...status.garage.heatingControls, confirmed: true, selectedMode: 'normal' };
      }
      if (globalThis.learningSmokeValues) {
        const missing = globalThis.learningSmokeValues === 'missing';
        status.learning.metrics = { ...status.learning.metrics, profit: { value: 0, count: missing ? 0 : 1 } };
        status.learning.adaptive.model.parameters.lossPerHour = missing ? null : 0;
        for (const location of ['rear', 'front'])
          status.garage.observations[location] = { ...status.garage.observations[location], value: missing ? null : 0 };
        status.garage.learning.coefficients.rear.find(row => row.name === 'coolingPerHour').value = missing ? null : 0;
      }
      if (globalThis.garageBudgetSmokeState) {
        const state = globalThis.garageBudgetSmokeState, approved = state !== 'unapproved';
        status.garage.settings.protection = { ...status.garage.settings.protection, approved };
        status.garage.protection = { ...status.garage.protection, approved, safeToPause: true, reasons: [], limitingLocation: 'front', locations: {
          rear: { remainingKjPerM: 6.3, estimatedC: 5.5, fresh: true, uncertain: false, reason: null },
          front: { estimatedC: state === 'exhausted' ? 1 : 2.5,
            remainingKjPerM: state === 'exhausted' ? 0 : 2.1,
            fresh: state !== 'stale', uncertain: state === 'uncertain',
            reason: state === 'exhausted' ? 'reserve-exhausted' : null },
        } };
      }
      if (globalThis.chargingSmokeValues) {
        const states = typeof globalThis.chargingSmokeValues === 'string'
          ? [[null, globalThis.chargingSmokeValues]] : Object.entries(globalThis.chargingSmokeValues);
        for (const [chargerId, state] of states) {
          const manual = ['manual', 'manual-stop', 'handover-pending'].includes(state),
            controlled = manual || ['single', 'periods', 'paused', 'problem', 'progress', 'reported-progress', 'full', 'risk', 'waiting', 'provisional',
              'released', 'handover', 'unknown-controlled', 'disconnected-controlled'].includes(state);
          const charger = status.charging.chargers.find(item => item.id === (chargerId ?? (controlled ? 'charger1' : 'charger2')));
          const observation = value => ({ value, source: charger.id === 'charger1' ? 'bmw-cardata' : 'teslamate', available: true, measuredAt: null, receivedAt: status.now });
          charger.values.soc = { ...observation(62), measuredAt: status.now - 4 * 86400_000 };
          charger.values.minimumSoc = observation(85);
          charger.values.connected = observation(state.startsWith('unknown') ? null : !state.startsWith('disconnected'));
          charger.vehicle = { state: charger.values.connected.value === true ? 'identified' : 'disconnected',
            id: charger.id === 'charger1' ? 'bmw' : 'tesla', label: charger.id === 'charger1' ? 'BMW' : 'Tesla' };
          charger.values.scheduledStartAt = observation(status.now + 2 * 3600_000);
          charger.values.charging = observation(state === 'charging');
          charger.values.powerKw = observation(8.2);
          charger.requiredGridKwh = 15; charger.progress = null;
          charger.forecast = { state: 'forecast', feasible: true, startAt: status.now + 2 * 3600_000, finishAt: status.now + 3.5 * 3600_000,
            powerKw: 10, shortfallGridKwh: 0 };
          status.prices = [{ start: status.now, end: status.now + 24 * 3600_000, allInCentsPerKWh: 20 }];
          if (state === 'unavailable') charger.forecast = { state: 'unavailable', finishAt: null,
            reason: 'electrical-telemetry-unavailable', feasible: null };
          status.providers.teslamate = { enabled: true, status: 'idle', recording: false, reception: {
            brokerConnected: true, subscriptionStatus: 'subscribed', lastMessageAt: status.now, lastLiveAt: status.now } };
          status.charging.vehicleFeeds = [
            { id: 'bmw', label: 'BMW', provider: 'bmw-cardata', topic: 'fixture/vehicles/bmw',
              reception: { brokerConnected: true, subscriptionStatus: 'subscribed' } },
            { id: 'tesla', label: 'Tesla', provider: 'teslamate', topic: 'teslamate/cars/7/#',
              reception: status.providers.teslamate.reception },
          ];
          status.equipment.topicGroups = [...(status.equipment.topicGroups ?? []).filter(group => !['teslamate', 'charger1-vehicle', 'vehicle:bmw', 'vehicle:tesla'].includes(group.id)),
            { id: 'vehicle:tesla', vehicleFeedId: 'tesla', topics: [{ role: 'Vehicle subscription', topic: 'teslamate/cars/7/#', direction: 'subscribe' }] },
            { id: 'vehicle:bmw', vehicleFeedId: 'bmw', topics: [{ role: 'Timestamped vehicle readings', topic: 'fixture/vehicles/bmw', direction: 'subscribe' }] }];
          status.charging.coordination.assumptions.householdReference = { nights: 8, minimumNights: 6, limited: false,
            temperatureRangeC: [-5, 2], oldestAt: status.now - 220 * 86400_000, legacy: true };
          if (manual) {
            charger.settings.enabled = true;
            charger.control = { phase: 'yielded', manual: { kind: 'window', startsAt: status.now + 2 * 3600_000,
              resumeAt: status.now + 15 * 3600_000, windowEndAt: status.now + 17 * 3600_000, detectedAt: status.now - 3600_000, repeating: true } };
            charger.values.scheduledEndAt = observation(status.now + 17 * 3600_000);
            charger.telemetry = { scheduledEndKind: 'scheduled-stop' };
            charger.plan = { startAt: status.now + 3 * 3600_000, deadlineAt: status.now + 15 * 3600_000 };
            if (state === 'manual-stop') {
              charger.control.manual = { kind: 'stop', resumeAt: status.now + 15 * 3600_000,
                detectedAt: status.now - 3600_000, reason: 'Charging stopped from the charger app.' };
              charger.values.scheduledStartAt = observation(null);
            }
            if (state === 'handover-pending') charger.control.manual.resumeAt = status.now - 60_000;
          } else if (controlled) {
            charger.settings.enabled = true;
            charger.values.maximumCurrentA = observation(16); charger.values.availableCurrentA = observation(16);
            const periods = state === 'single' ? [{ startAt: status.now + 2 * 3600_000, endAt: null }]
              : [{ startAt: status.now + (state === 'paused' ? -2 : 2) * 3600_000,
                endAt: status.now + (state === 'paused' ? -1 : 3) * 3600_000 }, { startAt: status.now + 5 * 3600_000, endAt: null }];
            charger.plan = { startAt: periods[0].startAt, periods, finishAt: status.now + 10 * 3600_000,
              deadlineAt: status.now + 15 * 3600_000, costCents: 125, feasible: true };
            charger.forecast = { state: 'planned', feasible: true, finishAt: charger.plan.finishAt,
              powerKw: 10.7, shortfallGridKwh: 0 };
            charger.control = { phase: state === 'paused' ? 'paused' : 'waiting', owned: { startAt: state === 'paused' ? periods[1].startAt : periods[0].startAt },
              execution: { periods, deadlineAt: charger.plan.deadlineAt } };
            if (['progress', 'reported-progress', 'full'].includes(state)) {
              charger.values.soc = { ...observation(40), source: 'manual-fallback' };
              charger.values.charging = observation(true); charger.values.actualCurrentA = observation(16);
              charger.progress = { estimatedSoc: 52, estimatedSocSource: 'starting-charge', hasEnergyEstimate: true,
                deliveredGridKwh: 10, remainingGridKwh: 27 };
              charger.forecast = { feasible: true, finishAt: status.now + 10 * 3600_000 };
              charger.control = { phase: 'active', execution: { periods: [
                { startAt: status.now - 3600_000, endAt: status.now + 3600_000 }, periods[1] ] } };
              if (state === 'reported-progress') {
                charger.values.soc = { ...observation(85), measuredAt: status.now - 3600_000 };
                charger.values.minimumSoc = observation(95);
                charger.progress = { ...charger.progress, estimatedSoc: 89, estimatedSocSource: 'vehicle', deliveredGridKwh: 3.5, remainingGridKwh: 5 };
              }
              if (state === 'full') {
                charger.values.minimumSoc = observation(100);
                charger.progress = { ...charger.progress, estimatedSoc: 100, remainingGridKwh: 0 };
              }
            }
            if (state === 'problem') {
              charger.control.phase = 'unavailable'; charger.control.errorCode = 'readback-failed';
              charger.control.reason = 'Easee did not confirm the update. The last confirmed schedule may still be active; another reading will be requested.';
              charger.plan = { ...charger.plan, startAt: status.now + 3 * 3600_000, periods: [{ startAt: status.now + 3 * 3600_000, endAt: null }] };
            }
            if (state === 'risk') {
              charger.forecast = { ...charger.forecast, feasible: false, reason: 'insufficient-time',
                finishAt: status.now + 18 * 3600_000, shortfallGridKwh: 8.5 };
            }
            if (['waiting', 'provisional', 'released', 'handover'].includes(state)) {
              charger.control = { phase: state === 'waiting' ? 'planning' : state };
              charger.plan = { deadlineAt: status.now + 15 * 3600_000, periods: [] };
              charger.forecast = { state: 'unavailable', finishAt: null, feasible: null };
              charger.values.scheduledStartAt = observation(null);
            }
            if (state === 'handover') {
              charger.settings.enabled = false;
              charger.control = { phase: 'disabled', handoverConfirmed: false,
                reason: 'Automatic charging is off. The charger has not confirmed the handover; the last instruction may remain active.' };
            }
          }
        }
      }
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  await until("document.getElementById('charger1-setting-capacityKwh')?.disabled === false");
  assert.deepEqual(await evaluate("['control-title','garage-title'].map(id=>document.getElementById(id).textContent)"), ['Home', 'Garage']);
  await checkDashboardDisclosures({ evaluate, keyPress, until });
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#charging-devices > .equipment-device')].map(node=>node.id)"), ['charger1-device', 'charger2-device']);
  assert.deepEqual(await evaluate("['charger1-setting-minimumSoc','charger1-setting-readyBy','charger1-setting-capacityKwh','charger2-setting-capacityKwh'].map(id=>document.getElementById(id).value)"), ['80', '06:00', '74', '57']);
  assert.equal(await evaluate("document.getElementById('charger1-setting-manualSoc').value"), '20');
  assert.equal(await evaluate("document.getElementById('charger1-enabled').getAttribute('aria-checked')"), 'false');
  assert.equal(await evaluate("document.getElementById('charger1-setting-readyBy').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charger2-setting-readyBy').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charger2-enabled').disabled"), false);
  assert.notEqual(await evaluate("getComputedStyle(document.getElementById('charger2-setting-readyBy').closest('.charging-field')).display"), 'none',
    'Physical Charger 2 offers a ready-by setting');
  assert.notEqual(await evaluate("getComputedStyle(document.getElementById('charger2-enabled').parentElement).display"), 'none',
    'Physical Charger 2 offers automatic control independently of commissioning');
  assert.equal(await evaluate("[...document.querySelectorAll('#charging-devices > details')].some(fold=>fold.open)"), false);
  assert.equal(await evaluate("document.getElementById('charging-installation-details')"), null);
  assert.equal(await evaluate("document.querySelector('.charging-secondary, .charging-soc-form')"), null);
  assert.equal(await evaluate("document.querySelector('.charging-settings-form .status-detail-trigger')"), null,
    'Charger form guidance stays inline beside each input');
  await evaluate("document.getElementById('garage-equipment-details').open=true; true");
  for (const [charger, value] of [[1, '76'], [2, '59']]) {
    await evaluate(`(() => { document.getElementById('charger${charger}-device').open=true;
      const input=document.getElementById('charger${charger}-setting-capacityKwh'); input.value='${value}';
      input.dispatchEvent(new Event('input')); document.getElementById('charger${charger}-settings-form').requestSubmit(); })()`);
    await until(`document.getElementById('charger${charger}-settings-message').textContent === 'Settings saved.'`);
  }
  await evaluate("(() => { const field=document.getElementById('charger1-setting-manualSoc'); field.value='43'; field.dispatchEvent(new Event('input')); document.getElementById('charger1-settings-form').requestSubmit(); })()");
  await until("document.getElementById('charger1-settings-message').textContent==='Settings saved.'");
  await send('Page.reload');
  await until("document.getElementById('charger1-setting-capacityKwh')?.disabled === false");
  await until("typeof globalThis.refreshLearningSmokeStatus === 'function'");
  assert.deepEqual(await evaluate("['charger1-setting-capacityKwh','charger2-setting-capacityKwh'].map(id=>document.getElementById(id).value)"), ['76', '59']);
  assert.equal(await evaluate("document.getElementById('charger1-setting-manualSoc').value"), '43');
  assert.equal(await evaluate("document.getElementById('charger1-soc').textContent"), '—',
    'The saved starting charge does not appear as a current charge before a connection is known');
  assert.equal(await evaluate("document.getElementById('charger1-overview').hidden"), false);
  await evaluate("document.getElementById('garage-equipment-details').open=true; document.getElementById('charger1-device').open=true");
  const secondChargerNode = await evaluate("window.originalChargingSmokeNode=document.getElementById('charger2-device'); true");
  assert(secondChargerNode);
  await evaluate("globalThis.chargingSmokeValues='scheduled'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-soc').textContent==='62 %'");
  assert.equal(await evaluate("document.getElementById('charger2-setting-minimumSoc').value"), '85');
  assert.equal(await evaluate("document.getElementById('charger2-setting-minimumSoc').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').value"), '62');
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charger2-state').textContent"), 'Observed');
  assert.equal(await evaluate("document.getElementById('charger2-summary')"), null,
    'The Garage overview does not duplicate the visible charger card');
  assert.equal(await evaluate("document.getElementById('charger2-event-label').textContent"), 'Starts');
  assert.equal(await evaluate("document.getElementById('charger2-event-value').textContent"), '17:00');
  assert.equal(await evaluate("document.getElementById('charger2-completion').textContent"), '18:30');
  assert.equal(await evaluate("document.getElementById('charger2-cost').textContent"), '€3.00',
    'Observed charging estimates remaining cost from forecast time and the supplied electricity rates');
  assert.equal(await evaluate("document.getElementById('charger2-source-info') || document.getElementById('charger2-completion-info')"), null,
    'Charger bodies omit repeated charge-source and target-estimate links');
  assert.equal(await evaluate("document.querySelector('#charger2-device > summary').contains(document.getElementById('charger2-remaining'))"), true,
    'Grid energy is visible in the daily charger summary');
  assert.equal(await evaluate("['delivered', 'cost'].every(metric => document.querySelector('#charger2-device > summary').contains(document.getElementById('charger2-' + metric)))"), true,
    'Delivered energy and remaining charging cost are visible before opening the fold');
  assert.equal(await evaluate("document.querySelector('#charger2-device > summary').contains(document.getElementById('charger2-reading-time'))"), false,
    'The original reading timestamp remains available inside the equipment body');
  assert.equal(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:tesla:other\"] .equipment-device-status').textContent"), 'Connected');
  assert.equal(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:tesla:other\"] .equipment-connection-name').textContent"), 'Tesla');
  assert.equal(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:tesla:other\"] .equipment-connection-meta').textContent"), 'Vehicle · TeslaMate');
  assert.equal(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:bmw:other\"] .equipment-connection-name').textContent"), 'BMW');
  assert.equal(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:bmw:other\"] .equipment-connection-meta').textContent"), 'Vehicle · BMW CarData');
  assert.doesNotMatch(await evaluate("document.querySelector('[data-device-id=\"connection:vehicle:tesla:other\"]').textContent"), /No live report yet/);
  assert.equal(await evaluate("document.getElementById('charger2-device')===window.originalChargingSmokeNode"), true);
  const chargerMetricSelectors = {
    charge: '#charger2-charge-label', target: '#charger2-target-label', completion: '#charger2-completion-label',
    delivered: '#charger2-delivered-label', energy: '#charger2-energy-label', cost: '#charger2-cost-label',
    role: '#charger2-state', activity: '#charger2-event-value', context: '#charger2-notice',
  };
  for (const expanded of [false, true]) for (const [metric, selector] of Object.entries(chargerMetricSelectors)) {
    await evaluate(`(() => {
      document.getElementById('charger2-device').open=${expanded};
      const trigger = document.querySelector('${selector} .status-detail-trigger');
      globalThis.chargerMetricSmokeTrigger = trigger; trigger.focus();
    })()`);
    await pause(60);
    await keyPress('Enter');
    assert.equal(await evaluate("document.getElementById('status-detail-popover').hidden"), false);
    assert.equal(await evaluate("document.getElementById('charger2-device').open"), expanded,
      `${metric} help opens with Enter without toggling ${expanded ? 'open' : 'closed'} equipment`);
    await evaluate('globalThis.refreshLearningSmokeStatus()');
    assert.equal(await evaluate("document.getElementById('status-detail-popover').hidden"), false,
      'Metric help stays open during status refresh');
    await keyPress('Escape');
    assert.equal(await evaluate("document.activeElement===globalThis.chargerMetricSmokeTrigger"), true);
    await evaluate('globalThis.chargerMetricSmokeTrigger.click()');
    assert.equal(await evaluate("document.getElementById('status-detail-popover').hidden"), false);
    assert.equal(await evaluate("document.getElementById('charger2-device').open"), expanded,
      `${metric} help opens by pointer without toggling equipment`);
    await keyPress('Escape');
  }
  await evaluate("globalThis.chargingSmokeValues='charging'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-device').dataset.state==='Charging'");
  assert.equal(await evaluate("document.getElementById('charger2-state').textContent"), 'Observed');
  assert.match(await evaluate("document.getElementById('charger2-event').textContent"), /^Charging.*8.2 kW/);
  assert.doesNotMatch(await evaluate("document.getElementById('charger2-event').textContent"), /estimated/,
    'The completion estimate has its own consistent metric');
  await evaluate("globalThis.chargingSmokeValues='unavailable'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-completion').textContent==='No estimate'");
  await evaluate("globalThis.chargingSmokeValues='manual'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger1-device').dataset.state==='Manual schedule'");
  assert.equal(await evaluate("document.getElementById('charger1-state').textContent"), 'Manual override');
  assert.match(await evaluate("document.getElementById('charger1-event').textContent"), /^Manual window /);
  assert.doesNotMatch(await evaluate("document.getElementById('charger1-readings').textContent"), /Ready by|start|window|resumes|stopping/i);
  assert.equal(await evaluate("document.getElementById('charger1-resume').hidden"), false);
  assert.match(await evaluate("document.getElementById('charger1-priority').textContent"), /Automatic control resumes .*ready-by boundary/);
  assert.equal(await evaluate("document.getElementById('charger1-deadline').parentElement.hidden"), true);
  for (const [state, expected] of [['periods', 'Scheduled'], ['paused', 'Paused between periods'], ['problem', 'Update unconfirmed']]) {
    await evaluate(`globalThis.chargingSmokeValues='${state}'; globalThis.refreshLearningSmokeStatus()`);
    await until(`document.getElementById('charger1-device').dataset.state==='${expected}'`);
    assert.equal(await evaluate("document.getElementById('charger1-state').textContent"), state === 'problem' ? 'Control unconfirmed' : 'Controlled');
    assert.equal(await evaluate("document.getElementById('charger1-periods').children.length"), 4);
    assert.equal(await evaluate("document.getElementById('charger1-period-count').textContent"), '2 charging periods');
    assert.equal(await evaluate("document.getElementById('charger1-reading-time').hidden"), false);
    assert.match(await evaluate("document.getElementById('charger1-readings').textContent"), /Reported allowance16 A/);
    assert.match(await evaluate("document.getElementById('charger1-explanations').textContent"), /service and the Easee cloud/);
  }
  assert.match(await evaluate("document.getElementById('charger1-event').textContent"), /^Last confirmed start/);
  assert.match(await evaluate("document.getElementById('charger1-problem').textContent"), /did not confirm.*last confirmed schedule.*another reading/);
  await evaluate("globalThis.chargingSmokeValues='progress'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger1-soc').textContent==='≈52 %'");
  assert.match(await evaluate("document.getElementById('charger1-sources').textContent"), /Estimated/);
  assert.match(await evaluate("document.getElementById('charger1-remaining').textContent.toLowerCase()"), /remaining.*≈27 kwh|≈27 kwh.*remaining/);
  assert.equal(await evaluate("document.getElementById('charger1-deadline').textContent"), 'tomorrow 06:00');
  assert.equal(await evaluate("document.getElementById('charger1-completion').textContent"), 'tomorrow 01:00');
  assert.equal(await evaluate("document.getElementById('charger1-delivered').textContent"), '10 kWh');
  assert.match(await evaluate("document.getElementById('charger1-explanations').textContent"), /6–8 comparable nights/);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#charger1-readings dt')].slice(0,3).map(node=>node.textContent)"),
    ['Drawing now', 'Reported allowance', 'Charging limit']);
  await evaluate("globalThis.chargingSmokeValues='single'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger1-device').dataset.state==='Scheduled'");
  assert.equal(await evaluate("document.getElementById('charger1-periods').hidden"), false,
    'Every planned period remains visible inside the equipment details');
  assert.equal(await evaluate("document.getElementById('charger1-periods').textContent"), 'Period 117:00 onwards');
  assert.equal(await evaluate("document.getElementById('charger1-event-label').textContent"), 'Starts');
  assert.equal(await evaluate("document.getElementById('charger1-event-value').textContent"), '17:00');
  assert.equal(await evaluate("document.getElementById('charger1-cost').textContent"), '€1.25');
  assert.equal(await evaluate("document.getElementById('charger1-summary')"), null,
    'The Garage overview does not duplicate the controlled charger card');
  await evaluate(`(() => {
    const trigger = document.querySelector('#charger1-schedule-info .status-detail-trigger');
    globalThis.assertChargingSmokeTrigger = trigger; trigger.focus();
  })()`);
  await pause(60);
  await keyPress('Enter');
  assert.equal(await evaluate("assertChargingSmokeTrigger.getAttribute('aria-expanded')"), 'true');
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Reaching the target or ready-by time does not stop charging/);
  await evaluate('globalThis.refreshLearningSmokeStatus()');
  assert.equal(await evaluate("document.querySelector('#status-detail-popover').hidden"), false,
    'The charging schedule explanation stays open during status refresh');
  await keyPress('Escape');
  assert.equal(await evaluate("document.activeElement.textContent"), 'Charging schedule',
    'Escape returns focus to the current charging explanation trigger');
  await evaluate("globalThis.chargingSmokeValues='disconnected'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-device').dataset.state==='Not connected'");
  assert.equal(await evaluate("document.getElementById('charger2-overview').hidden"), false);
  assert.notEqual(await evaluate("getComputedStyle(document.getElementById('charger2-overview')).display"), 'none',
    'Disconnected charging retains the summary metric layout');
  assert.deepEqual(await evaluate("['soc', 'minimum', 'delivered', 'energy'].map(metric => document.getElementById('charger2-' + metric).textContent)"),
    ['—', '—', '—', '—'], 'Disconnected summaries replace stale charge and energy readings with dashes');
  assert.equal(await evaluate("document.getElementById('charger2-reading-time').hidden"), true);
  await evaluate("globalThis.chargingSmokeValues=null; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-setting-minimumSoc').disabled===false");
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').value"), '20');
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').disabled"), false);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.controller-column > article, .controller-panels > article')].map(card => card.id)"),
    ['home-control', 'providers-controls', 'garage-control'],
    'Home and Garage have separate dashboard cards beside Data & settings');
  assert.equal(await evaluate("[...document.querySelectorAll('#learning-metrics > details[data-learning-key]')].map(row => row.dataset.learningKey).join(',')"),
    'profit,auxProfit,recoveryError,indoorTemperature',
    'The existing Home outcome entries are preserved');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#learning-panel-details > details > summary')].map(row => row.textContent.trim())"),
    await evaluate("[...document.querySelectorAll('#garage-learning-details > details > summary')].map(row => row.textContent.trim())"),
    'Home and Garage use the same outcome, input, coefficient and planning headings');
  assert.match(await evaluate("document.getElementById('learning-progress').textContent"), /usable temperature intervals/);
  assert.match(await evaluate("document.getElementById('garage-learning-progress').textContent"), /completed cooling \/ recovery episodes.*OFF hours covered by validation/);
  assert.doesNotMatch(await evaluate("document.getElementById('garage-learning-progress').textContent"), /trained intervals|prediction checks/);
  for (const id of ['garage-learning-context', 'garage-input-context', 'garage-coefficient-context'])
    assert.ok((await evaluate(`document.getElementById('${id}').textContent`)).trim(), `${id} explains its list`);
  assert.equal(await evaluate("document.getElementById('garage-release').disabled"), true);
  assert.equal(await evaluate("document.getElementById('garage-controller-details').open || document.getElementById('garage-learning-details').open"), false);
  assert.equal(await evaluate("document.getElementById('garage-settings-details').open || document.getElementById('garage-recovery-details').open"), false,
    'Garage settings and recovery explanations start closed');
  for (const id of ['home-pump-device', 'garage-controller-details', 'charger1-device', 'charger2-device']) {
    await evaluate(`(() => {
      const device = document.getElementById('${id}'); device.open = false;
      for (let parent = device.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      device.querySelector(':scope > summary').focus();
    })()`);
    if (!id.startsWith('charger')) assert.equal(await evaluate(`document.querySelector('#${id} > summary').querySelector(
      'button, a, input, select, textarea, [tabindex]') === null`), true,
      `${id} summary has one disclosure action without nested interactive readings`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${id}').open
      && document.querySelector('#${id} > .equipment-device-body').checkVisibility()`), true,
      `${id} opens its readings and controls with Enter`);
    await evaluate('globalThis.refreshLearningSmokeStatus()');
    assert.equal(await evaluate(`document.getElementById('${id}').open
      && document.activeElement === document.querySelector('#${id} > summary')`), true,
      `${id} keeps its open body and keyboard focus after status refresh`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), false,
      `${id} closes with Space`);
    await clickSummaryPadding(id);
    assert.equal(await evaluate(`document.getElementById('${id}').open`), true,
      `${id} opens when clicking the summary surface outside its text`);
    await clickSummaryPadding(id);
    assert.equal(await evaluate(`document.getElementById('${id}').open`), false,
      `${id} closes from the same full-row click target`);
  }
  for (const [id, metrics] of [['home-pump-device', ['home-pump-state', 'home-pump-dhw', 'home-pump-room']],
    ['garage-controller-details', ['garage-native-power', 'garage-native-compressor', 'garage-native-target']]]) {
    assert.equal(await evaluate(`(() => {
      const device = document.getElementById('${id}'), summary = device.querySelector(':scope > summary');
      return !device.open && ${JSON.stringify(metrics)}.every(id => {
        const metric = document.getElementById(id);
        return summary.contains(metric) && metric.checkVisibility() && document.querySelectorAll('#' + id).length === 1;
      }) && device.querySelector(':scope > .equipment-device-body .pump-native-overview') === null;
    })()`), true, `${id} shows each primary reading once in its closed equipment row`);
  }
  assert.equal(await evaluate("document.getElementById('home-pump-preview') || document.getElementById('garage-pump-preview')"), null,
    'Native heat pumps use their actual metric rows instead of a second preview');
  assert.equal(await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.equipment-device-static')];
    for (const row of rows) for (let parent = row.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    return rows.length > 0 && rows.every(row => row.tagName === 'SECTION'
      && !row.querySelector(':scope > summary') && row.querySelector('.equipment-readings')?.checkVisibility()
      && ['none', 'normal', '""'].includes(getComputedStyle(row.querySelector('.equipment-device-summary'), '::after').content));
  })()`), true, 'Temperature-only equipment rows show their readings without a disclosure');
  for (const id of ['temporary-details', 'garage-pause-details']) {
    assert.equal(await evaluate(`document.getElementById('${id}').classList.contains('equipment-fold')`), true,
      `${id} uses the shared equipment disclosure style`);
    await evaluate(`(() => {
      const fold = document.getElementById('${id}'); fold.open=false;
      for (let parent = fold.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open=true;
      fold.querySelector(':scope > summary').focus();
    })()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), true);
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), false);
  }
  assert.equal(await evaluate("document.querySelector('#garage-equipment-details > summary').textContent.includes('Cold allowance')"), false,
    'The compact Garage summary keeps thermal allowance inside the detailed settings');
  assert.equal(await evaluate("document.getElementById('garage-budget-rear') || document.getElementById('garage-budget-front')"), null);
  assert.equal(await evaluate("document.querySelector('[data-scope=home]').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.getElementById('timing-details').open=true; document.querySelector('[data-scope=garage]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /-€1.00.*Provisional/);
  await evaluate("document.querySelector('[data-scope=total]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /€2.00/);
  await evaluate("document.querySelector('[data-mode=timing]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /Timing cost saving/);
  await evaluate("document.querySelector('[data-scope=home]').click(); document.querySelector('[data-mode=model]').click()");
  const learningSections = [
    ['learning-metrics', 'home-outcomes'], ['model-inputs-content', 'home-inputs'],
    ['model-coefficients-content', 'home-coefficients'], ['garage-learning-outcomes', 'garage-outcomes'],
    ['garage-learning-inputs', 'garage-inputs'], ['garage-learning-coefficients', 'garage-coefficients'],
    ['learning-policy-content', 'home-planning'], ['garage-learning-planning', 'garage-planning'],
  ];
  for (const [id, name] of learningSections) {
    assert.equal(await evaluate(`(() => {
      const root = document.getElementById('${id}'), section = root.closest('.learning-section');
      return Boolean(section?.querySelector(':scope > summary > .learning-section-title')
        && section.querySelector(':scope > summary > .learning-section-kind')
        && section.querySelector(':scope > .learning-section-body')?.contains(root));
    })()`), true, `${name} uses the shared section structure`);
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#${id} > details.learning-entry')];
      return rows.length > 0 && rows.every(row => row.dataset.learningKey
        && row.querySelector(':scope > summary .learning-entry-title')?.textContent.trim()
        && row.querySelector(':scope > summary .learning-entry-value')?.textContent.trim()
        && row.querySelector(':scope > .learning-entry-body'));
    })()`), true, `${name} uses named, expandable learning rows`);
    await evaluate(`(() => {
      const row = document.querySelector('#${id} > details.learning-entry'); row.open = false;
      for (let parent = row.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      row.querySelector('summary').focus();
    })()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry').open`), true,
      `${name} row opens with Enter`);
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry > .learning-entry-body').checkVisibility()`), true,
      `${name} explanation becomes visible`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry').open`), false,
      `${name} row closes with Space`);
    await evaluate(`(() => {
      const section = document.getElementById('${id}').closest('.learning-section');
      section.querySelector(':scope > summary').focus();
    })()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${id}').closest('.learning-section').open`), false,
      `${name} section closes with Enter`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').closest('.learning-section').open`), true,
      `${name} section opens with Space`);
  }
  // Every list keeps its row mounted across polling, including Home's static input controls.
  for (const [id, name] of learningSections) {
    await evaluate(`(() => {
      const row = document.querySelector('#${id} > details.learning-entry');
      globalThis.learningSmokeRow = row; row.open = true;
      for (let parent = row.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      row.querySelector('summary').focus();
    })()`);
    await evaluate('globalThis.refreshLearningSmokeStatus()');
    assert.equal(await evaluate(`globalThis.learningSmokeRow === document.querySelector('#${id} > details.learning-entry')
      && globalThis.learningSmokeRow.open
      && document.activeElement === globalThis.learningSmokeRow.querySelector('summary')`), true,
    `${name} preserves the row, open explanation and keyboard focus during status refresh`);
  }
  assert.equal(await evaluate("document.getElementById('sensor-change-form').closest('.learning-entry-body')?.parentElement.dataset.modelInput"),
    'model_indoor_temperature', 'Indoor sensor maintenance stays inside its model input explanation');
  assert.equal(await evaluate("document.getElementById('outdoor-sensor-change-form').closest('.learning-entry-body')?.parentElement.dataset.modelInput"),
    'model_outdoor_temperature', 'Outdoor sensor maintenance stays inside its model input explanation');
  const valueCases = [
    ['#learning-metrics [data-learning-key=profit]', /^0[.,]00 €/],
    ['#model-coefficients-content [data-learning-key=lossPerHour]', /^0[.,]0+ 1\/h$/],
    ['#garage-learning-inputs [data-learning-key=rear-air-temperature]', /^0 °C(?: · stale)?$/],
    ['#garage-learning-inputs [data-learning-key=front-air-temperature]', /^0 °C(?: · stale)?$/],
    ['#garage-learning-coefficients [data-learning-key=rear-cooling-rate]', /^0 1\/h$/],
  ];
  await evaluate(`(() => {
    globalThis.learningSmokeValueRows = ${JSON.stringify(valueCases.map(([selector]) => selector))}.map(selector => {
      const row = document.querySelector(selector); row.open = true; return row;
    });
    const row = globalThis.learningSmokeValueRows.at(-1);
    for (let parent = row.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    row.querySelector('summary').focus();
  })()`);
  for (const mode of ['zero', 'missing']) {
    await evaluate(`globalThis.learningSmokeValues = '${mode}'; globalThis.refreshLearningSmokeStatus()`);
    assert.equal(await evaluate(`globalThis.learningSmokeValueRows.every(row => row.isConnected && row.open)
      && document.activeElement === globalThis.learningSmokeValueRows.at(-1).querySelector('summary')`), true,
      `${mode} status values update mounted rows without closing explanations or losing focus`);
    for (const [selector, zero] of valueCases) {
      const value = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.querySelector('.learning-entry-value').textContent`);
      assert.match(value, mode === 'zero' ? zero : /Unavailable|Not available yet/,
        `${selector} distinguishes an observed zero from unavailable evidence`);
    }
  }
  await evaluate('globalThis.learningSmokeValues = null; globalThis.refreshLearningSmokeStatus()');

  await evaluate(`(() => {
    const settings = document.getElementById('garage-settings-details');
    for (let parent = settings; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    settings.querySelector(':scope > summary').focus();
  })()`);
  for (const id of ['garage-heating-settings', 'garage-protection-settings', 'garage-recovery-settings']) {
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#${id} > .garage-setting')];
      return rows.length > 0 && rows.every(row => row.querySelector(':scope > dt small')?.textContent.trim()
        && row.querySelector(':scope > dd')?.textContent.trim()
        && row.querySelector(':scope > dd').children.length === 0);
    })()`), true, `${id} puts setting explanations beside plain values`);
  }
  assert.equal(await evaluate(`(() => {
    const live = document.getElementById('garage-live-budgets');
    return live.tagName === 'SECTION' && live.closest('#garage-settings-details') !== null
      && !live.closest('dl') && !live.querySelector('.garage-setting');
  })()`), true, 'Live cold budgets have a separate section outside configured setting rows');
  await evaluate("document.querySelector('#garage-recovery-details > summary').focus()");
  await keyPress('Enter');
  assert.equal(await evaluate("document.getElementById('garage-recovery-details').open"), true,
    'Recovery explanations open with Enter');
  await keyPress(' ');
  assert.equal(await evaluate("document.getElementById('garage-recovery-details').open"), false,
    'Recovery explanations close with Space');
  await evaluate("globalThis.garageBudgetSmokeState = 'available'; globalThis.refreshLearningSmokeStatus()");
  assert.deepEqual(await evaluate("['rear','front'].map(location => document.getElementById('garage-settings-budget-' + location).textContent)"),
    ['6.3 kJ/m', '2.1 kJ/m'], 'Detailed settings show independent live thermal reserves');
  assert.match(await evaluate("document.getElementById('garage-settings-budget-rear-remaining').textContent"), /Reference estimate 5\.5 °C/);
  assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"), /Reference estimate 2\.5 °C/);
  assert.equal(await evaluate("document.querySelector('#garage-live-budgets meter') === null"), true,
    'Thermal reserves have no invented full-budget meter');
  const configuredValues = await evaluate("[...document.querySelectorAll('#garage-settings-details .garage-setting > dd')].map(node => node.textContent)");
  for (const value of ['1 °C', '21 mm', '1 mm', '20 W/m²K', '2×'])
    assert(configuredValues.includes(value), 'The reference assumptions and fixed safety factor are visible');
  assert(!configuredValues.some(value => value.includes('°C·min')), 'The former fixed allowance is absent');
  await evaluate(`(() => {
    globalThis.garageBudgetSmokeTriggers = ['rear','front'].map(location =>
      document.querySelector('#garage-settings-budget-' + location + ' .status-detail-trigger'));
    document.getElementById('garage-recovery-details').open = true;
    globalThis.garageBudgetSmokeTriggers[1].focus();
  })()`);
  const unavailableReasons = { stale: /fresh|report|reading/i, uncertain: /history|uncertain|recover/i, unapproved: /approv/i };
  for (const state of ['stale', 'uncertain', 'unapproved', 'exhausted', 'available']) {
    await evaluate(`globalThis.garageBudgetSmokeState = '${state}'; globalThis.refreshLearningSmokeStatus()`);
    const unavailable = Object.hasOwn(unavailableReasons, state), frontValue = unavailable ? '—' : state === 'exhausted' ? '0 kJ/m' : '2.1 kJ/m';
    assert.equal(await evaluate("document.getElementById('garage-settings-budget-front').textContent"), frontValue,
      `${state} live evidence is reflected in settings`);
    if (unavailable) assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"),
      unavailableReasons[state], `${state} explains why the current budget is unavailable`);
    if (state === 'exhausted') {
      assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"), /Allowance exhausted/);
    }
    assert.equal(await evaluate("document.getElementById('garage-settings-budget-rear').textContent"), state === 'unapproved' ? '—' : '6.3 kJ/m',
      `${state} keeps the rear assessment independent`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#garage-settings-details .garage-setting > dd')].map(node => node.textContent)"),
      configuredValues, `${state} changes live budgets without changing configured values`);
    assert.equal(await evaluate(`globalThis.garageBudgetSmokeTriggers.every((node, index) => node ===
      document.querySelector('#garage-settings-budget-' + ['rear','front'][index] + ' .status-detail-trigger'))
      && document.getElementById('garage-recovery-details').open
      && document.activeElement === globalThis.garageBudgetSmokeTriggers[1]`), true,
      `${state} status refresh preserves budget triggers, keyboard focus and expanded recovery explanations`);
  }
  await keyPress('Enter');
  assert.equal(await evaluate("globalThis.garageBudgetSmokeTriggers[1].getAttribute('aria-expanded')"), 'true',
    'The live budget explanation opens with Enter');
  await evaluate('globalThis.refreshLearningSmokeStatus()');
  assert.equal(await evaluate("globalThis.garageBudgetSmokeTriggers[1].getAttribute('aria-expanded')"), 'true',
    'An open budget explanation survives status refresh');
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click()");
  assert.equal(await evaluate('document.activeElement === globalThis.garageBudgetSmokeTriggers[1]'), true,
    'Closing a budget explanation returns focus to its trigger');

  const prepareLearningShot = async (id, expanded) => evaluate(`(async () => {
    document.querySelectorAll('.learning-model-details, .learning-model-details details').forEach(fold => fold.open = false);
    const root = document.getElementById('${id}'), section = root.closest('.learning-section');
    for (let parent = section; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    if (${expanded}) root.querySelector(':scope > details.learning-entry').open = true;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    section.scrollIntoView({block: 'start'});
  })()`);
  const chargerSummaryHeights = new Map();
  const checkChargerSummaries = async name => {
    const summaries = await evaluate(`Array.from(document.querySelectorAll('#charging-devices > details > summary'))
      .filter(summary => summary.checkVisibility()).map(summary => {
        const box = summary.getBoundingClientRect(), problems = [];
        const bands = [...summary.children].filter(band => band.checkVisibility()).map(band => ({
          element: band, name: band.id || band.className, box: band.getBoundingClientRect(),
        })).filter(band => band.box.width && band.box.height);
        const inside = (outer, inner) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1
          && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
        if (summary.scrollHeight > summary.clientHeight + 1)
          problems.push({ verticalOverflow: summary.scrollHeight - summary.clientHeight });
        for (const [index, band] of bands.entries()) {
          if (!inside(box, band.box)) problems.push({ band: band.name, outsideSummary: true });
          for (const other of bands.slice(index + 1)) {
            const overlapX = Math.min(band.box.right, other.box.right) - Math.max(band.box.left, other.box.left);
            const overlapY = Math.min(band.box.bottom, other.box.bottom) - Math.max(band.box.top, other.box.top);
            if (overlapX > 1 && overlapY > 1)
              problems.push({ overlappingBands: [band.name, other.name], overlapY });
          }
        }
        const fields = [...summary.querySelectorAll('h4, strong, small, p, .equipment-device-status, .status-detail-trigger')]
          .filter(field => field.checkVisibility());
        for (const field of fields) {
          const bounds = field.getBoundingClientRect(), band = bands.find(band => band.element.contains(field));
          const style = getComputedStyle(field);
          const expandableClamp = field.classList.contains('status-detail-trigger') && style.overflowY === 'hidden'
            && Number.parseInt(style.webkitLineClamp, 10) > 0;
          const range = document.createRange(); range.selectNodeContents(field);
          const percentWrap = /-(?:soc|minimum)$/.test(field.id) && /%$/.test(field.textContent)
            && range.getBoundingClientRect().height > parseFloat(style.lineHeight) + 1;
          if (!inside(box, bounds) || band && !inside(band.box, bounds)
            || field.scrollWidth > field.clientWidth + 1 || !expandableClamp && field.scrollHeight > field.clientHeight + 1 || percentWrap)
            problems.push({ field: field.id || field.className, band: band?.name, percentWrap,
              width: field.clientWidth, scrollWidth: field.scrollWidth,
              height: field.clientHeight, scrollHeight: field.scrollHeight,
              bandOverflow: band ? { left: band.box.left - bounds.left, right: bounds.right - band.box.right,
                top: band.box.top - bounds.top, bottom: bounds.bottom - band.box.bottom } : null });
        }
        return { id: summary.parentElement.id, viewport: innerWidth, height: box.height, problems };
      })`);
    assert.equal(summaries.length, 2, `${name} keeps both charger summaries visible`);
    for (const summary of summaries.filter(summary => summary.problems.length)) {
      await evaluate(`document.getElementById('${summary.id}').scrollIntoView({block: 'start'})`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `${name}-overflow-${summary.id}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    assert.deepEqual(summaries.filter(summary => summary.problems.length), [],
      `${name} keeps summary bands separate and all charging text inside its reserved space`);
    for (const summary of summaries) {
      const key = `${summary.viewport}:${summary.id}`;
      if (!chargerSummaryHeights.has(key)) chargerSummaryHeights.set(key, summary.height);
      assert.ok(Math.abs(summary.height - chargerSummaryHeights.get(key)) <= 1,
        `${name} keeps ${summary.id} at its fixed ${chargerSummaryHeights.get(key)}px summary height (was ${summary.height}px)`);
    }
    assert.ok(Math.abs(summaries[0].height - summaries[1].height) <= 1,
      `${name} gives both charging roles the same summary height`);
  };
  const checkChargerPlacement = async (name, sideBySide) => {
    const layout = await evaluate(`(() => {
      const devices = [...document.querySelectorAll('#charging-devices > details')];
      return devices.map(device => {
        const box = device.getBoundingClientRect(), summary = device.querySelector(':scope > summary').getBoundingClientRect();
        return { id: device.id, open: device.open, left: box.left, top: box.top,
          right: box.right, bottom: box.bottom, width: box.width, height: box.height, summaryHeight: summary.height };
      });
    })()`);
    assert.equal(layout.length, 2);
    assert.ok(Math.abs(layout[0].width - layout[1].width) <= 1, `${name} gives both chargers equal width`);
    if (sideBySide) {
      assert.ok(Math.abs(layout[0].top - layout[1].top) <= 1 && layout[0].right < layout[1].left,
        `${name} places Charger 1 and Charger 2 alongside each other`);
    } else {
      assert.ok(Math.abs(layout[0].left - layout[1].left) <= 1 && layout[0].bottom < layout[1].top,
        `${name} stacks Charger 2 below Charger 1`);
    }
    return layout;
  };
  const checkIndependentChargerFolds = async (name, sideBySide) => {
    await evaluate("document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false)");
    const baseline = await checkChargerPlacement(`${name}-closed`, sideBySide);
    for (const openedIndex of [0, 1]) {
      await evaluate(`document.querySelectorAll('#charging-devices > details').forEach((device, index) => device.open = index === ${openedIndex})`);
      const layout = await checkChargerPlacement(`${name}-charger${openedIndex + 1}-open`, sideBySide);
      const siblingIndex = 1 - openedIndex;
      assert.equal(layout[siblingIndex].open, false, `${name} opens each charger independently`);
      assert.ok(layout[openedIndex].height > baseline[openedIndex].height,
        `${name} reveals the selected charger's details`);
      assert.ok(Math.abs(layout[siblingIndex].height - baseline[siblingIndex].height) <= 1,
        `${name} keeps the closed sibling card from stretching`);
      await checkChargerSummaries(`${name}-charger${openedIndex + 1}-open`);
    }
    await evaluate("document.querySelectorAll('#charging-devices > details').forEach(device => device.open = false)");
  };
  const capture = async (name, { fullPage = false } = {}) => {
    await pause(60);
    const size = fullPage ? (await send('Page.getLayoutMetrics')).cssContentSize : null;
    const screenshot = await send('Page.captureScreenshot', { format: 'png',
      ...(size ? { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}) });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} fits the viewport`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.learning-entry > summary')).filter(node => node.checkVisibility())
      .flatMap(node => {
        const box = node.getBoundingClientRect();
        const contentFits = [...node.querySelectorAll('.learning-entry-title, .learning-entry-value, .learning-entry-provenance, .learning-entry-summary')]
          .filter(field => field.checkVisibility()).every(field => {
            const fieldBox = field.getBoundingClientRect();
            return fieldBox.left >= box.left - 1 && fieldBox.right <= box.right + 1
              && field.scrollWidth <= field.clientWidth + 1;
          });
        return box.left >= 0 && box.right <= innerWidth + 1 && contentFits ? []
          : [{ key: node.parentElement.dataset.learningKey, left: box.left, right: box.right, contentFits }];
      })`), [], `${name} keeps learning text within its rows`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#garage-settings-details .garage-setting, #garage-live-budgets'))
      .filter(node => node.checkVisibility()).flatMap(node => {
        const box = node.getBoundingClientRect();
        const fields = [...node.querySelectorAll('dt, dd, small, meter, .status-detail-trigger')].filter(field => field.checkVisibility());
        const contentFits = fields.every(field => {
          const bounds = field.getBoundingClientRect();
          return bounds.left >= box.left - 1 && bounds.right <= box.right + 1
            && field.scrollWidth <= field.clientWidth + 1;
        });
        return box.left >= 0 && box.right <= innerWidth + 1 && contentFits ? []
          : [{ id: node.id, left: box.left, right: box.right, contentFits }];
      })`), [], `${name} keeps garage settings and live budget content within their sections`);
    await checkChargerSummaries(name);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#charging-devices > details'))
      .filter(device => device.querySelector('.charging-overview').checkVisibility()).flatMap(device => {
        const id = device.id.replace(/-device$/, ''), errors = [];
        const range = document.createRange(), textBox = element => {
          range.selectNodeContents(element); return range.getBoundingClientRect();
        };
        for (const [upper, lower] of [['soc', 'delivered'], ['minimum', 'energy'], ['completion', 'cost']]) {
          const first = textBox(document.getElementById(id + '-' + upper));
          const second = textBox(document.getElementById(id + '-' + lower));
          const firstAnchor = upper === 'completion' ? first.left : (first.left + first.right) / 2;
          const secondAnchor = upper === 'completion' ? second.left : (second.left + second.right) / 2;
          if (Math.abs(firstAnchor - secondAnchor) > 1) {
            const lowerElement = document.getElementById(id + '-' + lower);
            errors.push({ upper, lower, first: firstAnchor, second: secondAnchor,
              upperTextWidth: first.width, lowerTextWidth: second.width,
              valueWidth: lowerElement.getBoundingClientRect().width,
              columnWidth: lowerElement.parentElement.getBoundingClientRect().width });
          }
        }
        const arrowElement = device.querySelector('.charging-progress-arrow');
        if (!arrowElement.checkVisibility()) return errors.length ? [{ id, errors }] : [];
        range.selectNodeContents(arrowElement); const arrow = range.getBoundingClientRect();
        range.selectNodeContents(document.getElementById(id + '-soc')); const charge = range.getBoundingClientRect();
        const difference = Math.abs((arrow.top + arrow.bottom - charge.top - charge.bottom) / 2);
        if (difference > 4) errors.push({ arrowCenterDifference: difference });
        const target = textBox(document.getElementById(id + '-minimum'));
        const expectedArrowCenter = (charge.left + charge.right + target.left + target.right) / 4;
        const midpointDifference = Math.abs((arrow.left + arrow.right) / 2 - expectedArrowCenter);
        const narrowColumns = device.clientWidth <= 360;
        if (midpointDifference > (narrowColumns ? 6 : 1)) errors.push({ arrowMidpointDifference: midpointDifference });
        return errors.length ? [{ id, errors }] : [];
      })`), [], `${name} aligns daily charger facts with the overview and centers the charge arrow`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.native-heat-pump > summary .pump-native-overview strong'))
      .filter(value => value.checkVisibility() && value.childNodes.length === 1 && value.firstChild.nodeType === Node.TEXT_NODE)
      .flatMap(value => {
        const broken = [], lineHeight = parseFloat(getComputedStyle(value).lineHeight);
        for (const word of value.textContent.matchAll(/\\S+/g)) {
          const range = document.createRange(); range.setStart(value.firstChild, word.index);
          range.setEnd(value.firstChild, word.index + word[0].length);
          if (range.getBoundingClientRect().height > lineHeight + 1) broken.push(word[0]);
        }
        return broken.length ? [{ id: value.id, broken }] : [];
      })`), [], `${name} keeps native heat-pump values readable without breaking words`);
  };
  const chargingCases = [
    ['unknown', 'charger2', 'Connection unknown'], ['disconnected', 'charger2', 'Not connected'],
    ['unknown-controlled', 'charger1', 'Connection unknown'], ['disconnected-controlled', 'charger1', 'Not connected'],
    ['full', 'charger1', 'Charging'], ['single', 'charger1', 'Scheduled'], ['manual', 'charger1', 'Manual schedule'],
    ['manual-stop', 'charger1', 'Manual control'], ['handover-pending', 'charger1', 'Handover pending'],
    ['handover', 'charger1', 'Handover unconfirmed'], ['waiting', 'charger1', 'Connected'],
    ['provisional', 'charger1', 'Connected'], ['released', 'charger1', 'Connected'],
    ['risk', 'charger1', 'Scheduled'], ['periods', 'charger1', 'Scheduled'],
    ['paused', 'charger1', 'Paused between periods'], ['problem', 'charger1', 'Update unconfirmed'],
    ['scheduled', 'charger2', 'Connected'], ['unavailable', 'charger2', 'Connected'],
    ['charging', 'charger2', 'Charging'], ['progress', 'charger1', 'Charging'], ['reported-progress', 'charger1', 'Charging'],
  ];
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 600 ? 1100 : 844, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('.controller-panels details').forEach(fold => fold.open = false);
        document.getElementById('home-control').scrollIntoView({block: 'start'})`);
      await checkDashboardLayout({ evaluate, width });
      await capture(`dashboard-${width}-${theme}`);
      await checkIndependentChargerFolds(`${width}-${theme}`, width === 1440);
      await evaluate("globalThis.chargingSmokeValues={charger1:'progress',charger2:'charging'}; globalThis.nativePumpSmokeValues=true; globalThis.refreshLearningSmokeStatus()");
      await until("['charger1','charger2'].every(id=>document.getElementById(id+'-device').dataset.state==='Charging')");
      await evaluate("document.querySelectorAll('details').forEach(fold=>fold.open=false); document.activeElement?.blur(); window.scrollTo(0,0)");
      await capture(`dashboard-active-${width}-${theme}`, { fullPage: true });
      await capture(`dashboard-active-overview-${width}-${theme}`);
      await checkIndependentChargerFolds(`active-${width}-${theme}`, width === 1440);
      await evaluate("globalThis.chargingSmokeValues=null; globalThis.nativePumpSmokeValues=false; globalThis.refreshLearningSmokeStatus()");
      await until("document.getElementById('charger2-setting-manualSoc').disabled===false");
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('.learning-model-details, .learning-model-details details').forEach(fold => fold.open = false);
        document.getElementById('home-heat-pump-details').open = true;
        document.getElementById('learning-panel-details').scrollIntoView({block: 'start'})`);
      await capture(`learning-overview-${width}-${theme}`);
      for (const [id, name] of learningSections) {
        for (const expanded of [false, true]) {
          await prepareLearningShot(id, expanded);
          await capture(`${name}-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
        }
      }
      for (const expanded of [false, true]) {
        await evaluate(`(async () => {
          const settings = document.getElementById('garage-settings-details');
          for (let parent = settings; parent; parent = parent.parentElement)
            if (parent.tagName === 'DETAILS') parent.open = true;
          document.getElementById('garage-recovery-details').open = ${expanded};
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          settings.scrollIntoView({block: 'start'});
        })()`);
        await capture(`garage-settings-${width}-${theme}-${expanded ? 'recovery-expanded' : 'recovery-collapsed'}`);
      }
      await evaluate("document.getElementById('garage-live-budgets').scrollIntoView({block: 'center'})");
      await capture(`garage-live-budgets-${width}-${theme}`);
      for (const [area, fold] of [['home', 'temporary-details'], ['garage', 'garage-pause-details']]) {
        await evaluate(`(() => {
          const element = document.getElementById('${fold}');
          for (let parent = element; parent; parent = parent.parentElement)
            if (parent.tagName === 'DETAILS') parent.open = true;
          element.scrollIntoView({block:'start'});
        })()`);
        await capture(`${area}-availability-${width}-${theme}`);
        await evaluate(`document.getElementById('${fold}').open=false`);
      }
      await evaluate("globalThis.nativePumpSmokeValues=true; globalThis.refreshLearningSmokeStatus()");
      await until("document.getElementById('home-pump-state').textContent==='Running'");
      assert.equal(await evaluate("document.getElementById('home-pump-state-age').textContent"), 'for at least 1 h 15 min');
      for (const [area, zone, device] of [
        ['home', 'home-equipment-details', 'home-pump-device'],
        ['garage', 'garage-equipment-details', 'garage-controller-details'],
      ]) {
        for (const expanded of [false, true]) {
          await evaluate(`document.getElementById('${zone}').open=true;
            document.querySelectorAll('#${area}-equipment-section details').forEach(fold=>fold.open=false);
            document.getElementById('${device}').open=${expanded};
            document.getElementById('${area}-equipment-section').scrollIntoView({block:'start'})`);
          await capture(`${area}-equipment-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
        }
        await evaluate(`document.querySelector('#${area}-equipment-section .equipment-device-static').scrollIntoView({block:'center'})`);
        await capture(`${area}-temperatures-${width}-${theme}`);
      }
      for (const expanded of [false, true]) {
        await evaluate(`document.querySelectorAll('#charging-devices > details').forEach(fold=>fold.open=${expanded});
          document.getElementById('charger1-device').scrollIntoView({block:'start'})`);
        await capture(`chargers-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
      }
      for (const [state, id, expected] of chargingCases) {
        await evaluate(`globalThis.chargingSmokeValues='${state}'; globalThis.refreshLearningSmokeStatus()`);
        await until(`document.getElementById('${id}-device').dataset.state==='${expected}'`);
        if (state === 'unavailable') await until(`document.getElementById('${id}-completion').textContent==='No estimate'`);
        if (state === 'full') await until(`document.getElementById('${id}-completion').textContent==='Reached'`);
        for (const expanded of [false, true]) {
          await evaluate(`document.querySelectorAll('#charging-devices > details').forEach(fold => fold.open=${expanded});
            document.getElementById('${id}-device').scrollIntoView({block:'start'})`);
          await checkChargerSummaries(`charger-${state}-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
        }
        await capture(`charger-${state}-${width}-${theme}`);
        if (state === 'full') {
          await evaluate("document.getElementById('charger1-soc').textContent='≈99.9 %'");
          await capture(`charger-fractional-percentage-${width}-${theme}`);
          await evaluate("document.getElementById('charger1-soc').textContent='≈100 %'");
        }
        if (state === 'single') for (const [help, target] of [['schedule', 'schedule-info'], ['metric', 'charge-label'], ['context', 'notice']]) {
          await evaluate(`document.querySelector('#charger1-${target} .status-detail-trigger').scrollIntoView({block:'center'})`);
          await pause(60);
          await evaluate(`document.querySelector('#charger1-${target} .status-detail-trigger').click()`);
          await capture(`charger-${help}-help-${width}-${theme}`);
          assert.equal(await evaluate(`(() => {
            const popover = document.getElementById('status-detail-popover'), box = popover.getBoundingClientRect();
            return !popover.hidden && box.width > 0 && box.height > 0
              && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
          })()`), true, `Charging help stays within the ${width}px ${theme} viewport`);
          await keyPress('Escape');
        }
        if (state === 'periods') {
          await evaluate("document.getElementById('charger1-explanation-details').open=true; document.getElementById('charger1-explanation-details').scrollIntoView({block:'start'})");
          await capture(`charger-explanations-${width}-${theme}`);
          await evaluate("document.getElementById('charger1-explanation-details').open=false");
        }
      }
      await evaluate("globalThis.chargingSmokeValues=null; globalThis.nativePumpSmokeValues=false; globalThis.refreshLearningSmokeStatus()");
      await until("document.getElementById('charger2-setting-manualSoc').disabled===false");
    }
    // Preserve the equipment and savings layout checks from this smoke test.
    for (const [id, name] of [['timing-details', 'savings'], ['garage-controller-details', 'equipment'], ['charger1-device', 'charging']]) {
      await evaluate(`(() => { const element = document.getElementById('${id}'); element.open = true;
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
          if (parent.tagName === 'DETAILS') parent.open = true;
        element.scrollIntoView({block: 'start'}); })()`);
      await capture(`${name}-${width}`);
    }
  }
  // Responsive reflow and status polling must keep an in-progress edit intact.
  await evaluate(`(() => {
    const device = document.getElementById('charger1-device'); device.open = true;
    globalThis.chargingSmokeEdit = document.getElementById('charger1-setting-capacityKwh');
    globalThis.chargingSmokeSavedCapacity = globalThis.chargingSmokeEdit.value;
    globalThis.chargingSmokeEdit.value = '78.5'; globalThis.chargingSmokeEdit.dispatchEvent(new Event('input'));
    globalThis.chargingSmokeEdit.focus();
  })()`);
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate('globalThis.refreshLearningSmokeStatus()');
    assert.equal(await evaluate(`document.getElementById('charger1-setting-capacityKwh') === globalThis.chargingSmokeEdit
      && globalThis.chargingSmokeEdit.value === '78.5' && document.activeElement === globalThis.chargingSmokeEdit
      && document.getElementById('charger1-device').open`), true,
      `An unsaved charger setting, focus and open fold survive polling at ${width}px`);
  }
  await evaluate(`globalThis.chargingSmokeEdit.value = globalThis.chargingSmokeSavedCapacity;
    globalThis.chargingSmokeEdit.dispatchEvent(new Event('input')); document.getElementById('charger1-settings-form').requestSubmit()`);
  await until("document.getElementById('charger1-settings-message').textContent==='Settings saved.'");
  // Cover the single-column tablet layout, narrow desktop columns, and both sides of pairing.
  for (const width of [624, 625, 626, 640, 768, 900, 1024, 1200, 1266, 1267, 1268, 1280, 1366, 1920]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}')`);
      const sideBySide = await evaluate("document.querySelector('.garage-chargers').getBoundingClientRect().width >= 540");
      await checkIndependentChargerFolds(`${width}-${theme}`, sideBySide);
      for (const state of ['full', 'progress']) {
        await evaluate(`globalThis.chargingSmokeValues='${state}'; globalThis.refreshLearningSmokeStatus()`);
        await until(`document.getElementById('charger1-soc').textContent==='${state === 'full' ? '≈100 %' : '≈52 %'}'`);
        for (const expanded of [false, true]) {
          await evaluate(`document.querySelectorAll('#charging-devices > details').forEach(fold => fold.open=${expanded});
            document.getElementById('charger1-device').scrollIntoView({block:'start'})`);
          await capture(`charger-${state}-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
        }
        if (state === 'full') {
          await evaluate("document.getElementById('charger1-soc').textContent='≈99.9 %'");
          await capture(`charger-fractional-percentage-${width}-${theme}`);
        }
      }
    }
  }
  await evaluate("globalThis.chargingSmokeValues=null; globalThis.refreshLearningSmokeStatus()");
  for (const left of ['garage_model_front', 'garage_model_difference', 'garage_coefficient_rear_coolingPerHour']) {
    await evaluate(`document.getElementById('left-axis').value='${left}'; document.getElementById('left-axis').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('history').dataset.ready==='true' && document.getElementById('history').dataset.left==='${left}'`);
    assert.equal(await evaluate("document.getElementById('chart-status').textContent.includes('No recorded values')"), false, left);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'garage-browser-smoke-passed', artifacts,
    chargerSummaryHeights: Object.fromEntries(chargerSummaryHeights), chargingStates: chargingCases.length,
    checks: ['Home default', 'separate scope and method controls', 'negative Garage and Total figures',
      'disabled release without an owned episode', 'closed Garage disclosures', '320–1920px layouts including tablet and charger-pair boundaries',
      'equipment rows open with Enter and full-summary pointer clicks and preserve focus and expansion during refresh',
      'shared charger cards, energy-based percentage with source and original vehicle timestamp, 20% starting fallback, confirmed periods, current readiness, TeslaMate reception, seasonal history explanation',
      'Controlled and Observed roles with shared charge, target, completion, delivered energy, remaining energy and cost in the always-visible summary',
      'fixed matching charger summary heights across both themes, all viewports, connection, charging, planning, manual priority, risk and handover states, and open or closed folds',
      'equal desktop charger columns, narrow mobile stacking, independent folds without stretching the closed sibling, and active full-dashboard screenshots',
      'unsaved charger settings and focus survive status polling and reflow between desktop and mobile',
      'summary bands remain separate without vertical overflow; disconnected and unknown readings retain the layout without stale percentages',
      'metric explanations open without toggling equipment, preserve focus during refresh, and return on Escape; form guidance and all charging periods remain inline',
      'separate Home and Garage cards, independent keyboard disclosures, and both chart shortcuts preserve fold state and focus',
      'desktop column grouping and mobile Home, Garage, Data order',
      'matching Home and Garage learning headings', 'episode-based Garage progress',
      'shared learning rows and section structure', 'Enter and Space operate each learning section and entry',
      'status refresh preserves learning row identity, open explanations and focus',
      'sensor maintenance stays inside its input explanation', 'zero values remain distinct from missing evidence',
      'Garage settings keep descriptions outside values and live budgets in a separate section',
      'detailed settings retain independent, stale, uncertain, unapproved and exhausted cold budgets without repeating them in the compact summary',
      'status refresh preserves budget triggers, focus, open explanations and the recovery fold',
      'Garage settings and live budgets fit desktop and mobile in both themes',
      'Home and Garage learning sections fit desktop and mobile in both themes, collapsed and expanded',
      'original input and replay coefficient charts', 'no browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
