import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { validateSettings } from '../src/app/config.js';
import { addSensorChange, sensorChangesView } from '../src/app/sensor-changes.js';
import { sensorChangeEvents, sensorBoundaries, affectsThermalLearning } from '../src/app/sensor-inputs.js';
import { LEARNING_ALGORITHM} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { SENSOR_SETTLING_MS } from '../src/domain/indoor-sensors.js';

const now = Date.parse('2026-09-10T12:00:00Z'), HOUR = 3_600_000;
const change = (requestId = 'invented-change', signal = 'indoor_temperature', reason = 'replacement') => ({ requestId, signal, reason });
const sourceCount = store => store.db.prepare("SELECT COUNT(*) n FROM learning_journal WHERE json_type(payload,'$.value.sensorChange')='object'").get().n;

function fixture(t) {
  const store = new Store(':memory:');
  const config = { input: 'providers', settings: validateSettings({ mode: 'monitoring' }),
    control: { learningTrials: false, indoorSensorWeights: { indoor_temperature: 0.5, bedroom_temperature: 0.5 } } };
  const engine = new Engine({ store, config, clock: () => now });
  const seed = restoreAdaptiveCheckpoint(null, engine.control);
  seed.model.parameters.lossPerHour = 0.018;
  seed.model.parameters.normalHeatCPerHour = 0.62;
  seed.model.validation = { accepted: true, kind: 'conditional-thermal', samples: 200 };
  seed.model.forecastValidation = { accepted: true, episodes: 6 };
  seed.model.equipmentResponse = { phases: { normal: { episodes: 6 } }, validation: { accepted: true } };
  seed.samples = [now - HOUR, now - HOUR / 2].map(timestamp => ({ timestamp, indoorC: 21.5, outdoorC: 10,
    phase: 'normal', regime: 'occupied', quality: [], valid: true }));
  seed.cursor = new Date(now - HOUR / 2).toISOString();
  seed.state = { indoorC: 21.5, reserveC: 22, observedAt: now - HOUR / 2 };
  seed.baselineC = 21.5;
  seed.comfortReference = { baselineC: 21.5, observedAt: now - HOUR / 2 };
  seed.sensorComfortReferences = { indoor_temperature: { baselineC: 22 }, bedroom_temperature: { baselineC: 21 } };
  seed.episodeArchive = [{ id: 'invented-old-cycle', startedAt: now - 2 * HOUR, endedAt: now - HOUR, phases: [], samples: [] }];
  seed.sinceFit = 8;
  appendLearningRecord(store, config.input, 'context', { timestamp: now - HOUR / 2 }, { config: engine.control, seed });
  const initial = structuredClone(engine.readAdaptive(now));
  // Keep follow-up scheduling separate so assertions inspect the complete
  // checkpoint published by the change action itself. HTTP tests use real ticks.
  engine.tick = () => {};
  t.after(async () => {
    await engine.closeFireplace(); engine.executor.closed = true; clearTimeout(engine.executor.timer); store.close();
  });
  return { store, engine, initial };
}

test('sensor source changes preserve server time and one immutable event per retry within each input stream', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = addSensorChange(store, 'providers', change(), now);
  const repeated = addSensorChange(store, 'providers', change(), now + HOUR);
  const second = addSensorChange(store, 'providers', change('invented-move', 'bedroom_temperature', 'moved'), now + 1);
  addSensorChange(store, 'simulated', change(), now);
  assert.equal(repeated.id, first.id); assert.equal(repeated.repeated, true);
  assert.equal(repeated.at, now); assert.equal(repeated.settleUntil, now + SENSOR_SETTLING_MS);
  assert.equal(sourceCount(store), 3);
  assert.deepEqual(sensorChangeEvents(store, 'providers', { at: now }).map(row => row.id), [first.id]);
  assert.deepEqual(sensorChangeEvents(store, 'providers').map(row => row.id), [second.id, first.id]);
  assert.deepEqual(sensorBoundaries(store, 'providers', now), { indoor_temperature: now });
  assert.deepEqual(sensorBoundaries(store, 'providers', now + 1), { bedroom_temperature: now + 1, indoor_temperature: now });
  for (const payload of [change('invented-change', 'bedroom_temperature'), change('invented-change', 'indoor_temperature', 'other')])
    assert.throws(() => addSensorChange(store, 'providers', payload, now), error => error.statusCode === 409);
  assert.equal(sourceCount(store), 3);
});

test('sensor boundaries select the latest unreverted time within the requested correction revision and input', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const append = (value, at, input = 'providers') => store.appendLearningJournal(input, {
    kind: 'context', at, algorithmVersion: LEARNING_ALGORITHM, key: `invented-context-${input}-${at}`,
    payload: { value },
  });
  const first = append({ sensorChange: { signal: 'indoor_temperature' } }, now);
  const latest = append({ sensorChange: { signal: 'indoor_temperature' } }, now + 2);
  append({ sensorChange: { signal: 'indoor_temperature' } }, now + 1);
  append({ sensorChange: { signal: 'bedroom_temperature' } }, now + 5);
  append({ sensorRevert: { id: first } }, now + 10, 'simulated');
  const revision = append({ sensorRevert: { id: latest } }, now + 10);
  const lastRevision = append({ sensorRevert: { id: first } }, now + 11);
  assert.deepEqual(sensorBoundaries(store, 'providers', now + 2, { revision: 0 }), { indoor_temperature: now + 2 });
  assert.deepEqual(sensorBoundaries(store, 'providers', now + 2, { revision }), { indoor_temperature: now + 1 });
  assert.deepEqual(sensorBoundaries(store, 'providers', now, { revision }), { indoor_temperature: now });
  assert.deepEqual(sensorBoundaries(store, 'providers', now, { revision: lastRevision }), {});
  assert.deepEqual(sensorBoundaries(store, 'providers', now + 11), {
    indoor_temperature: now + 1, bedroom_temperature: now + 5,
  });
  assert.throws(() => sensorBoundaries(store, 'providers', now, { revision: -1 }), TypeError);
});

test('sensor boundaries follow the selected journal epoch and referenced immutable context payloads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const source = store.appendLearningJournal('providers', { kind: 'context', at: now,
    algorithmVersion: LEARNING_ALGORITHM, key: 'invented-original-change',
    payload: { value: { sensorChange: { signal: 'garage_temperature' } } } });
  store.appendLearningJournal('providers', { kind: 'context', at: now + 1,
    algorithmVersion: LEARNING_ALGORITHM, key: 'invented-original-revert',
    payload: { value: { sensorRevert: { id: source } } } });
  store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,source_entry_id) VALUES(?,?,'invented-projected-change','context',?,?,?)`)
    .run('invented-recovery', 'providers', now, LEARNING_ALGORITHM, source);
  store.db.prepare('INSERT INTO learning_epochs(input,epoch) VALUES(?,?)').run('providers', 'invented-recovery');
  assert.deepEqual(sensorBoundaries(store, 'providers', now + 2), { garage_temperature: now });
});

test('sensor changes reject timestamps, private fields, unsupported signals and invalid identities before storing a source event', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const valid = change();
  for (const payload of [null, [], {}, { ...valid, signal: 'supply_temperature' }, { ...valid, reason: 'adjusted' },
    { ...valid, requestId: '' }, { ...valid, requestId: 'has spaces' }, { ...valid, requestId: 'a'.repeat(101) },
    { ...valid, at: now - HOUR }, { ...valid, settleUntil: now }, { ...valid, device: 'invented-private-device' },
    { ...valid, notes: 'invented-private-note' }, { ...valid, input: 'simulated' }])
    assert.throws(() => addSensorChange(store, 'providers', payload, now), TypeError);
  for (const input of ['offline', 'history', 'unknown']) assert.throws(() => addSensorChange(store, input, valid, now), TypeError);
  for (const at of [null, NaN, -1, 1.2]) assert.throws(() => addSensorChange(store, 'providers', valid, at), TypeError);
  assert.equal(sourceCount(store), 0);
});

test('sensor status exposes logical labels and effective events without retry identities or private configuration', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { indoorSensorWeights: { bedroom_temperature: 1 }, connections: { token: 'synthetic-invented-secret' } };
  addSensorChange(store, 'providers', change('invented-hidden-id', 'bedroom_temperature', 'calibration'), now);
  addSensorChange(store, 'providers', change('invented-future', 'garage_temperature', 'other'), now + HOUR);
  const view = sensorChangesView(store, 'providers', { now, config, observedSignals: ['downstairs_temperature'] });
  assert.equal(view.events.length, 1); assert.equal(view.available, true);
  assert.equal(view.settlingMinutes * 60_000, SENSOR_SETTLING_MS);
  assert.equal(view.sensors.find(row => row.signal === 'bedroom_temperature').configured, true);
  assert.equal(view.sensors.find(row => row.signal === 'downstairs_temperature').configured, true);
  assert.equal(view.sensors.find(row => row.signal === 'garage_temperature').configured, false);
  assert.equal(view.sensors.find(row => row.signal === 'indoor_temperature').label, 'Upstairs');
  assert.equal(JSON.stringify(view).includes('invented-'), false);
  const readonly = sensorChangesView(store, 'providers', { now, config, readOnly: true });
  assert.equal(readonly.available, false); assert.equal(readonly.readOnly, true);
  assert.equal(sensorChangesView(store, 'offline', { now }).available, false);
  assert.equal(affectsThermalLearning('bedroom_temperature', config), true);
  assert.equal(affectsThermalLearning('outdoor_temperature', config), true);
  assert.equal(affectsThermalLearning('indoor_temperature', config), false);
  assert.equal(affectsThermalLearning('garage_temperature', config), false);
});

test('a contributing sensor change retains house parameters but clears measurement baseline, state and validation before follow-up', t => {
  const { store, engine, initial } = fixture(t);
  const prefix = structuredClone(store.learningJournal({ input: 'providers' }));
  engine.pendingPlan = { id: 'invented-pending' }; store.setState('pending-plan:providers', engine.pendingPlan);
  engine.lastSample = { timestamp: now - 1 }; engine.fireplaceReserveOverride = { reserveC: 22 };
  engine.ingest({ source: 'mqtt-temperature', device: 'invented-device', signal: 'bedroom_temperature', value: 21,
    unit: 'degC', sourceTime: now - 1, receivedAt: now - 1, quality: [] });
  const observations = structuredClone(store.observations());
  let ticks = 0;
  engine.tick = () => {
    ticks++;
    assert.deepEqual(store.getState('adaptive:providers'), engine.checkpoint, 'Follow-up sees a durably published complete checkpoint');
    assert.equal(engine.checkpoint.baselineC, null);
  };
  engine.changeSensor(change('invented-bedroom-change', 'bedroom_temperature'));
  const checkpoint = engine.checkpoint;
  assert.equal(ticks, 1);
  assert.deepEqual(checkpoint.model.parameters, initial.model.parameters);
  assert.equal(checkpoint.model.validation, null);
  assert.equal(Boolean(checkpoint.model.forecastValidation), false);
  assert.equal(checkpoint.baselineC, null); assert.equal(checkpoint.comfortReference, null); assert.equal(checkpoint.state, null);
  assert.deepEqual(checkpoint.sensorComfortReferences, {});
  assert.deepEqual(checkpoint.samples, []); assert.deepEqual(checkpoint.episodeArchive, []);
  assert.equal(checkpoint.measurementEpochAt, now); assert.equal(checkpoint.sensorEpochs.bedroom_temperature, now);
  assert.equal(engine.pendingPlan, null); assert.equal(store.getState('pending-plan:providers'), null);
  assert.equal(engine.lastSample, null); assert.equal(engine.fireplaceReserveOverride, null);
  assert.deepEqual(store.observations(), observations, 'Source measurements are never rewritten');
  assert.deepEqual(store.learningJournal({ input: 'providers' }).slice(0, prefix.length), prefix);
});

test('garage changes preserve the house model, comfort reference, state and pending plan', t => {
  const { store, engine, initial } = fixture(t);
  engine.pendingPlan = { id: 'invented-pending' }; store.setState('pending-plan:providers', engine.pendingPlan);
  engine.changeSensor(change('invented-garage-change', 'garage_temperature', 'moved'));
  assert.deepEqual(engine.checkpoint.model, initial.model);
  assert.deepEqual(engine.checkpoint.samples, initial.samples);
  assert.deepEqual(engine.checkpoint.state, initial.state);
  assert.equal(engine.checkpoint.baselineC, initial.baselineC);
  assert.deepEqual(engine.checkpoint.comfortReference, initial.comfortReference);
  assert.deepEqual(engine.pendingPlan, { id: 'invented-pending' });
  assert.equal(engine.checkpoint.measurementEpochAt, undefined);
  assert.equal(engine.checkpoint.sensorEpochs.garage_temperature, now);
});

test('failed checkpoint publication rolls back the sensor event and retry publishes it only once', t => {
  const { store, engine, initial } = fixture(t);
  const setState = store.setState.bind(store);
  store.setState = (key, value) => {
    if (key === 'adaptive:providers' && value?.measurementEpochAt === now) throw new Error('invented-write-failure');
    return setState(key, value);
  };
  assert.throws(() => engine.changeSensor(change()), /invented-write-failure/);
  assert.equal(sourceCount(store), 0);
  assert.deepEqual(store.getState('adaptive:providers'), initial);
  assert.deepEqual(engine.checkpoint, initial);
  store.setState = setState;
  engine.changeSensor(change()); engine.changeSensor(change());
  assert.equal(sourceCount(store), 1);
  assert.equal(engine.checkpoint.measurementEpochAt, now);
});

test('sensor changes end an active heating cycle as incomplete without rewriting observations or frozen forecasts', t => {
  const { store, engine } = fixture(t);
  const start = now - HOUR;
  const plan = { model: engine.checkpoint.model, intervals: Array.from({ length: 8 }, (_, i) => ({
    start: start + i * HOUR / 4, end: start + (i + 1) * HOUR / 4, outdoorC: 10, solarRadiationWm2: 0, price: 10,
  })), initialState: { indoorC: 21.5, reserveC: 22 }, targetC: 21.5,
    schedule: { preheatStart: start, preheatEnd: start, reductionStart: start, reductionEnd: now + HOUR, roomBoostC: 0 },
    reference: null, occupancy: { mode: 'occupied' }, maxDropC: 1, equipment: {} };
  const cycle = engine.cycles.start(plan, { timestamp: start, indoorC: 21.5 }, start);
  cycle.observations.push({ start, end: now, indoorC: 21, electricityKwh: 1 });
  cycle.actual.electricityKwh = 1; engine.cycles.save(cycle);
  const before = structuredClone(store.cycles({ input: 'providers' })[0]);
  engine.changeSensor(change());
  const after = store.cycles({ input: 'providers' })[0];
  assert.equal(engine.cycles.active(), null);
  assert.equal(after.status, 'incomplete'); assert.equal(after.endedAt, now);
  assert.equal(after.incompleteReason, 'sensor-measurement-changed');
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.originalPrediction, before.originalPrediction);
  assert.deepEqual(after.observations, before.observations);
  assert.deepEqual(after.actual, before.actual);
  assert.equal(engine.checkpoint.model.energy.episodes, 0);
});
