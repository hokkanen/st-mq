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

const directory = mkdtempSync(join(tmpdir(), 'stmq-garage-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-garage-screenshots-'));
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
    throw new Error(`Garage UI did not settle: ${expression}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.controller-column > article, .controller-panels > article')].map(card => card.id)"),
    ['home-control', 'providers-controls', 'house-model'],
    'The existing dashboard cards are preserved');
  assert.equal(await evaluate("document.getElementById('learning-metrics').children.length"), 4,
    'The existing Home outcome entries are preserved');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#learning-panel-details > details > summary')].map(row => row.textContent.trim())"),
    await evaluate("[...document.querySelectorAll('#garage-learning-details > details > summary')].map(row => row.textContent.trim())"),
    'Home and Garage use the same outcome, input and coefficient fold headings');
  assert.match(await evaluate("document.getElementById('learning-progress').textContent"), /usable temperature intervals/);
  assert.match(await evaluate("document.getElementById('garage-learning-progress').textContent"), /completed cooling \/ recovery episodes.*validated pause hours/);
  assert.doesNotMatch(await evaluate("document.getElementById('garage-learning-progress').textContent"), /trained intervals|prediction checks/);
  for (const id of ['garage-learning-context', 'garage-input-context', 'garage-coefficient-context'])
    assert.ok((await evaluate(`document.getElementById('${id}').textContent`)).trim(), `${id} explains its list`);
  assert.equal(await evaluate("document.getElementById('garage-release').disabled"), true);
  assert.equal(await evaluate("document.getElementById('garage-controller-details').open || document.getElementById('garage-learning-details').open"), false);
  assert.equal(await evaluate("document.querySelector('[data-scope=home]').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.getElementById('timing-details').open=true; document.querySelector('[data-scope=garage]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /-€1.00.*Provisional/);
  await evaluate("document.querySelector('[data-scope=total]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /€2.00/);
  await evaluate("document.querySelector('[data-mode=timing]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /Timing cost saving/);
  await evaluate("document.querySelector('[data-scope=home]').click(); document.querySelector('[data-mode=model]').click()");
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 600 ? 1100 : 844, deviceScaleFactor: 1, mobile: false });
    for (const [id, name] of [['timing-details', 'savings'], ['garage-controller-details', 'equipment'],
      ['learning-panel-details', 'home-learning'], ['garage-learning-details', 'garage-learning'],
      ['model-inputs-details', 'home-inputs'], ['garage-learning-inputs', 'garage-inputs'],
      ['model-coefficients-details', 'home-coefficients'], ['garage-learning-coefficients', 'garage-coefficients']]) {
      await evaluate(`(() => { const element=document.getElementById('${id}'); element.open=true;
        for(let parent=element.parentElement;parent;parent=parent.parentElement) if(parent.tagName==='DETAILS') parent.open=true;
        if(['learning-panel-details','garage-learning-details'].includes('${id}')) element.querySelectorAll('details').forEach(fold=>fold.open=true);
        element.scrollIntoView({block:'start'}); })()`);
      await pause(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} fits ${width}px`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(artifacts, `${name}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
  }
  for (const left of ['garage_model_front', 'garage_model_difference', 'garage_coefficient_rear_lossPerHour']) {
    await evaluate(`document.getElementById('left-axis').value='${left}'; document.getElementById('left-axis').dispatchEvent(new Event('change'))`);
    await until(`document.getElementById('history').dataset.ready==='true' && document.getElementById('history').dataset.left==='${left}'`);
    assert.equal(await evaluate("document.getElementById('chart-status').textContent.includes('No recorded values')"), false, left);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'garage-browser-smoke-passed', artifacts,
    checks: ['Home default', 'separate scope and method controls', 'negative Garage and Total figures',
      'disabled release without an owned episode', 'closed Garage disclosures', '1440/390/320px layouts',
      'unchanged dashboard cards', 'matching Home and Garage learning headings', 'episode-based Garage progress',
      'Home and Garage learning folds fit desktop and mobile',
      'original input and replay coefficient charts', 'no browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
