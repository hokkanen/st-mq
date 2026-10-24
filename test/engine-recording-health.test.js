import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { Recorder } from '../src/storage/recorder.js';
import { createRecordingHealth } from '../src/app/recording-health.js';
import { createAppServer } from '../src/app/server.js';
import { recordingRows } from '../chart/recording.js';

const MINUTE = 60_000, START = Date.parse('2026-10-11T14:28:00Z');
const stateRow = recording => recording.exactParameters.find(row=>row.signal === 'caravan_dehumidifier_state');
function fixture(t) {
  let now = START;
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input:'mqtt',connections:{},settings:{} },clock:()=>now });
  const health = createRecordingHealth({ clock:()=>now,
    backupCatalog:{async list() {return {copies:[],complete:true,reasons:[],checkedAt:now};}} });
  t.after(async()=>{
    engine.beginShutdown({restore:false});
    await engine.charging.close(); await engine.garage.close({restore:false});
    await engine.closeFireplace(); await engine.executor.close({restore:false}); store.close();
  });
  return {store,engine,health,now:()=>now,advance:ms=>{now+=ms;},
    put:(value,quality=[])=>engine.ingest({source:'mqtt-equipment',device:'synthetic-caravan-appliance',
      signal:'caravan_dehumidifier_state',value,unit:'state',sourceTime:value === null ? null : now,
      receivedAt:now,quality,raw:{timeBasis:value === null ? 'availability-transition' : 'mqtt-live-status'}}),
    status:()=>health.status({store,engine,current:engine.latestStatus})};
}

test('status and independent health use committed recovery and loss between controller updates without writes', async t=>{
  const f = fixture(t);
  f.put(null,['location-unconfirmed']);
  await f.store.runWrite(()=>f.engine.tick());
  assert.equal(stateRow(f.engine.latestStatus.recording).freshness.status,'unavailable');
  f.advance(500); f.put(1);
  const cached = structuredClone(f.engine.latestStatus);
  const changes = f.store.db.prepare('SELECT total_changes() n').get().n;
  t.mock.method(f.engine,'tick',()=>{throw new Error('A status read must not run control');});
  t.mock.method(f.engine.recorder,'status',()=>{throw new Error('A status read must not scan recording statistics');});
  let current = f.engine.status(), health = await f.status();
  assert.equal(stateRow(current.recording).freshness.status,'fresh');
  assert.equal(stateRow(current.recording).lastPollAt,f.now());
  assert.deepEqual(stateRow(current.recording).day,stateRow(cached.recording).day,'recording statistics retain their tick boundary');
  assert.equal(health.recording.state,'ok');
  assert.equal(health.recording.lastLoopCompletedAt,START);
  assert.equal(health.recording.lastSourceCheckAt,START+500);
  assert.deepEqual(health.recording.sources.issues,[]);
  assert.deepEqual(f.engine.latestStatus,cached,'refreshing presentation cannot renew the controller completion clock');

  f.advance(500); f.put(null,['state-evidence-unavailable','synthetic-private-diagnostic']);
  const afterLoss = f.store.db.prepare('SELECT total_changes() n').get().n;
  current = f.engine.status(); health = await f.status();
  assert.equal(stateRow(current.recording).freshness.status,'unavailable');
  assert.equal(health.recording.state,'source-unavailable');
  assert.equal(health.recording.sources.issues[0].lastCheckedAt,START+1000);
  assert.equal(health.recording.sources.issues[0].sourceObservedAt,START+500,'a lost source keeps its earlier measurement clock');
  assert.match(health.recording.sources.issues[0].reason,/fresh fan report while On/);
  assert(!JSON.stringify(health).includes('synthetic-private'));
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,afterLoss);
  assert.ok(afterLoss>changes,'the source loss was an actual recorder write before the read');

  f.advance(500); f.put(2);
  const afterRecovery = f.store.db.prepare('SELECT total_changes() n').get().n;
  const refreshed = await f.status();
  assert.equal(refreshed.recording.state,'ok');
  assert.deepEqual(refreshed.recording.sources.issues,[]);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,afterRecovery);
});

test('health includes streams first observed between updates while detail rows await real statistics', async t=>{
  const f = fixture(t);
  await f.store.runWrite(()=>f.engine.tick());
  assert.equal(stateRow(f.engine.latestStatus.recording),undefined);
  f.advance(1000); f.put(1);
  assert.equal(stateRow(f.engine.status().recording),undefined);
  const healthy = await f.status();
  assert.equal(healthy.recording.state,'ok');
  assert.equal(healthy.recording.sources.observedStreams,1);
  assert.equal(healthy.recording.lastSourceCheckAt,START+1000);
  f.advance(1000); f.put(null,['location-unconfirmed']);
  const lost = await f.status();
  assert.equal(lost.recording.state,'source-unavailable');
  assert.equal(lost.recording.sources.issues[0].label,'Caravan dehumidifier state');
  await f.store.runWrite(()=>f.engine.tick());
  const row = stateRow(f.engine.status().recording);
  assert.equal(row.observedThisRun,true);
  assert.equal(row.day.records,2,'new detail rows contain actual saved statistics');
});

test('an adaptive source first observed between updates cannot show an invented zero-record day', async t=>{
  const f = fixture(t);
  await f.store.runWrite(()=>f.engine.tick());
  f.advance(1000);
  f.engine.ingest({source:'synthetic',device:'synthetic-pump',signal:'supply_temperature',value:35,unit:'degC',
    sourceTime:f.now(),receivedAt:f.now(),quality:[]});
  assert.equal((await f.status()).recording.sources.usableStreams,1);
  assert.equal(recordingRows(f.engine.status().recording).find(row=>row.signal==='supply_temperature'),undefined);
  await f.store.runWrite(()=>f.engine.tick());
  const row = recordingRows(f.engine.status().recording).find(row=>row.signal==='supply_temperature');
  assert.equal(row.savedDay.records,1);
});

test('current source reads cannot hide storage failure, loop stall or read-only scope', async t=>{
  const f = fixture(t);
  f.put(1); await f.store.runWrite(()=>f.engine.tick());
  await f.status();
  f.store.writeHealth.failure({code:'ENOSPC'});
  assert.equal((await f.status()).recording.state,'write-failed');
  f.advance(3*MINUTE+1); f.put(2);
  assert.equal((await f.status()).recording.state,'stalled','fresh acquisition cannot pretend a controller tick completed');
  t.mock.method(f.engine,'recordingSourceStatus',()=>{throw new Error('Replica must not inspect live source evidence');});
  const replica = await f.health.status({store:f.store,engine:f.engine,current:f.engine.latestStatus,readOnly:true});
  assert.equal(replica.recording.state,'read-only');
  assert.equal(replica.recording.sources,null);
  assert.equal(replica.recording.lastLoopCompletedAt,null);
});

test('an independent health read fails source evidence closed while preserving storage and loop diagnostics', async t=>{
  const f = fixture(t);
  f.put(1); await f.store.runWrite(()=>f.engine.tick());
  assert.equal((await f.status()).recording.state,'ok');
  t.mock.method(f.engine,'recordingSourceStatus',()=>{throw new Error('synthetic-private-database-details');});
  let current = await f.status();
  assert.equal(current.recording.state,'unknown');
  assert.equal(current.recording.sources,null);
  assert.equal(current.recording.lastLoopCompletedAt,START);
  assert(!JSON.stringify(current).includes('synthetic-private'));
  f.store.writeHealth.failure({code:'ENOSPC'});
  assert.equal((await f.status()).recording.state,'write-failed');
  f.store.writeHealth.success(); f.advance(3*MINUTE+1);
  assert.equal((await f.status()).recording.state,'stalled');
});

test('invalid current source metadata cannot fall back to a previous healthy controller snapshot', async t=>{
  const f = fixture(t);
  f.put(1); await f.store.runWrite(()=>f.engine.tick());
  let recording;
  t.mock.method(f.engine,'recordingSourceStatus',()=>recording);
  for (recording of [undefined,null,[],{parameters:{}},{exactParameters:[{}]}]) {
    const current = await f.status();
    assert.equal(current.recording.state,'unknown');
    assert.equal(current.recording.sources,null);
  }
});

test('health evaluates source reports received during its bounded asynchronous refresh at the later local time', async t=>{
  const f = fixture(t);
  f.put(null,['location-unconfirmed']); await f.store.runWrite(()=>f.engine.tick());
  let begun, release;
  const started = new Promise(resolve=>{begun=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  const health = createRecordingHealth({clock:f.now,backupCatalog:{async list() {
    begun(); await gate; return {copies:[],complete:true,reasons:[],checkedAt:f.now()};
  }}});
  const pending = health.status({store:f.store,engine:f.engine,current:f.engine.latestStatus});
  await started;
  f.advance(600); f.put(1); release();
  const current = await pending;
  assert.equal(current.checkedAt,START+600);
  assert.equal(current.recording.lastSourceCheckAt,START+600);
  assert.equal(current.recording.state,'ok');
  assert.deepEqual(current.recording.sources.issues,[]);
});

test('both authenticated endpoints clear a cached Caravan gap before the next controller update', async t=>{
  const f = fixture(t), token = 'synthetic-recording-health-token';
  f.put(null,['location-unconfirmed']); await f.store.runWrite(()=>f.engine.tick());
  const server = createAppServer({store:f.store,engine:f.engine,chartService:{overview() {}},token,recordingHealth:f.health});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async path=>{
    const response = await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(response.status,200); return response.json();
  };
  const lost = await get('/api/recording-health');
  assert.match(lost.recording.sources.issues[0].reason,/power check and fresh appliance\/meter reports/);
  f.advance(600); f.put(1);
  const changes = f.store.db.prepare('SELECT total_changes() n').get().n;
  t.mock.method(f.engine,'tick',()=>{throw new Error('GET must not run control');});
  t.mock.method(f.engine.recorder,'status',()=>{throw new Error('GET must not scan recording statistics');});
  const health = await get('/api/recording-health'), current = await get('/api/status');
  assert.equal(health.recording.state,'ok');
  assert.equal(current.recordingHealth.recording.state,'ok');
  assert.deepEqual(health.recording.sources.issues,[]);
  assert.deepEqual(current.recordingHealth.recording.sources.issues,[]);
  assert.equal(stateRow(current.recording).freshness.status,'fresh');
  assert.equal(health.recording.lastLoopCompletedAt,START);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('lightweight source status uses current coverage clocks and never queries measurement history or statistics', t=>{
  const store = new Store(':memory:'); t.after(()=>store.close());
  let now = START;
  const recorder = new Recorder(store,{clock:()=>now});
  const reading = {source:'mqtt-temperature',device:'synthetic-room',signal:'indoor_temperature',value:21,
    unit:'degC',quality:[],raw:{reportIntervalMs:MINUTE,reportGraceMs:0}};
  recorder.record({...reading,sourceTime:now,receivedAt:now});
  now += MINUTE/2;
  assert.equal(recorder.record({...reading,sourceTime:now,receivedAt:now}).saved,false);
  const detail = recorder.status(now), changes = store.db.prepare('SELECT total_changes() n').get().n;
  const prepare = store.db.prepare.bind(store.db);
  const queries = [];
  t.mock.method(store.db,'prepare',sql=>{
    queries.push(sql);
    assert(!/observations|recorder_metrics|provider_snapshot|recorder:energy|PRAGMA/i.test(sql),'source evidence must not scan saved history or statistics');
    return prepare(sql);
  });
  let row = recorder.sourceStatus(now).exactParameters[0];
  assert.equal(row.freshness.sourceObservedAt,START+MINUTE/2);
  assert.equal(row.lastSavedAt,START,'an unchanged report does not fabricate a saved observation');
  for (const [key,value] of Object.entries(row)) assert.deepEqual(value,detail.exactParameters[0][key],key);
  now += MINUTE;
  row = recorder.sourceStatus(now).exactParameters[0];
  assert.equal(row.freshness.status,'stale');
  assert.deepEqual(row.freshness.reasons,['missing-report']);
  assert.equal(row.freshness.sourceObservedAt,START+MINUTE/2);
  assert.equal(prepare('SELECT total_changes() n').get().n,changes);
  assert(queries.every(sql=>/^SELECT value FROM state|^SELECT source_time,evidence FROM recorder_coverage WHERE id=\?/.test(sql)));
});
