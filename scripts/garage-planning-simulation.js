#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { planGarage } from '../src/garage/planner.js';
import { HEATING_STRATEGIES } from '../src/domain/heating-strategy.js';
import { garageSettings } from '../src/garage/settings.js';
import { createGarageModel, updateGarageModel, garageModelSummary } from '../src/garage/model.js';
import { createGarageExposure, updateGarageExposure } from '../src/garage/protection.js';
import { knownGarageReserve } from '../test/helpers/garage-reserve-fixture.js';
import { runScenario } from './garage-simulation-audit.js';
import { AUDIT_START, HOUR, outdoorAt, createPlant, plantInputs, stepPlant,
  observedPlant, randomSource } from '../test/helpers/garage-plant.js';
const round = value => Number.isFinite(value) ? Math.round(value * 100000) / 100000 : value;
// Declared simulation allowance, preserving the previous comparison's assumed
// heating response. This is not a measured bound for the installed heat pump.
const SIMULATED_HEATING_RESPONSE_MS = 10 * 60_000;
// Independent plant assumption, distinct from the planner's conservative idle
// allowance. Standby electricity contributes to the bill, not compressor heat.
const SIMULATED_STANDBY_KW = .04;
function targetInputs(plant, hour, row, extra = {}) {
  const demandReduced = row?.demandReduced === true;
  return { ...plantInputs(plant, hour, { available: true, roomTargetC: demandReduced ? row.targetC : 7,
    standbyPowerKw: SIMULATED_STANDBY_KW, ...extra }),
    demandReduced, roomTargetC: 7, effectiveTargetC: demandReduced ? row.targetC : 7 };
}
const PRICES = [
  { name: 'flat', values: Array(24).fill(7) },
  { name: 'mild-peak', values: Array.from({ length: 24 }, (_, i) => i >= 6 && i < 10 ? 12 : 7) },
  { name: 'ordinary-peak', values: Array.from({ length: 24 }, (_, i) => i >= 6 && i < 10 ? 40 : 7) },
  { name: 'exceptional-peak', values: Array.from({ length: 24 }, (_, i) => i >= 6 && i < 10 ? 400 : 7) },
  { name: 'two-peaks', values: Array.from({ length: 24 }, (_, i) => i >= 4 && i < 7 || i >= 15 && i < 18 ? 40 : 7) },
];
export function runPlanningAudit({ days = 43, cadenceMinutes = 5, parameters = {}, restorationDelayMs = SIMULATED_HEATING_RESPONSE_MS } = {}) {
  const started = performance.now();
  const trained = runScenario({ days, cadenceMinutes, parameters, offDurations: [], includeSnapshot: true });
  const { model, plant, observation } = trained.snapshot, now = observation.at, hour = (now - AUDIT_START) / HOUR;
  const forecast = Array.from({ length: 24 }, (_, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR,
    outdoorC: outdoorAt(hour + i, plant.parameters), issuedAt: now }));
  const rows = [];
  for (const tariff of PRICES) for (const { id: savingsStrategy } of HEATING_STRATEGIES) {
    const settings = garageSettings({ enabled: true, savingsStrategy, protection: { approved: true } });
    // This frozen comparison starts with explicitly warm synthetic reference
    // objects. It does not infer installed pipe warmth from one air report.
    const exposure = knownGarageReserve(settings, { at: now, rearC: plant.state.rearC, frontC: plant.state.frontC,
      rearAirC: observation.rearC, frontAirC: observation.frontC });
    const prices = tariff.values.map((value, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR, priceCtPerKwh: value }));
    const planned = planGarage({ now, model, observation, exposure, prices, forecast, settings, restorationDelayMs });
    const candidate = structuredClone(plant), reference = structuredClone(plant);
    const totals = { candidateKwh: 0, referenceKwh: 0, candidateCostEur: 0, referenceCostEur: 0,
      reducedHours: 0, reducedElectricityKwh: 0, nativeOffHours: 0, coolingDegreeHours: 0, minimumRearC: Infinity, minimumFrontC: Infinity };
    let horizonDebtC = null;
    for (let minute = 0; minute < 48 * 60; minute++) {
      const at = now + minute * 60_000;
      const row = minute < 24 * 60 ? planned.steps.find(step => step.start <= at && step.end > at) : null;
      const input = targetInputs(candidate, hour + minute / 60, row, { disturbance: false });
      const candidateEnergy = stepPlant(candidate, input);
      const referenceEnergy = stepPlant(reference, targetInputs(reference, hour + minute / 60, null, { disturbance: false }));
      const cents = minute < 24 * 60 ? tariff.values[Math.floor(minute / 60)] : 7;
      totals.candidateKwh += candidateEnergy; totals.referenceKwh += referenceEnergy;
      totals.candidateCostEur += candidateEnergy * cents / 100; totals.referenceCostEur += referenceEnergy * cents / 100;
      totals.reducedHours += input.demandReduced ? 1 / 60 : 0;
      totals.reducedElectricityKwh += input.demandReduced ? candidateEnergy : 0;
      totals.minimumRearC = Math.min(totals.minimumRearC, candidate.state.rearC);
      totals.minimumFrontC = Math.min(totals.minimumFrontC, candidate.state.frontC);
      totals.coolingDegreeHours += (Math.max(0, reference.state.coreC - candidate.state.coreC)
        + .5 * Math.max(0, reference.state.rearC - candidate.state.rearC)
        + .25 * Math.max(0, reference.state.frontC - candidate.state.frontC)) / 60;
      if (minute === 24 * 60 - 1) horizonDebtC = Object.fromEntries(['rearC', 'frontC', 'coreC', 'slabC']
        .map(key => [key, round(reference.state[key] - candidate.state[key])]));
    }
    const endDebtC = Object.fromEntries(['rearC', 'frontC', 'coreC', 'slabC']
      .map(key => [key, round(reference.state[key] - candidate.state[key])]));
    rows.push({ tariff: tariff.name, savingsStrategy, reason: planned.reason, forecastExtrapolation: planned.forecastExtrapolation ?? false,
      modeledTimingBenefitEur: round(planned.timingBenefitEur), modeledBenefitEur: round(planned.modelBenefitEur),
      simulatedBillDifferenceEur: round(totals.referenceCostEur - totals.candidateCostEur),
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])), horizonDebtC, endDebtC });
  }
  return { fixtureVersion: 'independent-garage-target-plant-v1', algorithm: model.algorithm,
    protectionVersion: garageSettings().protection.version, restorationDelayMs, standbyPowerKw: SIMULATED_STANDBY_KW,
    scope: 'Open-loop software simulation of a frozen plan with 24h extra recovery at 7c/kWh; residual mass debt remains explicit. No installed performance or realized savings claim.',
    training: { days, cadenceMinutes, ready: trained.ready, electricalReady: trained.electricalReady, validatedOffHours: trained.validatedOffHours },
    defaults: garageSettings(), runtimeMs: round(performance.now() - started), rows };
}
/** Causal target-control audit from untouched priors. Target reductions keep
 * native power ON and are excluded from native-OFF learning. This cannot create
 * clean OFF validation merely because compressor demand falls. Each opportunity
 * has a complete 24h plan and at least 32h before the next decision. */
export function runBootstrapAudit({ days = 42, cadenceMinutes = 5, parameters = {}, seed = 731,
  peakCents = 400, baseCents = 7, restorationDelayMs = SIMULATED_HEATING_RESPONSE_MS } = {}) {
  const started = performance.now(), plant = createPlant(parameters), random = randomSource(seed);
  // Extra protection reports must not consume the learner's existing noise
  // sequence. Both consumers use the same report at each learning boundary.
  const protectionRandom = randomSource(seed);
  const settings = garageSettings({ enabled: true, savingsStrategy: 'balanced',
    maxSensorAgeMs: Math.max(120_000, cadenceMinutes * 120_000), protection: { approved: true } });
  let model = createGarageModel({ seedAt: AUDIT_START, roomTargetC: 7 }), exposure = createGarageExposure(settings), planned = null;
  let previouslyReduced = false, recoveryUntil = 0, totalReducedHours = 0, reducedElectricityKwh = 0;
  const opportunities = [];
  for (let minute = 0; minute <= days * 1440; minute++) {
    const hour = minute / 60, at = AUDIT_START + minute * 60_000;
    const row = planned?.steps.find(step => step.start <= at && step.end > at);
    const demandReduced = row?.demandReduced === true;
    if (!demandReduced && previouslyReduced) recoveryUntil = at + 24 * HOUR;
    previouslyReduced = demandReduced;
    let input = { ...targetInputs(plant, hour, row), inputDisturbed: demandReduced || at < recoveryUntil,
      recovering: at < recoveryUntil, availableChangedAt: AUDIT_START };
    const learningReport = minute % cadenceMinutes === 0;
    const observation = observedPlant(plant, hour, input, learningReport ? random : protectionRandom);
    exposure = updateGarageExposure(exposure, observation, settings);
    if (learningReport) {
      model = updateGarageModel(model, observation, settings);
      if (minute >= 40 * 60 && (minute - 40 * 60) % (56 * 60) === 0) {
        const forecast = Array.from({ length: 24 }, (_, i) => ({ start: at + i * HOUR, end: at + (i + 1) * HOUR,
          outdoorC: outdoorAt(hour + i, plant.parameters), issuedAt: at }));
        const prices = Array.from({ length: 24 }, (_, i) => ({ start: at + i * HOUR, end: at + (i + 1) * HOUR,
          priceCtPerKwh: i < 4 ? peakCents : baseCents }));
        planned = planGarage({ now: at, model, exposure, observation, prices, forecast, settings, restorationDelayMs });
        const summary = garageModelSummary(model);
        opportunities.push({ day: round(hour / 24), ready: summary.ready, electricalReady: summary.electricalReady,
          validatedOffHours: round(summary.validatedOffHours), completedEpisodes: summary.validation.completedEpisodes,
          reason: planned.reason, forecastExtrapolation: planned.forecastExtrapolation ?? false,
          plannedReducedHours: round(planned.steps.reduce((sum, step) => sum + (step.demandReduced === true ? (step.end - step.start) / HOUR : 0), 0)),
          timingBenefitEur: round(planned.timingBenefitEur), evidence: planned.evidence ?? null });
        const selected = planned.steps[0];
        input = { ...targetInputs(plant, hour, selected),
          inputDisturbed: selected?.demandReduced === true || at < recoveryUntil,
          recovering: at < recoveryUntil, availableChangedAt: AUDIT_START };
        previouslyReduced = input.demandReduced;
      }
    }
    if (minute < days * 1440) {
      const energy = stepPlant(plant, input);
      totalReducedHours += input.demandReduced ? 1 / 60 : 0;
      reducedElectricityKwh += input.demandReduced ? energy : 0;
    }
  }
  const summary = garageModelSummary(model);
  return { algorithm: model.algorithm, days, cadenceMinutes, seed, parameters, peakCents, baseCents,
    protectionVersion: settings.protection.version, protectionCadenceMinutes: 1, restorationDelayMs,
    nativeSamples: model.native.samples, totalReducedHours: round(totalReducedHours),
    nativeOffHours: 0, reducedElectricityKwh: round(reducedElectricityKwh), standbyPowerKw: SIMULATED_STANDBY_KW,
    ready: summary.ready, electricalReady: summary.electricalReady, validatedOffHours: round(summary.validatedOffHours),
    validation: summary.validation, stateBytes: Buffer.byteLength(JSON.stringify(model)),
    runtimeMs: round(performance.now() - started), opportunities };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = process.argv.includes('--bootstrap') ? {
    scope: 'Causal software target-control audit from priors. Native power stays ON; reductions do not create OFF learning evidence or use future actual power.',
    metered: runBootstrapAudit(), activityOnly: runBootstrapAudit({ parameters: { activityOnly: true } }),
    booleanActivity: runBootstrapAudit({ parameters: { activityOnly: true, booleanActivity: true } }),
  } : runPlanningAudit();
  const index = process.argv.indexOf('--json');
  if (index >= 0) await writeFile(process.argv[index + 1], `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
