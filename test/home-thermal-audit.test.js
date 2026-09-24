import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAdaptiveModel, predictThermalStep, thermalObservationIntervals, thermalUncertaintyC,
  thermalErrorEnvelope, restoreAdaptiveCheckpoint } from '../src/control/adaptive-learning.js';
import { withFireplaceInputs } from '../src/app/fireplace-inputs.js';
import { fireplaceBurnGroups } from '../src/domain/fireplace.js';
import { cycleForecastCovered, trialEnvelope } from '../src/control/planner.js';
import { appendLearningRecord, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';
import { Store } from '../src/storage/store.js';
const HOUR = 3600000, start = Date.UTC(2026, 0, 1);
const zero = { outdoorC: 20, compressorDuty: 0, auxKw: 0, solarRadiationWm2: 0, phase: 'normal' };
function rk4(model, initial, outside, hours) {
  const p = model.parameters, f = model.floor;
  const derivative = ([room, reserve, slab]) => [
    -p.lossPerHour * (room - outside) + p.memoryExchangePerHour * (reserve - room) + p.hydronicCPerKwh * f.exchangeKwPerC * (slab - room),
    p.memoryExchangePerHour * (room - reserve) / (f.nativeCapacityKwhPerC * p.hydronicCPerKwh),
    (f.exchangeKwPerC * (room - slab) + f.groundLossKwPerC * (f.groundC - slab)) / f.capacityKwhPerC];
  let state = [...initial]; const dt = hours / 10000;
  const add = (a, b, factor) => a.map((v, i) => v + b[i] * factor);
  for (let i = 0; i < 10000; i++) {
    const a = derivative(state), b = derivative(add(state, a, dt / 2)), c = derivative(add(state, b, dt / 2)), d = derivative(add(state, c, dt));
    state = state.map((v, j) => v + dt / 6 * (a[j] + 2 * b[j] + 2 * c[j] + d[j]));
  }
  return state;
}

test('complete passive network respects extrema and an independent RK4 solution at stiff accepted settings', () => {
  for (const gain of [0.005, 0.75 / 9.4, 0.6]) for (const slab of [10, 30]) {
    const model = initialAdaptiveModel({ thermalPriors: { hydronicCPerKwh: gain },
      floorThermalPriors: { capacityKwhPerC: 100, nativeCapacityKwhPerC: 100, exchangeKwPerC: 100, groundLossKwPerC: 0 } });
    const initial = { indoorC: 20, reserveC: 20, slabC: slab };
    const actual = predictThermalStep(model, initial, zero, 0.25);
    const expected = rk4(model, [20, 20, slab], 20, 0.25);
    [actual.indoorC, actual.reserveC, actual.slabC].forEach((temperature, index) => {
      assert(temperature >= Math.min(20, slab) - 1e-10 && temperature <= Math.max(20, slab) + 1e-10);
      assert(Math.abs(temperature - expected[index]) < 0.015, `${temperature} != ${expected[index]}`);
    });
    const energyChange = (actual.indoorC - 20) / gain + 100 * (actual.reserveC - 20) + 100 * (actual.slabC - slab);
    assert(Math.abs(energyChange + actual.envelopeLossKwh) < 1e-8);
  }
});

test('explicit ground exchange is passive and conserves energy across capacities, gain, long durations and valve transitions', () => {
  for (const capacity of [0.1, 100]) for (const gain of [0.005, 0.6]) for (const groundC of [-5, 25]) {
    const model = initialAdaptiveModel({ thermalPriors: { hydronicCPerKwh: gain },
      floorThermalPriors: { capacityKwhPerC: capacity, nativeCapacityKwhPerC: 0.5, exchangeKwPerC: 1, groundLossKwPerC: 1, groundC } });
    let state = { indoorC: 21, reserveC: 21, slabC: 21 };
    const short = predictThermalStep(model, state, { ...zero, outdoorC: 0 }, 0.01);
    assert(short.indoorC <= 21, 'A colder outside cannot warm an initially equal room');
    for (const mode of ['on', 'off']) {
      const result = predictThermalStep(model, state, { ...zero, outdoorC: 0, floorOverrideMode: mode }, 36);
      for (const value of [result.indoorC, result.reserveC, result.slabC]) assert(value >= Math.min(0, groundC) - 1e-9 && value <= Math.max(21, groundC) + 1e-9);
      const delta = (result.indoorC - state.indoorC) / gain + 0.5 * (result.reserveC - state.reserveC) + capacity * (result.slabC - state.slabC);
      assert(Math.abs(delta + result.groundLossKwh + result.envelopeLossKwh) < 1e-7);
      state = result;
    }
  }
});

test('held temperature aggregation preserves all causal ignition identities and drops unfinished/gapped evidence', () => {
  const events = [{ id: 'first', litAt: start + 5 * 60000, kg: 4 }, { id: 'reload', litAt: start + 30 * 60000, kg: 2 }];
  const rows = Array.from({ length: 5 }, (_, i) => withFireplaceInputs({ timestamp: start + i * HOUR / 4,
    windowStart: start + (i - 1) * HOUR / 4, indoorC: 21, outdoorC: 0, phase: 'normal', regime: 'occupied', quality: [],
    indoorSensors: { room: { weight: 1, observedAt: start + (i === 4 ? HOUR : 0) } },
    inputSegments: [{ start: start + (i - 1) * HOUR / 4, end: start + i * HOUR / 4,
      phase: 'normal', regime: 'occupied', outdoorC: 0, solarRadiationWm2: 0, thermalCompressorDuty: 0, thermalAuxKw: 0, quality: [] }] },
  { fireplaceEvents: events, fireplaceStartedAt: start }));
  rows[2].fireplaceIgnitions = [events[0]]; // Duplicate reference does not duplicate an ignition.
  const merged = thermalObservationIntervals(rows);
  assert.deepEqual(merged.at(-1).fireplaceIgnitions.map(row => row.id), ['first', 'reload']);
  assert.equal(fireplaceBurnGroups(merged.flatMap(row => row.fireplaceIgnitions ?? [])).length, 1);
  const unfinished = thermalObservationIntervals(rows.slice(0, 4));
  assert.equal(unfinished.at(-1).temperatureObservationFresh, false);
  const gap = thermalObservationIntervals(rows.map((row, i) => i === 2 ? { ...row, valid: false } : row));
  assert(!gap.at(-1).fireplaceIgnitions?.some(event => event.id === 'first'));
});

test('hourly endpoint evidence cannot claim measured quarter-hour or half-hour support', () => {
  const envelope = thermalErrorEnvelope({ blocks: Array.from({ length: 3 }, () => ({ hours: 2,
    errors: [{ hours: 1, errorC: 0.1 }, { hours: 2, errorC: 0.2 }] })), maxErrorC: 0.2, horizons: [2, 2, 2] });
  assert.deepEqual(envelope.points.map(point => [point.hours, point.blocks]), [[1, 3], [2, 3]]);
  const model = initialAdaptiveModel(); model.uncertainty = envelope;
  assert(thermalUncertaintyC(model, 0.25, { solarRadiationWm2: 0 }) >= 0.325);
  assert.equal(thermalErrorEnvelope({ blocks: [{ hours: 2, errors: [] }], horizons: [2], maxErrorC: 0 }), null);
});

test('required recovery coverage cannot become a five-cent trial with missing prices', () => {
  const schedule = { preheatStart: start, preheatEnd: start, reductionStart: start, reductionEnd: start + HOUR / 2 };
  const intervals = [{ start, end: start + HOUR / 4, price: 2, outdoorC: 10 }];
  assert.equal(cycleForecastCovered(intervals, schedule), false);
  const result = trialEnvelope({ schedule, intervals, model: initialAdaptiveModel(), initialState: { indoorC: 21 }, targetC: 21 });
  assert.equal(result.available, false); assert.equal(result.costExposureCents, null); assert.equal(result.comfortSafe, false);
});

test('obsolete native Home checkpoints and payloads reject without journal mutation', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.throws(() => restoreAdaptiveCheckpoint({ version: 1, model: { version: 3 }, samples: [] }), /Unsupported Home checkpoint/);
  assert.throws(() => appendLearningRecord(store, 'mqtt', 'sample', { timestamp: start, intervalInputs: {} }), /Unsupported Home sample/);
  assert.equal(store.learningJournal({ input: 'mqtt' }).length, 0);
  assert.equal(LEARNING_ALGORITHM, 'committed-house-v12-passive-thermal');
});
