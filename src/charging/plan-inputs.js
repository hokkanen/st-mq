const unavailableReasons = new Set([
  'electrical-telemetry-unavailable',
  'equalizer-allowance-unavailable',
  'price-coverage-unavailable',
  'household-history-loading',
  'household-history-unavailable',
]);

// Missing planning evidence cannot supersede an adopted instruction. A modeled
// shortfall or a known vehicle restriction remains a separate release decision.
export const chargingPlanInputsUnavailable = plan => plan?.provisional === true
  && unavailableReasons.has(plan.reason);

// A modeled shortfall may remove an economic hold even if ready-by cannot be
// fully recovered. This shape can only allow charging now, never add a pause.
// Session, revision, native instruction and electrical guards remain separate.
export const chargingServiceRelease = (plan, now) => plan?.feasible === false && plan.provisional === true
  && plan.reason === 'insufficient-time' && plan.periods?.length === 1
  && Number.isSafeInteger(plan.periods[0].startAt) && plan.periods[0].startAt >= 0
  && plan.periods[0].startAt <= now && plan.periods[0].endAt === null;
