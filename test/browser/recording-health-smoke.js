// Production health markup/styles in a disposable browser, with synthetic data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = mkdtempSync(join(tmpdir(), 'stmq-health-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-health-screenshots-'));
const dashboard = readFileSync(new URL('../../chart/index.html', import.meta.url), 'utf8');
const attentionStart = dashboard.indexOf('<aside id="recording-health-attention"');
const attention = dashboard.slice(attentionStart, dashboard.indexOf('</aside>', attentionStart) + 8);
const recordingStart = dashboard.indexOf('<details id="recording-details"');
const recording = dashboard.slice(recordingStart, dashboard.indexOf('</section>\n\n    <section id="pairing-panel"', recordingStart));
assert(attentionStart >= 0 && recordingStart >= 0 && recording.endsWith('    '));
const now = Date.parse('2026-10-07T12:00:00Z');
const status = { recordingHealth: { version: 1, checkedAt: now, scope: 'live',
  disk: { state: 'critical', totalBytes: 128e9, freeBytes: 2.1e9, checkedAt: now,
    detail: 'Free space is critically low. Recordings and backup copies share this filesystem.' },
  recording: { state: 'write-failed', lastRecordedAt: now - 180000, lastFailureAt: now - 60000,
    detail: 'The last write failed. New observations may not have been recorded.' },
  backup: { state: 'available', latestAt: now - 2 * 86400_000, latestKind: 'saved-copy', latestVerifiedAt: null,
    detail: 'A saved copy is listed on this computer. Keep an independent copy on separate storage.' },
  attention: [{ id: 'disk', severity: 'critical', title: 'Disk space is critically low', detail: 'Only 2.1 GB is available on this computer.' },
    { id: 'recording', severity: 'critical', title: 'Recording write failed', detail: 'New observations may not have been recorded.' }],
}, recording: { annualBudgetBytes: 10e9, measuredDatabaseBytes: 83e9, adaptiveEstimatedBytes: 40e6,
  adaptiveAccountingStartedAt: now - 2 * 86400_000,
  adaptiveMeasurementHours: 48, adaptiveProjectedAnnualBytes: 8e9,
  totalDatabaseMeasurementHours: 240, totalDatabaseProjectedAnnualBytes: 32e9,
} };
const fixture = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/recording-health.css"></head>
<body data-authenticated="true"><header><h1>Home Energy</h1></header><main>${attention}<section class="panel history-panel"><div id="fixture-control">Other dashboard content</div>${recording}</section></main>
<script type="module">import { createRecordingHealth } from '/chart/recording-health.js';
import { recordingOverviewRefresh } from '/chart/recording.js';
window.payload = ${JSON.stringify(status)}; window.failRefresh = false; window.requestCount = 0;
window.panel = createRecordingHealth({document, now: () => ${now}, request: async path => {
  if(path !== '/api/recording-health') throw Error('Unexpected request'); window.requestCount++;
  if(window.deferred) return new Promise(resolve => window.resolveHealth = resolve);
  if(window.failRefresh) throw Error('private fixture error'); return window.payload.recordingHealth;
}});
panel.update(payload);
window.inventoryRequests = 0;
const element = id => document.getElementById(id);
const inventoryRefresh = recordingOverviewRefresh({
  request: async path => {
    if(path !== '/api/recording-overview') throw Error('Unexpected inventory request');
    window.inventoryRequests++;
    return {generatedAt:${now}, groups:[], database:{adaptiveEstimatedBytes:6e9}};
  }, root:element('recording-overview-content'), details:element('recording-overview-details'),
  parent:element('recording-details'), message:element('recording-overview-message'), button:element('recording-overview-refresh'),
  render:overview => panel.inventory(overview), onState:state => panel.inventoryStatus(state),
});
element('recording-details').addEventListener('toggle', () => { if(element('recording-details').open) void inventoryRefresh({summary:true}); });
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
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', {url: `http://127.0.0.1:${server.address().port}/`});
  for(let attempt = 0; attempt < 100 && !await evaluate('window.ready === true'); attempt++) await pause(30);
  assert.equal(await evaluate('window.ready'), true, errors.join('\n'));
  assert.equal(await evaluate("document.getElementById('recording-details').open"), false);
  await evaluate("document.querySelector('[data-recording-open=recording-details]').click()");
  assert.equal(await evaluate("document.getElementById('recording-details').open && document.activeElement === document.querySelector('#recording-details > summary')"), true,
    'Attention opens recording details and transfers keyboard focus');
  await settle();
  assert.equal(await evaluate('inventoryRequests'),1,'Opening recording details requests the cached inventory once');
  assert.equal(await evaluate("document.getElementById('recording-overview-details').open"),false);
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"),'6 GB');
  assert.equal(await evaluate("document.getElementById('recording-disk-meter').getAttribute('aria-valuetext')"), '2.1 GB free · 1.6% free of 128 GB');
  for(const width of [320,390,768,1440]) {
    await send('Emulation.setDeviceMetricsOverride', {width, height:1000, deviceScaleFactor:1, mobile:false});
    for(const theme of ['light','dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'; scrollTo(0,0)`); await settle();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}/${theme}: page fits`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.recording-health-card, .recording-growth, .recording-health-attention')).filter(node => {
        const b = node.getBoundingClientRect(); return b.width <= 0 || b.left < 0 || b.right > innerWidth || node.scrollWidth > node.clientWidth + 1;
      }).map(node => node.id || node.className)`), [], `${width}/${theme}: health content fits without clipping`);
      assert.equal(await evaluate("document.getElementById('recording-growth-adaptive').textContent"), '8 GB/year');
      assert.equal(await evaluate("document.getElementById('recording-growth-total').textContent"), '32 GB/year');
      assert.equal(await evaluate("document.getElementById('recording-growth-adaptiveStored').textContent"), '40 MB');
      await capture(`critical-${width}-${theme}`);
    }
  }
  await evaluate('panel.inventory({generatedAt:payload.recordingHealth.checkedAt, database:{adaptiveEstimatedBytes:6e9}})');
  assert.equal(await evaluate("document.getElementById('recording-growth-retained').textContent"), '6 GB');
  assert.match(await evaluate("document.getElementById('recording-growth-inventoryAt').textContent"), /Retained adaptive payload estimate.*checked/);
  await evaluate("document.getElementById('recording-health-refresh').focus(); payload.recordingHealth.backup.state = 'running'; payload.recordingHealth.backup.startedAt = payload.recordingHealth.checkedAt; panel.update(payload)");
  assert.equal(await evaluate('document.activeElement.id'), 'recording-health-refresh', 'Updates preserve keyboard focus');
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Creating a copy');
  await evaluate("document.querySelector('[data-recording-open=database-export-details]').click()");
  assert.equal(await evaluate("document.getElementById('database-export-details').open && document.activeElement === document.querySelector('#database-export-details > summary')"), true);
  await evaluate("failRefresh = true; document.getElementById('recording-health-refresh').click()"); await settle();
  assert.match(await evaluate("document.getElementById('recording-health-checked').textContent"), /Refresh failed/);
  assert.equal(await evaluate("document.getElementById('recording-backup-state').textContent"), 'Creating a copy', 'Failure retains dated evidence');
  assert.doesNotMatch(await evaluate('document.body.innerText'), /private fixture error/);
  await evaluate("failRefresh = false; payload.recordingHealth.scope = 'snapshot'; payload.recordingHealth.recording = {state:'read-only', detail:'This computer reads the recorded snapshot.'}; payload.recordingHealth.attention = []; payload.recordingHealth.disk.state = 'ok'; payload.recordingHealth.disk.freeBytes = 80e9; payload.recordingHealth.backup = {state:'none-known'}; panel.update(payload)");
  assert.equal(await evaluate("document.getElementById('recording-health-attention').hidden"), true);
  assert.equal(await evaluate("document.getElementById('recording-recording-state').textContent"), 'Read-only history');
  assert.match(await evaluate("document.getElementById('recording-health-scope').textContent"), /Recorded snapshot/);
  await capture('snapshot-1440-dark');
  // Authenticated fallback can expose just health when the first status read fails.
  await evaluate("panel.clear(); document.body.dataset.authenticated = 'false'; document.getElementById('recording-details').open = true; window.fallback = panel.refresh()");
  await evaluate('fallback');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.history-panel')).display !== 'none' && document.getElementById('recording-health').getBoundingClientRect().height > 0"), true);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('fixture-control')).display"), 'none');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('database-export-details')).display"), 'none');
  // Clear fences a response that arrives after logout.
  await evaluate('deferred = true; window.pendingRefresh = panel.refresh(); panel.clear(); resolveHealth(payload.recordingHealth)');
  await evaluate('pendingRefresh');
  assert.equal(await evaluate('document.body.dataset.recordingHealth'), 'false');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.history-panel')).display"), 'none');
  assert.deepEqual(errors, []);
  console.log(`Recording health browser smoke passed: 320/390/768/1440, light/dark, attention navigation, unknown/snapshot, refresh failure, auth fallback and logout fencing. Screenshots: ${artifacts}`);
} finally {
  socket?.close(); browser?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await pause(120); rmSync(profile, {recursive:true,force:true});
}
