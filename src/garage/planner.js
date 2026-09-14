import { garageSettings, garageWarmthPrice, GARAGE_PREFERENCE_VERSION } from './settings.js';
import { createGarageExposure, updateGarageExposure, assessGarageProtection } from './protection.js';
import { forecastGarage, predictGarageStep, knownGarageEvAt, normalGarageTemperature, garageModelSummary } from './model.js';
import { garagePlanningEvidence, garagePlanningMargins, garagePlanningEnergyUncertainty } from './planning-evidence.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const copy = value => structuredClone(value);
const weights = [0, .003, .012, .035, .1];

function horizon(now, prices, weather, config) {
  const rows = [], endAt = now + config.maxHorizonHours * HOUR;
  let at = now;
  const sorted = prices.filter(p => finite(p.start) && finite(p.end) && p.end > now).sort((a, b) => a.start - b.start);
  for (const price of sorted) {
    if (price.start > at || at >= endAt) break;
    if (price.end <= at) continue;
    const cents = price.priceCtPerKwh ?? price.allInCentsPerKWh ?? price.totalCtPerKwh ?? price.price;
    if (!finite(cents)) break;
    while (at < Math.min(price.end, endAt)) {
      const forecast = weather.find(w => w.start <= at && w.end > at && finite(w.outdoorC)
        && (w.issuedAt == null || w.issuedAt <= now) && (w.fetchedAt == null || w.fetchedAt <= now));
      if (!forecast) return rows;
      const end = Math.min(price.end, forecast.end, at + config.stepMinutes * 60_000, endAt);
      if (end <= at) return rows;
      rows.push({ start: at, end, priceCtPerKwh: cents, outdoorC: forecast.outdoorC, available: true });
      at = end;
    }
  }
  return rows;
}
function debt(reference, state, model) {
  const rearC = Math.max(0, reference.rearC - state.rearC), coreC = Math.max(0, reference.coreC - state.coreC);
  const frontC = Math.max(0, reference.frontC - state.frontC);
  // Explicit effective heat-equivalent debt. Core degrees are not measured kWh.
  // Doubling core burden is a fixed conservative terminal assumption in v1.
  const effectiveKwh = (rearC + 2 * coreC + .4 * frontC) / Math.max(.1, model.rear.values[2]);
  return { rearC, frontC, coreC, effectiveKwh, basis: 'modeled-terminal-heat-equivalent-not-measured-storage' };
}
function rank(node, lambda) { return node.timing - lambda * node.cooling - node.transitions * .001 - node.debtPenalty - node.uncertainty; }
function paretoBeam(nodes) {
  // Fixed candidate search independent of the slider. The final linear preference
  // over this same set makes increased aggressiveness monotonically relax warmth.
  const chosen = new Set();
  for (const weight of weights) {
    const ranked = [...nodes].sort((a, b) => rank(b, weight) - rank(a, weight) || a.transitions - b.transitions || a.cooling - b.cooling);
    const cells = new Set();
    for (const node of ranked) {
      const dwellHours = ((node.path.at(-1)?.end ?? node.changedAt) - node.changedAt) / HOUR;
      const key = [node.available, Math.round(node.state.rearC * 4), Math.round(node.state.coreC * 10),
        Math.round(node.state.frontC * 4), Math.min(4, node.transitions), node.trial, node.offPeriods,
        Math.round(Math.min(6, dwellHours) * 4), Math.round(node.cycleOffHours * 4),
        Math.round(Math.min(4, node.cycleRecoveryHours) * 4)].join(':');
      if (cells.has(key)) continue;
      cells.add(key); chosen.add(node);
      if (cells.size >= 7) break;
    }
  }
  return [...chosen];
}

/** Bounded, joint whole-outlook search of native availability schedules. Always
 * models preparation, OFF, recovery and residual debt. No temperature boost. */
export function planGarage({ now, model, exposure, observation, settings = {}, prices = [], forecast = [],
  knownEvPlans = [], activeEpisode = null, referenceInitialState = null, restorationDelayMs = 10 * 60_000 } = {}) {
  const config = garageSettings(settings);
  if (!finite(now)) throw new Error('Garage planner requires numeric UTC time');
  const protection = assessGarageProtection(exposure, { now, observation, settings: config, restorationDelayMs });
  const base = { at: now, state: 'normal', reason: 'normal-heating', nextAction: 'available', pauseUntil: null,
    steps: [], timingBenefitEur: 0, modelBenefitEur: 0, heatDebt: null, uncertainty: null, protection,
    preferenceVersion: GARAGE_PREFERENCE_VERSION, algorithm: model?.algorithm, provisional: true };
  const stop = reason => ({ ...base, reason });
  if (!config.enabled) return stop('automatic-control-disabled');
  if (config.aggressiveness === 0) return stop('normal-heating-preference');
  if (!protection.safeToPause) return stop(protection.reasons[0] ?? 'protection-unavailable');
  const summary = garageModelSummary(model);
  const evidence = garagePlanningEvidence(model, summary, { now, observation, stepMinutes: config.stepMinutes, activeEpisode });
  if (evidence.maxPauseHours <= 0) return { ...stop(evidence.reason), evidence };
  if (!finite(model.state.coreC) || !finite(observation?.rearC) || !finite(observation?.frontC)) return stop('thermal-state-unavailable');
  const steps = horizon(now, prices, forecast, config);
  if (steps.length < 4 || steps.at(-1).end - now < 2 * HOUR) return stop('insufficient-price-weather-horizon');
  const minPrice = Math.min(...steps.map(s => s.priceCtPerKwh)), maxPrice = Math.max(...steps.map(s => s.priceCtPerKwh));
  if (maxPrice - minPrice <= 1e-9) return { ...stop('flat-prices-preserve-normal-warmth'), steps };
  const initial = { ...model.state, rearC: observation.rearC, frontC: observation.frontC,
    differenceC: observation.frontC - observation.rearC };
  const reference = forecastGarage(model, { now, initial, steps, settings: config, knownEvPlans });
  // Outstanding host accounting keeps its original frozen normal trajectory.
  // Dispatch compares future choices against ON continuation from the same actual
  // state: savings already earned and unavoidable existing debt are not new gains.
  const obligationReference = referenceInitialState
    ? forecastGarage(model, { now, initial: referenceInitialState, steps, settings: config, knownEvPlans }) : reference;
  if (reference.electricityKwh <= .001) return stop('no-native-heating-demand');
  const normalAtEnd = normalGarageTemperature(model, steps.at(-1).outdoorC);
  if (reference.state.rearC < normalAtEnd - 1 && reference.state.coreC < normalAtEnd - 1)
    return { ...stop('normal-heating-capacity-limited'), steps: reference.points };
  const averagePrice = reference.costEur / reference.electricityKwh; // EUR/kWh
  // Unknown continuation prices never become an assumed cheap recovery window.
  const terminalPrice = Math.max(.01, maxPrice / 100, ...steps.slice(-8).map(s => s.priceCtPerKwh / 100));
  const initialExposure = updateGarageExposure(exposure ?? createGarageExposure(config), { ...observation, at: now }, config);
  const active = activeEpisode && !['completed', 'released', 'cancelled'].includes(activeEpisode.state);
  const existingEnd = active ? activeEpisode.authorizedEndAt ?? activeEpisode.pauseUntil ?? activeEpisode.endpointAt : null;
  const initialAvailable = active ? false : observation.available !== false;
  const pauseStartedAt = activeEpisode?.pauseStartedAt ?? activeEpisode?.startedAt ?? observation.availableChangedAt ?? now;
  let beam = [{ state: initial, robustState: copy(initial), exposure: initialExposure,
    available: initialAvailable, changedAt: initialAvailable ? observation.availableChangedAt ?? now - config.minOnMs
      : pauseStartedAt,
      electricityKwh: 0, costEur: 0, timing: 0, cooling: 0, transitions: 0, debtPenalty: 0,
      uncertainty: 0, offHours: 0, offPeriods: initialAvailable ? 0 : 1, trial: false,
      cycleOffHours: initialAvailable ? 0 : Math.max(0, (now - pauseStartedAt) / HOUR), cycleRecoveryHours: 0,
      cycleRearC: initial.rearC, cycleFrontC: initial.frontC, cycleOutdoorC: observation.outdoorC,
      rearDropC: 0, frontDropC: 0, path: [] }];
  const engineering = { ...config, maxSensorAgeMs: 4 * HOUR };
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i], ref = reference.points[i], hours = (step.end - step.start) / HOUR, nodes = [];
    for (const node of beam) {
      for (const available of [true, false]) {
        const switching = available !== node.available;
        if (switching && available && step.start - node.changedAt < config.minOffMs) continue;
        if (switching && !available && step.start - node.changedAt < config.minOnMs) continue;
        if (active && switching && !available) continue;
        if (!available && active && finite(existingEnd) && step.end > existingEnd) continue;
        const pauseHours = !available ? (step.end - (switching ? step.start : node.changedAt)) / HOUR : 0;
        if (!available && pauseHours > evidence.maxPauseHours + 1e-9) continue;
        const trial = node.trial || !available && pauseHours > evidence.economicHours + 1e-9;
        const offPeriods = node.offPeriods + Number(switching && !available);
        // A learning trial is one experiment with its recovery, rather than many
        // short pauses whose aggregate exposure bypasses the supported duration.
        if (trial && offPeriods > 1) continue;
        if (evidence.economicHours < 2 && offPeriods > 1) continue;
        let cycleOffHours = node.cycleOffHours + (available ? 0 : hours);
        if (!available && cycleOffHours > evidence.maxPauseHours + 1e-9) continue;
        const ev = knownGarageEvAt(knownEvPlans, step.start, now);
        const next = predictGarageStep(model, node.state, { outdoorC: step.outdoorC, available,
          restart: available && switching, ...ev }, hours);
        // Protection and renewed duration allowance cannot spend forecast EV
        // warmth: either charger can cancel after this decision.
        const robust = predictGarageStep(model, node.robustState, { outdoorC: step.outdoorC, available,
          restart: available && switching, ev1Kw: 0, ev2Kw: 0 }, hours);
        const startingCycle = !available && node.cycleOffHours === 0;
        const cycleRearC = startingCycle ? node.robustState.rearC : node.cycleRearC;
        const cycleFrontC = startingCycle ? node.robustState.frontC : node.cycleFrontC;
        const cycleOutdoorC = startingCycle ? step.outdoorC : node.cycleOutdoorC;
        const outdoorChange = step.outdoorC - cycleOutdoorC;
        const rearShift = model.normalReference.outdoorSlope * outdoorChange;
        const frontShift = rearShift + model.front.values[1] / model.front.values[0] * (outdoorChange - rearShift);
        const rearDropC = Math.max(startingCycle ? 0 : node.rearDropC, cycleRearC + rearShift - robust.rearC);
        const frontDropC = Math.max(startingCycle ? 0 : node.frontDropC, cycleFrontC + frontShift - robust.frontC);
        let cycleRecoveryHours = available && cycleOffHours > 0 ? node.cycleRecoveryHours + hours : 0;
        if (available && cycleOffHours > 0 && cycleRecoveryHours + 1e-9 >= Math.max(.5, Math.min(cycleOffHours, 4))
          && robust.rearC >= cycleRearC + rearShift - Math.min(.2, Math.max(.05, .25 * rearDropC))
          && robust.frontC >= cycleFrontC + frontShift - Math.min(.3, Math.max(.05, .25 * frontDropC))) {
          cycleOffHours = 0; cycleRecoveryHours = 0;
        }
        const margins = garagePlanningMargins(summary, (step.end - now) / HOUR);
        const rearMargin = margins.rearC, frontMargin = margins.frontC;
        const projected = updateGarageExposure(node.exposure, { at: step.end,
          rearC: robust.rearC - rearMargin, frontC: robust.frontC - frontMargin }, engineering);
        const nearLimit = ['rear', 'front'].some(location => {
          const local = projected.locations[location], rate = Math.max(0, config.protection.floorC - local.lastC);
          return local.lastC <= config.protection.hardMinimumC || local.degreeMinutes
            + rate * restorationDelayMs / 60_000 >= config.protection.budgetDegreeMinutes || local.uncertain;
        });
        if (nearLimit && !available) continue;
        if (trial && !available && (robust.rearC - rearMargin < Math.max(config.protection.floorC + 1, initial.rearC - evidence.trialCoolingLimitC)
          || robust.frontC - frontMargin < Math.max(config.protection.floorC + 1, initial.frontC - evidence.trialCoolingLimitC))) continue;
        // Returning native availability does not instantly restore local allowance.
        if (!available && switching && ['rear', 'front'].some(location =>
          node.exposure.locations[location].degreeMinutes > config.protection.budgetDegreeMinutes * .8)) continue;
        const electricityKwh = node.electricityKwh + next.electricityKwh;
        const costEur = node.costEur + next.electricityKwh * step.priceCtPerKwh / 100;
        const cooling = node.cooling + hours * (Math.max(0, ref.coreC - next.coreC)
          + .5 * Math.max(0, ref.rearC - next.rearC) + .25 * Math.max(0, ref.frontC - next.frontC));
        const thermalDebt = debt(obligationReference.points[i].state, next.state, model);
        const continuationDebt = debt(obligationReference.points[i].state, ref.state, model);
        const additionalDebtKwh = Math.max(0, thermalDebt.effectiveKwh - continuationDebt.effectiveKwh);
        const offHours = node.offHours + (available ? 0 : hours);
        const energyUncertainty = garagePlanningEnergyUncertainty(model, summary, offHours);
        const modeledUncertainty = energyUncertainty.kwh * (maxPrice - minPrice) / 100;
        const timing = electricityKwh * averagePrice - costEur;
        // A small calibration experiment has an explicit exploration allowance:
        // an unqualified electricity prior cannot veto every opportunity to
        // learn. Retain its full error estimate for disclosure, but charge at
        // most half positive modeled timing in a bounded single trial. Thermal
        // limits, warmth cost and debt still apply; this is not economic validation.
        const uncertainty = active ? 0 : trial && !evidence.electricalReady
          ? Math.min(modeledUncertainty, .5 * Math.max(0, timing)) : modeledUncertainty;
        nodes.push({ state: next.state, robustState: robust.state, exposure: projected, available,
          changedAt: switching ? step.start : node.changedAt, electricityKwh, costEur,
          timing, cooling,
          transitions: node.transitions + (switching && !(active && node.transitions === 0 && available) ? 1 : 0),
          debtPenalty: additionalDebtKwh * Math.max(.01, terminalPrice - averagePrice) * (i === steps.length - 1 ? 1 : .2),
          uncertainty, modeledUncertainty, uncertaintyBasis: energyUncertainty.basis, offHours, offPeriods, trial,
          cycleOffHours, cycleRecoveryHours, cycleRearC, cycleFrontC, cycleOutdoorC, rearDropC, frontDropC,
          path: [...node.path, { ...step, available, ...next,
            rearLowerC: robust.rearC - rearMargin, frontLowerC: robust.frontC - frontMargin }] });
      }
    }
    if (!nodes.length) return { ...stop('forecast-protection-requires-heating'), steps: reference.points };
    beam = paretoBeam(nodes);
  }
  const lambda = garageWarmthPrice(config.aggressiveness);
  const referenceTiming = reference.electricityKwh * averagePrice - reference.costEur;
  const candidates = beam.map(node => ({ ...node, netScore: rank(node, lambda) - referenceTiming }));
  const selected = candidates.sort((a, b) => b.netScore - a.netScore || a.transitions - b.transitions || a.cooling - b.cooling)[0];
  if (!selected || selected.offHours === 0 || selected.netScore <= 1e-8)
    return { ...stop('benefit-below-warmth-or-prediction-resolution'), steps: reference.points,
      uncertainty: { method: 'episode-or-native-energy-error-times-price-spread', electricityBasis: reference.points[0].electricityBasis } };
  const finalDebt = debt(obligationReference.state, selected.state, model);
  const continuationDebt = debt(obligationReference.state, reference.state, model);
  const additionalDebtKwh = Math.max(0, finalDebt.effectiveKwh - continuationDebt.effectiveKwh);
  let firstOff = selected.path.findIndex(row => row.available === false), offEnd = firstOff;
  while (offEnd + 1 < selected.path.length && selected.path[offEnd + 1].available === false) offEnd++;
  const immediate = firstOff === 0;
  const pauseUntil = immediate ? selected.path[offEnd].end : null;
  const allOff = selected.path.map((row, i) => !row.available ? i : -1).filter(i => i >= 0), lastOff = allOff.at(-1);
  const planned = selected.path.map((row, i) => ({ ...row, phase: !row.available ? 'pause'
    : i < firstOff ? 'preparation' : i > lastOff ? 'recovery' : 'continuation' }));
  // Quantity effects belong to the model estimate only. The timing estimate uses
  // the candidate's same energy at the reference's average price, exactly zero
  // on a constant-price horizon, before conservative residual recovery liability.
  const timingBenefitEur = selected.timing - referenceTiming - selected.debtPenalty;
  return { ...base, state: immediate ? 'paused-plan' : 'preparation', evidence, learningTrial: selected.trial,
    reason: selected.trial ? immediate ? active ? 'continue-bounded-learning-trial' : 'bounded-learning-trial' : 'prepare-for-bounded-learning-trial'
      : immediate ? active ? 'continue-authorized-economic-episode' : 'credible-price-timing-opportunity' : 'prepare-for-later-price-opportunity',
    nextAction: immediate ? active ? 'renew' : 'pause' : 'available', pauseUntil, steps: planned,
    timingBenefitEur, modelBenefitEur: reference.costEur - selected.costEur - additionalDebtKwh * terminalPrice,
    heatDebt: finalDebt, continuationDebt, coolingDegreeHours: selected.cooling, scoreEur: selected.netScore,
    uncertainty: { amountEur: selected.modeledUncertainty, decisionDeductionEur: selected.uncertainty,
      explorationAllowance: selected.trial && !evidence.electricalReady, method: selected.uncertaintyBasis,
      electricityBasis: planned[0].electricityBasis, terminalPriceEurPerKwh: terminalPrice },
    reference: { electricityKwh: reference.electricityKwh, costEur: reference.costEur, state: reference.state },
    obligationReference: { state: obligationReference.state, basis: referenceInitialState ? 'frozen-host-normal-reference' : 'current-normal-reference' },
    candidate: { electricityKwh: selected.electricityKwh, costEur: selected.costEur, state: selected.state },
    nextOpportunityAt: planned[firstOff].start, horizonEndAt: steps.at(-1).end };
}
