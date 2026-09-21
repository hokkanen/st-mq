// Exercise shared learning disclosures in a real browser using only synthetic data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-learning-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-learning-screenshots-'));
const assets = new Map([
  ['/learning-rows.js', ['text/javascript', readFileSync(new URL('../chart/learning-rows.js', import.meta.url))]],
  ['/monitor.css', ['text/css', readFileSync(new URL('../chart/monitor.css', import.meta.url))]],
]);
function addModule(pathname) {
  if (assets.has(pathname)) return;
  const source = readFileSync(new URL(`..${pathname}`, import.meta.url), 'utf8');
  assets.set(pathname, ['text/javascript', source]);
  for (const match of source.matchAll(/\b(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) addModule(new URL(match[1], `http://fixture${pathname}`).pathname);
  }
}
addModule('/chart/learning-status.js');
const model = initialAdaptiveModel({ floorThermalPriors: { capacityKwhPerC: 2.5,
  nativeCapacityKwhPerC: 8, exchangeKwPerC: 0.2, groundLossKwPerC: 0.015,
  groundC: 10, openAllocationFraction: 0.35, closedAllocationFraction: 0.08 } });
const learning = { adaptive: { model, baselineC: 21,
  comfortReference: { confidence: 'observed-heating-baseline' },
  health: { status: 'prior-estimates', usableSamples: 144, phaseSamples: { normal: 120, reduction: 24 }, acceptedFits: 0, rejectedFits: 2 } },
  metrics: { profit: { value: 0.36, count: 6, uncertainty: 0.18 }, auxProfit: { value: -0.12, count: 2 },
    recoveryError: { value: 0.11, count: 6 } },
  outcomes: { attempted: 9, completed: 7, incomplete: 1, inProgress: 1, assessed: 6, observedCostCents: 486, missingHours: 0.5 },
  readiness: { thermalValidated: false, responseValidated: false, advanceValidated: false,
    actionValidated: false, trialReady: false, reasons: ['collecting-independent-equipment-episodes'] },
  parameters: { auxIntegralA2: -990, auxHysteresisC: 30, a2Basis: 'absolute' } };
const context = { settings: { savingsAggressiveness: 50, preheatRoomBoostC: 5, recoveryHoldMinutes: 60,
  comfort: { targetC: 21, maxDropC: 1.5, maxRiseC: 1.5, severeDropC: 2 } },
  preheatValves: { enabled: true, available: true, active: false, leaseSeconds: 900, renewSeconds: 300 } };
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <title>Learning calculation fixture</title><link rel="stylesheet" href="/monitor.css">
  <style>body { margin: 0; } main { max-width: 760px; margin: 0 auto; padding: 24px; } h1 { font-size: 20px; }</style>
  </head><body><main><h1>Home learning</h1><section class="learning-section-body" id="rows"></section>
  <div id="actual" hidden></div></main>
  <script type="module">
    import { renderLearningRows } from '/learning-rows.js';
    import { learningDisplay, modelInputDescriptions } from '/chart/learning-status.js';
    globalThis.rows = [{ key: 'hydronic', title: 'Hydronic heating response', value: '0.0798 °C/kWh thermal',
      provenance: 'Initial estimate — not validated', summary: 'How supplied heat changes the model temperature.',
      detail: 'One effective response to compressor and resistance heat. Stored heat delays room warming.',
      evidence: 'Independent heating evidence is still being collected.', calculation: {
        equations: [
          { label: 'Space-heating input', expression: 'Pₕ = duty × Q(T) + Pₐᵤₓ',
            legend: 'Pₕ: thermal power in kW; duty: compressor running fraction; T: water temperature in °C.' },
          { label: 'Compressor electricity',
            expression: 'P(T) = 9.40 / 4.24 + ((9.24 / 3.51 − 9.40 / 4.24) / 10) × (T − 35)',
            legend: 'P(T): estimated electrical input in kW. The fixed map is based on manufacturer operating points.' }
        ], paragraphs: ['The shared coefficient acts on estimated thermal energy.',
          'Source-map uncertainty remains separate from evidence for the learned response.'],
        reference: { href: 'https://example.com/technical-data', label: 'Manufacturer technical data' }
      } },
      { key: 'loss', title: 'Heat loss', value: '0.0200 1/h', provenance: 'Fitted in current model',
        summary: 'Cooling from the indoor–outdoor temperature difference.', detail: 'A larger value means faster cooling.',
        calculation: { equations: [{ label: 'Loss rate', expression: 'cooling = loss × (Tᵢ − Tₒ)',
          legend: 'Tᵢ and Tₒ: indoor and outdoor temperatures in °C.' }] } },
      { key: 'unchanged', title: 'Garage learning row', value: '12 h', detail: 'An ordinary row without calculations.' }];
    globalThis.renderRows = () => renderLearningRows(document.getElementById('rows'), rows);
    renderRows();
    globalThis.learningFixture = ${JSON.stringify(learning)};
    globalThis.learningContext = ${JSON.stringify(context)};
    globalThis.renderActual = () => {
      const display = learningDisplay(learningFixture, learningContext);
      globalThis.actualDisplay = display;
      const sections = [ ['outcomes', 'Learning outcomes', display.metrics],
        ['evidence', 'Model evidence', display.evidenceRows],
        ['coefficients', 'Parameters', display.coefficients],
        ['calculations', 'Model calculations', display.coefficientEvidenceRows],
        ['inputs', 'Model inputs', modelInputDescriptions()],
        ['policy', 'Planning and control', display.policyRows ?? []] ];
      for (const [key, title, rows] of sections) {
        let section = document.getElementById('actual-' + key);
        if (!section) {
          section = document.createElement('section'); section.id = 'actual-' + key;
          section.className = 'learning-section-body';
          const heading = document.createElement('h2'); heading.textContent = title;
          const content = document.createElement('div'); content.className = 'actual-rows';
          section.append(heading, content); document.getElementById('actual').append(section);
        }
        renderLearningRows(section.querySelector('.actual-rows'), rows);
      }
    };
    renderActual(); globalThis.ready = true;
  </script></body></html>`;
const missingAssets = [];
const server = createServer((request, response) => {
  const asset = assets.get(request.url);
  if (!asset && request.url !== '/' && request.url !== '/favicon.ico') missingAssets.push(request.url);
  response.writeHead(asset || request.url === '/' ? 200 : 404,
    { 'Content-Type': asset?.[0] ?? 'text/html; charset=utf-8' });
  response.end(asset?.[1] ?? (request.url === '/' ? fixture : 'Not found'));
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket, sequence = 0;
const pending = new Map(), errors = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError; browser.on('error', error => { launchError = error; });
  let port;
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(directory, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(
      message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const keyPress = async key => {
    const code = key === 'Enter' ? 'Enter' : 'Space', windowsVirtualKeyCode = key === 'Enter' ? 13 : 32;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 200 && !await evaluate('globalThis.ready === true'); attempt++) await pause(30);
  assert.equal(await evaluate('globalThis.ready'), true,
    `Synthetic learning rows render; missing assets: ${missingAssets.join(', ')}; errors: ${errors.join(', ')}`);
  assert.equal(await evaluate(`document.querySelector('[data-learning-key="unchanged"] .learning-calculation') === null`), true,
    'Rows without calculations keep their original disclosure structure');
  assert.deepEqual(await evaluate(`(() => {
    const body = document.querySelector('.learning-entry-body');
    return [...body.children].map(node => node.className);
  })()`), ['learning-entry-detail', 'learning-calculation', 'learning-entry-evidence'],
  'Calculation follows the explanation and precedes evidence');
  await evaluate(`document.querySelector('.learning-entry').open = true;
    document.querySelector('.learning-calculation > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.querySelector('.learning-calculation').open`), true,
    'The native calculation disclosure opens with Enter');
  await evaluate(`globalThis.saved = {
    fold: document.querySelector('.learning-calculation'), summary: document.activeElement,
    equation: document.querySelector('.learning-equation-expression'),
    text: document.querySelector('.learning-equation-expression').firstChild,
    paragraph: document.querySelector('.learning-calculation-notes > p') };
    rows[0].value = '0.0800 °C/kWh thermal'; renderRows(); renderRows()`);
  assert.equal(await evaluate(`saved.fold.open && document.activeElement === saved.summary
    && saved.equation === document.querySelector('.learning-equation-expression')
    && saved.text === saved.equation.firstChild
    && saved.paragraph === document.querySelector('.learning-calculation-notes > p')`), true,
  'Polling updates values without closing folds, replacing equations or losing keyboard focus');
  await keyPress(' ');
  assert.equal(await evaluate(`document.querySelector('.learning-calculation').open`), false,
    'The native calculation disclosure closes with Space');
  await evaluate(`document.querySelectorAll('details').forEach(node => { node.open = true; })`);
  for (const [width, theme] of [[980, 'dark'], [360, 'light']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth
      && [...document.querySelectorAll('.learning-calculation')].every(node => node.scrollWidth <= node.clientWidth)`), true,
    `Long equations wrap within a ${width}px ${theme} layout`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(join(artifacts, `${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate(`rows[0].calculation.equations = [{ expression: '<img src=x onerror=alert(1)>' }];
    rows[0].calculation.paragraphs = ['<script>window.injected = true<\/script>'];
    rows[0].calculation.reference.href = 'javascript:alert(1)';
    rows[0].reference = { href: 'https://', label: 'Malformed address' }; renderRows()`);
  assert.equal(await evaluate(`document.querySelectorAll('#rows .learning-entry-body img, #rows .learning-entry-body script, #rows .learning-entry-body a').length === 0
    && document.querySelector('#rows .learning-equation-expression').textContent === '<img src=x onerror=alert(1)>'
    && document.querySelectorAll('#rows .learning-calculation-notes > p').length === 1`), true,
  'Calculation text stays literal, removed paragraphs disappear and unsafe or malformed links are rejected');
  await evaluate(`delete rows[0].calculation; renderRows()`);
  assert.equal(await evaluate(`document.querySelector('[data-learning-key="hydronic"] .learning-calculation') === null
    && document.querySelector('[data-learning-key="loss"] .learning-calculation').open`), true,
  'Removing one calculation preserves the other expanded rows');
  await evaluate(`document.getElementById('rows').hidden = true;
    document.getElementById('actual').hidden = false;
    document.activeElement.blur();
    document.querySelectorAll('#actual .learning-entry').forEach(row => { row.open = true; });
    document.querySelectorAll('#actual .learning-calculation').forEach(row => { row.open = true; })`);
  assert.equal(await evaluate(`document.querySelectorAll('#actual-outcomes .learning-entry').length === 4
    && document.querySelectorAll('#actual-coefficients .learning-entry').length >= 14
    && document.querySelectorAll('#actual-inputs .learning-entry').length >= 12`), true,
  'Real learning display renders outcomes, fixed slab priors and all model inputs');
  const panels = await evaluate(`[...document.querySelectorAll('#actual > section')]
    .filter(section => section.querySelector('.learning-entry')).map(section => section.id)`);
  assert.equal(await evaluate(`[...document.querySelectorAll('#actual > section')].every(section => {
    const groups = [...section.querySelectorAll('.learning-row-group')].map(node => node.textContent);
    return groups.length === new Set(groups).size;
  })`), true, 'Each disclosure group occurs once in its section');
  for (const [width, theme] of [[980, 'dark'], [360, 'light']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    for (const panel of panels) {
      await evaluate(`document.querySelectorAll('#actual > section').forEach(section => { section.hidden = section.id !== '${panel}'; });
        document.querySelectorAll('#${panel} details').forEach(row => { row.open = true; });
        window.scrollTo(0, 0)`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth
        && [...document.querySelectorAll('#${panel} .learning-calculation')].every(node => node.scrollWidth <= node.clientWidth)`), true,
      `Real ${panel} equations and explanations fit ${width}px ${theme}`);
      await evaluate(`(() => {
        const selected = {
          'actual-outcomes': ['profit', 'recoveryError'],
          'actual-coefficients': ['hydronicCPerKwh', 'solarCPerHourPerKwM2'],
          'actual-inputs': ['model_indoor_temperature', 'model_hydronic_heat'],
        }['${panel}'];
        const rows = [...document.querySelectorAll('#${panel} .learning-entry')];
        for (const [index, row] of rows.entries()) row.open = selected
          ? selected.includes(row.dataset.learningKey) : index < 2;
      })()`);
      const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 } });
      writeFileSync(join(artifacts, `${panel}-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
    for (const [panel, key, name] of [
      ['actual-coefficients', 'source-model-confirmed', 'source-map'],
      ['actual-calculations', 'model-fitting', 'model-fitting'],
      ['actual-policy', 'Preheat and comfort policy', 'preheat-policy'],
      ['actual-policy', 'Recovery hold', 'recovery-hold'],
    ]) {
      await evaluate(`document.querySelectorAll('#actual > section').forEach(section => { section.hidden = section.id !== '${panel}'; });
        document.querySelectorAll('#${panel} .learning-entry').forEach(row => { row.hidden = row.dataset.learningKey !== '${key}'; row.open = true; });
        document.querySelectorAll('#${panel} .learning-row-group').forEach(row => { row.hidden = true; });
        document.querySelectorAll('#${panel} .learning-calculation').forEach(row => { row.open = true; });
        window.scrollTo(0, 0)`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth
        && document.querySelector('#${panel} [data-learning-key="${key}"]') !== null`), true,
      `${name} detail remains available without overflow at ${width}px`);
      const height = await evaluate('Math.ceil(document.documentElement.scrollHeight)');
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 } });
      writeFileSync(join(artifacts, `actual-${name}-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
      await evaluate(`document.querySelectorAll('#${panel} .learning-entry, #${panel} .learning-row-group').forEach(row => { row.hidden = false; })`);
    }
  }
  await evaluate(`document.querySelectorAll('#actual > section').forEach(section => { section.hidden = false; });
    globalThis.realEquation = document.querySelector('#actual .learning-equation-expression');
    if (realEquation) {
      globalThis.realFold = realEquation.closest('details'); realEquation.closest('.learning-entry').open = true;
      realFold.open = true; realFold.querySelector('summary').focus();
    }
    learningFixture.metrics.profit.value = 0.42; renderActual()`);
  assert.equal(await evaluate(`!realEquation || realFold.open
    && document.activeElement === realFold.querySelector('summary')
    && document.querySelector('#actual .learning-equation-expression') === realEquation`), true,
  'Real model refresh retains an expanded calculation and keyboard focus');
  assert.deepEqual(errors, []);
  console.log(`Learning calculation browser checks passed. Synthetic screenshots: ${artifacts}`);
} finally {
  for (const task of pending.values()) clearTimeout(task.timer);
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  }
  await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
