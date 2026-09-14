import test from 'node:test';
import assert from 'node:assert/strict';
import { createGarageModel, garageModelSummary } from '../src/garage/model.js';
import { garageSettings } from '../src/garage/settings.js';
import { planGarage } from '../src/garage/planner.js';
import { garagePlanningEvidence, garagePlanningMargins, garagePlanningEnergyUncertainty } from '../src/garage/planning-evidence.js';
import { assignGaragePlanningEvidence } from './helpers/garage-model-fixture.js';

const HOUR = 3_600_000, now = 100 * 24 * HOUR;
const settings = garageSettings({ enabled: true, aggressiveness: 100, protection: { approved: true } });
const observation = { at: now, rearC: 7, frontC: 6.7, outdoorC: 0, baselineVerified: true, available: true };
function model() {
  const value = createGarageModel({ seedAt: 0 });
  value.at = now;
  value.state = { rearC: 7, frontC: 6.7, coreC: 7, differenceC: -.3 };
  value.normalReference.interceptC = 7;
  value.rear.samples = 100; value.front.samples = 100;
  return assignGaragePlanningEvidence(value, { at: now, hours: 2 });
}
function outlook(values) {
  return { prices: values.map((value, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR, priceCtPerKwh: value })),
    forecast: [{ start: now, end: now + values.length * HOUR, outdoorC: 0, issuedAt: now }] };
}
function offRuns(plan) {
  const durations = [];
  for (const row of plan.steps ?? []) {
    if (row.available) continue;
    const previous = durations.at(-1);
    if (previous?.end === row.start) previous.end = row.end;
    else durations.push({ start: row.start, end: row.end });
  }
  return durations.map(row => (row.end - row.start) / HOUR);
}

test('initial economic learning trial remains bounded within a long price outlook', () => {
  const value = model(); value.validation.episodes = [];
  const plan = planGarage({ now, model: value, observation, settings, ...outlook([100, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) });
  assert.equal(plan.learningTrial, true);
  assert.ok(['pause', 'available'].includes(plan.nextAction));
  assert.equal(offRuns(plan).length, 1);
  assert.ok(offRuns(plan)[0] <= .5);
  assert.ok(plan.timingBenefitEur > 0);
});

test('learning growth requires two completed acceptable experiments, never many rows in one pause', () => {
  const value = model();
  value.validation.episodes = value.validation.episodes.slice(0, 1);
  const first = garagePlanningEvidence(value, garageModelSummary(value), { now, observation });
  assert.equal(first.trialHours, .5);
  value.validation.episodes.push({ ...value.validation.episodes[0], id: 1, offHours: .5 });
  const second = garagePlanningEvidence(value, garageModelSummary(value), { now, observation });
  assert.equal(second.trialHours, .75);
  value.validation.episodes[1].thermalPassed = false;
  assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { now, observation }).trialHours, .5);
});

test('a trial cannot start during recovery, a door disturbance or the recovery interval', () => {
  const value = model(); value.validation.episodes = [];
  for (const patch of [{ doorFront: true }, { doorRear: true }, { ev1Active: true }, { baselineVerified: false }]) {
    assert.equal(garagePlanningEvidence(value, garageModelSummary(value), { now, observation: { ...observation, ...patch } }).maxPauseHours, 0);
  }
  value.validation.active = { role: 'training', phase: 'recovery' };
  assert.equal(garagePlanningEvidence(value, { validation: {} }, { now, observation }).maxPauseHours, 0);
  value.validation.active = null;
  value.validation.episodes = [{ complete: true, clean: true, offHours: .5, endedAt: now - HOUR }];
  assert.equal(garagePlanningEvidence(value, { validation: {} }, { now, observation }).maxPauseHours, 0);
});

test('multi-hour economic schedules require electricity evidence as well as thermal duration support', () => {
  const value = model(), summary = garageModelSummary(value);
  assert.equal(summary.thermalReady, true); assert.equal(summary.electricalReady, true);
  assert.equal(garagePlanningEvidence(value, summary, { now, observation }).economicHours, 2);
  const withoutElectricity = { ...summary, electricalReady: false };
  const evidence = garagePlanningEvidence(value, withoutElectricity, { now, observation });
  assert.equal(evidence.economicHours, 0); assert.equal(evidence.maxPauseHours, 1);
  assert.equal(garagePlanningEvidence(value, summary, { now, observation }).trialHours, 3,
    'Repeated two-hour qualification can earn a longer extension experiment');
});

test('forecast margins use whole trajectory errors and keep growing beyond six hours', () => {
  const summary = { validation: { horizonHours: 16, supportedOffHours: 4, rearRmse: .2, frontRmse: .3,
    offRearRmse: .3, offFrontRmse: .4, rearBias: .1, frontBias: .2 },
    heldOut: { advanceRear: { rmse: 0 }, advanceFront: { rmse: 0 } } };
  const early = garagePlanningMargins(summary, 4), later = garagePlanningMargins(summary, 12);
  assert.equal(early.rearC, .6); assert.equal(early.frontC, .8);
  assert.ok(later.rearC > early.rearC); assert.ok(later.frontC > early.frontC);
  assert.deepEqual(garagePlanningMargins({ ...summary, heldOut: {} }, 12), later);
});

test('a failed recent episode blocks immediate trials and resets duration growth', () => {
  const value = model();
  value.validation.episodes.push({ ...value.validation.episodes[0], id: 3, endedAt: now - HOUR,
    thermalPassed: false, electricalPassed: false });
  const summary = { thermalReady: false, electricalReady: false, validation: {} };
  assert.equal(garagePlanningEvidence(value, summary, { now, observation }).maxPauseHours, 0);
  assert.equal(garagePlanningEvidence(value, summary, { now: now + 6 * HOUR, observation }).trialHours, .5);
});

test('electricity uncertainty has kWh units and includes full recovery energy errors', () => {
  const value = model(), summary = { heldOut: { native: { rmse: .1 } } };
  assert.equal(garagePlanningEnergyUncertainty(value, summary, .5).kwh, .05);
  value.validation.episodes[2].predictedKwh = 2;
  assert.equal(garagePlanningEnergyUncertainty(value, summary, 2).kwh, 1);
});

test('a running trial uses its original start and endpoint when renewed', () => {
  const value = model(); value.validation.episodes = [];
  const plan = planGarage({ now, model: value, observation: { ...observation, available: false }, settings,
    activeEpisode: { state: 'paused', pauseStartedAt: now - HOUR / 4, authorizedEndAt: now + HOUR / 4 },
    ...outlook([100, 100, 5, 5, 5, 5]) });
  assert.equal(plan.nextAction, 'renew');
  assert.ok(plan.pauseUntil <= now + HOUR / 4);
  assert.ok(offRuns(plan)[0] <= .25);
});
