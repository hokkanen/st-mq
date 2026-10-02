// Real shared charger renderer and styles, isolated synthetic data and requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-controls-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-charging-controls-screenshots-'));
const pending = new Map(), errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, sequence = 0;
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/chart/monitor.css"><title>Charging controls fixture</title></head>
<body data-authenticated="true"><main style="max-width:1100px;margin:auto;padding:16px"><section class="garage-chargers zone-content">
<p id="charging-status"></p><div id="charging-devices" class="charging-device-list"></div></section></main>
<script type="module">
import { createChargingPanel } from '/chart/charging.js';
const now = Date.parse('2026-10-02T12:00:00Z');
const reading = (value, source = 'fixture') => ({ value, source, available: true, measuredAt: now });
const longText = 'The charger has not confirmed whether the earlier stop instruction belongs to automatic scheduling or another controller. Review the current charger state before requesting a handover. This explanation must remain fully readable even when the charger is offline and its recorded message includes '+ 'UnbrokenSyntheticStatus'.repeat(7) + '. End of complete explanation.';
function charger(id, provider) {
  return { id, provider, label: id === 'charger1' ? 'Charger 1' : 'Charger 2', association: 'fixture:' + id,
    settings: { enabled: true, readyBy: '06:00', manualSoc: 20, minimumSoc: 80, capacityKwh: 74 },
    defaults: { readyBy: '06:00', manualSoc: 20, minimumSoc: 80, capacityKwh: 74 },
    controls: { enabled: true, revision: 4 }, request: { sessionId: 'session:' + id, revision: 7, overrides: {} },
    capabilities: { scheduling: true, currentControl: provider === 'shelly-evse', externalLoadBalancing: provider === 'easee' },
    values: { connected: reading(true), charging: reading(false), soc: reading(42, 'teslamate'), minimumSoc: reading(80, 'manual-fallback'), capacityKwh: reading(74, 'manual-fallback') },
    requiredGridKwh: 30, plan: { startAt: now + 3600000, finishAt: now + 7200000, deadlineAt: now + 10800000, feasible: true },
    control: { phase: 'manual', reason: 'manual-stop', manual: { kind: 'stop' }, takeover: { available: true, token: 'native:' + id } } };
}
const fixture = globalThis.chargingFixture = { writes: [], longText };
const panel = createChargingPanel({ document, request: async (path, payload) => {
  fixture.writes.push([path, payload]);
  if (fixture.hold) await new Promise(resolve => { fixture.finish = resolve; });
  if (fixture.error) throw new Error(fixture.error);
  const id = path.split('/')[4], item = fixture.status.charging.chargers.find(charger => charger.id === id);
  if (path.endsWith('/control')) { item.settings.enabled = payload.enabled; item.controls.enabled = payload.enabled; item.controls.revision++; }
  if (path.endsWith('/use-automatic')) { item.settings.enabled = true; item.controls.enabled = true; item.request.chargeNow = false;
    item.control.takeover = { available: false, token: null, state: 'pending' }; }
  if (path.endsWith('/charge-now')) item.request.chargeNow = true;
  if (path.endsWith('/resume')) item.request.chargeNow = false;
  return structuredClone(fixture.status);
} });
fixture.setCase = name => {
  fixture.error = null; fixture.hold = false;
  fixture.status = { now, role: 'master', charging: { timezone: 'Europe/Helsinki', settings: { priority: 'balanced' },
    controls: { priority: 'balanced', revision: 1 }, chargers: [charger('charger1', 'easee'), charger('charger2', 'shelly-evse')] } };
  for (const item of fixture.status.charging.chargers) {
    if (name === 'ordinary') item.control = { phase: 'waiting', owned: { startAt: now + 3600000 }, takeover: { available: true, token: 'native:' + item.id } };
    if (name === 'long') { item.control.reason = longText; item.control.manual.reason = longText; item.label += ' with a long synthetic descriptive name'; }
    if (name === 'pending') item.control.takeover = { available: false, token: null, state: 'pending' };
    if (name === 'blocked') item.control.takeover = { available: false, token: null, state: 'blocked', reason: longText };
    if (name === 'unavailable') item.control.takeover = { available: false, token: null, reason: 'Fresh charger readings are unavailable. Check the connection and try again.' };
    if (name === 'estimate') item.progress = { estimatedSoc: 55.6, hasEnergyEstimate: true, deliveredGridKwh: 10, remainingGridKwh: 20 };
    if (name === 'readonly') item.readOnly = true;
  }
  panel.update(fixture.status);
};
fixture.refresh = () => panel.update(fixture.status);
fixture.setCase('ordinary');
</script></body></html>`;
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (!/^\/chart\/[a-z0-9-]+\.(?:js|css)$/.test(path) && !/^\/src\/[a-z0-9/-]+\.js$/.test(path)) { response.writeHead(404); response.end(); return; }
  try { response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(readFileSync(join(root, path))); }
  catch { response.writeHead(404); response.end(); }
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`Timeout ${method}`)), 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => { for (let n = 0; n < 150; n++) { if (await evaluate(expression)) return; await pause(30); } throw new Error(`Timed out: ${expression}; ${JSON.stringify(errors)}`); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until('Boolean(globalThis.chargingFixture) && Boolean(document.getElementById("charger2-use-automatic"))');

  for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    for (const state of ['ordinary', 'long', 'manual-stop', 'pending', 'blocked', 'unavailable', 'estimate', 'readonly']) {
      await evaluate(`chargingFixture.setCase('${state}'); document.querySelectorAll('.charging-device').forEach(card => card.open = true)`);
      const layout = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.charging-device')];
        return { overflow: document.documentElement.scrollWidth > innerWidth, cards: cards.map(card => {
          const summary = card.querySelector('summary'), box = summary.getBoundingClientRect();
          const nodes = [...card.querySelectorAll('*')].filter(node => node.checkVisibility() && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()));
          const clipped = nodes.filter(node => { const style = getComputedStyle(node); return style.textOverflow === 'ellipsis' || !['none', '0'].includes(style.webkitLineClamp) || node.scrollWidth > node.clientWidth + 1 && ['hidden', 'clip'].includes(style.overflowX); }).map(node => node.id || node.className);
          const outside = [...summary.children].filter(node => node.checkVisibility() && node.getBoundingClientRect().bottom > box.bottom + 1).map(node => node.id || node.className);
          const action = card.querySelector('.charging-use-automatic');
          return { id: card.id, clipped, outside, action: { label: action.textContent, disabled: action.disabled, visible: action.checkVisibility(), parent: action.parentElement.id.replace(/^charger[12]/, 'charger') } };
        }) };
      })()`);
      assert.equal(layout.overflow, false, `${width}px ${theme} ${state}: no horizontal overflow`);
      for (const card of layout.cards) { assert.deepEqual(card.clipped, [], `${width}px ${theme} ${state} ${card.id}: readable text`); assert.deepEqual(card.outside, [], `${width}px ${theme} ${state} ${card.id}: summary grows around text`); }
      assert.deepEqual(layout.cards[0].action, layout.cards[1].action, 'Both providers render the same action and capability state');
      assert.equal(layout.cards[0].action.label, 'Use automatic');
      assert.equal(layout.cards[0].action.disabled, ['pending', 'blocked', 'unavailable', 'readonly'].includes(state));
      if (state === 'long') {
        for (const id of ['charger1', 'charger2']) {
          await evaluate(`document.querySelector('#${id}-event-value button').click()`);
          assert.equal(await evaluate("document.getElementById('status-detail-popover').textContent.includes(chargingFixture.longText)"), true, 'The popup preserves the full original explanation');
          assert.equal(await evaluate("document.getElementById('status-detail-popover').scrollWidth <= document.getElementById('status-detail-popover').clientWidth + 1"), true, 'Long words wrap inside the popup');
          await evaluate("document.querySelector('.status-detail-close').click()");
        }
        const metrics = await send('Page.getLayoutMetrics');
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height: Math.min(metrics.cssContentSize.height, 12000), scale: 1 } });
        writeFileSync(join(artifacts, `charging-long-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  for (const id of ['charger1', 'charger2']) {
    await evaluate(`chargingFixture.setCase('manual-stop'); chargingFixture.writes = []; document.getElementById('${id}-enabled').click()`);
    await until('chargingFixture.writes.length === 1');
    assert.equal((await evaluate('chargingFixture.writes[0]'))[0], `/api/charging/chargers/${id}/control`, 'The preference switch does not take over');
    await evaluate(`chargingFixture.hold = true; document.getElementById('${id}-use-automatic').click()`);
    await until('Boolean(chargingFixture.finish)');
    assert.equal(await evaluate(`document.getElementById('${id}-use-automatic').disabled`), true);
    const action = await evaluate('chargingFixture.writes[1]');
    assert.equal(action[0], `/api/charging/chargers/${id}/use-automatic`);
    assert.deepEqual(action[1], { association: `fixture:${id}`, sessionId: `session:${id}`, revision: 7, controlRevision: 5, takeoverToken: `native:${id}` });
    await evaluate('chargingFixture.hold = false; chargingFixture.finish(); chargingFixture.finish = null');
    await until(`document.getElementById('${id}-takeover-help').textContent.includes('awaiting charger confirmation')`);
    assert.equal(await evaluate(`document.getElementById('${id}-enabled').getAttribute('aria-checked')`), 'true');
    assert.match(await evaluate(`document.getElementById('${id}-takeover-message').textContent`), /confirmed.*economic plan/);
    await evaluate(`chargingFixture.setCase('manual-stop'); chargingFixture.error = 'The charger changed after this view was loaded. Review its latest state before trying again.'; document.getElementById('${id}-use-automatic').click()`);
    await until(`document.getElementById('${id}-takeover-message').classList.contains('form-error')`);
    assert.match(await evaluate(`document.getElementById('${id}-takeover-message').textContent`), /charger changed.*latest state/);
  }
  assert.deepEqual(errors, []);
  console.log(`Charging controls browser checks passed: shared controls, explicit takeover fencing, pending/errors, readable long states and popups at 320/390/1440px in both themes. Screenshots: ${artifacts}`);
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
