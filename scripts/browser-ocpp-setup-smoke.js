import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';

// A synthetic local application and browser-only setup replies. No cloud account,
// charger, production configuration or household network is contacted.
const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-ui-'));
const pending = new Map(), errors = [];
let app, ws, id = 0, ownsBrowser = false;
const command = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 20_000);
  pending.set(requestId, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
try {
  writeFileSync(join(directory, 'fixture.json'), '{}');
  const config = loadConfig({ STMQ_CONFIG: join(directory, 'fixture.json'), STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => Date.parse('2026-09-07T12:00:00Z') });
  ws = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:39125/session');
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer); pending.delete(message.id);
      message.type === 'error' ? request.reject(new Error(JSON.stringify(message))) : request.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params.level === 'error') errors.push(message.params.text);
  };
  await command('session.new', { capabilities: {} }); ownsBrowser = true;
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.setViewport', { context, viewport: { width: 1100, height: 800 }, devicePixelRatio: 1 });
  await command('script.addPreloadScript', { functionDeclaration: `() => {
    window.setupFixture = { state: 'needs-endpoint', reason: 'endpoint-required', endpointSource: null,
      canAdopt: false, revision: null, busy: false };
    window.setupRequests = []; window.localAvailable = false; window.fixtureReadOnly = false;
    const original = window.fetch;
    window.fetch = async (input, options) => {
      const path = String(input);
      if (path.endsWith('/api/charging/ocpp-setup')) {
        window.setupRequests.push(JSON.parse(options.body));
        await new Promise(resolve => { window.finishSetup = resolve; });
        window.setupFixture = { state: 'connecting', reason: 'waiting-connection', endpointSource: 'pairing-vip' };
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
  }` });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
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
  const local = '[data-provider=electricity] .provider-local-connection';
  const button = `${local} .provider-local-adopt`;
  const setupLabel = `${local} [data-local-connection=setup]`;
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${app.server.address().port}`, wait: 'complete' });
  await until(`document.querySelector('${setupLabel}')?.textContent === 'Address needed'`);
  assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Available');
  assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
  await evaluate("document.querySelector('[data-provider=electricity] details').open = true; true");
  assert.match(await evaluate(`document.querySelector('${local}').textContent`), /standalone address.*apply configuration/);
  assert.match(await evaluate(`document.querySelector('${local} .provider-local-outage').textContent`), /If the controller stops.*crash or power loss.*waiting for approval.*Restart the controller/);
  for (const [reason, label] of [['native-control-unavailable', 'Activation pending'],
    ['cloud-schedule-active', 'Waiting for cloud schedule'], ['control-transition-pending', 'Control handover pending']]) {
    await evaluate(`window.setupFixture = {state:'blocked', reason:${JSON.stringify(reason)}, endpointSource:'pairing-vip', canAdopt:false}; true`);
    await refresh(); await until(`document.querySelector('${setupLabel}').textContent === ${JSON.stringify(label)}`);
    assert.equal(await evaluate(`document.querySelector('${setupLabel}').dataset.state`), 'pending');
    assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true);
    assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Available');
  }
  await evaluate("window.setupFixture = { state: 'blocked', reason: 'foreign-configuration', endpointSource: 'pairing-vip', canAdopt: true, revision: 'a'.repeat(64) }; true");
  await refresh(); await until(`!document.querySelector('${button}').hidden`);
  await evaluate(`document.querySelector('${button}').click(); true`);
  await until("Boolean(document.querySelector('.confirmation-dialog[open]'))");
  assert.equal(await evaluate('document.activeElement.textContent'), 'Cancel');
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /Native OCPP takes over charging authorization and schedules/);
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /crash or power loss.*wait for approval/);
  await evaluate("document.querySelector('.confirmation-dialog .secondary-button').click(); true");
  assert.equal(await evaluate('window.setupRequests.length'), 0);
  // A refreshed remote revision while the confirmation is open invalidates it.
  await evaluate(`document.querySelector('${button}').click(); window.setupFixture.revision = 'b'.repeat(64); true`);
  await refresh();
  await until("document.querySelector('.confirmation-dialog[open]') && document.querySelector('[data-provider=electricity] .provider-local-adopt')");
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
  await evaluate("window.localAvailable = true; window.setupFixture = { state: 'ready', endpointSource: 'pairing-vip' }; true");
  await refresh(); await until(`document.querySelector('${setupLabel}').textContent === 'Setup complete'`);
  assert.equal(await evaluate(`document.querySelector('${local} [data-local-connection=readings]').textContent`), 'Available');
  assert.equal(await evaluate(`document.querySelector('${local} .provider-local-message').textContent`), '', 'Confirmed setup replaces the earlier waiting notice');
  mkdirSync('var', { recursive: true });
  for (const width of [1100, 320]) {
    await command('browsingContext.setViewport', { context, viewport: { width, height: 800 }, devicePixelRatio: 1 });
    await new Promise(resolve => setTimeout(resolve, 200));
    await evaluate(`document.querySelector('${local}').scrollIntoView({block:'start', behavior:'instant'}); true`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const element = await command('script.evaluate', { expression: `document.querySelector('${local}')`,
      target: { context }, awaitPromise: true });
    const shot = await command('browsingContext.captureScreenshot', { context, origin: 'document',
      clip: { type: 'element', element: { sharedId: element.result.sharedId } } });
    writeFileSync(`var/ocpp-setup-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  await evaluate("window.setupFixture = { state: 'blocked', reason: 'foreign-configuration', canAdopt: true, revision: 'a'.repeat(64) }; window.fixtureReadOnly = true; true");
  await refresh(); await until(`document.querySelector('${setupLabel}').textContent === 'Setup needs attention'`);
  assert.equal(await evaluate(`document.querySelector('${button}').hidden`), true, 'Read-only history cannot adopt a charger connection');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'ocpp-setup-browser-smoke-passed', checks: [
    'setup-and-reading-status-independent', 'endpoint-guidance', 'pending-native-and-cloud-handover', 'confirmation-cancel', 'revision-change-during-confirmation',
    'adoption-busy-and-actual-revision', 'confirmed-local-readings', 'desktop-and-320px', 'read-only-action-hidden' ] }));
  await command('browser.close', {}); ownsBrowser = false;
} finally {
  if (ownsBrowser) { try { await command('browser.close', {}); } catch {} }
  ws?.close(); for (const entry of pending.values()) clearTimeout(entry.timer);
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
