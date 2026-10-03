// Run after npm run build. Uses a disposable synthetic app and Chrome profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-selectors-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-selectors-screenshots-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pending = new Map(), errors = [], screenshots = [];
let app, browser, socket, sequence = 0, touch = false;
try {
  const configuration = join(directory, 'fixture-config.json');
  writeFileSync(configuration, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => Date.parse('2026-09-07T12:00:00Z'), installSignalHandlers: false });
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Isolated Chromium listener started');
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
    const id = ++sequence, timer = setTimeout(() => {
      pending.delete(id); reject(new Error(`CDP timeout: ${method}`));
    }, 15_000);
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
    throw new Error(`UI did not settle: ${expression}; errors: ${errors.join(', ')}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('Missing click target: ' + ${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('Hidden click target: ' + ${JSON.stringify(selector)});
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scrollBefore: scrollY };
    })()`);
    const { scrollBefore, ...coordinates } = point;
    if (touch) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...coordinates, radiusX: 1, radiusY: 1 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...coordinates, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...coordinates, button: 'left', clickCount: 1 });
    }
    await settle();
    if (['#date-start', '#date-end', '#away-until'].includes(selector))
      assert(Math.abs(await evaluate('scrollY') - scrollBefore) <= 1, `${selector}: opening the popup preserves document position`);
  };
  const key = async value => {
    const keyCode = { Escape: 27, ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9, ' ': 32 }[value];
    const params = { key: value, code: value === ' ' ? 'Space' : value,
      ...(keyCode ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode } : {}) };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params,
      ...(value === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params }); await settle();
  };
  const openAncestors = async selector => {
    await evaluate(`(() => { for (let node = document.querySelector(${JSON.stringify(selector)}).parentElement;
      node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true; })()`);
    await settle();
  };
  const bounds = async (selector, description) => {
    const geometry = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}), box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
        visible: node.checkVisibility(), background: getComputedStyle(node).backgroundColor };
    })()`);
    assert(geometry.visible && geometry.width > 0 && geometry.height > 0 && geometry.left >= 7 && geometry.top >= 7
      && geometry.right <= geometry.viewportWidth - 7 && geometry.bottom <= geometry.viewportHeight - 7,
    `${description}: popup stays in the viewport: ${JSON.stringify(geometry)}`);
    assert.notEqual(geometry.background, 'rgba(0, 0, 0, 0)', `${description}: popup has an app surface`);
  };
  const capture = async name => {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    const path = join(artifacts, `${name}.png`); writeFileSync(path, Buffer.from(screenshot.data, 'base64')); screenshots.push(path);
  };
  const datePopup = '.date-picker:not([hidden])';
  const selectPopup = '.app-select-popup:not([hidden])';
  const fixtureTrigger = '#selector-fixture-select + .app-select-trigger';
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    globalThis.selectorFixture = { mutations: [], events: [], transferFocus: false };
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, options = {}) => {
      const method = options.method ?? (input instanceof Request ? input.method : 'GET');
      if (!['GET', 'HEAD'].includes(method.toUpperCase())) {
        selectorFixture.mutations.push(String(input));
        throw new Error('Mutating requests are blocked in the synthetic selector fixture');
      }
      return nativeFetch(input, options);
    };
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('updated')?.textContent.startsWith('Updated')");
  await until("document.querySelector('#date-start[data-date-picker]') && document.querySelectorAll('.app-select-trigger').length >= 8");
  assert.equal(await evaluate("document.querySelectorAll('input[type=date], input[type=datetime-local], input[type=time]').length"), 0,
    'Shipped date/time fields cannot invoke browser selectors');
  assert.equal(await evaluate(`[...document.querySelectorAll('select')].every(select => select.classList.contains('app-select-source')
    && getComputedStyle(select).display === 'none' && select.tabIndex === -1
    && select.nextElementSibling.matches('.app-select-trigger[role=combobox]'))`), true,
  'Every static and dynamically rendered select uses an app trigger');

  // Pointer selection follows the real chart path, including accepting an unchanged suggestion.
  await click('#date-start'); await bounds(datePopup, 'Start date');
  const startStyle = await evaluate(`(() => { const node = document.querySelector('${datePopup}'), style = getComputedStyle(node);
    return [node.className, style.backgroundColor, style.borderRadius, style.width]; })()`);
  await click(`${datePopup} [data-date="2026-09-05"]`);
  assert.equal(await evaluate("document.getElementById('date-start').value"), '2026-09-05');
  assert.equal(await evaluate("document.getElementById('date-end').dataset.singleDay"), 'true');
  const suggestion = await evaluate("document.getElementById('date-end').value");
  await click('#date-end'); await bounds(datePopup, 'End date');
  assert.deepEqual(await evaluate(`(() => { const node = document.querySelector('${datePopup}'), style = getComputedStyle(node);
    return [node.className, style.backgroundColor, style.borderRadius, style.width]; })()`), startStyle,
  'Start and end use identical calendar styling');
  await click(`${datePopup} [data-date="${suggestion}"]`);
  assert.equal(await evaluate("document.getElementById('date-end').dataset.singleDay"), 'false',
    'Choosing the suggested end date explicitly activates the range');
  assert.equal(await evaluate("document.getElementById('date-end').value"), suggestion);
  await click('#date-start'); await key('ArrowRight'); await key('Escape');
  assert.equal(await evaluate("document.querySelector('.date-picker:not([hidden])') === null && document.activeElement.id === 'date-start'"), true,
    'Calendar keyboard navigation cancels and restores focus');
  assert.equal(await evaluate(`(() => { const input = document.getElementById('date-start');
    input.value = '2026-02-30'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const rejected = !input.checkValidity(); input.value = '2026-09-05'; return rejected && input.checkValidity(); })()`), true,
  'Impossible typed dates are rejected and valid programmatic replacements clear validation');

  await openAncestors('#away-until');
  await evaluate(`(() => { const input = document.getElementById('away-until'); input.value = '2026-09-07T08:30';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.addEventListener('input', () => selectorFixture.events.push('date-input'));
    input.addEventListener('change', () => selectorFixture.events.push('date-change')); })()`);
  await click('#away-until');
  await click(`${datePopup} [data-date="2026-09-08"]`);
  await evaluate(`document.querySelector('${datePopup} .date-picker-time input').value = '19'`);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-07T08:30', 'Calendar and time edits remain drafts');
  await click(`${datePopup} .date-picker-close`);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-07T08:30', 'Closing cancels the draft');
  assert.deepEqual(await evaluate('selectorFixture.events'), [], 'Cancel emits no edits');
  await click('#away-until'); await click(`${datePopup} [data-date="2026-09-08"]`);
  await evaluate(`(() => { const fields = document.querySelectorAll('${datePopup} .date-picker-time input');
    fields[0].value = '19'; fields[1].value = '45'; })()`);
  await click(`${datePopup} .date-picker-apply`);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '2026-09-08T19:45');
  assert.deepEqual(await evaluate('selectorFixture.events'), ['date-input', 'date-change'], 'Set emits one input/change pair');
  await click('#away-until'); await click(`${datePopup} .date-picker-clear`);
  assert.equal(await evaluate("document.getElementById('away-until').value"), '', 'Clear commits an empty optional deadline');
  assert.deepEqual(await evaluate('selectorFixture.events'), ['date-input', 'date-change', 'date-input', 'date-change']);
  assert.equal(await evaluate(`(() => { const input = document.getElementById('away-until');
    input.value = '2026-09-08T25:00'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const rejected = !input.checkValidity(); input.value = ''; return rejected && input.checkValidity(); })()`), true,
  'Invalid typed times are rejected and clearing restores validity');
  for (const id of ['pause-until']) {
    assert.equal(await evaluate(`document.getElementById('${id}').type === 'text'
      && document.getElementById('${id}').getAttribute('aria-haspopup') === 'dialog'`), true,
    `${id} uses the shared app date/time control`);
  }
  await click('#away-until');
  await evaluate("document.getElementById('temporary-details').hidden = true");
  await until("document.querySelector('.date-picker:not([hidden])') === null");
  await evaluate("document.getElementById('temporary-details').hidden = false");
  await evaluate(`(() => { const input = document.getElementById('away-until'), fieldset = document.createElement('fieldset');
    fieldset.id = 'selector-fixture-fieldset'; fieldset.style.cssText = 'border:0;margin:0;padding:0';
    input.before(fieldset); fieldset.append(input); })()`);
  await click('#away-until');
  await evaluate("document.getElementById('selector-fixture-fieldset').disabled = true");
  await until("document.querySelector('.date-picker:not([hidden])') === null");
  await evaluate(`(() => { const fieldset = document.getElementById('selector-fixture-fieldset');
    fieldset.disabled = false; fieldset.replaceWith(document.getElementById('away-until')); })()`);

  // Add controls after initialization to exercise the same observer as dynamic equipment UI.
  await evaluate(`(() => {
    const section = document.createElement('section'); section.id = 'selector-fixture';
    section.style.cssText = 'padding:20px;margin:20px;max-width:460px;border:1px solid var(--border);background:var(--surface)';
    const heading = document.createElement('h2'); heading.textContent = 'Selector browser fixture';
    const label = document.createElement('label'); label.textContent = 'Fixture selection'; label.htmlFor = 'selector-fixture-select';
    const select = document.createElement('select'); select.id = 'selector-fixture-select';
    for (const [value, text, disabled] of [['alpha', 'Alpha', false], ['beta', 'Beta', false], ['disabled', 'Unavailable', true], ['gamma', 'Gamma', false]]) {
      const option = new Option(text, value); option.disabled = disabled; select.append(option);
    }
    label.append(select);
    const next = document.createElement('input'); next.id = 'selector-fixture-next'; next.setAttribute('aria-label', 'Next editor');
    const close = document.createElement('button'); close.type = 'button'; close.id = 'selector-fixture-close'; close.textContent = 'Close fixture';
    close.addEventListener('click', () => section.closest('dialog')?.close());
    select.addEventListener('input', () => selectorFixture.events.push('select-input'));
    select.addEventListener('change', () => { selectorFixture.events.push('select-change'); if (selectorFixture.transferFocus) next.focus(); });
    section.append(heading, label, next, close); document.body.append(section); selectorFixture.events = [];
  })()`);
  await until("document.querySelector('#selector-fixture-select + .app-select-trigger') !== null");
  const clickLabel = async selector => {
    const point = await evaluate(`(() => {
      const label = document.querySelector(${JSON.stringify(selector)}); label.scrollIntoView({ block: 'center' });
      const range = document.createRange(); range.selectNodeContents(label.firstChild); const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (touch) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1 }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    }
    await settle();
    assert.equal(await evaluate(`document.querySelector('${fixtureTrigger}').getAttribute('aria-expanded')`), 'true',
      `${selector}: label activation opens the app selector`);
    await key('Escape');
  };
  await clickLabel('label[for="selector-fixture-select"]');
  await evaluate(`document.querySelector('label[for="selector-fixture-select"]').removeAttribute('for')`);
  await clickLabel('#selector-fixture > label');
  assert.equal(await evaluate(`(() => { const select = document.getElementById('selector-fixture-select');
    select.value = 'beta'; return select.nextElementSibling.textContent.includes('Beta'); })()`), true,
  'Programmatic value assignments update the visible control immediately');
  await evaluate("document.getElementById('selector-fixture-select').value = 'alpha'");
  await click(fixtureTrigger); await bounds(selectPopup, 'Dynamic select');
  await key('ArrowDown'); await key('Enter');
  assert.equal(await evaluate("document.getElementById('selector-fixture-select').value"), 'beta');
  assert.deepEqual(await evaluate('selectorFixture.events'), ['select-input', 'select-change']);
  await click(fixtureTrigger); await key('g'); await key('Enter');
  assert.equal(await evaluate("document.getElementById('selector-fixture-select').value"), 'gamma', 'Typeahead selects matching enabled options');
  await click(fixtureTrigger); await key('Escape');
  assert.equal(await evaluate(`document.querySelector('${fixtureTrigger}').getAttribute('aria-expanded')`), 'false');
  await click(fixtureTrigger); await click('#selector-fixture-next');
  assert.equal(await evaluate(`document.querySelector('${fixtureTrigger}').getAttribute('aria-expanded')`), 'false', 'Outside pointer dismisses the selector');
  await evaluate("selectorFixture.transferFocus = true; document.getElementById('selector-fixture-select').value = 'alpha'");
  await click(fixtureTrigger); await click(`${selectPopup} [data-index="1"]`);
  assert.equal(await evaluate('document.activeElement.id'), 'selector-fixture-next', 'Selection preserves the change handler’s transfer of focus');
  assert.deepEqual(await evaluate('selectorFixture.events'), ['select-input', 'select-change', 'select-input', 'select-change', 'select-input', 'select-change']);
  await click(fixtureTrigger);
  assert.equal(await evaluate(`(() => { const select = document.getElementById('selector-fixture-select'); select.disabled = true;
    return select.nextElementSibling.disabled && select.nextElementSibling.getAttribute('aria-expanded') === 'false'; })()`), true,
  'Disabling a source immediately disables its trigger and dismisses an open popup');
  await evaluate("document.getElementById('selector-fixture-select').disabled = false; selectorFixture.transferFocus = false");
  await click(fixtureTrigger);
  await evaluate(`document.getElementById('selector-fixture-select').append(new Option('Delta added later', 'delta'))`);
  await until("document.querySelector('.app-select-popup:not([hidden])').textContent.includes('Delta added later')");
  await key('Escape');

  // A parent modal stays authoritative while its app selector lives in the top layer.
  await evaluate(`(() => { const dialog = document.createElement('dialog'); dialog.id = 'selector-fixture-dialog';
    dialog.className = 'control-dialog'; dialog.setAttribute('aria-label', 'Selector modal fixture');
    dialog.append(document.getElementById('selector-fixture')); document.body.append(dialog); dialog.showModal(); })()`);
  await settle();
  for (const [width, height] of [[1440, 1100], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    touch = width === 390;
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`); await settle();
      if (touch) await clickLabel('#selector-fixture > label');
      await click(fixtureTrigger); await bounds(selectPopup, `${width}px ${theme} modal selector`);
      assert.equal(await evaluate("document.querySelector('.app-select-popup:not([hidden])').closest('dialog')?.id"), 'selector-fixture-dialog');
      await capture(`select-${width}-${theme}`); await key('Escape');
      assert.equal(await evaluate("document.getElementById('selector-fixture-dialog').open"), true, 'Escape dismisses the selector before its parent modal');
    }
  }
  await click(fixtureTrigger); await evaluate("document.getElementById('selector-fixture-dialog').close()"); await settle();
  assert.equal(await evaluate(`document.querySelector('${fixtureTrigger}').getAttribute('aria-expanded')`), 'false', 'Closing a modal dismisses its nested selector');
  for (const [width, height] of [[1440, 1100], [390, 844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    touch = width === 390;
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch });
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = '${theme}'`); await settle();
      await click('#date-start'); await bounds(datePopup, `${width}px ${theme} calendar`);
      await capture(`calendar-${width}-${theme}`); await key('Escape');
      await openAncestors('#away-until'); await click('#away-until'); await bounds(datePopup, `${width}px ${theme} date/time`);
      await capture(`datetime-${width}-${theme}`); await key('Escape');
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 320, deviceScaleFactor: 1, mobile: false });
  await click('#away-until'); await bounds(datePopup, 'Short mobile viewport date/time');
  await capture('datetime-390-short'); await key('Escape');

  // Authentication changes can hide the owning dashboard while an overlay is in the body.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await click('#away-until');
  await evaluate("document.body.dataset.authenticated = 'false'");
  assert.equal(await evaluate("document.querySelector('.date-picker:not([hidden])').checkVisibility()"), false,
    'Signed-out UI never exposes an existing date/time popup');
  await evaluate("document.body.dataset.authenticated = 'true'"); await key('Escape');
  await evaluate(`document.body.append(document.getElementById('selector-fixture'));
    document.getElementById('selector-fixture-dialog').remove()`);
  await settle(); await click(fixtureTrigger);
  await evaluate("document.body.dataset.authenticated = 'false'");
  assert.equal(await evaluate("document.querySelector('.app-select-popup:not([hidden])').checkVisibility()"), false,
    'Signed-out UI never exposes an existing body-level select popup');
  await evaluate("document.body.dataset.authenticated = 'true'"); await key('Escape');
  assert.deepEqual(await evaluate('selectorFixture.mutations'), [], 'Choosing draft settings does not send device or configuration commands');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(JSON.stringify({ result: 'selectors-browser-smoke-passed', screenshots,
    checks: ['matching-chart-calendars', 'suggested-end-date', 'typed-validation', 'staged-date-time', 'all-selects-enhanced',
      'dynamic-controls-and-options', 'programmatic-values-and-disabled', 'keyboard-and-pointer-selection',
      'outside-dismissal', 'label-activation', 'focus-transfer', 'modal-parent', 'hidden-and-disabled-ancestors',
      'touch', 'stable-document-scroll', 'desktop-mobile-light-dark-bounds', 'short-mobile-viewport', 'signed-out-overlays'] }));
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
