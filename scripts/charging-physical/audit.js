import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openPrivateOutput, parseArgs, privatePath, readPrivateJson } from './io.js';

// Offline evidence assessment only: no providers, application writes or device
// commands. The stream projection deliberately keeps independent source clocks,
// native readback and measured effects separate. See docs/charging/testing.md.
const MAX_STREAM_BYTES = 128 * 1024 * 1024;
const MAX_STREAM_RECORDS = 50000;
const KINDS = ['shelly-priority', 'balanced', 'easee-priority', 'owned-pause-resume', 'fallback', 'native-stop'];
const finite = Number.isFinite;
const vector = v => Array.isArray(v) && v.length === 3 && v.every(x => finite(x) && x >= 0);
const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
const range = v => v.length ? [Math.min(...v), Math.max(...v)] : null;
const safeName = x => typeof x === 'string' && /^[a-z0-9][a-z0-9.-]{0,100}$/.test(x);
const time = x => Number.isSafeInteger(x) && x > 0;
const inside = (at, start, end) => time(at) && at >= start && at <= end;
const unique = rows => [...new Map(rows.map(r => [r.measuredAt, r])).values()].sort((a,b) => a.measuredAt-b.measuredAt);
const charger = (row, id) => row.charging?.chargers?.find(c => c.id === id);
function session(c) {
  const s = c?.control?.session;
  return c?.association && c?.request?.sessionId && s?.connected === true && time(s.connectedAt)
    ? JSON.stringify([c.association, c.request.sessionId, s.connectedAt]) : null;
}
function physical(c, id, receivedAt) {
  if (c?.control?.snapshot?.online !== true) return null;
  const snapshot = c.control.snapshot, t = c.telemetry;
  if (id === 'charger2') {
    const f = snapshot.fields?.phase_info, p = f?.value;
    const currents = ['phase_a','phase_b','phase_c'].map(k => p?.[k]?.current);
    if (!f || f.retained === true || f.invalidatedAt !== undefined || !vector(currents) || !finite(p?.total_power) || p.total_power<0) return null;
    return { measuredAt: f.measuredAt, receivedAt, currents, powerKw: p.total_power,
      volts: ['phase_a','phase_b','phase_c'].map(k => p?.[k]?.voltage), powerAt: f.measuredAt };
  }
  const currents = snapshot.supply?.chargerCurrentA, times = snapshot.supply?.observationTimes?.charger;
  const p = typeof snapshot.powerKw === 'number' ? snapshot.powerKw : t?.powerKw?.value;
  const powerAt = snapshot.powerAt ?? t?.powerKw?.measuredAt;
  if (!vector(currents) || !Array.isArray(times) || times.length !== 3 || !times.every(time) || !finite(p) || p<0) return null;
  return { measuredAt: Math.min(...times), phaseTimes: times, receivedAt, currents, powerKw: p, powerAt };
}
function projection(row) {
  const c1 = charger(row, 'charger1'), c2 = charger(row, 'charger2'), at = row.receivedAt;
  if (!time(at)) throw Error('Status record lacks receipt clock');
  const c = c2?.control, snapshot = c?.snapshot;
  return { at, now: row.now, master: row.pair?.role === 'master' && row.pair.canControl === true && row.pair.vip?.owned === true
      && row.pair.peerRole === 'slave',
    priority: row.charging?.settings?.priority, session1: session(c1), session2: session(c2),
    meter1: physical(c1,'charger1',at), meter2: physical(c2,'charger2',at),
    supply1: c1?.control?.snapshot?.supply ?? null,
    peerOnline: c1?.control?.snapshot?.online === true,
    peerOpen: c1?.control?.manual?.kind !== 'stop' && c1?.control?.snapshot?.appControl?.stopped !== true
      && c1?.control?.snapshot?.appControl?.enabled !== false
      && (['enable','charge-now'].includes(c1?.control?.manual?.kind) || c1?.request?.chargeNow === true
        || ['active','released','charging'].includes(c1?.control?.phase)),
    limiter: c2?.limiter ?? null, decision: c?.limiter ?? null, manual: c?.manual?.kind ?? null,
    ownedPause: c?.ownedPause === true, permission: snapshot?.fields?.start_charging,
    currentSetting: snapshot?.fields?.current_limit, currentTest: c?.currentTest?.phase ?? null };
}
async function rows(file, accept) {
  file = privatePath(file);
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.size > MAX_STREAM_BYTES) throw Error('Input is absent or exceeds 128 MiB');
  const stream = fs.createReadStream(file), lines = readline.createInterface({input:stream,crlfDelay:Infinity});
  let count=0;
  try { for await (const line of lines) {
    if (++count>MAX_STREAM_RECORDS || line.length>2*1024*1024) throw Error('Input exceeds bounded record limit');
    if (!line.trim()) continue;
    accept(JSON.parse(line));
  }} finally { lines.close(); stream.destroy(); }
  return count;
}
function normalizeNative(row, requests, result) {
  if (row.retained === true || !time(row.receivedAt) || typeof row.payload!=='string') return;
  const at=row.receivedAt;
  let f; try { f=JSON.parse(row.payload); } catch { return; }
  if (typeof f.method==='string' && f.id != null) {
    const role=f.params?.role;
    if (['phase_info','current_limit','start_charging'].includes(role)) {
      if(requests.size>10000) throw Error('Too many unmatched native requests');
      requests.set(f.id,{at,method:f.method,role,value:f.params?.value,owner:typeof f.src==='string'&&f.src.startsWith('stmq-evse-')?'application':'external'});
      if(f.method.endsWith('.Set')) result.commands.push({at,method:f.method,role,value:f.params.value,owner:requests.get(f.id).owner});
    }
  }
  const req=requests.get(f.id);
  if(req && at>=req.at && at-req.at<=30000 && (Object.hasOwn(f,'result') || Object.hasOwn(f,'error'))) {
    requests.delete(f.id);
    if(f.error) {result.rejections++;return;}
    result.acks.push({...req,receivedAt:at});
    if(req.method.endsWith('.GetStatus') && f.result && Object.hasOwn(f.result,'value')) {
      const measuredAt=finite(f.result.last_update_ts)?Math.round(f.result.last_update_ts*1000):null;
      if(req.role==='phase_info') addNativeMeter(f.result.value,measuredAt,at,result.meters);
      else result.readbacks.push({role:req.role,value:f.result.value,measuredAt,requestedAt:req.at,receivedAt:at});
    }
  }
  if(['NotifyStatus','NotifyFullStatus'].includes(f.method)) for(const v of Object.values(f.params??{})) {
    if(v && typeof v==='object' && Object.hasOwn(v,'value')) {
      const measuredAt=finite(v.last_update_ts)?Math.round(v.last_update_ts*1000):null;
      addNativeMeter(v.value,measuredAt,at,result.meters);
    }
  }
}
function addNativeMeter(v, measuredAt, receivedAt, list) {
  const currents=['phase_a','phase_b','phase_c'].map(k=>v?.[k]?.current);
  if(vector(currents)&&finite(v?.total_power)&&v.total_power>=0&&time(measuredAt)&&measuredAt<=receivedAt)
    list.push({measuredAt,receivedAt,currents,powerKw:v.total_power});
}
function normalizeVehicle(row, list) {
  if(row.retained===true || row.dup===true || !time(row.receivedAt))return;
  const at=row.receivedAt;
  if(row.feed==='tesla') {
    const field=String(row.topic??'').split('/').at(-1);
    if(!['charger_actual_current','charger_power','charging_state','state','plugged_in'].includes(field))return;
    const value=['charger_actual_current','charger_power'].includes(field)?Number(row.payload):row.payload;
    if(typeof value==='number'&&!finite(value))return;
    list.push({at,feed:'tesla',field,value,sourceAt:null,timeBasis:'receipt-only'});
  } else if(row.feed==='bmw') {
    let p;try{p=JSON.parse(row.payload);}catch{return;}
    const raw=p.fields?.charging?.measuredAt,sourceAt=typeof raw==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(raw)?Date.parse(raw):raw;
    if(typeof p.charging==='boolean'&&time(sourceAt)&&sourceAt<=at)
      list.push({at,feed:'bmw',field:'charging',value:p.charging,sourceAt,timeBasis:'source'});
  }
}
function checkFresh(p,start,end,maxAge=15000){return p && inside(p.measuredAt,start,end)&&inside(p.powerAt??p.measuredAt,start,end)
  && (!p.phaseTimes||p.phaseTimes.every(at=>inside(at,start,end)&&at<=p.receivedAt))
  && p.receivedAt>=p.measuredAt && p.receivedAt>=(p.powerAt??p.measuredAt)
  && p.receivedAt-p.measuredAt<=maxAge && p.receivedAt-(p.powerAt??p.measuredAt)<=maxAge;}
function rawMatch(p,raw){return raw.some(q=>q.measuredAt===p.measuredAt&&Math.abs(q.powerKw-p.powerKw)<.05
  &&q.currents.every((v,i)=>Math.abs(v-p.currents[i])<.05));}
function sameSessions(window,keys=['session1','session2']){return keys.every(key=>window.length&&window[0][key]!=null&&window.every(r=>r[key]===window[0][key]));}
function gap(window,start,end){if(!window.length)return Infinity;return Math.max(window[0].at-start,end-window.at(-1).at,...window.slice(1).map((r,i)=>r.at-window[i].at));}
function evidenceGroups(value,out=[],depth=0){if(depth>8||value==null)return out;if(Array.isArray(value)){for(const v of value.slice(0,10000))evidenceGroups(v,out,depth+1);return out;}
  if(typeof value==='object'){if(time(value.at)&&value.evidence)out.push({at:value.at,evidence:value.evidence});
    if(time(value.at)&&value.supply?.feedEvidence)out.push({at:value.at,evidence:value.supply.feedEvidence});
    for(const [k,v]of Object.entries(value))if(!['observations','payload','profile','options'].includes(k))evidenceGroups(v,out,depth+1);}return out;}
function feedEvidence(c,file,directory){if(!file||!file.endsWith('.jsonl'))return [];if(!safeName(file))throw Error('Unsafe evidence filename');
  const input=[...independentFeedRows(file,directory).values()];
  return evidenceGroups(input).filter(r=>inside(r.at,c.startAt,c.endAt)).flatMap(r=>Object.entries(r.evidence??{}).map(([role,e])=>({at:r.at,role,e})));}
const supplyFeed=e=>['easee-stream','easee-ocpp'].includes(e?.source);
const badFeed=e=>supplyFeed(e)&&(e.connected===false||e.online===false||e.synchronized===false);
const goodFeed=e=>supplyFeed(e)&&e.connected===true&&e.online===true&&e.synchronized===true;
function validNativeBudget(budget,at){return budget?.source==='easee-equalizer-config'
  &&typeof budget.equipment==='string'&&budget.equipment.length>0
  &&finite(budget.currentA)&&budget.currentA>=0&&budget.currentA<=1000
  &&time(budget.confirmedAt)&&budget.confirmedAt<=at&&time(budget.validUntil)
  &&budget.validUntil>at&&budget.validUntil>budget.confirmedAt
  &&budget.validUntil-budget.confirmedAt<=24*3600_000;}
function sameBudget(a,b){return ['currentA','source','equipment','confirmedAt','validUntil'].every(k=>a?.[k]===b?.[k]);}
function independentFeedRows(file,directory){
  if(!safeName(file))return null;const full=privatePath(path.join(directory,file)),stat=fs.lstatSync(full);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>64*1024*1024)throw Error('Independent feed evidence exceeds bound');
  const lines=fs.readFileSync(full,'utf8').split('\n');if(lines.length>10000)throw Error('Independent feed evidence exceeds record bound');
  const result=new Map();for(const line of lines){if(!line.trim())continue;const row=JSON.parse(line);
    if(!row||typeof row!=='object'||Array.isArray(row)||!time(row.at))throw Error('Unsupported independent evidence record');
    result.set(row.at,row);}return result;
}
function streamPhases(rows,start){
  if(!Array.isArray(rows))return null;const selected=[0,1,2].map(i=>rows.filter(r=>r.id===start+i));
  if(selected.some(r=>r.length!==1))return null;
  const values=selected.map(([r])=>r.value),times=selected.map(([r])=>typeof r.timestamp==='number'?r.timestamp
    :typeof r.timestamp==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(r.timestamp)?Date.parse(r.timestamp):null);
  return vector(values)&&times.every(time)?{values,times}:null;
}
function belowMinimumIdle(s,phase,at){
  const e=s?.feedEvidence?.charger,p=s?.reportedPropertyCurrentA??s?.propertyCurrentA;
  if(!validNativeBudget(s?.nativeBudget,at)||![p,s?.chargerCurrentA,s?.availableCurrentA].every(vector)
    ||s.availableCurrentA[phase]!==0||e?.source!=='easee-ocpp'||!goodFeed(e)||e.epoch==null
    ||!['activityAt','receivedAt'].every(k=>time(e[k])&&e[k]<=at&&at-e[k]<=120000)
    ||!s.chargerCurrentA.every(a=>a<=.1)||!Array.isArray(s.observationTimes?.charger)
    ||s.observationTimes.charger.length!==3||!s.observationTimes.charger.every(t=>time(t)&&t<=at&&at-t<=120000)
    ||!['property','allowance'].every(k=>goodFeed(s.feedEvidence?.[k])&&s.feedEvidence[k].epoch!=null
      &&Array.isArray(s.observationTimes?.[k])&&s.observationTimes[k].length===3
      &&s.observationTimes[k].every(t=>time(t)&&t<=at)))return false;
  const raw=s.nativeBudget.currentA-p[phase]+s.chargerCurrentA[phase];
  return raw>=0&&raw<6;
}
function independentlySupportedIdle(row,phase,feeds,start,end){
  const base=row.supply1;
  return feeds.some(feed=>inside(feed.statusAt,start,end)&&Math.abs(feed.at-row.at)<=5000
    &&feed.statusAt<=feed.at&&feed.at-feed.statusAt<=5000
    &&validNativeBudget(feed.nativeBudget,row.at)&&feed.nativeBudget.currentA===base?.nativeBudget?.currentA
    &&feed.nativeBudget.equipment===base?.nativeBudget?.equipment
    &&['property','charger'].every(k=>feed.evidence?.[k]?.source==='easee-stream'&&goodFeed(feed.evidence[k]))
    &&vector(feed.nativeEaseeCurrentA)&&feed.nativeEaseeCurrentA.every((value,i)=>value===base?.chargerCurrentA?.[i])
    &&feed.nativeEaseeEvidence?.epoch===base?.feedEvidence?.charger?.epoch&&(()=>{
      const property=streamPhases(feed.property,31),allowance=streamPhases(feed.charger,230);
      if(!property||!allowance)return false;
      const supply={nativeBudget:feed.nativeBudget,reportedPropertyCurrentA:property.values,
        chargerCurrentA:feed.nativeEaseeCurrentA,availableCurrentA:allowance.values,
        observationTimes:{property:property.times,allowance:allowance.times,charger:feed.nativeEaseeTimes},
        feedEvidence:{property:feed.evidence.property,allowance:feed.evidence.charger,charger:feed.nativeEaseeEvidence}};
      const expected=feed.nativeBudget.currentA-property.values[phase]+feed.nativeEaseeCurrentA[phase];
      return belowMinimumIdle(supply,phase,row.at)
        &&finite(row.decision.allowanceComparison?.expectedCurrentA?.[phase])
        &&Math.abs(expected-row.decision.allowanceComparison.expectedCurrentA[phase])<=.000001;
    })());
}
function snapshotSupportedIdle(row,phase){
  const s=row.supply1,p=s?.reportedPropertyCurrentA??s?.propertyCurrentA;
  return belowMinimumIdle(s,phase,row.at)&&finite(row.decision.allowanceComparison?.expectedCurrentA?.[phase])
    &&Math.abs(s.nativeBudget.currentA-p[phase]+s.chargerCurrentA[phase]
      -row.decision.allowanceComparison.expectedCurrentA[phase])<=.000001;
}
function rawDisagreementEvidence(c,file,window,actual2,directory){
  if(!file||!file.endsWith('.json'))return 0;if(!safeName(file))throw Error('Unsafe comparison evidence filename');
  const input=readPrivateJson(path.join(directory,file));
  if(input.kind!=='raw-allowance-disagreement')return 0;
  if(!safeName(input.configurationSource)||!safeName(input.nativeBudgetSource)||!Number.isInteger(input.phase)||input.phase<1||input.phase>3
    ||!finite(input.allowanceA)||input.allowanceA<0||input.allowanceA>1000
    ||input.allowanceA!==0&&!safeName(input.independentFeedSource)
    ||!Array.isArray(input.supportingPhysicalSamples)||input.supportingPhysicalSamples.length>1000)return 0;
  const electrical=readPrivateJson(path.join(directory,input.configurationSource)),phase=input.phase-1;
  const independent=readPrivateJson(path.join(directory,input.nativeBudgetSource));
  if(independent.readOnly!==true||independent.httpStatus!==200||!time(independent.requestedAt)||!time(independent.receivedAt)
    ||independent.requestedAt>independent.receivedAt||!validNativeBudget(independent.nativeBudget,independent.receivedAt)
    ||independent.nativeBudget.confirmedAt<independent.requestedAt||independent.nativeBudget.confirmedAt>independent.receivedAt)return 0;
  if(electrical.readOnly!==true||!time(electrical.at)||!vector(electrical.mainFuseA)
    ||input.mainFuseA!==electrical.mainFuseA[phase]||input.toleranceA!==electrical.agreementToleranceA
    ||!finite(input.toleranceA)||input.toleranceA<0||input.toleranceA>16)return 0;
  const feeds=input.independentFeedSource?independentFeedRows(input.independentFeedSource,directory):null;
  const byTime=new Map(window.map(r=>[r.at,r])),actualTimes=new Set(actual2.map(r=>r.measuredAt)),matched=[];
  for(const sample of input.supportingPhysicalSamples){
    const row=byTime.get(sample.statusAt??sample.at),s=row?.supply1,p=row?.meter2;
    if(!row||!row.peerOnline||row.limiter?.mode!=='fallback'||row.decision?.fallbackReason!=='allowance-disagreement'
      ||!validNativeBudget(s?.nativeBudget,row.at)||!sameBudget(input.nativeBudget,s.nativeBudget)
      ||!validNativeBudget(independent.nativeBudget,row.at)||independent.nativeBudget.currentA!==s.nativeBudget.currentA
      ||independent.nativeBudget.equipment!==s.nativeBudget.equipment
      ||sample.phase!==input.phase||sample.mainFuseA!==input.mainFuseA||sample.toleranceA!==input.toleranceA
      ||!p||!actualTimes.has(p.measuredAt)||sample.shellyMeasuredAt!==p.measuredAt||!vector(sample.shellyCurrentA)
      ||!sample.shellyCurrentA.every((v,i)=>Math.abs(v-p.currents[i])<.000001))continue;
    let property=s?.reportedPropertyCurrentA??s?.propertyCurrentA,allowance=s?.availableCurrentA,sourceTimes=s?.observationTimes;
    const charger=s?.chargerCurrentA,feed=feeds?.get(sample.at);
    if(feeds){
      const p=streamPhases(feed?.property,31),a=streamPhases(feed?.charger,230);
      if(!feed||feed.statusAt!==row.at||feed.at<row.at||feed.at-row.at>5000||!p||!a
        ||!['charger','property'].every(k=>feed.evidence?.[k]?.source==='easee-stream'&&goodFeed(feed.evidence[k])&&feed.evidence[k].epoch!=null)
        ||!sameBudget(feed.nativeBudget,independent.nativeBudget)||!sameBudget(feed.runtimeNativeBudget,s.nativeBudget)
        ||!vector(feed.nativeEaseeCurrentA)||!feed.nativeEaseeCurrentA.every((v,i)=>v===charger?.[i])
        ||!Array.isArray(feed.nativeEaseeTimes)||!feed.nativeEaseeTimes.every((v,i)=>v===s.observationTimes?.charger?.[i])
        ||feed.shellyMeasuredAt!==sample.shellyMeasuredAt||!vector(feed.shellyCurrentA)
        ||!feed.shellyCurrentA.every((v,i)=>v===sample.shellyCurrentA[i])
        ||row.decision.allowanceComparison?.basis?.[phase]!=='raw'
        ||feed.comparison?.basis?.[phase]!=='raw'
        ||a.values[phase]!==s.availableCurrentA?.[phase]||a.times[phase]!==s.observationTimes?.allowance?.[phase])continue;
      property=p.values;allowance=a.values;sourceTimes={property:p.times,allowance:a.times,charger:s.observationTimes.charger};
      const expected=Math.max(0,s.nativeBudget.currentA-property[phase]+charger[phase]);
      if(!finite(row.decision.allowanceComparison?.expectedCurrentA?.[phase])
        ||Math.abs(expected-row.decision.allowanceComparison.expectedCurrentA[phase])>.000001)continue;
    }
    if(![property,charger,allowance].every(vector)||allowance[phase]!==input.allowanceA
      ||sample.propertyCurrentA!==property[phase]||sample.easeeCurrentA!==charger[phase]||sample.allowanceA!==allowance[phase]
      ||!['property','charger','allowance'].every(role=>Array.isArray(sourceTimes?.[role])
        &&time(sourceTimes[role][phase])&&sourceTimes[role][phase]<=row.at
        &&sample.sourceTimes?.[role]===sourceTimes[role][phase]))continue;
    // Compare the independently read native budget, never the separate hard
    // Shelly fuse. Zero cannot own a positive anchor, but can be operationally
    // consistent with an independently measured idle peer below its minimum.
    // Keep its actual numeric value and all source clocks unchanged.
    const expected=Math.max(0,s.nativeBudget.currentA-property[phase]+charger[phase]);
    if(Math.abs(allowance[phase]-expected)>input.toleranceA
      &&!belowMinimumIdle({...s,reportedPropertyCurrentA:property,availableCurrentA:allowance,observationTimes:sourceTimes},phase,row.at))matched.push(p);
  }
  const distinct=unique(matched);
  return distinct.length>=(c.minDistinctSamples??3)&&distinct.at(-1).measuredAt-distinct[0].measuredAt>=(c.minHoldMs??10000)?distinct.length:0;
}
function powerFits(p){if(!vector(p.volts)||p.volts.some(v=>v<150||v>300))return false;
 const estimate=p.currents.reduce((total,a,i)=>total+a*p.volts[i]/1000,0);return p.powerKw>=estimate*.75&&p.powerKw<=estimate*1.2;}
function auditCase(c,data,directory){
  const result={id:c.id,kind:c.kind,status:'not-exercised',checks:[],physical:{},vehicle:{}};
  if(!time(c.startAt)||!time(c.endAt)||c.endAt<=c.startAt)return result;
  const settle=c.settleMs??30000,start=c.startAt+settle,end=c.endAt;
  const minSamples=c.minDistinctSamples??3,minHold=c.minHoldMs??10000;
  if(!Number.isSafeInteger(settle)||settle<0||end-start<0||minSamples<2||minSamples>100||minHold<1000)throw Error('Invalid case bounds');
  const all=data.status.filter(r=>inside(r.at,c.startAt,end)),window=all.filter(r=>r.at>=start);
  const add=(name,passed,detail)=>result.checks.push({name,passed:passed===true,...(detail!==undefined?{detail}:{})});
  add('recorded-window-covered',window.length>=minSamples&&gap(window,start,end)<=(c.maxStatusGapMs??5000));
  add('sole-master-through-window',all.length>0&&all.every(r=>r.master&&time(r.now)&&Math.abs(r.now-r.at)<=5000));
  if(c.kind==='fallback'){
    // A genuine peer feed outage may make its physical session unknown. It
    // cannot erase Shelly's own scope or an observed peer-session replacement.
    add('unchanged-shelly-physical-connection',sameSessions(all,['session2']));
    add('no-known-easee-connection-replacement',new Set(all.map(r=>r.session1).filter(s=>s!==null)).size<=1);
  }else add('unchanged-physical-connections',sameSessions(all));
  const native=data.native.meters.filter(r=>inside(r.measuredAt,start,end)&&inside(r.receivedAt,start,end));
  const actual2=unique(window.map(r=>r.meter2).filter(p=>checkFresh(p,start,end)&&rawMatch(p,native)));
  const actual1=unique(window.map(r=>r.meter1).filter(p=>checkFresh(p,start,end,60000)));
  add('fresh-native-correlated-shelly-measurements',actual2.length>=minSamples&&actual2.at(-1).measuredAt-actual2[0].measuredAt>=minHold);
  result.physical={shellyDistinctClocks:actual2.length,easeeDistinctClocks:actual1.length,
    shellyMeanCurrentRangeA:range(actual2.map(p=>mean(p.currents))),shellyPowerRangeKw:range(actual2.map(p=>p.powerKw)),
    easeeMaxCurrentRangeA:range(actual1.map(p=>Math.max(...p.currents))),easeePowerRangeKw:range(actual1.map(p=>p.powerKw))};
  const priority={ 'shelly-priority':'charger2',balanced:'balanced','easee-priority':'charger1' }[c.kind];
  if(priority)add('requested-priority-observed',window.length>0&&window.every(r=>r.priority===priority));
  const target=c.expectedCurrentA??null;
  const low=c.minActualA??(target===0?0:target!=null?target-1.5:6);
  const high=c.maxActualA??(target===0?.3:target!=null?target+.8:1000);
  const limitRows=window.filter(r=>r.limiter&&r.decision&&time(r.decision.evaluatedAt)&&r.decision.evaluatedAt<=r.at&&r.at-r.decision.evaluatedAt<=30000);
  const readbacks=data.native.readbacks.filter(r=>r.role==='current_limit'&&inside(r.requestedAt,start,end)&&inside(r.receivedAt,start,end));
  const stops=actual2.filter(p=>p.powerKw<=.05&&p.currents.every(a=>a<=.3));
  if(['shelly-priority','balanced','easee-priority','fallback'].includes(c.kind)){
    add('limiter-decision-observed',limitRows.length>=minSamples&&limitRows.every(r=>r.decision.currentA===target));
    add('fallback-classification-correct',limitRows.length>=minSamples&&limitRows.every(r=>r.decision.fallback===(c.kind==='fallback')
      &&(c.kind!=='fallback'||r.limiter.mode==='fallback')));
    if(c.kind!=='fallback')add('verified-load-model-observed',limitRows.length>=minSamples&&limitRows.every(r=>
      r.decision.modelAvailable===true&&r.decision.settling!==true
      &&(r.decision.currentA===0?r.limiter.mode==='paused-by-balancing':['unrestricted','limited'].includes(r.limiter.mode))));
    if(c.kind!=='fallback')add('native-budget-and-idle-basis-supported',limitRows.length>=minSamples&&limitRows.every(r=>
      validNativeBudget(r.supply1?.nativeBudget,r.at)&&[0,1,2].every(i=>
        r.decision.allowanceComparison?.basis?.[i]!=='below-minimum-idle'||snapshotSupportedIdle(r,i)
          ||independentlySupportedIdle(r,i,data.independentFeeds,start,end))));
    add('measured-current-and-power-fit-case',actual2.length>=minSamples&&actual2.every(p=>
      target===0?p.powerKw<=.05&&p.currents.every(a=>a<=.3)
        :p.currents.every(a=>a>=low&&a<=high)&&p.powerKw>=1&&p.powerKw<=12&&powerFits(p)));
    if(target===0){
      add('owned-limiter-pause-confirmed',window.length>=minSamples&&window.every(r=>r.ownedPause&&r.permission?.value===false
        &&r.limiter?.mode===(c.kind==='fallback'?'fallback':'paused-by-balancing')&&r.limiter.applicationStatus==='confirmed'));
      if(c.kind==='fallback'){
        const allNative=data.native.meters.filter(p=>inside(p.measuredAt,c.startAt,end));
        const before=unique(all.map(r=>r.meter2).filter(p=>checkFresh(p,c.startAt,start)&&rawMatch(p,allNative)
          &&p.powerKw>=1&&p.currents.some(a=>a>=5)));
        add('application-stop-acknowledged-after-measured-charge',data.native.acks.some(r=>r.owner==='application'
          &&r.role==='start_charging'&&r.method==='Boolean.Set'&&r.value===false&&inside(r.at,c.startAt,start)
          &&r.receivedAt<=start&&before.some(p=>p.measuredAt<r.at&&p.receivedAt<=r.at)));
        add('no-replacement-start-during-fallback-pause',!data.native.commands.some(r=>r.role==='start_charging'
          &&r.value===true&&inside(r.at,start,end)));
      }
    }else{
      add('native-current-setting-readback',readbacks.some(r=>r.value===target));
      add('application-readback-confirmed',limitRows.length>=minSamples&&limitRows.every(r=>r.limiter.applicationStatus==='confirmed'
        &&r.limiter.appliedCurrentA===r.decision.currentA));
    }
    if(c.kind==='fallback'){
      const rawSamples=rawDisagreementEvidence(c,c.fallbackCauseEvidence,window,actual2,directory);
      add('independent-bad-feed-evidence',rawSamples>0||feedEvidence(c,c.fallbackCauseEvidence,directory).some(r=>r.at>=start&&badFeed(r.e)),
        rawSamples>0?{kind:'raw-allowance-disagreement',distinctPhysicalClocks:rawSamples}:undefined);
    }
  }
  if(['shelly-priority','balanced','easee-priority'].includes(c.kind)){
    add('easee-remains-online-and-open',window.length>0&&window.every(r=>r.peerOnline&&r.peerOpen));
    if(c.kind!=='shelly-priority')add('easee-actual-draw-recorded',actual1.length>=minSamples&&actual1.some(p=>Math.max(...p.currents)>=5&&p.powerKw>=1));
  }
  if(c.kind==='shelly-priority'){
    // The case starts with the previous priority charging prelude. Nothing
    // before startAt may supply the baseline, including cached meter values.
    // Equalizer may correctly yield all the way to zero after Shelly takes 16 A.
    const switchIndex=all.findIndex((r,i)=>r.priority==='charger2'&&i>0&&all[i-1].priority!=='charger2');
    const switchAt=switchIndex>=0?all[switchIndex].at:null;
    const prelude=switchIndex>=0?all.slice(0,switchIndex):[];
    const before=unique(prelude.filter(r=>r.priority!=='charger2'&&r.peerOnline&&r.peerOpen)
      .map(r=>r.meter1).filter(p=>checkFresh(p,c.startAt,switchAt-1,60000)
        &&Math.max(...p.currents)>=5&&p.powerKw>=1));
    const baseA=before.length?Math.min(...before.map(p=>Math.max(...p.currents))):null;
    const basePower=before.length?Math.min(...before.map(p=>p.powerKw)):null;
    add('requested-priority-transition-observed',switchAt!==null&&switchAt<=start
      &&prelude.every(r=>['charger1','balanced'].includes(r.priority))&&all.slice(switchIndex).every(r=>r.priority==='charger2'));
    add('easee-actual-draw-before-priority-switch',before.length>=2
      &&before.at(-1).measuredAt-before[0].measuredAt>=1000);
    add('easee-permission-open-through-priority-switch',all.length>0&&all.every(r=>r.peerOnline&&r.peerOpen));
    add('native-equalizer-reduces-easee',baseA!==null&&actual1.length>=minSamples
      &&actual1.at(-1).measuredAt-actual1[0].measuredAt>=minHold&&actual1.every(p=>
        p.measuredAt>=switchAt&&baseA-Math.max(...p.currents)>=(c.peerReductionA??2)
        &&p.powerKw<basePower&&(p.currents.every(a=>a<=.3)?p.powerKw<=.05:p.powerKw>.05)));
    result.physical.easeePreludeDistinctClocks=before.length;
    result.physical.easeePreludeMaxCurrentRangeA=range(before.map(p=>Math.max(...p.currents)));
  }
  if(c.kind==='owned-pause-resume'){
    const paused=all.find(r=>r.ownedPause&&r.permission?.value===false&&checkFresh(r.meter2,c.startAt,end)
      &&r.meter2.powerKw<=.05&&r.meter2.currents.every(a=>a<=.3));
    const resumed=actual2.filter(p=>paused&&p.measuredAt>paused.at&&p.powerKw>=1&&p.currents.every(a=>a>=5));
    add('owned-pause-physically-observed',Boolean(paused));
    add('fresh-charging-resumes-after-owned-pause',resumed.length>=minSamples);
    add('application-start-acknowledged',data.native.acks.some(r=>r.owner==='application'&&r.role==='start_charging'
      &&r.method==='Boolean.Set'&&r.value===true&&paused&&r.at>=paused.at&&r.receivedAt<=end));
    add('no-unrelated-native-stop-overridden',all.every(r=>r.manual!=='stop'));
    add('priority-change-observed',new Set(all.map(r=>r.priority)).size>=2);
  }
  if(c.kind==='native-stop'){
    add('native-stop-acknowledged',data.native.acks.some(r=>r.owner==='external'&&r.role==='start_charging'&&r.method==='Boolean.Set'
      &&r.value===false&&inside(r.at,c.startAt,start)&&r.receivedAt<=start));
    add('physical-stop-held',actual2.length>=minSamples&&stops.length===actual2.length);
    add('manual-stop-authority-preserved',window.length>0&&window.every(r=>r.manual==='stop'&&r.permission?.value===false&&!r.ownedPause));
    add('no-replacement-start-command',!data.native.commands.some(r=>r.role==='start_charging'&&r.value===true&&inside(r.at,c.startAt,end)));
    add('priority-change-exercised',new Set(all.map(r=>r.priority)).size>=2);
    const feeds=feedEvidence(c,c.feedRecoveryEvidence,directory);
    add('feed-recovery-exercised',feeds.some(a=>badFeed(a.e)&&feeds.some(b=>b.role===a.role&&b.e?.source===a.e.source&&b.at>a.at&&goodFeed(b.e)))
      ||all.some((a,i)=>a.decision?.fallback===true&&all.slice(i+1).some(b=>b.decision?.fallback===false
        &&b.decision.modelAvailable===true&&b.decision.settling!==true
        &&['unrestricted','limited','paused-by-balancing'].includes(b.limiter?.mode))));
  }
  const vehicleEnd=end+(c.vehicleDelayMs??120000),tesla=data.vehicle.filter(r=>r.feed==='tesla'&&inside(r.at,c.startAt,vehicleEnd));
  const current=tesla.filter(r=>r.field==='charger_actual_current'&&r.value>0),power=tesla.filter(r=>r.field==='charger_power'&&r.value>0);
  const teslaMatch=actual2.some(p=>p.powerKw>1&&current.some(r=>Math.abs(r.at-p.measuredAt)<=(c.vehicleDelayMs??120000)
    &&Math.abs(r.value-mean(p.currents))<=2)&&power.some(r=>Math.abs(r.at-p.measuredAt)<=(c.vehicleDelayMs??120000)&&Math.abs(r.value-p.powerKw)<=1.5));
  const bmw=data.vehicle.filter(r=>r.feed==='bmw'&&r.value===true&&inside(r.sourceAt,c.startAt,end)&&r.at<=vehicleEnd);
  result.vehicle={teslaCurrentAndPowerCorroborated:teslaMatch,teslaEvidence:'receipt-only',bmwFreshChargingReports:new Set(bmw.map(r=>r.sourceAt)).size,
    lateReportsAllowedMs:c.vehicleDelayMs??120000};
  if(c.requireVehicleCharging===true)add('vehicle-current-and-power-corroborate',teslaMatch);
  // Absence of proof, a missed setup, or lower vehicle draw is inconclusive.
  // Reserve failure for positively observed violations; do not diagnose taper
  // or an unknown connection as a failed charger implementation.
  const replacementStart = result.checks.some(r=>!r.passed && [
    'no-replacement-start-command', 'no-replacement-start-during-fallback-pause'
  ].includes(r.name));
  const continuedCharging = c.kind==='native-stop'
    &&result.checks.some(r=>r.name==='native-stop-acknowledged'&&r.passed)&&actual2.length>=minSamples
    && actual2.some(p=>p.currents.some(a=>a>0.3)&&p.powerKw>0.05);
  const aboveCeiling = target!==null
    &&result.checks.some(r=>r.name==='native-current-setting-readback'&&r.passed)
    &&result.checks.some(r=>r.name==='limiter-decision-observed'&&r.passed)&&actual2.length>=minSamples
    && actual2.some(p=>p.currents.some(a=>a>high));
  result.status=result.checks.every(r=>r.passed)?'passed'
    :replacementStart||continuedCharging||aboveCeiling?'failed':'inconclusive';
  return result;
}
const CONFIG_KEYS = ['version', 'observer', 'cases', 'requiredKinds', 'independentFeedSource'];
const CASE_KEYS = ['id', 'kind', 'startAt', 'endAt', 'settleMs', 'minDistinctSamples',
  'minHoldMs', 'maxStatusGapMs', 'expectedCurrentA', 'minActualA', 'maxActualA',
  'peerReductionA', 'vehicleDelayMs', 'requireVehicleCharging',
  'fallbackCauseEvidence', 'feedRecoveryEvidence'];
function knownKeys(value, keys) {
  return value && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).every(k=>keys.includes(k));
}
function validateConfig(config) {
  if(!knownKeys(config,CONFIG_KEYS)||config.version!==1||!safeName(config.observer)
    ||!Array.isArray(config.cases)||config.cases.length>40)throw Error('Unsupported audit configuration');
  const names=new Set();
  for(const c of config.cases){
    if(!knownKeys(c,CASE_KEYS)||!safeName(c.id)||names.has(c.id)||!KINDS.includes(c.kind))throw Error('Unknown or duplicate audit case');
    names.add(c.id);
    for(const k of ['fallbackCauseEvidence','feedRecoveryEvidence'])
      if(c[k]!==undefined&&!safeName(c[k]))throw Error('Unsafe evidence filename');
    if(c.feedRecoveryEvidence!==undefined&&!c.feedRecoveryEvidence.endsWith('.jsonl'))throw Error('Feed evidence must be current JSONL');
    if(c.fallbackCauseEvidence!==undefined&&!/\.jsonl?$/.test(c.fallbackCauseEvidence))throw Error('Unsupported comparison evidence file');
    for(const k of ['startAt','endAt'])
      if(c[k]!==undefined&&c[k]!==null&&!time(c[k]))throw Error('Invalid case clock');
    if(time(c.startAt)&&time(c.endAt)&&(c.endAt<=c.startAt||c.endAt-c.startAt>2*3600_000))throw Error('Invalid case duration');
    for(const [k,min,max] of [['settleMs',0,3600000],['minDistinctSamples',2,100],
      ['minHoldMs',1000,3600000],['maxStatusGapMs',100,60000],['vehicleDelayMs',0,300000]])
      if(c[k]!==undefined&&(!Number.isSafeInteger(c[k])||c[k]<min||c[k]>max))throw Error('Invalid evidence bounds');
    if(['shelly-priority','balanced','easee-priority','fallback'].includes(c.kind)
      &&(!Number.isInteger(c.expectedCurrentA)||(c.expectedCurrentA!==0
        &&(c.expectedCurrentA<6||c.expectedCurrentA>16))))throw Error('Allocation cases require explicit 0 or 6-16 A expected current');
    for(const k of ['expectedCurrentA','minActualA','maxActualA','peerReductionA'])
      if(c[k]!==undefined&&(!finite(c[k])||c[k]<0||c[k]>1000))throw Error('Invalid expected current');
    if(c.minActualA!==undefined&&c.maxActualA!==undefined&&c.minActualA>c.maxActualA)throw Error('Invalid measured range');
    if(c.requireVehicleCharging!==undefined&&typeof c.requireVehicleCharging!=='boolean')throw Error('Invalid vehicle requirement');
  }
  if(config.independentFeedSource!==undefined&&(!safeName(config.independentFeedSource)||!config.independentFeedSource.endsWith('.jsonl')))throw Error('Unsafe independent evidence filename');
  const required=config.requiredKinds??KINDS;
  if(!Array.isArray(required)||required.length===0||required.some(k=>!KINDS.includes(k))
    ||new Set(required).size!==required.length)throw Error('Invalid required cases');
  return required;
}

export async function audit(config, { directory } = {}){
  const required=validateConfig(config);
  if(typeof directory!=='string'||!path.isAbsolute(directory)||!fs.statSync(directory).isDirectory())
    throw Error('An explicit absolute evidence directory is required');
  const data={status:[],native:{meters:[],readbacks:[],commands:[],acks:[],rejections:0},vehicle:[],
    independentFeeds:config.independentFeedSource?[...independentFeedRows(config.independentFeedSource,directory).values()]:[]};
  const count={};count.status=await rows(path.join(directory,config.observer+'-status.jsonl'),r=>data.status.push(projection(r)));
  for(let i=1;i<data.status.length;i++)if(data.status[i].at<data.status[i-1].at)throw Error('Status receipt clocks are not ordered');
  const requests=new Map();count.native=await rows(path.join(directory,config.observer+'-native.jsonl'),r=>normalizeNative(r,requests,data.native));
  count.vehicle=await rows(path.join(directory,config.observer+'-vehicle.jsonl'),r=>normalizeVehicle(r,data.vehicle));
  count.admittedNativeMeters=data.native.meters.length;count.admittedNativeReadbacks=data.native.readbacks.length;
  count.observedNativeCommands=data.native.commands.length;count.nativeRejections=data.native.rejections;count.admittedVehicleReports=data.vehicle.length;
  const cases=config.cases.map(c=>auditCase(c,data,directory));
  const unprovenKinds=required.filter(k=>!cases.some(c=>c.kind===k&&c.status==='passed'));
  return {version:1,generatedAt:Date.now(),readOnly:true,allRequiredPassed:unprovenKinds.length===0&&cases.every(c=>c.status==='passed'),
    unprovenKinds,counts:count,cases,limits:['No direct OCPP wire capture: Easee physical proof uses source-clocked native meter projection.',
      'Equalizer reduction is observed response during the case, not proof that no unobserved household load changed.',
      'Vehicle receipt-only reports retain that provenance; missing vehicle reports are never inferred.',
      'Optional vehicle corroboration assumes the operator-confirmed Tesla-on-Shelly pairing; it does not test identification.',
      'The sole-master check requires paired operation with the peer reporting slave and the active owner holding the VIP.',
      'A passing physical interval does not prove all future operating conditions.']};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length===3&&process.argv[2]==='--help'){
      console.log(`Offline physical limiter evidence assessment.
Usage: node scripts/charging-physical/audit.js --cases /private/run/cases.json --out /private/run/audit.json
Inputs: version 1 manifest plus its sibling observer-prefix status/native/vehicle JSONL files.
Output: a new private report outside the checkout. No provider or charger requests.
Exit codes: 0 all required cases passed; 2 incomplete or failed; 1 invalid input.
See docs/charging/testing.md for setups, evidence and supported cases.`);
    }else{
    const args=parseArgs(process.argv.slice(2),['cases','out']);
    if(!args.cases||!args.out)throw Error('Explicit --cases and --out are required');
    const input=path.resolve(args.cases);
    const report=await audit(readPrivateJson(input),{directory:path.dirname(input)});
    const fd=openPrivateOutput(args.out);
    try{fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n');}finally{fs.closeSync(fd);}
    // Detailed currents and actual case identifiers stay in the private report.
    console.log(JSON.stringify({readOnly:true,allRequiredPassed:report.allRequiredPassed,
      cases:report.cases.length,statusCounts:Object.fromEntries(['passed','failed','inconclusive','not-exercised']
        .map(status=>[status,report.cases.filter(c=>c.status===status).length]))}));
    if(!report.allRequiredPassed)process.exitCode=2;
    }
  }catch{console.error(JSON.stringify({readOnly:true,error:'audit-input-invalid-or-incomplete',allRequiredPassed:false}));process.exitCode=1;}
}
