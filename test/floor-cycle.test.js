import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel, predictThermalStep } from '../src/control/adaptive-learning.js';
import { evaluateCycle } from '../src/control/planner.js';
import { estimateHeatPumpPerformance } from '../src/domain/heat-pump-performance.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { fireplaceLearningContext } from '../src/app/fireplace-inputs.js';

const HOUR = 3_600_000, start = Date.parse('2026-01-01T00:00:00Z'), treatmentKey = 'room-boost-floor-v1';
function fixture(t, { reductionHours = 4 } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { recoveryTimeoutHours: 12, heatPumpModelConfirmed: true,
    floorThermalPriors: { capacityKwhPerC: 2, exchangeKwPerC: 0.5, openAllocationFraction: 0.7, closedAllocationFraction: 0 } };
  const tracker = new CycleTracker({ store, input: 'mqtt', config });
  const model = initialAdaptiveModel(config);
  const intervals = Array.from({ length: 48 }, (_, i) => ({ start: start + i * HOUR / 4,
    end: start + (i + 1) * HOUR / 4, outdoorC: 21, solarRadiationWm2: 0, price: i < 2 ? 5 : 20 }));
  const plan = { model, intervals, initialState: { indoorC: 21, reserveC: 21, slabC: 21 }, targetC: 21,
    schedule: { preheatStart: start, preheatEnd: start + HOUR / 2, reductionStart: start + HOUR / 2,
      reductionEnd: start + reductionHours * HOUR, roomBoostC: 2, floorOverride: true, treatmentKey },
    reference: null, referenceLabel: 'continuous normal operation', occupancy: { mode: 'occupied' }, maxDropC: 1,
    equipment: { supplyC: 35, brineC: 0, fireplaceEvents: [], nativeAuxAllowed: false } };
  const sample = (timestamp, extra = {}) => {
    const phase = timestamp <= plan.schedule.preheatEnd ? 'preheat' : timestamp <= plan.schedule.reductionEnd ? 'reduction' : 'recovery';
    const supplyC = phase === 'preheat' ? 45 : 35, compressorDuty = phase === 'preheat' ? 1 : 0;
    const compressorPowerKw = estimateHeatPumpPerformance({ supplyC, brineC: 0 }).electricalKw;
    return { timestamp, indoorC: 21, outdoorC: 21, solarRadiationWm2: 0, indoorTrendCPerHour: 0,
      phase, supplyC, brineC: 0, floorOverrideMode: phase === 'preheat' ? 'on' : 'off', treatmentKey,
      compressorDuty, thermalCompressorDuty: compressorDuty, compressorPowerKw, circulationKw: 0,
      powerKw: compressorDuty * compressorPowerKw, thermalAuxKw: 0, auxKw: 0, auxRoute: 'space',
      compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true, energyBasis: 'estimated', ...extra };
  };
  tracker.start(plan, sample(start), start);
  return { store, tracker, plan, sample };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} differs from ${b}`);

test('frozen observer follows recorded source temperatures and floor ON/OFF without losing stored heat', t => {
  const f = fixture(t);
  let expected = { ...f.plan.initialState };
  for (let i = 1; i <= 4; i++) {
    const row = f.sample(start + i * HOUR / 4);
    expected = predictThermalStep(f.plan.model, expected, { ...row, compressorDuty: row.thermalCompressorDuty,
      auxKw: row.thermalAuxKw }, 0.25);
    expected.indoorC = row.indoorC;
    f.tracker.record(row, row.timestamp);
    const observed = f.tracker.active().observerState;
    near(observed.reserveC, expected.reserveC); near(observed.slabC, expected.slabC);
    assert.ok(observed.slabC > 21, 'Both opening and subsequent closure preserve accounted slab energy');
  }
  const active = f.tracker.active();
  assert.equal(active.treatmentKey, treatmentKey);
  assert.deepEqual(active.observations.map(row => row.floorOverrideMode), ['on', 'on', 'off', 'off']);
  assert.deepEqual(active.observations.map(row => row.supplyC), [45, 45, 35, 35]);
  assert.ok(active.observations.every(row => row.treatmentKey === treatmentKey && row.brineC === 0));
});

test('corrected frozen observer reproduces recorded floor routing across sub-sample transitions', t => {
  const fired = fixture(t), clean = fixture(t);
  const load = addFireplace(fired.store, 'mqtt', { requestId: 'invented-floor-correction-fire', kg: 8 }, start);
  fired.tracker.correctFireplace(fireplaceLearningContext(fired.store, 'mqtt'), start);
  for (let i = 1; i <= 4; i++) {
    const end = start + i * HOUR / 2;
    for (const f of [fired, clean]) {
      const row = f.sample(end);
      row.inputSegments = [f.sample(end - HOUR / 4), row].map((value, j) => ({ ...value,
        start: end - HOUR / 2 + j * HOUR / 4, end: end - HOUR / 4 + j * HOUR / 4 }));
      f.tracker.record(row, end);
    }
  }
  const before = fired.tracker.active(), expected = clean.tracker.active().observerState;
  assert.notEqual(before.observerState.slabC, expected.slabC);
  removeFireplace(fired.store, 'mqtt', { requestId: 'invented-floor-correction-remove', id: load.id }, start + 2 * HOUR + 1);
  fired.tracker.correctFireplace(fireplaceLearningContext(fired.store, 'mqtt'), start + 2 * HOUR + 1);
  const corrected = fired.tracker.active();
  near(corrected.observerState.indoorC, expected.indoorC);
  near(corrected.observerState.reserveC, expected.reserveC);
  near(corrected.observerState.slabC, expected.slabC);
  assert.deepEqual(corrected.actual, before.actual);
  assert.deepEqual(corrected.observations, before.observations);
  assert.deepEqual(corrected.plan, before.plan);
});

test('room and native reserve recovery cannot complete a cycle while selected slab debt remains', t => {
  const f = fixture(t, { reductionHours: 2 });
  for (let i = 1; i <= 14; i++) {
    const recovering = i > 8;
    const row = f.sample(start + i * HOUR / 4, { indoorC: recovering ? 21.1 : 19,
      compressorDuty: recovering ? 1 : 0, thermalCompressorDuty: recovering ? 1 : 0,
      powerKw: recovering ? 9.4 / 4.24 : 0 });
    assert.equal(f.tracker.record(row, row.timestamp), null);
  }
  const active = f.tracker.active();
  const intervals = active.observations.map(({ start, end, outdoorC, solarRadiationWm2, price }) =>
    ({ start, end, outdoorC, solarRadiationWm2, price }));
  const reference = evaluateCycle({ ...active.plan, intervals, schedule: null, config: active.modelConfig, includeTail: false });
  assert.ok(active.lastSample.indoorC >= reference.endState.indoorC - 0.2);
  assert.ok(active.observerState.reserveC >= reference.endState.reserveC - 0.25);
  assert.ok(active.observerState.slabC < reference.endState.slabC - 0.25);
  assert.equal(active.stableSince, null);
  assert.equal(f.store.learningJournal({ input: 'mqtt' }).filter(row => row.kind === 'episode').length, 0);
});

test('partial or unknown floor feedback invalidates the observer and a correction cannot restore it', t => {
  for (const floorOverrideMode of ['partial', 'unknown']) {
    const f = fixture(t);
    const load = addFireplace(f.store, 'mqtt', { requestId: `invented-${floorOverrideMode}-fire`, kg: 8 }, start);
    f.tracker.correctFireplace(fireplaceLearningContext(f.store, 'mqtt'), start);
    f.tracker.record(f.sample(start + HOUR / 4, { floorOverrideMode }), start + HOUR / 4);
    assert.equal(f.tracker.active().observerState, null);
    removeFireplace(f.store, 'mqtt', { requestId: `invented-${floorOverrideMode}-remove`, id: load.id }, start + HOUR / 4 + 1);
    f.tracker.correctFireplace(fireplaceLearningContext(f.store, 'mqtt'), start + HOUR / 4 + 1);
    assert.equal(f.tracker.active().observerState, null);
    assert.equal(f.tracker.active().stableSince, null);
  }
});
