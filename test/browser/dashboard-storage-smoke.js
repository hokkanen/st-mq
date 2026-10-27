// The production dashboard and a disposable simulated application. Only the
// browser's status evidence and one delayed request are controlled by this test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';

const directory = await mkdtemp(join(tmpdir(), 'stmq-dashboard-storage-'));
const screenshots = process.env.STMQ_STORAGE_DASHBOARD_SCREENSHOTS;
const token = 'synthetic-storage-dashboard-admin-token';
let app, browser, socket, sequence = 0;
const requests = new Map(), errors = [];
try {
  const configuration = join(directory, 'fixture.json');
  await writeFile(configuration, '{}');
  const config = loadConfig({ STMQ_CONFIG: configuration, STMQ_DATA_DIR: directory,
    STMQ_INPUT: 'simulated', STMQ_PORT: '0', STMQ_API_TOKEN: token }, directory);
  app = await start({ config });
  const profile = join(directory, 'browser'); await mkdir(profile);
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let launchError, port;
  browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert(port, 'Chrome starts with a disposable profile');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = requests.get(message.id); if (!request) return;
      requests.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { requests.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
    requests.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${expression}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.storageBrowser={writer:'ready',pending:false,statusReads:0,healthReads:0,failStatus:false,holdAction:false,actionStarted:false};
    const originalFetch=window.fetch.bind(window), originalInterval=window.setInterval.bind(window);
    window.setInterval=(callback,delay,...args)=>{
      if(delay===15000)storageBrowser.poll=callback;
      return originalInterval(callback,delay,...args);
    };
    window.fetch=async(input,options)=>{
      const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
      if(path==='/api/status'&&storageBrowser.failStatus)return new Response(JSON.stringify({error:'Synthetic status unavailable'}),
        {status:503,headers:{'Content-Type':'application/json'}});
      if(path==='/api/automation'&&storageBrowser.holdAction){
        storageBrowser.actionStarted=true;
        await new Promise(resolve=>storageBrowser.releaseAction=resolve);
      }
      const response=await originalFetch(input,options);
      if(!['/api/status','/api/recording-health'].includes(path)||!response.ok)return response;
      const value=await response.json();
      const health=path==='/api/status'?value.recordingHealth:value;
      health.recording.writer={state:storageBrowser.writer};
      if(['confirming','unavailable'].includes(storageBrowser.writer)){
        const confirming=storageBrowser.writer==='confirming';
        health.recording.state=confirming?'writer-confirming':'writer-unavailable';
        health.recording.detail=confirming?'The storage writer stopped responding. The last save is being checked before its outcome is reported; control requests remain blocked.'
          :'Confirmed saves remain recorded. New recording and storage-dependent control are unavailable. Check storage, then restart the application.';
        health.attention=[...health.attention.filter(item=>item.id!=='storage-writer'),{id:'storage-writer',severity:confirming?'warning':'critical',
          title:confirming?'Confirming the last save':'Storage writer is unavailable',detail:health.recording.detail}];
      }
      if(path==='/api/status'){
        value.storagePending=storageBrowser.pending;
        storageBrowser.statusReads++;
      }else{storageBrowser.healthReads++;}
      return new Response(JSON.stringify(value),{status:response.status,headers:response.headers});
    };
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}/` });
  await until("document.getElementById('auth') && !document.getElementById('auth').hidden");
  await evaluate(`document.getElementById('token').value=${JSON.stringify(token)};document.getElementById('auth').requestSubmit();true`);
  await until("document.body.dataset.authenticated==='true' && storageBrowser.statusReads>0 && !document.getElementById('home-automation-automatic').disabled");
  await evaluate("document.getElementById('home-heat-pump-details').open=true;document.getElementById('pause-until').value='2026-12-20T15:30';document.getElementById('pause-until').dispatchEvent(new Event('input',{bubbles:true}));storageBrowser.holdAction=true;document.getElementById('home-automation-automatic').click();true");
  await until('storageBrowser.actionStarted');
  await evaluate("storageBrowser.writer='saving';storageBrowser.pending=true;window.beforeReads=storageBrowser.statusReads;storageBrowser.poll();true");
  await until('storageBrowser.statusReads>beforeReads');
  await until("document.getElementById('context').textContent.includes('saved readings alongside live door reports')");
  assert.equal(await evaluate("document.getElementById('pause-until').value"), '2026-12-20T15:30', 'Health polling retains the pending form draft');
  assert.equal(await evaluate("document.getElementById('home-automation-message').textContent"), 'Enabling automatic heating…');
  assert.equal(await evaluate("document.getElementById('connection').textContent"), 'Simulation');
  assert.equal(await evaluate("document.getElementById('database-export-save').disabled"), false, 'Normal writer activity does not block unrelated saves');
  await evaluate("storageBrowser.writer='confirming';window.beforeReads=storageBrowser.statusReads;storageBrowser.poll();true");
  await until('storageBrowser.statusReads>beforeReads');
  await until("document.getElementById('read-only-help').textContent.includes('last save is confirmed')");
  assert.equal(await evaluate("document.getElementById('database-export-save').disabled"), true);
  assert.equal(await evaluate("document.getElementById('database-export-download').disabled"), false);
  assert.equal(await evaluate("document.getElementById('home-automation-message').textContent"), 'Enabling automatic heating…', 'Writer confirmation is separate from the action receipt');
  await evaluate("storageBrowser.writer='unavailable';window.beforeReads=storageBrowser.statusReads;storageBrowser.poll();true");
  await until('storageBrowser.statusReads>beforeReads');
  await until("document.getElementById('context').textContent.includes('original timestamps')");
  assert.equal(await evaluate("document.getElementById('recording-status-state').textContent"), 'Recording unavailable');
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const width of [320, 390, 1440]) for (const theme of ['dark', 'light']) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}');scrollTo(0,0);true`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `${width}/${theme}: dashboard has no horizontal overflow`);
    assert.equal(await evaluate("(()=>{const node=document.getElementById('context');return node.scrollWidth<=node.clientWidth})()"), true);
    assert.equal(await evaluate("(()=>{const node=document.getElementById('read-only-help');return node.scrollWidth<=node.clientWidth})()"), true);
    if (screenshots) {
      const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(screenshots, `writer-unavailable-${width}-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
  }
  await evaluate('storageBrowser.failStatus=true;window.beforeHealthReads=storageBrowser.healthReads;storageBrowser.poll();true');
  await until('storageBrowser.healthReads>beforeHealthReads');
  assert.equal(await evaluate("document.getElementById('connection').textContent"), 'Connection needs attention',
    'Successful health fallback cannot renew failed dashboard communication');
  await evaluate("document.getElementById('recording-details').open=true;window.beforeHealthReads=storageBrowser.healthReads;document.getElementById('recording-health-refresh').click();true");
  await until('storageBrowser.healthReads>beforeHealthReads');
  assert.equal(await evaluate("document.getElementById('database-export-save').disabled"), true);
  assert.equal(await evaluate("document.getElementById('connection').textContent"), 'Connection needs attention');
  assert.equal(await evaluate("document.getElementById('pause-until').value"), '2026-12-20T15:30');
  await evaluate('storageBrowser.releaseAction();true');
  await until("!document.getElementById('home-automation-message').textContent.includes('Enabling')");
  assert.equal(await evaluate("document.getElementById('database-export-save').disabled"), true, 'An ordinary action reply cannot clear unavailable writer evidence');
  await evaluate("storageBrowser.failStatus=false;storageBrowser.writer='ready';storageBrowser.pending=false;window.beforeReads=storageBrowser.statusReads;storageBrowser.poll();true");
  await until('storageBrowser.statusReads>beforeReads');
  await until("!document.getElementById('database-export-save').disabled && document.getElementById('read-only-help').hidden");
  assert.doesNotMatch(await evaluate("document.getElementById('context').textContent"), /last saved|original timestamps/);
  assert.equal(await evaluate("document.getElementById('pause-until').value"), '2026-12-20T15:30', 'Settlement and normal polling retain the draft');
  assert.deepEqual(errors, []);
  console.log('Dashboard storage browser checks passed: busy observation, retained drafts and receipts, writer restrictions, read-only inspection, dated health retention and six responsive theme layouts.');
} finally {
  socket?.close(); for (const request of requests.values()) clearTimeout(request.timer);
  await app?.close();
  if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
