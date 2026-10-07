import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { replayLearningJournal, recordLearningContext,
  LEARNING_ALGORITHM, learningVersion} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { recordChargingSessionCheck, chargingSessionCheckSummaries } from '../src/app/charging-session-checks.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { sensorChangeEvents, sensorLearningContext, sensorRevision } from '../src/app/sensor-inputs.js';
import { withSensorMeasurements } from '../src/app/sensor-samples.js';
import { importCsv } from '../src/storage/history.js';
import { Engine } from '../src/app/engine.js';

import { fixture, observation, sample, recover, learningCatchup, energyCatchup, start, HOUR, W } from './helpers/recovery-fixture.js';

test('source check creates no trial database and the single merge preserves master conflicts', { timeout: 10000 }, async t => {
  const f = fixture(t);
  observation(f.master, start);
  const donor = await f.donor();
  observation(f.master, start + HOUR, 22);
  observation(donor, start + HOUR, 35);
  observation(donor, start + 2 * HOUR, 20);
  observation(f.master, start + 3 * HOUR, 1, { signal: 'property_energy_l1', unit: 'kWh',
    raw: { intervalStart: start + 2 * HOUR, intervalEnd: start + 3 * HOUR } });
  observation(donor, start + 4 * HOUR, 9, { signal: 'property_energy_l1', unit: 'kWh',
    raw: { intervalStart: start + 2 * HOUR, intervalEnd: start + 4 * HOUR } });
  const donorPath = await f.snapshot(donor), before = f.master.observations();
  const files = readdirSync(f.directory), progress = [];
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath, input: 'mqtt',
    onProgress: value => progress.push(value) });
  assert.deepEqual(f.master.observations(), before);
  assert.equal(preview.status, 'checked'); assert.equal(preview.model.status, 'not-assessed');
  assert.equal(preview.counts, undefined, 'source counts are not missing or conflict counts');
  assert.equal(preview.tables.find(row => row.name === 'observations').count, 4);
  assert(progress.length > 0 && progress.every(value => ['validating', 'checking'].includes(value.phase)));
  assert.deepEqual(readdirSync(f.directory), files, 'check never creates a trial database');
  const result = await recoverHistory({ signal: f.signal, store: f.master, donorPath, preview });
  assert.equal(result.report.status, 'complete'); assert.equal(result.report.imported, 1);
  assert.equal(result.report.counts.conflicts, 2);
  assert.equal(f.master.observations().find(row => row.sourceTime === start + HOUR).value, 22);
  assert.equal(f.master.observations().filter(row => row.signal === 'property_energy_l1').reduce((sum, row) => sum + row.value, 0), 1);
  const again = await recover(f, donorPath);
  assert.equal(again.report.imported, 0);
  assert.equal(f.master.observations().filter(row => row.sourceTime === start + 2 * HOUR).length, 1);
});

test('recovery catches up live learning across replay batches and retains the original journal', t => learningCatchup(t, 80));

test('recovery remaps observations, coverage, forecast and context provenance instead of mixing local IDs', async t => {
  const f = fixture(t);
  const context = recordLearningContext(f.master, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  const donor = await f.donor();
  observation(f.master, start + 4 * HOUR, 22);
  const changedContext = recordLearningContext(donor, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 20, roomBoostC: 0 }, start + W / 2);
  const id = observation(donor, start + W, 20);
  const coverage = Number(donor.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
    VALUES('synthetic','invented-house','indoor_temperature','fresh',?,?,?,?,2)`).run(start, start + W, start + W, id).lastInsertRowid);
  const forecast = donor.snapshot({ kind: 'weather', source: 'fmi', fetchedAt: start, payload: { forecast: [] } });
  sample(donor, start + W, { indoorC: 20, provenance: { basis: 'committed-history', lineage: {
    indoor_temperature: { observations: [id], coverage: [coverage] }, control_context: { journal: [context, changedContext] } },
  forecastVersion: { id: forecast, contentId: donor.snapshotById(forecast).contentId } } });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.model.acceptedSamples, 1);
  const row = f.master.learningJournal({ input: 'mqtt' }).find(value => value.kind === 'sample');
  const mapped = row.payload.value.provenance;
  assert.notEqual(mapped.lineage.indoor_temperature.observations[0], id);
  assert.equal(f.master.db.prepare('SELECT source_time FROM observations WHERE id=?').get(mapped.lineage.indoor_temperature.observations[0]).source_time, start + W);
  assert.equal(mapped.lineage.control_context.journal[0], f.master.learningJournal({ input: 'mqtt' })[0].id);
  assert.equal(mapped.lineage.control_context.journal[1], f.master.learningJournal({ input: 'mqtt' }).find(row => row.at === start + W / 2).id);
  assert.equal(f.master.snapshotById(mapped.forecastVersion.id).source, 'fmi');
});

test('donor learning cannot bypass conflicting master source measurements', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  observation(f.master, start + 2 * W, 22);
  const rejected = observation(donor, start + 2 * W, 35);
  sample(donor, start + 2 * W, { indoorC: 35, provenance: { lineage: { indoor_temperature: { observations: [rejected] } } } });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.model.acceptedSamples, 0);
  assert.ok(result.report.counts.skipped > 0);
  assert.equal(f.master.learningJournal({ input: 'mqtt' }).length, 1);
});

test('malformed donor observations are skipped without creating learning evidence', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start);
  donor.db.prepare("UPDATE observations SET quality='broken-json' WHERE id=1").run();
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.counts.skipped, 1); assert.equal(result.report.model.unsupported, 0);
  assert.equal(f.master.observations().length, 0);
  assert.equal(f.master.learningJournal({ input: 'mqtt' }).length, 0);
});

test('master removal wins and donor loads/removals keep valid references', async t => {
  const f = fixture(t);
  const shared = Number(f.master.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','shared-load',?,'load',3)").run(start).lastInsertRowid);
  const donor = await f.donor();
  f.master.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,target_id) VALUES('mqtt','master-remove',?,'remove',?)").run(start + HOUR, shared);
  const load = Number(donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','donor-load',?,'load',4)").run(start + 2 * HOUR).lastInsertRowid);
  donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,target_id) VALUES('mqtt','donor-remove',?,'remove',?)").run(start + 3 * HOUR, load);
  const result = await recover(f, await f.snapshot(donor));
  const rows = f.master.db.prepare('SELECT * FROM fireplace_events ORDER BY id').all();
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.request_id === 'master-remove').target_id, shared);
  assert.equal(rows.find(row => row.request_id === 'donor-remove').target_id, rows.find(row => row.request_id === 'donor-load').id);
  assert.equal(result.report.status, 'complete');
});

test('authority loss rejects publication and resumed recovery is idempotent', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  for (let i = 2; i < 100; i++) { observation(donor, start + i * W); sample(donor, start + i * W); }
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  let current = true;
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview, isCurrent: () => current,
    onProgress(value) { if (value.phase === 'rebuilding') current = false; } }), /authority changed/);
  assert.equal(f.master.learningEpoch('mqtt'), 'original');
  assert.equal(f.master.getState('recovery:active:mqtt').status, 'failed');
  const count = f.master.observations().length;
  const resumed = await recover(f, donorPath);
  assert.equal(f.master.observations().length, count);
  assert.equal(resumed.report.status, 'complete');
  assert.equal(f.master.learningJournal({ input: 'mqtt', limit: 1000 }).length, 99);
});

test('a stale recovery cannot publish over or mark a newer operation as failed', async t => {
  const f = fixture(t), donor = await f.donor();
  sample(donor, start + W);
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  const replacement = { status: 'rebuilding', operationToken: 'fixture-newer-operation', startedAt: start + W };
  let replaced = false;
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview,
    async onProgress(value) {
      if (replaced || value.phase !== 'rebuilding') return;
      await f.master.runWrite(() => f.master.setState('recovery:active:mqtt', replacement));
      replaced = true;
    } }), /active recovery operation changed/);
  assert.deepEqual(f.master.getState('recovery:active:mqtt'), replacement);
  assert.equal(f.master.learningEpoch('mqtt'), 'original');
});

test('a modified donor invalidates its preview before source import', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start);
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  const changed = new Store(donorPath); observation(changed, start + HOUR);
  changed.db.exec('PRAGMA journal_mode=DELETE'); changed.close();
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview }), /preview is stale/);
  assert.equal(f.master.observations().length, 0);
});

test('source check stays read only with a master writer and recovery uses later master evidence', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start, 20);
  observation(donor, start + HOUR, 21);
  const donorPath = await f.snapshot(donor);
  f.master.db.exec('BEGIN IMMEDIATE');
  let preview;
  try {
    preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
    assert.equal(preview.status, 'checked');
    assert.equal(preview.counts, undefined);
  } finally { f.master.db.exec('ROLLBACK'); }
  observation(f.master, start, 25);
  const result = await recoverHistory({ signal: f.signal, store: f.master, donorPath, preview });
  assert.equal(result.report.counts.conflicts, 1);
  assert.equal(result.report.imported, 1);
  assert.equal(f.master.observations().find(row => row.sourceTime === start).value, 25);
});

test('a retired trial-merge preview cannot authorize source recovery', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start);
  const donorPath = await f.snapshot(donor);
  const checked = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  const { previewId, status, ...retired } = checked;
  retired.model = { status: 'unchanged', acceptedSamples: 0, unsupported: 0 };
  retired.counts = { missing: 1, duplicates: 0, conflicts: 0, skipped: 0 };
  retired.previewId = learningVersion(retired);
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview: retired }), /Check the other instance/);
  assert.equal(f.master.observations().length, 0);
});

test('missing placeholders are filled without changing original master source records', async t => {
  const f = fixture(t), donor = await f.donor();
  const id = observation(f.master, start + W, null);
  sample(f.master, start + W, { indoorC: null, outdoorC: null, quality: ['missing'] });
  const original = f.master.db.prepare('SELECT * FROM observations WHERE id=?').get(id);
  observation(donor, start + W, 20);
  sample(donor, start + W, { indoorC: 20 });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.model.acceptedSamples, 1);
  assert.equal(f.master.latestObservation('indoor_temperature').value, 20);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations WHERE id=?').get(id), original);
  assert.equal(f.master.learningJournal({ input: 'mqtt' }).length, 1);
  assert.equal(f.master.learningJournal({ input: 'mqtt' })[0].payload.value.indoorC, 20);
});

test('a missing donor removal of a shared load is recovered and logging starts at the earliest source date', async t => {
  const f = fixture(t);
  const later = Number(f.master.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','later',?,'load',3)").run(start + 2 * HOUR).lastInsertRowid);
  const donor = await f.donor();
  donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,target_id) VALUES('mqtt','removed-on-backup',?,'remove',?)")
    .run(start + 3 * HOUR, later);
  donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','earlier',?,'load',2)").run(start);
  const result = await recover(f, await f.snapshot(donor));
  const source = fireplaceLearningContext(f.master, 'mqtt');
  assert.equal(result.report.status, 'complete');
  assert.equal(source.fireplaceStartedAt, start);
  assert.equal(source.fireplaceEvents.length, 1);
  assert.equal(source.fireplaceEvents[0].at, start);
});

test('a recovered charging session retains retry identity and cannot be counted twice by acquisition', async t => {
  const f = fixture(t), donor = await f.donor();
  const input = { source: 'easee', sessionKey: 'invented-session', start, end: start + HOUR,
    estimatedKwh: 2, referenceKwh: 2.1, complete: true, quality: ['estimated'] };
  recordChargingSessionCheck(donor, input);
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.status, 'complete');
  const id = f.master.events().find(row => row.type === 'charging-session-check').id;
  assert.equal(recordChargingSessionCheck(f.master, input), id);
  assert.equal(chargingSessionCheckSummaries(f.master).find(row => row.source === 'easee').summary.recordedSessions, 1);
});

test('phase energy recovery imports bounded batches while the master continues recording', t => energyCatchup(t, 64));

test('recovered CSV history preserves raw source rows, time, units and remapped import provenance', async t => {
  const f = fixture(t), donor = await f.donor();
  const primaryCsv = join(f.directory, 'invented-primary.csv'), donorCsv = join(f.directory, 'invented-donor.csv');
  writeFileSync(primaryCsv, `unix_time,price,heat_on,temp_in,temp_ga,temp_out\n${start / 1000},3,15,20,10,-1\n`);
  writeFileSync(donorCsv, `unix_time,ch_curr1,ch_curr2,ch_curr3,eq_curr1,eq_curr2,eq_curr3\n${(start + HOUR) / 1000},1,2,3,4,5,6\n`);
  await importCsv(f.master, primaryCsv, { kind: 'stmq' });
  const imported = await importCsv(donor, donorCsv, { kind: 'easee' });
  const source = donor.importRow(imported.importId, 1);
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.status, 'complete');
  const saved = f.master.observations().find(row => row.source === 'csv:easee');
  assert.notEqual(saved.provenance.importId, imported.importId);
  assert.equal(saved.sourceTime, start + HOUR); assert.equal(saved.unit, 'A'); assert.equal(saved.value, 1);
  assert.deepEqual(f.master.importRow(saved.provenance.importId, 1), { ...source, importId: saved.provenance.importId });
  assert.equal(f.master.db.prepare('SELECT status FROM imports WHERE id=?').get(saved.provenance.importId).status, 'complete');
  const original = f.master.events({ limit: 100 }).find(row => row.type === 'history.imported' && row.payload.kind === 'easee');
  assert.equal(original.payload.importId, saved.provenance.importId);
});

test('an accepted source deletion on the master is not resurrected by retrying the same donor snapshot', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(donor, start);
  const donorPath = await f.snapshot(donor);
  await recover(f, donorPath);
  f.master.db.prepare('DELETE FROM observations WHERE source_time=?').run(start);
  const result = await recover(f, donorPath);
  assert.equal(result.report.imported, 0);
  assert.equal(f.master.observations().length, 0);
  assert.equal(result.report.counts.conflicts, 1);
});

test('a fresh engine resumes the verified recovery epoch and appends later learning without rewriting history', async t => {
  const f = fixture(t);
  sample(f.master, start + W); replayLearningJournal(f.master, 'mqtt');
  const donor = await f.donor();
  sample(donor, start + 2 * W, { indoorC: 20.8 });
  sample(f.master, start + 3 * W); replayLearningJournal(f.master, 'mqtt');
  const result = await recover(f, await f.snapshot(donor));
  const before = f.master.db.prepare('SELECT * FROM learning_journal ORDER BY id').all();
  const engine = new Engine({ store: f.master, config: { input: 'mqtt', settings: {  } }, clock: () => start + 4 * W });
  t.after(() => engine.closeFireplace());
  assert.deepEqual(engine.readAdaptive(start + 4 * W), result.checkpoint);
  engine.tick();
  assert.equal(engine.checkpoint.windowCursor, start + 4 * W);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM learning_journal WHERE id<=? ORDER BY id').all(before.at(-1).id), before);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), engine.checkpoint);
});

test('failed recovery keeps control learning available and resumes ordinary background manual corrections', async t => {
  const f = fixture(t);
  sample(f.master, start + W); replayLearningJournal(f.master, 'mqtt');
  const donor = await f.donor();
  donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','accepted-before-failure',?,'load',3)").run(start);
  sample(donor, start + 2 * W);
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  let current = true;
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview, isCurrent: () => current,
    onProgress(value) { if (value.phase === 'rebuilding') current = false; } }), /authority changed/);
  assert.equal(f.master.learningEpoch('mqtt'), 'original');
  assert.equal(f.master.getState('fireplace:rebuild:mqtt').status, 'pending');
  const engine = new Engine({ store: f.master, config: { input: 'mqtt', settings: {  } }, clock: () => start + 3 * W });
  t.after(() => engine.closeFireplace());
  engine.readAdaptive(start + 3 * W);
  for (let attempt = 0; attempt < 200 && f.master.getState('fireplace:rebuild:mqtt').status !== 'current'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10)); engine.reconcileFireplace();
  }
  assert.equal(f.master.getState('fireplace:rebuild:mqtt').status, 'current');
  assert.equal(f.master.getState('recovery:active:mqtt').status, 'failed', 'peer remains protected until manual recovery succeeds');
  assert.equal(engine.checkpoint.fireplaceRevision, 1);
});

test('successive recoveries reuse source payloads directly and a no-op creates no further model epoch', async t => {
  const f = fixture(t);
  sample(f.master, start + W); const donor = await f.donor();
  sample(donor, start + 2 * W); sample(f.master, start + 3 * W);
  await recover(f, await f.snapshot(donor));
  sample(donor, start + 4 * W); sample(f.master, start + 5 * W);
  const secondPath = await f.snapshot(donor);
  const second = await recover(f, secondPath);
  assert.equal(second.report.model.acceptedSamples, 1);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries WHERE payload IS NOT NULL').get().n, 5);
  assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM learning_journal_entries a JOIN learning_journal_entries b
    ON a.source_entry_id=b.id WHERE b.source_entry_id IS NOT NULL`).get().n, 0);
  const before = f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries').get().n;
  const again = await recover(f, secondPath);
  assert.equal(again.report.model.status, 'unchanged'); assert.equal(again.epoch, second.epoch);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries').get().n, before);
  assert.equal(f.master.db.prepare("SELECT COUNT(*) n FROM recovery_runs WHERE status='complete'").get().n, 2);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), second.checkpoint);
});

test('recovery preserves master and donor sensor reversals across successive projection epochs', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  const masterChange = addSensorChange(f.master, 'mqtt', { requestId: 'invented-master-change', signal: 'outdoor_temperature', reason: 'replacement' }, start + W + 1);
  sample(f.master, start + 3 * W);
  revertSensorChange(f.master, 'mqtt', { requestId: 'invented-master-revert', id: masterChange.id }, start + 3 * W + 1);
  sample(donor, start + 2 * W);
  const donorChange = addSensorChange(donor, 'mqtt', { requestId: 'invented-donor-change', signal: 'outdoor_temperature', reason: 'calibration' }, start + 2 * W + 1);
  sample(donor, start + 4 * W);
  revertSensorChange(donor, 'mqtt', { requestId: 'invented-donor-revert', id: donorChange.id }, start + 4 * W + 1);
  const originals = f.master.db.prepare("SELECT * FROM learning_journal_entries WHERE epoch='original' ORDER BY id").all();
  const inspect = result => {
    const events = sensorChangeEvents(f.master, 'mqtt');
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.revertedAt !== null));
    assert.deepEqual(new Set(sensorLearningContext(f.master, 'mqtt').revertedSensorChanges), new Set(events.map(event => event.id)));
    assert.equal(result.checkpoint.measurementEpochAt ?? null, null, 'Neither reverted reset may restart learning after recovery');
    assert.equal(result.checkpoint.sensorRevision, sensorRevision(f.master, 'mqtt'));
    assert.equal(f.master.getState('fireplace:rebuild:mqtt').sensorRevision, result.checkpoint.sensorRevision);
    assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint);
    assert.deepEqual(f.master.db.prepare("SELECT * FROM learning_journal_entries WHERE epoch='original' AND id<=? ORDER BY id")
      .all(originals.at(-1).id), originals, 'Remapping never changes original source bytes');
  };
  const first = await recover(f, await f.snapshot(donor));
  inspect(first);
  assert.equal(first.report.model.acceptedSamples, 2);
  sample(donor, start + 5 * W);
  sample(f.master, start + 6 * W);
  const secondPath = await f.snapshot(donor);
  const second = await recover(f, secondPath);
  inspect(second);
  assert.notEqual(second.epoch, first.epoch);
  assert.equal(second.report.model.acceptedSamples, 1);
  const again = await recover(f, secondPath);
  assert.equal(again.epoch, second.epoch);
  assert.equal(again.report.model.status, 'unchanged');
});

test('a sensor reversal during recovery rejects the obsolete candidate and keeps correction rebuild intent', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const change = addSensorChange(f.master, 'mqtt', { requestId: 'invented-racing-change', signal: 'outdoor_temperature', reason: 'replacement' }, start + W + 1);
  sample(f.master, start + 2 * W);
  const old = replayLearningJournal(f.master, 'mqtt');
  const donor = await f.donor();
  for (let i = 3; i <= 100; i++) sample(donor, start + i * W);
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath });
  let reverted = false;
  await assert.rejects(recoverHistory({ signal: f.signal, store: f.master, donorPath, preview, onProgress(value) {
    if (value.phase === 'rebuilding' && !reverted) {
      reverted = true;
      revertSensorChange(f.master, 'mqtt', { requestId: 'invented-racing-revert', id: change.id }, start + 101 * W);
    }
  } }), /source changed|correction history changed/);
  assert.equal(reverted, true);
  assert.equal(f.master.learningEpoch('mqtt'), 'original');
  assert.deepEqual(f.master.getState('adaptive:mqtt'), old);
  const job = f.master.getState('fireplace:rebuild:mqtt');
  assert.equal(job.status, 'pending');
  assert.equal(job.sensorRevision, sensorRevision(f.master, 'mqtt'));
  const resumed = await recover(f, donorPath);
  assert.equal(resumed.report.status, 'complete');
  assert.equal(resumed.checkpoint.measurementEpochAt ?? null, null);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), resumed.checkpoint);
});

test('recovery rejects a donor sensor reversal whose target is not a sensor change', async t => {
  const f = fixture(t);
  const sampleId = sample(f.master, start + W);
  const donor = await f.donor();
  appendLearningRecord(donor, 'mqtt', 'context', { timestamp: start + W + 1,
    sensorRevert: { id: sampleId, requestId: 'invented-invalid-target' } });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.counts.skipped, 1);
  assert.equal(sensorRevision(f.master, 'mqtt'), 0);
});

function settlingSample(at, changedAt, { indoorC = 21, quality = [] } = {}) {
  return withSensorMeasurements({ sensorInputVersion: 1, timestamp: at, windowStart: at - W, windowEnd: at,
    indoorC, outdoorC: 0, quality,
    indoorSensors: { indoor_temperature: { value: indoorC, weight: 1, observedAt: at } },
    inputSegments: [{ start: at - W, end: at, outdoorC: 0, outdoorObservedAt: at, quality }],
    }, { sensorEpochs: { outdoor_temperature: changedAt }, measurementEpochAt: changedAt });
}

test('recovery accepts reversible settling inputs while keeping genuine donor measurement gaps excluded', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  const change = addSensorChange(donor, 'mqtt', { requestId: 'invented-settling-change', signal: 'outdoor_temperature', reason: 'replacement' }, start + W + 1);
  const settling = settlingSample(start + 2 * W, change.at);
  assert.equal(settling.indoorC, null); assert.equal(settling.outdoorC, null);
  sample(donor, start + 2 * W, settling);
  sample(donor, start + 3 * W, settlingSample(start + 3 * W, change.at, { indoorC: null, quality: ['missing'] }));
  revertSensorChange(donor, 'mqtt', { requestId: 'invented-settling-revert', id: change.id }, start + 3 * W + 1);
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.model.acceptedSamples, 1);
  assert.equal(result.report.counts.skipped, 1);
  const saved = f.master.learningJournal({ input: 'mqtt' }).find(row => row.kind === 'sample' && row.at === start + 2 * W);
  assert.equal(saved.payload.value.indoorC, null, 'The original exclusion remains in its saved input');
  assert.deepEqual(saved.payload.value.measurementInputs, settling.measurementInputs);
  assert.equal(result.checkpoint.samples.at(-1).indoorC, 21, 'The corrected projection recovers the original temperature');
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint);
});

test('usable master temperatures masked by a reset still take precedence over conflicting donor samples', async t => {
  const f = fixture(t);
  sample(f.master, start + W);
  const donor = await f.donor();
  const change = addSensorChange(f.master, 'mqtt', { requestId: 'invented-master-settling', signal: 'outdoor_temperature', reason: 'replacement' }, start + W + 1);
  sample(f.master, start + 2 * W, settlingSample(start + 2 * W, change.at));
  sample(donor, start + 2 * W, { indoorC: 35 });
  const original = f.master.learningJournal({ input: 'mqtt' });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.model.acceptedSamples, 0);
  assert.equal(result.report.counts.conflicts, 1);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }), original);
});
