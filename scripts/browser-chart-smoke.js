import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { providerFixture } from './lib/provider-fixture.js';
import { seedTimingBrowserFixture, checkTimingBrowser } from './lib/timing-browser-checks.js';
import { checkChartZoomBrowser } from './lib/chart-zoom-browser-checks.js';
import { installChartPopupProbe, checkChartPopupBrowser } from './lib/chart-popup-browser-checks.js';
import { checkEquipmentBrowser } from './lib/equipment-browser-checks.js';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { addFireplace } from '../src/app/fireplace.js';
import { recordChargingSessionCheck } from '../src/app/charging-session-checks.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { CHART_VIEWS, CHART_VIEW_BY_KEY } from '../src/domain/chart-views.js';
import { EXPLORER_SERIES } from '../chart/series-explorer.js';

// Requires a separately started isolated Firefox BiDi listener. This script
// creates its own temporary simulation, never reads household credentials.
const directory = mkdtempSync(join(tmpdir(), 'stmq-browser-chart-'));
const now = Date.parse('2026-09-07T12:00:00Z');
const coefficientValues = {
  model_coefficient_heat_loss: { parameter: 'lossPerHour', value: 0.0273 },
  model_coefficient_hydronic_response: { parameter: 'hydronicCPerKwh', value: 0.085 },
  model_coefficient_solar_response: { parameter: 'solarCPerHourPerKwM2', value: 0.32 },
  model_coefficient_fireplace_response: { parameter: 'fireplaceCPerKg', value: 0.16 },
};
const coefficientKeys = Object.keys(coefficientValues);
const recordingOnly = process.argv.includes('--recording-only');
const chartOnly = process.argv.includes('--chart-only');
const energyOnly = process.argv.includes('--energy-only');
function seedRecordingFixture(app) {
  const record = (signal,value,unit,device,source='mqtt-equipment') => app.engine.recorder.record({
    source,device,signal,value,unit,sourceTime:now,receivedAt:now,quality:[],raw:{reportIntervalMs:90_000} });
  for(const [device,value] of [['private-recording-probe-a',18],['private-recording-probe-b',19]])
    record('workshop_temperature',value,'degC',device);
  record('workshop_temperature',45,'%', 'private-recording-probe-a');
  for(const group of ['living','storage']) for(const output of [0,1])
    record(`floor_${group}_${output}_active`,output,'state',`private-floor-${group}`,'floor-override');
  record('garage_native_defrost',0,'state','private-pump','garage-adapter');
  for (let interval = 0; interval < 2; interval++) app.engine.recorder.recordEnergy({
    source:'shelly-mqtt',device:'private-caravan-meter',prefix:'caravan',start:now-(2-interval)*60_000,
    end:now-(1-interval)*60_000,receivedAt:now-(1-interval)*60_000,powers:[1],energies:[1/60],quality:[],
  });
  // Current-format recovered observations need not have a live recorder checkpoint.
  app.store.observation({source:'mqtt-equipment',device:'private-recovered-probe',signal:'workshop_pressure',
    value:2,unit:'bar',sourceTime:now,receivedAt:now,quality:[],raw:{recorder:{policy:'adaptive-value'}}});
  for(let i=0;i<2;i++) app.engine.recorder.record({source:'mqtt-equipment',device:'private-circulation',signal:'dhwr_active',
    value:i,unit:'state',sourceTime:now-(1-i)*1000,receivedAt:now-(1-i)*1000,quality:[],raw:{basis:'measured-power',timeBasis:'mqtt-received'}});
  app.store.event('garage-external-temperature-diagnostic',{status:'abnormal',reason:'synthetic-report-gap'},now);
  app.engine.latestStatus.recording=app.engine.recorder.status(now);
}
function seedChargingFixture(store, energySource='simulation') {
  store.transaction(() => {
    for (let slot=0;slot<12;slot++) {
      const start=now-(120-slot*5)*60_000,end=start+5*60_000,power=slot<6?6:4;
      store.observation({source:energySource,device:'synthetic-browser-shelly',signal:'ev2_energy',
        sourceTime:end,receivedAt:end,value:power/12,unit:'kWh',quality:['estimated',...(energySource==='simulation'?['simulated']:[])],
        raw:{intervalStart:start,intervalEnd:end,durationMs:end-start,basis:'synthetic-browser-fixture'}});
    }
    store.energyAudit({source:'easee',device:'synthetic-browser-property',signal:'property_import_energy_counter',
      sourceTime:now,receivedAt:now,value:100});
    for (const [source,key,estimatedKwh,referenceKwh,complete,offset] of [
      ['easee','synthetic-first',12,10,true,4],['easee','synthetic-second',81,90,true,2],
      ['shelly-evse','synthetic-first',12,10,true,4],['shelly-evse','synthetic-partial',2,1,false,2],
    ]) recordChargingSessionCheck(store,{source,sessionKey:key,start:now-offset*3600_000,
      end:now-(offset-1)*3600_000,estimatedKwh,referenceKwh,complete,
      quality:complete?[]:['incomplete-coverage']});
  });
}
let app, ws, command, ownsBrowser=false;
const pending = new Map(), errors = [], timings = [];
let id = 0;
try {
  const exportDirectory = join(directory, 'database-exports');
  writeFileSync(join(directory, 'options.json'), JSON.stringify({ recording: { export_directory: exportDirectory } }));
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
    model.validation = { accepted: true, kind: 'conditional-thermal', chronological: true,
      fittedParameters: Object.values(coefficientValues).map(row => row.parameter),
      parameterEvidence: Object.fromEntries(Object.values(coefficientValues).map(row => [row.parameter,
        { status: 'identified', fitStatus: 'fitted', relativeSpread: .1 }])) };
    model.trainedAt = new Date(now - 4 * 3600000).toISOString();
    appendLearningRecord(fixtureStore, 'simulated', 'context', { timestamp: now - 4 * 3600000,
      historySeed: { model, source: { basis: 'synthetic-browser-model' } } }, { config: config.control });
  } finally { fixtureStore.close(); }
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  seedChargingFixture(app.store);
  seedRecordingFixture(app);
  addFireplace(app.store, 'simulated', { kg: 8, requestId: 'synthetic-browser-fire' }, now - 3 * 3600000);
  addFireplace(app.store, 'simulated', { kg: 4, requestId: 'synthetic-browser-topup' }, now - 2 * 3600000);
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
  await installChartPopupProbe({ command, context });
  await command('browsingContext.activate',{context});
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
    const decode = result => result.type === 'array' ? result.value.map(decode)
      : result.type === 'object' ? Object.fromEntries(result.value.map(([key, value]) => [key, decode(value)]))
        : result.type === 'null' ? null : result.value;
    return decode(result.result);
  };
  const browserTimeZone = await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
  const until = async (expression, attempts = 150) => {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${JSON.stringify(errors)}`);
  };
  if (energyOnly) {
    await app.close();
    const fixture = providerFixture(now);
    app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'energy-fixture.sqlite'),
      priceSettings: { ...config.priceSettings, effectiveDate: '2026-09-07' },
      connections: { ...fixture.connections, equipment: equipmentConfiguration({ devices: [] }) } },
      clock: () => now, providerOptions: fixture.providerOptions });
    seedTimingBrowserFixture(app.store);
    mkdirSync('var', { recursive: true });
    const capture = async name => {
      const shot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
      writeFileSync(`var/${name}.png`, Buffer.from(shot.data, 'base64'));
    };
    await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
    await until("document.getElementById('history')?.dataset.ready === 'true'");
    await checkTimingBrowser({ command, evaluate, until, capture, context });
    assert.deepEqual(errors, [], 'Energy comparisons render without browser errors');
    console.log(JSON.stringify({ result: 'energy-browser-smoke-passed', browserTimeZone,
      checked: ['scopes-and-comparisons', 'calculation-operands', 'coverage-and-rates', 'zero-negative-unavailable',
        'keyboard-focus-and-fold-preservation', 'responsive-layout', 'dark-and-light'] }));
  } else {
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const checkDateAlignment = async () => {
    assert.equal(await evaluate(`(() => {
      const start = document.getElementById('date-start'), end = document.getElementById('date-end');
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      return ['top', 'height', 'width'].every(key => Math.abs(a[key] - b[key]) < 1)
        && getComputedStyle(start).fontSize === getComputedStyle(end).fontSize;
    })()`), true, 'Date fields have matching widths, heights, alignment and text size');
  };
  const checkRangeSteps = async () => {
    assert.equal(await evaluate(`(() => {
      const back = document.getElementById('range-back'), forward = document.getElementById('range-forward');
      const yesterday = document.getElementById('range-yesterday'), tomorrow = document.getElementById('range-tomorrow');
      const a = back.getBoundingClientRect(), b = yesterday.getBoundingClientRect();
      const c = tomorrow.getBoundingClientRect(), d = forward.getBoundingClientRect();
      return [back, forward].every(button => button.type === 'button' && button.getAttribute('aria-label'))
        && a.width < b.width && d.width < c.width && a.right <= b.left && c.right <= d.left
        && Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 1
        && Math.abs((d.top + d.height / 2) - (c.top + c.height / 2)) < 1;
    })()`), true, 'Accessible one-day arrows are compact and flank the shortcuts in one aligned row');
  };
  const checkActivityTracks = async () => {
    assert.match(await evaluate("document.querySelector('#dhwr-history .activity-title').textContent"), /Hot-water circulation request/i);
    assert.equal(await evaluate(`(() => {
      const canvas = document.getElementById('history').getBoundingClientRect();
      const rows = ['operating-modes', 'dhwr-history', 'fireplace-history'].map(id => document.getElementById(id));
      const tracks = rows.map(row => row.querySelector('.mode-track').getBoundingClientRect());
      return rows.every(row => !row.hidden) && tracks.every(track => track.width > 0 && track.top >= canvas.bottom
        && Math.abs(track.left - tracks[0].left) < 1 && Math.abs(track.right - tracks[0].right) < 1);
    })()`), true, 'Activity strips stay below the plot and aligned after theme/viewport changes');
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
  await until("document.getElementById('chart-legend')?.querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.title'), 'Home Energy');
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await evaluate("document.getElementById('date-start').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  await checkDateAlignment();
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.range-shortcuts button')).map(button => button.id).join(',')"), 'range-back,range-yesterday,range-today,range-tomorrow,range-forward');
  await checkRangeSteps();
  assert.equal(await evaluate("document.getElementById('history').dataset.view"), 'power');
  await evaluate("document.getElementById('chart-series-toggle').click(); true");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [data-view-key]')].map(option => option.dataset.viewKey)"),
    CHART_VIEWS.map(view => view.key), 'Every named investigation is available in the explorer');
  assert.equal(await evaluate("Boolean(document.querySelector('#chart-series [data-view-key=firewood]'))"), true,
    'The explorer includes Firewood additions');
  await evaluate("document.getElementById('chart-series-search').value='Home coefficients'; document.getElementById('chart-series-search').dispatchEvent(new Event('input')); true");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [data-view-key]')].map(option => option.dataset.viewKey)"),
    coefficientKeys, 'Only the four fitted Home coefficients have chart choices');
  await evaluate("document.getElementById('chart-series-mode-series').click(); true");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [role=option]')].map(option => option.dataset.seriesKey).sort()"),
    EXPLORER_SERIES.map(series => series.key).sort(), 'The explorer retains every supported numerical and state projection');
  await evaluate("document.getElementById('chart-series-close').click(); true");
  assert.equal(await evaluate("document.getElementById('history').dataset.view"), 'power', 'Browsing the catalogues preserves the active chart');
  const selectChartSubject = async key => {
    const kind = CHART_VIEW_BY_KEY[key] ? 'view' : 'series';
    await evaluate(`document.getElementById('chart-series-toggle').click();
      document.getElementById('chart-series-mode-${kind === 'view' ? 'views' : 'series'}').click();
      document.getElementById('chart-series-search').value='';
      document.getElementById('chart-series-search').dispatchEvent(new Event('input'));
      document.querySelector('#chart-series [data-${kind}-key="${key === 'integral' ? 'heating_integral' : key}"]').click(); true`);
  };
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
  await until("document.querySelectorAll('#recording-content tr[data-stream-id]').length>0");
  assert.match(await evaluate("document.getElementById('recording-content').textContent"),/Rolling target/);
  for(const label of ['Garage rear temperature','Garage front temperature','maximum interval'])
    assert(!await evaluate(`document.getElementById('recording-content').textContent.includes(${JSON.stringify(label)})`));
  const expectedStreams=app.engine.recorder.status(now).parameters.map(row=>row.streamId).sort();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#recording-content tr[data-stream-id]')].map(row=>row.dataset.streamId).sort()"),expectedStreams,
    'every actual adaptive stream appears once; exact and never-observed streams do not appear');
  const duplicateRows=await evaluate("[...document.querySelectorAll('#recording-content tr[data-signal=workshop_temperature]')].map(row=>({id:row.dataset.streamId,text:row.querySelector('th').textContent}))");
  assert.equal(duplicateRows.length,3);assert.equal(new Set(duplicateRows.map(row=>row.id)).size,3);
  assert(duplicateRows.every(row=>row.text.includes(`Stream ${row.id}`)));
  assert(duplicateRows.some(row=>row.text.includes('°C'))&&duplicateRows.some(row=>row.text.includes('%')));
  assert(!JSON.stringify(duplicateRows).includes('private-recording-probe'));
  assert.match(await evaluate("document.querySelector('#recording-content tr[data-signal=caravan_energy]').textContent"),/Caravan energy.*1.*Open:.*kWh over 1 min.*saved as readings arrive/);
  assert.equal(await evaluate("Boolean(document.querySelector('#recording-content tr[data-signal=workshop_pressure]'))"),false,
    'saved history without a checkpoint does not invent a current threshold');
  await evaluate("document.querySelector('#recording-content details[data-stream-id]').open=true; document.querySelector('#recording-content details[data-stream-id] summary').focus(); true");
  const focusedReading=await evaluate("document.activeElement.closest('details').dataset.streamId");
  await evaluate("document.getElementById('recording-details').dispatchEvent(new Event('toggle')); true");
  assert.equal(await evaluate("document.activeElement.closest('details').dataset.streamId"),focusedReading);
  assert.equal(await evaluate(`document.querySelector('#recording-content details[data-stream-id="${focusedReading}"]').open`),true,
    'fresh status rendering preserves source disclosure and keyboard focus');
  assert.equal(await evaluate("window.recordingFixture.requests"),0,'opening the adaptive table does not fetch the separate inventory');
  assert.equal(await evaluate("[...document.querySelectorAll('#recording-details > details')].map(node=>node.id).join(',')"),'recording-adaptive-details,recording-overview-details,energy-audit-details,database-export-details');
  await evaluate(`(() => {
    window.exportFixture = { create: URL.createObjectURL, click: HTMLAnchorElement.prototype.click, picker: window.showSaveFilePicker };
    window.showSaveFilePicker = undefined;
    URL.createObjectURL = blob => { window.exportFixture.blob = blob; return window.exportFixture.create(blob); };
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.exportFixture.name = this.download; else window.exportFixture.click.call(this); };
    document.getElementById('database-export-details').open = true;
    document.getElementById('database-export-download').click(); return true;
  })()`);
  await until("Boolean(window.exportFixture.blob) && !document.getElementById('database-export-download').disabled");
  assert.equal(await evaluate("window.exportFixture.blob.slice(0,16).text()"), 'SQLite format 3\0');
  const exportFilename = /^stmq-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.sqlite$/;
  assert.match(await evaluate("window.exportFixture.name"), exportFilename);
  assert.match(await evaluate("document.getElementById('database-export-message').textContent"), /Download ready/);
  await evaluate("URL.createObjectURL=window.exportFixture.create; HTMLAnchorElement.prototype.click=window.exportFixture.click; window.showSaveFilePicker=window.exportFixture.picker; document.getElementById('database-export-save').click(); true");
  await until("!document.getElementById('database-export-save').disabled && document.getElementById('database-export-message').textContent.startsWith('Database copy saved on the server:')");
  const savedFiles = readdirSync(exportDirectory);
  assert.equal(savedFiles.length, 1);
  assert.match(savedFiles[0], exportFilename);
  const savedDatabase = new Store(join(exportDirectory, savedFiles[0]), { readOnly: true });
  try { assert.equal(savedDatabase.getState('settings:browser-fixture').input, 'simulated'); }
  finally { savedDatabase.close(); }
  await evaluate("document.getElementById('database-export-details').open=false; true");
  await evaluate("document.querySelector('#recording-overview-details > summary').focus(); true");
  await command('input.performActions',{context,actions:[{type:'key',id:'recording-keyboard',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
  await until("document.querySelectorAll('#recording-overview-content .recording-data-group').length>=8");
  assert.equal(await evaluate("document.getElementById('recording-overview-details').open"),true,'native summary opens by keyboard');
  assert.equal(await evaluate("window.recordingFixture.requests"),1);
  for(const group of ['living','storage']) for(const output of [0,1]) {
    const key=`floor_${group}_${output}_active`;
    assert.match(await evaluate(`document.querySelector('[data-dataset-id="${key}"]').textContent`),/Every change/);
  }
  assert.match(await evaluate("document.querySelector('[data-dataset-id=dhwr_active]').textContent"),/2 records.*Every change/);
  assert.match(await evaluate("document.querySelector('[data-dataset-id=garage_native_defrost]').textContent"),/Garage defrost/);
  assert.match(await evaluate("document.querySelector('[data-dataset-id=events-garage-feed]').textContent"),/garage-external-temperature-diagnostic/);
  assert.match(await evaluate("document.querySelector('[data-dataset-id=adaptive-observations]').textContent"),/workshop_pressure.*bar.*Adaptive measurement/);
  const chargingInventory=await evaluate("document.querySelector('[data-dataset-id=state-charging]').textContent");
  assert.match(chargingInventory,/Charging choices, sessions and device state/);
  assert.match(chargingInventory,/Automatic charging and shared priority.*survive restart and unplugging/);
  assert.match(chargingInventory,/Session edits.*do not replace configured defaults/);
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
  await until("document.querySelectorAll('#energy-audit-content .energy-check').length===3");
  assert.equal(await evaluate("document.querySelector('#energy-audit-details > summary').textContent.trim()"),'Recorded energy checks');
  assert.match(await evaluate("document.getElementById('energy-audit-content').textContent"),/Compares recorded energy with electricity-meter readings\./);
  const energyCheck = signal => `#energy-audit-content .energy-check[data-check-key="${signal}"]`;
  const propertyCheck = energyCheck('property_import_energy_counter');
  const charger1Check = energyCheck('ev1_session_energy_check');
  const charger2Check = energyCheck('shelly_session_energy_check');
  const checkText = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const energyKey = value => command('input.performActions',{context,actions:[{type:'key',id:'energy-check-keyboard',
    actions:[{type:'keyDown',value},{type:'keyUp',value}]}]});
  const checkEnergyLayout = async label => {
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`${label}: checks fit the page`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('#energy-audit-content .energy-check, #energy-audit-content .energy-check-details')).every(node=>{
      const box=node.getBoundingClientRect();
      return box.left>=0 && box.right<=innerWidth && node.scrollWidth<=node.clientWidth+1;
    })`),true,`${label}: device rows and expanded explanations need no horizontal scrolling`);
  };
  for(const theme of ['dark','light']) {
    if(await evaluate('document.documentElement.dataset.theme')!==theme)
      await evaluate("document.getElementById('theme-toggle').click(); true");
    const checks=await evaluate(`Array.from(document.querySelectorAll('#energy-audit-content .energy-check'),row=>({
      title:row.querySelector('h3').textContent,subtitle:row.querySelector('.energy-check-source').textContent,
      result:row.querySelector('.energy-check-result').textContent,text:row.textContent}))`);
    assert.deepEqual(checks.map(row=>row.title),['Property','Charger 1','Charger 2'],`${theme}: device checks share a clear row layout`);
    assert.equal(checks[0].subtitle,'Import meter');
    assert.equal(checks[0].result,'Waiting for a second meter reading');
    assert(checks.slice(1).every(row=>row.subtitle==='Completed sessions'));
    assert.equal(checks[1].result,'Recorded energy is 7.0% lower than the meter');
    assert.match(checks[1].text,/93(?:\.0+)? kWh.*100(?:\.0+)? kWh/);
    assert.equal(checks[2].result,'Recorded energy is 20.0% higher than the meter');
    assert(!checks.slice(1).some(row=>/averages|per session|Lifetime energy meter/.test(row.text)),
      'Session results show weighted totals without per-session averages or lifetime counters');
    for(const width of [1440,390]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height:width===390?844:1100},devicePixelRatio:1});
      await evaluate("document.getElementById('energy-audit-details').scrollIntoView({block:'start'}); true");
      await checkEnergyLayout(`${theme}/${width}`);
      const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/home-energy-checks-${theme}-${width}.png`,Buffer.from(shot.data,'base64'));
    }
  }
  // Exercise actual refresh rendering with controlled API responses. The brief
  // clock offset bypasses only the audit refresh cache; no real data is read.
  await evaluate(`(async()=>{
    const fixture=window.energyCheckFixture={fetch:window.fetch.bind(window),now:Date.now,offset:0,requests:0};
    fixture.original=await fixture.fetch('/api/energy-audits').then(response=>response.json());
    fixture.rows=structuredClone(fixture.original);
    window.fetch=(...args)=>{
      if(!String(args[0]).includes('/api/energy-audits'))return fixture.fetch(...args);
      fixture.requests++;
      if(fixture.fail){fixture.fail=false;return Promise.reject(new Error('Synthetic energy-check failure'));}
      return Promise.resolve(new Response(JSON.stringify(fixture.rows),{status:200,headers:{'content-type':'application/json'}}));
    };
    return true;
  })()`);
  const refreshEnergyChecks = async rows => {
    if(rows) await evaluate(`window.energyCheckFixture.rows=${JSON.stringify(rows)}; true`);
    const previous=await evaluate('window.energyCheckFixture.requests');
    await evaluate(`(()=>{
      const fixture=window.energyCheckFixture;fixture.offset+=61000;
      Date.now=()=>fixture.now()+fixture.offset;
      document.getElementById('energy-audit-details').dispatchEvent(new Event('toggle'));
      return true;
    })()`);
    await until(`window.energyCheckFixture.requests>${previous}`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
    await evaluate('Date.now=window.energyCheckFixture.now; true');
  };
  await evaluate(`document.querySelector(${JSON.stringify(charger1Check+' .energy-check-details > summary')}).focus(); true`);
  await energyKey('\uE007');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(charger1Check+' .energy-check-details')}).open`),true,
    'Session comparison details open with Enter');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(charger2Check+' .energy-check-details')}).open`),false,
    'Other device details remain folded');
  await refreshEnergyChecks();
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(charger1Check+' .energy-check-details')}).open`),true,
    'Audit refresh preserves the expanded device');
  assert.equal(await evaluate('document.activeElement.closest(".energy-check")?.dataset.checkKey'),'ev1_session_energy_check',
    'Audit refresh preserves keyboard focus on the device disclosure');
  await evaluate("window.energyCheckFixture.previous=document.getElementById('energy-audit-content').innerHTML; window.energyCheckFixture.fail=true; true");
  await refreshEnergyChecks();
  assert.equal(await evaluate("document.getElementById('energy-audit-content').innerHTML===window.energyCheckFixture.previous"),true,
    'Failed refresh preserves the full comparison and expanded detail');
  assert.match(await checkText('#energy-audit-message'),/last successful results are still shown/);
  assert.equal(await evaluate('document.activeElement.closest(".energy-check")?.dataset.checkKey'),'ev1_session_energy_check',
    'Failed refresh preserves the focused disclosure');
  await energyKey('\uE007');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(charger1Check+' .energy-check-details')}).open`),false,
    'The focused disclosure still closes with Enter after refresh');
  const gapRows=await evaluate('structuredClone(window.energyCheckFixture.original)');
  gapRows[0].summary={status:'incomplete-coverage',readingCount:3,
    latestReading:{valueKwh:110,sourceTime:now,receivedAt:now+1000},
    previousReading:{valueKwh:105,sourceTime:now-3600000,receivedAt:now-3599000},
    coverage:{start:now-3600000,end:now,coveredMs:1800000,durationMs:3600000,conflictingMs:0},comparison:null,
    lastSuccessfulComparison:{start:now-7200000,end:now-3600000,estimatedKwh:4.5,meteredKwh:5,
      differenceKwh:-.5,differencePercent:-10,edgeEstimated:false,includesOpenInterval:false,basis:'recorded-energy'}};
  gapRows[1].summary={basis:'electricity-meter',recordedSessions:14,comparedSessions:2,excludedSessions:12,
    exclusionReasons:{'incomplete-coverage':12,'zero-reference':6},estimatedKwh:.24002,referenceKwh:.25,
    differenceKwh:-.00998,differencePercent:-3.992,start:now-7200000,end:now-3600000,lastSessionEnd:now};
  gapRows[2].summary={basis:'electricity-meter',recordedSessions:0,comparedSessions:0,excludedSessions:0,
    exclusionReasons:{},estimatedKwh:0,referenceKwh:0,differenceKwh:null,differencePercent:null,
    start:null,end:null,lastSessionEnd:null};
  await refreshEnergyChecks(gapRows);
  assert.match(await checkText(propertyCheck),/10\.0% lower/,'An incomplete latest period retains the last successful result');
  assert.match(await checkText(propertyCheck),/Last successful comparison:/);
  assert.equal(await checkText(propertyCheck+' .energy-check-notice'),'Latest reading: Recording does not cover the whole meter period.');
  assert.match(await checkText(propertyCheck),/Recording covers 30 min of 1 h/,'Property diagnostics identify the missing coverage');
  assert.equal(await checkText(charger1Check+' .energy-check-result'),'Recorded energy is 4.0% lower than the meter');
  assert.match(await checkText(charger1Check),/0\.25(?:0)? kWh/,'Tiny comparison samples disclose the metered total');
  assert.match(await checkText(charger1Check),/Based on 2 of 14 completed sessions/);
  assert.match(await checkText(charger1Check),/Incomplete recording: 12 sessions/);
  assert.match(await checkText(charger1Check),/Meter reference is zero: 6 sessions/);
  assert.match(await checkText(charger1Check),/Reason counts can overlap/,'Overlapping reasons cannot be mistaken for additional excluded sessions');
  assert.equal(await checkText(charger2Check+' .energy-check-result'),'No completed sessions recorded');
  assert(!/0 compared|0 excluded|0 recorded sessions/.test(await checkText(charger2Check)),
    'An empty charger uses a useful empty state instead of zero-valued statistics');
  const methodCheck='#energy-audit-content details[data-check-key="method"]';
  assert.equal(await checkText(methodCheck+' > summary'),'How comparisons work');
  assert.match(await checkText(methodCheck),/do not change recorded history, calibrate estimates, train the house model or adjust recording thresholds/);
  await evaluate("document.querySelectorAll('#energy-audit-content .energy-check-details').forEach(node=>node.open=true); true");
  for(const theme of ['dark','light']) for(const width of [390,1440]) {
    if(await evaluate('document.documentElement.dataset.theme')!==theme)
      await evaluate("document.getElementById('theme-toggle').click(); true");
    await command('browsingContext.setViewport',{context,viewport:{width,height:width===390?844:1100},devicePixelRatio:1});
    await evaluate("document.getElementById('energy-audit-details').scrollIntoView({block:'start'}); true");
    await checkEnergyLayout(`expanded ${theme}/${width}`);
    const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
    writeFileSync(`var/home-energy-checks-details-${theme}-${width}.png`,Buffer.from(shot.data,'base64'));
  }
  await refreshEnergyChecks(await evaluate('window.energyCheckFixture.original'));
  await evaluate("window.fetch=window.energyCheckFixture.fetch; Date.now=window.energyCheckFixture.now; delete window.energyCheckFixture; document.querySelectorAll('#energy-audit-content .energy-check-details').forEach(node=>node.open=false); true");
  if(await evaluate('document.documentElement.dataset.theme')!=='dark') await evaluate("document.getElementById('theme-toggle').click(); true");
  await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  await evaluate("document.getElementById('recording-details').scrollIntoView(); true");
  mkdirSync('var',{recursive:true});
  const recordingShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
  writeFileSync('var/home-energy-recording.png',Buffer.from(recordingShot.data,'base64'));
  for(const theme of ['dark','light']) for(const width of [390,1440]) {
    if(await evaluate('document.documentElement.dataset.theme')!==theme) await evaluate("document.getElementById('theme-toggle').click(); true");
    await command('browsingContext.setViewport',{context,viewport:{width,height:width===390?844:1100},devicePixelRatio:1});
    await evaluate("document.getElementById('recording-adaptive-details').scrollIntoView({block:'start'}); true");
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`${theme}/${width}: page stays within viewport`);
    assert.equal(await evaluate("document.querySelector('.recording-measurements').scrollWidth<=document.querySelector('.recording-measurements').clientWidth+1"),true,
      `${theme}/${width}: adaptive rows fit without sideways scrolling`);
    const screenshot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
    writeFileSync(`var/recording-${theme}-${width}.png`,Buffer.from(screenshot.data,'base64'));
  }
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  await evaluate("document.getElementById('recording-details').open=false; window.scrollTo(0,0); true");

  if (!recordingOnly) {
  assert.equal(await evaluate("document.body.textContent.includes('A comfortable home')"), false);
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  const legendState = text => evaluate(`Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))?.getAttribute('aria-pressed')`);
  const checkSeriesDrawn = async (keys, left) => {
    await evaluate(`${JSON.stringify(keys)}.forEach(key => {const button = document.querySelector('[data-chart-key=\"'+key+'\"]'); if(button?.getAttribute('aria-pressed')==='false')button.click();}); true`);
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.left === ${JSON.stringify(left)}
      && ${JSON.stringify(keys)}.every(key =>
        document.querySelector('[data-chart-key="' + key + '"]')?.getAttribute('aria-pressed') === 'true')`);
    for (const key of keys) {
      if (await evaluate(`document.querySelector('[data-chart-key=\"${key}\"]').dataset.axis === 'activity'`)) {
        assert.equal(await evaluate(`document.querySelector('[data-activity-key=\"${key}\"] .mode-track').children.length > 0`), true, `${key} has visible lower-row intervals`);
        continue;
      }
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
  const checkPowerDrawn = async () => {
    await checkSeriesDrawn(['property_power', 'charger_power', 'charger2_power'], 'power');
    const palette=JSON.parse(await evaluate(`JSON.stringify((()=>{const styles=getComputedStyle(document.documentElement);
      return {property:styles.getPropertyValue('--chart-property').trim(),charger1:styles.getPropertyValue('--chart-ev').trim(),
        charger2:styles.getPropertyValue('--chart-ev2').trim(),theme:document.documentElement.dataset.theme};})())`));
    assert.notEqual(palette.charger1,palette.property,'Charger 1 has a distinct semantic color from property demand');
    assert.notEqual(palette.charger2,palette.charger1,'The two chargers remain distinguishable');
  };
  await checkPowerDrawn();
  await checkChartPopupBrowser({ evaluate, command, context, until });
  if (!chartOnly) await checkEquipmentBrowser({ evaluate, command, context, until });
  await checkChartZoomBrowser({ evaluate, command, context, until });
  assert.match(await evaluate("document.getElementById('chart-notes').textContent"),/two chargers.*Auxiliary.*separate lines/);
  await evaluate("document.querySelector('[data-chart-key=auxiliary_power]').click(); document.querySelector('[data-chart-key=charger_power]').click(); true");
  await checkSeriesDrawn(['charger2_power'],'power');
  await evaluate("document.querySelector('[data-chart-key=auxiliary_power]').click(); document.querySelector('[data-chart-key=charger_power]').click(); true");
  // Exercise an actual response with both lower loads absent, independently of
  // legend hiding. The fixture remains in browser memory and touches no history.
  await evaluate(`(() => {
    window.onlyCharger2Fixture={fetch:window.fetch.bind(window),requests:0};
    window.fetch=async (...args)=>{
      const response=await window.onlyCharger2Fixture.fetch(...args);
      if(!String(args[0]).includes('/api/chart?'))return response;
      const payload=await response.json();
      payload.series.auxiliary_power=[];payload.series.charger_power=[];
      delete payload.meta?.lastReadings?.auxiliary_power;delete payload.meta?.lastReadings?.charger_power;
      window.onlyCharger2Fixture.requests++;
      return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
    };
    document.getElementById('date-end').value='2026-09-08';
    document.getElementById('date-end').dispatchEvent(new Event('change'));
    return true;
  })()`);
  await until("window.onlyCharger2Fixture.requests>0 && document.getElementById('history').dataset.ready==='true' && document.getElementById('history').dataset.rangeEnd==='2026-09-08'");
  await checkSeriesDrawn(['charger2_power'],'power');
  await evaluate("window.fetch=window.onlyCharger2Fixture.fetch; document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready==='true' && document.getElementById('history').dataset.rangeEnd==='2026-09-07'");
  assert.equal(await legendState('all-in'), 'true');
  assert.equal(await legendState('spot'), 'true');
  assert.equal(await legendState('Hot-water circulation request'), 'true');
  assert.equal(await legendState('fireplace'), 'true');
  await checkActivityTracks();
  for (const key of ['dhwr', 'fireplace']) {
    assert.equal(await evaluate(`(async () => {
      const canvas = document.getElementById('history'), ctx = canvas.getContext('2d');
      const before = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      document.querySelector('[data-chart-key="${key}"]').click();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const after = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hidden = document.getElementById('${key}-history').hidden;
      document.querySelector('[data-chart-key="${key}"]').click();
      return hidden && before.every((value, i) => value === after[i]);
    })()`), true, `${key} toggles its strip without changing plot shading`);
  }
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await checkPowerDrawn();
  assert.equal(await evaluate("localStorage.getItem('home-energy-theme')"), 'light', 'The last selected theme is saved');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('chart-legend')?.querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light', 'Reload restores the last light theme');
  assert.equal(await evaluate("document.getElementById('theme-toggle').getAttribute('aria-label')"), 'Switch to dark theme');
  await checkPowerDrawn();
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate("localStorage.getItem('home-energy-theme')"), 'dark');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('chart-legend')?.querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'Reload restores the last dark theme');
  assert.equal(await evaluate("document.getElementById('theme-toggle').getAttribute('aria-label')"), 'Switch to light theme');
  const checkRange = async (start, end = start) => {
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.rangeStart === ${JSON.stringify(start)}
      && document.getElementById('history').dataset.rangeEnd === ${JSON.stringify(end)}`);
  };
  await checkRange('2026-09-07');
  await evaluate(`(() => {
    window.dateFixture = { fetch: window.fetch.bind(window), requests: 0 };
    window.fetch = (...args) => {
      if (String(args[0]).includes('/api/chart?')) window.dateFixture.requests++;
      return window.dateFixture.fetch(...args);
    };
    return true;
  })()`);
  // Both native pickers apply immediately; changing the start preserves a valid end.
  await evaluate("document.getElementById('date-start').value='2024-09-07'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await checkRange('2024-09-07', '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  await evaluate("document.getElementById('date-end').value='2024-09-09'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  await checkRange('2024-09-07', '2024-09-09');
  await evaluate("document.getElementById('date-start').value='2024-09-06'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await checkRange('2024-09-06', '2024-09-09');
  const beforeInvalid = await evaluate('window.dateFixture.requests');
  await evaluate("document.getElementById('date-end').value='2024-09-05'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  assert.equal(await evaluate("document.getElementById('chart-range-form').checkValidity()"), false);
  assert.equal(await evaluate('window.dateFixture.requests'), beforeInvalid);
  await checkRange('2024-09-06', '2024-09-09');
  await evaluate("document.getElementById('date-start').value='2024-09-12'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await checkRange('2024-09-12');
  await evaluate("document.getElementById('date-end').value='2024-09-21'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  await checkRange('2024-09-12', '2024-09-21');
  await evaluate("document.getElementById('range-back').click(); true");
  await checkRange('2024-09-11', '2024-09-20');
  await evaluate("document.getElementById('range-forward').click(); true");
  await checkRange('2024-09-12', '2024-09-21');
  // Day stepping uses calendar dates through month/year, leap-day and DST boundaries,
  // including when the browser's own zone differs from the household zone.
  for (const [start, previous] of [
    ['2025-01-01', '2024-12-31'], ['2024-03-01', '2024-02-29'],
    ['2026-03-30', '2026-03-29'], ['2026-10-26', '2026-10-25'],
  ]) {
    await evaluate(`document.getElementById('date-start').value=${JSON.stringify(start)}; document.getElementById('date-start').dispatchEvent(new Event('change')); true`);
    await evaluate(`document.getElementById('date-end').value=${JSON.stringify(start)}; document.getElementById('date-end').dispatchEvent(new Event('change')); true`);
    await checkRange(start);
    await evaluate("document.getElementById('range-back').click(); true");
    await checkRange(previous);
    await evaluate("document.getElementById('range-forward').click(); true");
    await checkRange(start);
  }
  await evaluate("window.fetch=window.dateFixture.fetch; true");
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  await evaluate("Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes('spot')).click(); true");
  for (const [left, expected, absent] of [['phases', 'property_current_l1', 'property_power'], ['integral', 'heating_integral', 'charger_power'],
    ['heat_pump_power','heat_pump_power','property_power'],
    ...['learning_profit', 'learning_aux_profit', 'learning_recovery_error', 'learning_indoor_temperature'].map(name => [name, name, 'property_power']),
    ...coefficientKeys.map(name => [name, name, 'property_power']),
    ...['ev1_session_energy_check','shelly_session_energy_check'].map(name=>[name,name,'property_power']),
    ['solar_radiation', 'solar_radiation', 'property_power'], ['power', 'property_power', 'heating_integral']]) {
    const began = performance.now();
    await selectChartSubject(left);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)} && !!document.querySelector('[data-chart-key="${expected}"]') && !document.querySelector('[data-chart-key="${absent}"]')`);
    assert.equal(await legendState('spot'), 'false', 'Explicitly hidden shared legend preference survives axis changes');
    if(left==='phases')assert.equal(await evaluate("Boolean(document.querySelector('[data-chart-key=charger2_power]'))"),false,'Phase loading retains ampere units rather than total power');
    if(['ev1_session_energy_check','shelly_session_energy_check'].includes(left)) {
      assert.equal(await evaluate(`document.querySelector('[data-chart-key="${left}"]').textContent.includes(${JSON.stringify(left==='ev1_session_energy_check'?'Charger 1':'Charger 2')})`),true);
      assert.match(await evaluate("document.getElementById('chart-view-description').textContent"),/[Ss]ession/);
      const sessionPlot=await fetch(`${base}/api/chart?start=2026-09-07&end=2026-09-07&left=${left}`).then(response=>response.json());
      assert.equal(sessionPlot.series[left].length,2,'one chart point per finalized session');
      await checkSeriesDrawn([left],left);
    }
    if(left==='heat_pump_power')assert.match(await evaluate("document.getElementById('chart-view-description').textContent"),/reconstruct|estimate|recorded/i);
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
      assert.match(await evaluate("document.getElementById('chart-notes').textContent"), /Coefficients replay.*supported journal/);
      await checkSeriesDrawn([left], left);
    }
    if (left === 'power') await checkPowerDrawn();
    timings.push({ action: left, elapsedMs: Math.round(performance.now() - began) });
  }
  // Rapid changes must settle on the last request even if previous requests finish late.
  await evaluate("document.getElementById('range-yesterday').click(); document.getElementById('range-tomorrow').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  await evaluate("document.getElementById('date-start').value='2026-09-08'; document.getElementById('date-end').value='2026-09-08'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-08' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  const tomorrow = await fetch(`${base}/api/chart?start=2026-09-08&end=2026-09-08`).then(r => r.json());
  assert.ok(tomorrow.series.outdoor_forecast.length > 0);
  assert.ok(tomorrow.series.all_in_price.length > 0);
  assert.equal(tomorrow.series.property_power.some(p => p.y !== null), false);
  for (const series of Object.values(tomorrow.series)) assert.ok(series.every(p => p.x >= tomorrow.range.from && p.x <= tomorrow.range.to));
  await evaluate("document.getElementById('range-yesterday').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-06' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  const populated = await fetch(`${base}/api/chart?start=2026-09-06&end=2026-09-07`).then(r => r.json());
  for (const key of ['heatOff', 'compressorHome', 'dhwr', 'fireplace']) assert.ok(populated.shading[key].length > 0, `Synthetic ${key} activity is available`);
  assert.deepEqual(populated.shading.fireplace, [{ start: now - 3 * 3600000, end: now }], 'Overlapping additions use the model burn window');
  await checkActivityTracks();
  assert.equal(await evaluate("document.querySelectorAll('#fireplace-history .mode-segment').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#dhwr-history .mode-segment').length > 0"), true);
  await checkSeriesDrawn(['auxiliary_power', 'charger_power', 'compressorHome'], 'power');
  assert.ok(populated.operatingModes.length > 0);
  assert.ok(populated.series.auxiliary_power.some(point => point.y > 0));
  if (!chartOnly) {
  assert.equal(await evaluate("document.getElementById('learning-details').open"), false);
  assert.equal(await evaluate("document.getElementById('learning-panel-details').open"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('#learning-metrics > details[data-learning-key]')].map(row => row.dataset.learningKey).join(',')"),
    'profit,auxProfit,recoveryError,indoorTemperature');
  assert.equal(await evaluate("document.getElementById('h66-test-submit').disabled"), true);
  mkdirSync('var', { recursive: true });
  const capture = async name => {
    const shot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    writeFileSync(`var/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  const checkEquipment = async () => {
    await evaluate("document.querySelector('#home-equipment-details > summary').focus(); true");
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'equipment-keyboard', actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    assert.equal(await evaluate("document.getElementById('home-equipment-details').open"), true, 'Equipment opens by keyboard');
    const parents = { 'home-pump-device': 'home-equipment-details', 'h66-readings-details': 'home-pump-device',
      'h66-test-details': 'home-pump-device' };
    assert.equal(await evaluate(`Object.entries(${JSON.stringify(parents)}).every(([id,parent]) => {
      const fold = document.getElementById(id);
      return !fold.open && fold.parentElement.closest('details').id === parent;
    })`), true, 'Equipment keeps grouped readings and manual controls in sibling disclosures');
    assert.equal(await evaluate("['home-pump-device'].every(id=>document.querySelector('#'+id+' > summary').checkVisibility())"), true);
    assert.equal(await evaluate("['h66-readings-details','h66-test-details'].every(id=>!document.querySelector('#'+id+' > summary').checkVisibility())"), true, 'Readings and adjustments stay behind their parent disclosure');
    for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
      await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
      await evaluate("document.getElementById('home-equipment-details').scrollIntoView({block:'start'}); true");
      await capture(`home-energy-equipment-${viewport.width}`);
      for (const id of ['home-pump-device', 'h66-readings-details']) {
        await evaluate(`(() => {const fold=document.getElementById('${id}');for(let parent=fold.parentElement.closest('details');parent;parent=parent.parentElement.closest('details'))parent.open=true;fold.querySelector(':scope > summary').click();fold.scrollIntoView({block:'start'});return true;})()`);
        assert.equal(await evaluate(`document.getElementById('${id}').open`), true);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Expanded equipment content fits the viewport');
        await capture(`home-energy-${id}-${viewport.width}`);
        await evaluate(`document.querySelector('#${id} > summary').click(); true`);
      }
      await evaluate("document.querySelectorAll('#home-equipment-details details').forEach(fold=>fold.open=false);document.getElementById('theme-toggle').click(); true");
    }
    await evaluate("document.getElementById('home-equipment-details').open = false; true");
    await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  };
  await evaluate("document.querySelector('.history-panel').scrollIntoView(); true");
  await capture('home-energy-activity-dark');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await checkActivityTracks();
  await capture('home-energy-activity-light');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate("document.querySelectorAll('.controller-column > article').length"), 3);
  assert.equal(await evaluate("[...document.querySelectorAll('.controller-panels details')].every(fold => !fold.open)"), true);
  await evaluate("document.querySelector('.controller-panels').scrollIntoView({block:'start'}); true");
  await capture('home-energy-dashboard-closed-desktop');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await capture('home-energy-dashboard-closed-light');
  await evaluate("document.getElementById('theme-toggle').click(); document.getElementById('home-heat-pump-details').open=true; document.querySelector('#learning-panel-details > summary').focus(); true");
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
    await checkActivityTracks();
    await checkDateAlignment();
    await checkRangeSteps();
    await evaluate("true");
    await checkDateAlignment();
    await evaluate("true");
    await capture(`home-energy-dark-${viewport.width}`);
    await evaluate("document.getElementById('fireplace-shortcut').click(); true");
    assert.equal(await evaluate("document.getElementById('fireplace-dialog').matches(':modal') && document.getElementById('fireplace-form').checkVisibility()"), true,
      'Home shortcut opens the fireplace window');
    assert.equal(await evaluate("document.getElementById('fireplace-dialog').scrollWidth <= document.getElementById('fireplace-dialog').clientWidth && document.documentElement.scrollWidth <= innerWidth"), true,
      'Fireplace window fits the mobile viewport without horizontal overflow');
    await capture(`home-energy-fireplace-${viewport.width}`);
    await evaluate("document.getElementById('fireplace-close').click(); true");
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
  assert.equal(await evaluate("document.getElementById('h66-readings-details').open"), false);
  assert.equal(await evaluate("document.getElementById('home-equipment-details').open"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
  assert.equal(await evaluate("document.getElementById('home-control').contains(document.getElementById('temporary-details')) && document.getElementById('providers-controls').contains(document.getElementById('electricity-details'))"), true);
  await evaluate(`document.getElementById('home-heat-pump-details').open = true; document.getElementById('temporary-details').open = true;
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
  await evaluate(`document.getElementById('home-heat-pump-details').open = true; document.getElementById('temporary-details').open = true;
    window.__statusPolls = 0; const originalFetch = window.fetch;
    window.fetch = (...args) => { if (new URL(args[0], location.href).pathname === '/api/status') window.__statusPolls++; return originalFetch(...args); };
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
    await evaluate("document.getElementById('home-heat-pump-details').open=true; document.querySelector('#temporary-details > summary').click(); true");
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
  const connectTestBroker = (_address, options = {}) => {
    // Identity and vehicle acquisition use separate startup connections; these
    // connection/publish assertions describe only manual heating commands.
    const identity = String(options.clientId ?? '').startsWith('stmq-identity-');
    const manual = !identity && options.reconnectPeriod === 0;
    if (manual) testConnections++;
    const client = new EventEmitter();
    client.subscribe = (_topic, _options, callback) => callback?.();
    client.publish = (topic, payload, options, callback) => {
      const tariff = topic === 'synthetic/tariff/set';
      if (!manual && !tariff) { callback?.(); return; }
      testPublishes.push({ topic, payload, options });
      acknowledgeHeating = error => {
        callback?.(error);
        if (tariff && !error) queueMicrotask(() => client.emit('message', 'synthetic/tariff/status', Buffer.from(payload), {}));
      };
    };
    client.end = (force, options, callback) => callback?.();
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
  app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'provider-fixture.sqlite'),
    priceSettings: { ...config.priceSettings, effectiveDate: '2026-09-07' },
    connections: { ...fixture.connections, mqtt: { address: 'mqtt://fixture.invalid' },
      equipment: equipmentConfiguration({ devices: [{ id: 'heat_savings', kind: 'switch',
        connection: 'mqtt:synthetic/tariff/status', tariff_control: true,
        mqtt: { command_topic: 'synthetic/tariff/set', on_payload: 'ON', off_payload: 'OFF' } }] }) } },
    clock: () => now, providerOptions: fixture.providerOptions, mqttOptions: { connect: connectTestBroker } });
  // Supply capture health independently of the manual-command broker fixture.
  // No MQTT connection, household identifiers or raw TeslaMate fields are used.
  let charger2Status = { source: 'shelly-evse', enabled: true, status: 'ok', reason: 'physical-meter',
    connected: true, recording: true, maxAgeMs: 300000,
    readings: Object.fromEntries([
      ...[1,2,3].flatMap(phase => [[`ev2_current_l${phase}`,10,'A'],[`ev2_voltage_l${phase}`,230,'V'],[`ev2_active_power_l${phase}`,2.3,'kW']]),
      ['ev2_active_power',6.9,'kW'],['ev2_import_energy_counter',123.4,'kWh'],['ev2_session_energy',4.2,'kWh'],
    ].map(([signal,value,unit]) => [signal,{value,unit,sourceTime:now,receivedAt:now,available:true,quality:[]}])) };
  const realProviderStatus = app.engine.providerStatus.bind(app.engine);
  app.engine.providerStatus = () => ({ ...realProviderStatus(), 'shelly-evse': { ...charger2Status } });
  seedChargingFixture(app.store,'shelly-evse');
  for(const [prefix,power] of [['property',6.9],['ev1',2.07]]) {
    app.engine.ingestEnergy({source:'easee',device:`synthetic-${prefix}`,prefix,start:now-5*60_000,end:now,
      energies:[power/36,power/36,power/36],powers:[power/3,power/3,power/3],quality:['estimated'],receivedAt:now});
  }
  // Invented recorded energy predates the only known contract period. Original
  // quarter-hour energy and spot prices suffice; no HP power is invented.
  seedTimingBrowserFixture(app.store);
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
  await until("document.querySelector('#outdoor .status-detail-trigger')");
  await evaluate("document.querySelector('#outdoor .status-detail-trigger').click(); true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /FMI nearby station/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true'");
  await checkEquipment();
  const providerChart = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?start=2026-09-07&end=2026-09-07&left=power`).then(response => response.json());
  for (const [key, expected] of [['property_power', 6.9], ['charger_power', 2.07]]) {
    assert.ok(providerChart.series[key].some(point => Number.isFinite(point.y) && Math.abs(point.y - expected) < 1e-9),
      `${key} contains the expected total from all three provider phase currents`);
  }
  assert(providerChart.series.charger2_power.some(point=>point.y===6),'Physical Shelly scalar intervals project to total charger power');
  await checkPowerDrawn();
  await checkTimingBrowser({ command, evaluate, until, capture, context });
  for (const left of ['phases', 'integral', 'power']) {
    await selectChartSubject(left);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)}`);
  }
  await checkPowerDrawn();
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Using backup')"), true);
  assert.equal(await evaluate("document.querySelector('[data-provider=market] .provider-heading > strong').textContent"), 'Electricity prices');
  assert.equal(await evaluate("document.querySelector('[data-provider=market] .provider-category-meta').textContent.includes('Elering')"), true);
  await evaluate("document.querySelector('#provider-overview [data-source-key=market] .status-detail-trigger').click();true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Next ENTSO-E try/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] .provider-heading > strong').textContent"), 'Main temperatures & Weather');
  assert.equal(await evaluate("[...document.querySelectorAll('[data-provider=main-temperatures] [data-source-section=temperatures] .provider-series > li > strong')].map(row => row.textContent).join(',')"),
    'Upstairs,Downstairs,Bedroom,Garage rear temperature,Garage front temperature,Outdoor temperature');
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-heading > strong').textContent"),
    'Electricity consumption');
  assert.equal(await evaluate("document.querySelectorAll('#providers > [data-provider=easee], #providers > [data-provider=shelly-evse]').length"), 0,
    'Both electricity acquisitions appear in one connection card');
  const electricitySeries = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll(
    '[data-provider=electricity] .provider-series > li > strong')].map(row => row.textContent))`));
  assert.deepEqual(electricitySeries.filter(label => label.startsWith('Charger 2')), [
    'Charger 2 phase currents L1–L3', 'Charger 2 phase voltages L1–L3', 'Charger 2 phase active power L1–L3',
    'Charger 2 active power', 'Charger 2 meter counter', 'Charger 2 total energy', 'Charger 2 session energy', 'Charger 2 session check',
  ], 'Charger 2 exposes supported native phase readings separately from total and session energy');
  assert.equal(electricitySeries.includes('Charger 2 phase energy L1–L3'), false, 'Native total energy is never represented as measured phase energy');
  for (const label of ['Property phase energy L1–L3', 'Charger 1 phase energy L1–L3'])
    assert.ok(electricitySeries.includes(label), `${label} remains in the combined catalogue`);
  const electricityOverview = () => evaluate(`JSON.stringify((() => {
    const row = document.querySelector('#provider-overview #providers > .source-overview[data-source-key=electricity]');
    return row ? { title: row.querySelector('.provider-category-title').textContent, source: row.querySelector('.provider-category-meta').textContent,
      state: row.querySelector('.provider-category-state').textContent, attention: row.dataset.state === 'attention' } : null;
  })())`);
  const checkProviderColors = async needsAttention => {
    const result = JSON.parse(await evaluate(`JSON.stringify((() => {
      const row = document.querySelector('#provider-overview #providers > .source-overview[data-source-key=electricity]');
      const names = [...row.querySelectorAll('.provider-name')].map(node => ({
        name: node.textContent, state: node.dataset.state, color: getComputedStyle(node).color,
        accessible: node.getAttribute('aria-label'),
      }));
      const bullets = [...document.querySelectorAll('[data-provider=electricity] .provider-series > li')].map(node => ({
        label: node.querySelector('strong').textContent, series: node.dataset.series, state: node.dataset.state,
        color: getComputedStyle(node.querySelector('.provider-series-value'), '::before').backgroundColor, accessible: node.getAttribute('aria-label'),
      }));
      return {names, bullets};
    })())`));
    const [easee, shelly] = result.names;
    assert.equal(easee.state, 'available');
    assert.equal(shelly.state, needsAttention ? 'attention' : 'available');
    assert.equal(easee.color === shelly.color, !needsAttention, 'Provider names follow their individual availability');
    for (const bullet of result.bullets) {
      const provider = bullet.label.startsWith('Charger 2') ? shelly : easee;
      const nativeFresh = bullet.series.startsWith('ev2_') && bullet.series !== 'ev2_energy';
      assert.equal(bullet.color, nativeFresh ? easee.color : provider.color,
        `${bullet.label}: color follows fresh measurement availability or provider-dependent capture status`);
      assert.equal(bullet.state, nativeFresh ? 'available' : provider.state,
        'Fresh native readings remain available independently of charging-control commissioning');
      assert(bullet.accessible, 'Status is available without relying on color');
    }
  };
  assert.deepEqual(JSON.parse(await electricityOverview()), { title: 'Electricity consumption',
    source: 'Easee, Shelly EVSE', state: 'Available', attention: false });
  assert.equal(await evaluate("document.getElementById('providers').parentElement.id"), 'provider-overview');
  await evaluate(`document.getElementById('connections-details').open = false;
    document.querySelector('[data-provider=electricity] summary').focus(); true`);
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] summary').checkVisibility()"), true, 'Source categories remain accessible with configuration closed');
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'electricity-keyboard',
    actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] details').open"), true,
    'The combined electricity connection opens with the keyboard');
  await checkProviderColors(false);
  charger2Status = { ...charger2Status, status: 'degraded', reason: 'commissioning-required' };
  await evaluate("window.dispatchEvent(new Event('online')); true");
  await until("document.querySelector('[data-provider=electricity] .provider-category-state').textContent === 'Needs attention'");
  assert.deepEqual(JSON.parse(await electricityOverview()), { title: 'Electricity consumption',
    source: 'Easee, Shelly EVSE', state: 'Needs attention', attention: true }, 'Charger 2 commissioning needs reach the closed source overview');
  await checkProviderColors(true);
  await evaluate("document.querySelector('[data-provider=electricity] .provider-health .status-detail-trigger').click();true");
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"),
    /Physical Charger 2 requires verified model, firmware/i, 'The commissioning requirement identifies Charger 2');
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] details').open"), true,
    'Updating capture health preserves the expanded connection');
  charger2Status = { ...charger2Status, status: 'ok', reason: 'physical-meter' };
  await evaluate("window.dispatchEvent(new Event('online')); true");
  await until("document.querySelector('[data-provider=electricity] .provider-category-state').textContent === 'Available'");
  assert.equal(await evaluate("document.querySelector('#providers > :last-child').dataset.provider"), 'main-temperatures', 'Temperature and weather feeds form the final category');
  assert.equal(await evaluate("document.querySelector('#provider-overview #providers > :last-child .provider-category-title').textContent"), 'Main temperatures & Weather', 'The combined temperature and weather category is last in the source overview');
  assert.equal(await evaluate("document.getElementById('weather-status').textContent.includes('FMI')"), true);
  assert.equal(testConnections, 0, 'Configured manual tests do not connect during startup or polling');
  assert.equal(await evaluate("document.getElementById('home-equipment-details').open"), false);
  await evaluate(`document.getElementById('home-equipment-details').open = true;
    document.getElementById('home-heat-pump-details').open = true; document.getElementById('temporary-details').open = true;
    document.getElementById('away-until').value = '2026-09-10T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input')); true`);
  for (const command of ['reduction', 'normal', 'circulation']) {
    acknowledgeHeating = null;
    await evaluate(`document.getElementById('test-${command}').click(); document.getElementById('test-${command}').click(); true`);
    await until("document.getElementById('heating-test-buttons').getAttribute('aria-busy') === 'true'");
    for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof acknowledgeHeating, 'function');
    assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
    assert.equal(await evaluate(`document.getElementById('${command === 'circulation' ? 'dhwr-message' : 'heating-test-message'}').textContent.includes('sent at')`), false);
    acknowledgeHeating();
    const commandLabel = { reduction: 'Reduced heating', normal: 'Normal heating', circulation: 'Circulation' }[command];
    await until(`document.getElementById('${command === 'circulation' ? 'dhwr-message' : 'heating-test-message'}').textContent.includes('${commandLabel} sent at') && !document.getElementById('test-${command}').disabled`);
    assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00');
  }
  assert.deepEqual(testPublishes, [
    ...['ON', 'OFF'].map(payload => ({ topic: 'synthetic/tariff/set', payload, options: { qos: 1, retain: false } })),
    { topic: 'stmq/home/dhwr/command/switch', payload: 'ON', options: { qos: 1, retain: false } },
  ]);
  const requestedHeating = app.engine.status().observations.actual;
  assert.equal(requestedHeating.mode, 'normal');
  assert.equal(requestedHeating.source, 'equipment-state-readback');
  assert.equal(requestedHeating.verified, true, 'A matching device report confirms the direct relay command');
  assert.match(await evaluate("document.getElementById('tariff-control-state').textContent"), /Normal heating · confirmed/);
  acknowledgeHeating = null;
  // Normal heat is allowed during the preceding DHWR pulse; reduction would
  // correctly fail before publishing and never exercise broker-error handling.
  await evaluate("document.getElementById('test-normal').click(); true");
  for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof acknowledgeHeating, 'function');
  acknowledgeHeating(new Error('synthetic-private-broker-error'));
  await until("document.getElementById('heating-test-message').classList.contains('form-error') && !document.getElementById('test-normal').disabled");
  assert.equal(await evaluate("document.body.textContent.includes('synthetic-private-broker-error')"), false);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-desktop');
  await evaluate("document.getElementById('home-pump-device').open = true; document.getElementById('h66-readings-details').open = true; document.getElementById('connections-details').open = true; document.querySelectorAll('#providers .provider-fold').forEach(fold => fold.open = true); document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-desktop');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-mobile');
  await evaluate("document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-mobile');
  }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(chartOnly ? { result: 'chart-only-browser-smoke-passed', browserTimeZone, timings,
    checked: ['named-views-and-series-explorer', 'recording-inventory', 'power-visible-pixels', 'fullscreen-and-zoom',
      'pointer-gestures-and-keyboard', 'date-and-view-request-races', 'tooltips', 'charger-fills', 'coefficient-replay', 'activity-rows'] }
    : recordingOnly?{result:'recording-browser-smoke-passed',browserTimeZone,
    checked:['actual-adaptive-streams-only','opaque-duplicate-stream-identities','unit-distinction','all-four-floor-outputs',
      'every-change-circulation-feedback','observed-defrost','abnormal-feed-events','event-type-breakdown','saved-history-without-checkpoint','durable-open-energy','lazy-read-only-inventory',
      'counts-and-dates','persistent-charging-choices-and-separate-session-edits','keyboard-and-refresh-preservation','energy-check-device-rows','energy-check-focus-and-expansion-preservation','property-reading-gap-and-retained-result','tiny-session-sample-and-no-sessions','dark-and-light','390-and-1440-layouts','physical-table-accounting']}:{ result: 'chart-browser-smoke-passed', browserTimeZone, timings,
    electricityConnections: ['combined-source-overview-and-connection', 'charger2-native-phase-readings-and-total-energy',
      'source-scoped-charger2-errors', 'keyboard-expansion', 'refresh-preserves-expansion'],
    chargingChecks:['charger2-visible-power-dark-and-light','charger2-visible-with-lower-loads-hidden-or-absent','charger2-no-invented-phases','exactly-two-charger-session-axes','property-reading-status-and-retained-comparison','charger-session-totals-and-sample-size','session-counts-exclusions-and-energy-weighting'],
    checked: ['electricity-first-without-right-axis-duplicates', 'four-coefficients-from-read-only-replay', 'coefficient-visible-pixels-and-status', 'last-theme-restored-on-reload', 'theme-toggle', 'Finnish-today', 'single-old-day', 'immediate-end-date', 'immediate-date-range', 'one-day-window-stepping', 'rapid-range-stepping', 'calendar-boundary-stepping', 'compact-responsive-arrow-buttons', 'range-validation', 'shortcut-order-and-state', 'axis-and-legend-selection', 'property-and-charger-visible-pixels', 'asynchronous-provider-phase-power', 'historical-charger-assumed-rates', 'timing-evidence-shares-and-dates', 'heating-model-and-timing-selector-keyboard-touch', 'heating-saving-selection-refresh-reload-persistence', 'heating-model-positive-zero-negative-and-unavailable', 'timing-reconstructed-and-unavailable', 'timing-consistent-elapsed-time-coverage-and-standby-exclusion', 'timing-equal-closed-card-heights-and-independent-expansion', 'timing-stable-heading-and-fold-positions', 'timing-nested-fold-keyboard-touch-and-refresh', 'timing-dark-light-responsive-inline-explanations', 'grouped-history-catalogue', 'recording-frequencies', 'recording-inventory-lazy-fetch', 'recording-inventory-keyboard-mobile', 'recording-inventory-refresh-and-error-preservation', 'physical-storage-accounting', 'reconstructed-heat-pump-note', 'audit-only-diagnostics', 'price-defaults', 'date-races', 'tomorrow-only', 'desktop-mobile', 'Finnish-away-and-pause', 'independent-cancellation', 'draft-poll-preservation', 'DST-atomic-rejection', 'read-only-rates', 'home-model-settings-with-folded-equipment', 'equipment-grouped-readings-and-manual-controls', 'status-detail-escape-outside-dismissal-and-focus', 'status-detail-poll-preservation', 'status-detail-bounded-mobile-and-landscape', 'dynamic-equipment-rows-and-inline-controls', 'nested-learning-keyboard', 'closed-away-and-pause-deadlines', 'provider-sources-and-fallbacks', 'collapsed-MQTT-tests', 'MQTT-publish-acknowledgement-and-failure', 'MQTT-draft-preservation'] }, null, 2));
  }
  await command('browser.close', {}); ownsBrowser=false;
} finally {
  if(ownsBrowser) { try {await command('browser.close',{});}catch{} }
  ws?.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
