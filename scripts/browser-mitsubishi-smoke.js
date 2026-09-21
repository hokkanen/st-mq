// Synthetic app and browser-only pump responses. No device connection or actuation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/main.js';
import { loadConfig } from '../src/app/config.js';
import { build, preview } from 'vite';
const directory=mkdtempSync(join(tmpdir(),'stmq-mitsubishi-browser-'));
const artifacts=mkdtempSync(join(tmpdir(),'stmq-mitsubishi-screenshots-'));
const profile=join(directory,'chrome');mkdirSync(profile);
const now=Date.parse('2026-09-21T12:00:00Z'), pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app,browser,socket,ui,sequence=0;const pending=new Map(),errors=[];
try {
  const path=join(directory,'synthetic.json');writeFileSync(path,'{}');
  const config=loadConfig({STMQ_CONFIG:path,STMQ_DATA_DIR:directory,STMQ_PORT:'0',STMQ_INPUT:'simulated'},directory);
  app=await start({config,clock:()=>now});
  const uiDirectory=process.env.STMQ_UI_DIST??join(directory,'dist');
  if(!process.env.STMQ_UI_DIST)await build({build:{outDir:uiDirectory},logLevel:'warn'});
  ui=await preview({configFile:false,build:{outDir:uiDirectory},preview:{host:'127.0.0.1',port:0,
    proxy:{'/api':`http://127.0.0.1:${app.server.address().port}`}}});
  browser=spawn(process.env.STMQ_CHROME_BIN??'/opt/google/chrome/chrome',['--headless','--no-sandbox','--disable-gpu',
    '--no-first-run','--disable-background-networking','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  let launchError,port;browser.on('error',error=>{launchError=error;});
  for(let attempt=0;attempt<200&&!port;attempt++){if(launchError)throw launchError;
    try{port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);}catch{}
    if(!port)await pause(30);}
  assert(port,'Chromium DevTools started');
  const target=await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(response=>response.json());
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const task=pending.get(message.id);if(!task)return;
    pending.delete(message.id);clearTimeout(task.timer);message.error?task.reject(new Error(message.error.message)):task.resolve(message.result);
  }else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>reject(new Error(`CDP timeout: ${method}`)),20000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
  const until=async expression=>{for(let attempt=0;attempt<200;attempt++){if(await evaluate(expression))return;await pause(30);}throw new Error(`UI did not settle: ${expression}; ${JSON.stringify(await evaluate("({message:document.getElementById('garage-native-message')?.textContent,error:document.getElementById('error')?.textContent,result:globalThis.pumpSmokeResult,calls:globalThis.pumpSmokeCalls})"))}`);};
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`
    const originalInterval=globalThis.setInterval.bind(globalThis);
    globalThis.setInterval=(callback,delay,...args)=>{if(delay===15000)globalThis.refreshPumpSmoke=()=>callback(...args);return originalInterval(callback,delay,...args);};
    const originalFetch=globalThis.fetch.bind(globalThis);
    globalThis.pumpSmokeValues={power:'on',mode:'heat',targetC:22,fan:'auto',vane:'auto',wideVane:'center'};
    globalThis.pumpSmokeCalls=[];globalThis.pumpSmokeResult=null;globalThis.pumpSmokeReadOnly=false;globalThis.pumpSmokeOffline=false;
    const pumpFixture=status=>{
      const at=status.now,stale=globalThis.pumpSmokeOffline,values=globalThis.pumpSmokeValues;
      const choices={power:['on','off'],mode:['heat','cool','auto','dry','fan'],fan:['auto','quiet',1,2,3,4],vane:['auto',1,2,3,4,5,'swing'],wideVane:['far-left','left','center','right','far-right','split','swing']};
      status.readOnly=globalThis.pumpSmokeReadOnly;
      status.garage.adapter={...status.garage.adapter,connected:!stale,health:{deviceOnline:!stale,pumpCommunicating:!stale,driverProgressing:!stale},
        native:{...values,powerAt:at,readbacks:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,measuredAt:at}]))},
        telemetry:{indoorTemperature:{value:21.25,sourceTime:at,receivedAt:at,supported:true,usable:true,unit:'degC',quality:[],accuracyVerified:false},
          outdoorTemperature:{value:null,sourceTime:at,supported:false,quality:['unsupported'],unit:'degC'},
          compressorFrequency:{value:0,sourceTime:at,supported:true,usable:true,quality:[],unit:'Hz'},
          defrost:{value:false,sourceTime:at,supported:true,usable:true,quality:[],unit:'boolean'},
          energyCounterRaw:{value:0,sourceTime:at,supported:false,usable:false,quality:['unverified'],unit:'count'}}};
      status.garage.nativeControls={available:!stale,reason:stale?'Pump connection unavailable':null,
        busy:false,pending:globalThis.pumpSmokeResult?.status==='accepted',result:globalThis.pumpSmokeResult,
        settings:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,measuredAt:at,supported:true,usable:!stale,available:!stale,
          ...(key==='targetC'?{min:16,max:31,step:.5}:{values:choices[key]})}]))};
      return status;
    };
    globalThis.fetch=async(input,options)=>{
      const path=new URL(input.url??String(input),location.href).pathname;
      if(path==='/api/garage/native'){
        const command=JSON.parse(options.body);globalThis.pumpSmokeCalls.push(command);
        globalThis.pumpSmokeResult={...command,status:'accepted',requestedAt:${now},acceptedAt:${now}};
        const response=await originalFetch('/api/status');return new Response(JSON.stringify(pumpFixture(await response.json())),{status:200,headers:{'Content-Type':'application/json'}});
      }
      const response=await originalFetch(input,options);if(path!=='/api/status')return response;
      return new Response(JSON.stringify(pumpFixture(await response.json())),{status:response.status,headers:{'Content-Type':'application/json'}});
    };
  `});
  const address=ui.httpServer.address();
  await send('Page.navigate',{url:`http://127.0.0.1:${address.port}/`});
  await until("document.getElementById('garage-native-power')?.textContent==='on'");
  await until("typeof globalThis.refreshPumpSmoke==='function'");
  await evaluate("document.getElementById('garage-equipment-details').open=true;document.getElementById('garage-controller-details').open=true;document.getElementById('garage-native-control-details').open=true");
  for(const [setting,value] of [['power','off'],['mode','cool'],['fan',2],['vane','swing'],['wideVane','left'],['targetC',22.5]]){
    await evaluate(`document.getElementById('garage-native-setting').value=${JSON.stringify(setting)};document.getElementById('garage-native-setting').dispatchEvent(new Event('change'));`);
    if(setting==='targetC')await evaluate(`document.getElementById('garage-native-temperature').value='22.5';document.getElementById('garage-native-temperature').dispatchEvent(new Event('input'))`);
    else await evaluate(`document.getElementById('garage-native-value').value=${JSON.stringify(JSON.stringify(value))};document.getElementById('garage-native-value').dispatchEvent(new Event('change'))`);
    await evaluate("document.getElementById('garage-native-form').requestSubmit()");
    await until("document.getElementById('garage-native-message').textContent.includes('waiting for fresh pump confirmation')");
    assert.equal(await evaluate("document.getElementById('garage-native-submit').disabled"),true);
    assert.deepEqual(await evaluate('globalThis.pumpSmokeCalls.at(-1)'),{setting,value});
    await pause(150);
    await evaluate(`globalThis.pumpSmokeValues[${JSON.stringify(setting)}]=${JSON.stringify(value)};globalThis.pumpSmokeResult={...globalThis.pumpSmokeResult,status:'native-confirmed',nativeConfirmedAt:${now}};globalThis.refreshPumpSmoke()`);
    await until("document.getElementById('garage-native-message').textContent.includes('Confirmed by the pump')");
  }
  assert.equal(await evaluate('globalThis.pumpSmokeCalls.length'),6);
  await evaluate("document.getElementById('garage-native-temperature').value='23.5';document.getElementById('garage-native-temperature').dispatchEvent(new Event('input'));document.getElementById('garage-native-temperature').focus();globalThis.refreshPumpSmoke()");
  await pause(150);
  assert.equal(await evaluate("document.getElementById('garage-native-temperature').value==='23.5'&&document.activeElement.id==='garage-native-temperature'"),true);
  await evaluate("document.getElementById('garage-readings-details').open=true");
  assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-compressorFrequency] td').textContent.includes('0 Hz')"),true);
  assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-outdoorTemperature]')===null"),true);
  await evaluate("document.querySelector('[data-reading=telemetry-indoorTemperature] .status-detail-trigger').click()");
  assert.equal(await evaluate("document.getElementById('status-detail-popover').textContent.includes('Measurement accuracy has not been verified')"),true);
  await evaluate("document.querySelector('.status-detail-close').click()");
  for(const width of [1440,390,320])for(const theme of ['dark','light']){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}');document.getElementById('garage-controller-details').scrollIntoView({block:'start',behavior:'instant'})`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,`${width} ${theme} page overflow`);
    const overflow=await evaluate("(()=>{const root=document.getElementById('garage-controller-details'),bounds=root.getBoundingClientRect();return [...root.querySelectorAll('select,input,table')].filter(node=>node.offsetParent).filter(node=>{const r=node.getBoundingClientRect();return r.left<bounds.left-1||r.right>bounds.right+1;}).map(node=>node.id||node.tagName);})()");
    assert.deepEqual(overflow,[],`${width} ${theme} equipment content stays inside the card`);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});
    writeFileSync(join(artifacts,`mitsubishi-${width}-${theme}.png`),Buffer.from(screenshot.data,'base64'));
  }
  await evaluate('globalThis.pumpSmokeOffline=true;globalThis.refreshPumpSmoke()');
  await until("document.getElementById('garage-controller-state').textContent==='Not connected'");
  assert.equal(await evaluate("document.getElementById('garage-native-submit').disabled"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('#garage-native-readings td strong')].every(node=>node.textContent==='Unavailable')"),true);
  await evaluate('globalThis.pumpSmokeOffline=false;globalThis.pumpSmokeReadOnly=true;globalThis.refreshPumpSmoke()');
  await until("document.getElementById('garage-native-status').textContent.includes('read-only')");
  assert.equal(await evaluate("document.getElementById('garage-native-submit').disabled"),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'mitsubishi-browser-smoke-passed',artifacts,checks:['all six typed controls','accepted versus native confirmation','dirty edit and focus preserved','freshness and quality details','unsupported telemetry','320/390/1440px both themes','offline and read-only gating','no browser exceptions']}));
  await send('Page.close');
}finally{
  socket?.close();for(const task of pending.values())clearTimeout(task.timer);
  if(browser&&browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),pause(2000)]);}
  if(ui)await new Promise(resolve=>ui.httpServer.close(resolve));
  await app?.close();rmSync(directory,{recursive:true,force:true});
}
