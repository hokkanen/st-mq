// Synthetic localhost app and intercepted controls; no household configuration.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { checkEquipmentBrowser } from './lib/equipment-browser-checks.js';
const directory=mkdtempSync(join(tmpdir(),'stmq-equipment-browser-'));
let app, socket, id=0;
const pending=new Map(),errors=[];
try {
  writeFileSync(join(directory,'options.json'),'{}');
  const config=loadConfig({STMQ_CONFIG:join(directory,'options.json'),STMQ_DATA_DIR:directory,STMQ_PORT:'0',STMQ_INPUT:'simulated'},directory);
  app=await start({config,clock:()=>Date.parse('2026-09-07T12:00:00Z')});
  app.engine.providerStatus=()=>({
    market:{source:'entsoe',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')},
    weather:{source:'fmi',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')}
  });
  const endpoint=process.argv[2]??'http://127.0.0.1:39135';
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
    if(method==='input.performActions'){for(const group of params.actions)for(const action of group.actions){const key=action.value==='\uE00C'?'Escape':'Enter';await send('Input.dispatchKeyEvent',{type:action.type==='keyDown'?'keyDown':'keyUp',key,code:key,windowsVirtualKeyCode:key==='Escape'?27:13});}return;}
    throw new Error(`Unsupported browser operation ${method}`);
  };
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${app.server.address().port}/`});
  await until("document.getElementById('updated')?.textContent.startsWith('Updated')");
  mkdirSync('var',{recursive:true});
  await checkEquipmentBrowser({evaluate,command,context:'cdp',until});
  assert.deepEqual(errors,[]);
  console.log('Equipment browser checks passed: live controls, dynamic devices, MQTT diagnostics, DHWR feedback, popup baseline, five responsive viewports.');
} finally {
  socket?.close();for(const p of pending.values())clearTimeout(p.timer);await app?.close();rmSync(directory,{recursive:true,force:true});
}
