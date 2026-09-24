// Local synthetic fixture and disposable browser profile; no household services.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { Store } from '../src/storage/store.js';
import { seedChartFixture } from './lib/chart-fixture.js';
import { appendGarageEntry } from '../src/garage/learning.js';
import { garageSettings } from '../src/garage/settings.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-garage-learning-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-garage-learning-screenshots-'));
const profile = join(directory, 'chrome'); mkdirSync(profile);
const now = Date.parse('2026-09-07T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  const configPath = join(directory, 'synthetic.json'); writeFileSync(configPath, '{}');
  const config = loadConfig({ STMQ_CONFIG: configPath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  const store = new Store(config.dbPath);
  seedChartFixture(store, now);
  for (let index = 0; index < 30; index++) {
    const at = now - (31 - index) * 60_000;
    appendGarageEntry(store, 'simulated', 'sample', { at, rearAt: at, rearC: 8 - index * .004,
      frontAt: at, frontC: 7.5 - index * .006, outdoorAt: at, outdoorC: 4, outdoorSource: 'simulation',
      available: true, powerKw: .4, powerQuality: 'provisional', ev1Kw: 0, ev2Kw: 0 }, garageSettings(), at);
  }
  store.cycle('simulated', { id: 'synthetic-home-browser-cycle', status: 'completed', startedAt: now - 7_200_000,
    endedAt: now - 3_600_000, assessment: { basis: 'estimated-space-heating-execution-and-reference', profitCents: 300 } });
  store.cycle('garage:simulated', { id: 'synthetic-garage-browser-cycle', status: 'completed', startedAt: now - 7_200_000,
    endedAt: now - 3_600_000, assessment: { basis: 'garage-frozen-normal-reference', profitCents: -100, includesGarageOnly: true, provisional: true } });
  store.close(); app = await start({ config, clock: () => now });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox',
    '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Isolated Chromium DevTools listener started');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(expression)) return; await pause(30); }
    throw new Error(`Garage UI did not settle: ${expression}. ${errors.join("; ")}. State: ${await evaluate("JSON.stringify({ phase: globalThis.garageSmokePhase, basis: document.getElementById('garage-native-target-basis')?.textContent, error: document.getElementById('error')?.textContent })")}`);
  };
  const keyPress = async key => {
    const code = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : 'Space', virtualKey = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 32;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: virtualKey, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
  };
  const clickSummaryPadding = async id => {
    const point = await evaluate(`(() => {
      const summary = document.querySelector('#${id} > summary');
      summary.scrollIntoView({block: 'center'});
      const box = summary.getBoundingClientRect();
      return {x: box.left + 6, y: box.bottom - 6};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  await send('Runtime.enable'); await send('Page.enable');

  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000) globalThis.refreshGarageSmoke = () => callback(...args);
      return originalInterval(callback, delay, ...args);
    };
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.garageSmokeTarget = null; globalThis.garageSmokePhase = 'disabled'; globalThis.garageSmokeCalls = [];
    globalThis.fetch = async (input, options) => {
      const path = new URL(input.url ?? String(input), location.href).pathname;
      let response;
      if (path === '/api/garage/native') {
        const command = JSON.parse(options.body); globalThis.garageSmokeCalls.push(command);
        globalThis.garageSmokeTarget = command.value; globalThis.garageSmokePhase = 'preparing';
        response = await originalFetch('/api/status');
      } else response = await originalFetch(input, options);
      if (!['/api/status', '/api/garage/native'].includes(path)) return response;
      const status = await response.json(), at = status.now;
      status.garage.adapter = { ...status.garage.adapter, connected: true, baselineVerified: false,
        health: { deviceOnline: true, pumpCommunicating: true },
        native: { power: 'on', powerAt: at, mode: 'heat', targetC: 17,
          readbacks: Object.fromEntries(['power', 'mode', 'targetC'].map(field => [field, { measuredAt: at }])) } };
      const targetC = globalThis.garageSmokeTarget, phase = globalThis.garageSmokePhase;
      status.garage.roomTemperature = { targetC, phase, acknowledged: phase === 'active',
        sourceC: phase === 'waiting' ? null : 0, measuredAt: phase === 'waiting' ? null : at,
        offsetC: targetC === null ? 0 : 17 - targetC, suppliedC: phase === 'active' ? 17 - targetC : null,
        nativeTargetC: 17, reason: phase === 'waiting' ? 'rear-temperature-stale' : null };
      status.garage.nativeControls = { available: true, busy: false, pending: false,
        settings: { targetC: { supported: true, available: true, usable: true, value: targetC ?? 17, min: 5, max: 31, step: .5 } },
        result: targetC === null ? null : { setting: 'targetC', value: targetC, status: phase === 'active' ? 'acknowledged' : 'saved' } };
      if (globalThis.garageSmokeMissing) {
        status.garage.observations.rear = { value: null };
        status.garage.learning.coefficients.rear[0].value = null;
      } else {
        status.garage.observations.rear = { value: 0, stale: false };
        status.garage.learning.coefficients.rear[0].value = 0;
      }
      if (globalThis.garageSmokeReadOnly) status.readOnly = true;
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#garage-learning-details > details > summary')].map(node => node.textContent.trim())"),
    await evaluate("[...document.querySelectorAll('#learning-panel-details > details > summary')].map(node => node.textContent.trim())"));
  assert.equal(await evaluate(`(() => {
    const pause = document.getElementById('garage-pause-details'), settings = document.getElementById('garage-settings-details'),
      learning = document.getElementById('garage-learning-details');
    return Boolean(pause.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(settings.compareDocumentPosition(learning) & Node.DOCUMENT_POSITION_FOLLOWING)
      && !settings.closest('.learning-model-details');
  })()`), true, 'Temporary control and permanent preferences precede learning, matching Home');
  await evaluate("document.getElementById('garage-heating-details').open=true; document.getElementById('garage-learning-details').open=true");
  const sections = ['outcomes', 'inputs', 'coefficients', 'planning'];
  for (const name of sections) {
    const id = `garage-${name}-details`, root = `garage-learning-${name}`;
    await evaluate(`document.querySelector('#${id} > summary').focus()`); await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${id}').open`), true);
    await evaluate(`document.querySelector('#${root} > .learning-entry > summary').focus()`); await keyPress('Enter');
    assert.equal(await evaluate(`document.querySelector('#${root} > .learning-entry').open`), true);
    await evaluate(`globalThis.garageSmokeRow = document.querySelector('#${root} > .learning-entry'); globalThis.refreshGarageSmoke()`);
    await pause(100);
    assert.equal(await evaluate(`globalThis.garageSmokeRow === document.querySelector('#${root} > .learning-entry')
      && globalThis.garageSmokeRow.open && document.activeElement === globalThis.garageSmokeRow.querySelector('summary')`), true,
      `${name} retains the open row and focused summary across polling`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.querySelector('#${root} > .learning-entry').open`), false);
  }
  for (const missing of [true, false]) {
    await evaluate(`globalThis.garageSmokeMissing=${missing}; globalThis.refreshGarageSmoke()`);
    await until(`document.querySelector('#garage-learning-inputs [data-learning-key="rear-air-temperature"] .learning-entry-value').textContent === '${missing ? 'Unavailable' : '0 °C'}'`);
    assert.equal(await evaluate("document.querySelector('#garage-learning-coefficients [data-learning-key=rear-cooling-rate] .learning-entry-value').textContent"), missing ? 'Unavailable' : '0 1/h');
  }
  assert.equal(await evaluate("document.querySelectorAll('#garage-learning-coefficients > .learning-entry').length"), 6);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#garage-learning-coefficients > .learning-row-group')].map(node => node.textContent)"),
    ['Learned cooling', 'Electricity estimate', 'Fixed assumptions'], 'Each coefficient group appears once after repeated refreshes');
  await evaluate("document.getElementById('garage-equipment-details').open=true; document.getElementById('garage-controller-details').open=true; document.getElementById('garage-native-control-details').open=true");
  await until("document.getElementById('garage-native-submit').disabled === false");
  assert.equal(await evaluate("document.getElementById('garage-assume-isave')"), null);
  assert.doesNotMatch(await evaluate('document.body.textContent'), /Assume i-save|Assumes i-save|controller’s assumption/);
  assert.equal(await evaluate("document.getElementById('garage-native-target').textContent"), '17 °C');
  assert.equal(await evaluate("document.getElementById('garage-native-temperature').min"), '5');
  await evaluate("document.getElementById('garage-native-temperature').value='5'; document.getElementById('garage-native-temperature').dispatchEvent(new Event('input')); document.getElementById('garage-native-form').requestSubmit()");
  await until("document.getElementById('garage-native-target-basis').textContent === 'External sensor · preparing'");
  assert.deepEqual(await evaluate('globalThis.garageSmokeCalls'), [{ setting: 'targetC', value: 5 }]);
  await evaluate("globalThis.garageSmokePhase='active'; globalThis.refreshGarageSmoke()");
  await until("document.getElementById('garage-native-target-basis').textContent === 'Garage rear · active'");
  assert.equal(await evaluate("document.getElementById('garage-native-target').textContent"), '5 °C');
  assert.equal(await evaluate("document.getElementById('garage-native-temperature').value"), '5');
  assert.match(await evaluate("document.querySelector('#garage-native-readings [data-reading=native-targetC]').textContent"), /17 °C/);
  assert.match(await evaluate("document.getElementById('garage-native-reported').textContent"), /17 °C/);
  await evaluate("document.querySelector('#garage-pump-reading-info .status-detail-trigger').click()");
  assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /adds 12 °C/);
  await evaluate("document.querySelector('.status-detail-close').click()");
  await evaluate("globalThis.garageSmokePhase='waiting'; globalThis.refreshGarageSmoke()");
  await until("document.getElementById('garage-native-target-basis').textContent === 'External sensor · fallback'");
  assert.equal(await evaluate("document.getElementById('garage-native-target').textContent"), '5 °C');
  assert.equal(await evaluate("document.getElementById('garage-room-temperature-status').textContent"), 'Room setting 5 °C. External temperature control is unavailable.');
  await evaluate("document.querySelector('#garage-native-temperature-details .status-detail-trigger').click()");
  assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /internal temperature sensor when the current permission expires/);
  await evaluate("document.querySelector('.status-detail-close').click()");
  await evaluate("globalThis.garageSmokePhase='active'; globalThis.garageSmokeReadOnly=true; globalThis.refreshGarageSmoke()");
  await until("document.getElementById('garage-native-submit').disabled === true");
  assert.equal(await evaluate("document.getElementById('garage-native-target').textContent"), '5 °C');
  await evaluate("globalThis.garageSmokeReadOnly=false; globalThis.refreshGarageSmoke()");
  await until("document.getElementById('garage-native-submit').disabled === false");
  const capture = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    for (const name of sections) {
      await evaluate(`{ for (const name of ${JSON.stringify(sections)}) document.getElementById('garage-' + name + '-details').open=name==='${name}';
        const section = document.getElementById('garage-${name}-details');
        section.querySelector('.learning-entry').open=true; section.scrollIntoView({block:'start'}); }`);
      await pause(30);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} fits ${width}px ${theme}`);
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#garage-learning-details .learning-entry > summary')).filter(node => node.checkVisibility()).flatMap(node => {
        const box = node.getBoundingClientRect();
        return box.left >= -1 && box.right <= innerWidth + 1 && [...node.querySelectorAll('.learning-entry-title, .learning-entry-value')].every(item => item.scrollWidth <= item.clientWidth + 1)
          ? [] : [node.parentElement.dataset.learningKey];
      })`), [], `${name} values stay inside their rows`);
      await capture(`${name}-${width}-${theme}`);
    }
    await evaluate("document.getElementById('garage-controller-details').scrollIntoView({block:'start'})");
    await capture(`mitsubishi-external-${width}-${theme}`);
    await evaluate("document.getElementById('garage-learning-details').open=false; document.getElementById('garage-settings-details').open=true; document.getElementById('garage-manual-controls').scrollIntoView({block:'start'})");
    await capture(`heating-configuration-${width}-${theme}`);
    await evaluate("document.getElementById('garage-learning-details').open=true; document.getElementById('garage-settings-details').open=false");
  }
  await evaluate("document.getElementById('dashboard-reset').click()");
  assert.equal(await evaluate("document.querySelectorAll('details[open]').length"), 0);
  assert.equal(await evaluate("document.activeElement.id"), 'dashboard-reset');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'garage-learning-browser-smoke-passed', artifacts,
    checks: ['four matching Home/Garage learning sections', 'configuration before learning', 'keyboard entry and section controls',
      'polling preserves focus and open rows', 'missing versus zero inputs', 'two cooling rates and explicit assumptions',
      '5°C target via existing setting form', 'external active/preparing/fallback with actual17 visible', 'read-only setting gate',
      '320,390,1440px layouts in both themes', 'no browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
