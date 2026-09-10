// Synthetic local fixture only. Requires an isolated Chrome DevTools listener.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { providerFixture } from './lib/provider-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-sensors-ui-'));
const now = Date.parse('2026-09-10T12:00:00Z');
let app, socket, id = 0;
const pending = new Map(), errors = [];
try {
  const configPath = join(directory, 'fixture.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const fixture = providerFixture(now);
  fixture.connections.smartthings.downstairs_temp_dev_id = 'synthetic-downstairs';
  fixture.connections.smartthings.bedroom_temp_dev_id = 'synthetic-bedroom';
  const temperatures = fixture.providerOptions.devices.temperatures;
  fixture.providerOptions.temperatureProvider = async () => {
    const original = await temperatures();
    return [...original, { ...original[0], signal: 'downstairs_temperature', value: 20.2 },
      { ...original[0], signal: 'bedroom_temperature', value: 21.6 }];
  };
  app = await start({ config: { ...config, input: 'providers', connections: fixture.connections,
    control: { ...config.control, indoorSensorWeights: { indoor_temperature: 1 / 3, downstairs_temperature: 1 / 3, bedroom_temperature: 1 / 3 } } },
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
  await until("document.getElementById('history')?.dataset.ready === 'true' && document.getElementById('upstairs')?.textContent === '21.2 °C'");
  assert.equal(await evaluate("document.getElementById('indoor').textContent"), '21.0 °C');
  assert.equal(await evaluate("document.getElementById('downstairs').textContent"), '20.2 °C');
  assert.equal(await evaluate("document.getElementById('bedroom').textContent"), '21.6 °C');
  for (const label of ['Upstairs', 'Downstairs', 'Bedroom']) {
    assert.equal(await evaluate(`document.getElementById('chart-legend').textContent.includes(${JSON.stringify(label)})`), true);
  }
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
  assert.equal(await evaluate("document.getElementById('downstairs').textContent"), '20.2 °C', 'raw sensor values stay visible during settling');
  assert.match(await evaluate("document.getElementById('downstairs-age').textContent"), /Settling after sensor change/);
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
  console.log(JSON.stringify({ result: 'sensor-ui-smoke-passed', checks: ['separate room readings', 'weighted indoor average',
    'three chart legends', 'configured sensor choices', 'selection and focus survive refresh', 'real sensor-change API submission',
    'server timestamp and single saved event', 'settling preserves raw readings', 'desktop and mobile layout'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
