import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace } from '../src/app/fireplace.js';
import { replayLearningJournal} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';
import { initialAdaptiveModel, thermalEvidenceReady, fireplaceEvidenceReady } from '../src/control/adaptive-learning.js';
import { getFirewoodBenefit } from '../src/app/firewood-benefit.js';
import { advanceFirewoodPair, firewoodScenarios } from '../src/domain/firewood-benefit.js';

const HOUR = 3_600_000, WINDOW = HOUR / 4, start = Date.UTC(2026, 0, 1);
function fixture(t, { hours = 48, input = 'mqtt', price = 20, gapAt = null, seed = null, dhw = false, config = {} } = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const load = addFireplace(store, input, { requestId: 'invented-fire', kg: 8 }, start);
  for (let i = 0; i <= hours * 4; i++) {
    const at = start + i * WINDOW;
    const values = { phase: 'normal', regime: 'occupied', targetC: 21, outdoorC: i === gapAt ? null : 0,
      solarRadiationWm2: 0, compressorDuty: 1, thermalCompressorDuty: 1, auxKw: 0, thermalAuxKw: 0,
      compressorPowerKw: 3, circulationKw: 0.08, compressorActivityObserved: true,
      auxiliaryObserved: true, auxiliaryRouteKnown: true, actualModeKnown: true, quality: [],
      nativeCompressorDemand: true, integral: -999, supplyShortfallC: 20, operatingMode: 1,
      ...(dhw ? { thermalCompressorDuty: 0, dhwCompressorDuty: 1, auxRoute: 'dhw' } : {}) };
    appendLearningRecord(store, input, 'sample', { timestamp: at, windowStart: at - WINDOW, windowEnd: at,
      indoorC: 21, ...values, inputSegments: [{ ...values, start: at - WINDOW, end: at }] }, { seed, config });
  }
  const now = start + hours * HOUR;
  const priceIntervals = [{ start, end: now, price }];
  const args = { store, input, range: { from: start, to: now }, now, priceIntervals };
  return { store, args, load };
}

test('paired runtime changes despite recorded native demand; negative prices retain negative benefit', t => {
  const { args } = fixture(t, { price: -20 });
  const result = getFirewoodBenefit(args);
  assert.equal(result.summary.status, 'provisional');
  assert.ok(result.summary.electricityAvoidedKwh > 0);
  assert.ok(result.summary.valueEuro < 0);
  assert.equal(result.summary.woodCostEuro, 0);
  assert.equal(result.summary.coverage.missingMs, 0);
  assert.ok(result.summary.estimateRange.lowerEuro <= result.summary.valueEuro);
  assert.ok(result.summary.estimateRange.upperEuro >= 0, 'Scenario range includes little or no displacement');
});

test('overlapping fires share one no-fire counterfactual, with identical initial state and no fixed kg conversion', () => {
  const model = initialAdaptiveModel(); model.parameters.fireplaceCPerKg = 0.8;
  const events = [{ id: 1, at: start, kg: 10 }, { id: 2, at: start, kg: 10 }];
  const total = fires => {
    const scenario = firewoodScenarios(model, { indoorC: 21, reserveC: 21 })[0];
    let saved = 0;
    for (let i = 0; i < 96; i++) saved += advanceFirewoodPair(scenario, {
      start: start + i * WINDOW, end: start + (i + 1) * WINDOW, outdoorC: 0,
      solarRadiationWm2: 0, targetC: 21, price: 20, fireplaceEvents: fires }).avoidedKwh;
    return saved;
  };
  assert.equal(total([]), 0);
  assert.ok(total(events) > total(events.slice(0, 1)));
  assert.ok(total(events) < 2 * total(events.slice(0, 1)), 'Saturation is evaluated once across both loads');
});

test('selected-period totals warm up earlier fires and exclude prices and residual heat outside the period', t => {
  const { args } = fixture(t);
  const whole = getFirewoodBenefit(args);
  const split = start + 24 * HOUR;
  const first = getFirewoodBenefit({ ...args, range: { from: start, to: split } });
  const second = getFirewoodBenefit({ ...args, range: { from: split, to: args.now },
    priceIntervals: [{ start: split, end: args.now, price: 20 }] });
  assert.ok(Math.abs(whole.summary.valueEuro - first.summary.valueEuro - second.summary.valueEuro) < 1e-9);
  assert.ok(second.summary.electricityAvoidedKwh > 0, 'A load before the selected period still contributes');
  assert.equal(second.summary.loads.count, 0);
  assert.ok(second.summary.remaining.kgEquivalent > 0);
  assert.equal(second.summary.remaining.valueEuro, undefined);
});

test('price gaps remain missing; historical tariff assumption flags reach the summary', t => {
  const { args } = fixture(t, { hours: 8 });
  const result = getFirewoodBenefit({ ...args, priceIntervals: [
    { start, end: start + 2 * HOUR, price: 20, assumedPrice: true },
    { start: start + 4 * HOUR, end: args.now, price: -10 },
  ] });
  assert.equal(result.summary.coverage.includedMs, 6 * HOUR);
  assert.equal(result.summary.coverage.missingMs, 2 * HOUR);
  assert.match(result.summary.reason, /Partial/);
  assert.ok(result.summary.assumptions.some(value => /assumed tariff/.test(value)));
  assert.deepEqual(result.summary.priceAssumptions, { durationMs: 2 * HOUR, share: 1 / 3,
    firstAt: start, lastAt: start + 2 * HOUR, timeBasis: 'included-period' });
  const known = getFirewoodBenefit(args);
  assert.deepEqual(known.summary.priceAssumptions, { durationMs: 0, share: 0, firstAt: null, lastAt: null, timeBasis: 'included-period' });
});

test('retired price-assumption aliases cannot authorize a fireplace estimate', t => {
  const { args } = fixture(t, { hours: 8 });
  for (const key of ['rateAssumption', 'assumedRates', 'ratesAssumed', 'assumed']) {
    const result = getFirewoodBenefit({ ...args, priceIntervals: args.priceIntervals.map(row => ({ ...row, [key]: true })) });
    assert.equal(result.summary.status, 'unavailable');
    assert.equal(result.summary.valueEuro, null);
    assert.match(result.summary.reason, /unsupported rate-assumption fields/);
    assert.equal(result.summary.priceAssumptions.durationMs, 0);
  }
});

test('missing weather cannot become a zero-cost period or an invented later counterfactual', t => {
  const { args } = fixture(t, { gapAt: 8, hours: 8 });
  const result = getFirewoodBenefit(args);
  assert.ok(result.summary.coverage.includedMs < 8 * HOUR);
  assert.ok(result.summary.coverage.missingMs > 0);
  assert.equal(result.summary.evidence.sourceGaps > 0, true);
});

test('fresh partial forecast residual is separate from recorded past totals', t => {
  const { args } = fixture(t, { hours: 8 });
  const before = getFirewoodBenefit(args);
  const future = [{ start: args.now, end: args.now + 2 * HOUR, outdoorC: 0,
    solarRadiationWm2: 0, price: 20, forecastIssuedAt: args.now - HOUR }];
  const result = getFirewoodBenefit({ ...args, futureIntervals: future });
  assert.equal(result.summary.valueEuro, before.summary.valueEuro);
  assert.deepEqual(result.intervals, before.intervals);
  assert.equal(result.summary.remaining.status, 'partial-forecast');
  assert.ok(result.summary.remaining.valueEuro > 0);
  assert.equal(result.summary.remaining.through, args.now + 2 * HOUR);
  const stale = getFirewoodBenefit({ ...args, futureIntervals: [{ ...future[0], forecastIssuedAt: args.now - 7 * HOUR }] });
  assert.equal(stale.summary.remaining.valueEuro, undefined);
});

test('corrections invalidate cached values, source streams remain separate, and estimation is read-only', t => {
  const { args, store, load } = fixture(t, { hours: 8 });
  const before = getFirewoodBenefit(args);
  assert.ok(before.summary.valueEuro > 0);
  assert.equal(getFirewoodBenefit({ ...args, input: 'simulated' }).summary.valueEuro, null);
  const stateBefore = store.db.prepare('SELECT * FROM state ORDER BY key').all();
  store.db.exec('PRAGMA query_only=ON');
  const cached = getFirewoodBenefit(args);
  assert.deepEqual(cached, before);
  assert.deepEqual(store.db.prepare('SELECT * FROM state ORDER BY key').all(), stateBefore);
  store.db.exec('PRAGMA query_only=OFF');
  removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, args.now);
  const removed = getFirewoodBenefit(args);
  assert.equal(removed.summary.valueEuro, null);
  assert.notEqual(removed.summary.fireplaceRevision, before.summary.fireplaceRevision);
});

test('temperature/fireplace validation alone cannot certify electrical displacement without observed backoff', t => {
  const model = initialAdaptiveModel();
  model.trainedAt = new Date(start - HOUR).toISOString();
  model.validation = { accepted: true, kind: 'conditional-thermal', samples: 100,
    parameterEvidence: Object.fromEntries(['lossPerHour', 'hydronicCPerKwh', 'fireplaceCPerKg'].map(key => [key, { status: 'identified' }])),
    fireplace: { accepted: true, trainingBurns: 3, validationBurns: 3 } };
  const { args, store } = fixture(t, { seed: { version: 1, samples: [], model, baselineC: 21 }, hours: 30 });
  const checkpoint = replayLearningJournal(store, 'mqtt');
  assert.equal(thermalEvidenceReady(checkpoint.model), true);
  assert.equal(fireplaceEvidenceReady(checkpoint.model), true);
  const result = getFirewoodBenefit(args);
  assert.equal(result.summary.status, 'provisional');
  assert.equal(result.summary.evidence.electricalValidated, false);
  assert.equal(result.summary.evidence.displacementChecked, false);
  assert.ok(result.summary.estimateRange.lowerEuro <= 0);
});

test('legitimate boundary parameters and malformed model seeds cannot break the chart estimate', t => {
  for (const [lossPerHour, hydronicCPerKwh] of [[0.001, 0.6], [0.12, 0.005]]) {
    const model = initialAdaptiveModel();
    Object.assign(model.parameters, { lossPerHour, hydronicCPerKwh });
    for (const scenario of firewoodScenarios(model, { indoorC: 21, reserveC: 21 })) assert.doesNotThrow(() => advanceFirewoodPair(scenario,
      { start, end: start + WINDOW, outdoorC: 0, solarRadiationWm2: 0, price: 10, targetC: 21, fireplaceEvents: [] }));
  }
  assert.throws(() => fixture(t, { hours: 8, seed: { version: 1, samples: [], model: { version: 3, parameters: {} } } }), /Unsupported Home seed/);
  const { args } = fixture(t, { hours: 8 });
  const result = getFirewoodBenefit(args);
  assert.equal(result.summary.status, 'provisional');
  args.store.db.prepare("INSERT INTO state(key,value,updated_at) VALUES('adaptive:mqtt','{',?)").run(args.now);
  assert.doesNotThrow(() => getFirewoodBenefit(args));
});

test('retired nominal compressor watts cannot override the fixed source performance map', () => {
  const run = power => {
    const scenario = firewoodScenarios(initialAdaptiveModel(), { indoorC: 21, reserveC: 21 })[0];
    let kwh = 0;
    for (let i = 0; i < 32; i++) kwh += advanceFirewoodPair(scenario, { start: start + i * WINDOW,
      end: start + (i + 1) * WINDOW, outdoorC: 0, solarRadiationWm2: 0, price: 20, targetC: 21,
      config: { heatPumpCompressorKw: power, circulationKw: 0, auxRatedKw: 0 }, fireplaceEvents: [{ at: start, kg: 8 }] }).avoidedKwh;
    return kwh;
  };
  assert.ok(run(1) > 0);
  assert.ok(Math.abs(run(3) - run(1)) < 1e-9);
});

test('DHW compressor operation cannot masquerade as observed space-heating backoff', t => {
  const model = initialAdaptiveModel(); model.trainedAt = new Date(start - HOUR).toISOString();
  const { args } = fixture(t, { hours: 8, dhw: true, seed: { version: 1, samples: [], model, baselineC: 21 } });
  const result = getFirewoodBenefit(args);
  assert.equal(result.summary.evidence.normalObservedHours, 0);
  assert.equal(result.summary.evidence.electricalValidated, false);
});

test('recorded segment nominal power takes precedence over window-end equipment configuration', t => {
  const { args: beforeChange } = fixture(t, { hours: 8, config: { heatPumpCompressorKw: 3, circulationKw: 0.08 } });
  const { args: afterChange } = fixture(t, { hours: 8, config: { heatPumpCompressorKw: 6, circulationKw: 0.16 } });
  const before = getFirewoodBenefit(beforeChange), after = getFirewoodBenefit(afterChange);
  assert.ok(Math.abs(before.summary.electricityAvoidedKwh - after.summary.electricityAvoidedKwh) < 1e-9,
    'Both journals retain the same 3 kW / 0.08 kW segment observations despite different window-end settings');
});

test('off-grid forecast bridge is explicit, excluded from past money, and does not repeat past replay', t => {
  const { args, store } = fixture(t, { hours: 8 });
  const realPrepare = store.db.prepare.bind(store.db);
  let replayReads = 0;
  store.db.prepare = sql => { if (sql === 'SELECT * FROM learning_journal WHERE input=? AND at<=? ORDER BY id') replayReads++; return realPrepare(sql); };
  const range = { from: start, to: args.now + HOUR };
  const first = getFirewoodBenefit({ ...args, range });
  const now = args.now + 5 * 60_000;
  const next = getFirewoodBenefit({ ...args, range, now,
    futureIntervals: [{ start: args.now, end: args.now + 2 * HOUR, outdoorC: 0, solarRadiationWm2: 0,
      price: 20, forecastIssuedAt: args.now - HOUR }] });
  assert.equal(replayReads, 1, 'A moving clock alone must reuse the expensive committed-history replay');
  assert.equal(next.summary.valueEuro, first.summary.valueEuro);
  assert.equal(next.summary.remaining.bridgeMs, 5 * 60_000);
  assert.equal(next.summary.remaining.status, 'partial-forecast');
  assert.equal(next.summary.coverage.missingMs, 5 * 60_000);
});

test('unsupported early fire history can restart a provisional comparison after release expiry for later fires', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  addFireplace(store, 'mqtt', { requestId: 'invented-old-fire', kg: 4 }, start);
  const later = start + 6 * 24 * HOUR;
  addFireplace(store, 'mqtt', { requestId: 'invented-new-fire', kg: 8 }, later);
  for (let i = 0; i <= 32; i++) {
    const at = later + i * WINDOW;
    appendLearningRecord(store, 'mqtt', 'sample', { timestamp: at, windowStart: at - WINDOW, windowEnd: at,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied', targetC: 21, quality: [] });
  }
  const result = getFirewoodBenefit({ store, input: 'mqtt', now: later + 8 * HOUR,
    range: { from: start, to: later + 8 * HOUR }, priceIntervals: [{ start, end: later + 8 * HOUR, price: 20 }] });
  assert.equal(result.summary.status, 'provisional');
  assert.ok(result.summary.valueEuro > 0);
  assert.equal(result.summary.evidence.resetCount, 1);
  assert.equal(result.summary.coverage.firstAt, later);
  assert.ok(result.summary.coverage.missingMs >= 6 * 24 * HOUR);
});

test('a gap preserves missing coverage but a later fire after release expiry can be estimated', t => {
  const { args, store } = fixture(t, { hours: 8, gapAt: 4 });
  const later = start + 6 * 24 * HOUR;
  addFireplace(store, 'mqtt', { requestId: 'invented-later-fire', kg: 8 }, later);
  for (let i = 0; i <= 32; i++) {
    const at = later + i * WINDOW;
    appendLearningRecord(store, 'mqtt', 'sample', { timestamp: at, windowStart: at - WINDOW, windowEnd: at,
      indoorC: 21, outdoorC: 0, solarRadiationWm2: 0, phase: 'normal', regime: 'occupied', targetC: 21, quality: [] });
  }
  const result = getFirewoodBenefit({ ...args, now: later + 8 * HOUR, range: { from: start, to: later + 8 * HOUR },
    priceIntervals: [{ start, end: later + 8 * HOUR, price: 20 }] });
  assert.ok(result.summary.evidence.resetCount > 0);
  assert.equal(result.summary.coverage.lastAt, later + 8 * HOUR);
  assert.ok(result.summary.coverage.missingMs > 5 * 24 * HOUR);
});
