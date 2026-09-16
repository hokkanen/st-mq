// Isolated synthetic app and Chrome profile; never reads household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-fullscreen-browser-'));
let app, socket, browser, id = 0;
const pending = new Map(), errors = [];
try {
  writeFileSync(join(directory, 'options.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'options.json'), STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => Date.parse('2026-09-07T12:00:00Z') });
  let endpoint = process.argv[2];
  if (!endpoint) {
    const profile = join(directory, 'chrome');
    mkdirSync(profile);
    browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
      '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    let launchError;
    browser.on('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 200 && !endpoint; attempt++) {
      if (launchError) throw launchError;
      try {
        const port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
        if (port) endpoint = `http://127.0.0.1:${port}`;
      } catch {}
      if (!endpoint) await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert(endpoint, 'Isolated Chromium DevTools listener started');
  }
  const target = await fetch(`${endpoint}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timeout ${method}`)); }, 15000);
    pending.set(key, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression, userGesture = false) => {
    const result = await send('Runtime.evaluate', { expression, userGesture, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async selector => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await settle();
  };
  const chartOpen = "document.querySelector('.history-panel').dataset.fullscreen === 'true'";
  const nativeState = active => `Boolean(document.fullscreenElement) === ${active}
    && document.getElementById('fullscreen-toggle').dataset.fullscreen === '${active}'`;
  const expectState = async (chart, native, description) => {
    await until(`(${chartOpen}) === ${chart} && ${nativeState(native)}`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('#fullscreen-toggle [data-fullscreen-${native ? 'exit' : 'enter'}]')).display !== 'none'
      && getComputedStyle(document.querySelector('#fullscreen-toggle [data-fullscreen-${native ? 'enter' : 'exit'}]')).display === 'none'`), true,
      `${description}: fullscreen icon reflects the available action`);
    assert.equal(await evaluate("document.getElementById('chart-fullscreen').dataset.chartView"), String(chart),
      `${description}: chart control reflects inspection state`);
    if (chart) assert.equal(await evaluate("document.getElementById('chart-fullscreen').textContent.trim()"), 'Exit',
      `${description}: chart inspection has a simple Exit action`);
    else assert.equal(await evaluate("Boolean(document.getElementById('chart-fullscreen').querySelector('svg'))"), true,
      `${description}: normal chart uses an icon`);
  };
  const externalEnter = async () => {
    await evaluate('document.documentElement.requestFullscreen()', true);
    await until(nativeState(true));
  };
  const externalExit = async () => {
    await evaluate('document.exitFullscreen()');
    await until(nativeState(false));
  };
  const capture = async name => {
    await evaluate('window.scrollTo(0, 0)');
    await settle();
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    mkdirSync('var', { recursive: true });
    writeFileSync(`var/fullscreen-${name}.png`, Buffer.from(screenshot.data, 'base64'));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('updated')?.textContent.startsWith('Updated')");
  await expectState(false, false, 'Initial dashboard');
  assert.equal(await evaluate('document.fullscreenEnabled'), true, 'Chrome exposes native page fullscreen');

  for (const [width, height] of [[1440, 1100], [390, 844], [320, 568]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await settle();
    assert.equal(await evaluate(`(() => {
      const theme = document.getElementById('theme-toggle'), fullscreen = document.getElementById('fullscreen-toggle');
      const a = theme.getBoundingClientRect(), b = fullscreen.getBoundingClientRect();
      return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
        && Math.abs(a.top - b.top) < 1 && b.left >= a.right && b.right <= innerWidth
        && document.documentElement.scrollWidth <= innerWidth
        && [theme, fullscreen].every(button => button.querySelector('svg') && !button.textContent.trim()
          && button.title && button.getAttribute('aria-label'));
    })()`), true, `${width}px: matching accessible icon buttons fit next to each other without overflow`);
    if (width === 390) await capture('mobile-390');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  const originalTheme = await evaluate('document.documentElement.dataset.theme');
  await capture(`desktop-${originalTheme}`);
  for (let change = 0; change < 2; change++) {
    const before = await evaluate('document.documentElement.dataset.theme');
    assert.match(await evaluate("document.getElementById('theme-toggle').getAttribute('aria-label')"),
      new RegExp(before === 'dark' ? 'light' : 'dark', 'i'), 'Theme label describes the offered action');
    assert.equal(await evaluate(`document.querySelector('#theme-toggle [data-theme-${before === 'dark' ? 'light' : 'dark'}]').checkVisibility()
      && !document.querySelector('#theme-toggle [data-theme-${before}]').checkVisibility()`), true,
      'Theme displays only the icon for the offered action');
    await click('#theme-toggle');
    assert.notEqual(await evaluate('document.documentElement.dataset.theme'), before, 'Theme icon toggles theme');
    if (change === 0) await capture(`desktop-${before === 'dark' ? 'light' : 'dark'}`);
  }
  assert.equal(await evaluate('document.documentElement.dataset.theme'), originalTheme, 'Theme is restored');

  await click('#fullscreen-toggle');
  await expectState(false, true, 'Whole UI fullscreen');
  assert.equal(await evaluate('document.fullscreenElement === document.documentElement'), true, 'The whole page is the native fullscreen target');
  await click('#fullscreen-toggle');
  await expectState(false, false, 'Leaving whole UI fullscreen');
  await externalEnter();
  await expectState(false, true, 'Externally entered fullscreen');
  await externalExit();
  await expectState(false, false, 'Externally exited fullscreen');

  for (const baseline of [false, true]) {
    for (const interruption of ['none', 'exit', 'exit-and-reenter']) {
      if (baseline) await externalEnter();
      await click('#chart-fullscreen');
      await expectState(true, true, `Chart entered from fullscreen=${baseline}`);
      if (!baseline && interruption === 'none') await capture('chart-exit');
      if (interruption !== 'none') {
        await externalExit();
        await expectState(true, false, 'Fullscreen interruption retains chart inspection');
        if (interruption === 'exit-and-reenter') {
          await externalEnter();
          await expectState(true, true, 'Reentered fullscreen retains chart inspection');
        }
      }
      await click('#chart-fullscreen');
      const expectedNative = baseline && interruption !== 'exit';
      await expectState(false, expectedNative, `Chart Exit from baseline=${baseline}, interruption=${interruption}`);
      if (expectedNative) await externalExit();
    }
  }

  await click('#chart-fullscreen');
  await expectState(true, true, 'Chart before native Escape');
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await settle();
  assert.equal(await evaluate(chartOpen), true, 'Trusted Escape leaves chart inspection open');
  if (await evaluate('Boolean(document.fullscreenElement)')) {
    // Headless Chrome versions may forward Escape only to page input handlers.
    console.log('Headless Chrome retained native fullscreen after CDP Escape; external native exit is covered separately.');
    await externalExit();
  }
  await expectState(true, false, 'Chart after native fullscreen exit');
  await click('#chart-fullscreen');
  await expectState(false, false, 'Explicit Exit after Escape');

  for (const fallback of ['unsupported', 'denied']) {
    await evaluate(`window.fullscreenRequest = document.documentElement.requestFullscreen;
      document.documentElement.requestFullscreen = ${fallback === 'unsupported' ? 'undefined' : "() => Promise.reject(new Error('Synthetic fullscreen denial'))"};
      document.dispatchEvent(new Event('fullscreenchange')); true`);
    if (fallback === 'unsupported') {
      assert.equal(await evaluate("document.getElementById('fullscreen-toggle').disabled"), true,
        'Unavailable page fullscreen disables its header action');
      assert.match(await evaluate("document.getElementById('fullscreen-toggle').title"), /unavailable/i,
        'Unavailable fullscreen explains the disabled action');
    } else {
      await click('#fullscreen-toggle');
      await expectState(false, false, 'Denied header request preserves the dashboard');
      assert.equal(await evaluate("document.getElementById('fullscreen-toggle').disabled"), false,
        'Denied header request permits a retry');
      assert.match(await evaluate("document.getElementById('fullscreen-toggle').title"), /try again/i,
        'Denied header request explains the retry');
    }
    await click('#chart-fullscreen');
    await expectState(true, false, `${fallback} native fullscreen still opens chart inspection`);
    await click('#chart-fullscreen');
    await expectState(false, false, `${fallback} chart fallback closes normally`);
    await evaluate(`document.documentElement.requestFullscreen = window.fullscreenRequest; delete window.fullscreenRequest;
      document.dispatchEvent(new Event('fullscreenchange')); true`);
    await click('#fullscreen-toggle');
    await expectState(false, true, `Page fullscreen recovers after ${fallback} request`);
    await click('#fullscreen-toggle');
    await expectState(false, false, `Page fullscreen exits after ${fallback} recovery`);
  }
  assert.deepEqual(errors, [], 'Fullscreen interactions produce no uncaught browser errors');
  console.log('Fullscreen browser checks passed: native page toggle, external changes, six chart restoration paths, unsupported/denied fallback, theme actions, and three responsive viewports.');
} finally {
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise(resolve => browser.once('exit', resolve));
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
