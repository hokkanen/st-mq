// Disposable simulated app and actual browser input; no household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { seedChartFixture } from '../../scripts/lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-chart-touch-'));
const now = Date.parse('2026-09-07T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;
try {
  const configuration = join(directory, 'configuration.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  seedChartFixture(app.store, now);
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chromium')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let port;
  for (let attempt = 0; attempt < 150 && !port; attempt++) {
    try { port = Number(readFileSync(join(directory, 'chromium', 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(40);
  }
  assert(port, 'Disposable Chromium starts');
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
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(`(()=>{try{return (${expression});}catch{return false;}})()`)) return;
      await pause(40);
    }
    throw new Error(`UI did not settle: ${expression}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.popupText = [];
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
      if (this.canvas.id === 'history') window.popupText.push(String(text));
      return original.call(this, text, ...args);
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  await evaluate("document.getElementById('chart-fullscreen').click()");
  await until("document.querySelector('.history-panel').dataset.fullscreen === 'true'");
  const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) => ({ ...point, id: index + 1 })) });
  const painted = () => evaluate('window.popupText.some(line => /^(Property|Charger [12]|Average indoor|Outdoor|All-in price|Spot price):/.test(line))');
  const clear = async () => {
    await evaluate("document.getElementById('history').dispatchEvent(new MouseEvent('mouseout',{bubbles:true}));window.popupText=[]");
    await pause(80);
  };
  for (const [width, height] of [[390, 844], [320, 568], [1280, 900]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await pause(250);
    const point = await evaluate("(()=>{const r=document.getElementById('history').getBoundingClientRect();return {x:r.left+r.width*.55,y:r.top+r.height*.45};})()");
    for (const [dx, dy] of [[45, 0], [0, 35]]) {
      await clear(); await touch('touchStart', [point]); await pause(80);
      assert.equal(await painted(), false, `${width}px: touch-down does not open a popup`);
      for (let step = 1; step <= 5; step++) {
        await touch('touchMove', [{ x: point.x + dx * step / 5, y: point.y + dy * step / 5 }]); await pause(20);
      }
      assert.equal(await painted(), false, `${width}px: dragging does not open a popup`);
      await touch('touchEnd', []); await pause(250);
      assert.equal(await painted(), false, `${width}px: drag release does not open a popup`);
    }
    await clear(); await touch('touchStart', [{ x: point.x - 20, y: point.y }, { x: point.x + 20, y: point.y }]);
    await touch('touchMove', [{ x: point.x - 35, y: point.y }, { x: point.x + 35, y: point.y }]);
    await touch('touchEnd', []); await pause(250);
    assert.equal(await painted(), false, `${width}px: pinching does not open a popup`);
    await clear(); await touch('touchStart', [point]); await touch('touchEnd', []); await pause(150);
    assert.equal(await painted(), true, `${width}px: a completed tap opens a popup`);
    await clear();
    const band = await evaluate("(()=>{const r=document.querySelector('#operating-modes .mode-track').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height*.5};})()");
    await touch('touchStart', [band]);
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension')?.hidden !== false"), true);
    await touch('touchMove', [{ x: band.x + 40, y: band.y }]); await touch('touchEnd', []); await pause(100);
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension')?.hidden !== false"), true, 'Band dragging leaves details closed');
    await touch('touchStart', [band]); await touch('touchEnd', []); await pause(100);
    assert.equal(await evaluate("document.querySelector('.chart-crosshair-extension')?.hidden"), false, 'Band tapping opens details');
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  }
  assert.deepEqual(errors, []);
  console.log('Chart touch browser checks passed: horizontal/vertical drag, pinch, release and tap-only plot/band inspection at 320/390px and touchscreen desktop size.');
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
