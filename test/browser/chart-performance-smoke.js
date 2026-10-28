// Real chart modules/Chart.js and production chart HTTP endpoint, using only a
// disposable synthetic database/browser. Vite serves modules so --source can
// compare an untouched checkout without overwriting its built dashboard.
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { Store } from '../../src/storage/store.js';
import { seedChartActivityFixture, seedChartActivityCatalogueFixture, ACTIVITY_FIXTURE_SIGNALS } from '../../scripts/lib/chart-activity-fixture.js';
import { seedChartPerformanceFixture, CHART_PERFORMANCE_NOW as now } from '../../scripts/lib/chart-performance-fixture.js';

const argv = process.argv.slice(2), option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const source = resolve(option('--source', '.')), baseline = argv.includes('--baseline');
const indicatorsOnly = argv.includes('--indicators-only'), catalogueOnly = argv.includes('--catalogue-only'), recordBroken = argv.includes('--record-broken-indicators');
const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-browser-performance-'));
const profile = join(directory, 'profile'), artifacts = mkdtempSync(join(tmpdir(), 'stmq-chart-performance-shots-'));
const load = path => import(pathToFileURL(join(source, path)));
const [{ Engine }, { loadConfig }, { createAppServer }, { createChartService }] = await Promise.all([
  load('src/app/engine.js'), load('src/app/config.js'), load('src/app/server.js'), load('src/app/chart-service.js')]);
const store = new Store(join(directory, 'fixture.sqlite'));
const fixture = catalogueOnly ? seedChartActivityCatalogueFixture(store) : indicatorsOnly ? { days: 2, basis: 'dense-state-boundaries' } : seedChartPerformanceFixture(store, { days: 35 });
if (indicatorsOnly) seedChartActivityFixture(store);
const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'providers', connections: {} };
const fixtureNow = catalogueOnly ? fixture.to : now;
const engine = new Engine({ store, config, clock: () => fixtureNow });
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
import {activityTracks,createChartOverlays} from '/chart-overlays.js';
import {defaultPalette} from '/history-model.js';
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
window.fixtureStatus={now:${fixtureNow},input:'providers',contract:null,recording:{historyRevision:1}};
window.chart=createHistoryChart({api});
window.fixtureGraph=()=>Chart.getChart(document.getElementById('history'));
window.frames=[];let last=performance.now();function frame(at){frames.push(at-last);last=at;requestAnimationFrame(frame);}requestAnimationFrame(frame);
window.setDates=(start,end)=>{const a=document.getElementById('date-start'),b=document.getElementById('date-end');a.value=start;a.dispatchEvent(new Event('change'));if(end!==start){b.value=end;b.dispatchEvent(new Event('change'));}};
window.chooseView=key=>{document.getElementById('chart-series-toggle').click();document.querySelector('[data-view-key="'+key+'"]').click();};
window.auditBuiltIn=async key=>{
  if(!window.auditPayload){
    const canvas=document.getElementById('history'),v=canvas.dataset;
    const query='start=2026-10-05&end=2026-10-05&points=100&viewFrom='+v.viewFrom+'&viewTo='+v.viewTo;
    const [control,garage,charging]=await Promise.all(['control','garage','charging_currents'].map(view=>api('/api/chart?'+query+'&view='+view)));
    window.auditPayload={...control,shading:{...control.shading,...garage.shading,...charging.shading}};
  }
  window.auditOverlay?.close();
  const canvas=document.getElementById('history'),track=activityTracks.find(row=>row.key===key);
  window.auditOverlay=createChartOverlays({canvas,getChart:fixtureGraph,getPayload:()=>auditPayload,
    getView:()=>({from:Number(canvas.dataset.viewFrom),to:Number(canvas.dataset.viewTo)}),getPalette:()=>defaultPalette,getTracks:()=>[track]});
  document.getElementById('chart-series-selected').textContent=track.label;
  auditOverlay.render();
};
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
  if (indicatorsOnly || catalogueOnly) {
    await evaluate(catalogueOnly?"setDates('2026-10-05','2026-10-05')":"setDates('2026-10-05','2026-10-06')");
    await until(`document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.rangeStart==='2026-10-05'&&document.getElementById('history').dataset.rangeEnd==='${catalogueOnly ? '2026-10-05' : '2026-10-06'}'`);
    const coverage = key => evaluate(`(() => {
      const row=document.querySelector('[data-activity-key="${key}"]'), track=row.querySelector('.mode-track');
      const segments=[...track.querySelectorAll('.mode-segment')];
      return {segments:segments.length,coveragePercent:segments.reduce((total,node)=>total+parseFloat(node.style.width)*(node.style.height?parseFloat(node.style.height)/100:1),0),
        border:segments[0]?getComputedStyle(segments[0]).borderRightWidth:null,trackWidth:track.getBoundingClientRect().width};
    })()`);
    const paintedColumns = async key => {
      const bounds=await evaluate(`(() => {const row=document.querySelector('[data-activity-key="${key}"] .mode-track'),r=row.getBoundingClientRect();
        return {x:r.left+1,y:r.top+1,width:Math.floor(r.width-2),height:Math.floor(r.height-2),background:getComputedStyle(row).backgroundColor};})()`);
      const {background,...clip}=bounds;
      const shot=await send('Page.captureScreenshot',{format:'png',clip:{...clip,scale:1}});
      return evaluate(`(async()=>{const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,${shot.data}')).blob());
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');
        ctx.fillStyle=${JSON.stringify(background)};ctx.fillRect(0,0,1,1);const bg=ctx.getImageData(0,0,1,1).data;
        ctx.drawImage(bitmap,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let painted=0;
        for(let x=0;x<canvas.width;x++){if([.25,.5,.75].some(f=>{const i=(Math.floor((canvas.height-1)*f)*canvas.width+x)*4;
          return Math.max(...[0,1,2].map(k=>Math.abs(pixels[i+k]-bg[k])))>8;}))painted++;}
        bitmap.close();return painted/canvas.width;})()`);
    };
    if (catalogueOnly) {
      const { EXPLORER_SERIES }=await import('../../chart/series-explorer.js');
      const { activityTracks }=await import('../../chart/chart-overlays.js');
      await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      await evaluate("document.documentElement.dataset.theme='dark';chart.updateTheme();true");
      for (const row of EXPLORER_SERIES.filter(row=>['state','code'].includes(row.unit))) {
        await measure(`catalogue/${row.key}`, `document.getElementById('chart-series-toggle').click();document.getElementById('chart-series-mode-series').click();document.querySelector('[data-series-key="${row.key}"]').click();true`,
          `document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.series==='${row.key}'`);
        if(!await evaluate("document.querySelector('.history-panel').dataset.fullscreen==='true'"))await evaluate("document.getElementById('chart-fullscreen').click();true");
        await evaluate("document.getElementById('history').focus();document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));for(let i=0;i<10;i++)document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown',{key:'+',bubbles:true}));true");
        await until("Number(document.getElementById('history').dataset.zoom)>100&&document.getElementById('chart-detail-status').dataset.state==='idle'&&!document.querySelector('.chart-gesture-preview')");
        await evaluate("document.getElementById('chart-navigator').value='0';document.getElementById('chart-navigator').dispatchEvent(new Event('input',{bubbles:true}));true");
        await until(`Number(document.getElementById('history').dataset.viewFrom)<${fixture.from + 10000}&&document.getElementById('chart-detail-status').dataset.state==='idle'&&!document.querySelector('.chart-gesture-preview')`);
        const state=await coverage(row.signal),painted=await paintedColumns(row.signal);
        measurements.at(-1).bar={...state,paintedColumnFraction:painted};
        assert(state.coveragePercent>99.8,`${row.key}: all original coverage renders`);assert(painted>.98,`${row.key}: screenshot colour remains visible`);
        const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(artifacts,`catalogue-${row.key}.png`),Buffer.from(shot.data,'base64'));
      }
      for(const track of activityTracks){
        await evaluate(`auditBuiltIn('${track.key}')`);await pause(100);
        const state=await coverage(track.key),painted=await paintedColumns(track.key);
        measurements.push({name:`built-in/${track.key}`,bar:{...state,paintedColumnFraction:painted}});
        assert(state.coveragePercent>99.8,`${track.key}: complete built-in coverage`);assert(painted>.98,`${track.key}: built-in screenshot colour`);
        const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(join(artifacts,`built-in-${track.key}.png`),Buffer.from(shot.data,'base64'));
      }
      await evaluate('auditOverlay.close();true');
    } else {
    for (const [width,height] of [[1440,1000],[390,844]]) for (const theme of ['dark','light']) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate(`document.documentElement.dataset.theme='${theme}';chart.updateTheme();true`);
      for (const key of ACTIVITY_FIXTURE_SIGNALS) {
        await measure(`${width}/${theme}/${key}`, `(() => {
          document.getElementById('chart-series-toggle').click();document.getElementById('chart-series-mode-series').click();
          document.querySelector('[data-series-key="${key}"]').click();return true;
        })()`, `document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.series==='${key}'`);
        await evaluate("document.getElementById('history').focus();document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));true");
        await until("Number(document.getElementById('history').dataset.zoom)===1&&!document.querySelector('.chart-gesture-preview')");
        const initial=await coverage(key);measurements.at(-1).bar=initial;
        if (!recordBroken) {assert(initial.coveragePercent>99.99,`${key}: recorded coverage survives the overview`);assert.equal(initial.border,'0px');}
        await evaluate("document.getElementById('chart-fullscreen').click();true");
        await until("document.querySelector('.history-panel').dataset.fullscreen==='true'&&!document.querySelector('.chart-gesture-preview')");
        const overview=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(artifacts,`${key}-${width}-${theme}-overview.png`),Buffer.from(overview.data,'base64'));
        const before=await coverage(key);
        measurements.at(-1).bar.paintedColumnFraction=await paintedColumns(key);
        if(!recordBroken)assert(measurements.at(-1).bar.paintedColumnFraction>.98,`${key}: real screenshot pixels show continuous recorded colour`);
        await measure(`${width}/${theme}/${key}/zoom`, "document.getElementById('history').focus();for(let i=0;i<8;i++)document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown',{key:'+',bubbles:true}));true",
          "Number(document.getElementById('history').dataset.zoom)>2&&document.getElementById('chart-detail-status').dataset.state==='idle'&&!document.querySelector('.chart-gesture-preview')");
        const zoomed=await coverage(key);measurements.at(-1).bar=zoomed;
        if (!recordBroken) {assert(zoomed.coveragePercent>99.99,`${key}: zoom preserves coverage`);assert(Math.abs(before.coveragePercent-zoomed.coveragePercent)<.01);}
        const shot=await send('Page.captureScreenshot',{format:'png'});
        writeFileSync(join(artifacts,`${key}-${width}-${theme}-zoomed.png`),Buffer.from(shot.data,'base64'));
        await evaluate("document.getElementById('chart-fullscreen').click();true");
        await until("document.querySelector('.history-panel').dataset.fullscreen==='false'");
      }
    }    }

  } else {
  for (const [name, start, end] of [['day', '2026-10-06', '2026-10-06'], ['week', '2026-09-30', '2026-10-06']]) {
    await measure(name, `setDates('${start}','${end}')`, `document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.rangeStart==='${start}'&&document.getElementById('history').dataset.rangeEnd==='${end}'`);
    await measure(`${name}/unchanged`, 'chart.refresh(fixtureStatus)', "document.getElementById('history').dataset.ready==='true'");
    await measure(`${name}/theme`, "document.documentElement.dataset.theme='light';chart.updateTheme()", "document.getElementById('history').dataset.ready==='true'");
  }
  await measure('garage/week', "chooseView('garage')", "document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.view==='garage'");
  if (!baseline) {
    await pause(100);
    assert(!requests.some(row => row.prefetch), 'No navigation prediction requests');
    const before = requests.length;
    await measure('garage/other-view', "chooseView('garage_control')", "document.getElementById('history').dataset.ready==='true'&&document.getElementById('history').dataset.view==='garage_control'");
    assert.equal(requests.length - before, 1, 'A different view is fetched only when selected');
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
