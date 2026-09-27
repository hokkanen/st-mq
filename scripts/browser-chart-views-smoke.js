// Isolated synthetic app and Chrome profile; never reads household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { CHART_VIEWS } from '../src/domain/chart-views.js';
import { EXPLORER_SERIES } from '../chart/series-explorer.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { addFireplace } from '../src/app/fireplace.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-views-browser-'));
const now = Date.parse('2026-09-07T12:00:00Z');
let app, socket, browser, id = 0;
const pending = new Map(), errors = [], screenshots = [];
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  addFireplace(app.store, 'simulated', { kg: 5, requestId: 'invented-chart-views-fire' }, now - 3 * 3600_000);
  app.store.observation({ signal: 'alarm_code', value: 13, unit: 'code', source: 'simulation',
    device: 'invented-chart-alarm', sourceTime: now - 2 * 3600_000, receivedAt: now - 2 * 3600_000,
    quality: ['simulated'], raw: {} });
  app.store.transaction(() => {
    for (let index = 0; index < 180; index++) {
      const at = now - (180 - index) * 60_000;
      for (const [signal, value, unit] of [
        ['garage_temperature_2', 12 + Math.sin(index / 16) * .6, 'degC'],
        ['garage_native_indoor_temperature', 14 + Math.sin(index / 18), 'degC'],
        ['garage_compressor_frequency', index % 50 < 35 ? 24 + index % 17 : 0, 'Hz'],
        ['garage_compressor_active', index % 50 < 35 ? 1 : 0, 'state'],
        ['garage_native_defrost', index % 60 > 55 ? 1 : 0, 'state'],
        ['garage_door1_open', index % 70 > 65 ? 1 : 0, 'state'],
        ['garage_door2_open', 0, 'state'],
        ['bedroom_temperature', 20 + Math.sin(index / 27) * .2, 'degC'],
        ['downstairs_temperature', 20.5 + Math.sin(index / 19) * .4, 'degC'],
        ['supply_temperature', 34 + Math.sin(index / 18) * 3, 'degC'],
        ['return_temperature', 30 + Math.sin(index / 18) * 2, 'degC'],
        ['heating_setpoint', 35 + Math.floor(index / 40), 'degC'],
        ['caravan_temperature', 17 + Math.sin(index / 16), 'degC'],
        ['caravan_humidity', 65 + Math.sin(index / 20) * 5, '%'],
        ['caravan_dehumidifier_running_state', index % 50 < 35 ? 4 : 0, 'state'],
      ]) app.engine.recorder.record({ signal, value, unit, source: 'simulation', device: 'invented-chart-views-probe',
        sourceTime: at, receivedAt: at, quality: ['simulated'], raw: { reportIntervalMs: 60_000 } });
    }
  });
  let endpoint = process.argv[2];
  if (!endpoint) {
    const profile = join(directory, 'chrome'); mkdirSync(profile);
    browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    let launchError; browser.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 200 && !endpoint; attempt++) {
      if (launchError) throw launchError;
      try {
        const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
        if (port) endpoint = `http://127.0.0.1:${port}`;
      } catch {}
      if (!endpoint) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert(endpoint, 'Isolated Chromium DevTools listener started');
  }
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timeout ${method}`)); }, 15000);
    pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Timed out: ${expression}; browser errors: ${JSON.stringify(errors)}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const choose = async (id, value) => {
    await evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)});
      input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change')); return true; })()`);
    const expected = id === 'chart-view' ? `dataset.view === ${JSON.stringify(value)}` : `dataset.series === ${JSON.stringify(value)}`;
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').${expected}`);
    await settle();
  };
  const toggle = async key => {
    await evaluate(`document.querySelector('[data-chart-key="${key}"]').click(); true`); await settle();
  };
  const shown = key => evaluate(`document.querySelector('[data-chart-key="${key}"]')?.getAttribute('aria-pressed') === 'true'`);
  const capture = async name => {
    await settle(); mkdirSync('var', { recursive: true });
    const path = `var/chart-views-${name}.png`, screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(screenshot.data, 'base64')); screenshots.push(path);
  };
  const viewport = async (width, height, touch = false) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: 5 });
    await settle();
  };
  const checkFits = async label => {
    assert.equal(await evaluate(`(() => {
      const panel = document.querySelector('.history-panel'), bounds = panel.getBoundingClientRect();
      const canvas = document.getElementById('history').getBoundingClientRect();
      const select = document.getElementById('chart-view').getBoundingClientRect();
      const exit = document.getElementById('chart-fullscreen').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth + 1 && bounds.left >= -1 && bounds.right <= innerWidth + 1
        && select.width >= 80 && select.right <= exit.left + 1 && exit.right <= innerWidth + 1 && canvas.height >= 80
        && (panel.dataset.fullscreen !== 'true' || canvas.bottom <= innerHeight && bounds.bottom <= innerHeight + 1);
    })()`), true, `${label}: chart controls and plot fit without horizontal overflow`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await viewport(1280, 1100);
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('chart-view').value"), 'power');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-view option')].map(option => option.value)"),
    [...CHART_VIEWS.map(view => view.key), 'explorer']);
  for (const view of CHART_VIEWS) {
    await choose('chart-view', view.key);
    assert.equal(await evaluate("document.getElementById('chart-view-description').textContent"), view.description);
    const legend = await evaluate("[...document.querySelectorAll('[data-chart-key]')].map(item => item.dataset.chartKey)");
    assert.equal(new Set(legend).size, legend.length, `${view.key}: each selectable series or activity row appears once`);
    for (const key of [...view.leftSignals, ...view.rightSignals, ...view.tracks, 'all_in_price', 'spot_price'])
      assert(legend.includes(key), `${view.key}: ${key} stays selectable`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-activity [data-activity-key]')].map(row => row.dataset.activityKey)"), view.tracks);
    assert.equal(await evaluate("document.getElementById('chart-explorer').hidden"), true);
  }
  await choose('chart-view', 'power');
  for (const [key, pattern] of [['property_power', 'solid'], ['outdoor_temperature', 'dashed'], ['outdoor_forecast', 'dash-dot'], ['all_in_price', 'dotted']])
    assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch').dataset.pattern`), pattern);
  for (const key of ['charger_power', 'charger2_power']) assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch').dataset.kind`), 'fill');
  assert.notEqual(await evaluate("document.querySelector('[data-chart-key=auxiliary_power] .chart-legend-swatch').dataset.kind"), 'fill');
  await toggle('outdoor_temperature'); await toggle('spot_price');
  assert.equal(await shown('outdoor_temperature'), false); assert.equal(await shown('spot_price'), false);
  await choose('chart-view', 'weather');
  assert.equal(await shown('outdoor_temperature'), true, 'Temperature visibility belongs to the selected view');
  assert.equal(await shown('spot_price'), false, 'Price visibility is shared across views');
  await choose('chart-view', 'power');
  assert.equal(await shown('outdoor_temperature'), false, 'Returning restores that view’s deliberate choices');
  await evaluate("document.querySelector('.chart-legend-reset').click(); true"); await settle();
  assert.equal(await shown('outdoor_temperature'), true);
  assert.equal(await shown('spot_price'), false, 'Reset view preserves shared price choices');
  await toggle('spot_price');

  await choose('chart-view', 'garage');
  await toggle('garage_native_indoor_temperature');
  assert.equal(await shown('garage_native_indoor_temperature'), true);
  assert.match(await evaluate("document.getElementById('chart-notes').textContent"), /native readback.*not an independent protection probe/);
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('garage-dark');
  await choose('chart-view', 'explorer');
  assert.equal(await evaluate("document.getElementById('chart-explorer').hidden"), false);
  assert.equal(await evaluate("document.querySelectorAll('#chart-series option').length"), EXPLORER_SERIES.length);
  await evaluate("document.getElementById('chart-series-search').value='pump interpreted'; document.getElementById('chart-series-search').dispatchEvent(new Event('input')); true");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series option')].map(option => option.value)"), ['garage_native_indoor_temperature']);
  await choose('chart-series', 'garage_native_indoor_temperature');
  assert.match(await evaluate("document.getElementById('chart-view-description').textContent"), /Recorded temperature/);
  await evaluate("document.getElementById('chart-series-search').value='no-synthetic-series-matches'; document.getElementById('chart-series-search').dispatchEvent(new Event('input')); true");
  assert.equal(await evaluate("document.querySelectorAll('#chart-series option:not(:disabled)').length"), 0);
  assert.match(await evaluate("document.getElementById('chart-series').textContent"), /No matching series/);
  assert.equal(await evaluate("document.getElementById('history').dataset.ready"), 'true', 'An empty search does not discard the displayed chart');
  await evaluate("document.getElementById('chart-series-search').value=''; document.getElementById('chart-series-search').dispatchEvent(new Event('input')); true");
  await choose('chart-series', 'garage_door1_open');
  assert.equal(await evaluate("document.querySelector('#chart-activity [data-activity-key]').dataset.activityKey"), 'garage_door1_open');
  assert.equal(await evaluate("document.querySelectorAll('#chart-activity .mode-segment').length > 0"), true, 'Recorded state explorer has inspectable intervals');
  await choose('chart-series', 'alarm_code');
  assert.equal(await evaluate("document.querySelectorAll('#chart-activity .mode-segment[data-kind=point]').length"), 1,
    'An isolated state report remains visible as a point without inventing duration');
  assert.match(await evaluate("document.querySelector('#chart-activity .mode-segment').title"), /Value 13.*duration unknown/);

  await choose('chart-view', 'power');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true"); await settle();
  const cursorPoint = await evaluate(`(() => {
    const canvas = document.getElementById('history').getBoundingClientRect();
    const track = document.querySelector('#operating-modes .mode-track').getBoundingClientRect();
    return { x: track.left + track.width * .47, y: canvas.top + canvas.height * .45 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cursorPoint }); await settle();
  await until("document.querySelector('.chart-crosshair-extension')?.hidden === false");
  const cursorBounds = await evaluate(`(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; };
    const rows = [...document.querySelectorAll('#chart-activity .mode-history')].filter(row => !row.hidden);
    const panel = document.querySelector('.history-panel'), cursor = document.querySelector('.chart-crosshair-extension');
    return {cursor:rect(cursor),style:cursor.style.cssText,panel:rect(panel),scrollTop:panel.scrollTop,position:getComputedStyle(panel).position,offsetParent:cursor.offsetParent?.className,last:rect(rows.at(-1)),
      track:rect(rows[0].querySelector('.mode-track')),legend:rect(document.querySelector('.chart-legend-panel'))};
  })()`);
  assert.equal(await evaluate(`(() => {
    const cursor = document.querySelector('.chart-crosshair-extension').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#chart-activity .mode-history')].filter(row => !row.hidden);
    const last = rows.at(-1).getBoundingClientRect(), track = rows[0].querySelector('.mode-track').getBoundingClientRect();
    const legend = document.querySelector('.chart-legend-panel').getBoundingClientRect();
    return Math.abs(cursor.left - ${cursorPoint.x}) < 2 && cursor.left >= track.left && cursor.right <= track.right
      && Math.abs(cursor.bottom - last.bottom) < 2 && cursor.bottom <= legend.top;
  })()`), true, `Crosshair remains inside the time axis and stops at the last active row: ${JSON.stringify(cursorBounds)}`);
  await capture('power-dark-cursor');
  const rowY = await evaluate("(() => { const rect = document.getElementById('dhwr-history').getBoundingClientRect(); return rect.top + rect.height / 2; })()");
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cursorPoint.x, y: rowY }); await settle();
  assert.equal(await evaluate("document.querySelector('.chart-crosshair-readout').hidden"), false);
  assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /DHWR/);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: rowY }); await settle();
  assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension').hidden"), true);
  await evaluate("document.getElementById('theme-toggle').click(); true"); await settle();
  await capture('power-light');
  await evaluate("document.getElementById('theme-toggle').click(); true");

  for (const [width, height] of [[390, 844], [320, 568]]) {
    await viewport(width, height, true);
    await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true"); await settle();
    await checkFits(`${width}px dashboard`);
    await evaluate("document.getElementById('chart-fullscreen').click(); true");
    await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'"); await settle();
    await checkFits(`${width}px fullscreen`);
    const point = await evaluate("(() => { const r = document.getElementById('history').getBoundingClientRect(); return {x:r.left+r.width*.48,y:r.top+r.height*.45}; })()");
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension').hidden"), false, `${width}px fullscreen: a tap keeps the time cursor visible`);
    await capture(`mobile-${width}-dark`);
    await evaluate("document.getElementById('history').focus(); document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown', {key:'+',bubbles:true})); true");
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension').hidden"), true, 'Keyboard zoom clears the old time cursor before gesture capture');
    await until("document.querySelector('.chart-gesture-preview') === null");
    await choose('chart-view', 'explorer');
    await checkFits(`${width}px fullscreen explorer`);
    await capture(`explorer-${width}-dark`);
    await choose('chart-view', 'power');
    await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  }
  for (const [width, height] of [[1280, 1100], [390, 844]]) {
    await viewport(width, height, width < 600);
    for (const theme of ['dark', 'light']) {
      if (await evaluate('document.documentElement.dataset.theme') !== theme)
        await evaluate("document.getElementById('theme-toggle').click(); true");
      for (const key of ['power', 'garage', 'heating_water', 'temperatures', 'explorer']) {
        await choose('chart-view', key);
        if (key === 'explorer') await choose('chart-series', 'garage_native_indoor_temperature');
        await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
        await checkFits(`${width}px ${theme} ${key}`);
        await capture(`${key}-${width}-${theme}`);
      }
      await choose('chart-view', 'power');
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
      await checkFits(`${width}px ${theme} fullscreen`);
      await capture(`fullscreen-${width}-${theme}`);
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
    }
  }
  assert.deepEqual(errors, [], 'All view selections and cursor interactions have no uncaught browser exceptions');
  console.log(`Chart views browser checks passed: ${CHART_VIEWS.length} named views, ${EXPLORER_SERIES.length} explorer choices, visibility isolation, garage readback, crosshair bounds and touch, dark/light themes, and 320/390px fullscreen layouts.`);
  console.log(`Screenshots: ${screenshots.join(', ')}`);
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
