import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';

test('schema 3 upgrade retains observations and durable samples/cycle assessments resume without duplication', t => {
  const dir=mkdtempSync(join(tmpdir(),'stmq-learning-store-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'fixture.sqlite');
  let store=new Store(path);
  store.observation({source:'synthetic',device:'fixture',signal:'indoor_temperature',value:21,unit:'degC',sourceTime:1000,receivedAt:1000,quality:[]});
  store.close();
  const old=new DatabaseSync(path);
  // Recreate the pre-recorder table layout rather than merely downgrading the
  // version number of a newer schema (which leaves incompatible views behind).
  old.exec(`DROP TABLE learning_samples; DROP TABLE learning_cycles;
    DROP VIEW provider_snapshots;
    DROP INDEX snapshots_content_fetch;
    ALTER TABLE provider_snapshot_fetches DROP COLUMN content_id;
    ALTER TABLE provider_snapshot_fetches DROP COLUMN fetch_metadata;
    ALTER TABLE provider_snapshot_fetches RENAME TO provider_snapshots;
    DROP TABLE provider_snapshot_contents; DROP TABLE recorder_coverage; DROP TABLE recorder_metrics;
    DROP TABLE energy_audits; DROP TABLE learning_journal;
    DROP TABLE chart_rollups; DROP TABLE chart_rollup_meta;
    PRAGMA user_version=3`);old.close();
  store=new Store(path);
  const sample={timestamp:2000,indoorC:21,phase:'normal',solarRadiationWm2:null};
  assert.equal(store.learningSample('mqtt',sample),true);
  assert.equal(store.learningSample('mqtt',{...sample,indoorC:25}),false);
  store.cycle('mqtt',{id:'fixture-cycle',startedAt:2000,status:'active',actual:{auxiliaryRouteKnown:false}});
  store.close();store=new Store(path);
  try {
    assert.equal(store.latestObservation('indoor_temperature').value,21);
    assert.equal(store.learningSamples({input:'mqtt'})[0].indoorC,21);
    assert.equal(store.learningSamples({input:'mqtt',after:1}).length,0);
    assert.equal(store.learningSamples({input:'simulated'}).length,0);
    assert.equal(store.cycles({input:'mqtt',completedOnly:true}).length,0);
    store.cycle('mqtt',{id:'fixture-cycle',startedAt:2000,endedAt:4000,status:'completed',assessment:{profitCents:-12},actual:{auxiliarySpaceObserved:false}});
    const rows=store.cycles({input:'mqtt',completedOnly:true});
    assert.equal(rows.length,1);assert.equal(rows[0].assessment.profitCents,-12);
    assert.equal(rows[0].actual.auxiliarySpaceObserved,false);
  } finally {store.close();}
});
