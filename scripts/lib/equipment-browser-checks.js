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
    const fixture = window.equipmentUiFixture = {fetch:window.fetch.bind(window),calls:[],responses:0,now:at,lastResult:null,heatingResult:null,status:{},
      originalHash:location.hash,openDetails:[...document.querySelectorAll('.controller-panels details[open]')].map(node=>node.id)};
    const temperature=(source,value)=>({source,value,observedAt:at,stale:false});
    fixture.observations={indoor:temperature('indoor-average',20.8),upstairs:temperature('mqtt-temperature',21.2),
      downstairs:temperature('mqtt-temperature',20.4),bedroom:temperature('shelly-mqtt',20.8),
      garage:temperature('shelly-mqtt',18.2),garageFront:temperature('shelly-mqtt',16.5),outdoor:temperature('fmi',12)};
    fixture.devices = [
      {id:'garage-probes',label:'Garage temperatures',area:'garage',kind:'temperature',source:'MQTT-shelly',available:true,
        controls:{switch:false},readings:{garage_temperature:reading('By the entrance',18.2,'degC'),garage_temperature_2:reading('By the back wall',16.5,'degC')},
        topics:[{role:'Native status',topic:'invented-garage/status/temperature:100',direction:'subscribe'}]},
      {id:'caravan',label:'Caravan',area:'garage',kind:'metered_switch',source:'MQTT-shelly',available:true,
        mqttStatus:{subscriptionStatus:'subscribed',lastLiveAt:at,lastRetainedAt:at-60000},
        controls:{switch:true},readings:{caravan_active:reading('Switch',1,'state'),caravan_power:reading('Power',0.35,'kW')},energy:{dailyKwh:1.234,observedAt:at,partial:true},
        topics:[{role:'Native requests',topic:'invented-caravan/rpc',direction:'publish'}]},
      ...[1,2].map(index=>({id:'door'+index,label:'Door '+index,area:'garage',kind:'door',source:'MQTT',available:true,
        controls:{switch:false,cover:{open:true,close:true,stop:false}},cover:{available:true,state:index===1?'closed':'open',operation:null},
        readings:{['garage_door'+index+'_open']:reading('Door state',index===1?0:1,'state',at-7*86400000)},
        check:{status:'listening',checkedAt:at},recheck:{method:'subscription',requestSupported:false,description:'This device publishes changes; no status-request topic is configured.'},
        topics:[{role:'Door state',topic:'invented/garage/long-device-prefix/door'+index+'/contact/state',direction:'subscribe'}]})),
    ];
    fixture.chargerReadings=Object.fromEntries([
      ...[1,2,3].flatMap(phase=>[[\`ev2_current_l\${phase}\`,10,'A'],[\`ev2_voltage_l\${phase}\`,230,'V'],[\`ev2_active_power_l\${phase}\`,2.3,'kW']]),
      ['ev2_active_power',6.9,'kW'],['ev2_import_energy_counter',123.4,'kWh'],['ev2_session_energy',4.2,'kWh'],
    ].map(([signal,value,unit])=>[signal,{value,unit,sourceTime:at,receivedAt:at,available:true,quality:[]}]));
    fixture.dhwr={active:false,durationMinutes:10,actualOn:false,confirmed:false,requestedAt:null,commandTopic:'invented/dhwr/set',feedback:{configured:true,available:true,
      state:reading('Switch',0,'state'),power:reading('Live power',0,'W')}};
    fixture.response = base => { if(fixture.dhwr.feedback.basis==='power') { const feedback=fixture.dhwr.feedback,power=feedback.power; feedback.state=power?{...power,value:power.value>0?1:0,unit:'state'}:null; fixture.dhwr.actualOn=feedback.available&&power&&!power.stale?power.value>0:null; } return ({...base,...fixture.status,now:fixture.now,observations:{...base.observations,...fixture.observations,...fixture.status.observations},providers:{...base.providers,temperatures:{source:'mqtt-temperature',status:'ok',lastSuccessAt:at},outdoor:{source:'fmi',status:'ok',lastSuccessAt:at},easee:{status:'ok',currentReadings:{property:{qualityIssues:[],lastSuccessAt:at},charger:{qualityIssues:[],lastSuccessAt:at}},deviceTransports:{charger:'ocpp',property:'stream'},localOcpp:{configured:true,connected:true,available:true,setup:{state:'ready',endpointSource:'configured'}}},'shelly-evse':{enabled:true,status:'ok',connected:true,recording:true,maxAgeMs:300000,readings:fixture.chargerReadings,...fixture.chargerStatus,mqttStatus:{brokerConnected:true,subscriptionStatus:'subscribed',lastLiveAt:at},topics:[{role:'Charger status',topic:'invented/evse/events/rpc',direction:'subscribe'},{role:'RPC requests',topic:'invented/evse/rpc',direction:'publish'}]}},equipment:{configured:true,connected:true,devices:fixture.devices,topicGroups:[
      {id:'temperatures',label:'Temperature feeds',topics:[{role:'Upstairs',topic:'invented/home/upstairs/temperature',direction:'subscribe'}]},
      {id:'vehicle:bmw',vehicleFeedId:'bmw',label:'BMW',topics:[{role:'Timestamped vehicle readings',topic:'invented/vehicles/bmw',direction:'subscribe'}]},
      {id:'vehicle:tesla',vehicleFeedId:'tesla',label:'TeslaMate',topics:[{role:'Vehicle subscription',topic:'invented/teslamate/cars/1/#',direction:'subscribe'}]}
    ]},charging:{...base.charging,vehicleFeeds:[{id:'bmw',label:'BMW',provider:'bmw-cardata',topic:'invented/vehicles/bmw',enabled:true,reception:{brokerConnected:true,subscriptionStatus:'subscribed',lastLiveAt:at,lastMessageAt:at}},{id:'tesla',label:'Tesla',provider:'teslamate',topic:'invented/teslamate/cars/1/#',enabled:true,reception:{brokerConnected:true,subscriptionStatus:'subscribed',lastLiveAt:at,lastMessageAt:at}}]},dhwr:fixture.dhwr,
      heatingTests:{available:true,lastResult:fixture.heatingResult},equipmentControls:{available:true,busy:false,lastResult:fixture.lastResult},equipmentTests:{available:true,busy:false}}); };
    window.fetch = async (...args) => {
      const path = new URL(args[0],location.href).pathname;
      if(path.endsWith('/api/status')) {const response=await fixture.fetch(...args);fixture.base=await response.json();fixture.responses++;return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});}
      if(path.includes('/api/equipment/')||path.endsWith('/api/heating-test')||path.endsWith('/api/dhwr/stop')) {
        const body=JSON.parse(args[1].body);fixture.calls.push({path,body});
        if(fixture.failNext) {fixture.failNext=false;return new Response(JSON.stringify({error:'Synthetic control failure'}),{status:503});}
        if(path.endsWith('/switch')) {
          fixture.lastResult={...body,at:fixture.now,status:'unconfirmed',sent:true,confirmed:false};
          return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
        }
        if(path.endsWith('/cover')) {
          if(fixture.holdCover) await new Promise(resolve=>{fixture.releaseCover=resolve;});
          fixture.devices.find(device=>device.id===body.deviceId).cover.operation={action:body.action,status:'published',requestedAt:fixture.now,acknowledgedAt:fixture.now};
          return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
        }
        if(path.endsWith('/dehumidifier')) {
          fixture.devices.find(device=>device.id===body.deviceId).dehumidifier.operation={...body,status:'published',requestedAt:fixture.now};
          return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
        }
        if(path.endsWith('/heating-test')) {fixture.dhwr.active=true;fixture.dhwr.confirmed=false;fixture.dhwr.requestedAt=fixture.now;fixture.dhwr.expiresAt=fixture.now+600000;fixture.heatingResult={command:body.command,sent:true,at:fixture.now,status:'sent'};return new Response(JSON.stringify(fixture.heatingResult),{status:200});}
        if(path.endsWith('/stop')) {fixture.dhwr.active=false;fixture.dhwr.confirmed=false;fixture.dhwr.requestedAt=fixture.now;if(fixture.dhwr.feedback.power) fixture.dhwr.feedback.power.value=0;if(fixture.dhwr.feedback.state){fixture.dhwr.actualOn=false;fixture.dhwr.feedback.state.value=0;}}
        return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
      }
      return fixture.fetch(...args);
    };return true;
  })()`);
  try {
    await refresh();
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#providers > li')].map(row=>row.dataset.provider)"), ['electricity','market','vehicle-telemetry','main-temperatures']);
    assert.equal(await evaluate("document.querySelectorAll('.provider-local-summary').length"), 0);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-provider=\"main-temperatures\"] .provider-source-title')].map(node=>node.textContent)"), ['Main temperatures','Weather forecast']);
    assert.equal(await evaluate("document.querySelector('[data-provider=\"main-temperatures\"] .provider-category-meta').textContent"), 'MQTT, Shelly, FMI');
    assert.equal(await evaluate("[...document.querySelectorAll('#providers .provider-body')].every(body=>body.firstElementChild.classList.contains('provider-introduction')&&body.firstElementChild.textContent.length>30)"), true);
    const charger2 = '[data-source-section=shelly-evse] .provider-series > li';
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${charger2} > strong')].map(node=>node.textContent)`), [
      'Charger 2 phase currents L1–L3', 'Charger 2 phase voltages L1–L3', 'Charger 2 phase active power L1–L3',
      'Charger 2 active power', 'Charger 2 meter counter', 'Charger 2 total energy', 'Charger 2 session energy', 'Charger 2 session check',
    ], 'Shelly native phase readings are listed alongside supported total and session measurements');
    assert.equal(await evaluate(`[...document.querySelectorAll('${charger2}')].slice(0,5).every(node=>node.dataset.state==='available')`), true);
    assert.equal(await evaluate("[...document.querySelectorAll('[data-provider=electricity] .provider-series > li > strong')].some(node=>node.textContent==='Charger 2 phase energy L1–L3')"), false, 'Total meter energy is not invented phase energy');
    await evaluate('window.equipmentUiFixture.completeChargerReadings=structuredClone(window.equipmentUiFixture.chargerReadings);delete window.equipmentUiFixture.chargerReadings.ev2_voltage_l2;true');
    await refresh();
    assert.match(await evaluate(`document.querySelectorAll('${charger2}')[1].getAttribute('aria-label')`), /Partly available/, 'A missing phase cannot appear as complete three-phase voltage');
    await evaluate("for(const phase of [1,2,3])window.equipmentUiFixture.chargerReadings['ev2_current_l'+phase].sourceTime-=300001;true");
    await refresh();
    assert.match(await evaluate(`document.querySelector('${charger2}').getAttribute('aria-label')`), /Needs attention/, 'Old phase measurements remain unavailable');
    assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Needs attention', 'Stale native readings reach the closed electricity overview');
    assert.equal(await evaluate("[...document.querySelectorAll('[data-provider=electricity] .provider-name')].find(node=>node.textContent==='Shelly EVSE').dataset.state"), 'attention', 'Stale native readings affect the Shelly source status');
    await evaluate("window.equipmentUiFixture.chargerStatus={enabled:false,status:'disabled'};true");
    await refresh();
    assert.equal(await evaluate(`[...document.querySelectorAll('${charger2}')].every(node=>node.getAttribute('aria-label').includes('Not enabled'))`), true);
    await evaluate('window.equipmentUiFixture.chargerReadings=window.equipmentUiFixture.completeChargerReadings;window.equipmentUiFixture.chargerStatus={};true');
    await refresh();
    await evaluate("window.equipmentUiFixture.chargerStatus={status:'degraded',reason:'commissioning-required'};true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('[data-provider=electricity] .provider-category-state').textContent"), 'Needs attention', 'Commissioning remains visible in the source overview');
    assert.equal(await evaluate(`[...document.querySelectorAll('${charger2}')].filter(node=>!['ev2_energy','shelly_session_energy_check'].includes(node.dataset.series)).every(node=>node.dataset.state==='available')`), true, 'Fresh native measurements do not become unavailable when charging control needs commissioning');
    await evaluate('window.equipmentUiFixture.chargerStatus={};true');
    await refresh();
    const vehicles = '[data-provider=vehicle-telemetry] .provider-body';
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('${vehicles} .provider-series > li > strong')].map(node=>node.textContent)`), ['BMW','Tesla']);
    assert.equal(await evaluate(`document.querySelectorAll('${vehicles} details').length`), 0, 'Vehicle feeds are ordinary rows within the category');
    assert.doesNotMatch(await evaluate(`document.querySelector('${vehicles}').textContent`), /invented\/vehicles|invented\/teslamate/, 'MQTT addresses stay in MQTT connections');
    const local = '[data-source-section=easee-ocpp] .provider-local-connection';
    assert.equal(await evaluate(`document.querySelector('${local}').previousElementSibling.className`), 'muted provider-source-description');
    assert.equal(await evaluate(`document.querySelector('${local}').nextElementSibling.className`), 'provider-source-readings', 'Connection setup follows the OCPP introduction and precedes readings');
    assert.equal(await evaluate(`document.querySelector('${local} > summary').textContent`), 'Local connection & charging control');
    assert.doesNotMatch(await evaluate(`document.querySelector('${local}').textContent`), /ST-MQ|property readings/i);
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:bmw:other\"] .equipment-connection-meta').textContent"), 'Vehicle · BMW CarData');
    await evaluate("document.querySelectorAll('#providers .provider-fold, #equipment-connections [data-connection-area=vehicles] .equipment-connection-fold, #equipment-connections [data-connection-area=vehicles] .equipment-packet-details').forEach(node=>node.open=true);window.equipmentUiFixture.bmwCard=document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:bmw:other\"]');true");
    assert.equal(await evaluate(`document.querySelector('${local}').open`), false, 'Setup details begin collapsed below the OCPP introduction');
    await evaluate(`document.querySelector('${local} > summary').focus();true`);
    await command('input.performActions',{context,actions:[{type:'key',id:'local-connection',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
    await settle();
    assert.equal(await evaluate(`document.querySelector('${local}').open`), true, 'Keyboard opens local charging control details');
    assert.equal(await evaluate(`[...document.querySelectorAll('${vehicles} .provider-series > li')].every(node=>node.checkVisibility())`), true);
    assert.equal(await evaluate(`document.querySelector('${vehicles} .provider-health').checkVisibility()`), false, 'Feed descriptions do not need a Source details disclosure');
    assert.equal(await evaluate(`[...document.querySelectorAll('${vehicles} .provider-series-description')].filter(node=>node.checkVisibility()).length`), 2);
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${local}').open`), true, 'Refresh preserves expanded charging control details');
    assert.equal(await evaluate("[...document.querySelectorAll('#providers .provider-fold, #equipment-connections [data-connection-area=vehicles] .equipment-connection-fold, #equipment-connections [data-connection-area=vehicles] .equipment-packet-details')].every(node=>node.open)"), true, 'Refresh preserves expanded categories and vehicle MQTT diagnostics');
    assert.equal(await evaluate("window.equipmentUiFixture.bmwCard===document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:bmw:other\"]')"), true);
    await evaluate('document.activeElement.blur();true');
    for (const width of [1440,390,320]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height:1100},devicePixelRatio:1}); await settle();
      const height=await evaluate("Math.ceil(document.getElementById('providers-controls').getBoundingClientRect().height)+60");
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1}); await settle();
      await evaluate("document.getElementById('providers-controls').scrollIntoView({block:'start'});true"); await settle();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Expanded Data and settings fits at ${width}px`);
      const screenshot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/data-settings-expanded-${width}.png`,Buffer.from(screenshot.data,'base64'));
      if (width !== 320) {
        await command('browsingContext.setViewport',{context,viewport:{width,height:1000},devicePixelRatio:1}); await settle();
        await evaluate(`document.querySelector('${local}').open=false;document.querySelector('[data-source-section=easee-ocpp]').scrollIntoView({block:'start'});true`); await settle();
        const chargerShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/charger-source-settings-${width}.png`,Buffer.from(chargerShot.data,'base64'));
        await evaluate(`document.querySelector('${local}').open=true;document.querySelector('[data-provider=vehicle-telemetry]').scrollIntoView({block:'start'});true`); await settle();
        const feedsShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/vehicle-feeds-${width}.png`,Buffer.from(feedsShot.data,'base64'));
        await evaluate("document.getElementById('connections-details').open=true;document.getElementById('mqtt-devices-details').open=true;document.querySelector('#equipment-connections [data-connection-area=vehicles]').scrollIntoView({block:'start'});true"); await settle();
        const mqttShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/vehicle-mqtt-${width}.png`,Buffer.from(mqttShot.data,'base64'));
        await evaluate("document.getElementById('connections-details').open=false;document.getElementById('mqtt-devices-details').open=false;true");
      }
    }
    await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
    await evaluate("document.querySelectorAll('#providers .provider-fold').forEach(node=>node.open=false);document.getElementById('home-equipment-details').open=true;document.getElementById('garage-equipment-details').open=true;document.getElementById('connections-details').open=true;document.getElementById('mqtt-devices-details').open=true;true");
    assert.equal(await evaluate("document.getElementById('home-equipment-section').closest('#home-equipment-details') !== null"), true);
    assert.equal(await evaluate("document.querySelectorAll('#home-equipment-section input[type=number]').length"), 1, 'Only the H66 setting is numeric; manual controls have no duration inputs');
    assert.equal(await evaluate("document.querySelector('#garage-equipment-readings [data-device-id=door1] .status-detail-label').textContent"), 'Closed');
    assert.equal(await evaluate("document.getElementById('garage-equipment-readings').textContent.includes('By the back wall')"), true);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, 'Monitoring sends no commands');
    const caravan = '#garage-equipment-readings [data-device-id=caravan]';
    assert.equal(await evaluate(`document.querySelector('${caravan}').tagName`), 'DETAILS');
    assert.equal(await evaluate(`document.querySelector('${caravan}').open`), false, 'Equipment starts as a compact summary');
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-device-body').checkVisibility()`), false);
    assert.equal(await evaluate("document.querySelectorAll('.zone-equipment-fold .equipment-device > summary button, .zone-equipment-fold .equipment-device > summary input, .zone-equipment-fold .equipment-device > summary a').length"), 0, 'An equipment device summary has one native disclosure action');
    assert.match(await evaluate(`document.querySelector('${caravan} > summary').textContent`), /Caravan.*Energy.*Switch: On.*Available/);
    await evaluate(`document.querySelector('${caravan} > summary h4').click();document.querySelector('${caravan} > summary').focus();true`);
    await settle();
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-device-body').checkVisibility()`), true, 'Clicking the equipment heading expands the full row');
    await command('input.performActions',{context,actions:[{type:'key',id:'equipment-fold',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
    await settle();
    assert.equal(await evaluate(`document.querySelector('${caravan}').open`), false, 'Enter toggles the native equipment disclosure');
    await evaluate("document.querySelectorAll('.equipment-device').forEach(node=>node.open=true);true");
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
    assert.match(await evaluate(`document.querySelector('${caravan} .equipment-control-result').textContent`), /device confirmed/);
    await evaluate('window.equipmentUiFixture.now+=60000;true'); await refresh();
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-control-result').hidden`), true, 'Old switch receipts disappear while the actual setting remains visible');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now++;f.lastResult={deviceId:'caravan',on:false,at:f.now,confirmedAt:f.now,status:'confirmed',sent:true,confirmed:true};return true;})()`);
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-control-result').hidden`), false, 'A new request can show its own receipt');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now++;Object.assign(f.devices.find(d=>d.id==='caravan').readings.caravan_active,{value:1,observedAt:f.now});return true;})()`);
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-control-result').hidden`), true, 'New device state supersedes the old switch confirmation');
    await evaluate(`(() => {const f=window.equipmentUiFixture;f.now++;Object.assign(f.devices.find(d=>d.id==='caravan').readings.caravan_active,{value:0,observedAt:f.now});return true;})()`);
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${caravan} .equipment-control-result').hidden`), true, 'A superseded receipt cannot reappear when the device later returns to that value');
    assert.equal(await evaluate("document.getElementById('equipment-recheck-all') === null && [...document.querySelectorAll('#mqtt-devices-details button')].every(button=>!/^Recheck/i.test(button.textContent))"), true, 'Connections show live status without Recheck controls');
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=caravan] .equipment-connection-name').textContent"), 'Caravan');
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=caravan] .equipment-device-status').textContent"), 'Available');
    assert.match(await evaluate("document.querySelector('#equipment-connections [data-device-id=caravan] .equipment-connection-recent').textContent"), /^Reported /);
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:tesla:other\"] .equipment-connection-name').textContent"), 'Tesla');
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:tesla:other\"]').closest('[data-connection-area]').dataset.connectionArea"), 'vehicles');
    assert.equal(await evaluate("document.querySelector('#vehicle-telemetry-connections')"), null, 'MQTT diagnostics have a single home in MQTT connections');
    assert.match(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:vehicle:tesla:other\"] .equipment-connection-meta').textContent"), /TeslaMate/);
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:shelly-evse:garage\"]').closest('[data-connection-area]').dataset.connectionArea"), 'garage');
    assert.match(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:shelly-evse:garage\"]').textContent"), /Charger 2.*Charger · Shelly EVSE.*local Shelly MQTT.*invented\/evse\/events\/rpc.*RPC requests/);
    await evaluate("document.querySelectorAll('#equipment-connections .equipment-connection-fold, #equipment-connections .equipment-packet-details').forEach(d=>d.open=true);true");
    await refresh();
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections .equipment-connection-fold, #equipment-connections .equipment-packet-details')].every(node=>node.open)"), true, 'Refresh preserves expanded MQTT cards and packet diagnostics');
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(n=>n.textContent==='invented/garage/long-device-prefix/door1/contact/state')"), true);
    assert.match(await evaluate("document.getElementById('equipment-connections').textContent"), /no status-request topic/);
    assert.match(await evaluate("document.getElementById('equipment-connections').textContent"), /Last live packet:/);
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:temperatures:home\"] code').textContent"), 'invented/home/upstairs/temperature');
    // Power reports determine circulation operation independently of run requests.
    await evaluate("window.equipmentUiFixture.savedDhwr=structuredClone(window.equipmentUiFixture.dhwr);window.equipmentUiFixture.dhwr.actualOn=null;Object.assign(window.equipmentUiFixture.dhwr.feedback,{stateConfigured:true,powerConfigured:true,basis:'power',state:null});window.equipmentUiFixture.dhwr.feedback.power.eventOnly=true;true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '0 W');
    assert.equal(await evaluate("document.querySelector('#dhwr-live-state .status-detail-label').textContent"), 'Off');
    assert.equal(await evaluate("document.getElementById('dhwr-live-power-label').textContent"), 'Last reported power');
    assert.match(await evaluate("document.getElementById('dhwr-live-power-time').textContent"), /Reported 7 Sept/);
    assert.equal(await evaluate("document.getElementById('dhwr-feedback-status').textContent"), 'Power reported');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.power.value=38;true"); await refresh();
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '38 W');
    assert.equal(await evaluate("document.getElementById('dhwr-stop').disabled"), false, 'Positive measured power enables stopping circulation');
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
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 1, 'Reading updates never operate equipment');
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
    await until('window.equipmentUiFixture.calls.length === 3'); await settle();
    assert.equal(await evaluate("document.getElementById('dhwr-message').classList.contains('form-error')"), false);
    await evaluate("document.getElementById('test-circulation').click();true");
    await until("window.equipmentUiFixture.calls.length === 4 && !document.getElementById('test-circulation').disabled");
    await evaluate("window.equipmentUiFixture.dhwr.actualOn=true;window.equipmentUiFixture.dhwr.feedback.state.value=1;window.equipmentUiFixture.dhwr.feedback.power.value=38;true"); await refresh();
    // Removing/reordering/adding devices retains unrelated row identity and open diagnostics.
    await evaluate(`window.equipmentUiFixture.savedRow=document.querySelector('${caravan}');document.querySelector('${caravan} > summary').focus();window.equipmentUiFixture.savedDevices=[...window.equipmentUiFixture.devices];window.equipmentUiFixture.devices=window.equipmentUiFixture.devices.filter(d=>d.id!=='door1').reverse();true`);
    await refresh();
    assert.equal(await evaluate("document.querySelector('#garage-equipment-readings [data-device-id=door1]') === null"), true);
    assert.equal(await evaluate(`document.querySelector('${caravan}')===window.equipmentUiFixture.savedRow`), true);
    assert.equal(await evaluate(`document.querySelector('${caravan}').open`), true, 'Polling and device reordering preserve an expanded device');
    await evaluate("window.equipmentUiFixture.devices=window.equipmentUiFixture.savedDevices;true"); await refresh();
    assert.equal(await evaluate(`document.activeElement===document.querySelector('${caravan} > summary')`), true, 'Reordering preserves keyboard focus on the same equipment');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.deviceId='dhwr';window.equipmentUiFixture.devices.push({id:'dhwr',label:'Circulation pump',area:'garage',kind:'switch',available:true});true"); await refresh();
    assert.equal(await evaluate("document.getElementById('dhwr-device').closest('#garage-equipment-details')!==null"), true, 'Circulation follows its configured location');
    assert.equal(await evaluate("document.querySelectorAll('#garage-equipment-readings [data-device-id=dhwr]').length"), 0, 'Circulation feedback has one row');
    await evaluate("window.equipmentUiFixture.dhwr.feedback.deviceId=null;window.equipmentUiFixture.devices.pop();true"); await refresh();
    await evaluate("window.equipmentUiFixture.dhwr.actualOn=null;window.equipmentUiFixture.dhwr.active=false;Object.assign(window.equipmentUiFixture.dhwr.feedback,{deviceId:'dhwr',stateConfigured:true,powerConfigured:true,basis:'power',state:null});window.equipmentUiFixture.dhwr.feedback.power.eventOnly=true;window.equipmentUiFixture.devices.push({id:'dhwr',label:'Hot-water circulation',area:'home',kind:'power',available:true,topics:[{role:'Power',topic:'stmq/home/dhwr/status/power',direction:'subscribe'}]});true"); await refresh();
    assert.equal(await evaluate("document.querySelectorAll('#home-equipment-readings [data-device-id=dhwr]').length"), 0);
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(n=>n.textContent==='stmq/home/dhwr/status/power')"), true);
    await evaluate("document.getElementById('test-circulation').click();true");
    await until("window.equipmentUiFixture.calls.length === 5 && !document.getElementById('test-circulation').disabled"); await settle();
    assert.match(await evaluate("document.getElementById('dhwr-message').textContent"), /Waiting for a new device report/);
    assert.equal(await evaluate("document.querySelector('#dhwr-live-power .status-detail-label').textContent"), '38 W');
    await evaluate("document.getElementById('dhwr-stop').click();true");
    await until("window.equipmentUiFixture.calls.length === 6 && document.getElementById('dhwr-stop').disabled"); await settle();
    assert.equal(await evaluate("document.getElementById('dhwr-message').textContent"), 'Stop sent. Waiting for a new device report to verify the request.');
    await evaluate('window.equipmentUiFixture.dhwr.confirmed=true;true'); await refresh();
    assert.equal(await evaluate("document.getElementById('dhwr-message').textContent"), '', 'Fresh OFF confirmation clears the circulation stop acknowledgement');
    // Persisted manual receipts follow current ownership, including an early Resume.
    await evaluate(`(() => {const f=window.equipmentUiFixture;
      f.beginManual=()=>{const at=++f.now,until=at+60000,pauseId='invented-ui-pause-'+at;
        f.heatingResult={command:'preheat',status:'mqtt',sent:true,at,expiresAt:until,holdUntil:until};
        f.status={override:{id:pauseId,createdAt:at,expiresAt:until},execution:{status:'mqtt'},
          decision:{...f.base.decision,manualHold:{phase:'preheat',until,parameters:true,changed:true}},
          observations:{...f.base.observations,actual:{requestedPhase:'preheat',phase:'preheat',mode:'normal',verified:false,stale:false,observedAt:at}},
          h66:{...f.base.h66,enabled:true,connected:true,brokerConnected:true,phase:'manual-pause',pauseId,expiresAt:until,restorationPending:false,
            requested:{'0203':25},obligations:{'0203':{baseline:20,expected:25}},manualPreheat:{confirmed:true,baseValue:20},
            lastManual:{register:'0203',value:25,previousValue:20,readback:25,at,expiresAt:until,pauseId,status:'confirmed',confirmed:true,sent:true},
            readings:{...f.base.h66?.readings,'0203':{value:25,available:true,stale:false,receivedAt:at,observedAt:at}}}};};
      f.endManual=()=>{f.status.override=null;delete f.status.decision.manualHold;
        Object.assign(f.status.h66,{phase:'normal',pauseId:null,expiresAt:null,requested:{},obligations:{},manualPreheat:null});
        Object.assign(f.status.h66.readings['0203'],{value:20,receivedAt:f.now,observedAt:f.now});
        Object.assign(f.status.observations.actual,{requestedPhase:'normal',phase:'normal',verified:true,observedAt:f.now});};
      f.beginManual();return true;})()`); await refresh();
    assert.match(await evaluate("document.getElementById('heating-test-message').textContent"), /Preheat sent.*held until/);
    assert.match(await evaluate("document.getElementById('h66-test-message').textContent"), /requested 25.*readback 25.*Held until/);
    await evaluate('window.equipmentUiFixture.now=window.equipmentUiFixture.status.override.expiresAt;window.equipmentUiFixture.endManual();true'); await refresh();
    assert.equal(await evaluate("document.getElementById('heating-test-message').textContent"), '', 'Expired preheat receipts disappear after restoration');
    assert.equal(await evaluate("document.getElementById('h66-test-message').textContent"), '', 'Expired native-setting receipts disappear after restoration');
    await refresh();
    assert.equal(await evaluate("document.getElementById('heating-test-message').textContent+document.getElementById('h66-test-message').textContent"), '', 'Polling the same stored results cannot bring ended changes back');
    await evaluate('window.equipmentUiFixture.beginManual();true'); await refresh();
    assert.match(await evaluate("document.getElementById('heating-test-message').textContent"), /held until/);
    await evaluate('window.equipmentUiFixture.now++;window.equipmentUiFixture.endManual();true'); await refresh();
    assert.equal(await evaluate("document.getElementById('heating-test-message').textContent+document.getElementById('h66-test-message').textContent"), '', 'Resume removes both receipts before their original deadline');
    await evaluate('window.equipmentUiFixture.status={};window.equipmentUiFixture.heatingResult=null;true'); await refresh();
    // Cover operations remain separate from the contact state and from other device results.
    const door1 = '#garage-equipment-readings [data-device-id=door1]', door2 = '#garage-equipment-readings [data-device-id=door2]';
    await evaluate(`document.querySelector('${door1}').open=true;document.querySelector('${door2}').open=true;true`);
    const coverCalls = await evaluate('window.equipmentUiFixture.calls.length');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('${door1} [data-cover-action]')].filter(node=>!node.hidden).map(node=>node.textContent))`)), ['Open', 'Close']);
    assert.equal(await evaluate(`document.querySelector('${door2} [data-cover-action=open]').disabled`), false, 'An open contact does not establish fully open position');
    assert.equal(await evaluate(`document.querySelector('${door1} [data-cover-action=open]').getAttribute('aria-label')`), 'Open Door 1');
    await evaluate(`window.equipmentUiFixture.holdCover=true;document.querySelector('${door1} [data-cover-action=open]').click();document.querySelector('${door1} [data-cover-action=open]').click();true`);
    await until(`window.equipmentUiFixture.calls.length === ${coverCalls + 1} && Boolean(window.equipmentUiFixture.releaseCover)`);
    assert.equal(await evaluate(`document.querySelector('${door1} [data-cover-action=close]').disabled`), true, 'Buttons block duplicate requests during delivery');
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.equipmentUiFixture.calls[${coverCalls}])`)), {path:'/api/equipment/cover',body:{deviceId:'door1',action:'open'}});
    await evaluate('window.equipmentUiFixture.holdCover=false;window.equipmentUiFixture.releaseCover();true');
    await until(`!document.querySelector('${door1} [data-cover-action=close]').disabled`); await settle();
    assert.equal(await evaluate(`document.querySelector('${door1} .status-detail-label').textContent`), 'Closed', 'Delivery does not invent movement or endpoint');
    assert.match(await evaluate(`document.querySelector('${door1} .equipment-cover-controls .equipment-control-result').textContent`), /Open requested.*position unconfirmed/);
    assert.equal(await evaluate(`document.querySelector('${door2} .equipment-cover-controls .equipment-control-result').hidden`), true);
    await evaluate(`window.equipmentUiFixture.failNext=true;document.querySelector('${door2} [data-cover-action=close]').click();true`);
    await until(`document.querySelector('${door2} .equipment-cover-controls .equipment-control-result').classList.contains('form-error')`);
    assert.equal(await evaluate(`document.querySelector('${door1} .equipment-cover-controls .equipment-control-result').classList.contains('form-error')`), false);
    await evaluate("window.equipmentUiFixture.devices.find(device=>device.id==='door1').controls.cover.stop=true;true"); await refresh();
    assert.equal(await evaluate(`document.querySelector('${door1} [data-cover-action=stop]').disabled`), false, 'Stop stays available during unconfirmed movement');
    await evaluate(`document.querySelector('${door1} [data-cover-action=stop]').click();true`);
    await until(`window.equipmentUiFixture.calls.length === ${coverCalls + 3}`); await settle();
    assert.match(await evaluate(`document.querySelector('${door1} .equipment-cover-controls .equipment-control-result').textContent`), /Stop requested.*stopping unconfirmed/);
    await evaluate('window.equipmentUiFixture.now+=60000;true'); await refresh();
    assert.equal(await evaluate(`document.querySelector('${door1} .equipment-cover-controls .equipment-control-result').hidden`), true, 'Unconfirmed door receipts expire while current door state stays visible');
    assert.equal(await evaluate(`document.querySelector('${door1} .status-detail-label').textContent`), 'Closed');
    await evaluate("window.equipmentUiFixture.devices.find(device=>device.id==='door2').cover.available=false;true"); await refresh();
    assert.equal(await evaluate(`document.querySelector('${door2} [data-cover-action=open]').disabled`), true);
    await evaluate("window.equipmentUiFixture.devices.find(device=>device.id==='door2').cover.available=true;true"); await refresh();
    // Popup triggers keep the reading's line-height and baseline without an icon or button margin.
    const trigger = '#garage-equipment-readings [data-device-id=door1] .status-detail-trigger';
    for (const [width,height] of [[1440,1100],[900,900],[320,640],[390,844],[844,390]]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1}); await settle();
      await evaluate("document.getElementById('garage-equipment-details').scrollIntoView({block:'start'});true");
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `No page overflow at ${width}px`);
      assert.equal(await evaluate(`(() => {const boxes=[...document.querySelectorAll('#garage-equipment-readings > .equipment-device')].map(node=>node.getBoundingClientRect());return boxes.length>0&&boxes.every((box,index)=>boxes.slice(index+1).every(other=>box.right<=other.left+1||other.right<=box.left+1||box.bottom<=other.top+1||other.bottom<=box.top+1))})()`), true, 'Equipment rows never overlap');
      assert.equal(await evaluate(`(() => {const n=document.querySelector('${trigger}'),s=getComputedStyle(n);return s.marginTop==='0px'&&s.minHeight==='0px'&&getComputedStyle(n,'::after').content==='none'})()`), true, 'No inherited button spacing or circled i');
      const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/equipment-controls-${width}.png`,Buffer.from(shot.data,'base64'));
      await evaluate(`document.querySelector('${trigger}').scrollIntoView({block:'center'});true`); await settle();
      assert.equal(await evaluate(`(() => {const card=document.querySelector('${door1}').getBoundingClientRect();return [...document.querySelectorAll('${door1} [data-cover-action]')].filter(node=>!node.hidden).every(node=>{const box=node.getBoundingClientRect();return box.left>=card.left&&box.right<=card.right&&box.height>=36;});})()`), true, `Door buttons remain usable inside the card at ${width}px`);
      const doorShot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/door-controls-${width}.png`,Buffer.from(doorShot.data,'base64'));
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
    // Air and the upcoming appliance belong inside the existing Caravan fold.
    await evaluate(`(() => { const f=window.equipmentUiFixture, at=f.now;
      const reading=(label,value,unit)=>({label,value,unit,observedAt:at,stale:false});
      f.devices.find(device=>device.id==='caravan').label='Caravan energy';
      f.devices.push({id:'blu_ht',label:'Caravan air',area:'garage',kind:'temperature',source:'MQTT',available:true,
        readings:{caravan_temperature:reading('Temperature',14.1,'degC'),caravan_humidity:reading('Relative humidity',63,'%'),
          blu_ht_battery:reading('Battery',100,'%'),blu_ht_rssi:reading('Bluetooth signal',-81,'dBm')},
        topics:[{role:'Air readings',topic:'invented/caravan/air/state',direction:'subscribe'}]},
        {id:'caravan_dehumidifier',label:'Caravan dehumidifier',area:'garage',kind:'dehumidifier',source:'MQTT',available:false,
          model:'electriQ DESD8LW',controls:{dehumidifier:true},readings:{},
          dehumidifier:{available:false,state:{},runningState:null,operation:null},
          topics:[{role:'State',topic:'invented/caravan/dehumidifier/state',direction:'subscribe'}]});
      const response=f.response; f.response=base=>{const next=response(base);next.equipment.topicGroups.push({id:'garage-adapter',
        topics:[{role:'Heat pump',topic:'invented/garage/pump/state',direction:'subscribe'}]});return next;};return true;})()`);
    await refresh();
    const appliance = `${caravan} .caravan-dehumidifier`, fan = `${appliance} [data-setting=fanSpeed]`;
    assert.equal(await evaluate("document.querySelectorAll('#home-equipment-readings [data-device-id=blu_ht], #garage-equipment-readings > [data-device-id=blu_ht]').length"), 0);
    assert.match(await evaluate(`document.querySelector('${caravan} .caravan-air-metrics').textContent`), /14.1 °C.*63 %/);
    assert.equal(await evaluate(`document.querySelector('${caravan} .caravan-sensor-details').open`), false);
    assert.match(await evaluate(`document.querySelector('${appliance}').textContent`), /electriQ DESD8LW.*Awaiting first MQTT report/);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('${appliance} button, ${appliance} select')).every(node=>node.disabled)`), true);
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll('#equipment-connections [data-connection-area=garage] .equipment-connection-fold')).map(node=>node.dataset.deviceId)"),
      ['connection:garage-adapter:garage','garage-probes','blu_ht','caravan_dehumidifier','caravan','door1','door2','connection:shelly-evse:garage']);
    assert.equal(await evaluate(`document.querySelector('${caravan}').open`), true, 'Adding Caravan devices preserves the open fold');
    for (const [width,height] of [[1440,1100],[390,1000],[320,900]]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1}); await settle();
      await evaluate(`document.querySelector('${caravan}').scrollIntoView({block:'start'});true`); await settle();
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Caravan does not overflow at ${width}px`);
      assert.equal(await evaluate(`(() => {const card=document.querySelector('${caravan}').getBoundingClientRect();return [...document.querySelectorAll('${appliance} select, ${appliance} button')].every(node=>{const box=node.getBoundingClientRect();return box.left>=card.left&&box.right<=card.right&&box.height>=36;});})()`), true, `Appliance controls fit at ${width}px`);
      const screenshot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
      writeFileSync(`var/caravan-${width}.png`,Buffer.from(screenshot.data,'base64'));
    }
    await evaluate(`(() => {const d=window.equipmentUiFixture.devices.find(d=>d.id==='caravan_dehumidifier');d.available=true;
      Object.assign(d.dehumidifier,{available:true,state:{power:'off',mode:'auto',targetHumidity:55,fanSpeed:'low',swing:'fixed_90'},runningState:'off'});return true;})()`);
    await refresh();
    assert.equal(await evaluate(`document.querySelector('${fan}').value`), 'low');
    const dehumidifierCalls = await evaluate('window.equipmentUiFixture.calls.length');
    await evaluate(`document.querySelector('${fan}').value='high';document.querySelector('${fan}').dispatchEvent(new Event('change',{bubbles:true}));true`);
    await until(`window.equipmentUiFixture.calls.length===${dehumidifierCalls + 1}`); await settle();
    assert.deepEqual(await evaluate('window.equipmentUiFixture.calls.at(-1)'),
      {path:'/api/equipment/dehumidifier',body:{deviceId:'caravan_dehumidifier',setting:'fanSpeed',value:'high'}});
    assert.equal(await evaluate(`document.querySelector('${fan}').value`), 'low', 'A publication cannot replace live reported settings');
    assert.equal(await evaluate(`document.querySelector('${fan}').disabled`), true);
    assert.match(await evaluate(`document.querySelector('${appliance} .equipment-control-result').textContent`), /High requested.*awaiting device report/);
    await evaluate("(() => {const d=window.equipmentUiFixture.devices.find(d=>d.id==='caravan_dehumidifier').dehumidifier;d.state.fanSpeed='high';d.operation.status='observed';return true;})()"); await refresh();
    assert.equal(await evaluate(`document.querySelector('${fan}').value`), 'high');
    assert.equal(await evaluate(`document.querySelector('${fan}').disabled`), false);
    assert.match(await evaluate(`document.querySelector('${appliance} .equipment-control-result').textContent`), /device reported/);
    await evaluate("window.equipmentUiFixture.status.role='replica';true"); await refresh();
    assert.equal(await evaluate(`document.querySelector('${fan}').disabled`), true, 'Replica remains read-only');
    await evaluate("window.equipmentUiFixture.status={};window.equipmentUiFixture.observations={};window.equipmentUiFixture.devices=[];true"); await refresh();
    assert.match(await evaluate("document.getElementById('garage-equipment-readings').textContent"), /No garage devices enabled/);
    assert.equal(await evaluate("document.querySelectorAll('#equipment-connections [data-device-id=caravan], #equipment-connections [data-device-id=garage-probes], #equipment-connections [data-device-id=door1], #equipment-connections [data-device-id=door2]').length"), 0);
    assert.equal(await evaluate("document.querySelector('#equipment-connections [data-device-id=\"connection:temperatures:home\"] code').textContent"), 'invented/home/upstairs/temperature', 'Configured feeds remain after equipment removal');
    assert.doesNotMatch(await evaluate("document.getElementById('equipment-check-message').textContent"), /No MQTT devices configured/, 'Other configured MQTT feeds prevent a false empty state');
  } finally {
    await evaluate("document.querySelector('#status-detail-popover .status-detail-close')?.click();window.fetch=window.equipmentUiFixture.fetch;history.replaceState(null,'',location.pathname+location.search+window.equipmentUiFixture.originalHash);for(const d of document.querySelectorAll('.controller-panels details'))d.open=window.equipmentUiFixture.openDetails.includes(d.id);delete window.equipmentUiFixture;document.getElementById('auth').dispatchEvent(new Event('submit',{cancelable:true}));true");
    await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  }
}
