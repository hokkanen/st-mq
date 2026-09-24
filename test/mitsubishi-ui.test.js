import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mitsubishiReadings, mitsubishiCompressor, mitsubishiControl, mitsubishiResult, mitsubishiRoomTemperature, createMitsubishiControls } from '../chart/mitsubishi.js';

const now = Date.parse('2026-09-21T12:00:00Z');
function fixture() {
  const fields = { power: 'on', mode: 'heat', targetC: 22, fan: 'auto', vane: 'auto', wideVane: 'center' };
  const values = { power: ['on','off'], mode: ['heat','cool','auto','dry','fan'], fan: ['auto','quiet',1,2,3,4],
    vane: ['auto',1,2,3,4,5,'swing'], wideVane: ['far-left','left','center','right','far-right','split','swing'] };
  return { now, garage: { settings: { enabled: false }, adapter: { connected: true,
    health: { deviceOnline: true, pumpCommunicating: true },
    native: { ...fields, powerAt: now, readbacks: Object.fromEntries(Object.entries(fields).map(([field,value]) => [field,{value,measuredAt:now}])) },
    telemetry: {} }, nativeControls: { available: true, busy: false, pending: false,
    settings: Object.fromEntries(Object.entries(fields).map(([field,value]) => [field, { supported:true,available:true,usable:true,value,measuredAt:now,
      ...(field==='targetC'?{min:16,max:31,step:.5}:{values:values[field]}) }])) } } };
}

test('Mitsubishi settings and diagnostics preserve zero, false and provisional measurements alongside unavailable fields', () => {
  const status=fixture();
  status.garage.adapter.telemetry={
    compressorFrequency:{value:0,unit:'Hz',sourceTime:now,supported:true,usable:true,quality:[]},
    defrost:{value:false,unit:'boolean',sourceTime:now,supported:true,usable:true,quality:[]},
    power:{value:300,unit:'W',sourceTime:now,receivedAt:now,supported:true,usable:false,quality:['unverified'],accuracyVerified:false},
    energy:{value:null,unit:'kWh',sourceTime:now,supported:false,usable:false,quality:['unsupported']},
  };
  const rows=Object.fromEntries(mitsubishiReadings(status.garage,now).map(row=>[row.key,row]));
  assert.equal(rows['native-targetC'].value,'22 °C');assert.equal(rows['native-power'].value,'On');
  assert.equal(rows['telemetry-compressorFrequency'].value,'0 Hz');assert.equal(rows['telemetry-defrost'].value,'No');
  assert.equal(rows['telemetry-power'].value,'300 W');assert.equal(rows['telemetry-power'].qualifier,'Provisional');
  assert.match(rows['telemetry-power'].detail,/Not qualified as control or metering evidence/);
  assert.equal(rows['telemetry-energy'].value,'Unavailable');assert.equal(rows['telemetry-outdoorTemperature'].value,'Unavailable');
  assert.match(rows['telemetry-energy'].detail,/Unsupported/);
});

test('Mitsubishi readings merge telemetry aliases and expose last stale readings only in details', () => {
  const status=fixture(), reading={value:18.25,sourceTime:now-120000,supported:true,usable:false,quality:['stale']};
  status.garage.adapter.telemetry={indoorTemperature:reading,garage_native_indoor_temperature:reading,
    energyCounterRaw:{value:42,sourceTime:now,supported:true,unit:'count',quality:[]}};
  const rows=mitsubishiReadings(status.garage,now);
  assert.equal(rows.filter(row=>row.key==='telemetry-indoorTemperature').length,1);
  const indoor=rows.find(row=>row.key==='telemetry-indoorTemperature');
  assert.equal(indoor.value,'Unavailable');assert.match(indoor.detail,/Last reported: 18.25 °C/);
  const raw=rows.find(row=>row.key==='telemetry-energyCounterRaw');assert.equal(raw.value,'42');assert.doesNotMatch(raw.value,/kWh/);
  status.garage.adapter.connected=false;
  assert(mitsubishiReadings(status.garage,now).every(row=>!row.available));
});

test('additional native and diagnostic values are visible without inventing unsupported water circuits', () => {
  const status=fixture();
  status.garage.adapter.native.readbacks.extraSetting={value:'reported',measuredAt:now};
  status.garage.adapter.telemetry.faultRaw={value:'a1',sourceTime:now,supported:true,quality:['unverified']};
  const rows=mitsubishiReadings(status.garage,now);
  assert(rows.some(row=>row.key==='native-extraSetting'&&row.value==='Reported'));
  assert(rows.some(row=>row.key==='telemetry-faultRaw'&&row.value==='A1'));
  assert(!rows.some(row=>/hot water|brine|flow temperature/i.test(row.label)));
});

test('native controls require their own advertised authority, independently of automatic savings', () => {
  const status=fixture();assert.equal(mitsubishiControl(status,'power').available,true);
  for(const changed of [{...status,readOnly:true},{...status,role:'replica'},{...status,role:'protected'},
    {...status,garage:{...status.garage,nativeControls:{...status.garage.nativeControls,available:false}}},
    {...status,garage:{...status.garage,nativeControls:{...status.garage.nativeControls,pending:true}}},
    {...status,garage:{...status.garage,nativeControls:{...status.garage.nativeControls,busy:true}}},
    {...status,garage:{...status.garage,nativeControls:{available:true,settings:{power:{supported:false,available:true}}}}}])
    assert.equal(mitsubishiControl(changed,'power').available,false);
  assert.equal(mitsubishiControl({},'power').available,false);
});

test('command feedback requires native confirmation and identifies unknown outcomes', () => {
  for(const status of ['pending','published','accepted']){
    const message=mitsubishiResult({setting:'targetC',value:22,status});
    assert.match(message,/waiting for fresh pump confirmation/);assert.doesNotMatch(message,/Confirmed by/);
  }
  assert.match(mitsubishiResult({setting:'power',value:'off',status:'native-confirmed',nativeConfirmedAt:now}),/Confirmed by the pump at/);
  assert.match(mitsubishiResult({setting:'fan',value:2,status:'uncertain'}),/Outcome uncertain.*before retrying/);
  assert.match(mitsubishiResult({setting:'vane',value:'swing',status:'rejected',reason:'restoration-pending'}),/Rejected.*Restoration pending/);
});

function panelFixture() {
  class Node {
    constructor(){this.value='';this.textContent='';this.children=[];this.listeners=new Map();this.attributes=new Map();this.classes=new Set();
      this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
    get options(){return this.children;} append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=[...nodes];}
    setAttribute(key,value){this.attributes.set(key,value);} removeAttribute(key){this.attributes.delete(key);}
    addEventListener(event,handler){this.listeners.set(event,handler);} removeEventListener(event){this.listeners.delete(event);}
  }
  const ids=['form','setting','value','temperature','submit','message','temperature-field','value-field','status','control-details','temperature-help'];
  const nodes=new Map(ids.map(id=>[`garage-native-${id}`,new Node()]));
  nodes.set('garage-room-temperature-status', new Node());
  const setting=nodes.get('garage-native-setting');setting.value='power';
  for(const field of ['power','mode','targetC','fan','vane','wideVane']){const option=new Node();option.value=field;setting.append(option);}
  const document={getElementById:id=>nodes.get(id),createElement:()=>new Node()};
  const calls=[],busy=[],status=fixture();let reply=status;
  const panel=createMitsubishiControls({document,request:async(path,input)=>{calls.push([path,input]);return typeof reply==='function'?reply():reply;},onBusy:value=>busy.push(value)});
  panel.update(status);
  return {panel,nodes,calls,busy,status,reply(value){reply=value;},
    change(field){setting.value=field;setting.listeners.get('change')();},
    submit(){return nodes.get('garage-native-form').listeners.get('submit')({preventDefault(){}});}};
}

test('parameter form sends one advertised typed setting, rejects double submit, and follows confirmation', async () => {
  const f=panelFixture();f.change('fan');f.nodes.get('garage-native-value').value='2';
  let done;f.reply(()=>new Promise(resolve=>{done=resolve;}));
  const pending=f.submit();await f.submit();assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0],['/api/garage/native',{setting:'fan',value:2}]);assert.equal(f.nodes.get('garage-native-submit').disabled,true);
  done({...f.status,garage:{...f.status.garage,nativeControls:{...f.status.garage.nativeControls,result:{setting:'fan',value:2,status:'accepted'}}}});
  await pending;assert.match(f.nodes.get('garage-native-message').textContent,/waiting for fresh pump confirmation/);
  f.panel.update({...f.status,garage:{...f.status.garage,nativeControls:{...f.status.garage.nativeControls,result:{setting:'fan',value:2,status:'native-confirmed',nativeConfirmedAt:now}}}});
  assert.match(f.nodes.get('garage-native-message').textContent,/Confirmed by the pump/);assert.deepEqual(f.busy,[true,false]);
  f.panel.close();assert.equal(f.nodes.get('garage-native-form').listeners.size,0);
});

test('parameter form rejects unsupported enums and invalid setpoint steps, then permits corrected input', async () => {
  const f=panelFixture();f.change('mode');f.nodes.get('garage-native-value').value='"invented"';await f.submit();
  assert.equal(f.calls.length,0);assert.match(f.nodes.get('garage-native-message').textContent,/supported by the pump/);
  f.change('targetC');for(const value of ['', '10','32','22.25']){f.nodes.get('garage-native-temperature').value=value;await f.submit();}
  assert.equal(f.calls.length,0);
  f.nodes.get('garage-native-temperature').value='22.5';await f.submit();
  assert.deepEqual(f.calls,[['/api/garage/native',{setting:'targetC',value:22.5}]]);
  f.panel.update({...f.status,readOnly:true});await f.submit();assert.equal(f.calls.length,1);
  assert.equal(f.nodes.get('garage-native-submit').disabled,true);
});

test('Mitsubishi keeps readings visible inside the card with separate settings and automatic policy', () => {
  const html=readFileSync(new URL('../chart/index.html',import.meta.url),'utf8');
  for(const id of ['garage-native-control-details','garage-automatic-details']){
    const tag=html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert.match(tag,/class="equipment-fold"/);assert.doesNotMatch(tag,/\sopen(?:\s|>|=)/);
  }
  assert.match(html, /<section id="garage-readings-details"[^>]+aria-labelledby="garage-readings-title">/);
  assert.doesNotMatch(html, /<details id="garage-readings-details"/);
  assert.match(html, /id="garage-native-form" class="h66-test-form mitsubishi-test-form"/);
  const form=html.slice(html.indexOf('id="garage-native-form"'),html.indexOf('id="garage-native-status"'));
  for(const field of ['power','mode','targetC','fan','vane','wideVane'])assert(form.includes(`value="${field}"`));
  assert(html.indexOf('id="garage-automatic-details"')<html.indexOf('id="garage-release"'));
});

test('all known Mitsubishi readings stay visible before telemetry arrives while unsupported controls stay disabled', () => {
  const readings=mitsubishiReadings({},now);
  assert.deepEqual(readings.map(row=>row.key).sort(), [
    'native-power','native-mode','native-targetC','native-fan','native-vane','native-wideVane',
    'telemetry-compressorActive','telemetry-compressorFrequency','telemetry-defrost','telemetry-actualFan',
    'telemetry-preheat','telemetry-standby','telemetry-faultRaw','telemetry-indoorTemperature',
    'telemetry-outdoorTemperature','telemetry-power','telemetry-energy','telemetry-energyCounterRaw',
  ].sort());
  assert(readings.every(row=>row.value==='Unavailable'&&!row.available));
  const f=panelFixture(), controls=f.status.garage.nativeControls;
  const changed={...f.status,garage:{...f.status.garage,nativeControls:{...controls,settings:{...controls.settings,
    power:{...controls.settings.power,supported:false},mode:{...controls.settings.mode,value:null}}}}};
  f.panel.update(changed);
  assert.deepEqual(f.nodes.get('garage-native-setting').options.map(option=>option.value),['targetC','fan','vane','wideVane']);
  f.panel.update({...f.status,garage:{...f.status.garage,nativeControls:{available:false,settings:{}}}});
  assert.equal(f.nodes.get('garage-native-control-details').hidden,true);
  assert.equal(f.nodes.get('garage-native-setting').options.length,0);
  assert.equal(f.nodes.get('garage-native-submit').disabled,true);
});

test('invalid diagnostic values remain visible as unavailable without being mistaken for current readings', () => {
  const status=fixture();
  for(const quality of ['unknown','unsupported','invalid-value','sentinel']){
    status.garage.adapter.telemetry={energyCounterRaw:{value:0,sourceTime:now,supported:true,quality:[quality]}};
    const row=mitsubishiReadings(status.garage,now).find(row=>row.key==='telemetry-energyCounterRaw');
    assert.equal(row.value,'Unavailable');assert.equal(row.available,false);
  }
  status.garage.adapter.telemetry={compressorFrequency:{value:0,sourceTime:now-120000,supported:true,quality:['stale']}};
  const stale=mitsubishiReadings(status.garage,now).find(row=>row.key==='telemetry-compressorFrequency');
  assert.equal(stale.value,'Unavailable');assert.match(stale.detail,/Last reported: 0 Hz/);
});

test('compressor state distinguishes idle from power-on and stays unknown without fresh boolean evidence', () => {
  const status=fixture(), telemetry=status.garage.adapter.telemetry;
  const reading={sourceTime:now,supported:true,usable:true,quality:[]};
  for(const [value,expected] of [[true,'Running'],[false,'Idle']]){
    telemetry.compressorActive={...reading,value};
    assert.equal(mitsubishiCompressor(status.garage,now).value,expected);
  }
  for(const extra of [{value:null},{value:0},{value:'false'},{value:true,sourceTime:now-120000},
    {value:false,sourceTime:now+1},{value:true,supported:false},{value:true,quality:['invalid']},
    {value:true,quality:['unknown']},{value:true,available:false}]){
    telemetry.compressorActive={...reading,...extra};
    assert.equal(mitsubishiCompressor(status.garage,now).value,'Unknown',JSON.stringify(extra));
  }
  telemetry.compressorActive={...reading,value:true};
  status.garage.adapter.connected=false;
  assert.equal(mitsubishiCompressor(status.garage,now).value,'Unknown');
  delete telemetry.compressorActive;status.garage.adapter.connected=true;
  telemetry.compressorFrequency={...reading,value:42,unit:'Hz'};
  assert.equal(mitsubishiCompressor(status.garage,now).value,'Unknown','Frequency and selected power do not substitute for compressor state');
});

test('Mitsubishi field set survives lost, unsupported and invalid telemetry without changing row order', () => {
  const status=fixture(), expected=mitsubishiReadings(status.garage,now).map(row=>row.key);
  for(const field of ['compressorActive','compressorFrequency','defrost','actualFan','preheat','standby',
    'faultRaw','indoorTemperature','outdoorTemperature','power','energy','energyCounterRaw']){
    for(const reading of [{value:null,supported:false},{value:0,supported:true,quality:['unknown']},
      {value:false,supported:true,quality:['invalid']}]){
      status.garage.adapter.telemetry={[field]:{sourceTime:now,...reading}};
      const rows=mitsubishiReadings(status.garage,now);
      assert.deepEqual(rows.map(row=>row.key),expected);
      assert.equal(rows.find(row=>row.key===`telemetry-${field}`).value,'Unavailable');
    }
  }
  assert.deepEqual(mitsubishiReadings({},now).map(row=>row.key),expected);
});


test('room setting permits 5°C only when advertised and preserves the saved target across fallback', async () => {
  const f = panelFixture(), status = structuredClone(f.status);
  Object.assign(status.garage.adapter.native, { targetC: 17 });
  status.garage.adapter.native.readbacks.targetC.value = 17;
  Object.assign(status.garage.nativeControls.settings.targetC, { min: 5, value: 5, usable: false });
  status.garage.roomTemperature = { targetC: 5, phase: 'waiting', reason: 'rear-temperature-stale',
    sourceC: null, measuredAt: null, offsetC: 12, suppliedC: null, nativeTargetC: 17, acknowledged: false };
  f.panel.update(status); f.change('targetC');
  assert.equal(f.nodes.get('garage-native-temperature').min, 5);
  assert.equal(f.nodes.get('garage-native-temperature').value, '5');
  assert.equal(f.nodes.get('garage-native-temperature-help').hidden, false);
  assert.match(f.nodes.get('garage-room-temperature-status').textContent, /Room setting 5 °C.*External temperature control is unavailable/);
  for (const value of ['4.5', '31.5', '5.25']) { f.nodes.get('garage-native-temperature').value = value; await f.submit(); }
  assert.equal(f.calls.length, 0);
  f.nodes.get('garage-native-temperature').value = '5';
  f.reply({ ...status, garage: { ...status.garage, nativeControls: { ...status.garage.nativeControls,
    result: { setting: 'targetC', value: 5, status: 'saved' } } } });
  await f.submit();
  assert.deepEqual(f.calls, [['/api/garage/native', { setting: 'targetC', value: 5 }]]);
  assert.match(f.nodes.get('garage-native-message').textContent, /Saved; preparing external temperature control/);
  assert.equal(mitsubishiReadings(status.garage, now).find(row => row.key === 'native-targetC').value, '17 °C');
  assert.equal(f.nodes.get('garage-native-temperature').value, '5');
  f.change('fan');
  assert.equal(f.nodes.get('garage-native-temperature-help').hidden, true);
  assert.match(f.nodes.get('garage-native-status').textContent, /ends external temperature control/);
});

test('room control status distinguishes acknowledgement, preparation and fallback without rewriting native evidence', () => {
  const garage = fixture().garage;
  garage.roomTemperature = { targetC: 5, phase: 'active', sourceC: 5.25, measuredAt: now,
    offsetC: 12, suppliedC: 17.25, nativeTargetC: 17, acknowledged: true };
  const before = structuredClone(garage), room = mitsubishiRoomTemperature(garage);
  assert.equal(room.value, '5 °C'); assert.equal(room.basis, 'Garage rear · active');
  assert.match(room.detail, /native pump target of 17 °C/);
  assert.match(room.detail, /adds 12 °C/); assert.match(room.detail, /Garage rear: 5.25 °C/);
  assert.match(room.detail, /Supplied temperature: 17.25 °C/);
  assert.match(room.detail, /Missing or stale sensor readings/);
  assert.match(room.detail, /Before enabling or renewing.*ON, HEAT and 17 °C/);
  assert.match(room.detail, /If that check fails, renewals stop and the current permission expires/);
  assert.match(room.detail, /Internal temperature control then uses the pump's current settings/);
  assert.deepEqual(garage, before);
  for (const [phase, basis] of [['preparing', 'preparing'], ['clearing', 'clearing'], ['waiting', 'fallback'], ['blocked', 'fallback']]) {
    garage.roomTemperature.phase = phase;
    garage.roomTemperature.reason = 'rear-temperature-unavailable';
    const pending = mitsubishiRoomTemperature(garage);
    assert.equal(pending.active, false); assert.equal(pending.basis, `External sensor · ${basis}`);
    assert.match(pending.detail, /Rear temperature unavailable/);
  }
  garage.roomTemperature.phase = 'active'; garage.roomTemperature.acknowledged = false;
  assert.equal(mitsubishiRoomTemperature(garage).basis, 'External sensor · preparing');
  garage.roomTemperature.targetC = null; assert.equal(mitsubishiRoomTemperature(garage), null);
  assert.equal(mitsubishiRoomTemperature({}), null);
  assert.match(mitsubishiResult({ setting: 'targetC', value: 5, status: 'acknowledged' }), /acknowledged by the driver/);
  assert.doesNotMatch(mitsubishiResult({ setting: 'targetC', value: 5, status: 'acknowledged' }), /Confirmed by the pump/);
});

test('external room targets remain visible but cannot be submitted from read-only replicas', async () => {
  const f = panelFixture(), status = structuredClone(f.status);
  Object.assign(status.garage.nativeControls.settings.targetC, { min: 5, value: 5 });
  status.garage.roomTemperature = { targetC: 5, phase: 'active', acknowledged: true, offsetC: 12 };
  for (const role of ['replica', 'protected', 'transition']) {
    f.panel.update({ ...status, role }); f.change('targetC'); await f.submit();
    assert.equal(f.nodes.get('garage-native-temperature').value, '5');
    assert.equal(f.nodes.get('garage-native-submit').disabled, true);
    assert.match(f.nodes.get('garage-native-status').textContent, /read-only/);
  }
  f.panel.update({ ...status, readOnly: true }); await f.submit();
  assert.equal(f.calls.length, 0);
  const html = readFileSync(new URL('../chart/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /assume-isave|Assume i-save|Assumes i-save|controller’s assumption/);
  assert.match(html, /Garage rear guides heating while the pump is set to 17 °C/);
});
