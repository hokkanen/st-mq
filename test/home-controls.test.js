import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRates, finnishDateTime, homePolicyValues, homeRoomReferences, priceControlState, rateRows, temporaryValues } from '../chart/home-controls.js';

test('date controls display Finnish wall time across winter, summer and midnight', () => {
  const original = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(finnishDateTime('2026-01-12T12:30:00Z'), '2026-01-12T14:30');
    assert.equal(finnishDateTime('2026-09-07T12:30:00Z'), '2026-09-07T15:30');
    assert.equal(finnishDateTime('2026-09-07T21:00:00Z'), '2026-09-08T00:00');
    assert.equal(finnishDateTime('2026-10-25T00:30:00Z'), '2026-10-25T03:30');
    assert.equal(finnishDateTime('2026-10-25T01:30:00Z'), '2026-10-25T03:30');
    assert.equal(finnishDateTime(null), '');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('saved controls show only unexpired away and pause deadlines', () => {
  const now = Date.parse('2026-09-07T12:00:00Z');
  const status = { now, settings: { occupancy: { mode: 'away', returnAt: '2026-09-07T13:00:00Z' } },
    override: { expiresAt: now + 7200_000 } };
  assert.deepEqual(temporaryValues(status), { awayUntilLocal: '2026-09-07T16:00', pauseUntilLocal: '2026-09-07T17:00' });
  assert.deepEqual(temporaryValues({ ...status, now: now + 7200_000 }), { awayUntilLocal: '', pauseUntilLocal: '' });
});

test('Home and Garage automation badges are independent of each other and the environment', () => {
  const status = { input: 'mqtt', automation: { home: { enabled: false }, garage: { enabled: true } } };
  assert.deepEqual(priceControlState(status), { label: 'Paused', state: 'paused' });
  assert.deepEqual(priceControlState(status, { feature: 'garage' }), { label: 'Automatic', state: 'active' });
  assert.equal(priceControlState(status, { feature: 'garage', paused: true }).label, 'Paused');
  assert.equal(priceControlState(status, { enabled: false }).label, 'Unavailable');
  assert.equal(priceControlState({ ...status, input: 'offline' }).label, 'History viewer');
  assert.equal(priceControlState({}).label, 'Unavailable');
  assert.equal(priceControlState({ automation: { home: { enabled: true, available: false } } }).label, 'Unavailable');
});

test('rate report selects the active dated snapshot instead of future or configured rates', () => {
  const previous = { from: 0, to: 100, marginCtPerKwh: 0.4 };
  const current = { from: 100, to: 200, marginCtPerKwh: 0.33 };
  const future = { from: 200, marginCtPerKwh: 0.6 };
  const status = { now: 150, contract: { periods: [previous, current, future] }, configuredPrices: future };
  assert.equal(activeRates(status), current);
  assert.equal(activeRates({ ...status, now: 200 }), future);
  assert.equal(activeRates({ ...status, now: -1 }), null);
});

test('rate table applies VAT once to new ex-VAT and legacy VAT-inclusive transfer snapshots', () => {
  const common = { marginCtPerKwh: 0.33, taxCtPerKwh: 2.325, vatRate: 0.255, tariff: 'day-night' };
  const rows = rateRows({ ...common, transferRates: { vatIncluded: false, dayCtPerKwh: 2, nightCtPerKwh: 1 } });
  assert.equal(rows[0].includingVat.toFixed(5), '0.41415');
  assert.equal(new Intl.NumberFormat('en-GB', { maximumFractionDigits: 5 }).format(rows[1].includingVat), '2.91788');
  assert.equal(rows[2].includingVat, 2.51);
  assert.equal(rows[3].includingVat, 1.255);
  const legacy = rateRows({ ...common, transferRates: { vatIncluded: true, dayCtPerKwh: 3.34, nightCtPerKwh: 1.96 } });
  assert.equal(legacy[2].includingVat, 3.34);
  assert.ok(Math.abs(legacy[2].excludingVat * 1.255 - 3.34) < 1e-10);
  const seasonal = rateRows({ ...common, tariff: 'seasonal', transferRates: { vatIncluded: false, winterDayCtPerKwh: 4, otherCtPerKwh: 2 } });
  assert.deepEqual(seasonal.slice(2).map(row => row.name), ['Winter day transfer', 'Other times transfer']);
});


test('Home policy displays named strategies and saved bounds without inventing missing settings', () => {
  const common = { preheatRoomBoostC: 5, comfort: { maxDropC: 1, maxRiseC: 1.5 } };
  for (const [id, label] of [['gentle', 'Gentle'], ['balanced', 'Balanced'], ['savings', 'More savings']]) {
    const values = homePolicyValues({ settings: { ...common, savingsStrategy: id } });
    assert.equal(values.strategy, label);
    assert.equal(values.strategyId, id);
    assert.equal(values.preheat, '5 °C');
    assert.equal(values.maximumRise, '1.5 °C');
    assert.equal(values.limits, '−1 / +1.5 °C');
  }
  const missing = homePolicyValues({});
  assert.equal(missing.strategy, 'Unavailable');
  assert.equal(missing.strategyId, null);
  assert.equal(missing.preheat, 'Unavailable');
  assert.equal(missing.maximumRise, 'Unavailable');
  assert.equal(missing.limits, 'Limits unavailable');
  assert.equal(homePolicyValues({ settings: { savingsStrategy: 'unknown' } }).strategyId, null);
  assert.equal(missing.benefit, '');
});

test('Home decision summaries distinguish trial budgets, configured ceilings and accepted economics', () => {
  const status = { settings: { savingsStrategy: 'balanced' }, learning: { parameters: {
    learningTrials: true, maxTrialCostCents: 25, trialBudgetCentsPerDay: 100,
    maxPreheatHours: 2, maxReductionHours: 4, maxAwayReductionHours: 12, maxUnobservedReductionHours: 0.5,
  } }, decision: { plan: { economics: { lowerBenefitCents: 45, hurdleCents: 38 } } } };
  const values = homePolicyValues(status);
  assert.match(values.trialBudget, /€0.25 per trial and €1 per day.*remaining budget/);
  assert.match(values.durations, /preheat 2 h; reduction 4 h at home or 12 h away.*0.5 h.*can shorten/);
  assert.match(values.benefit, /€0.45 conservative space-heating benefit.*€0.38 required benefit.*estimates/);
  const trial = structuredClone(status);
  trial.decision.plan.trial = true;
  assert.match(homePolicyValues(trial).benefit, /bounded learning trial/);
  assert.doesNotMatch(homePolicyValues(trial).benefit, /€0.45/);
  trial.learning.parameters.learningTrials = false;
  assert.equal(homePolicyValues(trial).trialBudget, 'Learning trials are disabled in configuration.');
});

test('Room preferences distinguish learned and overall references, occupied bounds and unknown values', () => {
  const status = { comfortRooms: [
    { id: 'bedroom', label: 'Bedroom', referenceC: 20, referenceSource: 'room', minC: 18.5, maxC: 21.5, limitsApply: true },
    { id: 'office', label: 'Office', referenceC: 21, referenceSource: 'overall', minC: 19.5, maxC: 22.5, limitsApply: false },
    { id: 'living', label: 'Living room', referenceC: null, referenceSource: 'unavailable', minC: null, maxC: null, limitsApply: true },
  ] };
  const before = structuredClone(status), rows = homeRoomReferences(status);
  assert.deepEqual(rows.map(row => [row.reference, row.basis, row.limits, row.inactive]), [
    ['20 °C', 'Learned room reference', '18.5 °C – 21.5 °C', false],
    ['21 °C', 'Overall reference', '19.5 °C – 22.5 °C', true],
    ['Unavailable', 'Reference not established', 'Limits unavailable', false],
  ]);
  assert.deepEqual(homeRoomReferences({}), []);
  assert.deepEqual(status, before);
});
