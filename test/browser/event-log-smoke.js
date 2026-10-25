// The built dashboard and real event API, with isolated source history and
// transport failures. No household configuration, broker or equipment is used.
// Run after npm run build; add --firefox to exercise the same cases through BiDi.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
import { uiSpacingFailures } from '../../scripts/lib/ui-spacing-checks.js';

const firefox = process.argv.includes('--firefox');
const directory = await mkdtemp(join(tmpdir(), 'event-log-browser-'));
const artifacts = await mkdtemp(join(tmpdir(), 'event-log-browser-images-'));
const initial = Date.parse('2026-10-25T10:10:01Z');
const admin = 'synthetic-event-admin-password', family = 'synthetic-event-family-password';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [], requests = [], pending = new Map();
let app, proxy, browser, socket, context, sequence = 0, failure = false, hold = null;
let snapshot = false, generation = 1, statusNow = initial;
let externalProfile;

try {
  const privatePath = join(directory, 'synthetic.json');
  await writeFile(privatePath, '{}', { mode: 0o600 });
  const config = loadConfig({ STMQ_CONFIG: privatePath, STMQ_DATA_DIR: directory,
    STMQ_DATABASE_DIR: directory, STMQ_PORT: '0', STMQ_INPUT: 'simulated',
    STMQ_API_TOKEN: admin, STMQ_FAMILY_API_TOKEN: family, XDG_STATE_HOME: directory }, directory);
  app = await start({ config, clock: () => initial });
  await app.store.runWrite(() => app.store.transaction(() => {
    for (let index = 0; index < 260; index++) app.store.event('occupancy-changed', {
      occupancy: index % 2 ? { mode: 'away', returnAt: new Date(initial + 3_600_000).toISOString() } : { mode: 'occupied' },
      input: 'simulated',
    }, initial - 1000 - index * 1000);
    for (let index = 0; index < 80; index++) app.store.event('decision', {
      input: 'simulated', phase: 'normal', action: 'normal', reasons: ['automation-paused'], execution: 'paused',
    }, initial - index * 1000);
    app.store.event('controller-error', { message: '<img src=x onerror="window.eventLogInjected=true">synthetic-private-detail' }, initial);
  }));
  const upstream = `http://127.0.0.1:${app.server.address().port}`;
  proxy = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture');
    const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    try {
      if (url.pathname === '/api/events') {
        requests.push(url.search);
        if (hold) { const current = hold; hold = null; current.started(); await current.wait; }
        if (failure) return json(503, { error: 'Synthetic event read failure' });
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert(['GET', 'HEAD'].includes(request.method) || request.method === 'POST' && url.pathname === '/api/temporary',
        'Only the isolated Away receipt test can mutate this fixture');
      const result = await fetch(upstream + request.url, { method: request.method,
        headers: { ...(request.headers.authorization ? { Authorization: request.headers.authorization } : {}),
          ...(chunks.length ? { 'content-type': 'application/json', origin: upstream } : {}) },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      if (url.pathname === '/api/status' && result.ok) {
        const status = await result.json(); status.now = statusNow;
        if (snapshot) {
          status.topology = 'mirror'; status.role = 'slave'; status.readOnly = true;
          status.sync = { state: 'ready', generation: `fixture-${generation}`, sourceAt: initial, snapshotAt: initial, verifiedAt: initial };
          status.settingsReload = { available: false, busy: false, reason: 'Read-only slave' };
        }
        return json(200, status);
      }
      if (url.pathname === '/api/events' && result.ok) {
        const page = await result.json();
        return json(200, { ...page, ...(snapshot ? { scope: 'snapshot', snapshotAt: initial } : {}) });
      }
      response.writeHead(result.status, Object.fromEntries([...result.headers].filter(([key]) =>
        !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key))));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      // Sign-out deliberately aborts the held read. Firefox also closes the
      // incoming request stream, which is cancellation rather than proxy failure.
      if (request.aborted || response.destroyed) return;
      errors.push(`Proxy: ${error.message}`); if (!response.headersSent) response.writeHead(500);
      response.end('Synthetic fixture failure');
    }
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  // Confined Firefox packages may have a separate /tmp namespace. Tests may
  // choose an accessible disposable profile root without touching a user profile.
  externalProfile = firefox && process.env.STMQ_FIREFOX_PROFILE_ROOT
    ? await mkdtemp(join(process.env.STMQ_FIREFOX_PROFILE_ROOT, 'event-log-browser-')) : null;
  const profile = externalProfile ?? join(directory, 'browser');
  let address;
  if (firefox) {
    if (!externalProfile) await mkdir(profile, { mode: 0o700 });
    const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    browser = spawn(process.env.STMQ_FIREFOX_BIN ?? '/usr/bin/firefox', ['--headless', '--no-remote', '--profile', profile,
      '--remote-debugging-port', String(port), 'about:blank'], { stdio: 'ignore' });
    address = `ws://127.0.0.1:${port}/session`;
  } else {
    browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu',
      '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let attempt = 0; attempt < 200 && !port; attempt++) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
      if (!port) await pause(30);
    }
    assert(port, 'Isolated Chromium starts');
    address = (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(result => result.json())).webSocketDebuggerUrl;
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    try { socket = new WebSocket(address); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }); break; }
    catch { socket?.close(); socket = null; await pause(30); }
  }
  assert(socket, 'Isolated browser protocol connects');
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const task = pending.get(message.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      message.error ? task.reject(new Error(message.message ?? message.error.message ?? message.error)) : task.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(`Browser: ${message.params.exceptionDetails.text}`);
    else if (message.method === 'log.entryAdded' && message.params.level === 'error' && message.params.type === 'javascript') errors.push(`Browser: ${message.params.text}`);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  if (firefox) {
    await send('session.new', { capabilities: { alwaysMatch: {} } });
    await send('session.subscribe', { events: ['log.entryAdded'] });
    ({ context } = await send('browsingContext.create', { type: 'tab' }));
  } else { await send('Page.enable'); await send('Runtime.enable'); }
  const unwrap = value => value?.type === 'array' ? value.value.map(unwrap)
    : value?.type === 'object' ? Object.fromEntries(value.value.map(([key, entry]) => [key, unwrap(entry)]))
      : value?.type === 'null' ? null : value?.value;
  const evaluate = async expression => {
    const result = await send(firefox ? 'script.evaluate' : 'Runtime.evaluate', firefox
      ? { expression, target: { context }, awaitPromise: true }
      : { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails || result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails ?? result.exceptionDetails));
    return firefox ? unwrap(result.result) : result.result.value;
  };
  const until = async (expression, label = expression) => {
    for (let attempt = 0; attempt < 400; attempt++) { if (await evaluate(expression)) return; await pause(30); }
    const state = await evaluate("({authenticated:document.body?.dataset.authenticated,authHidden:document.getElementById('auth')?.hidden,authError:document.getElementById('auth-error')?.textContent,eventMessage:document.getElementById('event-log-message')?.textContent,eventStatus:document.getElementById('event-log-status')?.textContent})");
    throw new Error(`Event log did not settle: ${label}; state: ${JSON.stringify(state)}; reads: ${requests.length}; browser errors: ${errors.join(', ')}`);
  };
  const navigate = () => send(firefox ? 'browsingContext.navigate' : 'Page.navigate', firefox
    ? { context, url: origin, wait: 'complete' } : { url: origin });
  const press = async key => {
    if (firefox) {
      const value = { Enter: '\uE007', Tab: '\uE004' }[key] ?? key;
      await send('input.performActions', { context, actions: [{ type: 'key', id: 'event-keys',
        actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
    } else {
      const [code, windowsVirtualKeyCode] = { Enter: ['Enter', 13], Tab: ['Tab', 9], ' ': ['Space', 32] }[key];
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode,
        ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    }
    await pause(30);
  };
  const refresh = async () => {
    const previous = requests.length;
    await evaluate("window.dispatchEvent(new Event('online'));true");
    await until('document.getElementById("event-log-refresh").disabled===false');
    for (let attempt = 0; requests.length === previous && attempt < 400; attempt++) await pause(30);
    assert(requests.length > previous); await until('document.getElementById("event-log-refresh").disabled===false');
  };
  const filter = async (id, value) => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}));true`);
    await until('document.getElementById("event-log-refresh").disabled===false');
  };
  await navigate(); await until('document.getElementById("auth")?.hidden===false');
  await evaluate(`document.getElementById('token').value=${JSON.stringify(admin)};document.getElementById('auth').requestSubmit();true`);
  await until('document.body?.dataset.authenticated==="true" && document.querySelectorAll("#events li").length>0');
  assert.equal(await evaluate('document.querySelectorAll("#events li").length'), 40);
  assert.equal(await evaluate('document.getElementById("events").textContent.includes("synthetic-private-detail")'), false);
  assert.equal(await evaluate('document.getElementById("events").querySelectorAll("img").length'), 0);
  await evaluate('document.getElementById("event-log-refresh").focus();true'); await press('Tab');
  assert.equal(await evaluate('document.activeElement.id'), 'events', 'Keyboard can enter the labelled event region');
  await evaluate('document.querySelector("#events summary").focus();true'); await press('Enter');
  assert.equal(await evaluate('document.querySelector("#events details").open'), true, 'Enter opens event evidence');
  await press(' ');
  assert.equal(await evaluate('document.querySelector("#events details").open'), false, 'Space closes event evidence');

  await evaluate("document.querySelectorAll('#events details')[3].open=true;document.querySelectorAll('#events summary')[3].focus();document.getElementById('events').scrollTop=400;window.savedEvent=document.querySelectorAll('#events li')[3];window.savedFocus=document.activeElement;window.savedScroll=document.getElementById('events').scrollTop;true");
  await refresh();
  assert.equal(await evaluate('window.savedEvent.isConnected && window.savedEvent.querySelector("details").open && window.savedFocus===document.activeElement'), true);
  assert(Math.abs(await evaluate('document.getElementById("events").scrollTop-window.savedScroll')) < 3, 'Ordinary refresh preserves reading position');
  const freshId = await app.store.runWrite(() => app.store.event('heating-automation-changed', {
    input: 'simulated', feature: 'home', enabled: false, identity: 'a'.repeat(64),
  }, initial));
  await refresh(); await until('document.getElementById("event-log-new").hidden===false');
  assert.equal(await evaluate('window.savedEvent.isConnected'), true);
  await evaluate('document.getElementById("event-log-new").click();true');
  await until('document.getElementById("event-log-refresh").disabled===false');
  const freshKey = `event:${String(freshId).padStart(16, '0')}`;
  assert.equal(await evaluate(`document.getElementById('events').textContent.length>0 && Boolean(document.querySelector('[data-event-id="${freshKey}"]'))`), true);

  for (let page = 0; page < 6; page++) {
    await until('document.getElementById("event-log-older").disabled===false');
    assert.equal(await evaluate('document.getElementById("event-log-older").hidden'), false);
    await evaluate('document.getElementById("event-log-older").click();true');
    await until('document.getElementById("event-log-refresh").disabled===false');
    assert(await evaluate('document.getElementById("events").children.length') <= 200);
  }
  await evaluate('document.getElementById("event-log-new").click();true');
  await until('document.getElementById("event-log-refresh").disabled===false');
  const checked = await evaluate('document.getElementById("event-log-status").textContent');
  failure = true; statusNow += 120000; await refresh();
  assert.equal(await evaluate('document.getElementById("event-log-status").textContent'), checked);
  assert.equal(await evaluate('document.getElementById("event-log-message").dataset.state'), 'error');
  assert.equal(await evaluate('document.getElementById("error").hidden'), true, 'Log read failures remain local');
  await evaluate("document.getElementById('away-until').value='2026-10-25T15:00';document.getElementById('away-until').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('temporary-form').requestSubmit();true");
  await until('document.getElementById("temporary-message").textContent==="Changes applied."');
  assert.equal(app.engine.settings.occupancy.mode, 'away');
  assert.equal(await evaluate('document.getElementById("temporary-message").classList.contains("form-error")'), false);
  failure = false; await refresh();
  await filter('event-log-view', 'all');
  assert.equal(await evaluate('document.getElementById("event-log-message").dataset.state'), 'neutral');
  await filter('event-log-area', 'caravan');
  assert.equal(await evaluate('document.getElementById("events").children.length'), 0);
  assert.match(await evaluate('document.getElementById("event-log-message").textContent'), /No recorded events/);
  await filter('event-log-area', 'all'); await filter('event-log-view', 'important');

  await evaluate("document.querySelectorAll('#events details')[2].open=true;window.replicaEvent=document.querySelectorAll('#events li')[2];document.getElementById('events').scrollTop=300;window.replicaScroll=document.getElementById('events').scrollTop;true");
  snapshot = true; generation++; await refresh(); generation++; await refresh();
  assert.equal(await evaluate('window.replicaEvent.isConnected && window.replicaEvent.querySelector("details").open'), true);
  assert(Math.abs(await evaluate('document.getElementById("events").scrollTop-window.replicaScroll')) < 3);
  assert.match(await evaluate('document.getElementById("event-log-status").textContent'), /Snapshot/);
  snapshot = false; await refresh();

  const layoutCases = [];
  for (const role of ['admin', 'family']) {
    if (role === 'family') {
      await evaluate(`sessionStorage.setItem('stmq-token',${JSON.stringify(family)});true`); await navigate();
      await until('document.body?.dataset.authenticated==="true" && document.querySelectorAll("#events li").length>0');
    }
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
      await send(firefox ? 'browsingContext.setViewport' : 'Emulation.setDeviceMetricsOverride', firefox
        ? { context, viewport: { width, height: 1000 }, devicePixelRatio: 1 }
        : { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('#events details').open=true;document.getElementById('event-log-panel').scrollIntoView({block:'start'});true`);
      await pause(60);
      const geometry = await evaluate("(()=>{const p=document.getElementById('event-log-panel'),l=document.getElementById('events');return {pageOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:p.scrollWidth>p.clientWidth,listOverflow:l.scrollWidth>l.clientWidth,semanticTime:Boolean(l.querySelector('time[datetime]')),rowHeight:l.firstElementChild.querySelector('summary').getBoundingClientRect().height};})()");
      assert.equal(geometry.pageOverflow, false, `${role}/${theme}/${width}: page fits`);
      assert.equal(geometry.panelOverflow, false, `${role}/${theme}/${width}: event card fits`);
      assert.equal(geometry.listOverflow, false, `${role}/${theme}/${width}: evidence fits`);
      assert.equal(geometry.semanticTime, true); layoutCases.push({ role, theme, width, ...geometry });
      const spacing = await evaluate(`(${uiSpacingFailures.toString()})({root:document.getElementById('event-log-panel'),maxElements:1000})`);
      assert.deepEqual(spacing, [], `${role}/${theme}/${width}: disclosure spacing`);
      if (width === 390 || width === 1440) {
        const screenshot = await send(firefox ? 'browsingContext.captureScreenshot' : 'Page.captureScreenshot', firefox
          ? { context, origin: 'viewport', format: { type: 'image/png' } } : { format: 'png' });
        await writeFile(join(artifacts, `${firefox ? 'firefox' : 'chrome'}-${role}-${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  for (const factor of [1.5, 2]) for (const width of [320, 390]) {
    await send(firefox ? 'browsingContext.setViewport' : 'Emulation.setDeviceMetricsOverride', firefox
      ? { context, viewport: { width, height: 568 }, devicePixelRatio: 1 }
      : { width, height: 568, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.eventFontStyles=[document.getElementById('event-log-panel'),...document.querySelectorAll('#event-log-panel *')].map(node=>({node,original:node.style.fontSize,size:parseFloat(getComputedStyle(node).fontSize)}));window.eventFontStyles.forEach(({node,size})=>{if(Number.isFinite(size))node.style.fontSize=(size*${factor})+'px';});true`);
    const enlarged = await evaluate("({pageOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:document.getElementById('event-log-panel').scrollWidth>document.getElementById('event-log-panel').clientWidth,clippedFilters:[...document.querySelectorAll('#event-log-panel .app-select-value')].some(node=>node.scrollWidth>node.clientWidth+1),titleFont:parseFloat(getComputedStyle(document.querySelector('#events .event-log-title')).fontSize)})");
    assert.equal(enlarged.pageOverflow, false, `${width}/${factor}: enlarged text fits page`);
    assert.equal(enlarged.panelOverflow, false, `${width}/${factor}: enlarged text fits event card`);
    assert.equal(enlarged.clippedFilters, false, `${width}/${factor}: filter choices remain readable`);
    assert(enlarged.titleFont >= 13 * factor - 0.1, 'The check actually enlarges explicitly sized text');
    await evaluate('window.eventFontStyles.forEach(({node,original})=>{node.style.fontSize=original;});delete window.eventFontStyles;true');
  }
  const oldRows = await evaluate('document.getElementById("events").children.length'); assert(oldRows > 0);
  let started;
  const blocked = new Promise(resolve => { started = resolve; }); let release;
  hold = { started, wait: new Promise(resolve => { release = resolve; }) };
  await evaluate("window.dispatchEvent(new Event('online'));true"); await blocked;
  await evaluate('document.getElementById("web-logout").click();true');
  release(); await until('document.body?.dataset.authenticated==="false"');
  assert.equal(await evaluate('document.getElementById("events").children.length'), 0, 'Sign-out discards history and fences delayed responses');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: firefox ? 'Firefox' : 'Chromium', layouts: layoutCases,
    checks: 'Real API, safe projection, stable reading, new events, older paging beyond 200, local failure/recovery, successful action receipt, filters, replica advancement, family access, enlarged text and sign-out fencing passed.', artifacts }));
} finally {
  socket?.close(); for (const task of pending.values()) clearTimeout(task.timer);
  if (browser && browser.exitCode === null) { const done = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await done; }
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await app?.close(); await rm(directory, { recursive: true, force: true });
  if (externalProfile) await rm(externalProfile, { recursive: true, force: true });
}
