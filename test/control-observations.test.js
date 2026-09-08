import test from 'node:test';
import assert from 'node:assert/strict';
import { controlObservations, deriveChargerPower } from '../src/app/control-observations.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { timingPowerEvidence } from '../src/app/timing-evidence.js';
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
  assert.equal(observed.powerKw, 6.05);
  assert.equal(observed.powerSourceTime, now - MINUTE);
  assert.equal(observed.powerReceivedAt, now);
  assert.equal(observed.auxiliaryAssumed, false);
  const assumedAux = sample({ latest: { compressor_active: reading(1) } });
  assert.equal(assumedAux.powerBasis, 'observed');
  assert.equal(assumedAux.auxiliaryAssumed, true);
  assert(Math.abs(assumedAux.powerKw - 3.185) < 1e-12);
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

test('derived charger power carries explicit current-based evidence without changing its acquisition time', () => {
  const latest = Object.fromEntries([1, 2, 3].map(phase => [`ev1_current_l${phase}`, reading(phase * 2, {
    source: 'easee', sourceTime: now - phase * 1000,
  })]));
  const result = deriveChargerPower(latest, now);
  assert.equal(result.value, 2.76);
  assert.equal(result.sourceTime, now - 3000);
  assert.equal(result.raw.powerBasis, 'currents');
  assert.equal(timingPowerEvidence(result).key, 'currents');
  latest.ev1_current_l1.sourceTime = now - 6 * MINUTE;
  assert.equal(deriveChargerPower(latest, now), null);
});

test('live model evidence remains available without persisting it as original power history', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine({ store, config: { input: 'providers', settings: { mode: 'shadow' } }, clock: () => now });
  for (const [signal, value] of [['indoor_temperature', 21], ['outdoor_temperature', 0]]) engine.ingest({
    source: signal === 'outdoor_temperature' ? 'fmi' : 'smartthings', device: 'synthetic-house', signal, value,
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

test('invalid or incomplete legacy metadata cannot claim measured or observed energy', () => {
  for (const raw of ['{bad', null, [], { basis: 'estimated' }, { powerBasis: 'private-not-for-display' }]) {
    const evidence = timingPowerEvidence({ signal: 'heat_pump_power', raw });
    assert.equal(evidence.key, 'unknown');
    assert.equal(evidence.auxiliaryUnknown, true);
    assert(!JSON.stringify(evidence).includes('private-not-for-display'));
  }
});
