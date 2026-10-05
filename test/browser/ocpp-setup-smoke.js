import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

// A synthetic local application and browser-only setup replies. No cloud account,
// charger, production configuration or household network is contacted.
const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-ui-'));
const artifacts = mkdtempSync(join(tmpdir(), 'stmq-ocpp-screenshots-'));
const pending = new Map(), errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, ws, id = 0;
const command = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
  pending.set(requestId, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
try {
  writeFileSync(join(directory, 'fixture.json'), '{}', {mode:0o600});
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'fixture.json'), STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => Date.parse('2026-09-07T12:00:00Z') });
  const profile = join(directory, 'chrome');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], {stdio:'ignore'});
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Disposable Chromium listener starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method:'PUT'}).then(response => response.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  await command('Page.enable'); await command('Runtime.enable');
  await command('Emulation.setDeviceMetricsOverride', {width:1100, height:800, deviceScaleFactor:1, mobile:false});
  await command('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
    window.setupFixture = { state: 'needs-endpoint', reason: 'endpoint-required', endpointSource: null,
      canAdopt: false, revision: null, busy: false };
    window.setupRequests = []; window.localAvailable = false; window.fixtureReadOnly = false;
    const original = window.fetch;
    window.fetch = async (input, options) => {
      const path = String(input);
      if (path.endsWith('/api/charging/ocpp-setup')) {
        window.setupRequests.push(JSON.parse(options.body));
        await new Promise(resolve => { window.finishSetup = resolve; });
        window.setupFixture = { state: 'connecting', reason: 'waiting-connection', endpointSource: 'pair-vip' };
        return new Response(JSON.stringify({ setup: window.setupFixture }), { status: 200 });
      }
      const response = await original(input, options);
      if (!path.endsWith('/api/status')) return response;
      const status = await response.json();
      const current = { qualityIssues: [], error: null, lastSuccessAt: status.now };
      status.providers = { easee: { status: 'ok', currentReadings: { charger: current, property: current },
        localOcpp: { configured: true, connected: window.localAvailable, available: window.localAvailable, setup: window.setupFixture } } };
      status.readOnly = window.fixtureReadOnly;
      return new Response(JSON.stringify(status), { status: 200 });
    };
  })()` });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let n = 0; n < 150; n++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}`);
  };
  const refresh = () => evaluate("window.dispatchEvent(new Event('online')); true");
  const local = '#charging-setup-ocpp .provider-local-connection';
  const button = `${local} .provider-local-adopt`;
  const setupLabel = `${local} [data-local-connection=setup]`;
  const endpointText = `${local} .provider-local-endpoint`;
  await command('Page.navigate', {url:`http://127.0.0.1:${app.server.address().port}`});
  await until(`document.querySelector('${setupLabel}')?.textContent === 'Address needed'`);
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Available');
  assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
  await evaluate(`for (let node = document.querySelector('${local}'); node; node = node.parentElement)
    if (node.tagName === 'DETAILS') node.open = true; true`);
  assert.equal(await evaluate("document.querySelectorAll('.provider-local-connection').length"), 1,
    'The native setup action has one owner in Charging under Data & settings');
  await evaluate(`document.querySelector('${local}').open = true; true`);
  assert.match(await evaluate(`document.querySelector('${local}').textContent`), /No unambiguous local address could be detected.*easee\.local_ocpp\.server_url.*apply configuration/);
  assert.match(await evaluate(`document.querySelector('${local} .provider-local-outage').textContent`), /If the controller stops.*shutdown, restart and paired handover keep local OCPP enabled.*wait for authorization.*Restart the controller/);
  for (const [endpointSource, endpoint, label] of [
    ['detected', 'ws://192.0.2.10:9001/ocpp', 'Detected standalone address'],
    ['configured', 'wss://charger.example.invalid/ocpp', 'Configured standalone address'],
    ['pair-vip', 'ws://192.0.2.30:9001/ocpp', 'Paired virtual address'],
  ]) {
    const fixture = { state: 'connecting', reason: 'waiting-connection', endpointSource, endpoint, canAdopt: false };
    await evaluate(`window.setupFixture = ${JSON.stringify(fixture)}; true`);
    await refresh(); await until(`document.querySelector('${endpointText}').textContent.startsWith(${JSON.stringify(`${label}: ${endpoint}.`)})`);
    assert.equal(await evaluate(`document.querySelector('${local} [data-local-connection=readings]').textContent`), 'Waiting for connection');
    assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
    if (endpointSource === 'detected') {
      assert.match(await evaluate(`document.querySelector('${local} .provider-local-help').textContent`), /cannot reach this address.*easee\.local_ocpp\.server_url.*detect the address after a network change/);
    }
  }
  for (const [endpointSource, endpoint, label] of [
    ['configured', 'ws://synthetic-private:secret@192.0.2.10:9001/ocpp', 'Configured standalone address'],
    ['detected', 'ws://192.0.2.10:9001/ocpp/synthetic-private', 'Detected standalone address'],
    ['configured', 'wss://charger.example.invalid/ocpp?token=synthetic-private', 'Configured standalone address'],
    ['pair-vip', 'ws://192.0.2.30:9001/ocpp#synthetic-private', 'Paired virtual address'],
    ['synthetic-private', 'ws://synthetic-private.invalid/ocpp', 'Address unavailable'],
  ]) {
    // Each iteration changes the label so the wait confirms a completed refresh.
    const fixture = { state: 'connecting', reason: 'waiting-connection', endpointSource, endpoint, canAdopt: false };
    await evaluate(`window.setupFixture = ${JSON.stringify(fixture)}; true`);
    await refresh(); await until(`document.querySelector('${endpointText}').textContent.startsWith(${JSON.stringify(`${label}.`)})`);
    assert.doesNotMatch(await evaluate(`document.querySelector('${local}').textContent`), /synthetic-private|secret@/);
  }
  for (const [reason, label] of [['native-control-unavailable', 'Activation pending'],
    ['cloud-schedule-active', 'Waiting for cloud schedule'], ['control-transition-pending', 'Control handover pending']]) {
    await evaluate(`window.setupFixture = {state:'blocked', reason:${JSON.stringify(reason)}, endpointSource:'pair-vip', canAdopt:false}; true`);
    await refresh(); await until(`document.querySelector('${setupLabel}').textContent === ${JSON.stringify(label)}`);
    assert.equal(await evaluate(`document.querySelector('${setupLabel}').dataset.state`), 'pending');
    assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
    assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Available');
  }
  await evaluate("window.setupFixture = { state: 'blocked', reason: 'foreign-configuration', endpointSource: 'pair-vip', canAdopt: true, revision: 'a'.repeat(64) }; true");
  await refresh(); await until(`!document.querySelector('${button}').hidden`);
  await evaluate(`document.querySelector('${button}').click(); true`);
  await until("Boolean(document.querySelector('.confirmation-dialog[open]'))");
  assert.equal(await evaluate('document.activeElement.textContent'), 'Cancel');
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /Native OCPP takes over charging authorization and schedules/);
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /Stopping or restarting this application keeps OCPP enabled.*wait for authorization.*disabling Direct OCPP/);
  await evaluate("document.querySelector('.confirmation-dialog .secondary-button').click(); true");
  await until("!document.querySelector('.confirmation-dialog')");
  assert.equal(await evaluate('window.setupRequests.length'), 0);
  // A refreshed remote revision while the confirmation is open invalidates it.
  await evaluate(`document.querySelector('${button}').click(); window.setupFixture.revision = 'b'.repeat(64); true`);
  await refresh();
  await until("Boolean(document.querySelector('.confirmation-dialog[open]') && document.querySelector('#charging-setup-ocpp .provider-local-adopt'))");
  await new Promise(resolve => setTimeout(resolve, 150));
  await evaluate("document.querySelector('.confirmation-dialog button:last-child').click(); true");
  await until(`document.querySelector('${local} .provider-local-message').textContent.includes('changed')`);
  assert.equal(await evaluate('window.setupRequests.length'), 0);
  await evaluate(`document.querySelector('${button}').click(); true`);
  await until("Boolean(document.querySelector('.confirmation-dialog[open]'))");
  await evaluate("document.querySelector('.confirmation-dialog button:last-child').click(); true");
  await until('window.setupRequests.length === 1');
  assert.equal(await evaluate(`document.querySelector('${button}').disabled`), true);
  assert.equal(await evaluate('JSON.stringify(window.setupRequests[0])'), JSON.stringify({ action: 'adopt', revision: 'b'.repeat(64) }));
  await evaluate('window.finishSetup(); true');
  await until(`document.querySelector('${setupLabel}').textContent === 'Waiting for connection'`);
  assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
  await evaluate("window.localAvailable = true; window.setupFixture = { state: 'ready', endpointSource: 'detected', endpoint: 'ws://192.0.2.10:9001/ocpp' }; true");
  await refresh(); await until(`document.querySelector('${setupLabel}').textContent === 'Setup complete'`);
  assert.equal(await evaluate(`document.querySelector('${local} [data-local-connection=readings]').textContent`), 'Available');
  assert.equal(await evaluate(`document.querySelector('${local} .provider-local-message').textContent`), '', 'Confirmed setup replaces the earlier waiting notice');
  for (const width of [1100, 320]) for (const theme of ['dark', 'light']) {
    await command('Emulation.setDeviceMetricsOverride', {width, height:800, deviceScaleFactor:1, mobile:false});
    await evaluate(`document.documentElement.dataset.theme = '${theme}'`);
    await pause(200);
    await evaluate(`document.querySelector('${local}').scrollIntoView({block:'start', behavior:'instant'}); true`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const overflow = await evaluate(`(() => {const root = document.querySelector('${local}'), box = root.getBoundingClientRect();
      return Array.from(root.querySelectorAll('*')).filter(node => {
        if (!node.checkVisibility()) return false;
        const bounds = node.getBoundingClientRect();
        return bounds.left < box.left - 1 || bounds.right > box.right + 1 || node.scrollWidth > node.clientWidth + 1;
      }).map(node => node.className || node.tagName);})()`);
    assert.deepEqual(overflow, [], 'Every native setup field and explanation fits its disclosure');
    // Include the surrounding dashboard without Chrome's offset tall-element clips.
    const shot = await command('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
    writeFileSync(join(artifacts, `ocpp-setup-${width}-${theme}.png`), Buffer.from(shot.data, 'base64'));
  }
  await evaluate("window.setupFixture = { state: 'blocked', reason: 'foreign-configuration', canAdopt: true, revision: 'a'.repeat(64) }; window.fixtureReadOnly = true; true");
  await refresh(); await until(`document.querySelector('${setupLabel}').textContent === 'Setup needs attention'`);
  assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true, 'Read-only history cannot adopt a charger connection');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ocpp-setup-browser-smoke-passed', artifacts, checks: [
    'setup-and-reading-status-independent', 'endpoint-ambiguity-guidance', 'detected-configured-and-pair-addresses', 'invalid-and-sensitive-endpoints-hidden',
    'pending-native-and-cloud-handover', 'confirmation-cancel', 'revision-change-during-confirmation',
    'adoption-busy-and-actual-revision', 'confirmed-local-readings', 'single-native-setup-owner', 'desktop-and-320px-both-themes', 'read-only-action-hidden' ] }));
} finally {
  ws?.close(); for (const entry of pending.values()) clearTimeout(entry.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, {recursive:true, force:true, maxRetries:10, retryDelay:100});
}
