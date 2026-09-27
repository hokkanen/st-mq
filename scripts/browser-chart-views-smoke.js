// Isolated synthetic app and Chrome profile; never reads household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { CHART_VIEWS } from '../src/domain/chart-views.js';
import { EXPLORER_SERIES } from '../chart/series-explorer.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { addFireplace } from '../src/app/fireplace.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { createGarageModel, GARAGE_ALGORITHM_VERSION } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-views-browser-'));
const now = Date.parse('2026-09-07T12:00:00Z');
const screenshotDirectory = process.env.STMQ_SCREENSHOT_DIR ?? 'var';
let app, socket, browser, id = 0;
const pending = new Map(), errors = [], screenshots = [];
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  // Build the Garage journal before application startup, which adds its own
  // current context. This preserves the seed boundary and chronological replay.
  const fixtureStore = new Store(config.dbPath);
  try {
    fixtureStore.transaction(() => {
      // A current-format saved seed supplies achieved reference and independent
      // validation evidence. It is artificial chart evidence, never live state.
      const seed = createGarageModel({ seedAt: now - 30 * 60_000, roomTargetC: 12 });
      Object.assign(seed.normalReference, { initialized: true, interceptC: 12.1, frontC: 11.6,
        samples: 120, qualifiedHours: 2.5 });
      seed.validation.episodes = [{ id: 0, role: 'validation', clean: true, complete: true,
        startedAt: now - 6 * 3600_000, endedAt: now - 2 * 3600_000,
        offHours: 1, recoveryHours: 3, thermalPassed: true, trainingSupportHours: 1,
        offRearRmse: .2, offFrontRmse: .3, rearRmse: .25, frontRmse: .4,
        rearBias: -.05, frontBias: -.1 }];
      seed.validation.nextId = 1;
      for (let index = 0; index < 6; index++) {
        const at = now - (30 - index) * 60_000;
        appendGarageEntry(fixtureStore, 'simulated', 'sample', {
          at, rearAt: at, rearC: 12, frontAt: at, frontC: 11.5, outdoorAt: at, outdoorC: 3,
          available: [true, false, false, true, null, true][index], managedPause: [false, true, false, false, null, false][index],
          powerKw: .4, powerQuality: 'simulated', ev1Kw: 0, ev2Kw: 0,
        }, garageSettings(), at, index === 0 ? { seed } : {});
      }
      for (const [index, profitCents] of [125, -35].entries()) {
        fixtureStore.cycle('garage:simulated', {
          id: `invented-chart-garage-episode-${index}`, status: 'completed',
          startedAt: now - (8 - index * 2) * 3600_000, endedAt: now - (4 - index * 2) * 3600_000,
          algorithmVersion: GARAGE_ALGORITHM_VERSION,
          assessment: { algorithmVersion: GARAGE_ALGORITHM_VERSION, stage: 'completed',
            basis: 'garage-frozen-normal-reference', includesGarageOnly: true, provisional: true,
            profitCents, uncertaintyCents: 20, referenceCostCents: 250, actualCostCents: 250 - profitCents,
            electricityBasis: index ? 'modeled-native-electricity' : 'qualified-recorded-electricity' },
        });
      }
    });
  } finally { fixtureStore.close(); }
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
        ['dhwr_active', index % 60 < 10 ? 1 : 0, 'state'],
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

  });
  const periodicFixture = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?view=temperatures&start=2026-09-07&end=2026-09-07&points=800`).then(response => response.json());
  for (const key of ['bedroom_temperature', 'downstairs_temperature']) {
    assert(periodicFixture.series[key].some(point => point.periodicCoverage && point.displayBoundary),
      `${key}: the fixture contains periodic hold endpoints, the geometry regression being tested`);
    assert(new Set(periodicFixture.series[key].filter(point => Number.isFinite(point.y)).map(point => point.y)).size > 10,
      `${key}: source readings change gradually across enough reports to inspect their curve`);
  }
  const outcomeFixtures = Object.fromEntries(await Promise.all(['garage_references', 'garage_error', 'garage_benefit'].map(async view => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?view=${view}&start=2026-09-07&end=2026-09-07&points=800`);
    assert.equal(response.status, 200, `${view}: the synthetic outcome projection is available`);
    return [view, await response.json()];
  })));
  for (const [key, expected] of [['garage_outcome_rear_reference', 12.1], ['garage_outcome_front_reference', 11.6]]) {
    const points = outcomeFixtures.garage_references.series[key].filter(point => Number.isFinite(point.y));
    assert(points.length && points.every(point => point.y === expected && point.modelOutcome === true
      && point.outcomeBasis === 'continuously-available-achieved-reference'), `${key}: the fixture supplies achieved, replayed references`);
  }
  for (const [key, expected] of [['garage_outcome_rear_error', .2], ['garage_outcome_front_error', .3]]) {
    const points = outcomeFixtures.garage_error.series[key].filter(point => Number.isFinite(point.y));
    assert(points.length && points.every(point => Math.abs(point.y - expected) < 1e-12 && point.modelOutcome === true
      && point.evidenceCount === 1), `${key}: the fixture supplies independent held-out evidence`);
  }
  assert.deepEqual(outcomeFixtures.garage_benefit.series.garage_outcome_benefit.map(point => point.y), [1.25, -.35],
    'Completed Garage assessments preserve benefit and extra cost as individual outcomes');
  assert(outcomeFixtures.garage_benefit.series.garage_outcome_benefit.every(point => point.modelOutcome === true
    && point.provisional === true && !point.displayBoundary && !point.carriedForward),
  'Episode outcomes retain their provisional provenance without fabricated chart tails');
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
    const opening = !await pickerOpen();
    if (opening) await evaluate("document.getElementById('chart-series-toggle').click(); true");
    await until("document.getElementById('chart-series-picker').open"); await settle();
    if (opening) assert.equal(await evaluate("document.activeElement.matches('input, textarea, [contenteditable=true]')"), false,
      'Opening or reopening Explore chart leaves the virtual keyboard closed');
  };
  const pickerMode = async mode => {
    await openPicker();
    await evaluate(`document.getElementById('chart-series-mode-${mode}').click(); true`);
    await settle();
    assert.equal(await evaluate("document.activeElement.id"), `chart-series-mode-${mode}`,
      'Switching chart catalogues keeps focus on the chosen mode instead of opening the search keyboard');
  };
  const searchCatalogue = async (query, mode) => {
    await pickerMode(mode);
    await evaluate(`(() => { const input = document.getElementById('chart-series-search');
      input.value = ${JSON.stringify(query)}; input.dispatchEvent(new Event('input')); return true; })()`);
    await settle();
  };
  const searchSeries = query => searchCatalogue(query, 'series');
  const searchViews = query => searchCatalogue(query, 'views');
  const pressKey = async key => {
    const code = { Escape: 'Escape', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', Enter: 'Enter', Tab: 'Tab', ' ': 'Space' }[key];
    const windowsVirtualKeyCode = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9, ' ': 32 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode }); await settle();
  };
  const choose = async (kind, value) => {
    await searchCatalogue('', kind === 'view' ? 'views' : 'series');
    await evaluate(`document.querySelector('#chart-series [data-${kind}-key="${value}"]').click(); true`);
    await until("!document.getElementById('chart-series-picker').open");
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.${kind} === ${JSON.stringify(value)}`);
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
    await settle(); mkdirSync(screenshotDirectory, { recursive: true });
    const path = join(screenshotDirectory, `chart-views-${name}.png`), screenshot = await send('Page.captureScreenshot', { format: 'png' });
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
      const select = document.getElementById('chart-series-toggle').getBoundingClientRect();
      const exit = document.getElementById('chart-fullscreen').getBoundingClientRect();
      const minimumPlotHeight = panel.dataset.fullscreen === 'true' && innerHeight <= 550
        && document.getElementById('chart-legend-panel').open ? 40 : 80;
      return document.documentElement.scrollWidth <= innerWidth + 1 && bounds.left >= -1 && bounds.right <= innerWidth + 1
        && select.width >= 80 && select.right <= exit.left + 1 && exit.right <= innerWidth + 1 && canvas.height >= minimumPlotHeight
        && (panel.dataset.fullscreen !== 'true' || canvas.bottom <= innerHeight && bounds.bottom <= innerHeight + 1);
    })()`), true, `${label}: chart controls and plot fit without horizontal overflow`);
  };
  const viewportState = () => evaluate(`(() => {
    const data = document.getElementById('history').dataset;
    return { from: data.viewFrom, to: data.viewTo, zoom: data.zoom };
  })()`);
  const bandPoint = (fraction = .47, id = 'operating-modes') => evaluate(`(() => {
    const r = document.querySelector('#${id} .mode-track').getBoundingClientRect();
    return { x: r.left + r.width * ${fraction}, y: r.top + r.height / 2 };
  })()`);
  const cursorHidden = () => evaluate("document.querySelector('.chart-crosshair-extension')?.hidden !== false");
  const checkCursorSegments = async (x, label) => {
    const bounds = await evaluate(`(() => {
      const rect = node => { const r = node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
      const activity = rect(document.getElementById('chart-activity'));
      const tracks = [...document.querySelectorAll('#chart-activity .mode-history:not([hidden]) .mode-track')]
        .map(rect).filter(r => r.width > 0 && r.height > 0 && r.bottom > activity.top && r.top < activity.bottom)
        .map(r => ({...r,top:Math.max(r.top,activity.top),bottom:Math.min(r.bottom,activity.bottom)}));
      const extension = document.querySelector('.chart-crosshair-extension');
      return {tracks,segments:[...extension.querySelectorAll('.chart-crosshair-segment')].map(rect),
        border:getComputedStyle(extension).borderLeftWidth,hidden:extension.hidden};
    })()`);
    assert.equal(bounds.hidden, false, `${label}: the time cursor is visible`);
    assert.equal(bounds.border, '0px', `${label}: no continuous border crosses captions or gaps`);
    assert.equal(bounds.segments.length, bounds.tracks.length, `${label}: every visible band has one cursor segment`);
    assert(bounds.segments.length > 0, `${label}: at least one band is visible`);
    bounds.segments.forEach((segment, index) => {
      const track = bounds.tracks[index];
      assert(Math.abs(segment.left - x) < 2 && segment.left >= track.left - 1 && segment.right <= track.right + 1,
        `${label}: band ${index} follows the inspected time`);
      assert(Math.abs(segment.top - track.top) < 1 && Math.abs(segment.bottom - track.bottom) < 1,
        `${label}: band ${index} stops at its own edges, including scrolling clips`);
    });
  };
  const checkLegendDisclosure = async (label, fullscreen) => {
    assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), false,
      `${label}: the legend starts compact`);
    const before = await viewportState();
    await evaluate("document.getElementById('chart-legend-toggle').focus(); true");
    await pressKey(await evaluate('innerWidth < 600') ? ' ' : 'Enter');
    await until("document.getElementById('chart-legend-panel').open"); await settle();
    assert.equal(await evaluate("document.getElementById('chart-legend').checkVisibility()"), true,
      `${label}: native keyboard disclosure reveals the legend`);
    assert.equal(await evaluate("document.getElementById('chart-activity').checkVisibility()"), !fullscreen,
      `${label}: the expanded legend ${fullscreen ? 'temporarily replaces' : 'keeps'} the activity rows`);
    if (fullscreen) assert.equal(await evaluate("document.getElementById('chart-overview').checkVisibility()"), await evaluate('innerHeight > 550'),
      `${label}: the navigator stays available when viewport height permits`);
    const layout = await evaluate(`(() => {
      const list = document.getElementById('chart-legend'), reset = document.querySelector('.chart-legend-reset');
      const resetBounds = () => { const r=reset.getBoundingClientRect(); return {top:r.top,bottom:r.bottom}; };
      const before = resetBounds();
      const buttons = [...list.querySelectorAll('[data-chart-key]')];
      const accessible = buttons.map(button => {
        button.scrollIntoView({block:'nearest'});
        const r=button.getBoundingClientRect(), hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return {key:button.dataset.chartKey,visible:button.checkVisibility(),hit:hit?.closest('[data-chart-key]')===button};
      });
      return {accessible,resetBefore:before,resetAfter:resetBounds(),resetOutsideList:!list.contains(reset),
        scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,scrollTop:list.scrollTop,
        panel:document.getElementById('chart-legend-panel').getBoundingClientRect().toJSON()};
    })()`);
    assert(layout.accessible.length > 3 && layout.accessible.every(item => item.visible && item.hit),
      `${label}: every legend item is reachable through scrolling (${JSON.stringify(layout)})`);
    assert.equal(layout.resetOutsideList, true, `${label}: reset sits outside the scrolling list`);
    if (fullscreen) {
      assert.deepEqual(layout.resetAfter, layout.resetBefore, `${label}: Reset view stays pinned when scrolling the legend`);
      assert(layout.panel.top >= 0 && layout.panel.bottom <= await evaluate('innerHeight') + 1,
        `${label}: the complete legend stays inside the viewport`);
      await checkFits(`${label} expanded legend`);
      if (await evaluate('innerWidth < 600 && innerHeight < 550'))
        assert(layout.scrollHeight > layout.clientHeight, `${label}: the short phone viewport provides real scrolling for the complete legend`);
      await capture(`legend-${label.toLowerCase().replaceAll(' ', '-')}`);
    }
    if (layout.scrollHeight > layout.clientHeight + 1) {
      const lowerItem = await evaluate(`(() => {
        const list = document.getElementById('chart-legend'), bounds = list.getBoundingClientRect();
        const button = [...list.querySelectorAll('[data-chart-key]')].filter(node => {
          const r = node.getBoundingClientRect();
          return r.top >= Math.max(bounds.top, 0) && r.bottom <= Math.min(bounds.bottom, innerHeight);
        }).at(-1);
        return { key: button?.dataset.chartKey, scrollTop: list.scrollTop };
      })()`);
      assert(lowerItem.key && lowerItem.scrollTop > 0, `${label}: a lower legend item is visible after real scrolling`);
      const originalVisibility = await shown(lowerItem.key), touch = await evaluate('matchMedia("(pointer: coarse)").matches');
      for (let attempt = 0; attempt < 2; attempt++) {
        const target = await evaluate(`(() => {
          const button = document.querySelector('[data-chart-key="${lowerItem.key}"]');
          if (!${touch}) button.focus({preventScroll:true});
          const r = button.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, scrollTop: document.getElementById('chart-legend').scrollTop };
        })()`);
        if (touch) {
          await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x, y: target.y, id: 1 }] });
          await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
        } else await pressKey('Enter');
        assert.equal(await shown(lowerItem.key), attempt ? originalVisibility : !originalVisibility,
          `${label}: the scrolled legend item changes through ${touch ? 'touch' : 'keyboard'}`);
        assert(Math.abs(await evaluate("document.getElementById('chart-legend').scrollTop") - target.scrollTop) < 1,
          `${label}: toggling a lower legend item preserves the scroll position`);
        assert.equal(await evaluate("document.activeElement.dataset.chartKey"), lowerItem.key,
          `${label}: the same legend item retains focus after it is rebuilt`);
        assert.equal(await evaluate(`(() => {
          const button = document.querySelector('[data-chart-key="${lowerItem.key}"]'), r = button.getBoundingClientRect();
          return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[data-chart-key]') === button;
        })()`), true, `${label}: the toggled item remains visible at the same place`);
      }
      await capture(`legend-scroll-${label.toLowerCase().replaceAll(' ', '-')}`);
    }
    const original = await shown('property_power');
    await evaluate("document.querySelector('[data-chart-key=property_power]').focus(); true"); await pressKey('Enter');
    assert.equal(await shown('property_power'), !original, `${label}: a keyboard legend toggle changes the series`);
    assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), true,
      `${label}: changing a series keeps the legend open`);
    await evaluate("localStorage.removeItem('home-energy-chart-views'); document.querySelector('.chart-legend-save').focus(); true");
    await pressKey('Enter');
    assert.equal(await evaluate("document.querySelector('.chart-legend-save').textContent"), 'View saved');
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('home-energy-chart-views')).views.power.property_power"), !original,
      `${label}: Save view persists the current visibility choices`);
    assert.equal(await evaluate("document.activeElement.classList.contains('chart-legend-save')"), true,
      `${label}: saving retains keyboard focus`);
    assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), true,
      `${label}: saving keeps the legend open`);
    assert.equal(await evaluate(`(() => {
      const save = document.querySelector('.chart-legend-save'), r = save.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === save;
    })()`), true, `${label}: Save view is reachable in the legend footer`);
    await evaluate("document.querySelector('.chart-legend-reset').focus(); true"); await pressKey('Enter');
    assert.equal(await shown('property_power'), true, `${label}: Reset view restores the default series`);
    assert.equal(await evaluate("document.activeElement.classList.contains('chart-legend-reset')"), true,
      `${label}: reset retains keyboard focus after the legend is rebuilt`);
    assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), true,
      `${label}: Reset view keeps the legend open`);
    assert.deepEqual(await viewportState(), before, `${label}: opening and using the legend preserves the visible time range`);
    await pressKey('Escape');
    assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), false,
      `${label}: Escape closes the legend`);
    assert.equal(await evaluate("document.activeElement.id"), 'chart-legend-toggle', `${label}: Escape restores focus to the summary`);
    assert.equal(await evaluate("document.getElementById('chart-activity').checkVisibility()"), true,
      `${label}: closing the legend restores the activity rows`);
    assert.equal(await evaluate("document.querySelector('.history-panel').dataset.fullscreen === 'true'"), fullscreen,
      `${label}: Escape in the legend does not leave fullscreen`);
  };
  const checkScrollbarAlignment = async label => {
    await evaluate(`(() => {
      const sheet=document.styleSheets[0], index=sheet.cssRules.length;
      sheet.insertRule('#chart-activity { overflow-y: hidden !important; scrollbar-width: auto !important; max-height: 160px !important; }',index);
      sheet.insertRule('#chart-activity::-webkit-scrollbar { width:18px; }',index+1);
      window.chartScrollbarFixture={sheet,index}; return true;
    })()`); await settle();
    const edges = () => evaluate(`(() => {
      const root=document.getElementById('chart-activity');
      return {gutter:root.offsetWidth-root.clientWidth,rows:[...root.querySelectorAll('.mode-history:not([hidden]) .mode-track')].map(node => {
        const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width};
      })};
    })()`);
    const baseline = await edges();
    assert.equal(baseline.gutter, 0, `${label}: baseline has no reserved scrollbar`);
    await evaluate("window.chartScrollbarFixture.sheet.cssRules[window.chartScrollbarFixture.index].style.setProperty('overflow-y','scroll','important'); true");
    await settle();
    const check = async phase => {
      const current=await edges();
      assert(current.gutter >= 16, `${label}: the fixture exercises a real non-overlay scrollbar`);
      assert.equal(current.rows.length, baseline.rows.length);
      current.rows.forEach((row,index) => {
        assert(Math.abs(row.left-baseline.rows[index].left)<1 && Math.abs(row.right-baseline.rows[index].right)<1,
          `${label}: ${phase} preserves both time endpoints of row ${index} (${JSON.stringify({before:baseline.rows[index],after:row,gutter:current.gutter})})`);
      });
    };
    await check('showing a scrollbar');
    await evaluate("document.querySelector('#operating-modes .activity-summary').click(); true"); await settle();
    await check('opening an activity explanation');
    await evaluate("document.querySelector('#operating-modes .activity-summary').click(); true"); await settle();
    await check('closing an activity explanation');
    await evaluate("window.chartScrollbarFixture.sheet.deleteRule(window.chartScrollbarFixture.index); window.chartScrollbarFixture.sheet.deleteRule(window.chartScrollbarFixture.index); delete window.chartScrollbarFixture; document.getElementById('chart-activity').scrollTop=0; true");
    await settle();
  };
  const checkPickerFits = async label => {
    const layout = await evaluate(`(() => {
      const dialog = document.getElementById('chart-series-picker');
      const modal = dialog.getBoundingClientRect();
      const list = document.getElementById('chart-series'), rows = [...list.querySelectorAll('[role=option]')];
      const root = document.documentElement, style = getComputedStyle(dialog);
      return {
        modal: { left: modal.left, top: modal.top, right: modal.right, bottom: modal.bottom, width: modal.width, height: modal.height },
        viewport: { width: innerWidth, height: innerHeight, clientWidth: root.clientWidth, clientHeight: root.clientHeight,
          visualWidth: visualViewport?.width, visualHeight: visualViewport?.height,
          visualOffsetLeft: visualViewport?.offsetLeft, visualOffsetTop: visualViewport?.offsetTop },
        centerOffset: { x: modal.left + modal.width / 2 - innerWidth / 2,
          y: modal.top + modal.height / 2 - innerHeight / 2,
          clientX: modal.left + modal.width / 2 - root.clientWidth / 2 },
        list: { height: list.clientHeight, rowCount: rows.length,
          firstRowHeight: rows[0]?.getBoundingClientRect().height,
          minRowHeight: rows.length ? Math.min(...rows.map(row => row.getBoundingClientRect().height)) : null },
        document: { scrollWidth: root.scrollWidth, bodyScrollWidth: document.body.scrollWidth },
        style: { position: style.position, top: style.top, right: style.right, bottom: style.bottom, left: style.left,
          margin: style.margin, maxHeight: style.maxHeight, transform: style.transform },
      };
    })()`);
    const { modal, viewport, centerOffset, list } = layout;
    const evidence = `${label}: ${JSON.stringify(layout)}`;
    assert(modal.left >= -1 && modal.top >= -1 && modal.right <= viewport.width + 1 && modal.bottom <= viewport.height + 1,
      `Explorer fits inside the viewport. ${evidence}`);
    // Native centered dialogs use the content viewport, excluding its scrollbar.
    assert(Math.abs(centerOffset.clientX) <= 2 && Math.abs(centerOffset.y) <= 2,
      `Explorer is centered in the viewport. ${evidence}`);
    assert(list.height >= 100 && list.rowCount > 0 && list.firstRowHeight >= 40,
      `Explorer has usable result targets. ${evidence}`);
    assert(layout.document.scrollWidth <= viewport.width + 1,
      `Explorer does not introduce horizontal document overflow. ${evidence}`);
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
  assert.equal(await evaluate("document.getElementById('history').dataset.view"), 'power');
  for (const [start, end] of [['2026-08-07', '2026-09-07'], ['2026-08-20', '2026-09-07'],
    ['2026-09-07', '2026-09-07'], ['2026-09-08', '2026-09-08']]) {
    await evaluate(`document.getElementById('date-start').value=${JSON.stringify(start)};
      document.getElementById('date-start').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.rangeStart === ${JSON.stringify(start)}
      && document.getElementById('history').dataset.rangeEnd === ${JSON.stringify(end)}`);
    assert.equal(await evaluate("document.getElementById('date-end').value"), end,
      `${start}: the end moves only when the start passes it`);
  }
  await evaluate("document.getElementById('range-today').click(); true");
  await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07'
    && document.getElementById('history').dataset.rangeEnd === '2026-09-07'`);
  assert.equal(await evaluate("document.getElementById('chart-legend-panel').tagName"), 'DETAILS',
    'Legend uses a native disclosure on every screen size');
  assert.equal(await evaluate("document.getElementById('chart-legend-toggle').tagName"), 'SUMMARY');
  assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), false,
    'The initial dashboard gives plot and activity rows the compact closed legend');
  assert.equal(await evaluate("document.getElementById('chart-series-toggle-label').textContent"), 'Selected view');
  assert.match(await evaluate("document.getElementById('chart-series-selected').textContent"), /Electrical power/);
  assert.equal(await evaluate("document.querySelectorAll('[aria-controls=chart-series-picker]').length"), 1,
    'One chart selection button opens the explorer');
  assert.equal(await evaluate("document.querySelector('#chart-view, #chart-explorer')"), null,
    'The old dropdown and redundant selected-series row are removed');
  const chartSelection = () => evaluate(`(() => {
    const chart = document.getElementById('history');
    return { view: chart.dataset.view, series: chart.dataset.series,
      label: document.getElementById('chart-series-selected').textContent,
      dates: ['date-start', 'date-end'].map(id => document.getElementById(id).value),
      requests: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/chart?')).length };
  })()`);
  const beforeBrowsing = await chartSelection();
  await openPicker();
  assert.equal(await evaluate("document.getElementById('chart-series-mode-views').getAttribute('aria-pressed')"), 'true',
    'Opening a grouped view starts in Views');
  assert.equal(await evaluate("Boolean(document.getElementById('chart-series-mode-views').closest('[role=group]')) && document.getElementById('chart-series-mode-views').closest('[role=group]') === document.getElementById('chart-series-mode-series').closest('[role=group]')"), true);
  assert.equal(await evaluate("document.getElementById('chart-series').getAttribute('role')"), 'listbox');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-mode-views');
  assert.match(await evaluate("document.getElementById('chart-series-picker').textContent"), /Explore chart/);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [data-view-key]')].map(option => option.dataset.viewKey)"),
    CHART_VIEWS.map(view => view.key));
  for (const [group, count] of [['Home learning', 4], ['Home coefficients', 4], ['Home outcomes', 2],
    ['Garage learning', 2], ['Garage coefficients', 2], ['Garage outcomes', 3]]) {
    await searchViews(group);
    const groupResults = await evaluate(`(() => {
      let group;
      return [...document.getElementById('chart-series').children].flatMap(node => {
        if (node.matches('.chart-series-group')) { group = node.textContent; return []; }
        return group === ${JSON.stringify(group)} && node.dataset.viewKey ? [node.dataset.viewKey] : [];
      });
    })()`);
    assert.deepEqual(groupResults,
      CHART_VIEWS.filter(view => view.group === group).map(view => view.key), `${group}: the matching learning section is discoverable`);
    assert.equal(groupResults.length, count,
      `${group}: useful comparisons retain deliberate Home and Garage detail`);
  }
  assert(!CHART_VIEWS.some(view => ['learning_auxiliary', 'learning_treatment'].includes(view.key)),
    'The streamlined Home catalogue removes the separate auxiliary and treatment views');
  await searchSeries('model_auxiliary_power');
  assert.equal(await evaluate("Boolean(document.querySelector('#chart-series [data-series-key=model_auxiliary_power]'))"), true,
    'The original saved auxiliary electrical input remains independently searchable');
  await searchViews('');
  await checkPickerFits('Desktop views');
  await capture('picker-views-desktop-dark');
  await searchViews('heating water');
  assert.equal(await evaluate("Boolean(document.querySelector('#chart-series [data-view-key=heating_water]'))"), true,
    'Views can be searched by their subject');
  assert((await evaluate("document.querySelectorAll('#chart-series [role=option]').length")) < CHART_VIEWS.length);
  await searchViews('no-synthetic-view-matches');
  assert.equal(await evaluate("document.querySelectorAll('#chart-series [role=option]').length"), 0);
  assert.match(await evaluate("document.getElementById('chart-series-picker').textContent"), /No matching views/);
  await searchViews('heating water');
  await searchSeries('pump interpreted');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [role=option]')].map(option => option.dataset.seriesKey)"),
    ['garage_native_indoor_temperature']);
  await pickerMode('views');
  assert.equal(await evaluate("document.getElementById('chart-series-search').value"), 'heating water', 'Views keep their own search');
  await pickerMode('series');
  assert.equal(await evaluate("document.getElementById('chart-series-search').value"), 'pump interpreted', 'Series keep their own search');
  assert.deepEqual(await chartSelection(), beforeBrowsing, 'Opening, filtering and switching catalogues never change the chart or request data');
  await pressKey('Escape');
  assert.deepEqual(await chartSelection(), beforeBrowsing, 'Dismissing exploration keeps the active selection');
  await openPicker();
  assert.equal(await evaluate("document.getElementById('chart-series-mode-views').getAttribute('aria-pressed')"), 'true',
    'Reopening follows the active chart selection rather than the last browsed catalogue');
  assert.equal(await evaluate("document.getElementById('chart-series-search').value"), 'heating water');
  await pressKey('Escape');
  for (const view of CHART_VIEWS) {
    await choose('view', view.key);
    assert.equal(await evaluate("document.getElementById('chart-view-description').textContent"), view.description);
    const legend = await evaluate("[...document.querySelectorAll('[data-chart-key]')].map(item => item.dataset.chartKey)");
    assert.equal(new Set(legend).size, legend.length, `${view.key}: each selectable series or activity row appears once`);
    for (const key of [...view.leftSignals, ...view.rightSignals, ...view.tracks, 'all_in_price', 'spot_price'])
      assert(legend.includes(key), `${view.key}: ${key} stays selectable`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-activity [data-activity-key]')].map(row => row.dataset.activityKey)"), view.tracks);
    assert.equal(await evaluate(`(() => {
      const swatches=[...document.querySelectorAll('.chart-legend-group[data-axis=activity] .chart-legend-swatch')];
      const shape=node=>{ const s=getComputedStyle(node); return [s.width,s.height,s.borderStyle,s.borderRadius,s.backgroundImage].join('|'); };
      return swatches.every(swatch=>swatch.dataset.kind==='strip' && swatch.dataset.pattern==='solid'
        && !swatch.style.backgroundImage && shape(swatch)===shape(swatches[0]));
    })()`), true, `${view.key}: every activity legend icon uses the same single-colour striped shape`);
    assert.equal(await evaluate("document.getElementById('chart-series-toggle-label').textContent"), 'Selected view');
    assert.equal(await evaluate("document.getElementById('chart-series-selected').textContent"), view.label);
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#chart-activity [data-activity-key]')];
      return rows.every(row => {
        const fold = row.querySelector(':scope > details.activity-caption');
        return fold && fold.querySelector(':scope > summary.activity-summary .activity-title')?.textContent.trim()
          && fold.querySelector('.activity-description > p')?.textContent.trim()
          && fold.querySelectorAll('.activity-description .activity-key-item').length > 0
          && [...row.querySelectorAll('.mode-segment')].every(segment =>
            [...fold.querySelectorAll('.activity-description .activity-key-swatch')].some(swatch =>
              swatch.style.backgroundColor === segment.style.backgroundColor
              && (swatch.dataset.pattern ?? '') === (segment.dataset.pattern ?? '')));
      }) && !document.querySelector('.activity-key');
    })()`), true, `${view.key}: every activity title unfolds its meaning and complete colour key`);
  }
  await choose('view', 'power');
  await checkLegendDisclosure('Desktop dashboard', false);
  await evaluate("document.getElementById('chart-legend-toggle').click(); true"); await settle();
  await choose('view', 'weather');
  assert.equal(await evaluate("document.getElementById('chart-legend-panel').open"), true,
    'Changing the selected view keeps the legend open');
  await choose('view', 'power');
  await evaluate("document.getElementById('chart-legend-toggle').focus(); true"); await pressKey('Escape');
  for (const [key, pattern] of [['property_power', 'solid'], ['outdoor_temperature', 'dashed'], ['outdoor_forecast', 'dash-dot'], ['all_in_price', 'dotted']])
    assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch').dataset.pattern`), pattern);
  for (const key of ['charger_power', 'charger2_power']) assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"] .chart-legend-swatch').dataset.kind`), 'fill');
  assert.notEqual(await evaluate("document.querySelector('[data-chart-key=auxiliary_power] .chart-legend-swatch').dataset.kind"), 'fill');
  await toggle('outdoor_temperature'); await toggle('spot_price');
  assert.equal(await shown('outdoor_temperature'), false); assert.equal(await shown('spot_price'), false);
  await choose('view', 'weather');
  assert.equal(await shown('outdoor_temperature'), true, 'Temperature visibility belongs to the selected view');
  assert.equal(await shown('spot_price'), false, 'Price visibility is shared across views');
  await choose('view', 'power');
  assert.equal(await shown('outdoor_temperature'), false, 'Returning restores that view’s deliberate choices');
  await evaluate("document.querySelector('.chart-legend-save').click(); true");
  await send('Page.reload');
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await shown('outdoor_temperature'), false, 'Reload restores the saved view visibility');
  assert.equal(await shown('spot_price'), false, 'Reload restores saved shared price choices');
  assert.equal(await evaluate(`(() => {
    const original = Storage.prototype.setItem;
    try {
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); };
      document.querySelector('.chart-legend-save').click();
      return document.querySelector('.chart-legend-save').textContent;
    } finally { Storage.prototype.setItem = original; }
  })()`), 'Could not save', 'Failed storage does not claim that the view was saved');
  await evaluate("document.querySelector('.chart-legend-reset').click(); true"); await settle();
  assert.equal(await shown('outdoor_temperature'), true);
  assert.equal(await shown('spot_price'), false, 'Reset view preserves shared price choices');
  await toggle('spot_price');

  for (const [view, temperatures] of [['temperatures', ['bedroom_temperature', 'downstairs_temperature']],
    ['heating_water', ['supply_temperature', 'return_temperature']]]) {
    await choose('view', view);
    for (const key of temperatures) await checkTemperatureCurve(key);
  }
  await choose('view', 'hot_water');
  assert.deepEqual(await evaluate("['dhwr','dhwr_active'].map(key=>document.querySelector('[data-activity-key='+key+'] .activity-title').textContent)"),
    ['Hot-water circulation request','Hot-water circulation feedback'], 'Requested and reported circulation use equivalent labels');
  assert.equal(await evaluate(`(() => {
    const titles = ['dhwr','dhwr_active'].map(key=>getComputedStyle(document.querySelector('[data-activity-key='+key+'] .activity-title')));
    return ['fontSize','fontWeight','color'].every(property=>titles[0][property]===titles[1][property]);
  })()`), true, 'Requested and reported circulation share the same visual hierarchy');
  await choose('view', 'home_power');
  assert.match(await evaluate("[...document.querySelectorAll('[data-activity-key=compressorHome] .activity-description .activity-key-item')].map(item=>item.textContent).join(' ')"),
    /Space heating.*Hot water.*Stopped.*Routing unknown.*Unknown/, 'The Home compressor row explains all colours, hatching and blank intervals');
  for (const [value, color] of [[1, '--chart-compressor-space'], [2, '--chart-compressor-dhw']]) {
    assert.equal(await evaluate(`(() => {
      const segment=document.querySelector('[data-activity-key=compressorHome] [data-value="${value}"]');
      const swatch=document.createElement('span'); swatch.style.color=getComputedStyle(document.documentElement).getPropertyValue('${color}').trim();
      return Boolean(segment) && segment.style.backgroundColor === swatch.style.color;
    })()`), true, `Compressor state ${value} uses its own explained color`);
  }
  for (const [key,variable] of [['operatingMode','--chart-indoor'],['compressorHome','--chart-compressor-space']]) {
    assert.equal(await evaluate(`(() => {
      const swatch=document.querySelector('[data-chart-key=${key}] .chart-legend-swatch');
      const expected=document.createElement('span'); expected.style.color=getComputedStyle(document.documentElement).getPropertyValue('${variable}').trim();
      return swatch.style.color===expected.style.color && swatch.style.backgroundColor===expected.style.color;
    })()`), true, `${key}: the activity swatch uses its representative on-state colour`);
  }
  if (!await shown('operatingMode')) await toggle('operatingMode');
  await evaluate("document.querySelector('#operating-modes .activity-caption summary').focus(); true"); await pressKey('Enter');
  assert.equal(await evaluate("document.querySelector('#operating-modes .activity-caption').open"), true, 'The pump-mode explanation opens from the keyboard');
  assert.equal(await evaluate("document.querySelectorAll('#operating-modes .activity-description .activity-key-item').length"), 6);
  assert.match(await evaluate("document.querySelector('#operating-modes .activity-caption').textContent"), /Protection or circulation may still operate/);
  await toggle('outdoor_temperature');
  assert.equal(await evaluate("document.querySelector('#operating-modes .activity-caption').open"), true, 'Changing a series does not close a mode explanation being read');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('home-compressor-activity-explanation-dark');
  await choose('view', 'weather'); await choose('view', 'home_power');
  assert.equal(await evaluate("document.querySelector('#operating-modes .activity-caption').open"), true,
    'Returning to a view preserves the activity explanation being read');
  const refreshedCursor = await evaluate(`(() => {
    document.querySelector('[data-chart-key=outdoor_temperature]').click();
    const track = document.querySelector('#operating-modes .mode-track'), r = track.getBoundingClientRect();
    const point = {clientX:r.left+r.width*.47,clientY:r.top+r.height/2};
    track.dispatchEvent(new PointerEvent('pointermove',{...point,pointerType:'mouse',pointerId:1,bubbles:true}));
    return point.clientX;
  })()`);
  await settle();
  await checkCursorSegments(refreshedCursor, 'A restored open title does not cancel a new cursor when its native toggle event arrives');
  await evaluate("document.querySelector('#operating-modes .activity-caption summary').click(); true"); await settle();
  await choose('view', 'weather');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=solar_radiation] .chart-legend-swatch').dataset.pattern"), 'solid');
  const solarPaths = await drawnPaths('solar_radiation');
  assert(solarPaths.some(path => path.path.some(command => command.method === 'lineTo')), 'Solar estimate draws recorded forecast evidence');
  assert(solarPaths.some(path => path.dash.length === 0 && path.path.some(command => command.method === 'lineTo')),
    'Solar estimate uses a solid canvas stroke alongside the same-colour future forecast');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=solar_forecast] .chart-legend-swatch').dataset.pattern"), 'dash-dot',
    'Future solar forecast retains a distinct dash-dot stroke');
  assert(solarPaths.some(path => JSON.stringify(path.dash) === '[8,3,2,3]' && path.path.some(command => command.method === 'lineTo')),
    'Future solar forecast uses a dash-dot canvas stroke');
  await choose('view', 'phases');
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
  await choose('view', 'runtime');
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
  await choose('view', 'caravan_power');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=caravan_power]').getAttribute('aria-pressed')"), 'true');
  assert((await drawnPaths('caravan_power')).some(path => path.path.some(command => command.method === 'lineTo')),
    'Caravan meter intervals draw their average power');
  assert.match(await evaluate("document.querySelector('[data-chart-key=caravan_power]').title"), /kW/);
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
  await capture('caravan-power-dark');
  await choose('series', 'caravan_energy');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=caravan_energy] .chart-legend-swatch').dataset.kind"), 'interval-energy',
    'The explorer keeps the original Caravan energy intervals separately available');

  await choose('view', 'garage');
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
  await choose('view', 'garage_references');
  for (const key of ['garage_outcome_rear_reference', 'garage_outcome_front_reference']) {
    assert.equal(await shown(key), true, `${key}: achieved references are visible by default`);
    assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"]').closest('[data-axis]').dataset.axis`), 'right',
      `${key}: absolute reference temperature shares the °C axis with saved room readings`);
    assert((await drawnPaths(key)).some(path => path.path.some(command => ['lineTo', 'bezierCurveTo'].includes(command.method))),
      `${key}: saved reference evidence actually renders in the chart`);
  }
  await capture('garage-references-dark');
  await choose('view', 'garage_error');
  for (const key of ['garage_outcome_rear_error', 'garage_outcome_front_error']) {
    assert.equal(await shown(key), true, `${key}: both locations have visible held-out forecast errors`);
    assert.equal(await evaluate(`document.querySelector('[data-chart-key="${key}"]').closest('[data-axis]').dataset.axis`), 'left',
      `${key}: temperature error uses its own difference axis`);
    assert.match(await evaluate(`document.querySelector('[data-chart-key="${key}"]').title`), /Δ°C/);
    assert((await drawnPaths(key)).some(path => path.path.some(command => command.method === 'lineTo')),
      `${key}: reconstructed held-out error draws supported evidence`);
  }
  await capture('garage-errors-dark');
  await choose('view', 'garage_benefit');
  assert.equal(await evaluate("document.querySelector('[data-chart-key=garage_outcome_benefit] .chart-legend-swatch').dataset.kind"), 'episode');
  assert.match(await evaluate("document.querySelector('[data-chart-key=garage_outcome_benefit]').title"), /€\/episode/);
  const benefitPaths = await drawnPaths('garage_outcome_benefit');
  const benefitMarkers = benefitPaths.flatMap(path => path.path.filter(command => command.method === 'arc' && command.args[2] >= 4));
  assert.equal(benefitMarkers.length, 2, 'Each completed pause and recovery has one visible episode marker');
  assert(benefitPaths.every(path => path.path.every(command => !['lineTo', 'bezierCurveTo'].includes(command.method))),
    'Individual episode outcomes have no connecting line or invented duration');
  const [benefitX, benefitY] = benefitMarkers[0].args;
  assert.equal(await evaluate(`window.chartDrawing.some(row => row.method === 'fill' && ['rgba(0, 0, 0, 0)', '#00000000'].includes(row.color)
    && row.path.some(command => command.method === 'arc' && command.args[0] === ${benefitX} && command.args[1] === ${benefitY}))`), true,
  'Provisional episode markers are hollow');
  const benefitPoint = await evaluate(`(() => { const r=document.getElementById('history').getBoundingClientRect(); return {x:r.left+${benefitX}+2,y:r.top+${benefitY}+1}; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...benefitPoint }); await settle();
  assert.match(await evaluate("window.chartLabels.join(' ')"), /completed episode estimate.*provisional model estimate/,
    'Inspecting an episode clearly identifies its provisional model assessment');
  await capture('garage-benefit-dark');
  await choose('view', 'garage');
  await pickerMode('series');
  assert.equal(await pickerOpen(), true, 'The selection button opens the explorer and its catalogue switch keeps it open');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-mode-series', 'The selected catalogue receives initial focus');
  await searchSeries('');
  assert.equal(await evaluate("document.querySelectorAll('#chart-series [role=option]').length"), EXPLORER_SERIES.length);
  await checkPickerFits('Desktop');
  await searchSeries('pump interpreted');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#chart-series [role=option]')].map(option => option.dataset.seriesKey)"), ['garage_native_indoor_temperature']);
  const searchPoint = await evaluate("(() => { const r=document.getElementById('chart-series-search').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...searchPoint });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...searchPoint });
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-search', 'Deliberately clicking search enables keyboard search');
  await pressKey('ArrowDown');
  assert.equal(await evaluate("document.getElementById(document.activeElement.getAttribute('aria-activedescendant')).dataset.seriesKey"), 'garage_native_indoor_temperature');
  await pressKey('Enter');
  await until("document.getElementById('history').dataset.series === 'garage_native_indoor_temperature'");
  assert.equal(await pickerOpen(), false, 'Enter selects and closes the picker');
  assert.equal(await evaluate("document.activeElement.id"), 'chart-series-toggle', 'Selection restores focus to the compact series button');
  assert.match(await evaluate("document.getElementById('chart-view-description').textContent"), /Recorded temperature/);
  assert.equal(await evaluate("document.getElementById('chart-series-toggle-label').textContent"), 'Selected series');
  assert.match(await evaluate("document.getElementById('chart-series-selected').textContent"), /pump.*interpreted|interpreted.*pump/i);
  await openPicker();
  assert.equal(await evaluate("document.getElementById('chart-series-mode-series').getAttribute('aria-pressed')"), 'true', 'An individual selection opens the series catalogue');
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
  await choose('series', 'garage_door1_open');
  assert.equal(await evaluate("document.querySelector('#chart-activity [data-activity-key]').dataset.activityKey"), 'garage_door1_open');
  assert.equal(await evaluate("document.querySelectorAll('#chart-activity .mode-segment').length > 0"), true, 'Recorded state explorer has inspectable intervals');
  await choose('series', 'alarm_code');
  assert.equal(await evaluate("document.querySelectorAll('#chart-activity .mode-segment[data-kind=point]').length"), 1,
    'An isolated state report remains visible as a point without inventing duration');
  assert.match(await evaluate("document.querySelector('#chart-activity .mode-segment').title"), /Value 13.*duration unknown/);
  assert.equal(await evaluate("document.querySelector('.chart-legend-group[data-axis=right] .chart-legend-axis').textContent"), 'Price',
    'A state-only explorer labels its price axis without claiming temperature series');

  await choose('view', 'power');
  await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true"); await settle();
  const plotPoint = await evaluate(`(() => {
    const r = document.getElementById('history').getBoundingClientRect();
    return {x:r.left+r.width*.47,y:r.top+r.height*.45};
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...plotPoint }); await settle();
  assert.equal(await cursorHidden(), true, 'Hovering the main plot does not activate the time cursor');
  const cursorPoint = await bandPoint();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...cursorPoint }); await settle();
  await checkCursorSegments(cursorPoint.x, 'Desktop band hover');
  const beforeBandDrag = await viewportState();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...cursorPoint });
  const dragged = await bandPoint(.71);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: dragged.x, y: dragged.y - 24 }); await settle();
  await checkCursorSegments(dragged.x, 'Desktop drag beyond the originating band');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...dragged }); await settle();
  assert.deepEqual(await viewportState(), beforeBandDrag, 'Dragging a band changes neither the visible interval nor magnification');
  const rowPoint = await bandPoint(.71, 'dhwr_active-history');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rowPoint }); await settle();
  assert.equal(await evaluate("document.querySelector('.chart-crosshair-readout').hidden"), false);
  assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /Hot-water circulation feedback/);
  await capture('power-dark-cursor');
  const captionPoint = await evaluate("(() => { const r=document.querySelector('#dhwr_active-history .activity-summary').getBoundingClientRect(); return {x:r.left+r.width*.71,y:r.top+r.height/2}; })()");
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...captionPoint }); await settle();
  assert.equal(await cursorHidden(), true, 'Captions between bands do not activate the cursor');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...plotPoint }); await settle();
  assert.equal(await cursorHidden(), true, 'Returning to the main plot keeps its pointer free of the time cursor');
  await evaluate("document.getElementById('chart-fullscreen').click(); true");
  await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'"); await settle();
  await checkLegendDisclosure('Desktop fullscreen', true);
  await checkScrollbarAlignment('Desktop fullscreen');
  await evaluate("document.getElementById('history').focus(); document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown',{key:'+',bubbles:true})); true");
  await until("document.querySelector('.chart-gesture-preview') === null");
  const beforePlotDrag = await viewportState();
  const dragPlot = await evaluate("(() => {const r=document.getElementById('history').getBoundingClientRect();return{x:r.left+r.width*.5,y:r.top+r.height*.5};})()");
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...dragPlot });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...dragPlot });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: dragPlot.x + 60, y: dragPlot.y });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: dragPlot.x + 60, y: dragPlot.y }); await settle();
  assert(Number((await viewportState()).from) < Number(beforePlotDrag.from), 'Dragging the main chart still moves the visible interval horizontally');
  assert.equal(await cursorHidden(), true, 'Panning the main chart does not show a vertical cursor');
  await until("document.querySelector('.chart-gesture-preview') === null");
  const zoomBeforeBand = await viewportState(), zoomBand = await bandPoint(.47);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...zoomBand });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: zoomBand.x + 60, y: zoomBand.y });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, x: zoomBand.x + 60, y: zoomBand.y }); await settle();
  await checkCursorSegments(zoomBand.x + 60, 'Magnified desktop band drag');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomBand.x, y: zoomBand.y, deltaX: 80, deltaY: -200 }); await settle();
  assert.deepEqual(await viewportState(), zoomBeforeBand, 'Dragging and wheel gestures on bands cannot pan or zoom a magnified chart');
  await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  await evaluate("document.getElementById('theme-toggle').click(); true"); await settle();
  await capture('power-light');
  await evaluate("document.getElementById('theme-toggle').click(); true");

  for (const [width, height] of [[390, 844], [320, 568]]) {
    await viewport(width, height, true);
    await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true"); await settle();
    await checkFits(`${width}px dashboard`);
    await evaluate("document.querySelector('#operating-modes .mode-track').scrollIntoView({block:'center'}); true"); await settle();
    const dashboardStart = await bandPoint(.35), dashboardEnd = await bandPoint(.6), dashboardView = await viewportState();
    await send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{...dashboardStart,id:1}]});
    await send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{...dashboardEnd,id:1}]});
    await send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]}); await settle();
    await checkCursorSegments(dashboardEnd.x, `${width}px dashboard touch drag`);
    assert.deepEqual(await viewportState(), dashboardView, `${width}px: dashboard band inspection keeps the whole selected interval`);
    await evaluate("document.getElementById('chart-fullscreen').click(); true");
    await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'"); await settle();
    await checkFits(`${width}px fullscreen`);
    await checkLegendDisclosure(`${width}px fullscreen`, true);
    await checkScrollbarAlignment(`${width}px fullscreen`);
    assert.equal(await evaluate("[...document.querySelectorAll('.mode-history:not([hidden]) .activity-caption')].every(fold=>fold.open || fold.getBoundingClientRect().height<=24)"), true,
      `${width}px: every closed activity title stays on one compact line`);
    assert.equal(await evaluate("[...document.querySelectorAll('.activity-key-inline')].every(key=>!key.checkVisibility())"), true,
      `${width}px: compact closed titles keep colour keys inside their folds`);
    await evaluate("document.querySelector('#operating-modes .activity-summary').click(); true"); await settle();
    assert.equal(await evaluate("document.querySelector('#operating-modes .activity-description .activity-key-items').checkVisibility()"), true,
      `${width}px: opening the title reveals every colour and its explanation`);
    await checkFits(`${width}px expanded activity explanation`);
    await capture(`mobile-${width}-activity-explanation-dark`);
    await evaluate("document.querySelector('#operating-modes .activity-summary').click(); true"); await settle();
    const point = await evaluate("(() => { const r = document.getElementById('history').getBoundingClientRect(); return {x:r.left+r.width*.48,y:r.top+r.height*.45}; })()");
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    assert.equal(await cursorHidden(), true, `${width}px: tapping the main plot does not show a time cursor`);
    const touchBand = await bandPoint(.35), touchEnd = await bandPoint(.65), beforeTouch = await viewportState();
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touchBand, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x:touchEnd.x,y:touchEnd.y-20,id:1 }] }); await settle();
    await checkCursorSegments(touchEnd.x, `${width}px touch drag outside the originating band`);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    await checkCursorSegments(touchEnd.x, `${width}px touch release retains the inspected time`);
    assert.deepEqual(await viewportState(), beforeTouch, `${width}px: a band drag changes neither magnification nor time range`);
    const pinchLeft = await bandPoint(.3), pinchRight = await bandPoint(.7);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{...touchBand,id:1},{...touchEnd,id:2}] });
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{...pinchLeft,id:1},{...pinchRight,id:2}] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    assert.deepEqual(await viewportState(), beforeTouch, `${width}px: two fingers on a band cannot zoom or pan the chart`);
    await capture(`mobile-${width}-dark`);
    await evaluate("document.getElementById('history').focus(); document.getElementById('history').dispatchEvent(new KeyboardEvent('keydown', {key:'+',bubbles:true})); true");
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension').hidden"), true, 'Keyboard zoom clears the old time cursor before gesture capture');
    await until("document.querySelector('.chart-gesture-preview') === null");
    await openPicker();
    await searchViews('');
    await checkPickerFits(`${width}px fullscreen views`);
    await searchSeries('');
    const searchTouch = await evaluate("(() => { const r=document.getElementById('chart-series-search').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()");
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...searchTouch, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    assert.equal(await evaluate("document.activeElement.id"), 'chart-series-search', `${width}px: search accepts an intentional touch`);
    await pressKey('Escape'); await openPicker(); await searchSeries('');
    assert.equal(await evaluate("document.getElementById('history').dataset.view"), 'power',
      `${width}px fullscreen: changing catalogue keeps the active chart`);
    await checkPickerFits(`${width}px fullscreen series`);
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
    await choose('view', 'power');
    await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  }
  for (const [width, height] of [[1280, 1100], [390, 844]]) {
    await viewport(width, height, width < 600);
    for (const theme of ['dark', 'light']) {
      if (await evaluate('document.documentElement.dataset.theme') !== theme)
        await evaluate("document.getElementById('theme-toggle').click(); true");
      for (const key of ['power', 'garage', 'heating_water', 'temperatures', 'garage_references', 'garage_error', 'garage_benefit', 'explorer']) {
        if (key === 'explorer') await choose('series', 'garage_native_indoor_temperature');
        else await choose('view', key);
        await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'}); true");
        await checkFits(`${width}px ${theme} ${key}`);
        await capture(`${key}-${width}-${theme}`);
        if (key === 'explorer') {
          await openPicker(); await checkPickerFits(`${width}px ${theme}`);
          await capture(`picker-${width}-${theme}`); await pressKey('Escape');
        }
      }
      await choose('view', 'power');
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
      await checkFits(`${width}px ${theme} fullscreen`);
      await capture(`fullscreen-${width}-${theme}`);
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
    }
  }
  for (const [width, height] of [[600, 360], [667, 375], [844, 390], [932, 430], [768, 1024], [320, 568], [390, 844]]) {
    await viewport(width, height, true);
    for (const theme of ['dark', 'light']) {
      if (await evaluate('document.documentElement.dataset.theme') !== theme)
        await evaluate("document.getElementById('theme-toggle').click(); true");
      await choose('view', 'power');
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
      for (const subject of ['power', 'model_coefficient_hydronic_response']) {
        await choose('view', subject);
        const label = `${width}×${height} ${theme} ${subject}`;
        await checkFits(label);
        const header = await evaluate(`(() => {
          const rect = id => { const r = document.getElementById(id).getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, centerY: r.top + r.height / 2 }; };
          return { start: rect('date-start'), end: rect('date-end'), selection: rect('chart-series-toggle'), exit: rect('chart-fullscreen') };
        })()`);
        assert(Object.values(header).every(rect => rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= height),
          `${label}: every header control stays inside the viewport`);
        assert(header.start.right < header.end.left && header.selection.right < header.exit.left,
          `${label}: the date fields and selection/Exit controls do not overlap`);
        assert(Math.abs(header.selection.centerY - header.exit.centerY) < 2,
          `${label}: selection and Exit share a row`);
        if (width >= 600) {
          assert(Math.abs(header.start.centerY - header.selection.centerY) < 2
            && Math.abs(header.end.centerY - header.selection.centerY) < 2,
          `${label}: date fields occupy the same header row as selection and Exit`);
          assert(header.end.right < header.selection.left && header.start.left <= 20 && header.exit.right >= width - 20,
            `${label}: dates align left and selection/Exit align right without overlap`);
        } else {
          assert(header.selection.bottom <= header.start.top,
            `${label}: narrow portrait keeps usable separate rows`);
        }
        await capture(`header-${width}x${height}-${subject}-${theme}`);
      }
      await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
    }
  }
  for (const [width, height] of [[1280, 1100], [390, 844], [320, 568]]) {
    await viewport(width, height, width < 600);
    for (const theme of ['dark', 'light']) {
      if (await evaluate('document.documentElement.dataset.theme') !== theme)
        await evaluate("document.getElementById('theme-toggle').click(); true");
      await evaluate("document.getElementById('timing-details').open=false; document.getElementById('recording-details').open=false; document.getElementById('timing-details').scrollIntoView({block:'center'}); true");
      await settle();
      const geometry = id => evaluate(`(() => {
        const summary = document.querySelector('#${id} > summary'), text = summary.querySelector('span');
        const outer = summary.getBoundingClientRect(), inner = text.getBoundingClientRect();
        const before = getComputedStyle(summary, '::before'), after = getComputedStyle(summary, '::after');
        return { height: outer.height, textInset: inner.left - outer.left,
          textCenter: inner.top + inner.height / 2 - outer.top, textHeight: inner.height,
          arrow: { content: before.content, width: before.width, height: before.height,
            marginLeft: before.marginLeft, marginRight: before.marginRight, order: before.order },
          trailingArrow: after.content, fits: outer.left >= 0 && outer.right <= innerWidth };
      })()`);
      const comparison = await geometry('timing-details'), recording = await geometry('recording-details');
      for (const key of ['height', 'textInset', 'textCenter', 'textHeight'])
        assert(Math.abs(comparison[key] - recording[key]) < 1, `${width}px ${theme}: footer ${key} aligns across the two closed folds`);
      assert.deepEqual(comparison.arrow, recording.arrow, `${width}px ${theme}: both folds use the same leading arrow`);
      assert(comparison.arrow.content !== 'none' && parseFloat(comparison.arrow.width) > 0
        && parseFloat(comparison.arrow.width) < comparison.textInset,
      `${width}px ${theme}: an arrow precedes each footer title`);
      assert([comparison, recording].every(row => row.trailingArrow === 'none' && row.fits),
        `${width}px ${theme}: footer titles fit without a trailing marker`);
      await capture(`footer-folds-${width}-${theme}`);
      for (const [id, closed] of [['timing-details', comparison], ['recording-details', recording]]) {
        await evaluate(`document.querySelector('#${id} > summary').click(); true`); await settle();
        const open = await geometry(id);
        for (const key of ['height', 'textInset', 'textCenter', 'textHeight'])
          assert(Math.abs(open[key] - closed[key]) < 1, `${width}px ${theme}: opening ${id} preserves its header geometry`);
        assert.equal(await evaluate(`document.getElementById('${id}').open`), true);
        if (id === 'recording-details') assert.equal(await evaluate("Boolean(document.querySelector('#recording-details > #recording-adaptive-details > summary'))"), true,
          'The recording fold retains its independently expandable Adaptive measurements section');
        await capture(`footer-${id}-open-${width}-${theme}`);
        await evaluate(`document.querySelector('#${id} > summary').click(); true`); await settle();
      }
    }
  }
  await viewport(1280, 460);
  await choose('view', 'power');
  await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  await checkLegendDisclosure('Short desktop fullscreen', true);
  await checkScrollbarAlignment('Short desktop fullscreen');
  await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  await viewport(390, 400, true);
  await choose('view', 'power');
  await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  await checkLegendDisclosure('Short phone fullscreen', true);
  await evaluate("document.getElementById('chart-fullscreen').click(); true"); await settle();
  await searchSeries('');
  await checkPickerFits('Phone with a short available viewport');
  await capture('picker-short-phone'); await pressKey('Escape');
  assert.deepEqual(errors, [], 'All view selections and cursor interactions have no uncaught browser exceptions');
  console.log(`Chart views browser checks passed: ${CHART_VIEWS.length} named views, ${EXPLORER_SERIES.length} searchable explorer choices, balanced Home/Garage learning groups, achieved references and held-out errors, isolated provisional episode markers and provenance, unified view/series browsing without chart changes, separate searches, centered modal keyboard/touch/focus without automatic search keyboards, periodic temperature Bézier geometry, solid solar history and dash-dot forecast, charger phase fills, visibility isolation, garage readback, crosshair bounds and touch, dark/light themes, 320/390px portrait, and aligned landscape/tablet headers with long selected labels.`);
  console.log(`Screenshots: ${screenshots.join(', ')}`);
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
