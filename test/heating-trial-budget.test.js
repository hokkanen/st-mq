import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { CycleTracker } from '../src/app/cycles.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { evaluateCycle, advanceCycleEvaluation, trialCostExposure } from '../src/control/planner.js';
import { rebuildCycleWorking, initialTrialCostPrefix, advanceTrialCostPrefix } from '../src/app/cycle-evaluation.js';

const hour = 3_600_000, now = Date.parse('2026-11-05T12:00:00Z');
function fixture(t, { exposure = .248, reserved = exposure, cap = 150, daily = 300,
  previous = 0, reviewed = false, startedAt = now, deferStart = false, reductionHours = 2, forecastHours = 8 } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const config = { maxTrialCostCents: cap, trialBudgetCentsPerDay: daily };
  const tracker = new CycleTracker({ store, input: 'synthetic', config });
  const intervals = Array.from({ length: forecastHours * 4 }, (_, i) => ({ start: startedAt + i * hour / 4,
    end: startedAt + (i + 1) * hour / 4, outdoorC: 10, solarRadiationWm2: 0, price: 5 }));
  const schedule = { preheatStart: startedAt, preheatEnd: startedAt, reductionStart: startedAt,
    reductionEnd: startedAt + reductionHours * hour, roomBoostC: 0 };
  const args = { model: initialAdaptiveModel(), initialState: { indoorC: 21, reserveC: 21 },
    targetC: 21, intervals, config };
  const plan = { ...args, schedule, reference: null, trial: true, trialAllowanceCents: reserved,
    trialSafety: { costExposureCents: exposure }, prediction: evaluateCycle({ ...args, schedule }),
    referencePrediction: evaluateCycle(args), occupancy: { mode: 'occupied' } };
  if (reviewed) plan.userTrial = { limits: { maxTrialCostCents: cap } };
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(startedAt);
  store.setState('trials:synthetic', { date, reservedCents: previous });
  const begin = () => tracker.start(plan, { timestamp: startedAt, indoorC: 21, phase: 'reduction' }, startedAt);
  if (!deferStart) begin();
  return { store, tracker, plan, date, begin, ledger: () => store.getState('trials:synthetic') };
}

test('small forecast changes grow a reservation inside the authorized cap without rewriting the original plan', t => {
  const r = fixture(t), original = structuredClone(r.tracker.active().plan);
  assert.equal(r.tracker.reserveTrialExposure(.249), true);
  assert.equal(r.tracker.reserveTrialExposure(.249), true);
  assert.equal(r.ledger().reservedCents, .249);
  assert.equal(r.tracker.active().trialBudget.reservedCents, .249);
  assert.deepEqual(r.tracker.active().plan, original);
  const restored = new CycleTracker({ store: r.store, input: 'synthetic', config: r.tracker.config });
  assert.equal(restored.reserveTrialExposure(.250), true);
  assert.equal(r.ledger().reservedCents, .250);
  assert.equal(r.tracker.active().adjustments, undefined, 'Budget updates are not schedule changes');
});

test('forecast-only exposure oscillations do not spend the same allowance repeatedly', t => {
  const r = fixture(t, { exposure: 3, cap: 3 });
  for (const estimate of [2, 3, 2, 3, 1, 3])
    assert.equal(r.tracker.reserveTrialExposure(estimate), true);
  assert.equal(r.ledger().reservedCents, 3);
  assert.equal(r.tracker.active().trialBudget.reservedCents, 3);
});

test('known unfunded exposure retains the cycle but reduces allowance for later trials without double counting', t => {
  const r = fixture(t, { exposure: 10, cap: 10, daily: 100 });
  const id = r.tracker.active().id;
  for (const exposure of [80, 20, 80]) r.tracker.observeTrialExposure(exposure, now);
  assert.equal(r.tracker.active().id, id);
  assert.equal(r.tracker.active().trialBudget.reservedCents, 10);
  assert.equal(r.ledger().unreservedExposureCents, 70);
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = now + hour; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(now + hour), 20, 'Retaining a cycle cannot grant the same daily allowance again');
});

test('a separately reviewed exposure overrun does not consume the automatic allowance', t => {
  const r = fixture(t, { exposure: 10, cap: 10, daily: 100, reviewed: true });
  r.tracker.observeTrialExposure(80, now);
  assert.equal(r.ledger().unreservedExposureCents, undefined);
  assert.equal(r.tracker.active().exposureEstimate.unreservedCents, 70);
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = now + hour; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(now + hour), 100);
});

function prefixSample(timestamp, { duty = 0, auxKw = 0, price = -5, phase = 'reduction', ...changes } = {}) {
  return { timestamp, indoorC: 21, outdoorC: 10, solarRadiationWm2: 0, phase,
    priceCents: price, priceStart: now, priceEnd: now + 8 * hour,
    compressorDuty: duty, thermalCompressorDuty: duty, thermalAuxKw: auxKw,
    compressorPowerKw: 2.2, circulationKw: 0, powerKw: duty * 2.2 + auxKw,
    auxKw, auxRoute: 'space', compressorActivityObserved: true, auxiliaryObserved: true,
    auxiliaryRouteKnown: true, energyBasis: 'estimated', floorOverrideMode: 'off', ...changes };
}

test('bounded cost prefixes retain all three scenarios and negative-price income through cache reconstruction', t => {
  const r = fixture(t), at = now + hour / 4;
  r.tracker.record(prefixSample(at), at);
  const before = r.tracker.trialExposureContext(at);
  assert(before); assert.equal(before.through, at); assert.equal(before.scenarios.length, 3);
  assert(before.scenarios.every(s => s.actualCostCents === 0 && s.referenceCostCents < 0 && s.foregoneIncomeCents > 0));
  assert.equal(r.tracker.trialExposureContext(at + 1), null, 'A stale prefix cannot fund future operation');
  const working = r.store.getState(r.tracker.workingKey(r.tracker.active()));
  assert.deepEqual(Object.keys(working), ['version', 'id', 'count', 'observer', 'reference', 'revision', 'digest']);
  assert(Buffer.byteLength(JSON.stringify(working)) <= 16 * 1024);
  const restored = new CycleTracker({ store: r.store, input: 'synthetic', config: r.tracker.config });
  assert.equal(restored.trialExposureContext(at), null, 'Missing derived RAM is unknown');
  restored.adoptWorking(rebuildCycleWorking(r.store, restored.workingJob()));
  assert.deepEqual(restored.trialExposureContext(at), before);
});

test('a day-long trial retains exact bounded cost cursors without growing control writes', t => {
  const r = fixture(t, { reductionHours: 24, forecastHours: 26 }), id = r.tracker.active().id;
  let earlyBytes, lastBytes;
  for (let minute = 1; minute <= 1440; minute++) {
    const at = now + minute * 60000;
    r.tracker.record(prefixSample(at, { priceEnd: now + 26 * hour }), at);
    const bytes = r.store.db.prepare('SELECT bytes FROM journal_commits ORDER BY sequence DESC LIMIT 1').get().bytes;
    if (minute === 100) earlyBytes = bytes;
    if (minute === 1440) lastBytes = bytes;
  }
  const before = r.tracker.trialExposureContext(now + 24 * hour);
  assert(before); assert.equal(r.tracker.active().observationCount, 1440);
  assert(before.scenarios.every(s => s.foregoneIncomeCents > 0 && s.referenceCostCents < 0));
  assert(Buffer.byteLength(JSON.stringify(r.tracker.trialCostPrefix)) < 16 * 1024);
  assert(lastBytes < earlyBytes * 1.25, JSON.stringify({ earlyBytes, lastBytes }));
  const restored = new CycleTracker({ store: r.store, input: 'synthetic', config: r.tracker.config });
  restored.adoptWorking(rebuildCycleWorking(r.store, restored.workingJob()));
  assert.deepEqual(restored.trialExposureContext(now + 24 * hour), before);
  assert.equal([...r.store.cycleEvidence(id)].length, 1440);
});

test('recorded AUX remains fixed while estimated compressor input shares the reference source scenarios', t => {
  const r = fixture(t), at = now + hour / 4;
  r.tracker.record(prefixSample(at, { duty: 1, auxKw: 2, price: 5, phase: 'preheat' }), at);
  const context = r.tracker.trialExposureContext(at);
  assert(context);
  for (const s of context.scenarios)
    assert(Math.abs(s.actualCostCents - (2.2 * s.electricalScale + 2) * .25 * 5) < 1e-10);
  assert(Math.abs(context.scenarios[1].actualCostCents - r.tracker.active().actual.spaceHeatingCostCents) < 1e-10);
  assert(context.scenarios.every(s => s.foregoneIncomeCents === 0));
});

test('zero compressor duty needs no invented component power or measured-total attribution', t => {
  const r = fixture(t), cycle = r.tracker.active(), end = now + hour / 4;
  for (const auxKw of [0, 2]) {
    const row = { start: now, end, outdoorC: 10, solarRadiationWm2: 0, price: 5,
      phase: 'reduction', floorOverrideMode: 'off', eligible: true, energyBasis: 'measured',
      thermalCompressorDuty: 0, thermalAuxKw: auxKw, compressorPowerKw: null, circulationKw: null };
    const prefix = advanceTrialCostPrefix({ ...cycle, observationCount: 1, lastSample: { timestamp: end } },
      [row], [], initialTrialCostPrefix(cycle));
    assert.equal(prefix.available, true);
    assert(prefix.scenarios.every(s => s.actualCostCents === auxKw * .25 * 5));
  }
});

test('unknown routed costs and rolled-back evidence cannot become a zero-cost prefix', t => {
  const r = fixture(t), at = now + hour / 4;
  assert.throws(() => r.store.transaction(() => {
    r.tracker.record(prefixSample(at), at);
    throw Error('Synthetic rollback');
  }), /Synthetic rollback/);
  assert.equal(r.tracker.trialExposureContext(now), null, 'Rollback invalidates derived RAM');
  r.tracker.adoptWorking(rebuildCycleWorking(r.store, r.tracker.workingJob()));
  assert(r.tracker.trialExposureContext(now), 'An empty committed prefix is a known zero');
  r.tracker.record(prefixSample(at, { thermalAuxKw: null }), at);
  assert.equal(r.tracker.trialExposureContext(at), null);
});

test('dense negative-price prefix accounting traverses ordered intervals linearly in bounded RAM', t => {
  const r = fixture(t), count = 512, cycle = r.tracker.active();
  let startReads = 0;
  const rows = Array.from({ length: count }, (_, index) => {
    const start = now + Math.floor(index * hour / 4 / count), end = now + Math.floor((index + 1) * hour / 4 / count);
    return { ...prefixSample(end), end, price: -1, eligible: true,
      get start() { startReads++; return start; } };
  });
  const prefix = initialTrialCostPrefix(cycle);
  cycle.observationCount = count; cycle.lastSample = { timestamp: rows.at(-1).end };
  const result = advanceTrialCostPrefix(cycle, rows, [], prefix);
  assert(result.available);
  assert(startReads < count * 200, `Ordered overlap work must stay linear; observed ${startReads} start reads`);
  assert(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024, 'Three cursors retain no observation tape');
});

test('carried Normal storage is included in future recovery and terminal debt', () => {
  const model = initialAdaptiveModel({ homeModel: { dutyPerDegree: 0, internalCPerHour: 0 } });
  const args = { model, initialState: { indoorC: 21, reserveC: 18 }, targetC: 21,
    intervals: [{ start: now, end: now + hour / 4, outdoorC: 21, solarRadiationWm2: 0, price: 10 }],
    equipment: { nativeAuxAllowed: false, supplyC: 35 },
    schedule: { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + hour / 4 } };
  const initial = evaluateCycle(args);
  const carried = evaluateCycle({ ...args, referenceInitialState: { indoorC: 21, reserveC: 22 } });
  assert(carried.terminalKwh > initial.terminalKwh, 'Earlier borrowed storage cannot disappear at the remaining forecast boundary');
  const partial = advanceCycleEvaluation({ ...args, referenceInitialState: { indoorC: 21, reserveC: 22 }, includeTail: false });
  assert.throws(() => advanceCycleEvaluation({ ...args, intervals: [], includeTail: true,
    referenceInitialState: { indoorC: 21, reserveC: 20 } }, partial.continuation), /binding|continuation/i);
});

test('complete-prefix costs stay signed and gross negative-price loss cannot be cancelled by other gains', t => {
  const r = fixture(t), args = { ...r.plan, equipment: { nativeAuxAllowed: false, supplyC: 35 },
    model: initialAdaptiveModel({ homeModel: { dutyPerDegree: 0, internalCPerHour: 0 } }),
    intervals: [{ start: now, end: now + hour / 4, outdoorC: 25, solarRadiationWm2: 0, price: 0 }],
    schedule: { preheatStart: now, preheatEnd: now, reductionStart: now, reductionEnd: now + hour / 4 } };
  const scenarios = [-1, 0, 1].map(direction => ({ direction, actualState: { indoorC: 21, reserveC: 21 },
    referenceState: { indoorC: 21, reserveC: 21 }, actualCostCents: -3, referenceCostCents: 2,
    foregoneIncomeCents: 0, electricalScale: 1, auxiliaryScale: 1 }));
  assert.equal(trialCostExposure({ ...args, costContext: { through: now, scenarios } }).costExposureCents, 0);
  scenarios.forEach(s => { s.foregoneIncomeCents = 4; });
  assert.equal(trialCostExposure({ ...args, costContext: { through: now, scenarios } }).costExposureCents, 4);
  assert.equal(trialCostExposure({ ...args, costContext: null }).costExposureCents, null);
  assert.equal(trialCostExposure({ ...args, costContext: { through: now - 1, scenarios } }).costExposureCents, null);
});

test('full-cycle estimates keep the highest reservation without refunds or repeated top-ups', t => {
  const r = fixture(t, { exposure: 10, cap: 12 });
  assert.equal(r.tracker.reserveTrialExposure(5), true);
  assert.equal(r.ledger().reservedCents, 10);
  assert.equal(r.tracker.reserveTrialExposure(7), true);
  assert.equal(r.ledger().reservedCents, 10);
  assert.equal(r.tracker.reserveTrialExposure(12), true);
  assert.equal(r.ledger().reservedCents, 12);
  assert.equal(r.tracker.reserveTrialExposure(12.001), false);
  assert.equal(r.ledger().reservedCents, 12);
  assert.equal(r.tracker.active().trialBudget.lastExposureCents, 12);
});

test('continuation includes previous daily reservations and rejects only the unaffordable increase', t => {
  const r = fixture(t, { exposure: 1, reserved: 2, cap: 150, daily: 150, previous: 147 });
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().reservedCents, 149, 'The original opportunity reservation already covers this estimate');
  assert.equal(r.tracker.reserveTrialExposure(3), true);
  assert.equal(r.ledger().reservedCents, 150);
  assert.equal(r.tracker.active().trialBudget.reservedCents, 3);
  assert.equal(r.tracker.reserveTrialExposure(3.01), false);
  assert.equal(r.ledger().reservedCents, 150);
});

test('explicit reviewed budgets stay separate from the automatic daily ledger', t => {
  const r = fixture(t, { reviewed: true, cap: 400, daily: 0 });
  assert.equal(r.tracker.reserveTrialExposure(399), true);
  assert.equal(r.ledger().reservedCents, 0);
  assert.equal(r.tracker.reserveTrialExposure(401), false);
  assert.equal(r.ledger().reservedCents, 0);
});

test('one-cycle approval without an edited budget still uses automatic allowance', t => {
  const r = fixture(t, { exposure: 1, cap: 10, daily: 10, previous: 8, deferStart: true });
  r.plan.userTrial = { limits: { maxDropC: 2 } }; r.begin();
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().reservedCents, 10);
  assert.equal(r.tracker.reserveTrialExposure(2.1), false);
});

test('zero remains a valid allowance and unknown exposure never becomes free learning', t => {
  const r = fixture(t, { exposure: 0, cap: 0, daily: 0 });
  assert.equal(r.tracker.reserveTrialExposure(0), true);
  for (const value of [.001, null, undefined, NaN, Infinity, -1, '0'])
    assert.equal(r.tracker.reserveTrialExposure(value), false);
  assert.equal(r.ledger().reservedCents, 0);
});

test('a midnight-spanning cycle retains its original Finnish funding day', t => {
  const startedAt = Date.parse('2026-11-05T21:59:00Z'), nextDay = startedAt + 2 * 60_000;
  const r = fixture(t, { exposure: 1, startedAt });
  assert.equal(r.tracker.reserveTrialExposure(2), true);
  assert.equal(r.ledger().date, r.date);
  assert.equal(r.ledger().reservedCents, 2);
  assert.equal(r.tracker.budget(nextDay), 0, 'An active cycle still blocks another experiment');
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = nextDay; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(nextDay), 300);
  assert.equal(r.tracker.budget(startedAt), 298);
});

test('ledger and active-cycle reservation roll back together after a failed save', t => {
  const r = fixture(t), cycle = structuredClone(r.tracker.active()), ledger = r.ledger();
  const save = r.store.cycle;
  r.store.cycle = () => { throw new Error('Synthetic cycle save failure'); };
  try { assert.throws(() => r.tracker.reserveTrialExposure(1), /Synthetic/); }
  finally { r.store.cycle = save; }
  assert.deepEqual(r.tracker.active(), cycle);
  assert.deepEqual(r.ledger(), ledger);
});

test('a failed initial cycle save cannot consume daily allowance or publish a started event', t => {
  const r = fixture(t, { deferStart: true, previous: 20 }), ledger = r.ledger();
  const save = r.store.cycle;
  r.store.cycle = () => { throw new Error('Synthetic initial cycle save failure'); };
  try { assert.throws(() => r.begin(), /Synthetic/); }
  finally { r.store.cycle = save; }
  assert.equal(r.tracker.active(), null);
  assert.deepEqual(r.ledger(), ledger);
  assert.equal(r.store.events().some(event => event.type === 'cycle-started'), false);
});

test('missing or damaged reservation state does not silently grant more allowance', t => {
  const r = fixture(t);
  r.store.setState('trials:synthetic', { date: r.date, reservedCents: null });
  assert.equal(r.tracker.reserveTrialExposure(.249), false);
  const cycle = r.tracker.active(); cycle.status = 'incomplete'; cycle.endedAt = now + hour; r.tracker.save(cycle);
  assert.equal(r.tracker.budget(now + hour), null);
});
