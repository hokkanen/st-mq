import test from 'node:test';
import assert from 'node:assert/strict';
import { controlObservations, applyNativeControlTrends } from '../src/app/control-observations.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { timingEvidenceSource } from '../src/app/timing-evidence.js';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';

const now = Date.parse('2026-01-15T12:00:00Z'), MINUTE = 60_000;
const config = { auxRatedKw: 9, circulationKw: 0.05, dhwrKw: 0.05 };
const reading = (value, extra = {}) => ({ value, source: 'husdata-h66', sourceTime: now - MINUTE,
  receivedAt: now, raw: { usableForControl: true }, ...extra });
function sample(extra = {}) {
  return controlObservations({ now, latest: {}, config, phase: 'normal', h66: { connected: true },
    observations: { indoor: { value: 21 }, outdoor: { value: 0 } }, outlook: { forecast: [], prices: [] },
    checkpoint: { model: initialAdaptiveModel(config), baselineC: 21 }, ...extra }).sample;
}

test('heat-pump evidence records meter precedence, observed operation, model fallback and auxiliary assumptions', () => {
  const observed = sample({ latest: { compressor_active: reading(1), auxiliary_output: reading(33) } });
  assert.equal(observed.powerBasis, 'observed');
  assert.equal(observed.powerKw, 9.4 / 4.24 + 3);
  assert.equal(observed.powerSourceTime, now - MINUTE);
  assert.equal(observed.powerReceivedAt, now);
  assert.equal(observed.auxiliaryAssumed, false);
  const assumedAux = sample({ latest: { compressor_active: reading(1) } });
  assert.equal(assumedAux.powerBasis, 'observed');
  assert.equal(assumedAux.auxiliaryAssumed, true);
  assert(Math.abs(assumedAux.powerKw - (9.4 / 4.24 + .135)) < 1e-12);
  const invalidAux = sample({ latest: { compressor_active: reading(1), auxiliary_output: reading(150) } });
  assert.equal(invalidAux.auxiliaryObserved, true);
  assert.equal(invalidAux.auxiliaryAssumed, true, 'An unusable observed output still invokes the power fallback');
  assert.equal(invalidAux.powerKw, assumedAux.powerKw);
  const measured = sample({ latest: { heat_pump_meter_power: reading(4.5), compressor_active: reading(1) } });
  assert.equal(measured.powerBasis, 'measured');
  assert.equal(measured.powerKw, 4.5);
  assert.equal(measured.auxiliaryAssumed, false, 'A meter replaces component consumption assumptions');
  const modelled = sample();
  assert.equal(modelled.powerBasis, 'modelled');
  assert.equal(modelled.compressorActivityObserved, false);
  assert.equal(modelled.auxiliaryAssumed, true);
  assert.equal(modelled.powerSourceTime, now);
  assert(Number.isFinite(modelled.powerKw));
  const missing = sample({ observations: {} });
  assert.equal(missing.powerBasis, 'unknown');
  assert.equal(missing.powerKw, null);
});

test('stale or disconnected operation stays modelled and simulated energy stays simulated even with a meter', () => {
  const latest = { compressor_active: reading(1, { sourceTime: now - 6 * MINUTE }) };
  assert.equal(sample({ latest }).powerBasis, 'modelled');
  assert.equal(sample({ latest: { compressor_active: reading(1) }, h66: { connected: false } }).powerBasis, 'modelled');
  const simulated = sample({ latest: { heat_pump_meter_power: reading(5) }, observations: {
    indoor: { value: 21 }, outdoor: { value: 0 }, actual: { source: 'simulation', powerKw: 2.5, compressorDuty: 0.5, auxKw: 0 },
  } });
  assert.equal(simulated.powerBasis, 'simulated');
  assert.equal(simulated.powerKw, 2.5);
  assert.equal(simulated.auxiliaryAssumed, false);
});

test('live model evidence remains available without persisting it as original power history', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine({ store, config: { input: 'providers', settings: {  } }, clock: () => now });
  for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0]]) engine.ingest({
    source: signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature', device: 'synthetic-house', signal, value,
    unit: 'degC', sourceTime: now, receivedAt: now, quality: [],
  });
  engine.tick();
  assert.equal(store.latestObservation('heat_pump_power'), null);
  assert.equal(engine.lastSample.powerBasis, 'modelled');
  assert.equal(engine.lastSample.compressorActivityObserved, false);
  assert.equal(engine.lastSample.auxiliaryAssumed, true);
  assert.equal(engine.lastSample.powerSourceTime, now);
  assert.equal(engine.lastSample.powerReceivedAt, now);
});

test('current timing source names cannot expose arbitrary provenance', () => {
  for (const key of ['{bad', null, [], {}, 'private-not-for-display']) {
    const evidence = timingEvidenceSource(key);
    assert.equal(evidence, 'unknown');
    assert(!JSON.stringify(evidence).includes('private-not-for-display'));
  }
});

test('fresh native reduction telemetry remains distinct from readiness to write settings', () => {
  const native = { connected: true, controlsReady: false, writesEnabled: true,
    restorationPending: true, readings: Object.fromEntries(['0203', '0212', '0208', '2201']
      .map(index => [index, { value: 1, available: true }])) };
  const capture = (h66, observations = { indoor: { value: 21 }, outdoor: { value: 0 } }) =>
    controlObservations({ now, latest: {}, config, phase: 'reduction', h66, observations,
      outlook: { forecast: [], prices: [] }, checkpoint: { model: initialAdaptiveModel(config), baselineC: 21 } }).equipment;
  const transition = capture(native);
  assert.equal(transition.reductionTelemetryAvailable, true);
  assert.equal(transition.h66Available, false, 'Restoration still prevents new actuator assumptions');
  assert.equal(transition.preheatAvailable, false);
  for (const change of [h => { h.connected = false; }, h => { h.writesEnabled = false; },
    h => { h.readings['0203'].available = false; }, h => { delete h.readings['2201']; }]) {
    const unavailable = structuredClone(native); change(unavailable);
    assert.equal(capture(unavailable).reductionTelemetryAvailable, false);
  }
  assert.equal(capture({}, { actual: { source: 'simulation', compressorDuty: 0 } }).reductionTelemetryAvailable, true);
});

test('native trend points retain their report clocks and zero values through controller polling', () => {
  const capture = (at, sourceAt, changes = {}) => controlObservations({ now: at, config, phase: 'normal',
    h66: { connected: true }, observations: { indoor: { value: 21 }, outdoor: { value: 0 } },
    outlook: { forecast: [], prices: [] }, checkpoint: { model: initialAdaptiveModel(config), baselineC: 21 },
    latest: Object.fromEntries(Object.entries({ heating_integral: -10, heating_setpoint: 35, supply_temperature: 30,
      compressor_active: 0, dhw_routing: 0, operating_mode: 1, ...changes }).map(([signal, value]) =>
      [signal, reading(value, { device: 'fixture-native-trend', sourceTime: sourceAt, receivedAt: sourceAt })])) });
  const first = capture(now, now);
  applyNativeControlTrends(first.sample, first.equipment, null, 1);
  assert.equal(first.equipment.integralTrendPerHour, null);
  const poll = capture(now + 59_900, now);
  applyNativeControlTrends(poll.sample, poll.equipment, first.sample, 1);
  assert.equal(poll.equipment.integralTrendPerHour, null, 'A repeated report has no positive time separation');
  const next = capture(now + MINUTE, now + MINUTE, { heating_integral: 0, supply_temperature: 29 });
  applyNativeControlTrends(next.sample, next.equipment, poll.sample, 1);
  assert.equal(next.equipment.integralTrendPerHour, 600, 'A valid reported zero remains a measurement');
  assert.equal(next.equipment.supplyShortfallTrendPerHour, 60, 'The native minute, not the final 100 ms poll, owns the slope');
  assert.deepEqual(next.equipment.nativeProjection, { integral: { observedAt: now + MINUTE, spanMs: MINUTE },
    shortfall: { observedAt: now + MINUTE, spanMs: MINUTE } });
  assert.equal(next.sample.nativeControl.integral.at, now + MINUTE);
  assert.equal(next.sample.nativeControl.compressorOn, 0);
  const held = capture(now + MINUTE + 100, now + MINUTE, { heating_integral: 0, supply_temperature: 29 });
  applyNativeControlTrends(held.sample, held.equipment, next.sample, 1);
  assert.equal(held.equipment.integralTrendPerHour, 600, 'Polling identical evidence retains the dated slope');
  assert.equal(held.equipment.supplyShortfallTrendPerHour, 60);
  assert.equal(held.sample.nativeControl.integral.at, next.sample.nativeControl.integral.at);
  assert.deepEqual(held.equipment.nativeProjection, next.equipment.nativeProjection,
    'Identical controller polls cannot extend the original projection horizon');
  const stale = capture(now + 7 * MINUTE, now + MINUTE, { heating_integral: 0, supply_temperature: 29 });
  applyNativeControlTrends(stale.sample, stale.equipment, held.sample, 1);
  assert.equal(stale.equipment.integralTrendPerHour, null, 'The original points still expire');
  assert.equal(stale.equipment.supplyShortfallTrendPerHour, null);
});

for (const boundary of ['treatment epoch', 'target step', 'compressor', 'routing', 'operating mode',
  'unknown native state', 'missing target', 'nonmonotone clock', 'contradictory clock', 'changed integral source', 'changed supply source'])
test(`native forecast derivatives retain the ${boundary} boundary`, () => {
  const point = (value, at) => ({ value, at, source: 'fixture-native', device: 'fixture-pump' });
  const before = { nativeControl: { contextRevision: 1, integral: point(-10, now), supply: point(30, now),
    target: point(35, now), compressorOn: 0, dhwRouting: 0, operatingMode: 1 } };
  const sample = structuredClone(before), equipment = {};
  sample.nativeControl.integral = point(-20, now + MINUTE);
  sample.nativeControl.supply = point(29, now + MINUTE);
  if (boundary === 'target step') sample.nativeControl.target.value += 9;
  if (boundary === 'compressor') sample.nativeControl.compressorOn = 1;
  if (boundary === 'routing') sample.nativeControl.dhwRouting = 1;
  if (boundary === 'operating mode') sample.nativeControl.operatingMode = 2;
  if (boundary === 'unknown native state') before.nativeControl.compressorOn = sample.nativeControl.compressorOn = null;
  if (boundary === 'missing target') sample.nativeControl.target = null;
  if (boundary === 'nonmonotone clock') sample.nativeControl.integral.at = sample.nativeControl.supply.at = now - 1;
  if (boundary === 'contradictory clock') sample.nativeControl.integral.at = sample.nativeControl.supply.at = now;
  if (boundary === 'changed integral source') sample.nativeControl.integral.device = 'fixture-replaced-pump';
  if (boundary === 'changed supply source') sample.nativeControl.supply.source = 'fixture-replaced-feed';
  applyNativeControlTrends(sample, equipment, before, boundary === 'treatment epoch' ? 2 : 1);
  assert.equal(equipment.integralTrendPerHour, boundary === 'changed supply source' ? -600 : null);
  assert.equal(equipment.supplyShortfallTrendPerHour, boundary === 'changed integral source' ? 60 : null);
});
