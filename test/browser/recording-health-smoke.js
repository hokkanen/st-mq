import { uiSpacingFailures } from '../../scripts/lib/ui-spacing-checks.js';
// Production recording markup, tables and styles in a disposable browser,
// with synthetic data only. No application or household connections are made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageHealthFixture } from '../helpers/storage-health-fixture.js';
import { createWriteHealthHistory } from '../../src/storage/write-health-history.js';
import { createStorageOperationHealth } from '../../src/storage/operation-health.js';
import { Store } from '../../src/storage/store.js';
import { Recorder } from '../../src/storage/recorder.js';
import { getDatabaseOverview } from '../../src/app/database-overview.js';
import { createRecordingHealth as createHealthService } from '../../src/app/recording-health.js';

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
// Build populated evidence through the production memory aggregator. The clock,
// durations and failures are synthetic; no database or live service is opened.
let fixtureElapsed = 0;
const performanceRuntime = createWriteHealthHistory({ clock: () => now - 8 * 3600_000 + fixtureElapsed,
  monotonic: () => fixtureElapsed });
for (let index = 0; index < 12680; index++) {
  fixtureElapsed = index * (8 * 3600_000 / 12680);
  const priority = index % 24 === 0 ? 'control' : 'normal';
  performanceRuntime.queue({ type: 'accepted' });
  performanceRuntime.queue({ type: 'pending', pending: index % 3000 === 0 ? 9 : 1 });
  if ([1000, 4000, 7000, 10000].includes(index)) {
    performanceRuntime.queue({ type: 'waiting' });
    fixtureElapsed += index === 1000 ? 600 : 300;
    performanceRuntime.queue({ type: 'ready' });
  }
  performanceRuntime.queue({ type: 'completed', priority, delayMs: index % 5000 === 0 ? 612 : priority === 'control' ? 1.6 : 3.3 });
  performanceRuntime.queue({ type: 'pending', pending: 0 });
  if (index < 11320) performanceRuntime.transaction({ committed: true,
    beginMs: 0.3, bodyMs: index % 3000 === 0 ? 128 : 4.2, totalMs: index % 3000 === 0 ? 540 : 17.2, commitMs: index % 3000 === 0 ? 410 : 12.1,
    journalSealMs: index % 3000 === 0 ? 110 : 2.1, nativeCommitMs: index % 3000 === 0 ? 300 : 10 });
}
performanceRuntime.checkpoint({ ran: true, elapsedMs: 450 });
performanceRuntime.checkpoint({ ran: true, elapsedMs: 60 });
performanceRuntime.backgroundTurn({ runMs: 470 });
performanceRuntime.queue({ type: 'completed', priority: 'background', delayMs: 15 });
fixtureElapsed = 8 * 3600_000;
const performanceHistory = performanceRuntime.status({ queued: 0, activeJobs: 0, oldestPendingMs: null });
let operationTick = 0;
const operationRuntime = createStorageOperationHealth({ clock: () => now - 2 * 3600_000 + operationTick, monotonic: () => operationTick });
const backupOperation = operationRuntime.begin('backup', { queued: true, scope: 'runtime' });
operationTick = 40; backupOperation.start(); operationTick = 320; backupOperation.finish('completed');
const publicationOperation = operationRuntime.begin('learning-publication', { scope: 'standby' });
operationTick = 600; publicationOperation.finish('failed', { reason: 'committed-followup-failed', committed: true });
operationRuntime.refuse('history-query');
const historyOperation = operationRuntime.begin('history-query', { scope: 'history' });
operationTick = 800; historyOperation.finish('cancelled', { reason: 'cancelled' });
operationTick = 2 * 3600_000;
const localOperationHistory = operationRuntime.status();
const measurement = (signal, streamId, extra = {}) => ({ signal, streamId, source: 'simulation',
  unit: 'degC', policy: 'adaptive-value', observedThisRun: true, lastPollAt: now - 10000,
  lastSourceTime: now - 12000, lastSavedAt: now - 60000, threshold: .15,
  recordedPeriod: { firstSavedAt: now - 7 * 86400_000, lastSavedAt: now - 60000 },
  hour: { records: 12, averageIntervalMs: 300000 }, day: { records: 248, estimatedBytes: 16000, averageIntervalMs: 348000 },
  week: { records: 1800, averageIntervalMs: 336000 },
  freshness: { status: 'fresh', sourceObservedAt: now - 12000, maxAgeMs: 120000, reasons: [] }, ...extra });
const status = { webAccess: { role: 'admin' }, recordingHealth: { version: 3, checkedAt: now, operations: localOperationHistory, scope: 'live', contextId: 'synthetic-live',
  disk: { state: 'critical', totalBytes: 128e9, freeBytes: 2.1e9, checkedAt: now,
    detail: 'Free space is critically low. Recordings and backup copies share this filesystem.' },
  recording: { storage: storageHealthFixture(now), writer: { state: 'ready' }, state: 'write-failed', lastLoopCompletedAt: now - 1000, lastSourceCheckAt: now - 180000, lastFailureAt: now - 60000,
    detail: 'The last write failed. New observations may not have been recorded.', history: performanceHistory },
  backup: { state: 'available', count: 3, totalBytes: 12288000, complete: true, latestAt: now - 2 * 86400_000, latestKind: 'saved-copy', latestVerifiedAt: null,
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
const inventory = { generatedAt: now, database: { allocatedBytes: 84e9, adaptiveEstimatedBytes: 6e9, adaptiveObservationCount: 281672,
  fileBytes: 82e9, walBytes: 1e9, totalFileBytes: 83e9, reusableBytes: 2e9,
  physical: { available:true, observationBytes:6e9, historyBytes:60e9,currentBytes:1e9,
    journalBytes:8e6,peerBacklogBytes:16e6,branchBytes:4e9,indexBytes:8e9,internalBytes:1e6 },
  journalRetention: {commits:1800,payloadBytes:6e6,baseSequence:8000,maxCommits:2048,maxBytes:8*1024*1024} }, groups: [
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
// Full catalog and partial-source health use real producers, with synthetic inputs.
const inventoryStore = new Store(':memory:');
let productionInventory;
try {
  const recorder = new Recorder(inventoryStore);
  for (const [signal, value] of [['supply_temperature', 30], ['indoor_temperature', 21], ['outdoor_temperature', 8]])
    recorder.record({ source: 'synthetic', device: 'synthetic', signal, value, unit: 'degC', sourceTime: now, receivedAt: now, quality: [] });
  productionInventory = getDatabaseOverview({ store: inventoryStore, now });
} finally { inventoryStore.close(); }
const healthService = createHealthService({ clock: () => now, getConfig: () => ({ dbPath: '/synthetic/history.sqlite' }),
  filesystem: async () => ({ blocks: 25_000_000, bavail: 15_000_000, bsize: 4096 }),
  backupCatalog: { list: async () => ({ copies: [], complete: true, reasons: [], checkedAt: now }) } });
const partialSourceHealth = await healthService.status({ engine: { config: { input: 'mqtt' }, latestStatus: { now } },
  current: { input: 'mqtt', recording: { parameters: [measurement('supply_temperature', '112233445566'),
    measurement('outdoor_temperature', 'aabbccddeeff', { freshness: { status: 'unavailable', sourceObservedAt: now - 900000, maxAgeMs: 120000 } })] } } });
assert.equal(partialSourceHealth.recording.state, 'ok');
assert.equal(partialSourceHealth.recording.sources.attentionStreams, 1);
const fixture = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/recording-health.css"><link rel="stylesheet" href="/chart/timing-benefit.css"></head>
<body data-authenticated="true">${header}<main>${dashboardContext}
<section class="controller-panels" aria-label="Synthetic dashboard layout" data-snapshot-content>
  <div class="controller-column"><article class="panel"><h2>Home</h2><p class="muted">Synthetic controller panel</p></article></div>
  <div class="controller-column"><article class="panel"><h2>Garage</h2><p class="muted">Synthetic controller panel</p></article></div>
</section>
<section class="panel history-panel"><div id="fixture-control">Other dashboard content</div>${recording}</section></main>
<script type="module">import { createRecordingHealth } from '/chart/recording-health.js';
import { createEnergyCheckRange } from '/chart/energy-check-range.js';
import { recordingOverviewRefresh, renderRecording, renderRecordingOverview, renderEnergyAudits } from '/chart/recording.js';
window.payload = ${JSON.stringify(status)}; window.inventory = ${JSON.stringify(inventory)};
window.initialHealth = structuredClone(payload.recordingHealth);
window.partialSourceHealth = ${JSON.stringify(partialSourceHealth)};
window.productionInventory = ${JSON.stringify(productionInventory)};
window.setScenario = state => {
  const health = structuredClone(initialHealth);
  if(state !== 'critical') {
    health.recording = {storage:structuredClone(initialHealth.recording.storage),writer:{state:'ready'},runtimeTiming:{basis:'observed-event-loop-delay',hardRealtime:false,samples:12680,maxObservedDelayMs:72,p99ObservedDelayMs:24,warningThresholdMs:1000},state:state === 'sources' ? 'source-unavailable' : 'ok', lastSourceCheckAt:${now}, lastLoopCompletedAt:${now - 1000}, lastWriteAt:${now - 1000},
      sources:{observedStreams:3,usableStreams:state==='sources'?2:3,attentionStreams:state==='sources'?1:0,unknownStreams:0,complete:false,issues:state==='sources'?[{id:'synthetic-temperature',label:'Outdoor temperature',unit:'°C',status:'stale',sourceObservedAt:${now-900000},lastCheckedAt:${now}}]:[]},
      detail:state === 'sources' ? 'Check source connections.' : 'Source monitoring is active.', history: structuredClone(initialHealth.recording.history)};
    health.disk = {state:'ok', totalBytes:128e9, freeBytes:80e9, checkedAt:${now}, detail:'Local disk space is available.'};
    health.attention = state === 'sources' ? [{id:'recording', severity:'warning', title:'Recording sources are unavailable', detail:'Check source connections.'}] : [];
  }
  payload.recordingHealth = health;
  renderStatus(payload);
};
window.setDetailedSources = () => {
  setScenario('sources');
  payload.recordingHealth.recording.state = 'ok';
  payload.recordingHealth.recording.detail = 'Source monitoring is active.';
  payload.recordingHealth.attention = [{id:'recording-sources',severity:'warning',title:'Some recording sources need attention',detail:'Check the affected measurements.'}];
  payload.recordingHealth.recording.sources = {observedStreams:5,usableStreams:2,attentionStreams:3,unknownStreams:1,complete:false,issues:[
    {id:'synthetic-temperature',label:'Outdoor temperature',unit:'°C',status:'stale',destination:'adaptive',
      reason:'The last received observation is older than the supported freshness limit.',sourceObservedAt:${now-900000},lastCheckedAt:${now}},
    {id:'synthetic-garage',label:'Garage heat-pump indoor temperature',unit:'°C',status:'unavailable',destination:'adaptive',
      reason:'The source is not currently reporting this measurement.',sourceObservedAt:${now-600000},lastCheckedAt:${now-5000}},
    {id:'synthetic-circulation',label:'Hot-water circulation feedback',status:'unknown',destination:'overview',
      reason:'The current source observation is not known.',sourceObservedAt:null,lastCheckedAt:null}
  ]};
  renderStatus(payload);
};
window.setPerformance = state => {
  setScenario('healthy');
  const health = payload.recordingHealth, history = health.recording.history;
  if(['saving','confirming','unavailable'].includes(state)) {
    health.recording.writer={state}; health.recording.storage.writer={state};
    health.recording.storage.transactionPhase=state==='saving'?'committing':state==='confirming'?'confirming':null;
    health.recording.storage.queue.active=state==='unavailable'?null:{priority:'control',kind:null,phase:'transaction',elapsedMs:140};
    health.recording.storage.queue.lanes.control.running=state==='unavailable'?0:1;
    history.current={pending:0,oldestPendingMs:null,waitingMs:null,activeJobs:state==='unavailable'?0:1};
    if(state!=='saving') {
      health.recording.state=state==='confirming'?'writer-confirming':'writer-unavailable';
      health.attention=[{id:'storage-writer',severity:state==='confirming'?'warning':'critical',
        title:state==='confirming'?'Confirming last save':'Recording storage is unavailable',detail:'Check Storage health.'}];
    }
  }
  if(state === 'busy') {
    history.current = {pending:6, oldestPendingMs:850, waitingMs:600, activeJobs:1};
    for(const window of Object.values(history.windows)) window.contention.active=true;
    health.recording.state='write-waiting';
    health.attention=[{id:'recording',severity:'warning',title:'Waiting for storage',detail:'Observations are waiting to be saved.'}];
  }
  if(state === 'failed') for(const window of Object.values(history.windows)) {
    window.failedWrites=2; window.queueRejected=1; window.failedJobs=2; window.postCommitFailures=1; window.commandsNotSent=3;
    window.incidents=[
      {category:'save-failed',at:${now - 60000},context:'mqtt-input',reason:'database-io',outcome:'not-retained-for-retry',recoveredAt:null},
      {category:'queue-refused',at:${now - 55000},context:'provider-input',reason:'write-queue-full',outcome:'queue-refused',recoveredAt:null},
      {category:'command-not-sent',at:${now - 40000},context:'heat-pump-command',reason:'recording-wait-expired',outcome:'command-not-sent',recoveredAt:null},
      {category:'follow-up-failed',at:${now - 30000},context:'storage',reason:'follow-up-failed',outcome:'saved-follow-up-failed',recoveredAt:null}];
  }
  if(state === 'recovered') for(const window of Object.values(history.windows)) {
    window.failedWrites=1;
    window.incidents=[{category:'save-failed',at:${now - 60000},context:'charging-input',reason:'database-io',outcome:'original-update-saved',recoveredAt:${now - 10000}}];
  }
  if(state === 'unknown') {
    health.disk={state:'unknown',detail:'Local disk space could not be checked.'};
    health.backup={state:'unknown',detail:'Available backups could not be checked.'};
    health.recording.writer={state:'unknown'};
    history.current={pending:null,oldestPendingMs:null,waitingMs:null,activeJobs:null}; health.recording.storage.queue=null;
    for(const window of Object.values(history.windows)) window.commandsNotSent=null;
  }
  if(state === 'empty' || state === 'reset') {
    history.startedAt=${now}; history.elapsedMs=state === 'reset' ? 0 : 5000;
    health.recording.storage.checkpoint={state:'idle',frames:null,lastRun:null,lastFailureAt:null};
    for(const window of Object.values(history.windows)) {
      window.coveredMs=history.elapsedMs;
      window.monitoredMs=history.elapsedMs;
      for(const metric of ['queueDelay','controlQueueDelay','normalQueueDelay','transactionDuration','commitDuration','beginDuration','bodyDuration','journalSealDuration','nativeCommitDuration','backgroundQueueDelay','backgroundRunDuration','checkpointDuration'])
        window[metric]={count:0,meanMs:null,p95Ms:null,maxMs:null};
      window.contention={episodes:0,totalMs:0,maxMs:0,active:false};
      for(const metric of ['peakPending','failedWrites','queueRejected','cancelledJobs','failedJobs','postCommitFailures','transactionAttempts','committedTransactions','commandsNotSent','backgroundFailedJobs','backgroundQueueRejected','backgroundCancelledJobs','checkpointFailures']) window[metric]=0;
      window.incidents=[];
    }
  }
  if(state === 'background') {
    const storage=health.recording.storage;
    storage.queue.active={priority:'background',kind:'checkpoint',phase:'exclusive',elapsedMs:450};
    storage.queue.lanes.control={queued:2,running:0,oldestPendingMs:320};
    storage.queue.lanes.background.running=1; storage.checkpoint.state='running';
    history.current={pending:2,oldestPendingMs:320,waitingMs:null,activeJobs:1};
  }
  if(state === 'periodic-checkpoints') health.recording.storage.configuration.checkpoint={mode:'periodic-passive',autoCheckpointFrames:0,pollMs:250,triggerFrames:null,maxDirtyMs:null,fallbackPollMs:1000};
  if(state === 'snapshot') {
    const storage=health.recording.storage;
    storage.configuration.execution='read-only'; storage.configuration.checkpoint={mode:'not-owned',autoCheckpointFrames:1000};
    storage.writer={state:'read-only'}; storage.checkpoint=null;
    health.scope='snapshot'; health.contextId='synthetic-snapshot'; health.recording={state:'read-only',history:null,storage};
  }
  renderStatus(payload);
};
window.failRefresh = false; window.failInventory = false; window.requestCount = 0; window.catalogRequests = 0; window.failCatalog = false;
window.copies = {directory:'/synthetic/recording/backups',checkedAt:${now-60000},complete:true,limit:100,reasons:[],copies:[
{id:'backup:synthetic',kind:'backup',filename:'stmq-2026-10-06T12-00-00-000Z.sqlite',createdAt:${now-86400_000},fileModifiedAt:${now-86400_000},bytes:4096000,verification:{state:'verified-when-created',at:null}},
{id:'reset:synthetic',kind:'reset',filename:'reset-recording-backup.sqlite',createdAt:${now-2*86400_000},fileModifiedAt:${now-2*86400_000},bytes:4096000,verification:{state:'not-checked',at:null}},
{id:'protected:synthetic',kind:'protected',filename:'protected-pairing-copy.sqlite',createdAt:null,fileModifiedAt:${now-3*86400_000},bytes:4096000,verification:{state:'verified-when-created',at:null}}]};
let recordingContext;
function resetRecordingContext(health) {
  const context = JSON.stringify([health.scope, health.contextId]);
  if (context === recordingContext) return;
  recordingContext = context;
  inventoryRefresh.reset();
}
window.renderStatus = value => {
  if (value.recordingHealth?.version === 3) resetRecordingContext(value.recordingHealth);
  panel.update(value);
  void inventoryRefresh();
};
window.panel = createRecordingHealth({document, now: () => ${now}, onContextChange: resetRecordingContext,
setTimer: (callback,ms) => { if(ms===15000) window.expireIntro = callback; return 1; }, clearTimer: () => {},
reviewBackup: value => { window.reviewedBackup = value.sourceId; }, downloadBackup: async copy => 'Download sent to the browser. Check this device to confirm it was saved.',
request: async (path,body) => {
  if(path.startsWith('/api/recording-backups')) {
    window.catalogRequests++;
    if(window.deferCatalog) return new Promise(resolve=>window.resolveCatalog=resolve);
    if(window.failCatalog) throw Error('Private catalog failure');
    if(path.endsWith('/verify')) {window.copies.copies.find(copy=>copy.id===body.sourceId).recheck={state:'queued',startedAt:${now}}; return {state:'queued'};}
    return structuredClone(window.copies);
  }
  if(path !== '/api/recording-health') throw Error('Unexpected request'); window.requestCount++;
  if(window.deferred) return new Promise(resolve => window.resolveHealth = resolve);
  if(window.failRefresh) throw Error('private fixture error'); return window.payload.recordingHealth;
}});
window.initialStatusHidden = document.getElementById('recording-status').hidden;
window.inventoryRequests = 0;
const element = id => document.getElementById(id);
element('context').textContent = 'Live controller · synthetic dashboard';
element('connection').textContent = 'Updated just now';
window.renderInventory = () => renderRecordingOverview(inventory, element('recording-overview-content'));
window.renderMeasurements = () => renderRecording(payload, element('recording-content'));
renderMeasurements();
renderEnergyAudits([{ kind:'property-meter-summary', signal:'property_import_energy_counter',
  summary:{status:'waiting-for-second-reading',readingCount:1,latestReading:{valueKwh:1250,sourceTime:${now},receivedAt:${now}}} },
  {kind:'charging-session-summary',source:'easee',signal:'ev1_session_energy_check',
    summary:{comparedSessions:5,recordedSessions:6,excludedSessions:1,estimatedKwh:49.5,referenceKwh:50,differencePercent:-1,
      start:${now - 7 * 86400_000},end:${now},lastSessionEnd:${now},exclusionReasons:{'incomplete-coverage':1}}}],element('energy-audit-content'));
element('energy-audit-message').textContent='Recorded energy comparisons · synthetic fixture';
window.energyPeriodChanges = [];
window.energyRange = createEnergyCheckRange({document, now:()=>payload.now, onChange:()=>energyPeriodChanges.push(energyRange.selection())});
window.inventoryRefresh = recordingOverviewRefresh({
  request: async path => {
    if(path!=='/api/recording-overview') throw Error('Unexpected inventory request');
    window.inventoryRequests++;
    if(window.failInventory) throw Error('Private inventory failure');
    return {catalogue:{groups:[],database:window.inventory.database,generatedAt:window.inventory.generatedAt},result:window.inventory,job:{state:"completed"}};
  }, root:element('recording-overview-content'), details:[element('recording-overview-details'), element('recording-disk-card')],
  parent:element('recording-details'), message:element('recording-overview-message'), button:element('recording-overview-refresh'),
  cancel:element('recording-overview-cancel'),progress:element('recording-overview-progress'),detail:element('recording-overview-detail'),
  render:renderRecordingOverview,onView:view=>panel.inventory(view.result??view.catalogue,{files:view.catalogue}),onState:state=>panel.inventoryStatus(state),
});
element('recording-details').addEventListener('toggle', () => { if(element('recording-details').open) void inventoryRefresh(); });
for(const id of ['recording-overview-details','recording-disk-card']) element(id).addEventListener('toggle', () => void inventoryRefresh());
element('recording-overview-refresh').addEventListener('click', () => void inventoryRefresh({force:true}));
renderStatus(payload);
window.ready = true;</script></body></html>`;
const assets = new Map(['monitor.css', 'recording-health.css', 'timing-benefit.css'].map(name => [`/chart/${name}`,
  [name.endsWith('.css') ? 'text/css' : 'text/javascript', readFileSync(new URL(`../../chart/${name}`, import.meta.url))]]));
function addModule(path) {
  if(assets.has(path)) return;
  const source = readFileSync(new URL(`../..${path}`, import.meta.url), 'utf8');
  assets.set(path, ['text/javascript', source]);
  for(const match of source.matchAll(/\b(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
    if(match[1].startsWith('.')) addModule(new URL(match[1], `http://fixture${path}`).pathname);
  }
}
addModule('/chart/recording-health.js');
addModule('/chart/recording.js');
addModule('/chart/storage-health.js');
addModule('/chart/energy-check-range.js');
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
  const captureArea = async (name, geometry) => {
    // Full-document capture hides Chrome's scrollbar. Preserve the layout width
    // so a focused clip cannot reflow wider and crop its right edge mid-capture.
    const originalWidth = await evaluate("(() => { const root=document.documentElement, previous=root.style.width; root.style.width=root.clientWidth+'px'; return previous; })()");
    try {
      await settle();
      const clip = await evaluate(geometry);
      const result = await send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true,clip});
      writeFileSync(join(artifacts, `${name}.png`), Buffer.from(result.data,'base64'));
    } finally {
      await evaluate(`document.documentElement.style.width=${JSON.stringify(originalWidth)}`);
      await settle();
    }
  };
  const capture = name => captureArea(name, '({x:0,y:0,width:innerWidth,height:document.documentElement.scrollHeight,scale:1})');
  const captureFold = (id, name) => captureArea(name,
    `(() => { const box=document.getElementById('${id}').getBoundingClientRect(); return {x:box.left,y:box.top+scrollY,width:box.width,height:box.height,scale:1}; })()`);
  const captureGlance = name => captureFold('recording-health', name);
  const checkLayout = async label => {
    assert.equal(await evaluate(`JSON.stringify((${uiSpacingFailures.toString()})())`), '[]', 'All visible surfaces use one small inset');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${label}: page fits`);
    const clipped = await evaluate(`Array.from(document.querySelectorAll('.recording-backup-list, .recording-backup-toolbar, .recording-backup-actions, .recording-source-exceptions, .recording-source-heading, .recording-source-reason, .recording-source-clocks, .recording-source-clocks dd, #recording-recording-unknown, #recording-recording-coverage, .recording-storage-inventory, .recording-health-card, .recording-section-group, .recording-section, .recording-section-body, .recording-status, .recording-status-issue, .recording-measurements, .recording-data-group, .recording-data-group > summary, .recording-data-group > p, .recording-dataset, .recording-dataset-facts, .recording-performance-timings, .recording-performance-toolbar, .recording-performance-measures, .recording-performance-outcomes, .recording-performance-incidents, .recording-operation-list, .recording-operation, .recording-command-coverage')).filter(node => {
      if(!node.checkVisibility()) return false;
      const b = node.getBoundingClientRect(), owner=node.closest('.recording-health-card')?.getBoundingClientRect();
      return b.width <= 0 || b.left < 0 || b.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1
        || (owner && (b.left < owner.left - 1 || b.right > owner.right + 1));
    }).map(node => ({id: node.id || node.className, left:node.getBoundingClientRect().left, right:node.getBoundingClientRect().right,
      width:node.clientWidth, content:node.scrollWidth}))`);
    if(clipped.length) await capture(`clipping-${label.replaceAll('/', '-')}`);
    assert.deepEqual(clipped, [], `${label}: recording content fits without clipping`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#recording-details .recording-section, #recording-details .recording-guide, #recording-details .recording-data-group, #recording-details .recording-dataset')).filter(node => node.checkVisibility()).filter(node => Number.parseFloat(getComputedStyle(node).marginInlineStart) !== 12).map(node => node.id || node.className)`), [], `${label}: plain nested folds use the shared inset; card and table padding own their level`);
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
  const checkTransactionHierarchy = async label => {
    const rows = await evaluate(`Array.from(document.querySelectorAll('#recording-performance-technical .recording-performance-timings tbody tr'), row => {
      const label=row.querySelector('.recording-timing-label'), text=label?.firstChild;
      const range=document.createRange(); if(text) range.selectNodeContents(text);
      return {
      label:text?.textContent.trim(),
      relation:row.querySelector('.recording-timing-relation')?.textContent,
      rowHeader:row.querySelector('th')?.getAttribute('scope'),
      inset:text ? range.getBoundingClientRect().left : null,
      values:Array.from(row.querySelectorAll('td'), cell=>({heading:cell.dataset.label,value:cell.textContent.trim()}))
    }})`);
    assert.deepEqual(rows.map(row=>row.label), ['Transaction','Writer admission','Transaction building','Commit & confirmation','Journal sealing','SQLite COMMIT'], `${label}: complete transaction timings retain their measurement names`);
    assert.deepEqual(rows.map(row=>row.relation), ['Whole successful attempt','BEGIN and its acknowledgement','Callback and dependent SQL calls','Within the transaction','Within commit & confirmation','Within commit & confirmation'], `${label}: parent/component relationships are explicit text`);
    assert.ok(rows.every(row=>row.rowHeader==='row'), `${label}: timing names remain accessible table row headers`);
    assert.ok(rows[0].inset < rows[1].inset && rows.slice(1,4).every(row=>Math.abs(row.inset-rows[1].inset)<=1) && rows[3].inset < rows[4].inset && Math.abs(rows[4].inset-rows[5].inset)<=1,
      `${label}: transaction, commit and its stages form three visible levels: ${JSON.stringify(rows.map(row=>row.inset))}`);
    assert.ok(rows.every(row=>row.values.length===3 && row.values.every(cell=>cell.heading && cell.value)),
      `${label}: average, percentile and worst values keep their headings in the mobile layout`);
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
    ['recording-disk-card', 'recording-performance-details']);
  assert.equal(await evaluate("document.getElementById('recording-details').open"), false);
  await evaluate("document.querySelector('[data-recording-open=recording-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-details').open && document.activeElement === document.querySelector('#recording-details > summary')"), true,
    'Status opens recording details and transfers keyboard focus');
  await settle();
  assert.equal(await evaluate('inventoryRequests'),0,'Opening recording details leaves the full inventory lazy');
  assert.equal(await evaluate('catalogRequests'),0,'A collapsed backup list does not scan files');
  await evaluate("document.getElementById('recording-disk-card').open=true"); await settle();
  assert.equal(await evaluate('inventoryRequests'),1,'Opening merged Storage & growth requests the bounded inventory');
  await evaluate("document.getElementById('recording-disk-card').open=false"); await settle();
  assert.equal(await evaluate("document.getElementById('recording-overview-details').open"),false);
  assert.equal(await evaluate("document.getElementById('recording-storage-details').closest('.recording-health-card').id"),'recording-disk-card');
  assert.equal(await evaluate("document.querySelectorAll('#recording-data-title ~ #recording-storage-details').length"),0,'Recorded data has no duplicate storage fold');
  assert.equal(await evaluate("document.querySelectorAll('.recording-health-card[open]').length"),0,'Health explanations start folded');
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.recording-health-card > summary > .recording-health-label'),node=>node.textContent)"),
    ['Recording','Storage health','Storage & growth','Backups'],'Four health areas share the same hierarchy');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"),'6 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-database').textContent"),'84 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-file').textContent"),'82 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-wal').textContent"),'1 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-files').textContent"),'83 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-peerBacklogPages').textContent"),'16 MB');
  assert.equal(await evaluate("document.getElementById('recording-growth-reusable').textContent"),'2 GB');
  assert.match(await evaluate("document.getElementById('recording-growth-journalRetention').textContent"),/including deletions, until acknowledged/);
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
      await evaluate("setPerformance('healthy'); document.querySelectorAll('.recording-health-card').forEach(node=>node.open=false)");
      await settle(); await checkLayout(`${width}/${theme}/glance-collapsed`); await captureGlance(`glance-collapsed-${width}-${theme}`);
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
      await evaluate("document.getElementById('recording-disk-card').open=true; document.querySelectorAll('.recording-storage-evidence').forEach(node => node.open=true)");
      await settle();
      assert.equal(await evaluate("document.getElementById('recording-growth-database').textContent"), '84 GB', 'A new scope reloads inventory allocation when Storage & growth opens');
      assert.match(await evaluate("document.getElementById('recording-overview-message').textContent"), /Complete inventory ready/);
      await checkLayout(`${width}/${theme}/storage`); await capture(`storage-${width}-${theme}`);
      await evaluate("document.getElementById('recording-disk-card').open=false; document.getElementById('recording-adaptive-details').open=true; document.querySelector('[data-signal=outdoor_temperature] .recording-source-history').open=true");
      await settle(); await checkLayout(`${width}/${theme}/adaptive`); await capture(`adaptive-${width}-${theme}`);
      await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=true)");
      await settle(); await checkLayout(`${width}/${theme}/expanded`); await capture(`expanded-${width}-${theme}`);
      assert.equal(await evaluate("document.querySelectorAll('#recording-backup-list > li').length"),3,'Backups lists individual saved copies');
      assert.match(await evaluate("document.getElementById('recording-backup-folder').textContent"),/synthetic\/recording\/backups/);
      await evaluate("setDetailedSources(); document.getElementById('recording-recording-card').open=true");
      await settle(); await checkLayout(`${width}/${theme}/source-details`);
      assert.match(await evaluate("document.getElementById('recording-recording-sources').textContent"),/Outdoor temperature.*Out of date.*Source observation/);
      assert.match(await evaluate("document.getElementById('recording-recording-coverage').textContent"),/never reported are outside/);
      assert.deepEqual(await evaluate("['observed','usable','attention'].map(name=>document.getElementById('recording-recording-'+name).textContent)"), ['5','2','3'],
        'Observed, usable and attention counts remain distinct');
      assert.match(await evaluate("document.getElementById('recording-recording-unknown').textContent"), /1.*unknown/i, 'Unknown sources are labelled within the attention count');
      const sourceRows = await evaluate(`Array.from(document.querySelectorAll('#recording-recording-sources > li'), row=>({
        title:row.querySelector('.recording-source-heading strong')?.textContent,
        status:row.querySelector('.recording-source-status')?.textContent,
        reason:row.querySelector('.recording-source-reason')?.textContent,
        clocks:Array.from(row.querySelectorAll('.recording-source-clocks dt'),node=>node.textContent),
        values:Array.from(row.querySelectorAll('.recording-source-clocks dd'),node=>node.textContent),
        destination:row.querySelector('.recording-source-link')?.dataset.recordingOpen
      }))`);
      assert.deepEqual(sourceRows.map(row=>row.status), ['Out of date','Unavailable','Unknown'], 'Each source owns a separate explicit status');
      assert.ok(sourceRows.every(row=>row.title && row.reason && row.clocks.join('|')==='Source observation|Last polling attempt' && row.values.length===2),
        'Each source has a name, reason and individually labelled observation and polling clocks');
      assert.deepEqual(sourceRows.map(row=>row.destination), ['recording-adaptive-details','recording-adaptive-details','recording-overview-details']);
      assert.doesNotMatch(sourceRows[2].values.join(' '), /just now|7 Oct/, 'An unknown source does not receive a manufactured clock');
      await captureFold('recording-recording-card', `recording-sources-${width}-${theme}`);
      await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=false); document.getElementById('recording-performance-details').open=true; setPerformance('healthy')");
      await settle(); await checkLayout(`${width}/${theme}/performance`); await capture(`performance-${width}-${theme}`); await captureGlance(`glance-storage-${width}-${theme}`);
      await evaluate("document.getElementById('recording-performance-operations').open=true; document.querySelector('#recording-performance-operation-list details[data-kind=learning-publication]').open=true");
      await settle(); await checkLayout(`${width}/${theme}/local-operations`);
      assert.match(await evaluate("document.querySelector('#recording-performance-operation-list details[data-kind=learning-publication]').textContent"), /Model publication.*Earlier problems.*save committed; follow-up work failed/s);
      assert.equal(await evaluate("document.querySelector('#recording-performance-operation-list details[data-kind=csv-import]')===null"), true);
      await captureFold('recording-performance-details', `local-operations-${width}-${theme}`);

      for(const state of ['saving','confirming','unavailable','busy','background','periodic-checkpoints','failed','recovered','unknown','empty','reset','snapshot']) {
        await evaluate(`setPerformance('${state}')`); await settle();
        await checkLayout(`${width}/${theme}/performance-${state}`); await capture(`performance-${state}-${width}-${theme}`);
        if(state==='background') assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"),'2 saves waiting');
        if(state==='periodic-checkpoints') assert.match(await evaluate("document.getElementById('recording-performance-checkpointPolicy').textContent"),/every 1 s; no frame-count trigger/);
        if(state==='failed') {
          await captureGlance(`glance-problems-${width}-${theme}`);
          await evaluate("document.querySelectorAll('.recording-health-card').forEach(node=>node.open=true); document.getElementById('recording-performance-technical').open=true");
          await settle(); await checkLayout(`${width}/${theme}/glance-all-open`); await captureGlance(`glance-all-open-${width}-${theme}`);
          await checkTransactionHierarchy(`${width}/${theme}`);
          if(width===390 && theme==='dark') {
            const accessibility = await send('Accessibility.getFullAXTree');
            assert.ok(accessibility.nodes.some(node=>node.role?.value==='table' && /Successful transactions/.test(node.name?.value)),
              'The mobile timing layout retains its accessible table');
            for(const title of ['Transaction','Writer admission','Transaction building','Commit & confirmation','Journal sealing','SQLite COMMIT'])
              assert.ok(accessibility.nodes.some(node=>node.role?.value==='rowheader' && node.name?.value?.startsWith(title)),
                `${title}: mobile timing remains an accessible row header`);
          }
          assert.match(await evaluate("document.getElementById('recording-performance-history-state').textContent"), /earlier problems/i, 'Past problems have their own historical summary cue');
          assert.doesNotMatch(await evaluate("document.getElementById('recording-performance-evidence').textContent"), /earlier problems/i, 'Monitored coverage remains separate from historical outcomes');
          await captureFold('recording-performance-details', `storage-timings-${width}-${theme}`);
          await evaluate("document.querySelectorAll('.recording-health-card').forEach(node=>node.open=false); document.getElementById('recording-performance-details').open=true; document.getElementById('recording-performance-technical').open=false");
        }
      }
      await evaluate("setScenario('critical')");
    }
  }
  await evaluate("setPerformance('snapshot'); document.getElementById('recording-performance-details').open=true; document.getElementById('recording-performance-operations').open=true; window.operationRow=document.querySelector('#recording-performance-operation-list details[data-kind=learning-publication]'); operationRow.open=true; operationRow.querySelector('summary').focus(); panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-performance-data').hidden && document.getElementById('recording-performance-operations').checkVisibility()"), true, 'Local-node jobs remain visible in a snapshot without claiming live writer monitoring');
  assert.equal(await evaluate("operationRow.open && document.activeElement===operationRow.querySelector('summary')"), true, 'Operation polling preserves disclosure and keyboard focus');
  await evaluate("window.originalOperations=structuredClone(payload.recordingHealth.operations); for(const period of ['day','week']) payload.recordingHealth.operations.coverage.find(row=>row.kind==='backup')[period].completed=0; panel.update(payload)");
  assert.equal(await evaluate("operationRow.open && document.activeElement===operationRow.querySelector('summary')"), true,
    'Removing an earlier task group preserves the surviving disclosure and focus');
  await evaluate("for(const period of ['day','week']) { const row=payload.recordingHealth.operations.coverage.find(row=>row.kind==='learning-publication'); row[period].failed=0; row[period].lastProblem=null; } panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-performance-operations > summary')"), true,
    'An expired focused task returns focus to its persistent diagnostic disclosure');
  await evaluate("payload.recordingHealth.operations=originalOperations; panel.update(payload)");
  assert.match(await evaluate("document.getElementById('recording-performance-operations-evidence').textContent"), /On this computer/);
  await evaluate("setDetailedSources(); document.getElementById('recording-details').open=true; document.getElementById('recording-recording-card').open=true; window.sourceRow=document.querySelector('#recording-recording-sources > li'); window.sourceLink=sourceRow.querySelector('.recording-source-link'); sourceLink.focus(); panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===sourceLink && sourceLink.closest('li')===sourceRow && document.getElementById('recording-recording-card').open"), true,
    'Routine source polling preserves its row, disclosure and focused link');
  await evaluate("payload.recordingHealth.recording.sources.issues.reverse(); panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===sourceLink && document.querySelector('#recording-recording-sources > li:last-child')===sourceRow"), true,
    'Reordering source exceptions preserves identity and focused navigation');
  await evaluate("payload.recordingHealth.recording.sources.issues=payload.recordingHealth.recording.sources.issues.filter(item=>item.id!=='synthetic-temperature'); panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-recording-card > summary')"), true,
    'A source recovering during inspection moves focus to its persistent fold summary');
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await evaluate("document.getElementById('recording-recording-card').open"), false, 'The recording fold closes with its native keyboard action');
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await evaluate("document.getElementById('recording-recording-card').open"), true, 'The recording fold reopens with its native keyboard action');
  // Same-scope Store replacement clears the loader and the displayed snapshot together.
  await evaluate("setScenario('healthy'); document.getElementById('recording-details').open=true; document.getElementById('recording-disk-card').open=true"); await settle();
  const beforeContextRequests = await evaluate('inventoryRequests');
  await evaluate("payload.recordingHealth={...payload.recordingHealth,contextId:'synthetic-replacement'}; renderStatus(payload)"); await settle();
  assert.equal(await evaluate('inventoryRequests'), beforeContextRequests + 1);
  assert.equal(await evaluate("document.getElementById('recording-growth-database').textContent"), '84 GB');
  await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=false); payload.recordingHealth={...payload.recordingHealth,scope:'snapshot',contextId:'synthetic-next-snapshot'}; renderStatus(payload)"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('#recording-overview-content [data-dataset-id]').length"), 0);
  assert.match(await evaluate("document.getElementById('recording-overview-message').textContent"), /Dataset descriptions are ready/);
  assert.equal(await evaluate("document.getElementById('recording-growth-database').textContent"), 'Not checked');
  // Home Assistant host/app paths retain their distinct labels on small screens.
  await evaluate("setScenario('healthy'); document.getElementById('recording-details').open=true; document.getElementById('recording-backup-card').open=true; copies.location={environment:'home-assistant',folder:'/addon_configs/synthetic_repository_home_energy/st-mq/backups',insideApp:'/config/st-mq/backups',hostMappingKnown:true}; panel.refreshCopies({force:true})"); await settle();
  assert.equal(await evaluate("document.getElementById('recording-backup-folder').textContent"), '/addon_configs/synthetic_repository_home_energy/st-mq/backups');
  assert.equal(await evaluate("document.getElementById('recording-backup-inside').textContent"), '/config/st-mq/backups');
  assert.equal(await evaluate("document.getElementById('recording-backup-inside-label').textContent"), 'Inside app');
  for (const [width,theme] of [[320,'dark'],[390,'light']]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';scrollTo(0,0)`); await settle();
    await checkLayout(`${width}/${theme}/backup-location`); await capture(`backup-location-${width}-${theme}`);
    assert.equal(await evaluate("document.getElementById('recording-backup-folder').checkVisibility() && document.getElementById('recording-backup-inside').checkVisibility()"), true);
  }
  await send('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate("delete copies.location; panel.refreshCopies({force:true})"); await settle();
  await evaluate("setScenario('healthy'); document.getElementById('recording-details').open=true; document.getElementById('recording-backup-card').open=true"); await settle();
  await evaluate("window.copyReview=document.querySelector('#recording-backup-list > li .recording-backup-actions button:last-child'); copyReview.focus(); panel.refreshCopies({force:true})"); await settle();
  assert.equal(await evaluate('document.activeElement===copyReview'),true,'Metadata refresh preserves copy action identity and keyboard focus');
  await evaluate('copyReview.click()');
  assert.equal(await evaluate('reviewedBackup'),'backup:synthetic','Review history selects the saved copy in the existing workflow');
  await evaluate("document.querySelector('#recording-backup-list .recording-backup-actions button:first-child').click()"); await settle();
  assert.match(await evaluate("document.querySelector('#recording-backup-list > li').textContent"),/Download sent.*confirm it was saved/);
  await evaluate("document.querySelector('#recording-backup-list .recording-backup-actions button:nth-child(2)').click()"); await settle();
  assert.equal(await evaluate("document.querySelector('#recording-backup-list .recording-backup-actions button:nth-child(2)').disabled"),true,'An active verification cannot be submitted twice');
  assert.match(await evaluate("document.querySelector('#recording-backup-list > li').textContent"),/Waiting for the full verifier/);
  await evaluate(`copies.copies[0].recheck={state:'complete',startedAt:${now-1000},finishedAt:${now}}; panel.refreshCopies({force:true})`); await settle();
  assert.match(await evaluate("document.querySelector('#recording-backup-list > li').textContent"),/Full check passed.*file state/);
  await evaluate("failCatalog=true; panel.refreshCopies({force:true,scan:true})"); await settle();
  assert.match(await evaluate("document.getElementById('recording-backup-catalogStatus').textContent"),/Could not refresh.*last successful list.*1 min ago/);
  assert.equal(await evaluate("document.querySelectorAll('#recording-backup-list > li').length"),3,'A failed list refresh retains previous metadata');
  assert.doesNotMatch(await evaluate('document.body.innerText'),/Private catalog failure/);
  await evaluate("failCatalog=false; document.querySelector('#recording-backup-list .recording-backup-actions button:first-child').focus(); copies.copies.shift(); panel.refreshCopies({force:true})"); await settle();
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-backup-card > summary')"),true,'Removing a focused saved-copy row restores a stable focus target');
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"),'2 saved copies','The folded count follows the newest catalog rather than older health metadata');
  await evaluate("setPerformance('healthy'); document.getElementById('recording-details').open=true; document.getElementById('recording-performance-details').open=true; window.beforePerformanceRequests=requestCount; document.getElementById('recording-performance-week').click(); document.getElementById('recording-performance-week').focus(); panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-performance-week').getAttribute('aria-pressed')"), 'true', 'Period choice survives status updates');
  assert.match(await evaluate("document.getElementById('recording-performance-coverage').textContent"), /Past week.*8 h monitored.*partial run/);
  assert.equal(await evaluate('requestCount'), await evaluate('beforePerformanceRequests'), 'Window selection makes no extra request');
  assert.equal(await evaluate("document.activeElement === document.getElementById('recording-performance-week') && document.getElementById('recording-performance-details').open"), true, 'Performance polling preserves focus and disclosure');
  assert.match(await evaluate("document.getElementById('recording-performance-current').textContent"), /^No queued operations$/);
  assert.equal(await evaluate("document.getElementById('recording-performance-journalSeal-worst').textContent"), '110 ms');
  assert.equal(await evaluate("document.getElementById('recording-performance-nativeCommit-worst').textContent"), '300 ms');
  assert.match(await evaluate("document.getElementById('recording-performance-nativeCommit-samples').textContent"), /measured SQLite commits/);
  await evaluate("setPerformance('busy')");
  assert.match(await evaluate("document.getElementById('recording-performance-current').textContent"), /6 queued.*oldest 850 ms.*1 running/);
  assert.match(await evaluate("document.getElementById('recording-performance-waiting').textContent"), /writer lock.*600 ms so far/);
  assert.match(await evaluate("document.getElementById('recording-performance-contentionDetail').textContent"), /active wait/);
  await evaluate("setPerformance('saving')");
  assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"), 'Writing');
  assert.equal(await evaluate("document.getElementById('recording-performance-details').dataset.tone"), 'neutral');
  assert.equal(await evaluate("document.getElementById('recording-performance-waiting').hidden"), true);
  await evaluate("setPerformance('unavailable')");
  assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"), 'Writer unavailable');
  assert.equal(await evaluate("document.getElementById('recording-performance-failed').textContent"), '0');
  assert.equal(await evaluate("document.querySelector('#recording-status-issues [data-recording-open]').dataset.recordingOpen"), 'recording-performance-details');
  await evaluate("payload.recordingHealth.recording.history=null; panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"), 'Writer unavailable', 'History absence cannot hide writer failure');
  assert.equal(await evaluate("document.getElementById('recording-performance-data').hidden"), true);
  await evaluate("setPerformance('confirming')");
  assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"), 'Confirming last save');
  await evaluate("document.getElementById('recording-performance-responsiveness').open=true; document.querySelector('#recording-performance-responsiveness > summary').focus(); panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-performance-responsiveness > summary')"), true);
  assert.equal(await evaluate("document.getElementById('recording-performance-runtime-p99').textContent"), '24 ms');
  assert.match(await evaluate("document.getElementById('recording-performance-runtime-samples').textContent"), /since application start/);
  await captureFold('recording-performance-responsiveness', 'application-responsiveness-1440-dark');
  await evaluate("setPerformance('snapshot')");
  assert.equal(await evaluate("document.getElementById('recording-performance-responsiveness').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-performance-live').hidden"), true);
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-performance-details > summary')"), true);
  await evaluate("setPerformance('failed')");
  assert.equal(await evaluate("document.getElementById('recording-performance-failed').textContent"), '2');
  assert.equal(await evaluate("document.getElementById('recording-performance-rejected').textContent"), '1');
  assert.equal(await evaluate("document.getElementById('recording-performance-commandsNotSent').textContent"),'3');
  assert.equal(await evaluate("document.querySelectorAll('#recording-performance-incident-list > li').length"),3);
  assert.match(await evaluate("document.getElementById('recording-performance-incidents').textContent"),/not retained for retry.*Saving resumed.*does not establish recovery/);
  assert.equal(await evaluate("document.getElementById('recording-performance-state').textContent"),'Caught up','Historical problems remain distinct from the live queue');
  await evaluate("document.getElementById('recording-performance-technical').open=true; document.querySelector('#recording-performance-technical > summary').focus(); panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===document.querySelector('#recording-performance-technical > summary') && document.getElementById('recording-performance-technical').open"),true,'Polling preserves technical disclosure and focus');
  for(const id of ['recording-performance-diagnostics','recording-performance-method']) {
    await evaluate(`document.getElementById('${id}').open=true; document.querySelector('#${id} > summary').focus(); panel.update(payload)`);
    assert.equal(await evaluate(`document.activeElement===document.querySelector('#${id} > summary') && document.getElementById('${id}').open`), true,
      `${id}: polling preserves its disclosure and focus`);
  }
  await evaluate("document.getElementById('recording-performance-week').focus()");
  await evaluate("failRefresh=true; panel.refresh()");
  assert.match(await evaluate("document.getElementById('recording-performance-notice').textContent"), /Refresh failed.*last known/);
  assert.equal(await evaluate("document.getElementById('recording-performance-failed').textContent"), '2');
  assert.equal(await evaluate("document.getElementById('recording-performance-week').getAttribute('aria-pressed')"), 'true');
  for(const area of ['recording','disk','backup','performance'])
    assert.match(await evaluate(`document.getElementById('recording-${area}-state').textContent`),/^Last known:/,'Each health row dates retained status after refresh failure');
  await capture('performance-stale-1440-dark');
  await evaluate("failRefresh=false; setPerformance('empty')");
  assert.equal(await evaluate("document.getElementById('recording-performance-queue-mean').textContent"), 'No samples');
  assert.equal(await evaluate("document.getElementById('recording-performance-journalSeal-mean').textContent"), 'No samples');
  assert.equal(await evaluate("document.getElementById('recording-performance-nativeCommit-mean').textContent"), 'No samples');
  assert.equal(await evaluate("document.getElementById('recording-performance-failed').textContent"), '0', 'Zero is observed only in covered time');
  await evaluate("setPerformance('reset')");
  assert.equal(await evaluate("document.getElementById('recording-performance-failed').textContent"), 'Not monitored');
  assert.match(await evaluate("document.getElementById('recording-performance-coverage').textContent"), /0 ms monitored.*partial run/);
  await evaluate("setPerformance('snapshot')");
  assert.equal(await evaluate("document.getElementById('recording-performance-data').hidden"), true);
  assert.match(await evaluate("document.getElementById('recording-performance-notice').textContent"), /memory.*not included.*snapshot/);
  assert.equal(await evaluate("document.activeElement === document.getElementById('recording-performance-week')"), true, 'The shared period selector remains available in snapshot scope');
  await evaluate("setScenario('critical'); document.querySelectorAll('#recording-details details').forEach(node=>node.open=true)");
  await evaluate("document.getElementById('recording-status-disk').click()");
  assert.equal(await evaluate("document.getElementById('recording-disk-card').open && document.activeElement === document.querySelector('#recording-disk-card > summary')"), true,
    'Storage summary opens and focuses disk details');
  await evaluate("document.querySelector('#recording-status-issues [data-recording-open=recording-performance-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-performance-details').open && document.activeElement === document.querySelector('#recording-performance-details > summary')"), true,
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
  await evaluate("setPerformance('failed')");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Historical performance counts do not create a new permanent banner');
  await evaluate("setScenario('sources')");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'A new warning remains visible after startup');
  await evaluate("window.sameIssueLink=document.querySelector('#recording-status-issues [data-recording-open=recording-recording-card]'); sameIssueLink.focus(); payload.recordingHealth.recording.state='write-waiting'; payload.recordingHealth.attention[0].title='Waiting for storage'; panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===sameIssueLink && sameIssueLink.dataset.recordingOpen==='recording-performance-details' && document.getElementById('recording-status-recording').dataset.recordingOpen==='recording-performance-details'"),true,
    'Source to storage updates both destinations without replacing the focused issue');
  await evaluate("sameIssueLink.click()");
  assert.equal(await evaluate("document.getElementById('recording-performance-details').open && document.activeElement===document.querySelector('#recording-performance-details > summary')"),true,
    'A storage issue opens its corresponding health evidence');
  await evaluate("sameIssueLink.focus(); payload.recordingHealth.recording.state='source-unavailable'; payload.recordingHealth.attention[0].title='Recording sources are unavailable'; panel.update(payload)");
  assert.equal(await evaluate("document.activeElement===sameIssueLink && sameIssueLink.dataset.recordingOpen==='recording-recording-card' && document.getElementById('recording-status-recording').dataset.recordingOpen==='recording-recording-card'"),true,
    'Storage to source restores both destinations without losing focus');
  await evaluate("document.querySelector('#recording-status-issues [data-recording-open=recording-recording-card]').focus(); setScenario('healthy')");
  assert.equal(await evaluate("document.activeElement === document.getElementById('recording-status-recording')"), true,
    'Resolving a focused issue transfers focus to its stable status link');
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false,
    'Recovery does not remove the replacement keyboard focus target');
  await evaluate("document.querySelector('#recording-details > summary').focus()"); await settle();
  await evaluate("setScenario('healthy')");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Recovery hides the status again');
  await evaluate("setScenario('critical')");
  await evaluate("document.getElementById('recording-adaptive-details').open=true; document.querySelector('[data-signal=outdoor_temperature] .recording-source-history').open=true; document.querySelector('[data-signal=outdoor_temperature] .recording-source-history > summary').focus(); renderMeasurements()");
  assert.equal(await evaluate("document.activeElement.closest('details').classList.contains('recording-source-history') && document.activeElement.closest('details').open"),true,
    'Adaptive source history preserves disclosure and keyboard focus through polling');
  await evaluate("document.getElementById('recording-overview-details').open=true; document.querySelector('[data-dataset-id=weather-snapshots]').closest('.recording-data-group').open=true; document.querySelector('[data-dataset-id=weather-snapshots]').open=true; document.querySelector('[data-dataset-id=weather-snapshots] > summary').focus(); inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.querySelector('[data-dataset-id=weather-snapshots]').open && document.querySelector('[data-dataset-id=weather-snapshots]').closest('.recording-data-group').open"),true,
    'Inventory refresh preserves nested disclosure states');
  assert.equal(await evaluate("document.activeElement.closest('[data-dataset-id]')?.dataset.datasetId"),'weather-snapshots',
    'Inventory refresh preserves keyboard focus');
  await evaluate("window.previousInventory=document.getElementById('recording-overview-content').innerHTML; failInventory=true; inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.getElementById('recording-overview-content').innerHTML === previousInventory"),true,'Inventory failure preserves the complete last inventory');
  assert.equal(await evaluate("document.getElementById('recording-overview-notice').hidden"),false,'Inventory errors remain visible inside Other recorded data');
  assert.match(await evaluate("document.getElementById('recording-overview-notice').textContent"),/last complete result.*Storage & growth/);
  assert.doesNotMatch(await evaluate('document.body.innerText'),/Private inventory failure/);
  await evaluate("failInventory=false; inventoryRefresh({force:true})");
  assert.equal(await evaluate("document.getElementById('recording-overview-notice').hidden"),true,'A successful retry clears inventory attention');
  await evaluate("document.getElementById('recording-disk-card').open=false; document.querySelector('[data-recording-open=recording-storage-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-disk-card').open && document.activeElement === document.querySelector('#recording-disk-card > summary')"),true,
    'Other recorded data links to the shared storage and refresh disclosure');
  await evaluate('panel.inventory(inventory)');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"), '6 GB');
  assert.match(await evaluate("document.getElementById('recording-growth-inventoryAt').textContent"), /Retained adaptive payload estimate.*checked/);
  await evaluate(`window.fullInventory=structuredClone(inventory);fullInventory.generatedAt=${now-3600_000};panel.inventory(fullInventory,{files:{generatedAt:${now},database:{allocatedBytes:90e9,fileBytes:85e9,walBytes:8e9,totalFileBytes:93e9,reusableBytes:3e9}}});true`);
  assert.equal(await evaluate("document.getElementById('recording-growth-database').textContent"),'90 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-files').textContent"),'93 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"),'6 GB');
  assert.equal(await evaluate("document.getElementById('recording-growth-measuredAllocation').textContent"),'84 GB');
  assert.match(await evaluate("document.getElementById('recording-growth-allocationAt').textContent"),/1 h ago/);
  assert.match(await evaluate("document.getElementById('recording-growth-fileEvidence').textContent"),/just now/);
  await evaluate('panel.inventory(inventory)');
  await evaluate("document.querySelector('#recording-backup-card > summary').focus(); payload.recordingHealth.backup.state = 'running'; payload.recordingHealth.backup.startedAt = payload.recordingHealth.checkedAt; panel.update(payload)");
  assert.equal(await evaluate("document.activeElement === document.querySelector('#recording-backup-card > summary') && document.getElementById('recording-backup-card').open"),true,
    'Health updates preserve disclosure state and keyboard focus');
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Copy in progress');
  await evaluate("document.querySelector('#database-export-details > summary').focus(); document.getElementById('database-export-details').open=false; document.querySelector('#database-export-details > summary').click()");
  assert.equal(await evaluate("document.getElementById('database-export-details').open && document.activeElement === document.querySelector('#database-export-details > summary')"), true);
  await evaluate("failRefresh = true; document.getElementById('recording-health-refresh').click()"); await settle();
  assert.match(await evaluate("document.getElementById('recording-health-checked').textContent"), /Refresh failed/);
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), false);
  assert.match(await evaluate("document.getElementById('recording-status-freshness').textContent"), /Refresh failed/);
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Last known: Copy in progress', 'Failure retains dated evidence');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /private fixture error/);
  await evaluate("failRefresh = false; payload.recordingHealth.scope = 'snapshot'; payload.recordingHealth.recording = {state:'read-only', detail:'This computer reads the recorded snapshot.'}; payload.recordingHealth.attention = []; payload.recordingHealth.disk.state = 'ok'; payload.recordingHealth.disk.freeBytes = 80e9; payload.recordingHealth.backup = {state:'none-known'}; panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'A healthy recorded snapshot has no persistent startup strip');
  assert.equal(await evaluate("document.getElementById('recording-status-issues').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-recording-state').textContent"), 'Read-only history');
  assert.match(await evaluate("document.getElementById('recording-health-scope').textContent"), /On this server.*Read-only replica/);
  assert.match(await evaluate("document.getElementById('recording-status-disk').textContent"), /this computer|local disk/i,
    'Snapshot storage identifies the local computer rather than the source of the recording');
  await evaluate(`payload.recordingHealth.checkedAt = ${now - 86400_000}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'Stale health remains visible after startup');
  assert.equal(await evaluate("document.getElementById('recording-status-freshness').hidden"), false, 'A stale check is explicitly labelled');
  await evaluate(`payload.recordingHealth.checkedAt = ${now}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Fresh health clears stale attention');
  await evaluate(`payload.recordingHealth.checkedAt = ${now + 1000}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'A small server clock lead does not create stale attention');
  assert.doesNotMatch(await evaluate("document.getElementById('recording-status-state').textContent"), /Last known/);
  await evaluate(`payload.recordingHealth.checkedAt = ${now + 180_001}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'A large clock difference remains visible');
  assert.match(await evaluate("document.getElementById('recording-status-freshness').textContent"), /server and browser clocks differ/);
  assert.doesNotMatch(await evaluate("document.getElementById('recording-status-freshness').textContent"), /just now|out of date/);
  await evaluate(`payload.recordingHealth.checkedAt = ${now}; panel.update(payload)`);
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), true, 'Corrected clocks clear the warning');
  await evaluate("document.querySelectorAll('#recording-details details').forEach(node=>node.open=false); scrollTo(0,0)");
  await settle(); await capture('snapshot-1440-dark');
  await evaluate("panel.update({recordingHealth:structuredClone(partialSourceHealth)}); expireIntro(); document.getElementById('recording-details').open=false");
  assert.equal(await evaluate("document.getElementById('recording-recording-state').textContent"), 'Monitoring active');
  assert.equal(await evaluate("document.getElementById('recording-status').hidden"), false, 'A real partial-source-loss response keeps attention visible');
  assert.equal(await evaluate("document.getElementById('recording-health-badge').hidden"), false, 'Partial source loss reaches the collapsed section');
  assert.match(await evaluate("document.getElementById('recording-recording-evidence').textContent"), /1 observed measurement stream needs attention/);
  await evaluate("payload.recording.parameters.push({signal:'voltage_estimate_l1',streamId:'abcdef123456',source:'voltage-estimate',unit:'V',policy:'adaptive-value',observedThisRun:true,lastPollAt:payload.now,lastSourceTime:payload.now,freshness:{status:'fresh',sourceObservedAt:payload.now,maxAgeMs:120000},voltage:{available:true,lastObservedAt:payload.now,reporting:true}}); renderMeasurements(); document.getElementById('recording-details').open=true; document.getElementById('recording-adaptive-details').open=true; document.querySelector('[data-recording-source] .status-detail-trigger').focus(); renderMeasurements()");
  assert.equal(await evaluate("document.activeElement.classList.contains('status-detail-trigger') && Boolean(document.activeElement.closest('[data-recording-source]'))"), true,
    'Voltage source information keeps keyboard focus through measurement polling');
  await evaluate("panel.update({recordingHealth:structuredClone(initialHealth),webAccess:{role:'admin'}}); document.getElementById('recording-adaptive-details').open=false; document.getElementById('recording-overview-details').open=true; inventory=productionInventory; inventoryRefresh({force:true});");
  const density = await evaluate("({total:document.querySelectorAll('#recording-overview-content [data-dataset-id]').length,empty:productionInventory.groups.flatMap(group=>group.items).filter(item=>item.count===0).length,folded:document.querySelectorAll('#recording-overview-content .recording-empty-datasets:not([open])').length})");
  assert(density.total >= 80 && density.empty >= 60 && density.folded > 0, 'Full production catalog keeps empty datasets discoverable and folded');
  for (const width of [390,1440]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelectorAll('#recording-overview-content > .recording-data-group').forEach(node=>node.open=true); scrollTo(0,0)");
    await settle(); await checkLayout(`${width}/production-inventory`); await capture(`production-inventory-${width}`);
  }
  await evaluate("document.getElementById('recording-details').open=true; document.getElementById('energy-audit-details').open=true; energyRange.selection()");
  assert.deepEqual(await evaluate("[document.getElementById('energy-check-date-start').value,document.getElementById('energy-check-date-end').value]"), ['2026-10-01','2026-10-07']);
  assert.equal(await evaluate("document.querySelector('#energy-audit-details progress')"), null, 'Energy checks have no animated refresh bar');
  for (const [preset, expected] of [['month',['2026-09-01','2026-09-30']],['year',['2026-01-01','2026-10-07']],['previous-year',['2025-01-01','2025-12-31']],['week',['2026-10-01','2026-10-07']]]) {
    await evaluate(`document.getElementById('energy-check-period-${preset}').click()`);
    assert.deepEqual(await evaluate("[document.getElementById('energy-check-date-start').value,document.getElementById('energy-check-date-end').value]"), expected);
    assert.equal(await evaluate(`document.getElementById('energy-check-period-${preset}').getAttribute('aria-pressed')`),'true');
  }
  await evaluate("document.getElementById('energy-check-date-end').value='2026-09-30'; document.getElementById('energy-check-date-end').dispatchEvent(new Event('change'))");
  assert.match(await evaluate("document.getElementById('energy-check-range-status').textContent"), /Choose valid dates/);
  assert.equal(await evaluate('energyPeriodChanges.length'),4,'An invalid date never starts another check');
  await evaluate("document.getElementById('energy-check-period-week').click(); inventory.inventoryIssues=['Current-state entries without a registered writer description are present.']; renderInventory()");
  assert.equal(await evaluate("document.querySelector('.recording-inventory-notice').open"), false);
  assert.equal(await evaluate("document.querySelector('.recording-inventory-notice > summary').textContent"), '1 inventory issue');
  await evaluate("document.querySelector('.recording-inventory-notice').open=true;document.querySelector('.recording-inventory-notice > summary').focus();renderInventory()");
  assert.equal(await evaluate("document.querySelector('.recording-inventory-notice').open && document.activeElement === document.querySelector('.recording-inventory-notice > summary')"),true,'Inventory issues retain expansion and focus');
  await evaluate("document.querySelector('#recording-overview-content .recording-task-link').focus();renderInventory()");
  assert.equal(await evaluate("document.activeElement === document.querySelector('#recording-overview-content .recording-task-link')"),true,'The measurement action retains focus on refresh');
  await evaluate("setScenario('healthy');document.getElementById('recording-performance-day').click();payload.recordingHealth.recording.history.windows.day.failedJobs=1;payload.recordingHealth.recording.history.windows.day.incidents=[];delete payload.recordingHealth.recording.history.windows.week;panel.update(payload);document.getElementById('recording-performance-details').open=true");
  assert.equal(await evaluate("document.getElementById('recording-performance-incidents').hidden"),false);
  assert.match(await evaluate("document.getElementById('recording-performance-undated-problems').textContent"),/1 failed queued operation.*dates and causes are unavailable/);
  await evaluate("document.getElementById('recording-performance-week').click()");
  assert.match(await evaluate("document.getElementById('recording-performance-problem-period').textContent"),/Past day.*past week is unavailable/);
  for (const width of [320,390,640,641,768,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await checkLayout(`${width}/updated-details`);
    if([320,390,1440].includes(width)) {
      await captureFold('recording-performance-details',`undated-storage-${width}`);
      await captureFold('energy-audit-details',`energy-period-${width}`);
      await captureFold('recording-overview-details',`inventory-header-${width}`);
    }
  }
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
  console.log(`Recording details browser smoke passed: 320/390/768/1440, light/dark, dashboard spacing, startup/source/critical states, startup expiry and recovery, four balanced health rows, merged storage, backup inventory/actions/failed-list/focus, source exceptions, collapsed/storage/all-open layouts, storage saving/confirming/unavailable/busy/failed/recovered/unknown/empty/reset/snapshot, independent writer availability and runtime responsiveness, local period choice, safe incidents, production tables, disclosure and focus preservation, source/storage navigation transitions, stale labels in all rows, inventory and health failures, snapshot, context reset and reload, Home Assistant host/app paths, production inventory density, voltage focus, auth fallback and logout fencing. Screenshots: ${artifacts}`);
} finally {
  socket?.close(); browser?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await pause(120); rmSync(profile, {recursive:true,force:true});
}
