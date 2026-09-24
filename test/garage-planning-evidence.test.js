import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageModel, garageModelSummary } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { planGarage } from '../src/garage/planner.js';
import { garagePlanningEvidence, garagePlanningMargins, garagePlanningEnergyUncertainty } from '../src/garage/planning-evidence.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';
import { knownGarageReserve } from './helpers/garage-reserve-fixture.js';
const HOUR = 3_600_000, now = 100 * 24 * HOUR;
const settings = garageSettings({ enabled: true, protection: { approved: true } });
const observation = { at: now, rearC: 7, frontC: 6.7, outdoorC: 0, baselineVerified: true, available: true };
function model() {
  const value = createGarageModel({ seedAt: 0 });
  value.at = now; value.state = { rearC: 7, frontC: 6.7, differenceC: -.3 };
  value.normalReference.interceptC = 7; value.normalReference.frontC = 6.7;
  return assignGaragePlanningEvidence(value, { at: now, hours: 2 });
}
function outlook(values) {
  return { prices: values.map((value, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR, priceCtPerKwh: value })),
    forecast: [{ start: now, end: now + values.length * HOUR, outdoorC: 0, issuedAt: now }] };
}
const offHours = plan => (plan.steps ?? []).reduce((hours, row) => hours + (row.available ? 0 : (row.end - row.start) / HOUR), 0);

test('an initial worthwhile opportunity may exceed two hours when pipe protection supports it', () => {
  const value = model(); value.validation.episodes = [];
  const plan = planGarage({ now, restorationDelayMs: 120_000, exposure: knownGarageReserve(settings, { at: now }),
    model: value, observation, settings, ...outlook([300, 300, 300, 300, ...Array(20).fill(5)]) });
  assert.equal(plan.learningTrial, true); assert.equal(plan.state, 'waiting');
  assert.ok(offHours(plan) > 2); assert.ok(plan.scoreEur > settings.minSavingsEur);
  assert.equal(plan.evidence.validatedOffHours, 0); assert.equal(plan.evidence.eligible, true);
  const ordinary = planGarage({ now, restorationDelayMs: 120_000, exposure: knownGarageReserve(settings, { at: now }),
    model: value, observation, settings, ...outlook([40, 5, 5, 5, 5, 5, 5, 5]) });
  assert.equal(offHours(ordinary), 0, 'Learning alone never justifies a small saving');
});

test('completed experiments improve duration evidence without imposing a permission ceiling', () => {
  const value = model(), complete = structuredClone(value.validation.episodes);
  for (const episodes of [[], complete.slice(0, 1), complete.slice(0, 2)]) {
    value.validation.episodes = episodes;
    const evidence = garagePlanningEvidence(value, garageModelSummary(value), { observation });
    assert.equal(evidence.eligible, true); assert.equal(evidence.validatedOffHours, 0);
    assert.equal(evidence.reason, 'protection-limited-learning-opportunity');
    for (const oldLimit of ['economicHours', 'trialHours', 'maxPauseHours']) assert.equal(Object.hasOwn(evidence, oldLimit), false);
  }
  value.validation.episodes = complete.map(row => ({ ...row, offHours: 1, trainingSupportHours: 1 }));
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation }).validatedOffHours, 1);
  value.validation.episodes = complete;
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation }).validatedOffHours, 2);
  const plan = planGarage({ now, restorationDelayMs: 120_000, exposure: knownGarageReserve(settings, { at: now }),
    model: value, observation, settings, ...outlook([300, 300, 300, 300, ...Array(20).fill(5)]) });
  assert.ok(offHours(plan) > plan.evidence.validatedOffHours);
});

test('recovery and failed-trial cooldown prevent starting a new experiment', () => {
  const value = model();
  value.validation.active = { role: 'training', phase: 'recovery' };
  assert.equal(garagePlanningEvidence(value, { thermalReady: true, validatedOffHours: 2 }, { observation }).eligible, false);
  value.validation.active = null;
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation: { ...observation, recovering: true } }).eligible, false);
  value.validation.episodes.push({ ...value.validation.episodes[2], id: 3, endedAt: now - HOUR,
    complete: false, thermalPassed: false });
  const blocked = garagePlanningEvidence(value, garageModelSummary(value), { observation });
  assert.equal(blocked.eligible, false); assert.equal(blocked.reason, 'learning-retry-cooldown');
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation, now: now + 6 * HOUR }).eligible, true);
});

test('unknown baseline or charging prevents prior-only eligibility; owner assumption is explicit', () => {
  const value = model(); value.validation.episodes = [];
  for (const patch of [{ ev1Active: true }, { ev2Kw: 5 }, { baselineVerified: false }, { available: false }]) {
    assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation: { ...observation, ...patch } }).eligible, false);
  }
  const assumed = { ...observation, baselineVerified: false, baselineAccepted: true };
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { observation: assumed }).eligible, true);
  value.normalReference.initialized = false;
  const unknown = garagePlanningEvidence(value, garageModelSummary(value), { observation });
  assert.equal(unknown.eligible, false); assert.equal(unknown.reason, 'insufficient-normal-heating-evidence');
});

test('thermal evidence remains distinct from electricity qualification and duration permission', () => {
  const value = model(), summary = garageModelSummary(value);
  assert.equal(summary.thermalReady, true); assert.equal(summary.electricalReady, true);
  const evidence = garagePlanningEvidence(value, { ...summary, electricalReady: false }, { observation });
  assert.equal(evidence.validatedOffHours, 2); assert.equal(evidence.electricalReady, false);
  assert.equal(evidence.eligible, true); assert.equal(Object.hasOwn(evidence, 'maxPauseHours'), false);
});

test('forecast margins use frozen trajectory errors and keep growing beyond support', () => {
  const summary = { validation: { supportedOffHours: 4, rearRmse: .2, frontRmse: .3,
    offRearRmse: .3, offFrontRmse: .4, rearBias: .1, frontBias: .2 } };
  const early = garagePlanningMargins(summary, 4), later = garagePlanningMargins(summary, 12);
  assert.equal(early.rearC, .6); assert.equal(early.frontC, .8);
  assert.ok(later.rearC > early.rearC); assert.ok(later.frontC > early.frontC);
});

test('power and optimistic recovery errors have separate kWh units and conservative overprediction adds no second penalty', () => {
  const value = model(), summary = { heldOut: { native: { rmse: .1 } } };
  let result = garagePlanningEnergyUncertainty(value, summary, 2);
  assert.equal(result.kwh, .2); assert.equal(result.recoveryKwh, 0);
  value.validation.episodes[2].predictedKwh = 2;
  result = garagePlanningEnergyUncertainty(value, summary, 2);
  assert.equal(result.kwh, .2); assert.equal(result.recoveryKwh, 0);
  value.validation.episodes[2].observedKwh = 3;
  result = garagePlanningEnergyUncertainty(value, summary, 2);
  assert.equal(result.kwh, .2); assert.equal(result.recoveryKwh, 1);
  value.native.active[0] = false;
  assert.equal(garagePlanningEnergyUncertainty(value, { heldOut: {} }, 2).kwh, .5);
});

test('a running one-hour trial cannot extend its original endpoint during renewal', () => {
  const value = model(); value.validation.episodes = [];
  const plan = planGarage({ now, restorationDelayMs: 120_000, exposure: knownGarageReserve(settings, { at: now }), model: value,
    observation: { ...observation, available: false }, settings,
    activeEpisode: { state: 'paused', pauseStartedAt: now - .75 * HOUR, authorizedEndAt: now + .25 * HOUR },
    ...outlook([300, 5, 5, 5, 5, 5]) });
  assert.equal(plan.nextAction, 'renew'); assert.equal(plan.pauseUntil, now + .25 * HOUR); assert.equal(offHours(plan), .25);
});
