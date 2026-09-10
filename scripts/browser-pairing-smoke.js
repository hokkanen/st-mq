// Isolated UI fixture: actual built HTML, styles and monitor modules, with a
// synthetic pairing API in front of a temporary simulation. No pairing manager,
// broker, virtual IP, household configuration or physical device is used.
// Run `npm run build`, then provide an isolated Firefox BiDi listener as argv[2].
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { seedChartFixture } from './lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-pairing-browser-'));
const screenshots = mkdtempSync(join(tmpdir(), 'stmq-pairing-screenshots-'));
const now = Date.now(), previewId = 'a'.repeat(64);
const actions = [], pending = new Map(), errors = [], prompts = [], measurements = [];
const preview = { previewId, counts: { missing: 12, conflicts: 3, duplicates: 4, skipped: 2 },
  period: { from: now - 8 * 86400_000, to: now - 86400_000 }, model: { status: 'rebuild-required', unsupported: 2 } };
const master = (overrides = {}) => ({ enabled: true, role: 'primary', canControl: true, busy: false,
  peer: { reachable: true, role: 'replica', lastSeenAt: now }, vip: { owned: true, ready: true },
  recovery: { state: 'idle' }, actions: { 'check-recovery': true, recover: false, rejoin: false, handover: true, promote: false },
  ...overrides });
const checked = () => master({ recovery: { state: 'ready', preview },
  actions: { 'check-recovery': true, recover: true, rejoin: true, handover: false, promote: false } });
const standby = role => ({ ...master(), role, canControl: false, vip: { owned: false, ready: true },
  peer: { reachable: true, role: 'primary', lastSeenAt: now }, actions: { promote: true },
  sync: { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000, bytes: 2e6 } });
let pairing = master(), app, proxy, socket, command, ownsBrowser = false, requestId = 0;

try {
  const privatePath = join(directory, 'secrets.json');
  writeFileSync(privatePath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  proxy = createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.url === '/api/pairing' && request.method === 'GET') return json(200, pairing);
      if (request.url === '/api/pairing/action' && request.method === 'POST') {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 4096); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString()); actions.push(body);
        assert(['check-recovery', 'recover', 'rejoin'].includes(body.action), 'Fixture only accepts the tested management actions');
        pairing = { ...pairing, busy: true, uiOperation: { id: body.requestId, action: body.action, state: 'running' },
          recovery: { ...pairing.recovery, state: body.action === 'check-recovery' ? 'checking' : 'recovering' } };
        return json(202, { status: pairing });
      }
      assert.equal(request.method, 'GET', 'No other fixture mutations are allowed');
      const result = await fetch(`${upstream}${request.url}`, { signal: AbortSignal.timeout(10_000) });
      const headers = Object.fromEntries([...result.headers].filter(([key]) =>
        !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      if (request.url === '/api/status') {
        const status = await result.json(); status.pairing = pairing;
        // This projection exercises the live observation label without opening
        // providers: the underlying app and all its stored data stay simulated.
        status.input = 'providers'; status.mode = 'monitoring'; status.liveWrites = false;
        if (pairing.role !== 'primary') {
          status.role = 'replica'; status.instance = { role: 'replica', readOnly: true };
          status.replication = { state: 'ready', generation: 'synthetic-pair-snapshot',
            snapshotAt: now - 60_000, verifiedAt: now - 30_000, lastSuccessAt: now - 30_000, bytes: 2e6 };
        }
        response.writeHead(result.status, headers); response.end(JSON.stringify(status));
      } else { response.writeHead(result.status, headers); response.end(Buffer.from(await result.arrayBuffer())); }
    } catch { if (!response.headersSent) json(500, { error: 'Synthetic browser fixture failure' }); else response.end(); }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  socket = new WebSocket(process.argv[2] ?? 'ws://127.0.0.1:39124/session');
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.type === 'error' ? task.reject(new Error(JSON.stringify(message))) : task.resolve(message.result);
    } else if (message.method === 'log.entryAdded' && message.params.level === 'error') errors.push(message.params.text);
    else if (message.method === 'browsingContext.userPromptOpened') prompts.push(message.params);
  };
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  await command('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: 'ignore' } } }); ownsBrowser = true;
  await command('session.subscribe', { events: ['log.entryAdded', 'browsingContext.userPromptOpened'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('browsingContext.activate', { context });
  const evaluate = async expression => {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`UI did not settle: ${expression}; browser errors: ${JSON.stringify(errors)}`);
  };
  const $ = id => `document.getElementById(${JSON.stringify(id)})`;
  const open = async () => {
    if (!await evaluate(`${$('pairing-details')}.open`)) await evaluate("document.querySelector('#pairing-details > summary').click(); true");
  };
  const close = async () => {
    if (await evaluate(`${$('pairing-details')}.open`)) await evaluate("document.querySelector('#pairing-details > summary').click(); true");
  };
  const checkLayout = async (width, theme) => {
    await command('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await evaluate("document.getElementById('theme-toggle').click(); true");
    await until(`document.documentElement.dataset.theme === '${theme}'`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px ${theme}: no horizontal overflow`);
    assert.equal(await evaluate(`${$('instance-role')}.checkVisibility()`), true, 'Role is visible beside the operating mode');
    assert.equal(await evaluate(`${$('pairing-panel')}.nextElementSibling.contains(${$('events')})`), true, 'Paired computers sits immediately above Event log');
    const height = await evaluate(`${$('pairing-panel')}.getBoundingClientRect().height`);
    measurements.push({ width, theme, closedHeight: height });
    assert(height <= (width >= 1000 ? 90 : 125), `Closed pairing block stays compact: ${height}px at ${width}px`);
    assert.equal(await evaluate(`${$('pairing-check-recovery')}.checkVisibility()`), false, 'Closed disclosure hides controls');
  };
  const capture = async (name, header = false) => {
    await evaluate(header ? 'scrollTo(0, 0); true' : `${$('pairing-panel')}.scrollIntoView({ block: 'start' }); true`);
    const image = await command('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } });
    writeFileSync(join(screenshots, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 });
  };
  const confirmAction = async (button, accept) => {
    const before = prompts.length;
    await evaluate(`setTimeout(() => ${$(button)}.click(), 0); true`);
    for (let attempt = 0; prompts.length === before && attempt < 200; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(prompts.length > before, `${button} requests explicit confirmation`);
    const message = prompts.at(-1).message;
    await command('browsingContext.handleUserPrompt', { context, accept });
    return message;
  };

  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1000 }, devicePixelRatio: 1 });
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${proxy.address().port}`, wait: 'complete' });
  await until(`${$('instance-role')}.textContent === 'MASTER' && !${$('pairing-panel')}.hidden`);
  assert.equal(await evaluate(`${$('connection')}.textContent`), 'LIVE OBSERVATION · MONITORING');
  assert.equal(await evaluate(`${$('pairing-details')}.open`), false, 'Pairing starts folded');
  assert.equal(await evaluate(`${$('error')}.hidden`), true);
  for (const width of [1440, 390]) for (const theme of ['dark', 'light']) await checkLayout(width, theme);
  await capture('mobile-closed');
  await capture('mobile-header', true);

  await evaluate("document.querySelector('#pairing-details > summary').focus(); true");
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'pair-keyboard',
    actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert.equal(await evaluate(`${$('pairing-details')}.open`), true, 'Native disclosure opens with Enter');
  assert.equal(await evaluate(`${$('pairing-check-recovery')}.checkVisibility()`), true);
  assert.equal(await evaluate(`${$('pairing-recover')}.disabled`), true);
  assert.match(await evaluate(`${$('pairing-recover-help')}.textContent`), /check|step 1/i);
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1400 }, devicePixelRatio: 1 });
  await capture('desktop-expanded');
  await capture('desktop-header', true);
  await evaluate(`${$('pairing-recover')}.click(); true`);
  assert.equal(actions.length, 0, 'Disabled recovery does not issue a request');
  pairing = master({ peer: { reachable: false, lastSeenAt: now - 120_000 } });
  await until(`${$('pairing-peer')}.textContent.includes('unavailable')`);
  assert.equal(await evaluate(`${$('pairing-details')}.open`), true, 'Polling preserves the open disclosure');
  pairing = master(); await until(`${$('pairing-peer')}.textContent.includes('connected')`);

  await evaluate(`${$('pairing-check-recovery')}.click(); true`);
  await until(`${$('pairing-recovery')}.textContent.includes('Checking')`);
  assert.equal(actions.length, 1);
  assert.equal(await evaluate(`${$('pairing-recover')}.disabled`), true, 'Running check cannot enable recovery');
  await close();
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true, 'Check progress remains visible when folded');
  pairing = master({ recovery: { state: 'error', error: 'synthetic-unrendered-detail' },
    uiOperation: { id: actions.at(-1).requestId, action: 'check-recovery', state: 'error' } });
  await until(`${$('pairing-attention')}.textContent.length > 0 && ${$('pairing-check-recovery')}.disabled === false`);
  assert.equal(await evaluate(`${$('pairing-recover')}.disabled`), true, 'Failed check cannot enable recovery');
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true, 'Failure remains visible when folded');
  assert.doesNotMatch(await evaluate(`${$('pairing-panel')}.textContent`), /synthetic-unrendered-detail/);
  await open(); await evaluate(`${$('pairing-check-recovery')}.click(); true`);
  await until(`${$('pairing-recovery')}.textContent.includes('Checking')`);
  assert.equal(actions.length, 2);
  pairing = { ...checked(), uiOperation: { id: actions.at(-1).requestId, action: 'check-recovery', state: 'complete' } };
  await until(`${$('pairing-recover')}.disabled === false`);
  assert.equal(await evaluate(`${$('pairing-details')}.open`), true);
  assert.equal(await evaluate(`${$('pairing-preview')}.checkVisibility()`), true);
  assert.match(await evaluate(`${$('pairing-preview')}.textContent`), /12/);
  assert.equal(await evaluate(`${$('pairing-rejoin')}.disabled`), false);
  assert.match(await evaluate(`${$('pairing-rejoin')}.textContent`), /Skip recovery/i);
  assert.match(await confirmAction('pairing-rejoin', false), /discard|delete|lost|replaced/i);
  await until(`${$('pairing-recover')}.disabled === false`);
  assert.equal(actions.length, 2, 'Cancelling skip preserves the checked recovery choice');
  assert.match(await confirmAction('pairing-recover', true), /gap|rebuild/i);
  await until(`${$('pairing-recovery')}.textContent.includes('Recovering')`);
  assert.equal(actions.at(-1).action, 'recover');
  assert.equal(actions.at(-1).previewId, previewId, 'Recovery uses the successfully checked snapshot');
  await close();
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true, 'Recovery progress remains visible when folded');
  pairing = master({ recovery: { state: 'complete', report: { ...preview, imported: 12, model: { status: 'rebuilt' } } },
    actions: { 'check-recovery': true, recover: false, rejoin: true },
    uiOperation: { id: actions.at(-1).requestId, action: 'recover', state: 'complete', progress: { phase: 'publishing', processed: 12 } } });
  await until(`${$('pairing-rejoin')}.textContent === 'Resume mirroring' && !${$('pairing-rejoin')}.disabled`);
  assert.equal(await evaluate(`${$('pairing-phase')}.textContent`), '', 'Completed recovery cannot retain a publishing progress indicator');

  for (const role of ['replica', 'protected']) {
    pairing = role === 'replica' ? { ...standby(role), sync: { state: 'waiting' } } : standby(role);
    await until(`${$('instance-role')}.textContent === '${role === 'replica' ? 'SLAVE' : 'PROTECTED'}'`);
    await open();
    if (role === 'replica') {
      await until(`${$('pairing-syncDetail')}.textContent.includes('Identity verified')`);
      assert.match(await evaluate(`${$('pairing-syncStat')}.textContent`), /Snapshot.*min old/,
        'Durable publication remains visible after the receiver’s in-memory progress restarts');
    }
    assert.equal(await evaluate(`${$('pairing-master-controls')}.checkVisibility()`), false);
    assert.equal(await evaluate(`${$('pairing-slave-controls')}.checkVisibility()`), true);
    for (const id of ['pairing-check-recovery', 'pairing-recover', 'pairing-rejoin', 'pairing-handover'])
      assert.equal(await evaluate(`${$(id)}.checkVisibility()`), false, `${role} hides master control ${id}`);
    assert.equal(await evaluate(`${$('pairing-promote')}.checkVisibility()`), true);
    assert.equal(await evaluate(`${$('replica-notice')}.hidden`), true, 'Paired viewer has no duplicate large banner');
    assert.doesNotMatch(await evaluate(`${$('connection')}.textContent`), /LIVE CONTROL|LIVE OBSERVATION/);
    await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 1000 }, devicePixelRatio: 1 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Expanded slave controls fit mobile width');
    await close();
    if (role === 'protected') assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true);
  }
  pairing = master({ transition: { kind: 'handover', phase: 'quiescing' }, canControl: false });
  await until(`${$('instance-role')}.textContent === 'ROLE CHANGE'`);
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true, 'Role-change progress remains visible when folded');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pairing-browser-smoke-passed', measurements, screenshots,
    checked: ['actual built dashboard', 'role beside operating mode', 'compact desktop/mobile dark/light layout',
      'placement above events', 'keyboard disclosure', 'poll preserves disclosure', 'failed/running checks never enable recovery',
      'successful preview unlocks recovery', 'skip recovery requires explicit discard confirmation',
      'recovery sends checked identity', 'closed progress and failures', 'matching protected/slave layout without master controls'] }));
  await command('browser.close'); ownsBrowser = false;
} finally {
  if (ownsBrowser) { try { await command('browser.close'); } catch {} }
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
