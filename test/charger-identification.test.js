import { withReportDatabase } from './helpers/report-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
const NOW=1800000000000;
function fixture(t) {
  let now=NOW;const saved=new Map(),physical={charger1:{connected:true,charging:false,at:NOW,power:0,session:NOW},charger2:{connected:false,charging:false,at:NOW,power:0,session:null}};
  const store={getState:key=>structuredClone(saved.get(key)),setState:(key,value)=>saved.set(key,structuredClone(value))};
  withReportDatabase(store, t);
  const runtime=new ChargingRuntime({engine:{},store,config:{input:'mqtt',connections:{easee:{charger_id:'synthetic'}}},clock:()=>now});
  // Passive matching is independent of the fresh-installation Automatic choice.
  for(const item of Object.values(runtime.chargers))item.controls.enabled=false;
  runtime.refreshSettings();
  const tesla={association:"synthetic-tesla-source",connected:true,healthy:true,pluggedIn:true,atHome:true,charging:false,batteryLevel:40,chargeLimitSoc:90,requestedCurrentA:6,maxCurrentA:16,actualPowerKw:0,fields:{healthy:{receivedAt:NOW,retained:false},plugged_in:{receivedAt:NOW,retained:false},battery_level:{receivedAt:NOW,retained:false},charge_limit_soc:{receivedAt:NOW,retained:false},charge_current_request:{receivedAt:NOW,retained:false}},boundaries:[]};
  runtime.teslaCapture={snapshot:()=>structuredClone(tesla)};
  for(const id of Object.keys(physical)) {
    runtime.chargers[id].controller={status:()=>({phase:'off',session:{connected:physical[id].connected,connectedAt:physical[id].session,lastDisconnectedAt:physical[id].lastDisconnectedAt},snapshot:{}}),close(){},async update(){}};
    runtime.chargers[id].adapter={normalize(){const p=physical[id],field=value=>({value,available:value!==null,source:id==='charger1'?'easee':'shelly-evse',measuredAt:p.at,receivedAt:p.at});return {providerConnected:true,connected:field(p.connected),charging:field(p.charging),powerKw:field(p.power),voltageV:field(230),maximumCurrentA:field(16),currentA:field(16)};}};
  }
  t.after(()=>runtime.close());
  return {runtime,physical,tesla,saved,setNow:value=>now=value,view:id=>runtime.status().chargers.find(row=>row.id===id),
    // Synthetic native/vehicle snapshots become accepted context in a write,
    // as they do after production acquisition or native reconciliation. Views
    // remain read-only and cannot create a session or consume identity evidence.
    admit:()=>runtime.write(()=>runtime.persist()),
    charge(id,at){now=at;Object.assign(physical[id],{charging:true,power:4.14,at});Object.assign(tesla,{charging:true,actualPowerKw:4.14});tesla.fields.charger_power={receivedAt:at,retained:false};tesla.fields.charge_current_request={receivedAt:at,retained:false};}};
}
test('passive assignment continues hours after plug with automatic OFF on either physical charger',async t=>{
  for(const id of ['charger1','charger2']) {
    const f=fixture(t);for(const [key,p]of Object.entries(f.physical))Object.assign(p,{connected:key===id,session:key===id?NOW:null});
    await f.admit();
    assert.equal(f.view(id).vehicle.id,null);f.charge(id,NOW+2*3600000);
    await f.admit();
    const view=f.view(id);assert.equal(view.vehicle.id,'tesla');assert.equal(view.values.soc.value,40);assert.equal(view.values.vehicleCurrentA.value,6);
    assert.equal(view.settings.enabled,false);assert.equal(view.provider,id==='charger1'?'easee':'shelly-evse');
  }
});
test('equal-power chargers remain unidentified without inferring either vehicle',async t=>{
  const f=fixture(t);Object.assign(f.physical.charger2,{connected:true,session:NOW});f.charge('charger1',NOW+1000);f.charge('charger2',NOW+1000);
  await f.admit();
  for(const id of ['charger1','charger2']) {
    assert.equal(f.view(id).vehicle.id,null);assert.equal(f.view(id).vehicle.state,'unidentified');
    assert.equal(f.runtime.chargers[id].vehicleMatch,null);
    assert.equal(f.runtime.chargers[id].vehicleConflict,null,'Similar power alone is not conflicting positive identity evidence');
    assert.equal(f.view(id).values.soc.source,'manual-fallback');
  }
});
test('physical cable swap changes assignment without borrowing session energy, deadline or ownership',async t=>{
  const f=fixture(t);f.charge('charger1',NOW+1000);await f.admit();const old=f.view('charger1').request;
  Object.assign(f.physical.charger1,{connected:false,session:null,charging:false,power:0,at:NOW+2000});f.setNow(NOW+2000);await f.admit();
  Object.assign(f.physical.charger2,{connected:true,session:NOW+3000});f.tesla.fields.plugged_in.receivedAt=NOW+3000;f.charge('charger2',NOW+4000);
  await f.admit();
  assert.equal(f.view('charger1').vehicle.id,null);assert.equal(f.view('charger2').vehicle.id,'tesla');assert.notEqual(f.view('charger2').request.sessionId,old.sessionId);
  assert.equal(f.view('charger2').progress.deliveredGridKwh,0);
});
test('current-session edits retain the physical session and reject stale multi-tab changes',async t=>{
  const f=fixture(t);await f.admit();const view=f.view('charger1'),request=view.request;
  await f.runtime.setChargerSettings('charger1',{scope:'session',association:view.association,sessionId:request.sessionId,revision:request.revision,changes:{minimumSoc:95,manualSoc:30,capacityKwh:60}});
  const updated=f.view('charger1');assert.equal(updated.request.sessionId,request.sessionId);assert.equal(updated.values.minimumSoc.value,95);assert.equal(updated.values.soc.value,30);
  assert.equal(f.runtime.settings.chargers.charger1.minimumSoc,80);
  await assert.rejects(f.runtime.setChargerSettings('charger1',{scope:'session',association:view.association,sessionId:request.sessionId,revision:request.revision-1,changes:{minimumSoc:70}}),/changed/);
});
test('unscoped assignment and former settings never grant new physical authority',t=>{
  const f=fixture(t);f.runtime.chargers.charger1.vehicleMatch={id:'tesla',connectedAt:NOW,matchedAt:NOW};assert.equal(f.view('charger1').vehicle.id,null);
  assert.throws(()=>new ChargingRuntime({engine:{},store:{getState:()=>({version:4,settings:{}})},config:{input:'mqtt'}}),/Unsupported/);
});
test('BMW delayed native starts remain identifiable on either physical EVSE hours after the plug event',async t=>{
 for(const id of ['charger1','charger2']) {
  const f=fixture(t);f.tesla.healthy=false;f.runtime.setMqttStatus({connected:true,subscribed:true},'bmw');
  for(const [key,p] of Object.entries(f.physical))Object.assign(p,{connected:key===id,session:key===id?NOW:null});
  const send=(at,charging,plug=true)=>{f.setNow(at);return f.runtime.write(()=>f.runtime.receiveSoc('stmq/vehicles/bmw',JSON.stringify({provider:'bmw-cardata',soc:60,readingId:`soc-${at}`,measuredAt:at,atHome:true,pluggedIn:plug,charging,
    fields:{atHome:{readingId:`home-${at}`,measuredAt:at},pluggedIn:{readingId:`plug-${plug}-${at}`,measuredAt:at},charging:{readingId:`charging-${charging}-${at}`,measuredAt:at}}})));};
  await send(NOW,false);f.view(id);
  const started=NOW+2*3600000;Object.assign(f.physical[id],{charging:true,power:7,at:started});await send(started,true);f.view(id);
  const stopped=started+60000;Object.assign(f.physical[id],{charging:false,power:0,at:stopped});await send(stopped,false);
  assert.equal(f.view(id).vehicle.id,'bmw');assert.equal(f.view(id).values.soc.value,60);
  assert.equal(f.view(id).request.sessionId,`${f.view(id).association}:${NOW}`);
 }
});
test('Tesla charging edges identify after normal ramp delay and unchanged power on either EVSE',async t=>{
  for(const id of ['charger1','charger2']) {
    const f=fixture(t);
    for(const [key,p]of Object.entries(f.physical))Object.assign(p,{connected:key===id,session:key===id?NOW:null});
    f.tesla.fields.plugged_in.retained=true;
    const start=NOW+60000;
    f.setNow(start);Object.assign(f.physical[id],{charging:true,power:1,at:start});
    await f.admit();
    Object.assign(f.tesla,{charging:true,actualPowerKw:4.14});
    f.tesla.fields.charging_state={value:'Charging',receivedAt:start+11000,retained:false};
    f.tesla.fields.charger_power={value:4.14,receivedAt:start+34000,retained:false};
    const observed=start+7*60000;
    f.setNow(observed);Object.assign(f.physical[id],{power:4.14,at:observed});
    await f.admit();
    const view=f.view(id);
    assert.equal(view.vehicle.id,'tesla');
    assert.equal(view.values.soc.value,40);
  }
});
test('delayed Tesla matching rejects retained starts, stale EVSE power, unhealthy feeds and earlier connections',async t=>{
  for(const reason of ['retained-start','retained-power','stale-evse','unhealthy','older-connection','unmatched-start']) {
    const f=fixture(t),start=NOW+60000;
    f.tesla.fields.plugged_in.retained=true;
    f.setNow(start);Object.assign(f.physical.charger1,{charging:true,power:1,at:start});await f.admit();
    Object.assign(f.tesla,{charging:true,actualPowerKw:4.14});
    f.tesla.fields.charging_state={value:'Charging',receivedAt:start+11000,retained:reason==='retained-start'};
    f.tesla.fields.charger_power={value:4.14,receivedAt:start+34000,retained:reason==='retained-power'};
    const now=start+7*60000;f.setNow(now);Object.assign(f.physical.charger1,{power:4.14,at:reason==='stale-evse'?start:now});
    if(reason==='unhealthy')f.tesla.healthy=false;
    if(reason==='older-connection')Object.assign(f.physical.charger1,{session:now,lastDisconnectedAt:now-1000});
    if(reason==='unmatched-start')f.tesla.fields.charging_state.receivedAt=start+3*60000;
    await f.admit();
    assert.equal(f.view('charger1').vehicle.id,null,reason);
  }
});
