import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, observation, recover, start } from './helpers/recovery-fixture.js';
import { recoveryPreview, recoverHistory, previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { Store } from '../src/storage/store.js';
import { scopeIncrementalSource,openJournalSource } from '../src/recovery/incremental-source.js';
import { commonCheckpoint, changedRecordKeys } from '../src/storage/journal.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';
import { PeerTransfers } from '../src/replication/coalesced.js';
import { validRecoverySourceSummary } from '../src/recovery/coverage-report.js';

async function peerDonor(f){enrollJournalPeer(f.master.db);return f.donor();}

async function journalSource(f,donor,{truncate=false,corrupt=false,retired=false}={}) {
  const transfers=new PeerTransfers(join(f.directory,'peer-wire'));
  const metadata=await transfers.export({dbPath:donor.path,after:enrollJournalPeer(f.master.db).checkpoint});
  const lines=(await readFile(join(transfers.directory,`peer-${metadata.id}.changes`),'utf8')).trimEnd().split('\n');
  if(corrupt){const change=JSON.parse(lines[1]);change.afterHash='0'.repeat(64);lines[1]=JSON.stringify(change);}
  if(retired)lines[0]=JSON.stringify({version:2,base:metadata.base,checkpoint:metadata.target});
  if(truncate) lines.pop();
  const path=join(f.directory,`source-${truncate}-${corrupt}.ndjson`);
  await writeFile(path,lines.join('\n')+'\n',{mode:0o600});
  return path;
}

test('shared checkpoint review scans only changed records and keeps a pinned WAL source',async t=>{
  const f=fixture(t);
  for(let batch=0;batch<2000;batch+=128)f.master.transaction(()=>{for(let i=batch;i<Math.min(batch+128,2000);i++) f.master.event('synthetic-old-history',{padding:'x'.repeat(4096)},start+i);});
  const donor=await peerDonor(f);
  observation(donor,start+10000,22);
  const before=await readdir(f.directory),phases=[];
  const preview=await recoveryPreview({masterPath:f.master.path,donorPath:donor.path,signal:t.signal,onProgress:p=>phases.push(p.phase)});
  assert.equal(preview.incremental.records,1);
  assert.equal(preview.tables.find(row=>row.name==='events').count,0);
  assert.equal(preview.tables.find(row=>row.name==='observations').count,1);
  assert.equal(preview.coverage,undefined);
  assert.equal(validRecoverySourceSummary(preview.sourceSummary),true);
  assert.deepEqual(preview.sourceSummary.categories.find(row=>row.name==='temperatures'),
    {name:'temperatures',count:1,from:start+10000,to:start+10000,undated:0});
  assert.equal(preview.sourceSummary.categories.find(row=>row.name==='events').count,0,
    'Older common history never leaks into the changed-record date inventory');
  assert.equal(validRecoverySourceSummary({...preview.sourceSummary,path:'/invented/private.sqlite'}),false);
  const scoped=new Store(donor.path,{readOnly:true});
  try {
    scoped.db.exec('BEGIN');
    const base=commonCheckpoint(f.master.db,scoped.db),checkpoint=scoped.checkpoint();
    await scopeIncrementalSource(scoped,{base,checkpoint,yieldControl:async()=>{},changes:changedRecordKeys(scoped.db,{after:base,through:checkpoint})});
    for(const table of ['events','observations']) {
      const plan=scoped.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM active_${table} ORDER BY id`).all().map(row=>row.detail);
      const scratch=scoped.db.prepare(`SELECT COUNT(*) n FROM recovery_source_rows_${table}`).get().n;
      assert.equal(scratch,table==='events'?0:1,`${table}: scratch contains only changed records`);
      assert(!plan.some(detail=>/MATERIALIZE/.test(detail)),`${table}: no historical view materialization`);
      const aggregate=scoped.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM active_${table}`).all().map(row=>row.detail);
      assert(!aggregate.some(detail=>/MATERIALIZE/.test(detail)),`${table}: aggregate stays within delta scratch`);
    }
  } finally {scoped.close();}
  assert(!phases.includes('snapshotting'));
  assert.deepEqual(await readdir(f.directory),before);
  const result=await recoverHistory({store:f.master,donorPath:donor.path,preview,signal:t.signal});
  assert.equal(result.report.imported,1);
  t.diagnostic(`Historical database bytes: ${(await stat(f.master.path)).size}; reviewed source records: ${preview.incremental.records}`);
});

test('divergent peer journal overlays common evidence without replacing local rows or copying database',async t=>{
  const f=fixture(t);
  const original=observation(f.master,start,20);
  const donor=await peerDonor(f);
  observation(f.master,start+1000,21);
  observation(donor,start+2000,22);
  donor.db.prepare('INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('synthetic','invented-house','indoor_temperature','fresh',start,start,start,original,1);
  const donorJournalPath=await journalSource(f,donor),before=await readdir(f.directory);
  const source=await openJournalSource({masterPath:f.master.path,journalPath:donorJournalPath,yieldControl:async()=>{}});
  try {
    for(const name of ['active_observations','active_recorder_coverage','recovery_source_journal']) {
      const plan=source.db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${name}`).all().map(row=>row.detail);
      assert(!plan.some(detail=>/MATERIALIZE/.test(detail)),`${name}: journal overlay aggregates never materialize historical data`);
    }
  } finally {source.close();}
  const args={masterPath:f.master.path,donorJournalPath,signal:t.signal};
  const preview=await recoveryPreview(args);
  assert.equal(preview.incremental.records,3,'changed observation and coverage retain the referenced common observation');
  const result=await recoverHistory({...args,store:f.master,preview});
  assert.deepEqual(f.master.observations().map(row=>row.value),[20,21,22]);
  assert.equal(result.report.counts.duplicates,1);
  assert.deepEqual(await readdir(f.directory),before);
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});

for(const mode of ['truncate','corrupt','retired']) test(`unsupported or damaged peer transfer (${mode}) leaves target untouched`,async t=>{
  const f=fixture(t),donor=await peerDonor(f);observation(donor,start,22);
  const donorJournalPath=await journalSource(f,donor,{[mode]:true}),before=f.master.checkpoint();
  await assert.rejects(recoveryPreview({masterPath:f.master.path,donorJournalPath,signal:t.signal}));
  assert.deepEqual(f.master.checkpoint(),before);
  assert.equal(f.master.observations().length,0);
});

test('history-only revert uses temporary review state and preserves the model epoch',async t=>{
  const f=fixture(t),donor=await peerDonor(f);observation(donor,start,22);
  const result=await recover(f,await f.snapshot(donor));
  const args={store:f.master,recoveryId:result.report.recoveryId,active:false,signal:t.signal};
  const before=f.master.checkpoint(),epoch=f.master.learningEpoch('mqtt'),files=await readdir(f.directory),phases=[];
  const preview=await previewRecoveryRevision({...args,onProgress:value=>phases.push(value.phase)});
  assert.deepEqual(f.master.checkpoint(),before);
  assert.deepEqual(await readdir(f.directory),files);
  assert(!phases.includes('snapshotting'));
  assert.equal(preview.model.status,'unchanged');
  const revision=await reviseRecovery({...args,preview});
  assert.equal(revision.report.model.status,'unchanged');
  assert.equal(f.master.learningEpoch('mqtt'),epoch);
  assert.equal(f.master.observations().length,0);
});

test('compact state and coverage changes reconstruct divergent recovery overlays exactly',async t=>{
  const f=fixture(t),id=observation(f.master,start,20);
  f.master.db.prepare('INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('synthetic','invented-house','indoor_temperature','fresh',start,start,start,id,1);
  f.master.setState('synthetic-overlay',{padding:'x'.repeat(10000),value:'shared'});
  const donor=await peerDonor(f);
  f.master.setState('synthetic-overlay',{padding:'x'.repeat(10000),value:'local'});
  f.master.db.prepare('UPDATE recorder_coverage SET end_at=?,samples=? WHERE id=1').run(start+1000,2);
  donor.setState('synthetic-overlay',{padding:'x'.repeat(10000),value:'donor'});
  donor.db.prepare('UPDATE recorder_coverage SET end_at=?,samples=? WHERE id=1').run(start+2000,3);
  const donorJournalPath=await journalSource(f,donor);
  const source=await openJournalSource({masterPath:f.master.path,journalPath:donorJournalPath,yieldControl:async()=>{}});
  try {
    assert.deepEqual(source.getState('synthetic-overlay'),{padding:'x'.repeat(10000),value:'donor'});
    const coverage=source.db.prepare('SELECT * FROM active_recorder_coverage WHERE id=1').get();
    assert.equal(coverage.start_at,start);assert.equal(coverage.end_at,start+2000);assert.equal(coverage.samples,3);
    assert.equal(coverage.source_time,start,'unchanged original source time is preserved');
  } finally {source.close();}
  assert.equal(f.master.getState('synthetic-overlay').value,'local');
  assert.equal(f.master.db.prepare('SELECT end_at FROM recorder_coverage WHERE id=1').get().end_at,start+1000);
});

test('compacted divergent peers recover from coalesced evidence without a database snapshot',async t=>{
  const f=fixture(t);
  observation(f.master,start,20);
  f.master.setState('synthetic-control',{permission:'shared'});
  const base=enrollJournalPeer(f.master.db).checkpoint,donor=await peerDonor(f);
  observation(f.master,start+1000,21);observation(donor,start+2000,22);
  for(let i=0;i<10;i++) {
    f.master.setState('synthetic-control',{permission:'local',counter:i});
    donor.setState('synthetic-control',{permission:'donor',counter:i});
  }
  for(const store of [f.master,donor]) store.compactJournal({maxBytes:1024*1024,maxCommits:1});
  assert.equal(f.master.checkpointAt(base.sequence),null);
  assert.equal(donor.checkpointAt(base.sequence),null);
  const transfers=new PeerTransfers(join(f.directory,'peer-wire'));
  const metadata=await transfers.export({dbPath:donor.path,after:base,signal:t.signal});
  const donorJournalPath=join(transfers.directory,`peer-${metadata.id}.changes`);
  const preview=await recoveryPreview({masterPath:f.master.path,donorJournalPath,signal:t.signal});
  assert.equal(preview.incremental.checkpoint.hash,donor.checkpoint().hash);
  const recovered=await recoverHistory({store:f.master,donorJournalPath,preview,signal:t.signal});
  assert.equal(recovered.report.imported,1);
  assert.deepEqual(f.master.observations().map(row=>row.value),[20,21,22]);
  assert.deepEqual(f.master.getState('synthetic-control'),{permission:'local',counter:9});
  assert(metadata.bytes<10000,'wire keeps changed records without repeated intermediate states');
});
