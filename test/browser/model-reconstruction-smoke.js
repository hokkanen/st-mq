// Real History tools markup and styles; synthetic service, no household access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(join(tmpdir(), 'model-reconstruction-browser-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = Date.now(), requests = [], errors = [], pending = new Map(), layouts = [];
let browser, socket, server, sequence = 0;
let state = { state: 'idle', job: null, source: { role: 'slave', snapshotAt: now - 120_000 }, storage: { bytes: 0, disposable: true } };
try {
  const markup = (await readFile(join(root, 'chart/index.html'), 'utf8')).match(/<details id="model-reconstruction-details"[\s\S]*?<\/details>/)[0];
  server = createServer(async (request, response) => {
    const json = body => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      if (request.url === '/favicon.ico') return response.writeHead(204).end();
      if (request.url === '/api/model-reconstruction') return json(state);
      if (request.url === '/api/model-reconstruction/action' && request.method === 'POST') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
        assert.match(body.requestId, /^[a-f0-9-]{36}$/);
        state = { ...state, lastAction: { requestId: body.requestId, action: body.action } };
        if (body.action === 'pause') state.state = 'paused';
        else if (body.action === 'resume') state.state = 'running';
        else if (body.action === 'cancel') state = { ...state, state: 'idle', job: null };
        else if (body.action === 'discard') state = { ...state, state: 'idle', job: null, storage: { bytes: 0, disposable: true }, lastVerification: null };
        else state = { ...state, state: 'running', storage: { bytes: 2_000_000, disposable: true }, job: { kind: 'verify', requestId: body.requestId,
          phase: 'replaying', processed: 12, total: 48, startedAt: now - 60_000, targetAt: now - 30_000, journalId: 48 } };
        return json(state);
      }
      if (request.url === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        return response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/chart/monitor.css"><link rel="stylesheet" href="/chart/recording-health.css"></head><body data-authenticated="true" data-access-role="admin"><main><section class="panel"><details id="recording-details" open><summary>Recording details</summary><section class="recording-section-group recording-tools"><h3 class="recording-group-title">History tools</h3>${markup}</section></details></section></main><script type="module">import {createModelReconstruction} from '/chart/model-reconstruction.js'; window.panel=createModelReconstruction({document,storage:sessionStorage,request:async(path,body)=>{const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return response.json();}}); window.setRole=role=>{document.body.dataset.accessRole=role;panel.update({role:'slave',webAccess:{role}})};setRole('admin');</script></body></html>`);
      }
      const path = resolve(root, `.${decodeURIComponent(request.url)}`);
      if (!path.startsWith(`${root}/chart/`) && !path.startsWith(`${root}/src/`) || !/\.(js|css)$/.test(path)) return response.writeHead(404).end();
      response.writeHead(200, { 'Content-Type': path.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(await readFile(path));
    } catch (error) { errors.push(error.message); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = join(directory, 'chromium');
  browser = spawn(process.env.STMQ_CHROME_BIN ?? '/opt/google/chrome/chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port, launchError; browser.on('error', error => { launchError = error; });
  for (let attempt = 0; attempt < 200 && !port; attempt++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
    if (!port) await pause(30);
  }
  assert(port, 'Browser launched');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error(`Timeout ${method}`)), 20_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const until = async expression => {
    for (let attempt = 0; attempt < 200; attempt++) { if (await evaluate(`Boolean(${expression})`)) return; await pause(30); }
    throw Error(`UI did not settle: ${expression}`);
  };
  const id = name => `document.getElementById('model-reconstruction-${name}')`;
  const click = async name => {
    await until(`!${id(name)}.disabled`);
    const point = await evaluate(`(()=>{const element=${id(name)};element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,disabled:element.disabled,visible:!!r.height}})()`);
    assert.equal(point.disabled, false); assert(point.visible);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until('window.panel');
  await evaluate(`${id('details')}.open=true;true`); await until(`!${id('verify')}.disabled`);
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
    const layout = await evaluate(`(()=>{const panel=${id('details')},buttons=[...panel.querySelectorAll('button')].filter(e=>!e.hidden),facts=panel.querySelector('dl');return{width,scroll:document.documentElement.scrollWidth,viewport:innerWidth,minButton:Math.min(...buttons.map(e=>e.getBoundingClientRect().height)),columns:getComputedStyle(facts).gridTemplateColumns}})()`.replace('return{width,', `return{width:${width},`));
    assert(layout.scroll <= layout.viewport, `No horizontal overflow at ${width}`); assert(layout.minButton >= 44);
    layouts.push({ theme, ...layout });
  }
  await click('verify'); await until(`${id('status')}.textContent.includes('is running')`);
  assert.equal(await evaluate(`${id('discard')}.disabled`), true, 'Active worker data cannot be discarded');
  await click('pause'); await until(`${id('status')}.textContent.includes('is paused')`);
  await click('resume'); await until(`${id('status')}.textContent.includes('is running')`);
  await click('cancel'); await until(`${id('status')}.textContent.includes('No verification is running')`);
  await click('discard'); await until(`${id('storage')}.textContent.includes('0 B')`);
  assert.equal(await evaluate(`${id('discard')}.disabled`), true);
  state = { ...state, storage: { bytes: 2_000_000, disposable: true }, lastVerification: { state: 'matched', modelMatched: true, historyMatched: true, completedAt: now, checkedAt: now - 30_000, journalId: 48, current: true } };
  await evaluate('panel.refresh()');
  assert.match(await evaluate(`${id('result')}.textContent`), /Complete model: matched.*All four coefficient histories: matched/);
  state.lastVerification = { ...state.lastVerification, state:'mismatch', modelMatched:false,
    streams:[{input:'mqtt',modelMatched:false,historyMatched:true,differences:{count:12,numericCount:12,otherCount:0,
      maxAbsoluteDelta:2.220446049250313e-16,maxRelativeDelta:1.1102230246251565e-15,truncated:true,
      paths:Array.from({length:12},(_,index)=>`samples.${index}.inputSegments.0.fireplaceKgPerHour`),
      expected:'private-saved-value',actual:'private-replayed-value'}}],
    runtime:{node:'24.15.0',v8:'13.6.233.10-node.29',arch:'arm64',platform:'linux'}};
  await evaluate('panel.refresh()');
  const mismatch = await evaluate(`${id('result')}.textContent`);
  assert.match(mismatch,/Complete model: differed.*All four coefficient histories: matched.*12 model differences.*2.22e-16 absolute/);
  assert.match(mismatch,/samples\.7\.inputSegments\.0\.fireplaceKgPerHour; more omitted/);
  assert.doesNotMatch(mismatch,/samples\.(?:8|9|10|11)\.|private-(?:saved|replayed)-value/);
  assert.match(mismatch,/Replay runtime: Node 24\.15\.0.*linux\/arm64.*Exact comparison applies no tolerance/);
  for (const theme of ['light','dark']) for (const width of [320,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});
    await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
    const layout=await evaluate(`({scroll:document.documentElement.scrollWidth,viewport:innerWidth})`);
    assert(layout.scroll<=layout.viewport,`Mismatch diagnostics do not overflow at ${width}/${theme}`);
    layouts.push({theme,width,diagnostics:true,...layout});
  }
  state.lastVerification.streams[0].differences.roundingConsistent=true;
  await evaluate('panel.refresh()');
  assert.equal(await evaluate(`${id('summary')}.textContent`),'Minor numerical differences');
  const rounding=await evaluate(`${id('result')}.textContent`);
  assert.match(rounding,/Complete model: minor numerical differences consistent with rounding.*All four coefficient histories: matched exactly.*Exact full-model comparison: mismatch/);
  assert.doesNotMatch(rounding,/Complete model: differed|Preserve the learning history/);
  state.lastVerification.current=null;
  await evaluate('panel.refresh()');
  assert.equal(await evaluate(`${id('summary')}.textContent`),'Verification applicability unconfirmed');
  const unconfirmed=await evaluate(`${id('result')}.textContent`);
  assert.match(unconfirmed,/Applicability to the selected history is unconfirmed.*Complete model: minor numerical differences consistent with rounding.*coefficient histories: matched exactly.*Exact full-model comparison: mismatch/);
  assert.doesNotMatch(unconfirmed,/earlier source interpretation|does not verify the currently selected history/);
  for (const theme of ['light','dark']) for (const width of [320,1440]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500});
    await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
    const layout=await evaluate(`({scroll:document.documentElement.scrollWidth,viewport:innerWidth})`);
    assert(layout.scroll<=layout.viewport,`Unconfirmed result does not overflow at ${width}/${theme}`);
    layouts.push({theme,width,unconfirmed:true,...layout});
  }
  await evaluate("setRole('family');true"); await until(`${id('verify')}.disabled`);
  assert.equal(await evaluate(`${id('discard')}.disabled`), true);
  assert.match(await evaluate(`${id('storage')}.textContent`), /2 MB/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'pass', layouts, actions: requests.map(value => value.action), runtimeErrors: errors.length }));
} finally {
  socket?.close(); browser?.kill('SIGTERM');
  if (server) await new Promise(resolve => server.close(resolve));
  for (const task of pending.values()) clearTimeout(task.timer);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
