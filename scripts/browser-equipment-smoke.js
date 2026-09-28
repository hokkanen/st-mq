// Synthetic localhost app and intercepted controls; no household configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { checkEquipmentBrowser } from './lib/equipment-browser-checks.js';
const directory=mkdtempSync(join(tmpdir(),'stmq-equipment-browser-'));
let app, socket, browser, id=0;
const pending=new Map(),errors=[];
const garageDoorsOnly=process.argv.includes('--garage-doors');
const caravanOnly=process.argv.includes('--caravan-only');
try {
  writeFileSync(join(directory,'options.json'),'{}');
  const config=loadConfig({STMQ_CONFIG:join(directory,'options.json'),STMQ_DATA_DIR:directory,STMQ_PORT:'0',STMQ_INPUT:'simulated'},directory);
  app=await start({config,clock:()=>Date.parse('2026-09-07T12:00:00Z')});
  app.engine.providerStatus=()=>({
    market:{source:'entsoe',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')},
    weather:{source:'fmi',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')}
  });
  let endpoint=process.argv.slice(2).find(arg=>!['--garage-doors','--caravan-only'].includes(arg));
  if(!endpoint) {
    const profile=join(directory,'chrome');mkdirSync(profile);
    browser=spawn(process.env.STMQ_CHROME_BIN??'/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-gpu',
      '--no-first-run','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',
      `--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
    let launchError;browser.on('error',error=>{launchError=error;});
    for(let attempt=0;attempt<200&&!endpoint;attempt++) {
      if(launchError)throw launchError;
      try {const port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);if(port)endpoint=`http://127.0.0.1:${port}`;}catch{}
      if(!endpoint)await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert(endpoint,'Isolated Chromium DevTools listener started');
  }
  const target=await fetch(`${endpoint}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error(`Timeout ${method}`)),15000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expression=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error(`Timed out: ${expression}`);};
  const command=async(method,params)=>{
    if(method==='browsingContext.setViewport')return send('Emulation.setDeviceMetricsOverride',{...params.viewport,deviceScaleFactor:1,mobile:false});
    if(method==='browsingContext.captureScreenshot')return send('Page.captureScreenshot',{format:'png'});
    if(method==='input.performActions'){for(const group of params.actions)for(const action of group.actions){const key=({'\uE00C':'Escape','\uE004':'Tab'})[action.value]??'Enter';await send('Input.dispatchKeyEvent',{type:action.type==='keyDown'?'keyDown':'keyUp',key,code:key,windowsVirtualKeyCode:({Escape:27,Tab:9,Enter:13})[key],...(key==='Enter'&&action.type==='keyDown'?{text:'\r',unmodifiedText:'\r'}:{})});}return;}
    throw new Error(`Unsupported browser operation ${method}`);
  };
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${app.server.address().port}/`});
  await until("document.getElementById('updated')?.textContent.startsWith('Updated')");
  mkdirSync('var',{recursive:true});
  await checkEquipmentBrowser({evaluate,command,context:'cdp',until,garageDoorsOnly,caravanOnly});
  assert.deepEqual(errors,[]);
  console.log(caravanOnly ? 'Caravan browser checks passed: supported settings, automatic power drafts and saving, recording states, authority, and both themes at 320/390/1440px.' : garageDoorsOnly ? 'Garage door browser checks passed: modal navigation, focus, pending commands, live reports, authority, and both themes at desktop, mobile and landscape sizes.' : 'Equipment browser checks passed: charger phase availability, local OCPP setup placement and keyboard disclosure, flat vehicle feeds with MQTT diagnostics, mocked equipment controls, Caravan layout, DHWR feedback and five responsive viewports.');
} finally {
  socket?.close();for(const p of pending.values())clearTimeout(p.timer);await app?.close();
  if(browser&&browser.exitCode===null) {browser.kill();await new Promise(resolve=>browser.once('exit',resolve));}
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
