// Production recording markup, tables and styles in a disposable browser,
// with synthetic data only. No application or household connections are made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'stmq-health-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-health-screenshots-'));
const dashboard = readFileSync(new URL('../../chart/index.html', import.meta.url), 'utf8');
const headerStart = dashboard.indexOf('  <header>');
const mainStart = dashboard.indexOf('  <main>');
const controllersStart = dashboard.indexOf('    <section class="controller-panels"');
const header = dashboard.slice(headerStart, mainStart);
const dashboardContext = dashboard.slice(mainStart + '  <main>'.length, controllersStart);
const recordingStart = dashboard.indexOf('<details id="recording-details"');
const recording = dashboard.slice(recordingStart, dashboard.indexOf('</section>\n\n    <section id="pairing-panel"', recordingStart));
assert(headerStart >= 0 && mainStart > headerStart && controllersStart > mainStart);
assert(dashboardContext.includes('id="recording-status"'), 'Fixture includes the production recording status in its dashboard context');
assert(recordingStart >= 0 && recording.endsWith('    '));
const now = Date.parse('2026-10-07T12:00:00Z');
const measurement = (signal, streamId, extra = {}) => ({ signal, streamId, source: 'simulation',
  unit: 'degC', policy: 'adaptive-value', observedThisRun: true, lastPollAt: now - 10000,
  lastSourceTime: now - 12000, lastSavedAt: now - 60000, threshold: .15,
  recordedPeriod: { firstSavedAt: now - 7 * 86400_000, lastSavedAt: now - 60000 },
  hour: { records: 12, averageIntervalMs: 300000 }, day: { records: 248, estimatedBytes: 16000, averageIntervalMs: 348000 },
  week: { records: 1800, averageIntervalMs: 336000 },
  freshness: { status: 'fresh', sourceObservedAt: now - 12000, maxAgeMs: 120000, reasons: [] }, ...extra });
const status = { recordingHealth: { version: 2, checkedAt: now, scope: 'live',
  disk: { state: 'critical', totalBytes: 128e9, freeBytes: 2.1e9, checkedAt: now,
    detail: 'Free space is critically low. Recordings and backup copies share this filesystem.' },
  recording: { state: 'write-failed', lastSourceCheckAt: now - 180000, lastFailureAt: now - 60000,
    detail: 'The last write failed. New observations may not have been recorded.' },
  backup: { state: 'available', latestAt: now - 2 * 86400_000, latestKind: 'saved-copy', latestVerifiedAt: null,
    detail: 'A saved copy is listed on this computer. Keep an independent copy on separate storage.' },
  attention: [{ id: 'disk-space', severity: 'critical', title: 'Disk space is critically low', detail: 'Only 2.1 GB is available on this computer.' },
    { id: 'recording', severity: 'critical', title: 'Recording write failed', detail: 'New observations may not have been recorded.' }],
}, now, recording: { annualBudgetBytes: 10e9, measuredDatabaseBytes: 83e9, adaptiveEstimatedBytes: 40e6,
  adaptiveAccountingStartedAt: now - 2 * 86400_000,
  adaptiveMeasurementHours: 48, adaptiveProjectedAnnualBytes: 8e9,
  totalDatabaseMeasurementHours: 240, totalDatabaseProjectedAnnualBytes: 32e9,
  parameters: [measurement('outdoor_temperature', 'aabbccddeeff'),
    measurement('outdoor_temperature', '112233445566', { observedThisRun: false, lastPollAt: now - 86400_000,
      lastSourceTime: now - 86400_000, recordedPeriod: { firstSavedAt: now - 30 * 86400_000, lastSavedAt: now - 86400_000 } }),
    measurement('garage_native_indoor_temperature', '223344556677'),
    measurement('ev2_energy_l3', '334455667788', { source: 'shelly-evse', unit: 'kWh', policy: 'adaptive-energy',
      threshold: .08, thresholdUnit: 'kW', grouped: true, openInterval: { start: now - 3600000, end: now, kwh: 1.28 } })],
} };
const inventory = { generatedAt: now, database: { adaptiveEstimatedBytes: 6e9, adaptiveObservationCount: 281672,
  fileBytes: 82e9, walBytes: 1e9, totalFileBytes: 83e9 }, groups: [
  { id: 'states', label: 'Equipment states and settings', description: 'Exact reported changes and their original dates.',
    items: [{ id: 'dhwr_active', label: 'Hot-water circulation feedback', count: 312, countLabel: 'records',
      status: 'present', policyLabel: 'Every change', retention: 'history',
      description: 'Reported circulation feedback is distinct from the controller request.',
      writeBehavior: 'Every state, quality or availability change.', firstAt: now - 14 * 86400_000, lastAt: now - 30000,
      fields: [{ name: 'Reported state', description: 'Original on, off or unavailable value; this is not proof of water flow.' }] }] },
  { id: 'weather', label: 'Weather and market inputs', items: [{ id: 'weather-snapshots', label: 'Weather forecasts',
      count: 168, countLabel: 'fetches', status: 'present', retention: 'history',
      writeBehavior: 'Each successful weather acquisition.', firstAt: now - 7 * 86400_000, lastAt: now,
      fields: [{ name: 'Forecast periods', description: 'Forecast temperature and solar radiation with issue time and provider.' }],
      breakdown: [{ label: 'Synthetic weather provider', count: 168, firstAt: now - 7 * 86400_000, lastAt: now }] }] },
  { id: 'learning', label: 'Learning and saved state', items: [{ id: 'state-settings', label: 'Current controller settings',
      count: 2, countLabel: 'current entries', status: 'present', retention: 'current', firstAt: now - 86400_000, lastAt: now,
      writeBehavior: 'When the current application state changes.', fields: [{ name: 'Current state', description: 'Current choices with their equipment and session ownership.' }] }] },
], accounting: { totalRows: 281842, tables: [{ name: 'observations', rows: 281672 }, { name: 'snapshots', rows: 168 }, { name: 'state', rows: 2 }],
  views: [{ name: 'recorded_measurements', description: 'A query of original observations; no second stored history.' }] } };
const fixture = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/recording-health.css"></head>
<body data-authenticated="true">${header}<main>${dashboardContext}
<section class="controller-panels" aria-label="Synthetic dashboard layout" data-snapshot-content>
  <div class="controller-column"><article class="panel"><h2>Home</h2><p class="muted">Synthetic controller panel</p></article></div>
  <div class="controller-column"><article class="panel"><h2>Garage</h2><p class="muted">Synthetic controller panel</p></article></div>
</section>
<section class="panel history-panel"><div id="fixture-control">Other dashboard content</div>${recording}</section></main>
<script type="module">import { createRecordingHealth } from '/chart/recording-health.js';
import { recordingOverviewRefresh, renderRecording, renderRecordingOverview, renderEnergyAudits } from '/chart/recording.js';
window.payload = ${JSON.stringify(status)}; window.inventory = ${JSON.stringify(inventory)};
window.initialHealth = structuredClone(payload.recordingHealth);
window.setScenario = state => {
  const health = structuredClone(initialHealth);
  if(state !== 'critical') {
    health.recording = {state:state === 'sources' ? 'source-unavailable' : 'ok', lastSourceCheckAt:${now},
      detail:state === 'sources' ? 'Check source connections.' : 'Source monitoring is active.'};
    health.disk = {state:'ok', totalBytes:128e9, freeBytes:80e9, checkedAt:${now}, detail:'Local disk space is available.'};
    health.attention = state === 'sources' ? [{id:'recording', severity:'warning', title:'Recording sources are unavailable', detail:'Check source connections.'}] : [];
  }
  payload.recordingHealth = health;
  panel.update(payload);
};
window.failRefresh = false; window.failInventory = false; window.requestCount = 0;
window.panel = createRecordingHealth({document, now: () => ${now},
setTimer: callback => { window.expireIntro = callback; return 1; }, clearTimer: () => {}, request: async path => {
  if(path !== '/api/recording-health') throw Error('Unexpected request'); window.requestCount++;
  if(window.deferred) return new Promise(resolve => window.resolveHealth = resolve);
  if(window.failRefresh) throw Error('private fixture error'); return window.payload.recordingHealth;
}});
window.initialStatusHidden = document.getElementById('recording-status').hidden;
panel.update(payload);
window.inventoryRequests = 0;
const element = id => document.getElementById(id);
element('context').textContent = 'Live controller · synthetic dashboard';
element('connection').textContent = 'Updated just now';
window.renderMeasurements = () => renderRecording(payload, element('recording-content'));
renderMeasurements();
renderEnergyAudits([{ kind:'property-meter-summary', signal:'property_import_energy_counter',
  summary:{status:'waiting-for-second-reading',readingCount:1,latestReading:{valueKwh:1250,sourceTime:${now},receivedAt:${now}}} },
  {kind:'charging-session-summary',source:'easee',signal:'ev1_session_energy_check',
    summary:{comparedSessions:5,recordedSessions:6,excludedSessions:1,estimatedKwh:49.5,referenceKwh:50,differencePercent:-1,
      start:${now - 7 * 86400_000},end:${now},lastSessionEnd:${now},exclusionReasons:{'incomplete-coverage':1}}}],element('energy-audit-content'));
element('energy-audit-message').textContent='Recorded energy comparisons · synthetic fixture';
window.inventoryRefresh = recordingOverviewRefresh({
  request: async path => {
    if(path !== '/api/recording-overview') throw Error('Unexpected inventory request');
    window.inventoryRequests++;
    if(window.failInventory) throw Error('Private inventory failure');
    return window.inventory;
  }, root:element('recording-overview-content'), details:[element('recording-overview-details'), element('recording-storage-details')],
  parent:element('recording-details'), message:element('recording-overview-message'), button:element('recording-overview-refresh'),
  render:(overview, root) => { renderRecordingOverview(overview, root); panel.inventory(overview); }, onState:state => panel.inventoryStatus(state),
});
element('recording-details').addEventListener('toggle', () => { if(element('recording-details').open) void inventoryRefresh({summary:true}); });
for(const id of ['recording-overview-details','recording-storage-details']) element(id).addEventListener('toggle', () => void inventoryRefresh());
element('recording-overview-refresh').addEventListener('click', () => void inventoryRefresh({force:true}));
window.ready = true;</script></body></html>`;
const assets = new Map(['monitor.css', 'recording-health.css', 'recording-health.js'].map(name => [`/chart/${name}`,
  [name.endsWith('.css') ? 'text/css' : 'text/javascript', readFileSync(new URL(`../../chart/${name}`, import.meta.url))]]));
function addModule(path) {
  if(assets.has(path)) return;
  const source = readFileSync(new URL(`../..${path}`, import.meta.url), 'utf8');
  assets.set(path, ['text/javascript', source]);
  for(const match of source.matchAll(/\b(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
    if(match[1].startsWith('.')) addModule(new URL(match[1], `http://fixture${path}`).pathname);
  }
}
addModule('/chart/recording.js');
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture').pathname, asset = assets.get(path);
  response.writeHead(asset || path === '/' ? 200 : 404, { 'Content-Type': asset?.[0] ?? 'text/html; charset=utf-8' });
  response.end(asset?.[1] ?? (path === '/' ? fixture : 'Not found'));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for(let attempt = 0; attempt < 200 && !port; attempt++) {
    if(launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if(!port) await pause(30);
  }
  assert(port, 'Disposable browser starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'}).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {socket.onopen = resolve; socket.onerror = reject;});
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if(message.id) {const task = pending.get(message.id); if(!task) return; pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if(message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
    pending.set(id, {resolve, reject, timer}); socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
    if(result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async name => {
    const dimensions = await evaluate('({width:innerWidth, height:document.documentElement.scrollHeight})');
    const result = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport: true,
      clip:{x:0, y:0, width:dimensions.width, height:dimensions.height, scale:1} });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
  };
  const checkLayout = async label => {
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${label}: page fits`);
    const clipped = await evaluate(`Array.from(document.querySelectorAll('.recording-health-card, .recording-section-group, .recording-section, .recording-section-body, .recording-status, .recording-status-issue, .recording-measurements, .recording-dataset')).filter(node => {
      if(!node.checkVisibility()) return false;
      const b = node.getBoundingClientRect(); return b.width <= 0 || b.left < 0 || b.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1;
    }).map(node => ({id: node.id || node.className, left:node.getBoundingClientRect().left, right:node.getBoundingClientRect().right,
      width:node.clientWidth, content:node.scrollWidth}))`);
    if(clipped.length) await capture(`clipping-${label.replaceAll('/', '-')}`);
    assert.deepEqual(clipped, [], `${label}: recording content fits without clipping`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.recording-section-group')).flatMap(group => {
      const folds = Array.from(group.querySelectorAll(':scope > details'));
      return folds.slice(1).filter((fold, index) => fold.getBoundingClientRect().top < folds[index].getBoundingClientRect().bottom - 1).map(fold => fold.id);
    })`), [], `${label}: sibling folds do not overlap`);
  };
  const checkDashboardSpacing = async label => {
    const layout = await evaluate(`(() => {
      const status = document.getElementById('recording-status').getBoundingClientRect();
      const context = document.getElementById('context');
      const controllers = document.querySelector('.controller-panels').getBoundingClientRect();
      const history = document.querySelector('.history-panel').getBoundingClientRect();
      return {above:status.top-context.getBoundingClientRect().bottom, expectedAbove:parseFloat(getComputedStyle(context).marginBottom),
        below:controllers.top-status.bottom, otherGap:history.top-controllers.bottom,
        left:status.left-controllers.left, right:status.right-controllers.right};
    })()`);
    assert.ok(Math.abs(layout.above-layout.expectedAbove) <= 1, `${label}: context-to-status gap matches the dashboard context spacing: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs(layout.below-layout.otherGap) <= 1, `${label}: status and dashboard panels share vertical spacing: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs(layout.left) <= 1 && Math.abs(layout.right) <= 1, `${label}: status aligns with dashboard panels`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Background CDP targets otherwise update activeElement without firing focusout.
  await send('Emulation.setFocusEmulationEnabled', {enabled:true});
  await send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
  for(let attempt = 0; attempt < 100 && !await evaluate('window.ready === true'); attempt++) await pause(30);
  assert.equal(await evaluate('window.ready'), true, errors.join('\n'));
  assert.equal(await evaluate('window.initialStatusHidden'), true, 'No status is shown before current health is available');
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false);
  assert.equal(await evaluate("document.querySelectorAll('#recording-status-issues .recording-status-issue').length"), 2,
    'Concurrent recording and storage problems remain separate');
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#recording-status-issues [data-recording-open]'), node=>node.dataset.recordingOpen).sort()"),
    ['recording-disk-card', 'recording-recording-card']);
  assert.equal(await evaluate("document.getElementById('recording-details').open"), false);
  await evaluate("document.querySelector('[data-recording-open=recording-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-details').open && document.activeElement === document.querySelector('#recording-details > summary')"), true,
    'Status opens recording details and transfers keyboard focus');
  await settle();
  assert.equal(await evaluate('inventoryRequests'),1,'Opening recording details requests the cached inventory once');
  assert.equal(await evaluate("document.getElementById('recording-overview-details').open"),false);
  assert.equal(await evaluate("document.getElementById('recording-storage-details').open"),false);
  assert.equal(await evaluate("document.querySelectorAll('.recording-health-card[open]').length"),0,'Health explanations start folded');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"),'6 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-file').textContent"),'82 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-wal').textContent"),'1 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-files').textContent"),'83 GB');
  assert.equal(await evaluate("document.querySelectorAll('#recording-content tr[data-stream-id]').length"),3,'Adaptive measurements use real production rendering');
  assert.equal(await evaluate("document.querySelector('[data-signal=outdoor_temperature] .recording-source-history > summary').textContent"),'Source history · 2 identities');
  assert.equal(await evaluate("document.querySelectorAll('#recording-overview-content .recording-dataset').length"),3,'Inventory uses real production rendering');
  assert.equal(await evaluate("document.getElementById('recording-disk-meter').getAttribute('aria-valuetext')"), '2.1 GB free · 1.6% free of 128 GB');
  assert.equal(await evaluate("document.getElementById('recording-status-meter').getAttribute('aria-valuetext')"), '2.1 GB free · 1.6% free of 128 GB');
  for(const width of [320,390,768,1440]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height:1000, deviceScaleFactor:1, mobile:false});
    for(const theme of ['light','dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'; document.querySelectorAll('#recording-details details').forEach(node => node.open = false); scrollTo(0,0)`); await settle();
      await checkLayout(`${width}/${theme}/baseline`);
      await checkDashboardSpacing(`${width}/${theme}/baseline`);
      assert.equal(await evaluate("document.getElementById('recording-growth-adaptive').textContent"), '8 GB/year');
      assert.equal(await evaluate("document.getElementById('recording-growth-total').textContent"), '32 GB/year');
      assert.equal(await evaluate("document.getElementById('recording-growth-adaptiveStored').textContent"), '40 MB');
      await capture(`baseline-${width}-${theme}`);
      await evaluate("setScenario('healthy'); document.getElementById('recording-details').open=false; scrollTo(0,0)");
      await settle(); await checkLayout(`${width}/${theme}/startup`); await checkDashboardSpacing(`${width}/${theme}/startup`);
      assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'Healthy startup briefly shows recording and storage');
      assert.equal(await evaluate("document.getElementById('recording-status-issues').hidden"), true, 'Recovered issues are removed');
      await capture(`startup-${width}-${theme}`);
      await evaluate("setScenario('sources')"); await settle();
      await checkLayout(`${width}/${theme}/sources`); await checkDashboardSpacing(`${width}/${theme}/sources`);
      assert.match(await evaluate("document.getElementById('recording-status-state').textContent"), /source/i);
      assert.equal(await evaluate("document.querySelector('#recording-status-issues .recording-status-issue').dataset.tone"), 'warning');
      assert.doesNotMatch(await evaluate("document.getElementById('recording-status').textContent"), /write failed|writes are failing|database fault/i,
        'Unavailable sources are presented separately from failed database writes');
      await capture(`sources-${width}-${theme}`);
      await evaluate("setScenario('critical'); document.getElementById('recording-details').open=true");
      await evaluate("document.getElementById('recording-storage-details').open=true; document.querySelectorAll('.recording-storage-evidence').forEach(node => node.open=true)");
      await settle(); await checkLayout(`${width}/${theme}/storage`); await capture(`storage-${width}-${theme}`);
      await evaluate("document.getElementById('recording-storage-details').open=false; document.getElementById('recording-adaptive-details').open=true; document.querySelector('[data-signal=outdoor_temperature] .recording-source-history').open=true");
      await settle(); await checkLayout(`${width}/${theme}/adaptive`); await capture(`adaptive-${width}-${theme}`);
      await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=true)");
      await settle(); await checkLayout(`${width}/${theme}/expanded`); await capture(`expanded-${width}-${theme}`);
    }
  }
  await evaluate("document.getElementById('recording-status-disk').click()");
  assert.equal(await evaluate("document.getElementById('recording-disk-card').open && document.activeElement === document.querySelector('#recording-disk-card > summary')"), true,
    'Storage summary opens and focuses disk details');
  await evaluate("document.querySelector('#recording-status-issues [data-recording-open=recording-recording-card]').click()");
  assert.equal(await evaluate("document.getElementById('recording-recording-card').open && document.activeElement === document.querySelector('#recording-recording-card > summary')"), true,
    'Each issue opens and focuses its relevant details');
  await evaluate("setScenario('healthy'); document.getElementById('recording-status-recording').focus(); expireIntro()");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false,
    'Startup expiry does not hide a focused status control');
  await evaluate("document.querySelector('#recording-details > summary').focus()"); await settle();
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true,
    'Healthy startup status hides after focus leaves it');
  await evaluate('panel.update(payload)');
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true,
    'Routine successful updates do not restart the startup presentation');
  await evaluate("setScenario('sources')");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'A new warning remains visible after startup');
  await evaluate("document.querySelector('#recording-status-issues [data-recording-open=recording-recording-card]').focus(); setScenario('healthy')");
  assert.equal(await evaluate("document.activeElement === document.getElementById('recording-status-recording')"), true,
    'Resolving a focused issue transfers focus to its stable status link');
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false,
    'Recovery does not remove the replacement keyboard focus target');
  await evaluate("document.querySelector('#recording-details > summary').focus()"); await settle();
  await evaluate("setScenario('healthy')");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Recovery hides the status again');
  await evaluate("setScenario('critical')");
  await evaluate("document.querySelector('[data-signal=outdoor_temperature] .recording-source-history > summary').focus(); renderMeasurements()");
  assert.equal(await evaluate("document.activeElement.closest('details').classList.contains('recording-source-history') && document.activeElement.closest('details').open"),true,
    'Adaptive source history preserves disclosure and keyboard focus through polling');
  await evaluate("document.querySelector('[data-dataset-id=weather-snapshots] > summary').focus(); inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.querySelector('[data-dataset-id=weather-snapshots]').open && document.querySelector('[data-dataset-id=weather-snapshots]').closest('.recording-data-group').open"),true,
    'Inventory refresh preserves nested disclosure states');
  assert.equal(await evaluate("document.activeElement.closest('[data-dataset-id]')?.dataset.datasetId"),'weather-snapshots',
    'Inventory refresh preserves keyboard focus');
  await evaluate("window.previousInventory=document.getElementById('recording-overview-content').innerHTML; failInventory=true; inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.getElementById('recording-overview-content').innerHTML === previousInventory"),true,'Inventory failure preserves the complete last inventory');
  assert.equal(await evaluate("document.getElementById('recording-overview-notice').hidden"),false,'Inventory errors remain visible inside Other recorded data');
  assert.match(await evaluate("document.getElementById('recording-overview-notice').textContent"),/last successful inventory.*Storage & growth/);
  assert.doesNotMatch(await evaluate('document.body.innerText'),/Private inventory failure/);
  await evaluate("failInventory=false; inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.getElementById('recording-overview-notice').hidden"),true,'A successful retry clears inventory attention');
  await evaluate("document.getElementById('recording-storage-details').open=false; document.querySelector('[data-recording-open=recording-storage-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-storage-details').open && document.activeElement === document.querySelector('#recording-storage-details > summary')"),true,
    'Other recorded data links to the shared storage and refresh disclosure');
  await evaluate('panel.inventory(inventory)');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"), '6 GB');
  assert.match(await evaluate("document.getElementById('recording-growth-inventoryAt').textContent"), /Retained adaptive payload estimate.*checked/);
  await evaluate("document.querySelector('#recording-backup-card > summary').focus(); payload.recordingHealth.backup.state = 'running'; payload.recordingHealth.backup.startedAt = payload.recordingHealth.checkedAt; panel.update(payload)");
  assert.equal(await evaluate("document.activeElement === document.querySelector('#recording-backup-card > summary') && document.getElementById('recording-backup-card').open"),true,
    'Health updates preserve disclosure state and keyboard focus');
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Creating a copy');
  await evaluate("document.querySelector('[data-recording-open=database-export-details]').click()");
  assert.equal(await evaluate("document.getElementById('database-export-details').open && document.activeElement === document.querySelector('#database-export-details > summary')"), true);
  await evaluate("failRefresh = true; document.getElementById('recording-health-refresh').click()"); await settle();
  assert.match(await evaluate("document.getElementById('recording-health-checked').textContent"), /Refresh failed/);
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), false);
  assert.match(await evaluate("document.getElementById('recording-status-freshness').textContent"), /Refresh failed/);
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Creating a copy', 'Failure retains dated evidence');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /private fixture error/);
  await evaluate("failRefresh = false; payload.recordingHealth.scope = 'snapshot'; payload.recordingHealth.recording = {state:'read-only', detail:'This computer reads the recorded snapshot.'}; payload.recordingHealth.attention = []; payload.recordingHealth.disk.state = 'ok'; payload.recordingHealth.disk.freeBytes = 80e9; payload.recordingHealth.backup = {state:'none-known'}; panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'A healthy recorded snapshot has no persistent startup strip');
  assert.equal(await evaluate("document.getElementById('recording-status-issues').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-recording-state').textContent"), 'Read-only history');
  assert.match(await evaluate("document.getElementById('recording-health-scope').textContent"), /Recorded snapshot/);
  assert.match(await evaluate("document.getElementById('recording-status-disk').textContent"), /this computer|local disk/i,
    'Snapshot storage identifies the local computer rather than the source of the recording');
  await evaluate(`payload.recordingHealth.checkedAt = ${now - 86400_000}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'Stale health remains visible after startup');
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), false, 'A stale check is explicitly labelled');
  await evaluate(`payload.recordingHealth.checkedAt = ${now}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Fresh health clears stale attention');
  await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=false); scrollTo(0,0)");
  await settle(); await capture('snapshot-1440-dark');
  // Authenticated fallback can expose just health when the first status read fails.
  await evaluate("panel.clear(); document.body.dataset.authenticated = 'false'; document.getElementById('recording-details').open = true; window.fallback = panel.refresh()");
  await evaluate('fallback');
  assert.equal(await evaluate("document.getElementById('recording-status').checkVisibility()"), true,
    'Authenticated health fallback includes the startup status');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.history-panel')).display !== 'none' && document.getElementById('recording-health').getBoundingClientRect().height > 0"), true);
  assert.equal(await evaluate("document.querySelector('.controller-panels').checkVisibility()"), false, 'Health-only fallback does not expose dashboard controls');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('fixture-control')).display"), 'none');
  assert.equal(await evaluate("document.getElementById('database-export-details').checkVisibility()"),false);
  assert.equal(await evaluate("document.querySelector('.recording-section-group').checkVisibility()"),false,'Health fallback hides the complete data and tools groups');
  // Clear fences a response that arrives after logout.
  await evaluate('deferred = true; window.pendingRefresh = panel.refresh(); panel.clear(); resolveHealth(payload.recordingHealth)');
  await evaluate('pendingRefresh');
  assert.equal(await evaluate('document.body.dataset.recordingHealth'), 'false');
  assert.equal(await evaluate("document.getElementById('recording-status').checkVisibility()"), false);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.history-panel')).display"), 'none');
  assert.deepEqual(errors, []);
  console.log(`Recording details browser smoke passed: 320/390/768/1440, light/dark, dashboard spacing, startup/source/critical states, startup expiry and recovery, collapsed/storage/adaptive/all-open layouts, production tables, disclosure and focus preservation, targeted navigation, inventory and health failures, stale health, snapshot, auth fallback and logout fencing. Screenshots: ${artifacts}`);
} finally {
  socket?.close(); browser?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await pause(120); rmSync(profile, {recursive:true,force:true});
}
