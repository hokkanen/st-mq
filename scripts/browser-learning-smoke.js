// Synthetic local fixture only. Requires an isolated Chrome DevTools listener.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { providerFixture } from './lib/provider-fixture.js';
import { createH66Controller } from '../src/control/h66.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';
import { MODEL_INPUT_INFO } from '../src/domain/history-series.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-learning-ui-'));
let now = Date.parse('2026-09-07T12:00:00Z');
let app, socket, h66, id = 0;
const pending = new Map(), errors = [];
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const seededStore = new Store(config.dbPath);
  seedChartFixture(seededStore, now);
  const inputStart = now - 30 * 60_000, inputEnd = now - 15 * 60_000;
  appendLearningRecord(seededStore, 'simulated', 'sample', {
    timestamp: inputEnd, windowStart: inputStart, windowEnd: inputEnd, indoorC: 21.2, quality: [],
    inputSegments: [{ start: inputStart, end: inputStart + 5 * 60_000, outdoorC: 8, solarRadiationWm2: 300,
      phase: 'normal', roomBoostC: 0, targetC: 21, thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] },
    { start: inputStart + 5 * 60_000, end: inputEnd, outdoorC: 8, solarRadiationWm2: 300,
      phase: 'reduction', roomBoostC: 0, targetC: 21, thermalCompressorDuty: 0.5, thermalAuxKw: 0, quality: [] }],
  }, { config: config.control });
  seededStore.close();
  app = await start({ config, clock: () => now });
  const endpoint = process.argv[2] ?? 'http://127.0.0.1:39125';
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
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
  const checkNestedFolds = async (selector, minimumIndent = 16) => {
    const folds = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)}), fold => {
      const summary = fold.querySelector(':scope > summary');
      const parent = fold.parentElement.closest('details')?.querySelector(':scope > summary');
      return { label: summary.textContent.trim(), visible: summary.checkVisibility(),
        indent: parent ? summary.getBoundingClientRect().left - parent.getBoundingClientRect().left : 0 };
    })`);
    assert.ok(folds.length > 0, `Nested disclosures exist for ${selector}`);
    for (const fold of folds) {
      assert.equal(fold.visible, true, `${fold.label} is visible inside its expanded parent`);
      assert.ok(fold.indent >= minimumIndent, `${fold.label} is visibly indented from its parent (${fold.indent}px)`);
    }
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Page.bringToFront');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  assert.equal(await evaluate("document.getElementById('learning-metrics').children.length"), 4);
  const actualStatus = await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`).then(r => r.json());
  assert.equal(await evaluate(`document.getElementById('coefficient-evidence').textContent.includes('A2 ${actualStatus.learning.parameters.auxIntegralA2}')`), true);
  assert.equal(await evaluate(`document.getElementById('coefficient-evidence').textContent.includes('compressor ${actualStatus.learning.adaptive.model.energy.compressorKw.toFixed(2)} kW')`), true);
  assert.equal(await evaluate("document.getElementById('h66-test-submit').disabled"), true);
  await evaluate("document.getElementById('h66-test-register').value='2201'; document.getElementById('h66-test-register').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.getElementById('h66-test-mode-field').hidden"), false);
  assert.equal(await evaluate("document.getElementById('h66-test-value').disabled"), true);
  await evaluate("document.getElementById('h66-test-register').value='0208'; document.getElementById('h66-test-register').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.getElementById('h66-test-temperature-field').hidden"), false);
  assert.equal(await evaluate("document.getElementById('h66-test-value').value"), '50');
  assert.equal(await evaluate("document.querySelector('#h66-provider-details > summary').textContent"), 'About these readings');
  assert.equal(await evaluate("document.querySelector('#learning-details summary').textContent"), 'Learning outcomes · Calculated');
  assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([...document.querySelectorAll('#model-inputs-content > details')].map(fold=>fold.dataset.modelInput))")),Object.keys(MODEL_INPUT_INFO));
  assert.equal(await evaluate("document.querySelectorAll('.controller-column > article, .controller-panels > article').length"), 4);
  assert.equal(await evaluate("document.getElementById('control-title').textContent"), 'Home & heating');
  assert.equal(await evaluate("document.getElementById('model-title').textContent"), 'Learning models');
  assert.equal(await evaluate("document.getElementById('providers-title').textContent"), 'Data & settings');
  assert.equal(await evaluate("document.getElementById('equipment-title').textContent"), 'Equipment & controls');
  assert.equal(await evaluate("document.getElementById('h66-test-duration')"), null, 'Manual settings have no expiration input');
  assert.equal(await evaluate(`(() => {
    const equipment = document.getElementById('equipment-panel'), box = equipment.getBoundingClientRect();
    const panels = document.querySelector('.controller-panels').getBoundingClientRect();
    return equipment.parentElement.matches('.controller-panels') && !equipment.closest('.controller-column')
      && Math.abs(box.left - panels.left) < 1 && Math.abs(box.right - panels.right) < 1
      && [...document.querySelectorAll('.controller-column')].every(column => column.getBoundingClientRect().bottom <= box.top);
  })()`), true, 'Equipment occupies its own full-width row below the home, model and data cards');
  assert.equal(await evaluate("[...document.querySelectorAll('.controller-panels details')].every(fold => !fold.open)"), true);
  const checkClosedColumns = async () => {
    assert.equal(await evaluate(`(() => {
      const columns = [...document.querySelectorAll('.controller-column')];
      const [left, right] = columns.map(column => column.getBoundingClientRect());
      const [leftCard, rightCard] = columns.map(column => column.lastElementChild.getBoundingClientRect());
      return Math.abs(left.top - right.top) < 1 && Math.abs(left.bottom - right.bottom) < 1
        && Math.abs(leftCard.bottom - rightCard.bottom) < 1
        && Math.abs(leftCard.bottom - left.bottom) < 1 && Math.abs(rightCard.bottom - right.bottom) < 1;
    })()`), true, 'Closed desktop columns and their last cards align within one pixel');
  };
  const checkIndependentCards = async () => {
    await checkClosedColumns();
    const rightHeights = await evaluate("['house-model', 'providers-controls'].map(id => document.getElementById(id).getBoundingClientRect().height)");
    const homeHeight = await evaluate("document.getElementById('home-control').getBoundingClientRect().height");
    await evaluate("document.querySelector('#temporary-details > summary').click()");
    assert.equal(await evaluate("document.getElementById('temporary-details').open"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.controller-column > article')].every(card => getComputedStyle(card).flexGrow === '0')"), true, 'Expanded cards keep their natural content height');
    assert.ok(await evaluate("document.getElementById('home-control').getBoundingClientRect().height") > homeHeight, 'Opening temporary controls expands the home card');
    const expandedRightHeights = await evaluate("['house-model', 'providers-controls'].map(id => document.getElementById(id).getBoundingClientRect().height)");
    assert.ok(expandedRightHeights.every((height, index) => height <= rightHeights[index] + 0.5), 'Opening the home card does not stretch either right card');
    await evaluate("document.querySelector('#temporary-details > summary').click()");
    await checkClosedColumns();
    await evaluate("document.querySelector('#learning-panel-details > summary').click(); document.querySelector('#learning-details > summary').click(); document.querySelector('#learning-panel-details > summary').click()");
    assert.equal(await evaluate("document.getElementById('learning-details').open"), true, 'Closing a parent preserves its nested disclosure state');
    await checkClosedColumns();
    await evaluate("document.getElementById('learning-details').open = false");
  };
  await checkIndependentCards();
  for (const [section, content] of [['timing-details', 'timing-benefit'], ['recording-details', 'recording-adaptive-details']]) {
    const marker = `getComputedStyle(document.querySelector('#${section} > summary'), '::after').content`;
    assert.equal(await evaluate(`document.getElementById('${section}').open`), false);
    assert.equal(await evaluate(marker), '"+"', `${section} shows a plus when closed`);
    assert.equal(await evaluate(`document.getElementById('${content}').checkVisibility()`), false, `${section} hides its content when closed`);
    await evaluate(`document.querySelector('#${section} > summary').focus()`);
    assert.equal(await evaluate(`document.activeElement === document.querySelector('#${section} > summary')`), true, `${section} accepts keyboard focus`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    assert.equal(await evaluate(`document.getElementById('${section}').open`), true, `${section} opens with Enter`);
    assert.equal(await evaluate(marker), '"−"', `${section} shows a minus when open`);
    assert.equal(await evaluate(`document.getElementById('${content}').checkVisibility()`), true, `${section} reveals its content when open`);
    await checkClosedColumns();
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    assert.equal(await evaluate(`document.getElementById('${section}').open`), false, `${section} closes with Space`);
    assert.equal(await evaluate(marker), '"+"');
    assert.equal(await evaluate(`document.getElementById('${content}').checkVisibility()`), false);
  }
  assert.equal(await evaluate("document.querySelectorAll('#model-coefficients-content > .learning-entry').length >= 6"), true);
  assert.equal(await evaluate("document.getElementById('learning-evidence').textContent.includes('Thermal coefficients:')"), false);
  assert.equal(await evaluate("document.getElementById('home-h66-summary').textContent.includes('Unavailable')"), true);
  assert.equal(await evaluate("document.getElementById('h66-status').textContent"), 'Not connected');
  mkdirSync('var', { recursive: true });
  await evaluate("document.querySelector('.controller-panels').scrollIntoView({block:'start'})");
  writeFileSync('var/home-panels-closed-desktop.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.getElementById('connections-details').open=true; document.getElementById('controls-details').open=true; document.getElementById('temporary-details').open=true; document.getElementById('away-until').value='2026-09-10T18:00'; document.getElementById('away-until').dispatchEvent(new Event('input'))");
  assert.equal(actualStatus.settingsReload.configuration.environment, 'ubuntu');
  assert.equal(actualStatus.settingsReload.configuration.privatePath, join(directory, 'options.json'));
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#settings-location dt, #settings-location dd')].map(node => node.textContent)"),
    ['Folder', directory, 'File name', 'options.json', 'Full path', join(directory, 'options.json')]);
  assert.equal(await evaluate("document.getElementById('settings-location-message').hidden"), true);
  const configurationInstructions = await evaluate("document.getElementById('settings-configuration-steps').textContent");
  assert.ok(configurationInstructions.includes(actualStatus.settingsReload.configuration.privatePath), 'Configuration instructions show the actual isolated private file');
  assert.ok(configurationInstructions.includes(actualStatus.settingsReload.configuration.defaultsPath), 'Configuration instructions show the actual defaults file');
  assert.match(configurationInstructions, /stays in place/);
  assert.match(await evaluate("document.getElementById('settings-access').textContent"), /Loopback access works without a token/);
  assert.equal(await evaluate("document.getElementById('settings-import-warning').hidden"), true);
  assert.equal(await evaluate("document.getElementById('settings-reload').textContent"), 'Apply configuration');
  assert.match(await evaluate("document.getElementById('settings-reload-scope').textContent"), /Applies without restart.*Electricity rates.*Requires restart.*Input mode.*Environment variables/s);
  assert.equal(await evaluate("document.getElementById('settings-reload-scope').getBoundingClientRect().height > 0"), true, 'Reload scope is visible beside the action');
  writeFileSync(join(directory, 'options.json'), JSON.stringify({ controller: { max_drop_c: 0.7 } }));
  await evaluate("document.getElementById('settings-reload').click()");
  await until("document.getElementById('settings-reload-message').textContent === 'Configuration applied.' && !document.getElementById('settings-reload').disabled");
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00', 'Settings refresh preserves unsaved temporary drafts');
  assert.equal(await evaluate("document.getElementById('controls-details').open"), true, 'Settings refresh preserves open controls');
  assert.equal(await evaluate("document.getElementById('connections-details').open"), true, 'Settings refresh preserves the parent disclosure');
  assert.equal(await evaluate("document.getElementById('drop').textContent"), '0.7 °C', 'Settings reload applies options from disk');
  assert.equal(existsSync(join(directory, 'options.json')), true, 'Applying standalone configuration retains its permanent private file');
  await evaluate("document.getElementById('controls-details').open=false; document.getElementById('connections-details').open=false; document.getElementById('temporary-details').open=false");
  await evaluate("document.getElementById('learning-panel-details').open = true; document.getElementById('learning-details').open = true; document.getElementById('model-inputs-details').open = true; document.querySelector('#model-inputs-content details').open = true");
  assert.equal(await evaluate("document.getElementById('model-inputs-content').textContent.includes('configured sensors')"), true);
  assert.equal(await evaluate("document.getElementById('learning-evidence').textContent.includes('Action prediction:')"), true);
  for (const key of ['auxiliary_power', 'charger_power']) {
    assert(await evaluate(`(async () => {
      const canvas = document.getElementById('history'), ctx = canvas.getContext('2d');
      const button = document.querySelector('[data-chart-key="${key}"]');
      const first = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      button.click(); await new Promise(resolve => requestAnimationFrame(resolve));
      const second = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const changed = first.some((value, index) => value !== second[index]); button.click(); return changed;
    })()`), `${key} changes rendered pixels`);
  }
  assert(await evaluate("document.querySelectorAll('.mode-segment').length > 0"));
  await evaluate("document.querySelector('[data-chart-key=spot_price]').click()");
  for (const left of ['learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature', 'solar_radiation', 'model_compressor_duty', 'model_controller_phase', 'ev1_session_energy_check', 'power']) {
    await evaluate(`document.getElementById('left-axis').value='${left}'; document.getElementById('left-axis').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === '${left}'`);
    assert.equal(await evaluate("document.querySelector('[data-chart-key=spot_price]').getAttribute('aria-pressed')"), 'false');
    if (left === 'ev1_session_energy_check') assert.equal(await evaluate("document.getElementById('chart-status').textContent.includes('No recorded values for the selected left axis')"), true);
    if (left.startsWith('model_')) {
      assert.equal(await evaluate("document.getElementById('chart-notes').textContent.includes('not recalculated using today')"), true);
      assert.equal(await evaluate("document.getElementById('chart-status').textContent.includes('No recorded values')"), false);
      await evaluate(`document.querySelector('[data-chart-key=${left}]').click()`);
      assert.equal(await evaluate("document.getElementById('chart-status').textContent.includes('hidden in the legend')"), true);
      await evaluate(`document.querySelector('[data-chart-key=${left}]').click()`);
    }
  }
  mkdirSync('var', { recursive: true });
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 150));
    await checkNestedFolds('#learning-details, #learning-validation-details, #model-inputs-details, #model-inputs-content > details, #model-coefficients-details');
    for (const section of ['history-panel', 'learning-details', 'model-inputs-details', 'model-coefficients-details', 'providers-controls', 'h66-test-details']) {
      await evaluate(`(() => { const element = document.getElementById('${section}') ?? document.querySelector('.${section}'); if (element.tagName === 'DETAILS') element.open = true; for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; element.scrollIntoView({block:'start'}); })()`);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${section} fits ${width}px`);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`var/learning-${section}-${width}.png`, Buffer.from(shot.data, 'base64'));
    }
    await evaluate("document.getElementById('left-axis').value='model_compressor_duty'; document.getElementById('left-axis').dispatchEvent(new Event('change')); document.querySelector('.history-panel').scrollIntoView({block:'start'})");
    await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === 'model_compressor_duty'");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `model input chart fits ${width}px`);
    const inputShot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`var/learning-model-input-chart-${width}.png`, Buffer.from(inputShot.data, 'base64'));
    await evaluate("document.getElementById('left-axis').value='power'; document.getElementById('left-axis').dispatchEvent(new Event('change'))");
    await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === 'power'");
  }
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width < 600 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.getElementById('equipment-details').open=true;document.getElementById('h66-readings-details').open=true;document.getElementById('h66-readings-details').scrollIntoView({block:'start'});true");
    assert.equal(await evaluate(`(() => {
      const table=document.querySelector('#h66-readings table'),labels=[...table.querySelectorAll('.status-detail-label')];
      return document.documentElement.scrollWidth<=innerWidth && labels.every(label=>{
        const range=document.createRange();range.selectNodeContents(label);return range.getClientRects().length===1;
      }) && getComputedStyle(table.querySelector('thead th:last-child')).display${width < 600 ? '===' : '!=='}'none';
    })()`), true, `H66 values stay readable with an appropriate received-time column at ${width}px`);
    writeFileSync(`var/home-energy-h66-compact-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  // Exercise the real Engine/status/API/H66 controller with an in-memory MQTT
  // publication function. It has no broker address or physical connection.
  await app.close(); app = null;
  const fixture = providerFixture(now), publications = [], deviceId = 'synthetic-browser-h66';
  const fixtureTemperatures = fixture.providerOptions.devices.temperatures;
  fixture.providerOptions.temperatureProvider = async () => {
    const observations = await fixtureTemperatures();
    return [...observations, { ...observations[0], signal: 'garage_temperature', value: 16.4 }];
  };
  app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'providers.sqlite'), connections: fixture.connections },
    clock: () => now, providerOptions: fixture.providerOptions });
  const decoder = createH66Decoder({ deviceId });
  const readback = (register, value) => h66.ingest(decoder.decode({ topic: `${deviceId}/HP/${register}`, payload: String(value), receivedAt: now }));
  h66 = createH66Controller({ deviceId, store: app.store, clock: () => now, config: { writeEnabled: true },
    publish: async (topic, value) => { publications.push({ topic, value }); readback(topic.slice(-4), Number(value)); } });
  h66.setConnected(true);
  for (const [register, value] of [['0203', 20], ['0212', 40], ['0208', 55], ['2201', 1], ['3104', 0], ['1A01', 1], ['1A07', 0]]) readback(register, value);
  app.engine.setH66(h66); app.engine.tick();
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('h66-status')?.textContent === 'H66 connected'");
  await until("document.getElementById('h66-test-submit')?.disabled === false");
  assert.equal(publications.length, 0, 'Shadow startup never publishes H66 settings');
  assert.equal(await evaluate("document.querySelector('[data-h66-summary=mode]').textContent.includes('Auto')"), true);
  assert.equal(await evaluate("document.getElementById('home-pump-dhw').textContent.includes('40–55 °C')"), true);
  assert.equal(await evaluate("document.getElementById('home-tariff-status').textContent"), 'Unknown');
  await evaluate("document.querySelector('#home-tariff-status .status-detail-trigger').click();true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /no device readback/i);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
  assert.equal(await evaluate("document.querySelectorAll('#providers .provider-fold').length > 0"), true);
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] .provider-heading > strong').textContent"), 'Main temperatures');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-provider=main-temperatures] .provider-series > li > strong')].map(row => row.textContent)"),
    ['Upstairs', 'Downstairs', 'Bedroom', 'Garage rear temperature', 'Garage front temperature', 'Outdoor temperature']);
  assert.equal(await evaluate("document.querySelector('#providers > :last-child').dataset.provider"), 'weather', 'Weather forecast follows the main temperature measurements');
  assert.equal(await evaluate("document.querySelector('#provider-overview #providers > :last-child .provider-category-title').textContent"), 'Weather forecast', 'The source overview has weather last');
  assert.equal(await evaluate("!document.getElementById('connections-details').open && [...document.querySelectorAll('#providers .provider-fold > summary')].every(summary=>summary.checkVisibility())"), true, 'Source categories remain accessible with configuration closed');
  assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/api/status`).then(r => r.json())).observations.garage.value, 16.4,
    'The temperature catalogue receives the actual garage observation');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.controller-panels').scrollIntoView({block:'start'})");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Provider summary fits ${width}px`);
    if (width === 1440) {
      await checkIndependentCards();
    }
    await evaluate("document.querySelector('.controller-panels').scrollIntoView({block:'start'})");
    writeFileSync(`var/home-panels-providers-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate("document.getElementById('connections-details').open=true; document.querySelectorAll('#providers .provider-fold').forEach(fold=>fold.open=true); document.getElementById('equipment-details').open=true; document.getElementById('h66-provider-details').open=true; document.getElementById('h66-readings-details').open=true; document.getElementById('providers-controls').scrollIntoView({block:'start'})");
    assert.equal(await evaluate(`(() => {
      const summaries = [...document.querySelectorAll('#providers .provider-fold > summary')];
      return summaries.length === 4 && summaries.every(summary => summary.checkVisibility()
        && Math.abs(summary.getBoundingClientRect().left - summaries[0].getBoundingClientRect().left) < 1);
    })()`), true, 'The four source categories share a left edge');
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#connections-details > .controller-fold')].map(fold => ({
        box: fold.getBoundingClientRect(), summary: fold.querySelector(':scope > summary') }));
      return rows.length === 3 && rows.every((row, index) => row.summary.checkVisibility()
        && Math.abs(row.summary.getBoundingClientRect().left - rows[0].summary.getBoundingClientRect().left) < 1
        && (!index || row.box.top >= rows[index - 1].box.bottom - 1));
    })()`), true, 'MQTT topics, rates and configuration form three aligned rows without vertical overlap');
    assert.equal(await evaluate(`(() => {
      const parents = { 'h66-readings-details': 'equipment-details', 'h66-provider-details': 'h66-readings-details',
        'h66-test-details': 'equipment-details' };
      return Object.entries(parents).every(([id,parent]) => {
        const fold=document.getElementById(id),summary=fold.querySelector(':scope > summary');
        const parentSummary=document.querySelector('#'+parent+' > summary');
        return summary.checkVisibility() && fold.parentElement.closest('details').id === parent
          && summary.getBoundingClientRect().left >= parentSummary.getBoundingClientRect().left + 15;
      });
    })()`), true, 'Heat-pump settings and readings are visibly nested inside equipment');
    assert.equal(await evaluate("document.getElementById('home-manual-controls').tagName === 'SECTION' && document.getElementById('heating-test-details').tagName === 'DIV' && document.getElementById('heating-test-buttons').checkVisibility()"), true,
      'Tariff controls are visible beside their reported state without another disclosure');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Provider series and H66 table fit ${width}px`);
    writeFileSync(`var/home-providers-expanded-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await evaluate("document.querySelectorAll('.controller-panels details').forEach(fold=>fold.open=false)");
  }
  await evaluate("document.getElementById('connections-details').open=true; document.querySelector('#providers .provider-fold').open=true; document.getElementById('temporary-details').open=true; document.querySelector('#providers summary').focus(); window.savedProviderFold=document.querySelector('#providers .provider-fold')");
  await evaluate("document.getElementById('away-until').value='2026-09-10T18:00'; document.getElementById('away-until').dispatchEvent(new Event('input')); document.getElementById('temporary-form').requestSubmit()");
  await until("document.getElementById('temporary-message').textContent === 'Changes applied.'");
  assert.equal(await evaluate("window.savedProviderFold === document.querySelector('#providers .provider-fold') && window.savedProviderFold.open"), true, 'Provider folds stay mounted and open across refreshes');
  assert.equal(await evaluate("document.activeElement === document.querySelector('#providers summary')"), true, 'Provider summary keeps keyboard focus');
  assert.equal(await evaluate("document.querySelector('#providers .provider-series').children.length > 0"), true);
  await evaluate("document.getElementById('equipment-details').open=true; document.getElementById('h66-test-details').open=true; document.getElementById('h66-test-register').value='0208'; document.getElementById('h66-test-register').dispatchEvent(new Event('change')); document.getElementById('h66-test-value').value='50'; document.getElementById('h66-test-form').requestSubmit()");
  await until("document.getElementById('h66-test-message').textContent.includes('confirmed')");
  assert.equal(publications.length, 1); assert.equal(publications[0].value, '50');
  assert.equal(h66.status().readings['0208'].baseline, null);
  assert.equal(h66.status().lastManual.previousValue, 55);
  assert.equal(h66.status().lastManual.readback, 50);
  assert.equal(h66.status().expiresAt, null);
  assert.equal(await evaluate("document.getElementById('h66-test-message').textContent.includes('previously 55')"), true);
  assert.equal(await evaluate("document.getElementById('h66-manual-state').textContent.includes('50 °C')"), true);
  await evaluate("document.getElementById('h66-readings-details').open=true;document.querySelector('#h66-readings tr[data-register=\"0208\"] .status-detail-trigger').click();true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Received/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
  now += 61_000; await h66.reconcile({ now }); app.engine.tick();
  await send('Page.reload');
  await until("document.getElementById('h66-test-message')?.textContent.includes('device confirmed')");
  assert.equal(publications.length, 1, 'Controller ticks and page reload neither reverse nor replay a manual setting');
  assert.equal(h66.status().readings['0208'].value, 50);
  assert.equal(h66.status().restorationPending, false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'learning-ui-smoke-passed', checks: ['real chart pixels', 'four learning axes', 'solar axis', 'immutable model input axes', 'empty selected axis', 'all catalogued input source folds', 'separate action readiness', 'mode strip', 'saved visibility', 'aligned closed dashboard columns', 'independent expanded dashboard cards', 'full-width equipment row', 'alignment with hidden nested disclosures', 'chart disclosure markers and keyboard controls', 'provider folds preserve focus', 'visible settings reload scope', 'settings reload preserves drafts and nested disclosures', 'current coefficients', 'H66 home summary', 'actual Engine parameters', 'unavailable H66 controls', 'desktop and mobile layout', 'persistent manual H66 API setting and live readback with synthetic transport'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await h66?.close(); await app?.close(); rmSync(directory, { recursive: true, force: true });
}
