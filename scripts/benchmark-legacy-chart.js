// Optional, read-only comparison with the actual 0.7.5 chart algorithms.
// Requires Firefox and an already imported var/st-mq.sqlite. All HTTP is local;
// supplied CSVs are streamed only from the isolated loopback fixture server.
// Run: node scripts/benchmark-legacy-chart.js
// Run only the longest imported range: node scripts/benchmark-legacy-chart.js --full-only
import { build } from 'vite';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChartService } from '../src/app/chart-service.js';
import { finnishDate } from '../chart/history-model.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = join(repo, 'var/legacy-chart-benchmark');
const profile = join(repo, 'var/firefox-legacy-bench');
const dbPath = join(repo, 'var/st-mq.sqlite');
const httpPort = Number(process.env.STMQ_BENCH_HTTP_PORT ?? 39126);
const debugPort = Number(process.env.STMQ_BENCH_DEBUG_PORT ?? 39125);
const fixtures = new Map([['/fixtures/easee.csv', join(repo, 'CODEX/easee.csv')], ['/fixtures/st-mq.csv', join(repo, 'CODEX/st-mq-corrected.csv')]]);
for (const dir of [scratch, profile, join(scratch, 'legacy'), join(scratch, 'current')]) mkdirSync(dir, { recursive: true });
const legacy = path => execFileSync('git', ['show', `8c701d6:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 });
writeFileSync(join(scratch, 'legacy/index.html'), legacy('chart/index.html'));
writeFileSync(join(scratch, 'legacy/data-processor.js'), legacy('chart/data-processor.js')
  .replace("new URL('../share/st-mq/easee.csv', import.meta.url).toString()", "'/fixtures/easee.csv'")
  .replace("new URL('../share/st-mq/st-mq.csv', import.meta.url).toString()", "'/fixtures/st-mq.csv'"));
writeFileSync(join(scratch, 'legacy/chart.js'), legacy('chart/chart.js').split('// Begin execution')[0] + `
import { animator } from 'chart.js';
const drawer = new ChartDrawer();
window.benchmarkRange = async (start, end) => {
  const begin = performance.now();
  await drawer.generate_chart(new Date(start + 'T12:00:00'), new Date(end + 'T12:00:00'));
  const readyMs = performance.now() - begin;
  const chart = Chart.getChart('acquisitions');
  if (!chart || !chart.data.datasets.some(d => d.data.length)) throw new Error('Legacy chart has no data');
  while (animator.running(chart)) await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  return { readyMs, settledMs: performance.now() - begin, points: chart.data.datasets.reduce((sum, d) => sum + d.data.length, 0) };
};
window.benchmarkReady = true;
`);
writeFileSync(join(scratch, 'current/index.html'), `<!doctype html><html data-theme="dark"><head><style>
body{margin:20px;background:#14251c;color:#e0ede6;font:14px sans-serif}.chart-wrap{position:relative;height:500px;width:1200px;max-width:100%;margin:auto}
#chart-legend{display:flex;gap:12px;flex-wrap:wrap}.chart-legend-group{display:flex;gap:8px}button{font:inherit}
</style></head><body><form id="chart-range-form"><input id="date-start" type="date"><input id="date-end" type="date"><button>Apply</button></form>
<select id="left-axis"><option value="power">Power</option><option value="phases">Phases</option><option value="integral">Integral</option></select>
<button id="range-today">Today</button><button id="range-yesterday">Yesterday</button><button id="range-tomorrow">Tomorrow</button>
<div class="chart-wrap"><canvas id="history"></canvas></div><div id="chart-legend"></div><p id="chart-status"></p><p id="chart-notes"></p><script type="module" src="main.js"></script></body></html>`);
writeFileSync(join(scratch, 'current/main.js'), `
import { createHistoryChart } from ${JSON.stringify(join(repo, 'chart/history-chart.js'))};
import { selectedRange } from ${JSON.stringify(join(repo, 'chart/history-model.js'))};
// Compare the same historical signals: the supplied files contain spot prices,
// while household all-in rates have deliberately never been invented.
localStorage.setItem('home-energy-chart-visibility', JSON.stringify({spot_price:true,all_in_price:false,dhwr:true}));
let active = false;
const chart = createHistoryChart({api:async (path,options) => {
  if (!active) {
    const range = selectedRange('today',Date.now());
    return {range:{...range,from:Date.now()-1000,to:Date.now()+1000},now:Date.now(),input:'offline',series:{},shading:{},meta:{warnings:[]}};
  }
  const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}});
await chart.refresh({now:Date.now(),input:'offline'});
active = true;
window.benchmarkRange = async (start,end) => {
  document.getElementById('date-start').value=start;document.getElementById('date-end').value=end;
  const canvas=document.getElementById('history'); const begin=performance.now();
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{observer.disconnect();reject(new Error(document.getElementById('chart-status').textContent));},30000);
    const check=()=>{if(canvas.dataset.ready==='true'&&canvas.dataset.rangeStart===start&&canvas.dataset.rangeEnd===end){observer.disconnect();clearTimeout(timeout);resolve();}};
    const observer=new MutationObserver(check);observer.observe(canvas,{attributes:true});
    document.getElementById('chart-range-form').requestSubmit();queueMicrotask(check);
  });
  const readyMs=performance.now()-begin;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
  return {readyMs,settledMs:performance.now()-begin};
};
window.benchmarkReady=true;
`);
for (const version of ['legacy', 'current']) await build({ configFile: false, root: join(scratch, version), base: `/${version}/`, logLevel: 'warn', build: { outDir: join(scratch, `${version}-dist`), emptyOutDir: true } });

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON;');
const store = { db, path: dbPath };
let charts = createChartService({ store }), transferred = 0;
const contentTypes = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${httpPort}`);
    if (url.pathname === '/api/chart') {
      const data = await charts.query({ startDate: url.searchParams.get('start'), endDate: url.searchParams.get('end'), left: url.searchParams.get('left'), points: Number(url.searchParams.get('points')), input: 'offline', now: Date.now() });
      const text = JSON.stringify(data); transferred += Buffer.byteLength(text);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(text); return;
    }
    const version = url.pathname.split('/')[1];
    const fixture = fixtures.get(url.pathname);
    const relative = decodeURIComponent(url.pathname.slice(version.length + 2)) || 'index.html';
    if (!fixture && (!['legacy', 'current'].includes(version) || relative.includes('..'))) { res.writeHead(404); res.end(); return; }
    const file = fixture ?? join(scratch, `${version}-dist`, relative);
    const info = statSync(file);
    let start = 0, end = info.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) { res.writeHead(416); res.end(); return; }
      start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; status = 206;
      if (start > end) { res.writeHead(416); res.end(); return; }
    }
    res.writeHead(status, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream', 'Content-Length': end - start + 1,
      'Last-Modified': info.mtime.toUTCString(), 'Accept-Ranges': 'bytes', ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
    if (req.method === 'HEAD') { res.end(); return; }
    transferred += end - start + 1; createReadStream(file, { start, end }).pipe(res);
  } catch (error) { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(httpPort, '127.0.0.1', resolve); });
const firefoxLog = openSync(join(scratch, 'firefox.log'), 'w');
const firefox = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', String(debugPort)], { env: { ...process.env, TZ: 'Europe/Helsinki' }, stdio: ['ignore', firefoxLog, firefoxLog] });
let ws, sequence = 0;
const pending = new Map(), browserErrors = [];
function command(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
}
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${debugPort}/session`);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); break;
    } catch { ws?.close(); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (ws?.readyState !== WebSocket.OPEN) throw new Error('Isolated Firefox debugger did not start');
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(JSON.stringify(message))); else entry.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params.level === 'error') browserErrors.push(message.params.text);
  };
  await command('session.new', { capabilities: {} });
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const results = [];
  const fullOnly = process.argv.includes('--full-only');
  const first = db.prepare('SELECT source_time FROM observations WHERE source_time IS NOT NULL ORDER BY source_time LIMIT 1').get();
  const last = db.prepare('SELECT source_time FROM observations WHERE source_time IS NOT NULL ORDER BY source_time DESC LIMIT 1').get();
  const cases = fullOnly ? [['full-history', finnishDate(first.source_time), finnishDate(last.source_time)]]
    : [['day', '2025-01-15', '2025-01-15'], ['two-days', '2025-01-15', '2025-01-16'], ['month', '2025-01-01', '2025-01-31']];
  for (const version of ['legacy', 'current']) for (const [range, start, end] of cases) {
    await charts.close(); charts = createChartService({ store });
    const { context } = await command('browsingContext.create', { type: 'tab' });
    await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1000 }, devicePixelRatio: 1 });
    await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${httpPort}/${version}/`, wait: 'complete' });
    const evaluate = async expression => {
      const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
      if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
      return JSON.parse(result.result.value);
    };
    await evaluate(`(async()=>{for(let i=0;i<100&&!window.benchmarkReady;i++)await new Promise(r=>setTimeout(r,50));if(!window.benchmarkReady)throw new Error('Chart not ready');return JSON.stringify(true)})()`);
    transferred = 0;
    const cold = await evaluate(`(async()=>JSON.stringify(await window.benchmarkRange(${JSON.stringify(start)},${JSON.stringify(end)})))()`);
    const coldBytes = transferred;
    const warm = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      await evaluate(`(async()=>JSON.stringify(await window.benchmarkRange('2025-02-01','2025-02-01')))()`);
      transferred = 0;
      warm.push({ ...await evaluate(`(async()=>JSON.stringify(await window.benchmarkRange(${JSON.stringify(start)},${JSON.stringify(end)})))()`), bytes: transferred });
    }
    const entry = { version, range, start, end, cold: { ...cold, bytes: coldBytes }, warm };
    results.push(entry); console.log(JSON.stringify(entry));
    await command('browsingContext.close', { context });
  }
  const report = { at: new Date().toISOString(), viewport: '1440x1000', legacyCommit: '8c701d6', chartJs: JSON.parse(readFileSync(join(repo, 'node_modules/chart.js/package.json'))).version,
    notes: ['Both use installed Chart.js and Vite, original legacy data/chart algorithms and current chart modules.', 'Same supplied household CSVs; current SQLite is opened read-only.', 'Cold means a fresh browser module cache and chart worker; OS filesystem caches are uncontrolled.', 'Warm means navigate to another day, then return; three repeats.', 'Historical spot and DHWR enabled on current chart to compare the recorded signals available to legacy.', 'Ready includes fetch/query, processing and chart update; settled also waits for legacy default animation and two paint frames.', 'Browser desktop localhost timings do not establish Android or WAN performance.'], results, browserErrors };
  const reportPath = join(scratch, fullOnly ? 'results-full.json' : 'results.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
  await command('browser.close', {});
} finally {
  ws?.close(); firefox.kill('SIGTERM'); closeSync(firefoxLog);
  await charts.close(); db.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
