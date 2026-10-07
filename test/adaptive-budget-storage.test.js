import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { ADAPTIVE_BUDGET_KEY, initialAdaptiveBudget } from '../src/storage/adaptive-recording-budget.js';
import { STORAGE_METRICS_KEY, initialStorageMetrics } from '../src/storage/recording-metrics.js';

function database(t, saved, key=ADAPTIVE_BUDGET_KEY) {
  const directory=mkdtempSync(join(tmpdir(),'stmq-adaptive-preflight-')),path=join(directory,'synthetic.sqlite');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(path);
  if(saved!==undefined)store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)')
    .run(key,saved,1000);
  store.setState('synthetic-preserved-history',{value:42});
  // A writable Store normally changes this header back to WAL; rejecting only
  // during Engine/Recorder construction is already too late to preserve bytes.
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');store.close();
  return path;
}

test('adaptive budget rejection precedes writable setup and leaves the entire database unchanged',async t=>{
  for(const [name,value] of [
    ['unsupported-version',JSON.stringify({...initialAdaptiveBudget(1000),version:2})],
    ['retired-field',JSON.stringify({...initialAdaptiveBudget(1000),oldTotalBytes:0})],
    ['incomplete-shape',JSON.stringify({version:1})],
    ['invalid-counter',JSON.stringify({...initialAdaptiveBudget(1000),measuredBytes:1})],
    ['explicit-null','null'],['unreadable-json','{"version":1'],
  ])await t.test(name,t=>{
    const path=database(t,value),before=readFileSync(path);
    for(const readOnly of [false,true]) {
      assert.throws(()=>new Store(path,{readOnly}),error=>error.code==='ADAPTIVE_RECORDING_BUDGET_UNSUPPORTED');
      assert.deepEqual(readFileSync(path),before,'Rejection cannot change journal mode, state or history');
    }
  });
});

test('absent prospective budget remains absent during read-only startup and valid current state survives restart',t=>{
  for(const saved of [undefined,JSON.stringify({...initialAdaptiveBudget(1000),estimatedBytes:1234})]) {
    const path=database(t,saved),before=readFileSync(path),store=new Store(path,{readOnly:true});
    const recorder=new Recorder(store),status=recorder.status(1000);
    assert.equal(status.adaptiveEstimatedBytes,saved===undefined?0:1234);
    assert.equal(status.adaptiveAccountingStartedAt,saved===undefined?null:1000);
    assert.equal(store.getState('synthetic-preserved-history').value,42);
    store.close();assert.deepEqual(readFileSync(path),before);
    const writable=new Store(path);
    assert.equal(new Recorder(writable).status(1000).adaptiveEstimatedBytes,status.adaptiveEstimatedBytes);
    writable.close();
  }
});

test('current storage metrics reject malformed or retired fields before mutation',async t=>{
  for(const [name,value] of [
    ['unsupported-version',JSON.stringify({...initialStorageMetrics(0,0),version:2})],
    ['retired-controller-field',JSON.stringify({...initialStorageMetrics(0,0),tolerance:0.02})],
    ['incomplete-shape',JSON.stringify({version:1})],
    ['invalid-counter',JSON.stringify({...initialStorageMetrics(0,0),measuredBytes:-1})],
    ['explicit-null','null'],['unreadable-json','{"version":1'],
  ])await t.test(name,t=>{
    const path=database(t,value,STORAGE_METRICS_KEY),before=readFileSync(path);
    for(const readOnly of [false,true]) {
      assert.throws(()=>new Store(path,{readOnly}),error=>error.code==='RECORDING_STORAGE_METRICS_UNSUPPORTED');
      assert.deepEqual(readFileSync(path),before);
    }
  });
});

test('current storage metrics retain signed pruning boundaries and restart without rewriting diagnostic state',t=>{
  const saved=JSON.stringify({...initialStorageMetrics(0,1234),energyRevision:7});
  const path=database(t,saved,STORAGE_METRICS_KEY),before=readFileSync(path),store=new Store(path,{readOnly:true});
  assert.equal(store.getState(STORAGE_METRICS_KEY).metricsPrunedBefore,-7*24*3_600_000);
  const status=new Recorder(store).status(0);
  assert.equal(JSON.parse(status.historyRevision).energy,7);
  assert.equal(status.totalDatabaseMeasurementHours,0);
  store.close();assert.deepEqual(readFileSync(path),before);
});

test('retired global cache bytes are never read, translated or changed when new storage metrics start',t=>{
  const retiredKey='recorder:global:v2',retiredBytes='{"unsupported retired cache":';
  const path=database(t,retiredBytes,retiredKey),before=readFileSync(path),reader=new Store(path,{readOnly:true});
  const status=new Recorder(reader).status(1000);
  assert.equal(status.totalDatabaseMeasurementHours,0);
  assert.equal(status.totalDatabaseProjectedAnnualBytes,0);
  assert.equal(status.normalizedTolerance,0.02);
  assert.equal(reader.getState(STORAGE_METRICS_KEY),null);
  reader.close();assert.deepEqual(readFileSync(path),before);
  const store=new Store(path),recorder=new Recorder(store);
  recorder.record({source:'synthetic',device:'fixture',signal:'indoor_temperature',value:20,
    unit:'degC',sourceTime:1000,receivedAt:1000,quality:[]});
  assert.equal(store.getState(STORAGE_METRICS_KEY).version,1);
  assert.equal(store.getState(STORAGE_METRICS_KEY).energyRevision,0);
  assert.equal(store.db.prepare('SELECT value FROM state WHERE key=?').get(retiredKey).value,retiredBytes);
  store.close();
});
