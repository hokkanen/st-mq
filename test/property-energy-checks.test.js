import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { propertyEnergyCheckSummary } from '../src/app/property-energy-checks.js';

const start = Date.parse('2026-09-01T00:00:00Z'), MINUTE = 60_000;
const SIGNAL = 'property_import_energy_counter';
function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const audit = (minute,value,options = {}) => store.energyAudit({ source:'easee', device:'invented-property',
    signal:SIGNAL, sourceTime:start+minute*MINUTE, receivedAt:start+minute*MINUTE, value, ...options });
  const energy = (from,to,kwh,options = {}) => {
    for (let phase=1;phase<=3;phase++) store.observation({ source:'easee', device:'invented-property',
      signal:`property_energy_l${phase}`, sourceTime:start+to*MINUTE, receivedAt:start+to*MINUTE,
      unit:'kWh', value:kwh/3, quality:['estimated'],
      raw:{intervalStart:start+from*MINUTE,intervalEnd:start+to*MINUTE}, ...options });
  };
  const read = (minute=1000) => propertyEnergyCheckSummary(store,{now:start+minute*MINUTE}).summary;
  return { store,audit,energy,read };
}

test('property meter availability distinguishes no readings and one unchanged retained reading',t=>{
  const {store,audit,read}=fixture(t);
  assert.deepEqual(propertyEnergyCheckSummary(store,{now:start}),{
    kind:'property-meter-summary',signal:SIGNAL,summary:{status:'no-readings',readingCount:0,latestReading:null,
      previousReading:null,coverage:null,comparison:null,lastSuccessfulComparison:null},
  });
  audit(0,123,{receivedAt:start+MINUTE});
  assert.equal(audit(0,123,{receivedAt:start+2*MINUTE}),0);
  const summary=read();
  assert.equal(summary.status,'waiting-for-second-reading');
  assert.equal(summary.readingCount,1);
  assert.deepEqual(summary.latestReading,{valueKwh:123,sourceTime:start,receivedAt:start+MINUTE,transport:null});
  assert.equal(summary.previousReading,null);
  assert.equal(summary.lastSuccessfulComparison,null);
});

test('property result reports a matching period and distinguishes zero meter increase from missing energy',t=>{
  const {store,audit,energy,read}=fixture(t);
  audit(0,100);audit(10,102);energy(0,10,1.8);
  const before=store.db.prepare('SELECT total_changes() AS count').get().count;
  const summary=read();
  assert.equal(summary.status,'compared');
  assert.deepEqual(summary.coverage,{start,end:start+10*MINUTE,coveredMs:10*MINUTE,durationMs:10*MINUTE,conflictingMs:0});
  assert(Math.abs(summary.comparison.differencePercent+10)<1e-10);
  assert.deepEqual(summary.lastSuccessfulComparison,summary.comparison);
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get().count,before,'summary is read-only');
  audit(20,102);energy(10,20,0);
  assert.equal(read().status,'compared');
  assert.equal(read().comparison.meteredKwh,0);
  assert.equal(read().comparison.differencePercent,null);
});

test('a gap reports every usable span and preserves the last complete property comparison',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);audit(20,102);
  energy(0,10,1);energy(10,12,.2);energy(16,20,.4);
  const summary=read();
  assert.equal(summary.status,'incomplete-coverage');
  assert.equal(summary.comparison,null);
  assert.deepEqual(summary.coverage,{start:start+10*MINUTE,end:start+20*MINUTE,
    coveredMs:6*MINUTE,durationMs:10*MINUTE,conflictingMs:0});
  assert.equal(summary.lastSuccessfulComparison.end,start+10*MINUTE);
  assert.equal(summary.lastSuccessfulComparison.meteredKwh,1);
});

test('conflicting and incomplete phase intervals are excluded from usable coverage',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);
  energy(0,5,.5);energy(3,6,.3);energy(6,8,.2);
  // A phase with unavailable energy invalidates its entire three-phase span.
  energy(8,10,.2,{quality:['missing']});
  const summary=read();
  assert.equal(summary.status,'conflicting-coverage');
  assert.equal(summary.coverage.conflictingMs,6*MINUTE);
  assert.equal(summary.coverage.coveredMs,2*MINUTE);
  assert.equal(summary.comparison,null);
  assert.equal(summary.lastSuccessfulComparison,null);
});

test('a counter reset preserves the last successful check and allows a later period on the new baseline',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);energy(0,10,1);
  audit(20,0);energy(10,20,1);
  const reset=read();
  assert.equal(reset.status,'counter-reset');
  assert.equal(reset.latestReading.valueKwh,0);
  assert.equal(reset.previousReading.valueKwh,101);
  assert.equal(reset.coverage,null);
  assert.equal(reset.comparison,null);
  assert.equal(reset.lastSuccessfulComparison.end,start+10*MINUTE);
  audit(30,1);energy(20,30,1);
  assert.equal(read().status,'compared');
  assert.equal(read().comparison.start,start+20*MINUTE);
});

test('an older meter timestamp received last is explicit and cannot replace the comparison baseline',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);energy(0,10,1);
  audit(5,100.5,{receivedAt:start+20*MINUTE});
  const late=read();
  assert.equal(late.status,'out-of-order-counter');
  assert.equal(late.latestReading.sourceTime,start+5*MINUTE);
  assert.equal(late.latestReading.receivedAt,start+20*MINUTE);
  assert.equal(late.previousReading.sourceTime,start+10*MINUTE);
  assert.equal(late.comparison,null);
  assert.equal(late.lastSuccessfulComparison.end,start+10*MINUTE);
  audit(30,103);energy(10,30,2);
  assert.equal(read().comparison.start,start+10*MINUTE);
});

test('a changed value at the same meter timestamp cannot seed the next comparison',t=>{
  const {store,audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);energy(0,10,1);
  audit(10,999,{receivedAt:start+20*MINUTE});
  assert.equal(read().status,'out-of-order-counter');
  assert.equal(read().latestReading.valueKwh,999);
  assert.equal(read().lastSuccessfulComparison.meteredKwh,1);
  audit(30,103);energy(10,30,2);
  assert.equal(read().status,'compared');
  assert.equal(read().previousReading.valueKwh,101);
  assert.equal(read().comparison.meteredKwh,2);
  assert.equal(store.energyAudits({now:start+40*MINUTE}).at(-1).comparison.meteredKwh,2,
    'individual stored-check consumers use the same valid baseline');
});

test('counter and energy evidence respect both source and receipt cutoffs when the clock moves',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101,{receivedAt:start+20*MINUTE});
  energy(0,10,1,{receivedAt:start+30*MINUTE});
  assert.equal(read(15).status,'waiting-for-second-reading');
  assert.equal(read(20).status,'incomplete-coverage');
  assert.equal(read(20).coverage.coveredMs,0);
  assert.equal(read(30).status,'compared');
  assert.equal(read(20).lastSuccessfulComparison,null,'future receipts cannot survive a clock rollback');
  audit(40,102,{receivedAt:start+35*MINUTE});
  assert.equal(read(35).latestReading.sourceTime,start+10*MINUTE,'future meter timestamps are ineligible');
  assert.equal(read(40).latestReading.sourceTime,start+40*MINUTE);
  assert.equal(read(15).readingCount,1);
});

test('counts, baselines and successful checks stay within the latest equipment and source',t=>{
  const {store,audit,energy,read}=fixture(t);
  audit(0,100);audit(10,101);energy(0,10,1);
  audit(20,102,{source:'invented-provider'});
  assert.equal(read().status,'waiting-for-second-reading');
  assert.equal(read().readingCount,1);
  assert.equal(read().lastSuccessfulComparison,null);
  audit(30,103,{source:'invented-provider',device:'invented-replacement'});
  assert.equal(read().readingCount,1);
  assert.equal(read().previousReading,null);
  assert(!JSON.stringify(propertyEnergyCheckSummary(store,{now:start+40*MINUTE})).includes('invented-'));
});

test('the last complete comparison remains available beyond the ordinary audit page limit',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(1,101);energy(0,1,1);
  for(let minute=2;minute<=105;minute++)audit(minute,100+minute);
  const summary=read();
  assert.equal(summary.readingCount,106);
  assert.equal(summary.status,'incomplete-coverage');
  assert.equal(summary.lastSuccessfulComparison.end,start+MINUTE);
});

test('fallback streams long partial history once per batch without per-counter predecessor lookups',t=>{
  const {store,audit,energy,read}=fixture(t);
  audit(0,100);audit(1,101);energy(0,1,1);
  for(let minute=2;minute<=105;minute++) {
    audit(minute,100+minute);
    energy(minute-.5,minute,.5);
  }
  store.previousEnergyAudit=()=>{throw new Error('fallback must not perform per-counter predecessor queries');};
  const summary=read();
  assert.equal(summary.status,'incomplete-coverage');
  assert.equal(summary.coverage.coveredMs,MINUTE/2);
  assert.equal(summary.lastSuccessfulComparison.end,start+MINUTE);
});

test('shared fallback evidence can span counter boundaries while retaining the most recent complete period',t=>{
  const {audit,energy,read}=fixture(t);
  audit(0,100);audit(1,101);audit(2,102);audit(3,103);audit(4,104);
  energy(0,3,3);
  const summary=read();
  assert.equal(summary.status,'incomplete-coverage');
  assert.equal(summary.lastSuccessfulComparison.start,start+2*MINUTE);
  assert.equal(summary.lastSuccessfulComparison.end,start+3*MINUTE);
  assert.equal(summary.lastSuccessfulComparison.meteredKwh,1);
  assert.equal(summary.lastSuccessfulComparison.edgeEstimated,true);
});
