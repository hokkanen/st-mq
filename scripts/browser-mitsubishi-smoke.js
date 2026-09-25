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
    globalThis.pumpSmokeCompressor='running';globalThis.pumpSmokeMissingReadings=false;globalThis.pumpSmokeRoom=null;globalThis.pumpSmokeExtraReadings={};
    const pumpFixture=status=>{
      const at=status.now,stale=globalThis.pumpSmokeOffline,values=globalThis.pumpSmokeValues;
      const choices={power:['on','off'],mode:['heat','cool','auto','dry','fan'],fan:['auto','quiet',1,2,3,4],vane:['auto',1,2,3,4,5,'swing'],wideVane:['far-left','left','center','right','far-right','split','swing']};
      status.readOnly=globalThis.pumpSmokeReadOnly;status.garage.roomTemperature=globalThis.pumpSmokeRoom;
      status.garage.adapter={...status.garage.adapter,connected:!stale,health:{deviceOnline:!stale,pumpCommunicating:!stale,driverProgressing:!stale},
        native:{...values,powerAt:at,readbacks:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,measuredAt:at}]))},
        telemetry:{indoorTemperature:{value:21.25,sourceTime:at,receivedAt:at,supported:true,usable:true,unit:'degC',quality:[],accuracyVerified:false},
          outdoorTemperature:{value:null,sourceTime:at,supported:false,quality:['unsupported'],unit:'degC'},
          compressorFrequency:{value:0,sourceTime:at,supported:true,usable:true,quality:[],unit:'Hz'},
          compressorActive:{value:globalThis.pumpSmokeCompressor!=='idle',sourceTime:globalThis.pumpSmokeCompressor==='stale'?at-120000:at,
            supported:globalThis.pumpSmokeCompressor!=='unsupported',usable:true,quality:globalThis.pumpSmokeCompressor==='unsupported'?['unsupported']:[],unit:'boolean'},
          defrost:{value:false,sourceTime:at,supported:true,usable:true,quality:[],unit:'boolean'},
          energyCounterRaw:{value:0,sourceTime:at,supported:false,usable:false,quality:['unverified'],unit:'count'},
          ...globalThis.pumpSmokeExtraReadings}};
      if(globalThis.pumpSmokeCompressor==='missing')delete status.garage.adapter.telemetry.compressorActive;
      if(globalThis.pumpSmokeMissingReadings){status.garage.adapter.native={};status.garage.adapter.telemetry={};}
      status.garage.nativeControls={available:!stale,reason:stale?'Pump connection unavailable':null,
        busy:false,pending:globalThis.pumpSmokeResult?.status==='accepted',result:globalThis.pumpSmokeResult,
        settings:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value:key==='targetC'&&globalThis.pumpSmokeRoom?globalThis.pumpSmokeRoom.targetC:value,measuredAt:at,supported:true,usable:!stale,available:!stale,
          ...(key==='targetC'?{min:8,max:31,step:.5}:{values:choices[key]})}]))};
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
  await until("document.getElementById('garage-native-power')?.textContent==='On'");
  await until("typeof globalThis.refreshPumpSmoke==='function'");
  assert.equal(await evaluate("document.getElementById('garage-readings-details').tagName"),'DETAILS');
  assert.equal(await evaluate("document.getElementById('garage-readings-details').open"),false,'heat pump readings are in their own fold');
  assert.equal(await evaluate("document.getElementById('garage-readings-details').hidden"),false);
  await evaluate("document.getElementById('garage-equipment-details').open=true;document.getElementById('garage-controller-details').open=true;document.getElementById('garage-readings-details').open=true;document.getElementById('garage-native-control-details').open=true");
  const trustedClick=async selector=>{
    await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight)node.scrollIntoView({block:'center',behavior:'instant'});})()`);
    await pause(50);
    const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  };
  const pressKey=async key=>{const codes={Home:[36,'Home'],ArrowDown:[40,'ArrowDown']};
    const [windowsVirtualKeyCode,code]=codes[key];
    await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});};
  await evaluate("document.getElementById('garage-native-setting').focus()");
  for(const key of ['Home','ArrowDown','ArrowDown'])await pressKey(key);
  await until("document.getElementById('garage-native-setting').value==='targetC'");
  assert.equal(await evaluate("document.getElementById('garage-native-setting').matches(':open')"),false,'choosing room setting closes the native menu');
  assert.equal(await evaluate("document.activeElement.id"),'garage-native-setting','keyboard selection keeps focus on the setting selector');
  await trustedClick('#garage-native-temperature');
  assert.equal(await evaluate("document.getElementById('garage-native-setting').matches(':open')"),false,'temperature input does not reopen the native menu');
  assert.equal(await evaluate("document.activeElement.id"),'garage-native-temperature');
  for(const [setting,editor,pointerType] of [['power','garage-native-value','mouse'],['targetC','garage-native-temperature','touch']]){
    await trustedClick('#garage-native-setting');
    assert.equal(await evaluate("document.getElementById('garage-native-setting').matches(':open')"),true,'native menu opens before the pointer choice');
    await evaluate(`(()=>{const selector=document.getElementById('garage-native-setting');selector.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:${JSON.stringify(pointerType)}}));selector.value=${JSON.stringify(setting)};selector.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(`document.activeElement.id===${JSON.stringify(editor)}`);
    assert.equal(await evaluate("document.getElementById('garage-native-setting').matches(':open')"),false,`${pointerType} setting choice closes the menu and focuses its value editor`);
  }
  // Exercise the shared dismissal with real open native menus, including a dynamic control.
  await evaluate("document.getElementById('garage-native-setting').value='fan';document.getElementById('garage-native-setting').dispatchEvent(new Event('change'));const select=document.createElement('select');select.id='dynamic-select-smoke';select.innerHTML='<option>First</option><option>Second</option>';document.body.append(select)");
  for(const id of ['left-axis','garage-native-value','dynamic-select-smoke']) {
    for(const pointerType of ['mouse','touch']) {
      await trustedClick(`#${id}`);
      assert.equal(await evaluate(`document.getElementById('${id}').matches(':open')`),true,`${id} menu opens`);
      await evaluate(`(()=>{const select=document.getElementById('${id}');if('${pointerType}'==='touch')select.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'}));select.selectedIndex=select.selectedIndex===1?2:1;if(select.selectedIndex<0)select.selectedIndex=0;select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      assert.equal(await evaluate(`document.getElementById('${id}').matches(':open')`),false,`${id} ${pointerType} selection closes menu`);
      assert.notEqual(await evaluate('document.activeElement.id'),id);
    }
    await evaluate(`document.getElementById('${id}').focus()`);
    await pressKey('ArrowDown');
    assert.equal(await evaluate('document.activeElement.id'),id,`${id} keyboard navigation retains focus`);
  }
  await evaluate("document.getElementById('dynamic-select-smoke').remove()");
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
  const readingKeys=['telemetry-compressorActive','telemetry-compressorFrequency','telemetry-defrost',
    'telemetry-indoorTemperature','native-power','native-mode','native-targetC','native-fan','native-vane','native-wideVane'];
  const absentKeys=['telemetry-actualFan','telemetry-preheat','telemetry-standby','telemetry-faultRaw',
    'telemetry-outdoorTemperature','telemetry-power','telemetry-energy','telemetry-energyCounterRaw'];
  const readingGroups=async()=>evaluate("[...document.querySelectorAll('#garage-native-readings table caption')].map(node=>node.textContent)");
  const absentRows=async keys=>assert.deepEqual(await evaluate(`(${JSON.stringify(keys)}).filter(key=>document.querySelector('[data-reading='+key+']'))`),[],'never-observed unsupported readings stay absent');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#garage-native-readings [data-reading]')].map(row=>row.dataset.reading)"),readingKeys);
  assert.deepEqual(await readingGroups(),['Operation','Temperatures','Pump settings']);
  await absentRows(absentKeys);
  await evaluate("globalThis.pumpSmokeReadingRows=[...document.querySelectorAll('#garage-native-readings [data-reading]')]");
  const stableRows=async()=>assert.equal(await evaluate("globalThis.pumpSmokeReadingRows.every(row=>row.isConnected&&document.querySelector('[data-reading='+row.dataset.reading+']')===row)"),true,'reading rows survive status changes');
  assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-compressorFrequency] td strong').textContent"),'0 Hz');
  assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-defrost] td strong').textContent"),'No','real false is meaningful data');
  assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-compressorFrequency] .equipment-reading-qualifier').textContent"),'Provisional');
  for(const [state,summary,reading,qualifier] of [['running','Running','Running','Provisional'],['idle','Idle','Idle','Provisional'],
    ['stale','Unknown','Unavailable','Stale or unavailable'],['missing','Unknown','Unavailable','No reading'],['unsupported','Unknown','Unavailable','Unsupported']]){
    await evaluate(`globalThis.pumpSmokeCompressor=${JSON.stringify(state)};globalThis.refreshPumpSmoke()`);
    await until(`document.getElementById('garage-native-compressor').textContent===${JSON.stringify(summary)}&&document.querySelector('[data-reading=telemetry-compressorActive] .equipment-reading-qualifier').textContent===${JSON.stringify(qualifier)}`);
    assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-compressorActive] td strong').textContent"),reading,state);
    assert.equal(await evaluate("document.querySelector('[data-reading=telemetry-compressorActive]').offsetHeight>0"),true);
    await stableRows();
  }
  await evaluate('globalThis.pumpSmokeMissingReadings=true;globalThis.refreshPumpSmoke()');
  await until("[...document.querySelectorAll('#garage-native-readings td strong')].every(node=>node.textContent==='Unavailable')");
  await stableRows();
  await absentRows(absentKeys);
  assert.deepEqual(await readingGroups(),['Operation','Temperatures','Pump settings']);
  assert.equal(await evaluate("document.getElementById('garage-native-compressor').textContent"),'Unknown');
  await evaluate("globalThis.pumpSmokeMissingReadings=false;globalThis.pumpSmokeCompressor='running';globalThis.refreshPumpSmoke()");
  await until("document.getElementById('garage-native-compressor').textContent==='Running'");
  await stableRows();
  const description=await evaluate("document.querySelector('[data-reading=telemetry-indoorTemperature] .h66-reading-description').textContent");
  assert.equal(description,'Temperature used by the pump’s thermostat.');
  await evaluate("document.querySelector('[data-reading=telemetry-indoorTemperature] .status-detail-trigger').click()");
  const temperatureDetail=await evaluate("document.getElementById('status-detail-popover').textContent");
  assert.match(temperatureDetail,/internal sensor.*supplied external temperature.*offset/s);
  assert.match(temperatureDetail,/not necessarily measured room air/);
  assert.match(temperatureDetail,/Measurement accuracy has not been verified/);
  assert.doesNotMatch(temperatureDetail,/ST-MQ/i);
  await evaluate("document.querySelector('.status-detail-close').click()");
  assert.equal(await evaluate("document.activeElement.closest('[data-reading]')?.dataset.reading"),'telemetry-indoorTemperature');
  assert.equal(await evaluate("document.getElementById('garage-native-temperature-help').hidden"),false);
  assert.equal(await evaluate("document.getElementById('garage-room-temperature-status').hidden"),true,'help exists before saving a room setting');
  assert.equal(await evaluate("document.getElementById('garage-native-temperature-help').textContent.trim().split(/\\s+/).length<=25"),true);
  await evaluate("document.querySelector('#garage-native-temperature-details .status-detail-trigger').click()");
  const controlHelp=await evaluate("document.getElementById('status-detail-popover').textContent");
  assert.match(controlHelp,/Below 16 °C.*Garage rear.*17 °C.*offset/s);
  assert.match(controlHelp,/16 °C or higher replace the lower target and use normal pump control/);
  assert.match(controlHelp,/stays in effect until changed, including after restart/);
  assert.match(controlHelp,/Fan and vane changes preserve it/);
  assert.match(controlHelp,/fresh sensor readings.*power on, heating mode and 17 °C/s);
  assert.match(controlHelp,/checks fail.*renewals stop.*internal sensor/s);
  assert.doesNotMatch(controlHelp,/ST-MQ/i);
  await evaluate("document.querySelector('.status-detail-close').click()");
  assert.equal(await evaluate("document.activeElement.closest('#garage-native-temperature-details')?.id"),'garage-native-temperature-details');
  await evaluate(`globalThis.pumpSmokeRoom={targetC:10,nativeTargetC:17,offsetC:7,sourceC:10,suppliedC:17,measuredAt:${now},phase:'active',acknowledged:true};globalThis.pumpSmokeValues={...globalThis.pumpSmokeValues,power:'on',mode:'heat',targetC:17};globalThis.pumpSmokeResult={setting:'targetC',value:10,status:'acknowledged'};globalThis.refreshPumpSmoke()`);
  await until("document.getElementById('garage-native-target-basis').textContent==='Garage rear · Active'");
  assert.equal(await evaluate("document.getElementById('garage-native-target').textContent"),'10 °C');
  assert.equal(await evaluate("document.getElementById('garage-native-reported').textContent"),'17 °C');
  await evaluate("document.getElementById('garage-native-setting').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.getElementById('garage-native-temperature').value"),'10');
  assert.match(await evaluate("document.getElementById('garage-room-temperature-status').textContent"),/Room setting 10 °C.*Garage rear control is active/);
  await evaluate("document.querySelector('#garage-native-temperature-details .status-detail-trigger').click()");
  const activeHelp=await evaluate("document.getElementById('status-detail-popover').textContent");
  assert.match(activeHelp,/Room setting: 10 °C.*native pump target of 17 °C.*adds 7 °C/s);
  assert.match(activeHelp,/Garage rear: 10 °C.*Supplied temperature: 17 °C/s);
  assert.match(activeHelp,/fresh pump readings show ON, HEAT and 17 °C.*check fails.*renewals stop/s);
  assert.match(activeHelp,/16 °C or higher.*replaces the lower target/s);
  assert.doesNotMatch(activeHelp,/Temporary until|two hours|configured room target/);
  assert.doesNotMatch(activeHelp,/ST-MQ/i);
  await evaluate("document.querySelector('.status-detail-close').click()");
  assert.doesNotMatch(await evaluate("document.body.innerText"),/ST-MQ/i);
  for(const width of [1440,390,320])for(const theme of ['dark','light']){
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.homeEnergyTheme.setTheme('${theme}');document.getElementById('garage-controller-details').scrollIntoView({block:'start',behavior:'instant'})`);
    assert.equal(await evaluate('document.documentElement.scrollWidth<=window.innerWidth'),true,`${width} ${theme} page overflow`);
    const overflow=await evaluate("(()=>{const root=document.getElementById('garage-controller-details'),bounds=root.getBoundingClientRect();return [...root.querySelectorAll('select,input,table')].filter(node=>node.offsetParent).filter(node=>{const r=node.getBoundingClientRect();return r.left<bounds.left-1||r.right>bounds.right+1;}).map(node=>node.id||node.tagName);})()");
    assert.deepEqual(overflow,[],`${width} ${theme} equipment content stays inside the card`);
    await evaluate("globalThis.pumpSmokeCompressor='stale';globalThis.refreshPumpSmoke()");
    await until("document.getElementById('garage-native-compressor').textContent==='Unknown'");
    const unavailableLines=await evaluate("[...document.querySelectorAll('#garage-native-readings td.stale .status-detail-label')].filter(node=>node.textContent==='Unavailable').map(node=>{const range=document.createRange();range.selectNodeContents(node);return {reading:node.closest('[data-reading]').dataset.reading,lines:range.getClientRects().length};})");
    assert.equal(unavailableLines.length,1,`${width} ${theme} previously real compressor reading stays visible while stale`);
    assert.deepEqual(unavailableLines.filter(reading=>reading.lines!==1),[],`${width} ${theme} unavailable values stay on one line`);
    await evaluate("globalThis.pumpSmokeCompressor='running';globalThis.refreshPumpSmoke()");
    await until("document.getElementById('garage-native-compressor').textContent==='Running'");
    const capture=async name=>{
      const screenshot=await send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(artifacts,`mitsubishi-${name}${width}-${theme}.png`),Buffer.from(screenshot.data,'base64'));
    };
    await capture('');
    await evaluate("document.querySelector('[data-reading=telemetry-indoorTemperature]').scrollIntoView({block:'start',behavior:'instant'})");
    await capture('temperatures-');
    await evaluate("document.getElementById('garage-native-temperature-help').scrollIntoView({block:'start',behavior:'instant'});document.querySelector('#garage-native-temperature-details .status-detail-trigger').click()");
    assert.equal(await evaluate("(()=>{const panel=document.getElementById('status-detail-popover'),r=panel.getBoundingClientRect();return !panel.hidden&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()"),true,`${width} ${theme} popup stays inside the viewport`);
    await capture('help-');
    await evaluate("document.querySelector('.status-detail-close').click()");
  }
  // Previously absent fields become visible only after meaningful supported data arrives.
  await evaluate(`globalThis.pumpSmokeExtraReadings={outdoorTemperature:{value:0,sourceTime:${now},supported:true,usable:true,quality:[],unit:'degC'},power:{value:0,sourceTime:${now},supported:true,usable:true,quality:[],unit:'W'},futureUnknown:{value:'unknown',sourceTime:${now},supported:true,quality:['unknown'],unit:'raw'},futureUnsupported:{value:8,sourceTime:${now},supported:false,quality:['unsupported'],unit:'raw'}};globalThis.refreshPumpSmoke()`);
  await until("document.querySelector('[data-reading=telemetry-outdoorTemperature] td strong')?.textContent==='0 °C'&&document.querySelector('[data-reading=telemetry-power] td strong')?.textContent==='0 W'");
  assert.deepEqual(await readingGroups(),['Operation','Temperatures','Pump settings','Electricity']);
  await absentRows([...absentKeys.filter(key=>!['telemetry-outdoorTemperature','telemetry-power'].includes(key)),'telemetry-futureUnknown','telemetry-futureUnsupported']);
  await evaluate("globalThis.pumpSmokeReadingRows=[...document.querySelectorAll('#garage-native-readings [data-reading]')];globalThis.pumpSmokeExtraReadings={};globalThis.refreshPumpSmoke()");
  await until("document.querySelector('[data-reading=telemetry-outdoorTemperature] td strong').textContent==='Unavailable'&&document.querySelector('[data-reading=telemetry-power] td strong').textContent==='Unavailable'");
  await stableRows();
  await absentRows(['telemetry-energy','telemetry-energyCounterRaw','telemetry-futureUnknown','telemetry-futureUnsupported']);
  assert.deepEqual(await readingGroups(),['Operation','Temperatures','Pump settings','Electricity']);
  await evaluate('globalThis.pumpSmokeOffline=true;globalThis.refreshPumpSmoke()');
  await until("document.getElementById('garage-controller-state').textContent==='Not connected'");
  assert.equal(await evaluate("document.getElementById('garage-native-submit').disabled"),true);
  assert.equal(await evaluate("[...document.querySelectorAll('#garage-native-readings td strong')].every(node=>node.textContent==='Unavailable')"),true);
  await evaluate('globalThis.pumpSmokeOffline=false;globalThis.pumpSmokeReadOnly=true;globalThis.refreshPumpSmoke()');
  await until("document.getElementById('garage-native-status').textContent.includes('read-only')");
  assert.equal(await evaluate("document.getElementById('garage-native-submit').disabled"),true);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'mitsubishi-browser-smoke-passed',artifacts,checks:['chart axis, pump values and dynamic dropdowns close after mouse/touch selection and retain keyboard focus','readings in their own fold','native room selection closes menu','pointer and touch setting changes close the menu and focus the value editor','all six typed controls','accepted versus native confirmation','dirty edit and focus preserved','compressor running idle and unknown states','supported readings retained through temporary data loss','concise temperature and low-target popup help','active room sensor and offset details','freshness and quality details','never-observed unsupported fields and empty groups omitted','new real zero readings appear and remain through later loss','320/390/1440px both themes','unavailable values remain on one line','offline and read-only gating','no browser exceptions']}));
  await send('Page.close');
}finally{
  socket?.close();for(const task of pending.values())clearTimeout(task.timer);
  if(browser&&browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),pause(2000)]);}
  if(ui)await new Promise(resolve=>ui.httpServer.close(resolve));
  await app?.close();rmSync(directory,{recursive:true,force:true});
}
