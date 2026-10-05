import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { committedLearningSample, recordLearningContext, replayLearningJournal} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const MINUTE = 60_000, start = Date.parse('2026-01-01T00:00:00Z');
const signal = 'indoor_temperature';
const report = (minute, { receivedMinute = minute, value = 21, ...extra } = {}) => ({
  source: 'mqtt-temperature', device: 'invented-periodic-room', signal, value, unit: 'degC',
  sourceTime: start + minute * MINUTE, receivedAt: start + receivedMinute * MINUTE,
  quality: [], raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE, retained: false }, ...extra,
});
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, start);
  for (let minute = 0; minute <= 120; minute += 15) store.observation({
    source: 'fmi', device: 'invented-weather', signal: 'outdoor_temperature', value: 0, unit: 'degC',
    sourceTime: start + minute * MINUTE, receivedAt: start + minute * MINUTE, quality: [],
  });
  return { store, recorder: new Recorder(store), sample: minute => committedLearningSample({
    store, input: 'providers', at: start + minute * MINUTE,
  }) };
}

test('unchanged periodic reports prove learning coverage without changing the saved measurement timestamp', t => {
  const { store, recorder, sample } = fixture(t);
  const original = recorder.record(report(0));
  for (const minute of [15, 30]) assert.equal(recorder.record(report(minute)).saved, false);
  const before = sample(30);
  assert.equal(before.indoorC, 21);
  assert.equal(before.indoorSensors.indoor_temperature.observedAt, start);
  assert.equal(before.indoorSensors.indoor_temperature.reportCoverageComplete, true);
  assert.deepEqual(before.indoorSensors.indoor_temperature.attentionReasons, []);
  assert.deepEqual(before.provenance.lineage.indoor_temperature.observations, [original.id]);
  assert.equal(before.provenance.lineage.indoor_temperature.coverage.length, 1);
  for (const minute of [45, 60, 75, 90]) recorder.record(report(minute));
  assert.deepEqual(sample(30), before, 'Future extension of a continuous span cannot change an earlier learning sample');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations WHERE signal=?').get(signal).n, 1);
});

test('a recovered endpoint cannot make a learning window spanning a missed report eligible', t => {
  const { store, recorder, sample } = fixture(t);
  recorder.record(report(0)); recorder.record(report(15));
  const before = sample(30);
  recorder.record(report(45));
  const outage = sample(45);
  assert.equal(outage.indoorC, null);
  assert(outage.quality.includes('missing'));
  assert.equal(outage.indoorSensors.indoor_temperature.reportCoverageComplete, false);
  assert.equal(outage.indoorSensors.indoor_temperature.reportCoveredThrough, start + 32 * MINUTE);
  assert.equal(lastIndoorReading(store, { signal, at: start + 45 * MINUTE, input: 'providers' }).stale, false);
  recorder.record(report(60));
  assert.equal(sample(60).indoorC, 21);
  assert.deepEqual(sample(30), before);
  assert.deepEqual(sample(45), outage, 'Subsequent recovery cannot erase the missing interval');
  for (const value of [before, outage, sample(60)]) appendLearningRecord(store, 'providers', 'sample', value);
  const live = replayLearningJournal(store, 'providers');
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), live);
});

test('late receipts and explicit failures leave real holes even when source timestamps are fresh', t => {
  const { recorder, sample } = fixture(t);
  recorder.record(report(0)); recorder.record(report(15));
  recorder.record(report(30, { receivedMinute: 34 }));
  recorder.record(report(45));
  assert.equal(sample(45).indoorC, null, 'Receipt at minute 34 cannot fill the outage after minute 32');
  recorder.recordFailure({ source: 'mqtt-temperature', device: 'invented-periodic-room', signal,
    unit: 'degC', at: start + 46 * MINUTE, quality: ['mqtt-disconnected'] });
  recorder.record(report(47)); recorder.record(report(60));
  assert.equal(sample(60).indoorC, null, 'Explicit disconnection cuts the earlier fresh report short');
  recorder.record(report(75));
  assert.equal(sample(75).indoorC, 21);
});

test('a shorter reporting policy cannot hide an older failure that ended a long report interval', t => {
  const { recorder, sample } = fixture(t);
  recorder.record(report(0, { raw: { reportIntervalMs: 60 * MINUTE, reportGraceMs: 0 } }));
  recorder.recordFailure({ source: 'mqtt-temperature', device: 'invented-periodic-room', signal,
    unit: 'degC', at: start + MINUTE, quality: ['mqtt-disconnected'] });
  recorder.record(report(50));
  assert.equal(sample(50).indoorC, null);
  assert.equal(sample(50).indoorSensors.indoor_temperature.reportCoverageComplete, false);
});

test('disabling periodic reporting preserves an earlier gap and only restores the later nonperiodic windows', t => {
  const { recorder, sample } = fixture(t);
  recorder.record(report(0));
  recorder.record(report(45, { raw: { reportIntervalMs: 0, reportGraceMs: 0 } }));
  assert.equal(sample(45).indoorC, null);
  assert.equal(sample(45).indoorSensors.indoor_temperature.reportCoverageComplete, false);
  assert.equal(sample(60).indoorC, 21);
  assert.equal(sample(120).indoorC, 21);
});

test('enabling periodic reporting keeps previously valid nonperiodic coverage before the new contract', t => {
  const { recorder, sample } = fixture(t);
  recorder.record(report(0, { raw: { reportIntervalMs: 0, reportGraceMs: 0 } }));
  recorder.record(report(90));
  assert.equal(sample(90).indoorC, 21);
  assert.equal(sample(90).indoorSensors.indoor_temperature.reportCoverageComplete, true);
  assert.equal(sample(120).indoorC, null);
});

test('enabling reporting without a new message records one availability boundary across runtime restarts', t => {
  const { store, recorder, sample } = fixture(t);
  recorder.record(report(0, { device: signal, raw: { reportIntervalMs: 0, reportGraceMs: 0 } }));
  const before = sample(15);
  let now = start + 30 * MINUTE;
  const configuration = { input: 'providers' }, policy = { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE };
  const engine = new Engine({ store, config: configuration, clock: () => now });
  engine.configureTemperatureReports(signal, policy);
  assert.equal(engine.status().observations.indoor.value, null);
  assert.equal(sample(30).indoorC, null);
  assert.deepEqual(sample(15), before, 'The new contract does not reinterpret the earlier nonperiodic period');
  const count = store.db.prepare('SELECT COUNT(*) n FROM observations WHERE signal=?').get(signal).n;
  now = start + 45 * MINUTE;
  const restarted = new Engine({ store, config: configuration, clock: () => now });
  restarted.configureTemperatureReports(signal, policy);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations WHERE signal=?').get(signal).n, count);
  assert.equal(restarted.status().observations.indoor.value, null);
  assert.equal(sample(45).indoorC, null);
  restarted.ingest(report(45, { device: signal }));
  assert.equal(restarted.status().observations.indoor.value, 21);
  assert.equal(sample(45).indoorC, null, 'A recovered endpoint retains the preceding policy-change gap');
  now = start + 60 * MINUTE; restarted.ingest(report(60, { device: signal }));
  assert.equal(sample(60).indoorC, 21);
});

test('restart restores report coverage separately from temperature age and expires to normal safe control', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-periodic-indoor-'));
  const path = join(directory, 'invented.sqlite'); let store = new Store(path);
  let engine, now = start;
  t.after(async () => {
    // A file-backed engine also starts the household forecast reader on tick.
    // Wait for its database worker before closing and removing the fixture store.
    await engine?.charging.close();
    await engine?.closeFireplace();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const recorder = new Recorder(store);
  for (let minute = 0; minute <= 180; minute += 15) recorder.record(report(minute));
  store.close(); store = new Store(path); now = start + 181 * MINUTE;
  engine = new Engine({ store, config: { input: 'providers', settings: {  } }, clock: () => now });
  const initial = engine.status().observations;
  assert.equal(initial.upstairs.observedAt, start);
  assert.equal(initial.upstairs.stale, false);
  assert.equal(initial.upstairs.needsAttention, undefined);
  assert.equal(initial.indoor.periodicReports, true);
  assert.equal(initial.indoor.value, 21);
  now = start + 197 * MINUTE + 1;
  engine.ingest({ source: 'fmi', device: 'invented-weather', signal: 'outdoor_temperature', value: 0, unit: 'degC',
    sourceTime: now, receivedAt: now, quality: [] });
  const expired = engine.tick();
  assert.equal(expired.observations.upstairs.value, 21, 'The last actual value remains available for display');
  assert.equal(expired.observations.indoor.value, null);
  assert(expired.observations.upstairs.attentionReasons.includes('missing-report'));
  assert(expired.decision.reasons.includes('missing-or-stale-observations'));
  now = start + 198 * MINUTE; engine.ingest(report(180, { receivedMinute: 198 }));
  assert.equal(engine.status().observations.indoor.stale, true, 'A repeated old timestamp is not a heartbeat');
  now = start + 199 * MINUTE; engine.ingest(report(199));
  assert.equal(engine.status().observations.indoor.stale, false);
  assert.equal(engine.status().observations.indoor.value, 21);
});

test('a repeated timestamp cannot clear a recorded disconnection after engine restart', t => {
  const { store, recorder } = fixture(t);
  recorder.record(report(0)); recorder.record(report(15));
  recorder.recordFailure({ source: 'mqtt-temperature', device: 'invented-periodic-room', signal,
    unit: 'degC', at: start + 20 * MINUTE, quality: ['mqtt-disconnected'] });
  let now = start + 21 * MINUTE;
  const engine = new Engine({ store, config: { input: 'providers' }, clock: () => now });
  assert.equal(engine.status().observations.indoor.stale, true);
  engine.ingest(report(15, { receivedMinute: 21 }));
  assert.equal(engine.status().observations.indoor.stale, true);
  now = start + 22 * MINUTE; engine.ingest(report(22));
  assert.equal(engine.status().observations.indoor.stale, false);
});

test('a sensor measurement boundary records the first new report even if its value is unchanged', t => {
  const { store } = fixture(t); let now = start;
  const engine = new Engine({ store, config: { input: 'providers' }, clock: () => now });
  engine.ingest(report(0));
  addSensorChange(store, 'providers', { signal, reason: 'replacement', requestId: 'invented-periodic-replacement' },
    start + 5 * MINUTE);
  now = start + 15 * MINUTE;
  const replacement = engine.ingest(report(15));
  assert.equal(replacement.saved, true);
  assert.equal(replacement.reason, 'forced');
  now = start + 30 * MINUTE;
  assert.equal(engine.ingest(report(30)).saved, false);
  const reading = lastIndoorReading(store, { signal, at: now, input: 'providers', notBefore: start + 5 * MINUTE });
  assert.equal(reading.id, replacement.id);
  assert.equal(reading.sourceTime, start + 15 * MINUTE);
});

test('recording existence checks retain genuine boundary evidence independently of report availability', t => {
  const { store, recorder } = fixture(t);
  recorder.record(report(0));
  const replacement = recorder.record(report(15, { value: 22 }));
  recorder.recordFailure({ source: 'mqtt-temperature', device: 'invented-periodic-room', signal,
    unit: 'degC', at: start + 20 * MINUTE, quality: ['mqtt-disconnected'] });
  const request = { signal, at: start + 45 * MINUTE, input: 'providers', notBefore: start + 5 * MINUTE };
  const available = lastIndoorReading(store, request);
  const recorded = lastIndoorReading(store, { ...request, includeAvailability: false });
  assert.equal(available.stale, true, 'The outage must still affect control and learning');
  assert.equal(recorded.id, replacement.id, 'An outage does not erase the saved measurement after replacement');
  assert.equal(recorded.reportCoverage, undefined, 'Existence does not require resolving report availability');
  assert.equal(lastIndoorReading(store, { ...request, notBefore: start + 16 * MINUTE, includeAvailability: false }), null);
  store.observation(report(30, { raw: { acquisitionOnly: true }, value: 23 }));
  store.observation(report(35, { quality: ['invalid_numeric'], value: 24 }));
  assert.equal(lastIndoorReading(store, { ...request, includeAvailability: false }).id, replacement.id,
    'Unsaved control inputs and invalid attempts cannot establish a committed measurement');
});
