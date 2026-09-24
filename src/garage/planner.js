import { garageSettings, garageSavingsPreference, GARAGE_PREFERENCE_VERSION } from './settings.js';
import { assessGarageProtection, projectGarageExposure, projectCurrentGarageExposure } from './protection.js';
import { predictGarageStep, garageModelSummary, GARAGE_MODEL_ASSUMPTIONS, garageRecoveryHours } from './model.js';
import { garagePlanningEvidence, garagePlanningMargins, garagePlanningEnergyUncertainty } from './planning-evidence.js';
import { garagePauseStartReason } from './door-state.js';
const HOUR = 3_600_000, finite = Number.isFinite;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const validTime = value => finite(value) && Math.abs(value) <= 8.64e15;

function horizon(now, prices, weather, config) {
  const rows = [];
  let at = now;
  const sorted = prices.map(p => ({ ...p, start: instant(p.start), end: instant(p.end) }))
    .filter(p => validTime(p.start) && validTime(p.end) && p.end > now).sort((a, b) => a.start - b.start);
  const outlook = weather.map(w => ({ ...w, start: instant(w.start), end: instant(w.end) }))
    .filter(w => validTime(w.start) && validTime(w.end) && finite(w.outdoorC)
      && (w.issuedAt == null || instant(w.issuedAt) <= now) && (w.fetchedAt == null || instant(w.fetchedAt) <= now));
  for (const price of sorted) {
    if (price.start > at) break;
    if (price.end <= at) continue;
    const cents = price.priceCtPerKwh ?? price.allInCentsPerKWh ?? price.totalCtPerKwh ?? price.price;
    if (!finite(cents)) break;
    while (at < price.end) {
      const forecast = outlook.find(w => w.start <= at && w.end > at);
      if (!forecast) return rows;
      const end = Math.min(price.end, forecast.end, at + config.stepMinutes * 60_000);
      if (end <= at) return rows;
      rows.push({ start: at, end, priceCtPerKwh: cents, outdoorC: forecast.outdoorC, available: true }); at = end;
    }
  }
  return rows;
}

// Price an arbitrary recovery window without scanning the outlook for every
// possible pause. Unpublished recovery hours use the highest known price.
function recoveryPrices(steps, maximumPrice) {
  const totals = [0], endAt = steps.at(-1).end;
  for (const step of steps) totals.push(totals.at(-1) + (step.end - step.start) / HOUR * step.priceCtPerKwh);
  const integral = at => {
    if (at >= endAt) return totals.at(-1) + (at - endAt) / HOUR * Math.max(0, maximumPrice);
    let low = 0, high = steps.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (steps[middle].end <= at) low = middle + 1; else high = middle;
    }
    return totals[low] + (at - steps[low].start) / HOUR * steps[low].priceCtPerKwh;
  };
  return (at, hours) => Math.max(0, (integral(at + hours * HOUR) - integral(at)) / hours / 100);
}

/** One contiguous opportunity. No configured maximum duration: uncertainty,
 * copper-pipe reserve, available forecasts and whole-cycle economics determine
 * its endpoint. That endpoint cannot move later once the episode has started. */
export function planGarage({ now, model, exposure, observation, settings = {}, prices = [], forecast = [],
  activeEpisode = null, scheduledOpportunity = null, restorationDelayMs = null } = {}) {
  const config = garageSettings(settings), preference = garageSavingsPreference(config);
  if (!validTime(now)) throw new Error('Garage planner requires numeric UTC time');
  const delayKnown = finite(restorationDelayMs) && restorationDelayMs >= 0;
  const protection = assessGarageProtection(exposure, { now, observation, settings: config, restorationDelayMs: delayKnown ? restorationDelayMs : 0 });
  const base = { at: now, state: 'normal', reason: 'normal-heating', nextAction: 'available', pauseUntil: null,
    pauseFrom: null, steps: [], timingBenefitEur: 0, modelBenefitEur: 0, heatDebt: null, uncertainty: null, protection,
    preferenceVersion: GARAGE_PREFERENCE_VERSION, algorithm: model?.algorithm, provisional: true };
  const stop = reason => ({ ...base, reason });
  if (!config.enabled) return stop('automatic-control-disabled');
  if (!delayKnown) return stop('heating-response-bound-unavailable');
  if (!protection.safeToPause) return stop(protection.reasons[0] ?? 'protection-unavailable');
  const active = activeEpisode && !['completed', 'released', 'cancelled'].includes(activeEpisode.state);
  const scheduled = !active && scheduledOpportunity;
  if (scheduled && (scheduled.preferenceVersion !== GARAGE_PREFERENCE_VERSION
    || !validTime(scheduled.pauseFrom) || !validTime(scheduled.plannedPauseUntil)
    || scheduled.plannedPauseUntil <= scheduled.pauseFrom))
    throw new Error('Unsupported Garage scheduled opportunity');
  const admission = !active && (garagePauseStartReason(observation)
    || ([1, 2].some(id => observation?.[`ev${id}Kw`] > .1 || observation?.[`ev${id}Active`] === true)
      ? 'charging-heat-opportunity-uncertain' : null));
  if (admission) return stop(admission);
  if (!finite(observation?.rearC) || !finite(observation?.frontC)) return stop('thermal-state-unavailable');
  const summary = garageModelSummary(model), evidence = garagePlanningEvidence(model, summary, { now, observation, activeEpisode });
  if (!active && !evidence.eligible) return { ...stop(evidence.reason), evidence };
  const steps = horizon(now, prices, forecast, config);
  const activeEnd = active ? activeEpisode.authorizedEndAt ?? activeEpisode.pauseUntil ?? activeEpisode.endpointAt : null;
  for (const boundary of [activeEnd, scheduled?.pauseFrom, scheduled?.plannedPauseUntil].filter(validTime)) {
    const crossing = steps.findIndex(step => step.start < boundary && step.end > boundary);
    if (crossing >= 0) { const step = steps[crossing]; steps.splice(crossing, 1, { ...step, end: boundary }, { ...step, start: boundary }); }
  }
  if (steps.length < 2) return stop('insufficient-price-weather-horizon');
  const maximumPrice = steps.reduce((value, s) => Math.max(value, s.priceCtPerKwh), -Infinity);
  const minimumPrice = steps.reduce((value, s) => Math.min(value, s.priceCtPerKwh), Infinity);
  if (!active && maximumPrice - minimumPrice <= 1e-9) return { ...stop('flat-prices-preserve-normal-warmth'), steps };
  const power = summary.electricity.normalPowerKw;
  if (!(power > .01)) return stop('no-native-heating-demand');
  if (!active && observation.rearC > model.normalReference.interceptC + .5
    && observation.frontC > model.normalReference.frontC + .5) return stop('no-native-heating-demand');
  const initial = { rearC: observation.rearC, frontC: observation.frontC,
    differenceC: observation.frontC - observation.rearC };
  const initialReserve = projectCurrentGarageExposure(exposure, observation, now, config);
  const projected = (state, reserve, step, end, available) => {
    const next = predictGarageStep(model, state, { outdoorC: step.outdoorC, available }, (end - step.start) / HOUR);
    const margin = garagePlanningMargins(summary, (end - now) / HOUR);
    const result = projectGarageExposure(reserve, { at: end, rearAt: end, frontAt: end,
      rearC: next.rearC - margin.rearC, frontC: next.frontC - margin.frontC }, config);
    return { next, margin, reserve: result.exposure, safe: result.interventionAt === null
      && ['rear', 'front'].every(location => !result.exposure.locations[location].uncertain) };
  };
  const recoveryPrice = recoveryPrices(steps, maximumPrice);
  const elapsedOffHours = active ? Math.max(0, activeEpisode.accounting?.offHours
    ?? (finite(activeEpisode.pauseStartedAt) ? (now - activeEpisode.pauseStartedAt) / HOUR : 0)) : 0;
  const existingRecoveryKwh = active ? Math.max(0, activeEpisode.accounting?.recoveryAllowanceKwh
    ?? power * elapsedOffHours * GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor) : 0;
  const restoringNowCost = existingRecoveryKwh * recoveryPrice(now, Math.max(garageRecoveryHours(elapsedOffHours), config.minOnMs / HOUR));
  // Keep only the duration/benefit frontier, never every candidate trajectory.
  // A window is dominated when a shorter window saves at least as much.
  const candidates = [];
  const preferMaximum = active || preference.retainedBenefitFraction === 1;
  let hasEconomicCandidate = false, normalState = initial, normalReserve = initialReserve;
  for (let from = 0; from < (active ? 1 : steps.length); from++) {
    let avoidedKwh = 0, avoidedCostEur = 0, safeThrough = null;
    for (let to = from; to < steps.length; to++) {
      const step = steps[to], duration = step.end - steps[from].start;
      if (scheduled && (steps[from].start !== Math.max(now, scheduled.pauseFrom)
        || step.end > scheduled.plannedPauseUntil)) break;
      if (active && (!validTime(activeEnd) || step.end > activeEnd)) break;
      const hours = (step.end - step.start) / HOUR;
      avoidedKwh += power * hours; avoidedCostEur += power * hours * step.priceCtPerKwh / 100;
      if (scheduled && step.end !== scheduled.plannedPauseUntil) continue;
      if (!active && duration < config.minOffMs) continue;
      if (step.end + restorationDelayMs > steps.at(-1).end) break;
      if (safeThrough !== null && step.end + restorationDelayMs > safeThrough) break;
      const recoveryHours = Math.max(garageRecoveryHours(elapsedOffHours + duration / HOUR), config.minOnMs / HOUR);
      const price = recoveryPrice(step.end, recoveryHours);
      const recoveryKwh = existingRecoveryKwh + avoidedKwh * GARAGE_MODEL_ASSUMPTIONS.recoveryEnergyFactor;
      // For a renewal compare continuing with restoring now: accumulated heat
      // debt must not disappear simply because the planner tick moved forward.
      const recoveryCostEur = recoveryKwh * price - restoringNowCost;
      const uncertain = garagePlanningEnergyUncertainty(model, summary, duration / HOUR);
      const uncertaintyEur = uncertain.kwh * Math.max(0, maximumPrice - minimumPrice) / 100
        + uncertain.recoveryKwh * price;
      const net = avoidedCostEur - recoveryCostEur - uncertaintyEur;
      if (net <= (active ? 0 : preference.minimumBenefitEur)) continue;
      hasEconomicCandidate = true;
      const incumbent = candidates.at(-1);
      if (preferMaximum && incumbent && (net < incumbent.net
        || net === incumbent.net && duration >= incumbent.duration)) continue;
      let slot = 0, upper = candidates.length;
      while (slot < upper) {
        const middle = Math.floor((slot + upper) / 2);
        if (candidates[middle].duration < duration) slot = middle + 1; else upper = middle;
      }
      if (slot > 0 && candidates[slot - 1].net >= net
        || candidates[slot]?.duration === duration && candidates[slot].net >= net) continue;
      // Calculate the cooling trajectory once per start, only when economics
      // can improve the duration/benefit frontier.
      if (safeThrough === null) {
        let state = normalState, reserve = normalReserve;
        safeThrough = steps[from].start;
        for (let i = from; i < steps.length; i++) {
          const row = projected(state, reserve, steps[i], steps[i].end, false);
          if (!row.safe) break;
          state = row.next.state; reserve = row.reserve; safeThrough = steps[i].end;
        }
      }
      if (step.end + restorationDelayMs > safeThrough) break;
      let after = slot;
      while (after < candidates.length && (candidates[after].duration === duration || candidates[after].net <= net)) after++;
      candidates.splice(slot, after - slot, { from, to, duration, avoidedKwh, avoidedCostEur, recoveryKwh,
        recoveryHours, recoveryCostEur, uncertaintyEur, uncertaintyBasis: uncertain.basis, net });
      if (preferMaximum && candidates.length > 1) candidates.splice(0, candidates.length - 1);
    }
    if (active || from === steps.length - 1) break;
    const next = projected(normalState, normalReserve, steps[from], steps[from].end, true);
    if (!next.safe) break;
    normalState = next.next.state; normalReserve = next.reserve;
  }
  if (!candidates.length) return { ...stop(hasEconomicCandidate ? 'forecast-protection-requires-heating' : 'benefit-below-minimum-saving'), evidence };
  const maximumBenefitEur = candidates.at(-1).net;
  // Apply the duration preference when admitting an opportunity. Reapplying a
  // fraction to its remainder every minute would progressively shorten an
  // unchanged plan. Renewals instead compare continuing with restoring now,
  // including accumulated heat debt, within the originally accepted endpoint.
  const best = active ? candidates.at(-1)
    : candidates.find(candidate => candidate.net >= maximumBenefitEur * preference.retainedBenefitFraction);
  let state = initial, reserve = initialReserve;
  const path = [], until = steps[best.to].end + restorationDelayMs;
  for (let i = 0; i < steps.length && steps[i].start < until; i++) {
    const step = steps[i], end = Math.min(until, step.end), isOff = i >= best.from;
    const row = projected(state, reserve, step, end, !isOff);
    if (!row.safe) return { ...stop('forecast-protection-requires-heating'), evidence };
    state = row.next.state; reserve = row.reserve;
    path.push({ ...step, end, at: end, ...row.next, available: !isOff || i > best.to,
      rearLowerC: row.next.rearC - row.margin.rearC, frontLowerC: row.next.frontC - row.margin.frontC,
      phase: !isOff ? 'normal' : i > best.to ? 'restoration-delay' : 'pause' });
  }
  const immediate = best.from === 0, trial = !summary.thermalReady || best.duration / HOUR > evidence.validatedOffHours;
  return { ...base, state: immediate ? 'paused-plan' : 'waiting', evidence, learningTrial: active ? activeEpisode.plan?.learningTrial ?? trial : trial,
    reason: immediate ? active ? 'continue-authorized-economic-episode' : trial ? 'protection-limited-learning-opportunity' : 'credible-price-timing-opportunity'
      : 'wait-for-later-price-opportunity', nextAction: immediate ? active ? 'renew' : 'pause' : 'available',
    pauseFrom: steps[best.from].start, pauseUntil: immediate ? steps[best.to].end : null,
    plannedPauseUntil: steps[best.to].end, nextOpportunityAt: steps[best.from].start, steps: path,
    timingBenefitEur: best.avoidedCostEur - best.recoveryCostEur,
    modelBenefitEur: best.avoidedCostEur - best.recoveryCostEur, scoreEur: best.net,
    avoidedKwh: best.avoidedKwh, recoveryKwh: best.recoveryKwh, recoveryHours: best.recoveryHours,
    recoveryCostEur: best.recoveryCostEur, existingRecoveryKwh,
    uncertainty: { amountEur: best.uncertaintyEur, decisionDeductionEur: best.uncertaintyEur,
      method: best.uncertaintyBasis, electricityBasis: summary.electricity.basis },
    horizonEndAt: steps.at(-1).end };
}
