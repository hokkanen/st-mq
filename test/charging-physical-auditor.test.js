import assert from 'node:assert/strict';import fs from 'node:fs';import {randomUUID}from'node:crypto';
import test from 'node:test';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {audit as auditEvidence} from '../scripts/charging-physical/audit.js';

test('physical limiter auditor verifies effects and rejects incomplete source evidence', async t => {
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'charging-auditor-')),name='audit-fixture-'+randomUUID(),now=Date.parse('2030-01-02T12:00:00Z'),files=[];
const audit=config=>auditEvidence(config,{directory:dir});
const clone=structuredClone,triple=v=>[v,v,v];
function fixtures(){const status=[],native=[];for(let i=0;i<6;i++){const at=now+i*5000,current=16,power=11.04,phase={total_power:power,
 phase_a:{current,voltage:230},phase_b:{current,voltage:230},phase_c:{current,voltage:230}};
 const c1={id:'charger1',association:'synthetic-first',request:{sessionId:'synthetic-first-session',chargeNow:true},control:{manual:null,phase:'active',session:{connected:true,connectedAt:now-1000},snapshot:{online:true,appControl:{enabled:true,stopped:false},powerKw:(16-i*2)*.69,powerAt:at,supply:{chargerCurrentA:triple(16-i*2),observationTimes:{charger:triple(at)}}}}};
 const c2={id:'charger2',association:'synthetic-second',request:{sessionId:'synthetic-second-session'},limiter:{mode:'unrestricted',applicationStatus:'confirmed',appliedCurrentA:16},control:{manual:null,ownedPause:false,session:{connected:true,connectedAt:now-1000},limiter:{currentA:16,fallback:false,modelAvailable:true,evaluatedAt:at},snapshot:{online:true,fields:{phase_info:{value:phase,measuredAt:at,receivedAt:at,retained:false},current_limit:{value:16,receivedAt:at,measuredAt:at},start_charging:{value:true,receivedAt:at,measuredAt:at}}}}};
 const s=c1.control.snapshot.supply;
 s.feedEvidence=Object.fromEntries(['property','charger'].map(k=>[k,{source:k==='charger'?'easee-ocpp':'easee-stream',connected:true,online:true,synchronized:true,epoch:'synthetic-epoch',activityAt:at,receivedAt:at}]));
 status.push({receivedAt:at,now:at,pair:{role:'master',canControl:true,vip:{owned:true},peerRole:'slave'},charging:{settings:{priority:i<3?'charger1':'charger2'},chargers:[c1,c2]}});
 for(const role of ['phase_info','current_limit']){const id=i+'-'+role;native.push({receivedAt:at,retained:false,payload:JSON.stringify({id,src:'stmq-evse-synthetic',method:(role==='phase_info'?'Object':'Number')+'.GetStatus',params:{role}})});native.push({receivedAt:at,retained:false,payload:JSON.stringify({id,result:{value:role==='phase_info'?phase:16,last_update_ts:at/1000}})});}
 }return {status,native,vehicle:[]};}
function write(f){for(const key of ['status','native','vehicle']){const file=dir+'/'+name+'-'+key+'.jsonl';if(!files.includes(file))files.push(file);fs.writeFileSync(file,f[key].map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});}}
const config={version:1,observer:name,requiredKinds:['shelly-priority'],cases:[{id:'synthetic-priority',kind:'shelly-priority',expectedCurrentA:16,startAt:now,endAt:now+25000,settleMs:15000}]};
let checks=0;
try{let f=fixtures();write(f);let result=await audit(config);assert.equal(result.allRequiredPassed,true);checks++;
 f=fixtures();for(const row of f.status)row.charging.chargers[1].control.snapshot.fields.phase_info.measuredAt=now-1000;write(f);assert.equal((await audit(config)).allRequiredPassed,false);checks++;
 f=fixtures();for(const row of f.native)row.retained=true;write(f);assert.equal((await audit(config)).allRequiredPassed,false);checks++;
 f=fixtures();for(const row of f.status){row.charging.chargers[0].control.snapshot.supply.chargerCurrentA=triple(16);}write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='native-equalizer-reduces-easee').passed,false);checks++;
 f=fixtures();f.native=f.native.filter(r=>!r.payload.includes('current_limit'));write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='native-current-setting-readback').passed,false);checks++;
 f=fixtures();write(f);const missing=clone(config);delete missing.requiredKinds;result=await audit(missing);assert.equal(result.allRequiredPassed,false);assert(result.unprovenKinds.includes('native-stop'));checks++;
 const pending=clone(config);pending.cases[0].endAt=null;result=await audit(pending);assert.equal(result.allRequiredPassed,false);assert.equal(result.cases[0].status,'not-exercised');checks++;
 const vehicle=clone(config);vehicle.cases[0].requireVehicleCharging=true;result=await audit(vehicle);assert.equal(result.allRequiredPassed,false);checks++;

 function easeeYieldsToZero(){const f=fixtures();for(let i=0;i<f.status.length;i++){
  const s=f.status[i].charging.chargers[0].control.snapshot,amps=i<3?16:0;
  s.supply.chargerCurrentA=triple(amps);s.powerKw=amps*.69;}return f;}
 f=easeeYieldsToZero();write(f);result=await audit(config);assert.equal(result.allRequiredPassed,true);
 assert.deepEqual(result.cases[0].physical.easeeMaxCurrentRangeA,[0,0]);checks++;
 for(const change of [c=>{c.control.limiter.modelAvailable=false;c.limiter.mode='unknown';},
  c=>{c.control.limiter.modelAvailable=false;},c=>{c.limiter.mode='unknown';}]){
  f=easeeYieldsToZero();for(const row of f.status.slice(3))change(row.charging.chargers[1]);write(f);result=await audit(config);
  assert.equal(result.cases[0].checks.find(c=>c.name==='verified-load-model-observed').passed,false,'Physical16A and Easee yield do not make an unknown model verified');
  assert.equal(result.allRequiredPassed,false);checks++;
 }
 f=easeeYieldsToZero();for(let i=0;i<3;i++){const s=f.status[i].charging.chargers[0].control.snapshot;
  s.supply.chargerCurrentA=triple(0);s.powerKw=0;}write(f);result=await audit(config);
 assert.equal(result.cases[0].checks.find(c=>c.name==='easee-actual-draw-before-priority-switch').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(3))row.charging.chargers[0].control.manual={kind:'stop'};
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='easee-remains-online-and-open').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(0,3))row.charging.chargers[0].control.snapshot.supply.observationTimes.charger=triple(now-1);
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='easee-actual-draw-before-priority-switch').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(3))row.charging.chargers[0].request.sessionId='synthetic-replaced-session';
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='unchanged-physical-connections').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(3))row.charging.chargers[0].control.snapshot.powerKw=11;
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='native-equalizer-reduces-easee').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status)row.charging.settings.priority='charger2';
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='requested-priority-transition-observed').passed,false);checks++;
 f=easeeYieldsToZero();write(f);const noPrelude=clone(config);noPrelude.cases[0].startAt=now+15000;noPrelude.cases[0].settleMs=0;
 result=await audit(noPrelude);assert.equal(result.cases[0].checks.find(c=>c.name==='easee-actual-draw-before-priority-switch').passed,false);checks++;
 f=easeeYieldsToZero();const recovering=f.status.at(-1).charging.chargers[0].control.snapshot;
 recovering.supply.chargerCurrentA=triple(16);recovering.powerKw=11.04;write(f);result=await audit(config);
 assert.equal(result.cases[0].checks.find(c=>c.name==='native-equalizer-reduces-easee').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(3))row.charging.chargers[0].control.snapshot.supply.observationTimes.charger[2]=now+60000;
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='native-equalizer-reduces-easee').passed,false);checks++;
 f=easeeYieldsToZero();for(const row of f.status.slice(3))row.charging.chargers[0].control.snapshot.powerAt=now+60000;
 write(f);result=await audit(config);assert.equal(result.cases[0].checks.find(c=>c.name==='native-equalizer-reduces-easee').passed,false);checks++;

 function setPhysical(f, amps, mode='limited', fallback=false){
  for(const row of f.status){const c=row.charging.chargers[1],p=c.control.snapshot.fields.phase_info.value;
   for(const key of ['phase_a','phase_b','phase_c'])p[key].current=amps;p.total_power=amps*.69;
   c.control.limiter.currentA=amps;c.control.limiter.fallback=fallback;c.control.limiter.modelAvailable=!fallback;c.limiter.appliedCurrentA=amps;c.limiter.mode=mode;
   if(amps===0){c.control.ownedPause=true;c.control.snapshot.fields.start_charging.value=false;}}
  for(const row of f.native){const p=JSON.parse(row.payload);if(p.result&&p.result.value&&typeof p.result.value==='object'){
   for(const key of ['phase_a','phase_b','phase_c'])p.result.value[key].current=amps;p.result.value.total_power=amps*.69;
  }else if(p.result&&typeof p.result.value==='number')p.result.value=amps;row.payload=JSON.stringify(p);}}
 function setKind(kind){const c=clone(config);c.requiredKinds=[kind];c.cases[0].kind=kind;delete c.cases[0].expectedCurrentA;
   if(['balanced','easee-priority','fallback'].includes(kind))c.cases[0].expectedCurrentA={balanced:10,'easee-priority':0,fallback:12}[kind];
   if(kind==='shelly-priority')c.cases[0].expectedCurrentA=16;return c;}
 f=fixtures();setPhysical(f,10);for(const row of f.status)row.charging.settings.priority='balanced';write(f);
 assert.equal((await audit(setKind('balanced'))).allRequiredPassed,true);checks++;
 f=fixtures();setPhysical(f,0,'paused-by-balancing');for(const row of f.status)row.charging.settings.priority='charger1';write(f);
 assert.equal((await audit(setKind('easee-priority'))).allRequiredPassed,true);checks++;
 f=fixtures();setPhysical(f,0,'limited');for(let i=0;i<f.status.length;i++){const row=f.status[i],c=row.charging.chargers[1];
  row.charging.settings.priority=i<3?'charger2':'balanced';c.control.ownedPause=false;c.control.manual={kind:'stop'};c.control.limiter.fallback=i<3;}
 const stopAt=now,stopId='synthetic-stop';f.native.unshift({receivedAt:stopAt,retained:false,payload:JSON.stringify({id:stopId,src:'external-test-synthetic',method:'Boolean.Set',params:{role:'start_charging',value:false}})},
  {receivedAt:stopAt,retained:false,payload:JSON.stringify({id:stopId,result:null})});write(f);
 const stopConfig=setKind('native-stop'),nativeStopped=clone(f);assert.equal((await audit(stopConfig)).allRequiredPassed,true);checks++;
 const unknownStop=clone(nativeStopped);for(const row of unknownStop.status.slice(3)){
  const c=row.charging.chargers[1];c.control.limiter.modelAvailable=false;c.limiter.mode='unknown';}
 write(unknownStop);result=await audit(stopConfig);
 assert.equal(result.cases[0].checks.find(c=>c.name==='feed-recovery-exercised').passed,false,'Unknown state is not verified load-feed recovery during an external Stop');checks++;
 write(f);
 f.native.push({receivedAt:now+20000,retained:false,payload:JSON.stringify({id:'synthetic-forbidden-start',src:'stmq-evse-synthetic',method:'Boolean.Set',params:{role:'start_charging',value:true}})});write(f);
 assert.equal((await audit(stopConfig)).allRequiredPassed,false);checks++;
 f=fixtures();setPhysical(f,12,'fallback',true);write(f);const fallbackConfig=setKind('fallback'),causeFile=name+'-feed.jsonl';
 function writeFeeds(rows){fs.writeFileSync(dir+'/'+causeFile,rows.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});}
 files.push(dir+'/'+causeFile);writeFeeds([{at:now+15000,evidence:{property:{source:'easee-stream',connected:false,online:null,synchronized:false}}}]);
 fallbackConfig.cases[0].fallbackCauseEvidence=causeFile;assert.equal((await audit(fallbackConfig)).allRequiredPassed,true);checks++;
 const fallbackCorrect=clone(f);for(const row of f.status)row.charging.chargers[1].limiter.mode='unknown';write(f);
 result=await audit(fallbackConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='fallback-classification-correct').passed,false);checks++;
 f=fallbackCorrect;write(f);
 for(const field of ['connected','online','synchronized']){
  const e={source:'easee-ocpp',connected:true,online:true,synchronized:true,[field]:false};
  writeFeeds([{at:now+15000,evidence:{charger:e}}]);
  assert.equal((await audit(fallbackConfig)).allRequiredPassed,true,'A captured native OCPP outage is independent bad-feed evidence');checks++;
 }
 const fallbackKnown=clone(f),fallbackUnknownPeer=clone(f);
 for(const row of fallbackUnknownPeer.status){const c=row.charging.chargers[0];c.control.session=null;c.control.snapshot.online=false;}
 write(fallbackUnknownPeer);assert.equal((await audit(fallbackConfig)).allRequiredPassed,true,'Native peer outage may leave only the current Shelly physical scope known');checks++;
 const noCause=clone(fallbackConfig);delete noCause.cases[0].fallbackCauseEvidence;
 result=await audit(noCause);assert.equal(result.cases[0].checks.find(c=>c.name==='independent-bad-feed-evidence').passed,false,'Missing peer scope never substitutes for independent outage evidence');checks++;
 for(const kind of ['shelly-priority','balanced','easee-priority','owned-pause-resume','native-stop']){
  result=await audit(setKind(kind));assert.equal(result.cases[0].checks.find(c=>c.name==='unchanged-physical-connections').passed,false,'Only fallback may lack a known peer session');checks++;
 }
 f=clone(fallbackUnknownPeer);f.status.at(-1).charging.chargers[1].request.sessionId='synthetic-replaced-shelly';write(f);
 result=await audit(fallbackConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='unchanged-shelly-physical-connection').passed,false);checks++;
 f=clone(fallbackKnown);f.status[2].charging.chargers[0].control.session=null;
 f.status.at(-1).charging.chargers[0].request.sessionId='synthetic-replaced-easee';write(f);
 result=await audit(fallbackConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='no-known-easee-connection-replacement').passed,false,'An unknown interval cannot hide two different known peer identities');checks++;
 f=clone(fallbackKnown);f.status[2].charging.chargers[0].control.session=null;write(f);
 assert.equal((await audit(fallbackConfig)).allRequiredPassed,true,'A peer may become unknown and recover the same identity');checks++;
 f=clone(fallbackKnown);write(f);
 for(const source of ['tesla','unrelated-source',undefined]){
  writeFeeds([{at:now+15000,evidence:{charger:{source,connected:false,online:false,synchronized:false}}}]);
  result=await audit(fallbackConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='independent-bad-feed-evidence').passed,false);checks++;
 }
 writeFeeds([{at:now-1,evidence:{charger:{source:'easee-ocpp',connected:false,online:false,synchronized:false}}}]);
 result=await audit(fallbackConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='independent-bad-feed-evidence').passed,false,'Outage outside the current case cannot supply evidence');checks++;
 delete fallbackConfig.cases[0].fallbackCauseEvidence;assert.equal((await audit(fallbackConfig)).allRequiredPassed,false);checks++;
 fallbackConfig.cases[0].fallbackCauseEvidence=causeFile;
 function fallbackFixture(){const f=fixtures();setPhysical(f,12,'fallback',true);return f;}
 f=fallbackFixture();write(f);writeFeeds([{at:now,evidence:{charger:{source:'easee-ocpp',connected:false}}}]);
 const preludeConfig=clone(fallbackConfig);preludeConfig.cases[0].fallbackCauseEvidence=causeFile;
 result=await audit(preludeConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='independent-bad-feed-evidence').passed,false,'A prelude outage cannot justify a later settled interval');checks++;
 f=fallbackFixture();const zeroed=clone(f);setPhysical(zeroed,0,'fallback',true);
 for(let i=3;i<f.status.length;i++){f.status[i]=zeroed.status[i];f.native.splice(i*4,4,...zeroed.native.slice(i*4,i*4+4));}
 const ownedStopAt=now+12000;f.native.unshift({receivedAt:ownedStopAt,retained:false,payload:JSON.stringify({id:'owned-fallback-stop',src:'stmq-evse-synthetic',method:'Boolean.Set',params:{role:'start_charging',value:false}})},
  {receivedAt:ownedStopAt+1,retained:false,payload:JSON.stringify({id:'owned-fallback-stop',result:null})});
 const zeroConfig=clone(fallbackConfig);zeroConfig.cases[0].expectedCurrentA=0;write(f);writeFeeds([{at:now+15000,evidence:{property:{source:'easee-stream',connected:false}}}]);
 result=await audit(zeroConfig);assert.equal(result.allRequiredPassed,true,'An owned fallback pause retains fallback mode and proves charging before Stop');checks++;
 const savedZero=clone(f);f.native=f.native.filter(r=>!r.payload.includes('owned-fallback-stop'));write(f);result=await audit(zeroConfig);
 assert.equal(result.cases[0].checks.find(c=>c.name==='application-stop-acknowledged-after-measured-charge').passed,false);checks++;
 f=clone(savedZero);for(const row of f.status.slice(0,3)){const p=row.charging.chargers[1].control.snapshot.fields.phase_info.value;p.total_power=0;for(const k of ['phase_a','phase_b','phase_c'])p[k].current=0;}
 write(f);result=await audit(zeroConfig);assert.equal(result.cases[0].checks.find(c=>c.name==='application-stop-acknowledged-after-measured-charge').passed,false);checks++;
 f=clone(savedZero);for(const row of f.status.slice(3))row.charging.chargers[1].limiter.mode='paused-by-balancing';write(f);result=await audit(zeroConfig);
 assert.equal(result.cases[0].checks.find(c=>c.name==='owned-limiter-pause-confirmed').passed,false);checks++;
 for(const row of nativeStopped.status)row.charging.chargers[1].control.limiter.fallback=false;
 write(nativeStopped);const recovered=clone(stopConfig);recovered.cases[0].feedRecoveryEvidence=causeFile;
 for(const [badSource,goodSource,expected] of [['easee-stream','easee-stream',true],['easee-ocpp','easee-ocpp',true],['easee-stream','easee-ocpp',false]]){
  writeFeeds([
   {at:now,evidence:{charger:{source:badSource,connected:false,online:false,synchronized:false}}},
   {at:now+1000,evidence:{charger:{source:goodSource,connected:true,online:true,synchronized:true}}}
  ]);result=await audit(recovered);
  assert.equal(result.cases[0].checks.find(c=>c.name==='feed-recovery-exercised').passed,expected,'Recovery belongs to the same source and feed role');checks++;
 }
 t.diagnostic(`${checks} physical evidence counterexamples checked`);
 await t.test('classifies missing evidence separately from positive contradictions', async () => {
   write(fixtures());
   assert.equal((await audit(config)).cases[0].status,'passed');
   let f=fixtures();f.native=[];write(f);
   assert.equal((await audit(config)).cases[0].status,'inconclusive');
   f=fixtures();setPhysical(f,18,'unrestricted');
   for(const row of f.status){const c=row.charging.chargers[1];c.control.limiter.currentA=16;c.limiter.appliedCurrentA=16;}
   for(const row of f.native){const p=JSON.parse(row.payload);if(p.result&&p.result.value===18){p.result.value=16;row.payload=JSON.stringify(p);}}
   write(f);
   assert.equal((await audit(config)).cases[0].status,'failed');
   f=fixtures();setPhysical(f,13,'unrestricted');write(f);
   assert.equal((await audit(config)).cases[0].status,'inconclusive','Lower vehicle current is not proof of a charger fault');
   f=fixtures();f.status[3]={receivedAt:now+15000,error:'status-unavailable'};write(f);
   assert.equal((await audit(config)).cases[0].status,'inconclusive','A recorder gap cannot extend a verified hold');
   const pending=clone(config);pending.cases[0].startAt=null;pending.cases[0].endAt=null;
   assert.equal((await audit(pending)).cases[0].status,'not-exercised');
 });
 await t.test('uses explicit configured fallback expectations rather than a hidden 12 A default', async () => {
   const f=fixtures();setPhysical(f,14,'fallback',true);write(f);
   writeFeeds([{at:now+15000,evidence:{property:{source:'easee-stream',connected:false}}}]);
   const configured=clone(fallbackConfig);configured.cases[0].expectedCurrentA=14;configured.cases[0].fallbackCauseEvidence=causeFile;
   assert.equal((await audit(configured)).allRequiredPassed,true);
 });
 await t.test('rejects obsolete, unknown and ambiguous configuration before reading evidence', async () => {
   const mutations=[c=>{c.version=0;},c=>{c.retiredOption=true;},c=>{c.cases[0].retiredOption=true;},
     c=>{delete c.cases[0].expectedCurrentA;},c=>{c.cases[0].expectedCurrentA=5;},
     c=>{c.cases[0].expectedCurrentA=17;},c=>{c.cases[0].kind='unknown';},
     c=>{c.cases.push(clone(c.cases[0]));},c=>{c.requiredKinds=['fallback','fallback'];},
     c=>{c.observer='../outside';},c=>{c.cases[0].fallbackCauseEvidence='../outside.json';},
     c=>{c.independentFeedSource='../outside.jsonl';},c=>{c.cases[0].startAt=-1;},
     c=>{c.cases[0].endAt=now+3*3600_000;},c=>{c.cases[0].minDistinctSamples=1;},
     c=>{c.cases[0].minHoldMs=0;},c=>{c.cases[0].maxStatusGapMs=9999999;},
     c=>{c.cases[0].minActualA=20;c.cases[0].maxActualA=10;},
     c=>{c.cases[0].requireVehicleCharging='true';}];
   for(const mutate of mutations){const candidate=clone(config);mutate(candidate);await assert.rejects(audit(candidate));}
   await assert.rejects(auditEvidence(config),/absolute evidence directory/);
 });
 await t.test('CLI reports only summary counts and uses explicit private, exclusive output', async () => {
   write(fixtures());
   const manifest=path.join(dir,'manifest.json'),report=path.join(dir,'report.json');
   fs.writeFileSync(manifest,JSON.stringify(config),{mode:0o600});
   const cli=path.resolve('scripts/charging-physical/audit.js');
   const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
   const first=run(['--cases',manifest,'--out',report]);
   assert.equal(first.status,0,first.stderr);
   assert.equal(JSON.parse(first.stdout).allRequiredPassed,true);
   assert.equal(JSON.parse(fs.readFileSync(report)).cases[0].status,'passed');
   assert.equal(fs.statSync(report).mode&0o777,0o600);
   assert.equal(first.stdout.includes('synthetic-priority'),false);
   assert.equal(first.stdout.includes(dir),false);
   assert.equal(run(['--cases',manifest,'--out',report]).status,1,'Never overwrite evidence');
   const pending=clone(config);pending.cases[0].endAt=null;
   fs.writeFileSync(manifest,JSON.stringify(pending));
   assert.equal(run(['--cases',manifest,'--out',path.join(dir,'pending.json')]).status,2);
   fs.writeFileSync(manifest,'{malformed-input-private-value');
   const bad=run(['--cases',manifest,'--out',path.join(dir,'invalid.json')]);
   assert.equal(bad.status,1);assert.equal(bad.stderr.includes('private-value'),false);
   assert.equal(fs.existsSync(path.join(dir,'invalid.json')),false);
   assert.equal(run(['--help']).status,0);
 });
 await t.test('rejects readable-to-others and symlink evidence', async () => {
   write(fixtures());const filename=path.join(dir,name+'-status.jsonl');
   fs.chmodSync(filename,0o644);
   await assert.rejects(audit(config));
   fs.chmodSync(filename,0o600);
   const target=path.join(dir,'linked-status.jsonl');fs.renameSync(filename,target);fs.symlinkSync(target,filename);
   await assert.rejects(audit(config));fs.unlinkSync(filename);
 });
 await t.test('rejects the ad hoc feed-array format instead of preserving a second feed decoder', async () => {
   const f=fixtures();setPhysical(f,12,'fallback',true);write(f);
   fs.writeFileSync(dir+'/'+causeFile,JSON.stringify([{at:now+15000,evidence:{property:{source:'easee-stream',connected:false}}}]),{mode:0o600});
   const candidate=clone(fallbackConfig);candidate.cases[0].fallbackCauseEvidence=causeFile;
   await assert.rejects(audit(candidate),/Unsupported independent evidence record/);
 });
 await t.test('rejects oversized evidence and reversed receipt clocks', async () => {
   const f=fixtures();f.status.reverse();write(f);
   await assert.rejects(audit(config),/not ordered/);
   const filename=dir+'/'+name+'-status.jsonl';
   fs.truncateSync(filename,129*1024*1024);
   await assert.rejects(audit(config),/128 MiB/);
 });

}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
