// Run after npm run build. Every provider/status/action below is synthetic;
// the isolated application and disposable browser never load household config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { ChargingAllowanceHistory } from '../../src/charging/allowance-history.js';
import { recordChargingSessionCheck } from '../../src/app/charging-session-checks.js';
import { seedChartFixture } from '../../scripts/lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-current-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-current-screenshots-'));
const now = Date.parse('2026-09-30T12:00:00Z');
const outage = { from: now - 90 * 60_000, to: now - 75 * 60_000 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  seedChartFixture(app.store, now);
  const recorder = new ChargingAllowanceHistory({ store: app.store, input: 'simulated' });
  const states = [['unrestricted', 16], ['limited', 8], ['limited', 0], ['fallback', 12], ['fallback', 0], ['unknown', null]];
  for (let at = now - 6 * 3600_000; at <= now; at += 20_000) {
    const index = Math.min(5, Math.floor((at - now + 6 * 3600_000) / 3600_000));
    for (const chargerId of ['charger1', 'charger2']) {
      if (chargerId === 'charger1' && at >= outage.from && at < outage.to) continue;
      const [mode, allowanceA] = chargerId === 'charger1' ? index < 3 ? ['unrestricted', 16] : ['limited', 10.5] : states[index];
      recorder.observe({ chargerId, association: (chargerId === 'charger1' ? 'a' : 'b').repeat(64), status: {
        mode, allowanceA, maximumCurrentA: 16, reportedAllowanceA: null,
        reason: mode === 'fallback' ? 'feed-unavailable' : 'property-headroom',
        source: chargerId === 'charger1' ? 'easee-equalizer' : 'st-mq-load-balancing',
        measuredAt: at, receivedAt: at, sourceTimes: [], sourceEpoch: null, limiter: null,
      } }, at);
    }
  }
  recordChargingSessionCheck(app.store, { source: 'easee', sessionKey: 'synthetic-native-check',
    start: now - 3 * 3600_000, end: now - 3600_000, estimatedKwh: 12.2, referenceKwh: 12,
    complete: true, quality: [] });
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; browser errors: ${errors.join(', ')}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const keyPress = async key => {
    const windowsVirtualKeyCode = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode }); await settle();
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    localStorage.setItem('home-energy-chart-views', JSON.stringify({view:'charging_currents',views:{},prices:{}}));
    window.currentCharts = []; window.currentStrokes = [];
    const fetchOriginal = window.fetch.bind(window), stroke = CanvasRenderingContext2D.prototype.stroke;
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      if (String(args[0]).includes('/api/chart?')) window.currentCharts.push(await response.clone().json());
      return response;
    };
    CanvasRenderingContext2D.prototype.stroke = function(...args) {
      if (this.canvas.id === 'history') {
        window.currentStrokes.push({color:this.strokeStyle,dash:this.getLineDash()});
        if (window.currentStrokes.length > 5000) window.currentStrokes.splice(0,1000);
      }
      return stroke.apply(this,args);
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('history')?.dataset.view === 'charging_currents' && document.getElementById('history').dataset.ready === 'true'");
  await until("window.currentCharts.some(row => row.series?.ev2_current_fallback?.some(point => point.y === 12))");
  assert.equal(await evaluate("document.querySelector('[data-activity-key=shellyLimiter]') !== null"), false);
  const payload = await evaluate("window.currentCharts.find(row => row.view === 'charging_currents' && row.series?.ev2_current_fallback?.some(point => point.y === 12))");
  for (const key of ['property_current_max','ev1_current_allowance','ev2_current_allowance','ev2_current_fallback'])
    assert(payload.series[key].some(point => Number.isFinite(point.y)), `${key}: real chart response has recorded evidence`);
  assert(payload.series.ev2_current_allowance.some(point => point.y === 0));
  assert(payload.series.ev2_current_fallback.some(point => point.y === 0));
  assert(payload.series.ev2_current_fallback.every(point => point.y === null || point.y >= 0));
  const firstAllowance = payload.series.ev1_current_allowance;
  assert(firstAllowance.some(point => point.y === 16));
  assert(firstAllowance.some(point => point.y === 10.5 && point.x < outage.from));
  assert(firstAllowance.some(point => point.y === 10.5 && point.x >= outage.to));
  assert(firstAllowance.some(point => point.y === null && point.x >= outage.from && point.x < outage.to));
  assert(firstAllowance.filter(point => point.x >= outage.from && point.x < outage.to).every(point => point.y === null),
    'Charger 1 source outage cannot be bridged by its allowance');
  for (const signal of ['ev2_current_allowance', 'ev2_current_fallback']) {
    const missing = payload.series[signal].filter(point => point.x >= now - 3600_000);
    assert(missing.length > 0 && missing.every(point => point.y === null), `${signal}: unknown source evidence remains a gap`);
  }
  assert(!Object.keys(payload.series).some(key => key.includes('session')));
  assert(Object.hasOwn(payload.series, 'outdoor_temperature'));
  assert.equal(payload.limiterHistory, undefined);
  await evaluate("document.querySelector('[data-chart-key=outdoor_temperature]').click(); true");
  const choose = async (kind, name) => {
    await evaluate("document.getElementById('chart-series-toggle').click(); true");
    await until("document.getElementById('chart-series-picker').open");
    await evaluate(`document.getElementById('chart-series-mode-${kind === 'view' ? 'views' : 'series'}').click(); true`);
    assert.equal(await evaluate("document.querySelector('[data-view-key=session_checks]') !== null"), false);
    await evaluate(`document.querySelector('[data-${kind}-key=${name}]').click(); true`);
    await until(`document.getElementById('history').dataset.${kind} === '${name}' && document.getElementById('history').dataset.ready === 'true'`);
    await settle();
  };
  for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}'); document.querySelector('.history-panel').scrollIntoView({block:'center'}); true`);
    await settle();
    const style = await evaluate(`(() => {
      const key='ev2_current_fallback', swatch=document.querySelector('[data-chart-key='+key+'] .chart-legend-swatch');
      const context=document.createElement('canvas').getContext('2d'); context.strokeStyle=getComputedStyle(swatch).color;
      const matching=window.currentStrokes.filter(row=>row.color===context.strokeStyle);
      context.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--chart-learning').trim();
      return {pattern:swatch.dataset.pattern,color:getComputedStyle(swatch).color,purple:context.strokeStyle,
        stroke:matching.some(row=>JSON.stringify(row.dash)==='[8,3,2,3]'),
        ordinary:['property_current_max','ev1_current_allowance','ev2_current_allowance'].map(key=> {
          const item=document.querySelector('[data-chart-key='+key+'] .chart-legend-swatch');
          const line=document.createElement('canvas').getContext('2d'); line.strokeStyle=getComputedStyle(item).color;
          return {pattern:item.dataset.pattern,color:line.strokeStyle,
            stroke:window.currentStrokes.some(row=>row.color===line.strokeStyle&&row.dash.length===0)};
        }),
        temperature:document.querySelector('[data-chart-key=outdoor_temperature]').dataset.axis,
        colorMatch:matching.some(row=>row.color===context.strokeStyle)};
    })()`);
    assert.equal(style.pattern, 'dash-dot'); assert.equal(style.stroke, true, `${theme} ${width}: fallback is drawn dash-dot`);
    assert.equal(style.colorMatch, true, `${theme} ${width}: fallback uses theme purple`);
    assert.deepEqual(style.ordinary.map(row => row.pattern), ['solid','solid','solid']);
    assert(style.ordinary.every(row => row.stroke), `${theme} ${width}: property and both allowance lines are drawn`);
    assert.equal(new Set(style.ordinary.map(row => row.color)).size, 3, 'Both chargers and property have distinct line colors');
    assert.equal(style.temperature, 'right');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} ${width}px fits`);
    assert.equal(await evaluate("document.querySelector('[data-activity-key=shellyLimiter]') !== null"), false);
    const shot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(artifacts,`charging-currents-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
  }
  for (const [kind,name] of [['view','power'],['view','phases'],['series','charger2_power']]) {
    await choose(kind,name);
    assert.equal(await evaluate("document.querySelector('[data-activity-key=shellyLimiter]') !== null"), false, `${name}: retired balancing strip absent`);
  }
  await choose('series','ev1_session_energy_check');
  await until("window.currentCharts.some(row=>row.left==='ev1_session_energy_check'&&row.series?.ev1_session_energy_check?.some(point=>point.y===12))");
  assert.equal(await evaluate("document.querySelector('[data-chart-key=ev1_session_energy_check] .chart-legend-swatch').dataset.kind"), 'session');
  await choose('view', 'charging_currents');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=ev1_current_allowance]').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=ev2_current_allowance]').getAttribute('aria-pressed')"), 'true');
  assert.deepEqual(errors, []);
  console.log(`Charging currents browser checks passed: native and controller allowances, zero and fallback zero, purple dash-dot canvas strokes, temperature context, retired strips absent, C1 All series session check, 320/390/1440px dark and light. Synthetic screenshots: ${artifacts}`);
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
