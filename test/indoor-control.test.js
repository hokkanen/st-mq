import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indoorControl, INDOOR_ESTIMATE_MAX_AGE_MS } from '../src/domain/indoor-control.js';
import { indoorControlState } from '../src/app/indoor-control-state.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { Store } from '../src/storage/store.js';

const HOUR = 3_600_000, MINUTE = 60_000, now = Date.parse('2026-10-07T00:00:00Z');
const config = { indoorSensorWeights: { bedroom_temperature: 2, downstairs_temperature: 1, indoor_temperature: 1 } };
const identity = 'synthetic-three-sensors';
const reading = (value, at = now, extra = {}) => ({ value, observedAt: at, source: 'mqtt-temperature',
  quality: [], stale: false, periodicReports: true, reportMaxAgeMs: 75 * MINUTE, ...extra });
const readings = (at = now) => ({ bedroom_temperature: reading(19, at), downstairs_temperature: reading(21, at),
  indoor_temperature: reading(22, at) });
function fixture() {
  const original = readings();
  const anchor = indoorControl(original, config, now, null, identity).anchor;
  return { original, anchor };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);

test('missing bedroom follows the two surviving rooms while the original 50/25/25 weights remain fixed', () => {
  const { original, anchor } = fixture(), at = now + HOUR, current = structuredClone(original);
  current.bedroom_temperature.stale = true;
  current.downstairs_temperature = reading(21.4, at);
  current.indoor_temperature = reading(22.4, at);
  const before = structuredClone({ current, anchor });
  const result = indoorControl(current, config, at, anchor, identity);
  assert.equal(result.observation.estimated, true);
  assert.equal(result.observation.estimatedSensor, 'bedroom_temperature');
  near(result.observation.estimatedValueC, 19.4);
  near(result.observation.value, 20.65);
  assert.deepEqual(result.observation.weights, { indoor_temperature: .25, downstairs_temperature: .25, bedroom_temperature: .5 });
  near(result.observation.uncertaintyC, .16);
  assert.equal(result.observation.estimatedSourceObservedAt, now);
  assert.equal(result.observation.observedAt, at);
  assert.deepEqual({ current, anchor }, before);
});

test('losing a 25% room carries less source uncertainty than losing bedroom', () => {
  const { anchor } = fixture(), at = now + HOUR;
  const current = readings(at);
  current.indoor_temperature = reading(22, now, { stale: true });
  current.bedroom_temperature.value = 19.4;
  current.downstairs_temperature.value = 21.4;
  const result = indoorControl(current, config, at, anchor, identity).observation;
  near(result.estimatedValueC, 22.4);
  near(result.value, 20.65);
  near(result.uncertaintyC, .08);
  assert.equal(result.uncertaintyGrowthCPerHour, .005);
});

test('survivor disagreement increases uncertainty without assigning equal weights to their movement', () => {
  const { anchor } = fixture(), at = now + HOUR;
  const current = readings(at);
  current.indoor_temperature = reading(22, now, { stale: true });
  current.bedroom_temperature.value = 20;
  current.downstairs_temperature.value = 21;
  const observation = indoorControl(current, config, at, anchor, identity).observation;
  near(observation.estimatedValueC, 22 + 2 / 3);
  near(observation.uncertaintyC, .33);
});

test('estimate uncertainty ages, expires at the bounded horizon and needs an actual common anchor', () => {
  const { anchor } = fixture();
  const atAge = hours => {
    const at = now + hours * HOUR, current = readings(at);
    current.bedroom_temperature = reading(19, now, { stale: true });
    return indoorControl(current, config, at, anchor, identity).observation;
  };
  assert.ok(atAge(24).uncertaintyC > atAge(1).uncertaintyC);
  assert.equal(atAge(72).estimated, true);
  assert.equal(atAge(72).validUntil, now + INDOOR_ESTIMATE_MAX_AGE_MS);
  assert.equal(atAge(72 + 1 / HOUR).stale, true);
  assert.equal(atAge(72 + 1 / HOUR).estimateReason, 'estimate-anchor-expired');
  const current = readings(now + HOUR); current.bedroom_temperature.stale = true;
  const absent = indoorControl(current, config, now + HOUR, null, identity).observation;
  assert.equal(absent.stale, true); assert.equal(absent.estimateReason, 'no-common-observed-anchor');
});

test('two missing rooms or an estimated survivor never support another estimate', () => {
  const { anchor } = fixture(), current = readings(now + HOUR);
  current.bedroom_temperature.stale = true;
  current.indoor_temperature.stale = true;
  assert.equal(indoorControl(current, config, now + HOUR, anchor, identity).observation.estimated, false);
  current.indoor_temperature.stale = false;
  current.indoor_temperature.estimated = true;
  assert.equal(indoorControl(current, config, now + HOUR, anchor, identity).observation.estimated, false);
  const oneRoom = { indoorSensorWeights: { indoor_temperature: 1 } };
  current.indoor_temperature.stale = true;
  assert.equal(indoorControl(current, oneRoom, now + HOUR, anchor, identity).observation.estimated, false);
});

test('equipment, source and weight changes invalidate the old anchor', () => {
  const { anchor } = fixture(), current = readings(now + HOUR);
  current.bedroom_temperature.stale = true;
  for (const changed of [
    indoorControl(current, config, now + HOUR, anchor, 'replacement-device'),
    indoorControl(current, { indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1 } }, now + HOUR, anchor, identity),
    indoorControl({ ...current, downstairs_temperature: { ...current.downstairs_temperature, source: 'replacement-source' } }, config, now + HOUR, anchor, identity),
    indoorControl(current, config, now + HOUR, { ...anchor, version: 0 }, identity),
  ]) {
    assert.equal(changed.anchor, null);
    assert.equal(changed.observation.stale, true);
  }
});

test('measurement boundaries reject fallback even when the old readings are numerically plausible', () => {
  const { anchor } = fixture();
  for (const reason of ['sensor-settling', 'before-sensor-change']) {
    const current = readings(now + HOUR);
    current.bedroom_temperature = reading(19, now, { stale: true, availabilityReasons: [reason] });
    const result = indoorControl(current, config, now + HOUR, anchor, identity);
    assert.equal(result.observation.estimated, false);
    assert.equal(result.observation.stale, true);
    assert.equal(result.observation.estimateReason, 'sensor-measurement-changed');
  }
});

test('a returned real sensor replaces the estimate immediately and establishes a new observed anchor', () => {
  const { anchor } = fixture(), current = readings(now + HOUR);
  current.bedroom_temperature.value = 17;
  const result = indoorControl(current, config, now + HOUR, anchor, identity);
  assert.equal(result.observation.estimated, false);
  assert.equal(result.observation.value, 19.25);
  assert.equal(result.observation.uncertaintyC, 0);
  assert.equal(result.anchor.members.bedroom_temperature.value, 17);
  assert.equal(result.anchor.at, now + HOUR);
  assert.equal(anchor.members.bedroom_temperature.value, 19, 'The original anchor is not rewritten');
});

test('genuine unchanged reports refresh support while old reports and cache reads cannot', () => {
  const { anchor } = fixture(), at = now + 5 * HOUR;
  const current = readings();
  current.bedroom_temperature.stale = true;
  for (const signal of ['downstairs_temperature', 'indoor_temperature']) {
    current[signal].lastReportAt = at;
    current[signal].receivedAt = at;
  }
  const confirmed = indoorControl(current, config, at, anchor, identity).observation;
  assert.equal(confirmed.estimated, true);
  assert.equal(confirmed.observedAt, at);
  assert.equal(confirmed.estimatedSourceObservedAt, now);
  const cached = indoorControl(current, config, at + 76 * MINUTE, anchor, identity).observation;
  assert.equal(cached.estimated, false);
  assert.equal(cached.stale, true);
  for (const signal of ['downstairs_temperature', 'indoor_temperature']) {
    delete current[signal].lastReportAt;
    current[signal].receivedAt = at + 76 * MINUTE;
  }
  assert.equal(indoorControl(current, config, at + 76 * MINUTE, anchor, identity).observation.estimated, false);
});

test('an anchor preserves genuine report clocks and rejects malformed observed source clocks', () => {
  const at = now + 5 * HOUR, current = readings();
  for (const item of Object.values(current)) item.lastReportAt = at;
  const anchor = indoorControl(current, config, at, null, identity).anchor;
  assert.equal(anchor.at, at);
  assert.equal(anchor.members.bedroom_temperature.observedAt, now);
  assert.equal(anchor.members.bedroom_temperature.supportAt, at);
  delete current.bedroom_temperature.observedAt;
  assert.equal(indoorControl(current, config, at, null, identity).anchor, null);
});

function stateFixture() {
  const checkpoint = { model: initialAdaptiveModel(), state: { indoorC: 21, reserveC: 22,
    slabC: null, observedAt: new Date(now).toISOString() } };
  const observation = { value: 21, stale: false, estimated: false };
  const previous = indoorControlState({ checkpoint, observation, sample: {}, identity, now });
  const segment = { start: now, end: now + 15 * MINUTE, outdoorC: 0, solarRadiationWm2: 0,
    thermalCompressorDuty: 0, thermalAuxKw: 0, floorOverrideMode: 'off', phase: 'normal', targetC: 21 };
  return { checkpoint, previous, segment, observation: { ...observation, value: 20.9, estimated: true }, identity,
    now: now + 15 * MINUTE };
}

test('runtime thermal prediction uses covered actual inputs without changing learned state or checkpoint', () => {
  const args = stateFixture(), before = structuredClone(args);
  const result = indoorControlState({ ...args, sample: { inputSegments: [args.segment] } });
  assert.equal(result.estimated, true);
  assert.equal(result.state.indoorC, 20.9);
  assert.ok(result.state.reserveC < args.previous.state.reserveC, 'No heat plus colder air lowers the estimated reserve');
  assert.equal(result.measuredStateAt, now);
  assert.deepEqual(args, before);
  const noObservedPower = { ...args.segment, thermalCompressorDuty: null, thermalAuxKw: null, compressorDuty: 1, auxKw: 9 };
  assert.equal(indoorControlState({ ...args, sample: { inputSegments: [noObservedPower] } }), null);
});

test('runtime prediction rejects gaps, malformed or unphysical segments and uncertain floor state', () => {
  const args = stateFixture();
  for (const patch of [{ start: now + MINUTE }, { start: NaN }, { end: now }, { outdoorC: null },
    { thermalCompressorDuty: 1.1 }, { thermalCompressorDuty: -1 }, { thermalAuxKw: -1 },
    { floorOverrideMode: 'partial' }, { floorOverrideMode: 'unknown' }]) {
    assert.equal(indoorControlState({ ...args, sample: { inputSegments: [{ ...args.segment, ...patch }] } }), null);
  }
  assert.equal(indoorControlState({ ...args, sample: { inputSegments: [] } }), null);
  assert.equal(indoorControlState({ ...args, now: args.now + MINUTE, sample: { inputSegments: [args.segment] } }), null);
});

test('runtime prediction is fenced by current model, equipment identity and a bounded restart gap', () => {
  const args = stateFixture(), sample = { inputSegments: [args.segment] };
  assert.equal(indoorControlState({ ...args, previous: null, sample }), null);
  assert.equal(indoorControlState({ ...args, identity: 'replacement', sample }), null);
  const checkpoint = structuredClone(args.checkpoint); checkpoint.model.parameters.lossPerHour *= 1.01;
  assert.equal(indoorControlState({ ...args, checkpoint, sample }), null);
  assert.equal(indoorControlState({ ...args, now: now + 31 * MINUTE, sample }), null);
  const restored = indoorControlState({ ...args, observation: { value: 20, stale: false, estimated: false }, sample });
  assert.equal(restored.estimated, false);
  assert.equal(restored.state.indoorC, 20);
  assert.equal(restored.state.reserveC, args.checkpoint.state.reserveC);
});

test('anchor and runtime estimate survive an ordinary storage restart without becoming learned observations', t => {
  const directory = mkdtempSync(join(tmpdir(), 'st-mq-indoor-control-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'), { anchor } = fixture(), args = stateFixture();
  let store = new Store(path);
  store.setState('indoor-control-anchor:providers', anchor);
  store.setState('indoor-control-state:providers', args.previous);
  store.close();
  store = new Store(path); t.after(() => store.close());
  const current = readings(args.now); current.bedroom_temperature.stale = true;
  const control = indoorControl(current, config, args.now, store.getState('indoor-control-anchor:providers'), identity);
  assert.equal(control.observation.estimated, true);
  const runtime = indoorControlState({ ...args, previous: store.getState('indoor-control-state:providers'),
    sample: { inputSegments: [args.segment] } });
  assert.equal(runtime.estimated, true);
  assert.equal(store.latestObservation('indoor_temperature'), null);
  assert.equal(store.learningJournal({ input: 'providers' }).length, 0);
});
