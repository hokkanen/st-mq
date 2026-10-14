// Browser-only fixture: synthetic endpoint responses, loopback static server,
// disposable Chrome profile and blocked external requests. No application or
// certificate helper is started, and no installation configuration is read.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(join(tmpdir(), 'stmq-secure-web-browser-'));
const screenshots = process.env.STMQ_WEB_ACCESS_SCREENSHOT_DIR;
const adminToken = 'synthetic-web-access-browser-admin';
const familyToken = 'synthetic-web-access-browser-family';
const hostname = 'synthetic-access.example-tail.ts.net';
const fixture = {
  version: 1, enabled: false, phase: 'disabled', hostname: null, url: null, certificate: null,
  environment: 'home-assistant', setup: { credentialsReady: true },
  pair: { paired: true },
  helper: { state: 'not_installed', version: null },
  updates: { policy: 'automatic', testedVersion: '1.90.1', installed: null, latest: null, candidate: null },
  dns: { state: 'not_configured', resolver: null, expectedAddress: '192.0.2.50', a: [], aaaa: [] },
  transport: {
    https: { enabled: false, listening: false, address: null },
    recovery: { enabled: true, listening: true, address: { address: '127.0.0.1', port: 1234 } },
    ingress: { enabled: false, listening: false, address: null },
    lanHttp: { enabled: true, listening: true, address: { address: '192.0.2.1', port: 1236 } },
  },
};
const requests = [], errors = [], layouts = [], blocked = [], pending = new Map();
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
let server, browser, socket, sequence = 0;
const page = (await readFile(join(root, 'chart/index.html'), 'utf8'))
  .replace('src="./monitor.js"', 'src="/secure-web-harness.js"')
  .replace('</head>', '<link rel="stylesheet" href="/secure-web-access.css"></head>');
const harness = `
  import { createSecureWebAccessPanel } from '/secure-web-access.js';
  import { createSelectPickers } from '/select-picker.js';
  import { createAccessControls, assertWebRequest } from '/web-access.js';
  import { createReadOnlyControls, assertDashboardWrite } from '/dashboard-access.js';
  let access = {role:'admin',source:'password'};
  const status = {role:'slave',readOnly:true,webTransport:{enabled:false,phase:'disabled',certificate:null,secure:false,
    warning:'Unencrypted LAN HTTP backup is enabled. Passwords and household data can be intercepted or modified on that connection.'}};
  const adminToken = ${JSON.stringify(adminToken)}, familyToken = ${JSON.stringify(familyToken)};
  const permissions = createAccessControls({document});
  const readonly = createReadOnlyControls({document});
  createSelectPickers(document);
  window.webBrowser = {reads:0,writes:0,panel:null,status};
  const panel = createSecureWebAccessPanel({document,getAccess:()=>access,now:()=>Date.parse('2026-10-14T12:00:00Z'),request:async(path,body)=>{
    assertWebRequest(access,path,body,status);assertDashboardWrite(path,body,status);
    const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+(access.role==='admin'?adminToken:familyToken),
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();
    if(!response.ok)throw Object.assign(new Error(result.error),{status:response.status});
    if(body)webBrowser.writes++;else webBrowser.reads++;
    return result;
  }});
  webBrowser.panel=panel;
  webBrowser.role=role=>{
    access={role,source:'password'};permissions.update(access);panel.clear();
    panel.update(status);return true;
  };
  webBrowser.update=()=>panel.update(status);
  permissions.update(access);readonly.update(status);
  document.body.dataset.authenticated='true';document.getElementById('auth').hidden=true;
  panel.update(status);
  document.getElementById('secure-web-access-details').open=true;
  window.webBrowser.ready=true;
`;

try {
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/api/web-access') {
      const role = request.headers.authorization === `Bearer ${adminToken}` ? 'admin' : 'family';
      requests.push({ method: request.method, role });
      response.setHeader('content-type', 'application/json');
      if (role !== 'admin') { response.writeHead(403); response.end(JSON.stringify({ error: 'Admin required for this action.' })); return; }
      if (request.method === 'POST') {
        let data = ''; for await (const chunk of request) data += chunk;
        const input = JSON.parse(data);
        requests.at(-1).action = input.action;
        if (input.action === 'enable') {
          assert.equal(input.owner, 'local', 'Paired setup explicitly selects this computer as certificate owner');
          fixture.pair = { paired: true, ownerId: 'synthetic-owner', localOwner: true, peerRenewalRequired: true };
          fixture.enabled = true; fixture.phase = 'authorization_required';
          fixture.helper = { state: 'authorization_required', version: '1.90.1', authorizationUrl: 'https://login.tailscale.com/a/synthetic-authorization' };
          fixture.updates.installed = '1.90.1';
        } else if (input.action === 'recheck' || input.action === 'retry') {
          fixture.phase = 'ready'; fixture.hostname = hostname; fixture.url = `https://${hostname}:8443/`;
          fixture.certificate = { expiresAt: '2026-12-01T12:00:00Z' };
          fixture.helper.state = 'running';
          fixture.helper.authorizationUrl = null;
          fixture.helper.nodeKeyExpiresAt = '2026-10-16T14:00:00Z'; fixture.helper.securityUpdate = true;
          fixture.transport.https = { enabled: true, listening: true, address: { address: '192.0.2.1', port: 8443 } };
          fixture.dns = { state: 'not_configured', resolver: null, expectedAddress: '192.0.2.50', a: [], aaaa: [], checkedAt: '2026-10-14T12:00:00Z' };
        } else if (input.action === 'disable') {
          fixture.enabled = false; fixture.phase = 'disabled'; fixture.transport.https = { enabled: false, listening: false, address: null };
        } else if (input.action === 'set-update-policy') fixture.updates.policy = input.policy;
        else if (input.action === 'check-updates') { fixture.updates.latest = '1.90.2'; fixture.updates.candidate = '1.90.2'; }
        else if (input.action === 'update-now') { fixture.helper.version = '1.90.2'; fixture.updates.installed = '1.90.2'; fixture.updates.candidate = null; }
        else if (input.action === 'restore-identity') {
          assert.equal(input.confirmedPeerFenced, true, 'Restoration only follows an explicit fenced-owner confirmation');
          fixture.error = null; fixture.phase = 'ready';
        }
      }
      response.end(JSON.stringify({ ...fixture, webAccess: { role, source: 'password' } })); return;
    }
    if (path === '/secure-web-harness.js') { response.setHeader('content-type', 'text/javascript'); response.end(harness); return; }
    if (path === '/') { response.setHeader('content-type', 'text/html'); response.end(page); return; }
    const source = path.startsWith('/src/') && path.endsWith('.js');
    const target = source ? resolve(root, path.slice(1)) : resolve(root, 'chart', path.slice(1));
    if (!target.startsWith(`${join(root, source ? 'src' : 'chart')}${sep}`)) { response.writeHead(404); response.end(); return; }
    try {
      const data = await readFile(target);
      response.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = join(directory, 'chrome');
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
  assert(port, 'Disposable Chromium starts');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => { socket.onopen = resolveOpen; socket.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolveResponse, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(id, { resolve: resolveResponse, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === 'Fetch.requestPaused') {
      const local = message.params.request.url.startsWith(`${base}/`);
      if (!local) blocked.push(message.params.request.url);
      void send(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: message.params.requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) });
    }
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { if (await evaluate(`Boolean(document.body && (${expression}))`)) return; } catch (error) {
        if (!/Cannot find context|Execution context was destroyed|Inspected target navigated/.test(error.message)) throw error;
      }
      await pause(30);
    }
    throw new Error(`UI did not settle: ${expression}; browser exceptions: ${errors.length}`);
  };
  const settle = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
  const key = async value => {
    const keyCode = { Enter: 13, ' ': 32, ArrowDown: 40, Escape: 27 }[value];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value === ' ' ? 'Space' : value, windowsVirtualKeyCode: keyCode,
      ...(value === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value === ' ' ? 'Space' : value, windowsVirtualKeyCode: keyCode });
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await send('Page.navigate', { url: `${base}/` });
  await until("window.webBrowser?.ready && webBrowser.reads > 0");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#providers-controls > details')].map(fold=>fold.id)"),
    ['connections-details', 'secure-web-access-details', 'controls-details']);
  assert.equal(await evaluate("document.getElementById('secure-web-access-details').parentElement.id"), 'providers-controls');
  assert.equal(await evaluate("document.getElementById('connections-details').open"), false, 'HTTPS opens independently of Connections');
  assert.equal(await evaluate("document.getElementById('secure-web-access-enable').disabled"), false, 'Standby can set up its local web entrance');
  assert.equal(await evaluate("document.getElementById('secure-web-access-owner-choice').checkVisibility()"), true, 'First paired setup exposes the owner choice');
  assert.equal(await evaluate("document.getElementById('secure-web-access-owner-select').value"), 'local', 'Pair owner defaults to this computer');
  assert.equal(await evaluate("document.querySelectorAll('.secure-web-access-steps > li').length"), 6, 'Integrated checklist guides all six setup stages');
  assert.equal(await evaluate("document.getElementById('secure-web-access-step-prepare-state').textContent"), 'Choose certificate owner');
  assert.equal(await evaluate("document.querySelector('.secure-web-access-setup-links a').href"), 'https://console.tailscale.com/admin/dns');
  assert.equal(await evaluate("document.getElementById('settings-reload').disabled"), true, 'Standby cannot edit ordinary settings');
  assert.equal(await evaluate("document.getElementById('web-unsafe-warning').checkVisibility()"), true, 'Configured HTTP backup warning persists');
  await evaluate("document.getElementById('secure-web-access-enable').focus();true"); await key('Enter');
  await until("/Authorization required/.test(document.getElementById('secure-web-access-state').textContent)");
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').getAttribute('href')"), fixture.helper.authorizationUrl);
  assert.equal(requests.filter(item => item.action === 'enable').length, 1, 'Keyboard setup sends exactly one explicit operation');
  await evaluate("document.getElementById('secure-web-access-recheck').focus();true"); await key('Enter');
  await until("/HTTPS ready locally/.test(document.getElementById('secure-web-access-state').textContent)");
  await evaluate("document.getElementById('secure-web-access-network-details').open=true;document.getElementById('secure-web-access-update-details').open=true;true");
  assert.equal(await evaluate("document.getElementById('secure-web-access-state').textContent"), 'HTTPS ready locally · household DNS pending');
  assert.match(await evaluate("document.getElementById('secure-web-access-dns').textContent"), /Check not configured/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-step-tls-state').textContent"), 'Ready locally');
  assert.equal(await evaluate("document.getElementById('secure-web-access-hosts-entry').textContent"), `192.0.2.50 ${hostname}`);
  assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"), `curl --resolve '${hostname}:8443:192.0.2.50' 'https://${hostname}:8443/'`);
  assert.equal(await evaluate("document.getElementById('secure-web-access-step-client-state').textContent"), 'Verify each browser device');
  assert.equal(await evaluate('location.href'), `${base}/`, 'Local HTTPS readiness never leaves the recovery page automatically');
  assert.match(await evaluate("document.getElementById('secure-web-access-expiry').textContent"), /Dec 2026/);
  assert.match(await evaluate("document.getElementById('secure-web-access-key-expiry').textContent"), /16 Oct 2026.*2d 2h left/);
  assert.match(await evaluate("document.getElementById('secure-web-access-security-warning').textContent"), /urgent security update.*coverage is incomplete/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').checkVisibility()"), true);
  fixture.helper.authorizationUrl = 'https://login.tailscale.com/a/stale-authorization';
  fixture.dns = { ...fixture.dns, state: 'mismatch', resolver: '192.0.2.53', a: ['192.0.2.50'], aaaa: ['2001:db8::1'] };
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false, 'Running helper cannot expose a stale enrollment link');
  assert.match(await evaluate("document.getElementById('secure-web-access-dns').textContent"), /does not match/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-resolver').textContent"), '192.0.2.53');
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-a').textContent"), '192.0.2.50');
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-aaaa').textContent"), '2001:db8::1');
  fixture.dns.state = 'unavailable'; fixture.dns.aaaa = [];
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-aaaa').textContent"), 'Not checked', 'Failed IPv6 query cannot report no IPv6 answers');
  fixture.phase = 'approval_or_connection_pending'; fixture.dns.state = 'address_confirmation_required';
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.equal(await evaluate("document.getElementById('secure-web-access-state').textContent"), 'Approval or connection pending');
  assert.match(await evaluate("document.getElementById('secure-web-access-dns').textContent"), /Address needs confirmation.*14 Oct 2026/);
  fixture.phase = 'degraded'; fixture.error = 'helper_installation_binding_unavailable';
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.match(await evaluate("document.getElementById('secure-web-access-message').textContent"), /Supervisor host identity is unavailable.*Retry.*saved helper identity is preserved/);
  fixture.phase = 'ready'; fixture.error = null; await evaluate('webBrowser.panel.refresh({force:true})');
  await evaluate("document.getElementById('secure-web-access-setup-details').open=false;true");
  await evaluate("document.getElementById('secure-web-access-recheck').focus();window.webBrowser.savedButton=document.activeElement;webBrowser.update();true");
  await settle();
  assert.equal(await evaluate('document.activeElement===webBrowser.savedButton'), true, 'Status updates preserve focused control nodes');
  assert.equal(await evaluate("document.getElementById('secure-web-access-network-details').open"), true, 'Status updates preserve nested folds');
  assert.equal(await evaluate("document.getElementById('secure-web-access-setup-details').open"), false, 'Status updates preserve the checklist disclosure');
  const selector = "document.getElementById('secure-web-access-update-policy').parentElement.querySelector('.app-select-trigger')";
  await evaluate(`${selector}.focus();true`); await key('Enter'); await key('ArrowDown'); await key('Enter');
  await until("document.getElementById('secure-web-access-update-policy').value==='manual' && !document.getElementById('secure-web-access-check-updates').disabled");
  assert.equal(fixture.updates.policy, 'manual', 'Custom keyboard selector updates the local policy');
  await evaluate("document.getElementById('secure-web-access-check-updates').click();true");
  await until("!document.getElementById('secure-web-access-update-now').disabled");
  await evaluate("document.getElementById('secure-web-access-update-now').click();true");
  await until("document.getElementById('secure-web-access-helper').textContent==='1.90.2'");
  fixture.phase = 'degraded'; fixture.error = 'identity_restore_required';
  await evaluate('webBrowser.panel.refresh({force:true})');
  await evaluate("document.getElementById('secure-web-access-restore-identity').focus();true"); await key('Enter');
  await until("document.querySelector('.confirmation-dialog[open]')");
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /previous certificate-owner process is stopped and fenced from restarting/);
  const beforeRestore = requests.filter(item => item.action === 'restore-identity').length;
  await key('Escape'); await until("!document.querySelector('.confirmation-dialog')");
  assert.equal(requests.filter(item => item.action === 'restore-identity').length, beforeRestore, 'Cancel sends no identity restoration');
  assert.equal(await evaluate('document.activeElement.id'), 'secure-web-access-restore-identity', 'Identity cancellation restores focus');
  await evaluate("document.getElementById('secure-web-access-restore-identity').click();true");
  await until("document.querySelector('.confirmation-dialog[open]')");
  await evaluate("document.querySelector('.confirmation-dialog .confirmation-actions button:last-child').click();true");
  await until("document.getElementById('secure-web-access-restore-identity').hidden");
  assert.equal(requests.filter(item => item.action === 'restore-identity').length, beforeRestore + 1, 'Explicit fence confirmation restores exactly once');
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await evaluate("document.getElementById('secure-web-access-setup-details').open=true;true");
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 400 ? 1100 : 844, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('secure-web-access-details').scrollIntoView({block:'start',behavior:'instant'});true`);
    await settle();
    const geometry = await evaluate(`(()=>{
      const panel=document.getElementById('secure-web-access-details'),box=panel.getBoundingClientRect();
      return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,panelWidth:box.width,
        escapes:[...panel.querySelectorAll('button,a,code')].filter(node=>node.checkVisibility()).filter(node=>{
          const r=node.getBoundingClientRect();return r.x<box.x-2||r.right>box.right+2;
        }).map(node=>node.id||node.tagName)};
    })()`);
    layouts.push({ theme, width, ...geometry });
    assert(geometry.pageWidth <= geometry.viewport + 2, `${theme}/${width}: page fits`);
    assert.deepEqual(geometry.escapes, [], `${theme}/${width}: controls and addresses fit`);
    if (screenshots) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(screenshots, `${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  await evaluate("document.getElementById('secure-web-access-disable').focus();true"); await key('Enter');
  await until("document.querySelector('.confirmation-dialog[open]')");
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /retains renewal.*helper continues running/);
  const beforeCancel = requests.filter(item => item.action === 'disable').length;
  await key('Escape'); await until("!document.querySelector('.confirmation-dialog')");
  assert.equal(requests.filter(item => item.action === 'disable').length, beforeCancel, 'Escape sends no disable');
  assert.equal(await evaluate('document.activeElement.id'), 'secure-web-access-disable', 'Cancel restores focus');
  await evaluate("document.getElementById('secure-web-access-disable').click();true");
  await until("document.querySelector('.confirmation-dialog[open]')");
  await evaluate("document.querySelector('.confirmation-dialog .confirmation-actions button:last-child').click();true");
  await until("document.getElementById('secure-web-access-state').textContent==='Disabled · peer renewal retained'");
  assert.equal(await evaluate("document.getElementById('secure-web-access-peer-renewal').checkVisibility()"), true);
  assert.equal(fixture.helper.version, '1.90.2', 'Disabling retains the helper identity and version');
  const reads = requests.length;
  await evaluate("webBrowser.role('family');true"); await settle();
  assert.equal(await evaluate("document.getElementById('secure-web-access-admin').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-url').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"), '');
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-a').textContent"), '');
  assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-restore-identity').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('web-unsafe-warning').checkVisibility()"), true);
  assert.equal(requests.length, reads, 'Family does not poll the admin setup endpoint');
  assert.equal(await evaluate(`fetch('/api/web-access',{method:'POST',headers:{Authorization:'Bearer '+${JSON.stringify(familyToken)},'Content-Type':'application/json'},body:'{"action":"enable"}'}).then(r=>r.status)`), 403);
  assert.equal(await evaluate(`fetch('/api/web-access',{method:'POST',headers:{Authorization:'Bearer '+${JSON.stringify(familyToken)},'Content-Type':'application/json'},body:'{"action":"restore-identity","confirmedPeerFenced":true}'}).then(r=>r.status)`), 403);
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(blocked, [], 'No external browser requests were attempted');
  if (screenshots) await writeFile(join(screenshots, 'geometry.json'), JSON.stringify(layouts, null, 2));
  console.log(`Secure web access browser checks passed: own fold, standby/admin/family boundaries, keyboard setup, authorization, DNS/hosts guidance, certificate/node-key expiry, cached urgent update, retained peer renewal, fenced identity restoration, custom policy selector, updates, cancel/focus, HTTP warning, 320/390/1440px and both themes.${screenshots ? ` Synthetic screenshots: ${screenshots}` : ''}`);
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolveExit => browser.once('exit', resolveExit)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
