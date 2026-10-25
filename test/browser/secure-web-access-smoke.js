import { uiSpacingFailures } from '../../scripts/lib/ui-spacing-checks.js';
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
const baselineDirectory = process.env.STMQ_WEB_ACCESS_BASELINE_DIR;
const cssImports = source => [...source.matchAll(/import ['"]\.\/([a-z0-9-]+\.css)['"]/g)].map(match=>match[1]);
const runtimeStyles = cssImports(await readFile(join(root, 'chart/monitor.js'), 'utf8'));
const baselineStyles = baselineDirectory ? cssImports(await readFile(join(baselineDirectory, 'monitor.js'), 'utf8')) : [];
const styleLinks = (styles, prefix = '/') => styles.map(name=>`<link rel="stylesheet" href="${prefix}${name}">`).join('');
const baselinePage = baselineDirectory ? (await readFile(join(baselineDirectory, 'index.html'), 'utf8'))
  .replace('<body data-authenticated="false">', '<body data-authenticated="true">')
  .replace(/<script[^>]*src="\.\/monitor\.js"[^>]*><\/script>/, '')
  .replace('href="./monitor.css"', 'href="/baseline-monitor.css"')
  .replace('</head>', `<base href="/">${styleLinks(baselineStyles,'/baseline-css/')}</head>`) : null;
const centeredFolds = ['learning-details', 'model-inputs-details', 'model-coefficients-details', 'mqtt-devices-details',
  'charging-setup-details', 'floor-preheat-details', 'garage-protection-configuration-details', 'electricity-details', 'secure-web-access-details', 'controls-details'];
const unchangedFolds = ['connections-details', 'home-heat-pump-details', 'learning-panel-details',
  'learning-validation-details', 'connection-setup-details', 'settings-format-example'];
const adminToken = 'synthetic-web-access-browser-admin';
const familyToken = 'synthetic-web-access-browser-family';
const hostname = 'synthetic-access.example-tail.ts.net';
const fixture = {
  version: 1, enabled: false, phase: 'disabled', hostname: null, url: null, certificate: null,
  environment: 'home-assistant', setup: { credentialsReady: true },
  pair: { paired: true },
  helper: { state: 'not_installed', version: null },
  updates: { policy: 'automatic', testedVersion: '1.104.1', installed: null, latest: null, candidate: null },
  dns: { state: 'not_configured', resolver: null, expectedAddress: '192.0.2.50', a: [], aaaa: [] },
  transport: {
    https: { enabled: false, listening: false, address: null },
    recovery: { enabled: true, listening: true, address: { address: '127.0.0.1', port: 1234 } },
    ingress: { enabled: false, listening: false, address: null },
    lanHttp: { enabled: true, listening: true, address: { address: '192.0.2.1', port: 1236 } },
  },
};
const originalFixture = structuredClone(fixture);
const requests = [], errors = [], layouts = [], metadataLayouts = [], folds = [], blocked = [], pending = new Map();
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
let server, browser, socket, sequence = 0;
const page = (await readFile(join(root, 'chart/index.html'), 'utf8'))
  .replace('src="./monitor.js"', 'src="/secure-web-harness.js"')
  .replace('</head>', `${styleLinks(runtimeStyles)}</head>`);
const harness = `
  import { createSecureWebAccessPanel } from '/secure-web-access.js';
  import { createSelectPickers } from '/select-picker.js';
  import { createAccessControls, assertWebRequest } from '/web-access.js';
  import { createReadOnlyControls, assertDashboardWrite } from '/dashboard-access.js';
  import { createComparisonDisclosure } from '/comparison-disclosure.js';
  import { initializeChargingSetup } from '/charging-setup.js';
  let access = {role:'admin',source:'password'};
  const status = {role:'slave',readOnly:true,webTransport:{enabled:false,phase:'disabled',certificate:null,secure:false,
    warning:'Unencrypted LAN HTTP backup is enabled. Passwords and household data can be intercepted or modified on that connection.'}};
  const adminToken = ${JSON.stringify(adminToken)}, familyToken = ${JSON.stringify(familyToken)};
  const permissions = createAccessControls({document});
  const readonly = createReadOnlyControls({document});
  const chargingSetup=initializeChargingSetup(document);chargingSetup.render(status);
  createSelectPickers(document);
  createComparisonDisclosure({button:document.getElementById('comparison-toggle'),content:document.getElementById('comparison-content')});
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
    access=role==='anonymous'?null:{role,source:'password'};permissions.update(access);panel.clear();
    document.body.dataset.authenticated=String(role!=='anonymous');document.getElementById('auth').hidden=role!=='anonymous';
    if(role!=='anonymous')panel.update(status);return true;
  };
  webBrowser.update=()=>panel.update(status);
  webBrowser.controlRole=role=>{status.role=role;status.readOnly=role!=='master';readonly.update(status);panel.update(status);};
  webBrowser.ingress=()=>{access={role:'admin',source:'ingress'};permissions.update(access);panel.update(status);};
  permissions.update(access);readonly.update(status);
  document.body.dataset.authenticated='true';document.getElementById('auth').hidden=true;
  panel.update(status);
  document.getElementById('connections-details').open=true;
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
          fixture.helper = { state: 'authorization_required', version: '1.104.1', authorizationUrl: 'https://login.tailscale.com/a/synthetic-authorization' };
          fixture.updates.installed = '1.104.1';
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
        else if (input.action === 'check-updates') { fixture.updates.latest = '1.104.2'; fixture.updates.candidate = '1.104.2'; }
        else if (input.action === 'update-now') { fixture.helper.version = '1.104.2'; fixture.updates.installed = '1.104.2'; fixture.updates.candidate = null; }
        else if (input.action === 'restore-identity') {
          assert.equal(input.confirmedPeerFenced, true, 'Restoration only follows an explicit fenced-owner confirmation');
          fixture.error = null; fixture.phase = 'ready';
        }
      }
      response.end(JSON.stringify({ ...fixture, webAccess: { role, source: 'password' } })); return;
    }
    if (path === '/baseline' && baselinePage) { response.setHeader('content-type', 'text/html'); response.end(baselinePage); return; }
    if (path.startsWith('/baseline-css/') && baselineDirectory && baselineStyles.includes(path.slice('/baseline-css/'.length))) { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(baselineDirectory,path.slice('/baseline-css/'.length)))); return; }
    if (path === '/baseline-monitor.css' && baselineDirectory) { response.setHeader('content-type', 'text/css'); response.end(await readFile(join(baselineDirectory, 'monitor.css'))); return; }
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
  const foldGeometry = (ids, open = true, stress = false) => evaluate(`(()=>{
    const ids=${JSON.stringify(ids)};
    return ids.map(id=>{const node=document.querySelector('#'+id+' > summary');
      for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
      node.parentElement.open=${JSON.stringify(open)};const status=node.querySelector('small'),original=status?.textContent;
      if(status&&${JSON.stringify(stress)})status.textContent='Waiting for connection and fresh settings confirmation';
      const box=node.getBoundingClientRect();
      const child=[...node.children].map(child=>{const rect=child.getBoundingClientRect();return {tag:child.tagName,text:child.textContent.trim(),
        center:rect.top+rect.height/2-(box.top+box.height/2),width:rect.width,height:rect.height};});
      const arrow=getComputedStyle(node,'::after'),transform=new DOMMatrix(arrow.transform);
      const arrowCenter=arrow.position==='absolute'?parseFloat(arrow.top)+parseFloat(arrow.lineHeight)/2+transform.f-box.height/2:null;
      const result={id,width:box.width,height:box.height,child,arrow:{position:arrow.position,top:arrow.top,transform:arrow.transform},arrowCenter};
      if(status&&${JSON.stringify(stress)})status.textContent=original;return result;
    });})()`);
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
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const triangleLayouts=[];
  for(const theme of ['light','dark'])for(const width of [320,390,1440])for(const open of [false,true])for(const badge of [false,'Needs attention','Status unavailable','Last known']) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<=390});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};
      document.getElementById('comparison-toggle').setAttribute('aria-expanded',${JSON.stringify(String(open))});
      document.getElementById('recording-details').open=${open};
      document.getElementById('recording-health-badge').hidden=${!badge};
      document.getElementById('recording-health-badge').textContent=${JSON.stringify(badge||'')};true`);await settle();
    const geometry=await evaluate(`(()=>{return ['comparison-toggle','recording-details'].map(id=>{
      const node=id==='comparison-toggle'?document.getElementById(id):document.querySelector('#'+id+' > summary');
      const box=node.getBoundingClientRect(),title=node.querySelector('span:first-child'),text=title.getBoundingClientRect(),range=document.createRange();
      range.selectNodeContents(title);const glyph=range.getBoundingClientRect(),marker=getComputedStyle(node,'::before');
      return {id,height:box.height,width:box.width,titleCenter:text.top+text.height/2-(box.top+box.height/2),glyphCenter:glyph.top+glyph.height/2-(box.top+box.height/2),
        marker:{width:marker.width,height:marker.height,alignSelf:marker.alignSelf,marginRight:marker.marginRight},
        escapes:[...node.children].filter(child=>child.checkVisibility()).filter(child=>{const r=child.getBoundingClientRect();return r.left<box.left-1||r.right>box.right+1}).map(child=>child.id||child.tagName)};
    });})()`);
    triangleLayouts.push({theme,width,open,badge,geometry});
    if(screenshots&&theme==='light'&&badge==='Needs attention'&&!open){
      await evaluate("document.getElementById('timing-details').scrollIntoView({block:'start',behavior:'instant'});true");await settle();
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      await writeFile(join(screenshots,`leading-markers-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
    }

    for(const row of geometry){assert(Math.abs(row.titleCenter)<=1,`Triangle heading/title centered: ${JSON.stringify({theme,width,open,badge,...row})}`);
      assert(Math.abs(row.glyphCenter)<=1.1,`Triangle heading painted text aligned with centered marker: ${JSON.stringify({theme,width,open,badge,...row})}`);
      assert.deepEqual(row.escapes,[],`Triangle heading fits: ${JSON.stringify({theme,width,open,badge,...row})}`);}
  }
  await evaluate("document.getElementById('comparison-toggle').focus();true");await key('Enter');
  assert.equal(await evaluate("document.getElementById('comparison-toggle').getAttribute('aria-expanded')"),'false','Comparison button keyboard toggles its existing mounted disclosure');
  await key(' ');assert.equal(await evaluate("document.getElementById('comparison-toggle').getAttribute('aria-expanded')"),'true');
  await evaluate("document.querySelector('#recording-details > summary').focus();true");await key('Enter');
  assert.equal(await evaluate("document.getElementById('recording-details').open"),false,'Native recording disclosure retains keyboard behavior');
  await evaluate("document.getElementById('recording-health-badge').hidden=true;true");

  assert.deepEqual(await evaluate("[...document.querySelectorAll('#providers-controls > details')].map(fold=>fold.id)"),
    ['connections-details']);
  assert.equal(await evaluate("document.getElementById('secure-web-access-details').parentElement.id"), 'connections-details');
  assert.equal(await evaluate("document.getElementById('controls-details').parentElement.id"), 'connections-details');
  assert.equal(await evaluate("document.querySelector('#connections-details > summary > span').textContent"), 'Connections & configuration');
  assert.equal(await evaluate("document.getElementById('connections-details').open"), true, 'Web access belongs to the original Connections disclosure');
  assert.equal(await evaluate("document.getElementById('secure-web-access-enable').disabled"), false, 'Standby can set up its local web entrance');
  assert.equal(await evaluate("document.getElementById('secure-web-access-owner-choice').checkVisibility()"), true, 'First paired setup exposes the owner choice');
  assert.equal(await evaluate("document.getElementById('secure-web-access-owner-select').value"), 'local', 'Pair owner defaults to this computer');
  assert.equal(await evaluate("document.querySelectorAll('.secure-web-access-steps > li').length"), 3, 'Plain-language setup guide avoids redundant technical progress rows');
  assert.equal(await evaluate("document.getElementById('secure-web-access-setup-details').open"), false, 'Detailed setup guidance stays collapsed by default');
  assert.match(await evaluate("document.getElementById('secure-web-access-next-help').textContent"), /Choose which computer.*separate from the master/);
  assert.equal(await evaluate("document.querySelector('.secure-web-access-setup-links a').href"), 'https://console.tailscale.com/admin/dns');
  assert.equal(await evaluate("document.getElementById('settings-reload').disabled"), true, 'Standby cannot edit ordinary settings');
  await evaluate("document.getElementById('charging-setup-details').open=true;document.querySelector('#charging-setup-charger1-details > summary').focus();true");
  await key('Enter');assert.equal(await evaluate("document.getElementById('charging-setup-charger1-details').open"),true);
  await evaluate("window.savedChargingSummary=document.activeElement;webBrowser.update();true");await settle();
  assert.equal(await evaluate('document.activeElement===savedChargingSummary'),true,'Polling preserves an actual dynamic setup summary');
  assert.equal(await evaluate("document.getElementById('charging-setup-charger1-details').open"),true,'Actual dynamic setup disclosure stays open through polling');

  assert.equal(await evaluate("document.getElementById('web-unsafe-warning').checkVisibility()"), true, 'Configured HTTP backup warning persists');
  await evaluate("document.getElementById('secure-web-access-enable').focus();true"); await key('Enter');
  await until("/Authorization required/.test(document.getElementById('secure-web-access-state').textContent)");
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').getAttribute('href')"), fixture.helper.authorizationUrl);
  assert.equal(requests.filter(item => item.action === 'enable').length, 1, 'Keyboard setup sends exactly one explicit operation');
  await until("document.activeElement.id==='secure-web-access-authorize'");
  assert.equal(await evaluate('document.activeElement.id'), 'secure-web-access-authorize', 'Successful keyboard setup moves focus to the newly available authorization action');
  fixture.helper.authorizationUrl = null;
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorization').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'Authorization link unavailable');
  assert.match(await evaluate("document.getElementById('secure-web-access-next-help').textContent"), /No authorization link.*Retry setup/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-retry').checkVisibility()"), true);
  fixture.phase = 'degraded'; fixture.error = 'helper_authorization_start_failed';
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.match(await evaluate("document.getElementById('secure-web-access-message').textContent"), /could not start Tailscale authorization.*No sign-in link/);
  fixture.error = null; fixture.phase = 'authorization_required';
  fixture.helper.authorizationUrl = 'https://login.tailscale.com/a/synthetic-authorization';
  await evaluate('webBrowser.panel.refresh({force:true})');
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').checkVisibility()"), true, 'Current enrollment action remains visible outside collapsed guides');

  await evaluate("document.getElementById('secure-web-access-recheck').focus();true"); await key('Enter');
  await until("/HTTPS ready/.test(document.getElementById('secure-web-access-state').textContent)");
  await evaluate("document.getElementById('secure-web-access-network-details').open=true;document.getElementById('secure-web-access-update-details').open=true;true");
  assert.equal(await evaluate("document.getElementById('secure-web-access-state').textContent"), 'HTTPS ready · DNS not verified');
  assert.match(await evaluate("document.getElementById('secure-web-access-dns').textContent"), /Check not configured/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-https').textContent"), 'Listening · port 8443');
  assert.equal(await evaluate("document.getElementById('secure-web-access-hosts-entry').textContent"), `192.0.2.50 ${hostname}`);
  assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"), `curl --resolve '${hostname}:8443:192.0.2.50' 'https://${hostname}:8443/'`);
  assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'One address at home and away');
  assert.equal(await evaluate('location.href'), `${base}/`, 'Local HTTPS readiness never leaves the recovery page automatically');
  assert.match(await evaluate("document.getElementById('secure-web-access-expiry').textContent"), /Dec 2026/);
  assert.match(await evaluate("document.getElementById('secure-web-access-key-expiry').textContent"), /16 Oct 2026.*2d 2h left/);
  assert.match(await evaluate("document.getElementById('secure-web-access-security-warning').textContent"), /urgent security update.*coverage is incomplete/);
  assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').checkVisibility()"), true);
  for(const section of ['setup','network','update']) {
    await evaluate(`(()=>{const fold=document.getElementById('secure-web-access-${section}-details');fold.open=false;fold.querySelector(':scope>summary').focus();return true;})()`);
    await key('Enter'); assert.equal(await evaluate(`document.getElementById('secure-web-access-${section}-details').open`),true);
    await evaluate('webBrowser.panel.refresh({force:true})');
    assert.equal(await evaluate(`document.activeElement===document.querySelector('#secure-web-access-${section}-details>summary')`),true,'Polling preserves focused native summary');
    assert.equal(await evaluate(`document.getElementById('secure-web-access-${section}-details').open`),true,'Polling preserves expanded instructions');
    await key(' '); assert.equal(await evaluate(`document.getElementById('secure-web-access-${section}-details').open`),false);
    await key('Enter'); assert.equal(await evaluate(`document.getElementById('secure-web-access-${section}-details').open`),true);
  }
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
  await until("document.getElementById('secure-web-access-helper').textContent==='1.104.2'");
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
  const captureLayout = async (name, { details = false, anonymous = false } = {}) => {
    assert.equal(await evaluate(`JSON.stringify((${uiSpacingFailures.toString()})())`), '[]', 'Card padding and nested indentation remain independent');
    await evaluate(`document.getElementById('connections-details').open=true;document.getElementById('secure-web-access-details').open=true;
      for(const id of ['setup','network','update'])document.getElementById('secure-web-access-'+id+'-details').open=${details};true`);
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: width > 400 ? 1100 : 844, deviceScaleFactor: 1, mobile: width <= 390 });
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.getElementById('${anonymous ? 'auth' : 'secure-web-access-details'}').scrollIntoView({block:'start',behavior:'instant'});true`);
      await settle();
      const geometry = await evaluate(`(()=>{
        const panel=document.getElementById('${anonymous ? 'auth' : 'secure-web-access-details'}'),box=panel.getBoundingClientRect();
        const visible=node=>node.checkVisibility();
        const head=panel.querySelector(':scope > summary'),headBox=head?.getBoundingClientRect();
        return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,panelWidth:box.width,
          escapes:[...panel.querySelectorAll('button,a,code,.app-select-trigger')].filter(node=>visible(node)).filter(node=>{
            const r=node.getBoundingClientRect();return r.x<box.x-2||r.right>box.right+2;
          }).map(node=>node.id||node.tagName),
          heading:head?[...head.children].map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent.trim(),
            center:r.top+r.height/2-(headBox.top+headBox.height/2)};}):[],
          textAlignment:[...panel.querySelectorAll('button,.secure-web-access-link-action')].filter(node=>visible(node)&&!node.querySelector('svg')).map(node=>{
            const r=node.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect();
            return {id:node.id,center:text.top+text.height/2-(r.top+r.height/2)};})};
      })()`);
      layouts.push({ name, theme, width, ...geometry });
      assert(geometry.pageWidth <= geometry.viewport + 2, `${name}/${theme}/${width}: page fits`);
      assert.deepEqual(geometry.escapes, [], `${name}/${theme}/${width}: controls and addresses fit`);
      for (const item of geometry.heading) assert(Math.abs(item.center)<=1.1, `${name}/${theme}/${width}: fold heading centered: ${item.text}`);
      for (const item of geometry.textAlignment) assert(Math.abs(item.center)<=2, `${name}/${theme}/${width}: button text centered: ${item.id}`);
      if (screenshots) {
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        await writeFile(join(screenshots, `${name}-${theme}-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      if (details) {
        const facts = await evaluate(`(()=>{
          const groups=document.querySelector('.secure-web-access-update-groups');
          return {groups:groups.getBoundingClientRect().toJSON(),rows:[...groups.querySelectorAll('dl > div')].map(row=>{
            const label=row.querySelector('dt'),value=row.querySelector('dd'),a=label.getBoundingClientRect(),b=value.getBoundingClientRect();
            return {label:label.textContent,value:value.textContent,labelBox:a.toJSON(),valueBox:b.toJSON(),
              labelWeight:getComputedStyle(label).fontWeight,valueWeight:getComputedStyle(value).fontWeight};})};
        })()`);
        metadataLayouts.push({name,theme,width,...facts});
        for(const row of facts.rows) {
          assert(!row.label.endsWith(':'), 'Metadata labels use the shared colon-free row format');
          assert.equal(row.labelWeight, '500', 'Metadata labels share one weight');
          assert.equal(row.valueWeight, '550', 'Metadata values share one emphasis');
          if(width<=390) assert(row.valueBox.top>=row.labelBox.bottom+1, 'Mobile values follow their labels with a visible gap');
          else assert(Math.abs(row.labelBox.top-row.valueBox.top)<.2, 'Wide metadata labels and values align at the top');
        }
        if(screenshots) for(const section of ['network','update']) {
          await evaluate(`document.getElementById('secure-web-access-${section}-details').scrollIntoView({block:'start',behavior:'instant'});true`);
          const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
          await writeFile(join(screenshots,`${name}-${section}-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        }
        if(screenshots && name==='current-release') {
          const clip=await evaluate(`(()=>{const r=document.getElementById('secure-web-access-details').getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()`);
          const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip});
          await writeFile(join(screenshots,`${name}-full-fold-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
        }
      }
    }
  };
  await captureLayout('ready-details', { details: true });
  for(const id of ['helper','key-expiry','security-status'])
    assert.equal(await evaluate(`document.getElementById('secure-web-access-${id}').closest('section').getAttribute('aria-labelledby')`), 'secure-web-access-local-title');
  for(const id of ['tested','latest','update-check'])
    assert.equal(await evaluate(`document.getElementById('secure-web-access-${id}').closest('section').getAttribute('aria-labelledby')`), 'secure-web-access-release-title');
  const readyFixture = structuredClone(fixture);
  const installFixture = next => { for (const key of Object.keys(fixture)) delete fixture[key]; Object.assign(fixture, structuredClone(next)); };
  for (const [name, changes] of [
    ['remote-configured', { ...readyFixture, remoteAccess: { state: 'configured' } }],
    ['background-maintenance', { ...readyFixture, busy: true, operation: { action: 'recheck', state: 'completed', completedAt: Date.parse('2026-10-14T11:59:59Z'), error: null } }],
    ['remote-unavailable', { ...readyFixture, phase: 'ready', error: 'helper_remote_forwarding_unavailable', remoteAccess: { state: 'unavailable' } }],
    ['disabled-pair', originalFixture],
    ['disabled-peer-owner', { ...readyFixture, enabled: false, phase: 'disabled', pair: { paired: true, ownerId: 'synthetic-peer', localOwner: false }, transport: { ...readyFixture.transport, https: { enabled: false, listening: false } } }],
    ['disabled-local-owner', { ...readyFixture, enabled: false, phase: 'disabled', pair: { paired: true, ownerId: 'synthetic-owner', localOwner: true }, transport: { ...readyFixture.transport, https: { enabled: false, listening: false } } }],
    ['password-required', { ...originalFixture, setup: { credentialsReady: false } }],
    ['preparing', { ...originalFixture, enabled: true, phase: 'preparing', operation: { state: 'running' } }],
    ['startup-preparing', { ...originalFixture, enabled: true, phase: 'preparing', operation: { action: 'enable', state: 'completed' } }],
    ['retry-pending', { ...originalFixture, enabled: true, phase: 'degraded', error: 'helper_authorization_start_failed', operation: { state: 'running', action: 'retry', error: null } }],
    ['manager-owned', { ...originalFixture, enabled: true, phase: 'degraded', error: 'https_manager_already_running' }],
    ['manager-lock-repair', { ...originalFixture, enabled: true, phase: 'degraded', error: 'https_lock_recovery_required' }],
    ['recovered-receipt', { ...readyFixture, error: null, operation: { action: 'enable', state: 'failed', completedAt: Date.parse('2026-10-14T11:59:59Z'), error: 'helper_authorization_start_failed' } }],
    ['current-release', { ...readyFixture, helper: { ...readyFixture.helper, securityUpdate: null, runningLatest: true }, updates: { ...readyFixture.updates, installed: '1.104.1', latest: '1.104.1', candidate: '1.104.1', lastSuccessfulCheck: Date.parse('2026-10-14T11:59:30Z') } }],
    ['urgent-release', { ...readyFixture, helper: { ...readyFixture.helper, securityUpdate: true, securityObservedAt: Date.parse('2026-10-14T11:45:00Z') }, updates: { ...readyFixture.updates, installed: '1.104.1', latest: '1.104.2', candidate: '1.104.2' } }],
    ['retained-urgent', { ...readyFixture, helper: { state: 'stopped', securityUpdate: true, securityObservedAt: Date.parse('2026-10-13T11:45:00Z') } }],
    ['unknown-destination', { ...readyFixture, dns: { state: 'address_confirmation_required', expectedAddress: '0.0.0.0' }, transport: { ...readyFixture.transport, recovery: { listening: true, address: { address: '0.0.0.0', port: 1234 } } } }],
    ['loopback-destination', { ...readyFixture, dns: { state: 'ready', expectedAddress: '127.0.0.1' } }],
    ['custom-ports', { ...readyFixture, url: `https://${hostname}:9443/`, dns: { state: 'unavailable', expectedAddress: '192.0.2.74' }, transport: { ...readyFixture.transport, recovery: { listening: true, address: { address: '::1', port: 4321 } }, https: { enabled: true, listening: true, address: { address: '0.0.0.0', port: 9443 } } } }],
    ['default-port', { ...readyFixture, url: `https://${hostname}/`, transport: { ...readyFixture.transport, https: { enabled: true, listening: true, address: { address: '0.0.0.0', port: 443 } } } }],
    ['long-hostname', { ...readyFixture, hostname: `synthetic-${'a'.repeat(50)}.example-tail.ts.net`, url: `https://synthetic-${'a'.repeat(50)}.example-tail.ts.net:8443/` }],
    ['renamed-pending', { ...readyFixture, phase: 'degraded', error: 'helper_hostname_changed' }],
    ['authorize', { ...readyFixture, certificate: null, phase: 'authorization_required', helper: { state: 'authorization_required', authorizationUrl: 'https://login.tailscale.com/a/synthetic-authorization' }, transport: { ...originalFixture.transport, https: { enabled: false, listening: false } } }],
    ['missing-link', { ...readyFixture, certificate: null, phase: 'authorization_required', helper: { state: 'authorization_required' }, transport: { ...originalFixture.transport, https: { enabled: false, listening: false } } }],
    ['setup-failed', { ...readyFixture, certificate: null, phase: 'degraded', error: 'helper_authorization_start_failed', helper: { state: 'authorization_required' }, transport: { ...originalFixture.transport, https: { enabled: false, listening: false } } }],
    ['approval-pending', { ...readyFixture, phase: 'approval_or_connection_pending', helper: { state: 'approval_or_connection_pending' } }],
    ['certificate-settings', { ...readyFixture, certificate: null, phase: 'certificate_settings_required', helper: { state: 'running' } }],
    ['ready-dns-unchecked', { ...readyFixture, dns: { state: 'not_configured' }, helper: { state: 'running' }, pair: { paired: true, ownerId: 'synthetic-owner', localOwner: true } }],
    ['ready-dns-mismatch', { ...readyFixture, dns: { ...readyFixture.dns, state: 'mismatch', aaaa: ['2001:db8::1'] } }],
    ['expired-certificate', { ...readyFixture, certificate: { expiresAt: '2026-10-13T12:00:00Z' } }],
    ['peer-certificate', { ...readyFixture, certificate: null, phase: 'peer_certificate_pending', pair: { paired: true, ownerId: 'synthetic-peer', localOwner: false }, transport: { ...readyFixture.transport, https: { listening: false } } }],
    ['identity-repair', { ...readyFixture, phase: 'degraded', error: 'identity_restore_required' }],
    ['pair-reauthorization', { ...readyFixture, certificate: null, phase: 'degraded', error: 'https_pair_identity_changed',
      pair: { paired: true, ownerId: 'fixture-owner', localOwner: true, reauthorization: { token: 'fixture-pair-binding' } } }],
  ]) {
    installFixture(changes); await evaluate('webBrowser.panel.refresh({force:true})');
    if (name === 'pair-reauthorization') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-reauthorize-pair').hidden"), false);
      assert.equal(await evaluate("document.getElementById('secure-web-access-retry').hidden"), true);
      assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'Review the current paired computers');
    }
    assert.equal(await evaluate("document.querySelector('#secure-web-access-details > summary > small').textContent"),
      'HTTPS & remote access', 'The setup subtitle describes contents in every status');
    if (name === 'remote-configured') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-remote').textContent"), 'Forwarding configured');
      assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'One address at home and away');
    }
    if (name === 'remote-unavailable') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-state').textContent"), 'Needs attention');
      assert.match(await evaluate("document.getElementById('secure-web-access-summary').textContent"), /Local HTTPS is ready.*Tailscale access needs attention/);
      assert.equal(await evaluate("document.getElementById('secure-web-access-remote').textContent"), 'Unavailable');
      assert.match(await evaluate("document.getElementById('secure-web-access-message').textContent"), /Tailscale connection could not be configured/);
      assert.match(await evaluate("document.getElementById('secure-web-access-https').textContent"), /Listening/);
    }
    if(name==='startup-preparing') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'Setting up HTTPS');
      for(const action of ['enable','recheck','retry','disable','check-updates','update-now'])
        assert.equal(await evaluate(`document.getElementById('secure-web-access-${action}').disabled`), true, 'Startup setup progress disables overlapping panel actions');
      assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
    }
    if(name==='background-maintenance') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'Checking web access');
      for (const action of ['recheck', 'disable', 'check-updates'])
        assert.equal(await evaluate(`document.getElementById('secure-web-access-${action}').disabled`), true);
      const writesBefore = await evaluate('webBrowser.writes');
      assert.equal(await evaluate("webBrowser.panel.run('recheck')"), false, 'Programmatic activation also respects background maintenance');
      assert.equal(await evaluate('webBrowser.writes'), writesBefore);
      assert.match(await evaluate("document.getElementById('secure-web-access-receipt').textContent"), /Last action/);
    }
    if(name==='retry-pending')assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"),'Setting up HTTPS');
    if(name==='recovered-receipt'){assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"),'One address at home and away');assert.match(await evaluate("document.getElementById('secure-web-access-receipt').textContent"),/Last action · Set up HTTPS request failed/);}
    if(name==='current-release') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-update-now').hidden"), true);
      assert.equal(await evaluate("document.getElementById('secure-web-access-update-now').disabled"), true);
      assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').hidden"), true);
      assert.equal(await evaluate("document.getElementById('secure-web-access-security-status').textContent"), 'Not reported');
      assert.match(await evaluate("document.getElementById('secure-web-access-release-summary').textContent"), /Up to date/);
    }
    if(name==='urgent-release') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-update-now').hidden"), false);
      assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').hidden"), false);
      assert.match(await evaluate("document.getElementById('secure-web-access-security-help').textContent"), /urgent security update/);
      assert.match(await evaluate("document.getElementById('secure-web-access-security-reported').textContent"), /Vendor signal reported/);
    }
    if(name==='retained-urgent') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').hidden"),false);
      assert.match(await evaluate("document.getElementById('secure-web-access-security-reported').textContent"),/13 Oct 2026/);
      assert.match(await evaluate("document.getElementById('secure-web-access-security-help').textContent"),/was reported/);
    }
    if(['unknown-destination','loopback-destination'].includes(name)) {
      for(const id of ['hosts','curl']) assert.equal(await evaluate(`document.getElementById('secure-web-access-${id}-help').hidden`),true);
      for(const id of ['hosts-entry','curl-command']) assert.equal(await evaluate(`document.getElementById('secure-web-access-${id}').textContent`),'');
      assert.match(await evaluate("document.getElementById('secure-web-access-browser-instructions').textContent"),name==='loopback-destination'?/reaches only this computer/:/LAN destination is not reported/);
      if(name==='loopback-destination') assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"),'Local network access');
      if(name==='unknown-destination') assert.doesNotMatch(await evaluate("document.getElementById('secure-web-access-recovery-help').textContent"),/http:\/\/0\.0\.0\.0/);
    }
    if(name==='custom-ports') {
      assert.match(await evaluate("document.getElementById('secure-web-access-browser-instructions').textContent"),/HTTPS for.*9443.*192\.0\.2\.74/);
      assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"),`curl --resolve '${hostname}:9443:192.0.2.74' 'https://${hostname}:9443/'`);
      assert.match(await evaluate("document.getElementById('secure-web-access-recovery-help').textContent"),/http:\/\/\[::1\]:4321.*network namespace/);
    }
    if(name==='default-port') assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"),`curl --resolve '${hostname}:443:192.0.2.50' 'https://${hostname}/'`);
    if(name==='renamed-pending') {
      assert.equal(await evaluate("document.getElementById('secure-web-access-next-title').textContent"), 'Update the HTTPS hostname');
      assert.match(await evaluate("document.getElementById('secure-web-access-message').textContent"), /Select Recheck/);
    }
    if (name==='password-required') assert.equal(await evaluate("document.getElementById('secure-web-access-enable').disabled"), true);
    if (name==='expired-certificate') assert.equal(await evaluate("document.getElementById('secure-web-access-state').textContent"), 'HTTPS unavailable');
    if (name==='peer-certificate') assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
    await captureLayout(name,{details:['current-release','retained-urgent','unknown-destination','loopback-destination','custom-ports','default-port','long-hostname'].includes(name)});
  }
  installFixture(readyFixture); await evaluate('webBrowser.panel.refresh({force:true})');
  await evaluate("webBrowser.controlRole('master');true");
  assert.equal(await evaluate("document.getElementById('secure-web-access-standby').hidden"), true);
  assert.equal(await evaluate("document.getElementById('secure-web-access-recheck').disabled"), false);
  await captureLayout('master-admin');
  await evaluate("webBrowser.ingress();true");
  assert.equal(await evaluate("document.getElementById('web-access-role').textContent"), 'Admin via Home Assistant');
  await captureLayout('ingress-admin');
  await evaluate("webBrowser.controlRole('slave');true");
  await evaluate("document.getElementById('secure-web-access-network-details').open=true;document.getElementById('secure-web-access-update-details').open=true;true");
  for (const theme of ['light','dark']) for(const width of [320,390,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<=390});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};true`);await settle();
    const centered=[];
    for(const open of [false,true])for(const stress of [false,true]){
      const headers=await foldGeometry(centeredFolds,open,stress);
      for(const row of headers){
        assert(Math.abs(row.arrowCenter)<=.1,`${theme}/${width}/${open}: shared section-fold chevron centered: ${row.id}`);
        for(const item of row.child)assert(Math.abs(item.center)<=1.1,`${theme}/${width}/${open}: shared section-fold title/status centered: ${row.id}`);
      }
      centered.push({open,stress,headers});
    }
    folds.push({theme,width,centered,current:await foldGeometry(unchangedFolds)});
    if(screenshots){
      for(const [name,id]of [['home-learning','learning-details'],['connections','connections-details']]){
        await evaluate(`document.getElementById('${id}').scrollIntoView({block:'start',behavior:'instant'});true`);await settle();
        const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
        await writeFile(join(screenshots,`${name}-${theme}-${width}.png`),Buffer.from(shot.data,'base64'));
      }
    }

  }
  await evaluate("document.getElementById('secure-web-access-disable').focus();true"); await key('Enter');
  await until("document.querySelector('.confirmation-dialog[open]')");
  assert.match(await evaluate("document.querySelector('.confirmation-dialog').textContent"), /Certificate renewal and Tailscale forwarding.*remain/);
  const beforeCancel = requests.filter(item => item.action === 'disable').length;
  await key('Escape'); await until("!document.querySelector('.confirmation-dialog')");
  assert.equal(requests.filter(item => item.action === 'disable').length, beforeCancel, 'Escape sends no disable');
  assert.equal(await evaluate('document.activeElement.id'), 'secure-web-access-disable', 'Cancel restores focus');
  await evaluate("document.getElementById('secure-web-access-disable').click();true");
  await until("document.querySelector('.confirmation-dialog[open]')");
  await evaluate("document.querySelector('.confirmation-dialog .confirmation-actions button:last-child').click();true");
  await until("document.getElementById('secure-web-access-state').textContent==='Disabled · peer renewal retained'");
  assert.equal(await evaluate("document.getElementById('secure-web-access-peer-renewal').checkVisibility()"), true);
  assert.equal(fixture.helper.version, '1.104.2', 'Disabling retains the helper identity and version');
  const reads = requests.length;
  await evaluate("webBrowser.role('family');true"); await settle();
  assert.equal(await evaluate("document.getElementById('secure-web-access-admin').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-url').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-curl-command').textContent"), '');
  assert.equal(await evaluate("document.getElementById('secure-web-access-dns-a').textContent"), '');
  for(const id of ['browser-instructions','recovery-help','lan-backup-help']) assert.equal(await evaluate(`document.getElementById('secure-web-access-${id}').textContent`),'');
  assert.equal(await evaluate("document.getElementById('secure-web-access-security-warning').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-restore-identity').checkVisibility()"), false);
  assert.equal(await evaluate("document.getElementById('web-unsafe-warning').checkVisibility()"), true);
  assert.equal(requests.length, reads, 'Family does not poll the admin setup endpoint');
  assert.equal(await evaluate(`fetch('/api/web-access',{method:'POST',headers:{Authorization:'Bearer '+${JSON.stringify(familyToken)},'Content-Type':'application/json'},body:'{"action":"enable"}'}).then(r=>r.status)`), 403);
  assert.equal(await evaluate(`fetch('/api/web-access',{method:'POST',headers:{Authorization:'Bearer '+${JSON.stringify(familyToken)},'Content-Type':'application/json'},body:'{"action":"restore-identity","confirmedPeerFenced":true}'}).then(r=>r.status)`), 403);
  await captureLayout('family');
  await evaluate("webBrowser.role('anonymous');true"); await settle();
  assert.equal(await evaluate("document.getElementById('providers-controls').checkVisibility()"), false, 'Signed-out page hides installation folds');
  assert.equal(await evaluate("document.getElementById('secure-web-access-authorize').hasAttribute('href')"), false);
  assert.equal(await evaluate("document.getElementById('secure-web-access-url').hasAttribute('href')"), false);
  await captureLayout('signed-out', { anonymous: true });
  if (baselinePage) {
    await send('Page.navigate',{url:`${base}/baseline`});await until("document.getElementById('controls-details')");
    await evaluate("document.getElementById('connections-details').open=true;true");
    for(const row of folds) {
      await send('Emulation.setDeviceMetricsOverride',{width:row.width,height:1100,deviceScaleFactor:1,mobile:row.width<=390});
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(row.theme)};true`);await settle();
      row.baseline=await foldGeometry(unchangedFolds);
      for(let i=0;i<row.current.length;i++) {
        const current=row.current[i],baseline=row.baseline[i];
        assert.equal(current.id,baseline.id);assert.equal(current.child.length,baseline.child.length);
        assert(Math.abs(current.width-baseline.width)<.2,`${row.theme}/${row.width}: original fold width preserved: ${current.id}`);
        assert(Math.abs(current.height-baseline.height)<.2,`${row.theme}/${row.width}: original fold height preserved: ${current.id}`);
        assert.deepEqual(current.arrow,baseline.arrow,`${row.theme}/${row.width}: original chevron geometry preserved: ${current.id}`);
        for(let j=0;j<current.child.length;j++) {
          assert.equal(current.child[j].text,baseline.child[j].text);
          assert(Math.abs(current.child[j].center-baseline.child[j].center)<.2,`${row.theme}/${row.width}: original fold text alignment preserved: ${current.id}`);
        }
      }
    }
  }
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  assert.deepEqual(blocked, [], 'No external browser requests were attempted');
  if (screenshots) await writeFile(join(screenshots, 'geometry.json'), JSON.stringify({layouts,metadataLayouts,folds,triangleLayouts,runtimeStyles,baselineStyles,baselineCompared:Boolean(baselinePage)}, null, 2));
  console.log(`Secure web access browser checks passed: restored Connections/Configuration folds, standby/admin/family/signed-out boundaries, keyboard setup, authorization, DNS/hosts guidance, certificate/node-key expiry, cached urgent update, retained peer renewal, fenced identity restoration, custom policy selector, updates, cancel/focus, HTTP warning, all setup states, centered headers/buttons, 320/390/1440px and both themes.${baselinePage ? ' Other fold types match pre-HTTPS geometry; shared section-fold titles/statuses are centered, including Home learning.' : ''}${screenshots ? ` Synthetic screenshots: ${screenshots}` : ''}`);
} finally {
  socket?.close(); for (const request of pending.values()) clearTimeout(request.timer);
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolveExit => browser.once('exit', resolveExit)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
