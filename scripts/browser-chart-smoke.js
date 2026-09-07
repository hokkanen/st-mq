import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { providerFixture } from './lib/provider-fixture.js';

// Requires a separately started isolated Firefox BiDi listener. This script
// creates its own temporary simulation, never reads household credentials.
const directory = mkdtempSync(join(tmpdir(), 'stmq-browser-chart-'));
const now = Date.parse('2026-09-07T12:00:00Z');
let app, ws;
const pending = new Map(), errors = [], timings = [];
let id = 0;
try {
  const config = loadConfig({ STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' });
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  app.engine.addContractPeriod({ effectiveDate: '2020-01-01', marginCtPerKwh: 0.5, taxCtPerKwh: 2, vatRate: 0.25, tariff: 'day-night' });
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
  const until = async expression => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${JSON.stringify(errors)}`);
  };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await command('browsingContext.navigate', { context, url: base, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.title'), 'Home Energy');
  assert.equal(await evaluate("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await evaluate("document.getElementById('date-start').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('date-end').value"), '2026-09-07');
  assert.equal(await evaluate("document.getElementById('left-axis').value"), 'power');
  assert.equal(await evaluate("document.body.textContent.includes('A comfortable home')"), false);
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  const legendState = text => evaluate(`Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))?.getAttribute('aria-pressed')`);
  assert.equal(await legendState('all-in'), 'true');
  assert.equal(await legendState('spot'), 'false');
  assert.equal(await legendState('dhwr'), 'false');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await command('browsingContext.reload', { context, wait: 'complete' });
  await until("document.getElementById('chart-legend').querySelectorAll('button').length > 5");
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await evaluate("document.getElementById('theme-toggle').click(); true");
  await evaluate("Array.from(document.querySelectorAll('#chart-legend button')).find(b => b.textContent.toLowerCase().includes('spot')).click(); true");
  for (const [left, expected, absent] of [['phases', 'property_current_l1', 'property_power'], ['integral', 'heating_integral', 'charger_power'], ['power', 'charger_power', 'heating_integral']]) {
    const began = performance.now();
    await evaluate(`document.getElementById('left-axis').value=${JSON.stringify(left)}; document.getElementById('left-axis').dispatchEvent(new Event('change')); true`);
    await until(`document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.left === ${JSON.stringify(left)} && !!document.querySelector('[data-chart-key="${expected}"]') && !document.querySelector('[data-chart-key="${absent}"]')`);
    assert.equal(await legendState('spot'), 'true', 'Shared legend preference survives axis changes');
    assert.equal(await legendState('indoor'), 'true');
    timings.push({ action: left, elapsedMs: Math.round(performance.now() - began) });
  }
  // Rapid changes must settle on the last request even if previous requests finish late.
  await evaluate("document.getElementById('range-yesterday').click(); document.getElementById('range-tomorrow').click(); true");
  await until("document.getElementById('history').dataset.ready === 'true' && document.getElementById('history').dataset.rangeStart === '2026-09-07' && document.getElementById('history').dataset.rangeEnd === '2026-09-08'");
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
  await evaluate("document.getElementById('theme-toggle').click(); true");
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await command('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile layout fits screen');
    await capture(`home-energy-dark-${viewport.width}`);
    await evaluate("document.querySelector('.history-panel').scrollIntoView(); true");
    await capture(`home-energy-chart-${viewport.width}`);
    await evaluate('scrollTo(0, 0); true');
  }
  // The surrounding controller forms still operate against this isolated simulation.
  await evaluate("document.getElementById('duration').value='120'; document.getElementById('override-form').requestSubmit(); true");
  await until("document.getElementById('override-status').textContent.includes('until')");
  await evaluate("document.getElementById('max-drop').value='0.9'; document.getElementById('settings-form').requestSubmit(); true");
  await until("document.getElementById('drop').textContent === '0.9 °C'");
  assert.equal(await evaluate("document.getElementById('contract-vat').value"), '', 'Rates are not prefilled');
  await evaluate(`document.getElementById('contract-editor').open = true;
    document.getElementById('contract-date').value = '2026-09-07';
    document.getElementById('contract-margin').value = '1.25';
    document.getElementById('contract-tax').value = '2';
    document.getElementById('contract-vat').value = '24';
    document.getElementById('contract-tariff').value = 'seasonal';
    document.getElementById('contract-tariff').dispatchEvent(new Event('change'));
    document.getElementById('contract-form').requestSubmit(); true`);
  await until("document.getElementById('contract-message').textContent.includes('Dated rates saved')");
  await until("document.getElementById('contract-periods').textContent.includes('1.25 c/kWh')");
  assert.equal(app.engine.contract().periods.at(-1).vatRate, 0.24);
  assert.equal(await evaluate("document.getElementById('contract-vat').value"), '');
  await until("document.getElementById('history').dataset.ready === 'true'");
  assert.equal(await legendState('spot'), 'true', 'Contract refresh preserves legend preferences');
  await until("document.getElementById('events').children.length > 0");
  await app.close();
  const fixture = providerFixture(now);
  app = await start({ config: { ...config, input: 'providers', dbPath: join(directory, 'provider-fixture.sqlite'), connections: fixture.connections },
    clock: () => now, providerOptions: fixture.providerOptions });
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
  await until("document.getElementById('outdoor-age').textContent.includes('FMI nearby station')");
  await until("document.getElementById('history').dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Using backup')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Electricity market · Elering')"), true);
  assert.equal(await evaluate("document.getElementById('providers').textContent.includes('Next ENTSO-E try')"), true);
  assert.equal(await evaluate("document.getElementById('weather-status').textContent.includes('FMI')"), true);
  await evaluate("document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-desktop');
  await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 844 }, devicePixelRatio: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await evaluate("document.getElementById('providers').scrollIntoView({block:'center'}); true");
  await capture('home-energy-provider-fixture-mobile');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'chart-browser-smoke-passed', timings,
    checked: ['default-dark', 'theme-persistence', 'Finnish-today', 'axis-and-legend-selection', 'price-defaults', 'date-races', 'tomorrow-only', 'desktop-mobile', 'override-settings-contract-forms', 'provider-sources-and-fallbacks'] }, null, 2));
  await command('browser.close', {});
} finally {
  ws?.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
