import test from 'node:test';
import assert from 'node:assert/strict';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageModel } from '../src/garage/model.js';
import { planGarage } from '../src/garage/planner.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';

const HOUR = 3_600_000, NOW = Date.parse('2026-01-01T10:00:00Z');
const repeated = (count, value) => Array.from({ length: Math.ceil(count) }, () => value);
function candidate(values, { outdoorC = 8, priorOnly = false, settings: preferences = {} } = {}) {
  const settings = garageSettings({ enabled: true, aggressiveness: 100, protection: { approved: true }, ...preferences });
  const model = assignGaragePlanningEvidence(createGarageModel({ seedAt: NOW }), { at: NOW, hours: 2 });
  model.normalReference.interceptC = 10; model.normalReference.frontC = 9.5;
  if (priorOnly) {
    model.validation.episodes = [];
    model.rear.active[0] = false; model.front.active[0] = false;
  }
  return { now: NOW, settings, model,
    observation: { at: NOW, rearAt: NOW, frontAt: NOW, rearC: 10, frontC: 9.5,
      outdoorC, available: true, baselineVerified: true, doorFront: false },
    exposure: knownGarageReserve(settings, { at: NOW, rearC: 10, frontC: 9.5 }),
    restorationDelayMs: 120_000,
    prices: values.map((value, i) => ({ start: NOW + i * HOUR, end: NOW + (i + 1) * HOUR, priceCtPerKwh: value })),
    forecast: [{ start: NOW, end: NOW + values.length * HOUR, outdoorC, issuedAt: NOW }] };
}
const duration = plan => (plan.plannedPauseUntil - plan.pauseFrom) / HOUR;

test('temperature-safe opportunities can exceed two, twenty-four and forty-eight hours', () => {
  for (const hours of [6, 30, 60]) {
    const args = candidate([...repeated(hours, 200), ...repeated(hours * 1.25 + 4, 5)]);
    const plan = planGarage(args);
    assert.equal(plan.nextAction, 'pause');
    assert.equal(duration(plan), hours);
    assert.equal(plan.evidence.validatedOffHours, 2, 'Observed duration describes evidence, never a maximum permission');
    assert.equal(plan.learningTrial, true);
    assert.ok(plan.scoreEur > args.settings.minSavingsEur);
    assert.ok(plan.pauseUntil + args.restorationDelayMs <= plan.horizonEndAt);
    assert.equal(Object.hasOwn(args.settings, 'maxPauseHours'), false);
    assert.equal(Object.hasOwn(args.settings, 'maxHorizonHours'), false);
  }
});

test('an unvalidated cooling prior can select a worthwhile six-hour pause when uncertainty-adjusted pipe reserve supports it', () => {
  const args = candidate([...repeated(6, 200), ...repeated(12, 5)], { priorOnly: true });
  const plan = planGarage(args);
  assert.equal(plan.nextAction, 'pause');
  assert.equal(duration(plan), 6);
  assert.equal(plan.evidence.thermalReady, false);
  assert.equal(plan.evidence.validatedOffHours, 0);
  assert.equal(plan.learningTrial, true);
  assert.ok(plan.steps.at(-1).frontLowerC < plan.steps.at(-1).frontC - 1,
    'Extrapolation still pays for uncertainty in actual temperature units');
});

test('cold forecasts shorten the selected pause through copper-pipe protection instead of a duration constant', () => {
  const prices = [...repeated(60, 200), ...repeated(80, 5)];
  const warm = planGarage(candidate(prices));
  const cold = planGarage(candidate(prices, { outdoorC: -15 }));
  assert.equal(duration(warm), 60);
  assert.ok(duration(cold) > 1 && duration(cold) < 12);
  assert.ok(cold.pauseFrom > NOW, 'Heating remains available until the later safe opportunity');
  assert.equal(cold.nextAction, 'available');
  assert.ok(cold.steps.every(row => row.frontLowerC > 1 && row.rearLowerC > 1));
  const missing = candidate(prices); missing.observation.frontC = null;
  assert.equal(planGarage(missing).nextAction, 'available');
});

test('a short cheap trough cannot price a whole day of recovery as if all extra electricity fit within three hours', () => {
  const args = candidate([...repeated(24, 100), ...repeated(3, 1), ...repeated(30, 90)]);
  const plan = planGarage(args);
  assert.equal(plan.nextAction, 'available');
  assert.ok(plan.pauseFrom >= NOW + 20 * HOUR);
  assert.ok(duration(plan) < 4, 'The selected opportunity is near the trough, not the complete 24-hour plateau');
  const long = planGarage(candidate([...repeated(24, 200), ...repeated(40, 5)]));
  assert.equal(duration(long), 24);
  assert.equal(long.recoveryHours, 30);
  assert.equal(long.recoveryKwh, 15);
  assert.equal(long.recoveryCostEur, .75);
});

test('renewal retains accumulated recovery debt and rejects an extension that only looks worthwhile when that debt is forgotten', () => {
  const args = candidate([...repeated(2, 100), ...repeated(3, 1), ...repeated(40, 90)]);
  args.observation.available = false;
  args.activeEpisode = { state: 'paused', pauseStartedAt: NOW - 24 * HOUR,
    authorizedEndAt: NOW + 2 * HOUR, accounting: { offHours: 24, recoveryAllowanceKwh: 15 } };
  const withDebt = planGarage(args);
  assert.equal(withDebt.nextAction, 'available');
  assert.equal(withDebt.reason, 'benefit-below-minimum-saving');
  args.activeEpisode.pauseStartedAt = NOW;
  args.activeEpisode.accounting = { offHours: 0, recoveryAllowanceKwh: 0 };
  assert.equal(planGarage(args).nextAction, 'renew');
});

test('a valid renewal prices recovery of all earlier OFF hours and preserves its original endpoint', () => {
  const args = candidate([...repeated(2, 200), ...repeated(40, 5)]);
  args.observation.available = false;
  args.activeEpisode = { state: 'paused', pauseStartedAt: NOW - 24 * HOUR,
    authorizedEndAt: NOW + 2 * HOUR, accounting: { offHours: 24, recoveryAllowanceKwh: 15 } };
  const plan = planGarage(args);
  assert.equal(plan.nextAction, 'renew');
  assert.equal(plan.pauseUntil, NOW + 2 * HOUR);
  assert.equal(plan.existingRecoveryKwh, 15);
  assert.equal(plan.recoveryKwh, 16.25);
  assert.equal(plan.recoveryHours, 32.5);
  const restoreNowCost = 15 * (2 * 2 + 28 * .05) / 30;
  assert.ok(Math.abs(plan.recoveryCostEur - (16.25 * .05 - restoreNowCost)) < 1e-8);
  args.prices = args.prices.map((row, i) => ({ ...row, priceCtPerKwh: i < 10 ? 200 : 5 }));
  assert.ok((planGarage(args).pauseUntil ?? NOW) <= args.activeEpisode.authorizedEndAt,
    'New outlook data never silently lengthens the permission originally accepted by the driver');
});

test('no duration cap permits a pause across absent, future-issued or insufficient restoration weather', () => {
  for (const change of [
    args => { args.forecast = []; },
    args => { args.forecast[0].issuedAt = NOW + 1; },
    args => { args.forecast[0].fetchedAt = NOW + 1; },
    args => { args.forecast[0].end = NOW + HOUR; },
    args => { args.forecast[0].start = NOW + HOUR; },
  ]) {
    const args = candidate([200, ...repeated(12, 5)]);
    change(args);
    assert.equal(planGarage(args).nextAction, 'available');
  }
});

test('long planning retains only one selected trajectory, stays deterministic and does not mutate learning or observation history', () => {
  const args = candidate([...repeated(60, 200), ...repeated(108, 5)]);
  const before = JSON.stringify(args);
  const plan = planGarage(args);
  assert.equal(duration(plan), 60);
  assert.equal(plan.steps.filter((row, i, rows) => !row.available && (i === 0 || rows[i - 1].available)).length, 1);
  assert.ok(plan.steps.length <= 60 * 4 + 1, 'Returned storage is proportional to the selected path, not all possible windows');
  assert.ok(JSON.stringify(plan).length < 200_000);
  assert.deepEqual(planGarage(args), plan);
  assert.equal(JSON.stringify(args), before);
});
