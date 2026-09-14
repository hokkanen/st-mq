// Synthetic local fixture only. Requires an isolated Chrome DevTools listener.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { providerFixture } from './lib/provider-fixture.js';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-sensors-ui-'));
const now = Date.parse('2026-09-10T12:00:00Z');
let app, socket, id = 0;
let nextDialogAccept;
const pending = new Map(), errors = [], dialogs = [];
try {
  const configPath = join(directory, 'fixture.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const control = { ...config.control,
    indoorSensorWeights: { indoor_temperature: 1 / 3, downstairs_temperature: 1 / 3, bedroom_temperature: 1 / 3 } };
  const seededStore = new Store(config.dbPath);
  try {
    const step = 15 * 60_000;
    for (let at = now - 8 * 3600_000, i = 0; at < now; at += step, i++) {
      const delta = Math.sin(i / 5) * 0.6;
      for (const [signal, value, source] of [
        ['indoor_temperature', 21.2 + delta, 'mqtt-temperature'],
        ['bedroom_temperature', 21.6 + delta, 'mqtt-temperature'],
        ['downstairs_temperature', 20.2 + delta, 'mqtt-temperature'],
        ['garage_temperature', 14 + delta, 'mqtt-temperature'],
        ['outdoor_temperature', 10 + delta * 4, 'fmi'],
      ]) seededStore.observation({ source, device: 'synthetic-sensor-chart', signal, value,
        unit: 'degC', sourceTime: at, receivedAt: at, quality: [] });
      if (i) appendLearningRecord(seededStore, 'providers', 'sample', {
        timestamp: at, windowStart: at - step, windowEnd: at, indoorC: 21 + delta, quality: [],
        inputSegments: [{ start: at - step, end: at, outdoorC: 10, solarRadiationWm2: 0,
          phase: 'normal', roomBoostC: 0, targetC: 21, thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] }],
      }, { config: control });
    }
  } finally { seededStore.close(); }
  const fixture = providerFixture(now);
  const temperatures = fixture.providerOptions.devices.temperatures;
  fixture.providerOptions.temperatureProvider = async () => {
    const original = await temperatures();
    return [...original, { ...original[0], signal: 'downstairs_temperature', value: 20.2 },
      { ...original[0], signal: 'bedroom_temperature', value: 21.6 }];
  };
  app = await start({ config: { ...config, input: 'providers', connections: fixture.connections, control },
  clock: () => now, providerOptions: fixture.providerOptions });
  const endpoint = process.argv[2] ?? 'http://127.0.0.1:39125';
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    else if (message.method === 'Page.javascriptDialogOpening') {
      dialogs.push(message.params);
      const accept = nextDialogAccept;
      nextDialogAccept = undefined;
      if (accept === undefined) errors.push('Unexpected confirmation dialog');
      void send('Page.handleJavaScriptDialog', { accept: accept === true }).catch(error => errors.push(error.message));
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 20_000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`UI did not settle: ${expression}. ${errors.join('; ')}`);
  };
  const confirmClick = async (selector, accept, message) => {
    const before = dialogs.length;
    nextDialogAccept = accept;
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    assert.equal(dialogs.length, before + 1, 'The action opens its native confirmation dialog');
    assert.equal(dialogs.at(-1).type, 'confirm');
    assert.match(dialogs.at(-1).message, message);
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Expose the existing status poll to exercise its full render path without a 15-second wait.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const scheduleInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000) globalThis.refreshSensorSmokeStatus = () => callback(...args);
      return scheduleInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await send('Page.navigate', { url: base });
  await until("document.getElementById('history')?.dataset.ready === 'true' && document.getElementById('indoor')?.textContent === '21.0 °C'");
  assert.equal(await evaluate("document.getElementById('indoor').textContent"), '21.0 °C');
  const sensorParents = '#learning-panel-details, #model-inputs-details, details[data-model-input=model_indoor_temperature]';
  assert.equal(await evaluate("document.querySelectorAll('#sensor-change-details').length"), 1);
  assert.equal(await evaluate("document.querySelector('#home-control #sensor-change-details') === null"), true,
    'Home & heating has no sensor maintenance controls');
  assert.equal(await evaluate("document.getElementById('sensor-change-details').closest('[data-model-input]')?.dataset.modelInput"),
    'model_indoor_temperature', 'Sensor changes belong to the Average indoor model input');
  assert.equal(await evaluate("document.querySelectorAll('#outdoor-sensor-change-details').length"), 1);
  assert.equal(await evaluate("document.getElementById('outdoor-sensor-change-details').closest('[data-model-input]')?.dataset.modelInput"),
    'model_outdoor_temperature', 'Outdoor sensor changes have their own model input fold');
  assert.equal(await evaluate("document.getElementById('sensor-change-details').closest('article')?.id"), 'house-model');
  assert.equal(await evaluate("document.querySelector('#sensor-change-details > summary span').textContent"), 'Sensor changes');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('${sensorParents}, #sensor-change-details'), fold => fold.open).some(Boolean)`),
    false, 'Sensor changes and the model input disclosures start collapsed');
  for (const width of [1440, 375]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 600 });
    const heights = await evaluate(`(() => {
      const cards = ['home-control', 'providers-controls'].map(id => document.getElementById(id));
      const panel = document.getElementById('sensor-change-details'), parent = panel.parentNode, next = panel.nextSibling;
      const present = cards.map(card => card.getBoundingClientRect().height);
      panel.remove();
      const absent = cards.map(card => card.getBoundingClientRect().height);
      parent.insertBefore(panel, next);
      return { present, absent };
    })()`);
    assert.deepEqual(heights.present, heights.absent, `Sensor maintenance adds no closed Home/Data height at ${width}px`);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("document.querySelector('.indoor-readings, #upstairs, #downstairs, #bedroom') === null"), true);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.overview-zones > section > .overview-label, .overview-conditions > div > .overview-label'), node => node.textContent)"),
    ['Home · indoor average', 'Garage', 'Outdoor', 'ALL-IN PRICE']);
  const observations = (await fetch(`${base}/api/status`).then(response => response.json())).observations;
  for (const [key, value] of [['upstairs', 21.2], ['downstairs', 20.2], ['bedroom', 21.6]]) {
    assert.equal(observations[key].value, value, `${key} remains available to the controller`);
  }
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] .provider-heading > strong').textContent"),
    'Main temperatures');
  assert.equal(await evaluate("document.querySelectorAll('#chart-legend [data-chart-key=\"model_indoor_temperature\"]').length"), 1);
  assert.equal(await evaluate("document.querySelector('#chart-legend [data-chart-key=\"model_indoor_temperature\"]').textContent"), 'Average indoor');
  for (const signal of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature']) {
    assert.equal(await evaluate(`document.querySelector('#chart-legend [data-chart-key="${signal}"]') === null`), true);
    assert.equal(await evaluate(`document.querySelector('#left-axis option[value="${signal}"]') === null`), true);
  }
  assert.deepEqual(await evaluate("Array.from(document.querySelector('#left-axis optgroup[label=\"Home temperatures · Recorded\"]').children, node => node.textContent)"), ['All home temperatures']);
  assert.equal(await evaluate("document.querySelector('#left-axis option[value=\"garage_temperature\"]') === null"), true);
  assert.equal(await evaluate("document.querySelector('#left-axis optgroup[label=\"Other air temperatures · Recorded\"]') === null"), true);
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"garage_temperature\"]').textContent"), 'Garage');
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"model_indoor_temperature\"]').textContent"), 'Average indoor');
  await evaluate("document.getElementById('left-axis').value='temperatures'; document.getElementById('left-axis').dispatchEvent(new Event('change'))");
  await until("document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]').length === 5");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]'), node => node.textContent)"),
    ['Upstairs', 'Bedroom', 'Downstairs', 'Garage', 'Garage probe 2']);
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Left axis\"] [data-chart-key=\"garage_temperature\"]').textContent"), 'Garage');
  mkdirSync('var', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') document.getElementById('theme-toggle').click()`);
    const swatches = await evaluate(`(() => {
      const keys = ['model_indoor_temperature', 'indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'outdoor_temperature', 'garage_temperature'];
      return Object.fromEntries(keys.map(key => [key, document.querySelector('#chart-legend [data-chart-key="' + key + '"] .chart-legend-swatch').style.backgroundColor]));
    })()`);
    assert.equal(new Set(Object.values(swatches)).size, 6, `${theme}: rooms, average, outdoor and garage use distinct colours`);
    const expected = await evaluate(`(() => {
      const styles = getComputedStyle(document.documentElement), swatch = document.createElement('span');
      return Object.fromEntries(['indoor', 'outdoor'].map(key => {
        swatch.style.backgroundColor = styles.getPropertyValue('--chart-' + key).trim();
        return [key, swatch.style.backgroundColor];
      }));
    })()`);
    assert.equal(swatches.model_indoor_temperature, expected.indoor, `${theme}: average retains indoor green`);
    assert.equal(swatches.outdoor_temperature, expected.outdoor, `${theme}: outdoor retains blue`);
    for (const selection of ['power', 'phases']) {
      await evaluate(`document.getElementById('left-axis').value='${selection}'; document.getElementById('left-axis').dispatchEvent(new Event('change'))`);
      const first = selection === 'power' ? 'property_power' : 'property_current_l1';
      await until(`Boolean(document.querySelector('#chart-legend [aria-label="Left axis"] [data-chart-key="${first}"]'))`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"model_indoor_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.model_indoor_temperature, `${theme}: the average keeps its colour with ${selection}`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"outdoor_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.outdoor_temperature, `${theme}: outdoor keeps its colour with ${selection}`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"garage_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.garage_temperature, `${theme}: garage stays on the right and keeps its colour with ${selection}`);
    }
    await evaluate("document.getElementById('left-axis').value='temperatures'; document.getElementById('left-axis').dispatchEvent(new Event('change'))");
    await until("document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]').length === 5");
    await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'})");
    writeFileSync(`var/home-temperatures-${theme}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await evaluate("document.getElementById('theme-toggle').click()");
  await evaluate(`document.querySelectorAll('${sensorParents}').forEach(fold => { fold.open = true; })`);
  assert.equal(await evaluate("document.getElementById('sensor-change-submit').checkVisibility()"), false,
    'Viewing the Average indoor explanation leaves the maintenance form collapsed');
  assert.equal(await evaluate("document.querySelector('#sensor-change-details > summary').checkVisibility()"), true);
  await evaluate("document.querySelector('#sensor-change-details > summary').focus()");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  assert.equal(await evaluate("document.getElementById('sensor-change-details').open"), true, 'Sensor maintenance opens with the keyboard');
  await until("!document.getElementById('sensor-change-submit').disabled");
  assert.equal(await evaluate("document.getElementById('sensor-change-empty').checkVisibility()"), true);
  assert.equal(await evaluate("document.querySelector('#sensor-change-entries button') === null"), true,
    'A revert button appears only after a sensor change has been recorded');
  assert.deepEqual(await evaluate("Array.from(document.getElementById('sensor-change-signal').options, option => option.textContent)"),
    ['Upstairs', 'Downstairs', 'Bedroom']);
  assert.deepEqual(await evaluate("Array.from(document.getElementById('outdoor-sensor-change-signal').options, option => option.textContent)"),
    ['Outdoor']);
  await evaluate("document.querySelector('[data-model-input=model_outdoor_temperature]').open = true; document.getElementById('outdoor-sensor-change-details').open = true");
  assert.equal(await evaluate("document.getElementById('outdoor-sensor-change-submit').checkVisibility()"), true);
  await evaluate("document.querySelector('[data-model-input=model_outdoor_temperature]').open = false");
  assert.equal(await evaluate("document.querySelector('label[for=sensor-change-reason]').firstChild.textContent"), 'Reason');
  assert.deepEqual(await evaluate("Array.from(document.getElementById('sensor-change-reason').options, option => option.textContent)"),
    ['Replacement', 'New location', 'Calibration', 'Other']);
  assert.equal(await evaluate("document.getElementById('sensor-change-submit').textContent"), 'Record change now…');
  await evaluate("document.getElementById('sensor-change-signal').value='downstairs_temperature'; document.getElementById('sensor-change-reason').value='moved'; document.getElementById('sensor-change-signal').focus();");
  await evaluate("document.getElementById('sensor-change-refresh').click()");
  await until("!document.getElementById('sensor-change-refresh').disabled");
  assert.equal(await evaluate("document.getElementById('sensor-change-signal').value"), 'downstairs_temperature');
  assert.equal(await evaluate("document.activeElement.id"), 'sensor-change-signal');
  await evaluate("globalThis.sensorSmokeForm = document.getElementById('sensor-change-form'); globalThis.refreshSensorSmokeStatus()");
  assert.equal(await evaluate("document.getElementById('sensor-change-form') === globalThis.sensorSmokeForm"), true,
    'Status rendering keeps the existing sensor form mounted');
  assert.equal(await evaluate("document.getElementById('sensor-change-signal').value"), 'downstairs_temperature');
  assert.equal(await evaluate("document.getElementById('sensor-change-reason').value"), 'moved');
  assert.equal(await evaluate("document.activeElement.id"), 'sensor-change-signal', 'Status refresh preserves sensor form focus');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('${sensorParents}, #sensor-change-details'), fold => fold.open).every(Boolean)`),
    true, 'Status refresh preserves all nested disclosure states');
  await evaluate(`(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (String(url).endsWith('/api/sensor-changes') && options?.method === 'POST') {
        globalThis.sensorSmokeSavedRequest = JSON.parse(options.body);
      }
      return originalFetch(url, options);
    };
  })()`);
  const historicalReadings = () => ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature', 'outdoor_temperature']
    .map(signal => app.store.observations({ signal, from: now - 8 * 3600_000, to: now - 1, limit: 5000 }));
  const originalReadings = historicalReadings();
  await confirmClick('#sensor-change-submit', false, /clears the learned normal indoor temperature/);
  assert.equal((await fetch(`${base}/api/sensor-changes`).then(response => response.json())).events.length, 0,
    'Cancelling the confirmation does not record a sensor change');
  assert.equal(await evaluate('globalThis.sensorSmokeSavedRequest === undefined'), true);
  await confirmClick('#sensor-change-submit', true, /Recorded readings are kept/);
  await until("document.getElementById('sensor-change-entries').children.length === 1 && document.getElementById('indoor').textContent === 'Unavailable'");
  assert.match(await evaluate("document.getElementById('sensor-change-message').textContent"), /Downstairs change recorded/);
  assert.match(await evaluate("document.getElementById('sensor-change-entries').textContent"), /Downstairs · New location/);
  const settling = (await fetch(`${base}/api/status`).then(response => response.json())).observations;
  assert.equal(settling.downstairs.value, 20.2, 'raw sensor values remain available during settling');
  assert.equal(settling.downstairs.settling, true);
  await evaluate("document.querySelector('#indoor .status-detail-trigger').click();true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Settling after sensor change/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
  const saved = await fetch(`${base}/api/sensor-changes`).then(response => response.json());
  assert.equal(saved.events.length, 1); assert.equal(saved.events[0].signal, 'downstairs_temperature');
  assert.equal(saved.events[0].reason, 'moved'); assert.equal(saved.events[0].at, now);
  assert.equal(saved.events[0].canRevert, true);
  assert.equal(await evaluate("document.querySelector('#sensor-change-entries button').textContent"), 'Revert and relearn');
  assert.equal(await evaluate("document.querySelector('#sensor-change-entries button').checkVisibility()"), true);
  assert.equal(await evaluate("document.querySelector('#sensor-change-entries button').disabled"), false);
  assert.equal(await evaluate("document.getElementById('outdoor-sensor-change-entries').children.length"), 0,
    'Indoor changes stay out of outdoor history');
  mkdirSync('var', { recursive: true });
  for (const width of [1440, 1024, 430, 390, 375]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate("document.getElementById('sensor-change-details').scrollIntoView({block:'center'})");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `sensor form fits ${width}px`);
    assert.equal(await evaluate("document.getElementById('sensor-change-submit').checkVisibility()"), true);
    const controls = await evaluate(`Array.from(document.querySelectorAll('#sensor-change-form select, #sensor-change-form button'), node => {
      const box = node.getBoundingClientRect(), parent = node.closest('[data-model-input]').getBoundingClientRect();
      return { id: node.id, left: box.left - parent.left, right: parent.right - box.right, width: box.width };
    })`);
    assert.ok(controls.every(control => control.left >= 0 && control.right >= 0 && control.width >= 100),
      `Nested sensor controls stay usable inside Average indoor at ${width}px`);
    writeFileSync(`var/sensor-change-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  // A lost response keeps the original request id. Reload must reveal the nested retry control.
  const savedRequest = await evaluate('globalThis.sensorSmokeSavedRequest');
  assert.equal(typeof savedRequest?.requestId, 'string');
  await evaluate("sessionStorage.setItem('stmq-sensor-change-pending', JSON.stringify(globalThis.sensorSmokeSavedRequest))");
  await send('Page.reload');
  await until("document.getElementById('history')?.dataset.ready === 'true' && !document.getElementById('sensor-change-retry')?.disabled");
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('${sensorParents}, #sensor-change-details'), fold => fold.open).every(Boolean)`),
    true, 'Reload opens every parent of an uncertain sensor change');
  assert.equal(await evaluate("document.getElementById('sensor-change-retry').checkVisibility()"), true,
    'The recovered retry action is visible inside the nested model input');
  assert.equal(await evaluate("document.getElementById('sensor-change-signal').value"), 'downstairs_temperature');
  assert.equal(await evaluate("document.getElementById('sensor-change-reason').value"), 'moved');
  await evaluate("document.getElementById('sensor-change-retry').click()");
  await until("document.getElementById('sensor-change-retry').hidden && document.getElementById('sensor-change-message').textContent.includes('Downstairs change recorded')");
  const retried = await fetch(`${base}/api/sensor-changes`).then(response => response.json());
  assert.equal(retried.events.length, 1, 'Retry after reload does not duplicate the saved sensor change');
  assert.equal(await evaluate("sessionStorage.getItem('stmq-sensor-change-pending')"), null);
  await confirmClick('#sensor-change-entries button', false, /model will relearn from recorded history/);
  assert.equal((await fetch(`${base}/api/sensor-changes`).then(response => response.json())).events[0].revertedAt, null,
    'Cancelling a reversal preserves the active sensor change');
  await confirmClick('#sensor-change-entries button', true, /Other sensor changes still apply/);
  await until("document.querySelector('#sensor-change-entries .sensor-change-entry-status').textContent.startsWith('Reverted ')");
  const reversed = await fetch(`${base}/api/sensor-changes`).then(response => response.json());
  assert.equal(reversed.events.length, 1, 'Reversal retains the original history entry');
  assert.equal(reversed.events[0].id, saved.events[0].id);
  assert.equal(reversed.events[0].revertedAt, now);
  assert.equal(reversed.events[0].canRevert, false);
  assert.equal(await evaluate("document.querySelector('#sensor-change-entries button') === null"), true);
  assert.match(await evaluate("document.getElementById('sensor-change-rebuild').textContent"), /Relearning/);
  // Drive the fixture's next control tick once the real background worker is
  // ready, without waiting for its normal one-minute scheduling interval.
  const rebuildDeadline = Date.now() + 20_000;
  while (!app.engine.sensorChangesStatus().rebuild.current && Date.now() < rebuildDeadline) {
    assert.notEqual(app.engine.sensorChangesStatus().rebuild.status, 'failed', 'The background rebuild must succeed');
    if (app.engine.fireplaceManager().status().status === 'ready') app.engine.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(app.engine.sensorChangesStatus().rebuild.current, true, 'The rebuilt model becomes active');
  await evaluate('globalThis.refreshSensorSmokeStatus()');
  await until("document.getElementById('sensor-change-rebuild').textContent.includes('Relearning complete') && document.getElementById('indoor').textContent === '21.0 °C'");
  const restored = (await fetch(`${base}/api/status`).then(response => response.json())).observations;
  assert.equal(restored.downstairs.value, 20.2, 'Relearning preserves the recorded sensor value');
  assert.notEqual(restored.downstairs.settling, true, 'A reversed reset no longer excludes the sensor');
  assert.deepEqual(historicalReadings(), originalReadings, 'Recording and reverting leave historical raw temperatures intact');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'sensor-ui-smoke-passed', checks: ['room cards removed', 'raw room readings retained', 'weighted indoor average',
    'one Average indoor chart legend', 'garage stays on right axis for power and joins home temperatures', 'garage and other air group removed from drawer', 'all home temperatures on left axis',
    'MQTT temperature source', 'distinct room colours in both themes', 'average and outdoor preserve colours',
    'separate indoor and outdoor sensor maintenance folds', 'unchanged closed Home and Data card heights', 'keyboard disclosure access',
    'configured sensor choices and reason labels', 'selection, focus and open state survive status refresh', 'real sensor-change API submission',
    'server timestamp and single saved event', 'settling preserves raw readings', 'desktop and mobile layout',
    'reload reveals pending retry through all ancestor disclosures', 'retry remains idempotent',
    'native confirmations accept and cancel both actions', 'visible Revert and relearn action',
    'reverted entry retained', 'background relearning completes', 'temperature observations preserved'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
