import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { fixture, start, HOUR } from './helpers/recovery-fixture.js';

const END = start + 49 * HOUR;
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const energyKey = (source, device, prefix) => `recorder:energy:${JSON.stringify([source, device, prefix])}`;
function memory(t) {
  const target = new Store(':memory:'), donor = new Store(':memory:');
  t.after(() => { target.close(); donor.close(); });
  return { target, donor, merge(extra = {}) {
    return new HistoryMerge({ target, donor, donorDigest: 'a'.repeat(64), input: 'mqtt', now: END + HOUR, ...extra });
  } };
}
function pending(store, { source = 'easee', device = 'invented-meter', prefix = 'property', from = start,
  to = END, receivedAt = to, energies = prefix === 'caravan' ? [49] : [49, 98, 147], quality = [] } = {}) {
  const key = energyKey(source, device, prefix);
  const state = { lastEnd: to, lastReceivedAt: receivedAt, pending: { start: from, end: to, receivedAt, energies, quality },
    lastPowers: energies.map(() => 1), lastQuality: quality, scales: energies.map(() => null) };
  store.setState(key, state);
  return { key, state };
}
function finalized(store, { source = 'easee', device = 'invented-meter', prefix = 'property', from = start, to = END,
  energies = [49, 98, 147], phases = [1, 2, 3], raw = {} } = {}) {
  for (const phase of phases) store.observation({ source, device, signal: `${prefix}_energy_l${phase}`, unit: 'kWh',
    value: energies[phase - 1], sourceTime: to, receivedAt: to, quality: [],
    raw: { intervalStart: from, intervalEnd: to, basis: 'integrated-power-phase-allocation', ...raw } });
}

test('service preview and apply preserve a frozen multi-day tail as history without importing recorder state', async t => {
  const f = fixture(t), initialEnd = start + 60_000;
  const recorder = new Recorder(f.master);
  recorder.recordEnergy({ source: 'easee', device: 'invented-meter', prefix: 'property', start, end: initialEnd,
    energies: [1 / 60, 2 / 60, 3 / 60], powers: [1, 2, 3] });
  const point = (store, value, at) => new Recorder(store).record({ source: 'synthetic', device: 'invented-custom',
    signal: 'custom_feedback', unit: '%', value, sourceTime: at, receivedAt: at }, { kind: 'state' });
  point(f.master, 20, initialEnd);
  const donor = await f.donor(), duration = (END - initialEnd) / HOUR;
  new Recorder(donor).recordEnergy({ source: 'easee', device: 'invented-meter', prefix: 'property',
    start: initialEnd, end: END, receivedAt: END + 250, energies: [duration, 2 * duration, 3 * duration], powers: [1, 2, 3] });
  point(donor, 21, END + 500);
  const donorPath = await f.snapshot(donor), beforeHash = hash(donorPath);
  const stateBefore = f.master.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:%' ORDER BY key").all();
  const observationsBefore = f.master.observations();
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath, input: 'mqtt',
    workDirectory: join(f.directory, 'work') });
  assert.equal(preview.counts.missing, 5, 'three phase values, one exact reading and its coverage');
  assert.deepEqual(f.master.observations(), observationsBefore, 'preview does not materialize a master or donor tail');
  assert.deepEqual(f.master.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:%' ORDER BY key").all(), stateBefore);
  assert.equal(hash(donorPath), beforeHash);
  const result = await recoverHistory({ signal: f.signal, store: f.master, donorPath, input: 'mqtt', preview });
  assert.equal(result.report.imported, 5);
  const recovered = f.master.observations().filter(row => row.raw?.recovery?.kind === 'frozen-recorder-energy');
  assert.equal(recovered.length, 3);
  assert.ok(recovered.every(row => row.sourceTime === END && row.receivedAt === END + 250 && !row.raw.pending));
  assert.deepEqual(recovered.map(row => row.value), [duration, 2 * duration, 3 * duration]);
  assert.deepEqual(f.master.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:%' ORDER BY key").all(), stateBefore,
    'live cursors, thresholds, coverage pointers and global state stay local');
  const groups = [...recordedEnergyGroups(f.master, { from: initialEnd, to: END, now: END + 1000, input: 'providers', prefix: 'property' })];
  assert.equal(groups.length, 1); assert.equal(groups[0].conflict, undefined); assert.equal(groups[0].pending, false);
  const status = recorder.status(END + 2 * HOUR);
  assert.ok(status.parameters.every(row => row.week.records === 2));
  const exact = status.exactParameters.find(row => row.signal === 'custom_feedback');
  assert.equal(exact.week.records, 2, 'explicit change-only recovery uses the same policy key as the live writer');
  assert.equal(exact.week.polls, 1, 'donor poll metrics are not imported');
  const again = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath, input: 'mqtt',
    workDirectory: join(f.directory, 'work') });
  assert.equal(again.counts.missing, 0);
  assert.equal((await recoverHistory({ signal: f.signal, store: f.master, donorPath, input: 'mqtt', preview: again })).report.imported, 0);
  assert.equal(hash(donorPath), beforeHash, 'both service phases keep source bytes unchanged');
});

test('master pending and partial finalized energy reject donor phase cohorts atomically across source and device labels', async t => {
  for (const kind of ['pending', 'finalized']) await t.test(kind, async t => {
    const f = memory(t); pending(f.donor);
    if (kind === 'pending') pending(f.target, { source: 'alternate-acquisition', device: 'replacement-meter', from: start + HOUR, to: start + 2 * HOUR });
    else finalized(f.target, { source: 'alternate-acquisition', device: 'replacement-meter', from: start + HOUR, to: start + 2 * HOUR, phases: [2] });
    const stateBefore = f.target.db.prepare('SELECT * FROM state').all();
    const report = await f.merge().run();
    assert.equal(report.counts.conflicts, 3); assert.equal(report.counts.missing, 0);
    assert.equal(f.target.observations().length, kind === 'pending' ? 0 : 1);
    assert.deepEqual(f.target.db.prepare('SELECT * FROM state').all(), stateBefore);
  });
});

test('finalized donor phases also respect pending and partial finalized master cohorts', async t => {
  for (const kind of ['pending', 'finalized']) await t.test(kind, async t => {
    const f = memory(t); finalized(f.donor);
    if (kind === 'pending') pending(f.target, { source: 'other-source', from: start + HOUR, to: start + 2 * HOUR });
    else finalized(f.target, { from: start + HOUR, to: start + 2 * HOUR, phases: [2] });
    const report = await f.merge().run();
    assert.equal(report.counts.conflicts, 3); assert.equal(report.counts.missing, 0);
    assert.equal(f.target.observations().length, kind === 'pending' ? 0 : 1);
  });
});

test('energy tail writes, provenance and saved statistics roll back together if any phase insert fails', async t => {
  const f = memory(t); pending(f.donor);
  const merge = f.merge(), insert = merge.insert.bind(merge); let writes = 0;
  merge.insert = (table, row) => {
    if (table === 'observations' && ++writes === 2) throw new Error('synthetic disk failure');
    return insert(table, row);
  };
  await assert.rejects(merge.run(), /synthetic disk failure/);
  for (const table of ['observations', 'recovery_provenance', 'recorder_metrics'])
    assert.equal(f.target.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  assert.equal((await f.merge().run()).counts.missing, 3);
  assert.equal((await f.merge().run()).counts.missing, 0);
  assert.equal(f.target.db.prepare('SELECT SUM(records) n FROM recorder_metrics').get().n, 3);
});

test('interrupted tail recovery resumes complete cohorts and never resurrects a removed accepted phase', async t => {
  const f = memory(t); pending(f.donor); pending(f.donor, { prefix: 'ev1' });
  await assert.rejects(f.merge({ progress() { throw new Error('synthetic interruption'); } }).run(), /synthetic interruption/);
  assert.equal(f.target.observations().length, 3);
  assert.equal((await f.merge().run()).counts.missing, 3);
  assert.equal(f.target.observations().length, 6);
  const removed = f.target.observations().find(row => row.signal === 'property_energy_l2').id;
  f.target.db.prepare('DELETE FROM observations WHERE id=?').run(removed);
  for (let i = 0; i < 2; i++) {
    const report = await f.merge().run();
    assert.equal(report.counts.missing, 0); assert.equal(report.counts.conflicts, 3);
    assert.equal(f.target.observations().length, 5);
  }
});

test('a later donor snapshot cannot extend an already recovered tail by overlapping its accepted history', async t => {
  const f = memory(t); pending(f.donor);
  assert.equal((await f.merge().run()).counts.missing, 3);
  pending(f.donor, { to: END + HOUR, energies: [50, 100, 150] });
  const report = await f.merge({ donorDigest: 'b'.repeat(64) }).run();
  assert.equal(report.counts.conflicts, 3); assert.equal(report.counts.missing, 0);
  assert.deepEqual(f.target.observations().map(row => row.value), [49, 98, 147]);
});

test('removed finalized phases reject dependent coverage after interrupted recovery without losing tombstones', async t => {
  const f = memory(t);
  new Recorder(f.donor).recordEnergy({ source: 'easee', device: 'invented-meter', prefix: 'property', start, end: END,
    energies: [49, 98, 147], powers: [1, 2, 3] });
  await assert.rejects(f.merge({ progress() { throw new Error('interrupted before coverage'); } }).run(), /interrupted before coverage/);
  assert.equal(f.target.observations().length, 3);
  const removed = f.target.observations().find(row => row.signal === 'property_energy_l2').id;
  f.target.db.prepare('DELETE FROM observations WHERE id=?').run(removed);
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await f.merge().run();
    assert.equal(report.counts.conflicts, 3); assert.equal(report.counts.skipped, 3);
    assert.equal(report.counts.missing, 0); assert.equal(f.target.observations().length, 2);
    assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage').get().n, 0);
    assert.equal(f.target.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  }
});

test('invalid, future, incomplete and conflicting donor tails are skipped without synthesizing energy', async t => {
  const cases = {
    retained: state => { state.pending.quality = ['retained']; },
    invalidFlag: state => { state.pending.quality = ['integration-gap']; },
    nonstringFlag: state => { state.pending.quality = [1]; },
    future: state => { state.pending.receivedAt = state.lastReceivedAt = END + 2 * HOUR; },
    receiptBeforeEnd: state => { state.pending.receivedAt = state.lastReceivedAt = END - 1; },
    mismatchedEnd: state => { state.lastEnd--; },
    mismatchedReceipt: state => { state.lastReceivedAt--; },
    incomplete: state => { state.pending.energies.pop(); },
    unknownValue: state => { state.pending.energies[1] = null; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = memory(t), { key, state } = pending(f.donor); change(state); f.donor.setState(key, state);
    const report = await f.merge().run();
    assert.equal(report.counts.missing, 0); assert.ok(report.counts.skipped > 0); assert.equal(f.target.observations().length, 0);
  });
  await t.test('malformed identity and donor overlap', async t => {
    const f = memory(t), { state } = pending(f.donor);
    f.donor.setState('recorder:energy:{}', state);
    finalized(f.donor, { from: start + HOUR, to: start + 2 * HOUR });
    const merge = f.merge(); await merge.pendingEnergy();
    assert.equal(merge.report.counts.skipped, 2); assert.equal(f.target.observations().length, 0);
  });
  await t.test('two donor devices contradict the same physical stream', async t => {
    const f = memory(t); pending(f.donor); pending(f.donor, { source: 'alternate-source', device: 'replacement-meter' });
    const report = await f.merge().run();
    assert.equal(report.counts.skipped, 2); assert.equal(f.target.observations().length, 0);
  });
});

test('completed-hour equipment energy does not conflict with physical charger tails using the same signal', async t => {
  const f = memory(t);
  pending(f.donor, { prefix: 'ev2', device: 'ev2', source: 'shelly-evse' });
  f.target.observation({ source: 'mqtt-equipment', device: 'ev2', signal: 'ev2_energy_l1', unit: 'kWh', value: 1,
    sourceTime: start + HOUR, receivedAt: start + HOUR, quality: [],
    raw: { intervalStart: start, intervalEnd: start + HOUR, timeBasis: 'completed-hour' } });
  assert.equal((await f.merge().run()).counts.missing, 3);
  assert.equal(f.target.observations().length, 4);
});

test('malformed finalized phase members reject the whole cohort without aborting other recovery', async t => {
  const f = memory(t); finalized(f.donor);
  f.donor.db.prepare("UPDATE observations SET quality='malformed' WHERE signal='property_energy_l2'").run();
  pending(f.donor, { prefix: 'ev2', device: 'invented-charger' });
  const report = await f.merge().run();
  assert.equal(report.counts.skipped, 3); assert.equal(report.counts.missing, 3);
  assert.deepEqual(f.target.observations().map(row => row.signal), ['ev2_energy_l1', 'ev2_energy_l2', 'ev2_energy_l3']);
});

test('recovered archival energy before metric pruning stays readable without recreating old metric buckets', async t => {
  const f = memory(t);
  const recorder = new Recorder(f.target);
  recorder.recordEnergy({ source: 'easee', device: 'invented-meter', prefix: 'property', start: END + HOUR, end: END + 2 * HOUR,
    energies: [1, 2, 3], powers: [1, 2, 3] });
  const global = f.target.getState('recorder:global:v2'); global.metricsPrunedBefore = END + HOUR;
  f.target.setState('recorder:global:v2', global);
  pending(f.donor);
  assert.equal((await f.merge().run()).counts.missing, 3);
  assert.equal(f.target.db.prepare('SELECT COUNT(*) n FROM recorder_metrics WHERE bucket<?').get(global.metricsPrunedBefore).n, 0);
  assert.ok(recorder.status(END + 2 * HOUR).parameters.every(row => row.week.records === 2),
    'historical fallback counts the recovered raw records exactly');
});
