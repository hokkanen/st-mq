// Synthetic recovery API fixture: checks the isolated page without starting a
// controller, loading installation configuration, or contacting any equipment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryPage } from '../../src/app/configuration-recovery-page.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-recovery-browser-'));
const screenshots = process.env.STMQ_RECOVERY_SCREENSHOT_DIR;
const csrfToken = 'fixture-recovery-csrf', nonce = 'fixture-recovery-nonce';
const accessKey = 'fixture-recovery-access-key';
const prefix = '/fixture/ingress/';
const requests = [], errors = [], layouts = [], pending = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let environment = 'home-assistant', failApply = false, sequence = 0, browser, socket, receipt = null, missingSlug = false;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'`);
  const reply = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.url === prefix) {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(recoveryPage({ csrfToken, environment, nonce }));
    return;
  }
  if (!request.url.startsWith(`${prefix}api/recovery`)) { response.writeHead(404).end(); return; }
  let text = '';
  for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : null;
  requests.push({ url: request.url, method: request.method, body });
  if (environment === 'linux' && request.headers.authorization !== `Bearer ${accessKey}`) { reply(401, { error: 'Access required.' }); return; }
  if (request.method === 'POST' && request.headers['x-recovery-csrf'] !== csrfToken) { reply(403, { error: 'Review access expired.' }); return; }
  if (request.url === `${prefix}api/recovery`) {
    reply(200, {
      environment, error: receipt ? '' : 'Unknown configuration field in easee: [unsupported field].', receipt,
      privatePath: '/fixture/private/configuration/secrets.json', importPath: '/config/secrets.json',
      externalImportPath: missingSlug ? null : '/addon_configs/fixture_home_energy/secrets.json',
    });
  } else if (request.url.endsWith('/preview')) {
    if (environment === 'home-assistant' && !body.replacement) {
      reply(400, { error: 'Unknown configuration field in easee: [unsupported field].' }); return;
    }
    reply(200, {
      reviewId: 'fixture-review-id', replacement: body.replacement,
      changes: [
        { path: 'controller.max_drop_c', before: 1.5, after: 0.75 },
        { path: 'mqtt.pw', before: 'fixture-private-value-before', after: 'fixture-private-value-after', redacted: true },
        { path: 'equipment.devices.<img src=x onerror=globalThis.fixtureInjected=true>', before: null, after: ['fixture-value-with-a-long-name-that-must-fit-within-the-review-on-a-phone'] },
      ],
    });
  } else if (request.url.endsWith('/apply')) {
    if (failApply) reply(409, { error: 'Configuration changed after review. Check and review again.' });
    else {
      receipt = { saved: true, at: Date.now(), message: 'The reviewed configuration is ready. Restart to continue.',
        backupPath: environment === 'home-assistant' ? '/data/configuration-backups/fixture-private-backup.json' : null };
      reply(200, receipt);
    }
  } else reply(404, { error: 'Not found.' });
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = join(directory, 'chromium');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
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
    for (let attempt = 0; attempt < 150; attempt++) {
      try { if (await evaluate(`Boolean(document.body && (${expression}))`)) return; }
      catch (error) {
        if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error;
      }
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; browser exceptions: ${errors.length}`);
  };
  const click = id => evaluate(`document.getElementById('${id}').click();true`);
  const preview = async () => {
    await click('check');
    await until("!document.getElementById('check').disabled && !document.getElementById('review').hidden");
  };
  const keyPress = async key => {
    const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], Tab: ['Tab', 9] }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
      ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
  };
  const capture = async name => {
    await evaluate("document.getElementById('review').scrollIntoView({block:'start',behavior:'instant'});true");
    const geometry = await evaluate(`(() => {
      const panel = document.getElementById('review'), box = panel.getBoundingClientRect();
      return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,
        escapes:[...document.querySelectorAll('main button,main input,main code,main table,main th,main td')]
          .filter(node=>node.checkVisibility()).filter(node=>{
            const rect=node.getBoundingClientRect();return rect.x < -1 || rect.right > innerWidth + 1;
          }).map(node=>node.id||node.tagName),reviewWidth:box.width};
    })()`);
    layouts.push({ name, ...geometry });
    assert(geometry.pageWidth <= geometry.viewport + 1, `${name}: document fits the viewport`);
    assert.deepEqual(geometry.escapes, [], `${name}: controls, paths and values remain inside viewport`);
    if (screenshots) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(screenshots, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
  };

  await send('Runtime.enable'); await send('Page.enable');
  const url = `http://127.0.0.1:${server.address().port}${prefix}`;
  await send('Page.navigate', { url });
  await until("document.getElementById('configuration') && !document.getElementById('configuration').hidden");
  assert.equal(await evaluate("document.getElementById('access-panel').hidden"), true, 'HA does not ask for Linux access key');
  assert.equal(await evaluate("document.getElementById('external-import-path').textContent"),
    '/addon_configs/fixture_home_energy/secrets.json', 'Recovery shows the file-tool upload path and complete JSON filename');
  assert.equal(await evaluate("document.getElementById('import-path').textContent"), '/config/secrets.json',
    'The in-container import path remains distinct from the upload path');
  missingSlug = true;
  await send('Page.navigate', { url });
  await until("document.getElementById('configuration') && !document.getElementById('configuration').hidden");
  assert.equal(await evaluate("document.getElementById('external-import-path').textContent"),
    '/addon_configs/<actual-app-slug>/secrets.json', 'Missing slug uses the same external mount in its placeholder');
  missingSlug = false;
  await send('Page.navigate', { url });
  await until("document.getElementById('configuration') && !document.getElementById('configuration').hidden");
  assert.equal(await evaluate("document.querySelector('input[name=\"import-mode\"]:checked').value"), 'merge');
  await click('check');
  await until("!document.getElementById('check').disabled && document.getElementById('receipt').classList.contains('error')");
  assert.equal(await evaluate('document.activeElement.id'), 'receipt', 'Validation failure receives keyboard focus');
  assert.equal(await evaluate("document.getElementById('review').hidden"), true);
  assert.equal(requests.at(-1).body.replacement, false, 'First review uses merge rather than implicit replacement');
  const beforeReplace = requests.length;
  await evaluate("document.querySelector('input[value=replace]').click();true");
  assert.equal(requests.length, beforeReplace, 'Selecting replacement has no side effects');
  assert.equal(await evaluate("document.getElementById('replace-note').hidden"), false);
  await preview();
  assert.equal(requests.at(-1).body.replacement, true);
  assert.equal(await evaluate('document.activeElement.id'), 'review-title');
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'cancel');
  await keyPress('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'apply');
  assert.doesNotMatch(await evaluate("document.getElementById('review').textContent"), /fixture-private-value/);
  assert.equal(await evaluate("document.querySelectorAll('#changes img').length"), 0, 'Field names render as text');
  assert.equal(await evaluate('Boolean(globalThis.fixtureInjected)'), false);
  assert.match(await evaluate("document.getElementById('review-scope').textContent"), /replaces all saved app settings/);
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await click('theme-toggle');
    await capture(`ha-review-${width}-${theme}`);
  }
  const applies = () => requests.filter(request => request.url.endsWith('/apply')).length;
  await click('cancel');
  assert.equal(applies(), 0, 'Cancellation never saves');
  assert.equal(await evaluate('document.activeElement.id'), 'check');
  await preview();
  await evaluate("document.querySelector('input[value=merge]').click();true");
  assert.equal(await evaluate("document.getElementById('review').hidden"), true, 'Changing import mode invalidates visible review');
  await evaluate("document.querySelector('input[value=replace]').click();true");
  await preview(); failApply = true;
  await click('apply');
  await until("!document.getElementById('check').disabled && /changed after review/.test(document.getElementById('receipt').textContent)");
  assert.equal(await evaluate("document.getElementById('review').hidden"), true, 'Stale reviews cannot be resubmitted');
  assert.equal(await evaluate("document.getElementById('complete').hidden"), true);
  failApply = false; await preview(); await click('apply');
  await until("!document.getElementById('complete').hidden");
  assert.match(await evaluate("document.getElementById('restart-note').textContent"), /Home Assistant.*Restart/);
  assert.equal(await evaluate('document.activeElement.id'), 'complete-title');
  assert.equal(applies(), 2);
  assert.match(await evaluate("document.getElementById('backup-path').textContent"), /fixture-private-backup/);
  await send('Page.navigate', { url });
  await until("document.getElementById('complete') && !document.getElementById('complete').hidden");
  assert.match(await evaluate("document.getElementById('receipt').textContent"), /Configuration saved/,
    'Refresh restores the saved action receipt');
  assert.equal(await evaluate("document.getElementById('problem').hidden"), true, 'Successful recovery no longer shows a startup error');
  receipt.at -= 24 * 60 * 60 * 1000 + 1000;
  await send('Page.navigate', { url });
  await until("document.getElementById('configuration') && !document.getElementById('configuration').hidden");
  assert.equal(await evaluate("document.getElementById('complete').hidden"), true, 'Receipts expire after 24 hours');

  environment = 'linux'; receipt = null;
  const beforeLinux = requests.length;
  await send('Page.navigate', { url });
  await until("document.getElementById('access-panel') && !document.getElementById('access-panel').hidden");
  assert.equal(requests.length, beforeLinux, 'Linux requests no private configuration before key entry');
  assert.doesNotMatch(await evaluate('document.body.textContent'), /fixture\/private/);
  await evaluate("document.getElementById('access-key').value='fixture-wrong-key';document.getElementById('access-form').requestSubmit();true");
  await until("/not accepted/.test(document.getElementById('receipt').textContent)");
  assert.equal(await evaluate("document.getElementById('configuration').hidden"), true);
  await evaluate(`document.getElementById('access-key').value=${JSON.stringify(accessKey)};document.getElementById('access-form').requestSubmit();true`);
  await until("!document.getElementById('configuration').hidden");
  assert.equal(await evaluate("document.getElementById('access-key').value"), '', 'Key entry is cleared after authorization');
  assert.equal(await evaluate("document.getElementById('ha-instructions').hidden"), true);
  assert.match(await evaluate("document.getElementById('private-path').textContent"), /fixture\/private\/configuration/);
  assert.equal(await evaluate("JSON.stringify({...localStorage,...sessionStorage}).includes('fixture-recovery-access-key')"), false, 'Access key is not persisted in browser storage');
  await preview();
  assert.equal(requests.at(-1).body.replacement, false, 'Linux never requests saved-option replacement');
  assert.match(await evaluate("document.getElementById('apply').textContent"), /Confirm/);
  assert.equal(await evaluate("document.getElementById('before-heading').textContent"), 'Default', 'Linux comparison baseline is labeled honestly');
  for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await click('theme-toggle');
    await capture(`linux-review-${width}-${theme}`);
  }
  await click('apply');
  await until("!document.getElementById('complete').hidden");
  assert.match(await evaluate("document.getElementById('restart-note').textContent"), /service or command/);
  assert(requests.every(request => request.url.startsWith(`${prefix}api/recovery`)), 'All requests preserve ingress path');
  assert.deepEqual(errors, [], 'No uncaught browser errors under nonce-only CSP');
  if (screenshots) await writeFile(join(screenshots, 'geometry.json'), JSON.stringify(layouts, null, 2));
  console.log('Configuration recovery browser checks passed: HA ingress paths, explicit replacement, validation/stale failures, redaction, keyboard focus, Linux key access, environment guidance, restart receipts and 320/390/1440px in both themes.');
} finally {
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
