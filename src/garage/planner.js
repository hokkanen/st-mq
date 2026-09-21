import { garageSettings, GARAGE_PREFERENCE_VERSION } from './settings.js';
import { assessGarageProtection, projectGarageExposure, projectCurrentGarageExposure } from './protection.js';
import { predictGarageStep, garageModelSummary, GARAGE_MODEL_ASSUMPTIONS } from './model.js';
import { garagePlanningEvidence, garagePlanningMargins, garagePlanningEnergyUncertainty } from './planning-evidence.js';
import { garagePauseStartReason } from './door-state.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);

function horizon(now, prices, weather, config) {
  const rows = [], endAt = now + config.maxHorizonHours * HOUR;
  let at = now;
  const sorted = prices.map(p => ({ ...p, start: instant(p.start), end: instant(p.end) }))
    .filter(p => finite(p.start) && finite(p.end) && p.end > now).sort((a, b) => a.start - b.start);
  for (const price of sorted) {
    if (price.start > at || at >= endAt) break;
    if (price.end <= at) continue;
    const cents = price.priceCtPerKwh ?? price.allInCentsPerKWh ?? price.totalCtPerKwh ?? price.price;
    if (!finite(cents)) break;
    while (at < Math.min(price.end, endAt)) {
      const forecast = weather.find(w => instant(w.start) <= at && instant(w.end) > at && finite(w.outdoorC)
        && (w.issuedAt == null || instant(w.issuedAt) <= now) && (w.fetchedAt == null || instant(w.fetchedAt) <= now));
      if (!forecast) return rows;
      const end = Math.min(price.end, instant(forecast.end), at + config.stepMinutes * 60_000, endAt);
      if (end <= at) return rows;
      rows.push({ start: at, end, priceCtPerKwh: cents, outdoorC: forecast.outdoorC, available: true }); at = end;
    }
  }
  return rows;
}

/** One contiguous opportunity. Recovery is an explicit energy allowance, never
 * a thermostat boost or another OFF period before observed recovery. */
export function planGarage({ now, model, exposure, observation, settings = {}, prices = [], forecast = [],
  activeEpisode = null, restorationDelayMs = null } = {}) {
  const config = garageSettings(settings);
  if (!finite(now)) throw new Error('Garage planner requires numeric UTC time');
  const delayKnown = finite(restorationDelayMs) && restorationDelayMs >= 0;
  const protection = assessGarageProtection(exposure, { now, observation, settings: config, restorationDelayMs: delayKnown ? restorationDelayMs : 0 });
  const base = { at: now, state: 'normal', reason: 'normal-heating', nextAction: 'available', pauseUntil: null,
    pauseFrom: null, steps: [], timingBenefitEur: 0, modelBenefitEur: 0, heatDebt: null, uncertainty: null, protection,
    preferenceVersion: GARAGE_PREFERENCE_VERSION, algorithm: model?.algorithm, provisional: true };
  const stop = reason => ({ ...base, reason });
  if (!config.enabled) return stop('automatic-control-disabled');
  if (!delayKnown) return stop('heating-response-bound-unavailable');
  if (restorationDelayMs > config.maxHorizonHours * HOUR) return stop('heating-response-exceeds-planning-horizon');
  if (config.aggressiveness === 0) return stop('normal-heating-preference');
  if (!protection.safeToPause) return stop(protection.reasons[0] ?? 'protection-unavailable');
  const active = activeEpisode && !['completed', 'released', 'cancelled'].includes(activeEpisode.state);
  const admission = !active && (garagePauseStartReason(observation)
    || ([1, 2].some(id => observation?.[`ev${id}Kw`] > .1 || observation?.[`ev${id}Active`] === true)
      ? 'charging-heat-opportunity-uncertain' : null));
  if (admission) return stop(admission);
  if (!finite(observation?.rearC) || !finite(observation?.frontC)) return stop('thermal-state-unavailable');
  const summary = garageModelSummary(model), evidence = garagePlanningEvidence(model, summary, { now, observation, activeEpisode });
  if (!active && evidence.maxPauseHours <= 0) return { ...stop(evidence.reason), evidence };
  const steps = horizon(now, prices, forecast, config);
  const activeEnd = active ? activeEpisode.authorizedEndAt ?? activeEpisode.pauseUntil ?? activeEpisode.endpointAt : null;
  if (finite(activeEnd)) {
    const crossing = steps.findIndex(step => step.start < activeEnd && step.end > activeEnd);
    if (crossing >= 0) { const step = steps[crossing]; steps.splice(crossing, 1, { ...step, end: activeEnd }, { ...step, start: activeEnd }); }
  }
  if (steps.length < 2) return stop('insufficient-price-weather-horizon');
  const maximumPrice = Math.max(...steps.map(s => s.priceCtPerKwh));
  const minimumPrice = Math.min(...steps.map(s => s.priceCtPerKwh));
  if (!active && maximumPrice - minimumPrice <= 1e-9) return { ...stop('flat-prices-preserve-normal-warmth'), steps };
  const power = summary.electricity.normalPowerKw;
  if (!(power > .01)) return stop('no-native-heating-demand');
  // Do not assign avoided heating while observed air is already warmer than
  // its normal reference. Native ON alone does not establish a heat demand.
  if (!active && observation.rearC > model.normalReference.interceptC + .5
    && observation.frontC > model.normalReference.frontC + .5) return stop('no-native-heating-demand');
  const initial = { rearC: observation.rearC, frontC: observation.frontC,
    differenceC: observation.frontC - observation.rearC };
  const candidates = [];
  const existingEnd = active ? activeEpisode.authorizedEndAt ?? activeEpisode.pauseUntil ?? activeEpisode.endpointAt : null;
  const limitHours = Math.min(config.maxPauseHours, evidence.maxPauseHours);
  for (let from = 0; from < (active ? 1 : steps.length); from++) {
    let avoidedKwh = 0, avoidedCostEur = 0;
    for (let to = from; to < steps.length; to++) {
      const step = steps[to], duration = step.end - steps[from].start;
      if (active ? !finite(existingEnd) || step.end > existingEnd : duration > limitHours * HOUR + 1) break;
      const hours = (step.end - step.start) / HOUR;
      avoidedKwh += power * hours; avoidedCostEur += power * hours * step.priceCtPerKwh / 100;
      if (!active && duration < config.minOffMs) continue;
      // Protection needs actual forecast coverage through useful-heat return.
      // A truncated outlook cannot establish that the final weather persists.
      if (step.end + restorationDelayMs > steps.at(-1).end) continue;
      // An ongoing pause may end early for economics or protection, but cannot
      // move its original endpoint. Minimum OFF never delays restoration.
      const recoveryHours = Math.max(GARAGE_MODEL_ASSUMPTIONS.recoveryTimeHours, config.minOnMs / HOUR);
      let covered = 0, weightedPrice = 0;
      for (let i = to + 1; i < steps.length && covered < recoveryHours; i++) {
        const h = Math.min(recoveryHours - covered, (steps[i].end - steps[i].start) / HOUR);
        weightedPrice += h * steps[i].priceCtPerKwh; covered += h;
      }
      weightedPrice += Math.max(0, recoveryHours - covered) * Math.max(0, maximumPrice);
      const recoveryPrice = weightedPrice / recoveryHours / 100;
      const recoveryKwh = avoidedKwh * GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor;
      // Negative recovery prices must not reward deliberately wasting more heat.
      const recoveryCostEur = recoveryKwh * Math.max(0, recoveryPrice);
      const uncertain = garagePlanningEnergyUncertainty(model, summary, duration / HOUR);
      const uncertaintyEur = uncertain.kwh * Math.max(0, maximumPrice - minimumPrice) / 100
        + uncertain.recoveryKwh * Math.max(0, recoveryPrice);
      const net = avoidedCostEur - recoveryCostEur - uncertaintyEur;
      if (net <= (active ? 0 : config.minSavingsEur)) continue;
      candidates.push({ from, to, duration, avoidedKwh, avoidedCostEur, recoveryKwh, recoveryCostEur,
        uncertaintyEur, uncertaintyBasis: uncertain.basis, net });
    }
  }
  candidates.sort((a, b) => b.net - a.net || a.duration - b.duration || a.from - b.from);
  if (!candidates.length) return { ...stop('benefit-below-minimum-saving'), evidence };
  for (const candidate of candidates) {
    let state = initial, reserve = projectCurrentGarageExposure(exposure, observation, now, config), safe = true;
    const path = [];
    const until = steps[candidate.to].end + restorationDelayMs;
    let at = now, index = 0;
    while (at < until) {
      const step = steps[index] ?? { outdoorC: steps.at(-1).outdoorC, end: until, priceCtPerKwh: maximumPrice };
      const end = Math.min(until, step.end, at + config.stepMinutes * 60_000);
      if (end <= at) { index++; continue; }
      const isOff = at >= steps[candidate.from].start;
      // Continue cooling throughout the useful-heating delay. Future charger
      // heat never contributes to protection or the permission endpoint.
      const next = predictGarageStep(model, state, { outdoorC: step.outdoorC, available: !isOff }, (end - at) / HOUR);
      const margin = garagePlanningMargins(summary, (end - now) / HOUR);
      const projected = projectGarageExposure(reserve, { at: end, rearAt: end, frontAt: end,
        rearC: next.rearC - margin.rearC, frontC: next.frontC - margin.frontC }, config);
      if (projected.interventionAt !== null || ['rear', 'front'].some(location => projected.exposure.locations[location].uncertain)) {
        safe = false; break;
      }
      reserve = projected.exposure; state = next.state;
      path.push({ ...step, start: at, end, at: end, ...next, available: !isOff || at >= steps[candidate.to].end,
        rearLowerC: next.rearC - margin.rearC, frontLowerC: next.frontC - margin.frontC,
        phase: !isOff ? 'normal' : at >= steps[candidate.to].end ? 'restoration-delay' : 'pause' });
      at = end; if (at >= step.end) index++;
    }
    if (!safe) continue;
    const immediate = candidate.from === 0, trial = !summary.thermalReady || candidate.duration / HOUR > evidence.economicHours;
    return { ...base, state: immediate ? 'paused-plan' : 'waiting', evidence, learningTrial: active ? activeEpisode.plan?.learningTrial ?? trial : trial,
      reason: immediate ? active ? 'continue-authorized-economic-episode' : trial ? 'bounded-learning-trial' : 'credible-price-timing-opportunity'
        : 'wait-for-later-price-opportunity', nextAction: immediate ? active ? 'renew' : 'pause' : 'available',
      pauseFrom: steps[candidate.from].start, pauseUntil: immediate ? steps[candidate.to].end : null,
      plannedPauseUntil: steps[candidate.to].end, nextOpportunityAt: steps[candidate.from].start, steps: path,
      timingBenefitEur: candidate.avoidedCostEur - candidate.recoveryCostEur,
      modelBenefitEur: candidate.avoidedCostEur - candidate.recoveryCostEur, scoreEur: candidate.net,
      avoidedKwh: candidate.avoidedKwh, recoveryKwh: candidate.recoveryKwh, recoveryCostEur: candidate.recoveryCostEur,
      uncertainty: { amountEur: candidate.uncertaintyEur, decisionDeductionEur: candidate.uncertaintyEur,
        method: candidate.uncertaintyBasis, electricityBasis: summary.electricity.basis },
      horizonEndAt: steps.at(-1).end };
  }
  return { ...stop('forecast-protection-requires-heating'), evidence };
}
