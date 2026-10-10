import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/storage/store.js';
import { replayLearningJournal } from '../../src/app/committed-learning.js';
import { verifyDatabase } from '../../src/storage/full-verifier.js';
import { sensorChangeEvents, sensorBoundaries } from '../../src/app/sensor-inputs.js';
import { fireplaceEvents } from '../../src/app/fireplace.js';
import { generatedHistory, prepareGeneratedHistory, selectedState, originalEvidence,
  assertOriginalEvidence, runRecoveryOperation } from '../helpers/reliability-learning-history.js';

const childScript = fileURLToPath(new URL('../helpers/reliability-learning-history.js', import.meta.url));
// Reproduce one failure with STMQ_LEARNING_CRASH_SEEDS=<seed>,
// STMQ_LEARNING_CRASH_ACTIONS=<action> and STMQ_LEARNING_CRASH_BOUNDARIES=<boundary>.
// STMQ_LEARNING_CRASH_WINDOWS=48 reduces history while retaining both independent
// sensor/firewood correction pairs, source gaps, and a changed configuration.
// Default: 18 real process deaths across two deterministic generated histories.
const seeds = (process.env.STMQ_LEARNING_CRASH_SEEDS ?? '26731,51977').split(',').map(Number);
const windows = Number(process.env.STMQ_LEARNING_CRASH_WINDOWS ?? 96);
const actions = (process.env.STMQ_LEARNING_CRASH_ACTIONS ?? 'recover,revert,restore').split(',');
const boundaries = (process.env.STMQ_LEARNING_CRASH_BOUNDARIES ?? 'before-publication,during-publication,after-commit').split(',');
assert(seeds.length > 0 && seeds.length <= 16 && seeds.every(seed => Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffffffff));
assert(Number.isSafeInteger(windows) && windows >= 48 && windows <= 512);
assert(actions.length > 0 && actions.every(action => ['recover', 'revert', 'restore'].includes(action)));
assert(boundaries.length > 0 && boundaries.every(boundary => ['before-publication', 'during-publication', 'after-commit'].includes(boundary)));

for (const seed of seeds) test(`generated learning ${seed}: process death cannot partially publish recovery or source revisions`, async t => {
  const directory = mkdtempSync(join(tmpdir(), `stmq-learning-crash-${seed}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const trace = generatedHistory(seed, windows), donorPath = join(directory, 'donor-portable.sqlite');
  const baselines = Object.fromEntries(['recover', 'revert', 'restore'].map(action => [action, join(directory, `${action}-baseline.sqlite`)]));
  await prepareGeneratedHistory({ masterPath: baselines.recover, donorPath: join(directory, 'donor.sqlite'), donorSnapshot: donorPath, trace });
  for (const [action, prior, next] of [['recover', 'recover', 'revert'], ['revert', 'revert', 'restore']]) {
    // Each source is closed before copying; no live WAL is omitted.
    copyFileSync(baselines[prior], baselines[next]);
    const store = new Store(baselines[next]);
    try { await runRecoveryOperation(store, donorPath, action, { signal: t.signal }); }
    finally { store.close(); }
  }
  for (const action of actions) for (const boundary of boundaries) {
    await t.test(`${action} / ${boundary}`, async t => {
      const path = join(directory, `${action}-${boundary}.sqlite`);
      copyFileSync(baselines[action], path);
      let store = new Store(path);
      const before = selectedState(store), original = originalEvidence(store);
      const decisionsBefore = store.db.prepare('SELECT COUNT(*) n FROM recovery_decisions').get().n;
      store.close(); store = null;
      try {
        const args = [childScript, '--crash-child', path, donorPath, action, boundary];
        if (boundary === 'during-publication') {
          // A startup preload is inherited by worker threads; mutating the
          // parent's process.execArgv after startup does not install a preload.
          const hook = new URL('../helpers/learning-publication-crash-hook.js', import.meta.url);
          hook.searchParams.set('path', path); hook.searchParams.set('action', action);
          args.unshift('--import', hook.href);
        }
        const killed = spawnSync(process.execPath, args,
          { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
        assert.equal(killed.signal, 'SIGKILL', killed.stderr || killed.error?.message);
        const witnessed = JSON.parse(readFileSync(`${path}.crash.json`, 'utf8'));
        assert.equal(witnessed.boundary, boundary);
        assert.equal(witnessed.inTransaction, boundary === 'during-publication');
        assert.equal(witnessed.threadId > 0, boundary === 'during-publication',
          'only the in-transaction crash originates in the actual publication worker');
        store = new Store(path);
        const reopened = selectedState(store), published = boundary === 'after-commit';
        assertOriginalEvidence(store, original);
        assert.deepEqual(reopened.authority, before.authority);
        const decisionsAfter = store.db.prepare('SELECT COUNT(*) n FROM recovery_decisions').get().n;
        assert.equal(decisionsAfter, decisionsBefore + Number(published && action !== 'recover'));
        if (!published) {
          assert.deepEqual(reopened, before, 'partial publication leaves the complete previous selection and checkpoint');
          assert.notEqual(store.getState('recovery:active:mqtt')?.status, 'complete');
          const frozen = replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false,
            fireplaceRevision: before.checkpoint.fireplaceRevision ?? 0, sensorRevision: before.checkpoint.sensorRevision ?? 0 });
          assert.deepEqual(frozen, before.checkpoint, 'the retained old source revisions still reconstruct the complete previous checkpoint');
        } else {
          assert.notEqual(reopened.epoch, before.epoch);
          assert.equal(store.getState('recovery:active:mqtt').status, 'complete');
          assert.equal(store.getState('fireplace:rebuild:mqtt').status, 'current');
          assert.equal(store.getState('pending-plan:mqtt'), null);
        }
        await verifyDatabase({ dbPath: path, signal: t.signal });
        if (!published) await runRecoveryOperation(store, donorPath, action, { signal: t.signal });
        assertOriginalEvidence(store, original);
        const final = selectedState(store);
        assert.equal(store.getState('recovery:active:mqtt').status, 'complete');
        assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), final.checkpoint,
          'every field of the completed model reconstructs from selected retained inputs');
        assert.deepEqual(final.authority, before.authority);
        assert.equal(final.authority.length, 2, 'real durable permission and restoration state are both preserved byte for byte');
        const changes = sensorChangeEvents(store, 'mqtt');
        assert.equal(changes.length, action === 'revert' ? 1 : 2);
        assert(changes.every(change => change.revertedAt !== null), 'both selected corrections still cancel their original sensor changes');
        assert.deepEqual(sensorBoundaries(store, 'mqtt', Number.MAX_SAFE_INTEGER), {});
        assert.deepEqual(fireplaceEvents(store, 'mqtt').events, [], 'removed firewood supplies no selected heat');
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM active_fireplace_events').get().n, action === 'revert' ? 2 : 4,
          'reverting recovery changes source selection and keeps the independent original correction pair');
        const selected = store.learningJournal({ input: 'mqtt', limit: 1000 }).filter(row => row.kind === 'sample');
        const expectedTimes = trace.filter(row => row.n <= 16 || row.n > Math.floor(windows * 2 / 3)
          || action !== 'revert' && !row.gap).map(row => row.at);
        assert.deepEqual(selected.map(row => row.at), expectedTimes,
          'recovery retries neither omit nor duplicate usable donor samples; missing donor measurements remain unavailable');
        const missing = store.db.prepare("SELECT value,quality,source_time,received_at,unit FROM observations WHERE source='synthetic' AND source_time=?");
        for (const row of trace.filter(row => row.gap)) {
          const retained = missing.all(row.at);
          assert.equal(retained.length, 1, 'unavailable source observations remain retained once, including rejected learning inputs');
          assert.equal(retained[0].value, null);
          assert(JSON.parse(retained[0].quality).includes('missing'));
          assert.equal(retained[0].source_time, row.at); assert.equal(retained[0].received_at, row.at);
          assert.equal(retained[0].unit, 'degC');
        }
        await verifyDatabase({ dbPath: path, signal: t.signal });
        store.close(); store = new Store(path);
        assert.deepEqual(selectedState(store), final, 'restart preserves the complete published tuple');
        assert.deepEqual(replayLearningJournal(store, 'mqtt', final.checkpoint, { persistCheckpoint: false }), final.checkpoint,
          'an unchanged restart has no further learning update');
      } catch (error) {
        t.diagnostic(JSON.stringify({ seed, windows, action, boundary,
          columns: ['window', 'indoorC', 'outdoorC', 'solarWm2', 'gap', 'compressorKw'],
          trace: trace.map(row => [row.n, row.indoorC, row.outdoorC, row.solarRadiationWm2, row.gap, row.config.heatPumpCompressorKw]) }));
        throw error;
      } finally { store?.close(); }
    });
  }
  t.diagnostic(JSON.stringify({ seed, windows, cases: actions.length * boundaries.length,
    evidence: 'real process SIGKILL, full checkpoint equality and source preservation; not physical power-loss qualification' }));
});
