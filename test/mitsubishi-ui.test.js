import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mitsubishiReadings, mitsubishiControl, mitsubishiResult, createMitsubishiControls } from '../chart/mitsubishi.js';

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

test('Mitsubishi settings and diagnostics preserve zero, false and provisional measurements while omitting unsupported fields', () => {
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
  assert.equal(rows['telemetry-energy'],undefined);assert.equal(rows['telemetry-outdoorTemperature'],undefined);
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
  const ids=['form','setting','value','temperature','submit','message','temperature-field','value-field','status','control-details'];
  const nodes=new Map(ids.map(id=>[`garage-native-${id}`,new Node()]));
  for (const id of ['garage-assume-isave', 'garage-assume-isave-status']) nodes.set(id, new Node());
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

test('Mitsubishi disclosures match heat-pump controls/readings layout and keep automatic policy separate', () => {
  const html=readFileSync(new URL('../chart/index.html',import.meta.url),'utf8');
  for(const id of ['garage-native-control-details','garage-readings-details','garage-automatic-details']){
    const tag=html.match(new RegExp(`<details[^>]+id="${id}"[^>]*>`))[0];
    assert.match(tag,/class="equipment-fold"/);assert.doesNotMatch(tag,/\sopen(?:\s|>|=)/);
  }
  assert.match(html, /id="garage-native-form" class="h66-test-form mitsubishi-test-form"/);
  const form=html.slice(html.indexOf('id="garage-native-form"'),html.indexOf('id="garage-native-status"'));
  for(const field of ['power','mode','targetC','fan','vane','wideVane'])assert(form.includes(`value="${field}"`));
  assert(html.indexOf('id="garage-automatic-details"')<html.indexOf('id="garage-release"'));
});

test('never-observed readings and unsupported controls are absent instead of permanent unavailable placeholders', () => {
  assert.deepEqual(mitsubishiReadings({},now),[]);
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

test('explicitly unknown diagnostic values stay absent even when an older source claims support', () => {
  const status=fixture();
  for(const quality of ['unknown','unsupported','invalid-value','sentinel']){
    status.garage.adapter.telemetry={energyCounterRaw:{value:0,sourceTime:now,supported:true,quality:[quality]}};
    assert(!mitsubishiReadings(status.garage,now).some(row=>row.key==='telemetry-energyCounterRaw'));
  }
  status.garage.adapter.telemetry={compressorFrequency:{value:0,sourceTime:now-120000,supported:true,quality:['stale']}};
  const stale=mitsubishiReadings(status.garage,now).find(row=>row.key==='telemetry-compressorFrequency');
  assert.equal(stale.value,'Unavailable');assert.match(stale.detail,/Last reported: 0 Hz/);
});


test('i-save checkbox saves only an owner assumption and preserves native readback and verification', async () => {
  const f = panelFixture(), checkbox = f.nodes.get('garage-assume-isave');
  const original = { ...f.status, garage: { ...f.status.garage, preferences: { available: true },
    settings: { ...f.status.garage.settings, assumeISave10C: false },
    adapter: { ...f.status.garage.adapter, baselineVerified: false,
      native: { ...f.status.garage.adapter.native, targetC: 16 } } } };
  f.panel.update(original); assert.equal(checkbox.disabled, false); assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  let done; f.reply(() => new Promise(resolve => { done = resolve; }));
  const pending = checkbox.listeners.get('change')();
  assert.equal(checkbox.disabled, true); await checkbox.listeners.get('change')();
  assert.deepEqual(f.calls, [['/api/garage/preferences', { assumeISave10C: true }]]);
  const assumed = { ...original, garage: { ...original.garage, settings: { ...original.garage.settings, assumeISave10C: true } } };
  done(assumed); await pending;
  assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, false);
  assert.equal(assumed.garage.adapter.baselineVerified, false);
  assert.equal(assumed.garage.adapter.native.targetC, 16);
  assert.match(f.nodes.get('garage-assume-isave-status').textContent, /assumed.*readings remain unchanged/);
  for (const role of ['replica', 'protected', 'transition']) {
    f.panel.update({ ...assumed, role }); checkbox.checked = false;
    await checkbox.listeners.get('change')(); assert.equal(checkbox.disabled, true);
  }
  f.panel.update({ ...assumed, readOnly: true });
  await checkbox.listeners.get('change')(); assert.equal(checkbox.disabled, true); assert.equal(f.calls.length, 1);
  f.panel.close(); assert.equal(checkbox.listeners.size, 0);
});

test('failed i-save preference save restores the last accepted checkbox value and remains retryable', async () => {
  const f = panelFixture(), checkbox = f.nodes.get('garage-assume-isave');
  const status = { ...f.status, garage: { ...f.status.garage, preferences: { available: true },
    settings: { assumeISave10C: false } } };
  f.panel.update(status); checkbox.checked = true;
  f.reply(() => { throw new Error('Saving preference failed'); });
  await checkbox.listeners.get('change')();
  assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
  assert.match(f.nodes.get('garage-assume-isave-status').textContent, /Saving preference failed/);
  assert(f.nodes.get('garage-assume-isave-status').classes.has('form-error'));
  f.panel.update({ ...status, garage: { ...status.garage, nativeControls: { available: false, settings: {} } } });
  assert.equal(f.nodes.get('garage-native-control-details').hidden, false, 'Owner assumption remains configurable without native writable fields');
  assert.equal(f.nodes.get('garage-native-form').hidden, true);
});
