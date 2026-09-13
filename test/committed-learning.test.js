import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { committedLearningSample, recordLearningContext, appendLearningRecord, replayLearningJournal, validLearningCheckpoint, LEARNING_ALGORITHM, LEARNING_WINDOW_MS } from '../src/app/committed-learning.js';
import { initialAdaptiveModel, updateAdaptiveLearning, updateAdaptiveEpisode } from '../src/control/adaptive-learning.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE;
const start = Date.parse('2026-01-01T00:00:00Z');
const config = { heatPumpCompressorKw: 3, auxRatedKw: 9, circulationKw: 0.08, dhwrKw: 0.025 };
function knownContext(store, at = start, changes = {}, configuration = config) {
  return recordLearningContext(store, 'mqtt', { phase: 'normal', regime: 'occupied', targetC: 21,
    roomBoostC: 0, ...changes }, at, { config: configuration });
}
function record(store, signal, value, at, extra = {}) {
  return store.observation({ source: 'husdata-h66', device: 'invented-gateway', signal, value,
    unit: signal.endsWith('_temperature') ? 'degC' : signal.endsWith('_active') || signal === 'dhw_routing' ? 'state' : '%',
    sourceTime: at, receivedAt: at, quality: [], raw: { usableForControl: true, retained: false }, ...extra });
}
function weather(store, at, value) {
  return store.snapshot({ kind: 'weather', source: 'fmi', issuedAt: at, fetchedAt: at,
    payload: { source: 'fmi', issuedAt: at, fetchedAt: at,
      forecast: [{ start, end: start + 3 * HOUR, outdoorC: 0, solarRadiationWm2: value }] } });
}

test('causal windows use committed H66 heat inputs and frozen forecasts, never raw acquisition or audit values', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const recorder = new Recorder(store, { config: { maxIntervalMs: 5 * MINUTE }, clock: () => start + 15 * MINUTE });
  const forecastId = weather(store, start - HOUR, 120);
  for (let minute = 0; minute <= 15; minute++) {
    for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0],
      ['compressor_active', 1], ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1]]) {
      recorder.record({ source: 'husdata-h66', device: 'invented-gateway', signal, value,
        unit: signal.endsWith('_temperature') ? 'degC' : 'state', sourceTime: start + minute * MINUTE,
        receivedAt: start + minute * MINUTE, quality: [], raw: { usableForControl: true, retained: false } });
    }
  }
  const at = start + 15 * MINUTE;
  const before = committedLearningSample({ store, input: 'mqtt', at, config });
  assert.deepEqual(before.quality, []);
  assert.equal(before.powerKw, 3.08);
  assert.equal(before.thermalCompressorDuty, 1);
  assert.equal(before.provenance.forecastVersion.id, forecastId);
  assert.equal(before.solarRadiationWm2, 120);
  // Late arrivals cannot rewrite what was known at the window boundary.
  record(store, 'indoor_temperature', 30, at, { receivedAt: at + MINUTE });
  record(store, 'compressor_active', 0, at, { receivedAt: at + MINUTE });
  weather(store, at + MINUTE, 900);
  assert.deepEqual(committedLearningSample({ store, input: 'mqtt', at, config }), before);
  record(store, 'heat_pump_power', 99, at, { source: 'controller-estimate', unit: 'kW' });
  record(store, 'heat_pump_meter_power', 99, at, { source: 'easee', unit: 'kW', raw: { auditOnly: true } });
  assert.equal(committedLearningSample({ store, input: 'mqtt', at, config }).powerKw, 3.08);
});

test('fast unsaved polls stay live while the house learner receives only recorded values', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const now = start + LEARNING_WINDOW_MS;
  const engine = new Engine({ store, config: { input: 'mqtt', control: config,
    settings: { mode: 'shadow' } }, clock: () => now });
  for (const at of [start, now]) {
    record(store, 'indoor_temperature', 21, at);
    record(store, 'outdoor_temperature', 0, at);
  }
  const baseRows = store.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
  engine.ingest({ source: 'mqtt-temperature', device: 'invented-room', signal: 'indoor_temperature', value: 28,
    unit: 'degC', sourceTime: now, receivedAt: now, quality: [], raw: { acquisitionOnly: true } });
  engine.ingest({ source: 'easee', device: 'invented-meter', signal: 'property_energy_total', value: 123456,
    unit: 'kWh', sourceTime: now, receivedAt: now, quality: [], raw: { auditOnly: true } });
  assert.equal(engine.latest.indoor_temperature.value, 28);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, baseRows);
  const status = engine.tick();
  assert.equal(status.observations.indoor.value, 28);
  const entry = store.learningJournal({ input: 'mqtt' }).find(entry => entry.kind === 'sample');
  assert.equal(entry.payload.value.indoorC, 21);
  assert.equal(entry.payload.value.powerKw, null, 'No H66 compressor/output readings means no invented heat input');
  assert.equal(entry.payload.value.electricalContext.property.phases[0].kwh, null);
});

test('phase energy remains separate context and cannot turn property consumption into heat-pump power', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const at = start + LEARNING_WINDOW_MS;
  for (const point of [start, at]) for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0]]) record(store, signal, value, point);
  for (const prefix of ['property', 'ev1']) for (const phase of [1, 2, 3]) record(store, `${prefix}_energy_l${phase}`, prefix === 'property' ? 2 : 0.5, at,
    { source: 'easee', unit: 'kWh', raw: { intervalStart: start, intervalEnd: at } });
  const result = committedLearningSample({ store, input: 'mqtt', at, config });
  assert.equal(result.electricalContext.property.complete, true);
  assert.equal(result.electricalContext.property.phases.reduce((sum, phase) => sum + phase.kwh, 0), 6);
  assert.equal(result.powerKw, null);
  assert.equal(result.compressorDuty, null);
});

test('held indoor input outlives freshness while retaining its actual source timestamp', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const recorder = new Recorder(store, { clock: () => start });
  for (const minute of [0, 25]) recorder.record({ source: 'mqtt-temperature', device: 'invented-room',
    signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start,
    receivedAt: start + minute * MINUTE, quality: [], raw: { cached: minute > 0 } });
  assert.equal(committedLearningSample({ store, input: 'mqtt', at: start + 30 * MINUTE, config }).indoorC, 21);
  const held = committedLearningSample({ store, input: 'mqtt', at: start + 3 * HOUR, config });
  assert.equal(held.indoorC, 21);
  assert.equal(held.indoorSensors.indoor_temperature.observedAt, start);
  assert.deepEqual(held.indoorSensors.indoor_temperature.attentionReasons, ['old-reading']);
  assert.equal(held.indoorSensors.indoor_temperature.held, true);
  assert.equal(held.outdoorC, null, 'Outdoor observations retain their own freshness requirement');
});

test('recorded outdoor windows preserve source priority and fall back only after the source expires', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  for (const minute of [0, 5, 10, 15]) record(store, 'outdoor_temperature', 0, start + minute * MINUTE);
  for (const minute of [2, 7, 12]) record(store, 'outdoor_temperature', 10, start + minute * MINUTE,
    { source: 'fmi', raw: null });
  assert.equal(committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config }).outdoorC, 0);
  assert.ok(Math.abs(committedLearningSample({ store, input: 'mqtt', at: start + 30 * MINUTE, config }).outdoorC - 20 / 3) < 1e-10);
});

test('forecast provenance rejects stale issuance and solar fetched after the causal boundary', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const sample = () => committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  for (const [issuedAt, fetchedAt] of [[start - 7 * HOUR, start - HOUR], [start - HOUR, start + MINUTE]]) {
    store.snapshot({ kind: 'weather', source: 'fmi', issuedAt: start - HOUR, fetchedAt: start,
      payload: { forecast: [{ start, end: start + HOUR, solarRadiationWm2: 500,
        solar: { source: 'openmeteo', issuedAt, fetchedAt } }] } });
    assert.equal(sample().solarRadiationWm2, null);
  }
});

test('re-fetching unchanged weather with unknown model issuance cannot renew its solar age', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  for (const fetchedAt of [start - 7 * HOUR, start - MINUTE]) store.snapshot({ kind: 'weather', source: 'openmeteo',
    issuedAt: null, fetchedAt, payload: { source: 'openmeteo', issuedAt: null, fetchedAt,
      forecast: [{ start, end: start + HOUR, solarRadiationWm2: 500,
        solar: { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt } }] } });
  const result = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  assert.equal(result.solarRadiationWm2, null);
});

test('known phase energy crossing a window start contributes its interval overlap only', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  for (const phase of [1, 2, 3]) for (const [from, to, value] of [[-5, 5, 1], [5, 15, 1], [15, 18, 100]])
    record(store, `property_energy_l${phase}`, value, start + to * MINUTE,
      { source: 'easee', unit: 'kWh', raw: { intervalStart: start + from * MINUTE, intervalEnd: start + to * MINUTE } });
  const result = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  assert.equal(result.electricalContext.property.complete, true);
  assert.deepEqual(result.electricalContext.property.phases.map(phase => phase.kwh), [1.5, 1.5, 1.5]);
  assert.equal(result.powerKw, null);
});

test('a crash between journal commit and checkpoint preserves sample/episode ordering and deterministic rebuild', t => {
  const dir = mkdtempSync(join(tmpdir(), 'stmq-learning-journal-'));
  const path = join(dir, 'synthetic.sqlite');
  let store = new Store(path), checkpoint = null;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 768; i++) {
    const at = start + i * LEARNING_WINDOW_MS;
    const value = { timestamp: at, windowStart: at - LEARNING_WINDOW_MS, windowEnd: at,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0,
      targetC: 21, regime: 'occupied', quality: [], energyBasis: 'estimated', actualModeKnown: false,
      provenance: { basis: 'committed-history', forecastVersion: { id: Math.floor(i / 96) + 1 } } };
    const configuration = i < 384 ? config : { ...config, heatPumpCompressorKw: 3.1 };
    appendLearningRecord(store, 'mqtt', 'sample', value, { config: configuration, seed: checkpoint });
    if (i === 384) {
      const episode = { id: 'invented-complete-cycle', startedAt: at - 8 * HOUR, endedAt: at,
        complete: true, recoveryComplete: true, phases: ['preheat', 'reduction', 'recovery'],
        energyBasis: 'estimated', recoveryHours: 4, recoveryEnergyKwh: 8, recoveryAuxKwh: 1,
        predictedRecoveryEnergyKwh: 6, predictedRecoveryAuxKwh: 1, compressorActivityObserved: true,
        auxiliaryObserved: true, auxiliaryRouteKnown: true, spaceHeatingAuxKwh: 1, dhwAuxKwh: 0,
        predictedSpaceHeatingAuxKwh: 0.5 };
      appendLearningRecord(store, 'mqtt', 'episode', episode, { config: configuration, seed: checkpoint });
      // The durable checkpoint still precedes BOTH journal entries.
      const beforeCrash = store.getState('adaptive:mqtt').journalCursor;
      store.close(); store = new Store(path);
      assert.equal(store.getState('adaptive:mqtt').journalCursor, beforeCrash);
      checkpoint = replayLearningJournal(store, 'mqtt', store.getState('adaptive:mqtt'));
      assert.equal(checkpoint.model.energy.episodes, 0,
        'The durable episode straddles a power-configuration change and must not calibrate the new epoch');
    } else checkpoint = replayLearningJournal(store, 'mqtt', checkpoint);
  }
  assert.notEqual(checkpoint.model.validation?.accepted, true,
    'Flat temperatures without observed heat input cannot validate thermal coefficients');
  const rebuilt = replayLearningJournal(store, 'mqtt', null, { rebuild: true });
  assert.deepEqual(rebuilt, checkpoint);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', rebuilt), rebuilt);
  const entries = store.learningJournal({ input: 'mqtt', limit: 1000 });
  assert.equal(entries.filter(entry => entry.kind === 'episode').length, 1);
  assert.equal(new Set(entries.map(entry => entry.configVersion)).size, 2);
});

test('rare-phase coefficients need distinct completed episodes, and older completed evidence survives the recent sample tail', () => {
  let checkpoint = null;
  for (let i = 0; i < 144; i++) checkpoint = updateAdaptiveLearning(checkpoint, { timestamp: start + i * HOUR,
    indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', roomBoostC: 0,
    regime: 'occupied', quality: [], episodeId: i > 132 ? 'old-complete-cycle' : null }, { now: start + i * HOUR, config });
  const prior = initialAdaptiveModel(config);
  for (const name of ['reducedHeatCPerHour', 'preheatCPerHourPerDegree', 'memoryExchangePerHour', 'reserveTimeHours', 'auxiliaryCPerKwh']) {
    assert.equal(checkpoint.model.parameters[name], prior.parameters[name]);
    assert.equal(checkpoint.model.validation?.fittedParameters?.includes(name) ?? false, false);
  }
  checkpoint = updateAdaptiveEpisode(checkpoint, { id: 'old-complete-cycle', startedAt: start + 133 * HOUR,
    endedAt: start + 143 * HOUR, complete: true, recoveryComplete: true, phases: ['recovery'],
    energyBasis: 'estimated', recoveryHours: 4, recoveryEnergyKwh: 3 }, { config });
  const archived = structuredClone(checkpoint.episodeArchive);
  checkpoint.samples = [];
  checkpoint = updateAdaptiveLearning(checkpoint, { timestamp: start + 60 * 24 * HOUR, indoorC: 21, outdoorC: 0,
    phase: 'normal', regime: 'occupied', quality: [] }, { now: start + 60 * 24 * HOUR, config });
  assert.deepEqual(checkpoint.episodeArchive, archived);
  assert.ok(checkpoint.episodeArchive[0].samples.length > 0);
});

function equipmentWindow(store, { minutes = 15, routing = () => 0, auxiliary = () => 0, recorder = null } = {}) {
  for (let minute = 0; minute <= minutes; minute++) {
    for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0],
      ['compressor_active', 1], ['dhw_routing', routing(minute)], ['auxiliary_output', auxiliary(minute)],
      ['alarm_active', 0], ['operating_mode', 1]]) {
      const at = start + minute * MINUTE;
      if (recorder) recorder.record({ source: 'husdata-h66', device: 'invented-gateway', signal, value,
        unit: signal.endsWith('_temperature') ? 'degC' : 'state', sourceTime: at, receivedAt: at,
        quality: [], raw: { usableForControl: true, retained: false } });
      else record(store, signal, value, at);
    }
  }
}

test('recorded context splits a transition window instead of labelling it with the latest phase', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  equipmentWindow(store);
  knownContext(store, start + 10 * MINUTE, { phase: 'reduction', regime: 'away' });
  const sample = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config,
    context: { phase: 'preheat', roomBoostC: 5, regime: 'occupied' } });
  assert.deepEqual(sample.quality, []);
  assert.equal(sample.phase, 'mixed');
  assert.equal(sample.regime, 'mixed');
  assert.deepEqual(sample.inputSegments.map(row => [row.phase, row.regime, row.durationHours]),
    [['normal', 'occupied', 1 / 6], ['reduction', 'away', 1 / 12]]);
  assert.ok(Math.abs(sample.energyKwh - 3.08 / 4) < 1e-12);
});

test('current context never fills an unrecorded past, including a change exactly at window end', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  equipmentWindow(store);
  knownContext(store, start + 15 * MINUTE);
  const sample = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config,
    context: { phase: 'normal', targetC: 21, regime: 'occupied' } });
  assert.deepEqual(sample.quality, ['unavailable-controller-context']);
  assert.equal(sample.phase, null);
  assert.equal(sample.powerKw, null, 'Unknown historical configuration cannot be replaced with current nominal powers');
  assert.equal(sample.indoorC, 21);
});

test('joint routing and activity preserve space/DHW heat and energy across changes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  equipmentWindow(store, { routing: minute => minute < 10 ? 0 : 1, auxiliary: () => 100 / 3 });
  const sample = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  assert.equal(sample.compressorDuty, 1);
  assert.ok(Math.abs(sample.thermalCompressorDuty - 2 / 3) < 1e-12);
  assert.equal(sample.thermalAuxKw, 2);
  assert.equal(sample.auxRoute, 'mixed');
  assert.equal(sample.auxiliaryRouteKnown, true);
  assert.equal(sample.heating.compressorDuty, sample.thermalCompressorDuty);
  assert.deepEqual(sample.inputSegments.map(row => row.auxRoute), ['space', 'dhw']);
  assert.equal(sample.inputSegments.reduce((sum, row) => sum + row.spaceHeatingAuxKwh, 0), 0.5);
  assert.equal(sample.inputSegments.reduce((sum, row) => sum + row.dhwAuxKwh, 0), 0.25);
  assert.ok(Math.abs(sample.energyKwh - 6.08 / 4) < 1e-12);
});

test('later unchanged polls cannot alter earlier resolved inputs with long recording intervals', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const recorder = new Recorder(store, { config: { maxIntervalMs: 60 * MINUTE } });
  equipmentWindow(store, { recorder });
  const before = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  assert.deepEqual(before.quality, []);
  assert.equal(before.compressorDuty, 1);
  for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0],
    ['compressor_active', 1], ['dhw_routing', 0], ['auxiliary_output', 0], ['alarm_active', 0], ['operating_mode', 1]]) {
    recorder.record({ source: 'husdata-h66', device: 'invented-gateway', signal, value,
      unit: signal.endsWith('_temperature') ? 'degC' : 'state', sourceTime: start + 16 * MINUTE,
      receivedAt: start + 16 * MINUTE, quality: [], raw: { usableForControl: true, retained: false } });
  }
  assert.deepEqual(committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config }), before);
});

test('a delayed receipt cannot rejuvenate the source timestamp of an earlier held indoor input', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const recorder = new Recorder(store, { config: { maxIntervalMs: 60 * MINUTE } });
  const put = (sourceMinute, receiptMinute) => recorder.record({ source: 'husdata-h66', device: 'invented-gateway',
    signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: start + sourceMinute * MINUTE,
    receivedAt: start + receiptMinute * MINUTE, quality: [], raw: { usableForControl: true, retained: false } });
  put(0, 0);
  const before = committedLearningSample({ store, input: 'mqtt', at: start + 7 * MINUTE, windowMs: 7 * MINUTE, config });
  assert.equal(before.indoorC, 21);
  assert.equal(before.indoorSensors.indoor_temperature.observedAt, start);
  put(5, 10);
  assert.deepEqual(committedLearningSample({ store, input: 'mqtt', at: start + 7 * MINUTE, windowMs: 7 * MINUTE, config }), before);
});

test('coverage prefixes remain stable through failure, repeated failure and recovery', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  const recorder = new Recorder(store, { config: { maxIntervalMs: 60 * MINUTE } });
  const signals = [['indoor_temperature', 21], ['outdoor_temperature', 0],
    ['compressor_active', 1], ['dhw_routing', 0], ['auxiliary_output', 0]];
  const prefixes = [];
  for (let minute = 0; minute <= 20; minute++) {
    for (const [signal, value] of signals) {
      const failed = minute >= 6 && minute <= 11;
      recorder.record({ source: 'husdata-h66', device: 'invented-gateway', signal,
        value: failed ? null : value, unit: signal.endsWith('_temperature') ? 'degC' : 'state',
        sourceTime: failed ? null : start + minute * MINUTE, receivedAt: start + minute * MINUTE,
        quality: failed ? ['acquisition-failed'] : [], raw: { usableForControl: !failed, retained: false } });
    }
    if (minute >= 1 && minute <= 15) prefixes.push({ at: start + minute * MINUTE, windowMs: minute * MINUTE,
      sample: committedLearningSample({ store, input: 'mqtt', at: start + minute * MINUTE, windowMs: minute * MINUTE, config }) });
  }
  for (const prefix of prefixes) assert.deepEqual(committedLearningSample({ store, input: 'mqtt',
    at: prefix.at, windowMs: prefix.windowMs, config }), prefix.sample);
  const failed = prefixes.find(row => row.at === start + 10 * MINUTE).sample;
  assert.equal(failed.indoorC, 21);
  assert.equal(failed.indoorSensors.indoor_temperature.observedAt, start);
  assert.deepEqual(failed.indoorSensors.indoor_temperature.attentionReasons, ['invalid-reading']);
  assert.equal(prefixes.at(-1).sample.indoorC, 21);
  assert.ok(prefixes.at(-1).sample.quality.includes('missing'), 'An earlier outage remains a barrier after recovery');
});

test('configuration epochs update nominal prediction power and replay identically', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  let checkpoint = replayLearningJournal(store, 'mqtt');
  assert.equal(checkpoint.model.energy.compressorKw, 3);
  knownContext(store, start + 10 * MINUTE, {}, { ...config, heatPumpCompressorKw: 6 });
  checkpoint = replayLearningJournal(store, 'mqtt', checkpoint);
  assert.equal(checkpoint.model.energy.compressorKw, 6);
  equipmentWindow(store);
  const sample = committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE, config });
  assert.deepEqual(sample.inputSegments.map(row => row.compressorPowerKw), [3, 6]);
  assert.ok(Math.abs(sample.energyKwh - (3.08 / 6 + 6.08 / 12)) < 1e-12);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true }), checkpoint);
});

test('new algorithm starts its own journal while older entries remain explicitly archived', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.appendLearningJournal('mqtt', { kind: 'sample', at: start, key: `sample:${start}`,
    algorithmVersion: 'committed-house-v2', payload: { value: { timestamp: start } } });
  assert.equal(replayLearningJournal(store, 'mqtt').model.energy.compressorKw, 3);
  knownContext(store);
  assert.equal(store.learningJournal({ input: 'mqtt' }).length, 2);
  assert.equal(store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM }).length, 1);
  assert.equal(replayLearningJournal(store, 'mqtt').algorithmVersion, LEARNING_ALGORITHM);
});

test('reversible sensor learning establishes a v9 seed without reinterpreting the v8 archive', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.appendLearningJournal('mqtt', { kind: 'context', at: start - HOUR,
    algorithmVersion: 'committed-house-v8-report-coverage', key: 'invented-v8-archive',
    payload: { value: { timestamp: start - HOUR }, configuration: {}, seed: null } });
  const archived = store.db.prepare("SELECT * FROM learning_journal WHERE algorithm_version='committed-house-v8-report-coverage'").get();
  const model = initialAdaptiveModel(); model.parameters.fireplaceCPerKg = 0.23;
  appendLearningRecord(store, 'mqtt', 'context', { timestamp: start }, { config, seed: { version: 1, samples: [], model } });
  const entry = store.learningJournal({ input: 'mqtt', algorithmVersion: LEARNING_ALGORITHM })[0];
  assert.equal(LEARNING_ALGORITHM, 'committed-house-v9-reversible-sensors');
  assert.equal(entry.payload.seed.model.parameters.fireplaceCPerKg, 0.23);
  const checkpoint = replayLearningJournal(store, 'mqtt');
  assert.equal(checkpoint.model.parameters.fireplaceCPerKg, 0.23);
  assert.deepEqual(replayLearningJournal(store, 'mqtt', null, { rebuild: true }), checkpoint);
  assert.deepEqual(store.db.prepare('SELECT * FROM learning_journal WHERE id=?').get(archived.id), archived);
});

test('checkpoint digest rejects plausible model/state corruption and rebuilds from immutable entries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  knownContext(store);
  equipmentWindow(store);
  appendLearningRecord(store, 'mqtt', 'sample', committedLearningSample({ store, input: 'mqtt', at: start + 15 * MINUTE }), { config });
  const original = replayLearningJournal(store, 'mqtt');
  assert.equal(validLearningCheckpoint(original), true);
  for (const corrupt of [checkpoint => { checkpoint.model.parameters.lossPerHour *= 2; },
    checkpoint => { checkpoint.state.reserveC += 1; }, checkpoint => { checkpoint.journalHash = 'invented-wrong-prefix'; },
    checkpoint => { checkpoint.learningConfiguration.heatPumpCompressorKw = 6; }]) {
    const changed = structuredClone(original); corrupt(changed);
    assert.equal(validLearningCheckpoint(changed), false);
    assert.deepEqual(replayLearningJournal(store, 'mqtt', changed), original);
  }
  const engine = new Engine({ store, config: { input: 'mqtt', control: config, settings: { mode: 'shadow' } },
    clock: () => start + 15 * MINUTE });
  const changed = structuredClone(original); changed.model.parameters.lossPerHour *= 2;
  store.setState('adaptive:mqtt', changed);
  assert.deepEqual(engine.readAdaptive(start + 15 * MINUTE), original);
});

test('lightweight cycle summaries retain missing values and omit full observation payloads', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.cycle('mqtt', { id: 'invented-completed-cycle', status: 'completed', startedAt: start, endedAt: start + HOUR,
    assessment: { profitCents: -20, actualCostCents: 40, uncertaintyCents: 10, recoveryErrorCents: 5 },
    actual: { costCents: 40, missingHours: 0, auxiliarySpaceObserved: true }, observations: [{ unusedForSummary: 'synthetic' }] });
  store.cycle('mqtt', { id: 'invented-incomplete-cycle', status: 'incomplete', startedAt: start + 2 * HOUR,
    endedAt: start + 3 * HOUR, incompleteReason: 'synthetic-gap', actual: { costCents: 50, missingHours: 0.5 } });
  const rows = store.cycleSummaries({ input: 'mqtt' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profitCents, null);
  assert.equal(rows[0].incompleteReason, 'synthetic-gap');
  assert.equal(rows[0].actualCostCents, 50);
  assert.equal(rows[1].profitCents, -20);
  assert.equal(rows[1].auxiliarySpaceObserved, true);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'observations') && !Object.hasOwn(row, 'payload')));
  assert.equal(store.cycleSummaries({ input: 'mqtt', completedOnly: true }).length, 1);
});
