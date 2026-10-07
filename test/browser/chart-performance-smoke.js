// Real chart modules/Chart.js and production chart HTTP endpoint, using only a
// disposable synthetic database/browser. Vite serves modules so --source can
// compare an untouched checkout without overwriting its built dashboard.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Store } from '../../src/storage/store.js';
import { seedChartPerformanceFixture, CHART_PERFORMANCE_NOW as now } from '../../scripts/lib/chart-performance-fixture.js';

const argv = process.argv.slice(2), option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const source = resolve(option('--source', '.')), baseline = argv.includes('--baseline');
const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-browser-performance-'));
const profile = join(directory, 'profile'), artifacts = mkdtempSync(join(tmpdir(), 'stmq-chart-performance-shots-'));
const load = path => import(pathToFileURL(join(source, path)));
const [{ Engine }, { loadConfig }, { createAppServer }, { createChartService }] = await Promise.all([
  load('src/app/engine.js'), load('src/app/config.js'), load('src/app/server.js'), load('src/app/chart-service.js')]);
const store = new Store(join(directory, 'fixture.sqlite'));
const fixture = seedChartPerformanceFixture(store, { days: 35 });
const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'providers', connections: {} };
const engine = new Engine({ store, config, clock: () => now });
const service = createChartService({ store });
const server = createAppServer({ store, engine, chartService: service });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [], errors = [], measurements = [];
let vite, browser, socket, sequence = 0;
const pending = new Map();
const html = readFileSync(join(source, 'chart/index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace('</body>', '<script type="module" src="/__chart-performance.js"></script></body>');
const moduleSource = `import {createHistoryChart} from '/history-chart.js';
import Chart from 'chart.js/auto';
import * as network from '/network.js';
${baseline ? '' : "import {fetchChartResponse} from '/chart-request.js';"}
document.body.dataset.authenticated='true';
for(const panel of document.querySelectorAll('main > section')) if(!panel.classList.contains('history-panel')) panel.hidden=true;
document.getElementById('auth').hidden=true;
window.errors=[]; window.progress=[];
const api=async(path,options={})=>{
  const receive=${baseline ? 'network.fetchJsonResponse' : 'fetchChartResponse'};
  const {response,result}=await receive(path,{signal:options.signal},{...options,onProgress:p=>{progress.push(p);options.onProgress?.(p);}});
  if(!response.ok) throw new Error(result.error??'Fixture request failed'); return result;
};
window.fixtureStatus={now:${now},input:'providers',contract:null,recording:{historyRevision:1}};
window.chart=createHistoryChart({api});
window.fixtureGraph=()=>Chart.getChart(document.getElementById('history'));
window.frames=[];let last=performance.now();function frame(at){frames.push(at-last);last=at;requestAnimationFrame(frame);}requestAnimationFrame(frame);
window.setDates=(start,end)=>{const a=document.getElementById('date-start'),b=document.getElementById('date-end');a.value=start;a.dispatchEvent(new Event('change'));if(end!==start){b.value=end;b.dispatchEvent(new Event('change'));}};
window.chooseView=key=>{document.getElementById('chart-series-toggle').click();document.querySelector('[data-view-key="'+key+'"]').click();};
window.ready=chart.refresh(fixtureStatus).catch(error=>{errors.push(error.message);throw error;});`;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  vite = await createViteServer({ configFile: false, root: join(source, 'chart'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [source] },
      proxy: { '/api': { target: `http://127.0.0.1:${server.address().port}`, changeOrigin: true } } },
    plugins: [{ name: 'isolated-chart-performance-fixture',
      resolveId(id) { if (id === '/__chart-performance.js') return '\0chart-performance-fixture'; },
      load(id) { if (id === '\0chart-performance-fixture') return moduleSource; },
      configureServer(dev) {
      dev.middlewares.use(async (req, res, next) => {
        if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(await dev.transformIndexHtml('/', html)); return; }
        if (req.url.startsWith('/api/chart?')) {
          const query = new URL(req.url, 'http://fixture').searchParams;
          const item = { start: query.get('start'), end: query.get('end'), view: query.get('view'),
            prefetch: req.headers['x-chart-prefetch'] === '1', completed: false, closed: false };
          requests.push(item); res.once('finish', () => { item.completed = true; }); res.once('close', () => { item.closed = true; });
          // Deliberately stalled upstream establishes browser controls/cancel;
          // service tests separately interrupt real running SQLite workers.
          if (query.get('start') === '2025-01-01') {
            if (req.headers.accept?.includes('application/x-ndjson')) {
              res.writeHead(200, { 'content-type': 'application/x-ndjson' });
              res.write(JSON.stringify({ type: 'progress', stage: 'Reading history', completed: 1, total: 100 }) + '\n');
            }
            const timer = setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 30_000);
            res.once('close', () => clearTimeout(timer)); return;
          }
        }
        next();
      });
    } }] });
  await vite.listen();
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 60_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 600; attempt++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`Chart did not settle: ${expression}; ${JSON.stringify(errors)}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${vite.httpServer.address().port}` });
  await until("document.getElementById('history')?.dataset.ready==='true'");
  const measure = async (name, action, condition) => {
    await evaluate('frames.length=0'); const started = performance.now(); await evaluate(action); await until(condition);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    measurements.push({ name, elapsedMs: Math.round(performance.now() - started),
      ...(await evaluate('({maxFrameGapMs:Math.round(Math.max(0,...frames)),framesOver50ms:frames.filter(ms=>ms>50).length,drawMs:Number(document.getElementById("history").dataset.drawMs)})')) });
  };
  for (const [name, start, end] of [['day', '2026-10-06', '2026-10-06'], ['week', '2026-09-30', '2026-10-06']]) {
    await measure(name, `setDates('${start}','${end}')`, `document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.rangeStart==='${start}'&&document.getElementById('history').dataset.rangeEnd==='${end}'`);
    await measure(`${name}/unchanged`, 'chart.refresh(fixtureStatus)', "document.getElementById('history').dataset.ready==='true'");
    await measure(`${name}/theme`, "document.documentElement.dataset.theme='light';chart.updateTheme()", "document.getElementById('history').dataset.ready==='true'");
  }
  await measure('garage/week', "chooseView('garage')", "document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.view==='garage'");
  if (!baseline) {
    for (let attempt = 0; attempt < 100 && !requests.some(row => row.prefetch && row.view === 'garage_control' && row.completed); attempt++) await pause(50);
    assert(requests.some(row => row.prefetch && row.view === 'garage_control' && row.completed), 'Garage companion prefetched');
    const before = requests.length;
    await measure('garage/cached-companion', "chooseView('garage_control')", "document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.view==='garage_control'");
    assert.equal(requests.slice(before).filter(row => !row.prefetch).length, 0, 'Companion switch reuses response without foreground fetch');
    await evaluate("setDates('2025-01-01','2025-01-01')");
    await until("document.getElementById('chart-status').textContent.includes('1%')");
    assert.equal(await evaluate("document.getElementById('date-start').disabled||document.getElementById('range-today').disabled"), false);
    await measure('cancel-to-today', "document.getElementById('range-today').click()", "document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.rangeStart==='2026-10-07'");
    await pause(100);
    assert(requests.filter(row => row.start === '2025-01-01').every(row => row.closed && !row.completed), 'Selection change aborts old transport');
    assert(await evaluate('progress.length>0'), 'Real progress stream reached browser');
  }
  for (const [width, height, theme] of [[390, 844, 'dark'], [320, 720, 'light']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme='${theme}';chart.updateTheme()`); await pause(250);
    const colors = await evaluate(`fixtureGraph().data.datasets.flatMap((dataset,index)=>{
      if(!dataset.key.endsWith('_price'))return [];
      const points=fixtureGraph().getDatasetMeta(index).data;
      const at=dataset.data.findIndex(point=>Number.isFinite(point.y));
      return at<0?[]:[{key:dataset.key,line:dataset.borderColor,marker:points[at]?.options.backgroundColor,
        expected:Array.isArray(dataset.pointBackgroundColor)?dataset.pointBackgroundColor[at]:dataset.pointBackgroundColor}];
    })`);
    for (const color of colors) assert.equal(color.marker, color.expected, `${theme} ${color.key} resolved marker follows dataset style`);
    assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), `${width}px layout fits`);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(errors, [], 'No browser exceptions'); assert.deepEqual(await evaluate('errors'), []);
  console.log(JSON.stringify({ result: 'chart-performance-browser-passed', source, baseline, fixture, measurements,
    requests: requests.length, prefetches: requests.filter(row => row.prefetch).length, artifacts,
    note: 'Ubuntu Chromium real chart modules via Vite and production chart endpoint. Stalled-stream cancellation is injected; no Pi or physical-device claim.' }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  for (const task of pending.values()) clearTimeout(task.timer);
  if (browser) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await vite?.close(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await engine.charging.close(); await engine.garage.close({ restore: false }); await engine.closeFireplace(); await engine.executor.close({ restore: false });
  store.close(); rmSync(directory, { recursive: true, force: true });
}
