import { validateModel, hasValidatedEnergy, goodQuality } from './learning.js';
export { emptyCheckpoint, restoreCheckpoint, updateLearning, inferComfortReference, fitModel, validateModel, hasValidatedEnergy, CHECKPOINT_VERSION, MAX_SAMPLES } from './learning.js';

const HOUR = 3_600_000;
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const iso = value => new Date(value).toISOString();
const finite = Number.isFinite;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const helsinki = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Eligibility is Finnish local time, separate from electricity tariff hours. */
export function dhwrEligible(now, lastPulseAt, action = 'normal') {
  const timestamp = instant(now);
  if (!finite(timestamp) || action !== 'normal') return false;
  const parts = Object.fromEntries(helsinki.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  if (minute < 345 || minute > 1185) return false;
  if (lastPulseAt === null || lastPulseAt === undefined) return true;
  const previous = instant(lastPulseAt);
  // Invalid/future recency is uncertain, not permission to send an extra circulation pulse.
  return finite(previous) && timestamp - previous >= 52.5 * 60_000;
}

export function comfortPenalty(indoorC, targetC, maxDropC, durationHours = 1) {
  const exceedance = Math.max(0, targetC - maxDropC - indoorC);
  return (exceedance * 20 + exceedance ** 2 * 100) * durationHours;
}

function fresh(reading, now, maxAge) {
  const age = now - instant(reading?.observedAt);
  return reading && finite(reading.value) && finite(age) && age >= 0 && age <= maxAge
    && goodQuality(reading.quality);
}

function getIntervals(prices, forecast, now) {
  if (!Array.isArray(prices) || !Array.isArray(forecast)) return null;
  const sorted = prices.filter(price => instant(price.end) > now).sort((a, b) => instant(a.start) - instant(b.start));
  const intervals = [];
  let cursor = now;
  for (const price of sorted) {
    const start = instant(price.start), end = instant(price.end);
    if (!finite(start) || !finite(end) || end <= start || !finite(price.allInCentsPerKWh)) return null;
    if (start > cursor || (intervals.length > 0 && start !== cursor)) return null;
    if (end <= cursor) return null;
    let intervalEnd = Math.min(end, now + 24 * HOUR);
    // Split at weather boundaries and at one-hour steps while preserving actual price duration.
    while (cursor < intervalEnd) {
      const weather = forecast.find(item => instant(item.start) <= cursor && instant(item.end) > cursor);
      if (!weather || !finite(weather.outdoorC) || weather.outdoorC < -60 || weather.outdoorC > 50
        || !finite(instant(weather.issuedAt)) || instant(weather.issuedAt) > now || now - instant(weather.issuedAt) > 6 * HOUR) return null;
      const stepEnd = Math.min(intervalEnd, instant(weather.end), cursor + HOUR);
      intervals.push({ start: cursor, end: stepEnd, durationHours: (stepEnd - cursor) / HOUR,
        price: price.allInCentsPerKWh, outdoorC: weather.outdoorC });
      cursor = stepEnd;
      if (intervals.length > 192) return null;
    }
    if (cursor >= now + 24 * HOUR) break;
  }
  return intervals.length && cursor - now >= 8 * HOUR ? intervals : null;
}

/** Evaluate a whole candidate including recovery and conservative terminal reserve cost. */
export function evaluateSchedule({ intervals, reductionHours = 0, indoorC, targetC, maxDropC,
  severeDropC = 2, maxRiseC = 2, deficitDegreeHours = 0, model }) {
  const p = model.parameters, energy = model.energy;
  let temperature = indoorC, deficit = deficitDegreeHours, electricityKwh = 0, auxiliaryKwh = 0;
  let costCents = 0, absoluteCostCents = 0, penalty = 0, elapsed = 0, severe = false;
  const steps = [];
  for (const interval of intervals) {
    // Substeps avoid interpreting a long price interval as a long mandatory command duration.
    let remaining = interval.durationHours;
    while (remaining > 1e-9) {
      let dt = Math.min(0.25, remaining);
      if (elapsed < reductionHours && elapsed + dt > reductionHours) dt = reductionHours - elapsed;
      const action = elapsed + 1e-8 < reductionHours ? 'reduction' : 'normal';
      const loss = p.lossPerHour * (temperature - interval.outdoorC);
      const nativeNeed = Math.max(0, loss + Math.max(0, targetC - temperature) * 0.3);
      const heat = Math.min(action === 'normal' ? p.normalHeatCPerHour : p.reducedHeatCPerHour, nativeNeed);
      const reserveRecharge = action === 'normal' ? Math.min(deficit, p.recoveryDegreeHoursPerHour * dt) : 0;
      if (action === 'reduction') deficit += Math.max(0, Math.min(p.normalHeatCPerHour, nativeNeed) - heat) * dt;
      else deficit = Math.max(0, deficit - reserveRecharge);
      temperature += (heat - loss) * dt - reserveRecharge * 0.05;
      const duty = clamp(nativeNeed / p.normalHeatCPerHour, 0, 1);
      const baseKw = action === 'normal' ? energy.normalKw * duty : energy.reductionKw * duty;
      const recoveryKwh = reserveRecharge / p.normalHeatCPerHour * energy.normalKw * (energy.recoveryMultiplier - 1);
      const auxKwh = (energy.auxiliaryKw * duty + (deficit > 0.5 ? energy.auxiliaryKw * energy.recoveryMultiplier : 0)) * dt;
      const kwh = baseKw * dt + recoveryKwh + auxKwh;
      electricityKwh += kwh;
      auxiliaryKwh += auxKwh;
      costCents += kwh * interval.price;
      absoluteCostCents += Math.abs(kwh * interval.price);
      penalty += comfortPenalty(temperature, targetC, maxDropC, dt);
      const uncertainty = p.uncertaintyCPerHour * Math.sqrt(elapsed + dt);
      if (temperature - uncertainty < targetC - severeDropC || temperature + uncertainty > targetC + maxRiseC) severe = true;
      steps.push({ at: iso(interval.end - remaining * HOUR + dt * HOUR), action, indoorC: temperature,
        uncertaintyC: uncertainty, deficitDegreeHours: deficit, electricityKwh: kwh, auxiliaryKwh: auxKwh });
      elapsed += dt;
      remaining -= dt;
    }
  }
  // Neither cheap purchase timing nor an unrecovered end state is counted as a saving.
  const terminalDeficit = deficit + Math.max(0, targetC - temperature);
  const terminalKwh = terminalDeficit / p.normalHeatCPerHour * energy.normalKw * energy.recoveryMultiplier;
  const terminalPrice = Math.max(0, ...intervals.map(interval => interval.price));
  const terminalCostCents = terminalKwh * terminalPrice;
  costCents += terminalCostCents;
  // Apply energy uncertainty to the prices of the intervals where energy is used.
  // A single spike does not reprice every kWh in the recovery horizon.
  const uncertaintyCents = Math.max(2, (absoluteCostCents + Math.abs(terminalCostCents)) * energy.relativeUncertainty);
  return { reductionHours, costCents, comfortPenalty: penalty, score: costCents + penalty,
    electricityKwh, auxiliaryKwh, endIndoorC: temperature, endDeficitDegreeHours: deficit,
    terminalKwh, terminalCostCents, uncertaintyCents, severe, steps };
}

/** Pure decision function. commands are intents; only the application's single executor may act. */
export function decide({ now = Date.now(), settings = {}, observations = {}, prices = [], forecast = [],
  learned = null, state = {}, override = null } = {}) {
  const timestamp = instant(now);
  if (!finite(timestamp)) throw new TypeError('now must be a valid UTC instant');
  const comfort = settings.comfort ?? {};
  const target = finite(comfort.targetC) ? comfort.targetC : learned?.comfortReference?.targetC;
  const maxDrop = finite(comfort.maxDropC) && comfort.maxDropC >= 0 && comfort.maxDropC <= 2 ? comfort.maxDropC : 1;
  const severeDrop = finite(comfort.severeDropC) && comfort.severeDropC > maxDrop && comfort.severeDropC <= 5 ? comfort.severeDropC : Math.max(2, maxDrop + 0.5);
  const maxRise = finite(comfort.maxRiseC) && comfort.maxRiseC > 0 && comfort.maxRiseC <= 5 ? comfort.maxRiseC : 2;
  const observationAge = finite(settings.maxObservationAgeMs) && settings.maxObservationAgeMs > 0
    ? Math.min(settings.maxObservationAgeMs, HOUR) : 30 * 60_000;
  const indoor = observations.indoor, outdoor = observations.outdoor;
  const reasons = [];
  let action = 'normal', plan = null;
  const model = learned?.model ?? null;
  const previousTime = instant(state.lastDecisionAt);
  const age = timestamp - previousTime;
  const stateFresh = finite(age) && age >= 0 && age <= HOUR;
  const hours = stateFresh ? age / HOUR : 0;
  let deficit = finite(state.deficitDegreeHours) && state.deficitDegreeHours >= 0 ? Math.min(24, state.deficitDegreeHours) : 0;
  const recoverRate = validateModel(model) ? model.parameters.recoveryDegreeHoursPerHour : 0.25;
  if (state.lastAction === 'reduction') deficit += hours * Math.max(0.1, finite(target) && finite(indoor?.value) ? target - indoor.value : 0.2);
  else if (state.lastAction === 'normal') deficit = Math.max(0, deficit - hours * recoverRate);
  const nextState = { ...state, version: 1, lastDecisionAt: iso(timestamp), deficitDegreeHours: deficit };
  if (!stateFresh) {
    nextState.reconcileUntil = iso(timestamp + 4 * HOUR);
    reasons.push('thermal-state-reconciliation');
  }
  const reconcile = instant(nextState.reconcileUntil);
  const freshIndoor = fresh(indoor, timestamp, observationAge) && indoor.value > 2 && indoor.value < 40;
  const freshOutdoor = fresh(outdoor, timestamp, observationAge) && outdoor.value >= -60 && outdoor.value <= 50;
  if (!finite(target) || target < 12 || target > 28) reasons.push('learning-normal-comfort-reference');
  if (!freshIndoor || !freshOutdoor) reasons.push('missing-or-stale-observations');
  if (!validateModel(model)) reasons.push('unvalidated-thermal-model');
  else if (timestamp - instant(model.trainedAt) > 30 * 24 * HOUR || instant(model.trainedAt) > timestamp) reasons.push('stale-thermal-model');
  if (!hasValidatedEnergy(model)) reasons.push('unvalidated-heating-energy-model');
  if (finite(reconcile) && reconcile > timestamp) reasons.push('reconciling-thermal-reserve');
  if (deficit > 0.15) reasons.push('recovery-deficit');
  if (override?.mode === 'normal' && instant(override.expiresAt) > timestamp) reasons.push('timed-normal-override');
  if (settings.occupancy?.mode === 'away') reasons.push('explicit-away-normal-fallback');
  if (freshIndoor && finite(target) && indoor.value <= target - severeDrop) reasons.push('severe-cooling-protection');
  if (freshIndoor && finite(target) && indoor.value >= target + maxRise) reasons.push('severe-overheat-native-protection');
  if (observations.fault?.active === true) reasons.push('equipment-fault-native-protection');
  if (observations.integral?.verified === true && fresh(observations.integral, timestamp, observationAge)
    && finite(observations.integral.recoveryThreshold) && observations.integral.value <= observations.integral.recoveryThreshold)
    reasons.push('verified-integral-recovery-warning');
  if (!reasons.length) {
    const intervals = getIntervals(prices, forecast, timestamp);
    if (!intervals) reasons.push('missing-or-incomplete-price-weather-horizon');
    else {
      const options = [0, 0.25, 0.5, 1, 2].map(reductionHours => evaluateSchedule({ intervals, reductionHours,
        indoorC: indoor.value, targetC: target, maxDropC: maxDrop, severeDropC: severeDrop,
        maxRiseC: maxRise, deficitDegreeHours: deficit, model }));
      const baseline = options[0];
      const candidates = options.slice(1).filter(option => !option.severe
        && option.score + option.uncertaintyCents + baseline.uncertaintyCents < baseline.score
        && option.endDeficitDegreeHours <= baseline.endDeficitDegreeHours + 0.1
        && option.endIndoorC >= baseline.endIndoorC - 0.2);
      const chosen = candidates.sort((a, b) => a.score - b.score)[0] ?? baseline;
      action = chosen.reductionHours > 0 ? 'reduction' : 'normal';
      reasons.push(action === 'reduction' ? 'conservative-predicted-full-cycle-benefit' : 'continuous-normal-preferred');
      plan = { generatedAt: iso(timestamp), horizonEnd: iso(intervals.at(-1).end),
        baseline, chosen, alternatives: options.map(({ steps, ...summary }) => summary),
        estimatedBenefitCents: baseline.costCents - chosen.costCents,
        evidence: 'model estimate including recovery and uncertainty; not measured bill savings' };
    }
  }
  const dhwrRequested = dhwrEligible(timestamp, state.lastDhwrAt, action);
  nextState.lastAction = action;
  nextState.lastDhwrAt = dhwrRequested ? iso(timestamp) : (state.lastDhwrAt ?? null);
  return { action, reasons, commands: action === 'reduction' ? ['heatoff'] : dhwrRequested ? ['heaton60', 'heaton15'] : ['heaton15'],
    dhwr: { requested: dhwrRequested, lastPulseAt: nextState.lastDhwrAt, durationMinutes: 10 },
    nextState, plan, comfort: { targetC: finite(target) ? target : null, maxDropC: maxDrop,
      source: finite(comfort.targetC) ? 'explicit-setting' : learned?.comfortReference?.source ?? 'awaiting-normal-baseline' },
    learningHealth: learned?.health ?? { status: 'collecting' },
    semantics: 'heatoff requests tariff reduction; normal mode cannot force preheating or prove compressor operation' };
}
