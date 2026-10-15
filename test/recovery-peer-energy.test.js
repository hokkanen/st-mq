import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, start, HOUR } from './helpers/recovery-fixture.js';
import { Store } from '../src/storage/store.js';
import { enrollJournalPeer } from '../src/storage/journal-peer.js';
import { PeerTransfers, validPeerTransfer } from '../src/replication/coalesced.js';
import { openJournalSource } from '../src/recovery/incremental-source.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { recoveryPreview, recoverHistory } from '../src/recovery/service.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { pendingEnergyObservationsFromStates } from '../src/storage/pending-energy.js';

const source = 'synthetic', device = 'synthetic-meter';
const energyKey = `recorder:energy:${JSON.stringify([source, device, 'property'])}`;
function closed(store, { from = start, to = start + HOUR, values = [1, 2, 3], phases = [1, 2, 3] } = {}) {
  return store.transaction(() => phases.map(phase => store.observation({ source, device,
    signal: `property_energy_l${phase}`, unit: 'kWh', value: values[phase - 1],
    sourceTime: to, receivedAt: to, quality: [],
    raw: { intervalStart: from, intervalEnd: to, basis: 'integrated-power-phase-allocation' } })));
}
function pending(store, { from = start, to = start + HOUR, values = [4, 5, 6] } = {}) {
  const state = { lastEnd: to, lastReceivedAt: to,
    pending: { start: from, end: to, receivedAt: to, energies: values, quality: [] },
    lastPowers: [1, 1, 1], lastQuality: [], scales: [null, null, null] };
  store.setState(energyKey, state);
  return state;
}
async function fork(f) {
  const anchor = enrollJournalPeer(f.master.db).checkpoint;
  return { donor: await f.donor(), anchor };
}
const recorderStates = store => store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:%' ORDER BY key").all();
async function withSource(t, f, donor, anchor, use) {
  const transfers = new PeerTransfers(join(f.directory, 'peer-wire'));
  const metadata = await transfers.export({ dbPath: donor.path, after: anchor, signal: t.signal });
  assert.equal(validPeerTransfer(metadata), true);
  const donorJournalPath = join(transfers.directory, `peer-${metadata.id}.changes`);
  const wire = await readFile(donorJournalPath), checkpoint = donor.checkpoint(), states = recorderStates(donor);
  let overlay, primaryError;
  try {
    overlay = await openJournalSource({ masterPath: f.master.path, journalPath: donorJournalPath,
      yieldControl: async () => {} });
    assert.equal(overlay.journalSource, true);
    assert.equal(overlay.incremental.checkpoint.hash, checkpoint.hash);
    assert.equal(overlay.db.prepare("SELECT type FROM temp.sqlite_schema WHERE name='observations'").get().type, 'view');
    return await use({ overlay, donorJournalPath, metadata });
  } catch (error) { primaryError = error; throw error; }
  finally {
    let guardError;
    try {
      assert.deepEqual(donor.checkpoint(), checkpoint);
      assert.deepEqual(recorderStates(donor), states);
      assert.deepEqual(await readFile(donorJournalPath), wire);
    } catch (error) { guardError = error; }
    try { await overlay?.close(); } catch (error) { guardError ??= error; }
    if (guardError) {
      if (primaryError) t.diagnostic(`Source preservation or cleanup also failed: ${guardError.message}`);
      else throw guardError;
    }
  }
}
const groups = (store, from, to) => [...recordedEnergyGroups(store, {
  from, to, now: to, input: 'mqtt', prefix: 'property',
})].map(row => ({ start: row.start, end: row.end, values: row.values, pending: row.pending }));
async function mergeIntoEmpty(overlay, metadata, use) {
  const target = new Store(':memory:');
  try {
    const report = await new HistoryMerge({ target, donor: overlay, donorDigest: metadata.target.hash,
      input: 'mqtt', now: start + 4 * HOUR, yieldControl: async () => {} }).run();
    await use(target, report);
  } finally { await target.close(); }
}

test('peer journal service recovers admitted pending energy and retries without duplicating history', async t => {
  const f = fixture(t);
  closed(f.master, { values: [0.1, 0.2, 0.3] });
  f.master.setState('synthetic-local-control', { origin: 'shared', enabled: false });
  const { donor, anchor } = await fork(f);
  f.master.setState('synthetic-local-control', { origin: 'local', enabled: false });
  closed(donor, { from: start + HOUR, to: start + 2 * HOUR, values: [0.4, 0.5, 0.6] });
  const state = pending(donor, { from: start + 2 * HOUR, to: start + 3 * HOUR, values: [0.7, 0.8, 0.9] });
  await withSource(t, f, donor, anchor, async ({ overlay, donorJournalPath }) => {
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM main.observations').get().n, 3);
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 6);
    const scoped = overlay.db.prepare(`SELECT key,value FROM ${overlay.recoveryState} WHERE key=?`).get(energyKey);
    assert.deepEqual(JSON.parse(scoped.value), state);
    assert.deepEqual(pendingEnergyObservationsFromStates([scoped], { now: start + 3 * HOUR, input: 'mqtt' })
      .map(row => row.value), [0.7, 0.8, 0.9]);
    const args = { masterPath: f.master.path, donorJournalPath, input: 'mqtt', signal: t.signal };
    const preview = await recoveryPreview(args);
    assert.equal(preview.tables.find(row => row.name === 'observations').count, 3);
    assert.equal(preview.tables.find(row => row.name === 'recorder_pending_energy').count, 1);
    const result = await recoverHistory({ ...args, store: f.master, preview });
    assert.equal(result.report.imported, 6);
    assert.equal(result.report.tables.find(row => row.name === 'observations').missing, 3);
    assert.equal(result.report.tables.find(row => row.name === 'recorder_pending_energy').missing, 3);
    const frozen = f.master.observations().filter(row => row.raw?.recovery?.kind === 'frozen-recorder-energy');
    assert.deepEqual(frozen.map(row => row.value), [0.7, 0.8, 0.9]);
    assert(frozen.every(row => row.sourceTime === start + 3 * HOUR && row.receivedAt === start + 3 * HOUR
      && row.raw.intervalStart === start + 2 * HOUR && row.raw.intervalEnd === start + 3 * HOUR && !row.raw.pending));
    assert.equal(f.master.getState(energyKey), null);
    assert.deepEqual(f.master.getState('synthetic-local-control'), { origin: 'local', enabled: false });
    assert.deepEqual(groups(overlay, start + HOUR, start + 3 * HOUR), [
      { start: start + HOUR, end: start + 2 * HOUR, values: [0.4, 0.5, 0.6], pending: false },
      { start: start + 2 * HOUR, end: start + 3 * HOUR, values: [0.7, 0.8, 0.9], pending: true },
    ]);
    const rows = f.master.db.prepare('SELECT * FROM observations ORDER BY id').all();
    assert.equal(rows.length, 9);
    const again = await recoverHistory({ ...args, store: f.master, preview: await recoveryPreview(args) });
    assert.equal(again.report.imported, 0);
    assert.deepEqual(f.master.db.prepare('SELECT * FROM observations ORDER BY id').all(), rows);
    assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  });
});

for (const phases of [[1, 2, 3], [2]]) test(`peer pending validation retains unchanged shared-prefix ${phases.length === 3 ? 'contradictory' : 'partial'} finalized evidence`, async t => {
  const f = fixture(t);
  closed(f.master, { phases });
  const { donor, anchor } = await fork(f);
  pending(donor);
  await withSource(t, f, donor, anchor, async ({ overlay, metadata }) => {
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, 0,
      'the scoped changed-key closure deliberately omits the shared prefix');
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM observations').get().n, phases.length);
    await mergeIntoEmpty(overlay, metadata, async (target, report) => {
      assert.equal(report.tables.find(row => row.name === 'recorder_pending_energy').skipped, 1);
      assert.equal(report.counts.missing, 0);
      assert.equal(target.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0,
        'an empty target cannot hide a failure to validate the donor full evidence');
    });
  });
});

test('peer pending validation applies donor exclusions to unchanged shared-prefix evidence', async t => {
  const f = fixture(t), ids = closed(f.master);
  const { donor, anchor } = await fork(f);
  donor.transaction(() => {
    donor.db.prepare('UPDATE history_selection SET generation=? WHERE id=1').run('synthetic-donor-selection');
    const exclude = donor.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES(?,'observations',?)");
    for (const id of ids) exclude.run('synthetic-donor-selection', String(id));
  });
  pending(donor);
  await withSource(t, f, donor, anchor, async ({ overlay, metadata }) => {
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 3);
    assert.equal(overlay.db.prepare('SELECT COUNT(*) n FROM active_observations').get().n, 0);
    assert.equal(overlay.db.prepare('SELECT generation FROM main.history_selection').get().generation, 'original');
    assert.equal(overlay.db.prepare('SELECT generation FROM history_selection').get().generation, 'synthetic-donor-selection');
    await mergeIntoEmpty(overlay, metadata, async (target, report) => {
      assert.equal(report.tables.find(row => row.name === 'recorder_pending_energy').missing, 3);
      assert.equal(report.counts.missing, 3);
      assert.deepEqual(target.observations().map(row => row.value), [4, 5, 6]);
      assert.equal(target.getState(energyKey), null);
    });
  });
});

test('peer pending validation uses changed donor interval bounds and values from the raw overlay', async t => {
  const f = fixture(t), ids = closed(f.master, { values: [9, 9, 9] });
  const { donor, anchor } = await fork(f);
  donor.transaction(() => {
    const update = donor.db.prepare('UPDATE observations SET value=?,source_time=?,received_at=?,raw=? WHERE id=?');
    for (let index = 0; index < ids.length; index++) update.run(index + 4, start + 2 * HOUR, start + 2 * HOUR,
      JSON.stringify({ intervalStart: start + HOUR, intervalEnd: start + 2 * HOUR,
        basis: 'integrated-power-phase-allocation' }), ids[index]);
  });
  pending(donor, { values: [1, 2, 3] });
  await withSource(t, f, donor, anchor, async ({ overlay, metadata }) => {
    assert.deepEqual(overlay.db.prepare('SELECT value FROM main.observations ORDER BY signal').all().map(row => row.value), [9, 9, 9]);
    assert.deepEqual(groups(overlay, start, start + 2 * HOUR), [
      { start, end: start + HOUR, values: [1, 2, 3], pending: true },
      { start: start + HOUR, end: start + 2 * HOUR, values: [4, 5, 6], pending: false },
    ]);
    await mergeIntoEmpty(overlay, metadata, async (target, report) => {
      assert.equal(report.counts.missing, 6);
      assert.equal(report.tables.find(row => row.name === 'recorder_pending_energy').missing, 3);
      assert.deepEqual(groups(target, start, start + 2 * HOUR), [
        { start, end: start + HOUR, values: [1, 2, 3], pending: false },
        { start: start + HOUR, end: start + 2 * HOUR, values: [4, 5, 6], pending: false },
      ]);
    });
  });
});
