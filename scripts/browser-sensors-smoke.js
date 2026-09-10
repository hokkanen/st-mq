// Synthetic local fixture only. Requires an isolated Chrome DevTools listener.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { providerFixture } from './lib/provider-fixture.js';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-sensors-ui-'));
const now = Date.parse('2026-09-10T12:00:00Z');
let app, socket, id = 0;
const pending = new Map(), errors = [];
try {
  const configPath = join(directory, 'fixture.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const control = { ...config.control,
    indoorSensorWeights: { indoor_temperature: 1 / 3, downstairs_temperature: 1 / 3, bedroom_temperature: 1 / 3 } };
  const seededStore = new Store(config.dbPath);
  try {
    const step = 15 * 60_000;
    for (let at = now - 8 * 3600_000, i = 0; at < now; at += step, i++) {
      const delta = Math.sin(i / 5) * 0.6;
      for (const [signal, value, source] of [
        ['indoor_temperature', 21.2 + delta, 'mqtt-temperature'],
        ['bedroom_temperature', 21.6 + delta, 'mqtt-temperature'],
        ['downstairs_temperature', 20.2 + delta, 'mqtt-temperature'],
        ['garage_temperature', 14 + delta, 'mqtt-temperature'],
        ['outdoor_temperature', 10 + delta * 4, 'fmi'],
      ]) seededStore.observation({ source, device: 'synthetic-sensor-chart', signal, value,
        unit: 'degC', sourceTime: at, receivedAt: at, quality: [] });
      if (i) appendLearningRecord(seededStore, 'providers', 'sample', {
        timestamp: at, windowStart: at - step, windowEnd: at, indoorC: 21 + delta, quality: [],
        inputSegments: [{ start: at - step, end: at, outdoorC: 10, solarRadiationWm2: 0,
          phase: 'normal', roomBoostC: 0, targetC: 21, thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] }],
      }, { config: control });
    }
  } finally { seededStore.close(); }
  const fixture = providerFixture(now);
  const temperatures = fixture.providerOptions.devices.temperatures;
  fixture.providerOptions.temperatureProvider = async () => {
    const original = await temperatures();
    return [...original, { ...original[0], signal: 'downstairs_temperature', value: 20.2 },
      { ...original[0], signal: 'bedroom_temperature', value: 21.6 }];
  };
  app = await start({ config: { ...config, input: 'providers', connections: fixture.connections, control },
  clock: () => now, providerOptions: fixture.providerOptions });
  const endpoint = process.argv[2] ?? 'http://127.0.0.1:39125';
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id, timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 20_000);
    pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`UI did not settle: ${expression}. ${errors.join('; ')}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await send('Page.navigate', { url: base });
  await until("document.getElementById('history')?.dataset.ready === 'true' && document.getElementById('indoor')?.textContent === '21.0 °C'");
  assert.equal(await evaluate("document.getElementById('indoor').textContent"), '21.0 °C');
  assert.equal(await evaluate("document.querySelector('.indoor-readings, #upstairs, #downstairs, #bedroom') === null"), true);
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('.metrics article > p'), node => node.textContent)"),
    ['INDOOR AVERAGE', 'OUTDOOR', 'HEATING REQUEST', 'ALL-IN PRICE']);
  const observations = (await fetch(`${base}/api/status`).then(response => response.json())).observations;
  for (const [key, value] of [['upstairs', 21.2], ['downstairs', 20.2], ['bedroom', 21.6]]) {
    assert.equal(observations[key].value, value, `${key} remains available to the controller`);
  }
  assert.equal(await evaluate("document.querySelector('[data-provider=main-temperatures] .provider-heading > strong').textContent"),
    'Main temperatures · Smartthings, FMI');
  assert.equal(await evaluate("document.querySelectorAll('#chart-legend [data-chart-key=\"model_indoor_temperature\"]').length"), 1);
  assert.equal(await evaluate("document.querySelector('#chart-legend [data-chart-key=\"model_indoor_temperature\"]').textContent"), 'Average indoor');
  for (const signal of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature']) {
    assert.equal(await evaluate(`document.querySelector('#chart-legend [data-chart-key="${signal}"]') === null`), true);
    assert.equal(await evaluate(`document.querySelector('#left-axis option[value="${signal}"]') === null`), true);
  }
  assert.deepEqual(await evaluate("Array.from(document.querySelector('#left-axis optgroup[label=\"Home temperatures · Recorded\"]').children, node => node.textContent)"), ['All home temperatures']);
  assert.equal(await evaluate("document.querySelector('#left-axis option[value=\"garage_temperature\"]') === null"), true);
  assert.equal(await evaluate("document.querySelector('#left-axis optgroup[label=\"Other air temperatures · Recorded\"]') === null"), true);
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"garage_temperature\"]').textContent"), 'Garage');
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"model_indoor_temperature\"]').textContent"), 'Average indoor');
  await evaluate("document.getElementById('left-axis').value='temperatures'; document.getElementById('left-axis').dispatchEvent(new Event('change'))");
  await until("document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]').length === 3");
  assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]'), node => node.textContent)"),
    ['Upstairs', 'Bedroom', 'Downstairs']);
  assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"garage_temperature\"]').textContent"), 'Garage');
  mkdirSync('var', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') document.getElementById('theme-toggle').click()`);
    const swatches = await evaluate(`(() => {
      const keys = ['model_indoor_temperature', 'indoor_temperature', 'bedroom_temperature', 'downstairs_temperature', 'outdoor_temperature', 'garage_temperature'];
      return Object.fromEntries(keys.map(key => [key, document.querySelector('#chart-legend [data-chart-key="' + key + '"] .chart-legend-swatch').style.backgroundColor]));
    })()`);
    assert.equal(new Set(Object.values(swatches)).size, 6, `${theme}: rooms, average, outdoor and garage use distinct colours`);
    const expected = await evaluate(`(() => {
      const styles = getComputedStyle(document.documentElement), swatch = document.createElement('span');
      return Object.fromEntries(['indoor', 'outdoor'].map(key => {
        swatch.style.backgroundColor = styles.getPropertyValue('--chart-' + key).trim();
        return [key, swatch.style.backgroundColor];
      }));
    })()`);
    assert.equal(swatches.model_indoor_temperature, expected.indoor, `${theme}: average retains indoor green`);
    assert.equal(swatches.outdoor_temperature, expected.outdoor, `${theme}: outdoor retains blue`);
    for (const selection of ['power', 'phases']) {
      await evaluate(`document.getElementById('left-axis').value='${selection}'; document.getElementById('left-axis').dispatchEvent(new Event('change'))`);
      const first = selection === 'power' ? 'property_power' : 'property_current_l1';
      await until(`Boolean(document.querySelector('#chart-legend [aria-label="Left axis"] [data-chart-key="${first}"]'))`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"model_indoor_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.model_indoor_temperature, `${theme}: the average keeps its colour with ${selection}`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"outdoor_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.outdoor_temperature, `${theme}: outdoor keeps its colour with ${selection}`);
      assert.equal(await evaluate("document.querySelector('#chart-legend [aria-label=\"Right axis\"] [data-chart-key=\"garage_temperature\"] .chart-legend-swatch').style.backgroundColor"),
        swatches.garage_temperature, `${theme}: garage stays on the right and keeps its colour with ${selection}`);
    }
    await evaluate("document.getElementById('left-axis').value='temperatures'; document.getElementById('left-axis').dispatchEvent(new Event('change'))");
    await until("document.querySelectorAll('#chart-legend [aria-label=\"Left axis\"] [data-chart-key]').length === 3");
    await evaluate("document.querySelector('.history-panel').scrollIntoView({block:'start'})");
    writeFileSync(`var/home-temperatures-${theme}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  await evaluate("document.getElementById('theme-toggle').click()");
  await evaluate("document.getElementById('sensor-change-details').open=true");
  await until("!document.getElementById('sensor-change-submit').disabled");
  assert.deepEqual(await evaluate("Array.from(document.getElementById('sensor-change-signal').options, option => option.textContent)"),
    ['Upstairs', 'Downstairs', 'Bedroom', 'Outdoor']);
  await evaluate("document.getElementById('sensor-change-signal').value='downstairs_temperature'; document.getElementById('sensor-change-reason').value='moved'; document.getElementById('sensor-change-signal').focus();");
  await evaluate("document.getElementById('sensor-change-refresh').click()");
  await until("!document.getElementById('sensor-change-refresh').disabled");
  assert.equal(await evaluate("document.getElementById('sensor-change-signal').value"), 'downstairs_temperature');
  assert.equal(await evaluate("document.activeElement.id"), 'sensor-change-signal');
  await evaluate("document.getElementById('sensor-change-submit').click()");
  await until("document.getElementById('sensor-change-entries').children.length === 1 && document.getElementById('indoor').textContent === '—'");
  assert.match(await evaluate("document.getElementById('sensor-change-message').textContent"), /Downstairs change recorded/);
  assert.match(await evaluate("document.getElementById('sensor-change-entries').textContent"), /Downstairs · Moved/);
  const settling = (await fetch(`${base}/api/status`).then(response => response.json())).observations;
  assert.equal(settling.downstairs.value, 20.2, 'raw sensor values remain available during settling');
  assert.equal(settling.downstairs.settling, true);
  assert.match(await evaluate("document.getElementById('indoor-age').textContent"), /Settling after sensor change/);
  const saved = await fetch(`${base}/api/sensor-changes`).then(response => response.json());
  assert.equal(saved.events.length, 1); assert.equal(saved.events[0].signal, 'downstairs_temperature');
  assert.equal(saved.events[0].reason, 'moved'); assert.equal(saved.events[0].at, now);
  mkdirSync('var', { recursive: true });
  for (const width of [1440, 375]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 600 });
    await evaluate("document.getElementById('sensor-change-details').scrollIntoView({block:'center'})");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `sensor form fits ${width}px`);
    assert.equal(await evaluate("document.getElementById('sensor-change-submit').checkVisibility()"), true);
    writeFileSync(`var/sensor-change-${width}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'sensor-ui-smoke-passed', checks: ['room cards removed', 'raw room readings retained', 'weighted indoor average',
    'one Average indoor chart legend', 'garage stays on right axis', 'garage and other air group removed from drawer', 'all home temperatures on left axis',
    'Smartthings source with local MQTT', 'distinct room colours in both themes', 'average and outdoor preserve colours',
    'configured sensor choices', 'selection and focus survive refresh', 'real sensor-change API submission',
    'server timestamp and single saved event', 'settling preserves raw readings', 'desktop and mobile layout'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
