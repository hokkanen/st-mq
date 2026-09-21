import { OUTDOOR_MAX_AGE_MS } from '../domain/reading-freshness.js';
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
    && reading.stale !== true && goodQuality(reading.quality);
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
      // Some providers expose forecast valid times but no issuance timestamp.
      // Only an explicitly labelled snapshot may use its original fetch time.
      const weatherAt = weather?.issuedAt == null && weather?.issuedAtBasis === 'fetched-snapshot'
        ? instant(weather.fetchedAt) : instant(weather?.issuedAt);
      if (!weather || !finite(weather.outdoorC) || weather.outdoorC < -60 || weather.outdoorC > 50
        || !finite(weatherAt) || weatherAt > now || now - weatherAt > 6 * HOUR) return null;
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
  severeDropC = 2, maxRiseC = 1.5, deficitDegreeHours = 0, model, occupancy = { mode: 'occupied' },
  nativeEndIndoorC = null }) {
  const p = model.parameters, energy = model.energy;
  const returnAt = instant(occupancy.returnAt);
  const occupiedAt = at => occupancy.mode !== 'away' || finite(returnAt) && at >= returnAt;
  if (occupancy.mode === 'away' && reductionHours > 0 && !finite(nativeEndIndoorC)) {
    nativeEndIndoorC = evaluateSchedule({ intervals, indoorC, targetC, maxDropC,
      severeDropC, maxRiseC, deficitDegreeHours, model, occupancy }).endIndoorC;
  }
  let temperature = indoorC, deficit = deficitDegreeHours, electricityKwh = 0, auxiliaryKwh = 0;
  let costCents = 0, absoluteCostCents = 0, penalty = 0, elapsed = 0, severe = false;
  const steps = [];
  for (const interval of intervals) {
    // Substeps avoid interpreting a long price interval as a long mandatory command duration.
    let remaining = interval.durationHours;
    while (remaining > 1e-9) {
      const at = interval.end - remaining * HOUR;
      let dt = Math.min(0.25, remaining);
      if (elapsed < reductionHours && elapsed + dt > reductionHours) dt = reductionHours - elapsed;
      // Return is an actual occupancy boundary, even inside a price interval.
      if (finite(returnAt) && at < returnAt && at + dt * HOUR > returnAt) dt = (returnAt - at) / HOUR;
      const action = elapsed + 1e-8 < reductionHours ? 'reduction' : 'normal';
      const loss = p.lossPerHour * (temperature - interval.outdoorC);
      // The learned reference describes the native house knobs. Away changes
      // our objective, not the temperature the heat pump itself tries to maintain.
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
      const occupied = occupiedAt(at);
      if (occupied) penalty += comfortPenalty(temperature, targetC, maxDropC, dt);
      const uncertainty = p.uncertaintyCPerHour * Math.sqrt(elapsed + dt);
      // Check the return instant itself, but never apply occupied limits to an
      // earlier away interval. Native equipment fault protection remains separate.
      if (occupiedAt(at + dt * HOUR)
        && (temperature - uncertainty < targetC - severeDropC || temperature + uncertainty > targetC + maxRiseC)) severe = true;
      steps.push({ at: iso(at + dt * HOUR), action, occupied, indoorC: temperature,
        uncertaintyC: uncertainty, deficitDegreeHours: deficit, electricityKwh: kwh, auxiliaryKwh: auxKwh });
      elapsed += dt;
      remaining -= dt;
    }
  }
  // Charge for heat deferred by our actions in every regime. While away use
  // continuous native operation as the economic comparison, not an obligation
  // to reach the occupied room target. The normal baseline itself owes no such
  // relative recovery cost. Reuse that baseline when comparing multiple options.
  const endsOccupied = occupiedAt(intervals.at(-1).end);
  const terminalReferenceC = endsOccupied ? targetC : nativeEndIndoorC;
  const terminalDeficit = deficit + (finite(terminalReferenceC) ? Math.max(0, terminalReferenceC - temperature) : 0);
  const terminalRecoveryHours = terminalDeficit / p.normalHeatCPerHour;
  const terminalAuxiliaryKwh = occupancy.mode === 'away' && terminalDeficit > 0.5
    ? terminalRecoveryHours * energy.auxiliaryKw * energy.recoveryMultiplier : 0;
  const terminalKwh = terminalRecoveryHours * energy.normalKw * energy.recoveryMultiplier + terminalAuxiliaryKwh;
  const terminalPrice = Math.max(0, ...intervals.map(interval => interval.price));
  const terminalCostCents = terminalKwh * terminalPrice;
  costCents += terminalCostCents;
  // Apply energy uncertainty to the prices of the intervals where energy is used.
  // A single spike does not reprice every kWh in the recovery horizon.
  const uncertaintyCents = Math.max(2, (absoluteCostCents + Math.abs(terminalCostCents)) * energy.relativeUncertainty);
  return { reductionHours, costCents, comfortPenalty: penalty, score: costCents + penalty,
    electricityKwh, auxiliaryKwh, endIndoorC: temperature, endDeficitDegreeHours: deficit,
    terminalKwh, terminalAuxiliaryKwh, terminalCostCents, terminalReferenceC, uncertaintyCents, severe, endsOccupied, steps };
}

/** Pure decision function. commands are intents; only the application's single executor may act. */
export function decide({ now = Date.now(), settings = {}, observations = {}, prices = [], forecast = [],
  learned = null, state = {}, override = null } = {}) {
  const timestamp = instant(now);
  if (!finite(timestamp)) throw new TypeError('now must be a valid UTC instant');
  const comfort = settings.comfort ?? {};
  const target = finite(comfort.targetC) ? comfort.targetC : learned?.comfortReference?.targetC;
  const maxDrop = finite(comfort.maxDropC) && comfort.maxDropC >= 0 && comfort.maxDropC <= 2 ? comfort.maxDropC : 1.5;
  const severeDrop = finite(comfort.severeDropC) && comfort.severeDropC > maxDrop && comfort.severeDropC <= 5 ? comfort.severeDropC : Math.max(2, maxDrop + 0.5);
  const maxRise = finite(comfort.maxRiseC) && comfort.maxRiseC > 0 && comfort.maxRiseC <= 5 ? comfort.maxRiseC : 1.5;
  const returnAt = instant(settings.occupancy?.returnAt);
  const away = settings.occupancy?.mode === 'away' && !(finite(returnAt) && returnAt <= timestamp);
  const occupancy = away ? settings.occupancy : { mode: 'occupied' };
  const observationAge = finite(settings.maxObservationAgeMs) && settings.maxObservationAgeMs > 0
    ? Math.min(settings.maxObservationAgeMs, HOUR) : OUTDOOR_MAX_AGE_MS;
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
  if (state.lastAction === 'reduction') {
    // While away a low room temperature is allowed; it is not itself evidence
    // of a growing comfort debt. Track the heat withheld by the reduction model.
    const p = model?.parameters;
    const withheldHeat = away && validateModel(model) && finite(indoor?.value) && finite(outdoor?.value) && finite(target)
      ? Math.max(0, Math.min(p.normalHeatCPerHour,
        Math.max(0, p.lossPerHour * (indoor.value - outdoor.value) + Math.max(0, target - indoor.value) * 0.3)) - p.reducedHeatCPerHour)
      : Math.max(0.1, finite(target) && finite(indoor?.value) ? target - indoor.value : 0.2);
    deficit += hours * withheldHeat;
  }
  else if (state.lastAction === 'normal') deficit = Math.max(0, deficit - hours * recoverRate);
  const nextState = { ...state, version: 1, lastDecisionAt: iso(timestamp), deficitDegreeHours: deficit };
  if (!stateFresh) {
    nextState.reconcileUntil = iso(timestamp + 4 * HOUR);
    reasons.push('thermal-state-reconciliation');
  }
  const reconcile = instant(nextState.reconcileUntil);
  const freshIndoor = fresh(indoor, timestamp, Infinity) && indoor.value > 2 && indoor.value < 40;
  const freshOutdoor = fresh(outdoor, timestamp, observationAge) && outdoor.value >= -60 && outdoor.value <= 50;
  if (!finite(target) || target < 12 || target > 28) reasons.push('learning-normal-comfort-reference');
  if (!freshIndoor || !freshOutdoor) reasons.push('missing-or-stale-observations');
  if (!validateModel(model)) reasons.push('unvalidated-thermal-model');
  else if (timestamp - instant(model.trainedAt) > 30 * 24 * HOUR || instant(model.trainedAt) > timestamp) reasons.push('stale-thermal-model');
  if (!hasValidatedEnergy(model)) reasons.push('unvalidated-heating-energy-model');
  if (finite(reconcile) && reconcile > timestamp) reasons.push('reconciling-thermal-reserve');
  if (!away && deficit > 0.15) reasons.push('recovery-deficit');
  if (override?.mode === 'normal' && instant(override.expiresAt) > timestamp) reasons.push('timed-normal-override');
  if (away && settings.occupancy.returnAt != null && !finite(returnAt)) reasons.push('invalid-away-return-time');
  if (!away && freshIndoor && finite(target) && indoor.value <= target - severeDrop) reasons.push('severe-cooling-protection');
  if (!away && freshIndoor && finite(target) && indoor.value >= target + maxRise) reasons.push('severe-overheat-native-protection');
  if (observations.fault?.active === true) reasons.push('equipment-fault-native-protection');
  if (observations.integral?.verified === true && fresh(observations.integral, timestamp, observationAge)
    && finite(observations.integral.recoveryThreshold) && observations.integral.value <= observations.integral.recoveryThreshold)
    reasons.push('verified-integral-recovery-warning');
  if (!reasons.length) {
    const intervals = getIntervals(prices, forecast, timestamp);
    if (!intervals) reasons.push('missing-or-incomplete-price-weather-horizon');
    else {
      const horizonEnd = intervals.at(-1).end;
      const durationHours = (horizonEnd - timestamp) / HOUR;
      const reductions = away ? [0, 0.25, 0.5, 1, 2, 4, 8, 12, 24].filter(hours => hours <= durationHours) : [0, 0.25, 0.5, 1, 2];
      const scheduleInput = { intervals,
        indoorC: indoor.value, targetC: target, maxDropC: maxDrop, severeDropC: severeDrop,
        maxRiseC: maxRise, deficitDegreeHours: deficit, model, occupancy };
      const baseline = evaluateSchedule(scheduleInput);
      const options = [baseline, ...reductions.slice(1).map(reductionHours => evaluateSchedule({ ...scheduleInput,
        reductionHours, nativeEndIndoorC: baseline.endIndoorC }))];
      const candidates = options.slice(1).filter(option => !option.severe
        && option.score + option.uncertaintyCents + baseline.uncertaintyCents < baseline.score
        && (!option.endsOccupied || (option.endDeficitDegreeHours <= baseline.endDeficitDegreeHours + 0.1
          && option.endIndoorC >= baseline.endIndoorC - 0.2)));
      const chosen = candidates.sort((a, b) => a.score - b.score)[0] ?? baseline;
      action = chosen.reductionHours > 0 ? 'reduction' : 'normal';
      reasons.push(action === 'reduction' ? away ? 'away-predicted-cost-benefit' : 'conservative-predicted-full-cycle-benefit' : 'continuous-normal-preferred');
      plan = { generatedAt: iso(timestamp), horizonEnd: iso(horizonEnd),
        occupancy: { mode: away ? 'away' : 'occupied', returnAt: away && finite(returnAt) ? iso(returnAt) : null,
          returnWithinHorizon: away && finite(returnAt) && returnAt <= horizonEnd },
        objective: away ? 'cost including recovery and auxiliary heat; occupied comfort resumes at return' : 'occupied comfort and full-cycle cost',
        terminalPriceBasis: 'nonnegative maximum within verified horizon; conservative recovery allowance, not a future price forecast',
        baseline, chosen, alternatives: options.map(({ steps, ...summary }) => summary),
        estimatedBenefitCents: baseline.costCents - chosen.costCents,
        evidence: 'model estimate including recovery and uncertainty; not measured bill savings' };
    }
  }
  const dhwrRequested = dhwrEligible(timestamp, state.lastDhwrAt, action);
  nextState.lastAction = action;
  nextState.lastDhwrAt = dhwrRequested ? iso(timestamp) : (state.lastDhwrAt ?? null);
  return { action, reasons, commands: action === 'reduction' ? ['reduction'] : dhwrRequested ? ['circulation', 'normal'] : ['normal'],
    dhwr: { requested: dhwrRequested, lastPulseAt: nextState.lastDhwrAt, durationMinutes: 10 },
    nextState, plan, comfort: { targetC: finite(target) ? target : null, maxDropC: maxDrop, maxDropApplies: !away,
      source: finite(comfort.targetC) ? 'explicit-setting' : learned?.comfortReference?.source ?? 'awaiting-normal-baseline' },
    learningHealth: learned?.health ?? { status: 'collecting' },
    semantics: 'reduction requests tariff reduction; normal mode cannot force preheating or prove compressor operation' };
}
