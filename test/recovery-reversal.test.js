import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, observation, sample, recover, start, W } from './helpers/recovery-fixture.js';
import { listRecoveries, previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { replayLearningJournal } from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { Store } from '../src/storage/store.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { sensorChangeEvents } from '../src/app/sensor-inputs.js';
import { addFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';

async function change(f, id, active, options = {}) {
  const args = { store: f.master, input: 'mqtt', recoveryId: id, active, signal: f.signal };
  const preview = await previewRecoveryRevision(args);
  return reviseRecovery({ ...args, preview, ...options });
}

test('revert and restore preserve original evidence, current state and later local recordings across restart', async t => {
  const f = fixture(t);
  observation(f.master, start, 20);
  const donor = await f.donor(); observation(donor, start + W, 999);
  const result = await recover(f, await f.snapshot(donor));
  const id = result.report.recoveryId;
  observation(f.master, start + 2 * W, 21);
  f.master.setState('synthetic-current-authority', { permitted: false, session: 'current' });
  const original = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const previewBefore = f.master.db.prepare('SELECT total_changes() n').get().n;
  const preview = await previewRecoveryRevision({ store: f.master, input: 'mqtt', recoveryId: id, active: false, signal: f.signal });
  assert.equal(f.master.db.prepare('SELECT total_changes() n').get().n, previewBefore, 'preview does not write target');
  assert.equal(preview.counts.affected, 1);
  await reviseRecovery({ store: f.master, input: 'mqtt', recoveryId: id, active: false, preview, signal: f.signal });
  assert.deepEqual(f.master.observations().map(row => row.value), [20, 21]);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), original);
  assert.deepEqual(f.master.getState('synthetic-current-authority'), { permitted: false, session: 'current' });
  assert.equal(listRecoveries(f.master, 'mqtt')[0].active, false);
  const reopened = new Store(f.master.path, { readOnly: true });
  try { assert.deepEqual(reopened.observations().map(row => row.value), [20, 21]); } finally { reopened.close(); }
  await change(f, id, true);
  assert.deepEqual(f.master.observations().map(row => row.value), [20, 999, 21]);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM recovery_decisions').get().n, 2);
});

test('reverting an older recovery retains newer recoveries and rebuilds through subsequent learning', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); sample(donor, start + 2 * W, { indoorC: 22 });
  sample(f.master, start + 3 * W);
  const first = await recover(f, await f.snapshot(donor));
  sample(donor, start + 4 * W, { indoorC: 21.5 });
  sample(f.master, start + 5 * W);
  const second = await recover(f, await f.snapshot(donor));
  sample(f.master, start + 6 * W);
  const result = await change(f, first.report.recoveryId, false);
  assert.equal(result.checkpoint.windowCursor, start + 6 * W);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt', limit: 100 }).filter(row => row.kind === 'sample').map(row => row.at),
    [1, 3, 4, 5, 6].map(n => start + n * W));
  assert.equal(listRecoveries(f.master, 'mqtt').find(row => row.id === second.report.recoveryId).active, true);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint);
  await change(f, first.report.recoveryId, true);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt', limit: 100 }).filter(row => row.kind === 'sample').map(row => row.at),
    [1, 2, 3, 4, 5, 6].map(n => start + n * W));
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('rejecting recovery prevents silent reimport from a different snapshot of the same bad evidence', async t => {
  const f = fixture(t), donor = await f.donor(); observation(donor, start, 999);
  const first = await recover(f, await f.snapshot(donor));
  await change(f, first.report.recoveryId, false);
  donor.event('synthetic-later-history', {}, start + W);
  const next = await recover(f, await f.snapshot(donor));
  assert.equal(f.master.observations().length, 0);
  assert(next.report.counts.conflicts >= 1);
});

test('authority loss during reversal leaves selected history and model unchanged', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); for (let i = 2; i < 80; i++) sample(donor, start + i * W);
  const first = await recover(f, await f.snapshot(donor));
  const before = f.master.learningEpoch('mqtt'); let current = true;
  await assert.rejects(change(f, first.report.recoveryId, false, { isCurrent: () => current,
    onProgress() { current = false; } }), /authority changed/);
  assert.equal(f.master.learningEpoch('mqtt'), before);
  assert.equal(listRecoveries(f.master, 'mqtt')[0].active, true);
});

test('restoration retains later local evidence where it filled a rejected measurement gap', async t => {
  const f = fixture(t), donor = await f.donor(); observation(donor, start, 999);
  const first = await recover(f, await f.snapshot(donor)); await change(f, first.report.recoveryId, false);
  observation(f.master, start, 21);
  await change(f, first.report.recoveryId, true);
  assert.deepEqual(f.master.observations().map(row => row.value), [21]);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 2);
});

test('reversal catches up local learning recorded during rebuilding and rejects stale reviews', async t => {
  const f = fixture(t); for (let i = 1; i <= 70; i++) sample(f.master, start + i * W);
  const donor = await f.donor(); sample(donor, start + 71 * W, { indoorC: 999 });
  const first = await recover(f, await f.snapshot(donor)); sample(f.master, start + 72 * W);
  let written = false;
  const result = await change(f, first.report.recoveryId, false, { onProgress(value) {
    if (!written && value.phase === 'rebuilding') { written = true; sample(f.master, start + 73 * W); }
  } });
  assert(written); assert.equal(result.checkpoint.windowCursor, start + 73 * W);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint);
  const args = { store: f.master, input: 'mqtt', recoveryId: first.report.recoveryId, active: true, signal: f.signal };
  const preview = await previewRecoveryRevision(args); await change(f, first.report.recoveryId, true);
  await change(f, first.report.recoveryId, false);
  await assert.rejects(reviseRecovery({ ...args, preview }), /stale|changed/);
});

test('partial source imports remain explicitly reversible after authority loss', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); observation(donor, start + 2 * W, 999); sample(donor, start + 2 * W);
  let current = true;
  await assert.rejects(recover(f, await f.snapshot(donor), { isCurrent: () => current,
    onProgress(value) { if (value.phase === 'rebuilding') current = false; } }), /authority changed/);
  const operation = listRecoveries(f.master, 'mqtt')[0];
  assert(operation.canRevert); assert.equal(operation.status, 'interrupted');
  await change(f, operation.id, false);
  assert.equal(f.master.observations().length, 0);
  assert.equal(f.master.learningJournal({ input: 'mqtt' }).length, 1);
});

test('recovering again cannot reintroduce the rejected learning sample or erase independent sensor reversals', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); sample(donor, start + 2 * W, { indoorC: 999 });
  const first = await recover(f, await f.snapshot(donor)); await change(f, first.report.recoveryId, false);
  donor.event('synthetic-snapshot-changed', {}, start + 3 * W);
  const again = await recover(f, await f.snapshot(donor));
  assert(again.report.counts.conflicts > 0);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }).map(row => row.at), [start + W]);
});

test('fireplace recovery reversal preserves a later independent removal and exact model replay', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor();
  donor.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,kg) VALUES('mqtt','synthetic-recovered-load',?,'load',3)").run(start + W);
  const first = await recover(f, await f.snapshot(donor));
  const load = f.master.db.prepare("SELECT id FROM fireplace_events WHERE kind='load'").get().id;
  f.master.db.prepare("INSERT INTO fireplace_events(input,request_id,at,kind,target_id) VALUES('mqtt','synthetic-local-removal',?,'remove',?)").run(start + 2 * W, load);
  sample(f.master, start + 3 * W);
  const reverted = await change(f, first.report.recoveryId, false);
  assert.equal(fireplaceLearningContext(f.master, 'mqtt').fireplaceEvents.length, 0);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), reverted.checkpoint);
  const restored = await change(f, first.report.recoveryId, true);
  assert.equal(fireplaceLearningContext(f.master, 'mqtt').fireplaceEvents.length, 0, 'local removal stays effective');
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), restored.checkpoint);
});


test('restoration keeps local learning that subsequently filled the rejected window', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); sample(donor, start + 2 * W, { indoorC: 999 });
  const first = await recover(f, await f.snapshot(donor)); await change(f, first.report.recoveryId, false);
  sample(f.master, start + 2 * W, { indoorC: 21.25 });
  const restored = await change(f, first.report.recoveryId, true);
  const values = f.master.learningJournal({ input: 'mqtt' }).filter(row => row.kind === 'sample').map(row => row.payload.value.indoorC);
  assert.deepEqual(values, [21, 21.25]);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), restored.checkpoint);
});

test('restoration conflicts remain excluded after a different recovery is reverted', async t => {
  const f = fixture(t), donor = await f.donor(); observation(donor, start, 999);
  const first = await recover(f, await f.snapshot(donor)); await change(f, first.report.recoveryId, false);
  observation(f.master, start, 21); await change(f, first.report.recoveryId, true);
  observation(donor, start + W, 22);
  const second = await recover(f, await f.snapshot(donor)); await change(f, second.report.recoveryId, false);
  assert.deepEqual(f.master.observations().map(row => row.value), [21]);
});

test('new local measurements during restore force a fresh review without replacing current evidence', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); observation(donor, start + 2 * W, 999);
  for (let i = 2; i <= 70; i++) sample(donor, start + i * W);
  const first = await recover(f, await f.snapshot(donor)); await change(f, first.report.recoveryId, false);
  let written = false;
  await assert.rejects(change(f, first.report.recoveryId, true, { onProgress(value) {
    if (!written && value.phase === 'rebuilding') { written = true; observation(f.master, start + 2 * W, 21); }
  } }), /New local evidence/);
  assert(written); assert.equal(listRecoveries(f.master, 'mqtt')[0].active, false);
  assert.deepEqual(f.master.observations().map(row => row.value), [21]);
});

test('rejecting recovered observations invalidates dependent savings without deleting original cycles', async t => {
  const f = fixture(t), donor = await f.donor(); observation(donor, start, 999);
  const first = await recover(f, await f.snapshot(donor));
  const id = f.master.observations()[0].id;
  const cycle = { id: 'invented-dependent-cycle', input: 'mqtt', startedAt: start, endedAt: start + W, status: 'completed',
    observations: [{ provenance: { observationId: id } }], assessment: { basis: 'estimated-space-heating-execution-and-reference', profitCents: 200 } };
  f.master.db.prepare('INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload) VALUES(?,?,?,?,?,?)')
    .run(cycle.id, 'mqtt', start, start + W, cycle.status, JSON.stringify(cycle));
  await change(f, first.report.recoveryId, false);
  assert(f.master.db.prepare("SELECT 1 FROM recovery_exclusions WHERE generation=(SELECT generation FROM history_selection) AND table_name='cycle_assessments' AND record_key=?").get(cycle.id));
  assert.deepEqual(JSON.parse(f.master.db.prepare('SELECT payload FROM learning_cycles WHERE id=?').get(cycle.id).payload), cycle);
  await change(f, first.report.recoveryId, true);
  assert.equal(f.master.db.prepare("SELECT 1 FROM recovery_exclusions WHERE generation=(SELECT generation FROM history_selection) AND table_name='cycle_assessments' AND record_key=?").get(cycle.id), undefined);
});


test('revert and restore remap an independent sensor reversal to its retained original change', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor();
  addSensorChange(donor, 'mqtt', { signal: 'indoor_temperature', reason: 'replacement', requestId: 'invented-recovered-change' }, start + 2 * W, { config: {} });
  const first = await recover(f, await f.snapshot(donor));
  const recovered = sensorChangeEvents(f.master, 'mqtt')[0];
  revertSensorChange(f.master, 'mqtt', { id: recovered.id, requestId: 'invented-local-reversal' }, start + 3 * W, { config: {} });
  sample(f.master, start + 4 * W);
  await change(f, first.report.recoveryId, false);
  assert.equal(sensorChangeEvents(f.master, 'mqtt').length, 0);
  const restored = await change(f, first.report.recoveryId, true);
  const events = sensorChangeEvents(f.master, 'mqtt');
  assert.equal(events.length, 1); assert.equal(events[0].revertedAt, start + 3 * W);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), restored.checkpoint);
});


test('fully accepted interrupted learning can be reverted and restored after another recovery', async t => {
  const f = fixture(t); sample(f.master, start + W);
  const donor = await f.donor(); for (let i = 2; i <= 70; i++) sample(donor, start + i * W);
  await assert.rejects(recover(f, await f.snapshot(donor), { isCurrent() {
    return !f.master.db.prepare("SELECT 1 FROM recovery_members WHERE table_name='learning_journal' LIMIT 1").get();
  } }), /authority changed/);
  const operation = listRecoveries(f.master, 'mqtt')[0]; assert(operation.canRevert);
  await change(f, operation.id, false);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }).map(row => row.at), [start + W]);
  donor.event('invented-new-snapshot', {}, start + 71 * W);
  await recover(f, await f.snapshot(donor));
  const restored = await change(f, operation.id, true);
  assert.equal(f.master.learningJournal({ input: 'mqtt' }).filter(row => row.kind === 'sample').length, 70);
  assert.equal(restored.checkpoint.windowCursor, start + 70 * W);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), restored.checkpoint);
});


test('a recovery cannot invalidate another input model sharing its accepted observations', async t => {
  const f = fixture(t), donor = await f.donor(); observation(donor, start, 999);
  const first = await recover(f, await f.snapshot(donor));
  const id = f.master.observations()[0].id;
  appendLearningRecord(f.master, 'providers', 'sample', { timestamp: start + W, windowStart: start, windowEnd: start + W,
    indoorC: 999, outdoorC: 0, quality: [], provenance: { observations: [id] } }, { config: {} });
  await assert.rejects(change(f, first.report.recoveryId, false), error => error.code === 'recovery_other_input');
  assert.equal(listRecoveries(f.master, 'mqtt')[0].active, true);
  assert.deepEqual(f.master.observations().map(row => row.value), [999]);
});


test('idempotent producers retain rejected identities without resurrecting source contributions', async t => {
  const f = fixture(t), donor = await f.donor();
  const note = { kind: 'absence', startAt: start, note: 'Invented absence', uniqueKey: 'invented-absence' };
  const counter = { signal: 'compressor_runtime', value: 1, observedDate: '2026-01-01' };
  const snapshot = { kind: 'weather', source: 'synthetic', fetchedAt: start, payload: { temperature: 99 } };
  const fire = { requestId: 'invented-recovered-fire', kg: 2 };
  donor.annotation(note); donor.counter(counter); donor.snapshot(snapshot); addFireplace(donor, 'mqtt', fire, start);
  const first = await recover(f, await f.snapshot(donor));
  const ids = ['annotations', 'counters', 'provider_snapshot_fetches', 'fireplace_events']
    .map(table => f.master.db.prepare(`SELECT id FROM ${table}`).get().id);
  await change(f, first.report.recoveryId, false);
  assert.deepEqual([f.master.annotation(note), f.master.counter(counter), f.master.snapshot(snapshot), addFireplace(f.master, 'mqtt', fire, start).id], ids);
  assert.equal(f.master.annotations().length, 0); assert.equal(f.master.counters().length, 0);
  assert.equal(f.master.snapshots().length, 0); assert.equal(fireplaceLearningContext(f.master, 'mqtt').fireplaceEvents.length, 0);
});
