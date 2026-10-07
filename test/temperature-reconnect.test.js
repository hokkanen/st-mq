import { committedStatus } from './helpers/committed-status.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { committedLearningSample, replayLearningJournal, recordLearningContext} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

const MINUTE = 60_000, START = Date.parse('2026-09-13T00:00:00Z'), signal = 'indoor_temperature';
const routeSignature = 'a'.repeat(64), policy = { reportIntervalMs: 70 * MINUTE, reportGraceMs: 5 * MINUTE };
const report = (minute, extra = {}) => ({ source: 'mqtt-temperature', device: signal, signal, value: 21, unit: 'degC',
  sourceTime: START + minute * MINUTE, receivedAt: START + minute * MINUTE, quality: [],
  raw: { ...policy, timeBasis: 'mqtt-received', temperatureRouteSignature: routeSignature }, ...extra });
function fixture(t) {
  const store = new Store(':memory:'); let now = START;
  const configuration = { input: 'providers' };
  const engines = [];
  const restart = () => {
    const engine = new Engine({ store, config: configuration, clock: () => now });
    engines.push(engine); return engine;
  };
  const engine = restart();
  t.after(async () => {
    for (const engine of engines) { await engine.closeFireplace(); await engine.executor.close({ restore: false }); }
    store.close();
  });
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', targetC: 21, roomBoostC: 0 }, START);
  for (let minute = 0; minute <= 120; minute += 5) store.observation({ source: 'fmi', device: 'invented-weather',
    signal: 'outdoor_temperature', value: 5, unit: 'degC', sourceTime: START + minute * MINUTE,
    receivedAt: START + minute * MINUTE, quality: [] });
  return { store, engine, restart, at: minute => { now = START + minute * MINUTE; },
    sample: minute => committedLearningSample({ store, input: 'providers', at: START + minute * MINUTE }),
    fail(minute, quality = ['mqtt-disconnected']) {
      now = START + minute * MINUTE;
      engine.ingest(report(minute, { value: null, sourceTime: null, quality,
        raw: { ...policy, timeBasis: 'availability-transition', temperatureRouteSignature: routeSignature } }));
    } };
}
const confirm = engine => engine.confirmTemperatureConnection(signal, { ...policy, routeSignature });

test('confirmed reconnect restores a recent report prospectively and preserves outage windows and frozen replay', async t => {
  const f = fixture(t);
  f.engine.ingest(report(0));
  const before = f.sample(5);
  f.fail(10);
  const outage = f.sample(20);
  appendLearningRecord(f.store, 'providers', 'sample', before);
  appendLearningRecord(f.store, 'providers', 'sample', outage);
  const journal = f.store.learningJournal({ input: 'providers' });
  const spans = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(signal);
  f.at(30);
  const restarted = f.restart();
  assert.equal((await committedStatus(restarted)).observations.indoor.value, null);
  const recovered = confirm(restarted);
  assert.equal(recovered.sourceTime, START);
  assert.equal(recovered.receivedAt, START);
  assert.equal(recovered.reportExpiresAt, START + 75 * MINUTE);
  assert.equal((await committedStatus(restarted)).observations.indoor.value, 21);
  assert.equal((await committedStatus(restarted)).observations.upstairs.needsAttention, undefined);
  assert.deepEqual(f.sample(5), before);
  assert.deepEqual(f.sample(20), outage);
  assert.equal(f.sample(30).indoorC, null);
  assert.equal(f.sample(45).indoorC, 21);
  assert.deepEqual(f.store.learningJournal({ input: 'providers' }).slice(0, journal.length), journal);
  assert.deepEqual(replayLearningJournal(f.store, 'providers'), replayLearningJournal(f.store, 'providers', null, { rebuild: true }));
  const after = f.store.db.prepare('SELECT * FROM recorder_coverage WHERE signal=? ORDER BY id').all(signal);
  assert.deepEqual(after.slice(0, spans.length), spans);
  assert.equal(after.at(-1).start_at, START + 30 * MINUTE);
  assert.equal(after.at(-1).samples, 0);
  const event = f.store.latestObservation(signal);
  assert.equal(event.raw.timeBasis, 'mqtt-transport-recovery');
  assert.equal(event.raw.originalReportTimeBasis, 'mqtt-received');
  assert.equal((await committedStatus(restarted)).observations.upstairs.sourceTimeBasis, 'received-at');
  assert.equal(event.raw.originalReportReceivedAt, START);
  assert.equal(event.receivedAt, START + 30 * MINUTE);
  const count = f.store.observations({ signal }).length;
  confirm(restarted);
  assert.equal(f.store.observations({ signal }).length, count, 'Duplicate confirmations do not create reports or events');
  f.at(75);
  assert.equal((await committedStatus(restarted)).observations.indoor.value, null);
  assert.equal(confirm(restarted), null);
});

test('a changed reporting policy can recover a confirmed transport route without erasing its old deadline gap', async t => {
  const f = fixture(t);
  f.engine.ingest(report(0, { raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE,
    temperatureRouteSignature: routeSignature } }));
  f.fail(10, ['mqtt-subscription-failed']);
  f.at(30); f.engine.configureTemperatureReports(signal, policy);
  assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
  f.at(32); assert.equal(confirm(f.engine).reportExpiresAt, START + 75 * MINUTE);
  assert.equal(f.sample(30).indoorC, null);
  assert.equal(f.sample(45).indoorC, null);
  assert.equal(f.sample(47).indoorC, 21);
});

test('transport confirmation cannot conceal invalid data, a changed route, unsigned history or an expired report', async t => {
  for (const invalid of [['invalid-temperature-message'], ['missing'], ['future_source_time'], ['out-of-order-source-time'], ['device-offline']]) {
    const f = fixture(t); f.engine.ingest(report(0));
    f.fail(5, invalid); f.fail(10);
    f.at(20);
    assert.equal(confirm(f.engine), null, invalid.join(','));
    assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
  }
  const f = fixture(t); f.engine.ingest(report(0)); f.fail(10); f.at(20);
  assert.equal(f.engine.confirmTemperatureConnection(signal, { ...policy, routeSignature: 'b'.repeat(64) }), null);
  assert.equal(f.engine.confirmTemperatureConnection(signal, policy), null);
  const unsigned = fixture(t); unsigned.engine.ingest(report(0, { raw: policy })); unsigned.fail(10); unsigned.at(20);
  assert.equal(confirm(unsigned.engine), null);
  f.at(75); assert.equal(confirm(f.engine), null);
});

test('reconnect does not relax sensor-change exclusions or grant garage and equipment recovery', async t => {
  const f = fixture(t); f.engine.ingest(report(0)); f.fail(5);
  addSensorChange(f.store, 'providers', { signal, reason: 'replacement', requestId: 'invented-reconnect-replacement' }, START + 10 * MINUTE);
  f.at(30); assert.equal(confirm(f.engine), null);
  assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
  assert.equal(f.sample(45).indoorC, null);
  assert.equal(f.engine.confirmTemperatureConnection('garage_temperature', { ...policy, routeSignature }), null);
  assert.equal(f.engine.confirmTemperatureConnection('caravan_active', { ...policy, routeSignature }), null);
});

test('reconnect keeps the last compressed report time and an ensuing disconnect immediately invalidates it', async t => {
  const f = fixture(t); f.engine.ingest(report(0));
  f.at(15 + 1 / 60); f.engine.ingest(report(15, { receivedAt: START + 15 * MINUTE + 1000 }));
  f.fail(20); f.at(30);
  const recovered = confirm(f.engine);
  assert.equal(recovered.sourceTime, START + 15 * MINUTE);
  assert.equal(recovered.receivedAt, START + 15 * MINUTE + 1000);
  assert.equal(recovered.reportExpiresAt, START + 90 * MINUTE);
  f.at(31); f.engine.ingest(report(31, { quality: ['retained'], raw: { ...policy, retained: true,
    temperatureRouteSignature: routeSignature } }));
  assert.equal((await committedStatus(f.engine)).observations.upstairs.reportExpiresAt, START + 90 * MINUTE);
  f.fail(32);
  assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
  f.at(89 + 59 / 60); assert.equal(confirm(f.engine).sourceTime, START + 15 * MINUTE);
  f.at(90); assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
});

test('recovery storage failure rolls back the event and leaves runtime unavailable until retry', async t => {
  const f = fixture(t); f.engine.ingest(report(0)); f.fail(10); f.at(20);
  const rows = f.store.observations({ signal }), state = f.engine.recorder.signalState(report(0), START + 20 * MINUTE);
  const write = f.store.setState.bind(f.store);
  f.store.setState = (key, value) => {
    if (key.startsWith('recorder:signal:')) throw new Error('synthetic storage failure');
    return write(key, value);
  };
  assert.throws(() => confirm(f.engine), /synthetic storage failure/);
  f.store.setState = write;
  assert.deepEqual(f.store.observations({ signal }), rows);
  assert.deepEqual(f.engine.recorder.signalState(report(0), START + 20 * MINUTE), state);
  assert.equal((await committedStatus(f.engine)).observations.indoor.value, null);
  assert.equal(confirm(f.engine).sourceTime, START);
});

test('a first signed unchanged report establishes route evidence and a later route change saves its own evidence', async t => {
  const f = fixture(t); f.engine.ingest(report(0, { raw: policy }));
  f.at(15);
  assert.equal(f.engine.ingest(report(15)).saved, true);
  assert.equal(f.store.latestObservation(signal).raw.temperatureRouteSignature, routeSignature);
  f.fail(20); f.at(30);
  assert.equal(confirm(f.engine).sourceTime, START + 15 * MINUTE);
  const nextRoute = 'b'.repeat(64);
  f.at(40);
  assert.equal(f.engine.ingest(report(40, { raw: { ...policy, temperatureRouteSignature: nextRoute } })).saved, true);
  f.fail(45); f.at(50);
  assert.equal(confirm(f.engine), null);
  assert.equal(f.engine.confirmTemperatureConnection(signal, { ...policy, routeSignature: nextRoute }).sourceTime, START + 40 * MINUTE);
});
