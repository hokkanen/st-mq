/** Pooled masonry-fireplace response. Kilograms are logged fuel, not measured
 * delivered heat. The fixed kernel rises gradually and retains a five-day tail. */
const HOUR = 3_600_000;
export const FIREPLACE_HORIZON_MS = 120 * HOUR;
export const FIREPLACE_RESPONSE = Object.freeze({ version: 1, burnHours: 2, releaseHours: 18, horizonHours: 120 });
/** Structural tolerances, not statistical confidence limits. A small residual
 * still contributes heat; these only decide when it matters for evidence/control. */
export const FIREPLACE_RELEVANCE = Object.freeze({ remainingC: 0.1, nextHourC: 0.02, cleanRateKgPerHour: 0.02 });
const instant = value => typeof value === 'number' ? value : Date.parse(value);
const rawCumulative = hours => 1 - (18 * Math.exp(-hours / 18) - 2 * Math.exp(-hours / 2)) / 16;
const normalization = rawCumulative(FIREPLACE_RESPONSE.horizonHours);
const cumulative = hours => hours <= 0 ? 0 : hours >= FIREPLACE_RESPONSE.horizonHours ? 1 : rawCumulative(hours) / normalization;
const valid = event => event && Number.isFinite(instant(event.litAt ?? event.at))
  && Number.isFinite(event.kg) && event.kg > 0 && event.kg <= 100;

export function fireplaceIntegral(events = [], start, end) {
  const from = instant(start), to = instant(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return events.filter(valid).reduce((total, event) => {
    const litAt = instant(event.litAt ?? event.at);
    return total + event.kg * (cumulative((to - litAt) / HOUR) - cumulative((from - litAt) / HOUR));
  }, 0);
}

/** Interval-average kg/hour of the normalized release response. */
export function fireplaceRate(events = [], start, end) {
  const hours = (instant(end) - instant(start)) / HOUR;
  return hours > 0 ? fireplaceIntegral(events, start, end) / hours : 0;
}

export function fireplaceActive(events = [], at) {
  const now = instant(at);
  return Number.isFinite(now) && events.some(event => valid(event)
    && instant(event.litAt ?? event.at) <= now && now < instant(event.litAt ?? event.at) + FIREPLACE_HORIZON_MS);
}

/** Aggregate before testing significance: several individually small tails may
 * still matter together. Remaining degrees C are an integrated input allowance,
 * not a forecast of the eventual room-temperature rise. */
export function fireplaceInfluence(events = [], at, { gainCPerKg = 0.15, gainUncertaintyCPerKg = 0.15 } = {}) {
  const now = instant(at);
  const gain = Number.isFinite(gainCPerKg) ? Math.max(0, Math.min(1, gainCPerKg)) : 0.15;
  const uncertainty = Number.isFinite(gainUncertaintyCPerKg) ? Math.max(0, Math.min(1, gainUncertaintyCPerKg)) : 0.15;
  const remainingKgEquivalent = fireplaceIntegral(events, now, now + FIREPLACE_HORIZON_MS);
  const rateKgPerHour = fireplaceRate(events, now, now + HOUR);
  const expectedRemainingC = remainingKgEquivalent * gain;
  const uncertaintyRemainingC = remainingKgEquivalent * uncertainty;
  return { rateKgPerHour, remainingKgEquivalent, expectedRemainingC, uncertaintyRemainingC,
    relevant: expectedRemainingC + uncertaintyRemainingC > FIREPLACE_RELEVANCE.remainingC
      || rateKgPerHour * (gain + uncertainty) > FIREPLACE_RELEVANCE.nextHourC };
}

/** Completed-window rates already pool every logged load. Missing rates with an
 * active-fire flag remain excluded; absent legacy logging does not assert no fire. */
export function fireplaceAffectsLearning(sample) {
  if (!sample) return false;
  const rate = sample.fireplaceKgPerHour;
  return (Number.isFinite(rate) ? rate > FIREPLACE_RELEVANCE.cleanRateKgPerHour : sample.fireplaceActive === true)
    || sample.inputSegments?.some(fireplaceAffectsLearning) === true;
}

/** Simultaneous loads/reloads share one observation group. Separate groups have
 * ignition times at least a day apart; they may still have overlapping tails. */
export function fireplaceBurnGroups(events = []) {
  const seen = new Set(), groups = [];
  for (const event of events.filter(valid).sort((a, b) => instant(a.litAt ?? a.at) - instant(b.litAt ?? b.at))) {
    const at = instant(event.litAt ?? event.at), key = event.id ?? `${at}:${event.kg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = groups.at(-1);
    if (previous && at - previous.startedAt < 24 * HOUR) {
      previous.kg += event.kg; previous.events.push(key);
    } else groups.push({ id: String(key), startedAt: at, kg: event.kg, events: [key] });
  }
  return groups;
}
