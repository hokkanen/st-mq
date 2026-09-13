import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** All device actions below terminate in a browser fixture, never at hardware. */
export async function checkEquipmentBrowser({ evaluate, command, context, until }) {
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const refresh = async () => {
    const count = await evaluate('window.equipmentUiFixture.responses');
    await evaluate("document.getElementById('auth').dispatchEvent(new Event('submit',{cancelable:true}));true");
    await until(`window.equipmentUiFixture.responses > ${count}`); await settle();
  };
  await evaluate(`(() => {
    const at = Date.parse('2026-09-07T11:00:00Z');
    const reading = (label,value,unit,observedAt=at) => ({label,value,unit,observedAt,stale:false});
    const fixture = window.equipmentUiFixture = {fetch:window.fetch.bind(window),calls:[],responses:0,lastResult:null,
      originalHash:location.hash,openDetails:[...document.querySelectorAll('.controller-panels details[open]')].map(node=>node.id)};
    fixture.devices = [
      {id:'garage-probes',label:'Garage temperatures',area:'garage',kind:'temperature',source:'MQTT-shelly',available:true,
        controls:{switch:false},readings:{garage_temperature:reading('By the entrance',18.2,'degC'),garage_temperature_2:reading('By the back wall',16.5,'degC')},
        topics:[{role:'Native status',topic:'invented-garage/status/temperature:100',direction:'subscribe'}]},
      {id:'caravan',label:'Caravan',area:'garage',kind:'metered_switch',source:'MQTT-shelly',available:true,
        mqttStatus:{subscriptionStatus:'subscribed',lastLiveAt:at,lastRetainedAt:at-60000},
        controls:{switch:true},readings:{caravan_active:reading('Switch',1,'state'),caravan_power:reading('Power',0.35,'kW')},energy:{dailyKwh:1.234,observedAt:at,partial:true},
        topics:[{role:'Native requests',topic:'invented-caravan/rpc',direction:'publish'}]},
      ...[1,2].map(index=>({id:'door'+index,label:'Door '+index,area:'garage',kind:'door',source:'MQTT',available:true,
        controls:{switch:false},readings:{['garage_door'+index+'_open']:reading('Door state',index===1?0:1,'state',at-7*86400000)},
        check:{status:'listening',checkedAt:at},recheck:{method:'subscription',requestSupported:false,description:'This device publishes changes; no status-request topic is configured.'},
        topics:[{role:'Door state',topic:'invented/garage/long-device-prefix/door'+index+'/contact/state',direction:'subscribe'}]})),
    ];
    fixture.dhwr={active:false,durationMinutes:10,actualOn:false,commandTopic:'invented/dhwr/set',feedback:{configured:true,available:true,
      state:reading('Switch',0,'state'),power:reading('Live power',0,'W')}};
    fixture.response = base => ({...base,equipment:{configured:true,connected:true,devices:fixture.devices,topicGroups:[{id:'temperatures',label:'Temperature feeds',topics:[{role:'Upstairs',topic:'invented/home/upstairs/temperature',direction:'subscribe'}]}]},dhwr:fixture.dhwr,
      heatingTests:{available:true},equipmentControls:{available:true,busy:false,lastResult:fixture.lastResult},equipmentTests:{available:true,busy:false}});
    window.fetch = async (...args) => {
      const path = new URL(args[0],location.href).pathname;
      if(path.endsWith('/api/status')) {const response=await fixture.fetch(...args);fixture.base=await response.json();fixture.responses++;return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});}
      if(path.includes('/api/equipment/')||path.endsWith('/api/heating-test')||path.endsWith('/api/dhwr/stop')) {
        const body=JSON.parse(args[1].body);fixture.calls.push({path,body});
        if(fixture.failNext) {fixture.failNext=false;return new Response(JSON.stringify({error:'Synthetic control failure'}),{status:503});}
        if(path.endsWith('/switch')) {
          fixture.lastResult={...body,at,status:'unconfirmed',sent:true,confirmed:false};
          return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
        }
        if(path.endsWith('/heating-test')) {fixture.dhwr.active=true;return new Response(JSON.stringify({command:body.command,sent:true,at,status:'sent'}),{status:200});}
        if(path.endsWith('/stop')) {fixture.dhwr.active=false;if(fixture.dhwr.feedback.state){fixture.dhwr.actualOn=false;fixture.dhwr.feedback.state.value=0;}}
        return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
      }
      return fixture.fetch(...args);
    };return true;
  })()`);
  try {
    await refresh();
    await evaluate("document.getElementById('equipment-details').open=true;document.getElementById('connections-details').open=true;document.getElementById('mqtt-devices-details').open=true;true");
    assert.equal(await evaluate("document.getElementById('equipment-panel').parentElement.className"), 'controller-panels');
    assert.equal(await evaluate("document.querySelectorAll('#equipment-details input[type=number]').length"), 1, 'Only the H66 setting is numeric; manual controls have no duration inputs');
    assert.equal(await evaluate("document.querySelector('#garage-equipment-readings [data-device-id=door1] .status-detail-label').textContent"), 'Closed');
    assert.equal(await evaluate("document.getElementById('garage-equipment-readings').textContent.includes('By the back wall')"), true);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, 'Monitoring sends no commands');
    const caravan = '#garage-equipment-readings [data-device-id=caravan]';
    assert.equal(await evaluate(`document.querySelector('${caravan} button[aria-pressed=true]').textContent`), 'Turn on');
    await evaluate(`document.querySelector('${caravan} .equipment-switch-buttons button:last-child').click();true`);
    await until('window.equipmentUiFixture.calls.length === 1'); await settle();
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[0])')), {path:'/api/equipment/switch',body:{deviceId:'caravan',on:false}});
    assert.equal(await evaluate(`document.querySelector('${caravan} .status-detail-label').textContent`), 'On', 'Acknowledgement does not invent physical state');
    assert.match(await evaluate(`document.querySelector('${caravan} .equipment-control-result').textContent`), /awaiting device confirmation/);
    await evaluate("window.equipmentUiFixture.devices.find(d=>d.id==='caravan').readings.caravan_active.value=0;window.equipmentUiFixture.lastResult.confirmed=true;window.equipmentUiFixture.lastResult.status='confirmed';true");
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${caravan} .status-detail-label').textContent`), 'Off');
    assert.equal(await evaluate(`document.querySelector('${caravan} button[aria-pressed=true]').textContent`), 'Turn off');
    await evaluate("document.getElementById('equipment-recheck-all').click();true");
    await until('window.equipmentUiFixture.calls.length === 2'); await settle();
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[1].body)')), {});
    await evaluate("document.querySelectorAll('.equipment-topic-details').forEach(d=>d.open=true);true");
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(n=>n.textContent==='invented/garage/long-device-prefix/door1/contact/state')"), true);
    assert.match(await evaluate("document.getElementById('equipment-connections').textContent"), /no status-request topic/);
    assert.match(await evaluate("document.getElementById('equipment-connections').textContent"), /Last live packet:/);
    assert.equal(await evaluate("document.querySelector('[data-topic-group=temperatures] code').textContent"), 'invented/home/upstairs/temperature');
    // Power-only reports are useful independently of run requests or switch confirmation.
    await evaluate("window.equipmentUiFixture.savedDhwr=structuredClone(window.equipmentUiFixture.dhwr);window.equipmentUiFixture.dhwr.actualOn=null;Object.assign(window.equipmentUiFixture.dhwr.feedback,{stateConfigured:false,powerConfigured:true,state:null});window.equipmentUiFixture.dhwr.feedback.power.eventOnly=true;true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '0 W');
    assert.equal(await evaluate("document.querySelector('#dhwr-live-state .status-detail-label').textContent"), 'Not configured');
    assert.equal(await evaluate("document.getElementById('dhwr-live-power-label').textContent"), 'Last reported power');
    assert.match(await evaluate("document.getElementById('dhwr-live-power-time').textContent"), /Reported 7 Sept/);
    assert.equal(await evaluate("document.getElementById('dhwr-feedback-status').textContent"), 'Power reported');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.power.value=38;true"); await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '38 W');
    assert.equal(await evaluate("document.getElementById('dhwr-stop').disabled"), true, 'Power does not enable Stop as if switch ON was reported');
    await evaluate("document.querySelector('#dhwr-live-power .status-detail-trigger').click();true"); await settle();
    assert.match(await evaluate("document.getElementById('status-detail-popover').textContent"), /Updated when power changes/);
    await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();window.equipmentUiFixture.dhwr.feedback.available=false;window.equipmentUiFixture.dhwr.feedback.power.stale=true;true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), 'Unavailable');
    assert.equal(await evaluate("document.getElementById('dhwr-feedback-status').textContent"), 'Power unavailable');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.power=null;true"); await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), 'Unavailable');
    assert.equal(await evaluate("document.getElementById('dhwr-feedback-status').textContent"), 'Waiting for power');
    assert.equal(await evaluate("document.getElementById('dhwr-live-power-time').hidden"), true);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 2, 'Reading updates never operate equipment');
    await evaluate("window.equipmentUiFixture.dhwr=window.equipmentUiFixture.savedDhwr;true"); await refresh();
    // Failed circulation feedback belongs beside that control, including externally started runs.
    await evaluate("window.equipmentUiFixture.dhwr.actualOn=true;window.equipmentUiFixture.dhwr.feedback.state.value=1;window.equipmentUiFixture.dhwr.feedback.power.value=38;true");
    await refresh();
    assert.equal(await evaluate("document.getElementById('dhwr-stop').disabled"), false);
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '38 W');
    await evaluate("window.equipmentUiFixture.failNext=true;document.getElementById('dhwr-stop').click();true");
    await until("document.getElementById('dhwr-message').classList.contains('form-error')");
    assert.equal(await evaluate("document.getElementById('dhwr-message').closest('#dhwr-device') !== null"), true);
    await evaluate("document.getElementById('dhwr-stop').click();true");
    await until('window.equipmentUiFixture.calls.length === 4'); await settle();
    assert.equal(await evaluate("document.getElementById('dhwr-message').classList.contains('form-error')"), false);
    await evaluate("document.getElementById('test-heaton60').click();true");
    await until("window.equipmentUiFixture.calls.length === 5 && document.getElementById('test-heaton60').disabled");
    await evaluate("window.equipmentUiFixture.dhwr.actualOn=true;window.equipmentUiFixture.dhwr.feedback.state.value=1;true"); await refresh();
    // Removing/reordering/adding devices retains unrelated row identity and open diagnostics.
    await evaluate(`window.equipmentUiFixture.savedRow=document.querySelector('${caravan}');window.equipmentUiFixture.savedDevices=[...window.equipmentUiFixture.devices];window.equipmentUiFixture.devices=window.equipmentUiFixture.devices.filter(d=>d.id!=='door1').reverse();true`);
    await refresh();
    assert.equal(await evaluate("document.querySelector('#garage-equipment-readings [data-device-id=door1]') === null"), true);
    assert.equal(await evaluate(`document.querySelector('${caravan}')===window.equipmentUiFixture.savedRow`), true);
    await evaluate("window.equipmentUiFixture.devices=window.equipmentUiFixture.savedDevices;true"); await refresh();
    await evaluate("window.equipmentUiFixture.dhwr.feedback.deviceId='dhwr';window.equipmentUiFixture.devices.push({id:'dhwr',label:'Circulation pump',area:'garage',kind:'switch',available:true});true"); await refresh();
    assert.equal(await evaluate("document.getElementById('dhwr-device').closest('#garage-equipment-details')!==null"), true, 'Circulation follows its configured location');
    assert.equal(await evaluate("document.querySelectorAll('#garage-equipment-readings [data-device-id=dhwr]').length"), 0, 'Circulation feedback has one row');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.deviceId=null;window.equipmentUiFixture.devices.pop();true"); await refresh();
    await evaluate("window.equipmentUiFixture.dhwr.actualOn=null;window.equipmentUiFixture.dhwr.active=false;Object.assign(window.equipmentUiFixture.dhwr.feedback,{deviceId:'dhwr',stateConfigured:false,powerConfigured:true,state:null});window.equipmentUiFixture.dhwr.feedback.power.eventOnly=true;window.equipmentUiFixture.devices.push({id:'dhwr',label:'Hot-water circulation',area:'home',kind:'power',available:true,topics:[{role:'Power',topic:'to_stmq/dhwr/power',direction:'subscribe'}]});true"); await refresh();
    assert.equal(await evaluate("document.querySelectorAll('#home-equipment-readings [data-device-id=dhwr]').length"), 0);
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(n=>n.textContent==='to_stmq/dhwr/power')"), true);
    await evaluate("document.getElementById('test-heaton60').click();true");
    await until("window.equipmentUiFixture.calls.length === 6 && document.getElementById('test-heaton60').disabled"); await settle();
    assert.match(await evaluate("document.getElementById('dhwr-message').textContent"), /Switch feedback is not configured/);
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '38 W');
    await evaluate("document.getElementById('dhwr-stop').click();true");
    await until("window.equipmentUiFixture.calls.length === 7 && document.getElementById('dhwr-stop').disabled"); await settle();
    assert.equal(await evaluate("document.getElementById('dhwr-message').textContent"), 'Stop sent. Switch feedback is not configured.');
    // Popup triggers keep the reading's line-height and baseline without an icon or button margin.
    const trigger = '#garage-equipment-readings [data-device-id=door1] .status-detail-trigger';
    for (const [width,height] of [[1440,1100],[900,900],[320,640],[390,844],[844,390]]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1}); await settle();
      await evaluate("document.getElementById('equipment-details').scrollIntoView({block:'start'});true");
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `No page overflow at ${width}px`);
      assert.equal(await evaluate(`(() => {const nodes=[...document.querySelectorAll('#garage-equipment-readings > section')];return nodes.every((n,i)=>i===0||n.getBoundingClientRect().top>=nodes[i-1].getBoundingClientRect().bottom-1)})()`), true, 'Device rows never overlap');
      assert.equal(await evaluate(`(() => {const n=document.querySelector('${trigger}'),s=getComputedStyle(n);return s.marginTop==='0px'&&s.minHeight==='0px'&&getComputedStyle(n,'::after').content==='none'})()`), true, 'No inherited button spacing or circled i');
      const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/equipment-controls-${width}.png`,Buffer.from(shot.data,'base64'));
      await evaluate(`document.querySelector('${trigger}').scrollIntoView({block:'center'});true`); await settle();
      await evaluate(`document.querySelector('${trigger}').click();true`); await settle();
      assert.equal(await evaluate("(() => {const p=document.getElementById('status-detail-popover'),b=p.getBoundingClientRect();return p.checkVisibility()&&b.left>=7&&b.right<=innerWidth-7&&b.top>=7&&b.bottom<=innerHeight-7})()"), true);
      await refresh();
      assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), true, 'Polling preserves open details');
      await command('input.performActions',{context,actions:[{type:'key',id:'escape',actions:[{type:'keyDown',value:'\uE00C'},{type:'keyUp',value:'\uE00C'}]}]});
      assert.equal(await evaluate(`document.activeElement===document.querySelector('${trigger}')`), true);
      await evaluate("document.getElementById('providers-controls').scrollIntoView({block:'start'});true");
      assert.equal(await evaluate("(() => {const rows=[...document.querySelectorAll('#connections-details > details')];return rows.every((r,i)=>i===0||r.getBoundingClientRect().top>=rows[i-1].getBoundingClientRect().bottom-1)})()"), true, 'Connections and rates never overlap');
      const settings=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/data-settings-${width}.png`,Buffer.from(settings.data,'base64'));
    }
    await evaluate("window.equipmentUiFixture.devices=[];true"); await refresh();
    assert.match(await evaluate("document.getElementById('garage-equipment-readings').textContent"), /No garage devices enabled/);
    assert.equal(await evaluate("document.querySelectorAll('#equipment-connections > section').length"), 0);
    assert.doesNotMatch(await evaluate("document.getElementById('equipment-check-message').textContent"), /No MQTT devices configured/, 'Other configured MQTT feeds prevent a false empty state');
  } finally {
    await evaluate("document.querySelector('#status-detail-popover .status-detail-close')?.click();window.fetch=window.equipmentUiFixture.fetch;history.replaceState(null,'',location.pathname+location.search+window.equipmentUiFixture.originalHash);for(const d of document.querySelectorAll('.controller-panels details'))d.open=window.equipmentUiFixture.openDetails.includes(d.id);delete window.equipmentUiFixture;document.getElementById('auth').dispatchEvent(new Event('submit',{cancelable:true}));true");
    await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  }
}
