// Run after npm run build. Every provider/status/action below is synthetic;
// the isolated application and disposable browser never load household config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-charging-screenshots-'));
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
    const fixture = await evaluate(`({lastMutation:chargingFixture.mutations.at(-1),
      message:document.querySelector('[data-test-message]')?.textContent,
      receipt:document.querySelector('[data-test-schedule-receipt]')?.textContent,
      focused:{tag:document.activeElement?.tagName,id:document.activeElement?.id},
      confirmDisabled:document.querySelector('[data-test-confirm]')?.disabled,
      targetDisabled:document.querySelector('[data-test-target-value]')?.disabled})`);
    throw new Error(`UI did not settle: ${expression}; browser errors: ${errors.join(', ')}; synthetic fixture: ${JSON.stringify(fixture)}`);
  };
  const keyPress = async key => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Backspace: 8, a: 65 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const pointerClick = async selector => {
    const point = await evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});
      node.scrollIntoView({block:'center'});const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`);
    await send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point});
  };
  const typeField = async (selector, value) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();document.querySelector(${JSON.stringify(selector)}).select()`);
    await send('Input.insertText', {text:value});
  };
  const integratedTime = async selector => assert.equal(await evaluate(`(() => {
    const input=document.querySelector(${JSON.stringify(selector)}), group=input.closest('.charging-time-input');
    const button=group?.querySelector('.charging-time-choose');
    if(!button || !button.getAttribute('aria-label') || button.textContent.trim()) return false;
    const a=input.getBoundingClientRect(), b=button.getBoundingClientRect();
    return b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom
      && b.width >= 32 && b.height >= 32;
  })()`), true, `${selector} has an accessible clock button inside the field without a separate Choose time row`);
  const poll = async () => { await evaluate('chargingFixture.poll()'); await pause(60); };
  const setFields = values => evaluate(`(() => {
    const form = document.getElementById('charging-test-form');
    for (const [name, value] of Object.entries(${JSON.stringify(values)})) {
      const input = form.elements.namedItem(name);
      if (input.type === 'checkbox') input.checked = value; else input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (input.tagName === 'SELECT') input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  const screenshot = async (name, selector, { preserveScroll = false, viewport = false } = {}) => {
    // Fixed-position dialogs must be captured at document scroll zero: Chrome
    // otherwise clips background content at the dialog's document coordinates.
    await evaluate(`${viewport ? `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});` : 'window.scrollTo(0, 0);'} ${preserveScroll ? '' : `document.querySelector(${JSON.stringify(selector)}).scrollTop = 0;`} true`);
    await pause(80);
    const clip = viewport ? null : await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !viewport, ...(clip ? {clip} : {}) });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  const fits = async selector => assert.equal(await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)}), r = node.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth + 1 && node.scrollWidth <= node.clientWidth + 1
      && r.left >= -1 && r.right <= innerWidth + 1;
  })()`), true, `${selector} fits the viewport without horizontal overflow`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.chargingFixture = { reads: 0, mutations: [], reportMutations: [], reportReads: [], deletedReports: [], declarationChecks: [], runs: [], readOnly: false, family: false, connected: false, archived: false,
      noChargers: false, vehicleReadings: {}, diagnosticsAvailable: true, recent: [], second: { current: null, recent: [] },
      currentTest: null, currentTestConnected: true, devices: {
        charger1: {model:'Synthetic Easee',firmware:'9.9.1',source:'ocpp-boot',receivedAt:${now - 60000},available:true},
        charger2: {model:'Synthetic Shelly EVSE',firmware:'9.9.2',source:'shelly-device-info',receivedAt:${now - 120000},available:true}
      } };
    const N = ${now};
    const field = (value, receipt = false) => ({ value, available: true, measuredAt: receipt ? null : N - 60000,
      receivedAt: N - 30000, retained: false, timeBasis: receipt ? 'receipt-only' : 'measurement' });
    chargingFixture.report = { id: 'report-fixture', startedAt: N - 7200000, endedAt: null, evaluatedAt: N,
      vehicleId: null, outcome: { state: 'in-progress' }, behavior: 'attention', attentionCount: 1, recoveredCount: 0,
      current: { automaticEnabled: false, chargeNow: false, scheduleState: 'none', physicalFresh: true,
        vehicleId: null, vehicleSoc: false, soc: { value: 20, source: 'manual-fallback', assumed: true },
        power: { value: 0, source: 'easee-ocpp', measuredAt: N - 45000, receivedAt: N - 30000 },
        powerKw: 0, charging: false, reportedCharging: true },
      coverage: { identification: { state: 'not-exercised' }, initialRelease: { state: 'not-exercised' }, pause: { state: 'not-exercised' },
        resume: { state: 'not-exercised' }, completion: { state: 'not-exercised' }, energy: { state: 'insufficient-evidence' } },
      findings: [{ code: 'control-unconfirmed', severity: 'attention', firstAt: N - 1800000, resolvedAt: null }],
      timeline: [{ kind: 'session', code: 'observation-started', at: N - 3600000 },
        { kind: 'physical', code: 'not-charging-observed', at: N - 3500000, powerKw: 0, source: 'easee-ocpp',
          measuredAt: N - 3530000, receivedAt: N - 3510000 },
        { kind: 'charger-status', code: 'charger-reports-charging', at: N - 3500000, powerKw: 0, source: 'easee-ocpp',
          measuredAt: N - 3540000, receivedAt: N - 3530000, powerMeasuredAt: N - 3530000, powerReceivedAt: N - 3510000 },
        { kind: 'plan', code: 'target-update', at: N - 2400000, changes: [{ field: 'target', before: 80, after: 85 }] },
        { kind: 'finding', code: 'control-unconfirmed', at: N - 1800000 }],
      plans: [{ at: N - 3600000, reason: 'initial-plan', deadlineAt: N + 3600000, feasible: null,
        automatic: false, chargeNow: false, scheduleState: 'none', state: 'disabled', changes: [], vehicleId: null,
        inputs: { soc: { value: 20, source: 'manual-fallback', assumed: true }, target: { value: 80, source: 'manual-fallback' },
          capacity: { value: 74, source: 'manual-fallback', assumed: true } }, periods: [] },
      { at: N - 2400000, reason: 'target-update', deadlineAt: N + 3600000, feasible: null,
        automatic: false, chargeNow: false, scheduleState: 'none', state: 'disabled',
        changes: [{ field: 'target', before: 80, after: 85 }], vehicleId: null,
        inputs: { soc: { value: 20, source: 'manual-fallback', assumed: true }, target: { value: 85, source: 'session-request' },
          capacity: { value: 74, source: 'manual-fallback', assumed: true } }, periods: [] }], truncated: {} };
    function eventsFor(report) {
      const events = report.timeline.map(row => ({...row}));
      for (const plan of report.plans) {
        const paired = events.find(row => row.kind === 'plan' && row.at === plan.at && row.code === plan.reason && !row.plan);
        if (paired) paired.plan = plan;
        else events.push({at:plan.at,kind:'plan',code:plan.reason,changes:plan.changes,plan});
      }
      return events.sort((a,b) => a.at-b.at).map((row,index) => ({...row,id:index+1,sequence:index+1}));
    }
    function summaryFor(report) {
      if (!report) return null;
      const {timeline,plans,truncated,...summary} = report;
      return {...summary,saved:report.saved===true,observedFrom:timeline.find(row=>row.kind==='session')?.at,
        counts:{events:eventsFor(report).length,plans:plans.length,findings:report.findings.reduce((n,row)=>n+(row.count??1),0)},
        readOnly:chargingFixture.readOnly,retention:{days:30}};
    }
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (path.startsWith('/api/charging/reports')) {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href), f = chargingFixture;
        const all = (url.searchParams.get('chargerId') === 'charger2' ? [f.second.current,...f.second.recent] : [f.report,...f.recent])
          .filter(row=>row&&!f.deletedReports.includes(row.id));
        const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
        if (path === '/api/charging/reports') return json({reports:all.filter(row=>url.searchParams.get('savedOnly')!=='true'||row.saved).map(summaryFor),nextBefore:null,readOnly:f.readOnly});
        const id=decodeURIComponent(path.split('/')[4]), report=all.find(row=>row.id===id);
        if (!report) return json({error:'Report not found'},404);
        if (method.toUpperCase()==='POST') {
          const body=JSON.parse(options.body??'{}');
          if(f.family||f.readOnly) return json({error:'Report management is unavailable'},403);
          f.reportMutations.push({path,body});
          if(path.endsWith('/save')) {
            report.saved=body.saved;
            if(!body.saved&&report.endedAt!==null&&report.endedAt<=N-30*86400000) {f.deletedReports.push(id);return json({deleted:true});}
            return json(summaryFor(report));
          }
          if(path.endsWith('/delete')) {
            if(report.endedAt===null) return json({error:'Active report cannot be deleted'},409);
            f.deletedReports.push(id);f.recent=f.recent.filter(row=>row.id!==id);f.second.recent=f.second.recent.filter(row=>row.id!==id);return json({deleted:true});
          }
        }
        if (path.endsWith('/events')) {
          const kinds={findings:['finding','finding-update','recovery'],plans:['plan'],charging:['physical','charger-status','outcome','session','check'],control:['control'],vehicle:['identification','vehicle'],evidence:['evidence']};
          const filter=url.searchParams.get('filter'), before=Number(url.searchParams.get('before')??Infinity), limit=Number(url.searchParams.get('limit')??50);
          f.reportReads.push({id,filter});
          const events=eventsFor(report).filter(row=>row.id<before&&(filter==='all'||kinds[filter]?.includes(row.kind))).reverse();
          return json({events:events.slice(0,limit),nextBefore:events.length>limit?String(events[limit-1].id):null,readOnly:f.readOnly});
        }
        return json(summaryFor(report));
      }
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        const body = JSON.parse(options.body ?? '{}'); chargingFixture.mutations.push({ path, body });
        const ordinaryBefore = JSON.stringify(chargingFixture.ordinaryCharging);
        const checkedResponse = response => {
          chargingFixture.declarationChecks.push({path, unchanged:ordinaryBefore === JSON.stringify(chargingFixture.ordinaryCharging)});
          return response;
        };
        if (path === '/api/charging/tests/preview') {
          await globalThis.fetch('/api/status');
          if (chargingFixture.previewError) {
            const error = chargingFixture.previewError; chargingFixture.previewError = null;
            return checkedResponse(new Response(JSON.stringify({error}), {status:400,headers:{'Content-Type':'application/json'}}));
          }
          return checkedResponse(new Response(JSON.stringify({ eligible: true,
          headroom: { minutes: 180, capacityKwh: body.capacityKwh, powerKw: 11,
            minimumMinutes: body.program === 'immediate' ? 30 : 60 },
          gates: [{ state: 'ready', message: 'The physical charger is unplugged and ready.' },
            { state: 'ready', message: 'Vehicle feed available; physical identity remains unconfirmed.' }] }), { headers: { 'Content-Type': 'application/json' } }));
        }
        if (path === '/api/charging/tests/start') {
          chargingFixture.runs.unshift({ id: 'run-' + (chargingFixture.runs.length + 1), association: body.association,
            vehicleId: body.vehicleId, chargerId: body.chargerId, program: body.program, phase: 'armed', sessionId: null,
            expectations: { soc: body.soc, nativeTargetSoc: body.nativeTargetSoc, capacityKwh: body.capacityKwh,
              vehicleStartAt: body.vehicleStartAt ?? null },
            schedule: { startAt: body.vehicleStartAt ?? null, confirmedAt: null, history: [] },
            target: { reportedSoc: null, reportedAt: null, source: null, revision: 1, requiresConfirmation: false,
              history: [{ targetSoc: body.nativeTargetSoc, confirmedAt: N }] },
            milestones: { identification: null, initialPlan: null }, findings: [] });
        } else if (path === '/api/charging/tests/schedule') {
          const run = chargingFixture.runs.find(item => item.id === body.id); run.phase = 'observing';
          run.schedule.startAt = body.startAt; run.schedule.confirmedAt = N;
          run.schedule.history.push({ startAt: body.startAt, confirmedAt: N, source: 'user-confirmed' });
          run.milestones.vehicleSchedule = { at: N, startAt: body.startAt,
            message: 'User confirmed the vehicle schedule; awaiting actual charging evidence.' };
          run.restorationReminder = 'Restore the vehicle timer after this test.';
        } else if (path === '/api/charging/tests/target') {
          const run = chargingFixture.runs.find(item => item.id === body.id);
          if (body.targetRevision !== run.target.revision || Object.hasOwn(body, 'revision'))
            throw new Error('Assessment target confirmation must use its own revision, never the charger request revision');
          if (body.nativeTargetSoc !== run.expectations.nativeTargetSoc) delete run.target.verifications;
          if (body.verification) {
            if (body.verification.reportedSoc !== run.target.reportedSoc || body.verification.source !== run.target.source)
              throw new Error('The displayed vehicle target changed; review the current reading before confirming');
            run.target.verifications ??= [];
            run.target.verifications.push({targetSoc:body.nativeTargetSoc,reportedSoc:run.target.reportedSoc,
              source:run.target.source,reportedAt:run.target.reportedAt,confirmedAt:N});
          }
          run.expectations.nativeTargetSoc = body.nativeTargetSoc;
          run.target.revision++;
          run.target.requiresConfirmation = run.target.reportedSoc !== body.nativeTargetSoc
            && !run.target.verifications?.some(row => row.targetSoc === body.nativeTargetSoc
              && row.reportedSoc === run.target.reportedSoc && row.source === run.target.source);
          run.target.history.push({ targetSoc: body.nativeTargetSoc, confirmedAt: N });
        } else if (path === '/api/charging/tests/cancel') {
          const run = chargingFixture.runs.find(item => item.id === body.id); run.phase = 'cancelled';
        } else throw new Error('Unexpected mutation in charging browser fixture: ' + path);
        return checkedResponse(await globalThis.fetch('/api/status'));
      }
      const response = await nativeFetch(input, options);
      if (path !== '/api/status') return response;
      const status = await response.json(); chargingFixture.reads++;
      status.readOnly = chargingFixture.readOnly;
      if(chargingFixture.family) status.webAccess={role:'family',source:'password'};
      status.charging.settings.vehicles.tesla.capacityKwh = 57;
      status.charging.settings.vehicles.bmw.capacityKwh = 74;
      status.charging.physicalTests = { available: true, canManage: !chargingFixture.readOnly, runs: chargingFixture.runs };
      for (const charger of status.charging.chargers) {
        charger.association = charger.id + '-fixture-association';
        charger.device = chargingFixture.devices[charger.id] ?? null;
        charger.settings.enabled = true;
        charger.values.connected = field(chargingFixture.connected && charger.id === 'charger1');
        charger.values.charging = field(false); charger.control = { phase: 'off',
          ...(charger.id === 'charger1' ? {snapshot:{transport:'ocpp'}} : {}) };
        if (chargingFixture.readyBySession && charger.id === 'charger1') {
          charger.request = {sessionId:'ready-by-browser-session',revision:1,chargeNow:false};
          charger.capabilities.scheduling = true;
        }
        if (chargingFixture.currentTest && charger.id === 'charger2') {
          const currentTest = chargingFixture.currentTest;
          const active = ['proposed','applying','active'].includes(currentTest.phase);
          charger.values.connected = field(chargingFixture.currentTestConnected);
          charger.values.charging = field(chargingFixture.currentTestConnected);
          charger.capabilities = {...charger.capabilities,scheduling:true,currentControl:false};
          charger.controls = {enabled:true,revision:1};
          charger.request = chargingFixture.currentTestConnected ? {sessionId:currentTest.sessionId,revision:1,chargeNow:false} : null;
          charger.vehicle = {id:null,state:chargingFixture.currentTestConnected ? 'identifying' : 'disconnected'};
          charger.identification = {phase:active ? 'waiting' : 'completed',active,available:!active,
            reason:active ? 'current-evidence-pending' : null,currentTest};
          charger.telemetry = {...charger.telemetry,identificationCurrentReady:true};
        }
      }
      if (chargingFixture.noChargers) status.charging.chargers = [];
      status.charging.vehicleFeeds = ['bmw', 'tesla'].map(id => ({ id, label: id === 'bmw' ? 'BMW' : 'Tesla',
        provider: id === 'bmw' ? 'bmw-cardata' : 'teslamate', usedByChargerId: null,
        reception: { brokerConnected: true, subscribed: true, ...(id === 'bmw' ? { available: true } : {}) },
        setup: { available: true, healthy: true, state: id === 'tesla' ? 'asleep' : null,
          fields: { soc: field(id === 'bmw' ? 35 : 40, id === 'tesla'), minimumSoc: field(id === 'bmw' ? 100 : 80, id === 'tesla'),
            ...(id === 'bmw' ? { capacityKwh: field(72.43) } : { vehicleNotBefore: field(N + 10 * 3600000, true) }),
            atHome: field(true, id === 'tesla'), pluggedIn: field(false, id === 'tesla'), charging: field(false, id === 'tesla'),
            powerKw: field(0, true), requestedCurrentA: field(16, true), maxCurrentA: field(16, true),
            ...chargingFixture.vehicleReadings[id] } } }));
      status.charging.diagnostics = { available: chargingFixture.diagnosticsAvailable, chargers: [{ id: 'charger1',
        current: chargingFixture.archived ? null : summaryFor(chargingFixture.report),
        recent: (chargingFixture.archived ? [chargingFixture.report, ...chargingFixture.recent] : chargingFixture.recent).filter(row=>!chargingFixture.deletedReports.includes(row.id)).map(summaryFor) },
        { id: 'charger2', current: summaryFor(chargingFixture.second.current), recent: chargingFixture.second.recent.map(summaryFor) }] };
      chargingFixture.ordinaryCharging = structuredClone({settings:status.charging.settings,
        chargers:status.charging.chargers.map(({id,settings,request,values,vehicle,plan,control}) => ({id,settings,request,values,vehicle,plan,control})),
        vehicleFeeds:status.charging.vehicleFeeds});
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15000 && callback.toString().includes('background')) chargingFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
    const restoredFixture = sessionStorage.getItem('charging-browser-fixture');
    if (restoredFixture) {
      Object.assign(chargingFixture, JSON.parse(restoredFixture));
      sessionStorage.removeItem('charging-browser-fixture');
    }
    chargingFixture.observeTarget = (id, reportedSoc, source, reportedAt) => {
      const run = chargingFixture.runs.find(item => item.id === id), target = run.target;
      Object.assign(target, {reportedSoc,source,reportedAt});
      target.requiresConfirmation = reportedSoc !== run.expectations.nativeTargetSoc
        && !target.verifications?.some(row => row.targetSoc === run.expectations.nativeTargetSoc
          && row.reportedSoc === reportedSoc && row.source === source);
      chargingFixture.vehicleReadings[run.vehicleId] ??= {};
      chargingFixture.vehicleReadings[run.vehicleId].minimumSoc = {
        value:reportedSoc,available:true,measuredAt:reportedAt,receivedAt:reportedAt,
      };
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("chargingFixture.poll && document.getElementById('charging-setup-tesla-state')?.textContent === 'Healthy · Sleeping'");
  assert.deepEqual(errors, []);
  await evaluate("document.getElementById('connections-details').open = true; document.querySelector('#charging-setup-details > summary').focus()");
  await keyPress('Enter');
  assert.equal(await evaluate("document.getElementById('charging-setup-details').open"), true);

  // Setup owns device facts and installation guidance. These observations have
  // independent source clocks and never become qualification claims or commands.
  assert.equal(await evaluate("document.querySelectorAll('.charging-setup-hardware.equipment-setup-hardware > div').length"), 2,
    'Charging reuses the Garage hardware card pattern for both physical chargers');
  for (const [id, version] of [['charger1', '9.9.1'], ['charger2', '9.9.2']]) {
    assert.match(await evaluate(`document.getElementById('charging-setup-${id}-firmware').textContent`), new RegExp(version.replaceAll('.', '\\.')));
    assert.doesNotMatch(await evaluate(`document.getElementById('charging-setup-${id}-firmware').textContent`), /tested|qualified|verified/i,
      'Reported device firmware is not presented as tested firmware');
    assert.match(await evaluate(`document.getElementById('charging-setup-${id}-firmware-source').textContent`), /received|reported/i,
      'Reported firmware shows its evidence source or receipt clock');
  }
  assert.match(await evaluate("document.querySelector('.charging-setup-hardware a[href$=\"#hardware-verification-still-required\"]').textContent"), /Limited checks on firmware 1\.7\.1/,
    'The separate recorded firmware baseline links to its bounded qualification scope');
  const originalFirmwareSource = await evaluate("document.getElementById('charging-setup-charger2-firmware-source').textContent");
  await poll();
  assert.equal(await evaluate("document.getElementById('charging-setup-charger2-firmware-source').textContent"), originalFirmwareSource,
    'Polling preserves the original firmware evidence clock');
  await evaluate('chargingFixture.devices.charger2.available = false'); await poll();
  assert.match(await evaluate("document.getElementById('charging-setup-charger2-firmware').textContent + ' ' + document.getElementById('charging-setup-charger2-firmware-source').textContent"), /last|unavailable|unconfirmed/i,
    'Unavailable device evidence cannot imply a current firmware reading');
  await evaluate('chargingFixture.devices.charger2 = null'); await poll();
  assert.match(await evaluate("document.getElementById('charging-setup-charger2-firmware').textContent"), /unknown|unavailable|not reported/i,
    'A missing firmware report stays unknown');
  await evaluate(`chargingFixture.devices.charger2 = {model:'Synthetic Shelly EVSE',firmware:'9.9.2',source:'shelly-device-info',receivedAt:${now - 120000},available:true}`);
  await poll();
  const docPaths = await evaluate(`Array.from(document.querySelectorAll('#charging-setup-content a[href]'), node => node.href)
    .filter(href => href.startsWith('https://github.com/hokkanen/st-mq/blob/main/docs/'))`);
  assert(docPaths.length >= 4, 'Charging setup provides links to its user, integration and verification documentation');
  for (const href of docPaths) {
    const path = new URL(href).pathname.replace('/hokkanen/st-mq/blob/main/', '');
    assert(existsSync(join(import.meta.dirname, '../..', path)), `Setup documentation exists: ${path}`);
  }
  for (const id of ['charger1', 'charger2']) {
    await evaluate(`for (let node = document.getElementById('${id}-setup-link'); node; node = node.parentElement)
      if (node.tagName === 'DETAILS') node.open = true;
      document.getElementById('connections-details').open = false;
      document.getElementById('charging-setup-details').open = false;
      document.getElementById('charging-setup-${id}-details').open = false;
      document.getElementById('${id}-setup-link').focus()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('connections-details').open
      && document.getElementById('charging-setup-details').open
      && document.getElementById('charging-setup-${id}-details').open
      && document.activeElement === document.querySelector('#charging-setup-${id}-details > summary')`), true,
      'Session setup link opens the matching device and moves keyboard focus to its heading');
    await poll();
    assert.equal(await evaluate(`document.getElementById('charging-setup-${id}-details').open
      && document.activeElement === document.querySelector('#charging-setup-${id}-details > summary')`), true,
      'Status polling retains the setup disclosure and focus');
  }
  for (const [width, height] of [[320, 568], [390, 667], [1440, 900]]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
    await evaluate(`document.documentElement.dataset.theme = '${theme}';
      for (const fold of document.querySelectorAll('#charging-setup-content details')) fold.open = true`);
    await fits('#charging-setup-content');
    const clipped = await evaluate(`Array.from(document.querySelectorAll('#charging-setup-content *')).filter(node => {
      if (!node.checkVisibility()) return false;
      const style = getComputedStyle(node);
      return node.scrollWidth > node.clientWidth + 1 && ['hidden', 'clip'].includes(style.overflowX);
    }).map(node => node.id || node.className)`);
    assert.deepEqual(clipped, [], 'Expanded setup keeps device, protocol and firmware evidence readable');
    await screenshot(`charging-setup-expanded-${width}-${height}-${theme}`, '#charging-setup-details');
  }
  assert.equal(await evaluate('chargingFixture.mutations.length'), 0,
    'Device inspection, documentation and setup navigation do not send charger commands');
  await send('Emulation.setDeviceMetricsOverride', {width:1440, height:1000, deviceScaleFactor:1, mobile:false});
  await evaluate("document.getElementById('charging-setup-assessment-details').open = true; document.getElementById('charging-setup-bmw-test').focus()");
  await keyPress('Enter');
  await until("document.getElementById('charging-test-dialog').open");
  await keyPress('Escape');
  await until("!document.getElementById('charging-test-dialog').open");
  assert.equal(await evaluate('document.activeElement.id'), 'charging-setup-bmw-test', 'Escape returns focus to the setup button');
  assert.equal(await evaluate('chargingFixture.mutations.length'), 0, 'Opening and closing guides never commands a charger');

  // Vehicle preparation uses its independent feed before any charger is selected.
  // Exercise the application listbox itself, including keyboard selection.
  await evaluate('chargingFixture.noChargers = true'); await poll();
  await click('#charging-setup-bmw-test');
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh'].map(name =>
    document.querySelector('#charging-test-form [name=' + name + ']').value)`), ['35', '100', '72.43'],
  'BMW battery, one assumed vehicle target and usable capacity load without a configured charger');
  assert.equal(await evaluate("document.querySelector('[name=capacityKwh]').validity.valid && !document.querySelector('[name=capacityKwh]').validity.stepMismatch"), true,
    'The exact 72.43 kWh vehicle reading is valid without rounding or a browser step error');
  assert.equal(await evaluate("document.querySelector('[name=chargerId]').value"), '', 'Preparation does not silently select a physical charger');
  assert.match(await evaluate("document.querySelector('[data-test-source=soc]').textContent"), /vehicle|BMW|reported/i);
  assert.equal(await evaluate("document.querySelectorAll('#charging-test-form select.app-select-source').length"), 3,
    'Vehicle, physical charger and program use application dropdowns');
  await click('[name=vehicleId] + .app-select-trigger');
  await keyPress('ArrowDown'); await keyPress('Enter');
  assert.equal(await evaluate("document.querySelector('[name=vehicleId]').value"), 'tesla');
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh'].map(name =>
    document.querySelector('#charging-test-form [name=' + name + ']').value)`), ['40', '80', '57'],
  'Tesla loads its own readings and its configured capacity fallback');
  assert.match(await evaluate("document.querySelector('[data-test-source=capacityKwh]').textContent"), /configur|default/i);
  assert.equal(await evaluate('chargingFixture.mutations.length'), 0, 'Selecting vehicles only loads independent vehicle data');
  await click('[name=vehicleId] + .app-select-trigger');
  await keyPress('ArrowUp'); await keyPress('Enter');
  await setFields({ soc: '36', nativeTargetSoc: '82', capacityKwh: '72' });
  await evaluate(`chargingFixture.vehicleReadings.bmw = {
    soc:{value:37,available:true,measuredAt:${now},receivedAt:${now}},
    minimumSoc:{value:85,available:true,measuredAt:${now},receivedAt:${now}} }`);
  await poll();
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh'].map(name =>
    document.querySelector('#charging-test-form [name=' + name + ']').value)`), ['36', '82', '72'],
  'Background vehicle readings never replace edits to the battery, target or capacity');
  await click('[data-test-load]');
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh'].map(name =>
    document.querySelector('#charging-test-form [name=' + name + ']').value)`), ['37', '85', '72.43'],
  'The explicit load action replaces fields with the latest available readings');
  await evaluate(`chargingFixture.vehicleReadings.bmw = {
    soc:{value:null,available:false},minimumSoc:{value:null,available:false},capacityKwh:{value:null,available:false} }`);
  await evaluate("sessionStorage.setItem('charging-browser-fixture', JSON.stringify(chargingFixture))");
  await send('Page.reload');
  await until("chargingFixture.poll && document.getElementById('charging-setup-tesla-state')?.textContent === 'Healthy · Sleeping'");
  await click('#charging-setup-bmw-test');
  await setFields({ program: 'vehicle-schedule' });
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh','vehicleStartAt'].map(name =>
    document.querySelector('#charging-test-form [name=' + name + ']').value)`), ['', '', '74', ''],
  'Missing BMW battery and target require entry, capacity falls back to configuration, and no unsupported schedule is invented');
  assert.match(await evaluate("document.querySelector('[data-test-source=soc]').textContent"), /unavailable|enter|provide|not.*available/i);
  assert.equal(await evaluate('chargingFixture.mutations.length'), 0,
    'Loading or replacing preparation values does not arm a session or change car settings');
  await evaluate('chargingFixture.noChargers = false; chargingFixture.vehicleReadings = {}'); await poll();
  await setFields({ vehicleId: 'bmw', chargerId: 'charger1', program: 'immediate', soc: '35.2', nativeTargetSoc: '82.1', capacityKwh: '0', prepared: true });
  const beforeInvalidPreparation = await evaluate('chargingFixture.mutations.length');
  await click('[data-test-preview]');
  assert.match(await evaluate("document.querySelector('[data-test-message]').textContent"), /capacity.*1.*300/i,
    'Invalid capacity gives a field-specific range error before any request');
  assert.equal(await evaluate('chargingFixture.mutations.length'), beforeInvalidPreparation);
  await setFields({ capacityKwh: '71.987', prepared: true });
  assert.equal(await evaluate("document.querySelector('[data-test-message]').textContent"), '',
    'Correcting the invalid field clears its obsolete validation message');
  await evaluate("document.querySelector('[name=soc]').focus(); globalThis.savedSocInput = document.querySelector('[name=soc]')");
  await poll();
  assert.equal(await evaluate("document.querySelector('[name=soc]').value === '35.2' && document.activeElement === savedSocInput && savedSocInput === document.querySelector('[name=soc]')"), true,
    'Normal test drafts and field focus survive a status poll');
  assert.equal(await evaluate("document.querySelector('[name=capacityKwh]').validity.valid && !document.querySelector('[name=capacityKwh]').validity.stepMismatch"), true,
    'A manually verified capacity with three decimal places remains valid');
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await fits('#charging-test-dialog'); await screenshot(`preparation-${width}-${theme}`, '#charging-test-dialog');
  }
  await until("!document.querySelector('[data-test-preview]').disabled");
  await evaluate("chargingFixture.previewError = 'Enter usable battery capacity from 1 to 300 kWh.'");
  await click('[data-test-preview]');
  await until("document.querySelector('[data-test-message]').textContent.includes('Enter usable battery capacity from 1 to 300 kWh.')");
  assert.deepEqual(await evaluate(`['soc','nativeTargetSoc','capacityKwh'].map(name => document.querySelector('[name=' + name + ']').value)`),
    ['35.2','82.1','71.987'], 'A precise server preparation error keeps all manually verified values for correction');
  await until("!document.querySelector('[data-test-preview]').disabled");
  await click('[data-test-preview]');
  await until("!document.querySelector('[data-test-arm]').disabled");
  const immediate = { chargerId: 'charger1', vehicleId: 'bmw', program: 'immediate', association: 'charger1-fixture-association',
    soc: 35.2, nativeTargetSoc: 82.1, capacityKwh: 71.987, prepared: true };
  assert.match(await evaluate("document.querySelector('[data-test-preparation]').textContent"), /assessment/i);
  assert.doesNotMatch(await evaluate("document.querySelector('[data-test-preparation]').textContent"), /Apply these inputs|Use these values for this charging session/i,
    'Preparation explains that the entered values belong only to the assessment');
  assert.equal(await evaluate("document.querySelectorAll('#charging-test-form [name=nativeTargetSoc]').length"), 1,
    'The guide asks for one assumed vehicle target');
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/preview', body: immediate });
  await click('[data-test-arm]');
  await until("document.querySelector('[data-test-phase]').textContent === 'Ready to plug in'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/start', body: immediate });
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  assert.equal(await evaluate("document.querySelector('[data-test-phase]').textContent"), 'Ready to plug in', 'An armed test survives closing the window');
  await evaluate("chargingFixture.runs[0].sessionId='session-fixture-1'; chargingFixture.runs[0].report={id:'report-fixture'}; chargingFixture.runs[0].phase='observing'; chargingFixture.connected=true");
  await poll(); await until("!document.querySelector('[data-test-report]').disabled");

  await evaluate(`chargingFixture.runs[0].shared = {priorityChanges:1,coverage:{overlap:'observed'},current:{
    selectedPriority:'charger2',overlap:'observed',priority:'consistent',prioritySince:null,
    peers:[{id:'charger1',connected:true,drawing:true,powerKw:4.14},{id:'charger2',connected:true,drawing:true,powerKw:5.52}],
    execution:{state:'consistent'},proposed:{state:'feasible',costCents:50,costLowerBoundCents:45,costGapBoundCents:5},
    adopted:{state:'feasible',costCents:50}}}`);
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-shared]').open"), false,
    'Shared charging details begin collapsed so the selected vehicle remains the main focus');
  assert.match(await evaluate("document.querySelector('[data-test-shared-summary]').textContent"), /Priority Charger 2.*overlapping draw observed/);
  await click('[data-test-shared-summary]'); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-shared]').open"), true, 'Polling preserves shared-detail disclosure');
  assert.match(await evaluate("document.querySelector('[data-test-shared-detail]').textContent"), /Charger 2 draw: 5.52 kW.*combined cost 50 cents.*Planner-reported/s);
  await click('[data-test-shared-summary]');

  // BMW's raw target may alternate independently of the setting the user has
  // verified in the car. Each distinct disagreement is acknowledged explicitly.
  await evaluate(`chargingFixture.observeTarget('run-1',100,'bmw-cardata',${now - 300000})`); await poll();
  await until("!document.querySelector('[data-test-target-value]').disabled");
  await typeField('[data-test-target-value]', '82.1');
  const unverifiedMutations = await evaluate('chargingFixture.mutations.length');
  await keyPress('Enter');
  assert.equal(await evaluate('chargingFixture.mutations.length'), unverifiedMutations,
    'A differing manual target requires the explicit actual-car verification checkbox');
  assert.equal(await evaluate("document.querySelector('[data-test-target-verified]').required"), true);
  const verificationLayout = await evaluate(`(() => {
    const label=document.querySelector('[data-test-target-verification]'),input=label.querySelector('input'),text=label.querySelector('span');
    return {label:{display:getComputedStyle(label).display,flexDirection:getComputedStyle(label).flexDirection},
      input:{height:getComputedStyle(input).height,minHeight:getComputedStyle(input).minHeight,width:getComputedStyle(input).width},
      rectangles:{input:input.getBoundingClientRect().toJSON(),text:text.getBoundingClientRect().toJSON()}};
  })()`);
  writeFileSync(join(artifacts,'target-verification-layout.json'),JSON.stringify(verificationLayout,null,2));
  assert.equal(verificationLayout.label.flexDirection, 'row', 'Verification checkbox and explanatory text share a row');
  assert.ok(verificationLayout.rectangles.input.height <= 24,
    'The verification checkbox remains a compact native square instead of inheriting text-field height');
  assert.match(await evaluate("document.querySelector('[data-test-target-reported]').textContent"), /100%.*BMW|BMW.*100%/i);
  assert.match(await evaluate("document.querySelector('[data-test-target-reported]').textContent"), /14:55|2:55/,
    'The conflicting raw report retains its original source clock');
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('[data-test-target-review]').scrollIntoView({block:'center'})`);
    assert.equal(await evaluate(`(() => {const label=document.querySelector('[data-test-target-verification]'),
      checkbox=label.querySelector('input').getBoundingClientRect(),text=label.querySelector('span').getBoundingClientRect();
      return getComputedStyle(label).flexDirection==='row' && checkbox.height<=24 && text.left>=checkbox.right && text.top<checkbox.bottom;})()`), true,
    'Verification stays beside its wrapping text in every viewport and theme');
    await fits('#charging-test-dialog'); await screenshot(`target-discrepancy-${width}-${theme}`, '#charging-test-dialog', {preserveScroll:true});
  }
  const beforeBmwVerification = await evaluate('chargingFixture.ordinaryCharging');
  await click('[data-test-target-verified]');
  await evaluate("document.querySelector('[data-test-target-value]').focus()"); await keyPress('Enter');
  await until("chargingFixture.runs[0].target.revision === 2 && document.querySelector('[data-test-target-review]').hidden");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1).body'), {
    id:'run-1',association:'charger1-fixture-association',sessionId:'session-fixture-1',targetRevision:1,nativeTargetSoc:82.1,
    verification:{reportedSoc:100,source:'bmw-cardata'},
  });
  assert.deepEqual(await evaluate('chargingFixture.ordinaryCharging'), beforeBmwVerification,
    'Explicitly verifying a manual target never rewrites any actual charging input or vehicle report');
  await evaluate(`chargingFixture.observeTarget('run-1',100,'bmw-cardata',${now - 240000})`); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), true,
    'A later clock for the same acknowledged raw target does not demand another confirmation');
  assert.match(await evaluate("document.querySelector('[data-test-target-reported]').textContent"), /100%/);
  assert.match(await evaluate("document.querySelector('[data-test-target-verification-status]').textContent"), /verified|reviewed/i);
  await evaluate(`chargingFixture.observeTarget('run-1',85,'bmw-cardata',${now - 180000})`); await poll();
  await until("!document.querySelector('[data-test-target-review]').hidden && !document.querySelector('[data-test-target-value]').disabled");
  await typeField('[data-test-target-value]', '82.1'); await click('[data-test-target-verified]');
  await evaluate("document.querySelector('[data-test-target-value]').focus()"); await keyPress('Enter');
  await until("chargingFixture.runs[0].target.revision === 3 && document.querySelector('[data-test-target-review]').hidden");
  assert.deepEqual(await evaluate('chargingFixture.runs[0].target.verifications.map(row => row.reportedSoc)'), [100,85],
    'Both independently reviewed raw target values are retained');
  await until("!document.querySelector('[data-test-target-edit]').disabled");
  await click('[data-test-target-edit]');
  await typeField('[data-test-target-value]', '83.5'); await click('[data-test-target-verified]');
  const beforeStaleEdit = await evaluate('chargingFixture.mutations.length');
  await evaluate(`(() => {const run=chargingFixture.runs[0];run.expectations.nativeTargetSoc=84.2;
    run.target.revision=4;run.target.history.push({targetSoc:84.2,confirmedAt:${now}});
    delete run.target.verifications;run.target.requiresConfirmation=true;})()`);
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-value]').value"), '83.5',
    'A target saved by another tab preserves this tab’s draft for review');
  assert.equal(await evaluate("document.querySelector('[data-test-target-stale]').hidden"), false);
  assert.match(await evaluate("document.querySelector('[data-test-target-discrepancy]').textContent"), /84\.2/);
  assert.equal(await evaluate("document.querySelector('[data-test-target-confirm]').disabled && document.querySelector('[data-test-target-verified]').disabled && !document.querySelector('[data-test-target-verified]').checked"), true,
    'A changed assessment revision clears verification and disables stale submission');
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('[data-test-target-stale]').scrollIntoView({block:'center'})`);
    await fits('#charging-test-dialog'); await screenshot(`target-stale-edit-${width}-${theme}`, '#charging-test-dialog', {preserveScroll:true});
  }
  await evaluate("document.querySelector('[data-test-target-value]').focus()"); await keyPress('Enter');
  assert.equal(await evaluate('chargingFixture.mutations.length'), beforeStaleEdit,
    'A stale draft cannot silently submit against the newer revision');
  await click('[data-test-target-refresh]');
  assert.equal(await evaluate("document.querySelector('[data-test-target-value]').value"), '84.2',
    'Explicit review loads the target saved by the other tab');
  await typeField('[data-test-target-value]', '82.1'); await click('[data-test-target-verified]');
  await evaluate("document.querySelector('[data-test-target-value]').focus()"); await keyPress('Enter');
  await until("chargingFixture.runs[0].target.revision === 5 && document.querySelector('[data-test-target-review]').hidden");
  assert.equal(await evaluate('chargingFixture.mutations.at(-1).body.targetRevision'), 4,
    'Only explicit refresh and renewed verification permit saving against the latest revision');
  assert.deepEqual(await evaluate('chargingFixture.runs[0].target.verifications.map(row => row.reportedSoc)'), [85],
    'Changing the saved target invalidates acknowledgements associated with the old target');
  await evaluate(`chargingFixture.observeTarget('run-1',100,'bmw-cardata',${now - 150000})`); await poll();
  await until("!document.querySelector('[data-test-target-value]').disabled");
  await click('[data-test-target-verified]');
  await evaluate("document.querySelector('[data-test-target-value]').focus()"); await keyPress('Enter');
  await until("chargingFixture.runs[0].target.revision === 6 && document.querySelector('[data-test-target-review]').hidden");
  await evaluate("sessionStorage.setItem('charging-browser-fixture',JSON.stringify(chargingFixture))");
  await send('Page.reload');
  await until("chargingFixture.poll && document.getElementById('charging-setup-tesla-state')?.textContent === 'Healthy · Sleeping'");
  await click('#charging-setup-bmw-test');
  for (const [index, reported] of [100,85,100,85].entries()) {
    await evaluate(`chargingFixture.observeTarget('run-1',${reported},'bmw-cardata',${now - 120000} + ${index} * 30000)`); await poll();
    assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), true,
      'Reviewed 100/85 reports remain accepted after browser reload and repeated fluctuations');
    assert.equal(await evaluate('chargingFixture.runs[0].expectations.nativeTargetSoc'), 82.1);
    assert.match(await evaluate("document.querySelector('[data-test-target-reported]').textContent"), new RegExp(`${reported}%`));
  }
  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('[data-test-target-reported]').scrollIntoView({block:'center'})`);
    await fits('#charging-test-dialog'); await screenshot(`target-verified-${width}-${theme}`, '#charging-test-dialog', {preserveScroll:true});
  }
  await evaluate(`chargingFixture.observeTarget('run-1',90,'bmw-cardata',${now})`); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), false,
    'A genuinely new raw target is not covered by a previous verification');
  await evaluate(`chargingFixture.observeTarget('run-1',100,'bmw-cardata',${now})`); await poll();
  assert.equal(await evaluate('chargingFixture.runs[0].target.requiresConfirmation'), false,
    'Returning to an acknowledged raw report clears the new-conflict requirement');
  await click('[data-test-target-dismiss]'); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), true,
    'A previously acknowledged report stays closed after dismissing the unused edit');

  // The same integrated field serves ordinary ready-by editing; editing a draft
  // and opening its chooser must never send a settings request.
  await keyPress('Escape');
  await evaluate('chargingFixture.readyBySession=true'); await poll();
  await evaluate(`for(let node=document.getElementById('charger1-device');node;node=node.parentElement)
    if(node.tagName==='DETAILS') node.open=true`);
  await until("!document.getElementById('charger1-setting-readyBy').disabled");
  const beforeReadyByEdit = await evaluate('chargingFixture.mutations.length');
  await typeField('#charger1-setting-readyBy', '07:43'); await poll();
  assert.equal(await evaluate("document.getElementById('charger1-setting-readyBy').value"), '07:43');
  await pointerClick('#charger1-setup-link'); await poll();
  assert.equal(await evaluate("document.getElementById('charger1-setting-readyBy').value"), '07:43',
    'Opening device setup and refreshing status preserves an unsaved session draft');
  assert.equal(await evaluate("document.getElementById('charger1-device').open"), true,
    'Setup navigation leaves the originating session card expanded');
  await pointerClick('#charger1-setting-readyBy-choose');
  await until("document.getElementById('charging-time-dialog')?.open");
  assert.equal(await evaluate("document.getElementById('charging-time-minute').value"), '43');
  await typeField('#charging-time-minute', '47'); await click('#charging-time-set');
  assert.equal(await evaluate("document.getElementById('charger1-setting-readyBy').value"), '07:47');
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await integratedTime('#charger1-setting-readyBy');
    await screenshot(`ready-by-${width}-${theme}`, '.charging-field:has(#charger1-setting-readyBy)');
  }
  assert.equal(await evaluate('chargingFixture.mutations.length'), beforeReadyByEdit,
    'Typing and choosing an ordinary ready-by draft never silently saves it');
  await evaluate('chargingFixture.readyBySession=false'); await poll();
  await click('#charging-setup-bmw-test');
  const mutationCount = await evaluate('chargingFixture.mutations.length');
  await click('[data-test-report]');
  await until("document.getElementById('charging-report-dialog').open");
  await pause(40);
  assert.equal(await evaluate('chargingFixture.mutations.length'), mutationCount, 'Session reports make no control requests');
  assert.equal(await evaluate("document.querySelector('.charging-report-result').dataset.state"), 'attention');
  assert.match(await evaluate("document.querySelector('.charging-report-current-findings').textContent"), /1 unresolved finding/);
  const reportFacts = await evaluate("document.querySelector('.charging-report-facts').textContent");
  assert.match(reportFacts, /Automatic charging off.*No controller charging schedule/);
  assert.match(reportFacts, /Actual vehicle battery charge is unconfirmed.*20% · configured assumption/);
  assert.match(reportFacts, /0 kW measured.*Charger status reports charging/);
  assert.match(reportFacts, /Earlier charging is not covered by this report/);
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = true");
  assert.equal(await evaluate(`(() => {
    const entries = [...document.querySelectorAll('.charging-report-timeline > li')];
    const compact = value => value.replace(/\\s+/g, ' ').trim();
    return entries.length > 0 && entries.every(row => {
      const detail = row.querySelector(':scope > details'), summary = detail?.querySelector(':scope > summary');
      return detail && summary && !detail.open && compact(row.innerText) === compact(summary.innerText);
    });
  })()`), true, 'Each report entry initially shows only its clickable timestamp and title');
  assert.doesNotMatch(await evaluate("document.querySelector('.charging-report-timeline').innerText"), /Requested target:|Charging periods unchanged|Event details|Measured|Received/);
  await evaluate(`(() => {
    const entry = [...document.querySelectorAll('.charging-report-timeline > li > details')]
      .find(row => row.textContent.includes('Requested target: 80% → 85%'));
    if (!entry) throw new Error('No compact target-change entry');
    entry.querySelector('summary').focus();
  })()`);
  await keyPress('Enter');
  assert.match(await evaluate("document.querySelector('.charging-report-timeline').innerText"), /Requested target: 80% → 85%.*Charging periods unchanged/s);
  assert.match(await evaluate("document.querySelector('.charging-report-timeline').textContent"), /No controller charging schedule/);
  assert.doesNotMatch(await evaluate("document.querySelector('.charging-report-timeline').textContent"), /Physical charging observed|Physical charging stopped|Plan updated/);
  assert.match(await evaluate("document.querySelector('.charging-report-timeline').textContent"), /Local OCPP.*Measured.*Received/);
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = false");
  await keyPress('Escape');
  await until("!document.getElementById('charging-report-dialog').open");
  await until("document.activeElement.id === 'charger1-session-report'");
  assert.equal(await evaluate('document.activeElement.id'), 'charger1-session-report');
  const expanded = await evaluate("document.getElementById('charger1-device-summary').parentElement.open");
  await click('#charger1-session-report'); await pause(40);
  assert.equal(await evaluate("document.getElementById('charger1-device-summary').parentElement.open"), expanded, 'Report button does not toggle charger details');
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  await click('[data-test-cancel]');
  await until("document.querySelector('[data-test-phase]').textContent === 'Assessment stopped early'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/cancel', body: { id: 'run-1', association: 'charger1-fixture-association' } });
  await keyPress('Escape');

  await evaluate("document.getElementById('charging-setup-tesla-details').open = true");
  await click('#charging-setup-tesla-test');
  await until("!document.querySelector('[name=vehicleId]').disabled");
  assert.equal(await evaluate("document.querySelector('[name=vehicleStartAt]').value"), '01:00',
    'Tesla can preload its reported next vehicle schedule without a charger association');
  await setFields({ vehicleId: 'tesla', chargerId: 'charger2', program: 'vehicle-schedule', soc: '40', nativeTargetSoc: '80',
    capacityKwh: '57', vehicleStartAt: '01:00', prepared: true });
  assert.equal(await evaluate("document.querySelector('[name=vehicleStartAt]').type"), 'text');
  assert.match(await evaluate("document.querySelector('[data-test-initial-date]').textContent"), /Europe\/Helsinki/,
    'A time-only vehicle schedule explains its resolved date and installation timezone');
  await until("!document.getElementById('charging-test-initial-time-choose').disabled");
  await typeField('[name=vehicleStartAt]', '01:00');
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}';document.querySelector('[data-test-start-label]').scrollIntoView({block:'center'})`);
    await integratedTime('[name=vehicleStartAt]'); await fits('#charging-test-dialog');
    await screenshot(`initial-schedule-${width}-${theme}`, '#charging-test-dialog', {preserveScroll:true});
    await pointerClick('#charging-test-initial-time-choose');
    await until("document.getElementById('charging-test-time-dialog')?.open");
    await fits('#charging-test-time-dialog'); await screenshot(`initial-time-picker-${width}-${theme}`, '#charging-test-time-dialog');
    await evaluate("globalThis.timePickerClosed = new Promise(resolve => document.getElementById('charging-test-time-dialog').addEventListener('close', () => resolve(true), {once:true})); true");
    await keyPress('Escape');
    await evaluate('timePickerClosed');
    await until("!document.getElementById('charging-test-time-dialog').open && document.activeElement.id === 'charging-test-initial-time-choose'");
  }
  await evaluate("document.querySelector('[name=vehicleStartAt]').focus()");
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40,modifiers:1});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40,modifiers:1});
  await until("document.getElementById('charging-test-time-dialog')?.open");
  assert.equal(await evaluate("document.getElementById('charging-test-time-hour').value"), '01');
  await evaluate("document.getElementById('charging-test-time-minute').value='05'");
  await click('#charging-test-time-set');
  assert.equal(await evaluate("document.querySelector('[name=vehicleStartAt]').value"), '01:05',
    'The initial schedule uses the shared charging time chooser');
  await setFields({ vehicleStartAt: '01:00', prepared: true });
  await until("!document.querySelector('[data-test-preview]').disabled");
  await click('[data-test-preview]'); await until("!document.querySelector('[data-test-arm]').disabled");
  const delayed = { chargerId: 'charger2', vehicleId: 'tesla', program: 'vehicle-schedule', association: 'charger2-fixture-association',
    soc: 40, nativeTargetSoc: 80, capacityKwh: 57, prepared: true, vehicleStartAt: Date.parse('2026-09-30T22:00:00Z') };
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/preview', body: delayed });
  await click('[data-test-arm]'); await until("document.querySelector('[data-test-phase]').textContent === 'Ready to plug in'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/start', body: delayed });
  await evaluate("Object.assign(chargingFixture.runs[0], {sessionId:'session-fixture-2',phase:'observing',recommendation:{state:'unavailable'}})");
  await poll();
  assert.equal(await evaluate("document.getElementById('charging-test-schedule-form').hidden && document.querySelector('[data-test-confirm]').disabled"), true,
    'Before a recommendation exists, the guide shows the recorded initial schedule without offering an unsupported adjustment');
  await evaluate(`Object.assign(chargingFixture.runs[0], { sessionId:'session-fixture-2', phase:'awaiting-vehicle-schedule',
    recommendation: { state:'available', startAt:${Date.parse('2026-09-30T22:30:00Z')}, message:'The observed production plan starts at 01:00. A vehicle start at 01:30 exercises delayed charging.' } })`);
  await poll(); await until("!document.querySelector('[data-test-timer]').hidden");
  await until("!document.querySelector('[data-test-confirm]').disabled");
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '01:30', 'A first recommendation fills the untouched adjustment field');
  assert.match(await evaluate("document.querySelector('[data-test-schedule-original]').textContent"), /01:00/);
  assert.match(await evaluate("document.querySelector('[data-test-schedule-current]').textContent"), /01:00/);
  assert.match(await evaluate("document.querySelector('[data-test-recommendation]').textContent"), /01:30/);
  await pointerClick('#charging-test-adjustment-time-choose');
  await until("document.getElementById('charging-test-time-dialog')?.open");
  await evaluate("document.getElementById('charging-test-time-minute').value='45'");
  await click('#charging-test-time-set');
  await evaluate("document.querySelector('[data-test-confirm-time]').focus()");
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '01:45', 'Schedule draft survives polling');
  await evaluate("document.querySelector('[data-test-confirm-time]').focus()");
  await keyPress('Enter');
  await until("document.querySelector('[data-test-schedule-receipt]').textContent.includes('01:45')");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1)'), { path: '/api/charging/tests/schedule', body: {
    id: 'run-2', association: 'charger2-fixture-association', sessionId: 'session-fixture-2', startAt: Date.parse('2026-09-30T22:45:00Z') } });
  assert.match(await evaluate("document.querySelector('[data-test-schedule-original]').textContent"), /01:00/,
    'Recording a new schedule preserves the original preparation time');
  assert.match(await evaluate("document.querySelector('[data-test-schedule-current]').textContent"), /01:45/,
    'Enter records the new schedule and immediately displays the saved value');
  assert.match(await evaluate("document.querySelector('[data-test-guidance]').textContent"), /unplug/i,
    'The active assessment explains unplugging as the normal finish');
  assert.match(await evaluate("document.querySelector('[data-test-cancel]').textContent"), /Stop assessment early/i);
  await keyPress('Escape'); await click('#charging-setup-tesla-test');
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '01:45',
    'Reopening uses the saved schedule instead of restoring the recommendation');
  await evaluate(`Object.assign(chargingFixture.runs[0].recommendation, {
    startAt:${Date.parse('2026-09-30T23:00:00Z')},
    message:'The controller revised its charging periods. This recommendation leaves estimated room for the vehicle target.' })`);
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '01:45',
    'A later plan recommendation never silently replaces a confirmed schedule');
  await evaluate("sessionStorage.setItem('charging-browser-fixture', JSON.stringify(chargingFixture))");
  await send('Page.reload');
  await until("chargingFixture.poll && document.getElementById('charging-setup-tesla-state')?.textContent === 'Healthy · Sleeping'");
  await click('#charging-setup-tesla-test');
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value"), '01:45',
    'A fresh browser page restores the server-recorded schedule, even when a newer recommendation exists');
  assert.match(await evaluate("document.querySelector('[data-test-schedule-receipt]').textContent"), /01:45/,
    'The recorded-value receipt survives reloading');
  await evaluate("document.querySelector('[data-test-confirm-time]').value='02:15'; document.querySelector('[data-test-confirm-time]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-test-confirm-time]').focus()");
  await keyPress('Enter');
  await until("document.querySelector('[data-test-schedule-receipt]').textContent.includes('02:15')");
  await until("!document.querySelector('[data-test-cancel]').disabled");
  assert.equal(await evaluate('chargingFixture.runs[0].schedule.history.length'), 2,
    'Further schedule adjustments retain both confirmations');
  await evaluate("chargingFixture.runs[0].recommendation.state='unavailable'"); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm-time]').value === '02:15' && document.querySelector('[data-test-confirm-time]').disabled && document.querySelector('[data-test-confirm]').disabled"), true,
    'When a recommendation becomes unavailable, the saved schedule stays visible and further adjustments are disabled');
  await evaluate("chargingFixture.runs[0].recommendation.state='available'");
  await evaluate(`(() => {
    const run = chargingFixture.runs[0], at = ${now};
    run.expectations.nativeTargetSoc = 67;
    Object.assign(run.target, {reportedSoc:85,reportedAt:at,source:'teslamate',requiresConfirmation:true,
      history:[{targetSoc:67,confirmedAt:at}]});
    run.milestones.vehicleTarget = {at,targetSoc:67,source:'teslamate'};
    run.milestones.deadline = {at,targetSoc:67,state:'target-observed-by-deadline'};
    chargingFixture.vehicleReadings.tesla = {
      soc:{value:67,available:true,measuredAt:at,receivedAt:at},
      minimumSoc:{value:85,available:true,measuredAt:at,receivedAt:at},
    };
  })()`);
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), false,
    'A different reported vehicle target asks the user to verify the assessment assumption');
  const targetMilestones = () => evaluate(`Object.fromEntries([...document.querySelectorAll('[data-test-milestones] dt')]
    .filter(node => ['Vehicle target reached','Ready-by outcome'].includes(node.textContent))
    .map(node => [node.textContent,node.nextElementSibling.textContent]))`);
  assert.deepEqual(await targetMilestones(), {
    'Vehicle target reached':'Current vehicle target unconfirmed', 'Ready-by outcome':'Current vehicle target unconfirmed',
  }, 'A guide assumption of 67% cannot show target/deadline success when the car independently reports 85% and its charge is 67%');
  assert.equal(await evaluate("document.querySelector('[data-test-phase]').textContent"), 'Following the charging session',
    'Reaching only the declared assumption never displays physical charging completion');
  await until("!document.querySelector('[data-test-target-value]').disabled");
  await evaluate("document.querySelector('[data-test-target-value]').value='84'; document.querySelector('[data-test-target-value]').dispatchEvent(new Event('input',{bubbles:true})); chargingFixture.runs[0].target.reportedAt += 60000");
  await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-target-value]').value"), '84',
    'A refreshed source timestamp never replaces a manually edited target reconciliation draft');
  const beforeTargetDeclaration = await evaluate('chargingFixture.ordinaryCharging');
  await evaluate("document.querySelector('[data-test-target-value]').value='85'; document.querySelector('[data-test-target-value]').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-test-target-value]').focus()");
  await keyPress('Enter');
  await until("chargingFixture.mutations.at(-1).path === '/api/charging/tests/target'");
  assert.deepEqual(await evaluate('chargingFixture.mutations.at(-1).body'), {
    id:'run-2',association:'charger2-fixture-association',sessionId:'session-fixture-2',targetRevision:1,nativeTargetSoc:85,
  }, 'Confirming an assumption uses the assessment revision and no ordinary charging settings');
  assert.equal(await evaluate('chargingFixture.runs[0].expectations.nativeTargetSoc'), 85);
  assert.equal(await evaluate('chargingFixture.runs[0].target.revision'), 2);
  await until("document.querySelector('[data-test-target-review]').hidden");
  assert.equal(await evaluate("document.querySelector('[data-test-target-review]').hidden"), true,
    'Recording the verified vehicle target clears the assessment discrepancy');
  assert.deepEqual(await targetMilestones(), {
    'Vehicle target reached':'Current vehicle target unconfirmed', 'Ready-by outcome':'Current vehicle target unconfirmed',
  }, 'After accepting 85%, old milestones recorded for 67% remain historical and cannot become success for the current target');
  assert.deepEqual(await evaluate('chargingFixture.ordinaryCharging'), beforeTargetDeclaration,
    'Recording a different assumed vehicle target leaves actual values, requests, plans, controls, vehicle identity and configuration unchanged');
  assert.match(await evaluate("document.querySelector('[data-test-target-receipt]').textContent"), /assessment target/i);
  assert.doesNotMatch(await evaluate("document.querySelector('[data-test-target-receipt]').textContent"), /applied.*session/i);

  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await fits('#charging-test-dialog'); await screenshot(`test-${width}-${theme}`, '#charging-test-dialog');
    await evaluate("document.querySelector('[data-test-adjustment-field]').scrollIntoView({block:'center'})");
    await integratedTime('[data-test-confirm-time]');
    await screenshot(`adjusted-schedule-${width}-${theme}`, '#charging-test-dialog', {preserveScroll:true});
    await keyPress('Escape');
    await evaluate("document.getElementById('charging-setup-details').open=true; document.getElementById('charging-setup-bmw-details').open=true; document.getElementById('charging-setup-tesla-details').open=true");
    await fits('#charging-setup-content'); await screenshot(`setup-${width}-${theme}`, '#charging-setup-details');
    await click('#charger1-session-report'); await pause(40);
    await fits('#charging-report-dialog'); await screenshot(`report-${width}-${theme}`, '#charging-report-dialog');
    await keyPress('Escape'); await click('#charging-setup-tesla-test');
  }
  await evaluate('chargingFixture.readOnly = true'); await poll();
  assert.equal(await evaluate("document.querySelector('[data-test-confirm]').disabled && document.querySelector('[data-test-cancel]').disabled"), true,
    'Read-only status disables guided assessment mutations');
  assert.match(await evaluate("document.querySelector('[data-test-message]').textContent"), /live controller/);
  await keyPress('Escape'); await click('#charging-setup-bmw-test');
  await click('[data-test-new]');
  assert.equal(await evaluate("document.querySelector('[data-test-preview]').disabled && document.querySelector('[data-test-arm]').disabled"), true);
  await keyPress('Escape');
  await evaluate(`Object.assign(chargingFixture.runs.find(run => run.id === 'run-2'), {
    phase:'finished',endReason:'unplugged-before-completion',endedAt:${now} })`);
  await poll(); await click('#charging-setup-tesla-test');
  assert.match(await evaluate("document.querySelector('[data-test-phase]').textContent"), /finished|ended|unplugged/i);
  assert.match(await evaluate("document.querySelector('[data-test-guidance]').textContent"), /unplugging.*completion.*not confirmed/i,
    'Unplugging ends the assessment while clearly retaining incomplete completion coverage');
  assert.equal(await evaluate("document.querySelector('[data-test-cancel]').hidden"), true,
    'An unplugged assessment requires no separate End action');
  await keyPress('Escape');
  await evaluate(`chargingFixture.archived=true; chargingFixture.report.endedAt=${now}; chargingFixture.connected=false;
    chargingFixture.report.outcome={state:'completion-unknown'}; chargingFixture.report.findings[0].resolvedAt=${now - 60000};
    chargingFixture.report.attentionCount=0; chargingFixture.report.recoveredCount=1; chargingFixture.report.behavior='explained'`);
  await poll(); await until("document.getElementById('charger1-session-report').textContent.includes('Recovered issue')");
  await click('#charger1-session-report'); await pause(40);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /Unplugged · completion unconfirmed/);
  assert.match(await evaluate("document.querySelector('.charging-report-current-findings').textContent"), /0 unresolved findings/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 1, 'Completed reports remain inspectable after unplugging');
  await evaluate("globalThis.reportDismissed = new Promise(resolve => document.getElementById('charging-report-dialog').addEventListener('close', () => resolve(true), {once:true})); true");
  await keyPress('Escape');
  await evaluate('reportDismissed');

  // Report inspection is scoped to the selected physical charger, including
  // empty and expired histories. All cases below remain read-only browser work.
  const inspectionMutations = await evaluate('chargingFixture.mutations.length');
  await until("!document.getElementById('charging-report-dialog').open && document.activeElement.id === 'charger1-session-report'");
  await evaluate("document.getElementById('charger2-session-report').focus()");
  await until("document.activeElement.id === 'charger2-session-report'");
  await keyPress('Enter');
  await until("document.getElementById('charging-report-dialog').open");
  await pause(40);
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 2/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 0,
    'An empty Charger 2 never offers Charger 1 reports');
  assert.equal(await evaluate("document.getElementById('charging-report-session').disabled"), true);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /No .*session|No .*report/i);
  await keyPress('Escape'); await until("document.activeElement.id === 'charger2-session-report'");
  await evaluate(`(() => {
    const f = chargingFixture, baseline = structuredClone(f.report);
    f.archived = false; f.report.endedAt = null; f.report.outcome = { state:'in-progress' };
    f.recent = [{ ...structuredClone(baseline), id:'charger1-previous', startedAt:${now - 172_800_000},
      endedAt:${now - 165_600_000}, vehicleId:'bmw', outcome:{state:'target-confirmed'} }];
    f.second = { current:{ ...structuredClone(baseline), id:'charger2-current', startedAt:${now - 10_800_000}, endedAt:null,
      vehicleId:'tesla', behavior:'expected', attentionCount:0, recoveredCount:0, findings:[], outcome:{state:'target-confirmed'},
      current:{ ...structuredClone(baseline.current), vehicleId:'tesla', vehicleSoc:true, reportedCharging:false,
        soc:{value:80, source:'teslamate', measuredAt:${now - 60_000}, receivedAt:${now - 30_000}} } },
      recent:[{ ...structuredClone(baseline), id:'charger2-previous', startedAt:${now - 86_400_000}, endedAt:${now - 79_200_000},
        vehicleId:'tesla', outcome:{state:'deadline-missed'} }] };
    globalThis.savedSecondReports = structuredClone(f.second);
  })()`);
  await poll();
  await click('#charger1-session-report'); await pause(40);
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 1/);
  assert.deepEqual(await evaluate("[...document.getElementById('charging-report-session').options].map(option => option.value)"),
    ['report-fixture', 'charger1-previous'], 'Charger 1 offers only its current and retained reports');
  await evaluate("document.getElementById('charging-report-session').value='charger1-previous'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))"); await pause(40);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /Target confirmed/);
  await evaluate('chargingFixture.report.evaluatedAt += 1000'); await poll();
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'charger1-previous');
  await evaluate('chargingFixture.recent = []'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /no longer retained/i);
  assert.notEqual(await evaluate("document.getElementById('charging-report-session').value"), 'report-fixture',
    'An expired selected report never silently switches to the current physical connection');
  await keyPress('Escape'); await click('#charger2-session-report'); await pause(40);
  assert.deepEqual(await evaluate("[...document.getElementById('charging-report-session').options].map(option => option.value)"),
    ['charger2-current', 'charger2-previous'], 'Charger 2 offers only its current and retained reports');
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'charger2-current');
  await evaluate("document.getElementById('charging-report-session').value='charger2-previous'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))"); await pause(40);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /not reached by ready-by/i);
  await keyPress('Escape'); await click('#charger2-session-report'); await pause(40);
  await evaluate('chargingFixture.second.current.evidenceStale = true'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /no longer current|incomplete/i);
  await evaluate('chargingFixture.diagnosticsAvailable = false'); await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /could not be saved|unavailable/i);
  await evaluate('chargingFixture.diagnosticsAvailable = true; chargingFixture.second = { current:null, recent:[] }');
  await poll(); await keyPress('Escape'); await click('#charger2-session-report'); await pause(40);
  assert.equal(await evaluate("document.getElementById('charging-report-session').options.length"), 0);
  assert.match(await evaluate("document.querySelector('.charging-report-result').textContent"), /No .*session|No .*report/i);
  await keyPress('Escape');

  // Meaningful rows are presented compactly, with the unchanged raw evidence
  // available only when the user opens a group or a planning snapshot.
  await evaluate(`(() => {
    const report = chargingFixture.report, N = ${now};
    const idle = { automaticEnabled:false, chargeNow:false, scheduleState:'none', identificationActive:false,
      expectation:'observe', pending:false, error:false, confirmed:false };
    for (let index = 0; index < 4; index++) {
      const at = N - 1200000 + index * 1000;
      report.timeline.push({ kind:'control', code:index % 2 ? 'off' : 'unavailable', at, physicalKnown:false, ...idle });
    }
    for (let index = 0; index < 4; index++) {
      const at = N - 600000 + index * 1000;
      report.timeline.push({ kind:'charger-status', code:index % 2 ? 'charger-reports-not-charging' : 'charger-reports-charging',
        at, source:'easee-ocpp', powerKw:0, measuredAt:at - 2000, receivedAt:at - 1000,
        powerMeasuredAt:at - 2000, powerReceivedAt:at - 1000, physicalKnown:true, ...idle });
    }
    const baseline = structuredClone(report.plans.at(-1));
    report.plans.push({ ...structuredClone(baseline), at:N - 2350000, reason:'session-settings', changes:[] },
      { ...structuredClone(baseline), at:N - 2300000, reason:'price-update', changes:[] });
    const before = Array.from({length:8}, (_, index) => ({ startAt:N + index * 900000,
      endAt:N + (index + 1) * 900000, priceCtPerKwh:3.1234 + index / 10 }));
    const after = before.map(row => ({...row, priceCtPerKwh:row.priceCtPerKwh + 1}));
    const rateChange = {field:'prices', before, after};
    report.plans.push({ ...structuredClone(baseline), at:N - 2200000, reason:'price-update', changes:[rateChange] });
    report.timeline.push({kind:'plan', code:'session-settings', at:N - 2350000, changes:[]},
      {kind:'plan', code:'price-update', at:N - 2300000, changes:[]},
      {kind:'plan', code:'price-update', at:N - 2200000, changes:[structuredClone(rateChange)]});
    report.timeline.sort((a,b) => a.at - b.at);
    globalThis.originalHistory = JSON.stringify({timeline:report.timeline, plans:report.plans});
  })()`);
  await poll(); await click('#charger1-session-report'); await pause(40);
  await evaluate("for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = true");
  assert.equal(await evaluate("document.querySelectorAll('.charging-report-snapshots > li[data-plan-key]').length"), 5,
    'Every planning snapshot is available under its one event');
  assert.equal(await evaluate("document.querySelectorAll('.charging-report-timeline > li[data-history-key]').length < chargingFixture.report.timeline.length"), true,
    'Repeated idle control and zero-power charger status events are combined');
  assert.equal(await evaluate("JSON.stringify({timeline:chargingFixture.report.timeline, plans:chargingFixture.report.plans}) === originalHistory"), true,
    'Grouping does not mutate the recorded timeline or planning inputs');
  await until("document.querySelector('.charging-report-timeline details[data-history-key]') !== null");
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.charging-report-timeline > li[data-history-key]')]
      .find(node => /2 brief charger-status changes/i.test(node.querySelector(':scope > details > summary')?.textContent));
    const group = row?.querySelector('details[data-history-key]');
    if (!group || group.open || group.querySelectorAll('.charging-report-raw > li').length !== 4)
      throw new Error('The paired zero-power status changes must preserve four collapsed original events');
    globalThis.savedHistoryGroup = group;
    globalThis.savedHistorySummary = group.querySelector('summary');
    savedHistorySummary.focus();
  })()`);
  await keyPress('Enter');
  assert.equal(await evaluate('savedHistoryGroup.open'), true, 'Enter opens grouped original evidence');
  await evaluate(`(() => {
    savedHistorySummary.scrollIntoView({block:'center'});
    globalThis.savedReportScroll = document.getElementById('charging-report-dialog').scrollTop;
    chargingFixture.report.evaluatedAt += 1000;
    chargingFixture.report.current.power.measuredAt += 1000;
  })()`);
  await poll();
  assert.equal(await evaluate("savedHistoryGroup.isConnected && savedHistoryGroup.open && document.activeElement === savedHistorySummary"), true,
    'Current-reading polls preserve the expanded group and exact focused summary node');
  assert.equal(await evaluate("Math.abs(document.getElementById('charging-report-dialog').scrollTop - savedReportScroll) <= 2"), true,
    'Current-reading polls do not reset report scroll');
  await evaluate(`chargingFixture.report.timeline.push({kind:'evidence',code:'observation-gap',at:${now + 1000}})`);
  await poll();
  assert.equal(await evaluate("savedHistoryGroup.isConnected && savedHistoryGroup.open && document.activeElement === savedHistorySummary && document.getElementById('charging-report-dialog').scrollTop > 0"), true,
    'A newly recorded group preserves the open evidence and focus without resetting to the top');
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.charging-report-timeline > li[data-history-key]')]
      .find(node => /4\\.1234/.test(node.textContent));
    const details = row?.querySelector('details');
    const rates = row?.querySelector('.charging-report-change details');
    if (!details || !rates) throw new Error('No planning snapshot with exact changed electricity rates');
    globalThis.savedPlanDetails = details;
    globalThis.savedPlanRates = rates;
    details.querySelector(':scope > summary').focus();
  })()`);
  await keyPress('Enter');
  assert.equal(await evaluate('savedPlanDetails.open'), true, 'Enter on a planning timestamp and title opens its details');
  await evaluate(`(() => {
    savedPlanRates.open = true;
    globalThis.savedPlanSummary = savedPlanRates.querySelector('summary');
    savedPlanSummary.focus();
    globalThis.savedPlanScroll = document.getElementById('charging-report-dialog').scrollTop;
    chargingFixture.report.evaluatedAt += 1000;
  })()`);
  await poll();
  assert.equal(await evaluate("savedPlanDetails.isConnected && savedPlanDetails.open && savedPlanRates.isConnected && savedPlanRates.open && document.activeElement === savedPlanSummary"), true,
    'Expanded planning and nested exact-rate evidence survive polling');
  assert.equal(await evaluate("Math.abs(document.getElementById('charging-report-dialog').scrollTop - savedPlanScroll) <= 2"), true);

  await evaluate(`(() => {
    const model = {state:'unknown',priority:null,feasible:null,costCents:null,costLowerBoundCents:null,
      costGapBoundCents:null,scheduleKey:null,allocationKey:null,chargers:[]};
    chargingFixture.report.timeline.push({kind:'evidence',code:'shared-charging-evidence',at:${now + 1500},shared:{
      at:${now + 1500},selectedPriority:'charger2',priority:'unknown',prioritySince:null,overlap:'unknown',
      peers:[{id:'charger1',connected:true,drawing:false,powerKw:0},{id:'charger2',connected:true,drawing:false,powerKw:0}],
      proposed:model,adopted:model,execution:{state:'unknown',expectedCurrentA:16,allocationAt:${now},
        lastExpectedCurrentA:16,lastAllocationAt:${now},reportedCurrentA:16,measuredAt:${now},expectationAt:${now},
        commandReady:false,commandBlockReason:'input-processing'}}});
  })()`);
  await poll();
  const allowanceText = await evaluate("document.querySelector('.charging-report-timeline').textContent");
  assert.match(allowanceText, /Shared charging evidence changed/);
  assert.match(allowanceText, /expected allowance 16 A/);
  assert.match(allowanceText, /Confirmed current setting 16 A/);
  assert.match(allowanceText, /waiting for input processing/);

  for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme='${theme}';
      for (const fold of document.querySelectorAll('#charging-report-dialog > details')) fold.open = true;
      for (const fold of document.querySelectorAll('.charging-report-timeline > li > details')) fold.open = false;`);
    await fits('#charging-report-dialog');
    await evaluate("document.querySelector('.charging-report-events').scrollIntoView({block:'start'})");
    await screenshot(`report-compact-${width}-${theme}`, '#charging-report-dialog', { preserveScroll: true });
    await evaluate(`
      for (const fold of document.querySelectorAll('#charging-report-dialog details')) fold.open = true;`);
    await fits('#charging-report-dialog');
    await screenshot(`report-expanded-${width}-${theme}`, '#charging-report-dialog');
    await evaluate("savedHistorySummary.scrollIntoView({block:'start'})");
    await screenshot(`report-timeline-${width}-${theme}`, '#charging-report-dialog', { preserveScroll: true });
    await evaluate("savedPlanRates.scrollIntoView({block:'start'})");
    await screenshot(`report-rates-${width}-${theme}`, '#charging-report-dialog', { preserveScroll: true });
    assert.equal(await evaluate(`(() => {
      const button = document.querySelector('.charging-report-heading button').getBoundingClientRect();
      const dialog = document.getElementById('charging-report-dialog').getBoundingClientRect();
      return button.top >= dialog.top && button.bottom <= dialog.bottom && button.height >= 44;
    })()`), true, 'The close action stays reachable while inspecting expanded history');
    assert.equal(await evaluate(`savedPlanSummary.getBoundingClientRect().top >=
      document.querySelector('.charging-report-heading').getBoundingClientRect().bottom`), true,
    'Scrolled-to rate details stay visible below the sticky heading');
  }
  await keyPress('Escape'); await until("document.activeElement.id === 'charger1-session-report'");

  // Switching between the report and its linked guided assessment must leave
  // keyboard focus in the only open modal and follow the exact recorded run,
  // even when a newer assessment of the same vehicle is already active.
  await evaluate(`(() => {
    const f = chargingFixture, completed = structuredClone(f.runs.find(run => run.id === 'run-1'));
    const connectedAt=${now - 86_400_000}, endedAt=${now - 79_200_000};
    f.recent = [{...structuredClone(f.report), id:'report-bmw-old', startedAt:${now - 86_400_000}, endedAt:${now - 79_200_000},
      outcome:{state:'target-confirmed'}}];
    Object.assign(completed, {id:'completed-bmw-test', phase:'completed', endReason:'vehicle-target-and-stop-observed',
      report:{id:'report-bmw-old'}, sessionId:'previous-bmw-session',createdAt:connectedAt-300000,
      expiresAt:connectedAt+86100000,connectedAt,endedAt,lastSeenAt:endedAt});
    completed.target.history = completed.target.history.map((row,index) => ({...row,
      confirmedAt:index===0 ? completed.createdAt : connectedAt+90000+index*1000}));
    completed.target.verifications = completed.target.verifications.map((row,index) => ({...row,
      reportedAt:connectedAt+90000+index*1000,confirmedAt:connectedAt+95000+index*1000}));
    completed.target.reportedAt = completed.target.verifications.find(row=>row.reportedSoc===completed.target.reportedSoc)?.reportedAt
      ?? connectedAt+90000;
    completed.milestones = {
      connection:{at:${now - 86_400_000},connectedAt:${now - 86_400_000}},
      identification:{at:${now - 86_340_000},source:'bmw-cardata'},
      initialPlan:{at:${now - 86_280_000}},
      identifiedPlanningInputs:{at:${now - 86_280_000}},
      chargingStarted:{at:${now - 86_220_000},source:'easee-ocpp'},
      vehicleTarget:{at:${now - 79_260_000},targetSoc:completed.expectations.nativeTargetSoc,source:'bmw-cardata'},
      completion:{at:${now - 79_200_000},source:'vehicle-target-and-charger-stop',state:'observed'},
    };
    const latest = {...structuredClone(completed), id:'newer-bmw-test', phase:'armed', report:null, sessionId:null,milestones:{},
      createdAt:${now},expiresAt:${now + 86400000},connectedAt:null,endedAt:null,lastSeenAt:${now}};
    f.runs.unshift(latest, completed);
  })()`);
  await poll();
  await click('#charger1-session-report'); await pause(40);
  await evaluate("document.getElementById('charging-report-session').value='report-bmw-old'; document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  await click('.charging-report-guided button');
  await until("document.getElementById('charging-test-dialog').open && !document.getElementById('charging-report-dialog').open");
  assert.equal(await evaluate("document.getElementById('charging-test-dialog').contains(document.activeElement)"), true);
  assert.equal(await evaluate("document.querySelector('[data-test-phase]').textContent"), 'Charging completion confirmed',
    'An old report opens its completed guided assessment, not a newer active test of the same vehicle');
  assert.equal(await evaluate(`['New physical connection','Expected vehicle identified','Physical charging started','Vehicle target reached','Vehicle completion observed']
    .every(title => {const term=[...document.querySelectorAll('[data-test-milestones] dt')].find(node=>node.textContent===title);
      return term && !/Not exercised|Not yet observed|unconfirmed/i.test(term.nextElementSibling.textContent);})`), true,
  'A completed fixture presents its independently observed connection, identification, charging, target and completion milestones');
  assert.match(await evaluate("document.querySelector('[data-test-guidance]').textContent"), /completed charging occasion/i,
    'A historical completed assessment describes its recorded outcome');
  assert.doesNotMatch(await evaluate("document.querySelector('[data-test-guidance]').textContent"), /unplug the car/i,
    'A historical completed assessment never tells the user to unplug a different current session');
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride', {width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await fits('#charging-test-dialog'); await screenshot(`completed-assessment-${width}-${theme}`, '#charging-test-dialog');
  }
  await click('[data-test-report]');
  await until("document.getElementById('charging-report-dialog').open && !document.getElementById('charging-test-dialog').open");
  assert.equal(await evaluate("document.getElementById('charging-report-dialog').contains(document.activeElement)"), true);
  assert.match(await evaluate("document.getElementById('charging-report-title').textContent"), /Charger 1/);
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"), 'report-bmw-old',
    'Returning from the completed assessment restores its exact retained report');
  await keyPress('Escape');

  // Report management changes only the selected historical report. The browser
  // fixture rejects family/read-only writes and keeps production facts separate.
  await evaluate(`(() => {
    const f=chargingFixture;
    f.archived=false; f.readOnly=false; f.family=false; f.report.endedAt=null; f.report.saved=false;
    f.recent.push({...structuredClone(f.report),id:'report-management',startedAt:${now - 86400000},endedAt:${now - 82000000},saved:false},
      {...structuredClone(f.report),id:'report-expired-saved',startedAt:${now - 33*86400000},endedAt:${now - 32*86400000},saved:true});
    f.report.timeline.push({kind:'finding-update',code:'control-unconfirmed',episode:1,at:${now + 2000},
      context:{errorCode:'invalid-plan',reasonCode:'invalid-plan',basis:'controller-plan'}});
  })()`);
  await poll();
  const productionBeforeReports = await evaluate('JSON.stringify(chargingFixture.ordinaryCharging)');
  await click('#charger1-session-report');
  await until("document.getElementById('charging-report-session').value==='report-fixture' && !document.getElementById('charging-report-save').disabled");
  assert.equal(await evaluate("document.getElementById('charging-report-delete').disabled"),true,'Active reports cannot be deleted');
  await pointerClick('#charging-report-save');
  await until("document.getElementById('charging-report-save').textContent==='Remove from saved' && !document.getElementById('charging-report-save').disabled");
  assert.deepEqual(await evaluate('chargingFixture.reportMutations.at(-1)'),{path:'/api/charging/reports/report-fixture/save',body:{saved:true}});
  await poll();
  assert.match(await evaluate("document.querySelector('.charging-report-message').textContent"),/saved permanently.*future events/i);
  await evaluate("document.getElementById('charging-report-collection').value='saved';document.getElementById('charging-report-collection').dispatchEvent(new Event('change'))");
  await until("document.getElementById('charging-report-session').options.length===2");
  assert.deepEqual(await evaluate("[...document.getElementById('charging-report-session').options].map(row=>row.value)"),['report-fixture','report-expired-saved']);
  await evaluate("document.getElementById('charging-report-collection').value='recent';document.getElementById('charging-report-collection').dispatchEvent(new Event('change'))");
  await until("document.getElementById('charging-report-session').value==='report-fixture' && !document.getElementById('charging-report-save').disabled");
  for (const filter of ['findings','plans','charging','control','vehicle','evidence','all']) {
    await evaluate(`document.getElementById('charging-report-filter').value=${JSON.stringify(filter)};document.getElementById('charging-report-filter').dispatchEvent(new Event('change'))`);
    await until(`chargingFixture.reportReads.at(-1)?.filter===${JSON.stringify(filter)}`); await pause(40);
    assert.equal(await evaluate("document.querySelector('.charging-report-events').querySelectorAll('h3').length"),1,'The selected history stays in one Events section');
    if(filter==='findings') assert.match(await evaluate("document.querySelector('.charging-report-timeline').textContent"),/invalid|rejected|could not be (?:used|applied)/i,
      'A changed invalid-plan cause remains visible in Findings');
    if(filter==='plans') assert.ok(await evaluate("document.querySelectorAll('.charging-report-snapshots > li').length"));
  }
  await pointerClick('#charging-report-save');
  await until("document.getElementById('charging-report-save').textContent==='Save report' && !document.getElementById('charging-report-save').disabled");
  assert.deepEqual(await evaluate('chargingFixture.reportMutations.at(-1).body'),{saved:false});
  await evaluate("document.getElementById('charging-report-session').value='report-management';document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  await until("!document.getElementById('charging-report-delete').disabled");
  await pointerClick('#charging-report-save');
  await until("document.getElementById('charging-report-save').textContent==='Remove from saved' && !document.getElementById('charging-report-save').disabled");
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await fits('#charging-report-dialog'); await screenshot(`report-saved-${width}-${theme}`,'#charging-report-dialog');
  }
  await evaluate('chargingFixture.family=true'); await poll();
  await until("document.getElementById('charging-report-save').disabled && document.getElementById('charging-report-delete').disabled");
  const familyReportMutations = await evaluate('chargingFixture.reportMutations.length');
  await click('#charging-report-save'); await click('#charging-report-delete');
  assert.equal(await evaluate('chargingFixture.reportMutations.length'),familyReportMutations,'Family report browsing cannot change saved history');
  await evaluate('chargingFixture.family=false'); await poll();
  await until("!document.getElementById('charging-report-delete').disabled");
  await pointerClick('#charging-report-delete');
  await until("!document.querySelector('.charging-report-confirm').hidden");
  assert.match(await evaluate("document.querySelector('.charging-report-confirm').textContent"),/permanently.*Energy history is kept/i);
  await click('.charging-report-confirm button:last-child');
  assert.equal(await evaluate('chargingFixture.reportMutations.length'),familyReportMutations,'Cancelling deletion keeps the report');
  await pointerClick('#charging-report-delete'); await click('.charging-report-confirm button');
  await until("document.querySelector('.charging-report-result').textContent.includes('no longer retained')");
  assert.deepEqual(await evaluate('chargingFixture.reportMutations.at(-1)'),{path:'/api/charging/reports/report-management/delete',body:{}});
  assert.equal(await evaluate("document.getElementById('charging-report-session').value"),'report-management','Deleting the selected report never opens another connection');
  await evaluate("document.getElementById('charging-report-session').value='report-expired-saved';document.getElementById('charging-report-session').dispatchEvent(new Event('change'))");
  await until("document.getElementById('charging-report-save').textContent==='Remove from saved' && !document.getElementById('charging-report-save').disabled");
  await pointerClick('#charging-report-save');
  await until("!document.querySelector('.charging-report-confirm').hidden");
  assert.match(await evaluate("document.querySelector('.charging-report-confirm').textContent"),/past the retention period.*delete.*immediately/i);
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    await fits('#charging-report-dialog'); await screenshot(`report-expiry-warning-${width}-${theme}`,'#charging-report-dialog');
  }
  await click('.charging-report-confirm button');
  await until("document.querySelector('.charging-report-result').textContent.includes('no longer retained')");
  assert.deepEqual(await evaluate('chargingFixture.reportMutations.at(-1)'),{path:'/api/charging/reports/report-expired-saved/save',body:{saved:false}});
  assert.equal(await evaluate('JSON.stringify(chargingFixture.ordinaryCharging)'),productionBeforeReports,
    'Saving, un-saving and deleting reports do not change production inputs, identity, schedules or charger control');
  await keyPress('Escape');

  // A confirmed current setting does not identify Tesla. Exercise the actual
  // card while its temporary setting is applied, restored and uncertain,
  // including the remaining restoration obligation after physical unplugging.
  const currentTestMutations = await evaluate('chargingFixture.mutations.length');
  await evaluate(`chargingFixture.currentTest = {
    id:'synthetic-browser-current-test',connectedAt:${now - 60000},sessionId:'synthetic-current-session',
    phase:'applying',startedAt:${now - 10000},expiresAt:${now + 80000},confirmedAt:null,
    originalCurrentA:16,appliedCurrentA:6,permissionAt:${now - 12000},restoreCurrentA:null,pending:null
  }; chargingFixture.currentTestConnected=true`);
  await poll();
  await evaluate(`for(let node=document.getElementById('charger2-identification');node;node=node.parentElement)
    if(node.tagName==='DETAILS') node.open=true`);
  assert.equal(await evaluate("document.getElementById('charger2-identification-state').textContent"), 'Confirming');
  assert.match(await evaluate("document.getElementById('charger2-identification-status').textContent"), /temporary 6 A.*confirmation is pending/);
  assert.equal(await evaluate("document.getElementById('charger2-identify').disabled"), true);
  for (const width of [320,390,1440]) for (const theme of ['light','dark']) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    for (const phase of ['active','restoring','uncertain']) {
      await evaluate(`Object.assign(chargingFixture.currentTest,{phase:'${phase}',confirmedAt:${now - 5000},
        restoreCurrentA:${phase === 'active' ? 'null' : '16'}}); chargingFixture.currentTestConnected=${phase === 'active'}`);
      await poll();
      const state = await evaluate("document.getElementById('charger2-identification-state').textContent");
      const detail = await evaluate("document.getElementById('charger2-identification-status').textContent");
      if (phase === 'active') {
        assert.equal(state,'Checking');
        assert.match(detail,/confirmed a temporary 6 A current limit.*fresh measured draw.*matching Tesla readings.*restored afterward/);
        assert.doesNotMatch(await evaluate("document.getElementById('charger2-vehicle').textContent"),/Tesla identified/);
      } else if (phase === 'restoring') {
        assert.equal(state,'Recovery pending');
        assert.match(detail,/awaiting restoration to 16 A.*confirmation is still required.*newer external current instructions/);
      } else {
        assert.equal(state,'Review required');
        assert.match(detail,/outcome.*unknown.*actual current setting.*record remains pending/);
        assert.doesNotMatch(detail,/controller retries/);
      }
      assert.equal(await evaluate("document.getElementById('charger2-identify').disabled"),true,
        'Another identification attempt cannot hide or replace an unresolved current change');
      await fits('#charger2-device'); await fits('#charger2-identification');
      await screenshot(`identification-current-${phase}-${width}-${theme}`,'#charger2-identification',{viewport:true});
    }
  }
  await evaluate("chargingFixture.currentTest.phase='restored'"); await poll();
  assert.equal(await evaluate("document.getElementById('charger2-identification-state').textContent"),'Not connected');
  assert.doesNotMatch(await evaluate("document.getElementById('charger2-identification-status').textContent"),/restoration|unknown/);
  assert.equal(await evaluate('chargingFixture.mutations.length'),currentTestMutations,
    'Inspecting current identification and recovery never sends a charger instruction');
  await evaluate('chargingFixture.currentTest=null'); await poll();

  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("for (const fold of document.querySelectorAll('#charging-setup-bmw-details details')) fold.open = true");
  await fits('#charging-setup-content'); await screenshot('setup-descriptors-320', '#charging-setup-details');
  assert.equal(await evaluate("chargingFixture.mutations.every(row => row.path.startsWith('/api/charging/tests/'))"), true,
    'No tested guide action calls a charger settings or command endpoint');
  assert.equal(await evaluate('chargingFixture.declarationChecks.length === chargingFixture.mutations.length && chargingFixture.declarationChecks.every(row => row.unchanged)'), true,
    'Every preparation, arm, schedule, target and cancellation declaration preserves ordinary charging status and configuration');
  assert.equal(await evaluate('chargingFixture.mutations.length'), inspectionMutations, 'All report history inspection remains read-only');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'charging-browser-smoke-passed', artifacts, checks: [
    'shared-device-card-style', 'reported-firmware-source-clock-and-unknown', 'local-documentation-destinations',
    'keyboard-session-to-device-setup-navigation', 'setup-disclosure-and-focus-survive-poll', 'short-viewport-expanded-setup',
    'keyboard-disclosures-and-Escape-focus', 'vehicle-stats-without-charger', 'missing-stats-and-capacity-defaults',
    'precise-preparation-errors-and-full-decimal-capacity', 'manual-values-independent-of-vehicle-readings',
    'explicit-different-target-verification-persists-through-reload-and-100-85-flaps', 'raw-target-and-source-clock-remain-visible',
    'stale-target-draft-needs-explicit-reload-and-new-verification', 'compact-verification-checkbox-alignment',
    'single-assessment-target-reconciliation', 'lower-assumption-never-shows-real-target-success',
    'assessment-declarations-preserve-ordinary-charging', 'target-draft-preserved-through-source-refresh',
    'app-dropdowns-and-integrated-time-picker', 'keyboard-typing-and-inset-picker-for-ready-by-initial-and-adjusted-times',
    'draft-preservation-through-status-polls', 'normal-and-delayed-action-payloads',
    'time-only-schedules-in-installation-timezone', 'original-current-and-recommended-schedules', 'Enter-schedule-receipt',
    'confirmed-schedule-survives-reopen-page-reload-and-new-recommendation', 'unavailable-recommendation-gating', 'unplug-finish-and-incomplete-coverage',
    'passive-report-no-mutations', 'read-only-controls', 'retained-report-and-recovered-issue',
    'automatic-off-no-controller-schedule', 'unidentified-fallback-battery-input', 'partial-observation-history', 'semantic-input-deltas', 'measured-zero-distinct-from-charger-status',
    'charger-scoped-current-and-retained-reports', 'empty-charger-does-not-borrow-peer-history', 'expired-selected-report', 'stale-and-unavailable-report-states',
    'grouped-zero-power-status-and-idle-control', 'compact-timestamp-title-entry-disclosures', 'all-planning-snapshots-under-one-event', 'expanded-history-focus-and-scroll-during-polls',
    'all-seven-event-filters-and-material-finding-cause', 'active-and-completed-report-saving', 'saved-session-selector',
    'family-report-management-disabled', 'explicit-saved-report-deletion-and-cancel', 'expired-unsave-confirmation', 'report-actions-preserve-production-charging',
    'modal-switching-focus-and-exact-linked-run', 'long-expanded-details-fit-all-viewports', 'sticky-heading-keeps-history-and-close-action-visible',
    'minimum-current-setting-distinct-from-Tesla-evidence', 'current-restoration-after-unplug', 'uncertain-current-review-without-false-retry-promise',
    '320-390-1440-light-dark-layouts' ] }));
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
