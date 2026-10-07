import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingRows, recordingStatus, inventoryItemSummary, inventoryDateSpan, recordingOverviewRefresh, energyAuditRow, durationLabel } from '../chart/recording.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';

test('recording status distinguishes periodic report freshness from saved-value age and saving cadence',()=>{
  const now=3*86400_000,reportAt=now-17*60_000-1;
  const row={status:'fresh',hour:{averageIntervalMs:300000},freshness:{status:'stale',reasons:['missing-report'],
    sourceObservedAt:reportAt,savedValueAt:0,maxAgeMs:17*60_000,ageBasis:'periodic-report',reportIntervalMs:15*60_000,reportGraceMs:2*60_000}};
  const display=recordingStatus(row,{now});
  assert.equal(display.label,'Out of date');
  assert.match(display.detail,/Latest source report is 17 min 1 s old. Limit 17 min \(15 min reporting interval \+ 2 min grace\)/);
  assert.match(display.detail,/expected report is missing/);
  assert.match(display.detail,/unchanged saved value is 3 d old; report age determines current availability/);
  assert.doesNotMatch(display.detail,/Limit 5 min/);
});

test('recording status explains rejection, held temperatures and historical energy without leaking raw flags',()=>{
  const now=3*3600_000;
  const rejected=recordingStatus({status:'stale',freshness:{status:'stale',reasons:['out-of-order-source-time','invented-private-flag'],
    sourceObservedAt:now-60000,maxAgeMs:null,ageBasis:'source-observation'}},{now});
  assert.equal(rejected.label,'Reading rejected');
  assert.match(rejected.detail,/older than a newer report already received/);
  assert.doesNotMatch(rejected.detail,/invented-private-flag/);
  const held=recordingStatus({freshness:{status:'held-attention',sourceObservedAt:0,maxAgeMs:null,
    attentionAfterMs:2*3600_000,ageBasis:'source-observation'}},{now});
  assert.match(held.detail,/3 h old. No age cutoff applies. Attention starts after 2 h/);
  const energy=recordingStatus({freshness:{status:'recorded-interval',sourceObservedAt:0,maxAgeMs:null,ageBasis:'completed-interval'}},{now});
  assert.equal(energy.label,'Recorded interval');
  assert.match(energy.detail,/completed energy interval does not expire/);
});

test('event-only door recordings distinguish last report age from current connection health',()=>{
  const display=recordingStatus({freshness:{status:'last-reported',sourceObservedAt:0,maxAgeMs:null,ageBasis:'event-only'}},{now:7*86400_000});
  assert.equal(display.label,'Last reported state');
  assert.match(display.detail,/without a periodic heartbeat/);
  assert.match(display.detail,/last report is 7 d old/);
  assert.match(display.detail,/Report age alone does not indicate a fault/);
  assert.match(display.detail,/Current connection availability is shown under Equipment/);
  assert.doesNotMatch(display.detail,/Attention starts|Limit/);
});

function fixture(request) {
  let now=Date.parse('2026-09-08T10:00:00Z'),visible=true;
  const classes=new Set(),attributes=new Map(),renders=[],states=[];
  const root={setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key)};
  const details={open:false},parent={open:false},button={disabled:false};
  const message={textContent:'',classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)}};
  const refresh=recordingOverviewRefresh({request,root,details,parent,message,button,clock:()=>now,
    isVisible:()=>visible,render:overview=>renders.push(overview),onState:state=>states.push(state)});
  return {refresh,details,parent,button,message,attributes,classes,renders,states,
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

test('adaptive inventory contains only observed adaptive streams, including custom measurements and every charger phase', () => {
  assert.deepEqual(recordingRows({}), [], 'the catalogue does not manufacture waiting measurements');
  const parameters = [
    { signal: 'caravan_temperature', unit: 'degC', policy: 'adaptive-value' },
    { signal: 'garage_compressor_frequency', unit: 'Hz', policy: 'adaptive-value' },
    { signal: 'workshop_pressure', unit: 'bar', policy: 'adaptive-value' },
    { signal: 'room_setting', unit: 'degC', policy: 'change-only' },
    { signal: 'floor_groundfloor_1_active', unit: 'state', policy: 'change-only' },
    { signal: 'dhwr_active', unit: 'state', policy: 'change-only' },
    ...['property', 'ev1', 'ev2'].flatMap(prefix => [1, 2, 3].map(phase => ({
      signal: `${prefix}_energy_l${phase}`, unit: 'kWh', grouped: true, policy: 'adaptive-energy',
    }))),
    { signal: 'caravan_energy', unit: 'kWh', policy: 'adaptive-energy' },
  ];
  const rows = recordingRows({ parameters });
  assert.deepEqual(rows.map(row => row.signal).sort(), parameters.filter(row => row.policy.startsWith('adaptive-')).map(row => row.signal).sort());
  assert.equal(rows.filter(row => row.signal.startsWith('ev2_energy_l')).length, 3);
  assert.equal(rows.find(row => row.signal === 'workshop_pressure').label, 'workshop pressure');
  assert(!rows.some(row => row.signal === 'indoor_temperature'), 'never-observed indoor readings do not appear');
});

const propertyCheck = summary => ({kind:'property-meter-summary',signal:'property_import_energy_counter',
  summary:{status:'compared',readingCount:2,latestReading:{valueKwh:12345.678,sourceTime:60_000,receivedAt:61_000},
    previousReading:{valueKwh:12344.678,sourceTime:0,receivedAt:1000},coverage:{start:0,end:60_000,coveredMs:60_000,durationMs:60_000},
    comparison:null,lastSuccessfulComparison:null,...summary}});
const meterComparison = {estimatedKwh:1,meteredKwh:1,differenceKwh:0,differencePercent:0,start:0,end:60_000,
  edgeEstimated:true,includesOpenInterval:true};


test('retired Shelly session checks are rejected instead of presented as Charger 1', () => {
  assert.throws(() => energyAuditRow({ kind: 'charging-session-summary', source: 'shelly-evse',
    summary: { recordedSessions: 0, comparedSessions: 0, excludedSessions: 0 } }), /Unknown charging session check/);
});

test('property comparison explains boundaries, ongoing energy and source versus receipt times', () => {
  const ongoing=energyAuditRow(propertyCheck({comparison:meterComparison}));
  assert.match(ongoing.details.join(' '),/boundaries is prorated.*ongoing recorded interval/);
  assert.match(ongoing.context.join(' '),/Latest meter reading: 12,345.678 kWh/,'cumulative reading is not rounded to three significant digits');
  assert.match(ongoing.details.join(' '),/Latest reading received:.*Meter times describe the source reading/);
  assert.equal(ongoing.value,'Recorded energy matches the meter within 0.1%');
  const closed=energyAuditRow(propertyCheck({comparison:{...meterComparison,includesOpenInterval:false}}));
  assert(!closed.details.join(' ').includes('ongoing'));
});


test('property failures distinguish missing readings, reset, ordering and incomplete or conflicting coverage',()=>{
  const cases={
    'no-readings':'No property meter readings recorded',
    'waiting-for-second-reading':'Waiting for a second meter reading',
    'counter-reset':'Meter counter decreased; waiting for a new comparison period',
    'out-of-order-counter':'Meter readings arrived out of order',
    'incomplete-coverage':'Recording does not cover the whole meter period',
    'conflicting-coverage':'Recorded energy has conflicting intervals',
  };
  for(const [status,message] of Object.entries(cases)) assert.equal(energyAuditRow(propertyCheck({status})).value,message);
  const empty=energyAuditRow(propertyCheck({status:'no-readings',readingCount:0,latestReading:null,previousReading:null,coverage:null}));
  assert.deepEqual(empty.context,[]);
  assert.match(empty.details.join(' '),/Easee Equalizer.*Equipment/);
});

test('a previous property result is dated separately from the latest incomplete reading',()=>{
  const display=energyAuditRow(propertyCheck({status:'incomplete-coverage',lastSuccessfulComparison:meterComparison,
    coverage:{start:60_000,end:180_000,coveredMs:60_000,durationMs:120_000}}));
  assert.equal(display.value,'Recorded energy matches the meter within 0.1%');
  assert.match(display.context.join(' '),/Last successful comparison:/);
  assert.equal(display.notice,'Latest reading: Recording does not cover the whole meter period.');
  assert.match(display.details.join(' '),/Recording covers 1 min of 2 min/);
});

test('zero meter increments do not become zero-percent agreement',()=>{
  const display=energyAuditRow(propertyCheck({comparison:{...meterComparison,meteredKwh:0,differencePercent:null}}));
  assert.equal(display.value,'Meter recorded no consumption in this period');
  assert.match(display.context[0],/1 kWh recorded · 0.000 kWh metered/);
  assert.match(display.details.join(' '),/percentage cannot be calculated/);
  assert(!display.value.includes('0%'));
});

test('small coverage gaps remain explicit instead of rounding up to complete coverage',()=>{
  for(const gap of [500,3000]) {
    const display=energyAuditRow(propertyCheck({status:'incomplete-coverage',
      coverage:{start:0,end:3600000,coveredMs:3600000-gap,durationMs:3600000}}));
    assert.equal(display.value,'Recording does not cover the whole meter period');
    assert(display.details.includes(`Uncovered or unusable time: ${gap===500?'<1 s':'3 s'}.`));
  }
});

test('two devices reporting the same measurement remain distinct without exposing private device identifiers', t => {
  const store=new Store(':memory:');t.after(()=>store.close());
  const now=1_000_000,recorder=new Recorder(store,{clock:()=>now});
  for(const [device,value] of [['private-probe-a',9],['private-probe-b',10]]) recorder.record({source:'mqtt-equipment',
    device,signal:'workshop_temperature',unit:'degC',value,sourceTime:now,receivedAt:now,quality:[]});
  const status=recorder.status(now),rows=recordingRows(status);
  assert.equal(rows.length,2);
  assert.equal(new Set(rows.map(row=>row.streamId)).size,2);
  assert.deepEqual(rows.map(row=>row.streamQualifier),['Source 1','Source 2']);
  assert(!JSON.stringify(status).includes('private-probe'));
  const restarted=recordingRows(new Recorder(store,{clock:()=>now}).status(now));
  assert.deepEqual(restarted.map(row=>row.streamId),rows.map(row=>row.streamId));
  assert.equal(durationLabel(0),'0 s','equal receipt timestamps are not presented as missing statistics');
});

test('installation measurements collapse source history without combining current spacing, thresholds or open energy', t => {
  const store=new Store(':memory:');t.after(()=>store.close());
  const recorder=new Recorder(store),hour=3600000,now=5*hour;
  const record=(device,start)=>{
    for(let i=0;i<3;i++) recorder.recordEnergy({source:'shelly-evse',device,prefix:'ev2',
      start:start+i*60000,end:start+(i+1)*60000,receivedAt:start+(i+1)*60000,
      powers:[1,2,3],energies:[1/60,2/60,3/60]});
  };
  record('old-private-route',hour);record('current-private-route',4*hour);
  const status=recorder.status(now),rows=recordingRows(status);
  assert.equal(status.parameters.length,6);assert.equal(rows.length,3);
  const phase=rows.find(row=>row.signal==='ev2_energy_l3');
  assert.equal(phase.sourceHistory.length,2);assert.equal(phase.activity,'current');
  const current=status.parameters.find(row=>row.signal===phase.signal&&row.lastPollAt===4*hour+180000);
  assert.equal(phase.currentStreamId,current.streamId);
  assert.deepEqual(phase.hour,current.hour);assert.deepEqual(phase.openInterval,current.openInterval);
  assert.equal(phase.threshold,current.threshold);assert.equal(phase.savedDay.records,2);
  assert.deepEqual(phase.sourceHistory.map(row=>row.activity),['current','historical']);
  assert.equal(phase.sourceHistory[1].recordedPeriod.firstSavedAt,hour+60000);
  assert(!JSON.stringify(rows).includes('private-route'));
  const persisted=recordingRows(new Recorder(store).status(now)).find(row=>row.signal===phase.signal);
  assert.equal(persisted.activity,'historical');assert.equal(persisted.openInterval,null);
  assert.equal(persisted.threshold,null);assert.equal(persisted.day,null);
  assert.equal(recordingStatus(persisted).label,'Historical');
  const snapshot=recordingRows({...new Recorder(store).status(now),readOnly:true}).find(row=>row.signal===phase.signal);
  assert.equal(snapshot.activity,'snapshot');assert.equal(snapshot.currentStreamId,current.streamId);
  assert.deepEqual(snapshot.openInterval,current.openInterval);
  assert.equal(recordingStatus(snapshot).label,'Latest recorded source');
});

test('recording presentation keeps different units, policies and ambiguous current identities distinct',()=>{
  const parameters=[
    {signal:'supply_temperature',source:'husdata-h66',unit:'degC',policy:'adaptive-value',streamId:'first',observedThisRun:true,lastPollAt:100},
    {signal:'supply_temperature',source:'husdata-h66',unit:'degC',policy:'adaptive-value',streamId:'second',observedThisRun:true,lastPollAt:100},
    {signal:'supply_temperature',source:'husdata-h66',unit:'F',policy:'adaptive-value',streamId:'fahrenheit',observedThisRun:true,lastPollAt:100},
    {signal:'supply_temperature',source:'simulation',unit:'degC',policy:'adaptive-value',streamId:'simulation',observedThisRun:true,lastPollAt:100},
  ];
  const rows=recordingRows({parameters});assert.equal(rows.length,3);
  const conflict=rows.find(row=>row.sourceHistory.length===2);
  assert.equal(conflict.activity,'ambiguous');assert.equal(conflict.threshold,null);assert.equal(conflict.currentStreamId,null);
  assert.equal(recordingStatus(conflict).label,'Source selection uncertain');
  assert.equal(recordingRows({parameters:parameters.slice(0,1)})[0].rowId,conflict.rowId,'disclosure identity is stable across source changes');
});


test('opening the recording summary measures retained size through the same bounded inventory request',async()=>{
  let calls=0,resolve;
  const view=fixture(()=>{calls++;return new Promise(done=>{resolve=done;});});
  await view.refresh({summary:true});assert.equal(calls,0,'closed outer summary never requests inventory');
  view.parent.open=true;view.visibility(false);
  await view.refresh({summary:true});assert.equal(calls,0,'hidden page never scans for a summary');
  view.visibility(true);
  const pending=view.refresh({summary:true});
  assert.equal(calls,1);assert.equal(view.details.open,false,'summary does not open the full inventory');
  assert.deepEqual(view.states,['loading']);
  await view.refresh({summary:true,force:true});assert.equal(calls,1,'summary and full inventory share the in-flight gate');
  const overview={generatedAt:0,groups:[],database:{adaptiveEstimatedBytes:1234},refreshAfterMs:300000};
  resolve(overview);await pending;
  assert.deepEqual(view.renders,[overview]);assert.deepEqual(view.states,['loading','ready']);
  await view.refresh({summary:true});assert.equal(calls,1,'reopening uses the five-minute cache');
  view.details.open=true;await view.refresh();assert.equal(calls,1,'opening the other-data fold reuses the same measured inventory');
  view.details.open=false;view.advance(300001);
  await view.refresh();assert.equal(calls,1,'routine refresh does not scan for a closed inventory');
  const next=view.refresh({summary:true});assert.equal(calls,2,'an explicit later summary opening refreshes expired evidence');
  resolve(overview);await next;
});
