// Run after npm run build. Uses only a disposable simulated app and browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-heating-explorer-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-heating-explorer-screenshots-'));
const now = Date.parse('2026-09-30T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, sequence = 0;

try {
  const configuration = join(directory, 'fixture-config.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chromium')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(directory, 'chromium', 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
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
    const id = ++sequence, timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression: expression.includes('await ') ? `(async () => { ${expression} })()` : expression,
      awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; errors: ${errors.join(', ')}`);
  };
  const keyPress = async key => {
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], ' ': ['Space', 32], Tab: ['Tab', 9], Escape: ['Escape', 27] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const screenshot = async (name, id = 'heating-explorer-dialog') => {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate(`(() => {
      const box = document.getElementById('${id}').getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  const hour = 3_600_000;
  const summary = (hours, drop, cost) => ({ phase: 'normal', action: 'normal', reasons: ['currently-selected-cycle'],
    schedule: { preheatStart: now + hour, preheatEnd: now + 2 * hour, reductionStart: now + 2 * hour, reductionEnd: now + (2 + hours) * hour },
    phases: [{ phase: 'preheat', start: now + hour, end: now + 2 * hour }, { phase: 'reduction', start: now + 2 * hour, end: now + (2 + hours) * hour },
      { phase: 'recovery', start: now + (2 + hours) * hour, end: now + (4 + hours) * hour, estimated: true }],
    outcomes: { costCents: cost, electricityKwh: 12.3, auxiliaryKwh: .2, recoveryCostCents: 35, recoveryEnergyKwh: 2.1,
      recoveryAuxKwh: .1, terminalKwh: .2, terminalCostCents: 3, recoveredAt: now + (4 + hours) * hour,
      completeRecoveryPredicted: true, maxRoomDropC: drop, maxRoomRiseC: .4, uncertaintyC: .25,
      coldestRoom: { id: 'bedroom', label: 'Bedroom', at: now + (2 + hours) * hour, valueC: 20 - drop },
      warmestRoom: { id: 'living', label: 'Living room', at: now + 2 * hour, valueC: 21.4 } },
    estimatedBenefitCents: 300 - cost, lowerBenefitCents: 280 - cost,
    trajectory: Array.from({ length: 21 }, (_, i) => ({ at: now + i * hour / 2, indoorC: 21 + .4 * Math.sin(i / 2) - drop * Math.sin(i / 7), uncertaintyC: .25 })) });
  const fixture = { version: 1, snapshotId: 'synthetic-browser-snapshot', snapshotAt: now, expiresAt: now + 5 * 60_000,
    current: summary(4, .7, 180), scenario: summary(6, 1.1, 125),
    controls: [{ key: 'maxReductionHours', label: 'Maximum reduction', value: 4, min: .25, max: 12, step: .25, unit: 'h' },
      { key: 'maxDropC', label: 'Allowed room temperature drop', value: 1.5, min: 0, max: 2, step: .25, unit: '°C' },
      { key: 'maxRiseC', label: 'Allowed room temperature rise', value: 1.5, min: .25, max: 2, step: .25, unit: '°C' },
      { key: 'maxPreheatHours', label: 'Maximum preheat', value: 2, min: .25, max: 6, step: .25, unit: 'h' },
      { key: 'preheatRoomBoostC', label: 'Preheat ROOM increase', value: 2, min: 1, max: 5, step: 1, unit: '°C' },
      { key: 'savingsStrategy', label: 'Savings strategy', value: 'balanced', options: [{ value: 'gentle', label: 'Gentle' }, { value: 'balanced', label: 'Balanced' }, { value: 'savings', label: 'More savings' }] }],
    comparison: { additionalBenefitCents: 55, additionalRoomDropC: .4, changed: true },
    constraints: [{ key: 'maxReductionHours', label: 'Configured reduction ceiling', value: 4, unit: 'h', status: 'blocking',
      detail: 'A tested relaxation produces an eligible alternative with greater estimated benefit. Compare its room temperatures and recovery.' },
      { key: 'maxDropC', label: 'Allowed room temperature drop', value: 1.5, unit: '°C', status: 'available', detail: 'Checked separately for each room, including forecast uncertainty.' },
      { key: 'validatedReductionHours', label: 'Demonstrated reduction duration', value: 6, unit: 'h', status: 'blocking', detail: 'Longer reductions need additional evidence. Simulations do not add evidence.' },
      { key: 'economicAdmission', label: 'Benefit, comfort and recovery', status: 'available', detail: 'Paired stress cases assess the complete cycle including recovery.' }],
    opportunities: [{ title: 'There may be room for a longer reduction', detail: 'A six-hour allowance admits a plan with more estimated benefit under these conditions.',
      overrides: { maxReductionHours: 6 }, additionalBenefitCents: 55, evidence: 'A comparison using existing evidence, not a recommendation to change defaults.' }],
    evidence: { actionValidated: true, validatedReductionHours: 6, reasons: [] },
    limitations: ['Space-heating cost includes recovery and remaining heat debt; electricity totals exclude that tail. Hot-water service and whole-house savings are not established.'],
    application: { allowed: true, latestStartAt: now + hour, expiresAt: now + 12 * hour },
  };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.explorerFixture = { value: ${JSON.stringify(fixture)}, requests: [], role: 'admin', generation: 0, stale: false };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      if (path.startsWith('/api/heating/explorer')) {
        explorerFixture.requests.push({path, body});
        if (explorerFixture.stale && path.endsWith('/simulate')) return new Response(JSON.stringify({error:'Synthetic stale snapshot'}), {status:409});
        if (path.endsWith('/apply')) {
          explorerFixture.value.activeTrial = { id:'synthetic-cycle',status:'pending',approvedAt:${now},latestStartAt:${now + hour},expiresAt:${now + 12 * hour},limits:{maxReductionHours:6}};
          return Response.json({activeTrial:explorerFixture.value.activeTrial});
        }
        if (path.endsWith('/cancel')) {
          explorerFixture.value.activeTrial.status = 'cancelled';
          return Response.json({activeTrial:explorerFixture.value.activeTrial});
        }
        const data = structuredClone(explorerFixture.value);
        if (path.endsWith('/simulate')) {
          data.previewId = 'synthetic-reviewed-preview';
          data.opportunities = [];
          data.constraints[0].value = body.limits.maxReductionHours;
          if (body.limits.maxReductionHours === 8) data.illustrative = {...data.scenario, executable:false,extrapolated:true,reasons:['outside-demonstrated-duration'],
            schedule:{...data.scenario.schedule,reductionEnd:data.scenario.schedule.reductionStart + 8 * 3600000}};
        } else { data.previewId = null; data.snapshotId += '-' + (++explorerFixture.generation); explorerFixture.stale = false; }
        return Response.json(data);
      }
      if (body) throw new Error('Unexpected mutation in heating explorer fixture: ' + path);
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      const value = await response.json();
      value.webAccess = {role:explorerFixture.role,source:'local'};
      value.heatingScenario = explorerFixture.value.activeTrial ?? null;
      value.automation.home.enabled = true;
      value.decision.plan = {schedule:explorerFixture.value.current.schedule};
      value.decision.phase = 'normal';
      if (explorerFixture.recorded) value.input = 'offline';
      return Response.json(value);
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) explorerFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until(`globalThis.explorerFixture?.poll && document.body.dataset.authenticated === 'true'`);
  await evaluate(`document.getElementById('home-planned-change').focus(); globalThis.initialHomeFold = document.getElementById('home-heat-pump-details').open`);
  await keyPress('Enter');
  await until(`document.getElementById('heating-explorer-dialog').open && !document.getElementById('heating-explorer-content').hidden`);
  assert.equal(await evaluate(`document.getElementById('home-heat-pump-details').open === initialHomeFold`), true, 'Opening explorer does not toggle Home disclosure');
  assert.equal(await evaluate(`document.getElementById('home-planned-change').getAttribute('aria-expanded')`), 'true');
  assert.match(await evaluate(`document.getElementById('heating-explorer-constraints').textContent`), /4 h/);
  assert.match(await evaluate(`document.getElementById('heating-explorer-opportunities').textContent`), /€0.55.*6 h/);
  await keyPress('Escape');
  await until(`!document.getElementById('heating-explorer-dialog').open`);
  assert.equal(await evaluate(`document.activeElement.id`), 'home-planned-change');
  await keyPress(' ');
  await until(`document.getElementById('heating-explorer-dialog').open && !document.getElementById('heating-explorer-content').hidden`);
  await until(`!document.getElementById('heating-explorer-refresh').disabled`);
  for (const [width, height, theme] of [[320,740,'light'],[390,844,'dark'],[1280,1000,'light'],[1920,1080,'dark']]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.getElementById('heating-explorer-dialog').scrollTop=0`);
    const layout = await evaluate(`(() => { const d=document.getElementById('heating-explorer-dialog');return {viewport:innerWidth,width:d.getBoundingClientRect().width,scroll:d.scrollWidth,client:d.clientWidth,page:document.documentElement.scrollWidth};})()`);
    assert(layout.width <= width && layout.scroll <= layout.client + 1 && layout.page <= width, `${width}px ${theme} has no horizontal overflow: ${JSON.stringify(layout)}`);
    await screenshot(`${width}-${theme}-plan`);
  }
  await evaluate(`document.getElementById('heating-explorer-jump').click();document.getElementById('heating-limit-maxReductionHours').value='8';document.getElementById('heating-limit-maxReductionHours').dispatchEvent(new Event('input',{bubbles:true}))`);
  const reads = await evaluate(`explorerFixture.requests.length`);
  await evaluate(`await explorerFixture.poll()`);
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`), '8', 'Polling preserves hypothetical controls');
  assert.equal(await evaluate(`explorerFixture.requests.length`), reads, 'Editing and polling do not calculate or actuate');
  await evaluate(`document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`!document.getElementById('heating-explorer-comparison-section').hidden && !document.getElementById('heating-explorer-apply').disabled`);
  assert.match(await evaluate(`document.getElementById('heating-explorer-metrics').textContent`), /€0.55/);
  assert.match(await evaluate(`document.getElementById('heating-explorer-illustrative').textContent`), /Illustrative 8 h reduction.*cannot be applied/);
  assert.equal(await evaluate(`document.querySelectorAll('#heating-explorer-chart path').length`), 2);
  for (const [width,height,theme] of [[320,740,'dark'],[390,844,'light'],[1280,1000,'dark']]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`);
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.getElementById('heating-explorer-comparison-section').scrollIntoView({block:'start'})`);
    const overflow = await evaluate(`(() => {const d=document.getElementById('heating-explorer-dialog');return d.scrollWidth>d.clientWidth+1;})()`);
    assert.equal(overflow,false,`${width}px comparison fits`);
    assert.equal(await evaluate(`(() => {const d=document.getElementById('heating-explorer-dialog').getBoundingClientRect(),c=document.getElementById('heating-explorer-close').getBoundingClientRect();return c.top>=d.top && c.bottom<=innerHeight;})()`),true,'Close remains reachable deep in the plan');
    await screenshot(`${width}-${theme}-comparison`);
    if (width === 320) {
      await evaluate(`document.getElementById('heating-explorer-chart').scrollIntoView({block:'center'})`);
      assert.equal(await evaluate(`Number(document.querySelector('#heating-explorer-chart svg').getAttribute('viewBox').split(' ')[2])<400`),true,'Mobile chart uses its actual width for readable labels');
      await screenshot(`${width}-${theme}-temperature`);
    }
  }
  await evaluate(`document.getElementById('heating-explorer-apply').click()`);
  await until(`document.querySelector('.confirmation-dialog')?.open`);
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Cancel', 'Confirmation defaults to Cancel');
  await evaluate(`document.querySelector('.confirmation-dialog .confirmation-actions button:last-child').click()`);
  await until(`document.getElementById('heating-explorer-receipt').textContent.includes('approved')`);
  assert.deepEqual(await evaluate(`explorerFixture.requests.filter(r=>r.path.endsWith('/apply')).map(r=>r.body)`), [{previewId:'synthetic-reviewed-preview'}]);
  await evaluate(`explorerFixture.value.activeTrial.status='running';document.getElementById('heating-limit-maxDropC').value='1.75';document.getElementById('heating-limit-maxDropC').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(`await explorerFixture.poll();return document.getElementById('heating-explorer-trial-description').textContent.startsWith('running')`);
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxDropC').value`),'1.75','Actual cycle polling preserves the hypothetical draft');
  await evaluate(`document.getElementById('heating-explorer-cancel').click()`);
  await until(`document.getElementById('heating-explorer-receipt').textContent.includes('cancelled')`);
  await evaluate(`explorerFixture.value.activeTrial.status='completed';explorerFixture.value.activeTrial.outcome={profitCents:42,recoveryErrorCents:-7,uncertaintyCents:15}`);
  await until(`await explorerFixture.poll();return document.getElementById('heating-explorer-trial-description').textContent.includes('€0.42')`);
  assert.match(await evaluate(`document.getElementById('heating-explorer-trial-description').textContent`),/does not establish validation/);
  await evaluate(`document.getElementById('heating-explorer-refresh').click()`);
  await until(`!document.getElementById('heating-explorer-refresh').disabled`);
  await evaluate(`explorerFixture.role='family'`);
  await until(`await explorerFixture.poll();return document.body.dataset.accessRole === 'family'`);
  await evaluate(`document.getElementById('heating-limit-maxReductionHours').value='6';document.getElementById('heating-limit-maxReductionHours').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`!document.getElementById('heating-explorer-comparison-section').hidden && !document.getElementById('heating-explorer-calculate').disabled`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-apply').hidden`), true, 'Family can simulate but cannot apply');
  assert.match(await evaluate(`document.getElementById('heating-explorer-application-help').textContent`), /Family can explore/);
  await evaluate(`explorerFixture.stale=true;document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`document.getElementById('heating-explorer-message').textContent.includes('Refresh conditions')`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-calculate').disabled`),true);
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'6','Stale comparison preserves draft');
  await evaluate(`explorerFixture.recorded=true`);
  await until(`await explorerFixture.poll();return !document.getElementById('heating-explorer-dialog').open`);
  const beforeRecorded = await evaluate(`explorerFixture.requests.length`);
  await evaluate(`document.getElementById('home-planned-change').click();await explorerFixture.poll()`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-dialog').open`),true,'A recorded plan stays readable across polling');
  assert.match(await evaluate(`document.getElementById('heating-explorer-message').textContent`),/Recorded history only/);
  assert.equal(await evaluate(`explorerFixture.requests.length`),beforeRecorded,'Recorded view does not request live simulation');
  assert.deepEqual(errors, [], 'Production dashboard has no browser exceptions');
  console.log(`Heating explorer browser checks passed. Synthetic screenshots: ${artifacts}`);
} finally {
  for (const task of pending.values()) clearTimeout(task.timer);
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  await app?.close();
  rmSync(directory, { recursive: true, force: true });
}
