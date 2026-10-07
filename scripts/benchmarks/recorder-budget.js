// Offline adaptive-recording benefit and allocation measurement. Uses invented
// observations and in-memory SQLite only; never loads household configuration.
// Run: node scripts/benchmarks/recorder-budget.js [2..7 days, default 3]
import { Store } from '../../src/storage/store.js';
import { Recorder } from '../../src/storage/recorder.js';
import { getDatabaseOverview } from '../../src/app/database-overview.js';

const days=Number(process.argv[2]??3);
if(!Number.isInteger(days)||days<2||days>7) throw new Error('Use 2..7 synthetic days');
const MINUTE=60_000,start=Date.UTC(2026,0,1),steps=days*24*60;

function measure(annualBudgetBytes) {
  const store=new Store(':memory:'),recorder=new Recorder(store,{config:{annualBudgetBytes}});
  try {
    const initialBytes=store.databaseBytes(),held=new Map(),errors=new Map();
    let acquisitionValues=0,expectedEnergyKwh=0;
    const began=performance.now();
    for(let i=0;i<steps;i++) {
      const at=start+i*MINUTE;
      if(i===36*60) {
        recorder.energyGap({source:'synthetic',device:'meter',prefix:'property',start:at,end:at+15*MINUTE,quality:['provider-error']});
        for(const signal of ['supply_temperature','outdoor_temperature','solar_radiation'])
          recorder.record({source:'synthetic',device:'sensors',signal,value:null,
            unit:signal==='solar_radiation'?'W/m2':'degC',sourceTime:null,receivedAt:at,quality:['provider-error']});
      }
      if(i>=36*60&&i<36*60+15) continue;
      for(const [signal,value,unit] of [
        ['supply_temperature',35+4*Math.sin(i/150)+0.02*Math.sin(i*2.7),'degC'],
        ['outdoor_temperature',5+4*Math.sin(i/1440*Math.PI*2),'degC'],
        ['solar_radiation',Math.max(0,450*Math.sin((i%1440-360)/1440*Math.PI*2)),'W/m2']]) {
        const result=recorder.record({source:'synthetic',device:'sensors',signal,value,unit,
          sourceTime:at,receivedAt:at,quality:[],raw:{verified:true}});
        if(result.saved) held.set(signal,value);
        const error=value-held.get(signal),sample=errors.get(signal)??{squared:0,max:0,count:0,unit};
        sample.squared+=error*error;sample.max=Math.max(sample.max,Math.abs(error));sample.count++;
        errors.set(signal,sample);acquisitionValues++;
      }
      const powers=[0.8+(Math.floor(i/120)%2)*1.6,0.5,Math.floor(i/360)%2===0?0.1:2];
      const energies=powers.map(power=>power/60);
      expectedEnergyKwh+=energies.reduce((sum,value)=>sum+value,0);
      recorder.recordEnergy({source:'synthetic',device:'meter',prefix:'property',start:at,end:at+MINUTE,
        receivedAt:at+MINUTE,powers,energies,quality:[]});acquisitionValues+=3;
    }
    recorder.flush(start+steps*MINUTE,{force:true});
    const status=recorder.status(start+steps*MINUTE),overview=getDatabaseOverview({store,now:start+steps*MINUTE});
    const storedRows=store.db.prepare('SELECT COUNT(*) count FROM observations').get().count;
    const storedEnergyKwh=store.db.prepare("SELECT SUM(value) value FROM observations WHERE signal LIKE 'property_energy_l%'").get().value;
    const gapRows=store.db.prepare('SELECT COUNT(*) count FROM observations WHERE value IS NULL').get().count;
    if(gapRows!==6||Math.abs(storedEnergyKwh-expectedEnergyKwh)>1e-8)
      throw new Error('Synthetic gap or energy preservation failed');
    return {annualBudgetBytes,days,acquisitionValues,storedRows,gapRows,
      rowReductionPercent:100*(1-storedRows/acquisitionValues),
      prospectiveAdaptiveEstimatedBytes:status.adaptiveEstimatedBytes,
      retainedAdaptiveEstimatedBytes:overview.database.adaptiveEstimatedBytes,
      totalAllocatedGrowthBytes:store.databaseBytes()-initialBytes,
      normalizedTolerance:status.normalizedTolerance,adaptiveProjectedAnnualBytes:status.adaptiveProjectedAnnualBytes,
      expectedEnergyKwh,storedEnergyKwh,absoluteEnergyDifference:Math.abs(storedEnergyKwh-expectedEnergyKwh),
      scalarErrors:Object.fromEntries([...errors].map(([signal,sample])=>[signal,
        {rms:Math.sqrt(sample.squared/sample.count),max:sample.max,unit:sample.unit}])),
      durationMs:Math.round(performance.now()-began)};
  } finally {store.close();}
}

console.log(JSON.stringify({synthetic:true,scope:'Minute acquisition, three changing scalars and three steady/stepped energy phases; one 15-minute source gap.',
  limitations:'Finite synthetic comparison, not an annual convergence, household compression or Raspberry Pi throughput guarantee. Adaptive bytes estimate logical payload and metadata. Total SQLite growth includes recorder support tables, indexes and page overhead. SQL and JavaScript numeric serialization can make the two payload estimates differ slightly.',
  results:[measure(10_000_000_000),measure(100_000_000)]},null,2));
