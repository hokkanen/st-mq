// Synthetic storage/query benchmark, never reads household configuration or
// production databases. Bulk population uses the actual observation schema;
// population time is NOT a live-acquisition throughput claim.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { Session } from 'node:inspector';
import { Store } from '../src/storage/store.js';
import { H66_HISTORY_SIGNALS, SIGNAL_INFO, PHASE_ENERGY_SIGNALS } from '../src/domain/history-series.js';
import { chartRange, getChartData } from '../src/app/chart-data.js';
import { recordHeatPumpConfiguration } from '../src/app/chart-heat-pump.js';
import { getDatabaseOverview } from '../src/app/database-overview.js';

const args=process.argv.slice(2), number=(name,fallback)=>{
  const index=args.indexOf(name);return index<0 ? fallback : Number(args[index+1]);
};
const requestedDays=number('--days',365), maximumSeconds=number('--max-seconds',150), h66Minutes=number('--h66-minutes',5);
const profileRequested=args.includes('--profile');
if (!Number.isInteger(requestedDays) || requestedDays<1 || requestedDays>365 || ![1,5].includes(h66Minutes)
  || !Number.isFinite(maximumSeconds) || maximumSeconds<1) throw new Error('Use --days 1..365 --h66-minutes 1|5 --max-seconds positive');
const HOUR=3_600_000,DAY=24*HOUR,MINUTE=60_000;
const root=mkdtempSync(join(tmpdir(),'stmq-synthetic-year-')),store=new Store(join(root,'synthetic.sqlite'));
const cleanup=()=>{try{store.close();}finally{rmSync(root,{recursive:true,force:true});}};
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{cleanup();process.exit(130);});
const epoch=chartRange({startDate:'2026-01-01',endDate:'2026-12-31',now:Date.UTC(2027,0,1)}).from;
const start=performance.now();
let rows=0,days=0;
function insert(o) {
  const quality=JSON.stringify(o.quality),raw=JSON.stringify(o.raw);
  store.insertObservation.run(o.source,o.device,o.signal,o.value,o.unit,o.sourceTime,o.sourceTime,quality,raw,null,null);
  rows++;
}
try {
  recordHeatPumpConfiguration(store, 'providers', {
    heatPumpCompressorKw: 3, circulationKw: 0.08, auxRatedKw: 9,
  }, epoch);
  for(let day=0;day<requestedDays;day++) {
    for(let hour=0;hour<24;hour++) store.transaction(()=>{
      const at=epoch+day*DAY+hour*HOUR;
      for(let minute=0;minute<60;minute++) {
        const t=at+minute*MINUTE;
        for(const signal of PHASE_ENERGY_SIGNALS) {
          const isCar=signal.startsWith('ev1'),power=isCar ? (hour>=12&&hour<14 ? 2.3 : 0) : 0.3+0.05*Number(signal.at(-1))+0.15*Math.sin(hour/24*2*Math.PI);
          const value=power/60;
          insert({source:'easee',device:isCar?'synthetic-charger':'synthetic-property',signal,value,unit:'kWh',sourceTime:t+MINUTE,
            quality:['estimated','phase_allocation_estimated'],raw:{intervalStart:t,intervalEnd:t+MINUTE,durationMs:MINUTE,
              basis:'integrated-power-phase-allocation',recorder:{version:'adaptive-recorder-v1',reason:'synthetic-cadence',group:isCar?'ev1':'property'}}});
        }
        if(minute%h66Minutes) continue;
        for(const signal of H66_HISTORY_SIGNALS) {
          const info=SIGNAL_INFO[signal],state=info.unit==='state'||info.unit==='code';
          const value=state ? Number(signal==='compressor_active'&&hour%3!==0)
            : info.unit==='h' ? day*10+hour/2 : info.unit==='%' ? 30+(hour%3)*10
            : signal==='heating_integral' ? -50+minute : 20+5*Math.sin((day+hour/24)/365*2*Math.PI)+Math.sin(minute/60*2*Math.PI);
          insert({source:'husdata-h66',device:'synthetic-heatpump',signal,value,unit:info.unit,sourceTime:t,
            quality:[],raw:{usableForControl:true,verified:true,timeBasis:'mqtt-received',recorder:{version:'adaptive-recorder-v1',
              reason:'synthetic-cadence',threshold:0.02,originalSourceTime:t,status:'fresh',temporalBasis:'source-observation'}}});
        }
      }
    });
    days=day+1;
    if(days%30===0) process.stderr.write(`Synthetic benchmark: ${days} days populated\n`);
    if((performance.now()-start)/1000>=maximumSeconds)break;
  }
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  store.db.exec('PRAGMA cache_size=-8192; PRAGMA temp_store=FILE;');
  const populatedMs=performance.now()-start,end=epoch+days*DAY;
  const date=at=>new Date(at+2*HOUR).toISOString().slice(0,10),queries=[];
  let cpuProfile=null;
  for(const [label,length] of [['day',1],['week',Math.min(7,days)],['month',Math.min(30,days)],['available-period',days]]) {
    let profiler=null,post=null;
    if(profileRequested&&label==='available-period') {
      profiler=new Session();profiler.connect();
      post=(method,params={})=>new Promise((resolve,reject)=>profiler.post(method,params,(error,result)=>error?reject(error):resolve(result)));
      await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:1000});await post('Profiler.start');
    }
    const before=performance.now(),result=getChartData({store,input:'offline',left:'power',startDate:date(end-length*DAY),
      endDate:date(end-1),now:end});
    const elapsedMs=Math.round(performance.now()-before);
    if(result.meta.historyBasis!=='original-recorded-history')throw new Error('Benchmark must query original recorded history');
    if(profiler) {
      const {profile}=await post('Profiler.stop');profiler.disconnect();
      const nodes=new Map(profile.nodes.map(node=>[node.id,node])),parents=new Map(),self=new Map(),inclusive=new Map();
      for(const node of profile.nodes)for(const child of node.children??[])parents.set(child,node.id);
      for(let i=0;i<(profile.samples?.length??0);i++) {
        let id=profile.samples[i];const ms=(profile.timeDeltas?.[i]??1000)/1000;
        self.set(id,(self.get(id)??0)+ms);
        while(id!==undefined){inclusive.set(id,(inclusive.get(id)??0)+ms);id=parents.get(id);}
      }
      const describe=([id,ms])=>({function:nodes.get(id).callFrame.functionName||'(anonymous)',
        file:nodes.get(id).callFrame.url.replace(/^.*\/st-mq-recorder\//,''),line:nodes.get(id).callFrame.lineNumber+1,ms:Math.round(ms)});
      cpuProfile={scope:'getChartData only; excludes population, serialization and preceding warm-up queries',
        self:[...self].sort((a,b)=>b[1]-a[1]).slice(0,18).map(describe),
        inclusive:[...inclusive].sort((a,b)=>b[1]-a[1]).slice(0,18).map(describe)};
    }
    queries.push({range:label,days:length,elapsedMs,jsonBytes:Buffer.byteLength(JSON.stringify(result)),
      points:Object.values(result.series).reduce((n,list)=>n+list.length,0),historyBasis:result.meta.historyBasis});
  }
  const overviewStarted = performance.now(), overview = getDatabaseOverview({ store, now: end });
  const inventory = { elapsedMs: Math.round(performance.now() - overviewStarted),
    jsonBytes: Buffer.byteLength(JSON.stringify(overview)), groups: overview.groups.length,
    tables: overview.accounting.tables.length, totalRows: overview.accounting.totalRows };
  console.log(JSON.stringify({synthetic:true,hardware:cpus()[0]?.model,node:process.version,requestedDays,populatedDays:days,
    electricityIntervalMinutes:1,h66IntervalMinutes:h66Minutes,h66Signals:H66_HISTORY_SIGNALS.length,rows,
    databaseBytes:store.databaseBytes(),annualizedBytes:Math.round(store.databaseBytes()*365/days),
    populationMs:Math.round(populatedMs),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),queries,inventory,...(cpuProfile?{cpuProfile}:{}),
    limitations:'Bulk synthetic population plus one nominal-power configuration; no representative provider/forecast/journal/coverage/state growth or live write-throughput measurement. Host results, not Raspberry Pi timings.'},null,2));
} finally {cleanup();}
