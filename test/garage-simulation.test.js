import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../scripts/garage-simulation-audit.js';
import { runPlanningAudit } from '../scripts/garage-planning-simulation.js';
import { createPlant, plantInputs, stepPlant, observedPlant, randomSource, pauseSchedule,
  AUDIT_START } from './helpers/garage-plant.js';
import { createGarageModel, updateGarageModel, replayGarageModel, garageRecoveryHours } from '../src/garage/model.js';

test('independent plant retains separate slow masses through a local door plunge', () => {
  const warm = createPlant({ doors: true }), cold = createPlant({ doors: true });
  cold.state.coreC = 1; cold.state.slabC = 1;
  const inputs = { ...plantInputs(warm, 41.8), available: false, powerKw: 0, doorFront: true };
  for (let i = 0; i < 6; i++) { stepPlant(warm, inputs); stepPlant(cold, inputs); }
  assert.ok(warm.state.frontC < warm.state.rearC - 2);
  assert.ok(warm.state.coreC > 6.9 && warm.state.slabC > 6.9);
  for (let i = 0; i < 120; i++) {
    stepPlant(warm, { ...inputs, doorFront: false }); stepPlant(cold, { ...inputs, doorFront: false });
  }
  assert.ok(warm.state.frontC > cold.state.frontC + .5);
});

test('noisy one-minute and fifteen-minute histories retain accurate independent short OFF forecasts', () => {
  const minute = runScenario({ name: 'one-minute', cadenceMinutes: 1, days: 21 });
  const quarter = runScenario({ name: 'quarter-hour', cadenceMinutes: 15, days: 21 });
  for (const result of [minute, quarter]) {
    assert.equal(result.ready, true);
    assert.ok(result.stateBytes < 50_000, 'Checkpoint size is bounded independently of sensor report count');
    for (const episode of result.evaluation) {
      const learned = episode.models.learned;
      assert.ok(Math.abs(learned.offEndRearErrorC) < .35, JSON.stringify({ cadence: result.cadenceMinutes, episode }));
      assert.ok(Math.abs(learned.offEndFrontErrorC) < .4);
      assert.ok(learned.recoveryExtraKwh > 0, 'Explicit recovery allowance is included beyond normal maintenance power');
      assert.ok(Math.abs(learned.recoveryExtraKwh - result.coefficients.native[0] * episode.offHours * 1.25) < .001);
      assert.ok(Number.isFinite(learned.energyErrorKwh), 'Independent electricity mismatch remains visible');
    }
  }
  for (let i = 0; i < minute.evaluation.length; i++) {
    assert.ok(Math.abs(minute.evaluation[i].models.learned.offEndRearErrorC
      - quarter.evaluation[i].models.learned.offEndRearErrorC) < .25);
  }
});

test('rare independent episodes remain useful while activity alone cannot qualify electricity', () => {
  const sparse = runScenario({ name: 'fortnightly', cadenceMinutes: 15, days: 84, frequency: 'fortnightly' });
  assert.equal(sparse.offEpisodes, 6);
  const endpoint = sparse.evaluation.at(-1).models;
  assert.ok(Math.abs(endpoint.learned.offEndRearErrorC) < .3);
  assert.ok(Math.abs(endpoint.learned.offEndFrontErrorC) < .35);
  const activity = runScenario({ name: 'activity', days: 21, cadenceMinutes: 15, parameters: { activityOnly: true } });
  assert.equal(activity.electricalReady, false);
  const noOff = runScenario({ name: 'never-off', days: 21, cadenceMinutes: 15, frequency: 'never' });
  assert.equal(noOff.ready, false); assert.equal(noOff.validatedOffHours, 0);
  assert.deepEqual(noOff.coefficients.rear, [.03], 'No OFF history leaves the declared cooling prior intact');
});

test('long OFF audit branches price the full recovery allowance over a proportionate window', () => {
  const result = runScenario({ days: 21, cadenceMinutes: 15, offDurations: [6, 30] });
  for (const episode of result.evaluation) {
    assert.equal(episode.recoveryAllowanceHours, garageRecoveryHours(episode.offHours));
    assert.ok(episode.recoveryWindowHours >= episode.recoveryAllowanceHours);
    assert.ok(Math.abs(episode.models.learned.recoveryExtraKwh
      - result.coefficients.native[0] * episode.offHours * 1.25) < .001);
    assert.ok(Number.isFinite(episode.models.learned.offEndRearErrorC));
    assert.ok(Number.isFinite(episode.models.learned.offEndFrontErrorC));
  }
});

test('independent noisy journal replay and repeated simulation are deterministic', () => {
  const plant = createPlant({ ev: true, doors: true }), random = randomSource(47), entries = [];
  const seed = createGarageModel({ seedAt: AUDIT_START });
  let online = seed;
  for (let minute = 0; minute <= 3 * 1440; minute++) {
    const hour = minute / 60, input = { ...plantInputs(plant, hour, pauseSchedule(hour)), ...pauseSchedule(hour) };
    if (minute % 15 === 0) {
      const entry = { observation: observedPlant(plant, hour, input, random) };
      entries.push(entry); online = updateGarageModel(online, entry.observation);
    }
    stepPlant(plant, input);
  }
  assert.deepEqual(replayGarageModel(JSON.parse(JSON.stringify(seed)), entries), online);
  const options = { days: 3, cadenceMinutes: 15, seed: 11, offDurations: [2] };
  const first = runScenario(options), second = runScenario(options);
  delete first.runtimeMs; delete second.runtimeMs;
  assert.deepEqual(first, second);
});

test('savings preference changes selected duration and monetary admission without removing thermal protection', () => {
  const report = runPlanningAudit({ days: 43, cadenceMinutes: 15 });
  for (const row of report.rows.filter(row => ['flat', 'mild-peak'].includes(row.tariff)
    || row.tariff !== 'exceptional-peak' && row.aggressiveness <= 50)) {
    assert.equal(row.offHours, 0); assert.equal(row.simulatedBillDifferenceEur, 0);
  }
  const selected = report.rows.find(row => row.tariff === 'exceptional-peak' && row.aggressiveness === 50);
  assert.ok(selected.offHours > 2, 'The four-hour tariff opportunity is not capped by the old two-hour policy');
  assert.ok(selected.simulatedBillDifferenceEur > .5);
  assert.ok(selected.minimumFrontC > 3 && selected.minimumRearC > 3);
  assert.ok(selected.endDebtC.coreC < .2 && selected.endDebtC.slabC < .2);
  const preferences = report.rows.filter(row => row.tariff === 'exceptional-peak');
  assert.deepEqual(preferences.map(row => row.offHours), [2.5, 3, 3.25, 3.75, 4]);
  assert.ok(preferences.every(row => row.minimumFrontC > 3 && row.minimumRearC > 3));
  assert.ok(report.rows.find(row => row.tariff === 'ordinary-peak' && row.aggressiveness === 100).offHours > 0,
    'Highest preference accepts a smaller opportunity that fails the balanced monetary hurdle');
});
