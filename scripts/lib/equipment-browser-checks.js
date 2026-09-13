import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

/** Browser-only invented equipment replaces status responses. Test/recheck
 * requests are intercepted before transport; no equipment route is contacted. */
export async function checkEquipmentBrowser({ evaluate, command, context, until }) {
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const refresh = async () => {
    const responses = await evaluate('window.equipmentUiFixture.responses');
    await evaluate("document.getElementById('auth').dispatchEvent(new Event('submit', {cancelable:true})); true");
    await until(`window.equipmentUiFixture.responses > ${responses}`);
    await settle();
  };
  const openDetail = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'});true`);
    await settle();
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus();true`);
    await command('input.performActions',{context,actions:[{type:'key',id:'status-detail-open',actions:[{type:'keyDown',value:'\uE007'},{type:'keyUp',value:'\uE007'}]}]});
    await until("document.getElementById('status-detail-popover')?.checkVisibility()");
    await settle();
  };
  const escapeDetail = async () => {
    await command('input.performActions',{context,actions:[{type:'key',id:'status-detail-keyboard',actions:[{type:'keyDown',value:'\uE00C'},{type:'keyUp',value:'\uE00C'}]}]});
    assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), false, 'Escape dismisses the status explanation');
  };
  await evaluate(`(() => {
    const fixture = window.equipmentUiFixture = {fetch:window.fetch.bind(window), calls:[], responses:0, active:null, homeHeight:document.getElementById('home-control').getBoundingClientRect().height,
      originalHash:location.hash, openDetails:[...document.querySelectorAll('.controller-panels details[open]')].map(node=>node.id)};
    const at = Date.parse('2026-09-07T11:00:00Z');
    const reading = (label,value,unit,observedAt=at) => ({label,value,unit,observedAt,stale:false});
    fixture.devices = [
      {id:'home-relay',label:'Tariff control',area:'home',kind:'switch',source:'MQTT-shelly',connection:'shelly:invented-home-relay',available:true,
        controls:{switch:true,tariff:true},readings:{heat_savings_active:reading('Relay',0,'state')}},
      {id:'garage-probes',label:'Garage temperatures',area:'garage',kind:'temperature',source:'MQTT-shelly',connection:'shelly:invented-garage',available:true,
        controls:{switch:false},readings:{garage_temperature:reading('By the entrance',18.2,'°C'),garage_temperature_2:reading('By the back wall',16.5,'°C')}},
      {id:'caravan',label:'Caravan',area:'garage',kind:'metered_switch',source:'MQTT-shelly',connection:'shelly:invented-caravan',available:true,
        controls:{switch:true},readings:{caravan_active:reading('Switch',1,'state'),caravan_power:reading('Power',0.35,'kW'),caravan_current:reading('Current',1.52,'A')},energy:{dailyKwh:1.234,observedAt:at,partial:true}},
      ...[1,2].map(index=>({id:'door'+index,label:'Door '+index,area:'garage',kind:'door',source:'MQTT',connection:'mqtt:invented/garage/door'+index,available:true,
        controls:{switch:false},readings:{['garage_door'+index+'_open']:reading('Door state',index===1?0:1,'state',at-7*86400000)}})),

    ];
    fixture.response = base => ({...base,observations:{...base.observations,indoor:fixture.indoor??base.observations.indoor},equipment:{configured:true,connected:true,devices:fixture.devices},
      equipmentTests:{available:true,busy:false,active:fixture.active}});
    window.fetch = async (...args) => {
      const path = new URL(args[0],location.href).pathname;
      if(path.endsWith('/api/status')) {const response=await fixture.fetch(...args);fixture.base=await response.json();fixture.responses++;return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});}
      if(path.includes('/api/equipment/')) {
        const body=JSON.parse(args[1].body);fixture.calls.push({path,body});
        if(path.endsWith('/test'))fixture.active={deviceId:body.deviceId,on:body.on,previousOn:true,until:at+3600000,status:'awaiting readback'};
        if(path.endsWith('/restore')&&fixture.failRestore){fixture.failRestore=false;return new Response(JSON.stringify({error:'Synthetic restore failure'}),{status:503});}
        if(path.endsWith('/restore'))fixture.active=null;
        return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
      }
      return fixture.fetch(...args);
    };
    return true;
  })()`);
  try {
    await refresh();
    assert.equal(await evaluate("document.querySelectorAll('.controller-column > article').length"), 3);
    assert.equal(await evaluate("document.getElementById('garage-control') === null && document.getElementById('garage-equipment-readings').closest('#equipment-details') !== null"), true);
    assert.equal(await evaluate("Math.abs(document.getElementById('home-control').getBoundingClientRect().height-window.equipmentUiFixture.homeHeight)<2"), true, 'Added monitoring does not change the collapsed Home card');
    assert.equal(await evaluate("document.getElementById('equipment-details').open"), false);
    assert.equal(await evaluate("document.getElementById('garage-switch-tests-details').open"), false);
    assert.equal(await evaluate("document.getElementById('garage-equipment-readings').textContent.includes('By the entrance') && document.getElementById('garage-equipment-readings').textContent.includes('By the back wall')"), true);
    assert.equal(await evaluate("document.querySelector('[data-device-id=door1] .equipment-readings .status-detail-label').textContent"), 'Closed');
    assert.equal(await evaluate("document.querySelector('[data-device-id=door2] .equipment-readings .status-detail-label').textContent"), 'Open');
    assert.equal(await evaluate("document.querySelector('[data-device-id=caravan]').textContent.includes('1.234 kWh')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.equipment-source')].every(node=>['MQTT','Shelly'].includes(node.textContent))"), true);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, 'Monitoring does not test or recheck devices');
    await evaluate("document.getElementById('connections-details').open=true;document.getElementById('mqtt-devices-details').open=true;document.getElementById('equipment-recheck-all').click();true");
    await until('window.equipmentUiFixture.calls.length === 1');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[0].body)')), {});
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(node=>node.textContent==='mqtt:invented/garage/door1')"), true);
    assert.equal(await evaluate("document.getElementById('mqtt-devices-details').nextElementSibling.id"), 'electricity-details');
    assert.equal(await evaluate("(() => {const row=document.querySelector('.equipment-connection');const source=row.querySelector('.equipment-source').getBoundingClientRect(),check=row.querySelector('.equipment-connection-actions button').getBoundingClientRect();return source.bottom<=check.top&&Math.abs(source.right-check.right)<2;})()"), true, 'Source sits above Recheck on the right');
    assert.equal(await evaluate("document.querySelector('.equipment-connection .equipment-device-status').dataset.state"), 'available');
    await evaluate("document.querySelector('#equipment-connections .equipment-connection-actions button').click(); true");
    await until('window.equipmentUiFixture.calls.length === 2');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[1].body)')), {deviceId:'home-relay'});
    await evaluate("document.getElementById('equipment-details').open=true;document.getElementById('garage-switch-tests-details').open=true;document.querySelector('#garage-equipment-tests [data-device-id=caravan] input').value='7';true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('#garage-equipment-tests [data-device-id=caravan] input').value"), '7', 'Polling preserves the test draft');
    await evaluate("document.querySelector('#garage-equipment-tests [data-device-id=caravan] button').click();true");
    await until('window.equipmentUiFixture.calls.length === 3');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[2].body)')), {deviceId:'caravan',on:true,durationMinutes:7});
    assert.equal(await evaluate("document.getElementById('garage-active-test').hidden"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('.equipment-test-form button[type=submit]')].every(button=>button.disabled)"), true);
    await evaluate("document.getElementById('garage-switch-tests-details').open=false;true");
    assert.equal(await evaluate("document.querySelector('#garage-test-notice .equipment-restore').checkVisibility()"), true, 'Restoration stays reachable when manual controls are collapsed');
    await evaluate("window.equipmentUiFixture.failRestore=true;document.querySelector('#garage-test-notice .equipment-restore').click();true");
    await until("window.equipmentUiFixture.calls.length === 4 && document.getElementById('garage-equipment-result').classList.contains('form-error')");
    assert.equal(await evaluate("document.getElementById('garage-equipment-result').checkVisibility() && !document.querySelector('#garage-test-notice .equipment-restore').disabled"), true, 'Restore failure and retry remain visible with manual controls collapsed');
    assert.notEqual(await evaluate('window.equipmentUiFixture.active'), null);
    await evaluate("document.querySelector('#garage-test-notice .equipment-restore').click();true");
    await until('window.equipmentUiFixture.calls.length === 5 && window.equipmentUiFixture.active === null');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[4].body)')), {});
    assert.match(await evaluate("document.getElementById('garage-equipment-result').textContent"), /Restoration requested/);
    assert.equal(await evaluate("document.getElementById('garage-equipment-result').checkVisibility()"), true, 'Restoration acknowledgement remains visible outside collapsed controls');
    assert.doesNotMatch(await evaluate("document.getElementById('equipment-check-message').textContent"), /Restoration requested/);
    await evaluate("(() => {const door=window.equipmentUiFixture.devices.find(device=>device.id==='door1');door.available=false;door.readings.garage_door1_open.stale=true;return true;})()");
    await refresh();
    await until("document.querySelector('[data-device-id=door1] .equipment-readings .status-detail-label').textContent === 'Unknown'");
    assert.equal(await evaluate("[...document.querySelectorAll('.equipment-readings small')].every(node=>!node.textContent.includes('Last reported')&&!node.textContent.includes('updated'))"), true, 'Reading timestamps stay behind a compact explanation');
    const doorTrigger = '#garage-equipment-readings [data-device-id=door1] .equipment-readings .status-detail-trigger';
    await openDetail(doorTrigger);
    assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Last reported Closed/);
    await refresh();
    assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), true, 'Polling preserves an equipment reading explanation');
    await escapeDetail();
    assert.equal(await evaluate(`document.activeElement === document.querySelector(${JSON.stringify(doorTrigger)})`), true, 'Escape returns focus to the reading');
    await evaluate("window.equipmentUiFixture.indoor={value:null,source:'mqtt-temperature',observedAt:0,stale:true,periodicReports:true,lastReportAt:null,reportExpiresAt:null,reportMaxAgeMs:4500000,availabilityReasons:['missing-report']};document.getElementById('equipment-details').open=false;true");
    await refresh();
    await until("document.querySelector('#indoor .status-detail-label')?.textContent === 'Unavailable'");
    assert.equal(await evaluate("document.getElementById('indoor-age').textContent"), 'MQTT');
    assert.equal(await evaluate("document.getElementById('indoor-issue') === null && document.getElementById('indoor-status-detail') === null"), true);
    const indoorTrigger = '#indoor .status-detail-trigger';
    await openDetail(indoorTrigger);
    assert.equal(await evaluate("document.getElementById('status-detail-popover').getAttribute('role')"), 'dialog');
    assert.match(await evaluate("document.querySelector('#status-detail-popover .status-detail-body').textContent"), /Expected temperature report missing/);
    assert.equal(await evaluate("document.getElementById('equipment-details').open"), false, 'The indoor explanation does not expand another section');
    await refresh();
    assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), true, 'Polling preserves an open explanation');
    await escapeDetail();
    assert.equal(await evaluate("document.activeElement === document.querySelector('#indoor .status-detail-trigger')"), true, 'Escape returns focus to the indoor metric');
    await openDetail(indoorTrigger);
    await evaluate("document.getElementById('equipment-details').open=true;document.querySelector('#garage-equipment-readings [data-device-id=door2] .status-detail-trigger').click();true");
    assert.equal(await evaluate("document.querySelectorAll('.status-detail-popover:not([hidden])').length"), 1, 'Only one status explanation is shown at a time');
    assert.equal(await evaluate("document.querySelector('#indoor .status-detail-trigger').getAttribute('aria-expanded')"), 'false');
    await evaluate("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.body.click();true");
    assert.equal(await evaluate("document.getElementById('status-detail-popover').checkVisibility()"), false, 'Clicking outside dismisses the explanation');
    const fixtureDevices = await evaluate("window.equipmentUiFixture.devices.length");
    await evaluate("window.equipmentUiFixture.savedDevices=window.equipmentUiFixture.devices;window.equipmentUiFixture.devices=window.equipmentUiFixture.devices.filter(device=>!device.controls?.switch);true");
    await refresh();
    assert.equal(await evaluate("document.getElementById('garage-switch-tests-details').hidden"), true, 'Garage controls are hidden without controllable switches');
    await evaluate("window.equipmentUiFixture.devices=window.equipmentUiFixture.savedDevices;true");
    await refresh();
    assert.equal(await evaluate("window.equipmentUiFixture.devices.length"), fixtureDevices);
    for (const [width,height] of [[1440,1000],[320,640],[390,844],[844,390]]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1});
      await settle();
      await openDetail(indoorTrigger);
      assert.equal(await evaluate(`(() => {
        const label=document.querySelector('#indoor .status-detail-label'),range=document.createRange();
        range.selectNodeContents(label);return range.getClientRects().length===1;
      })()`), true, `Unavailable remains readable on one line at ${width}px`);
      assert.equal(await evaluate(`(() => {
        const popup=document.getElementById('status-detail-popover'),box=popup.getBoundingClientRect();
        return box.width>0 && box.width<=Math.min(352,innerWidth-24) && box.height<=Math.min(288,innerHeight-24)
          && box.left>=7 && box.right<=innerWidth-7 && box.top>=7 && box.bottom<=innerHeight-7
          && popup.scrollWidth<=popup.clientWidth;
      })()`), true, `Status explanation remains compact inside ${width}×${height}`);
      if(width===320||width===390) {
        const popup=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/home-energy-status-detail-${width}.png`,Buffer.from(popup.data,'base64'));
      }
      await evaluate("document.querySelector('#status-detail-popover .status-detail-close').click();true");
      assert.equal(await evaluate("document.activeElement === document.querySelector('#indoor .status-detail-trigger')"), true, 'Close returns focus to the status trigger');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Equipment and connections fit ${width}×${height}`);
      if(width===1440)assert.equal(await evaluate("Math.abs(document.getElementById('home-control').getBoundingClientRect().top-document.getElementById('house-model').getBoundingClientRect().top)<2"),true);
      assert.equal(await evaluate(`(() => {
        const root=document.getElementById('garage-equipment-readings'),cards=[...root.children].map(node=>node.getBoundingClientRect());
        return cards.every(box=>box.width>=Math.min(220,root.clientWidth)-1)
          && (${width}===1440?Math.abs(cards[0].top-cards[1].top)<1:cards[1].top>=cards[0].bottom);
      })()`), true, `Garage cards use readable columns at ${width}px`);
      {
        await evaluate("document.getElementById('garage-equipment-details').scrollIntoView({block:'start'});true");
        const shot=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/home-energy-garage-fold-${width}.png`,Buffer.from(shot.data,'base64'));
        await evaluate("document.getElementById('mqtt-devices-details').scrollIntoView({block:'start'});true");
        const settings=await command('browsingContext.captureScreenshot',{context,origin:'viewport'});
        writeFileSync(`var/home-energy-mqtt-devices-${width}.png`,Buffer.from(settings.data,'base64'));
      }
    }
  } finally {
    await evaluate("document.querySelector('#status-detail-popover .status-detail-close')?.click();true");
    await evaluate('window.fetch=window.equipmentUiFixture.fetch;history.replaceState(null,"",location.pathname+location.search+window.equipmentUiFixture.originalHash);for(const details of document.querySelectorAll(".controller-panels details"))details.open=window.equipmentUiFixture.openDetails.includes(details.id);delete window.equipmentUiFixture;document.getElementById("auth").dispatchEvent(new Event("submit",{cancelable:true}));true');
    await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  }
}
