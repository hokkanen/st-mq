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
import { appendGarageEntry } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';

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
  for (let index = 0; index < 4; index++) app.store.observation({
    signal: 'compressor_hours', value: 800 + index, unit: 'h', source: 'simulation', device: 'invented-chart-runtime',
    sourceTime: now - (6 - index) * 3600_000, receivedAt: now - (6 - index) * 3600_000, quality: ['simulated'], raw: {},
  });
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
    // Independent, overlapping phase-energy evidence exercises charger fills at
    // unequal currents. These are allocated phase estimates, never total energy.
    for (const prefix of ['ev1', 'ev2']) for (let index = 0; index < 12; index++) {
      const start = now - (90 - index * 5) * 60_000, end = start + 5 * 60_000;
      for (let phase = 1; phase <= 3; phase++) app.store.observation({
        signal: `${prefix}_energy_l${phase}`, value: (prefix === 'ev1' ? 5 + phase : 2 + phase) * .23 / 12,
        unit: 'kWh', source: 'simulation', device: `invented-chart-${prefix}`, sourceTime: end, receivedAt: end,
        quality: ['estimated', 'simulated', 'phase_allocation_estimated'],
        raw: { intervalStart: start, intervalEnd: end, durationMs: end - start, basis: 'integrated-power-phase-allocation' },
      });
    }
    for (let index = 0; index < 6; index++) {
      const start = now - (120 - index * 10) * 60_000, end = start + 10 * 60_000;
      app.store.observation({ signal: 'caravan_energy', value: .1, unit: 'kWh', source: 'simulation',
        device: 'invented-chart-caravan-meter', sourceTime: end, receivedAt: end, quality: ['simulated'],
        raw: { intervalStart: start, intervalEnd: end, durationMs: end - start, basis: 'meter-counter-delta' } });
    }
    for (let index = 0; index < 6; index++) {
      const at = now - (30 - index) * 60_000;
      appendGarageEntry(app.store, 'simulated', 'sample', {
        at, rearAt: at, rearC: 12, frontAt: at, frontC: 11.5, outdoorAt: at, outdoorC: 3,
        available: [true, false, false, true, null, true][index], managedPause: [false, true, false, false, null, false][index],
        powerKw: .4, powerQuality: 'simulated', ev1Kw: 0, ev2Kw: 0,
      }, garageSettings(), at);
    }
  });
  const periodicFixture = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?view=temperatures&start=2026-09-07&end=2026-09-07&points=800`).then(response => response.json());
  for (const key of ['bedroom_temperature', 'downstairs_temperature']) {
    assert(periodicFixture.series[key].some(point => point.periodicCoverage && point.displayBoundary),
      `${key}: the fixture contains periodic hold endpoints, the geometry regression being tested`);
    assert(new Set(periodicFixture.series[key].filter(point => Number.isFinite(point.y)).map(point => point.y)).size > 10,
      `${key}: source readings change gradually across enough reports to inspect their curve`);
  }
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
  const pickerOpen = () => evaluate("document.getElementById('chart-series-picker').open");
  const openPicker = async () => {
    if (!await pickerOpen()) await evaluate("document.getElementById('chart-series-toggle').click(); true");
    await until("document.getElementById('chart-series-picker').open"); await settle();
  };
  const searchSeries = async query => {
    await openPicker();
    await evaluate(`(() => { const input = document.getElementById('chart-series-search');
      input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input')); return true; })()`);
    await settle();
  };
  const pressKey = async key => {
    const code = { Escape: 'Escape', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', Enter: 'Enter', Tab: 'Tab' }[key];
    const windowsVirtualKeyCode = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }); await settle();
  };
  const choose = async (id, value) => {
    if (id === 'chart-series') {
      await searchSeries('');
      await evaluate(`document.querySelector('#chart-series [data-series-key="${value}"]').click(); true`);
      await until("!document.getElementById('chart-series-picker').open");
    } else {
      // Native selects cannot be activated beneath a modal dialog.
      if (await pickerOpen()) await pressKey('Escape');
      await evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)});
        input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change')); return true; })()`);
    }
    const expected = id === 'chart-view' ? `dataset.view === ${JSON.stringify(value)}` : `dataset.series === ${JSON.stringify(value)}`;
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').${expected}`);
    await settle();
  };
  const toggle = async key => {
    await evaluate(`document.querySelector('[data-chart-key="${key}"]').click(); true`); await settle();
  };
  const shown = key => evaluate(`document.querySelector('[data-chart-key="${key}"]')?.getAttribute('aria-pressed') === 'true'`);
  const drawnPaths = key => evaluate(`(() => {
    const swatch = document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch');
    const context = document.createElement('canvas').getContext('2d');
    context.strokeStyle = getComputedStyle(swatch).color;
    return window.chartDrawing.filter(row => row.method === 'stroke' && row.color === context.strokeStyle);
  })()`);
  const checkTemperatureCurve = async key => {
    const paths = await drawnPaths(key), curves = [], jumps = [];
    for (const path of paths) {
      let previous;
      for (const command of path.path) {
        if (command.method === 'moveTo') previous = command.args;
        else if (['lineTo', 'bezierCurveTo'].includes(command.method)) {
          const end = command.args.slice(-2);
          if (previous) {
            const dx = end[0] - previous[0], dy = end[1] - previous[1];
            if (Math.abs(dx) < .01 && Math.abs(dy) > .01) jumps.push({ dx, dy });
            if (command.method === 'bezierCurveTo' && Math.abs(dx) > .01 && Math.abs(dy) > .01) {
              const [cx, cy] = command.args;
              // The control point must depart from the endpoint chord: merely
              // calling bezierCurveTo with a straight segment proves nothing.
              if (Math.abs((cx - previous[0]) * dy - (cy - previous[1]) * dx) > .00001)
                curves.push(command);
            }
          }
          previous = end;
        }
      }
    }
    assert(curves.length >= 8, `${key}: real canvas contains curved temperature segments (${curves.length})`);
    assert.equal(jumps.length, 0, `${key}: artificial periodic hold edges do not create near-vertical stair steps`);
  };
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
  const checkPickerFits = async label => {
    assert.equal(await evaluate(`(() => {
      const modal = document.getElementById('chart-series-picker').getBoundingClientRect();
      const list = document.getElementById('chart-series'), rows = list.querySelectorAll('[role=option]');
      return modal.left >= -1 && modal.top >= -1 && modal.right <= innerWidth + 1 && modal.bottom <= innerHeight + 1
        && list.clientHeight >= 100 && rows.length > 0 && rows[0].getBoundingClientRect().height >= 40
        && document.documentElement.scrollWidth <= innerWidth + 1;
    })()`), true, `${label}: searchable picker stays inside the viewport with usable result targets`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Observe the real canvas drawing operations, without importing chart internals
  // or adding production hooks. Keep only the current frame of the history plot.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const proto = CanvasRenderingContext2D.prototype, state = new WeakMap();
    window.chartDrawing = []; window.chartLabels = [];
    for (const method of ['moveTo', 'lineTo', 'bezierCurveTo', 'closePath']) {
      const original = Path2D.prototype[method];
      Path2D.prototype[method] = function(...args) {
        const path = state.get(this) ?? []; state.set(this, path); path.push({ method, args });
        return original.apply(this, args);
      };
    }
    for (const method of ['beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'arc', 'closePath', 'stroke', 'fill', 'fillText', 'clearRect']) {
      const original = proto[method];
      proto[method] = function(...args) {
        if (this.canvas.id === 'history') {
          let path = state.get(this) ?? [];
          if (method === 'beginPath') { path = []; state.set(this, path); }
          else if (method === 'clearRect') { window.chartDrawing = []; window.chartLabels = []; }
          else if (method === 'fillText') window.chartLabels.push(String(args[0]));
          else if (method === 'stroke' || method === 'fill') {
            window.chartDrawing.push({ method, color: method === 'stroke' ? this.strokeStyle : this.fillStyle,
              dash: this.getLineDash(), path: (args[0] instanceof Path2D ? state.get(args[0]) ?? [] : path).slice() });
          } else path.push({ method, args });
        }
        return original.apply(this, args);
      };
    }
  })();` });
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

  for (const [view, temperatures] of [['temperatures', ['bedroom_temperature', 'downstairs_temperature']],
    ['heating_water', ['supply_temperature', 'return_temperature']]]) {
    await choose('chart-view', view);
    for (const key of temperatures) await checkTemperatureCurve(key);
  }
  await choose('chart-view', 'home_power');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-activity-key=compressorHome] .activity-key-item')].map(item=>item.textContent)"),
    ['Space heating', 'Hot water'], 'The combined Home compressor row explains its yellow and blue states beside the label');
  for (const [value, color] of [[1, '--chart-compressor-space'], [2, '--chart-compressor-dhw']]) {
    assert.equal(await evaluate(`(() => {
      const segment=document.querySelector('[data-activity-key=compressorHome] [data-value="${value}"]');
      const swatch=document.createElement('span'); swatch.style.color=getComputedStyle(document.documentElement).getPropertyValue('${color}').trim();
      return Boolean(segment) && segment.style.backgroundColor === swatch.style.color;
    })()`), true, `Compressor state ${value} uses its own explained color`);
  }
  if (!await shown('operatingMode')) await toggle('operatingMode');
  await evaluate("document.querySelector('#operating-modes .activity-key summary').focus(); true"); await pressKey('Enter');
  assert.equal(await evaluate("document.querySelector('#operating-modes .activity-key').open"), true, 'The pump-mode explanation opens from the keyboard');
  assert.equal(await evaluate("document.querySelectorAll('#operating-modes .activity-key-item').length"), 5);
  assert.match(await evaluate("document.querySelector('#operating-modes .activity-key').textContent"), /Protection or circulation may still operate/);
  await toggle('outdoor_temperature');
  assert.equal(await evaluate("document.querySelector('#operating-modes .activity-key').open"), true, 'Changing a series does not close a mode explanation being read');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('home-compressor-mode-key-dark');
  await evaluate("document.querySelector('#operating-modes .activity-key summary').click(); true"); await settle();
  await choose('chart-view', 'weather');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=solar_radiation] .chart-legend-swatch').dataset.pattern"), 'dashed');
  const solarPaths = await drawnPaths('solar_radiation');
  assert(solarPaths.some(path => path.path.some(command => command.method === 'lineTo')), 'Solar estimate draws recorded forecast evidence');
  assert(solarPaths.some(path => JSON.stringify(path.dash) === '[6,4]' && path.path.some(command => command.method === 'lineTo')),
    'Solar estimate uses a dashed canvas stroke alongside the same-color future forecast');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=solar_forecast] .chart-legend-swatch').dataset.pattern"), 'dash-dot',
    'Future solar forecast retains a distinct dash-dot stroke');
  await choose('chart-view', 'phases');
  for (const prefix of ['property', 'ev1', 'ev2']) for (let phase = 1; phase <= 3; phase++) {
    const key = `${prefix}_current_l${phase}`;
    if (prefix !== 'property' && !await shown(key)) await toggle(key);
    assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch').dataset.kind`),
      prefix === 'property' ? 'line' : 'fill', `${key}: property is an outline; charger phases are filled`);
  }
  assert(await evaluate("window.chartDrawing.filter(row => row.method === 'fill' && row.path.filter(command => command.method === 'lineTo').length >= 4).length >= 6"),
    'All six charger phases render supported filled areas');
  const phaseBands = await evaluate(`(() => {
    const pixel = document.createElement('canvas'); pixel.width = pixel.height = 1;
    const context = pixel.getContext('2d', {willReadFrequently:true});
    const rgb = color => {
      context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1);
      return [...context.getImageData(0,0,1,1).data].slice(0,3);
    };
    const fills = key => {
      const wanted = rgb(getComputedStyle(document.querySelector('[data-chart-key="'+key+'"] .chart-legend-swatch')).color);
      return window.chartDrawing.filter(row => row.method === 'fill' && rgb(row.color).every((value,index) => Math.abs(value-wanted[index]) <= 2));
    };
    const coordinates = paths => paths.flatMap(path => path.path.filter(command => ['moveTo','lineTo'].includes(command.method)).map(command => command.args));
    const result = [];
    for (let phase=1;phase<=3;phase++) {
      const lower=fills('ev1_current_l'+phase), upper=fills('ev2_current_l'+phase), points=coordinates(upper);
      const at=(Math.min(...points.map(point=>point[0]))+Math.max(...points.map(point=>point[0])))/2, bounds=[];
      for (const paths of [lower,upper]) {
        const intersections=[];
        for(const path of paths) {
          let previous;
          for(const command of path.path) {
            if(command.method==='moveTo')previous=command.args;
            else if(command.method==='lineTo'){
              const next=command.args;
              if(previous&&Math.min(previous[0],next[0])<at&&Math.max(previous[0],next[0])>at)
                intersections.push(previous[1]+(next[1]-previous[1])*(at-previous[0])/(next[0]-previous[0]));
              previous=next;
            }
          }
        }
        bounds.push({top:Math.min(...intersections),bottom:Math.max(...intersections)});
      }
      result.push(bounds);
    }
    return result;
  })()`);
  for (const [index, [lower, upper]] of phaseBands.entries()) {
    assert(Number.isFinite(lower.top) && Number.isFinite(upper.top), `L${index + 1}: both chargers have a visible supported fill`);
    assert(Math.abs(upper.bottom - lower.top) < .01, `L${index + 1}: Charger 2 stacks on the same phase of Charger 1`);
    assert(Math.abs((upper.bottom - upper.top) / (lower.bottom - lower.top) - (3 + index) / (6 + index)) < .01,
      `L${index + 1}: filled thickness preserves each charger's actual current`);
    assert(Math.abs(lower.bottom - phaseBands[0][0].bottom) < .01, `L${index + 1}: each conductor has its own zero baseline`);
  }
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('phases-stacked-dark');
  await choose('chart-view', 'runtime');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true"); await settle();
  const runtimePaths = await drawnPaths('compressor_hours');
  const runtimeMarkers = runtimePaths.flatMap(path => path.path.filter(command => command.method === 'arc' && command.args[2] >= 4));
  assert(runtimeMarkers.length >= 4, 'Sparse runtime reports have clearly clickable circular outlines');
  assert(runtimePaths.every(path => path.path.every(command => !['lineTo', 'bezierCurveTo'].includes(command.method))),
    'Momentary runtime reports do not invent a connecting line between acquisitions');
  const [markerX, markerY] = runtimeMarkers[1].args;
  assert.equal(await evaluate(`window.chartDrawing.some(row => row.method === 'fill' && ['rgba(0, 0, 0, 0)', '#00000000'].includes(row.color)
    && row.path.some(command => command.method === 'arc' && command.args[0] === ${markerX} && command.args[1] === ${markerY}))`), true,
  'Runtime circles leave their centers hollow');
  const markerPoint = await evaluate(`(() => { const r=document.getElementById('history').getBoundingClientRect(); return {x:r.left+${markerX}+2,y:r.top+${markerY}+1}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...markerPoint }); await settle();
  assert.match(await evaluate("window.chartLabels.join(' ')"), /Compressor.*80[0-3]|80[0-3].*Compressor/i,
    'Hovering the visible marker presents the original recorded runtime value');
  await capture('runtime-markers-dark');
  await choose('chart-view', 'caravan_power');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=caravan_power]').getAttribute('aria-pressed')"), 'true');
  assert((await drawnPaths('caravan_power')).some(path => path.path.some(command => command.method === 'lineTo')),
    'Caravan meter intervals draw their average power');
  assert.match(await evaluate("document.querySelector('[data-chart-key=caravan_power]').title"), /kW/);
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('caravan-power-dark');
  await choose('chart-view', 'explorer'); await choose('chart-series', 'caravan_energy');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=caravan_energy] .chart-legend-swatch').dataset.kind"), 'interval-energy',
    'The explorer keeps the original Caravan energy intervals separately available');

  await choose('chart-view', 'garage');
  for (const key of ['garage_model_available', 'garage_model_managed_pause']) {
    assert.equal(await shown(key), true, `${key}: garage operation context is visible by default`);
    assert.equal(await evaluate(`document.querySelector('[data-activity-key="${key}"] .mode-segment[data-value="0"]') !== null
      && document.querySelector('[data-activity-key="${key}"] .mode-segment[data-value="1"]') !== null`), true,
    `${key}: known off/on states remain separately inspectable`);
  }
  assert.match(await evaluate("document.querySelector('[data-activity-key=garage_model_available]').textContent"), /Pump power readback/);
  assert.match(await evaluate("document.querySelector('[data-activity-key=garage_model_managed_pause]').textContent"), /Managed.*pause/);
  await toggle('garage_native_indoor_temperature');
  assert.equal(await shown('garage_native_indoor_temperature'), true);
  assert.match(await evaluate("document.getElementById('chart-notes').textContent"), /native readback.*not an independent protection probe/);
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('garage-dark');
  await choose('chart-view', 'explorer');
  assert.equal(await evaluate("document.getElementById('chart-explorer').hidden"), false);
  assert.equal(await pickerOpen(), true, 'Choosing the explorer opens its searchable series picker immediately');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-search', 'Search receives initial dialog focus');
  assert.equal(await evaluate("document.querySelectorAll('#chart-series [role=option]').length"), EXPLORER_SERIES.length);
  await checkPickerFits('Desktop');
  await searchSeries('pump interpreted');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [role=option]')].map(option => option.dataset.seriesKey)"), ['garage_native_indoor_temperature']);
  await pressKey('ArrowDown');
  assert.equal(await evaluate("document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).dataset.seriesKey"), 'garage_native_indoor_temperature');
  await pressKey('Enter');
  await until("document.getElementById('history').dataset.series === 'garage_native_indoor_temperature'");
  assert.equal(await pickerOpen(), false, 'Enter selects and closes the picker');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-toggle', 'Selection restores focus to the compact series button');
  assert.match(await evaluate("document.getElementById('chart-view-description').textContent"), /Recorded temperature/);
  await openPicker();
  assert.equal(await evaluate("document.getElementById('chart-series-search').value"), 'pump interpreted', 'Reopening keeps the useful search');
  await capture('picker-desktop-dark');
  await pressKey('Escape');
  assert.equal(await pickerOpen(), false, `Escape dismisses the picker (focused element ${await evaluate('document.activeElement.id')}, query ${await evaluate("document.getElementById('chart-series-search').value")})`);
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-toggle', 'Escape restores focus to the opener');
  await viewport(1280, 740);
  await evaluate("document.getElementById('chart-series-toggle').scrollIntoView({block:'end'}); true");
  await openPicker();
  await evaluate("document.getElementById('chart-series-clear').click(); true"); await settle();
  await checkPickerFits('Desktop list expanding near the bottom edge');
  await pressKey('Escape'); await viewport(1280, 1100);
  await searchSeries('no-synthetic-series-matches');
  assert.equal(await evaluate("document.querySelectorAll('#chart-series [role=option]').length"), 0);
  assert.match(await evaluate("document.getElementById('chart-series-picker').textContent"), /No matching series/);
  assert.equal(await evaluate("document.getElementById('history').dataset.ready"), 'true', 'An empty search does not discard the displayed chart');
  await searchSeries('temperature');
  const results = await evaluate("[...document.querySelectorAll('#chart-series [role=option]')].map(option => option.dataset.seriesKey)");
  await evaluate("document.getElementById('chart-series-search').focus(); true");
  const activeResult = () => evaluate("document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).dataset.seriesKey");
  const activeIndex = results.indexOf(await activeResult());
  await pressKey('ArrowDown');
  assert.equal(await activeResult(), results[(activeIndex + 1) % results.length]);
  await pressKey('ArrowUp');
  assert.equal(await activeResult(), results[activeIndex]);
  await pressKey('Escape');
  await openPicker();
  const outsidePoint = await evaluate("(() => { const r=document.getElementById('chart-series-picker').getBoundingClientRect(); return {x:r.left>5?2:innerWidth-2,y:r.top>5?2:innerHeight-2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...outsidePoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...outsidePoint }); await settle();
  assert.equal(await pickerOpen(), false, 'Clicking outside dismisses the modal');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-toggle');
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
    await searchSeries('');
    await checkPickerFits(`${width}px fullscreen`);
    await pressKey('Tab');
    assert.equal(await evaluate("document.getElementById('chart-series-picker').contains(document.activeElement)"), true,
      `${width}px fullscreen: the chart focus trap leaves keyboard navigation inside the series picker`);
    await capture(`picker-mobile-${width}-dark`);
    await evaluate("document.querySelector('#chart-series [role=option]').scrollIntoView({block:'nearest'}); true"); await settle();
    const resultPoint = await evaluate("(() => { const r=document.querySelector('#chart-series [role=option]').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...resultPoint, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until("!document.getElementById('chart-series-picker').open");
    await until("document.getElementById('history').dataset.ready === 'true'");
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
        if (key === 'explorer') {
          await openPicker(); await checkPickerFits(`${width}px ${theme}`);
          await capture(`picker-${width}-${theme}`); await pressKey('Escape');
        }
      }
      await choose('chart-view', 'power');
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
      await checkFits(`${width}px ${theme} fullscreen`);
      await capture(`fullscreen-${width}-${theme}`);
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
    }
  }
  await viewport(390, 400, true);
  await choose('chart-view', 'explorer'); await searchSeries('');
  await checkPickerFits('Phone with a short available viewport');
  await capture('picker-short-phone'); await pressKey('Escape');
  assert.deepEqual(errors, [], 'All view selections and cursor interactions have no uncaught browser exceptions');
  console.log(`Chart views browser checks passed: ${CHART_VIEWS.length} named views, ${EXPLORER_SERIES.length} searchable explorer choices, modal keyboard/touch/focus, periodic temperature Bézier geometry, solar estimate dash, charger phase fills, visibility isolation, garage readback, crosshair bounds and touch, dark/light themes, and 320/390px fullscreen layouts.`);
  console.log(`Screenshots: ${screenshots.join(', ')}`);
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
