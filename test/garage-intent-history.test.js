import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { getChartData } from '../src/app/chart-data.js';
import { garageIntent } from './helpers/garage-intent.js';
import { garageIntentKey, recordGarageIntent, validateGarageIntent } from '../src/garage/intent-history.js';
import { historyTooltipLabel } from '../chart/history-tooltips.js';

const DAY = 86400000, start = Date.parse('2026-10-20T00:00:00+03:00');
const chart = (store, extra = {}) => getChartData({ store, input: 'providers', now: start + 4 * DAY,
  startDate: '2026-10-22', endDate: '2026-10-23', left: 'garage_away_mode', ...extra });
const bars = result => result.shading.garage_away_mode;
function fixture(t) { const store = new Store(':memory:'); t.after(() => store.close()); return store; }

test('saved Normal and Away cover later days without reports, preserve clocks and never imply device operation', t => {
  const store = fixture(t);
  garageIntent(store, start, { mode: 'normal' });
  garageIntent(store, start + 3 * DAY, { mode: 'away' });
  const result = chart(store), rows = bars(result);
  assert.deepEqual(rows.map(({start:from,end,value})=>[from,end,value]),
    [[start+2*DAY,start+3*DAY,0],[start+3*DAY,start+4*DAY,1]]);
  assert.equal(rows[0].selectedAt, start);
  assert.equal(rows[1].selectedAt, start + 3 * DAY);
  assert(rows.every(row => row.savedIntent && row.requested));
  assert(result.series.garage_away_mode.filter(p=>p.y===0).every(p=>p.observedAt===start));
  assert(!JSON.stringify(result).includes('a'.repeat(64)), 'Physical identities stay private');
  const text = historyTooltipLabel({dataset:{key:'garage_away_mode',label:'Selection',unit:'state'},
    raw:result.series.garage_away_mode[0],parsed:{x:start+2*DAY,y:0}});
  assert.match(text,/identity-bound intent; not device readback/);
  assert.match(text,/selected/);
});

test('equipment and route boundaries end the old scope, and same mode edits retain distinct source clocks', t => {
  const store = fixture(t);
  garageIntent(store, start, { mode:'away' });
  garageIntent(store, start+2*DAY, { mode:null, identity:'c' });
  garageIntent(store, start+3*DAY, { mode:'away', identity:'c' });
  garageIntent(store, start+3.5*DAY, { mode:'away', identity:'c', normalTargetC:12 });
  garageIntent(store, start+3.75*DAY, { mode:null, identity:'c', route:'d' });
  const rows = bars(chart(store));
  assert.deepEqual(rows.map(r=>[r.start,r.end,r.value]),[[start+3*DAY,start+3.5*DAY,1],[start+3.5*DAY,start+3.75*DAY,1]]);
  assert.notEqual(rows[0].scopeRevision,rows[1].scopeRevision);
  assert.equal(rows[1].selectedAt,start+3.5*DAY);
});

test('disabled scope stays blank; reenabling retains the original intent clock without filling the gap', t => {
  const store=fixture(t);
  garageIntent(store,start,{mode:'away'});
  garageIntent(store,start+2*DAY,{enabled:false,mode:'away',selectedAt:start});
  garageIntent(store,start+3*DAY,{mode:'away',selectedAt:start,basis:'retained-intent'});
  const result=chart(store);
  assert.deepEqual(bars(result).map(r=>[r.start,r.end,r.value]),[[start+3*DAY,start+4*DAY,1]]);
  assert.equal(bars(result)[0].selectedAt,start);
});

test('restart deduplication, first establishment, as-of bounds and source namespaces are explicit', t => {
  const store=fixture(t),at=start+2.5*DAY;
  garageIntent(store,at,{mode:'away',selectedAt:start,basis:'retained-intent'});
  const before=store.events().length;
  garageIntent(store,at+1000,{mode:'away',selectedAt:start,basis:'retained-intent'});
  assert.equal(store.events().length,before,'Restart does not manufacture another selection');
  garageIntent(store,start+3*DAY,{mode:'normal',input:'simulated'});
  garageIntent(store,start+3*DAY,{mode:'normal'});
  const past=chart(store,{now:start+2.75*DAY});
  assert.deepEqual(bars(past).map(r=>[r.start,r.end,r.value]),[[at,start+2.75*DAY,1]]);
  assert.equal(bars(past)[0].selectedAt,start);
  assert.deepEqual(bars(chart(store,{input:'mqtt'})),[]);
  assert.equal(bars(chart(store,{input:'simulated'}))[0].value,0);
  const detail=chart(store,{viewFrom:start+2.6*DAY,viewTo:start+2.7*DAY});
  assert.equal(bars(detail)[0].selectedAt,start);
  assert.equal(bars(detail)[0].start,start+2.6*DAY);
});

test('unknown formats fail closed, journaled head and event roll back together, and native observations cannot fill intent', t => {
  const store=fixture(t);
  assert.throws(()=>validateGarageIntent({version:0}),/Unsupported Garage intent/);
  garageIntent(store,start,{mode:'normal'});
  const previous=store.getState(garageIntentKey('providers')),events=store.events();
  assert.throws(()=>store.transaction(()=>{garageIntent(store,start+DAY,{mode:'away'});throw Error('rollback')}),/rollback/);
  assert.deepEqual(store.getState(garageIntentKey('providers')),previous);
  assert.deepEqual(store.events(),events);
  const empty=fixture(t);
  empty.observation({source:'stmq',device:'invented',signal:'garage_away_mode',unit:'state',value:1,
    sourceTime:start+2*DAY,receivedAt:start+2*DAY,raw:{requested:true}});
  assert.deepEqual(bars(chart(empty)),[],'Unscoped scalar records do not become a durable intent timeline');
  const before=store.checkpoint();store.db.exec('PRAGMA query_only=ON');chart(store);
  assert.deepEqual(store.checkpoint(),before,'Historical projections are read-only');
});

test('Finnish autumn day stays 25 hours and native report expiry remains independent of durable intent',async t=>{
  const store=fixture(t),{Recorder}=await import('../src/storage/recorder.js');
  const from=Date.parse('2026-10-25T00:00:00+03:00'),to=Date.parse('2026-10-26T00:00:00+02:00');
  garageIntent(store,start,{mode:'normal'});
  const recorder=new Recorder(store);
  recorder.record({source:'garage-adapter',device:'invented-pump',signal:'garage_native_power',value:1,unit:'state',
    sourceTime:from,receivedAt:from,quality:[],raw:{reportIntervalMs:60000,reportGraceMs:0}});
  const result=chart(store,{view:'garage',left:undefined,startDate:'2026-10-25',endDate:'2026-10-25',now:to});
  assert.equal(bars(result).reduce((sum,r)=>sum+r.end-r.start,0),25*3600000);
  assert(result.shading.garage_native_power.every(r=>r.end<=from+60000));
  assert.equal(bars(result)[0].selectedAt,start);
});
