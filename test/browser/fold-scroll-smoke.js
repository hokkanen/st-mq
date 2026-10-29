// Synthetic localhost app and real native activation; no household configuration.
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start } from '../../src/main.js';
import { loadConfig } from '../../src/app/config.js';
const widths=process.argv.slice(2).map(Number);
if(!widths.length) widths.push(320,390,1440);
assert(widths.every(width=>Number.isInteger(width)&&width>0),'Widths must be positive integers');
const directory=mkdtempSync(join(tmpdir(),'stmq-fold-scroll-browser-'));
let app, socket, browser, id=0;
const pending=new Map(),errors=[];
try {
  writeFileSync(join(directory,'options.json'),'{}');
  const config=loadConfig({STMQ_CONFIG:join(directory,'options.json'),STMQ_DATA_DIR:directory,STMQ_PORT:'0',STMQ_INPUT:'simulated'},directory);
  app=await start({config,clock:()=>Date.parse('2026-09-07T12:00:00Z')});
  app.engine.providerStatus=()=>({
    market:{source:'entsoe',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')},
    weather:{source:'fmi',status:'ok',lastSuccessAt:Date.parse('2026-09-07T12:00:00Z')}
  });
  let endpoint;
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
  await send('Runtime.enable');await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:`http://127.0.0.1:${app.server.address().port}/`});
  await until("document.getElementById('updated')?.textContent.startsWith('Updated')");
  const settle = () => evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  // Exercise the real Garage geometry before adding catalogue filler. The
  // neighbouring reordered card must not become the browser's scroll anchor.
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await send('Emulation.setTouchEmulationEnabled',{enabled:true});
  for(const id of ['home-equipment-details','garage-equipment-details','connections-details']) {
    await evaluate(`document.querySelectorAll('details').forEach(d=>d.open=false);
      document.querySelector('#${id} > summary').scrollIntoView({block:'center'});true`);
    await settle();
    const before=await evaluate(`(() => {const r=document.querySelector('#${id} > summary').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top};})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:before.x,y:before.y}]});
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await settle();
    assert.equal(await evaluate(`document.getElementById('${id}').open`),true,id);
    const top=await evaluate(`document.querySelector('#${id} > summary').getBoundingClientRect().top`);
    assert(Math.abs(top-before.top)<=1,`${id}: real layout moved ${top-before.top}px`);
  }
  // Include hidden conditional markup and folds created by the real renderers.
  const count = await evaluate(`(() => {
    window.foldCatalogue=[...document.querySelectorAll('details')];
    window.refreshFoldUnderTest=()=>{
      if(!foldUnderTest.isConnected) {
        const key=foldUnderTest.closest('[data-activity-key]')?.dataset.activityKey;
        if(key) foldUnderTest=document.querySelector('[data-activity-key="'+key+'"] .activity-caption');
      }
      if(!foldUnderTest?.isConnected) throw new Error('Disclosure was removed during catalogue activation');
      for(let node=foldUnderTest;node && node!==document.body;node=node.parentElement) {
        node.hidden=false;
        if(node.tagName==='DIALOG' && !node.open) node.showModal();
        if(getComputedStyle(node).display==='none') node.style.setProperty('display','block','important');
      }
    };
    for(const fold of window.foldCatalogue) {
      for(let node=fold;node && node!==document.body;node=node.parentElement) node.hidden=false;
      // Ensure even empty/unconfigured folds have enough content to expose jumps.
      const content=document.createElement('p');content.textContent='Synthetic disclosure content';
      content.style.height='300px';fold.append(content);
    }
    const padded=new Set();
    for(const fold of window.foldCatalogue) {
      const dialog=fold.closest('dialog');if(!dialog) continue;
      let scroller=fold.parentElement;
      while(scroller!==dialog && !['auto','scroll'].includes(getComputedStyle(scroller).overflowY)) scroller=scroller.parentElement;
      if(padded.has(scroller)) continue;
      padded.add(scroller);
      const tail=document.createElement('div');tail.style.height='1200px';scroller.append(tail);
    }
    const tail=document.createElement('div');tail.style.height='1200px';document.body.append(tail);
    return window.foldCatalogue.length;
  })()`);
  const coverage=[];
  for(const width of widths) for(const theme of ['dark','light']) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<800});
    await send('Emulation.setTouchEmulationEnabled',{enabled:width<800});
    await evaluate(`document.documentElement.dataset.theme='${theme}';true`);
    let checked=0;
    for(let index=0;index<count;index++) {
      const label=await evaluate(`(() => {
        const fold=window.foldCatalogue[${index}];
        for(const node of window.foldCatalogue) node.open=false;
        for(let node=fold.parentElement;node;node=node.parentElement) {
          if(node.tagName==='DETAILS') node.open=true;
          if(node.tagName==='DIALOG' && !node.open) node.showModal();
        }
        window.foldUnderTest=fold;
        return fold.id || fold.className || 'fold-${index}';
      })()`);
      await settle();
      // Exercise conditional folds too, without depending on commissioning or
      // authentication state in this synthetic catalogue.
      await evaluate(`for(let node=foldUnderTest;node && node!==document.body;node=node.parentElement) {
        node.hidden=false;
        if(getComputedStyle(node).display==='none') node.style.setProperty('display','block','important');
      } true`);
      for(const input of (width<800 ? ['native'] : ['native','keyboard'])) for(const open of [true,false]) {
        await evaluate(`refreshFoldUnderTest();foldUnderTest.querySelector(':scope > summary').scrollIntoView({block:'center'});true`);
        await settle();
        const before=await evaluate(`(() => {refreshFoldUnderTest();const s=foldUnderTest.querySelector(':scope > summary');
          if('${input}'==='keyboard') s.focus({preventScroll:true});const r=s.getBoundingClientRect();
          return {x:r.left+4,y:r.top+4,top:r.top,scroll:scrollY};})()`);
        if(input==='keyboard') {
          await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
          await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        } else {
          await evaluate("foldUnderTest.querySelector(':scope > summary').click();true");
        }
        await settle();
        const after=await evaluate(`(() => {refreshFoldUnderTest();return {open:foldUnderTest.open,top:foldUnderTest.querySelector(':scope > summary').getBoundingClientRect().top,scroll:scrollY};})()`);
        const context=`${width}/${theme}/${label}/${input}/${open?'open':'close'}`;
        assert.equal(after.open,open,context);
        // Provider tiles intentionally reflow from two columns to one. Keep
        // either the page position or the activated summary stable; ordinary
        // folds (whose summary does not move in document space) require both.
        const scrollDelta=after.scroll-before.scroll;
        const summaryDelta=after.top-before.top;
        assert(Math.abs(scrollDelta)<=1 || Math.abs(summaryDelta)<=1,
          `${context}: page scrolled ${scrollDelta}px and summary moved ${summaryDelta}px`);
      }
      await evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());true");
      checked++;
    }
    // The comparison panel uses a button rather than native details.
    await evaluate(`(() => {document.querySelectorAll('details').forEach(d=>d.open=false);
      const button=document.getElementById('comparison-toggle');
      if(button.getAttribute('aria-expanded')==='true') button.click();
      const body=document.getElementById('comparison-content');body.hidden=true;
      const fill=document.createElement('p');fill.style.height='300px';body.append(fill);return true;})()`);
    for(const open of [true,false]) {
      await evaluate("document.getElementById('comparison-toggle').scrollIntoView({block:'center'});true");
      await settle();
      const before=await evaluate("document.getElementById('comparison-toggle').getBoundingClientRect().top");
      await evaluate("document.getElementById('comparison-toggle').click();true");
      await settle();
      const after=await evaluate("({top:document.getElementById('comparison-toggle').getBoundingClientRect().top,open:document.getElementById('comparison-toggle').getAttribute('aria-expanded')==='true'})");
      assert.equal(after.open,open,`${width}/${theme}/comparison`);
      assert(Math.abs(after.top-before)<=1,`${width}/${theme}/comparison: summary position`);
    }
    coverage.push({width,theme,checked,catalogue:count,comparison:true});
    console.log(JSON.stringify(coverage.at(-1)));
  }
  assert.deepEqual(errors,[]);
  console.log('Disclosure scroll checks passed', JSON.stringify(coverage));
} finally {
  socket?.close();for(const p of pending.values())clearTimeout(p.timer);await app?.close();
  if(browser&&browser.exitCode===null) {browser.kill();await new Promise(resolve=>browser.once('exit',resolve));}
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
