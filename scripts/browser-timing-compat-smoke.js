// Isolated comparison UI through disclosure cycles; no runtime or household data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'stmq-timing-browser-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-timing-screenshots-'));
const assets = new Map();
function addModule(pathname) {
  if (assets.has(pathname)) return;
  const source = readFileSync(new URL(`..${pathname}`, import.meta.url), 'utf8');
  assets.set(pathname, ['text/javascript', source]);
  for (const match of source.matchAll(/\b(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) addModule(new URL(match[1], `http://fixture${pathname}`).pathname);
  }
}
addModule('/chart/timing-benefit.js');
addModule('/chart/comparison-disclosure.js');
for (const name of ['monitor.css', 'timing-benefit.css']) {
  assets.set(`/chart/${name}`, ['text/css', readFileSync(new URL(`../chart/${name}`, import.meta.url))]);
}
// Exercise the production fold button, introductory content and period controls.
// Keep its real markup and styles so appliance rendering checks cover the same
// layout path as the dashboard.
const dashboard = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
const comparisonStart = dashboard.indexOf('<section id="timing-details"');
const comparisonEnd = dashboard.indexOf('<details id="recording-details"', comparisonStart);
assert(comparisonStart >= 0 && comparisonEnd > comparisonStart, 'Production comparison markup is present');
const comparisonMarkup = dashboard.slice(comparisonStart, comparisonEnd).trim();
const from = Date.parse('2026-09-09T00:00:00+03:00'), hour = 3_600_000;
const timing = (value, charger = false) => ({ value, energyKwh: charger ? 2 : 1,
  actualCostEuro: 5, uniformCostEuro: 5 + value, provisional: true, coverage: 1 / 12,
  coverageDetails: { from, to: from + 12 * hour, elapsedMs: 12 * hour * (charger ? 2 : 1),
    includedMs: hour * (charger ? 2 : 1), powerMs: hour * (charger ? 2 : 1),
    missingPowerMs: 11 * hour * (charger ? 2 : 1), incompletePriceMs: 0,
    coverageBasis: charger ? 'charger-time' : 'elapsed-time' },
  evidence: { energyBasis: charger ? 'recorded-intervals' : 'reconstructed-equipment',
    timeBasis: 'recorded-interval-time', sources: [{ key: charger ? 'recorded' : 'observed',
      durationMs: hour * (charger ? 2 : 1), energyKwh: charger ? 2 : 1, share: 1,
      firstAt: from + hour, lastAt: from + 2 * hour }] } });
const payload = { now: from + 12 * hour,
  range: { from, to: from + 24 * hour, startDate: '2026-09-09', endDate: '2026-09-09' },
  heatingBenefit: { status: 'estimated', valueEuro: 3.5, counts: { assessed: 2, completed: 2 } },
  timingBenefit: { heatPump: timing(1), charger: timing(2, true) },
  firewoodBenefit: { status: 'provisional', valueEuro: 1.25, electricityAvoidedKwh: 4.5,
    woodCostEuro: 0, generatedAt: from + 12 * hour, loads: { kg: 8, count: 1 },
    coverage: { elapsedMs: 12 * hour, includedMs: 6 * hour, missingMs: 6 * hour,
      firstAt: from + hour, lastAt: from + 8 * hour }, assumptions: ['Synthetic browser fixture.'] } };
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
  <link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/timing-benefit.css">
  <title>Comparison browser fixture</title></head><body><main><section class="panel history-panel">
  ${comparisonMarkup}
  </section></main><script type="module">
    import { createTimingBenefit } from '/chart/timing-benefit.js';
    import { createComparisonDisclosure } from '/chart/comparison-disclosure.js';
    const options = new URLSearchParams(location.search);
    if (options.has('without-observer')) window.ResizeObserver = undefined;
    if (options.has('delayed-observer')) {
      const NativeResizeObserver = window.ResizeObserver;
      window.pendingResizeDeliveries = [];
      window.ResizeObserver = class extends NativeResizeObserver {
        constructor(callback) {
          super((entries, observer) => pendingResizeDeliveries.push(() => callback(entries, observer)));
        }
      };
      window.flushResizeDeliveries = () => pendingResizeDeliveries.splice(0).forEach(deliver => deliver());
    }
    localStorage.clear();
    window.comparisonPayload = ${JSON.stringify(payload)};
    window.comparisonPanel = createTimingBenefit(document.getElementById('timing-benefit'));
    window.comparisonDisclosure = createComparisonDisclosure({
      button: document.getElementById('comparison-toggle'), content: document.getElementById('comparison-content'),
      onOpen: () => comparisonPanel.refreshLayout(),
    });
    comparisonPanel.render(comparisonPayload); window.ready = true;
  </script></body></html>`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://fixture').pathname, asset = assets.get(pathname);
  response.writeHead(asset || pathname === '/' ? 200 : 404,
    { 'Content-Type': asset?.[0] ?? 'text/html; charset=utf-8' });
  response.end(asset?.[1] ?? (pathname === '/' ? fixture : 'Not found'));
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
  const settle = () => evaluate(`new Promise(resolve => {
    let frames = 4;
    function frame() { if (--frames) requestAnimationFrame(frame); else resolve(); }
    requestAnimationFrame(frame);
  })`);
  const checkIndentation = async () => {
    assert.deepEqual(await evaluate(`(() => {
      const inset = innerWidth <= 640 ? 16 : 24;
      const left = node => node.getBoundingClientRect().left;
      const panelLeft = left(document.getElementById('comparison-toggle')) + inset;
      const failures = [];
      for (const selector of ['#comparison-content', '.timing-intro', '.comparison-range-controls',
        '.timing-devices', '.timing-explanations > summary']) {
        if (Math.abs(left(document.querySelector(selector)) - panelLeft) > 1) failures.push(selector);
      }
      for (const card of document.querySelectorAll('.timing-device')) {
        if (Math.abs(left(card.querySelector('summary')) - left(card.querySelector('.timing-overview-content'))) > 1)
          failures.push(card.dataset.device + ' summary');
      }
      for (const body of document.querySelectorAll('details[open] > .timing-detail-content, details[open] > .timing-explanations-content')) {
        const bounds = body.getBoundingClientRect(), summary = body.previousElementSibling.getBoundingClientRect();
        if (bounds.height <= 0 || Math.abs(bounds.left - summary.left - inset) > 1
          || bounds.right > summary.right + 1 || body.scrollWidth > body.clientWidth + 1)
          failures.push(body.className);
      }
      return failures;
    })()`), [], 'Outer content shares one inset; nested headers align with their peers and opened bodies add one inset');
  };
  const checkVisibleCards = async (amounts = ['€3.50', '€2.00', '€1.25']) => {
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.timing-device')).map(card => {
      const overview = card.querySelector('.timing-device-overview'), fold = card.querySelector('details');
      return { name: card.querySelector('h3').textContent,
        amount: card.querySelector('.timing-amount').textContent,
        aboveFold: overview.getBoundingClientRect().bottom <= fold.getBoundingClientRect().top,
        visible: Array.from(overview.querySelectorAll('h3, .heating-selection, .timing-amount, .timing-basis')).every(node =>
          node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility === 'visible') };
    })`), ['Heating', 'Charging', 'Fireplace'].map((name, index) => ({ name,
      amount: amounts[index], aboveFold: true, visible: true })));
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.timing-overview-content, .timing-figures')).every(node =>
      node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1)`), true,
    'Margin-containing wrappers keep the complete result visible without clipping');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('.timing-device-overview')).every(overview => {
      const bounds = overview.getBoundingClientRect();
      return Array.from(overview.querySelectorAll('h3, .heating-selection, .timing-amount, .timing-basis')).every(node => {
        const box = node.getBoundingClientRect();
        return box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
      });
    })`), true, 'Card ingredients remain inside their visible overview after reopening');
    assert.equal(await evaluate(`Array.from(document.querySelectorAll(
      '.timing-device-overview h3, .timing-device-overview .timing-amount, .timing-device-overview .timing-basis'
    )).every(node => {
      node.scrollIntoView({ block: 'center' });
      const box = node.getBoundingClientRect();
      const painted = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return painted && node.contains(painted);
    })`), true, 'Overview text remains hit-testable through its ancestors, rather than clipped by a collapsed wrapper');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  };
  const alignment = () => evaluate(`(() => {
    const devices = document.querySelector('.timing-devices');
    return { selection: devices.style.getPropertyValue('--timing-selection-height'),
      overview: devices.style.getPropertyValue('--timing-overview-height') };
  })()`);
  const checkOuter = async open => {
    assert.deepEqual(await evaluate(`(() => {
      const button = document.getElementById('comparison-toggle'), content = document.getElementById('comparison-content');
      return { expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls'),
        hidden: content.hidden, visible: content.getBoundingClientRect().height > 0,
        marker: getComputedStyle(button, '::before').content };
    })()`), { expanded: String(open), controls: 'comparison-content', hidden: !open, visible: open,
      marker: open ? '"▼"' : '"▶"' },
    'The fold announces its state, updates its triangle and hides all collapsed contents');
  };
  const toggleOuter = async open => {
    await evaluate("document.getElementById('comparison-toggle').click()");
    await settle();
    await checkOuter(open);
  };
  const keyboardToggle = async (key, open) => {
    const code = key === ' ' ? 'Space' : 'Enter', keyCode = key === ' ' ? 32 : 13;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode,
      text: key === 'Enter' ? '\r' : key });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await settle();
    await checkOuter(open);
    assert.equal(await evaluate("document.activeElement.id"), 'comparison-toggle',
      'The native button retains focus after keyboard activation');
  };
  const captureCards = async () => {
    const clip = await evaluate(`(() => {
      const bounds = document.querySelector('.timing-devices').getBoundingClientRect();
      const x = Math.floor(bounds.left + scrollX), y = Math.floor(bounds.top + scrollY);
      return { x, y, width: Math.ceil(bounds.right + scrollX) - x,
        height: Math.ceil(bounds.bottom + scrollY) - y, scale: 1 };
    })()`);
    return (await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })).data;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // The explicit hidden panel always leaves layout while closed; there is no
  // native-disclosure cached-layout branch left to simulate.
  for (const observerMode of ['native', 'missing', 'delayed']) {
    const options = new URLSearchParams();
    const withoutObserver = observerMode === 'missing';
    if (withoutObserver) options.set('without-observer', '');
    if (observerMode === 'delayed') options.set('delayed-observer', '');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/?${options}` });
    for (let attempt = 0; attempt < 100 && !await evaluate('window.ready === true'); attempt++) await pause(30);
    assert.equal(await evaluate('window.ready'), true, `Comparison render completes; errors: ${errors.join(', ')}`);
    assert.equal(await evaluate('typeof ResizeObserver'), withoutObserver ? 'undefined' : 'function');
    await checkOuter(false);
    await evaluate("document.getElementById('comparison-toggle').focus()");
    await keyboardToggle('Enter', true);
    await keyboardToggle(' ', false);
    await keyboardToggle('Enter', true);
    for (const width of [1440, 1024, 844, 641, 640, 390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      for (const theme of ['dark', 'light']) {
        await evaluate(`document.documentElement.dataset.theme = '${theme}'`); await settle();
        await checkVisibleCards();
        await checkIndentation();
        if (width >= 1000) assert.equal(await evaluate(`(() => {
          const tops = Array.from(document.querySelectorAll('.timing-device-detail')).map(node => node.getBoundingClientRect().top);
          return Math.max(...tops) - Math.min(...tops) < 1;
        })()`), true, 'Opening and resizing aligns all three closed detail headers');
      }
      const visiblePaint = await captureCards();
      await settle();
      const visibleAlignment = await alignment();
      await toggleOuter(false);
      assert.deepEqual(await alignment(), visibleAlignment,
        `Closing the outer fold does not replace visible alignment (${width}px, ${observerMode})`);
      await send('Emulation.setDeviceMetricsOverride', { width: width === 320 ? 1440 : 320,
        height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate('comparisonPayload.firewoodBenefit.valueEuro = 2.25; comparisonPanel.render(comparisonPayload)');
      await settle();
      if (observerMode === 'delayed') await evaluate('flushResizeDeliveries()');
      assert.deepEqual(await alignment(), visibleAlignment,
        'Resizing and receiving comparison data while closed leave visible alignment intact');
      await toggleOuter(true);
      await checkVisibleCards(['€3.50', '€2.00', '€2.25']);
      await toggleOuter(false);
      await evaluate('comparisonPayload.firewoodBenefit.valueEuro = 1.25; comparisonPanel.render(comparisonPayload)');
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await toggleOuter(true);
      await checkVisibleCards();
      const reopenedPaint = await captureCards();
      if (reopenedPaint !== visiblePaint) {
        writeFileSync(join(artifacts, 'before-reopening.png'), Buffer.from(visiblePaint, 'base64'));
        writeFileSync(join(artifacts, 'after-reopening.png'), Buffer.from(reopenedPaint, 'base64'));
      }
      assert.equal(reopenedPaint === visiblePaint, true,
        `Restoring the same cards after close, hidden refresh and reopen restores their painted contents (${artifacts})`);
      await evaluate("document.querySelectorAll('#timing-benefit details > summary').forEach(summary => summary.click())");
      await toggleOuter(false);
      await toggleOuter(true);
      assert.equal(await evaluate("document.querySelectorAll('#timing-benefit details[open]').length"), 4,
        'Reopening the outer panel preserves every expanded inner fold');
      await checkVisibleCards();
      await checkIndentation();
      if (observerMode === 'native' && (width === 1440 || width === 320)) {
        await evaluate("document.querySelector('.timing-device-detail').scrollIntoView({ block: 'start' })");
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(artifacts, `comparison-expanded-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      await evaluate("document.querySelectorAll('#timing-benefit details > summary').forEach(summary => summary.click())");
      await settle();
    }
    await evaluate(`const mode = document.querySelector('[data-mode="timing"]');
      document.querySelector('.timing-device-detail').open = true; mode.focus(); mode.click();
      comparisonPayload.firewoodBenefit.valueEuro = 2.25; comparisonPanel.render(comparisonPayload);`);
    assert.equal(await evaluate(`document.querySelector('.timing-amount').textContent === '€1.00'
      && document.querySelector('.firewood-card .timing-amount').textContent === '€2.25'
      && document.querySelector('.timing-device-detail').open && document.activeElement.dataset.mode === 'timing'`), true,
    'Comparison selection and refresh retain the active control and open details');
    assert.equal(await evaluate(`(() => {
      const button = document.activeElement, box = button.getBoundingClientRect();
      const bounds = button.closest('.timing-overview-content').getBoundingClientRect();
      const style = getComputedStyle(button), outset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      return box.left - outset >= bounds.left && box.right + outset <= bounds.right
        && box.top - outset >= bounds.top && box.bottom + outset <= bounds.bottom;
    })()`), true, 'The active comparison button and its focus ring stay inside the visible overview');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('.timing-device-detail').open = false"); await settle();
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `comparison-fold-${observerMode}-resize-observer.png`), Buffer.from(shot.data, 'base64'));
    await evaluate('comparisonPanel.close()');
  }
  assert.deepEqual(errors, []);
  console.log(`Comparison browser checks passed through repeated disclosure, hidden refresh and resize cycles with native, missing and delayed ResizeObserver at seven widths in both themes, including outer and nested indentation, native button keyboard activation and zero-sized hidden layout. Synthetic screenshots: ${artifacts}`);
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
