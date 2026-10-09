// Synthetic shared charger cards and guarded dialog. No app runtime or live feeds.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'stmq-flexibility-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-flexibility-screenshots-'));
const html = `<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/charging-diagnostics.css"><body data-authenticated="true"><div class="zone-content" style="margin:12px;max-width:920px;container:charging-area / inline-size"><div id="charging-devices" class="charging-device-list"></div></div></body></html>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, `.${path}`);
    if (path !== '/' && !file.startsWith(`${root}/`)) throw Error('Outside fixture');
    response.setHeader('Content-Type', `${path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html'}; charset=utf-8`);
    response.end(path === '/' ? html : await readFile(file));
  } catch { response.statusCode = 404; response.end(); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let browser, socket, sequence = 0;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let n = 0; n < 200 && !port; n++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable browser starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const result = JSON.parse(event.data);
    if (result.id) {
      const task = pending.get(result.id); if (!task) return;
      pending.delete(result.id); clearTimeout(task.timer);
      result.error ? task.reject(Error(result.error.message)) : task.resolve(result.result);
    } else if (result.method === 'Runtime.exceptionThrown') errors.push(result.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(`CDP timeout: ${method}`)), 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (fn, arg) => {
    const expression = typeof fn === 'string' ? fn : `(${fn})(${JSON.stringify(arg) ?? ''})`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let n = 0; n < 200; n++) { if (await evaluate(expression)) return; await pause(20); }
    throw Error(`UI did not settle: ${expression}`);
  };
  const key = async key => {
    const code = { Enter: 13, Escape: 27, Tab: 9 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
  };
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  await until("Boolean(document.getElementById('charging-devices'))");
  await evaluate(async () => {

 const {createChargingPanel}=await import('/chart/charging.js');
 const now=Date.parse('2026-10-08T14:00:00Z'),baseline=Date.parse('2026-10-09T03:00:00Z');
 const reading=value=>({value,available:true,source:'manual-fallback'});
 const comp={at:now,available:true,recommended:true,priceCoverage:'partial',normalReadyByAt:baseline,deferredReadyByAt:baseline+86400000,normalCostCents:470,deferredCostCents:310,savingsCents:160,normalFinishAt:baseline-3600000,deferredFinishAt:baseline+86400000-7200000,normalChargingDurationMs:10800000,deferredChargingDurationMs:9000000,normalPeriods:[{startAt:now+3600000,endAt:null}],deferredPeriods:[{startAt:baseline+20*3600000,endAt:null}],householdSavingsCents:145,uncertaintyPremiumCents:60,householdUncertaintyPremiumCents:60,riskAdjustedSavingsCents:85,usesForecast:true};
 const charger=id=>({id,label:id==='charger1'?'Charger 1':'Charger 2',provider:id==='charger1'?'easee':'shelly-evse',association:'synthetic:'+id,request:{sessionId:'synthetic-'+id,revision:1,overrides:{}},settings:{enabled:true,readyBy:'06:00',manualSoc:20,minimumSoc:80,capacityKwh:74},controls:{revision:1},capabilities:{scheduling:true},values:{connected:reading(true),charging:reading(false),soc:reading(34),minimumSoc:reading(80),capacityKwh:reading(74)},requiredGridKwh:32,sessionCost:{totalCents:470,recordedGridKwh:12.3},plan:{state:'waiting',startAt:now+3600000,finishAt:baseline-3600000,deadlineAt:baseline,feasible:true,periods:[{startAt:now+3600000,endAt:null}]},control:{phase:'waiting',confirmed:true},flexibility:{comparisonScope:'comparison-'+id,enabled:true,active:false,eligible:true,revision:1,normalReadyByAt:baseline,effectiveReadyByAt:baseline,deferredReadyByAt:baseline+86400000,preview:comp}});
 window.fixture={role:'master',now,charging:{timezone:'Europe/Helsinki',settings:{priority:'balanced'},controls:{revision:1},chargers:[charger('charger1'),charger('charger2')]}};
 window.calls=[];window.panel=createChargingPanel({document,request:async(path,payload)=>{window.calls.push({path,payload});if(path.endsWith('preview'))return{comparison:comp,flexibility:window.fixture.charging.chargers[0].flexibility};return window.fixture;}});window.panel.update(window.fixture);
 for(const el of document.querySelectorAll('.charging-footer')){const button=document.createElement('button');button.className='charging-session-report';button.innerHTML='<span class="charging-session-report-copy"><span class="charging-session-report-label">Session report</span><span class="charging-session-report-status">In progress</span></span><span class="charging-session-report-open">Open ↗</span>';el.append(button);}
  });
  const measurements = [];
  for (const width of [280, 320, 390, 768, 1280]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const before = await evaluate("document.getElementById('charger1-device-summary').getBoundingClientRect().height");
    await evaluate(() => { window.fixture.charging.chargers.forEach(c => c.flexibility.enabled = false); window.panel.update(window.fixture); });
    const absent = await evaluate("document.getElementById('charger1-device-summary').getBoundingClientRect().height");
    await evaluate(() => { window.fixture.charging.chargers.forEach(c => c.flexibility.enabled = true); window.panel.update(window.fixture); });
    assert.equal(before, absent, `No resting card height increase at ${width}/${theme}: ${JSON.stringify(await evaluate(() => [...document.querySelectorAll('#charger1-flexibility, #charger1-flexibility > *')].map(el => ({ text: el.textContent, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))))}`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await evaluate("document.getElementById('charger1-flexibility').getBoundingClientRect().height >= 44"), true);
    assert.equal(await evaluate("document.getElementById('charger1-flexibility').textContent"), 'One extra day€1.60 est. saving');
    const comparisonStates = await evaluate(() => {
      const charger = window.fixture.charging.chargers[0], original = charger.flexibility.preview;
      const results = [];
      for (const [savingsCents, expected] of [[4, '€0.04 est. saving'], [0, '€0.00 est. saving'], [-35, '+€0.35 est. cost'], [null, 'Compare savings']]) {
        charger.flexibility.preview = { ...original, savingsCents, recommended: false };
        window.panel.update(window.fixture);
        const button = document.getElementById('charger1-flexibility'), label = button.querySelector('.charging-flexibility-entry-value');
        const buttonRect = button.getBoundingClientRect(), valueRect = label.getBoundingClientRect();
        results.push({ expected, label: label.textContent, tone: button.dataset.tone, height: buttonRect.height,
          overflow: valueRect.right > buttonRect.right || valueRect.bottom > buttonRect.bottom, valueHeight: valueRect.height });
      }
      charger.flexibility.preview = original; window.panel.update(window.fixture);
      return results;
    });
    for (const state of comparisonStates) {
      assert.equal(state.label, state.expected); assert.equal(state.tone, 'neutral');
      assert.equal(state.height, 44, `Compact comparison state at ${width}/${theme}: ${state.label}`);
      assert.equal(state.valueHeight, 15, `The estimate stays on one line at ${width}/${theme}: ${state.label}`);
      assert.equal(state.overflow, false);
    }
    const arrow = await evaluate(() => {
      const button = document.querySelector('.charging-flexibility-entry'), style = getComputedStyle(button, '::after');
      return { content: style.content, top: parseFloat(style.top), height: button.clientHeight,
        transform: new DOMMatrix(style.transform).m42, arrowHeight: parseFloat(style.height) };
    });
    assert.equal(arrow.content, '"↗"');
    assert(Math.abs(arrow.top + arrow.transform + arrow.arrowHeight / 2 - arrow.height / 2) < 1,
      `The arrow is vertically centered in the entire button at ${width}/${theme}`);
    assert.equal(await evaluate(() => {
      const field = document.getElementById('charger1-setting-capacityKwh'); field.value = '74.27';
      return field.step === '0.01' && field.checkValidity();
    }), true, `Two decimal capacity is accepted at ${width}/${theme}`);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.charging-priority-entry-value'), '::after').content"), '"↗"');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.charging-session-report')).borderTopColor === getComputedStyle(document.querySelector('.charging-flexibility-entry')).borderTopColor"), false,
      'The ordinary report border remains distinct from the highlighted savings border');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.charging-session-report')).borderTopColor !== 'rgba(0, 0, 0, 0)'"), true);
    await screenshot(`${width}-${theme}-cards`);
    await evaluate("document.getElementById('charger1-flexibility').focus()"); await key('Enter');
    await until("document.getElementById('charging-flexibility-apply').disabled === false");
    assert.equal(await evaluate("document.getElementById('charger1-device').open"), false);
    assert.equal(await evaluate('document.activeElement.id'), 'charging-flexibility-close');
    assert.match(await evaluate("document.getElementById('charging-flexibility-as-of').textContent"), /Prices cover only part.*later prices may change the saving/);
    assert.match(await evaluate("document.querySelectorAll('.charging-flexibility-plan')[1].textContent"), /Est\. finish 10 Oct 04:00.*Est\. charging 2 h 30 min/);
    await evaluate(() => { document.querySelectorAll('.charging-flexibility-periods').forEach(details => { details.open = true; }); });
    assert.match(await evaluate("document.querySelector('.charging-flexibility-periods').textContent"), /Proposed periods \(1\).*18:00 → onward/);
    const periodContents = await evaluate(() => [...document.querySelectorAll('.charging-flexibility-periods')].map(details => {
      const outer = details.getBoundingClientRect();
      return [...details.querySelectorAll('li')].every(row => row.getBoundingClientRect().right <= outer.right + 1);
    }));
    assert(periodContents.every(Boolean), `Proposed periods fit each alternative at ${width}/${theme}`);
    const dialog = await evaluate("(() => {const r=document.getElementById('charging-flexibility-dialog').getBoundingClientRect();return {width:r.width,height:r.height};})()");
    assert(dialog.width <= width && dialog.height <= 800);
    await screenshot(`${width}-${theme}-dialog`); await key('Escape');
    assert.equal(await evaluate('document.activeElement.id'), 'charger1-flexibility');
    measurements.push({ width, theme, height: before, dialogHeight: dialog.height });
  }
  // A completed comparison updates the open dialog only when displayed values change.
  await evaluate("document.getElementById('charger1-flexibility').click()");
  await until("document.getElementById('charging-flexibility-apply').disabled === false");
  await evaluate(() => {
    const old = window.fixture.charging.chargers[0];
    window.fixture = { ...window.fixture, charging: { ...window.fixture.charging,
      chargers: [{ ...old, flexibility: { ...old.flexibility, preview: { ...old.flexibility.preview, savingsCents: 220 } } }, window.fixture.charging.chargers[1]] } };
    window.panel.update(window.fixture);
  });
  assert.equal(await evaluate("document.getElementById('charging-flexibility-apply').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charging-flexibility-saving').textContent"), 'Estimated saving €2.20');
  assert.match(await evaluate("document.getElementById('charger1-flexibility').textContent"), /€2.20/);
  assert.equal(await evaluate("document.getElementById('charging-flexibility-refresh').hidden"), false);
  const requestsBefore = await evaluate('window.calls.length');
  await evaluate(() => {
    window.fixture = { ...window.fixture, now: window.fixture.now + 6 * 60_000 };
    window.panel.update(window.fixture); document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await evaluate('window.calls.length'), requestsBefore, 'Elapsed age and status changes never auto-refresh the dialog');
  assert.equal(await evaluate("document.getElementById('charging-flexibility-saving').textContent"), 'Estimated saving €2.20');
  await evaluate(() => {
    window.fixture.charging.chargers[0].request.revision++;
    window.panel.update({ ...window.fixture });
  });
  assert.equal(await evaluate("document.getElementById('charging-flexibility-apply').disabled"), true);
  assert.equal(await evaluate("document.getElementById('charging-flexibility-saving').textContent"), 'Estimated saving €2.20');
  await key('Escape');
  // A retained estimate keeps its original time and remains visible past five minutes.
  await evaluate(() => {
    const c = window.fixture.charging.chargers[0], comparison = window.fixture.charging.chargers[1].flexibility.preview;
    c.flexibility.preview = { ...comparison, at: window.fixture.now - 5 * 60_000 + 150 };
    window.panel.update({ ...window.fixture });
  });
  await pause(200);
  assert.equal(await evaluate("document.getElementById('charger1-flexibility').dataset.tone"), 'saving');
  // Active permission is a dated obligation; a background tab cannot retain its highlight.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: false });
  await evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    const c = window.fixture.charging.chargers[0];
    c.flexibility = { ...c.flexibility, active: true, eligible: false, checkpointAt: window.fixture.now + 60_000,
      effectiveReadyByAt: c.flexibility.deferredReadyByAt };
    window.panel.update({ ...window.fixture });
  });
  assert.equal(await evaluate("document.getElementById('charger1-defer-badge').hidden"), false);
  assert.equal(await evaluate("document.querySelector('#charger1-flexibility .charging-flexibility-entry-title').textContent"), 'One day allowed');
  assert.equal(await evaluate("document.querySelector('#charger1-flexibility .charging-flexibility-entry-value').textContent"), '€1.60 est. saving');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#charger1-flexibility .charging-flexibility-entry-title')).color === getComputedStyle(document.getElementById('charger1-deadline')).color"), true);
  await screenshot('active-light-cards');
  await evaluate("document.getElementById('charger1-flexibility').click()");
  await until("document.getElementById('charging-flexibility-apply').textContent === 'Cancel flexibility'");
  await screenshot('active-light-dialog'); await key('Escape');
  await evaluate(() => {
    const c = window.fixture.charging.chargers[0]; window.fixture.now = c.flexibility.checkpointAt;
    window.panel.update({ ...window.fixture }); document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await evaluate("document.getElementById('charger1-defer-badge').hidden"), true);
  assert.equal(await evaluate("document.getElementById('charger1-deadline').textContent"), '10 Oct 06:00');
  await screenshot('checkpoint-light-cards');
  assert.equal(await evaluate("window.calls.every(call=>call.path.endsWith('flexibility-preview'))"), true,
    'Opening, closing, changing time and reviewing never submit a deadline mutation');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ measurements, artifacts }, null, 2));
} finally {
  for (const task of pending.values()) clearTimeout(task.timer);
  socket?.close(); browser?.kill('SIGTERM'); server.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
