// Actual chart, provider panel and HTTP route with invented data, no live acquisition.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-price-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-price-screenshots-'));
const now = Date.now(), hour = 3_600_000, startAt = Math.floor(now / hour) * hour;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;
try {
  const configuration = join(directory, 'fixture.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'offline' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  const row = (at, value) => ({ start: at, end: at + hour, spotCtPerKwh: value, unit: 'c/kWh', vatIncluded: false });
  app.store.setState('provider:market', { source: 'elering', fetchedAt: now,
    intervals: Array.from({ length: 14 }, (_, i) => ({ ...row(startAt + (i - 12) * hour, 8 + i % 3), source: 'elering' })) });
  app.store.setState('provider:weather', { source: 'fmi', fetchedAt: now - 30 * 60_000,
    forecast: Array.from({ length: 6 }, (_, index) => ({ start: startAt + index * hour, end: startAt + (index + 1) * hour,
      source: 'fmi', outdoorC: 4, solarRadiationWm2: 0, issuedAt: now - 2 * hour,
      issuedAtBasis: 'provider-result-time', fetchedAt: now - 30 * 60_000,
      solar: index % 2 ? { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: now - 15 * 60_000 } : { basis: 'forecast' } })) });
  app.store.setState('providers:health', { market: { source: 'elering', status: 'ok', lastSuccessAt: now },
    weather: { source: 'fmi', status: 'fallback', lastSuccessAt: now, acquisition: { selected: 'fmi', solarSource: 'mixed' } } });
  app.store.setState('contract:offline', { periods: [{ from: '2026-01-01T00:00:00Z', marginCtPerKwh: 1, taxCtPerKwh: 2,
    vatRate: .2, tariff: 'day-night', transferRates: { vatIncluded: true, dayCtPerKwh: 3, nightCtPerKwh: 1,
      winterDayCtPerKwh: 4, otherCtPerKwh: 2 } }] });
  const forecast = { enabled: true, available: true, status: 'ok', source: 'energypriceforecast', fetchedAt: now,
    generatedAt: now, modelUpdatedAt: now - hour, expiresAt: now + hour, horizonEnd: now + 48 * hour,
    intervals: Array.from({ length: 47 }, (_, i) => ({ ...row(startAt + (i + 1) * hour, i % 5 - 1),
      source: 'energypriceforecast', predicted: true, nativeStart: startAt + (i + 1) * hour,
      nativeEnd: startAt + (i + 2) * hour, nativeResolutionMinutes: 60 })).filter((_, i) => i !== 7) };
  app.engine.electricityForecast = { snapshot: () => forecast, status: () => {
    const { intervals, ...health } = forecast; return health;
  } };
  await app.engine.tick();
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let n = 0; n < 200 && !port; n++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let n = 0; n < 200; n++) { if (await evaluate(expression)) return; await pause(30); }
    throw new Error(`UI timeout: ${expression}; ${JSON.stringify(errors)}; ${JSON.stringify(await evaluate("({requests:window.priceRequests,strokes:window.priceStrokes?.slice(-15),notes:document.getElementById('chart-notes')?.textContent,status:document.getElementById('chart-status')?.textContent})"))}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    localStorage.setItem('home-energy-chart-views', JSON.stringify({view:'power',views:{},prices:{spot_price:true,all_in_price:true}}));
    window.priceStrokes=[]; window.priceRequests=[];
    const original=window.fetch.bind(window), stroke=CanvasRenderingContext2D.prototype.stroke;
    window.fetch=async (...args)=>{window.priceRequests.push(String(args[0]));
      if(window.holdStatus && String(args[0]).includes('/api/status'))return new Promise(()=>{});
      return original(...args);};
    CanvasRenderingContext2D.prototype.stroke=function(...args){
      if(this.canvas.id==='history')window.priceStrokes.push({color:this.strokeStyle,dash:this.getLineDash()});
      if(window.priceStrokes.length>5000)window.priceStrokes.splice(0,1000);
      return stroke.apply(this,args);
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('history')?.dataset.ready==='true'");
  await until("window.priceStrokes.some(row=>JSON.stringify(row.dash)==='[1,8]')");
  const initialPresets = await evaluate("[...document.querySelectorAll('[id^=range-]')].map(node=>node.id)");
  assert(!initialPresets.some(id => /48|forecast/.test(id)));
  assert.equal(await evaluate("document.querySelectorAll('.charging-flexibility-entry:not([hidden])').length"), 0);
  assert.equal(await evaluate("document.querySelector('[data-provider=market] [data-series=electricity_price_forecast]')?.textContent.includes('Energy Price Forecast EU')"), true);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-provider=market] .provider-source-title')].map(node=>node.textContent)"), ['Prices', 'Price forecast']);
  assert.equal(await evaluate("document.querySelector('[data-provider=market] [data-source-section=forecast] .provider-source-description').textContent.includes('Hourly estimates')"), true);
  assert.equal(await evaluate("document.querySelector('[data-series=electricity_price_forecast] .provider-series-description').hidden"), true);
  assert.equal(await evaluate("document.querySelectorAll('[data-provider=market] .provider-series-source a').length"), 0);
  assert.equal(await evaluate("document.querySelector('[data-series=electricity_price_forecast] .provider-series-source').textContent.includes('Fetched')"), true);
  assert.equal(await evaluate("document.querySelector('[data-series=electricity_price_forecast] .provider-series-source').textContent.includes('Model updated')"), true);
  assert.equal(await evaluate("document.querySelector('[data-series=outdoor_forecast] .provider-series-source').textContent.includes('30 min ago')"), true);
  assert.equal(await evaluate("document.querySelector('[data-series=\"solar_radiation,solar_forecast\"] .provider-series-source').textContent.includes('Open-Meteo: Fetched')"), true);
  for (const theme of ['dark', 'light']) for (const width of [280, 320, 390, 1280]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.priceStrokes=[]; window.homeEnergyTheme.setTheme('${theme}'); document.querySelector('.history-panel').scrollIntoView({block:'center'}); true`);
    await until("window.priceStrokes.some(row=>JSON.stringify(row.dash)==='[1,8]')");
    const styles = await evaluate(`['spot','price'].map(name=>{
      const context=document.createElement('canvas').getContext('2d');
      context.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--chart-'+name).trim();
      return ['[1,3]','[1,8]'].map(dash=>window.priceStrokes.some(row=>row.color===context.strokeStyle&&JSON.stringify(row.dash)===dash));
    })`);
    assert(styles.every(row => row.every(Boolean)), `${theme}/${width}: same price colors with published and sparse forecast strokes`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    const image = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `forecast-${theme}-${width}.png`), Buffer.from(image.data, 'base64'));
    for (const provider of ['market', 'main-temperatures']) {
      await evaluate(`document.querySelector('[data-provider=${provider}] .provider-fold').open=true;
        document.querySelector('[data-provider=${provider}]').scrollIntoView({block:'start'});
        new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const providerImage = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `${provider}-${theme}-${width}.png`), Buffer.from(providerImage.data, 'base64'));
      assert.equal(await evaluate(`document.querySelector('[data-provider=${provider}] .provider-source-title').getBoundingClientRect().height>0`), true);
      assert.equal(await evaluate(`(()=>{const node=document.querySelector('[data-provider=${provider}] .provider-body');
        return node.scrollWidth<=node.clientWidth;})()`), true,
        `${theme}/${width}: ${provider} forecast metadata fits the fold; screenshot ${artifacts}`);
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      await evaluate(`document.querySelector('[data-provider=${provider}] .provider-fold').open=false; true`);
    }
  }
  await evaluate("document.getElementById('range-tomorrow').click(); true");
  await until("document.getElementById('history').dataset.ready==='true' && document.getElementById('range-tomorrow').getAttribute('aria-pressed')==='true'");
  await evaluate("document.querySelector('[data-chart-key=spot_price]').click(); document.querySelector('[data-chart-key=all_in_price]').click(); true");
  await until("document.querySelector('[data-chart-key=all_in_price]').getAttribute('aria-pressed')==='false'");
  assert.equal(await evaluate("document.querySelector('[data-chart-key=spot_price]').getAttribute('aria-pressed')"), 'false');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[id^=range-]')].map(node=>node.id)"), initialPresets);
  assert.equal(await evaluate("window.priceRequests.filter(path=>path.includes('electricity-forecast')).length"), 1, 'No provider requests on chart navigation');
  await evaluate("document.querySelector('[data-chart-key=spot_price]').click(); document.querySelector('[data-chart-key=all_in_price]').click(); true");
  await until("document.getElementById('chart-notes').textContent.includes('Sparse dots')");
  await evaluate("window.holdStatus=true; new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await evaluate("window.priceStrokes=[]; const clock=Date.now.bind(Date); Date.now=()=>clock()+7200000; document.dispatchEvent(new Event('visibilitychange')); true");
  await until("!document.getElementById('chart-notes').textContent.includes('Sparse dots')");
  assert.equal(await evaluate("window.priceStrokes.some(row=>JSON.stringify(row.dash)==='[1,8]')"), false,
    'Background return expires forecast without a successful status refresh');
  assert.deepEqual(errors, []);
  console.log(`Forecast browser checks passed: no cars, existing date controls, real sparse canvas strokes and shared price colors/toggles, price sections and plain attribution, original weather/solar acquisition ages, offline/background expiry, 280/320/390/1280px in both themes. Screenshots: ${artifacts}`);
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true });
}
