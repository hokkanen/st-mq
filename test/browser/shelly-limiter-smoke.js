// Run after npm run build. Every provider/status/action below is synthetic;
// the isolated application and disposable browser never load household config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { ChargingLimiterHistory } from '../../src/charging/limiter-history.js';
import { seedChartFixture } from '../../scripts/lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-limiter-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-limiter-screenshots-'));
const now = Date.parse('2026-09-30T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  seedChartFixture(app.store, now);
  const recorder = new ChargingLimiterHistory({ store: app.store, input: 'simulated' });
  const states = [
    { mode: 'unrestricted', allowanceA: 16, loadAllowanceA: 16, reason: 'hardware-restriction', appliedCurrentA: 16, applicationStatus: 'confirmed' },
    { mode: 'limited', allowanceA: 8, loadAllowanceA: 8, reason: 'priority-allocation', appliedCurrentA: 12, applicationStatus: 'pending' },
    { mode: 'paused-by-balancing', allowanceA: 0, loadAllowanceA: 0, reason: 'fuse-limit', appliedCurrentA: 6, applicationStatus: 'confirmed' },
    { mode: 'fallback', allowanceA: 12, loadAllowanceA: 12, reason: 'telemetry-fallback', appliedCurrentA: 12, applicationStatus: 'confirmed' },
    { mode: 'inactive', allowanceA: null, loadAllowanceA: null, reason: 'disconnected', appliedCurrentA: null, applicationStatus: 'inactive' },
    { mode: 'unknown', allowanceA: null, loadAllowanceA: null, reason: 'charger-unavailable', appliedCurrentA: null, applicationStatus: 'unknown' },
  ];
  const settling = { mode: 'unknown', allowanceA: 14, loadAllowanceA: 14, reason: 'measurement-settling', appliedCurrentA: 14, applicationStatus: 'confirmed' };
  for (let at = now - 6 * 3600_000; at <= now; at += 20_000)
    recorder.observe({ association: 'a'.repeat(64), status: at >= now - 60_000 && at < now - 20_000
      ? settling : states[Math.min(5, Math.floor((at - now + 6 * 3600_000) / 3600_000))] }, at);
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; browser errors: ${errors.join(', ')}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const keyPress = async key => {
    const windowsVirtualKeyCode = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode }); await settle();
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const original = window.fetch.bind(window);
    window.limiterFixture = { state: ${JSON.stringify(settling)}, responses: 0 };
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!String(args[0]).endsWith('/api/status')) return response;
      const status = await response.json();
      for (const charger of status.charging.chargers) {
        charger.values.connected = { value: true, available: true };
        charger.request = { sessionId: 'invented-limiter-session', revision: 1, overrides: {} };
        if (charger.id === 'charger2') charger.limiter = limiterFixture.state;
        else delete charger.limiter;
      }
      limiterFixture.responses++;
      return new Response(JSON.stringify(status), { status: 200 });
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.querySelector('[data-activity-key=shellyLimiter] [data-value=fallback]') && document.querySelector('#charger2-limiter button')");
  const row = '[data-activity-key=shellyLimiter]', track = `${row} .mode-track`;
  assert.deepEqual(await evaluate(`Array.from(new Set([...document.querySelectorAll('${track} .mode-segment')].map(node=>node.dataset.value)))`),
    ['unknown', 'unrestricted', 'limited', 'paused-by-balancing', 'fallback', 'inactive']);
  assert.equal(await evaluate("document.getElementById('charger1-limiter').hidden"), true);
  assert.match(await evaluate("document.getElementById('charger2-limiter').textContent"), /Unknown · Waiting for matching load readings/);
  for (const theme of ['dark', 'light']) for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}'); document.getElementById('garage-control').open = true; true`); await settle();
    await evaluate("document.querySelector('#charger2-limiter button').scrollIntoView({block:'center'}); document.querySelector('#charger2-limiter button').focus(); true");
    await keyPress('Enter');
    await until("document.getElementById('status-detail-popover')?.hidden === false");
    assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /Held allowance: 14 A/);
    assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /Charger setting: 14 A confirmed/);
    assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /Current headroom is not yet confirmed/);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} ${width}px: card and details fit`);
    assert.equal(await evaluate("(() => {const r=document.getElementById('status-detail-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()"), true);
    await keyPress('Escape');
    assert.equal(await evaluate("document.activeElement === document.querySelector('#charger2-limiter button')"), true);
    let screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `limiter-card-${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    await evaluate(`document.querySelector('${row}').scrollIntoView({block:'center'}); document.querySelector('${track}').focus(); true`);
    await keyPress('Home'); await keyPress('ArrowRight');
    assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /Unrestricted · 16 A/);
    await keyPress('ArrowRight');
    assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /Limited · 8 A.*\nAwaiting charger confirmation/);
    await keyPress('End'); await keyPress('ArrowLeft');
    assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /Unknown · Waiting for matching load readings\nHeld allowance: 14 A\nCharger setting: 14 A confirmed/);
    assert.equal(await evaluate(`document.querySelector('${row} .activity-caption').open`), false, 'Keyboard inspection works with the title folded');
    const colors = await evaluate(`(() => [...document.querySelectorAll('${track} .mode-segment')].reduce((out,node)=>({...out,[node.dataset.value]:getComputedStyle(node).backgroundColor}),{}))()`);
    assert.equal(new Set(Object.entries(colors).filter(([mode])=>!['inactive','unknown'].includes(mode)).map(([,color])=>color)).size, 4);
    assert.match(await evaluate(`getComputedStyle(document.querySelector('${track} [data-value=unknown]')).backgroundImage`), /linear-gradient/);
    await keyPress('Escape');
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    // Pointer-capability media queries rebuild the strips. Finish that layout
    // change before locating the target and starting a real touch gesture.
    await settle();
    const point = await evaluate(`(() => {const r=document.querySelector('${track} [data-value=fallback]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle();
    assert.match(await evaluate("document.querySelector('.chart-crosshair-readout').textContent"), /Fallback · 12 A/);
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-readout').hidden"), false, 'Touch selection remains visible after lifting the finger');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${theme} ${width}px: history fits`);
    screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `limiter-history-${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
  for (const [kind, name] of [['view', 'phases'], ['series', 'charger2_power']]) {
    await evaluate("document.getElementById('chart-series-toggle').click(); true");
    await until("document.getElementById('chart-series-picker').open");
    await evaluate(`document.getElementById('chart-series-mode-${kind === 'view' ? 'views' : 'series'}').click(); true`);
    await evaluate(`document.querySelector('[data-${kind}-key=${name}]').click(); true`);
    await until(`document.getElementById('history').dataset.${kind} === '${name}' && document.getElementById('history').dataset.ready === 'true'`);
    assert.equal(await evaluate(`document.querySelector('${row}').hidden`), false, `${name}: limiter history accompanies the relevant electrical series`);
    assert.equal(await evaluate(`document.querySelector('${track} [data-value=fallback]') !== null`), true);
  }
  assert.deepEqual(errors, []);
  console.log(`Shelly limiter browser checks passed: six modes, recorded settling spans, keyboard and touch inspection, held-setting badge details, 320/390/1440px in both themes. Synthetic screenshots: ${artifacts}`);
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
