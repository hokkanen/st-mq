// Isolated UI fixture: actual built HTML, styles and monitor modules, with a
// synthetic pair API in front of a temporary simulation. No pair manager,
// broker, virtual IP, household configuration or physical device is used.
// Run `npm run build`, then provide an isolated Firefox BiDi listener as argv[2].
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startReplica } from '../../src/app/replica.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { seedChartFixture } from '../../scripts/lib/chart-fixture.js';

const directory = mkdtempSync(join(tmpdir(), 'stmq-pairing-browser-'));
const screenshots = mkdtempSync(join(tmpdir(), 'stmq-pairing-screenshots-'));
const now = Date.now(), previewId = 'a'.repeat(64), resetToken = 'b'.repeat(64);
const actions = [], pending = new Map(), errors = [], prompts = [], measurements = [];
const preview = { previewId, status: 'checked', tables: [{ name: 'observations', count: 21 }], model: { status: 'not-assessed' } };
const master = (overrides = {}) => {
  const view = { role: 'master', canControl: true, busy: false,
    peer: { reachable: true, role: 'slave', lastSeenAt: now }, vip: { owned: true, ready: true },
    mqttFrontend: { listening: true, ready: true, connections: 3, error: null },
    recovery: { state: 'idle' }, reset: { token: resetToken }, ...overrides };
  return { ...view, actions: { 'check-recovery': view.peer.reachable === true && view.peer.role !== 'master',
    recover: false, rejoin: false, handover: view.peer.reachable === true && view.peer.role === 'slave',
    promote: false, reset: true, ...overrides.actions } };
};
const checked = () => master({ peer: { reachable: true, role: 'protected', lastSeenAt: now },
  recovery: { state: 'ready', donorRole: 'protected', preview },
  actions: { 'check-recovery': true, recover: true, rejoin: true, handover: false, promote: false } });
const standby = role => ({ ...master(), role, canControl: false, vip: { owned: false, ready: true },
  mqttFrontend: { listening: false, ready: false, connections: 0, error: null },
  peer: { reachable: true, role: 'master', lastSeenAt: now }, actions: { promote: true },
  sync: { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000, bytes: 2e6 } });
let sectionUnavailable = false;
const failedReads = new Set();
let delayedRead;
let topology = 'pair', pair = master(), app, viewer, proxy, socket, command, ownsBrowser = false, requestId = 0;

try {
  const privatePath = join(directory, 'secrets.json');
  writeFileSync(privatePath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory,
    STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config, clock: () => now });
  seedChartFixture(app.store, now);
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  const dbPath = await app.store.backup(join(directory, 'replica.sqlite'));
  const bytes = readFileSync(dbPath);
  const publication = { dbPath, generation: 'synthetic-pair-snapshot', sourceAt: now,
    verifiedAt: now, sourceStartedAt: now - 1000, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  viewer = await startReplica({ config: { ...config, topology: 'mirror', role: 'slave', mirror: { directory } }, clock: () => now,
    readPublication: () => publication, installSignalHandlers: false });
  let readOnlyUpstream = `http://127.0.0.1:${viewer.server.address().port}`;
  proxy = createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      if (delayedRead?.path === path) {
        const delayed = delayedRead; delayedRead = undefined; delayed.started();
        await delayed.release;
        return json(503, { error: 'Synthetic delayed read failure' });
      }
      if (failedReads.has(path)) return json(503, { error: 'Synthetic read unavailable' });
      if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.url === '/api/pair' && request.method === 'GET') return json(200, topology === 'pair' ? pair : null);
      if (request.url === '/api/history-recovery' && request.method === 'GET') return json(200, {
        available: pair.canControl === true, readOnly: pair.canControl !== true, busy: pair.busy === true,
        sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer', available: pair.actions?.['check-recovery'] === true }],
        operations: [], preview: pair.recovery?.preview ?? null, peer: pair,
        job: pair.uiOperation ? { ...pair.uiOperation, requestId: pair.uiOperation.id,
          kind: pair.uiOperation.action === 'check-recovery' ? 'check' : pair.uiOperation.action,
          status: pair.uiOperation.state, source: { id: 'peer' }, result: pair.recovery?.report } : null,
      });
      if (['/api/pair/action', '/api/history-recovery/action'].includes(request.url) && request.method === 'POST') {
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; assert(bytes <= 4096); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (request.url === '/api/history-recovery/action') { assert.equal(body.sourceId, 'peer'); if (body.action === 'check') body.action = 'check-recovery'; }
        actions.push(body);
        assert(['check-recovery', 'recover', 'rejoin', 'reset'].includes(body.action), 'Fixture only accepts the tested management actions');
        if (body.action === 'reset') {
          assert.equal(body.resetToken, resetToken); assert.equal(body.confirmed, true);
          if (body.mode === 'fresh') assert.equal(body.restorationConfirmed, true);
          pair = { ...standby(body.mode === 'keep' ? 'protected' : 'slave'), reason: body.mode === 'keep' ? 'pairing_reset' : null,
            reset: { token: resetToken, lastResult: { mode: body.mode, completedAt: Date.now(), archiveDirectory: '/config/st-mq/reset-archives/synthetic-reset',
              backupCount: 1, unavailableCount: 0, unavailableReasons: [] } },
            actions: { promote: true, reset: true }, uiOperation: { id: body.requestId, action: 'reset', state: 'complete' } };
          return json(200, { status: pair });
        }
        pair = { ...pair, busy: true, uiOperation: { id: body.requestId, action: body.action, state: 'running' },
          recovery: { ...pair.recovery, state: body.action === 'check-recovery' ? 'checking' : 'recovering' } };
        return json(202, request.url === '/api/pair/action' ? { status: pair } : { available: true, busy: true, readOnly: false, peer: pair, sources: [{ id: 'peer', kind: 'peer', label: 'Paired computer' }], preview: pair.recovery.preview ?? null, operations: [], job: { id: body.requestId, requestId: body.requestId, kind: body.action === 'check-recovery' ? 'check' : body.action, status: 'running', source: { id: 'peer' } } });
      }
      assert.equal(request.method, 'GET', 'No other fixture mutations are allowed');
      const result = await fetch(`${pair.role === 'master' ? upstream : readOnlyUpstream}${request.url}`, { signal: AbortSignal.timeout(10_000) });
      const headers = Object.fromEntries([...result.headers].filter(([key]) =>
        !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      if (request.url === '/api/status') {
        const status = await result.json(); status.topology = topology; status.pair = topology === 'pair' ? pair : null;
        if (topology === 'mirror' && pair.role === 'master') status.sync = { state: 'ready',
          sourceAt: now - 60_000, verifiedAt: now - 30_000, lastSuccessAt: now - 30_000 };
        if (sectionUnavailable && pair.role !== 'master') {
          status.charging = { available: false, readOnly: true, settings: null, controls: null, chargers: [], vehicleFeeds: [], error: 'Saved charging data unavailable' };
          status.readView.settingsError = 'Saved Home settings unavailable';
          status.readView.configurationMessage = 'Saved Home settings unavailable. Shown defaults come from this computer.';
          status.garage.errors = [{ section: 'manual-mode', message: 'Saved Garage room setting unavailable' }];
          status.garage.error = 'Some saved Garage data is unavailable. Other recorded data remains readable.';
        }
        if (pair.role === 'master') { status.input = 'providers'; status.automation = { home: { enabled: false }, garage: { enabled: false } }; }
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
  const checkLayout = async (width, theme, attention = false) => {
    await command('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await evaluate("document.getElementById('theme-toggle').click(); true");
    await until(`document.documentElement.dataset.theme === '${theme}'`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${width}px ${theme}: no horizontal overflow`);
    assert.equal(await evaluate(`${$('instance-role')}.checkVisibility()`), true, 'Role is visible beside the operating mode');
    assert.equal(await evaluate(`${$('pairing-panel')}.nextElementSibling.contains(${$('events')})`), true, 'Paired computers sits immediately above Event log');
    const height = await evaluate(`${$('pairing-panel')}.getBoundingClientRect().height`);
    measurements.push({ width, theme, closedHeight: height });
    const heightLimit = (width >= 1000 ? 90 : 125) + (attention ? 50 : 0);
    assert(height <= heightLimit, `Closed pair block stays compact: ${height}px at ${width}px`);
    assert.equal(await evaluate(`${$('pairing-history-recovery')}.checkVisibility()`), false, 'Closed disclosure hides controls');
  };
  const capture = async (name, header = false, element = null) => {
    await evaluate(header ? 'scrollTo(0, 0); true' : `${$(element ?? 'pairing-panel')}.scrollIntoView({ block: 'start' }); true`);
    const image = await command('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } });
    writeFileSync(join(screenshots, `${name}.png`), Buffer.from(image.data, 'base64'), { mode: 0o600 });
  };
  const confirmAction = async (button, accept, screenshot = null) => {
    await evaluate(`${$(button)}.click(); true`);
    await until("document.querySelector('.confirmation-dialog[open]') !== null");
    const message = await evaluate("document.getElementById('confirmation-description').textContent");
    if (screenshot) await capture(screenshot,true);
    await evaluate(`document.querySelector('.confirmation-dialog .confirmation-actions button:${accept ? 'last' : 'first'}-child').click(); true`);
    return message;
  };

  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1000 }, devicePixelRatio: 1 });
  for (const [mode, role, label] of [
    ['standalone', 'master', 'Standalone'], ['mirror', 'master', 'Mirror · Master'],
    ['mirror', 'slave', 'Mirror · Slave'], ['pair', 'slave', 'Pair · Slave'], ['pair', 'master', 'Pair · Master'],
  ]) {
    topology = mode; pair = role === 'master' ? master() : standby(role);
    await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${proxy.address().port}`, wait: 'complete' });
    await until(`${$('instance-role')}.textContent === ${JSON.stringify(label)}`);
    assert.equal(await evaluate(`${$('pairing-panel')}.hidden`), mode !== 'pair', `${label}: pair controls follow topology`);
    assert.equal(await evaluate(`${$('primary-replication-notice')}.hidden`), mode !== 'mirror' || role !== 'master');
    assert.equal(await evaluate(`${$('replica-notice')}.hidden`), mode !== 'mirror' || role !== 'slave');
    assert.equal(await evaluate(`${$('read-only-help')}.hidden`), role === 'master', `${label}: slave views stay read-only`);
  }
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${proxy.address().port}`, wait: 'complete' });
  await until(`${$('instance-role')}.textContent === 'Pair · Master' && !${$('pairing-panel')}.hidden`);
  assert.equal(await evaluate(`${$('connection')}.textContent`), 'Live');
  assert.equal(await evaluate(`${$('pairing-details')}.open`), false, 'Pairing starts folded');
  assert.equal(await evaluate(`${$('error')}.hidden`), true);
  assert.equal(await evaluate("[...document.querySelectorAll('#pairing-panel button, #pairing-reset-dialog button, #history-recovery-dialog button, #history-recovery-open')].every(button => !/(?:…|\\.\\.\\.)$/.test(button.textContent.trim()))"), true,
    'Pairing and history recovery actions use plain button labels');
  for (const width of [1440, 390, 320]) for (const theme of ['dark', 'light']) await checkLayout(width, theme);
  await capture('mobile-closed');
  await capture('mobile-header', true);

  await evaluate("document.querySelector('#pairing-details > summary').focus(); true");
  await command('input.performActions', { context, actions: [{ type: 'key', id: 'pair-keyboard',
    actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
  assert.equal(await evaluate(`${$('pairing-details')}.open`), true, 'Native disclosure opens with Enter');
  assert.equal(await evaluate(`${$('pairing-history-recovery')}.checkVisibility()`), true);
  assert.equal(await evaluate(`${$('pairing-rejoin-step')}.checkVisibility()`), false, 'Recovery steps live in the shared dialog');
  await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1400 }, devicePixelRatio: 1 });
  await capture('desktop-expanded');
  await capture('desktop-header', true);
  assert.equal(actions.length, 0, 'Opening pairing details does not issue a history request');
  pair = master({ peer: { reachable: false, lastSeenAt: now - 120_000 } });
  await until(`${$('pairing-peer')}.textContent.includes('unavailable')`);
  assert.equal(await evaluate(`${$('pairing-attention')}.textContent`), 'Other computer unavailable · mirroring cannot be confirmed.');
  assert.match(await evaluate(`${$('pairing-summary')}.textContent`), /does not stop control/);
  assert.match(await evaluate(`${$('pairing-broker')}.textContent`), /listener active · 3 connections/);
  assert.equal(await evaluate(`${$('pairing-handover')}.disabled`), true);
  assert.match(await evaluate(`${$('pairing-handover-help')}.textContent`), /must be connected/);
  assert.equal(await evaluate(`${$('pairing-details')}.open`), true, 'Polling preserves the open disclosure');
  await evaluate(`window.pairingDisconnects = []; window.pairingObserver = new MutationObserver(() => {
    const summary = ${$('pairing-summary')}.textContent;
    if (summary.includes('Connection to this computer is lost')) window.pairingDisconnects.push(summary);
  }); window.pairingObserver.observe(${$('pairing-panel')}, { subtree: true, childList: true }); true`);
  failedReads.add('/api/events');
  await evaluate("window.dispatchEvent(new Event('online')); true");
  await until(`!${$('error')}.hidden && ${$('error')}.textContent.includes('Synthetic read unavailable')`);
  assert.equal(await evaluate(`${$('pairing-broker')}.textContent.includes('unconfirmed')`), false,
    'An event-history failure preserves successful local MQTT ownership evidence');
  failedReads.add('/api/chart');
  await evaluate(`${$('range-yesterday')}.click(); true`);
  await until(`${$('chart-status')}.textContent.includes('Unable to load selected dates')`);
  assert.equal(await evaluate('window.pairingDisconnects.length'), 0,
    'History and chart errors cannot flash a local disconnect when only the peer is offline');
  failedReads.clear();
  await evaluate(`${$('range-today')}.click(); window.dispatchEvent(new Event('online')); true`);
  await until(`${$('error')}.hidden`);

  // Both poll directions can settle out of order. A later successful report
  // must survive failure of the request that was already pending before it.
  for (const path of ['/api/status', '/api/pair']) {
    let started, release;
    const waiting = new Promise(resolve => { started = resolve; });
    delayedRead = { path, started, release: new Promise(resolve => { release = resolve; }) };
    if (path === '/api/status') await evaluate("window.dispatchEvent(new Event('online')); true");
    await waiting;
    // A changed peer caption proves the other poll rendered the newer report.
    pair = master();
    if (path === '/api/pair') await evaluate("window.dispatchEvent(new Event('online')); true");
    await until(`${$('pairing-peer')}.textContent.includes('connected')`);
    release();
    if (path === '/api/status') await until(`!${$('error')}.hidden && ${$('error')}.textContent.includes('Synthetic delayed read failure')`);
    else await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await evaluate('window.pairingDisconnects.length'), 0,
      `${path}: an older failed read cannot invalidate a newer successful local report`);
    pair = master({ peer: { reachable: false, lastSeenAt: now - 120_000 } });
    await evaluate("window.dispatchEvent(new Event('online')); true");
    await until(`${$('pairing-peer')}.textContent.includes('unavailable') && ${$('error')}.hidden`);
  }
  await evaluate('window.pairingObserver.disconnect(); true');
  failedReads.add('/api/status'); failedReads.add('/api/pair');
  await evaluate("window.dispatchEvent(new Event('online')); true");
  await until(`${$('pairing-summary')}.textContent.includes('Connection to this computer is lost')`);
  assert.match(await evaluate(`${$('pairing-broker')}.textContent`), /unconfirmed/);
  assert.equal(await evaluate(`${$('pairing-handover')}.disabled`), true, 'Actual local read failure still fences pairing actions');
  failedReads.clear();
  await evaluate("window.dispatchEvent(new Event('online')); true");
  await until(`${$('pairing-peer')}.textContent.includes('unavailable') && !${$('pairing-broker')}.textContent.includes('unconfirmed') && ${$('error')}.hidden`);
  for (const theme of ['dark', 'light']) {
    if (await evaluate('document.documentElement.dataset.theme') !== theme) await evaluate("document.getElementById('theme-toggle').click(); true");
    assert.equal(await evaluate(`getComputedStyle(${$('pairing-peerStat')}).color === getComputedStyle(${$('pairing-attention')}).color`), true,
      'Unavailable connection and attention message use the same warning color');
    assert.notEqual(await evaluate(`getComputedStyle(${$('pairing-peerStat')}).color`), await evaluate(`getComputedStyle(${$('pairing-broker')}).color`),
      'Peer outage does not recolor confirmed local MQTT readiness');
    for (const width of [1440, 768, 390, 320]) {
      await close(); await checkLayout(width, theme, true); await open();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Unavailable peer details fit each viewport');
      if (width === 1440 || width === 320) await capture(`peer-unavailable-${width}-${theme}`);
    }
  }
  pair = master(); await until(`${$('pairing-peer')}.textContent.includes('connected')`);

  pair = master({ recovery: { state: 'ready', donorRole: 'slave', preview },
    peer: { reachable: true, role: 'slave', lastSeenAt: now, syncReceivedAt: now,
      sync: { state: 'ready', sourceAt: now - 60_000, verifiedAt: now - 30_000, bytes: 2e6 } } });
  await evaluate(`${$('pairing-history-recovery')}.click(); true`);
  await until(`${$('history-recovery-dialog')}.open && ${$('history-recovery-preview')}.textContent.includes('History source checked')`);
  assert.equal(await evaluate(`${$('history-recovery-source')}.value`), 'peer');
  assert.equal(await evaluate(`${$('history-recovery-apply')}.hidden`), true, 'Normal comparisons cannot become recovery');
  assert.equal(await evaluate(`${$('pairing-rejoin')}.disabled`), true);
  await evaluate(`${$('history-recovery-close')}.click(); true`);
  assert.equal(await evaluate('document.activeElement.id'), 'pairing-history-recovery');
  pair = master();
  await evaluate(`${$('pairing-history-recovery')}.click(); true`);
  await until(`${$('history-recovery-check')}.disabled === false`);
  await evaluate(`${$('history-recovery-check')}.click(); true`);
  await until(`${$('pairing-recovery')}.textContent.includes('Validating')`);
  assert.equal(actions.length, 1);
  assert.equal(await evaluate(`${$('history-recovery-apply')}.disabled`), true);
  await evaluate(`${$('history-recovery-close')}.click(); true`);
  await close();
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true);
  pair = master({ recovery: { state: 'error', error: 'synthetic-unrendered-detail' },
    uiOperation: { id: actions.at(-1).requestId, action: 'check-recovery', state: 'error' } });
  await until(`${$('pairing-attention')}.textContent.length > 0`);
  await open(); await evaluate(`${$('pairing-history-recovery')}.click(); true`);
  await until(`${$('history-recovery-check')}.disabled === false`);
  assert.equal(await evaluate(`${$('history-recovery-apply')}.hidden`), true);
  assert.doesNotMatch(await evaluate(`${$('history-recovery-dialog')}.textContent`), /synthetic-unrendered-detail/);
  await evaluate(`${$('history-recovery-check')}.click(); true`);
  await until(`${$('pairing-recovery')}.textContent.includes('Validating')`);
  assert.equal(actions.length, 2);
  pair = { ...checked(), uiOperation: { id: actions.at(-1).requestId, action: 'check-recovery', state: 'complete' } };
  await until(`${$('history-recovery-apply')}.disabled === false && !${$('history-recovery-apply')}.hidden`);
  assert.equal(await evaluate(`${$('pairing-rejoin-step')}.checkVisibility()`), true);
  for (const width of [1440, 390, 320]) for (const theme of ['dark', 'light']) {
    await command('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
    await evaluate(`document.documentElement.dataset.theme = '${theme}'; true`);
    assert.equal(await evaluate(`(() => { const d=${$('history-recovery-dialog')}; return d.scrollWidth <= d.clientWidth && d.getBoundingClientRect().right <= innerWidth; })()`), true, `${width}px ${theme}: shared recovery dialog fits`);
    if (width === 1440 || width === 320) await capture(`recovery-ready-${width}-${theme}`);
  }
  const skipMessage=await confirmAction('pairing-rejoin',false,'rejoin-skip-confirmation-320-light');
  assert.match(skipMessage,/previous database is retained inactive, including unmatched and unsupported history/);
  assert.match(skipMessage,/does not determine how much history is missing/);
  assert.doesNotMatch(skipMessage,/discarded|deleted|lost|replaced/i);
  assert.equal(actions.length, 2);
  assert.match(await confirmAction('history-recovery-apply', true), /history|rebuild/i);
  await until(`${$('pairing-recovery')}.textContent.includes('Recovering')`);
  assert.equal(actions.at(-1).action, 'recover');
  assert.equal(actions.at(-1).previewId, previewId);
  await evaluate(`${$('history-recovery-close')}.click(); true`);
  await close();
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true);
  pair = master({ peer: { reachable: true, role: 'protected', lastSeenAt: now },
    recovery: { state: 'complete', donorRole: 'protected', report: { status: 'complete', counts: { missing: 12, conflicts: 3, duplicates: 4, skipped: 2 }, imported: 12, model: { status: 'rebuilt' } } },
    actions: { 'check-recovery': true, recover: false, rejoin: true },
    uiOperation: { id: actions.at(-1).requestId, action: 'recover', state: 'complete', progress: { phase: 'publishing', processed: 12 } } });
  await until(`${$('pairing-rejoin')}.textContent === 'Resume mirroring' && !${$('pairing-rejoin')}.disabled`);
  assert.equal(await evaluate(`${$('pairing-phase')}.textContent`), '');
  await open();await evaluate(`${$('pairing-history-recovery')}.click(); true`);
  await until(`${$('history-recovery-dialog')}.open`);
  const resumeMessage=await confirmAction('pairing-rejoin',false,'rejoin-after-recovery-confirmation-320-light');
  assert.match(resumeMessage,/previous database is retained inactive, including skipped history/);
  assert.match(resumeMessage,/never reused automatically/);
  assert.equal(actions.at(-1).action,'recover','Cancelling resume mirroring sends no rejoin request');
  await evaluate(`${$('history-recovery-close')}.click(); true`);

  for (const role of ['slave', 'protected']) {
    pair = role === 'slave' ? { ...standby(role), sync: { state: 'waiting' } } : standby(role);
    await until(`${$('instance-role')}.textContent === '${role === 'slave' ? 'Pair · Slave' : 'Pair · Protected'}'`);
    await until(`${$('read-only-help')}.hidden === false && ${$('home-pump-health')}.textContent === 'Recorded snapshot'`);
    await open();
    if (role === 'slave') {
      await until(`${$('pairing-syncDetail')}.textContent.includes('Last snapshot identity verified')`);
      assert.match(await evaluate(`${$('pairing-syncStat')}.textContent`), /Snapshot.*min old/,
        'Durable publication remains visible after the receiver’s in-memory progress restarts');
    }
    assert.equal(await evaluate(`${$('pairing-master-controls')}.checkVisibility()`), false);
    assert.equal(await evaluate(`${$('pairing-slave-controls')}.checkVisibility()`), true);
    for (const id of ['pairing-history-recovery', 'pairing-rejoin', 'pairing-handover'])
      assert.equal(await evaluate(`${$(id)}.checkVisibility()`), false, `${role} hides master control ${id}`);
    assert.equal(await evaluate(`${$('pairing-promote')}.checkVisibility()`), true);
    assert.equal(await evaluate(`${$('replica-notice')}.hidden`), true, 'Paired viewer has no duplicate large banner');
    assert.doesNotMatch(await evaluate(`${$('connection')}.textContent`), /LIVE CONTROL|LIVE OBSERVATION/);
    await command('browsingContext.setViewport', { context, viewport: { width: 390, height: 1000 }, devicePixelRatio: 1 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Expanded slave controls fit mobile width');
    for (const id of ['providers-controls', 'garage']) {
      const selector = id === 'garage' ? $('garage-control') : $(id);
      assert.equal(await evaluate(`${selector}.checkVisibility()`), true, `${role} keeps ${id} visible`);
    }
    assert.equal(await evaluate("[...document.querySelectorAll('[data-write-control]')].flatMap(node => node.matches('button,input,select,textarea') ? [node] : [...node.querySelectorAll('button,input,select,textarea')]).every(node => node.disabled)"), true, `${role} disables every mutation control`);
    await evaluate("document.getElementById('connections-details').open = true; document.getElementById('controls-details').open = true; document.getElementById('recording-details').open = true; document.getElementById('database-export-details').open = true; true");
    assert.equal(await evaluate(`${$('settings-reload')}.disabled`), true);
    assert.equal(await evaluate(`${$('database-export-save')}.disabled`), true);
    assert.equal(await evaluate(`${$('database-export-download')}.disabled`), false, 'Read-only database download stays available');
    assert.equal(await evaluate(`${$('range-today')}.disabled`), false, 'Chart navigation stays usable');
    const requestsBefore = actions.length;
    await evaluate(`${$('settings-reload')}.dispatchEvent(new MouseEvent('click', { bubbles: true })); ${$('temporary-form')}.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); ${$('database-export-save')}.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
    assert.equal(actions.length, requestsBefore, 'Synthetic events cannot bypass read-only controls');
    assert.equal(await evaluate(`${$('error')}.hidden`), true, 'Complete replica projection renders without an application error');
    if (role === 'protected') {
      assert.equal(await evaluate(`(() => { const node = ${$('instance-role')}, box = node.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(node); const text = range.getBoundingClientRect(); return Math.abs((box.top + box.bottom) / 2 - (text.top + text.bottom) / 2) <= 1 && Math.abs((box.left + box.right) / 2 - (text.left + text.right) / 2) <= 1; })()`), true, 'Protected badge text is centered on both axes');
      await capture('protected-dashboard-mobile', true);
      await evaluate("document.getElementById('garage-heating-details').open = true; document.getElementById('home-heat-pump-details').open = true; true");
      await capture('protected-garage-mobile', false, 'garage-control');
      await capture('protected-settings-mobile', false, 'providers-controls');
      await command('browsingContext.setViewport', { context, viewport: { width: 1440, height: 1100 }, devicePixelRatio: 1 });
      await capture('protected-dashboard-desktop', true);
      await capture('protected-settings-desktop', false, 'providers-controls');
      await command('browsingContext.setViewport', { context, viewport: { width: 320, height: 1000 }, devicePixelRatio: 1 });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Expanded protected dashboard fits 320px');
      await capture('protected-dashboard-320', true);

      pair = { ...standby('protected'), reason: 'activation_failed', error: 'vip_policy_mismatch', peer: { reachable: false } };
      await until(`${$('pairing-summary')}.textContent.includes('same address, network interface and prefix')`);
      assert.match(await evaluate(`${$('pairing-summary')}.textContent`), /other computer can stay offline/);
      await capture('protected-setup-guidance');
    }
    await close();
    if (role === 'protected') assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true);
  }
  sectionUnavailable = true;
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${proxy.address().port}`, wait: 'complete' });
  await until(`${$('charging-status')}.textContent.includes('Charging needs attention')`);
  await evaluate(`${$('charging-status')}.querySelector('.status-detail-trigger').click(); true`);
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Saved charging data unavailable/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click(); true");
  assert.equal(await evaluate(`${$('error')}.hidden`), true, 'Unavailable settings and charging do not break the dashboard');
  assert.equal(await evaluate(`${$('pairing-panel')}.checkVisibility()`), true);
  await evaluate(`${$('provider-overview-state')}.querySelector('.status-detail-trigger').click(); true`);
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Saved Home settings unavailable/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click(); true");
  assert.match(await evaluate(`${$('garage-controller-reason')}.textContent`), /Some saved Garage data is unavailable/);
  sectionUnavailable = false;
  for (const code of ['database_schema_mismatch', 'database_schema_invalid']) {
    pair = { ...standby('protected'), reason: 'activation_failed', error: code };
    await until(`${$('pairing-summary')}.textContent.includes('${code === 'database_schema_mismatch' ? 'database schema' : 'database structure'}')`);
    await open();
    for (const width of [1440, 320]) for (const theme of ['dark', 'light']) {
      await command('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
      if (await evaluate('document.documentElement.dataset.theme') !== theme)
        await evaluate("document.getElementById('theme-toggle').click(); true");
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${code}: recovery guidance fits ${width}px ${theme}`);
      assert.match(await evaluate(`${$('pairing-summary')}.textContent`), /Reset pairing → Start fresh/);
      assert.doesNotMatch(await evaluate(`${$('pairing-summary')}.textContent`), /MQTT|credentials/);
    }
  }
  pair = { ...standby('protected'), error: 'database_schema_mismatch', reason: 'activation_failed',
    actions: { promote: true, reset: true }, reset: { token: resetToken, blockedReason: null } };
  await until(`${$('pairing-reset')}.disabled === false`);
  await open();
  const beforeResets = actions.length;
  for (const width of [1440, 320]) for (const theme of ['dark', 'light']) {
    await command('browsingContext.setViewport', { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 });
    if (await evaluate('document.documentElement.dataset.theme') !== theme)
      await evaluate("document.getElementById('theme-toggle').click(); true");
    await evaluate(`${$('pairing-reset')}.click(); true`);
    await until(`${$('pairing-reset-dialog')}.open`);
    assert.equal(await evaluate(`${$('pairing-reset')}.getAttribute('aria-expanded')`), 'true');
    assert.equal(await evaluate("document.activeElement.id"), 'pairing-reset-cancel', 'Reset dialog opens with Cancel focused');
    assert.equal(await evaluate(`${$('pairing-reset-fresh')}.disabled`), true, 'Fresh reset needs explicit restoration acknowledgement');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Reset choices fit the viewport');
    assert.equal(await evaluate(`(() => { const dialog = ${$('pairing-reset-dialog')}; return dialog.scrollWidth <= dialog.clientWidth; })()`), true, 'Reset dialog text does not overflow');
    if (width === 320) await capture(`reset-choices-${theme}`);
    await evaluate(`${$('pairing-reset-cancel')}.click(); true`);
    await until(`${$('pairing-reset-dialog')}.open === false`);
    assert.equal(await evaluate(`${$('pairing-reset')}.getAttribute('aria-expanded')`), 'false');
    assert.equal(await evaluate('document.activeElement.id'), 'pairing-reset', 'Cancel restores focus to reset button');
  }
  assert.equal(actions.length, beforeResets, 'Reviewing or cancelling reset choices sends no mutation');
  await evaluate(`${$('pairing-reset')}.click(); ${$('pairing-reset-keep')}.click(); true`);
  await until("document.querySelector('.confirmation-dialog[open] #confirmation-description') !== null");
  assert.match(await evaluate("document.getElementById('confirmation-description').textContent"), /database and saved settings remain intact/);
  await evaluate("document.querySelector('.confirmation-dialog[open] .confirmation-actions button:last-child').click(); true");
  await until(`${$('pairing-reset-receipt')}.textContent.includes('local history kept protected')`);
  assert.equal(actions.at(-1).mode, 'keep');
  assert.equal(actions.at(-1).restorationConfirmed, undefined);
  assert.equal(pair.role, 'protected');
  assert.equal(await evaluate(`${$('pairing-reset-receipt')}.hidden`), false);
  assert.match(await evaluate(`${$('pairing-reset-receipt')}.textContent`), /1 verified backup was created/);
  await evaluate(`${$('pairing-reset')}.click(); ${$('pairing-reset-restoration')}.click(); ${$('pairing-reset-fresh')}.click(); true`);
  await until("document.querySelector('.confirmation-dialog[open] #confirmation-description') !== null");
  assert.match(await evaluate("document.getElementById('confirmation-description').textContent"), /Archives are kept until you manually delete/);
  await evaluate("document.querySelector('.confirmation-dialog[open] .confirmation-actions button:first-child').click(); true");
  await until(`${$('pairing-reset')}.disabled === false`);
  assert.equal(actions.length, beforeResets + 1, 'Fresh final confirmation can be cancelled');
  await evaluate(`${$('pairing-reset')}.click(); true`);
  assert.equal(await evaluate(`${$('pairing-reset-restoration')}.checked`), false, 'Opening the dialog clears old fresh-start consent');
  await evaluate(`${$('pairing-reset-restoration')}.click(); ${$('pairing-reset-fresh')}.click(); true`);
  await until("document.querySelector('.confirmation-dialog[open] #confirmation-description') !== null");
  await evaluate("document.querySelector('.confirmation-dialog[open] .confirmation-actions button:last-child').click(); true");
  await until(`${$('pairing-reset-receipt')}.textContent.includes('Started fresh as a slave')`);
  assert.equal(actions.at(-1).mode, 'fresh');
  assert.equal(actions.at(-1).restorationConfirmed, true);
  assert.equal(pair.role, 'slave');
  assert.match(await evaluate(`${$('pairing-reset-receipt')}.textContent`), /synthetic-reset/);

  await viewer.close();
  viewer = await startReplica({ config: { ...config, topology: 'mirror', role: 'slave', mirror: { directory } }, clock: () => now,
    readPublication: () => null, installSignalHandlers: false });
  readOnlyUpstream = `http://127.0.0.1:${viewer.server.address().port}`;
  pair = { ...standby('slave'), sync: { state: 'waiting' } };
  await command('browsingContext.navigate', { context, url: `http://127.0.0.1:${proxy.address().port}`, wait: 'complete' });
  await until(`${$('connection')}.textContent.includes('WAITING FOR SNAPSHOT') && !${$('read-only-help')}.hidden`);
  assert.equal(await evaluate(`${$('error')}.hidden`), true, 'The empty viewer renders before its first snapshot');
  for (const id of ['providers-controls', 'garage-control', 'home-control'])
    assert.equal(await evaluate(`${$(id)}.checkVisibility()`), true, `No first snapshot does not hide ${id}`);
  assert.equal(await evaluate(`${$('settings-reload')}.disabled`), true);
  await evaluate(`${$('provider-overview-state')}.querySelector('.status-detail-trigger').click(); true`);
  assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /this computer/);
  await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click(); true");
  pair = master({ transition: { kind: 'handover', phase: 'quiescing' }, canControl: false });
  await until(`${$('instance-role')}.textContent === 'Pair · Role change'`);
  assert.equal(await evaluate(`${$('pairing-attention')}.checkVisibility()`), true, 'Role-change progress remains visible when folded');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pairing-browser-smoke-passed', measurements, screenshots,
    checked: ['actual built dashboard', 'all topology and role headers', 'mode-specific synchronization panels and read-only controls', 'role beside operating mode', 'compact desktop/mobile dark/light layout',
      'placement above events', 'keyboard disclosure', 'poll preserves disclosure', 'secondary read failures preserve local pairing evidence', 'older failed reads cannot erase newer status', 'local status failure and recovery', 'failed/running checks never enable recovery',
      'successful preview unlocks recovery', 'skip and completed recovery confirmations explain retained inactive original',
      'recovery sends checked identity', 'closed progress and failures', 'matching protected/slave layout without master controls', 'actual immutable ReplicaViewer projection',
      'visible Data and settings plus Garage', 'mutation event fencing', 'read-only downloads and navigation', 'centered protected badge', '320px protected layout and startup guidance', 'reset choices and archive receipt', 'fresh reset restoration and final confirmation', 'reset cancellation and focus', '320px reset dialog in both themes', 'all cards readable before the first snapshot', 'unavailable settings and charging preserve dashboard access'] }));
  await command('browser.close'); ownsBrowser = false;
} finally {
  if (ownsBrowser) { try { await command('browser.close'); } catch {} }
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
  await viewer?.close();
  await app?.close(); rmSync(directory, { recursive: true, force: true });
}
