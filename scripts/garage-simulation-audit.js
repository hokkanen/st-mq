#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import * as currentModel from '../src/garage/model.js';
import { createPlant, plantInputs, stepPlant, observedPlant, randomSource,
  pauseSchedule, observationGap, AUDIT_START, HOUR } from '../test/helpers/garage-plant.js';

export const AUDIT_SCENARIOS = [
  ...[1, 2, 5, 15].map(cadenceMinutes => ({ name: `three-weekly-${cadenceMinutes}min`, cadenceMinutes })),
  { name: 'weekly', frequency: 'weekly', days: 84 },
  { name: 'fortnightly', frequency: 'fortnightly', days: 84 },
  { name: 'doors-ev-gaps', parameters: { doors: true, ev: true, gaps: true } },
  { name: 'unobserved-doors', parameters: { doors: true, doorContacts: false } },
  { name: 'slow-heavy-mass', parameters: { memoryHours: 48, slabHours: 120, memoryExchange: .16 } },
  { name: 'fast-light-mass', parameters: { memoryHours: 8, slabHours: 30, memoryExchange: .05 } },
  { name: 'weak-recovery', parameters: { demand: .25, heatResponse: .52 } },
  { name: 'strong-recovery', parameters: { demand: .95, heatResponse: .9 } },
  { name: 'cold-weather', parameters: { weatherOffsetC: -10 } },
  { name: 'high-loss', parameters: { loss: .045, frontLoss: .025 } },
  { name: 'coarse-noisy-sensors', parameters: { noiseC: .07, quantizationC: .1 } },
  ...[11, 47, 991].map(seed => ({ name: `noise-seed-${seed}`, seed })),
  { name: 'activity-only', parameters: { activityOnly: true } },
  { name: 'boolean-activity', parameters: { activityOnly: true, booleanActivity: true } },
  { name: 'no-excitation', frequency: 'never' },
];
const round = value => Number.isFinite(value) ? Math.round(value * 1e5) / 1e5 : value;
function smallMetrics(sum) { return { rearRmseC: round(Math.sqrt(sum.rear / sum.n)),
  frontRmseC: round(Math.sqrt(sum.front / sum.n)) }; }

/** All learning ends before evaluation. Forecasts never receive measured future
 * temperatures, power, fan, defrost or EV. Weather is perfect in this controlled
 * comparison, keeping weather forecast error separate from model error. */
export function runScenario(options = {}, api = currentModel) {
  const { name = 'nominal', cadenceMinutes = 5, days = 42, frequency = 'three-weekly', parameters = {}, seed = 731,
    offDurations = [1, 2], includeSnapshot = false } = options;
  const started = performance.now(), plant = createPlant(parameters), random = randomSource(seed);
  let model = api.createGarageModel({ seedAt: AUDIT_START });
  let observedRows = 0, priorRow = null, offEpisodes = 0, wasAvailable = true;
  const simple = { rearXY: 0, rearXX: 0, frontXY: 0, frontXX: 0 };
  const settings = { baselineC: 10, maxSensorAgeMs: 4 * HOUR };
  for (let minute = 0; minute <= days * 1440; minute++) {
    const hour = minute / 60, schedule = frequency === 'never' ? { available: true } : pauseSchedule(hour, frequency);
    const input = { ...plantInputs(plant, hour, schedule), ...schedule };
    if (wasAvailable && !input.available) offEpisodes++;
    wasAvailable = input.available;
    if (minute % cadenceMinutes === 0 && !observationGap(hour, parameters)) {
      const row = observedPlant(plant, hour, input, random);
      model = api.updateGarageModel(model, row, settings); observedRows++;
      if (priorRow && priorRow.available === false && row.available === false && row.at - priorRow.at <= 30 * 60_000
        && !row.doorFront && !priorRow.doorFront && !row.doorRear && !priorRow.doorRear) {
        const dt = (row.at - priorRow.at) / HOUR;
        for (const place of ['rear', 'front']) {
          const x = (priorRow.outdoorC - priorRow[`${place}C`]) * dt, y = row[`${place}C`] - priorRow[`${place}C`];
          simple[`${place}XY`] += x * y; simple[`${place}XX`] += x * x;
        }
      }
      priorRow = row;
    }
    if (minute < days * 1440) stepPlant(plant, input);
  }
  const summary = api.garageModelSummary(model), endHour = days * 24;
  const prior = api.createGarageModel({ seedAt: AUDIT_START });
  prior.normalReference = structuredClone(model.normalReference);
  const initial = { ...model.state, rearC: priorRow.rearC, frontC: priorRow.frontC,
    differenceC: priorRow.frontC - priorRow.rearC };
  const evaluation = [];
  for (const offHours of offDurations) {
    const branch = structuredClone(plant), normalBranch = structuredClone(plant);
    const states = { learned: structuredClone(initial), prior: structuredClone(initial) };
    const normalStates = structuredClone(states);
    const simpleStates = { rearC: initial.rearC, frontC: initial.frontC };
    const metrics = Object.fromEntries(['learned', 'prior', 'oneNode', 'persistence'].map(key => [key,
      { rear: 0, front: 0, n: 0, energyKwh: 0, normalRecoveryKwh: 0,
        offRear: 0, offFront: 0, offN: 0, recoveredAtHours: null }]));
    let actualEnergyKwh = 0, actualNormalEnergyKwh = 0, actualNormalRecoveryKwh = 0, actualRecoveryHours = null;
    const threshold = { rearC: plant.state.rearC - .2, frontC: plant.state.frontC - .2 };
    const recoveryAllowanceHours = api.garageRecoveryHours(offHours);
    const recoveryWindowHours = Math.max(24, recoveryAllowanceHours);
    for (let minute = 0; minute < (offHours + recoveryWindowHours) * 60; minute += 5) {
      const hour = endHour + minute / 60, available = minute >= offHours * 60;
      const input = plantInputs(branch, hour, { available, disturbance: false });
      const forecastInput = { outdoorC: input.outdoorC, available, ev1Kw: 0, ev2Kw: 0,
        restart: minute === offHours * 60 };
      for (const [key, fitted] of [['learned', model], ['prior', prior]]) {
        const prediction = api.predictGarageStep(fitted, states[key], forecastInput, 5 / 60);
        states[key] = prediction.state; metrics[key].energyKwh += prediction.electricityKwh;
        // The planner accounts for extra recovery explicitly; the illustrative
        // temperature envelope alone does not estimate that electricity.
        if (available && minute < (offHours + recoveryAllowanceHours) * 60) {
          const hours = Math.min(5 / 60, offHours + recoveryAllowanceHours - minute / 60);
          metrics[key].energyKwh += api.predictGarageNative(fitted, states[key], { available: true }).powerKw
            * offHours * api.GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor * hours / recoveryAllowanceHours;
        }
        const normal = api.predictGarageStep(fitted, normalStates[key], { ...forecastInput, available: true, restart: false }, 5 / 60);
        normalStates[key] = normal.state;
        if (available) metrics[key].normalRecoveryKwh += normal.electricityKwh;
      }
      for (let i = 0; i < 5; i++) {
        actualEnergyKwh += stepPlant(branch, plantInputs(branch, hour + i / 60, { available, disturbance: false }));
        const normalEnergy = stepPlant(normalBranch,
          plantInputs(normalBranch, hour + i / 60, { available: true, disturbance: false }));
        actualNormalEnergyKwh += normalEnergy;
        if (available) actualNormalRecoveryKwh += normalEnergy;
      }
      for (const place of ['rear', 'front']) {
        const loss = Math.min(.15, Math.max(.001, simple[`${place}XX`] ? simple[`${place}XY`] / simple[`${place}XX`] : .022));
        simpleStates[`${place}C`] += (available ? (initial[`${place}C`] - simpleStates[`${place}C`]) / 3
          : loss * (input.outdoorC - simpleStates[`${place}C`])) * 5 / 60;
      }
      for (const [key, predicted] of Object.entries({ ...states, oneNode: simpleStates, persistence: initial })) {
        const m = metrics[key], rearError = predicted.rearC - branch.state.rearC, frontError = predicted.frontC - branch.state.frontC;
        m.rear += rearError ** 2; m.front += frontError ** 2; m.n++;
        if (!available) { m.offRear += rearError ** 2; m.offFront += frontError ** 2; m.offN++; }
        if (minute + 5 === offHours * 60) { m.offEndRearErrorC = round(rearError); m.offEndFrontErrorC = round(frontError); }
        if (available && m.recoveredAtHours === null && predicted.rearC >= threshold.rearC && predicted.frontC >= threshold.frontC)
          m.recoveredAtHours = round((minute + 5) / 60 - offHours);
      }
      if (available && actualRecoveryHours === null && branch.state.rearC >= threshold.rearC && branch.state.frontC >= threshold.frontC)
        actualRecoveryHours = round((minute + 5) / 60 - offHours);
    }
    const actualRecoveryExtraKwh = actualEnergyKwh - actualNormalRecoveryKwh;
    evaluation.push({ offHours, recoveryWindowHours, recoveryAllowanceHours, actualEnergyKwh: round(actualEnergyKwh), actualRecoveryHours,
      actualNormalEnergyKwh: round(actualNormalEnergyKwh), actualRecoveryExtraKwh: round(actualRecoveryExtraKwh),
      remainingMassDebtC: { coreC: round(normalBranch.state.coreC - branch.state.coreC),
        slabC: round(normalBranch.state.slabC - branch.state.slabC) },
      models: Object.fromEntries(Object.entries(metrics).map(([key, m]) => [key, { ...smallMetrics(m),
        offRearRmseC: round(Math.sqrt(m.offRear / m.offN)), offFrontRmseC: round(Math.sqrt(m.offFront / m.offN)),
        offEndRearErrorC: m.offEndRearErrorC, offEndFrontErrorC: m.offEndFrontErrorC,
        ...(['learned', 'prior'].includes(key) ? { energyKwh: round(m.energyKwh),
          energyErrorKwh: round(m.energyKwh - actualEnergyKwh), recoveredAtHours: m.recoveredAtHours,
          recoveryExtraKwh: round(m.energyKwh - m.normalRecoveryKwh),
          recoveryExtraErrorKwh: round(m.energyKwh - m.normalRecoveryKwh - actualRecoveryExtraKwh) } : {}) }])) });
  }
  return { name, algorithm: model.algorithm, cadenceMinutes, days, frequency, seed, parameters, observedRows, offEpisodes,
    ready: summary.ready, electricalReady: summary.electricalReady ?? null, electricityBasis: summary.electricity?.basis ?? null,
    validatedOffHours: summary.validatedOffHours ?? null,
    episodeValidation: summary.episodes ?? summary.validation ?? null,
    coefficients: { rear: model.rear.values.map(round), front: model.front.values.map(round), native: model.native.values.map(round) },
    stateBytes: Buffer.byteLength(JSON.stringify(model)), runtimeMs: round(performance.now() - started), evaluation,
    ...(includeSnapshot ? { snapshot: { model, plant, observation: priorRow } } : {}) };
}
export async function runAudit({ api = currentModel, scenarios = AUDIT_SCENARIOS } = {}) {
  const started = performance.now();
  const results = scenarios.map(scenario => runScenario(scenario, api));
  return { fixtureVersion: 'independent-garage-plant-v1', algorithm: results[0]?.algorithm,
    scope: 'Synthetic model audit; no installed hardware measurements or pipe-safety validation.',
    evaluation: 'Frozen coefficients, independent two-mass plant, 1/2h OFF plus 24h recovery with fixed 125% extra recovery allowance; perfect outdoor forecasts; no future actual power.',
    runtimeMs: round(performance.now() - started), results };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), arg = key => args[args.indexOf(key) + 1];
  const api = args.includes('--model') ? await import(pathToFileURL(arg('--model')).href) : currentModel;
  const scenarios = args.includes('--scenario') ? AUDIT_SCENARIOS.filter(item => item.name === arg('--scenario')) : AUDIT_SCENARIOS;
  if (!scenarios.length) throw new Error('No matching audit scenario');
  const report = await runAudit({ api, scenarios });
  if (args.includes('--json')) await writeFile(arg('--json'), `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
