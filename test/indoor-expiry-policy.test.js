import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, DEFAULT_TEMPERATURE_REPORT_GRACE_MS } from '../src/domain/temperature-reports.js';
import { recordLearningContext, committedLearningSample, appendLearningRecord, replayLearningJournal } from '../src/app/committed-learning.js';

const MINUTE = 60_000, START = Date.parse('2026-09-13T00:00:00Z'), signal = 'indoor_temperature';
const POLICY = { reportIntervalMs: 70 * MINUTE, reportGraceMs: 5 * MINUTE };
const report = (minute, extra = {}) => ({ source: 'mqtt-temperature', device: signal, signal, value: 21,
  unit: 'degC', sourceTime: START + minute * MINUTE, receivedAt: START + minute * MINUTE, quality: [],
  raw: { ...POLICY, timeBasis: 'mqtt-received', retained: false }, ...extra });
function fixture(t) {
  const store = new Store(':memory:');
  let now = START;
  const configuration = { input: 'providers' };
  const engine = new Engine({ store, config: configuration, clock: () => now });
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, START);
  for (let minute = 0; minute <= 180; minute += 15) store.observation({ source: 'fmi', device: 'invented-weather',
    signal: 'outdoor_temperature', value: 5, unit: 'degC', sourceTime: START + minute * MINUTE,
    receivedAt: START + minute * MINUTE, quality: [] });
  t.after(async () => { await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  return { store, engine, configuration, at(minute) { now = START + minute * MINUTE; },
    sample: minute => committedLearningSample({ store, input: 'providers', at: START + minute * MINUTE }) };
}

test('room age has no warning at74:59 and becomes unavailable for learning at exactly75 minutes', t => {
  assert.equal(DEFAULT_TEMPERATURE_REPORT_INTERVAL_MS, POLICY.reportIntervalMs);
  assert.equal(DEFAULT_TEMPERATURE_REPORT_GRACE_MS, POLICY.reportGraceMs);
  const f = fixture(t);
  f.engine.ingest(report(0));
  f.at(75 - 1 / 60);
  const before = f.engine.status().observations;
  assert.equal(before.indoor.value, 21); assert.equal(before.indoor.stale, false);
  assert.equal(before.upstairs.needsAttention, undefined);
  assert.equal(before.upstairs.reportExpiresAt, START + 75 * MINUTE);
  assert.equal(f.sample(75 - 1 / 60).indoorC, 21);
  f.at(75);
  assert.equal(f.engine.status().observations.indoor.value, null);
  assert.equal(f.engine.status().observations.upstairs.stale, true);
  assert.equal(f.sample(75).indoorC, null);
  assert.equal(f.sample(75).indoorSensors[signal].reportCoverageComplete, false);
});

test('unchanged genuine reports renew expiry while retained messages and repeated timestamps do not', t => {
  const f = fixture(t);
  f.engine.ingest(report(0));
  f.at(70); f.engine.ingest(report(70));
  f.at(140); f.engine.ingest(report(70, { receivedAt: START + 140 * MINUTE }));
  f.at(144); f.engine.ingest(report(144, { raw: { ...POLICY, retained: true }, quality: ['retained'] }));
  f.at(145 - 1 / 60);
  assert.equal(f.engine.status().observations.indoor.value, 21);
  assert.equal(f.engine.status().observations.upstairs.reportExpiresAt, START + 145 * MINUTE);
  f.at(145);
  assert.equal(f.engine.status().observations.indoor.value, null);
  f.at(146); f.engine.ingest(report(146));
  assert.equal(f.engine.status().observations.indoor.value, 21);
});

test('a longer report policy reuses a genuine value only from configuration time and preserves earlier gaps and journal replay', t => {
  const f = fixture(t), old = { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE };
  f.engine.ingest(report(0, { raw: old }));
  const before = f.sample(15), gap = f.sample(25);
  assert.equal(before.indoorC, 21); assert.equal(gap.indoorC, null);
  appendLearningRecord(f.store, 'providers', 'sample', before);
  appendLearningRecord(f.store, 'providers', 'sample', gap);
  const journal = f.store.learningJournal({ input: 'providers' });
  const oldSpans = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=?').all(signal);
  f.at(30); f.engine.configureTemperatureReports(signal, POLICY);
  assert.deepEqual(f.store.learningJournal({ input: 'providers' }), journal);
  const current = f.engine.status().observations;
  assert.equal(current.indoor.value, 21); assert.equal(current.upstairs.needsAttention, undefined);
  assert.equal(current.upstairs.lastReportAt, START); assert.equal(current.upstairs.reportExpiresAt, START + 75 * MINUTE);
  assert.deepEqual(f.sample(15), before); assert.deepEqual(f.sample(25), gap);
  assert.equal(f.sample(30).indoorC, null, 'The window still crosses the old17-to30 minute outage');
  assert.equal(f.sample(45).indoorC, 21, 'Only the forward window uses the new policy');
  assert.deepEqual(f.store.learningJournal({ input: 'providers' }).slice(0, journal.length), journal);
  assert.deepEqual(replayLearningJournal(f.store, 'providers'), replayLearningJournal(f.store, 'providers', null, { rebuild: true }));
  const spans = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(signal);
  assert.deepEqual(spans.slice(0, oldSpans.length), oldSpans);
  assert.equal(spans.at(-1).start_at, START + 30 * MINUTE); assert.equal(spans.at(-1).samples, 0);
  const row = f.store.latestObservation(signal);
  assert.equal(row.raw.timeBasis, 'report-policy-change'); assert.equal(row.sourceTime, START);
  assert.equal(row.raw.originalReportReceivedAt, START);
  const count = f.store.observations({ signal }).length;
  f.engine.configureTemperatureReports(signal, POLICY);
  assert.equal(f.store.observations({ signal }).length, count);
  f.at(60); f.engine.ingest(report(60));
  assert.equal(f.engine.status().observations.indoor.value, 21);
  assert.deepEqual(f.sample(25), gap);
});

test('policy changes keep actual failures excluded until a genuine newer report', t => {
  for (const reason of ['mqtt-disconnected', 'invalid-value']) {
    const f = fixture(t);
    f.engine.ingest(report(0, { raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE } }));
    f.at(10); f.engine.ingest(report(10, { value: null, sourceTime: null, quality: [reason], raw: { timeBasis: 'availability-transition' } }));
    f.at(20); f.engine.configureTemperatureReports(signal, POLICY);
    assert.equal(f.engine.status().observations.indoor.stale, true);
    assert.equal(f.sample(20).indoorC, null);
    f.at(21); f.engine.ingest(report(21));
    assert.equal(f.engine.status().observations.indoor.stale, false);
  }
});

test('a failed policy transition leaves both recorder state and source history unchanged', t => {
  const f = fixture(t), recorder = f.engine.recorder;
  f.engine.ingest(report(0, { raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE } }));
  const before = recorder.signalState(report(0), START), observations = f.store.observations({ signal });
  const write = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key.startsWith('recorder:signal:')) throw new Error('synthetic storage failure');
    return write(key, value);
  };
  assert.throws(() => recorder.transitionTemperatureReportPolicy(report(0), POLICY, START + 30 * MINUTE));
  f.store.setState = write;
  assert.deepEqual(recorder.signalState(report(0), START), before);
  assert.deepEqual(f.store.observations({ signal }), observations);
});

test('cached H66 indoor values are neither restored nor accepted as room model input', t => {
  const f = fixture(t);
  const old = report(0, { source: 'husdata-h66', device: 'invented-h66', raw: { usableForControl: true, verification: {} } });
  f.store.observation(old);
  const restarted = new Engine({ store: f.store, config: f.configuration, clock: () => START });
  assert.equal(lastIndoorReading(f.store, { signal, at: START, input: 'providers' }), null);
  assert.equal(restarted.status().observations.indoor.value, null);
  assert.equal(restarted.ingest(old).reason, 'disabled-h66-indoor');
  assert.equal(restarted.latest[signal], undefined);
  assert.equal(f.sample(15).indoorC, null);
});

test('a configured MQTT garage connection cannot fall back to old native garage readings', t => {
  const f = fixture(t);
  f.store.observation(report(0, { source: 'shelly-mqtt', device: 'garage', signal: 'garage_temperature', value: 12,
    raw: { reportIntervalMs: 30_000, reportGraceMs: 90_000 } }));
  const config = { input: 'providers', connections: { equipment: { devices: [{ id: 'garage', enabled: true,
    protocol: 'mqtt', kind: 'temperature', temperatureSignal: 'garage_temperature', ownedSignals: ['garage_temperature'] }] } } };
  const engine = new Engine({ store: f.store, config, clock: () => START });
  assert.equal(engine.status().observations.garage.value, null);
  engine.rememberObservation(report(0, { source: 'shelly-mqtt', device: 'garage', signal: 'garage_temperature', value: 12 }), START);
  assert.equal(engine.latest.garage_temperature, undefined);
  engine.ingest(report(0, { device: 'garage_temperature', signal: 'garage_temperature', value: 11,
    raw: { reportIntervalMs: 30_000, reportGraceMs: 90_000 } }));
  assert.equal(engine.status().observations.garage.value, 11);
});

test('policy carry preserves the latest compressed genuine report across restart without renewing its deadline', t => {
  const f = fixture(t), old = { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE };
  f.engine.ingest(report(0, { raw: old }));
  f.at(15 + 1 / 60);
  f.engine.ingest(report(15, { receivedAt: START + 15 * MINUTE + 1000, raw: old }));
  f.at(30); f.engine.configureTemperatureReports(signal, POLICY);
  const policyEvent = f.store.latestObservation(signal);
  assert.equal(policyEvent.sourceTime, START + 15 * MINUTE);
  assert.equal(policyEvent.raw.originalReportReceivedAt, START + 15 * MINUTE + 1000);
  assert.equal(policyEvent.raw.reportPolicyChangedAt, START + 30 * MINUTE);
  const restarted = new Engine({ store: f.store, config: f.configuration, clock: () => f.engine.clock() });
  t.after(async () => { await restarted.closeFireplace(); await restarted.executor.close({ restore: false }); });
  f.at(89 + 59 / 60);
  restarted.configureTemperatureReports(signal, POLICY);
  assert.equal(restarted.status().observations.indoor.value, 21);
  assert.equal(restarted.status().observations.upstairs.lastReportAt, START + 15 * MINUTE);
  assert.equal(restarted.status().observations.upstairs.reportExpiresAt, START + 90 * MINUTE);
  f.at(90);
  assert.equal(restarted.status().observations.indoor.value, null);
});

test('policy carry cannot admit a reading from before a sensor-change boundary', t => {
  const f = fixture(t);
  f.engine.ingest(report(0, { raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE } }));
  addSensorChange(f.store, 'providers', { signal, reason: 'replacement', requestId: 'invented-policy-replacement' },
    START + 10 * MINUTE);
  f.at(30); f.engine.configureTemperatureReports(signal, POLICY);
  assert.equal(f.engine.status().observations.indoor.value, null);
  assert.equal(f.sample(45).indoorC, null);
  assert.ok(f.engine.status().observations.upstairs.availabilityReasons.includes('before-sensor-change'));
});

test('a first periodic report received at its exact source deadline cannot establish fresh coverage', t => {
  const f = fixture(t);
  f.at(75);
  f.engine.ingest(report(0, { receivedAt: START + 75 * MINUTE }));
  const state = f.engine.recorder.signalState(report(0), START + 75 * MINUTE);
  assert.equal(state.status, 'stale');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM recorder_coverage WHERE signal=? AND status='fresh'").get(signal).n, 0);
  assert.equal(f.engine.status().observations.indoor.value, null);
  assert.equal(f.sample(75).indoorC, null);
});
