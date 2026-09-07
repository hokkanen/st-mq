import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { providerFixture } from './lib/provider-fixture.js';
import { EventEmitter } from 'node:events';

// Requires a separately started isolated Firefox BiDi listener. This script
// creates its own temporary simulation, never reads household credentials.
const directory = mkdtempSync(join(tmpdir(), 'stmq-browser-chart-'));
const now = Date.parse('2026-09-07T12:00:00Z');
let app, ws;
const pending = new Map(), errors = [], timings = [];
let id = 0;
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  config.priceSettings = { ...config.priceSettings, effectiveDate: '2020-01-01' };
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  ws = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:39124/session');
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(message.id);
      message.type === 'error' ? p.reject(new Error(JSON.stringify(message))) : p.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params.level === 'error') errors.push(message.params.text);
  };
  const command = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await command('session.new', { capabilities: {} });
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const browserTimeZone = await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
  const until = async (expression, attempts = 150) => {
    for (let i = 0; i < attempts; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${JSON.stringify(errors)}`);
  };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const checkDateAlignment = async () => {
    assert.equal(await evaluate(`(() => {
      const start = document.getElementById('date-start'), end = document.getElementById('date-end');
      const a = start.getBoundingClientRect(), b = end.getBoundingClientRect();
      return ['top', 'height', 'width'].every(key => Math.abs(a[key] - b[key]) < 1)
        && getComputedStyle(start).fontSize === getComputedStyle(end).fontSize;
    })()`), true, 'Date fields have matching widths, heights, alignment and text size');
  };
  await command('browsingContext.navigate', { context, url: base, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.title'), 'Home Energy');
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await evaluate("document.getElementById('date-start').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  await checkDateAlignment();
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), false);
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  assert.equal(await evaluate("Array.from(document.querySelectorAll('.range-shortcuts button')).map(button => button.id).join(',')"), 'range-yesterday,range-today,range-tomorrow');
  assert.equal(await evaluate("document.getElementById('left-axis').value"), 'power');
  assert.equal(await evaluate("document.body.textContent.includes('A comfortable home')"), false);
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  const legendState = text => evaluate(`Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))?.getAttribute('aria-pressed')`);
  const checkPowerDrawn = async () => {
    await until(`document.getElementById('history').dataset.ready === 'true'
      && document.getElementById('history').dataset.left === 'power'
      && ['property_power', 'charger_power'].every(key =>
        document.querySelector('[data-chart-key="' + key + '"]')?.getAttribute('aria-pressed') === 'true')`);
    for (const key of ['property_power', 'charger_power']) {
      const changedPixels = await evaluate(`(async () => {
        const canvas = document.getElementById('history');
        const context = canvas.getContext('2d');
        const button = document.querySelector('[data-chart-key="${key}"]');
        const settled = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await settled();
        const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
        button.click();
        await settled();
        const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let changed = 0;
        for (let i = 0; i < before.length; i += 4) {
          if (before[i] !== after[i] || before[i + 1] !== after[i + 1]
            || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) changed++;
        }
        button.click();
        await settled();
        return changed;
      })()`);
      assert.ok(changedPixels > 0, `${key} draws visible chart pixels, not just a legend entry`);
    }
  };
  await checkPowerDrawn();
  assert.equal(await legendState('all-in'), 'true');
  assert.equal(await legendState('spot'), 'false');
  assert.equal(await legendState('dhwr'), 'false');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await evaluate("localStorage.setItem('home-energy-theme', 'light'); true");
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'Reload starts dark even with a legacy light preference');
  // A single start-date change opens one old day; the disabled end follows it.
  await evaluate("document.getElementById('date-start').value='2024-09-07'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2024-09-07' && document.getElementById('history').dataset.rangeEnd === '2024-09-07'");
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2024-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  // Clicking the label enables a range and places the cursor in the end picker.
  await evaluate("document.querySelector('.end-date-toggle').click(); true");
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), true);
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  assert.equal(await evaluate('document.activeElement.id'), 'date-end');
  await evaluate("document.getElementById('date-end').value='2024-09-09'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeEnd === '2024-09-09'");
  // An end before the start is rejected without replacing the plotted range.
  await evaluate("document.getElementById('date-end').value='2024-09-06'; document.getElementById('date-end').dispatchEvent(new Event('change')); true");
  assert.equal(await evaluate("document.getElementById('chart-range-form').checkValidity()"), false);
  assert.equal(await evaluate("document.getElementById('history').dataset.rangeEnd"), '2024-09-09');
  await evaluate("document.getElementById('date-range-enabled').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeEnd === '2024-09-07'");
  // Moving the start beyond an enabled end keeps a valid one-day selection.
  await evaluate("document.getElementById('date-range-enabled').click(); document.getElementById('date-start').value='2024-09-12'; document.getElementById('date-start').dispatchEvent(new Event('change')); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2024-09-12' && document.getElementById('history').dataset.rangeEnd === '2024-09-12'");
  await evaluate("document.getElementById('range-today').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), true);
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), false);
  assert.equal(await evaluate("document.getElementById('range-today').getAttribute('aria-pressed')"), 'true');
  await evaluate("Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes('spot')).click(); true");
  for (const [left, expected, absent] of [['phases', 'property_current_l1', 'property_power'], ['integral', 'heating_integral', 'charger_power'], ['power', 'property_power', 'heating_integral']]) {
    const began = performance.now();
    await evaluate(`document.getElementById('left-axis').value=${JSON.stringify(left)}; document.getElementById('left-axis').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)} && !!document.querySelector('[data-chart-key="${expected}"]') && !document.querySelector('[data-chart-key="${absent}"]')`);
    assert.equal(await legendState('spot'), 'true', 'Shared legend preference survives axis changes');
    assert.equal(await legendState('indoor'), 'true');
    if (left === 'power') await checkPowerDrawn();
    timings.push({ action: left, elapsedMs: Math.round(performance.now() - began) });
  }
  // Rapid changes must settle on the last request even if previous requests finish late.
  await evaluate("document.getElementById('range-yesterday').click(); document.getElementById('range-tomorrow').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  assert.equal(await evaluate("document.getElementById('date-end').disabled"), false);
  assert.equal(await evaluate("document.getElementById('date-range-enabled').checked"), true);
  await evaluate("document.getElementById('date-start').value='2026-09-08'; document.getElementById('date-end').value='2026-09-08'; document.getElementById('chart-range-form').requestSubmit(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-08' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
  const tomorrow = await fetch(`${base}/api/chart?start=2026-09-08&end=2026-09-08`).then(r => r.json());
  assert.ok(tomorrow.series.outdoor_forecast.length > 0);
  assert.ok(tomorrow.series.all_in_price.length > 0);
  assert.equal(tomorrow.series.indoor_temperature.some(p => p.y !== null), false);
  for (const series of Object.values(tomorrow.series)) assert.ok(series.every(p => p.x >= tomorrow.range.from && p.x <= tomorrow.range.to));
  await evaluate("document.getElementById('range-yesterday').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-06' && document.getElementById('history').dataset.rangeEnd === '2026-09-07'");
  const populated = await fetch(`${base}/api/chart?start=2026-09-06&end=2026-09-07`).then(r => r.json());
  for (const key of ['heatOff', 'auxHeat', 'dhwr']) assert.ok(populated.shading[key].length > 0, `Synthetic ${key} shading is available`);
  mkdirSync('var', { recursive: true });
  const capture = async name => {
    const shot = await command('browsingContext.captureScreenshot', { context, origin: 'viewport' });
    writeFileSync(`var/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  await capture('home-energy-dark-desktop');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await capture('home-energy-light-desktop');
  await checkDateAlignment();
  await evaluate("document.getElementById('theme-toggle').click(); true");
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile layout fits screen');
    await checkDateAlignment();
    await evaluate("document.getElementById('date-range-enabled').click(); true");
    await checkDateAlignment();
    await evaluate("document.getElementById('date-range-enabled').click(); true");
    await capture(`home-energy-dark-${viewport.width}`);
    await evaluate("document.querySelector('.history-panel').scrollIntoView(); true");
    await capture(`home-energy-chart-${viewport.width}`);
    await evaluate('scrollTo(0, 0); true');
  }
  // Home controls use Finnish wall times even in a browser running in another zone.
  assert.equal(await evaluate("document.querySelectorAll('.controller-panels article').length"), 4);
  assert.equal(await evaluate("document.getElementById('home-control').textContent.includes('Household')"), false);
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Active');
  assert.equal(await evaluate("document.querySelector('#settings-form, #contract-form, #override-form') === null"), true);
  assert.equal(await evaluate("document.getElementById('contract-periods').textContent.includes('2.91788')"), true);
  assert.equal(await evaluate("document.getElementById('data-details').open"), false);
  assert.equal(await evaluate("document.getElementById('heating-test-details').open"), false);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
  assert.equal(await evaluate("document.querySelector('.controller-column .temporary-panel') !== null && document.querySelector('.controller-column:nth-child(2) .electricity-panel') !== null"), true);
  await evaluate(`document.getElementById('away-until').value = '2026-09-09T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('pause-until').value = '2026-09-07T18:00';
    document.getElementById('pause-until').dispatchEvent(new Event('input'));
    document.getElementById('temporary-form').requestSubmit(); true`);
  await until("document.getElementById('temporary-message').textContent === 'Changes applied.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Paused', 'A pause takes precedence over away mode');
  assert.equal(app.engine.settings.occupancy.returnAt, '2026-09-09T15:00:00.000Z');
  assert.equal(app.engine.status().override.expiresAt, Date.parse('2026-09-07T15:00:00Z'));
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('away-until').value === '2026-09-09T18:00'");
  assert.equal(await evaluate("document.getElementById('pause-until').value"), '2026-09-07T18:00');
  assert.equal(await evaluate("document.getElementById('temporary-submit').disabled"), true);
  // Pending edits survive blur and an actual background status poll.
  await evaluate(`window.__statusPolls = 0; const originalFetch = window.fetch;
    window.fetch = (...args) => { if (args[0] === '/api/status') window.__statusPolls++; return originalFetch(...args); };
    document.getElementById('away-until').value = '2026-09-10T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('away-until').blur(); true`);
  await until('window.__statusPolls > 0', 650);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00');
  await evaluate("document.getElementById('resume-now').click(); true");
  await until("document.getElementById('override-status').textContent === 'Price control is not paused.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Away');
  assert.equal(app.engine.settings.occupancy.returnAt, '2026-09-09T15:00:00.000Z', 'Resuming preserves the saved away deadline');
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00', 'Resuming preserves an unrelated pending edit');
  assert.equal(await evaluate("document.getElementById('temporary-submit').disabled"), false);
  await evaluate("document.getElementById('home-now').click(); true");
  await until("document.getElementById('away-status').textContent === 'At home.'");
  assert.equal(await evaluate("document.getElementById('control-price').textContent"), 'Active');
  assert.equal(await evaluate("document.getElementById('away-until').value"), '');
  assert.equal(app.engine.settings.occupancy.mode, 'occupied');
  // Invalid DST choices leave both settings untouched and the draft available to correct.
  await evaluate(`document.getElementById('away-until').value = '2026-10-25T03:30';
    document.getElementById('away-until').dispatchEvent(new Event('input'));
    document.getElementById('pause-until').value = '2026-09-07T18:00';
    document.getElementById('pause-until').dispatchEvent(new Event('input'));
    document.getElementById('temporary-form').requestSubmit(); true`);
  await until("document.getElementById('temporary-message').classList.contains('form-error')");
  assert.equal(app.engine.settings.occupancy.mode, 'occupied');
  assert.equal(app.engine.status().override, null);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-10-25T03:30');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('history').dataset.ready === 'true'");
  await until("document.getElementById('events').children.length > 0");
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 390, height: 844 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    await evaluate("document.getElementById('home-control').scrollIntoView(); true");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Home controls fit desktop and mobile');
    assert.equal(await evaluate(`(() => {
      const a = document.getElementById('away-until').getBoundingClientRect();
      const b = document.getElementById('pause-until').getBoundingClientRect();
      return Math.abs(a.width-b.width) < 1 && Math.abs(a.height-b.height) < 1;
    })()`), true, 'Temporary date fields match');
    await capture(`home-energy-controls-${viewport.width}`);
  }
  await app.close();
  const fixture = providerFixture(now);
  const fixtureCurrents = fixture.providerOptions.devices.easee;
  // Equalizer phases share an acquisition but retain independent source clocks.
  // This used to leave property power empty while charger power still rendered.
  fixture.providerOptions.devices.easee = async () => (await fixtureCurrents()).map(row => ({ ...row,
    sourceTime: row.sourceTime - (row.signal.startsWith('property_current_') ? (Number(row.signal.at(-1)) - 1) * 90_000 : 0),
  }));
  const testPublishes = [];
  let testConnections = 0, acknowledgeHeating;
  const connectTestBroker = () => {
    testConnections++;
    const client = new EventEmitter();
    client.publish = (topic, payload, options, callback) => { testPublishes.push({ topic, payload, options }); acknowledgeHeating = callback; };
    client.end = (force, options, callback) => callback?.();
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
  app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'provider-fixture.sqlite'),
    connections: { ...fixture.connections, mqtt: { address: 'mqtt://fixture.invalid' } } },
    clock: () => now, providerOptions: fixture.providerOptions, mqttOptions: { connect: connectTestBroker } });
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
  await until("document.getElementById('outdoor-age').textContent.includes('FMI nearby station')");
  await until("document.getElementById('history').dataset.ready === 'true'");
  const providerChart = await fetch(`http://127.0.0.1:${app.server.address().port}/api/chart?start=2026-09-07&end=2026-09-07&left=power`).then(response => response.json());
  for (const [key, expected] of [['property_power', 6.9], ['charger_power', 2.07]]) {
    assert.ok(providerChart.series[key].some(point => Number.isFinite(point.y) && Math.abs(point.y - expected) < 1e-9),
      `${key} contains the expected total from all three provider phase currents`);
  }
  await checkPowerDrawn();
  for (const left of ['phases', 'integral', 'power']) {
    await evaluate(`document.getElementById('left-axis').value=${JSON.stringify(left)}; document.getElementById('left-axis').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)}`);
  }
  await checkPowerDrawn();
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Using backup')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Electricity market · Elering')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Next ENTSO-E try')"), true);
  assert.equal(await evaluate("document.getElementById('weather-status').textContent.includes('FMI')"), true);
  assert.equal(testConnections, 0, 'Configured manual tests do not connect during startup or polling');
  assert.equal(await evaluate("document.getElementById('heating-test-details').open"), false);
  await evaluate(`document.getElementById('heating-test-details').open = true;
    document.getElementById('away-until').value = '2026-09-10T18:00';
    document.getElementById('away-until').dispatchEvent(new Event('input')); true`);
  for (const command of ['heatoff', 'heaton15', 'heaton60']) {
    acknowledgeHeating = null;
    await evaluate(`document.getElementById('test-${command}').click(); document.getElementById('test-${command}').click(); true`);
    await until("document.getElementById('heating-test-buttons').getAttribute('aria-busy') === 'true'");
    for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(typeof acknowledgeHeating, 'function');
    assert.equal(await evaluate("[...document.querySelectorAll('[data-heating-command]')].every(button => button.disabled)"), true);
    assert.equal(await evaluate("document.getElementById('heating-test-message').textContent.includes('sent via MQTT')"), false);
    acknowledgeHeating();
    await until(`document.getElementById('heating-test-message').textContent.includes('${command} sent via MQTT') && !document.getElementById('test-${command}').disabled`);
    assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-10T18:00');
  }
  assert.deepEqual(testPublishes, ['heatoff', 'heaton15', 'heaton60'].map(payload => ({ topic: 'from_stmq/heat/action', payload, options: { qos: 1, retain: false } })));
  assert.equal(app.engine.status().observations.actual.mode, 'unknown');
  acknowledgeHeating = null;
  await evaluate("document.getElementById('test-heatoff').click(); true");
  for (let i = 0; !acknowledgeHeating && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof acknowledgeHeating, 'function');
  acknowledgeHeating(new Error('synthetic-private-broker-error'));
  await until("document.getElementById('heating-test-message').classList.contains('form-error') && !document.getElementById('test-heatoff').disabled");
  assert.equal(await evaluate("document.body.textContent.includes('synthetic-private-broker-error')"), false);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-desktop');
  await evaluate("document.getElementById('data-details').open = true; document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-desktop');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate("document.querySelector('.temporary-panel').scrollIntoView({block:'start'}); true");
  await capture('home-energy-mqtt-tests-mobile');
  await evaluate("document.getElementById('data-details').open = true; document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-mobile');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'chart-browser-smoke-passed', browserTimeZone, timings,
    checked: ['default-dark-on-reload', 'theme-toggle', 'Finnish-today', 'single-old-day', 'optional-end-date', 'range-validation', 'shortcut-order-and-state', 'axis-and-legend-selection', 'property-and-charger-visible-pixels', 'asynchronous-provider-phase-power', 'price-defaults', 'date-races', 'tomorrow-only', 'desktop-mobile', 'Finnish-away-and-pause', 'independent-cancellation', 'draft-poll-preservation', 'DST-atomic-rejection', 'read-only-rates', 'four-controller-panels', 'provider-sources-and-fallbacks', 'collapsed-MQTT-tests', 'MQTT-publish-acknowledgement-and-failure', 'MQTT-draft-preservation'] }, null, 2));
  await command('browser.close', {});
} finally {
  ws?.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
