import { planChargers, chargingPlanParticipants, chargingPlanTotals } from './planner.js';

const priced = row => Number.isFinite(row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price);
// Only modeled energy-delivery spans count as charging time. An allowed period
// can also contain waiting for household headroom or the other charger.
const chargingDuration = plan => Array.isArray(plan.accounting)
  ? plan.accounting.reduce((duration, row) => duration + row.end - row.start, 0) : null;
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
    normalFinishAt: null, deferredFinishAt: null, normalChargingDurationMs: null, deferredChargingDurationMs: null,
    normalPeriods: null, deferredPeriods: null,
    householdSavingsCents: null, uncertaintyPremiumCents: null, riskAdjustedSavingsCents: null, usesForecast: false };
  const selected = options.chargers.find(charger => charger.id === chargerId);
  if (!selected || !(normalReadyByAt > options.now) || !(deferredReadyByAt > normalReadyByAt))
    return { ...base, reason: 'ready-by-passed' };
  const grant = selected.request?.flexibility?.activeDefer;
  const existingAllowance = grant?.checkpointAt === normalReadyByAt && grant?.deferredReadyByAt === deferredReadyByAt;
  const prepare = deferred => ({ ...options, previousPeriods: {}, previousAllocations: [],
    // A prospective allowance is the next decision. An already active one
    // retains its actual approval order relative to the peer's later choices.
    deadlineBaselines: deferred && existingAllowance ? {} : { [chargerId]: deferred ? normalReadyByAt : null },
    chargers: options.chargers.map(charger => ({ ...charger,
      ...(charger.id === chargerId ? { deadlineAt: deferred ? deferredReadyByAt : normalReadyByAt } : {}),
      // A preview can reconsider automatic permission, never an independent
      // native instruction or manual vehicle restriction.
      control: charger.settings.enabled && !charger.request?.chargeNow && !charger.control?.manual
        ? { ...charger.control, released: false, phase: null } : charger.control })) });
  const normal = planChargers(prepare(false)), deferred = planChargers(prepare(true));
  const connected = chargingPlanParticipants(options.chargers, normal, deferred);
  const comparable = result => connected.some(charger => charger.id === chargerId)
    && chargingPlanTotals(result, connected) !== null;
  if (!comparable(normal) || !comparable(deferred)) {
    const failed = !comparable(deferred) ? deferred : normal;
    const blocker = connected.find(charger => chargingPlanTotals(failed, [charger]) === null);
    return { ...base, reason: failed === deferred ? 'extended-plan-infeasible' : 'normal-plan-infeasible',
      blockingChargerId: blocker?.id ?? chargerId, blockingReason: failed.plans[blocker?.id ?? chargerId]?.reason ?? null };
  }
  const sum = (result, field) => connected.reduce((value, charger) => value + (result.plans[charger.id][field] ?? 0), 0);
  const before = normal.plans[chargerId], after = deferred.plans[chargerId];
  const householdSavingsCents = sum(normal, 'costCents') - sum(deferred, 'costCents');
  const riskAdjustedSavingsCents = householdSavingsCents + sum(normal, 'uncertaintyPremiumCents') - sum(deferred, 'uncertaintyPremiumCents');
  return { ...base, available: true, reason: null,
    priceCoverage: covered(options.prices, options.now, deferredReadyByAt)
      && normal.assumptions.priceCoverage === 'complete' && deferred.assumptions.priceCoverage === 'complete' ? 'complete' : 'partial',
    normalCostCents: before.costCents, deferredCostCents: after.costCents,
    normalFinishAt: before.finishAt, deferredFinishAt: after.finishAt,
    normalChargingDurationMs: chargingDuration(before), deferredChargingDurationMs: chargingDuration(after),
    normalPeriods: before.periods.map(({ startAt, endAt }) => ({ startAt, endAt })),
    deferredPeriods: after.periods.map(({ startAt, endAt }) => ({ startAt, endAt })),
    savingsCents: before.costCents - after.costCents, householdSavingsCents,
    sharedPlanChanged: existingAllowance && (after.costCents > before.costCents + 1e-7
      || householdSavingsCents < -1e-7 || riskAdjustedSavingsCents < -1e-7),
    normalUncertaintyPremiumCents: before.uncertaintyPremiumCents ?? 0,
    uncertaintyPremiumCents: after.uncertaintyPremiumCents ?? 0,
    normalHouseholdUncertaintyPremiumCents: sum(normal, 'uncertaintyPremiumCents'),
    householdUncertaintyPremiumCents: sum(deferred, 'uncertaintyPremiumCents'), riskAdjustedSavingsCents,
    normalUsesForecast: before.usesForecast,
    deferredUsesForecast: after.usesForecast,
    usesForecast: connected.some(charger => normal.plans[charger.id].usesForecast || deferred.plans[charger.id].usesForecast),
    recommended: before.costCents > after.costCents && householdSavingsCents > 0 && riskAdjustedSavingsCents > 1e-7,
    forecastUncertaintyCtPerKwh: 2,
    remainingGridKwh: selected.requiredGridKwh,
    chargers: connected.map(charger => ({ id: charger.id, requiredGridKwh: charger.requiredGridKwh,
      normalCostCents: normal.plans[charger.id].costCents, deferredCostCents: deferred.plans[charger.id].costCents })) };
}
