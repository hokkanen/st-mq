import test from 'node:test';
import assert from 'node:assert/strict';
import { floorWriterFixture } from './helpers/floor-writer-fixture.js';
import { CycleTracker } from '../src/app/cycles.js';
import { Engine } from '../src/app/engine.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { committedLearningSample, recordLearningContext } from '../src/app/committed-learning.js';

test('floor acquire bytes wait for the real worker obligation COMMIT', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ obligation: true });
  const action = f.manual(1, true, 'writer-acquire');
  await gate.ready;
  assert.equal(gate.writerHeld, true);
  assert.equal(f.committedState(), null, 'Another connection cannot see the proposed obligation yet');
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  assert.equal(f.nativeMask, 0);
  gate.release();
  await action;
  assert.equal(f.acquireRows.length, 1);
  assert.equal(f.committedState().outstanding.phase, 'active');
  assert.equal(f.committedState().outstanding.mask, 1);
  assert.equal(f.nativeMask, 1);
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsNotSent, 0, 'Queries and confirmed activation are not unsent commands');
});

test('native lease expiry preserves continuous recorded floor evidence and the cycle stored-heat observer', async t => {
  const f = await floorWriterFixture(t), start = f.now;
  const config = { heatPumpModelConfirmed: true, recoveryTimeoutHours: 12,
    floorThermalPriors: { capacityKwhPerC: 2, exchangeKwPerC: .5, openAllocationFraction: .7, closedAllocationFraction: 0 } };
  const model = initialAdaptiveModel(config);
  const mode = () => Engine.prototype.floorOverrideMode.call({ preheatValveStatus: now => f.adapter.status(now) }, f.now);
  await f.adapter.lease({ owner: 'recorded-cycle', until: start + 1000 });
  await f.store.runWrite(() => recordLearningContext(f.store, 'mqtt', {
    phase: 'preheat', roomBoostC: 2, floorOverrideMode: mode(), treatmentKey: 'room-boost-floor-v1',
    regime: 'occupied', targetC: 21, dhwrActive: false,
  }, start));
  const plan = { model, config, initialState: { indoorC: 21, reserveC: 21, slabC: 21 }, targetC: 21,
    maxDropC: 1, occupancy: { mode: 'occupied' }, reference: null, referenceLabel: 'continuous normal operation',
    equipment: { supplyC: 35, brineC: 0, nativeAuxAllowed: false },
    intervals: [{ start, end: start + 3600000, outdoorC: 21, solarRadiationWm2: 0, price: 20 }],
    schedule: { preheatStart: start, preheatEnd: start + 1000, reductionStart: start + 1000,
      reductionEnd: start + 1500, roomBoostC: 2, floorOverride: true, treatmentKey: 'room-boost-floor-v1' } };
  const tracker = new CycleTracker({ store: f.store, input: 'mqtt', config });
  const physical = { indoorC: 21, outdoorC: 21, solarRadiationWm2: 0, supplyC: 35, brineC: 0,
    powerKw: 2, thermalCompressorDuty: 1, thermalAuxKw: 0, compressorDuty: 1, auxKw: 0,
    compressorPowerKw: 2, circulationKw: 0, energyBasis: 'estimated',
    auxRoute: 'space', compressorActivityObserved: true, auxiliaryObserved: true, auxiliaryRouteKnown: true };
  await f.store.runWrite(() => tracker.start(plan, { ...physical, timestamp: start, phase: 'preheat' }, start));
  f.advance(1000);
  assert.equal(f.adapter.status().active, false);
  assert.equal(mode(), 'on', 'The original GPIO observation remains bounded and separate from expired authority');
  await f.store.runWrite(() => recordLearningContext(f.store, 'mqtt', {
    phase: 'reduction', roomBoostC: 0, floorOverrideMode: mode(), treatmentKey: 'room-boost-floor-v1',
    regime: 'occupied', targetC: 21, dhwrActive: false,
  }, f.now));
  f.advance(1); await f.adapter.tick();
  const offAt = f.now;
  assert.equal(mode(), 'off'); assert.equal(f.nativeMask, 0);
  f.advance(999);
  const committed = committedLearningSample({ store: f.store, input: 'mqtt', at: f.now, config });
  const segments = committed.inputSegments.filter(row => row.end > start).map(row => ({ ...physical,
    start: Math.max(start, row.start), end: row.end, phase: row.phase,
    floorOverrideMode: row.floorOverrideMode, roomBoostC: row.roomBoostC, treatmentKey: row.treatmentKey }));
  assert(segments.length > 1);
  assert(segments.every(row => ['on', 'off'].includes(row.floorOverrideMode)));
  const sample = { ...physical, timestamp: f.now, phase: 'recovery', floorOverrideMode: 'off',
    inputSegments: segments };
  await f.store.runWrite(() => tracker.record(sample, f.now));
  const cycle = tracker.active();
  assert(Number.isFinite(cycle.observerState?.reserveC));
  assert(Number.isFinite(cycle.observerState?.slabC));
  const intervals = [...f.store.cycleEvidence(cycle.id)];
  assert(intervals.every(row => row.floorOverrideMode !== 'unknown'));
  assert(intervals.some(row => row.floorOverrideMode === 'on' && row.end === offAt));
  assert(intervals.some(row => row.floorOverrideMode === 'off' && row.start === offAt));
});

test('a rejected worker obligation COMMIT cannot activate or retain provisional learning', async t => {
  const f = await floorWriterFixture(t), before = f.contexts();
  const gate = f.holdCommit({ obligation: true, fail: true });
  const action = f.manual(1, true, 'writer-rejected').catch(error => error);
  await gate.ready;
  assert.equal(f.wire.some(row => row.op === 'acquire'), false);
  gate.release();
  assert((await action) instanceof Error);
  await f.settle();
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  assert.equal(f.committedState(), null);
  assert.deepEqual(f.contexts(), before);
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsByContext['floor-control'], 1,
    'A selected acquire prevented by its required COMMIT is counted once before publisher entry');
});

test('an obligation COMMIT delayed beyond its challenge cannot publish late activation', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ obligation: true });
  const originalEnd = f.now + 900000;
  const action = f.manual(1, true, 'writer-too-late').catch(error => error);
  await gate.ready;
  f.advance(2001);
  gate.release();
  assert.equal((await action)?.code, 'FLOOR_ACTIVATION_TIMEOUT');
  assert.equal(f.wire.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  const saved = f.committedState();
  assert.equal(saved.outstanding, null, 'Fresh GPIO OFF may retire the committed unsent obligation');
  assert(saved.retired.some(row => row.key === 'manual_writer-too-late' && row.until === originalEnd));
  assert.equal(f.store.writeHealth.status().history.windows.day.commandsByContext['floor-control'], 1,
    'The existing challenge deadline expired during required persistence');
});

test('GPIO readback and its learning boundary become visible only after worker COMMIT', async t => {
  const f = await floorWriterFixture(t), rowsBefore = f.outputs(), contextsBefore = f.contexts();
  const gate = f.holdCommit();
  const receiving = f.externalOn();
  await gate.ready;
  assert.equal(f.adapter.status().devices[0].channels[0].output, false);
  assert.deepEqual(f.outputs(), rowsBefore);
  assert.deepEqual(f.contexts(), contextsBefore);
  gate.release();
  await receiving;
  assert.equal(f.adapter.status().devices[0].channels[0].output, true);
  assert(f.outputs().some(row => row.value === 1));
  assert.equal(f.contexts().at(-1).floorOverrideMode, 'partial');
});

test('rolled-back GPIO feedback cannot become current ON or a committed partial learning interval', async t => {
  const f = await floorWriterFixture(t), gate = f.holdCommit({ fail: true });
  const receiving = f.externalOn().catch(error => error);
  await gate.ready;
  gate.release();
  assert((await receiving) instanceof Error);
  await f.settle();
  assert.equal(f.adapter.status().devices[0].channels[0].output, null);
  assert.equal(f.outputs().some(row => row.value === 1), false);
  assert.equal(f.contexts().some(row => row.floorOverrideMode === 'partial'), false);
  assert.equal(f.contexts().at(-1).floorOverrideMode, 'unknown');
});

test('real writer restart releases a manual lease without replay or deadline extension', async t => {
  const f = await floorWriterFixture(t);
  await f.manual(1, true, 'writer-first-circuit', 60);
  const original = f.committedState().outstanding;
  const originalEnd = original.until;
  f.advance(20000);
  await f.manual(2, true, 'writer-peer-circuit', 900);
  assert.equal(f.committedState().outstanding.until, originalEnd);
  assert.equal(f.committedState().outstanding.mask, 3);
  const wireBefore = f.wire.length, rowsBefore = f.outputs();
  f.advance(10000);
  await f.restart();
  const after = f.wire.slice(wireBefore);
  assert(after.some(row => row.op === 'release'), 'Same board still ON must receive its owned release');
  assert.equal(after.some(row => row.op === 'acquire' || row.op === 'renew'), false);
  assert.equal(f.nativeMask, 0);
  assert.equal(f.committedState().outstanding, null);
  assert(f.committedState().retired.some(row => row.key === original.key && row.until === originalEnd));
  assert.deepEqual(f.outputs().slice(0, rowsBefore.length), rowsBefore);
});
