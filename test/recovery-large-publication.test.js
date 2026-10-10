import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { appendLearningRecord, replayLearningJournal, LEARNING_WINDOW_MS as WINDOW } from '../src/app/committed-learning.js';
import { previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { publishLearning } from '../src/app/learning-publication.js';
import { fixture, recover, start } from './helpers/recovery-fixture.js';

const HOUR = 3_600_000;

// Frequent real inputs can divide a fifteen-minute window into many segments.
// All fields below are current resolved inputs, not an oversized padding string.
function richSample(at) {
  const segmentCount = 30, durationHours = WINDOW / segmentCount / HOUR;
  const inputSegments = Array.from({ length: segmentCount }, (_, index) => ({
    start: at - WINDOW + index * WINDOW / segmentCount,
    end: at - WINDOW + (index + 1) * WINDOW / segmentCount,
    outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0, targetC: 21,
    regime: 'occupied', episodeId: null, supplyC: 35 + index / 10, brineC: 0,
    compressorHeatKw: 9.4, sourceRelativeUncertainty: 0.25,
    sourceEstimateBasis: 'manufacturer-two-point-estimate; not measured heat or electricity',
    sourceUncertaintyReasons: ['installed-model-not-confirmed'], sourcePumpsIncluded: true,
    floorOverrideMode: 'off', treatmentKey: 'normal', compressorDuty: 1,
    compressorPowerKw: 2.2, circulationKw: 0, dhwrKw: 0, auxKw: 0, powerKw: 2.2,
    thermalCompressorDuty: 1, thermalAuxKw: 0, auxRoute: 'space',
    dhwCompressorDuty: 0, dhwAuxKw: 0, auxiliaryStage: 'off',
    auxiliaryPowerBasis: 'observed-output-stage', integral: -100 + index, supplyShortfallC: 1,
    operatingMode: 1, quality: [], hydronicHeatKw: 9.4,
    compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true,
    actualModeKnown: true, energyBasis: 'estimated', configurationVersion: 'a'.repeat(64),
    durationHours, energyKwh: 2.2 * durationHours, hydronicHeatKwh: 9.4 * durationHours,
    compressorKwh: 2.2 * durationHours, spaceHeatingAuxKwh: 0, dhwAuxKwh: 0,
  }));
  return { sensorInputVersion: 1, timestamp: at, windowStart: at - WINDOW, windowEnd: at,
    indoorC: 21, outdoorC: 2, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied',
    roomBoostC: 0, targetC: 21, quality: [], actualModeKnown: true, energyBasis: 'estimated',
    thermalCompressorDuty: 1, thermalAuxKw: 0,
    heating: { verified: true, compressorActive: true, compressorDuty: 1, route: 'space-heating', quality: [] },
    indoorSensors: { indoor_temperature: { value: 21, weight: 1, observedAt: at,
      reportCoverageComplete: true, reportCoveredThrough: at,
      reportIntervals: [{ start: at - WINDOW, end: at, observedAt: at, endpoint: true }] } }, inputSegments };
}


test('recovery, revert and restore publish incident-sized checkpoints atomically and retain exact replay', { timeout: 60000 }, async t => {
  const f = fixture(t), config = { indoorSensorWeights: { indoor_temperature: 1 } };
  const append = (store, index) => store.transaction(() => appendLearningRecord(store, 'mqtt', 'sample',
    richSample(start + index * WINDOW), { config }));
  for (let index = 1; index <= 24; index++) append(f.master, index);
  const donor = await f.donor(); append(donor, 25);
  for (let index = 26; index <= 49; index++) append(f.master, index);
  const original = replayLearningJournal(f.master, 'mqtt', null, { rebuild: true, persistCheckpoint: false });
  f.master.setState('adaptive:mqtt', original);
  const charging = { automatic: false, equipment: 'synthetic-current-equipment', session: 'synthetic-current-session',
    restoration: { currentA: 6, pending: true } };
  f.master.setState('synthetic-current-charging-intent', charging);
  const originalJournal = f.master.db.prepare('SELECT * FROM learning_journal_entries ORDER BY id').all();
  assert.equal(original.samples.length, 48);
  const checkpointBytes = Buffer.byteLength(JSON.stringify(original));
  assert(checkpointBytes > 1.7 * 1024 ** 2, `resolved input segments reproduce the large cache (${checkpointBytes} bytes)`);
  t.diagnostic(JSON.stringify({ checkpointBytes }));
  let published = 0;
  const checkPublication = result => {
    published++;
    assert.equal(f.master.learningEpoch('mqtt'), result.epoch);
    assert.deepEqual(f.master.getState('adaptive:mqtt'), result.checkpoint);
    assert.equal(f.master.getState('recovery:active:mqtt').status, 'complete');
    assert.deepEqual(f.master.getState('synthetic-current-charging-intent'), charging);
  };
  const recovered = await recover(f, await f.snapshot(donor), { onPublish: checkPublication });
  assert.equal(recovered.report.model.status, 'rebuilt');
  const recoveryId = recovered.report.recoveryId;
  async function verify(result, samples) {
    assert.equal(result.checkpoint.samples.length, samples);
    assert.deepEqual(replayLearningJournal(f.master, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), result.checkpoint);
    const reopened = new Store(f.master.path, { readOnly: true });
    try {
      assert.equal(reopened.learningEpoch('mqtt'), result.epoch);
      assert.deepEqual(reopened.getState('adaptive:mqtt'), result.checkpoint);
      assert.deepEqual(replayLearningJournal(reopened, 'mqtt', null, { rebuild: true, persistCheckpoint: false }), result.checkpoint);
    } finally { reopened.close(); }
  }
  await verify(recovered, 49);
  for (const active of [false, true]) {
    const args = { store: f.master, input: 'mqtt', recoveryId, active, signal: t.signal };
    const preview = await previewRecoveryRevision(args);
    const result = await reviseRecovery({ ...args, preview, onPublish: checkPublication });
    assert.equal(result.report.model.status, 'rebuilt');
    await verify(result, active ? 49 : 48);
  }
  assert.equal(published, 3);
  assert.deepEqual(f.master.db.prepare('SELECT * FROM learning_journal_entries WHERE epoch=? ORDER BY id').all('original'),
    originalJournal, 'all original learning source bytes remain intact');
  assert.deepEqual(f.master.getState('synthetic-current-charging-intent'), charging);
  assert.equal(f.master.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(f.master.db.prepare('PRAGMA foreign_key_check').get(), undefined);
});

test('publication of a verified empty replacement clears the previous adaptive cache', async t => {
  const f = fixture(t);
  appendLearningRecord(f.master, 'mqtt', 'sample', richSample(start + WINDOW), { config: {} });
  const previous = replayLearningJournal(f.master, 'mqtt');
  assert(previous.journalCursor > 0);
  const operationToken = 'synthetic-empty-publication', epoch = 'synthetic-empty-epoch', runId = 'synthetic-empty-run';
  f.master.transaction(() => {
    f.master.setState('recovery:active:mqtt', { status: 'rebuilding', operationToken });
    f.master.db.prepare(`INSERT INTO recovery_runs(id,input,donor_digest,previous_epoch,epoch,status,started_at)
      VALUES(?,?,?,?,?,?,?)`).run(runId, 'mqtt', 'synthetic-digest', 'original', epoch, 'rebuilding', start);
  });
  let adopted = false;
  const result = await publishLearning({ store: f.master, input: 'mqtt', kind: 'recovery',
    context: { operationToken, previewId: 'synthetic-reviewed-source' }, signal: t.signal,
    message: { sourceSelection: 'original', sourceEpoch: 'original', sourceHead: previous.journalCursor,
      fireplaceRevision: 0, sourceSensorRevision: 0, sensorRevision: 0, epoch, runId,
      checkpoint: null, prefixCheckpoint: null, report: { counts: { missing: 0, skipped: 0, conflicts: 0 }, model: {} } },
    onPublish(value) { adopted = true; assert.equal(value.checkpoint, null); } });
  assert(adopted);
  assert.equal(result.checkpoint, null);
  assert.equal(f.master.learningEpoch('mqtt'), epoch);
  assert.equal(f.master.learningJournalHead('mqtt'), 0);
  assert.equal(f.master.getState('adaptive:mqtt'), null);
  assert.equal(f.master.db.prepare('SELECT COUNT(*) n FROM learning_journal_entries WHERE epoch=?').get('original').n, 1);
});
