import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { VoltageEstimator } from '../src/storage/voltage.js';
import { recordedTransport, recordingSourceLabel } from '../src/domain/recording-source.js';
import { pendingEnergyObservations } from '../src/storage/pending-energy.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { recordingStatus, energyAuditRow } from '../chart/recording.js';
import { recordChargingSessionCheck, chargingSessionCheckSummaries } from '../src/app/charging-session-checks.js';

test('recorded source labels require explicit transport evidence', () => {
  assert.equal(recordingSourceLabel({source:'easee',raw:{transport:'cloud'}}),'Easee · Cloud');
  assert.equal(recordingSourceLabel({source:'easee',quality:['local_ocpp']}),'Easee · OCPP');
  assert.equal(recordingSourceLabel({source:'easee',quality:'["easee_cloud"]'}),'Easee · Cloud');
  assert.equal(recordingSourceLabel({source:'easee'}),'Easee · transport unknown');
  assert.equal(recordedTransport({quality:['local_ocpp','easee_cloud']}),null);
  assert.equal(recordedTransport({raw:'invalid'}),null);
});

test('voltage source subtitles describe saved contributors, including mixed and unknown provenance', () => {
  const label = voltage => recordingSourceLabel({source:'voltage-estimate',voltage});
  assert.equal(label({inputs:1,input:1}),'Easee · OCPP');
  assert.equal(label({inputs:2,input:2}),'Easee · Cloud');
  assert.equal(label({inputs:4,input:4}),'Equalizer · Easee Cloud');
  assert.equal(label({inputs:8,input:8}),'Simulation');
  assert.equal(label({inputs:3,input:2}),'Mixed sources: Easee · OCPP; Easee · Cloud');
  assert.equal(label({inputs:3,input:1}),label({inputs:3,input:2}),
    'the latest input never hides earlier contributors to a smoothed estimate');
  for(const voltage of [undefined,{}, {inputs:0,input:0},{inputs:1,input:2}]) assert.equal(label(voltage),'Source unknown');
  assert.equal(recordingSourceLabel({source:'voltage-estimate',transport:'ocpp'}),'Source unknown',
    'transport without saved voltage contributors cannot relabel the estimate');
});

test('voltage recorder shows live collection progress and held estimates without false quality failures', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const start = Date.UTC(2026,0,1); let now = start;
  const recorder = new Recorder(store,{clock:()=>now});
  const estimator = new VoltageEstimator(store,{recorder,input:'providers',clock:()=>now});
  const ingest = () => estimator.ingest({source:'easee',device:'invented-charger',signal:'ev1_voltage_l1',
    value:232,unit:'V',sourceTime:now,receivedAt:now,quality:['local_ocpp'],
    raw:{transport:'ocpp',voltageMapping:'phase-neutral'}});
  const row = () => recorder.status(now).parameters.find(row=>row.signal==='voltage_estimate_l1');
  ingest(); now += 17000;
  assert.equal(recordingSourceLabel(row()),'Easee · OCPP');
  let display = recordingStatus(row(),{now});
  assert.equal(display.label,'Collecting voltage history');
  assert.match(display.detail,/0 of 60 minutes/);
  assert.doesNotMatch(display.detail,/failed.*quality|No age cutoff/);
  for(let minute=1;minute<=60;minute++) {
    now=start+minute*60000; ingest();
    if(minute===30) assert.match(recordingStatus(row(),{now}).detail,/30 of 60 minutes/);
  }
  display=recordingStatus(row(),{now});
  assert.equal(display.label,'Established estimate');
  assert.match(display.detail,/Charger 1 · OCPP/);
  assert.doesNotMatch(JSON.stringify(row()),/invented-charger/,'status excludes private device identifiers');
  now+=6*60000;
  assert.equal(recordingStatus(row(),{now}).label,'Estimate held · input unavailable');
  assert.equal(recordingSourceLabel(row()),'Easee · OCPP','unavailable inputs preserve established source provenance');
  assert.equal(store.observations().length,2,'progress reads and steady acquisitions add no historical rows');
});

test('energy transport survives adaptive pending tails and a source change closes the prior interval', t => {
  const store=new Store(':memory:');t.after(()=>store.close());
  const recorder=new Recorder(store), start=Date.UTC(2026,0,1);
  const put=(minute,transport)=>recorder.recordEnergy({source:'easee',device:'invented-charger',prefix:'ev1',
    start:start+minute*60000,end:start+(minute+1)*60000,receivedAt:start+(minute+1)*60000,
    energies:[.01,.01,.01],powers:[.6,.6,.6],quality:['estimated'],transport});
  put(0,'cloud');put(1,'cloud');
  assert(pendingEnergyObservations(store,{now:start+2*60000,input:'providers'})
    .every(row=>JSON.parse(row.raw).transport==='cloud'));
  put(2,'ocpp');
  assert(pendingEnergyObservations(store,{now:start+3*60000,input:'providers'})
    .every(row=>JSON.parse(row.raw).transport==='ocpp'));
  const groups=[...recordedEnergyGroups(store,{from:start,to:start+3*60000,now:start+3*60000,input:'providers',prefix:'ev1'})];
  assert.deepEqual(groups.map(row=>row.transport),['cloud','cloud','ocpp']);
  assert.equal(groups.reduce((sum,row)=>sum+row.values.reduce((a,b)=>a+b,0),0),.09);
  recorder.flush(start+3*60000,{force:true});
  assert(recorder.status(start+3*60000).parameters.every(row=>row.transport==='ocpp'));
  const saved=store.observations();
  assert(saved.filter(row=>row.sourceTime<=start+2*60000).every(row=>row.raw.transport==='cloud'));
});

test('session reference transport remains distinct from integrated-energy provenance', t => {
  const store=new Store(':memory:');t.after(()=>store.close());
  for(const [index,transport] of ['cloud','ocpp',undefined].entries()) recordChargingSessionCheck(store,{
    source:'easee',sessionKey:`invented-${index}`,start:index*1000,end:(index+1)*1000,
    estimatedKwh:1,referenceKwh:1,complete:true,quality:[],...(transport?{transport}:{})});
  const summary=chargingSessionCheckSummaries(store)[0];
  assert.deepEqual(summary.summary.referenceTransports,['cloud','ocpp','unknown']);
  const details=energyAuditRow(summary).details.join(' ');
  assert.match(details,/Easee · Cloud; Easee · OCPP; Easee · transport unknown/);
  assert.match(details,/Recorded energy can include different input transports/);
});
