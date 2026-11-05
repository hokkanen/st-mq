import WebSocket from 'ws';
import { uiSpacingFailures } from '../../scripts/lib/ui-spacing-checks.js';
// Uses only a disposable simulated app, UI build and browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { exploreHeatingPlan } from '../../src/control/heating-explorer.js';
import { heatingExplorerFixture } from '../helpers/heating-explorer-fixture.js';
import { build, preview } from 'vite';

const directory = mkdtempSync(join(tmpdir(), 'stmq-heating-explorer-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-heating-explorer-screenshots-'));
console.log(`Synthetic planner browser artifacts: ${artifacts}`);
const now = Date.parse('2026-09-30T12:00:00Z');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [];
let app, browser, socket, ui, sequence = 0;

try {
  const configuration = join(directory, 'fixture-config.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now, installSignalHandlers: false });
  const uiDirectory = process.env.STMQ_UI_DIST ?? join(directory, 'dist');
  if (!process.env.STMQ_UI_DIST) await build({ build: { outDir: uiDirectory }, logLevel: 'warn' });
  ui = await preview({ configFile: false, build: { outDir: uiDirectory }, preview: {
    host: '127.0.0.1', port: 0, proxy: { '/api': `http://127.0.0.1:${app.server.address().port}` },
  } });
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
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], ' ': ['Space', 32], Tab: ['Tab', 9], Escape: ['Escape', 27], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], Home: ['Home', 36], End: ['End', 35] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const screenshot = async (name, id = 'heating-explorer-dialog') => {
    assert.equal(await evaluate(`JSON.stringify((${uiSpacingFailures.toString()})())`), '[]', 'Card padding and nested indentation remain independent');
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
      completeRecoveryPredicted: true, maxIndoorDropC: drop, maxIndoorRiseC: .4, uncertaintyC: .25,
      coldestIndoor: { label: 'Weighted indoor average', at: now + (2 + hours) * hour, valueC: 20 - drop },
      warmestIndoor: { label: 'Weighted indoor average', at: now + 2 * hour, valueC: 21.4 } },
    estimatedBenefitCents: 300 - cost, lowerBenefitCents: 280 - cost,
    trajectory: Array.from({ length: 21 }, (_, i) => ({ at: now + i * hour / 2, indoorC: 21 + .4 * Math.sin(i / 2) - drop * Math.sin(i / 7), uncertaintyC: .25 })) });
  const fixture = { version: 1, snapshotId: 'synthetic-browser-snapshot', snapshotAt: now, expiresAt: now + 5 * 60_000,
    indoorInput: { valueC: 21, estimated: true, available: true, observedAt: now, uncertaintyC: .2 },
    current: summary(4, .7, 180), scenario: summary(6, 1.1, 125),
    controls: [{ key: 'maxReductionHours', label: 'Maximum reduction', value: 4, min: .25, max: 12, step: .25, unit: 'h' },
      { key: 'maxDropC', label: 'Allowed average temperature drop', value: 1.5, min: 0, max: 2, step: .25, unit: '°C' },
      { key: 'maxRiseC', label: 'Allowed average temperature rise', value: 1.5, min: .25, max: 2, step: .25, unit: '°C' },
      { key: 'maxPreheatHours', label: 'Maximum preheat', value: 2, min: .25, max: 6, step: .25, unit: 'h' },
      { key: 'preheatRoomBoostC', label: 'Preheat ROOM increase', value: 2, min: 1, max: 5, step: 1, unit: '°C' },
      { key: 'savingsStrategy', label: 'Savings strategy', value: 'balanced', options: [{ value: 'gentle', label: 'Gentle' }, { value: 'balanced', label: 'Balanced' }, { value: 'savings', label: 'More savings' }] }],
    comparison: { additionalBenefitCents: 55, additionalIndoorDropC: .4, changed: true },
    constraints: [{ key: 'maxReductionHours', label: 'Configured reduction ceiling', value: 4, unit: 'h', status: 'blocking',
      detail: 'A tested relaxation produces an eligible alternative with greater estimated benefit. Compare its average temperature and recovery.' },
      { key: 'maxDropC', label: 'Allowed average temperature drop', value: 1.5, unit: '°C', status: 'available', detail: 'Checked on the configured indoor average, including forecast uncertainty.' },
      { key: 'validatedReductionHours', label: 'Demonstrated reduction duration', value: 6, unit: 'h', status: 'blocking', detail: 'Longer reductions need additional evidence. Simulations do not add evidence.' },
      { key: 'economicAdmission', label: 'Benefit, comfort and recovery', status: 'available', detail: 'Paired stress cases assess the complete cycle including recovery.' }],
    opportunities: [{ title: 'There may be room for a longer reduction', detail: 'A six-hour allowance admits a plan with more estimated benefit under these conditions.',
      overrides: { maxReductionHours: 6 }, additionalBenefitCents: 55, evidence: 'A comparison using existing evidence, not a recommendation to change defaults.' }],
    evidence: { actionValidated: true, validatedReductionHours: 6, reasons: [] },
    limitations: ['Space-heating cost includes recovery and remaining heat debt; electricity totals exclude that tail. Hot-water service and whole-house savings are not established.'],
    application: { allowed: true, latestStartAt: now + hour, expiresAt: now + 12 * hour },
  };
  const capturedExplorer=exploreHeatingPlan(heatingExplorerFixture());
  const allControls=capturedExplorer.controls;
  fixture.learningContext=capturedExplorer.learningContext;fixture.limits=capturedExplorer.limits;
  fixture.constraints.push({key:'normalReference',label:'Normal temperature reference',kind:'evidence',
    status:'learning',value:21.25,unit:'°C',detail:'The normal reference is still learning; the allowed drop is shown separately.'});
  fixture.controls=allControls.map(control=>({...control,
    value:fixture.controls.find(existing=>existing.key===control.key)?.value??control.value}));
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.explorerFixture = { value: ${JSON.stringify(fixture)}, requests: [], role: 'admin', generation: 0, stale: false };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const body = options.body ? JSON.parse(options.body) : undefined;
      if (path.startsWith('/api/heating/explorer')) {
        explorerFixture.requests.push({path, body});
        if(explorerFixture.refreshFailure&&path==='/api/heating/explorer')return new Response(JSON.stringify({error:'Synthetic private backend detail'}),{status:503});
        if(explorerFixture.holdComparison&&path.endsWith('/simulate'))await new Promise(resolve=>{explorerFixture.releaseComparison=resolve;});
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
          data.limits={...data.limits,...body.limits};
          data.learningContext.allowanceBasis=Object.hasOwn(body.limits,'maxTrialCostCents')?'reviewed-one-cycle':'captured-automatic';
          data.opportunities = [];
          data.constraints[0].value = body.limits.maxReductionHours;
          if (body.limits.maxReductionHours === 8) data.illustrative = {...data.scenario, executable:false,extrapolated:true,reasons:['outside-demonstrated-duration'],
            schedule:{...data.scenario.schedule,reductionEnd:data.scenario.schedule.reductionStart + 8 * 3600000}};
        } else { data.previewId = null; data.snapshotId += '-' + (++explorerFixture.generation); explorerFixture.stale = false; }
        return Response.json(data);
      }
      if (path === '/api/pair' && explorerFixture.pair) return Response.json(explorerFixture.pair);
      if (body) throw new Error('Unexpected mutation in heating explorer fixture: ' + path);
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      const value = await response.json();
      value.webAccess = {role:explorerFixture.role,source:'local'};
      value.heatingScenario = explorerFixture.value.activeTrial ?? null;
      value.automation.home.enabled = true;
      value.override = null;
      delete value.decision.manualHold;
      value.decision.plan = {schedule:explorerFixture.value.current.schedule};
      value.decision.phase = 'normal';
      if (explorerFixture.planner) {
        const planner = explorerFixture.planner;
        value.input = planner.input ?? 'providers';
        value.role = planner.role ?? 'master';
        value.automation.home.enabled = planner.enabled ?? true;
        value.override = planner.override ?? null;
        Object.assign(value.decision, planner.decision ?? {});
        if (planner.role === 'slave') value.lastDecision = {payload: {phase: 'normal'}};
      }
      if (explorerFixture.recorded) value.input = 'offline';
      if (explorerFixture.pair) {
        value.topology = 'pair'; value.pair = structuredClone(explorerFixture.pair);
        value.role = explorerFixture.pair.role; value.readOnly = !explorerFixture.pair.canControl;
      }
      return Response.json(value);
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) explorerFixture.poll = callback;
      if (delay === 3000) explorerFixture.pairPoll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${ui.httpServer.address().port}/` });
  await until(`globalThis.explorerFixture?.poll && document.body.dataset.authenticated === 'true'`);
  const planCases = [
    { name: 'paused', patch: { enabled: false, decision: { plan: null } }, label: 'Planned actions', value: 'No actions scheduled' },
    { name: 'resume', patch: { enabled: false, override: { expiresAt: now + 24 * hour }, decision: { plan: null } },
      label: 'Planned actions', value: 'Resume automatic at 1 Oct, 15:00' },
    { name: 'manual-preheat', patch: { enabled: false, override: { expiresAt: now + 2 * hour },
      decision: { plan: null, manualHold: { phase: 'preheat', until: now + hour } } },
      label: 'Planned actions', value: 'End preheat at 16:00' },
    { name: 'scheduled', patch: {}, label: 'Planned actions', value: 'Preheat at 16:00' },
    { name: 'reduction', patch: { decision: { phase: 'reduction', expiresAt: now + hour } },
      label: 'Planned actions', value: 'Recovery at 16:00' },
    { name: 'simulation', patch: { input: 'simulated' }, label: 'Simulated actions', value: 'Preheat at 16:00' },
    { name: 'history', patch: { input: 'offline' }, label: 'Recorded plan', value: 'Recorded history only' },
    { name: 'replica', patch: { role: 'slave' }, label: 'Recorded plan', value: 'Normal heating' },
  ];
  for (const [width, height] of [[320, 740], [390, 844], [1280, 1000]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      for (const scenario of planCases) {
        await evaluate(`explorerFixture.planner = ${JSON.stringify(scenario.patch)}; await explorerFixture.poll()`);
        await until(`document.getElementById('home-plan-label').textContent === ${JSON.stringify(scenario.label)}
          && document.getElementById('home-plan-value').textContent === ${JSON.stringify(scenario.value)}`);
        await evaluate(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`);
        const plan = await evaluate(`(() => {
          const row = document.getElementById('home-planned-change'), bounds = row.getBoundingClientRect();
          const copy = [...row.querySelectorAll('.home-plan-copy > span')].map(node => {
            const rect = node.getBoundingClientRect();
            return { text: node.textContent, visible: node.checkVisibility(), clipped: node.scrollWidth > node.clientWidth + 1,
              left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          });
          return { aria: row.getAttribute('aria-label'), title: row.title, pageWidth: document.documentElement.scrollWidth,
            left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, copy };
        })()`);
        const name = `${width}px ${theme} ${scenario.name}`;
        await screenshot(`${width}-${theme}-home-${scenario.name}`, 'home-control');
        assert(plan.aria.includes(scenario.label) && plan.aria.includes(scenario.value)
          && plan.aria.includes('Explore'), `${name}: the accessible name describes the planned action and explorer`);
        assert(plan.title.includes(scenario.value), `${name}: the tooltip agrees with the visible action`);
        assert(plan.pageWidth <= width && plan.left >= 0 && plan.right <= width,
          `${name}: the planner row fits the viewport: ${JSON.stringify(plan)}`);
        assert(plan.copy.every(copy => copy.visible && !copy.clipped && copy.left >= plan.left
          && copy.right <= plan.right && copy.top >= plan.top && copy.bottom <= plan.bottom),
        `${name}: planner text is visible without clipping: ${JSON.stringify(plan)}`);
      }
    }
  }
  await evaluate(`delete explorerFixture.planner; await explorerFixture.poll()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.getElementById('home-planned-change').focus(); globalThis.initialHomeFold = document.getElementById('home-heat-pump-details').open`);
  await keyPress('Enter');
  await until(`document.getElementById('heating-explorer-dialog').open && !document.getElementById('heating-explorer-content').hidden`);
  assert.equal(await evaluate(`document.getElementById('home-heat-pump-details').open === initialHomeFold`), true, 'Opening explorer does not toggle Home disclosure');
  assert.equal(await evaluate(`document.getElementById('home-planned-change').getAttribute('aria-expanded')`), 'true');
  assert.match(await evaluate(`document.getElementById('heating-explorer-constraints').textContent`), /4 h/);
  assert.match(await evaluate(`document.querySelector('#heating-explorer-constraints [data-status="learning"]').textContent`),
    /Normal temperature reference · 21.25 °C.*Learning/);
  assert.match(await evaluate(`document.getElementById('heating-explorer-opportunities').textContent`), /€0.55.*6 h/);
  assert.match(await evaluate(`document.getElementById('heating-explorer-context').textContent`), /estimate for one unavailable room.*±0.2 °C.*no learning evidence/);
  assert.match(await evaluate(`document.querySelector('#heating-explorer-timeline [data-phase="recovery"]').textContent`), /stored heat.*does not mean continuous extra heating.*estimate/);
  await keyPress('Escape');
  await until(`!document.getElementById('heating-explorer-dialog').open`);
  assert.equal(await evaluate(`document.activeElement.id`), 'home-planned-change');
  await keyPress(' ');
  await until(`document.getElementById('heating-explorer-dialog').open && !document.getElementById('heating-explorer-content').hidden`);
  await until(`!document.getElementById('heating-explorer-refresh').disabled`);
  const reopenReads=await evaluate(`explorerFixture.requests.length`);
  await evaluate(`document.getElementById('heating-limit-maxReductionHours').value='6';document.getElementById('heating-limit-maxReductionHours').dispatchEvent(new Event('input',{bubbles:true}))`);
  await evaluate(`document.getElementById('heating-explorer-dialog').close();document.getElementById('home-planned-change').click();document.getElementById('heating-explorer-close').focus()`);
  await evaluate(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`);
  assert.equal(await evaluate(`document.getElementById('home-planned-change').getAttribute('aria-expanded')`), 'true', 'An older close cannot collapse a reopened heating plan');
  assert.equal(await evaluate('document.activeElement.id'), 'heating-explorer-close');
  assert.equal(await evaluate(`explorerFixture.requests.length`),reopenReads,'Reopening preserves the captured baseline without an implicit refresh');
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'6','Reopening preserves the draft');
  await until(`!document.getElementById('heating-explorer-refresh').disabled`);
  for (const [width, height] of [[280,740],[320,740],[390,420],[390,844],[650,900],[651,900],[768,1024],[844,390],[1024,768],[1280,1000],[1920,1080]]) {
    await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme='${theme}';document.getElementById('heating-explorer-dialog').scrollTop=0`);
      await evaluate(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`);
      await evaluate(`document.getElementById('heating-explorer-advanced').open=false`);
      assert.equal(await evaluate(`document.querySelector('#heating-explorer-advanced-controls input')?.checkVisibility()`),false,'Advanced settings start folded');
      await evaluate(`document.getElementById('heating-explorer-controls').scrollIntoView({block:'center'})`);
      await screenshot(`${width}-${theme}-common-settings`);
      await evaluate(`document.getElementById('heating-explorer-advanced').open=true`);
      const layout = await evaluate(`(() => {
        const d=document.getElementById('heating-explorer-dialog');
        const grids=['heating-explorer-controls','heating-explorer-advanced-controls','heating-explorer-learning-controls'].map(id=>{
          const grid=document.getElementById(id),bounds=grid.getBoundingClientRect();
          return {id,left:bounds.left,right:bounds.right,controls:[...grid.querySelectorAll('.heating-explorer-control')].map(control=>{
            const input=control.querySelector('input,select'),r=control.getBoundingClientRect();
            const shown=control.querySelector('.app-select-trigger')??input;
            const field=(input.type==='number'?control.querySelector('.heating-explorer-control-input'):shown).getBoundingClientRect();
            return {key:input.id.replace('heating-limit-',''),visible:shown.checkVisibility(),left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,overflow:control.scrollWidth>control.clientWidth+1,
              field:{left:field.left,right:field.right,top:field.top,bottom:field.bottom,width:field.width,height:field.height},
              help:Boolean(control.querySelector('.status-detail-trigger'))};
          })};
        });
        return{width:d.getBoundingClientRect().width,scroll:d.scrollWidth,client:d.clientWidth,page:document.documentElement.scrollWidth,grids};
      })()`);
      writeFileSync(join(artifacts,`${width}-${theme}-geometry.json`),JSON.stringify(layout,null,2));
      const label=`${width}px ${theme}`,all=layout.grids.flatMap(grid=>grid.controls);
      assert(layout.width<=width&&layout.scroll<=layout.client+1&&layout.page<=width,`${label}: no horizontal overflow`);
      assert.equal(all.length+1,allControls.length,`${label}: all numeric/select controls plus the master checkbox remain available`);
      assert(await evaluate(`document.getElementById('heating-explorer-learning-heading').contains(document.getElementById('heating-limit-learningTrials'))`),`${label}: master checkbox is integrated into the box legend`);
      assert.deepEqual(all.map(row=>row.key).sort(),allControls.filter(control=>control.type!=='checkbox').map(row=>row.key).sort());
      assert.equal(layout.grids[0].controls.length,allControls.filter(control=>!control.advanced).length);
      for(const grid of layout.grids){
        assert(grid.controls.every(row=>row.visible&&row.help&&!row.overflow&&row.width>0&&row.left>=grid.left-1&&row.right<=grid.right+1),`${label}: controls and help fit ${grid.id}`);
        const columns=grid.id==='heating-explorer-controls'?(width<=650?2:3):(width<=650?1:2);
        const rows=[...grid.controls].sort((a,b)=>Math.abs(a.top-b.top)<1?a.left-b.left:a.top-b.top);
        if(grid.id==='heating-explorer-controls') assert.deepEqual(rows.map(row=>row.key),width<=650
          ?['savingsStrategy','preheatRoomBoostC','maxDropC','maxRiseC','maxReductionHours','maxPreheatHours']
          :['savingsStrategy','maxDropC','maxReductionHours','preheatRoomBoostC','maxRiseC','maxPreheatHours'],`${label}: exact main control order`);
        else if(grid.id==='heating-explorer-advanced-controls')assert.equal(rows.at(-1).key,'maxUnobservedReductionHours',`${label}: telemetry ends the upper advanced region`);
        else assert.deepEqual(rows.map(row=>row.key),['maxTrialCostCents','learningPriorityPriceCents'],`${label}: learning box contains exactly the two learning inputs`);
        for(let i=0;i<rows.length;i++){
          const row=rows[i],same=rows[Math.floor(i/columns)*columns];
          assert(Math.abs(row.top-same.top)<1&&Math.abs(row.field.top-same.field.top)<1,`${label}: aligned labels and input boxes in ${grid.id}`);
          assert(Math.abs(row.field.width-rows[0].field.width)<1,`${label}: equal visible numeric and selector box widths: ${JSON.stringify({row,first:rows[0]})}`);
          assert(Math.abs(row.field.left-row.left)<1&&Math.abs(row.field.right-row.right)<1,`${label}: boxes fill their column`);
          if(i%columns)assert(rows[i-1].right<row.left,`${label}: no column overlap`);
          if(i>=columns){const above=rows[i-columns];assert(above.bottom<row.top&&Math.abs(above.left-row.left)<1,`${label}: no row overlap`);}
        }
      }
      await screenshot(`${width}-${theme}-plan`);
      await evaluate(`document.getElementById('heating-explorer-controls').scrollIntoView({block:'center'})`);
      await screenshot(`${width}-${theme}-controls`);
      if ([280, 390, 1280].includes(width)) {
        await evaluate(`document.getElementById('heating-explorer-learning').scrollIntoView({block:'center'})`);
        assert(await evaluate(`(() => {const box=document.getElementById('heating-explorer-learning'),r=box.getBoundingClientRect(),legend=box.querySelector('legend').getBoundingClientRect();return box.scrollWidth<=box.clientWidth+1&&legend.left>=r.left&&legend.right<=r.right+1;})()`),`${label}: the checkbox and legend fit their learning box`);
        await screenshot(`${width}-${height}-${theme}-learning-box`);
      }
      for(const folded of [true,false]) {
        for(const position of ['start','end']) {
          await evaluate(`document.getElementById('heating-explorer-advanced').open=${!folded};
            document.getElementById('heating-explorer-dialog').scrollTop=${position==='start'?'0':'99999'};
            document.getElementById('heating-explorer-jump').click()`);
          await evaluate(`await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)`);
          const jump=await evaluate(`(() => {const heading=document.getElementById('heating-simulator-title').getBoundingClientRect(),header=document.querySelector('.heating-explorer-header').getBoundingClientRect();
            return {top:heading.top,headerBottom:header.bottom,open:document.getElementById('heating-explorer-advanced').open,
              focused:document.activeElement===document.querySelector('#heating-explorer-controls .app-select-trigger')};})()`);
          assert.equal(jump.open,!folded,`${label}: jump preserves fold state`);
          assert(jump.focused,`${label}: jump focuses the visible strategy selector`);
          assert(Math.abs(jump.top-jump.headerBottom-24)<2,`${label}: jump aligns the section heading below the sticky header: ${JSON.stringify(jump)}`);
        }
      }
    }
  }
  for(const [width,height] of [[320,740],[1280,1000]]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.getElementById('heating-explorer-jump').click()`);
    const economics=await evaluate(`Object.fromEntries(['minimumHomeBenefitCents','homeDiscomfortCentsPerDegreeSquaredHour','cycleStartCostCents','cycleHourCostCents','economicUncertaintyFloorCents'].map(key=>[key,document.getElementById('heating-limit-'+key).value]))`);
    await evaluate(`document.querySelector('#heating-explorer-controls .app-select-trigger').focus()`);
    await keyPress('Enter');await keyPress('Home');await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('heating-limit-savingsStrategy').value`),'gentle','Keyboard selects Gentle');
    await evaluate(`document.querySelector('#heating-explorer-controls .app-select-trigger').focus()`);
    await keyPress('Enter');await keyPress('End');await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('heating-limit-savingsStrategy').value`),'savings','Keyboard selects More savings');
    assert.deepEqual(await evaluate(`Object.fromEntries(Object.keys(${JSON.stringify(economics)}).map(key=>[key,document.getElementById('heating-limit-'+key).value]))`),economics,'Strategy leaves every monetary field unchanged');
    const beforeReset=await evaluate(`explorerFixture.requests.length`);
    await evaluate(`document.getElementById('heating-explorer-reset').click()`);
    assert.equal(await evaluate(`document.getElementById('heating-limit-savingsStrategy').value`),'balanced','Reset restores configured strategy');
    assert.equal(await evaluate(`explorerFixture.requests.length`),beforeReset,'Reset makes no optimization or request');
    await evaluate(`document.getElementById('heating-explorer-opportunities').querySelector('button').click()`);
    assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'6','Opportunity button applies only the hypothetical draft');
    assert.equal(await evaluate(`document.activeElement.id`),'heating-explorer-calculate','Opportunity focuses comparison');
    await evaluate(`document.getElementById('heating-explorer-reset').click()`);
    assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'4','Reset restores configured duration');
  }
  const awayInput=heatingExplorerFixture();
  awayInput.settings.occupancy={mode:'away',returnAt:new Date(awayInput.now+48*hour).toISOString()};
  awayInput.config.maxAwayReductionHours=24;
  const awayControls=exploreHeatingPlan(awayInput,{}, {includeOpportunities:false}).controls;
  await evaluate(`explorerFixture.value.controls=${JSON.stringify(awayControls)};document.getElementById('heating-explorer-refresh').click()`);
  await until(`document.getElementById('heating-limit-maxAwayReductionHours')&&!document.getElementById('heating-explorer-refresh').disabled`);
  for(const width of [320,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const away=await evaluate(`(() => {const input=document.getElementById('heating-limit-maxAwayReductionHours'),row=input.closest('.heating-explorer-control');
      const controls=[...document.getElementById('heating-explorer-controls').children].map(e=>({key:e.dataset.key,rect:e.getBoundingClientRect()}));
      return {value:input.value,label:row.querySelector('label').textContent,keys:controls.sort((a,b)=>Math.abs(a.rect.top-b.rect.top)<1?a.rect.left-b.rect.left:a.rect.top-b.rect.top).map(e=>e.key)};})()`);
    assert.equal(away.value,'24'); assert.equal(away.label,'Maximum reduction while away');
    assert.deepEqual(away.keys,width<=650?['savingsStrategy','preheatRoomBoostC','maxDropC','maxRiseC','maxAwayReductionHours','maxPreheatHours']
      :['savingsStrategy','maxDropC','maxAwayReductionHours','preheatRoomBoostC','maxRiseC','maxPreheatHours']);
    await evaluate(`document.getElementById('heating-explorer-jump').click()`);
    await screenshot(`${width}-away-controls`);
  }
  await evaluate(`explorerFixture.value.controls=${JSON.stringify(fixture.controls)};document.getElementById('heating-explorer-refresh').click()`);
  await until(`document.getElementById('heating-limit-maxReductionHours')&&!document.getElementById('heating-explorer-refresh').disabled`);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const tap=async selector=>{
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    const point=await evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {x,y,hit:node.contains(document.elementFromPoint(x,y))};})()`);
    assert(point.hit,`Touch target is reachable: ${selector}`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:point.x,y:point.y}]});
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await tap('#heating-explorer-jump');
  await tap('#heating-explorer-controls .app-select-trigger');
  await until(`document.querySelector('.app-select-popup:not([hidden]) [role="option"]')`);
  await tap('.app-select-popup:not([hidden]) [role="option"][data-index="0"]');
  assert.equal(await evaluate(`document.getElementById('heating-limit-savingsStrategy').value`),'gentle','Touch selects Gentle');
  await tap('#heating-explorer-reset');
  assert.equal(await evaluate(`document.getElementById('heating-limit-savingsStrategy').value`),'balanced');
  const learningValues=await evaluate(`['maxTrialCostCents','learningPriorityPriceCents'].map(key=>document.getElementById('heating-limit-'+key).value)`);
  assert(await evaluate(`!document.getElementById('heating-limit-learningTrials').checked&&!document.getElementById('heating-limit-learningTrials').disabled&&['maxTrialCostCents','learningPriorityPriceCents'].every(key=>document.getElementById('heating-limit-'+key).disabled)`),'Unchecked automatic permission keeps both values visible but disabled');
  await tap('#heating-explorer-learning-heading label');
  assert(await evaluate(`document.getElementById('heating-limit-learningTrials').checked&&['maxTrialCostCents','learningPriorityPriceCents'].every(key=>!document.getElementById('heating-limit-'+key).disabled)`),'The border-heading checkbox enables the learning inputs');
  await screenshot('390-touch-learning-enabled');
  const permissionRequestCount=await evaluate(`explorerFixture.requests.length`);
  await evaluate(`document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`!document.getElementById('heating-explorer-calculate').disabled`);
  assert.equal(await evaluate(`explorerFixture.requests.length`),permissionRequestCount+1);
  assert.deepEqual(await evaluate(`explorerFixture.requests.at(-1).body.limits`),{learningTrials:true},'Enabling trials does not submit a replacement allowance or priority');
  await evaluate(`document.getElementById('heating-limit-maxTrialCostCents').value='';document.getElementById('heating-limit-maxTrialCostCents').dispatchEvent(new Event('input',{bubbles:true}))`);
  await tap('#heating-explorer-learning-heading label');
  assert.deepEqual(await evaluate(`['maxTrialCostCents','learningPriorityPriceCents'].map(key=>document.getElementById('heating-limit-'+key).value)`),['',learningValues[1]],'Unchecking retains both values, including an unfinished budget draft');
  assert(await evaluate(`['maxTrialCostCents','learningPriorityPriceCents'].every(key=>document.getElementById('heating-limit-'+key).disabled)&&getComputedStyle(document.querySelector('#heating-explorer-learning-controls .heating-explorer-control-input')).opacity==='0.6'&&!document.getElementById('heating-limit-learningTrials').disabled`),'Disabled learning values are greyed while the checkbox remains usable');
  await evaluate(`document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`!document.getElementById('heating-explorer-calculate').disabled`);
  assert.deepEqual(await evaluate(`explorerFixture.requests.at(-1).body.limits`),{},'Disabled unfinished learning drafts do not block an ordinary comparison or create an allowance');
  await evaluate(`document.getElementById('heating-explorer-reset').click()`);
  assert.deepEqual(await evaluate(`['maxTrialCostCents','learningPriorityPriceCents'].map(key=>document.getElementById('heating-limit-'+key).value)`),learningValues,'Reset restores the captured learning values locally');
  const beforeInvalid=await evaluate(`explorerFixture.requests.length`);
  for(const width of [390,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:width===390?2:1,mobile:width===390});
    for(const [key,value] of [['preheatRoomBoostC','1.5'],['maxReductionHours','']]) {
      await evaluate(`(() => {document.getElementById('heating-explorer-reset').click();const input=document.getElementById('heating-limit-${key}');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('heating-explorer-form').requestSubmit();})()`);
      assert.equal(await evaluate(`explorerFixture.requests.length`),beforeInvalid,'Invalid limits cannot submit');
      await evaluate(`await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)`);
      assert(await evaluate(`(() => {const input=document.getElementById('heating-limit-${key}'),r=input.getBoundingClientRect(),header=document.querySelector('.heating-explorer-header').getBoundingClientRect();return document.activeElement===input&&r.top>=header.bottom&&r.bottom<=innerHeight&&input.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()`),`${width}px: native validation keeps the invalid ${key} visible below the sticky header`);
    }
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await evaluate(`document.getElementById('heating-explorer-reset').click()`);
  await tap('.heating-explorer-footnotes > summary');
  assert.equal(await evaluate(`document.querySelector('.heating-explorer-footnotes').open`),true,'Touch opens estimate explanations');
  await tap('.heating-explorer-footnotes > summary');
  assert.equal(await evaluate(`document.querySelector('.heating-explorer-footnotes').open`),false);
  await send('Emulation.setTouchEmulationEnabled',{enabled:false});
  for(const [width,height,theme]of [[320,740,'light'],[1280,1000,'dark']]){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.getElementById('heating-explorer-advanced').open=true`);
    for(const control of allControls){
      const selector=`#heating-limit-${control.key}`;
      await evaluate(`(() => {const row=document.querySelector(${JSON.stringify(selector)}).closest('[data-key]');row.scrollIntoView({block:'center'});row.querySelector('.status-detail-trigger').focus({preventScroll:true});})()`);
      await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await keyPress('Enter');
      await until(`!document.getElementById('status-detail-popover').hidden`);
      assert.equal(await evaluate(`document.getElementById('status-detail-heading').textContent`),control.label);
      assert.equal(await evaluate(`document.querySelector('.status-detail-body').textContent`),control.help);
      assert.equal(await evaluate(`document.getElementById('status-detail-popover').contains(document.activeElement)`),true,'Help is keyboard-accessible inside the modal');
      assert.equal(await evaluate(`(() => {const r=document.getElementById('status-detail-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;})()`),true,'Help fits the viewport');
      if(control.key==='economicUncertaintyFloorCents'){
        const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        writeFileSync(join(artifacts,`${width}-${theme}-uncertainty-help.png`),Buffer.from(shot.data,'base64'));
      }
      await keyPress('Escape');
      assert.equal(await evaluate(`document.getElementById('heating-explorer-dialog').open`),true,`Escape dismisses help before the planner: ${control.key}`);
      assert.equal(await evaluate(`document.activeElement.closest('[data-key]')?.querySelector('input,select').id`),`heating-limit-${control.key}`,'Help restores focus to its setting');
    }
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
  const comparisonRequests=await evaluate(`explorerFixture.requests.length`);
  await evaluate(`explorerFixture.holdComparison=true;document.getElementById('heating-explorer-form').requestSubmit();document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`Boolean(explorerFixture.releaseComparison)`);
  assert.equal(await evaluate(`explorerFixture.requests.length`),comparisonRequests+1,'Busy comparisons suppress duplicate submissions');
  assert(await evaluate(`document.getElementById('heating-explorer-calculate').disabled&&document.getElementById('heating-explorer-reset').disabled&&document.getElementById('heating-explorer-refresh').disabled&&[...document.querySelectorAll('#heating-explorer-form input,#heating-explorer-form select')].every(e=>e.disabled)&&!document.getElementById('heating-explorer-close').disabled`),'Busy state disables draft changes while Close remains available');
  await evaluate(`explorerFixture.holdComparison=false;explorerFixture.releaseComparison();explorerFixture.releaseComparison=null`);
  await until(`!document.getElementById('heating-explorer-calculate').disabled`);
  for(const width of [320,1280]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('.heating-explorer-breakdown > summary').click()`);
    assert(await evaluate(`document.querySelector('.heating-explorer-breakdown').open&&document.querySelectorAll('#heating-explorer-breakdown tbody tr').length>=3`),'Energy and recovery breakdown opens');
    assert(await evaluate(`(()=>{const d=document.getElementById('heating-explorer-dialog');return d.scrollWidth<=d.clientWidth+1;})()`),'Expanded breakdown fits the window');
    await evaluate(`document.querySelector('.heating-explorer-breakdown > summary').click()`);
    assert.equal(await evaluate(`document.querySelector('.heating-explorer-breakdown').open`),false);
  }
  await evaluate(`globalThis.originalHeatingTrajectory = structuredClone(explorerFixture.value.scenario.trajectory);
    explorerFixture.value.scenario.trajectory = originalHeatingTrajectory.map(point => ({...point, uncertaintyC:null}));
    document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`document.getElementById('heating-explorer-chart-uncertainty').textContent.includes('unavailable')`);
  assert.equal(await evaluate(`document.querySelectorAll('#heating-explorer-chart polygon').length`), 0,
    'Unknown model uncertainty never creates a zero-width confidence band');
  assert.match(await evaluate(`document.querySelector('#heating-explorer-chart svg').getAttribute('aria-label')`), /allowance unavailable/);
  await evaluate(`explorerFixture.value.scenario.trajectory = originalHeatingTrajectory.map((point,index) => ({...point,uncertaintyC:index===10?null:point.uncertaintyC}));
    explorerFixture.value.constraints.push({key:'maxDropC',label:'Configured temperature allowance',status:'limiting',value:1,unit:'°C',detail:'The configured comfort allowance limits this scenario.'});
    document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`document.getElementById('heating-explorer-chart-uncertainty').textContent.includes('gaps are unknown')`);
  assert.equal(await evaluate(`document.querySelectorAll('#heating-explorer-chart polygon').length`), 2,
    'The allowance preserves an unsupported interval between independently supported segments');
  assert.match(await evaluate(`document.querySelector('#heating-explorer-constraints [data-status="limiting"]').textContent`), /Limits this search/);
  await evaluate(`explorerFixture.value.scenario.trajectory = originalHeatingTrajectory;
    document.getElementById('heating-explorer-form').requestSubmit()`);
  await until(`document.getElementById('heating-explorer-chart-uncertainty').textContent === 'Shaded: model uncertainty allowance'`);
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
  await evaluate(`document.getElementById('heating-explorer-apply').click();document.getElementById('heating-explorer-apply').click()`);
  await until(`document.querySelector('.confirmation-dialog')?.open`);
  assert.equal(await evaluate(`document.querySelectorAll('.confirmation-dialog').length`),1,'Repeated approval clicks open one confirmation');
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Cancel', 'Confirmation defaults to Cancel');
  assert.match(await evaluate(`document.getElementById('confirmation-description').textContent`),/Estimated saving against Normal heating.*paused or disabled/);
  await keyPress('Escape');
  await until(`!document.querySelector('.confirmation-dialog')`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-dialog').open`),true,'Cancelling confirmation preserves the planner');
  assert.equal(await evaluate(`explorerFixture.requests.filter(r=>r.path.endsWith('/apply')).length`),0);
  await evaluate(`document.getElementById('heating-explorer-apply').click()`);
  await until(`document.querySelector('.confirmation-dialog')?.open`);
  await evaluate(`explorerFixture.role='family';await explorerFixture.poll()`);
  await evaluate(`document.querySelector('.confirmation-dialog .confirmation-actions button:last-child').click()`);
  await until(`!document.querySelector('.confirmation-dialog')`);
  assert.equal(await evaluate(`explorerFixture.requests.filter(r=>r.path.endsWith('/apply')).length`),0,'Losing admin access while reviewing prevents submission');
  await evaluate(`explorerFixture.role='admin';await explorerFixture.poll();document.getElementById('heating-explorer-apply').click()`);
  await until(`document.querySelector('.confirmation-dialog')?.open`);
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
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxDropC').value`),'1.75','Refreshing conditions preserves the edited draft');
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
  await evaluate(`explorerFixture.stale=false;explorerFixture.refreshFailure=true;document.getElementById('heating-explorer-refresh').click()`);
  await until(`!document.getElementById('heating-explorer-refresh').disabled`);
  assert.match(await evaluate(`document.getElementById('heating-explorer-message').textContent`),/unavailable/);
  assert.doesNotMatch(await evaluate(`document.getElementById('heating-explorer-message').textContent`),/Synthetic private backend detail/);
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'6','Failed refresh retains the draft');
  assert.equal(await evaluate(`document.getElementById('heating-explorer-calculate').disabled`),true,'Failed refresh keeps old preview fenced');
  await evaluate(`explorerFixture.refreshFailure=false;document.getElementById('heating-explorer-refresh').click()`);
  await until(`!document.getElementById('heating-explorer-refresh').disabled&&!document.getElementById('heating-explorer-calculate').disabled`);
  assert.equal(await evaluate(`document.getElementById('heating-limit-maxReductionHours').value`),'6','Successful retry retains the draft');
  await evaluate(`explorerFixture.recorded=true`);
  await until(`await explorerFixture.poll();return !document.getElementById('heating-explorer-dialog').open`);
  const beforeRecorded = await evaluate(`explorerFixture.requests.length`);
  await evaluate(`document.getElementById('home-planned-change').click();await explorerFixture.poll()`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-dialog').open`),true,'A recorded plan stays readable across polling');
  assert.match(await evaluate(`document.getElementById('heating-explorer-message').textContent`),/Recorded history only/);
  assert.equal(await evaluate(`explorerFixture.requests.length`),beforeRecorded,'Recorded view does not request live simulation');
  await pause(1200);
  assert.match(await evaluate(`document.getElementById('heating-explorer-message').textContent`), /Recorded history only/,
    'The one-second display tick preserves the recorded explanation');
  await evaluate(`document.getElementById('heating-explorer-close').click(); explorerFixture.recorded=false;
    explorerFixture.pair = { role:'slave',canControl:false,nodeId:'synthetic-viewer',pairId:'synthetic-pair',
      transition:null,webAccess:{role:'family',source:'password'} }; await explorerFixture.poll();
    document.getElementById('home-planned-change').click(); await explorerFixture.pairPoll()`);
  assert.equal(await evaluate(`document.getElementById('heating-explorer-dialog').open`), true,
    'Unchanged slave management polls preserve the recorded plan window');
  assert.match(await evaluate(`document.getElementById('heating-explorer-message').textContent`), /Saved decision from local history/);
  await evaluate(`document.getElementById('heating-explorer-close').click();
    document.getElementById('fireplace-shortcut').click(); await explorerFixture.pairPoll()`);
  assert.equal(await evaluate(`document.getElementById('fireplace-dialog').open`), true,
    'Unchanged slave management polls preserve the read-only fireplace window');
  await evaluate(`explorerFixture.pair.role='protected'; await explorerFixture.pairPoll()`);
  assert.equal(await evaluate(`document.getElementById('fireplace-dialog').open`), false,
    'An actual authority transition still closes stale windows');
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
  if (ui) await new Promise(resolve => ui.httpServer.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
