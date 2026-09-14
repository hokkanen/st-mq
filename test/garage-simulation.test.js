import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../scripts/garage-simulation-audit.js';
import { runPlanningAudit } from '../scripts/garage-planning-simulation.js';
import { createPlant, plantInputs, stepPlant, observedPlant, randomSource, pauseSchedule,
  AUDIT_START } from './helpers/garage-plant.js';
import { createGarageModel, updateGarageModel, replayGarageModel } from '../src/garage/model.js';

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

test('noisy one-minute and fifteen-minute histories retain consistent frozen long forecasts', () => {
  const minute = runScenario({ name: 'one-minute', cadenceMinutes: 1 });
  const quarter = runScenario({ name: 'quarter-hour', cadenceMinutes: 15 });
  for (const result of [minute, quarter]) {
    assert.equal(result.ready, true);
    assert.ok(result.stateBytes < 50_000, 'Checkpoint size is bounded independently of sensor report count');
    for (const episode of result.evaluation) {
      const learned = episode.models.learned;
      assert.ok(Math.abs(learned.offEndRearErrorC) < .35, JSON.stringify({ cadence: result.cadenceMinutes, episode }));
      assert.ok(Math.abs(learned.offEndFrontErrorC) < .4);
      assert.ok(Math.abs(learned.energyErrorKwh) / episode.actualEnergyKwh < .1);
      assert.ok(Math.abs(learned.recoveryExtraErrorKwh) < Math.max(.1, .15 * episode.actualRecoveryExtraKwh),
        'Ordinary maintenance energy must not hide a poor prediction of the extra recovery');
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
  assert.equal(noOff.ready, false); assert.equal(noOff.maxPauseHours, 0);
  assert.equal(noOff.coefficients.rear[1], .11, 'Slow memory is retained until it has independent evidence');
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

test('default preference takes ordinary price opportunities and preserves flat-price warmth in independent simulation', () => {
  const report = runPlanningAudit();
  assert.equal(report.training.electricalReady, true);
  for (const row of report.rows.filter(row => row.tariff === 'flat' || row.aggressiveness === 0)) {
    assert.equal(row.offHours, 0); assert.equal(row.simulatedBillDifferenceEur, 0);
  }
  const ordinary = report.rows.find(row => row.tariff === 'ordinary-peak' && row.aggressiveness === 50);
  assert.ok(ordinary.offHours >= 2);
  assert.ok(ordinary.simulatedBillDifferenceEur > .2);
  assert.ok(ordinary.minimumFrontC > 3 && ordinary.minimumRearC > 3);
  assert.ok(ordinary.endDebtC.coreC < .2 && ordinary.endDebtC.slabC < .2);
  for (const tariff of ['mild-peak', 'ordinary-peak', 'two-peaks']) {
    const rows = report.rows.filter(row => row.tariff === tariff);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].coolingDegreeHours + 1e-6 >= rows[i - 1].coolingDegreeHours);
  }
});
