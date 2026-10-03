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
