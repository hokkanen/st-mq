import assert from 'node:assert/strict';

/** Browser-only invented equipment replaces status responses. Test/recheck
 * requests are intercepted before transport; no equipment route is contacted. */
export async function checkEquipmentBrowser({ evaluate, command, context, until }) {
  const refresh = async () => {
    await evaluate("document.getElementById('auth').dispatchEvent(new Event('submit', {cancelable:true})); true");
    await until("document.querySelector('#garage-equipment-readings [data-device-id=caravan]') !== null");
  };
  await evaluate(`(() => {
    const fixture = window.equipmentUiFixture = {fetch:window.fetch.bind(window), calls:[], active:null};
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
      {id:'garage-pump',label:'Garage heat pump',area:'garage',kind:'heat_pump',source:'MQTT',connection:'mqtt:invented/garage/pump',available:true,
        controls:{switch:true},readings:{garage_heat_pump_active:reading('Compressor',1,'state'),garage_heat_pump_temperature:reading('Air temperature',18,'°C')}}
    ];
    fixture.response = base => ({...base,equipment:{configured:true,connected:true,devices:fixture.devices},
      equipmentTests:{available:true,busy:false,active:fixture.active}});
    window.fetch = async (...args) => {
      const path = new URL(args[0],location.href).pathname;
      if(path.endsWith('/api/status')) {const response=await fixture.fetch(...args);fixture.base=await response.json();return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});}
      if(path.includes('/api/equipment/')) {
        const body=JSON.parse(args[1].body);fixture.calls.push({path,body});
        if(path.endsWith('/test'))fixture.active={deviceId:body.deviceId,on:body.on,previousOn:true,until:at+3600000,status:'awaiting readback'};
        if(path.endsWith('/restore'))fixture.active=null;
        return new Response(JSON.stringify(fixture.response(fixture.base)),{status:200});
      }
      return fixture.fetch(...args);
    };
    return true;
  })()`);
  try {
    await refresh();
    assert.equal(await evaluate("document.querySelectorAll('.controller-panels > article').length"), 4);
    assert.equal(await evaluate("document.getElementById('garage-control').parentElement === document.getElementById('home-control').parentElement"), true);
    assert.equal(await evaluate("document.getElementById('garage-equipment-details').open"), false);
    assert.equal(await evaluate("document.getElementById('garage-switch-tests-details').open"), false);
    assert.equal(await evaluate("document.getElementById('garage-equipment-readings').textContent.includes('By the entrance') && document.getElementById('garage-equipment-readings').textContent.includes('By the back wall')"), true);
    assert.equal(await evaluate("document.querySelector('[data-device-id=door1] .equipment-readings strong').textContent"), 'Closed');
    assert.equal(await evaluate("document.querySelector('[data-device-id=door2] .equipment-readings strong').textContent"), 'Open');
    assert.equal(await evaluate("document.querySelector('[data-device-id=garage-pump] .equipment-readings dt').textContent"), 'Power enabled');
    assert.equal(await evaluate("document.querySelector('[data-device-id=caravan]').textContent.includes('1.234 kWh')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.equipment-source')].every(node=>['MQTT','MQTT-shelly'].includes(node.textContent))"), true);
    assert.equal(await evaluate('window.equipmentUiFixture.calls.length'), 0, 'Monitoring does not test or recheck devices');
    await evaluate("document.getElementById('connections-details').open=true;document.getElementById('mqtt-devices-details').open=true;document.getElementById('equipment-recheck-all').click();true");
    await until('window.equipmentUiFixture.calls.length === 1');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[0].body)')), {});
    assert.equal(await evaluate("[...document.querySelectorAll('#equipment-connections code')].some(node=>node.textContent==='mqtt:invented/garage/door1')"), true);
    await evaluate("document.querySelector('#equipment-connections .equipment-connection button').click(); true");
    await until('window.equipmentUiFixture.calls.length === 2');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[1].body)')), {deviceId:'home-relay'});
    await evaluate("document.getElementById('garage-equipment-details').open=true;document.getElementById('garage-switch-tests-details').open=true;document.querySelector('#garage-equipment-tests [data-device-id=caravan] input').value='7';true");
    await refresh();
    assert.equal(await evaluate("document.querySelector('#garage-equipment-tests [data-device-id=caravan] input').value"), '7', 'Polling preserves the test draft');
    await evaluate("document.querySelector('#garage-equipment-tests [data-device-id=caravan] button').click();true");
    await until('window.equipmentUiFixture.calls.length === 3');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[2].body)')), {deviceId:'caravan',on:true,durationMinutes:7});
    assert.equal(await evaluate("document.getElementById('garage-active-test').hidden"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('.equipment-test-form button')].every(button=>button.disabled)"), true);
    await evaluate("document.querySelector('#garage-equipment-tests .equipment-restore').click();true");
    await until('window.equipmentUiFixture.calls.length === 4 && window.equipmentUiFixture.active === null');
    assert.deepEqual(JSON.parse(await evaluate('JSON.stringify(window.equipmentUiFixture.calls[3].body)')), {});
    await evaluate("(() => {const door=window.equipmentUiFixture.devices.find(device=>device.id==='door1');door.available=false;door.readings.garage_door1_open.stale=true;return true;})()");
    await refresh();
    await until("document.querySelector('[data-device-id=door1] .equipment-readings strong').textContent === 'Unknown'");
    assert.match(await evaluate("document.querySelector('[data-device-id=door1] .equipment-readings small').textContent"), /Last reported Closed/);
    for (const [width,height] of [[1440,1000],[390,844],[844,390]]) {
      await command('browsingContext.setViewport',{context,viewport:{width,height},devicePixelRatio:1});
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Equipment and connections fit ${width}×${height}`);
      if(width===1440)assert.equal(await evaluate("Math.abs(document.getElementById('home-control').getBoundingClientRect().top-document.getElementById('garage-control').getBoundingClientRect().top)<2"),true);
    }
  } finally {
    await evaluate('window.fetch=window.equipmentUiFixture.fetch;delete window.equipmentUiFixture;document.getElementById("garage-equipment-details").open=false;document.getElementById("connections-details").open=false;document.getElementById("auth").dispatchEvent(new Event("submit",{cancelable:true}));true');
    await command('browsingContext.setViewport',{context,viewport:{width:1440,height:1100},devicePixelRatio:1});
  }
}
