import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { recordLearningContext, replayLearningJournal } from '../src/app/committed-learning.js';
import { fixture, observation, sample, recover, start, W, HOUR } from './helpers/recovery-fixture.js';

function unavailable(store, at = start) {
  return new Recorder(store).record({ source: 'garage-adapter', device: 'invented-garage-controller',
    signal: 'garage_compressor_active', value: null, unit: 'state', sourceTime: at, receivedAt: at,
    quality: ['missing'], raw: { usableForControl: false, diagnosticAvailable: true,
      timeBasis: 'source-measured', reportIntervalMs: 60_000, reportGraceMs: 0 } });
}

test('recovering fresh mirrored snapshots does not multiply unavailable records or invent coverage conflicts', async t => {
  const f = fixture(t);
  unavailable(f.master);
  observation(f.master, start, 21, { signal: 'invented_stale_temperature', quality: ['stale'] });
  observation(f.master, start, null, { signal: 'invented_unknown_temperature', sourceTime: null, quality: ['unavailable'] });
  observation(f.master, start, 0, { signal: 'invented_valid_zero', quality: [] });
  const before = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const coverage = f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const digests = new Set();
  for (let cycle = 0; cycle < 3; cycle++) {
    // Ordinary mirroring gives the donor the master's recovered rows. Each
    // completed recovery also records an event, changing the next file digest.
    const donorPath = await f.snapshot(f.master);
    const result = await recover(f, donorPath);
    digests.add(result.preview.donorDigest);
    assert.equal(result.report.counts.missing, 0);
    assert.equal(result.report.counts.conflicts, 0);
    assert.equal(result.report.imported, 0);
    assert.equal(result.report.model.status, 'unchanged');
    assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
    assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(), coverage);
  }
  assert.equal(digests.size, 3, 'identity survives genuinely different snapshot digests');
});

test('a true unavailable-history gap is accepted once across new donor snapshots without rewriting existing rows', async t => {
  const f = fixture(t);
  unavailable(f.master);
  const donor = await f.donor();
  observation(f.master, start + HOUR, 0, { signal: 'invented_valid_zero' });
  unavailable(donor, start + HOUR);
  observation(donor, start + HOUR, 21, { signal: 'invented_stale_temperature', quality: ['stale'] });
  const original = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const first = await recover(f, await f.snapshot(donor));
  assert.equal(first.report.imported, 2, 'the new stale observation and extended unavailable coverage');
  assert.equal(first.report.counts.conflicts, 0);
  const accepted = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  assert.deepEqual(accepted.slice(0, original.length), original);
  donor.event('invented-donor-status', { sequence: 1 }, start + 2 * HOUR);
  const nextPath = await f.snapshot(donor);
  const second = await recover(f, nextPath);
  assert.notEqual(first.preview.donorDigest, second.preview.donorDigest);
  assert.equal(second.report.imported, 1, 'only the new event is absent');
  assert.equal(second.report.counts.conflicts, 0);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), accepted);
  const again = await recover(f, nextPath);
  assert.equal(again.report.counts.missing, 0);
  assert.equal(again.report.counts.conflicts, 0);
});

test('unavailable observation identity includes source, device, both clocks, unit, quality and raw meaning', async t => {
  const target = new Store(':memory:'), donor = new Store(':memory:');
  t.after(() => { target.close(); donor.close(); });
  const base = { source: 'synthetic', device: 'invented-device', signal: 'indoor_temperature', unit: 'degC',
    value: null, quality: ['missing'], sourceTime: start, receivedAt: start, raw: { reason: 'invented-outage' } };
  target.observation(base);
  donor.observation(base);
  const variants = [
    { source: 'another-source' }, { device: 'another-device' }, { signal: 'outdoor_temperature' },
    { sourceTime: start - 1 }, { sourceTime: null }, { receivedAt: start + 1 }, { unit: 'K' },
    { quality: ['failed'] }, { raw: { reason: 'different-outage' } }, { value: 0, quality: ['stale'] },
  ];
  for (const extra of variants) donor.observation({ ...base, ...extra });
  const merge = digest => new HistoryMerge({ target, donor, donorDigest: digest.repeat(64), input: 'mqtt' }).run();
  const first = await merge('a');
  assert.deepEqual(first.counts, { missing: variants.length, conflicts: 0, duplicates: 1, skipped: 0 });
  const before = target.observations();
  const second = await merge('b');
  assert.deepEqual(second.counts, { missing: 0, conflicts: 0, duplicates: variants.length + 1, skipped: 0 });
  assert.deepEqual(target.observations(), before);
});

test('pre-existing repeated unknown records retain their own mirrored coverage without cleanup', async t => {
  const f = fixture(t);
  unavailable(f.master);
  f.master.db.exec(`INSERT INTO observations SELECT id+1,source,device,signal,value,unit,source_time,received_at,
    quality,raw,import_id,row_number FROM observations`);
  const before = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const result = await recover(f, await f.snapshot(f.master));
  assert.equal(result.report.counts.missing, 0);
  assert.equal(result.report.counts.conflicts, 0);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), before);
  assert.equal(f.master.db.prepare('SELECT observation_id FROM recorder_coverage').get().observation_id, before[0].id);
});

test('an already mirrored repeated unavailable phase cohort is present without importing or repairing its rows', async t => {
  const f = fixture(t);
  for (let repeat = 0; repeat < 2; repeat++) for (let phase = 1; phase <= 3; phase++) {
    const signal = `property_energy_l${phase}`;
    const id = observation(f.master, start + HOUR, null, { signal, unit: 'kWh', quality: ['missing'],
      raw: { intervalStart: start, intervalEnd: start + HOUR, basis: 'counter-delta' } });
    f.master.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES('synthetic','invented-house',?,'unavailable',?,?,?,?,1)`)
      .run(signal, start + HOUR, start + HOUR, start + HOUR, id);
  }
  const observations = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
  const coverage = f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const result = await recover(f, await f.snapshot(f.master));
  assert.deepEqual(result.report.counts, { missing: 0, conflicts: 0, duplicates: 12, skipped: 0 });
  assert.equal(result.report.imported, 0);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), observations);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(), coverage);
});

test('an exact existing coverage span is present even when a later contrary span contains it', async t => {
  const f = fixture(t);
  const fresh = observation(f.master, start, 21);
  const unknown = observation(f.master, start + HOUR, null, { quality: ['missing'] });
  const insert = (store, status, from, to, at, observationId, samples) => store.db.prepare(`INSERT INTO recorder_coverage
    (source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
    VALUES('synthetic','invented-house','indoor_temperature',?,?,?,?,?,?)`)
    .run(status, from, to, at, observationId, samples);
  insert(f.master, 'fresh', start, start + HOUR, start + HOUR, fresh, 2);
  insert(f.master, 'unavailable', start, start + 2 * HOUR, start + HOUR, unknown, 3);
  const before = f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const same = await recover(f, await f.snapshot(f.master));
  assert.deepEqual(same.report.counts, { missing: 0, conflicts: 0, duplicates: 4, skipped: 0 });
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(), before);
  const donor = await f.donor();
  insert(donor, 'fresh', start + HOUR / 4, start + HOUR / 2, start, fresh, 2);
  const different = await recover(f, await f.snapshot(donor));
  assert.equal(different.report.imported, 0);
  assert.equal(different.report.counts.conflicts, 1, 'an absent conflicting donor span still cannot replace master evidence');
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all(), before);
});

test('remapped cycle and event provenance remain already present when donor snapshot identity changes', async t => {
  const target = new Store(':memory:'), donor = new Store(':memory:');
  t.after(() => { target.close(); donor.close(); });
  observation(target, start + HOUR);
  const observationId = observation(donor, start);
  const cycleId = 'invented-active-cycle';
  donor.db.prepare(`INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload)
    VALUES(?,?,?,NULL,?,?)`).run(cycleId, 'mqtt', start, 'active',
    JSON.stringify({ id: cycleId, status: 'active', provenance: { observations: [observationId] } }));
  donor.event('invented-cycle-evidence', { observationId, cycleId }, start);
  const merge = digest => new HistoryMerge({ target, donor, donorDigest: digest.repeat(64), input: 'mqtt' }).run();
  assert.equal((await merge('a')).counts.missing, 3);
  const cycle = target.db.prepare('SELECT * FROM learning_cycles').get();
  assert.equal(cycle.status, 'incomplete', 'a recovered active cycle cannot become active control state');
  const event = target.events().find(row => row.type === 'invented-cycle-evidence');
  assert.equal(event.payload.cycleId, cycle.id);
  assert.notEqual(event.payload.observationId, observationId);
  assert.deepEqual((await merge('b')).counts, { missing: 0, conflicts: 0, duplicates: 3, skipped: 0 });
  assert.deepEqual(target.db.prepare('SELECT * FROM learning_cycles').get(), cycle);
});

test('distinct existing events and learning contexts sharing a timestamp are recognized individually', async t => {
  const f = fixture(t);
  for (const targetC of [20, 21]) {
    f.master.event('invented-same-clock-event', { targetC }, start);
    recordLearningContext(f.master, 'mqtt', { phase: 'normal', regime: 'occupied', targetC, roomBoostC: 0 }, start);
  }
  const journal = f.master.learningJournal({ input: 'mqtt' });
  assert.equal(journal.length, 2);
  const result = await recover(f, await f.snapshot(f.master));
  assert.deepEqual(result.report.counts, { missing: 0, conflicts: 0, duplicates: 4, skipped: 0 });
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }), journal);
  assert.equal(result.report.model.status, 'unchanged');
});

test('equal local provenance numbers cannot disguise conflicting source measurements in a journal comparison', async t => {
  const f = fixture(t), donor = await f.donor();
  const masterId = observation(f.master, start + W, 22), donorId = observation(donor, start + W, 20);
  assert.equal(masterId, donorId, 'independent databases can allocate identical numeric IDs');
  const provenance = { lineage: { indoor_temperature: { observations: [donorId] } } };
  sample(f.master, start + W, { provenance });
  sample(donor, start + W, { provenance });
  const before = f.master.learningJournal({ input: 'mqtt' });
  const result = await recover(f, await f.snapshot(donor));
  assert.equal(result.report.imported, 0);
  assert.equal(result.report.counts.conflicts, 1);
  assert.equal(result.report.tables.find(row => row.name === 'learning_journal').skipped, 1);
  assert.deepEqual(f.master.learningJournal({ input: 'mqtt' }), before);
});

test('recovered learning provenance stays already present across new donor snapshots and later projection epochs', async t => {
  const f = fixture(t);
  const context = recordLearningContext(f.master, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  const donor = await f.donor();
  observation(f.master, start + 4 * HOUR, 22);
  const change = recordLearningContext(donor, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 20, roomBoostC: 0 }, start + W / 2);
  const id = observation(donor, start + W, 20);
  const forecast = donor.snapshot({ kind: 'weather', source: 'synthetic-weather', fetchedAt: start, payload: { forecast: [] } });
  const provenance = { basis: 'committed-history', lineage: { indoor_temperature: { observations: [id] },
    control_context: { journal: [context, change] } },
    forecastVersion: { id: forecast, contentId: donor.snapshotById(forecast).contentId } };
  sample(donor, start + W, { indoorC: 20, provenance });
  const firstPath = await f.snapshot(donor);
  const first = await recover(f, firstPath);
  const firstAgain = await recover(f, firstPath);
  assert.equal(firstAgain.report.counts.missing, 0);
  assert.equal(firstAgain.report.counts.conflicts, 0);
  sample(donor, start + 2 * W, { indoorC: 20, provenance });
  const secondPath = await f.snapshot(donor);
  const second = await recover(f, secondPath);
  assert.notEqual(second.epoch, first.epoch);
  assert.equal(second.report.model.acceptedSamples, 1);
  assert.equal(second.report.counts.conflicts, 0);
  const entries = f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries').get().n;
  const again = await recover(f, secondPath);
  assert.equal(again.report.imported, 0);
  assert.equal(again.report.counts.conflicts, 0);
  assert.equal(again.report.model.status, 'unchanged');
  assert.equal(again.epoch, second.epoch);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries').get().n, entries);
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), second.checkpoint);
});
