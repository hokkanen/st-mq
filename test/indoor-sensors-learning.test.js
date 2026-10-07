import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { indoorAverage } from '../src/domain/indoor-sensors.js';
import { lastIndoorReading, indoorReadingUsable } from '../src/app/indoor-readings.js';
import { addSensorChange } from '../src/app/sensor-changes.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { applyLearningRecord, committedLearningSample, recordLearningContext,
  replayLearningJournal, LEARNING_WINDOW_MS, LEARNING_ALGORITHM} from '../src/app/committed-learning.js';
import { appendLearningRecord, currentComfortReference } from './helpers/home-learning-fixture.js';

const start = Date.parse('2026-01-01T00:00:00Z'), W = LEARNING_WINDOW_MS;
const config = { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1 } };
function record(store, signal, value, at, extra = {}) {
  store.observation({ source: 'mqtt-temperature', device: `invented-${signal}`, signal, value,
    unit: signal.endsWith('temperature') ? 'degC' : 'state', sourceTime: at, receivedAt: at, quality: [], ...extra });
}
function window(store, at, temperatures = [24, 20, 19]) {
  for (const point of [at - W, at]) {
    for (const [i, signal] of ['indoor_temperature', 'downstairs_temperature', 'bedroom_temperature'].entries())
      if (temperatures[i] !== undefined) record(store, signal, temperatures[i], point);
    for (const [signal, value] of [['outdoor_temperature', 0], ['compressor_active', 1],
      ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1]])
      record(store, signal, value, point);
  }
}
function context(store, at = start, configuration = config) {
  recordLearningContext(store, 'providers', { phase: 'normal', regime: 'occupied', roomBoostC: 0, targetC: 21 },
    at, { config: configuration });
}

test('learning keeps three endpoints and their lineage while predicting a fixed configured average', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store); window(store, start + W);
  const sample = committedLearningSample({ store, input: 'providers', at: start + W, config });
  assert.equal(sample.indoorC, 21);
  assert.deepEqual(Object.values(sample.indoorSensors).map(row => row.value), [24, 20, 19]);
  for (const signal of Object.keys(config.indoorSensorWeights)) {
    assert.equal(sample.indoorSensors[signal].weight, 1 / 3);
    assert(sample.provenance.lineage[signal].observations.length > 0);
  }
  appendLearningRecord(store, 'providers', 'sample', sample, { config });
  const cp = replayLearningJournal(store, 'providers');
  assert.deepEqual(cp.samples.at(-1).indoorSensors, sample.indoorSensors);
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), cp);
});

test('missing rooms keep averages missing while old and invalid updates preserve the last genuine contribution', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store);
  window(store, start + W, [24, 20, undefined]);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + W, config }).indoorC, null);
  record(store, 'bedroom_temperature', 19, start + W);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + W, config }).indoorC, 21);
  window(store, start + 4 * W, [24, 20, undefined]);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + 4 * W, config }).indoorC, 21);
  record(store, 'bedroom_temperature', 45, start + 4 * W);
  assert.equal(committedLearningSample({ store, input: 'providers', at: start + 4 * W, config }).indoorC, 21);
  const average = indoorAverage({ indoor_temperature: { value: 24, observedAt: start },
    downstairs_temperature: { value: 20, observedAt: start }, bedroom_temperature: { value: 19, observedAt: start, stale: true } }, config);
  assert.equal(average.value, 21); assert.equal(average.stale, true);
});

test('held readings keep source time and causal scope across outages, delayed arrivals and bad updates', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const signal = 'bedroom_temperature', at = start + 3 * 3_600_000;
  record(store, signal, 19, start);
  const first = lastIndoorReading(store, { signal, at: start + 2 * 3_600_000, input: 'providers' });
  assert.equal(first.needsAttention, false, 'Exactly two hours does not trigger attention');
  record(store, signal, null, start, { receivedAt: start + W, quality: ['mqtt-disconnected', 'failed'],
    raw: { timeBasis: 'availability-transition' } });
  record(store, signal, 27, start + W, { quality: ['retained'], raw: { retained: true } });
  record(store, signal, 28, at + W, { receivedAt: at, quality: ['future_source_time'] });
  record(store, signal, 29, null, { receivedAt: at, quality: ['source_time_unknown'] });
  record(store, signal, 30, at - W, { receivedAt: at + W });
  record(store, signal, 31, at, { source: 'simulation', quality: ['simulated'] });
  const held = lastIndoorReading(store, { signal, at, input: 'providers' });
  assert.equal(held.value, 19);
  assert.equal(held.sourceTime, start);
  assert.equal(held.held, true);
  assert(held.attentionReasons.includes('old-reading'));
  assert.equal(lastIndoorReading(store, { signal, at, input: 'simulated' }).value, 31);
  assert.equal(lastIndoorReading(store, { signal, at, input: 'providers', notBefore: start + W }), null);
  assert.equal(lastIndoorReading(store, { signal: 'garage_temperature', at, input: 'providers' }), null);
  record(store, signal, 20, at);
  const fresh = lastIndoorReading(store, { signal, at, input: 'providers' });
  assert.equal(fresh.value, 20); assert.deepEqual(fresh.attentionReasons, []);
});

test('age-only stale publications remain genuine inputs while invalid measurements never replace them', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const at = start + 4 * 3_600_000, signal = 'bedroom_temperature';
  record(store, signal, 18, start, { receivedAt: at, quality: ['stale'] });
  const held = lastIndoorReading(store, { signal, at, input: 'providers' });
  assert.equal(held.value, 18); assert.equal(held.sourceTime, start);
  for (const extra of [{ quality: ['retained'] }, { quality: ['source_time_unknown'] },
    { quality: ['implausible_temperature'] }, { unit: 'K' }, { raw: { auditOnly: true } },
    { value: 0 }, { value: 45 }]) assert.equal(indoorReadingUsable({ ...held, ...extra }, at), false);
  const native = { ...held, source: 'husdata-h66', raw: { usableForControl: false, verification: { scale: 1 } } };
  assert.equal(indoorReadingUsable(native, at), true);
  assert.equal(indoorReadingUsable({ ...native, quality: ['stale', 'unverified-scaling'] }, at), false);
  record(store, 'garage_temperature', -8, start, { receivedAt: at, quality: ['stale'] });
  assert.equal(lastIndoorReading(store, { signal: 'garage_temperature', at, input: 'providers' }).value, -8);
});

test('Recorded out-of-order input cannot replace a newer compressed room update', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const recorder = new Recorder(store, { });
  const signal = 'bedroom_temperature';
  const observation = (value, sourceSecond, receiptSecond = sourceSecond) => ({ source: 'mqtt-temperature',
    device: 'invented-room', signal, value, unit: 'degC', sourceTime: start + sourceSecond * 1000,
    receivedAt: start + receiptSecond * 1000, quality: [], raw: { retained: false } });
  const initial = recorder.record(observation(20, 1));
  assert.equal(recorder.record(observation(20, 61)).saved, false, 'The newer genuine observation is represented by coverage');
  const delayed = observation(25, 31, 121);
  const delayedId = recorder.record(delayed).id;
  assert.ok(store.db.prepare('SELECT quality FROM observations WHERE id=?').get(delayedId).quality.includes('out-of-order-source-time'));
  const originalRow = store.db.prepare('SELECT * FROM observations WHERE id=?').get(delayedId);
  const held = lastIndoorReading(store, { signal, at: start + 121_000, input: 'providers' });
  assert.equal(held.value, 20); assert.equal(held.id, initial.id);
  assert.equal(held.sourceTime, start + 1000, 'Coverage does not renew the saved measurement timestamp');
  assert.deepEqual(held.attentionReasons, ['invalid-reading']);
  const sample = committedLearningSample({ store, input: 'providers', at: start + 121_000,
    config: { indoorSensorWeights: { bedroom_temperature: 1 } } });
  assert.equal(sample.indoorC, 20);
  assert.deepEqual(sample.provenance.lineage.bedroom_temperature.observations, [initial.id]);
  assert.equal(sample.indoorSensors.bedroom_temperature.observedAt, start + 1000);
  assert.deepEqual(store.db.prepare('SELECT * FROM observations WHERE id=?').get(delayedId), originalRow);
  recorder.record(observation(21, 181));
  const recovered = lastIndoorReading(store, { signal, at: start + 181_000, input: 'providers' });
  assert.equal(recovered.value, 21); assert.deepEqual(recovered.attentionReasons, []);
});

test('later fresh coverage cannot retroactively reinterpret an ambiguous stale observation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const signal = 'bedroom_temperature';
  const initialId = store.observation({ source: 'mqtt-temperature', device: 'invented-room', signal,
    value: 20, unit: 'degC', sourceTime: start + 1000, receivedAt: start + 1000, quality: [] });
  const delayedId = store.observation({ source: 'mqtt-temperature', device: 'invented-room', signal,
    value: 25, unit: 'degC', sourceTime: start + 31_000, receivedAt: start + 121_000,
    quality: ['stale'], raw: { recorder: { status: 'stale' } } });
  const args = { signal, at: start + 121_000, input: 'providers' };
  const before = lastIndoorReading(store, args);
  assert.equal(before.id, delayedId, 'Without prior newer evidence, age-only stale remains eligible');
  store.db.prepare(`INSERT INTO recorder_coverage
    (source,device,signal,status,start_at,end_at,source_time,observation_id,samples)
    VALUES(?,?,?,'fresh',?,?,?,?,1)`).run('mqtt-temperature', 'invented-room', signal,
    start + 181_000, start + 181_000, start + 61_000, initialId);
  assert.deepEqual(lastIndoorReading(store, args), before);
  assert.equal(lastIndoorReading(store, { ...args, at: start + 181_000 }).id, delayedId,
    'A classification uses evidence known when that observation was received');
});

test('outage learning saves held endpoint provenance and replays identically after a restart', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-held-indoor-'));
  const path = join(directory, 'invented.sqlite'); let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  context(store);
  for (const [signal, value] of [['indoor_temperature', 24], ['downstairs_temperature', 20], ['bedroom_temperature', 19]])
    record(store, signal, value, start);
  record(store, 'bedroom_temperature', null, start, { receivedAt: start + W,
    quality: ['mqtt-disconnected', 'failed'], raw: { timeBasis: 'availability-transition' } });
  const at = start + 3 * 3_600_000;
  for (const point of [at - W, at]) record(store, 'outdoor_temperature', 0, point, { source: 'fmi' });
  record(store, 'indoor_temperature', 24, at); record(store, 'downstairs_temperature', 20, at);
  const sample = committedLearningSample({ store, input: 'providers', at, config });
  assert.equal(sample.indoorC, 21); assert.deepEqual(sample.quality, []);
  assert.equal(sample.indoorSensors.bedroom_temperature.observedAt, start);
  assert.deepEqual(sample.indoorSensors.bedroom_temperature.attentionReasons, ['old-reading', 'disconnected']);
  assert.equal(sample.provenance.lineage.bedroom_temperature.observations.length, 1);
  appendLearningRecord(store, 'providers', 'sample', sample, { config });
  const checkpoint = replayLearningJournal(store, 'providers');
  assert.equal(checkpoint.state.indoorC, 21);
  store.close(); store = new Store(path);
  assert.deepEqual(committedLearningSample({ store, input: 'providers', at, config }), sample);
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), checkpoint);
  assert.deepEqual(checkpoint.samples.at(-1).indoorSensors, sample.indoorSensors);
  record(store, 'bedroom_temperature', 26, at - W, { receivedAt: at + W });
  assert.deepEqual(committedLearningSample({ store, input: 'providers', at, config }), sample,
    'A late receipt cannot change the historical held endpoint or its warning');
});

test('sensor changes isolate replay, settling and pre-change measurements without rewriting raw observations', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store); window(store, start + W);
  appendLearningRecord(store, 'providers', 'sample', committedLearningSample({ store, input: 'providers', at: start + W, config }), { config });
  const before = replayLearningJournal(store, 'providers');
  const raw = store.db.prepare('SELECT * FROM observations ORDER BY id').all();
  addSensorChange(store, 'providers', { signal: 'bedroom_temperature', reason: 'replacement', requestId: 'invented-change' },
    start + W, { config, seed: before });
  const reset = replayLearningJournal(store, 'providers', before);
  assert.equal(reset.state, null); assert.equal(reset.baselineC, null);
  assert.deepEqual(reset.model, before.model); assert.deepEqual(reset.samples, before.samples);
  assert.deepEqual(reset.model.parameters, before.model.parameters);
  for (const at of [start + 2 * W, start + 3 * W]) {
    window(store, at, [24, 20, 20]);
    const sample = committedLearningSample({ store, input: 'providers', at, config });
    assert.equal(sample.indoorC, null);
    appendLearningRecord(store, 'providers', 'sample', sample, { config });
  }
  window(store, start + 4 * W, [24, 20, 20]);
  const settled = committedLearningSample({ store, input: 'providers', at: start + 4 * W, config });
  assert(Math.abs(settled.indoorC - 64 / 3) < 1e-9);
  appendLearningRecord(store, 'providers', 'sample', settled, { config });
  const live = replayLearningJournal(store, 'providers', reset);
  assert.deepEqual(replayLearningJournal(store, 'providers', null, { rebuild: true }), live);
  assert.deepEqual(store.db.prepare('SELECT * FROM observations WHERE id<=? ORDER BY id').all(raw.at(-1).id), raw);
  assert.deepEqual(live.samples[0], before.samples[0]);
  assert.equal(live.samples.length, before.samples.length + 3);
});

test('membership changes create a measurement epoch and old CSV samples keep the original single sensor', t => {
  const store = new Store(':memory:'); t.after(() => store.close()); context(store, start, {}); window(store, start + W);
  appendLearningRecord(store, 'providers', 'sample', committedLearningSample({ store, input: 'providers', at: start + W }), {});
  let cp = replayLearningJournal(store, 'providers');
  context(store, start + 2 * W, config);
  cp = replayLearningJournal(store, 'providers', cp);
  assert.equal(cp.measurementEpochAt, start + 2 * W);
  assert.equal(cp.baselineC, null); assert.equal(cp.state, null); assert.deepEqual(cp.samples, []);
  const afterSettling = committedLearningSample({ store, input: 'providers', at: start + 8 * W,
    config, measurementEpochAt: cp.measurementEpochAt });
  assert.equal(afterSettling.indoorC, null, 'Changing membership cannot revive pre-epoch held measurements after settling');
  const sample = { timestamp: start + W, indoorC: 24, outdoorC: 0, phase: 'normal', regime: 'occupied', quality: [] };
  appendLearningRecord(store, 'history', 'sample', sample, { config });
  const entry = store.learningJournal({ input: 'history' })[0];
  assert.deepEqual(entry.payload.configuration.indoorSensorWeights, { indoor_temperature: 1 });
  assert.equal(entry.payload.value.indoorC, 24);
  assert.equal(applyLearningRecord(null, entry).samples[0].indoorC, 24);
});

test('changed sensors cannot regain obsolete validation from imported upstairs-only history', async t => {
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'providers', control: config }, clock: () => start + W });
  t.after(async () => { await engine.closeFireplace(); store.close(); });
  const seed = engine.readAdaptive(start + W);
  store.setState('adaptive:history', { ...seed, algorithmVersion: LEARNING_ALGORITHM,
    model: { ...seed.model, validation: { accepted: true } }, baselineC: 24 });
  engine.changeSensor({ signal: 'bedroom_temperature', reason: 'moved', requestId: 'invented-move' });
  assert.equal(engine.checkpoint.model.validation, null);
  assert.equal(engine.checkpoint.baselineC, null);
  assert.equal(engine.checkpoint.sensorEpochs.bedroom_temperature, start + W);
  assert(engine.status().observations.indoor.stale);
});

test('occupied comfort protects the configured average without individual room vetoes', async t => {
  const store = new Store(':memory:'); let now = start + W;
  const control = { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 2 } };
  const engine = new Engine({ store, config: { input: 'providers', control,
    settings: { comfort: { maxDropC: 1, maxRiseC: 1 } } }, clock: () => now,
    commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
      publish: async () => ({ status: 'synthetic', sent: true, actual: null }), close: async () => {} } });
  t.after(async () => { await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  engine.automation.set('home', true);
  const seed = restoreAdaptiveCheckpoint(null, control);
  seed.baselineC = 21; seed.comfortReference = currentComfortReference(21, start);
  appendLearningRecord(store, 'providers', 'context', { timestamp: start }, { config: control, seed });
  function readings(upstairs, downstairs, bedroom) {
    for (const [signal, value] of [['indoor_temperature', upstairs], ['downstairs_temperature', downstairs],
      ['bedroom_temperature', bedroom], ['outdoor_temperature', 0]]) engine.ingest({ signal, value,
      source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: signal,
      sourceTime: now, receivedAt: now, quality: [], unit: 'degC' });
  }
  readings(25, 23, 18);
  let status = engine.tick();
  assert.equal(status.observations.indoor.value, 21);
  assert(!status.decision.reasons.includes('indoor-comfort-limit'), 'A cool Bedroom cannot veto a comfortable average');
  assert.equal(Object.hasOwn(status, 'comfortRooms'), false);
  now += 60_000; readings(19, 19, 20);
  status = engine.tick();
  assert.equal(status.observations.indoor.value, 19.5);
  assert(status.decision.reasons.includes('indoor-comfort-limit'), JSON.stringify({ reasons: status.decision.reasons, baselineC: engine.checkpoint.baselineC, comfort: status.settings.comfort }));
  now += 60_000; readings(25, 25, 23);
  status = engine.tick();
  assert.equal(status.observations.indoor.value, 24);
  assert(!status.decision.reasons.includes('indoor-comfort-limit'), 'Warm average alone does not prohibit Normal or reduction');
});

test('one expired room uses a separate weighted control estimate through restart without training or filling history', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-indoor-estimate-engine-'));
  const path = join(directory, 'synthetic.sqlite'); let store = new Store(path), now = start;
  const control = { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 2 } };
  const engineConfig = { input: 'providers', control, settings: { comfort: { maxDropC: 1, maxRiseC: 1 } } };
  const runtimes = [];
  const makeEngine = () => { const engine = new Engine({ store, config: engineConfig, clock: () => now,
    commandTransport: { targetIdentity: { tariff: 'a'.repeat(64), dhwr: 'b'.repeat(64) },
      publish: async () => ({ status: 'synthetic', sent: true, actual: null }), close: async () => {} } });
    engine.automation.set('home', true); runtimes.push(engine); return engine; };
  const stop = async engine => {
    await engine.charging.close(); await engine.garage.close({ restore: false });
    await engine.closeFireplace(); await engine.executor.close({ restore: false });
  };
  let engine = makeEngine();
  t.after(async () => { for (const runtime of runtimes) await stop(runtime); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const ingest = (signal, value, room = false) => engine.ingest({ source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature',
    device: signal, signal, value, unit: signal.endsWith('temperature') ? 'degC' : 'state',
    sourceTime: now, receivedAt: now, quality: [], raw: room ? { reportIntervalMs: 10 * 60_000, reportGraceMs: 0 } : null });
  function report(minute, { bedroom = true, warming = 0, equipment = true } = {}) {
    now = start + minute * 60_000;
    ingest('indoor_temperature', 22 + warming, true); ingest('downstairs_temperature', 20 + warming, true);
    if (bedroom) ingest('bedroom_temperature', 19, true);
    ingest('outdoor_temperature', 0);
    if (equipment) for (const [signal, value] of [['compressor_active', 1], ['dhw_routing', 0], ['auxiliary_output', 0],
      ['alarm_active', 0], ['operating_mode', 1]]) ingest(signal, value);
    return engine.tick();
  }
  for (let minute = 0; minute <= 60; minute += 5) report(minute);
  assert.equal(engine.status().observations.indoor.value, 20);
  const reference = structuredClone(engine.checkpoint.comfortReference);
  assert(reference, 'Ordinary occupied Normal heating establishes an aggregate reference');
  const bedroomReports = store.observations({ signal: 'bedroom_temperature' }).length;
  report(65, { bedroom: false });
  const measuredRuntime = store.getState('indoor-control-state:providers');
  assert.equal(measuredRuntime.estimated, false);
  assert.ok(measuredRuntime.state.reserveC > engine.checkpoint.state.reserveC,
    'Actual heating since the latest committed window advances the runtime reserve');
  assert.deepEqual(engine.heatingExplorer.input.thermalState, measuredRuntime.state,
    'The planner and explorer receive the caught-up reserve while the indoor average remains measured');
  for (let minute = 70; minute <= 90; minute += 5) report(minute, { bedroom: false, warming: minute > 70 ? .4 : 0 });
  let status = engine.status();
  assert.equal(status.observations.indoor.value, null);
  assert.equal(status.observations.indoor.stale, true);
  assert.equal(status.observations.indoorControl.estimated, true);
  assert.equal(status.observations.indoorControl.estimatedSensor, 'bedroom_temperature');
  assert.equal(status.observations.indoorControl.value, 20.4);
  assert.equal(status.observations.indoorControl.anchorAt, start + 60 * 60_000);
  assert.equal(status.observations.indoorControl.estimatedSourceObservedAt, start + 60 * 60_000);
  assert.equal(store.getState('indoor-control-state:providers')?.estimated, true, 'Covered actual heat inputs preserve a separate runtime forecast state');
  assert(!status.decision.reasons.includes('estimated-indoor-thermal-state-unavailable'));
  assert.deepEqual(engine.checkpoint.comfortReference, reference, 'A missing measured average contributes no comfort evidence');
  assert.equal(store.observations({ signal: 'bedroom_temperature' }).length, bedroomReports);
  const missing = store.learningJournal({ input: 'providers' }).filter(row => row.kind === 'sample'
    && row.payload.value.timestamp >= start + 75 * 60_000);
  assert(missing.length > 0);
  assert(missing.every(row => row.payload.value.indoorC === null && row.payload.value.indoorSensors.bedroom_temperature.value === null));
  const model = structuredClone(engine.checkpoint.model), anchor = structuredClone(store.getState('indoor-control-anchor:providers'));
  await stop(engine); runtimes.splice(runtimes.indexOf(engine), 1); store.close(); store = new Store(path); engine = makeEngine();
  status = engine.tick();
  assert.equal(status.observations.indoor.value, null);
  assert.equal(status.observations.indoorControl.estimated, true);
  assert.equal(status.observations.indoorControl.value, 20.4);
  assert.deepEqual(store.getState('indoor-control-anchor:providers'), anchor, 'Restart preserves original baseline clocks');
  assert.deepEqual(engine.checkpoint.model, model);
  assert.deepEqual(engine.checkpoint.comfortReference, reference);
  status = report(95, { bedroom: false, warming: .6 });
  assert.equal(status.observations.indoorControl.value, 20.6);
  status = report(100, { bedroom: true, warming: .6 });
  assert.equal(status.observations.indoorControl.estimated, false);
  assert.equal(status.observations.indoor.value, 20.3, 'Returned actual Bedroom replaces its estimate immediately');
  for (let minute = 105; minute <= 120; minute += 5) status = report(minute, { bedroom: false, warming: .6, equipment: false });
  assert.equal(status.observations.indoorControl.estimated, true);
  assert(status.decision.reasons.includes('estimated-indoor-thermal-state-unavailable'), 'Missing heat-input coverage keeps the temperature estimate visible but selects Normal');
  assert.equal(status.decision.phase, 'normal');
});
