import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder, isCaravanRecordingRecovery, isCaravanRecordingAdmission } from '../src/storage/recorder.js';
import { HistoryMerge } from '../src/recovery/merge.js';
import { recordingStreamKey } from '../src/domain/recording-policy.js';
import { sourceTimeAdmission } from '../src/domain/time-evidence.js';
import { getChartData } from '../src/app/chart-data.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = Date.parse('2026-10-09T10:00:00Z'), SIGNAL = 'caravan_dehumidifier_state';
const SOURCE = BASE + 30_000, GAP = BASE + 40_000, RECOVERY = GAP + 700;
const MAX_AGE = 180_000, DEADLINE = BASE + 200_000;
const NEW_SOURCE = GAP + 500, NEW_FAN = GAP + 400, NEW_DEADLINE = NEW_FAN + MAX_AGE;
const IDENTITY = 'a'.repeat(64), METER = 'b'.repeat(64);
const wait = () => ({ startedAt: GAP, recordingSince: BASE + 20_000,
  identity: IDENTITY, meterSignature: METER, deadline: DEADLINE });
const evidence = () => ({ method: 'native-power-cycle-v1', meterSignature: METER,
  startedAt: BASE, completedAt: BASE + 20_000, meterObservedAt: SOURCE,
  powerRiseW: 5, powerFallW: 5, minimumChangeW: 3,
  phases: {
    baseline: { commandAt: null, firstPowerObservedAt: BASE, lastPowerObservedAt: BASE + 5000 },
    on: { commandAt: BASE + 6000, firstPowerObservedAt: BASE + 7000, lastPowerObservedAt: BASE + 12_000 },
    off: { commandAt: BASE + 13_000, firstPowerObservedAt: BASE + 14_000, lastPowerObservedAt: BASE + 19_000 },
  } });
function reading({ deferred = false, value = 1 } = {}) {
  const receivedAt = SOURCE - (deferred ? 500 : 0);
  return { source: 'mqtt-equipment', device: 'caravan_dehumidifier', signal: SIGNAL, unit: 'state',
    value, sourceTime: SOURCE, receivedAt, quality: [],
    raw: { timeBasis: 'mqtt-live-status', identity: IDENTITY, maxAgeMs: MAX_AGE,
      reportIntervalMs: DEADLINE - SOURCE, reportGraceMs: 0,
      fieldTimestamps: { power: SOURCE, fanSpeed: BASE + 20_000 }, locationEvidence: evidence(),
      ...(deferred ? { timeAdmission: sourceTimeAdmission({ sourceTime: SOURCE, receivedAt,
        now: SOURCE, deferred: true }) } : {}) } };
}
function fixture(t, { initial = true, deferred = false, gapQuality = ['location-unconfirmed', 'unavailable', 'missing'],
  gapMarker = true, value = 1, interruption } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { clock: () => RECOVERY });
  const original = reading({ deferred, value });
  if (initial) assert.equal(recorder.record(original).saved, true);
  if (interruption) recorder.record({ ...original, sourceTime: null, receivedAt: GAP - 500,
    value: null, quality: interruption, raw: { reportIntervalMs: MAX_AGE, reportGraceMs: 0,
      timeBasis: 'availability-transition' } });
  recorder.record({ ...original, sourceTime: null, receivedAt: GAP, value: null, quality: gapQuality,
    raw: { reportIntervalMs: MAX_AGE, reportGraceMs: 0, timeBasis: 'availability-transition',
      ...(gapMarker ? { sourceTimeWait: wait() } : {}) } });
  const candidate = structuredClone(original);
  candidate.raw.sourceTimeWait = wait();
  candidate.raw.locationEvidence.meterObservedAt = RECOVERY;
  const key = `recorder:signal:${recordingStreamKey(original)}`;
  return { store, recorder, original, candidate, state: () => store.getState(key),
    rows: () => store.observations({ signal: SIGNAL }),
    coverage: () => store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL),
    resume: (at = RECOVERY) => recorder.resumeCaravanRecording(candidate, at) };
}
function chart(store, now) {
  return getChartData({ store, input: 'mqtt', startDate: '2026-10-09', endDate: '2026-10-09',
    now, left: SIGNAL }).series[SIGNAL];
}
function freshness(recorder, now) {
  return recorder.sourceStatus(now).exactParameters.find(row => row.signal === SIGNAL).freshness;
}
function recoveryRows(store) {
  return store.observations({ signal: SIGNAL }).filter(row => row.raw?.timeBasis === 'recording-availability-recovery');
}
function admittedReading(f, receivedAt = GAP - 1, sourceTime = NEW_SOURCE, admittedAt = RECOVERY) {
  const candidate = f.candidate;
  candidate.value = 2; candidate.sourceTime = sourceTime; candidate.receivedAt = receivedAt;
  candidate.raw.fieldTimestamps = { power: sourceTime, fanSpeed: sourceTime - 100 };
  candidate.raw.reportIntervalMs = MAX_AGE - 100;
  candidate.raw.locationEvidence.meterObservedAt = admittedAt;
  candidate.raw.timeAdmission = sourceTimeAdmission({ sourceTime: candidate.sourceTime,
    receivedAt: candidate.receivedAt, now: admittedAt, deferred: true });
  return candidate;
}
function admissionRows(store) {
  return store.observations({ signal: SIGNAL }).filter(row => row.raw?.timeBasis === 'recording-source-admission');
}
function merge(target, donor, digest = 'c'.repeat(64)) {
  return new HistoryMerge({ target, donor, donorDigest: digest, input: 'mqtt', now: DEADLINE + 1 }).run();
}

test('Caravan recording resumes an unchanged qualified state prospectively without renewing its evidence', t => {
  const f = fixture(t), before = f.state(), coverage = f.coverage(), result = f.resume();
  assert.equal(result.changed, true);
  const event = result.observation, state = f.state();
  assert.equal(isCaravanRecordingRecovery(event), true);
  assert.equal(event.value, 1); assert.equal(event.sourceTime, SOURCE); assert.equal(event.receivedAt, RECOVERY);
  assert.equal(event.raw.originalReportSourceTime, SOURCE);
  assert.equal(event.raw.originalReportReceivedAt, SOURCE);
  assert.equal(event.raw.originalReportTimeBasis, 'mqtt-live-status');
  assert.equal(event.raw.originalReportTimeAdmission, undefined);
  assert.deepEqual(event.raw.fieldTimestamps, f.original.raw.fieldTimestamps);
  assert.deepEqual(event.raw.sourceTimeWait, wait());
  assert.deepEqual(f.coverage().slice(0, 2), coverage, 'Recovery cannot extend the earlier fresh span or erase its gap');
  assert.deepEqual(f.coverage().map(row => [row.status, row.start_at, row.end_at, row.samples]),
    [['fresh', SOURCE, SOURCE, 1], ['unavailable', GAP, GAP, 1], ['fresh', RECOVERY, RECOVERY, 0]]);
  for (const key of ['lastSourceTime', 'lastFreshAt', 'lastReportTime', 'mean', 'variance', 'scale', 'step', 'previousValue'])
    assert.deepEqual(state[key], before[key], `${key} retains genuine report evidence`);
  const polls = () => f.store.db.prepare('SELECT SUM(polls) n FROM recorder_metrics WHERE key=?')
    .get(recordingStreamKey(f.original)).n;
  assert.equal(polls(), 2, 'The recovery event is not another appliance poll');
  assert.equal(freshness(f.recorder, DEADLINE - 1).status, 'fresh');
  assert.equal(freshness(f.recorder, DEADLINE).status, 'stale');
  assert.equal(freshness(f.recorder, DEADLINE).sourceObservedAt, SOURCE);
  assert.deepEqual(freshness(f.recorder, DEADLINE).reasons, ['missing-report']);
});

test('Caravan recovery preserves the original physical receipt and delayed-admission proof', t => {
  const f = fixture(t, { deferred: true });
  const result = f.resume();
  assert.equal(result.changed, true);
  assert.equal(result.observation.raw.originalReportReceivedAt, SOURCE - 500);
  assert.deepEqual(result.observation.raw.originalReportTimeAdmission, f.original.raw.timeAdmission);
  assert.equal(result.observation.raw.timeAdmission, undefined, 'The old receipt proof cannot be attached to the new event receipt');
  assert.equal(isCaravanRecordingRecovery(result.observation), true);
});

test('a new Caravan report admits at the current boundary with its original physical clocks and one genuine sample', t => {
  const f = fixture(t, { deferred: true }), previous = f.state(), previousCoverage = f.coverage(), candidate = admittedReading(f);
  assert.throws(() => f.store.transaction(() => {
    assert.equal(f.resume().changed, true);
    throw new Error('synthetic interrupted new report');
  }), /synthetic interrupted new report/);
  assert.deepEqual(f.state(), previous); assert.deepEqual(f.coverage(), previousCoverage);
  assert.equal(admissionRows(f.store).length, 0);
  const result = f.resume(); assert.equal(result.changed, true);
  const event = result.observation, state = f.state();
  assert.equal(isCaravanRecordingAdmission(event), true);
  assert.equal(event.value, 2); assert.equal(event.sourceTime, NEW_SOURCE); assert.equal(event.receivedAt, RECOVERY);
  assert.equal(event.raw.timeBasis, 'recording-source-admission');
  assert.equal(event.raw.recorder.temporalBasis, 'source-admission');
  assert.equal(event.raw.originalReportSourceTime, NEW_SOURCE);
  assert.equal(event.raw.originalReportReceivedAt, GAP - 1);
  assert.deepEqual(event.raw.originalReportTimeAdmission, candidate.raw.timeAdmission);
  assert.equal(event.raw.recorder.previousSourceTime, SOURCE);
  assert.equal(event.raw.recorder.previousReportReceivedAt, SOURCE - 500);
  assert.deepEqual(event.raw.recorder.previousReportTimeAdmission, f.original.raw.timeAdmission);
  assert.equal(event.raw.timeAdmission, undefined);
  assert.deepEqual(event.raw.fieldTimestamps, candidate.raw.fieldTimestamps);
  assert.equal(state.lastSourceTime, NEW_SOURCE); assert.equal(state.lastFreshAt, NEW_SOURCE);
  assert.equal(state.previousValue, 2); assert(state.scale > previous.scale);
  assert.deepEqual(state.lastReportTime, { sourceTime: NEW_SOURCE, receivedAt: GAP - 1, admittedAt: RECOVERY });
  assert.deepEqual(f.coverage().slice(0, 2), previousCoverage);
  const coverage = f.coverage().at(-1);
  assert.deepEqual([coverage.start_at, coverage.end_at, coverage.source_time, coverage.samples],
    [RECOVERY, RECOVERY, NEW_SOURCE, 1]);
  assert.equal(f.store.db.prepare('SELECT SUM(polls) n FROM recorder_metrics WHERE key=?')
    .get(recordingStreamKey(f.original)).n, 3);
  assert.equal(f.recorder.committedAt(SIGNAL, RECOVERY - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, RECOVERY).value, 2);
  const points = chart(f.store, NEW_DEADLINE + 1);
  assert(points.some(point => point.x === GAP && point.y === null));
  assert(points.some(point => point.x === RECOVERY && point.y === 2));
  assert(!points.some(point => point.x >= GAP && point.x < RECOVERY && point.y !== null));
  assert(points.some(point => point.x === NEW_DEADLINE && point.y === null));
  assert.equal(freshness(f.recorder, NEW_DEADLINE - 1).status, 'fresh');
  assert.equal(freshness(f.recorder, NEW_DEADLINE).status, 'stale');
  assert.equal(freshness(f.recorder, NEW_DEADLINE).sourceObservedAt, NEW_SOURCE);
  assert.equal(f.resume(RECOVERY + 1).changed, false);
  assert.equal(admissionRows(f.store).length, 1);
});

test('new Caravan admission rejects invalid proof and conflicting native clock evidence', async t => {
  const cases = {
    'missing-proof': candidate => { delete candidate.raw.timeAdmission; },
    'wrong-physical-receipt': candidate => { candidate.raw.timeAdmission.receivedAt--; },
    'admitted-before-source': candidate => { candidate.raw.timeAdmission.admittedAt = NEW_SOURCE - 1; },
    'admitted-after-current-boundary': candidate => { candidate.raw.timeAdmission.admittedAt = RECOVERY + 1; },
    'report-not-newer': candidate => {
      candidate.sourceTime = SOURCE; candidate.raw.fieldTimestamps = { power: SOURCE, fanSpeed: BASE + 20_000 };
      candidate.receivedAt = SOURCE - 500;
      candidate.raw.timeAdmission = sourceTimeAdmission({ sourceTime: candidate.sourceTime,
        receivedAt: candidate.receivedAt, now: RECOVERY, deferred: true });
    },
    'native-field-rollback': candidate => { candidate.raw.fieldTimestamps.fanSpeed = BASE + 19_999; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
    const f = fixture(t), rows = f.rows(), coverage = f.coverage(), state = f.state();
    const candidate = admittedReading(f); change(candidate);
    assert.equal(f.resume().changed, false);
    assert.deepEqual(f.rows(), rows); assert.deepEqual(f.coverage(), coverage); assert.deepEqual(f.state(), state);
  });
});

test('storage delay beyond a new Caravan source clock preserves admission and the gap without hiding a master outage', async t => {
  const sourceTime = GAP - 20, receivedAt = GAP - 60, admittedAt = GAP + 40;
  const f = fixture(t), candidate = admittedReading(f, receivedAt, sourceTime, admittedAt);
  const event = f.resume(admittedAt).observation; assert(event);
  assert.equal(isCaravanRecordingAdmission(event), true);
  assert.equal(event.sourceTime, sourceTime); assert.equal(event.receivedAt, admittedAt);
  assert.equal(event.raw.originalReportReceivedAt, receivedAt);
  assert.deepEqual(event.raw.originalReportTimeAdmission, candidate.raw.timeAdmission);
  assert.equal(f.recorder.committedAt(SIGNAL, GAP).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, admittedAt - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, admittedAt).value, 2);
  const points = chart(f.store, admittedAt + 1);
  assert(points.some(point => point.x === GAP && point.y === null));
  assert(points.some(point => point.x === admittedAt && point.y === 2));
  const target = new Store(':memory:'); t.after(() => target.close());
  const merged = await merge(target, f.store);
  assert.equal(merged.counts.conflicts, 0); assert.equal(merged.counts.skipped, 0);
  assert.deepEqual(target.observations({ signal: SIGNAL }), f.rows());
  assert.deepEqual(chart(target, admittedAt + 1), points);
  const master = new Store(':memory:'); t.after(() => master.close());
  const recorder = new Recorder(master, { clock: () => admittedAt }); recorder.record(f.original);
  recorder.record({ ...f.original, sourceTime: null, receivedAt: GAP - 500, value: null,
    quality: ['mqtt-disconnected', 'missing'], raw: { timeBasis: 'availability-transition', reportIntervalMs: MAX_AGE } });
  recorder.record(f.rows()[1]);
  const contrary = await merge(master, f.store);
  assert(contrary.counts.conflicts > 0); assert.equal(admissionRows(master).length, 0);
});

test('HistoryMerge preserves new Caravan source admission and rejects contrary master evidence or invalid proof', async t => {
  for (const receivedAt of [GAP - 1, GAP + 100]) await t.test(receivedAt > GAP
    ? 'roundtrip-later-physical-receipt' : 'roundtrip and idempotency', async t => {
    const f = fixture(t); admittedReading(f, receivedAt); assert.equal(f.resume().changed, true);
    const target = new Store(':memory:'); t.after(() => target.close());
    const report = await merge(target, f.store);
    assert.equal(report.counts.conflicts, 0); assert.equal(report.counts.skipped, 0);
    assert.deepEqual(target.observations({ signal: SIGNAL }), f.rows());
    assert.deepEqual(target.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL), f.coverage());
    assert.deepEqual(chart(target, NEW_DEADLINE + 1), chart(f.store, NEW_DEADLINE + 1));
    const again = await merge(target, f.store, 'e'.repeat(64));
    assert.equal(again.counts.missing, 0); assert.equal(again.counts.conflicts, 0);
    assert.equal(again.counts.duplicates, 6);
  });
  for (const scenario of ['newer-master-report', 'outage-before-matching-gap',
    'outage-before-gap-later-physical-receipt']) await t.test(scenario, async t => {
    const f = fixture(t);
    admittedReading(f, scenario === 'outage-before-gap-later-physical-receipt' ? GAP + 100 : GAP - 1);
    assert.equal(f.resume().changed, true);
    const target = new Store(':memory:'); t.after(() => target.close());
    const recorder = new Recorder(target, { clock: () => RECOVERY }); recorder.record(f.original);
    const outage = scenario !== 'newer-master-report';
    recorder.record({ ...reading(), value: outage ? null : 3, sourceTime: outage ? null : NEW_SOURCE + 10,
      receivedAt: outage ? GAP - 500 : RECOVERY - 1, quality: outage ? ['missing', 'mqtt-disconnected'] : [],
      raw: { ...reading().raw, fieldTimestamps: { power: NEW_SOURCE + 10, fanSpeed: NEW_SOURCE + 10 } } });
    if (outage) recorder.record(f.rows()[1]);
    const report = await merge(target, f.store);
    assert(report.counts.conflicts > 0); assert.equal(admissionRows(target).length, 0);
  });
  for (const scenario of ['missing-proof', 'wrong-original-receipt', 'admitted-before-source',
    'missing-previous-admission', 'wrong-previous-receipt']) await t.test(scenario, async t => {
    const f = fixture(t, { deferred: true }); admittedReading(f); const event = f.resume().observation;
    assert(event);
    const raw = structuredClone(event.raw);
    if (scenario === 'missing-proof') delete raw.originalReportTimeAdmission;
    if (scenario === 'wrong-original-receipt') raw.originalReportReceivedAt--;
    if (scenario === 'admitted-before-source') raw.originalReportTimeAdmission.admittedAt = NEW_SOURCE - 1;
    if (scenario === 'missing-previous-admission') delete raw.recorder.previousReportTimeAdmission;
    if (scenario === 'wrong-previous-receipt') raw.recorder.previousReportReceivedAt--;
    f.store.db.prepare('UPDATE observations SET raw=? WHERE id=?').run(JSON.stringify(raw), event.id);
    const target = new Store(':memory:'); t.after(() => target.close());
    const report = await merge(target, f.store);
    assert(report.tables.find(row => row.name === 'observations').skipped > 0);
    assert.equal(admissionRows(target).length, 0);
  });
});

test('Caravan Off recovery needs power evidence and running levels retain both required native clocks', async t => {
  for (const value of [0, 2, 3]) await t.test(String(value), t => {
    const f = fixture(t, { value });
    if (value === 0) f.candidate.raw.fieldTimestamps.fanSpeed = BASE - MAX_AGE;
    const result = f.resume(); assert.equal(result.changed, true);
    assert.equal(result.observation.value, value);
    assert.deepEqual(result.observation.raw.fieldTimestamps, value === 0 ? { power: SOURCE } : f.original.raw.fieldTimestamps);
  });
});

test('Caravan causal reads and charts retain the unavailable interval before recovery', t => {
  const f = fixture(t); assert.equal(f.resume().changed, true);
  assert.equal(f.recorder.committedAt(SIGNAL, GAP - 1).value, 1);
  assert.equal(f.recorder.committedAt(SIGNAL, GAP).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, RECOVERY - 1).value, null);
  assert.equal(f.recorder.committedAt(SIGNAL, RECOVERY).value, 1);
  assert.equal(f.recorder.committedAt(SIGNAL, DEADLINE).value, null);
  const points = chart(f.store, DEADLINE + 1);
  assert(points.some(point => point.x === GAP && point.y === null));
  assert(points.some(point => point.x === RECOVERY && point.y === 1));
  assert(!points.some(point => point.x >= GAP && point.x < RECOVERY && point.y !== null));
  assert(points.some(point => point.x === DEADLINE && point.y === null));
  const before = chart(f.store, RECOVERY - 1);
  assert(!before.some(point => point.x >= GAP && point.y !== null), 'Later recovery never leaks into an earlier chart');
});

test('Caravan recovery rejects changes to identity, meter route, qualification or native field evidence', async t => {
  const cases = {
    identity: candidate => { candidate.raw.identity = 'd'.repeat(64); },
    'meter-route': candidate => { candidate.raw.locationEvidence.meterSignature = 'd'.repeat(64); },
    'probe-clock': candidate => { candidate.raw.locationEvidence.startedAt++; },
    'probe-phase': candidate => { candidate.raw.locationEvidence.phases.on.lastPowerObservedAt++; },
    'changed-value-at-same-clock': candidate => { candidate.value = 2; },
    'source-rollback': candidate => { candidate.sourceTime--; },
    'fan-clock-rollback': candidate => { candidate.raw.fieldTimestamps.fanSpeed--; },
    'power-clock-rollback': candidate => { candidate.raw.fieldTimestamps.power--; },
    retained: candidate => { candidate.raw.retained = true; },
    cached: candidate => { candidate.raw.cached = true; },
    'invalid-quality': candidate => { candidate.quality = ['invalid-value']; },
    'meter-observation-in-future': candidate => { candidate.raw.locationEvidence.meterObservedAt++; },
    'field-deadline-expired': candidate => { candidate.raw.fieldTimestamps.fanSpeed = RECOVERY - MAX_AGE; },
    'original-report-deadline-expired': candidate => { candidate.raw.reportIntervalMs = RECOVERY - SOURCE; },
    'changed-wait-boundary': candidate => { candidate.raw.sourceTimeWait.startedAt--; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
    const f = fixture(t), rows = f.rows(), coverage = f.coverage(), state = f.state();
    change(f.candidate);
    assert.equal(f.resume().changed, false);
    assert.deepEqual(f.rows(), rows); assert.deepEqual(f.coverage(), coverage); assert.deepEqual(f.state(), state);
  });
});

test('Caravan recording does not resume first qualification, genuine failures or a lost wait marker', async t => {
  const cases = {
    'first-qualification': { initial: false },
    'real-outage': { gapMarker: false },
    disconnected: { gapQuality: ['location-unconfirmed', 'mqtt-disconnected', 'unavailable', 'missing'] },
    invalid: { gapQuality: ['location-unconfirmed', 'invalid-value', 'unavailable', 'missing'] },
    failed: { gapQuality: ['location-unconfirmed', 'acquisition-failed', 'missing'] },
    fault: { gapQuality: ['location-unconfirmed', 'native-fault', 'unavailable', 'missing'] },
    'earlier-invalid-attempt': { interruption: ['invalid-value', 'missing'] },
    'earlier-real-outage': { interruption: ['mqtt-disconnected', 'missing'] },
  };
  for (const [name, options] of Object.entries(cases)) await t.test(name, t => {
    const f = fixture(t, options), rows = f.rows();
    assert.equal(f.resume().changed, false); assert.deepEqual(f.rows(), rows);
  });
  await t.test('the original combined deadline still expires', t => {
    const f = fixture(t); assert.equal(f.resume(DEADLINE).changed, false);
    assert.equal(recoveryRows(f.store).length, 0);
  });
});

test('Caravan recording recovery survives restart with original clocks and gap boundaries', t => {
  const directory = mkdtempSync(join(tmpdir(), 'caravan-recording-recovery-'));
  const path = join(directory, 'history.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let recorder = new Recorder(store, { clock: () => RECOVERY });
  const original = reading({ deferred: true }), candidate = structuredClone(original);
  recorder.record(original);
  recorder.record({ ...original, sourceTime: null, receivedAt: GAP, value: null,
    quality: ['location-unconfirmed', 'unavailable', 'missing'],
    raw: { timeBasis: 'availability-transition', reportIntervalMs: MAX_AGE, sourceTimeWait: wait() } });
  candidate.raw.sourceTimeWait = wait(); candidate.raw.locationEvidence.meterObservedAt = RECOVERY;
  assert.equal(recorder.resumeCaravanRecording(candidate, RECOVERY).changed, true);
  const expected = store.observations({ signal: SIGNAL });
  store.close(); store = new Store(path); recorder = new Recorder(store, { clock: () => RECOVERY });
  assert.deepEqual(store.observations({ signal: SIGNAL }), expected);
  assert.equal(recorder.committedAt(SIGNAL, RECOVERY - 1).value, null);
  assert.equal(recorder.committedAt(SIGNAL, RECOVERY).value, 1);
  assert.equal(freshness(recorder, DEADLINE).status, 'stale');
  assert.equal(recorder.resumeCaravanRecording(candidate, RECOVERY + 1).changed, false);
});

test('Caravan recovery rolls back atomically and a retry creates exactly one event', t => {
  const f = fixture(t), rows = f.rows(), coverage = f.coverage(), state = f.state();
  assert.throws(() => f.store.transaction(() => {
    assert.equal(f.resume().changed, true);
    throw new Error('synthetic interrupted transaction');
  }), /synthetic interrupted transaction/);
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.coverage(), coverage); assert.deepEqual(f.state(), state);
  assert.equal(f.resume().changed, true);
  const once = f.rows(), onceCoverage = f.coverage();
  assert.equal(f.resume(RECOVERY + 1).changed, false);
  assert.deepEqual(f.rows(), once); assert.deepEqual(f.coverage(), onceCoverage);
  assert.equal(recoveryRows(f.store).length, 1);
});

test('successive Caravan clock waits preserve the same physical report until a genuine report replaces it', async t => {
  for (const interveningPolicy of [false, true]) await t.test(interveningPolicy ? 'with-report-policy-event' : 'without-policy-event', async t => {
    const f = fixture(t, { deferred: true }); assert.equal(f.resume().changed, true);
    const secondGap = RECOVERY + 700, secondRecovery = secondGap + 700;
    const secondWait = { ...wait(), startedAt: secondGap, deadline: DEADLINE - (interveningPolicy ? 1000 : 0) };
    if (interveningPolicy) {
      const policy = f.recorder.record({ ...f.original, receivedAt: RECOVERY + 300,
        raw: { ...f.original.raw, timeAdmission: undefined, reportIntervalMs: DEADLINE - SOURCE - 1000 } });
      assert.equal(policy.observation.raw.timeBasis, 'report-policy-change');
      assert.equal(policy.observation.raw.originalReportReceivedAt, SOURCE - 500);
      assert.deepEqual(policy.observation.raw.originalReportTimeAdmission, f.original.raw.timeAdmission);
      assert.equal(policy.observation.raw.timeAdmission, undefined);
      f.candidate.raw.reportIntervalMs -= 1000;
    }
    f.recorder.record({ ...f.original, sourceTime: null, receivedAt: secondGap, value: null,
      quality: ['location-unconfirmed', 'unavailable', 'missing'],
      raw: { timeBasis: 'availability-transition', reportIntervalMs: MAX_AGE, reportGraceMs: 0,
        sourceTimeWait: secondWait } });
    f.candidate.raw.sourceTimeWait = secondWait;
    f.candidate.raw.locationEvidence.meterObservedAt = secondRecovery;
    const result = f.resume(secondRecovery);
    assert.equal(result.changed, true, 'An earlier qualified clock wait does not become a genuine outage');
    const events = recoveryRows(f.store);
    assert.deepEqual(events.map(row => row.sourceTime), [SOURCE, SOURCE]);
    assert.deepEqual(events.map(row => row.raw.originalReportReceivedAt), [SOURCE - 500, SOURCE - 500]);
    for (const event of events) assert.deepEqual(event.raw.originalReportTimeAdmission, f.original.raw.timeAdmission);
    assert.equal(f.recorder.committedAt(SIGNAL, secondRecovery - 1).value, null);
    assert.equal(f.recorder.committedAt(SIGNAL, secondRecovery).value, 1);
    const nextSource = secondRecovery + 3000, next = reading();
    next.sourceTime = nextSource; next.receivedAt = nextSource;
    next.raw.fieldTimestamps = { power: nextSource, fanSpeed: nextSource };
    next.raw.reportIntervalMs = MAX_AGE; next.raw.locationEvidence.meterObservedAt = nextSource;
    assert.equal(f.recorder.record(next).saved, true);
    assert.deepEqual(f.state().lastReportTime, { sourceTime: nextSource, receivedAt: nextSource });
    const policy = f.recorder.record({ ...next, receivedAt: nextSource + 5000,
      raw: { ...next.raw, reportIntervalMs: MAX_AGE - 1000 } });
    assert.equal(policy.observation.raw.timeBasis, 'report-policy-change');
    assert.equal(policy.observation.raw.originalReportSourceTime, nextSource);
    assert.equal(policy.observation.raw.originalReportReceivedAt, nextSource);
    assert.equal(policy.observation.raw.originalReportTimeAdmission, undefined);
    const target = new Store(':memory:'); t.after(() => target.close());
    const merged = await merge(target, f.store);
    assert.equal(merged.counts.conflicts, 0); assert.equal(merged.counts.skipped, 0);
    assert.equal(recoveryRows(target).length, 2);
    assert.deepEqual(chart(target, DEADLINE + 1), chart(f.store, DEADLINE + 1));
  });
});

test('a second Caravan wait cannot hide an invalid attempt after the earlier recovery', async t => {
  const f = fixture(t); assert.equal(f.resume().changed, true);
  const secondGap = RECOVERY + 700, secondRecovery = secondGap + 700;
  const secondWait = { ...wait(), startedAt: secondGap };
  const invalid = { ...f.original, sourceTime: null, receivedAt: RECOVERY + 300, value: null,
    quality: ['invalid-value', 'missing'], raw: { timeBasis: 'availability-transition', reportIntervalMs: MAX_AGE } };
  const pause = { ...f.original, sourceTime: null, receivedAt: secondGap, value: null,
    quality: ['location-unconfirmed', 'unavailable', 'missing'], raw: { timeBasis: 'availability-transition',
      reportIntervalMs: MAX_AGE, sourceTimeWait: secondWait } };
  f.recorder.record(invalid); f.recorder.record(pause);
  f.candidate.raw.sourceTimeWait = secondWait; f.candidate.raw.locationEvidence.meterObservedAt = secondRecovery;
  assert.equal(f.resume(secondRecovery).changed, false);

  const donor = fixture(t); assert.equal(donor.resume().changed, true);
  const target = new Store(':memory:'); t.after(() => target.close());
  assert.equal((await merge(target, donor.store)).counts.conflicts, 0);
  donor.recorder.record(pause);
  donor.candidate.raw.sourceTimeWait = secondWait; donor.candidate.raw.locationEvidence.meterObservedAt = secondRecovery;
  assert.equal(donor.resume(secondRecovery).changed, true);
  target.observation(invalid); target.observation(pause);
  const result = await merge(target, donor.store);
  assert(result.counts.conflicts > 0);
  assert.equal(recoveryRows(target).length, 1, 'An accepted first recovery cannot waive a later master fault');
});

test('HistoryMerge preserves a Caravan recovery event and its explicit gap idempotently', async t => {
  const f = fixture(t, { deferred: true }); assert.equal(f.resume().changed, true);
  const target = new Store(':memory:'); t.after(() => target.close());
  const first = await merge(target, f.store);
  assert.equal(first.counts.conflicts, 0); assert.equal(first.counts.skipped, 0);
  assert.deepEqual(target.observations({ signal: SIGNAL }), f.rows());
  assert.deepEqual(target.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(SIGNAL), f.coverage());
  assert.deepEqual(chart(target, DEADLINE + 1), chart(f.store, DEADLINE + 1));
  const again = await merge(target, f.store, 'e'.repeat(64));
  assert.equal(again.counts.missing, 0); assert.equal(again.counts.conflicts, 0); assert.equal(again.counts.skipped, 0);
  assert.equal(again.counts.duplicates, 6);
});

test('HistoryMerge refuses Caravan recovery over contrary master evidence', async t => {
  for (const scenario of ['newer-report', 'newer-unchanged-report', 'real-outage', 'earlier-invalid-before-matching-gap'])
    await t.test(scenario, async t => {
    const f = fixture(t); assert.equal(f.resume().changed, true);
    const target = new Store(':memory:'); t.after(() => target.close());
    const recorder = new Recorder(target, { clock: () => RECOVERY });
    recorder.record(f.original);
    const outage = scenario === 'real-outage' || scenario === 'earlier-invalid-before-matching-gap';
    recorder.record({ ...reading(), sourceTime: outage ? null : GAP + 100,
      receivedAt: scenario === 'earlier-invalid-before-matching-gap' ? GAP - 500 : GAP + 200,
      value: outage ? null : scenario === 'newer-report' ? 2 : 1,
      quality: outage ? ['missing', scenario === 'real-outage' ? 'mqtt-disconnected' : 'invalid-value'] : [],
      raw: { ...reading().raw, fieldTimestamps: { power: GAP + 100, fanSpeed: GAP + 100 } } });
    if (scenario === 'earlier-invalid-before-matching-gap') recorder.record(f.rows()[1]);
    const result = await merge(target, f.store);
    assert(result.counts.conflicts > 0);
    assert.equal(recoveryRows(target).length, 0, 'The donor cannot reopen the master connection');
    assert.equal(target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage WHERE samples=0').get().n, 0);
  });
});

test('HistoryMerge rejects malformed Caravan recovery proof and unsupported zero-sample coverage', async t => {
  const cases = {
    'identity-mismatch': raw => { raw.identity = 'd'.repeat(64); },
    'wait-clock-mismatch': raw => { raw.sourceTimeWait.startedAt = RECOVERY + 1; },
    'wait-deadline-beyond-native-fields': raw => { raw.sourceTimeWait.deadline = SOURCE + MAX_AGE + 1; },
    'measurement-before-qualification': raw => { raw.sourceTimeWait.recordingSince = SOURCE + 1; },
    'missing-original-admission': raw => { delete raw.originalReportTimeAdmission; },
    'wrong-original-receipt': raw => { raw.originalReportReceivedAt++; },
    'changed-recorder-source-clock': raw => { raw.recorder.originalSourceTime++; },
    'unbounded-report-deadline': raw => { raw.reportIntervalMs = MAX_AGE + 1; },
    'qualification-after-wait': raw => { raw.locationEvidence.completedAt = GAP + 1; },
    'failed-native-response': raw => { raw.locationEvidence.powerFallW = 1; },
    'event-receipt-proof': raw => { raw.timeAdmission = raw.originalReportTimeAdmission; },
    'missing-native-phases': raw => { delete raw.locationEvidence.phases; },
    'missing-off-phase': raw => { delete raw.locationEvidence.phases.off; },
    'native-phase-before-command': raw => { raw.locationEvidence.phases.on.firstPowerObservedAt = BASE + 5000; },
    'native-phase-after-completion': raw => { raw.locationEvidence.phases.off.lastPowerObservedAt = GAP; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = fixture(t, { deferred: true }), result = f.resume(); assert.equal(result.changed, true);
    const raw = structuredClone(result.observation.raw); change(raw);
    f.store.db.prepare('UPDATE observations SET raw=? WHERE id=?').run(JSON.stringify(raw), result.observation.id);
    const target = new Store(':memory:'); t.after(() => target.close());
    const report = await merge(target, f.store);
    assert(report.tables.find(row => row.name === 'observations').skipped > 0);
    assert.equal(recoveryRows(target).length, 0);
    assert.equal(target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage WHERE samples=0').get().n, 0);
  });
});

test('HistoryMerge rejects extended or misdated Caravan recovery coverage without changing its event', async t => {
  for (const scenario of ['extended', 'wrong-receipt', 'ordinary-observation']) await t.test(scenario, async t => {
    const f = fixture(t); assert.equal(f.resume().changed, true);
    const coverage = f.coverage().at(-1);
    if (scenario === 'extended') f.store.db.prepare('UPDATE recorder_coverage SET end_at=end_at+1 WHERE id=?').run(coverage.id);
    if (scenario === 'wrong-receipt') f.store.db.prepare('UPDATE recorder_coverage SET start_at=start_at+1,end_at=end_at+1 WHERE id=?').run(coverage.id);
    if (scenario === 'ordinary-observation') f.store.db.prepare('UPDATE recorder_coverage SET observation_id=1 WHERE id=?').run(coverage.id);
    const target = new Store(':memory:'); t.after(() => target.close());
    const report = await merge(target, f.store);
    assert.equal(report.tables.find(row => row.name === 'recorder_coverage').skipped, 1);
    assert.equal(recoveryRows(target).length, 1, 'The valid immutable event is separate from invalid coverage');
    assert.equal(target.db.prepare('SELECT COUNT(*) n FROM recorder_coverage WHERE samples=0').get().n, 0);
  });
});
