import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { createSourceSnapshot } from '../../src/replication/transport.js';
import { recoveryPreview, recoverHistory } from '../../src/recovery/service.js';
import { appendLearningRecord, replayLearningJournal, recordLearningContext, LEARNING_WINDOW_MS } from '../../src/app/committed-learning.js';

export const start = Date.parse('2026-01-01T00:00:00Z'), HOUR = 3_600_000, W = LEARNING_WINDOW_MS;
export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-recovery-'));
  const master = new Store(join(directory, 'master.sqlite'));
  const stores = [master];
  t.after(() => { for (const store of stores) try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  // Use the same isolated snapshot worker as pairing. Node 26.8.2's native
  // async backup can wait for unrelated timers when the test runner's message
  // port keeps the calling event loop alive. The production snapshot worker
  // has no idle command port, and cancellation terminates its pending backup.
  const backup = (store, destination) => createSourceSnapshot({ dbPath: store.path, destination, signal: t.signal });
  return { directory, master, signal: t.signal, async donor() {
    const path = join(directory, 'donor.sqlite'); await backup(master, path);
    const store = new Store(path); stores.push(store); return store;
  }, async snapshot(store) {
    const path = join(directory, `snapshot-${stores.length}-${readdirSync(directory).length}.sqlite`); await backup(store, path); return path;
  } };
}
export function observation(store, at, value = 21, extra = {}) {
  return store.observation({ source: 'synthetic', device: 'invented-house', signal: 'indoor_temperature',
    unit: 'degC', value, sourceTime: at, receivedAt: at, ...extra });
}
export function sample(store, at, extra = {}) {
  const value = { timestamp: at, windowStart: at - W, windowEnd: at,
    indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0,
    targetC: 21, regime: 'occupied', quality: [], energyBasis: 'estimated', actualModeKnown: false, ...extra };
  return appendLearningRecord(store, 'mqtt', 'sample', value, { config: {} });
}
export async function recover(f, donorPath, options = {}) {
  const preview = await recoveryPreview({ signal: f.signal, masterPath: f.master.path, donorPath, input: 'mqtt', workDirectory: join(f.directory, 'work') });
  return { preview, ...(await recoverHistory({ signal: f.signal, store: f.master, donorPath, input: 'mqtt', preview, ...options })) };
}

export async function learningCatchup(t, windows) {
  const f = fixture(t);
  recordLearningContext(f.master, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  for (let i = 1; i <= 8; i++) sample(f.master, start + i * W);
  const beforeModel = replayLearningJournal(f.master, 'mqtt');
  const donor = await f.donor();
  for (let i = 9; i <= 8 + windows; i++) sample(donor, start + i * W, { indoorC: 21 + Math.sin(i / 30) * 0.1 });
  for (let i = 8 + windows + 1; i <= 8 + windows + 8; i++) sample(f.master, start + i * W);
  const old = replayLearningJournal(f.master, 'mqtt', beforeModel);
  const original = f.master.db.prepare('SELECT * FROM learning_journal ORDER BY id').all();
  const donorPath = await f.snapshot(donor);
  let beats = 0, liveWritten = false, published = null;
  const timer = setInterval(() => { beats++; }, 5); t.after(() => clearInterval(timer));
  const result = await recover(f, donorPath, { onProgress(progress) {
    if (progress.phase === 'rebuilding' && !liveWritten) {
      liveWritten = true; sample(f.master, start + (8 + windows + 9) * W);
      assert.equal(f.master.learningEpoch('mqtt'), 'original', 'old selected history remains active during rebuild');
      const continuing = replayLearningJournal(f.master, 'mqtt', old);
      assert.equal(continuing.windowCursor, start + (8 + windows + 9) * W);
    }
  }, onPublish(value) { published = value; } });
  assert.ok(beats >= 3, 'background replay leaves the main event loop responsive');
  assert.equal(liveWritten, true); assert.equal(published.epoch, result.epoch);
  assert.equal(result.report.model.acceptedSamples, windows);
  assert.equal(f.master.learningEpoch('mqtt'), result.epoch);
  assert.equal(result.checkpoint.windowCursor, start + (8 + windows + 9) * W);
  const archived = f.master.db.prepare(`SELECT id,input,key,kind,at,algorithm_version,config_version,forecast_version,payload
    FROM learning_journal_entries WHERE epoch='original' AND id<=? ORDER BY id`).all(original.at(-1).id);
  assert.deepEqual(archived, original, 'master source bytes and IDs remain an honest archival boundary');
  assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true }), result.checkpoint,
    'the selected combined journal reconstructs the published model exactly');
  assert.notDeepEqual(result.checkpoint.samples, old.samples, 'the model has consumed recovered windows');
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
  const storage = f.master.db.prepare(`SELECT COUNT(*) entries,SUM(payload IS NOT NULL) payloads,
    SUM(source_entry_id IS NOT NULL) references_count,
    SUM(COALESCE(length(payload),0)+COALESCE(length(config_version),0)+COALESCE(length(forecast_version),0)) payload_bytes
    FROM learning_journal_entries`).get();
  assert.equal(storage.references_count, original.length + 1, 'master prefix and live tail use compact source references');
  assert.equal(storage.payloads, original.length + 1 + windows, 'each accepted source payload is saved once');
  assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM learning_journal_entries a
    JOIN learning_journal_entries b ON a.source_entry_id=b.id WHERE b.source_entry_id IS NOT NULL`).get().n, 0,
  'references point directly to original input, never chains across recoveries');
  t.diagnostic(JSON.stringify({ recoveredWindows: windows, entries: storage.entries, uniquePayloads: storage.payloads,
    orderedReferences: storage.references_count, payloadBytes: storage.payload_bytes, databaseBytes: f.master.databaseBytes() }));
}

export async function energyCatchup(t, intervals) {
  const f = fixture(t), donor = await f.donor();
  f.master.setState('controller:sentinel', { mode: 'active', currentAction: 'normal' });
  donor.transaction(() => {
    for (let i = 1; i <= intervals; i++) for (let phase = 1; phase <= 3; phase++) {
      const at = start + i * 5 * 60_000;
      observation(donor, at, 0.1, { signal: `property_energy_l${phase}`, unit: 'kWh',
        raw: { intervalStart: at - 5 * 60_000, intervalEnd: at } });
    }
  });
  let beats = 0, writes = 0;
  const timer = setInterval(() => { beats++; }, 5); t.after(() => clearInterval(timer));
  const result = await recover(f, await f.snapshot(donor), { onProgress(value) {
    if (value.phase === 'importing') { f.master.event('synthetic-live-control-tick', { sequence: ++writes }, start + 8 * 24 * HOUR + writes); }
  } });
  assert.equal(result.report.imported, intervals * 3);
  assert.ok(beats > 5); assert.ok(writes > 0);
  assert.deepEqual(f.master.getState('controller:sentinel'), { mode: 'active', currentAction: 'normal' });
  const energy = f.master.db.prepare("SELECT COUNT(*) n,SUM(value) kwh FROM observations WHERE unit='kWh'").get();
  assert.equal(energy.n, intervals * 3); assert.ok(Math.abs(energy.kwh - intervals * 0.3) < 1e-8);
}
