// Run after npm run build. Uses only a disposable simulated app and browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-home-controls-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-home-controls-screenshots-'));
const now = Date.parse('2026-09-21T12:00:00Z');
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
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], ' ': ['Space', 32], Tab: ['Tab', 9] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const screenshot = async (name, id = 'home-control') => {
    await evaluate('window.scrollTo(0, 0)');
    const clip = await evaluate(`(() => {
      const box = document.getElementById('${id}').getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    writeFileSync(join(artifacts, `${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable');
  // Exercise the production fetch/render/polling path. Only the presentation of
  // synthetic status is varied; control requests terminate in this fixture.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.homeFixture = { paused: false, savingsStrategy: 'balanced', reads: 0, mutations: [],
      automatic: true };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        const path = new URL(String(input), location.href).pathname;
        const body = JSON.parse(options.body ?? '{}');
        homeFixture.mutations.push({ path, body });
        if (path === '/api/automation') {
          homeFixture.automatic = body.enabled; homeFixture.paused = !body.enabled;
          homeFixture.pauseEnd = null; homeFixture.manualPhase = null;
        } else if (path === '/api/temporary') {
          if (Object.hasOwn(body, 'pauseUntilLocal')) {
            homeFixture.automatic = false; homeFixture.paused = true;
            homeFixture.pauseEnd = body.pauseUntilLocal ? Date.parse(body.pauseUntilLocal + '+03:00') : null;
          }
        } else if (path === '/api/heating-test') {
          homeFixture.manualPhase = body.command;
          homeFixture.receipt = { command: body.command, status: 'mqtt', sent: true,
            at: ${now}, requestedAt: ${now}, holdUntil: null,
            expiresAt: body.command === 'preheat' ? ${now} + 900000 : null };
          return new Response(JSON.stringify(homeFixture.receipt), { headers: { 'Content-Type': 'application/json' } });
        } else throw new Error('Unexpected mutation in browser fixture: ' + path);
        return globalThis.fetch('/api/status');
      }
      const response = await nativeFetch(input, options);
      if (!new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/api/status')) return response;
      const status = await response.json();
      homeFixture.reads++;
      status.automation = { home: { enabled: homeFixture.automatic && !homeFixture.paused, available: true, activity: homeFixture.automatic && !homeFixture.paused ? 'automatic' : 'paused' } };
      status.decision.reasons = homeFixture.paused ? ['heating-paused'] : ['flat-prices-preserve-normal-warmth'];
      status.settings.savingsStrategy = homeFixture.savingsStrategy;
      status.settings.preheatRoomBoostC = 5;
      status.settings.comfort.maxDropC = 1.5;
      status.settings.comfort.maxRiseC = 1.5;
      status.comfortRooms = [
        { id: 'bedroom', label: 'Bedroom', referenceC: 20, referenceSource: 'room', minC: 18.5, maxC: 21.5, limitsApply: true },
        { id: 'office', label: 'Office', referenceC: 21, referenceSource: 'overall', minC: 19.5, maxC: 22.5, limitsApply: true },
      ];
      status.override = homeFixture.paused ? { expiresAt: homeFixture.pauseEnd === undefined ? status.now + 3_600_000 : homeFixture.pauseEnd } : null;
      status.decision.manualHold = homeFixture.paused
        ? { until: homeFixture.manualPhase === 'preheat' ? status.now + 900000 : status.override.expiresAt, phase: homeFixture.manualPhase ?? 'preheat', changed: true } : null;
      status.heatingTests = { ...status.heatingTests, available: true, preheatAvailable: true,
        preheatTargetC: 25, preheatRoomBoostC: 5, lastResult: homeFixture.receipt };
      status.observations.actual = { ...status.observations.actual, source: 'simulation', verified: homeFixture.confirmed !== false, observedAt: status.now,
        stale: false, mode: 'normal', phase: homeFixture.manualPhase ?? (homeFixture.paused ? 'preheat' : 'normal'),
        requestedPhase: homeFixture.manualPhase ?? (homeFixture.paused ? 'preheat' : 'normal') };
      status.h66 = { ...status.h66, manualPreheat: homeFixture.manualPhase === 'preheat' ? { confirmed: true } : null, connected: true, brokerConnected: true, enabled: true,
        readings: Object.fromEntries(Object.entries({ '2201': 1, '0203': 20, '0212': 45,
          '0208': 55, '1A01': 1, '1A07': 0, '3104': 0, '1A20': 0 })
          .map(([key, value]) => [key, { value, available: true, observedAt: status.now }])) };
      return new Response(JSON.stringify(status), { status: response.status, headers: response.headers });
    };
    const nativeInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 15_000 && callback.toString().includes('background')) homeFixture.poll = callback;
      return nativeInterval(callback, delay, ...args);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until(`globalThis.homeFixture?.poll && document.getElementById('home-savings-strategy')?.textContent === 'Balanced'`);
  await evaluate(`document.getElementById('home-heat-pump-details').open = true`);
  assert.equal(await evaluate(`document.getElementById('home-preferences-details').open`), false,
    'Permanent preferences start folded');
  assert.equal(await evaluate(`(() => {
    const preferences = document.getElementById('home-preferences-details');
    return ['tariff-control-state', 'dhwr'].every(id => {
      const element = document.getElementById(id);
      return !preferences.contains(element) && element.checkVisibility() && element.textContent.trim() !== '—';
    }) && document.querySelector('[data-h66-summary="mode"]').checkVisibility()
      && !document.getElementById('home-savings-strategy').checkVisibility();
  })()`), true, 'Current heat-pump, tariff and circulation states remain visible outside folded preferences');
  assert.match(await evaluate(`document.getElementById('heating-test-help').textContent`), /next controller update.*1 minute.*Preheat.*lease deadline/);
  assert.equal(await evaluate(`document.getElementById('home-comfort-limits').textContent`), '−1.5 / +1.5 °C');
  assert.equal(await evaluate(`(() => {
    const group = document.getElementById('heating-test-buttons');
    return group.getAttribute('role') === 'group'
      && document.getElementById(group.getAttribute('aria-labelledby')).textContent === 'Manual heating override'
      && [...group.querySelectorAll('button')].every(button => button.type === 'button'
        && !button.disabled && button.getAttribute('aria-label') && button.hasAttribute('aria-pressed'));
  })()`), true, 'Temporary actions have an accessible group name, button names and selection state');
  assert.equal(await evaluate(`document.getElementById('home-manual-override-details').open`), false, 'Manual heating starts folded');
  await evaluate(`document.querySelector('#home-manual-override-details > summary').focus()`);
  await keyPress('Enter');
  await evaluate(`document.getElementById('test-normal').focus()`);
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'test-preheat', 'Preheat follows Normal in keyboard order');
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'test-reduction', 'Reduced heating follows Preheat in keyboard order');
  assert.equal(await evaluate(`(() => {
    const temporary = document.getElementById('temporary-details');
    return temporary.closest('#heating-test-details') !== null
      && Boolean(temporary.compareDocumentPosition(document.getElementById('home-manual-override-details')) & Node.DOCUMENT_POSITION_FOLLOWING)
      && Boolean(temporary.compareDocumentPosition(document.getElementById('home-preferences-details')) & Node.DOCUMENT_POSITION_FOLLOWING);
  })()`), true, 'Schedule and away sits below the mode choice before manual overrides and strategy');
  await screenshot('desktop-dark-folded');
  console.log(`Home controls first screenshot: ${join(artifacts, 'desktop-dark-folded.png')}`);
  await evaluate(`document.querySelector('#home-preferences-details > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('home-preferences-details').open`), true,
    'Enter opens native preferences disclosure');
  await evaluate(`globalThis.savedPreferences = { fold: document.getElementById('home-preferences-details'),
    summary: document.activeElement, value: document.getElementById('home-savings-strategy') };
    homeFixture.savingsStrategy = 'savings'; await homeFixture.poll()`);
  assert.equal(await evaluate(`savedPreferences.fold.open && document.activeElement === savedPreferences.summary
    && savedPreferences.value === document.getElementById('home-savings-strategy')
    && savedPreferences.value.textContent === 'More savings'`), true,
    'Status refresh updates preference values without replacing the fold or losing keyboard focus');
  await keyPress(' ');
  assert.equal(await evaluate(`document.getElementById('home-preferences-details').open`), false,
    'Space closes native preferences disclosure');
  await evaluate(`homeFixture.automatic = false; await homeFixture.poll()`);
  assert.equal(await evaluate(`document.getElementById('test-reduction').disabled`), false,
    'Home manual reduction stays available while paused');
  await evaluate(`homeFixture.automatic = true; await homeFixture.poll()`);
  for (const width of [1280, 360]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') document.getElementById('theme-toggle').click();
      document.getElementById('home-preferences-details').open = true;
      document.getElementById('home-room-references-details').open = true`);
    const layout = await evaluate(`({ page: document.documentElement.scrollWidth, viewport: innerWidth,
      overflow: [...document.querySelectorAll('#home-preferences-details *')].filter(element => element.scrollWidth > element.clientWidth + 1)
        .map(element => ({ name: element.id || element.tagName, scroll: element.scrollWidth, client: element.clientWidth })),
      rows: [...document.querySelectorAll('#home-manual-controls .home-state-reading, #home-preferences-details .home-preferences-body, #heating-test-buttons')]
        .map(element => ({ name: element.id || element.className, scroll: element.scrollWidth, client: element.clientWidth })) })`);
    assert.equal(layout.page <= layout.viewport && layout.rows.every(row => row.scroll <= row.client + 1), true,
      `Heating controls and preferences fit ${width}px ${theme} without horizontal overflow: ${JSON.stringify(layout)}`);
    const margins = await evaluate(`['temporary-details', 'home-preferences-details']
      .map(id => { const style = getComputedStyle(document.getElementById(id));
        return [style.marginInlineStart, style.marginTop, style.borderTopWidth]; })`);
    assert(margins.every(row => JSON.stringify(row) === JSON.stringify(margins[0])),
      'Home preferences use matching nested indentation, spacing and dividers');
    assert.equal(margins[0][0], width === 360 ? '16px' : '24px');
    assert.match(await evaluate(`document.getElementById('home-room-references').textContent`), /Bedroom20 °C · Learned room reference.*18.5 °C – 21.5 °C.*Office21 °C · Overall reference/);
    await screenshot(`${width === 360 ? 'mobile' : 'desktop'}-${theme}-preferences`);
  }
  for (const [policyId, modelId] of [
    ['home-preferences-details', 'learning-panel-details'],
  ]) {
    assert.equal(await evaluate(`(() => {
      const policy = document.getElementById('${policyId}');
      const choices = [...policy.querySelectorAll('.heating-strategy-option')];
      return choices.length === 3 && choices.filter(choice => choice.dataset.selected === 'true').length === 1
        && choices.find(choice => choice.dataset.selected === 'true').textContent.includes('More savings');
    })()`), true, 'Home preferences show the three strategies and identify the configured choice');
    await evaluate(`document.getElementById('${modelId}').open = false;
      document.querySelector('#${policyId} [data-policy-model-link]').focus()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`document.getElementById('${modelId}').open
      && document.activeElement === document.querySelector('#${modelId} > summary')`), true,
    'The heat-model reference opens the separate fold and transfers keyboard focus');
    await evaluate(`document.getElementById('${policyId}').open = false;
      document.querySelector('#${modelId} > .learning-section').open = true;
      document.querySelector('#${modelId} > .learning-model-purpose [data-policy-model-link]').focus()`);
    await keyPress('Enter');
    assert.equal(await evaluate(`(() => {
      const policy = document.getElementById('${policyId}'), summary = policy.querySelector(':scope > summary');
      const bounds = summary.getBoundingClientRect();
      return policy.open && summary.checkVisibility() && document.activeElement === summary
        && bounds.top >= -1 && bounds.bottom <= innerHeight + 1
        && document.getElementById('${modelId}').open
        && document.querySelector('#${modelId} > .learning-section').open;
    })()`), true, 'The model return link opens and focuses the visible strategy without resetting model disclosures');
    await keyPress(' ');
    assert.equal(await evaluate(`!document.getElementById('${policyId}').open
      && document.getElementById('${modelId}').open`), true,
    'The strategy still collapses by keyboard after return-link navigation');
    await evaluate(`document.getElementById('${modelId}').open = false;
      document.querySelector('#${modelId} > .learning-section').open = false`);
  }
  console.log(`Home controls screenshots available: ${artifacts}`);
  await evaluate(`homeFixture.paused = true; await homeFixture.poll()`);
  assert.match(await evaluate(`document.getElementById('heating-test-help').textContent`), /Normal and Reduced stay until.*Automatic.*Preheat always ends/);
  assert.doesNotMatch(await evaluate(`document.getElementById('heating-test-help').textContent`), /1 minute/);
  assert.equal(await evaluate(`document.getElementById('test-preheat').getAttribute('aria-pressed')`), 'true',
    'Paused fixture retains accessible active preheat state');
  assert.equal(await evaluate(`document.getElementById('home-hold-warning').checkVisibility()`), true,
    'The active held-setting warning remains visible outside preferences');
  await evaluate(`document.getElementById('home-preferences-details').open = false;
    document.getElementById('temporary-details').open = true;
    document.getElementById('pause-until').value = '2026-09-21T18:45';
    document.getElementById('pause-until').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pause-until').focus(); await homeFixture.poll()`);
  assert.equal(await evaluate(`document.activeElement.id === 'pause-until'
    && document.getElementById('pause-until').value === '2026-09-21T18:45'`), true,
    'Refresh retains an unsaved pause draft and input focus');
  await screenshot('mobile-light-paused');
  await evaluate(`document.getElementById('temporary-details').open = false;
    for (const id of ['learning-panel-details', 'learning-details', 'learning-validation-details'])
      document.getElementById(id).open = true`);
  assert.equal(await evaluate(`document.getElementById('learning-reconstruction-details')
    .parentElement.closest('details').id`), 'learning-validation-details',
    'Reconstruction explanation belongs to Home learning validation');
  assert.equal(await evaluate(`document.getElementById('learning-reconstruction-details').open`), false,
    'The detailed reconstruction contract starts folded');
  await evaluate(`document.querySelector('#learning-reconstruction-details > summary').focus()`);
  await keyPress('Enter');
  assert.equal(await evaluate(`document.getElementById('learning-reconstruction-details').open`), true,
    'Reconstruction disclosure opens by keyboard');
  assert.match(await evaluate(`document.getElementById('learning-reconstruction-details').textContent`),
    /Exactly reproducible:[\s\S]*complete learning journal[\s\S]*matching learning software[\s\S]*observation CSV alone is insufficient[\s\S]*Outside this guarantee:/);
  await evaluate(`globalThis.savedReconstruction = document.activeElement; await homeFixture.poll()`);
  assert.equal(await evaluate(`document.getElementById('learning-reconstruction-details').open
    && document.activeElement === savedReconstruction`), true, 'Reconstruction stays open and focused across refresh');
  for (const [width, theme] of [[360, 'light'], [1280, 'dark']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') document.getElementById('theme-toggle').click()`);
    const reconstructionLayout = await evaluate(`({ page: document.documentElement.scrollWidth, viewport: innerWidth,
      rows: [...document.querySelectorAll('#learning-reconstruction-details > p')]
        .map(element => ({ scroll: element.scrollWidth, client: element.clientWidth })) })`);
    assert.equal(reconstructionLayout.page <= reconstructionLayout.viewport
      && reconstructionLayout.rows.every(row => row.scroll <= row.client + 1), true,
    `Reconstruction explanation wraps within ${width}px ${theme}: ${JSON.stringify(reconstructionLayout)}`);
    await screenshot(`${width === 360 ? 'mobile' : 'desktop'}-${theme}-reconstruction`);
  }
  await evaluate(`homeFixture.paused = false; await homeFixture.poll()`);
  assert.match(await evaluate(`document.getElementById('heating-test-help').textContent`), /next controller update.*1 minute/);
  assert.deepEqual(await evaluate('homeFixture.mutations'), [], 'Presentation checks sent no commands');
  await evaluate(`document.getElementById('home-automation-pause').click()`);
  await until(`document.getElementById('home-automation-pause').getAttribute('aria-pressed') === 'true'
    && document.getElementById('home-automation-message').textContent.includes('No resume time')`);
  assert.match(await evaluate(`document.getElementById('heating-test-help').textContent`), /stay until you select/);
  await evaluate(`document.getElementById('home-manual-override-details').open = true; homeFixture.confirmed = false;
    document.getElementById('test-reduction').click()`);
  await until(`document.getElementById('heating-test-message').textContent.includes('Waiting for device feedback')`);
  await evaluate(`homeFixture.confirmed = true`);
  await until(`await homeFixture.poll(); return document.getElementById('heating-test-message').textContent.includes('Device confirmed')`);
  assert.match(await evaluate(`document.getElementById('heating-test-message').textContent`), /Device confirmed.*Held until you select/);
  for (const [id, command] of [['test-preheat', 'preheat'], ['test-normal', 'normal']]) {
    await evaluate(`document.getElementById('${id}').click()`);
    await until(`homeFixture.receipt?.command === '${command}' && !document.getElementById('${id}').disabled`);
    await until(`await homeFixture.poll(); return document.getElementById('heating-test-message').textContent.includes('Device confirmed')`);
    assert.match(await evaluate(`document.getElementById('heating-test-message').textContent`), /Device confirmed/);
  }
  await evaluate(`document.getElementById('temporary-details').open = true;
    document.getElementById('pause-until').value = '2026-09-21T17:00';
    document.getElementById('pause-until').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('temporary-form').requestSubmit()`);
  await until(`document.getElementById('override-status').textContent.includes('17:00')`);
  await evaluate(`document.getElementById('pause-until').value = '';
    document.getElementById('pause-until').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('temporary-form').requestSubmit()`);
  await until(`document.getElementById('override-status').textContent === 'Paused until you select Automatic.'`);
  assert.equal(await evaluate(`document.getElementById('home-automation-pause').getAttribute('aria-pressed')`), 'true',
    'Clearing the scheduled end keeps Pause selected');
  await evaluate(`document.getElementById('resume-now').click()`);
  await until(`document.getElementById('home-automation-automatic').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.getElementById('home-automation-pause').click()`);
  await until(`document.getElementById('home-automation-pause').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.getElementById('home-automation-automatic').click()`);
  await until(`document.getElementById('home-automation-automatic').getAttribute('aria-pressed') === 'true'`);
  assert.deepEqual(await evaluate('homeFixture.mutations.map(row => row.body)'), [
    { feature: 'home', enabled: false }, { command: 'reduction' }, { command: 'preheat' },
    { command: 'normal' }, { pauseUntilLocal: '2026-09-21T17:00' }, { pauseUntilLocal: null },
    { feature: 'home', enabled: true }, { feature: 'home', enabled: false }, { feature: 'home', enabled: true },
  ], 'Primary mode and all three manual buttons send their intended request');
  await evaluate(`document.getElementById('dashboard-reset').click()`);
  assert.equal(await evaluate(`document.querySelectorAll('details[open]').length`), 0,
    'Dashboard reset closes controls, strategies and models after cross-link navigation');
  assert.equal(await evaluate(`document.activeElement.id`), 'dashboard-reset');
  assert.deepEqual(errors, [], 'Production monitor runs without browser exceptions');
  console.log(`Home controls browser checks passed. Synthetic screenshots: ${artifacts}`);
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
