// Production dashboard with a synthetic history-recovery API. Disposable data,
// simulation and browser only; no household configuration or equipment access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = await mkdtemp(join(tmpdir(), 'history-recovery-browser-'));
const screenshots = await mkdtemp(join(tmpdir(), 'history-recovery-screenshots-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], requests = [], layouts = [], pending = new Map();
const previewId = 'a'.repeat(64), now = Date.now(), source = { id: 'backup-fixture', kind: 'backup', label: 'Saved backup · 1 October 2026', available: true };
const retainedSignals = ['return_temperature','supply_temperature','brine_in_temperature','brine_out_temperature',
  'dhw_temperature','heating_setpoint','heating_integral','auxiliary_output','compressor_hours','auxiliary_3kw_hours',
  'auxiliary_6kw_hours','dhw_hours','compressor_active','heating_pump_active','dhw_routing','heating_pump_speed',
  'brine_pump_speed','room_setting','dhw_stop_setting','dhw_start_setting','operating_mode','room_influence',
  'heating_curve','maximum_supply_setting','heat_stop_setting','tariff_reduction_setting','alarm_active','alarm_code'];
const preview = { previewId, status: 'checked', tables: ['imports', 'import_rows', 'observations', 'recorder_coverage',
  'provider_snapshot_contents', 'provider_snapshot_fetches', 'annotations', 'counters', 'fireplace_events',
  'learning_cycles', 'events', 'energy_audits', 'learning_journal', 'recorder_pending_energy', 'charging_session_keys']
  .map(name => ({ name, count: name === 'observations' ? 57 : 0 })), model: { status: 'not-assessed' },
  coverage: { checkedAt: now,categories: ['energy','temperatures','learning_journal','provider_snapshot_fetches'].map(name => ({ name,
    master: { count: 42,from: now - 86400000,to: now,undated: 0 },
    source: { count: 57,from: now - 172800000,to: now - 1000,undated: 0,
      outsideMaster: { before: { count: 15,from: now - 172800000,to: now - 86400000 },after: { count: 0,from: null,to: null } } } })),
    outages: { total: 30,omitted: 0,counts: { energyIntervals: 1,reportPeriods: 1,pointEvents: 28 },items: [
      { signal: null,energyPrefix: 'ev2',basis: 'energy-interval',from: now - 3600000,to: now - 1800000,potentialCoverage: true },
      { signal: null,signals: retainedSignals,records: 28,basis: 'receipt-coverage',reason: 'retained',status: 'unavailable',
        from: now - 10000,to: now - 10000,potentialCoverage: false },
      { signal: 'indoor_temperature',basis: 'receipt-coverage',reason: 'stale',status: 'stale',
        from: Math.floor(now / 1000) * 1000 - 100000,to: Math.floor(now / 1000) * 1000 - 99750,potentialCoverage: true },
    ] } } };
let app, server, browser, socket, sequence = 0, admin = true, topology = 'standalone', peer = null;
let recovery = { available: true, readOnly: false, busy: false, job: null, preview: null, sources: [source], nextBefore: '10:old-operation',
  operations: [{ id: 'old-operation', startedAt: 1, source: { label: 'Earlier backup' }, active: true, status: 'interrupted', canRevert: true }] };
try {
  const privatePath = join(directory, 'secrets.json'); await writeFile(privatePath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated' }, directory);
  app = await start({ config });
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  server = createServer(async (request, response) => {
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (request.url === '/api/pair') return json(200, peer);
      if (request.url.startsWith('/api/history-recovery')) {
        if (!admin) return json(403, { error: 'Admin required.' });
        if (request.method === 'GET') return json(200, { ...recovery, peer,
          ...(request.url.includes('before=') ? { nextBefore: null } : {}) });
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        if (request.url.endsWith('/upload')) {
          assert.equal(request.headers['content-type'], 'application/vnd.sqlite3');
          assert(Buffer.concat(chunks).length > 0);
          const uploaded = { id: 'upload-fixture', kind: 'upload', label: 'Uploaded database', available: true };
          recovery.sources.push(uploaded); requests.push({ action: 'upload' });
          return json(200, { sourceId: uploaded.id, source: uploaded });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        assert.equal(request.url, '/api/history-recovery/action');
        const selected = recovery.sources.find(item => item.id === body.sourceId);
        if (body.action === 'check') assert.equal(body.installationConfirmed, true);
        recovery = { ...recovery, busy: true, preview: null, job: { id: body.requestId, requestId: body.requestId,
          kind: body.action, status: 'running', source: selected, operationId: body.operationId,
          progress: { phase: body.action === 'recover' ? 'rebuilding' : 'checking' } } };
        if (body.action !== 'recover') setTimeout(() => {
          const revision = body.action.startsWith('review-');
          const correction = ['revert', 'restore'].includes(body.action);
          if (correction) recovery.operations[0] = { ...recovery.operations[0], active: body.action === 'restore', canRestore: body.action === 'revert', canRevert: body.action === 'restore' };
          const revisionResult = { previewId, recoveryId: 'old-operation', active: body.action.endsWith('restore'), counts: { affected: 12 }, model: { status: correction ? 'rebuilt' : 'rebuild-required' } };
          recovery = { ...recovery, busy: false, preview: revision ? revisionResult : correction ? null : preview,
            job: { ...recovery.job, status: 'complete', result: revision || correction ? revisionResult : preview } };
        }, 100);
        return json(202, { ...recovery, peer });
      }
      assert.equal(request.method, 'GET', 'Only synthetic recovery mutations are accepted');
      const result = await fetch(`${upstream}${request.url}`);
      const headers = Object.fromEntries([...result.headers].filter(([key]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)));
      if (request.url === '/api/status') {
        const status = await result.json(); status.topology = topology; status.pair = peer; status.webAccess = { ...status.webAccess, role: admin ? 'admin' : 'family' };
        response.writeHead(result.status, headers); response.end(JSON.stringify(status));
      } else { response.writeHead(result.status, headers); response.end(Buffer.from(await result.arrayBuffer())); }
    } catch (error) { errors.push(error.message); if (!response.headersSent) json(500, { error: 'Synthetic fixture failed.' }); else response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = join(directory, 'chromium');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port, launchError; browser.on('error', error => { launchError = error; });
  for (let i = 0; i < 200 && !port; i++) { if (launchError) throw launchError; try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {} if (!port) await pause(30); }
  assert(port);
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(value => value.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.error.message)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => reject(new Error(`Timeout ${method}`)), 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const until = async expression => { for (let i = 0; i < 300; i++) { if (await evaluate(`Boolean(document.body && (${expression}))`)) return; await pause(30); } throw Error(`UI did not settle: ${expression}; ${errors.join('; ')}`); };
  const $ = id => `document.getElementById(${JSON.stringify(id)})`;
  const click = id => evaluate(`${$(id)}.click(); true`);
  const accept = async () => { await until("document.querySelector('.confirmation-dialog[open]') !== null"); await evaluate("document.querySelector('.confirmation-dialog[open] .confirmation-actions button:last-child').click(); true"); };
  const key = async (key, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }); };
  const capture = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(screenshots, `${name}.png`), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
  };
  const reviewLayouts = async name => {
    for (const width of [1440, 320]) for (const theme of ['dark', 'light']) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width === 320 ? 568 : 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
      if (name === 'revision-review') await evaluate(`${$('history-recovery-review')}.scrollIntoView({block:'end'});true`);
      assert.equal(await evaluate("(() => { const b=document.querySelector('.history-recovery-body'); return b.scrollWidth <= b.clientWidth; })()"), true, `${name} fits the dialog`);
      await capture(`${name}-${width}-${theme}`);
    }
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}` });
  await until("document.body.dataset.authenticated === 'true'");
  assert.equal(await evaluate(`${$('history-recovery-open')}.checkVisibility()`), false, 'Recovery does not escape the closed recording fold');
  await evaluate(`${$('recording-details')}.open = true; true`);
  await until(`${$('recording-growth-inventoryAt')}.textContent.includes('Retained adaptive payload estimate')`);
  assert.equal(await evaluate(`${$('recording-overview-details')}.open`), false, 'Recording summary measures retained adaptive size without unfolding other recorded data');
  assert.equal(await evaluate(`${$('history-recovery-open')}.checkVisibility()`), false, 'Opening recording details leaves recovery inside its own closed fold');
  assert.equal(await evaluate(`${$('history-recovery-open')}.closest('details').id`), 'history-recovery-details');
  for (const width of [1440, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`${$('recording-details')}.scrollIntoView({block:'start'});true`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Folded recording tools fit the viewport');
    await capture(`recording-folded-${width}`);
  }
  await evaluate(`${$('history-recovery-details')}.open = true; ${$('history-recovery-open')}.focus(); true`);
  assert.equal(await evaluate('document.activeElement.id'), 'history-recovery-open', 'Recording opener receives keyboard focus');
  await key('Enter', 13);
  await until(`${$('history-recovery-dialog')}.open`);
  assert.equal(await evaluate('document.activeElement.id'), 'history-recovery-close');
  assert.equal(await evaluate("document.querySelectorAll('#history-recovery-dialog').length"), 1);
  assert.equal(await evaluate(`${$('history-recovery-history')}.checkVisibility()`), false, 'New recovery starts without the previous-recovery list');
  await until(`${$('history-recovery-source')}.options.length === 2`);
  await evaluate(`${$('history-recovery-source')}.value='backup-fixture'; ${$('history-recovery-source')}.dispatchEvent(new Event('change',{bubbles:true}));true`);
  assert.equal(await evaluate(`${$('history-recovery-check')}.disabled`), true);
  await click('history-recovery-installation-confirm'); await click('history-recovery-check');
  await until(`!${$('history-recovery-apply')}.hidden && !${$('history-recovery-apply')}.disabled`);
  assert.match(await evaluate(`${$('history-recovery-preview')}.textContent.replace(/\\s+/g, ' ')`), /Observations:\s*57/);
  assert.match(await evaluate(`${$('history-recovery-preview')}.innerText`), /History date ranges/);
  assert.equal(await evaluate("document.querySelector('.history-recovery-coverage details').open"), false);
  await evaluate("document.querySelector('.history-recovery-coverage details').open=true;true");
  assert.match(await evaluate(`${$('history-recovery-preview')}.innerText`), /Charger 2 energy/);
  assert.equal(await evaluate("document.querySelector('[data-recovery-section=availability-diagnostics]').open"),false,'Availability diagnostics start collapsed');
  assert.equal(await evaluate("document.querySelector('.history-recovery-outages').children.length"),1,'28 retained messages do not inflate the energy-gap list');
  assert.doesNotMatch(await evaluate("document.querySelector('[data-recovery-section=energy-gaps]').textContent"),/Retained|duration unknown/);
  await evaluate("document.querySelector('[data-recovery-section=availability-diagnostics]').open=true;document.querySelector('[data-recovery-section=diagnostic-0]').open=true;document.querySelector('[data-recovery-section=diagnostic-0] summary').focus();document.querySelector('[data-recovery-section=diagnostic-0]').dataset.beforeRefresh='yes';true");
  assert.match(await evaluate("document.querySelector('[data-recovery-section=diagnostic-0]').innerText"),/Retained messages · 28 records/);
  assert.match(await evaluate("document.querySelector('[data-recovery-section=diagnostic-0]').innerText"),/duration unknown/);
  assert.equal(await evaluate("document.querySelectorAll('[data-recovery-section=diagnostic-0] .history-recovery-diagnostic-signals li').length"),28);
  assert.match(await evaluate("document.querySelector('[data-recovery-section=diagnostic-1]').innerText"),/250 ms apart/,'Same formatted endpoints preserve a known subsecond report span');
  assert.doesNotMatch(await evaluate("document.querySelector('[data-recovery-section=availability-diagnostics]').textContent"),/potential coverage|No relevant usable source records|master outages/);
  await click('history-recovery-refresh');
  await until("!document.querySelector('[data-before-refresh]')");
  assert.equal(await evaluate("document.querySelector('[data-recovery-section=energy-gaps]').open"), true, 'Refreshing the same report preserves expanded energy gaps');
  assert.equal(await evaluate("document.querySelector('[data-recovery-section=availability-diagnostics]').open"),true);
  assert.equal(await evaluate("document.querySelector('[data-recovery-section=diagnostic-0]').open"),true,'Refreshing preserves the nested signal disclosure');
  assert.equal(await evaluate("document.activeElement.closest('details').dataset.recoverySection"),'diagnostic-0','Refreshing preserves nested summary focus');
  assert.doesNotMatch(await evaluate(`${$('history-recovery-preview')}.textContent`), /master|mirroring/);
  for (const width of [1440, 768, 390, 320]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 320 ? 568 : 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
    const geometry = await evaluate(`(() => { const d=${$('history-recovery-dialog')}, b=d.getBoundingClientRect();return {width:innerWidth,page:document.documentElement.scrollWidth,dialog:d.clientWidth,content:d.scrollWidth,left:b.left,right:b.right}; })()`);
    layouts.push({ width, theme, ...geometry });
    assert(geometry.content <= geometry.dialog + 1 && geometry.left >= 0 && geometry.right <= width + 1, `${width}px ${theme}: modal fits`);
    assert.equal(await evaluate("(() => { const b=document.querySelector('.history-recovery-body'); return b.scrollWidth <= b.clientWidth; })()"), true, 'Review content has no horizontal scrolling');
    assert.equal(await evaluate(`${$('history-recovery-close')}.getBoundingClientRect().bottom <= innerHeight`), true, 'Close stays visible on short screens');
    const shot = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(screenshots, `${width}-${theme}.png`), Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    await evaluate("document.querySelector('.history-recovery-ranges').scrollIntoView({block:'start'});true");
    await capture(`coverage-ranges-${width}-${theme}`);
    await evaluate("document.querySelector('.history-recovery-outages').scrollIntoView({block:'start'});true");
    await capture(`coverage-outages-${width}-${theme}`);
    await evaluate("document.querySelector('[data-recovery-section=diagnostic-0]').open=false;document.querySelector('[data-recovery-section=availability-diagnostics]').scrollIntoView({block:'start'});true");
    await capture(`availability-diagnostics-${width}-${theme}`);
    await evaluate("document.querySelector('[data-recovery-section=diagnostic-0]').open=true;true");
    assert.equal(await evaluate("(() => { const b=document.querySelector('.history-recovery-body'); return b.scrollWidth <= b.clientWidth; })()"),true,'Expanded grouped diagnostics fit without horizontal scrolling');
    await capture(`availability-signals-${width}-${theme}`);
    await evaluate("document.querySelector('.history-recovery-body').scrollTop=0;true");
    if (width === 320) {
      await evaluate(`${$('history-recovery-apply')}.scrollIntoView({block:'end'});true`);
      assert.equal(await evaluate(`${$('history-recovery-close')}.getBoundingClientRect().top >= 0`), true, 'Header remains available while reviewing a long result');
      await capture(`review-scrolled-${theme}`);
      await evaluate("document.querySelector('.history-recovery-body').scrollTop=0;true");
    }
  }
  await key('Tab', 9); assert.equal(await evaluate(`${$('history-recovery-dialog')}.contains(document.activeElement)`), true, 'Tab remains within native modal');
  await key('Escape', 27); await until(`!${$('history-recovery-dialog')}.open`);
  assert.equal(await evaluate('document.activeElement.id'), 'history-recovery-open');
  await click('history-recovery-open'); await until(`${$('history-recovery-dialog')}.open && !${$('history-recovery-apply')}.disabled`);
  await click('history-recovery-apply'); await accept();
  await until(`${$('history-recovery-status')}.textContent.includes('Rebuilding')`);
  await click('history-recovery-close');
  assert.equal(recovery.job.status, 'running');
  await click('history-recovery-open'); await until(`${$('history-recovery-status')}.textContent.includes('Rebuilding')`);
  assert.equal(requests.filter(item => item.action === 'recover').length, 1);
  recovery = { ...recovery, busy: false, job: { ...recovery.job, status: 'complete', result: { status: 'complete', counts: { missing: 12, conflicts: 2, duplicates: 42, skipped: 1 }, imported: 12, model: { status: 'rebuilt' } } } };
  await click('history-recovery-refresh'); await until(`${$('history-recovery-preview')}.innerText.replace(/\\s+/g, ' ').includes('Recovered entries: 12')`);
  await click('history-recovery-tab-history');
  assert.equal(await evaluate(`${$('history-recovery-source-section')}.checkVisibility()`), false, 'Previous recoveries is separate from selecting a new source');
  await reviewLayouts('previous-recoveries');
  await evaluate(`${$('history-recovery-operations')}.querySelector('button').click();true`);
  await until(`!${$('history-recovery-revision-apply')}.hidden && !${$('history-recovery-revision-apply')}.disabled`);
  assert.match(await evaluate(`${$('history-recovery-preview')}.textContent`), /Affected records: 12/);
  await reviewLayouts('revision-review');
  await click('history-recovery-revision-apply'); await accept();
  await until(`${$('history-recovery-operations')}.textContent.includes('Review restore')`);
  await evaluate(`${$('history-recovery-operations')}.querySelector('button').click();true`);
  await until(`${$('history-recovery-revision-apply')}.textContent==='Restore recovery' && !${$('history-recovery-revision-apply')}.disabled`);
  await click('history-recovery-revision-apply'); await accept();
  await until(`${$('history-recovery-operations')}.textContent.includes('Review revert')`);
  assert.deepEqual(requests.filter(item => ['revert','restore'].includes(item.action)).map(item => [item.action,item.confirmed]), [['revert',true],['restore',true]]);
  await click('history-recovery-earlier'); await until(`${$('history-recovery-earlier')}.hidden && !${$('history-recovery-newest')}.hidden`);
  await click('history-recovery-refresh'); assert.equal(await evaluate(`${$('history-recovery-newest')}.hidden`), false);
  await click('history-recovery-newest');
  await click('history-recovery-tab-recover');
  await evaluate(`${$('history-recovery-source')}.value='upload'; ${$('history-recovery-source')}.dispatchEvent(new Event('change',{bubbles:true}));true`);
  const uploadPath = join(directory, 'synthetic.sqlite'); await writeFile(uploadPath, 'SQLite format 3\0synthetic browser fixture', { mode: 0o600 });
  const { root } = await send('DOM.getDocument'); const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#history-recovery-file' });
  await send('DOM.setFileInputFiles', { nodeId, files: [uploadPath] });
  await until(`${$('history-recovery-source')}.value==='upload-fixture'`);
  assert.equal(await evaluate(`${$('history-recovery-installation-confirm')}.checked`), false);
  assert.equal(await evaluate(`${$('history-recovery-check')}.disabled`), true);
  await click('history-recovery-close');
  topology = 'pair'; peer = { role: 'master', canControl: true, busy: false, peer: { reachable: true, role: 'slave' }, vip: { owned: true },
    actions: { 'check-recovery': true, recover: false, rejoin: false }, recovery: { state: 'ready', donorRole: 'slave', preview } };
  recovery.sources.unshift({ id: 'peer', kind: 'peer', label: 'Paired computer', available: true });
  await send('Page.reload'); await until(`${$('pairing-panel')} && !${$('pairing-panel')}.hidden`);
  await evaluate(`${$('pairing-details')}.open=true; ${$('pairing-history-recovery')}.click();true`);
  await until(`${$('history-recovery-dialog')}.open && ${$('history-recovery-source')}.value==='peer'`);
  await until(`${$('history-recovery-preview')}.textContent.includes('History source checked')`);
  assert.match(await evaluate(`${$('history-recovery-status')}.textContent`), /Source check complete/);
  assert.doesNotMatch(await evaluate(`${$('history-recovery-status')}.textContent`), /before recovering|History recovery complete/);
  assert.equal(await evaluate("[...document.querySelectorAll('#history-recovery-details button, #history-recovery-dialog button, #pairing-panel button')].some(button => /(?:…|\\.\\.\\.)$/.test(button.textContent.trim()))"), false, 'Recovery and pairing actions use complete labels without ellipses');
  assert.equal(await evaluate(`${$('history-recovery-apply')}.hidden`), true);
  assert.equal(await evaluate(`${$('pairing-rejoin')}.disabled`), true);
  assert.equal(await evaluate("document.querySelectorAll('dialog#history-recovery-dialog').length"), 1);
  await click('history-recovery-close'); await until("document.activeElement.id === 'pairing-history-recovery'");
  admin = false; await send('Page.reload'); await until("document.body.dataset.authenticated === 'true'");
  await evaluate(`${$('recording-details')}.open=true;${$('history-recovery-details')}.open=true;true`);
  assert.equal(await evaluate(`${$('history-recovery-open')}.disabled`), true);
  const before = requests.length; await click('history-recovery-open'); assert.equal(await evaluate(`${$('history-recovery-dialog')}.open`), false); assert.equal(requests.length, before);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'history-recovery-browser-passed', layouts, screenshots,
    checks: ['production standalone opener', 'peer same modal and preselection', 'normal comparison cannot recover', 'installation confirmation', 'preview', 'recover with confirmation',
      'nested recording fold', 'energy gaps separate from 28 retained-message diagnostics', 'point duration unknown', 'grouped signal disclosure and focus preserved on refresh',
      'separate recovery/history views', 'close and reopen running job', 'complete result', 'whole operation revert and restore', 'old interrupted recovery', 'earlier pages', 'upload', 'keyboard focus and escape', '320/390/768/1440 both themes', 'short-screen header and scrolled review', 'family restriction'] }));
  await send('Browser.close');
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  browser?.kill();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
