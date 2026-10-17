import test from 'node:test';
import assert from 'node:assert/strict';
import { Recorder } from '../src/storage/recorder.js';
import { appendLearningRecord, committedLearningSample, recordLearningContext, replayLearningJournal } from '../src/app/committed-learning.js';
import { originalSensorSample } from '../src/app/sensor-samples.js';
import { recoverHistory, recoveryPreview, previewRecoveryRevision, reviseRecovery } from '../src/recovery/service.js';
import { indoorReportCoverage, lastIndoorReading } from '../src/app/indoor-readings.js';
import { chartCoverageRows } from '../src/app/chart-coverage.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { recordedEnergyGroups } from '../src/storage/energy-history.js';
import { indoorStatusMetadata } from '../src/app/temperature-status.js';
import { historicalHeatPumpIntervals, recordHeatPumpConfiguration } from '../src/app/chart-heat-pump.js';
import { fixture, start } from './helpers/recovery-fixture.js';

const MINUTE = 60_000;
const routeSignature = 'a'.repeat(64);
const config = { heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025 };
function recordMinute(recorder, minute, { indoor = true, sourceDelayMs = 0 } = {}) {
  const at = start + minute * MINUTE;
  for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0],
    ['compressor_active', 1], ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0],
    ['operating_mode', 1], ['heating_setpoint', 21], ['supply_temperature', 30]]) {
    if (signal === 'indoor_temperature' && !indoor) continue;
    const source = signal === 'outdoor_temperature' ? 'fmi' : signal === 'indoor_temperature' ? 'mqtt-temperature' : 'husdata-h66';
    recorder.record({ source, device: source === 'fmi' ? 'invented-weather' : source === 'mqtt-temperature' ? signal : 'invented-gateway',
      signal, value, unit: signal.endsWith('_temperature') || signal === 'heating_setpoint' ? 'degC' : signal === 'auxiliary_output' ? '%' : 'state',
      sourceTime: at - sourceDelayMs, receivedAt: at, quality: [], raw: { verified: true, usableForControl: true, retained: false,
        ...(signal === 'indoor_temperature' ? { reportIntervalMs: MINUTE, reportGraceMs: 2 * MINUTE,
          temperatureRouteSignature: routeSignature } : {}) } });
  }
}

test('current Recorder continuation of a shared prefix admits a usable donor learning sample over the local missing window', async t => {
  const f = fixture(t), masterRecorder = new Recorder(f.master);
  recordLearningContext(f.master, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start, { config });
  recordHeatPumpConfiguration(f.master, 'providers', config, start);
  for (let minute = 0; minute <= 5; minute++) recordMinute(masterRecorder, minute);
  for (let phase = 1; phase <= 3; phase++) f.master.observation({ source: 'easee', device: 'invented-meter',
    signal: `property_energy_l${phase}`, unit: 'kWh', value: phase / 10, sourceTime: start + 5 * MINUTE,
    receivedAt: start + 5 * MINUTE, quality: [], raw: { intervalStart: start, intervalEnd: start + 5 * MINUTE,
      basis: 'integrated-power-phase-allocation' } });
  const energy = () => [...recordedEnergyGroups(f.master, { input: 'providers', prefix: 'property', from: start,
    to: start + 45 * MINUTE, now: start + 45 * MINUTE })].map(row => [row.start, row.end, row.values]);
  const originalEnergy = energy();
  assert.deepEqual(originalEnergy, [[start, start + 5 * MINUTE, [0.1, 0.2, 0.3]]]);
  const localPrefix = f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const donor = await f.donor(), donorRecorder = new Recorder(donor), at = start + 15 * MINUTE;
  for (let minute = 6; minute <= 15; minute++) recordMinute(donorRecorder, minute);
  const donorSample = committedLearningSample({ store: donor, input: 'providers', at, config });
  assert.deepEqual(originalSensorSample(donorSample).quality, []);
  assert.equal(originalSensorSample(donorSample).indoorC, 21);
  assert.equal(originalSensorSample(donorSample).outdoorC, 0);
  appendLearningRecord(donor, 'providers', 'sample', donorSample, { config });
  for (let minute = 16; minute <= 20; minute++) recordMinute(donorRecorder, minute);
  const masterSample = committedLearningSample({ store: f.master, input: 'providers', at, config });
  assert.equal(originalSensorSample(masterSample).indoorC, null);
  appendLearningRecord(f.master, 'providers', 'sample', masterSample, { config });
  const before = replayLearningJournal(f.master, 'providers');
  const donorPath = await f.snapshot(donor);
  const preview = await recoveryPreview({ masterPath: f.master.path, donorPath, input: 'providers', signal: f.signal });
  const result = await recoverHistory({ store: f.master, donorPath, input: 'providers', preview, signal: f.signal });
  assert.equal(result.report.model.acceptedSamples, 1, 'same-source fresh confirmations extend the shared prefix without rejecting its journal references');
  assert.notDeepEqual(result.checkpoint, before);
  assert.deepEqual(energy(), originalEnergy, 'shared measured energy is neither duplicated nor apportioned by coverage recovery');
  const retainedDonor = donor.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const importedSpans = f.master.db.prepare(`SELECT c.* FROM recorder_coverage c JOIN recovery_members m
    ON m.table_name='recorder_coverage' AND m.record_key=CAST(c.id AS TEXT) WHERE m.recovery_id=? ORDER BY c.id`).all(result.report.recoveryId);
  assert.deepEqual(importedSpans.map(({ id, ...row }) => row), retainedDonor.map(({ id, ...row }) => row),
    'the full donor source spans and counts are retained intact as separate recovery contributions');
  assert(!f.master.db.prepare("SELECT 1 FROM recovery_members WHERE table_name='recorder_coverage' AND CAST(record_key AS INTEGER)<=?").get(localPrefix.at(-1).id),
    'shared local source rows do not become owned by this recovery');
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage WHERE id<=? ORDER BY id').all(localPrefix.at(-1).id), localPrefix,
    'original local prefix bytes remain separate from the recovered extension');
  assert.deepEqual(replayLearningJournal(f.master, 'providers', null, { rebuild: true, persistCheckpoint: false }), result.checkpoint);
  for (let minute = 6; minute <= 30; minute++) recordMinute(masterRecorder, minute, { indoor: minute % 2 === 0 });
  const localIndoor = f.master.db.prepare("SELECT * FROM recorder_coverage WHERE signal='indoor_temperature' ORDER BY id LIMIT 1").get();
  const donorIndoor = f.master.db.prepare("SELECT * FROM recorder_coverage WHERE signal='indoor_temperature' ORDER BY id DESC LIMIT 1").get();
  assert(localIndoor.end_at > donorIndoor.end_at && localIndoor.samples < donorIndoor.samples,
    'genuine slower local reporting can advance beyond donor coverage with fewer branch-local samples');
  const laterAt = start + 30 * MINUTE;
  const current = masterRecorder.committedAt('indoor_temperature', laterAt);
  assert.equal(current.value, 21, 'continued lower-ID local span stays fresh beyond the frozen donor endpoint');
  assert.equal(current.reportObservedAt, laterAt);
  const reading = lastIndoorReading(f.master, { signal: 'indoor_temperature', input: 'providers', at: laterAt });
  assert.equal(reading.stale, false);
  const metadata = indoorStatusMetadata(reading, laterAt, { store: f.master });
  assert.equal(metadata.lastReportAt, laterAt, 'diagnostics use the genuine newer local report, even with fewer confirmations');
  assert.equal(metadata.reportExpiresAt, laterAt + 3 * MINUTE);
  const union = indoorReportCoverage(f.master, { reading, from: at, at: laterAt, includeIntervals: true });
  assert.equal(union.complete, true);
  assert.equal(union.intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0), 15 * MINUTE,
    'equivalent fresh coverage contributes one duration, without counting its shared prefix twice');
  assert(![...chartCoverageRows(f.master, { input: 'providers', from: at, to: laterAt, now: laterAt,
    signals: ['indoor_temperature'] })].some(row => row.value === null), 'charts do not show expiry from the older higher-ID donor endpoint');
  const nominal = [...historicalHeatPumpIntervals({ store: f.master, input: 'providers', now: laterAt,
    range: { from: start + 25 * MINUTE, to: laterAt } })];
  assert(nominal.length > 0 && nominal.every(row => row.kw === 3.08 && row.quality === 'nominal-power-estimate'),
    'verified supported state/% reports retain the actual dated nominal estimate beyond the older donor endpoint');
  assert.equal(nominal.reduce((sum, row) => sum + row.end - row.start, 0), 5 * MINUTE);
  assert(Math.abs(nominal.reduce((sum, row) => sum + row.kw * (row.end - row.start) / 3_600_000, 0) - 3.08 * 5 / 60) < 1e-12,
    'equivalent source spans do not duplicate nominal heat-pump energy');
  const earlierNominal = [...historicalHeatPumpIntervals({ store: f.master, input: 'providers', now: start + 20 * MINUTE,
    range: { from: at, to: start + 20 * MINUTE } })];
  assert(earlierNominal.length > 0 && earlierNominal.every(row => row.kw === 3.08),
    'later local endpoints neither leak into nor hide the fully admitted prior donor endpoint');
  assert.equal(earlierNominal.reduce((sum, row) => sum + row.end - row.start, 0), 5 * MINUTE);
  const earlierPoints = [...chartCoverageRows(f.master, { input: 'providers', from: at, to: start + 20 * MINUTE,
    now: start + 20 * MINUTE, signals: ['compressor_active'] })];
  assert(earlierPoints.length > 0 && earlierPoints.every(row => row.value === 1),
    'chart as-of selection retains the known donor endpoint instead of substituting the future local span original clock');
  const onlyFuturePoints = [...chartCoverageRows(f.master, { input: 'providers', from: start + 6 * MINUTE,
    to: start + 10 * MINUTE, now: start + 10 * MINUTE, signals: ['compressor_active'] })];
  assert(!onlyFuturePoints.some(row => row.value !== null),
    'if every equivalent endpoint is future, only the bounded original observation is known and no later fresh clock is invented');
  const onlyFutureNominal = [...historicalHeatPumpIntervals({ store: f.master, input: 'providers', now: start + 10 * MINUTE,
    range: { from: start + 6 * MINUTE, to: start + 10 * MINUTE } })];
  assert(onlyFutureNominal.length > 0 && onlyFutureNominal.every(row => row.kw === null));
  assert.deepEqual(replayLearningJournal(f.master, 'providers', null, { rebuild: true, persistCheckpoint: false }), result.checkpoint,
    'new recording evidence cannot reinterpret already committed numerical learning payloads');
  const later = committedLearningSample({ store: f.master, input: 'providers', at: laterAt, config });
  assert.deepEqual(originalSensorSample(later).quality, []);
  appendLearningRecord(f.master, 'providers', 'sample', later, { config });
  const laterPayload = f.master.db.prepare("SELECT payload FROM learning_journal WHERE input='providers' AND kind='sample' AND at=?").get(laterAt).payload;
  const laterRows = f.master.db.prepare('SELECT * FROM recorder_coverage WHERE id<=? ORDER BY id').all(localPrefix.at(-1).id);
  for (const active of [false, true]) {
    const args = { store: f.master, input: 'providers', recoveryId: result.report.recoveryId, active, signal: f.signal };
    const revised = await reviseRecovery({ ...args, preview: await previewRecoveryRevision(args) });
    assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage WHERE id<=? ORDER BY id').all(localPrefix.at(-1).id), laterRows,
      'recovery reversal does not edit independently extended local prefix rows');
    assert.equal(originalSensorSample(JSON.parse(f.master.db.prepare("SELECT payload FROM learning_journal WHERE input='providers' AND kind='sample' AND at=?").get(laterAt).payload).value).indoorC, 21);
    assert.equal(f.master.db.prepare("SELECT payload FROM learning_journal WHERE input='providers' AND kind='sample' AND at=?").get(laterAt).payload, laterPayload);
    assert.equal(f.master.db.prepare(`SELECT COUNT(*) n FROM active_recorder_coverage c JOIN recovery_members m
      ON m.table_name='recorder_coverage' AND m.record_key=CAST(c.id AS TEXT) WHERE m.recovery_id=?`).get(result.report.recoveryId).n,
    active ? importedSpans.length : 0, 'only the recovered spans follow this source selection');
    assert.equal(masterRecorder.committedAt('indoor_temperature', laterAt).value, 21);
    assert.deepEqual(energy(), originalEnergy);
    assert.deepEqual(replayLearningJournal(f.master, 'providers', null, { rebuild: true, persistCheckpoint: false }), revised.checkpoint);
  }
  const policy = { reportIntervalMs: 2 * MINUTE, reportGraceMs: 2 * MINUTE };
  const changed = masterRecorder.transitionTemperatureReportPolicy(current, policy, laterAt + MINUTE);
  assert.equal(changed.changed, true);
  assert.equal(changed.reportSourceTime, laterAt);
  assert.equal(changed.reportReceivedAt, laterAt);
  assert.equal(changed.observation.value, 21, 'prospective policy change retains the latest local report rather than the older donor endpoint');
  masterRecorder.record({ ...current, value: null, sourceTime: null, receivedAt: laterAt + 90_000,
    quality: ['mqtt-disconnected'], raw: { ...policy, timeBasis: 'availability-transition', temperatureRouteSignature: routeSignature } });
  const recovered = masterRecorder.recoverTemperatureConnection(current, policy, laterAt + 2 * MINUTE, { routeSignature });
  assert.equal(recovered.changed, true);
  assert.equal(recovered.reportSourceTime, laterAt);
  assert.equal(recovered.reportReceivedAt, laterAt);
  assert.equal(recovered.observation.value, 21);
  assert.equal(recovered.observation.raw.originalReportSourceTime, laterAt);
  assert.equal(recovered.observation.raw.originalReportReceivedAt, laterAt);
  assert.equal(masterRecorder.committedAt('indoor_temperature', laterAt + 4 * MINUTE).value, null,
    'policy/reconnect cannot create a newer physical report or extend the original expiry');
});

test('equal receipt endpoints retain a genuine newer local source clock over a higher-ID frozen donor span', async t => {
  const f = fixture(t), recorder = new Recorder(f.master);
  for (let minute = 0; minute <= 5; minute++) recordMinute(recorder, minute);
  const donor = await f.donor(), donorRecorder = new Recorder(donor);
  for (let minute = 6; minute <= 20; minute++) recordMinute(donorRecorder, minute, { sourceDelayMs: 1000 });
  const at = start + 20 * MINUTE;
  await new HistoryMerge({ target: f.master, donor, donorDigest: 'a'.repeat(64), input: 'providers', now: at }).run();
  for (let minute = 6; minute <= 20; minute++) recordMinute(recorder, minute);
  const spans = f.master.db.prepare("SELECT * FROM active_recorder_coverage WHERE signal='indoor_temperature' ORDER BY id").all();
  assert.equal(spans.length, 2);
  assert.equal(spans[0].end_at, spans[1].end_at);
  assert(spans[0].source_time > spans[1].source_time && spans[0].id < spans[1].id);
  const current = recorder.committedAt('indoor_temperature', at);
  assert.equal(current.reportObservedAt, at, 'a genuine source report at the same receipt endpoint is newer than the frozen donor clock');
  const reading = lastIndoorReading(f.master, { signal: 'indoor_temperature', input: 'providers', at });
  const metadata = indoorStatusMetadata(reading, at, { store: f.master });
  assert.equal(metadata.lastReportAt, at);
  assert.equal(metadata.reportExpiresAt, at + 3 * MINUTE);
  const policy = { reportIntervalMs: 2 * MINUTE, reportGraceMs: 2 * MINUTE };
  const transitioned = recorder.transitionTemperatureReportPolicy(current, policy, at + 1000);
  assert.equal(transitioned.reportSourceTime, at);
  assert.equal(transitioned.reportReceivedAt, at);
});

test('a historical donor insertion does not truncate a fresh local post-gap span already recorded before recovery', async t => {
  const f = fixture(t), recorder = new Recorder(f.master);
  recordLearningContext(f.master, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start, { config });
  for (let minute = 0; minute <= 5; minute++) recordMinute(recorder, minute);
  const donor = await f.donor(), donorRecorder = new Recorder(donor);
  for (let minute = 6; minute <= 20; minute++) recordMinute(donorRecorder, minute);
  for (let minute = 30; minute <= 45; minute++) recordMinute(recorder, minute);
  const before = f.master.db.prepare('SELECT * FROM recorder_coverage ORDER BY id').all();
  const merge = new HistoryMerge({ target: f.master, donor, donorDigest: 'a'.repeat(64), input: 'providers', now: start + 45 * MINUTE });
  await merge.run();
  assert.equal(merge.known('recorder_coverage', donor.db.prepare("SELECT id FROM recorder_coverage WHERE signal='indoor_temperature'").get().id).disposition, 'missing');
  assert.deepEqual(f.master.db.prepare('SELECT * FROM recorder_coverage WHERE id<=? ORDER BY id').all(before.at(-1).id), before);
  const at = start + 45 * MINUTE, from = start + 30 * MINUTE;
  const reading = lastIndoorReading(f.master, { input: 'providers', signal: 'indoor_temperature', at });
  assert.equal(reading.value, 21); assert.equal(reading.stale, false);
  const coverage = indoorReportCoverage(f.master, { reading, from, at, includeIntervals: true });
  assert.equal(coverage.complete, true);
  assert.equal(coverage.intervals.reduce((sum, interval) => sum + interval.end - interval.start, 0), at - from);
  assert(![...chartCoverageRows(f.master, { input: 'providers', from, to: at, now: at,
    signals: ['indoor_temperature'] })].some(row => row.value === null));
  assert.deepEqual(originalSensorSample(committedLearningSample({ store: f.master, input: 'providers', at, config })).quality, []);
});

test('fresh shared-prefix admission rejects contrary or unproven overlapping evidence', async t => {
  const markSharedOriginal = (field, quality) => (f, d, old, row) => {
    for (const [store, id] of [[f.master, old.observation_id], [d, row.observation_id]]) {
      const original = store.db.prepare('SELECT * FROM observations WHERE id=?').get(id);
      const raw = { ...JSON.parse(original.raw), ...(field ? { [field]: true } : {}) };
      store.db.prepare('UPDATE observations SET raw=?,quality=? WHERE id=?')
        .run(JSON.stringify(raw), JSON.stringify(quality ?? JSON.parse(original.quality)), id);
    }
  };
  const cases = [
    ['changed donor status', (f, d, old, row) => d.db.prepare("UPDATE recorder_coverage SET status='unavailable' WHERE id=?").run(row.id)],
    ['source clock rollback', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET source_time=? WHERE id=?').run(old.source_time - 1, row.id)],
    ['source clock beyond receipt end', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET source_time=? WHERE id=?').run(row.end_at + 1, row.id)],
    ['backward extension endpoint', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET end_at=? WHERE id=?').run(old.end_at + 1, row.id)],
    ['non-advancing confirmation count', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET samples=? WHERE id=?').run(old.samples, row.id)],
    ['zero-sample donor gate', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET samples=0 WHERE id=?').run(row.id)],
    ['zero-sample local gate', (f, d, old) => f.master.db.prepare('UPDATE recorder_coverage SET samples=0 WHERE id=?').run(old.id)],
    ['missing original observation', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET observation_id=NULL WHERE id=?').run(row.id)],
    ['different original value', (f, d, old, row) => d.db.prepare('UPDATE observations SET value=0 WHERE id=?').run(row.observation_id)],
    ['different prefix start', (f, d, old, row) => d.db.prepare('UPDATE recorder_coverage SET start_at=start_at+1 WHERE id=?').run(row.id)],
    ...['retained', 'cached', 'acquisitionOnly', 'auditOnly'].map(field => [`original ${field} report`, markSharedOriginal(field)]),
    ...['retained', 'cached'].map(flag => [`original ${flag} quality`, markSharedOriginal(null, [flag])]),
    ['competing later unavailable interval', (f, d, old) => f.master.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES(?,?,?,'unavailable',?,?,?,NULL,1)`).run(old.source, old.device, old.signal, old.end_at + 1, old.end_at + 2, old.end_at + 1)],
    ['competing later fresh interval', (f, d, old) => f.master.db.prepare(`INSERT INTO recorder_coverage(source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
      VALUES(?,?,?,'fresh',?,?,?, ?,1)`).run(old.source, old.device, old.signal, old.end_at + 1, old.end_at + 2, old.end_at + 1, old.observation_id)],
    ['future donor receipt', () => {}, start + 19 * MINUTE],
  ];
  for (const [name, alter, now = start + 45 * MINUTE] of cases) await t.test(name, async t => {
    const f = fixture(t), recorder = new Recorder(f.master);
    for (let minute = 0; minute <= 5; minute++) recordMinute(recorder, minute);
    recorder.flush(start + 5 * MINUTE, { force: true });
    const donor = await f.donor(), donorRecorder = new Recorder(donor);
    for (let minute = 6; minute <= 20; minute++) recordMinute(donorRecorder, minute);
    donorRecorder.flush(start + 20 * MINUTE, { force: true });
    const old = f.master.db.prepare("SELECT * FROM recorder_coverage WHERE signal='compressor_active'").get();
    const row = donor.db.prepare("SELECT * FROM recorder_coverage WHERE signal='compressor_active'").get();
    alter(f, donor, old, row);
    const before = f.master.db.prepare("SELECT * FROM recorder_coverage WHERE signal='compressor_active' ORDER BY id").all();
    const merge = new HistoryMerge({ target: f.master, donor, donorDigest: 'a'.repeat(64), input: 'providers', now });
    await merge.run();
    if (name.startsWith('original ')) assert.equal(merge.known('observations', row.observation_id).disposition, 'duplicates',
      'the matching original observation reaches the continuity quality gate rather than failing reference remapping');
    assert(['conflicts', 'skipped'].includes(merge.known('recorder_coverage', row.id).disposition));
    assert.deepEqual(f.master.db.prepare("SELECT * FROM recorder_coverage WHERE signal='compressor_active' ORDER BY id").all(), before);
  });
});
