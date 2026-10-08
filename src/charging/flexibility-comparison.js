import { planChargers } from './planner.js';

const priced = row => Number.isFinite(row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price);
function covered(prices, start, end) {
  let at = start;
  for (const row of [...prices].filter(priced).sort((a, b) => a.start - b.start)) {
    if (row.end <= at) continue;
    if (row.start > at) return false;
    at = row.end;
    if (at >= end) return true;
  }
  return false;
}

/** Both counterfactuals use this one immutable worker snapshot. No outcome,
 * price or delivered-energy history is written by a preview. */
export function compareChargingFlexibility(options, { chargerId, normalReadyByAt, deferredReadyByAt }) {
  const base = { at: options.now, normalReadyByAt, deferredReadyByAt, estimated: true, available: false,
    recommended: false, normalCostCents: null, deferredCostCents: null, savingsCents: null,
    householdSavingsCents: null, uncertaintyPremiumCents: null, riskAdjustedSavingsCents: null, usesForecast: false };
  const selected = options.chargers.find(charger => charger.id === chargerId);
  if (!selected || !(normalReadyByAt > options.now) || !(deferredReadyByAt > normalReadyByAt))
    return { ...base, reason: 'ready-by-passed' };
  if (!covered(options.prices, options.now, deferredReadyByAt))
    return { ...base, reason: 'price-coverage-unavailable' };
  const prepare = deferred => ({ ...options, previousPeriods: {}, previousAllocations: [],
    chargers: options.chargers.map(charger => ({ ...charger,
      ...(charger.id === chargerId ? { deadlineAt: deferred ? deferredReadyByAt : normalReadyByAt,
        forecastAllowed: deferred || charger.forecastAllowed === true } : {}),
      // A preview can reconsider automatic permission, never an independent
      // native instruction or manual vehicle restriction.
      control: charger.settings.enabled && !charger.request?.chargeNow && !charger.control?.manual
        ? { ...charger.control, released: false, phase: null } : charger.control })) });
  const normal = planChargers(prepare(false)), deferred = planChargers(prepare(true));
  const connected = options.chargers.filter(charger => charger.values.connected.value === true && charger.requiredGridKwh > 1e-7);
  const comparable = result => connected.every(charger => {
    const plan = result.plans[charger.id];
    return plan?.feasible === true && Number.isFinite(plan.costCents)
      && Math.abs(plan.deliveredGridKwh - charger.requiredGridKwh) < 1e-5;
  });
  if (!comparable(normal) || !comparable(deferred)) return { ...base, reason: !comparable(deferred)
    ? 'extended-plan-infeasible' : 'normal-plan-infeasible' };
  const sum = (result, field) => connected.reduce((value, charger) => value + (result.plans[charger.id][field] ?? 0), 0);
  const before = normal.plans[chargerId], after = deferred.plans[chargerId];
  const householdSavingsCents = sum(normal, 'costCents') - sum(deferred, 'costCents');
  const riskAdjustedSavingsCents = householdSavingsCents + sum(normal, 'uncertaintyPremiumCents') - sum(deferred, 'uncertaintyPremiumCents');
  return { ...base, available: true, reason: null,
    normalCostCents: before.costCents, deferredCostCents: after.costCents,
    savingsCents: before.costCents - after.costCents, householdSavingsCents,
    normalUncertaintyPremiumCents: before.uncertaintyPremiumCents ?? 0,
    uncertaintyPremiumCents: after.uncertaintyPremiumCents ?? 0,
    householdUncertaintyPremiumCents: sum(deferred, 'uncertaintyPremiumCents'), riskAdjustedSavingsCents,
    usesForecast: connected.some(charger => deferred.plans[charger.id].usesForecast),
    recommended: before.costCents > after.costCents && householdSavingsCents > 0 && riskAdjustedSavingsCents >= 5,
    forecastUncertaintyCtPerKwh: 2,
    remainingGridKwh: selected.requiredGridKwh,
    chargers: connected.map(charger => ({ id: charger.id, requiredGridKwh: charger.requiredGridKwh,
      normalCostCents: normal.plans[charger.id].costCents, deferredCostCents: deferred.plans[charger.id].costCents })) };
}
