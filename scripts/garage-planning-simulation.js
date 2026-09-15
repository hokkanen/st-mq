#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { planGarage } from '../src/garage/planner.js';
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
const PRICES = [
  { name: 'flat', values: Array(24).fill(7) },
  { name: 'mild-peak', values: Array.from({ length: 24 }, (_, i) => i >= 6 && i < 10 ? 12 : 7) },
  { name: 'ordinary-peak', values: Array.from({ length: 24 }, (_, i) => i >= 6 && i < 10 ? 40 : 7) },
  { name: 'two-peaks', values: Array.from({ length: 24 }, (_, i) => i >= 4 && i < 7 || i >= 15 && i < 18 ? 40 : 7) },
];
export function runPlanningAudit({ days = 43, cadenceMinutes = 5, parameters = {}, restorationDelayMs = SIMULATED_HEATING_RESPONSE_MS } = {}) {
  const started = performance.now();
  const trained = runScenario({ days, cadenceMinutes, parameters, offDurations: [], includeSnapshot: true });
  const { model, plant, observation } = trained.snapshot, now = observation.at, hour = (now - AUDIT_START) / HOUR;
  const forecast = Array.from({ length: 24 }, (_, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR,
    outdoorC: outdoorAt(hour + i, plant.parameters), issuedAt: now }));
  const rows = [];
  for (const tariff of PRICES) for (const aggressiveness of [0, 25, 50, 75, 100]) {
    const settings = garageSettings({ enabled: true, aggressiveness, protection: { approved: true } });
    // This frozen comparison starts with explicitly warm synthetic reference
    // objects. It does not infer installed pipe warmth from one air report.
    const exposure = knownGarageReserve(settings, { at: now, rearC: plant.state.rearC, frontC: plant.state.frontC,
      rearAirC: observation.rearC, frontAirC: observation.frontC });
    const prices = tariff.values.map((value, i) => ({ start: now + i * HOUR, end: now + (i + 1) * HOUR, priceCtPerKwh: value }));
    const planned = planGarage({ now, model, observation, exposure, prices, forecast, settings, restorationDelayMs });
    const candidate = structuredClone(plant), reference = structuredClone(plant);
    const totals = { candidateKwh: 0, referenceKwh: 0, candidateCostEur: 0, referenceCostEur: 0,
      offHours: 0, coolingDegreeHours: 0, minimumRearC: Infinity, minimumFrontC: Infinity };
    let horizonDebtC = null;
    for (let minute = 0; minute < 48 * 60; minute++) {
      const at = now + minute * 60_000;
      const row = minute < 24 * 60 ? planned.steps.find(step => step.start <= at && step.end > at) : null;
      const available = row?.available !== false;
      const candidateEnergy = stepPlant(candidate, plantInputs(candidate, hour + minute / 60, { available, disturbance: false }));
      const referenceEnergy = stepPlant(reference, plantInputs(reference, hour + minute / 60, { available: true, disturbance: false }));
      const cents = minute < 24 * 60 ? tariff.values[Math.floor(minute / 60)] : 7;
      totals.candidateKwh += candidateEnergy; totals.referenceKwh += referenceEnergy;
      totals.candidateCostEur += candidateEnergy * cents / 100; totals.referenceCostEur += referenceEnergy * cents / 100;
      totals.offHours += available ? 0 : 1 / 60;
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
    rows.push({ tariff: tariff.name, aggressiveness, reason: planned.reason, learningTrial: planned.learningTrial ?? false,
      modeledTimingBenefitEur: round(planned.timingBenefitEur), modeledBenefitEur: round(planned.modelBenefitEur),
      simulatedBillDifferenceEur: round(totals.referenceCostEur - totals.candidateCostEur),
      ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])), horizonDebtC, endDebtC });
  }
  return { fixtureVersion: 'independent-garage-plant-v1', algorithm: model.algorithm,
    protectionVersion: garageSettings().protection.version, restorationDelayMs,
    scope: 'Open-loop software simulation of a frozen plan with 24h extra recovery at 7c/kWh; residual mass debt remains explicit. No installed performance or realized savings claim.',
    training: { days, cadenceMinutes, ready: trained.ready, electricalReady: trained.electricalReady, maxPauseHours: trained.maxPauseHours },
    defaults: garageSettings(), runtimeMs: round(performance.now() - started), rows };
}
/** Causal bootstrap: the planner's own choices are the only source of OFF data.
 * Each isolated opportunity has a complete 24h plan and at least 32h of normal
 * continuation before the next decision. This tests learning/control economics,
 * not the external adapter's native lease or acknowledgements. */
export function runBootstrapAudit({ days = 42, cadenceMinutes = 5, parameters = {}, seed = 731,
  peakCents = 40, baseCents = 7, restorationDelayMs = SIMULATED_HEATING_RESPONSE_MS } = {}) {
  const started = performance.now(), plant = createPlant(parameters), random = randomSource(seed);
  // Extra protection reports must not consume the learner's existing noise
  // sequence. Both consumers use the same report at each learning boundary.
  const protectionRandom = randomSource(seed);
  const settings = garageSettings({ enabled: true, aggressiveness: 50,
    maxSensorAgeMs: Math.max(120_000, cadenceMinutes * 120_000), protection: { approved: true } });
  let model = createGarageModel({ seedAt: AUDIT_START }), exposure = createGarageExposure(settings), planned = null;
  let previousAvailable = true, availableChangedAt = AUDIT_START, totalOffHours = 0;
  const opportunities = [];
  for (let minute = 0; minute <= days * 1440; minute++) {
    const hour = minute / 60, at = AUDIT_START + minute * 60_000;
    const row = planned?.steps.find(step => step.start <= at && step.end > at);
    let available = row?.available !== false;
    if (available !== previousAvailable) { availableChangedAt = at; previousAvailable = available; }
    let input = { ...plantInputs(plant, hour, { available }), managedPause: !available,
      recovering: row?.phase === 'recovery', availableChangedAt };
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
          maxPauseHours: round(summary.maxPauseHours), completedEpisodes: summary.validation.completedEpisodes,
          reason: planned.reason, learningTrial: planned.learningTrial ?? false,
          plannedOffHours: round(planned.steps.reduce((sum, step) => sum + (step.available === false ? (step.end - step.start) / HOUR : 0), 0)),
          timingBenefitEur: round(planned.timingBenefitEur), evidence: planned.evidence ?? null });
        available = planned.steps[0]?.available !== false;
        if (available !== previousAvailable) { availableChangedAt = at; previousAvailable = available; }
        input = { ...plantInputs(plant, hour, { available }), managedPause: !available, availableChangedAt };
      }
    }
    if (minute < days * 1440) { stepPlant(plant, input); totalOffHours += available ? 0 : 1 / 60; }
  }
  const summary = garageModelSummary(model);
  return { algorithm: model.algorithm, days, cadenceMinutes, seed, parameters, peakCents, baseCents,
    protectionVersion: settings.protection.version, protectionCadenceMinutes: 1, restorationDelayMs,
    nativeSamples: model.native.samples, totalOffHours: round(totalOffHours),
    ready: summary.ready, electricalReady: summary.electricalReady, maxPauseHours: round(summary.maxPauseHours),
    validation: summary.validation, stateBytes: Buffer.byteLength(JSON.stringify(model)),
    runtimeMs: round(performance.now() - started), opportunities };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = process.argv.includes('--bootstrap') ? {
    scope: 'Causal software bootstrap from priors, with no manually supplied OFF evidence or future actual power.',
    metered: runBootstrapAudit(), activityOnly: runBootstrapAudit({ parameters: { activityOnly: true } }),
    booleanActivity: runBootstrapAudit({ parameters: { activityOnly: true, booleanActivity: true } }),
  } : runPlanningAudit();
  const index = process.argv.indexOf('--json');
  if (index >= 0) await writeFile(process.argv[index + 1], `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
