import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingRows, inventoryItemSummary, inventoryDateSpan, recordingOverviewRefresh } from '../chart/recording.js';

function fixture(request) {
  let now=Date.parse('2026-09-08T10:00:00Z'),visible=true;
  const classes=new Set(),attributes=new Map(),renders=[];
  const root={setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  const details={open:false},parent={open:false},button={disabled:false};
  const message={textContent:'',classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)}};
  const refresh=recordingOverviewRefresh({request,root,details,parent,message,button,clock:()=>now,
    isVisible:()=>visible,render:overview=>renders.push(overview)});
  return {refresh,details,parent,button,message,attributes,classes,renders,
    advance:ms=>{now+=ms;},visibility:value=>{visible=value;}};
}

test('overview requests only while both folds are open and visible, with one in-flight request and a cache lifetime',async()=>{
  let calls=0,resolve;
  const view=fixture(()=>{calls++;return new Promise(done=>{resolve=done;});});
  await view.refresh({force:true});assert.equal(calls,0);
  view.parent.open=true;await view.refresh();assert.equal(calls,0);
  view.details.open=true;view.visibility(false);await view.refresh();assert.equal(calls,0);
  view.visibility(true);
  const pending=view.refresh();assert.equal(calls,1);assert(view.button.disabled);assert.equal(view.attributes.get('aria-busy'),'true');
  await view.refresh({force:true});assert.equal(calls,1,'concurrent refresh does not duplicate the database scan');
  const generatedAt=Date.parse('2026-09-07T10:00:00Z');
  resolve({generatedAt,groups:[],refreshAfterMs:300000,cache:{hit:true}});await pending;
  assert(!view.button.disabled);assert(!view.attributes.has('aria-busy'));
  assert.match(view.message.textContent,/7 Sept 2026/,'cached snapshot retains the actual generation date');
  assert.match(view.message.textContent,/cached/);
  await view.refresh();assert.equal(calls,1);
  view.advance(300000);view.parent.open=false;await view.refresh();assert.equal(calls,1);
  view.parent.open=true;const expired=view.refresh();assert.equal(calls,2);
  resolve({generatedAt,groups:[]});await expired;
});

test('failed overview refresh preserves the previous inventory and a retry recovers',async()=>{
  let fail=true,calls=0;
  const overview={generatedAt:Date.parse('2026-09-07T10:00:00Z'),groups:[{id:'settings',items:[]}]};
  const view=fixture(async()=>{calls++;if(fail)throw new Error('private backend failure');return overview;});
  view.parent.open=true;view.details.open=true;
  await view.refresh();assert.match(view.message.textContent,/could not be loaded/);assert.equal(view.renders.length,0);
  assert(!view.message.textContent.includes('private'));
  fail=false;await view.refresh({force:true});assert.equal(view.renders.length,1);assert(!view.classes.has('form-error'));
  fail=true;await view.refresh({force:true});assert.match(view.message.textContent,/last successful overview is still shown/);
  assert.equal(view.renders.length,1,'a failed response never replaces the inventory');assert(!view.button.disabled);
  fail=false;await view.refresh({force:true});assert.equal(view.renders.length,2);assert.equal(calls,4);
});

test('inventory distinguishes stored calculations, overwritten state and missing history, while excluding reconstructed heat power from adaptive records',()=>{
  assert.equal(inventoryItemSummary({count:3,countLabel:'records',retention:'derived',status:'present'}),'3 records · Stored calculations');
  assert.equal(inventoryItemSummary({count:1,countLabel:'current entries',retention:'current',status:'present'}),'1 current entry · Current state · overwritten');
  assert.equal(inventoryItemSummary({count:0,retention:'history',status:'empty'}),'No records yet · Retained history');
  assert.equal(inventoryDateSpan({status:'empty'}),'No recorded dates yet');
  assert.equal(inventoryDateSpan({status:'present'}),'Dates not recorded');
  assert.equal(inventoryDateSpan({status:'present',datePrecision:'date',dateBasis:'Observed dates',
    firstAt:Date.parse('2026-01-10T00:00:00Z'),lastAt:Date.parse('2026-07-10T00:00:00Z')}),
  'Observed dates: 10 Jan 2026 – 10 Jul 2026 · time not recorded','date-only counters never invent a time or apply a daylight-saving offset');
  const rows=recordingRows({parameters:[{signal:'heat_pump_power',threshold:0.1},{signal:'heat_pump_meter_power',threshold:0.1}]});
  assert(!rows.some(row=>row.signal==='heat_pump_power'));
  assert(rows.some(row=>row.signal==='heat_pump_meter_power'),'a separately metered heat pump remains an independent measurement');
});
