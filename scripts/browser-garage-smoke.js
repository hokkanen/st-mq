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
  const keyPress = async key => {
    const code = key === 'Enter' ? 'Enter' : 'Space', virtualKey = key === 'Enter' ? 13 : 32;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: virtualKey, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Exercise the real status-render path without waiting for the next 15-second poll.
  // Response edits are confined to this disposable page and synthetic server.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const scheduleInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000) globalThis.refreshLearningSmokeStatus = () => callback(...args);
      return scheduleInterval(callback, delay, ...args);
    };
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options) => {
      const response = await originalFetch(input, options);
      if (new URL(input.url ?? String(input), location.href).pathname !== '/api/status'
        || (!globalThis.learningSmokeValues && !globalThis.garageBudgetSmokeState && !globalThis.chargingSmokeValues)) return response;
      const status = await response.json();
      if (globalThis.learningSmokeValues) {
        const missing = globalThis.learningSmokeValues === 'missing';
        status.learning.metrics = { ...status.learning.metrics, profit: { value: 0, count: missing ? 0 : 1 } };
        status.learning.adaptive.model.parameters.lossPerHour = missing ? null : 0;
        for (const location of ['rear', 'front'])
          status.garage.observations[location] = { ...status.garage.observations[location], value: missing ? null : 0 };
        status.garage.learning.state.coreC = missing ? null : 0;
        status.garage.learning.state.differenceC = missing ? null : 0;
        status.garage.learning.coefficients.rear.find(row => row.name === 'lossPerHour').value = missing ? null : 0;
      }
      if (globalThis.garageBudgetSmokeState) {
        const state = globalThis.garageBudgetSmokeState, approved = state !== 'unapproved';
        status.garage.settings.protection = { ...status.garage.settings.protection, approved, budgetDegreeMinutes: 90 };
        status.garage.protection = { ...status.garage.protection, approved, locations: {
          rear: { degreeMinutes: 18, remainingDegreeMinutes: 72, fresh: true, uncertain: false, reason: null },
          front: { degreeMinutes: state === 'exhausted' ? 90 : 63,
            remainingDegreeMinutes: state === 'exhausted' ? 0 : 27,
            fresh: state !== 'stale', uncertain: state === 'uncertain',
            reason: state === 'exhausted' ? 'exposure-exhausted' : null },
        } };
      }
      if (globalThis.chargingSmokeValues) {
        const state = globalThis.chargingSmokeValues, manual = state === 'manual', controlled = ['manual', 'periods', 'paused', 'problem'].includes(state);
        const charger = status.charging.chargers.find(item => item.id === (controlled ? 'charger1' : 'charger2'));
        const observation = value => ({ value, source: 'teslamate', available: true, measuredAt: null, receivedAt: status.now });
        charger.values.soc = { ...observation(62), measuredAt: status.now - 4 * 86400_000 };
        charger.values.minimumSoc = observation(85);
        charger.values.connected = observation(state !== 'disconnected');
        charger.values.scheduledStartAt = observation(status.now + 2 * 3600_000);
        charger.values.charging = observation(globalThis.chargingSmokeValues === 'charging');
        charger.values.powerKw = observation(8.2);
        charger.requiredGridKwh = 15; charger.progress = null;
        if (manual) {
          charger.settings.enabled = true;
          charger.control = { phase: 'yielded', manual: { kind: 'window', startsAt: status.now + 2 * 3600_000,
            resumeAt: status.now + 15 * 3600_000, windowEndAt: status.now + 17 * 3600_000, detectedAt: status.now - 3600_000, repeating: true } };
          charger.values.scheduledEndAt = observation(status.now + 17 * 3600_000);
          charger.telemetry = { scheduledEndKind: 'scheduled-stop' };
          charger.plan = { startAt: status.now + 3 * 3600_000, deadlineAt: status.now + 15 * 3600_000 };
        } else if (controlled) {
          charger.settings.enabled = true;
          charger.values.maximumCurrentA = observation(16); charger.values.availableCurrentA = observation(16);
          const periods = [{ startAt: status.now + (state === 'paused' ? -2 : 2) * 3600_000,
            endAt: status.now + (state === 'paused' ? -1 : 3) * 3600_000 }, { startAt: status.now + 5 * 3600_000, endAt: null }];
          charger.plan = { startAt: periods[0].startAt, periods, deadlineAt: status.now + 15 * 3600_000, costCents: 125 };
          charger.control = { phase: state === 'paused' ? 'paused' : 'waiting', owned: { startAt: state === 'paused' ? periods[1].startAt : periods[0].startAt },
            execution: { periods, deadlineAt: charger.plan.deadlineAt } };
          if (state === 'problem') {
            charger.control.phase = 'unavailable'; charger.control.errorCode = 'readback-failed';
            charger.control.reason = 'Easee did not confirm the update. The last confirmed schedule may still be active; another reading will be requested.';
            charger.plan = { ...charger.plan, startAt: status.now + 3 * 3600_000, periods: [{ startAt: status.now + 3 * 3600_000, endAt: null }] };
          }
        }
      }
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}` });
  await until("document.getElementById('history')?.dataset.ready === 'true'");
  assert.equal(await evaluate("document.getElementById('error').hidden"), true);
  await until("document.getElementById('charger1-setting-capacityKwh')?.disabled === false");
  assert.deepEqual(await evaluate("['home-heat-pump-title','garage-title'].map(id=>document.getElementById(id).textContent)"), ['Home', 'Garage']);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#charging-devices > .equipment-device')].map(node=>node.id)"), ['charger1-device', 'charger2-device']);
  assert.deepEqual(await evaluate("['charger1-setting-minimumSoc','charger1-setting-readyBy','charger1-setting-capacityKwh','charger2-setting-capacityKwh'].map(id=>document.getElementById(id).value)"), ['80', '06:00', '74', '57']);
  assert.equal(await evaluate("document.getElementById('charger1-setting-manualSoc').value"), '20');
  assert.equal(await evaluate("document.getElementById('charger1-enabled').getAttribute('aria-checked')"), 'false');
  assert.equal(await evaluate("document.getElementById('charger1-setting-readyBy').disabled"), false);
  assert.equal(await evaluate("document.getElementById('charger2-setting-readyBy').disabled"), true);
  assert.equal(await evaluate("document.getElementById('charger2-enabled').disabled"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('.charging-settings')].some(fold=>fold.open)"), false);
  assert.equal(await evaluate("document.getElementById('charging-installation-details')"), null);
  assert.equal(await evaluate("document.querySelector('.charging-secondary, .charging-soc-form')"), null);
  await evaluate("document.getElementById('garage-equipment-details').open=true; true");
  for (const [charger, value] of [[1, '76'], [2, '59']]) {
    await evaluate(`(() => { document.getElementById('charger${charger}-settings-details').open=true;
      const input=document.getElementById('charger${charger}-setting-capacityKwh'); input.value='${value}';
      input.dispatchEvent(new Event('input')); document.getElementById('charger${charger}-settings-form').requestSubmit(); })()`);
    await until(`document.getElementById('charger${charger}-settings-message').textContent === 'Settings saved.'`);
  }
  await evaluate("(() => { const field=document.getElementById('charger1-setting-manualSoc'); field.value='43'; field.dispatchEvent(new Event('input')); document.getElementById('charger1-settings-form').requestSubmit(); })()");
  await until("document.getElementById('charger1-soc').textContent==='43 %'");
  await send('Page.reload');
  await until("document.getElementById('charger1-setting-capacityKwh')?.disabled === false");
  assert.deepEqual(await evaluate("['charger1-setting-capacityKwh','charger2-setting-capacityKwh'].map(id=>document.getElementById(id).value)"), ['76', '59']);
  assert.equal(await evaluate("document.getElementById('charger1-setting-manualSoc').value"), '43');
  assert.equal(await evaluate("document.getElementById('charger1-soc').textContent"), '43 %');
  assert.equal(await evaluate("document.getElementById('charger1-sources').textContent"), 'Both: Manual fallback');
  assert.equal(await evaluate("document.getElementById('charger1-overview').hidden"), true);
  await evaluate("document.getElementById('garage-equipment-details').open=true; document.getElementById('charger1-settings-details').open=true");
  const secondChargerNode = await evaluate("window.originalChargingSmokeNode=document.getElementById('charger2-device'); true");
  assert(secondChargerNode);
  await evaluate("globalThis.chargingSmokeValues='scheduled'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-soc').textContent==='62 %'");
  assert.equal(await evaluate("document.getElementById('charger2-setting-minimumSoc').value"), '85');
  assert.equal(await evaluate("document.getElementById('charger2-setting-minimumSoc').disabled"), true);
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').value"), '62');
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').disabled"), true);
  assert.match(await evaluate("document.getElementById('charger2-event').textContent"), /^Scheduled /);
  assert.equal(await evaluate("document.getElementById('charger2-device')===window.originalChargingSmokeNode"), true);
  await evaluate("globalThis.chargingSmokeValues='charging'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-state').textContent==='Charging'");
  assert.match(await evaluate("document.getElementById('charger2-event').textContent"), /^8.2 kW now/);
  await evaluate("globalThis.chargingSmokeValues='manual'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger1-state').textContent==='Manual schedule'");
  assert.match(await evaluate("document.getElementById('charger1-event').textContent"), /^Manual window /);
  assert.doesNotMatch(await evaluate("document.getElementById('charger1-readings').textContent"), /Ready by|start|window|resumes|stopping/i);
  assert.equal(await evaluate("document.getElementById('charger1-resume').hidden"), false);
  assert.match(await evaluate("document.getElementById('charger1-priority').textContent"), /Automatic control resumes .*ready-by boundary/);
  assert.equal(await evaluate("document.getElementById('charger1-deadline').hidden"), true);
  for (const [state, expected] of [['periods', 'Scheduled'], ['paused', 'Paused between periods'], ['problem', 'Update unconfirmed']]) {
    await evaluate(`globalThis.chargingSmokeValues='${state}'; globalThis.refreshLearningSmokeStatus()`);
    await until(`document.getElementById('charger1-state').textContent==='${expected}'`);
    assert.equal(await evaluate("document.getElementById('charger1-periods').children.length"), 4);
    assert.equal(await evaluate("document.getElementById('charger1-period-count').textContent"), '2 charging periods');
    assert.equal(await evaluate("document.getElementById('charger1-reading-time').hidden"), false);
    assert.match(await evaluate("document.getElementById('charger1-readings').textContent"), /Last reported Equalizer allowance16 A/);
    assert.match(await evaluate("document.getElementById('charger1-explanations').textContent"), /service and the Easee cloud/);
  }
  assert.match(await evaluate("document.getElementById('charger1-event').textContent"), /^Last confirmed start/);
  assert.match(await evaluate("document.getElementById('charger1-problem').textContent"), /did not confirm.*last confirmed schedule.*another reading/);
  await evaluate("globalThis.chargingSmokeValues='disconnected'; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-state').textContent==='Not connected'");
  assert.equal(await evaluate("document.getElementById('charger2-overview').hidden"), true);
  assert.equal(await evaluate("document.getElementById('charger2-reading-time').hidden"), true);
  await evaluate("globalThis.chargingSmokeValues=null; globalThis.refreshLearningSmokeStatus()");
  await until("document.getElementById('charger2-setting-minimumSoc').disabled===false");
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').value"), '20');
  assert.equal(await evaluate("document.getElementById('charger2-setting-manualSoc').disabled"), false);
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
  assert.equal(await evaluate("document.getElementById('garage-settings-details').open || document.getElementById('garage-recovery-details').open"), false,
    'Garage settings and recovery explanations start closed');
  assert.equal(await evaluate("document.querySelector('#garage-equipment-details > summary').textContent.includes('Freezing protection')"), false,
    'Garage overview shows the current cold budget instead of repeating configured protection values');
  assert.equal(await evaluate("document.querySelector('[data-scope=home]').getAttribute('aria-pressed')"), 'true');
  await evaluate("document.getElementById('timing-details').open=true; document.querySelector('[data-scope=garage]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /-€1.00.*Provisional/);
  await evaluate("document.querySelector('[data-scope=total]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /€2.00/);
  await evaluate("document.querySelector('[data-mode=timing]').click()");
  assert.match(await evaluate("document.querySelector('.timing-device[data-device=heatPump]').textContent"), /Timing cost saving/);
  await evaluate("document.querySelector('[data-scope=home]').click(); document.querySelector('[data-mode=model]').click()");
  const learningSections = [
    ['learning-metrics', 'home-outcomes'], ['model-inputs-content', 'home-inputs'],
    ['model-coefficients-content', 'home-coefficients'], ['garage-learning-outcomes', 'garage-outcomes'],
    ['garage-learning-inputs', 'garage-inputs'], ['garage-learning-coefficients', 'garage-coefficients'],
  ];
  for (const [id, name] of learningSections) {
    assert.equal(await evaluate(`(() => {
      const root = document.getElementById('${id}'), section = root.closest('.learning-section');
      return Boolean(section?.querySelector(':scope > summary > .learning-section-title')
        && section.querySelector(':scope > summary > .learning-section-kind')
        && section.querySelector(':scope > .learning-section-body')?.contains(root));
    })()`), true, `${name} uses the shared section structure`);
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#${id} > details.learning-entry')];
      return rows.length > 0 && rows.every(row => row.dataset.learningKey
        && row.querySelector(':scope > summary .learning-entry-title')?.textContent.trim()
        && row.querySelector(':scope > summary .learning-entry-value')?.textContent.trim()
        && row.querySelector(':scope > .learning-entry-body'));
    })()`), true, `${name} uses named, expandable learning rows`);
    await evaluate(`(() => {
      const row = document.querySelector('#${id} > details.learning-entry'); row.open = false;
      for (let parent = row.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      row.querySelector('summary').focus();
    })()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry').open`), true,
      `${name} row opens with Enter`);
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry > .learning-entry-body').checkVisibility()`), true,
      `${name} explanation becomes visible`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.querySelector('#${id} > details.learning-entry').open`), false,
      `${name} row closes with Space`);
    await evaluate(`(() => {
      const section = document.getElementById('${id}').closest('.learning-section');
      section.querySelector(':scope > summary').focus();
    })()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${id}').closest('.learning-section').open`), false,
      `${name} section closes with Enter`);
    await keyPress(' ');
    assert.equal(await evaluate(`document.getElementById('${id}').closest('.learning-section').open`), true,
      `${name} section opens with Space`);
  }
  // Every list keeps its row mounted across polling, including Home's static input controls.
  for (const [id, name] of learningSections) {
    await evaluate(`(() => {
      const row = document.querySelector('#${id} > details.learning-entry');
      globalThis.learningSmokeRow = row; row.open = true;
      for (let parent = row.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      row.querySelector('summary').focus();
    })()`);
    await evaluate('globalThis.refreshLearningSmokeStatus()');
    assert.equal(await evaluate(`globalThis.learningSmokeRow === document.querySelector('#${id} > details.learning-entry')
      && globalThis.learningSmokeRow.open
      && document.activeElement === globalThis.learningSmokeRow.querySelector('summary')`), true,
    `${name} preserves the row, open explanation and keyboard focus during status refresh`);
  }
  assert.equal(await evaluate("document.getElementById('sensor-change-form').closest('.learning-entry-body')?.parentElement.dataset.modelInput"),
    'model_indoor_temperature', 'Indoor sensor maintenance stays inside its model input explanation');
  assert.equal(await evaluate("document.getElementById('outdoor-sensor-change-form').closest('.learning-entry-body')?.parentElement.dataset.modelInput"),
    'model_outdoor_temperature', 'Outdoor sensor maintenance stays inside its model input explanation');
  const valueCases = [
    ['#learning-metrics [data-learning-key=profit]', /^0[.,]00 €/],
    ['#model-coefficients-content [data-learning-key=lossPerHour]', /^0[.,]0+ 1\/h$/],
    ['#garage-learning-inputs [data-learning-key=rear-air-temperature]', /^0 °C(?: · stale)?$/],
    ['#garage-learning-inputs [data-learning-key=front-rear-difference]', /^0 °C$/],
    ['#garage-learning-coefficients [data-learning-key=rear-heat-loss]', /^0 1\/h$/],
  ];
  await evaluate(`(() => {
    globalThis.learningSmokeValueRows = ${JSON.stringify(valueCases.map(([selector]) => selector))}.map(selector => {
      const row = document.querySelector(selector); row.open = true; return row;
    });
    const row = globalThis.learningSmokeValueRows.at(-1);
    for (let parent = row.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    row.querySelector('summary').focus();
  })()`);
  for (const mode of ['zero', 'missing']) {
    await evaluate(`globalThis.learningSmokeValues = '${mode}'; globalThis.refreshLearningSmokeStatus()`);
    assert.equal(await evaluate(`globalThis.learningSmokeValueRows.every(row => row.isConnected && row.open)
      && document.activeElement === globalThis.learningSmokeValueRows.at(-1).querySelector('summary')`), true,
      `${mode} status values update mounted rows without closing explanations or losing focus`);
    for (const [selector, zero] of valueCases) {
      const value = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.querySelector('.learning-entry-value').textContent`);
      assert.match(value, mode === 'zero' ? zero : /Unavailable|Not available yet/,
        `${selector} distinguishes an observed zero from unavailable evidence`);
    }
  }
  await evaluate('globalThis.learningSmokeValues = null; globalThis.refreshLearningSmokeStatus()');

  await evaluate(`(() => {
    const settings = document.getElementById('garage-settings-details');
    for (let parent = settings; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    settings.querySelector(':scope > summary').focus();
  })()`);
  for (const id of ['garage-heating-settings', 'garage-protection-settings', 'garage-recovery-settings']) {
    assert.equal(await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#${id} > .garage-setting')];
      return rows.length > 0 && rows.every(row => row.querySelector(':scope > dt small')?.textContent.trim()
        && row.querySelector(':scope > dd')?.textContent.trim()
        && row.querySelector(':scope > dd').children.length === 0);
    })()`), true, `${id} puts setting explanations beside plain values`);
  }
  assert.equal(await evaluate(`(() => {
    const live = document.getElementById('garage-live-budgets');
    return live.tagName === 'SECTION' && live.closest('#garage-settings-details') !== null
      && !live.closest('dl') && !live.querySelector('.garage-setting');
  })()`), true, 'Live cold budgets have a separate section outside configured setting rows');
  await evaluate("document.querySelector('#garage-recovery-details > summary').focus()");
  await keyPress('Enter');
  assert.equal(await evaluate("document.getElementById('garage-recovery-details').open"), true,
    'Recovery explanations open with Enter');
  await keyPress(' ');
  assert.equal(await evaluate("document.getElementById('garage-recovery-details').open"), false,
    'Recovery explanations close with Space');
  await evaluate("globalThis.garageBudgetSmokeState = 'available'; globalThis.refreshLearningSmokeStatus()");
  assert.deepEqual(await evaluate("['rear','front'].map(location => document.getElementById('garage-budget-' + location).textContent)"),
    ['Rear 80%', 'Front 30%'], 'Overview shows independent live remaining budgets');
  assert.deepEqual(await evaluate("['rear','front'].map(location => document.getElementById('garage-settings-budget-' + location).textContent)"),
    ['80%', '30%'], 'Settings show the same remaining percentages as the overview');
  assert.match(await evaluate("document.getElementById('garage-settings-budget-rear-remaining').textContent"), /72\b.*°C·min/);
  assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"), /27\b.*°C·min/);
  assert.deepEqual(await evaluate("['rear','front'].map(location => document.getElementById('garage-settings-budget-' + location + '-meter').hidden)"),
    [false, false], 'Available live budgets show their meters');
  const configuredValues = await evaluate("[...document.querySelectorAll('#garage-settings-details .garage-setting > dd')].map(node => node.textContent)");
  assert(configuredValues.includes('90 °C·min'), 'The configured allowance stays a degree-minute value');
  await evaluate(`(() => {
    globalThis.garageBudgetSmokeTriggers = ['rear','front'].map(location =>
      document.querySelector('#garage-settings-budget-' + location + ' .status-detail-trigger'));
    globalThis.garageBudgetSmokeOverview = ['rear','front'].map(location =>
      document.querySelector('#garage-budget-' + location + ' .status-detail-trigger'));
    document.getElementById('garage-recovery-details').open = true;
    globalThis.garageBudgetSmokeTriggers[1].focus();
  })()`);
  const unavailableReasons = { stale: /fresh|report|reading/i, uncertain: /history|uncertain|recover/i, unapproved: /approv/i };
  for (const state of ['stale', 'uncertain', 'unapproved', 'exhausted', 'available']) {
    await evaluate(`globalThis.garageBudgetSmokeState = '${state}'; globalThis.refreshLearningSmokeStatus()`);
    const unavailable = Object.hasOwn(unavailableReasons, state), frontValue = unavailable ? '—' : state === 'exhausted' ? '0%' : '30%';
    assert.equal(await evaluate("document.getElementById('garage-settings-budget-front').textContent"), frontValue,
      `${state} live evidence is reflected in settings`);
    assert.equal(await evaluate("document.getElementById('garage-budget-front').textContent"), `Front ${frontValue}`,
      `${state} live evidence agrees with the overview`);
    assert.equal(await evaluate("document.getElementById('garage-settings-budget-front-meter').hidden"), unavailable,
      `${state} never renders an unavailable budget as an exhausted meter`);
    if (unavailable) assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"),
      unavailableReasons[state], `${state} explains why the current budget is unavailable`);
    if (state === 'exhausted') {
      assert.match(await evaluate("document.getElementById('garage-settings-budget-front-remaining').textContent"), /0\b.*°C·min/);
      assert.equal(await evaluate("document.getElementById('garage-budget-front').dataset.state"), 'attention');
    }
    assert.equal(await evaluate("document.getElementById('garage-settings-budget-rear').textContent"), state === 'unapproved' ? '—' : '80%',
      `${state} keeps the rear assessment independent`);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#garage-settings-details .garage-setting > dd')].map(node => node.textContent)"),
      configuredValues, `${state} changes live budgets without changing configured values`);
    assert.equal(await evaluate(`globalThis.garageBudgetSmokeTriggers.every((node, index) => node ===
      document.querySelector('#garage-settings-budget-' + ['rear','front'][index] + ' .status-detail-trigger'))
      && globalThis.garageBudgetSmokeOverview.every((node, index) => node ===
        document.querySelector('#garage-budget-' + ['rear','front'][index] + ' .status-detail-trigger'))
      && document.getElementById('garage-recovery-details').open
      && document.activeElement === globalThis.garageBudgetSmokeTriggers[1]`), true,
      `${state} status refresh preserves budget triggers, keyboard focus and expanded recovery explanations`);
  }
  await keyPress('Enter');
  assert.equal(await evaluate("globalThis.garageBudgetSmokeTriggers[1].getAttribute('aria-expanded')"), 'true',
    'The live budget explanation opens with Enter');
  await evaluate('globalThis.refreshLearningSmokeStatus()');
  assert.equal(await evaluate("globalThis.garageBudgetSmokeTriggers[1].getAttribute('aria-expanded')"), 'true',
    'An open budget explanation survives status refresh');
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click()");
  assert.equal(await evaluate('document.activeElement === globalThis.garageBudgetSmokeTriggers[1]'), true,
    'Closing a budget explanation returns focus to its trigger');

  const prepareLearningShot = async (id, expanded) => evaluate(`(async () => {
    const card = document.getElementById('house-model');
    card.querySelectorAll('details').forEach(fold => fold.open = false);
    const root = document.getElementById('${id}'), section = root.closest('.learning-section');
    for (let parent = section; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    if (${expanded}) root.querySelector(':scope > details.learning-entry').open = true;
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    section.scrollIntoView({block: 'start'});
  })()`);
  const capture = async name => {
    await pause(60);
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} fits the viewport`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.learning-entry > summary')).filter(node => node.checkVisibility())
      .flatMap(node => {
        const box = node.getBoundingClientRect();
        const contentFits = [...node.querySelectorAll('.learning-entry-title, .learning-entry-value, .learning-entry-provenance, .learning-entry-summary')]
          .filter(field => field.checkVisibility()).every(field => {
            const fieldBox = field.getBoundingClientRect();
            return fieldBox.left >= box.left - 1 && fieldBox.right <= box.right + 1
              && field.scrollWidth <= field.clientWidth + 1;
          });
        return box.left >= 0 && box.right <= innerWidth + 1 && contentFits ? []
          : [{ key: node.parentElement.dataset.learningKey, left: box.left, right: box.right, contentFits }];
      })`), [], `${name} keeps learning text within its rows`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#garage-settings-details .garage-setting, #garage-live-budgets'))
      .filter(node => node.checkVisibility()).flatMap(node => {
        const box = node.getBoundingClientRect();
        const fields = [...node.querySelectorAll('dt, dd, small, meter, .status-detail-trigger')].filter(field => field.checkVisibility());
        const contentFits = fields.every(field => {
          const bounds = field.getBoundingClientRect();
          return bounds.left >= box.left - 1 && bounds.right <= box.right + 1
            && field.scrollWidth <= field.clientWidth + 1;
        });
        return box.left >= 0 && box.right <= innerWidth + 1 && contentFits ? []
          : [{ id: node.id, left: box.left, right: box.right, contentFits }];
      })`), [], `${name} keeps garage settings and live budget content within their sections`);
  };
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 600 ? 1100 : 844, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await evaluate(`window.homeEnergyTheme.setTheme('${theme}');
        document.querySelectorAll('#house-model details').forEach(fold => fold.open = false);
        document.getElementById('house-model').scrollIntoView({block: 'start'})`);
      await capture(`learning-overview-${width}-${theme}`);
      for (const [id, name] of learningSections) {
        for (const expanded of [false, true]) {
          await prepareLearningShot(id, expanded);
          await capture(`${name}-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
        }
      }
      for (const expanded of [false, true]) {
        await evaluate(`(async () => {
          const settings = document.getElementById('garage-settings-details');
          for (let parent = settings; parent; parent = parent.parentElement)
            if (parent.tagName === 'DETAILS') parent.open = true;
          document.getElementById('garage-recovery-details').open = ${expanded};
          await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
          settings.scrollIntoView({block: 'start'});
        })()`);
        await capture(`garage-settings-${width}-${theme}-${expanded ? 'recovery-expanded' : 'recovery-collapsed'}`);
      }
      await evaluate("document.getElementById('garage-live-budgets').scrollIntoView({block: 'center'})");
      await capture(`garage-live-budgets-${width}-${theme}`);
      for (const expanded of [false, true]) {
        await evaluate(`document.querySelectorAll('.charging-settings').forEach(fold=>fold.open=${expanded});
          document.getElementById('charger1-device').scrollIntoView({block:'start'})`);
        await capture(`chargers-${width}-${theme}-${expanded ? 'expanded' : 'collapsed'}`);
      }
      for (const state of ['manual', 'periods', 'paused', 'problem', 'charging']) {
        const id = state === 'charging' ? 'charger2' : 'charger1';
        await evaluate(`globalThis.chargingSmokeValues='${state}'; globalThis.refreshLearningSmokeStatus()`);
        await until(`document.getElementById('${id}-state').textContent==='${({ manual: 'Manual schedule', periods: 'Scheduled', paused: 'Paused between periods', problem: 'Update unconfirmed', charging: 'Charging' })[state]}'`);
        await evaluate(`document.getElementById('${id}-settings-details').open=true;
          document.getElementById('${id}-device').scrollIntoView({block:'start'})`);
        await capture(`charger-${state}-${width}-${theme}`);
        if (state === 'periods') {
          await evaluate("document.getElementById('charger1-explanation-details').open=true; document.getElementById('charger1-explanation-details').scrollIntoView({block:'start'})");
          await capture(`charger-explanations-${width}-${theme}`);
          await evaluate("document.getElementById('charger1-explanation-details').open=false");
        }
      }
      await evaluate("globalThis.chargingSmokeValues=null; globalThis.refreshLearningSmokeStatus()");
      await until("document.getElementById('charger2-setting-manualSoc').disabled===false");
    }
    // Preserve the equipment and savings layout checks from this smoke test.
    for (const [id, name] of [['timing-details', 'savings'], ['garage-controller-details', 'equipment'], ['charger1-device', 'charging']]) {
      await evaluate(`(() => { const element = document.getElementById('${id}'); element.open = true;
        for (let parent = element.parentElement; parent; parent = parent.parentElement)
          if (parent.tagName === 'DETAILS') parent.open = true;
        element.scrollIntoView({block: 'start'}); })()`);
      await capture(`${name}-${width}`);
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
      'shared charger cards, automatic SoC with original date/time, initial 20% fallback, connected-only metrics, confirmed periods retained through errors, manual expiry cap, nested operational explanations',
      'unchanged dashboard cards', 'matching Home and Garage learning headings', 'episode-based Garage progress',
      'shared learning rows and section structure', 'Enter and Space operate each learning section and entry',
      'status refresh preserves learning row identity, open explanations and focus',
      'sensor maintenance stays inside its input explanation', 'zero values remain distinct from missing evidence',
      'Garage settings keep descriptions outside values and live budgets in a separate section',
      'overview and settings agree for independent, stale, uncertain, unapproved and exhausted cold budgets',
      'status refresh preserves budget triggers, focus, open explanations and the recovery fold',
      'Garage settings and live budgets fit desktop and mobile in both themes',
      'Home and Garage learning sections fit desktop and mobile in both themes, collapsed and expanded',
      'original input and replay coefficient charts', 'no browser exceptions'] }));
  await send('Page.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(2000)]); }
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
