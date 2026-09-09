import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { providerFixture } from './lib/provider-fixture.js';
import { seedTimingBrowserFixture, checkTimingBrowser } from './lib/timing-browser-checks.js';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';

// Requires a separately started isolated Firefox BiDi listener. This script
// creates its own temporary simulation, never reads household credentials.
const directory = mkdtempSync(join(tmpdir(), 'stmq-browser-chart-'));
const now = Date.parse('2026-09-07T12:00:00Z');
const coefficientValues = {
  model_coefficient_heat_loss: { parameter: 'lossPerHour', value: 0.0273 },
  model_coefficient_compressor_response: { parameter: 'normalHeatCPerHour', value: 0.85 },
  model_coefficient_solar_response: { parameter: 'solarCPerHourPerKwM2', value: 0.32 },
  model_coefficient_auxiliary_response: { parameter: 'auxiliaryCPerKwh', value: 0.16 },
};
const coefficientKeys = Object.keys(coefficientValues);
let app, ws, command, ownsBrowser=false;
const pending = new Map(), errors = [], timings = [];
let id = 0;
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  config.priceSettings = { ...config.priceSettings, effectiveDate: '2020-01-01' };
  // Seed this temporary simulation before startup writes its current context,
  // keeping journal order chronological and exercising actual API replay.
  const fixtureStore = new Store(config.dbPath);
  try {
    appendLearningRecord(fixtureStore, 'simulated', 'context', { timestamp: now - 8 * 3600000 },
      { config: { ...config.control, thermalPriors: { lossPerHour: 0.0187 } } });
    const model = initialAdaptiveModel({ ...config.control,
      thermalPriors: Object.fromEntries(Object.values(coefficientValues).map(row => [row.parameter, row.value])) });
    model.validation = { accepted: true, fittedParameters: Object.values(coefficientValues).map(row => row.parameter) };
    model.trainedAt = new Date(now - 4 * 3600000).toISOString();
    appendLearningRecord(fixtureStore, 'simulated', 'context', { timestamp: now - 4 * 3600000,
      historySeed: { model, source: { basis: 'synthetic-browser-model' } } }, { config: config.control });
  } finally { fixtureStore.close(); }
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  app.store.snapshot({kind:'weather',source:'browser-fixture',fetchedAt:now-4*86400000,
    payload:{forecast:[{start:now-4*86400000,end:now-4*86400000+3600000,outdoorC:5,solarRadiationWm2:100}]}});
  app.store.appendLearningJournal('browser-fixture',{kind:'context',at:now-86400000,
    algorithmVersion:'browser-fixture',key:'overview-context',payload:{baselineResetAt:now-86400000}});
  app.store.setState('settings:browser-fixture',{input:'simulated'});
  ws = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:39124/session');
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      message.type === 'error' ? p.reject(new Error(JSON.stringify(message))) : p.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params.level === 'error') errors.push(message.params.text);
  };
  command = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await command('session.new', { capabilities: {} }); ownsBrowser=true;
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.activate',{context});
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const browserTimeZone = await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
  const until = async (expression, attempts = 150) => {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${JSON.stringify(errors)}`);
  };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const checkDateAlignment = async () => {
    assert.equal(await evaluate(`(() => {
      const start = document.getElementById('date-start'), end = document.getElementById('date-end');
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      return ['top', 'height', 'width'].every(key => Math.abs(a[key] - b[key]) < 1)
        && getComputedStyle(start).fontSize === getComputedStyle(end).fontSize;
    })()`), true, 'Date fields have matching widths, heights, alignment and text size');
  };
  const checkRecordingHierarchy = async () => {
    const folds = JSON.parse(await evaluate(`JSON.stringify(Array.from(document.querySelectorAll(
      '#recording-overview-details, .recording-data-group, [data-dataset-id="weather-snapshots"], [data-dataset-id="journal-context"], [data-dataset-id="state-settings"], .recording-storage-accounting'
    ), fold => {
      const summary = fold.querySelector(':scope > summary');
      const parent = fold.parentElement.closest('details')?.querySelector(':scope > summary');
      return { label: summary.textContent.trim(), visible: summary.checkVisibility(),
        indent: parent ? summary.getBoundingClientRect().left - parent.getBoundingClientRect().left : 0 };
    }))`));
    assert.ok(folds.length >= 13, 'Recording hierarchy covers the overview, groups, datasets and storage accounting');
    for (const fold of folds) {
      assert.equal(fold.visible, true, `${fold.label} is visible inside its expanded parent`);
      assert.ok(fold.indent >= 16, `${fold.label} is visibly indented from its parent (${fold.indent}px)`);
    }
  };
  await command('browsingContext.navigate', { context, url: base, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.title'), 'Home Energy');
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await evaluate("document.getElementById('date-start').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  await checkDateAlignment();
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), false);
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.range-shortcuts button')).map(button => button.id).join(',')"), 'range-yesterday,range-today,range-tomorrow');
  assert.equal(await evaluate("document.getElementById('left-axis').value"), 'power');
  assert.match(await evaluate("document.getElementById('chart-notes').textContent"),/original saved history.*stay in memory.*original recorded intervals/);
  assert.doesNotMatch(await evaluate("document.getElementById('chart-notes').textContent"),/hourly temperature extrema|15-minute energy sums|15-minute aggregate/);
  assert(await evaluate("document.querySelectorAll('#left-axis optgroup').length")>=10);
  assert.equal(await evaluate("document.querySelector('#left-axis optgroup').label.split(' · ')[0]"), 'Electricity');
  for(const key of ['brine_pump_speed','phase_energy','alarm_code', ...coefficientKeys])assert.equal(await evaluate(`Boolean(document.querySelector('#left-axis option[value="${key}"]'))`),true);
  for(const key of ['indoor_temperature','garage_temperature','outdoor_temperature','outdoor_forecast','spot_price','all_in_price'])
    assert.equal(await evaluate(`Boolean(document.querySelector('#left-axis option[value="${key}"]'))`),false,`${key} is already shown on the right axis`);
  assert.equal(await evaluate("document.querySelector('#left-axis optgroup[label=\"Model coefficients · Calculated\"]').children.length"), 4);
  assert.equal(await evaluate("performance.getEntriesByType('resource').some(entry=>entry.name.includes('/api/recording-overview'))"),false,'collapsed recording inventory does not fetch');
  await evaluate(`(() => {
    window.recordingFixture={fetch:window.fetch.bind(window),requests:0,fail:false,hold:false};
    window.fetch=(...args)=>{
      const fixture=window.recordingFixture;
      if(String(args[0]).includes('/api/recording-overview')){
        fixture.requests++;
        if(fixture.fail){fixture.fail=false;return Promise.reject(new Error('Synthetic overview failure'));}
        if(fixture.hold){fixture.hold=false;return new Promise(resolve=>{fixture.release=()=>resolve(fixture.fetch(...args));});}
      }
      return fixture.fetch(...args);
    };
    return true;
  })()`);
  await evaluate("document.getElementById('recording-details').open=true; true");
  await evaluate("document.getElementById('recording-adaptive-details').open=true; true");
  await until("document.querySelectorAll('#recording-content tbody tr').length>35");
  assert.match(await evaluate("document.getElementById('recording-content').textContent"),/rolling target/);
  assert.match(await evaluate("document.getElementById('recording-content').textContent"),/Garage temperature/);
  assert.equal(await evaluate("window.recordingFixture.requests"),0,'opening the adaptive table does not fetch the separate inventory');
  assert.equal(await evaluate("[...document.querySelectorAll('#recording-details > details')].map(node=>node.id).join(',')"),'recording-adaptive-details,energy-audit-details,recording-overview-details');
  await evaluate("document.querySelector('#recording-overview-details > summary').focus(); true");
  await command('input.performActions',{context,actions:[{type:'key',id:'recording-keyboard',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
  await until("document.querySelectorAll('#recording-overview-content .recording-data-group').length>=8");
  assert.equal(await evaluate("document.getElementById('recording-overview-details').open"),true,'native summary opens by keyboard');
  assert.equal(await evaluate("window.recordingFixture.requests"),1);
  assert.match(await evaluate("document.getElementById('recording-overview-message').textContent"),/Database snapshot:/);
  assert.equal(await evaluate("Boolean(document.querySelector('[data-dataset-id=heat_pump_power]'))"),false,'calculated heat-pump power is not a separate stored series');
  assert(await evaluate("document.querySelectorAll('.recording-storage-accounting tbody tr').length")>10,'physical table accounting is available separately');
  assert.equal(await evaluate("[...document.querySelectorAll('.recording-storage-accounting tbody th')].some(node=>/^chart_rollup/.test(node.textContent))"),false,'plot reduction does not create stored chart-summary tables');
  assert.equal(await evaluate("Boolean(document.querySelector('[data-dataset-id=chart-rollups], [data-dataset-id=rollup-metadata]'))"),false,'the database inventory contains no materialized chart summaries');
  for(const id of ['weather-snapshots','journal-context','state-settings']) {
    await evaluate(`(() => {const item=document.querySelector('[data-dataset-id="${id}"]');item.closest('.recording-data-group').open=true;item.open=true;return true;})()`);
    assert.equal(await evaluate(`document.querySelector('[data-dataset-id="${id}"] > summary').textContent.includes('No records yet')`),false,`${id} has actual stored records`);
    assert(await evaluate(`document.querySelectorAll('[data-dataset-id="${id}"] .recording-dataset-fields dt').length`)>0,`${id} describes its stored fields`);
  }
  await checkRecordingHierarchy();
  assert.match(await evaluate("document.querySelector('[data-dataset-id=state-settings] > summary').textContent"),/Current state · overwritten/);
  assert.match(await evaluate("document.querySelector('[data-dataset-id=csv-easee] > summary').textContent"),/No records yet/);
  await evaluate("window.recordingFixture.hold=true; document.getElementById('recording-overview-refresh').click(); document.querySelector('[data-dataset-id=weather-snapshots] > summary').focus(); true");
  await until("Boolean(window.recordingFixture.release)");
  await evaluate("window.recordingFixture.release(); true");
  await until("!document.getElementById('recording-overview-refresh').disabled");
  assert.equal(await evaluate("document.querySelector('[data-dataset-id=weather-snapshots]').open && document.querySelector('[data-dataset-id=weather-snapshots]').closest('.recording-data-group').open"),true,'refresh preserves nested expansion');
  assert.equal(await evaluate("document.activeElement.closest('[data-dataset-id]')?.dataset.datasetId"),'weather-snapshots','refresh preserves keyboard focus');
  await evaluate("window.recordingFixture.previous=document.getElementById('recording-overview-content').innerHTML; window.recordingFixture.fail=true; document.getElementById('recording-overview-refresh').click(); true");
  await until("document.getElementById('recording-overview-message').textContent.includes('last successful overview')");
  assert.equal(await evaluate("document.getElementById('recording-overview-content').innerHTML===window.recordingFixture.previous"),true,'failed refresh preserves the complete inventory');
  await evaluate("document.getElementById('recording-overview-refresh').click(); true");
  await until("!document.getElementById('recording-overview-refresh').disabled && !document.getElementById('recording-overview-message').classList.contains('form-error')");
  await command('browsingContext.setViewport',{context,viewport:{width:390,height:844},devicePixelRatio:1});
  await evaluate("document.querySelector('[data-dataset-id=state-settings] > summary').click(); document.querySelector('[data-dataset-id=state-settings] > summary').click(); document.querySelector('[data-dataset-id=state-settings]').scrollIntoView({block:'start'}); true");
  assert.equal(await evaluate("document.querySelector('[data-dataset-id=state-settings]').open"),true,'mobile native details remains operable');
  assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),true,'recording inventory does not overflow the mobile page');
  await checkRecordingHierarchy();
  mkdirSync('var',{recursive:true});
  const inventoryMobileShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
  writeFileSync('var/home-energy-recording-inventory-mobile.png',Buffer.from(inventoryMobileShot.data,'base64'));
  await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  await evaluate("document.getElementById('recording-overview-details').scrollIntoView({block:'start'}); true");
  const inventoryShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
  writeFileSync('var/home-energy-recording-inventory.png',Buffer.from(inventoryShot.data,'base64'));
  await evaluate("window.fetch=window.recordingFixture.fetch; document.getElementById('recording-overview-details').open=false; true");
  await evaluate("document.getElementById('energy-audit-details').open=true; true");
  await until("document.getElementById('energy-audit-content').textContent.includes('never change history')");
  await evaluate("document.getElementById('recording-details').scrollIntoView(); true");
  mkdirSync('var',{recursive:true});
  const recordingShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
  writeFileSync('var/home-energy-recording.png',Buffer.from(recordingShot.data,'base64'));
  await evaluate("document.getElementById('recording-details').open=false; window.scrollTo(0,0); true");

  assert.equal(await evaluate("document.body.textContent.includes('A comfortable home')"), false);
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  const legendState = text => evaluate(`Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))?.getAttribute('aria-pressed')`);
  const checkSeriesDrawn = async (keys, left) => {
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.left === ${JSON.stringify(left)}
      && ${JSON.stringify(keys)}.every(key =>
        document.querySelector('[data-chart-key="' + key + '"]')?.getAttribute('aria-pressed') === 'true')`);
    for (const key of keys) {
      const changedPixels = await evaluate(`(async () => {
        const canvas = document.getElementById('history');
        const context = canvas.getContext('2d');
        const button = document.querySelector('[data-chart-key="${key}"]');
        const settled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await settled();
        const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
        button.click();
        await settled();
        const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let changed = 0;
        for (let i = 0; i < before.length; i += 4) {
          if (before[i] !== after[i] || before[i + 1] !== after[i + 1]
            || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) changed++;
        }
        button.click();
        await settled();
        return changed;
      })()`);
      assert.ok(changedPixels > 0, `${key} draws visible chart pixels, not just a legend entry`);
    }
  };
  const checkPowerDrawn = () => checkSeriesDrawn(['property_power', 'charger_power'], 'power');
  await checkPowerDrawn();
  assert.equal(await legendState('all-in'), 'true');
  assert.equal(await legendState('spot'), 'true');
  assert.equal(await legendState('dhwr'), 'false');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await evaluate("localStorage.setItem('home-energy-theme', 'light'); true");
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'Reload starts dark even with a legacy light preference');
  // A single start-date change opens one old day; the disabled end follows it.
  await evaluate("document.getElementById('date-start').value='2024-09-07'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2024-09-07' && document.getElementById('history').dataset.rangeEnd === '2024-09-07'");
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2024-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  // Clicking the label enables a range and places the cursor in the end picker.
  await evaluate("document.querySelector('.end-date-toggle').click(); true");
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), true);
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  assert.equal(await evaluate('document.activeElement.id'), 'date-end');
  await evaluate("document.getElementById('date-end').value='2024-09-09'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeEnd === '2024-09-09'");
  // An end before the start is rejected without replacing the plotted range.
  await evaluate("document.getElementById('date-end').value='2024-09-06'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  assert.equal(await evaluate("document.getElementById('chart-range-form').checkValidity()"), false);
  assert.equal(await evaluate("document.getElementById('history').dataset.rangeEnd"), '2024-09-09');
  await evaluate("document.getElementById('date-range-enabled').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeEnd === '2024-09-07'");
  // Moving the start beyond an enabled end keeps a valid one-day selection.
  await evaluate("document.getElementById('date-range-enabled').click(); document.getElementById('date-start').value='2024-09-12'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2024-09-12' && document.getElementById('history').dataset.rangeEnd === '2024-09-12'");
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), false);
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  await evaluate("Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes('spot')).click(); true");
  for (const [left, expected, absent] of [['phases', 'property_current_l1', 'property_power'], ['integral', 'heating_integral', 'charger_power'],
    ['heat_pump_power','heat_pump_power','property_power'],
    ...['learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature'].map(name => [name, name, 'property_power']),
    ...coefficientKeys.map(name => [name, name, 'property_power']),
    ['solar_radiation', 'solar_radiation', 'property_power'], ['power', 'property_power', 'heating_integral']]) {
    const began = performance.now();
    await evaluate(`document.getElementById('left-axis').value=${JSON.stringify(left)}; document.getElementById('left-axis').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)} && !!document.querySelector('[data-chart-key="${expected}"]') && !document.querySelector('[data-chart-key="${absent}"]')`);
    assert.equal(await legendState('spot'), 'false', 'Explicitly hidden shared legend preference survives axis changes');
    assert.equal(await legendState('indoor'), 'true');
    if(left==='heat_pump_power')assert.match(await evaluate("document.getElementById('chart-notes').textContent"),/reconstructed from saved equipment states.*gaps/);
    if (coefficientKeys.includes(left)) {
      const tableCounts = () => app.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
        .map(({ name }) => [name, app.store.db.prepare(`SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`).get().count]);
      const before = tableCounts();
      const replayed = await fetch(`${base}/api/chart?start=2026-09-07&end=2026-09-07&left=${left}`).then(response => response.json());
      assert.deepEqual(tableCounts(), before, 'Coefficient API reads do not add stored entries');
      assert.equal(replayed.meta.modelCoefficients.basis, 'read-only-learning-replay');
      const values = replayed.series[left].filter(point => Number.isFinite(point.y));
      assert(values.some(point => point.coefficientStatus === 'initial'));
      assert(values.some(point => point.coefficientStatus === 'fitted' && point.y === coefficientValues[left].value));
      assert(values.every(point => point.modelCoefficient && point.inputSource === 'Simulation'));
      assert(values.every(point => point.x <= now), 'Current coefficients are never extended into the future');
      assert.match(await evaluate("document.getElementById('chart-notes').textContent"), /without additional stored history.*initial estimates, fitted values and retained values/);
      assert.doesNotMatch(await evaluate("document.getElementById('chart-notes').textContent"), /Model inputs are the values saved/);
      await checkSeriesDrawn([left], left);
    }
    if (left === 'power') await checkPowerDrawn();
    timings.push({ action: left, elapsedMs: Math.round(performance.now() - began) });
  }
  // Rapid changes must settle on the last request even if previous requests finish late.
  await evaluate("document.getElementById('range-yesterday').click(); document.getElementById('range-tomorrow').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), true);
  await evaluate("document.getElementById('date-start').value='2026-09-08'; document.getElementById('date-end').value='2026-09-08'; document.getElementById('chart-range-form').requestSubmit(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-08' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  const tomorrow = await fetch(`${base}/api/chart?start=2026-09-08&end=2026-09-08`).then(r => r.json());
  assert.ok(tomorrow.series.outdoor_forecast.length > 0);
  assert.ok(tomorrow.series.all_in_price.length > 0);
  assert.equal(tomorrow.series.indoor_temperature.some(p => p.y !== null), false);
  for (const series of Object.values(tomorrow.series)) assert.ok(series.every(p => p.x >= tomorrow.range.from && p.x <= tomorrow.range.to));
  await evaluate("document.getElementById('range-yesterday').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-06' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  const populated = await fetch(`${base}/api/chart?start=2026-09-06&end=2026-09-07`).then(r => r.json());
  for (const key of ['heatOff', 'compressorSpace', 'compressorDhw', 'dhwr']) assert.ok(populated.shading[key].length > 0, `Synthetic ${key} shading is available`);
  assert.ok(populated.operatingModes.length > 0);
  assert.ok(populated.series.auxiliary_power.some(point => point.y > 0));
  assert.equal(await evaluate("document.getElementById('learning-details').open"), false);
  assert.equal(await evaluate("document.getElementById('learning-panel-details').open"), false);
  assert.equal(await evaluate("document.getElementById('learning-metrics').children.length"), 4);
  assert.equal(await evaluate("document.getElementById('h66-test-submit').disabled"), true);
  mkdirSync('var', { recursive: true });
  const capture = async name => {
    const shot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    writeFileSync(`var/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  assert.equal(await evaluate("document.querySelectorAll('.controller-column > article').length"), 3);
  assert.equal(await evaluate("[...document.querySelectorAll('.controller-panels details')].every(fold => !fold.open)"), true);
  await evaluate("document.querySelector('.controller-panels').scrollIntoView({block:'start'}); true");
  await capture('home-energy-dashboard-closed-desktop');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await capture('home-energy-dashboard-closed-light');
  await evaluate("document.getElementById('theme-toggle').click(); document.querySelector('#learning-panel-details > summary').focus(); true");
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'learning-keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert.equal(await evaluate("document.getElementById('learning-panel-details').open"), true, 'Learning overview opens by keyboard');
  await evaluate("document.querySelector('#learning-details > summary').click(); document.getElementById('learning-details').scrollIntoView(); true");
  assert.equal(await evaluate("document.getElementById('learning-details').open && document.getElementById('learning-metrics').getBoundingClientRect().height > 0"), true, 'Nested learning outcomes are visible');
  await capture('home-energy-dark-desktop');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await capture('home-energy-light-desktop');
  await checkDateAlignment();
  await evaluate("document.getElementById('theme-toggle').click(); true");
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile layout fits screen');
    await checkDateAlignment();
    await evaluate("document.getElementById('date-range-enabled').click(); true");
    await checkDateAlignment();
    await evaluate("document.getElementById('date-range-enabled').click(); true");
    await capture(`home-energy-dark-${viewport.width}`);
    await evaluate("document.querySelector('.history-panel').scrollIntoView(); true");
    await capture(`home-energy-chart-${viewport.width}`);
    await evaluate('scrollTo(0, 0); true');
  }
  // Home controls use Finnish wall times even in a browser running in another zone.
  assert.equal(await evaluate("document.querySelectorAll('.controller-panels article').length"), 3);
  assert.equal(await evaluate("document.getElementById('home-control').textContent.includes('Household')"), false);
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Active');
  assert.equal(await evaluate("document.querySelector('#settings-form, #contract-form, #override-form') === null"), true);
  assert.equal(await evaluate("document.getElementById('contract-periods').textContent.includes('2.91788')"), true);
  assert.equal(await evaluate("document.getElementById('h66-provider-details').open"), false);
  assert.equal(await evaluate("document.getElementById('heating-test-details').open"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
  assert.equal(await evaluate("document.getElementById('home-control').contains(document.getElementById('temporary-details')) && document.getElementById('providers-controls').contains(document.getElementById('electricity-details'))"), true);
  await evaluate(`document.getElementById('temporary-details').open = true;
    document.getElementById('away-until').value = '2026-09-09T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('pause-until').value = '2026-09-07T18:00';
    document.getElementById('pause-until').dispatchEvent(new Event('input'));
    document.getElementById('temporary-form').requestSubmit(); true`);
  await until("document.getElementById('temporary-message').textContent === 'Changes applied.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Paused', 'A pause takes precedence over away mode');
  assert.match(await evaluate("document.getElementById('temporary-overview').textContent"), /Away until.*Paused until/);
  assert.equal(app.engine.settings.occupancy.returnAt, '2026-09-09T15:00:00.000Z');
  assert.equal(app.engine.status().override.expiresAt, Date.parse('2026-09-07T15:00:00Z'));
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('away-until').value === '2026-09-09T18:00'");
  assert.equal(await evaluate("document.getElementById('pause-until').value"), '2026-09-07T18:00');
  assert.equal(await evaluate("document.getElementById('temporary-details').open"), false);
  assert.match(await evaluate("document.getElementById('temporary-overview').textContent"), /Away until.*Paused until/, 'Closed controls still show active away and pause deadlines');
  assert.equal(await evaluate("document.getElementById('temporary-submit').disabled"), true);
  // Pending edits survive blur and an actual background status poll.
  await evaluate(`document.getElementById('temporary-details').open = true;
    window.__statusPolls = 0; const originalFetch = window.fetch;
    window.fetch = (...args) => { if (args[0] === '/api/status') window.__statusPolls++; return originalFetch(...args); };
    document.getElementById('away-until').value = '2026-09-10T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('away-until').blur(); true`);
  await until('window.__statusPolls > 0', 650);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00');
  await evaluate("document.getElementById('resume-now').click(); true");
  await until("document.getElementById('override-status').textContent === 'Price control is not paused.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Away');
  assert.equal(app.engine.settings.occupancy.returnAt, '2026-09-09T15:00:00.000Z', 'Resuming preserves the saved away deadline');
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00', 'Resuming preserves an unrelated pending edit');
  assert.equal(await evaluate("document.getElementById('temporary-submit').disabled"), false);
  await evaluate("document.getElementById('home-now').click(); true");
  await until("document.getElementById('away-status').textContent === 'At home.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Active');
  assert.equal(await evaluate("document.getElementById('away-until').value"), '');
  assert.equal(app.engine.settings.occupancy.mode, 'occupied');
  // Invalid DST choices leave both settings untouched and the draft available to correct.
  await evaluate(`document.getElementById('away-until').value = '2026-10-25T03:30';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('pause-until').value = '2026-09-07T18:00';
    document.getElementById('pause-until').dispatchEvent(new Event('input'));
    document.getElementById('temporary-form').requestSubmit(); true`);
  await until("document.getElementById('temporary-message').classList.contains('form-error')");
  assert.equal(app.engine.settings.occupancy.mode, 'occupied');
  assert.equal(app.engine.status().override, null);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-10-25T03:30');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('history').dataset.ready === 'true'");
  await until("document.getElementById('events').children.length > 0");
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    await evaluate("document.getElementById('temporary-details').open=false; document.getElementById('home-control').scrollIntoView(); true");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Home controls fit desktop and mobile');
    await capture(`home-energy-dashboard-closed-${viewport.width}`);
    await evaluate("document.querySelector('#temporary-details > summary').click(); true");
    assert.equal(await evaluate(`(() => {
      const a = document.getElementById('away-until').getBoundingClientRect();
      const b = document.getElementById('pause-until').getBoundingClientRect();
      return a.width > 0 && a.height > 0 && Math.abs(a.width-b.width) < 1 && Math.abs(a.height-b.height) < 1;
    })()`), true, 'Temporary date fields match');
    await capture(`home-energy-controls-${viewport.width}`);
  }
  await app.close();
  const fixture = providerFixture(now);
  fixture.providerOptions.temperatureProvider = fixture.providerOptions.devices.temperatures;
  const fixtureCurrents = fixture.providerOptions.devices.easee;
  // Equalizer phases share an acquisition but retain independent source clocks.
  // This used to leave property power empty while charger power still rendered.
  fixture.providerOptions.devices.easee = async () => (await fixtureCurrents()).map(row => ({ ...row,
    sourceTime: row.sourceTime - (row.signal.startsWith('property_current_') ? (Number(row.signal.at(-1)) - 1) * 90_000 : 0),
  }));
  const testPublishes = [];
  let testConnections = 0, acknowledgeHeating;
  const connectTestBroker = () => {
    testConnections++;
    const client = new EventEmitter();
    client.publish = (topic, payload, options, callback) => { testPublishes.push({ topic, payload, options }); acknowledgeHeating = callback; };
    client.end = (force, options, callback) => callback?.();
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
  app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'provider-fixture.sqlite'),
    priceSettings: { ...config.priceSettings, effectiveDate: '2026-09-07' },
    connections: { ...fixture.connections, mqtt: { address: 'mqtt://fixture.invalid' } } },
    clock: () => now, providerOptions: fixture.providerOptions, mqttOptions: { connect: connectTestBroker } });
  for(const [prefix,power] of [['property',6.9],['ev1',2.07]]) {
    app.engine.ingestEnergy({source:'easee',device:`synthetic-${prefix}`,prefix,start:now-5*60_000,end:now,
      energies:[power/36,power/36,power/36],powers:[power/3,power/3,power/3],quality:['estimated'],receivedAt:now});
  }
  // Artificial legacy readings predate the only known contract period. Charger
  // phase currents and quarter-hour spot prices suffice; no HP power is invented.
  const historicalStart = Date.parse('2026-09-06T00:00:00+03:00');
  app.store.transaction(() => {
    for (let slot = 0; slot <= 96; slot++) {
      const at = historicalStart + slot * 15 * 60_000;
      const add = (signal, value, unit) => app.store.observation({ source: 'browser-fixture',
        device: 'synthetic-historical-charger', signal, value, unit,
        sourceTime: at, receivedAt: at, quality: [], raw: { fixture: true } });
      if (slot < 96) add('spot_price', slot < 4 ? 0 : 20, 'c/kWh_ex_vat');
      for (let phase = 1; phase <= 3; phase++) add(`ev1_current_l${phase}`, slot < 4 ? 10 : 0, 'A');
    }
  });
  seedTimingBrowserFixture(app.store);
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
  await until("document.getElementById('outdoor-age')?.textContent.includes('FMI nearby station')");
  await until("document.getElementById('history').dataset.ready === 'true'");
  const providerChart = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?start=2026-09-07&end=2026-09-07&left=power`).then(response => response.json());
  for (const [key, expected] of [['property_power', 6.9], ['charger_power', 2.07]]) {
    assert.ok(providerChart.series[key].some(point => Number.isFinite(point.y) && Math.abs(point.y - expected) < 1e-9),
      `${key} contains the expected total from all three provider phase currents`);
  }
  await checkPowerDrawn();
  await checkTimingBrowser({ command, evaluate, until, capture, context });
  for (const left of ['phases', 'integral', 'power']) {
    await evaluate(`document.getElementById('left-axis').value=${JSON.stringify(left)}; document.getElementById('left-axis').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)}`);
  }
  await checkPowerDrawn();
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Using backup')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Electricity market · Elering')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Next ENTSO-E try')"), true);
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] .provider-heading > strong').textContent"), 'Main temperatures · SmartThings, FMI');
  assert.equal(await evaluate("[...document.querySelectorAll('[data-provider=main-temperatures] .provider-series > li > strong')].map(row => row.textContent).join(',')"),
    'Indoor temperature · °C,Garage temperature · °C,Outdoor temperature · °C');
  assert.equal(await evaluate("document.querySelector('#providers > :last-child').dataset.provider"), 'weather', 'Weather forecast is the final provider');
  assert.equal(await evaluate("document.querySelector('#provider-overview > :last-child > span').textContent"), 'Weather forecast', 'Weather forecast is last in the closed overview');
  assert.equal(await evaluate("document.getElementById('weather-status').textContent.includes('FMI')"), true);
  assert.equal(testConnections, 0, 'Configured manual tests do not connect during startup or polling');
  assert.equal(await evaluate("document.getElementById('heating-test-details').open"), false);
  await evaluate(`document.getElementById('equipment-details').open = true;
    document.getElementById('heating-test-details').open = true;
    document.getElementById('temporary-details').open = true;
    document.getElementById('away-until').value = '2026-09-10T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input')); true`);
  for (const command of ['heatoff', 'heaton15', 'heaton60']) {
    acknowledgeHeating = null;
    await evaluate(`document.getElementById('test-${command}').click(); document.getElementById('test-${command}').click(); true`);
    await until("document.getElementById('heating-test-buttons').getAttribute('aria-busy') === 'true'");
    for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof acknowledgeHeating, 'function');
    assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
    assert.equal(await evaluate("document.getElementById('heating-test-message').textContent.includes('sent via MQTT')"), false);
    acknowledgeHeating();
    await until(`document.getElementById('heating-test-message').textContent.includes('${command} sent via MQTT') && !document.getElementById('test-${command}').disabled`);
    assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00');
  }
  assert.deepEqual(testPublishes, ['heatoff', 'heaton15', 'heaton60'].map(payload => ({ topic: 'from_stmq/heat/action', payload, options: { qos: 1, retain: false } })));
  assert.equal(app.engine.status().observations.actual.mode, 'unknown');
  acknowledgeHeating = null;
  // Normal heat is allowed during the preceding DHWR pulse; reduction would
  // correctly fail before publishing and never exercise broker-error handling.
  await evaluate("document.getElementById('test-heaton15').click(); true");
  for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof acknowledgeHeating, 'function');
  acknowledgeHeating(new Error('synthetic-private-broker-error'));
  await until("document.getElementById('heating-test-message').classList.contains('form-error') && !document.getElementById('test-heaton15').disabled");
  assert.equal(await evaluate("document.body.textContent.includes('synthetic-private-broker-error')"), false);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-desktop');
  await evaluate("document.getElementById('h66-provider-details').open = true; document.getElementById('connections-details').open = true; document.querySelectorAll('#providers .provider-fold').forEach(fold => fold.open = true); document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-desktop');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-mobile');
  await evaluate("document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-mobile');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'chart-browser-smoke-passed', browserTimeZone, timings,
    checked: ['electricity-first-without-right-axis-duplicates', 'four-coefficients-from-read-only-replay', 'coefficient-visible-pixels-and-status', 'default-dark-on-reload', 'theme-toggle', 'Finnish-today', 'single-old-day', 'optional-end-date', 'range-validation', 'shortcut-order-and-state', 'axis-and-legend-selection', 'property-and-charger-visible-pixels', 'asynchronous-provider-phase-power', 'historical-charger-assumed-rates', 'timing-evidence-shares-and-dates', 'timing-reconstructed-and-unavailable', 'timing-consistent-elapsed-time-coverage-and-standby-exclusion', 'timing-equal-closed-card-heights-and-independent-expansion', 'timing-stable-heading-and-fold-positions', 'timing-nested-fold-keyboard-touch-and-refresh', 'timing-dark-light-responsive-inline-explanations', 'grouped-history-catalogue', 'recording-frequencies', 'recording-inventory-lazy-fetch', 'recording-inventory-keyboard-mobile', 'recording-inventory-refresh-and-error-preservation', 'physical-storage-accounting', 'reconstructed-heat-pump-note', 'audit-only-diagnostics', 'price-defaults', 'date-races', 'tomorrow-only', 'desktop-mobile', 'Finnish-away-and-pause', 'independent-cancellation', 'draft-poll-preservation', 'DST-atomic-rejection', 'read-only-rates', 'three-dashboard-cards', 'nested-learning-keyboard', 'closed-away-and-pause-deadlines', 'provider-sources-and-fallbacks', 'collapsed-MQTT-tests', 'MQTT-publish-acknowledgement-and-failure', 'MQTT-draft-preservation'] }, null, 2));
  await command('browser.close', {}); ownsBrowser=false;
} finally {
  if(ownsBrowser) { try {await command('browser.close',{});}catch{} }
  ws?.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
