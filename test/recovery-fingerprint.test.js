import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, observation, sample, recover, start, W } from './helpers/recovery-fixture.js';
import { Store } from '../src/storage/store.js';
import { recordLearningContext } from '../src/app/committed-learning.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { sourceFingerprint } from '../src/recovery/ledger.js';

test('rejected journal and context evidence cannot return through a reprojected donor copy', async t => {
  const f = fixture(t);
  const context = targetC => ({ phase: 'normal', regime: 'occupied', targetC, roomBoostC: 0 });
  recordLearningContext(f.master, 'mqtt', context(21), start);
  sample(f.master, start + W);
  const donor = await f.donor();
  const badContext = recordLearningContext(donor, 'mqtt', context(30), start + W + 1);
  sample(donor, start + 2 * W, { indoorC: 999, provenance: { lineage: { control_context: { journal: [badContext] } } } });
  const first = await recover(f, await f.snapshot(donor));
  const copied = new Store(await f.snapshot(f.master)); t.after(() => copied.close());
  const original = donor.db.prepare('SELECT * FROM learning_journal WHERE id=?').get(badContext);
  const projected = copied.db.prepare("SELECT * FROM learning_journal WHERE kind='context' AND at=?").get(start + W + 1);
  assert.notEqual(projected.key, original.key, 'The new donor uses its recovered journal identity');
  assert.equal(sourceFingerprint(copied, 'learning_journal', projected), sourceFingerprint(donor, 'learning_journal', original));
  sample(copied, start + 3 * W);
  const args = { store: f.master, input: 'mqtt', recoveryId: first.report.recoveryId, active: false, signal: f.signal };
  await reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
  const next = await recover(f, await f.snapshot(copied));
  assert.equal(next.report.counts.conflicts,0,'unchanged rejected common-prefix records are outside the incremental source');
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }).map(row => row.at), [start, start + W, start + 3 * W]);
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('source identity follows referenced evidence across local IDs and preserves meaningful differences', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(f.master, start - W, 19);
  const masterId = observation(f.master, start, 21), donorId = observation(donor, start, 21);
  assert.notEqual(masterId, donorId);
  const event = observationId => ({ type: 'synthetic-observation', at: start, payload: JSON.stringify({ observationId, sensor: 'invented-temperature' }) });
  assert.equal(sourceFingerprint(f.master, 'events', event(masterId)), sourceFingerprint(donor, 'events', event(donorId)));
  const different = observation(donor, start, 999);
  assert.notEqual(sourceFingerprint(f.master, 'events', event(masterId)), sourceFingerprint(donor, 'events', event(different)));
  assert.notEqual(sourceFingerprint(donor, 'events', event(donorId)), sourceFingerprint(donor, 'events', {
    ...event(donorId), payload: JSON.stringify({ observationId: donorId, sensor: 'another-temperature' }),
  }));
});

test('fingerprint provenance traversal rejects missing, cyclic and excessive references with bounded work', t => {
  const f = fixture(t), id = observation(f.master, start);
  const row = payload => ({ type: 'synthetic', at: start, payload: JSON.stringify(payload) });
  assert.throws(() => sourceFingerprint(f.master, 'events', row({ observationId: id + 1 })), /missing record/);
  assert.throws(() => sourceFingerprint(f.master, 'events', row({ observations: Array(2049).fill(id) })), /supported bounds/);
  let nested = { value: true }; for (let i = 0; i < 40; i++) nested = { nested };
  assert.throws(() => sourceFingerprint(f.master, 'events', row(nested)), /supported bounds/);
  assert.throws(() => sourceFingerprint(f.master, 'observations', { unit: 'kWh', raw: JSON.stringify(nested) }), /supported bounds/);
  f.master.db.prepare('UPDATE observations SET raw=? WHERE id=?').run(JSON.stringify({ observationId: id }), id);
  assert.throws(() => sourceFingerprint(f.master, 'events', row({ observationId: id })), /cycle/);
});

test('cycle observation objects retain frozen evidence while nested source references remap', async t => {
  const f = fixture(t), donor = await f.donor();
  observation(f.master, start - W, 19);
  const observationId = observation(donor, start, 21);
  const frozen = { at: start, indoorC: 21, outdoorC: 0, phase: 'normal',
    provenance: { observationId, lineage: { indoor_temperature: { observations: [observationId] } } } };
  const cycle = { id: 'invented-frozen-cycle', status: 'completed', startedAt: start, endedAt: start + W,
    observations: [frozen], plan: { model: { trainedAt: start - W }, baseline: { energyKwh: 2 } } };
  const context = recordLearningContext(donor, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21,
    roomBoostC: 0, episodeId: cycle.id }, start);
  cycle.lastSample = { timestamp: start, indoorC: 21, episodeId: cycle.id,
    provenance: { lineage: { control_context: { journal: [context] } } } };
  donor.db.prepare('INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload) VALUES(?,?,?,?,?,?)')
    .run(cycle.id, 'mqtt', start, start + W, cycle.status, JSON.stringify(cycle));
  const source = donor.db.prepare('SELECT * FROM learning_cycles WHERE id=?').get(cycle.id);
  const fingerprint = sourceFingerprint(donor, 'learning_cycles', source);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.counts.skipped, 0);
  const accepted = f.master.db.prepare('SELECT * FROM learning_cycles').get(), payload = JSON.parse(accepted.payload);
  const mappedId = f.master.db.prepare('SELECT id FROM observations WHERE source_time=?').get(start).id;
  assert.notEqual(mappedId, observationId);
  assert.deepEqual(payload.observations, [{ ...frozen, provenance: { observationId: mappedId,
    lineage: { indoor_temperature: { observations: [mappedId] } } } }]);
  assert.deepEqual(payload.plan, cycle.plan);
  assert.equal(payload.lastSample.episodeId, accepted.id);
  assert.equal(sourceFingerprint(f.master, 'learning_cycles', accepted), fingerprint);
  donor.event('synthetic-new-snapshot', {}, start + 2 * W);
  const repeated = await recover(f, await f.snapshot(donor));
  assert.equal(repeated.report.tables.find(row => row.name === 'learning_cycles').duplicates, 1);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_cycles').get().n, 1);
});

test('cycle fingerprint bounds accommodate the current complete observation log', t => {
  const f = fixture(t), id = observation(f.master, start);
  const payload = { observations: Array.from({ length: 3001 }, (_, index) => ({ start: start + index,
    end: start + index + 1, indoorC: 21, provenance: { observationId: id, lineage: { indoor: { observations: [id] } } } })) };
  const row = () => ({ input: 'mqtt', started_at: start, payload: JSON.stringify(payload) });
  assert.match(sourceFingerprint(f.master, 'learning_cycles', row()), /^[a-f0-9]{64}$/);
  payload.observations.push(payload.observations[0]);
  assert.throws(() => sourceFingerprint(f.master, 'learning_cycles', row()), /supported bounds/);
});
