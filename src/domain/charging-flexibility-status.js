/** Public refusal and comparison messages shared by the API and both cards. */
const DETAILS = {
  'competing-load-unavailable': 'The other charger is active, but its electrical demand cannot currently be estimated.',
  'price-coverage-unavailable': 'Available prices do not cover enough eligible charging time for this request.',
  'electrical-telemetry-unavailable': 'Current or voltage evidence is unavailable, so charging capacity cannot be estimated.',
  'vehicle-start-after-deadline': 'A vehicle timer prevents the requested charging before ready-by.',
  'insufficient-time': 'The modeled charging capacity cannot deliver the requested energy before ready-by.',
  'forecast-unavailable': 'A fresh price forecast is unavailable. No saving can be estimated.',
  'normal-plan-infeasible': 'The earlier ready-by time may not be achievable. A reliable saving cannot be compared.',
  'extended-plan-infeasible': 'The later plan cannot currently be compared. There may be insufficient charging capacity or price coverage.',
  'planning-unavailable': 'A current shared charging plan is not yet available. Try the comparison again shortly.',
  'connection-changed': 'The charging connection changed. Refresh to review its current plan.',
  'comparison-changed': 'The charging plan changed during comparison. Refresh to review current prices and deadlines.',
  'automatic-disabled': 'Turn on Automatic charging to use one-day flexibility.',
  'session-pause': 'Charging is paused for this connection. Use automatic returns to price scheduling before requesting one-day flexibility.',
  'charge-now': 'Charge now takes priority. Return to Automatic charging to use flexibility.',
  'manual-instruction': 'Another charging instruction has priority. Review the charger’s native controls before requesting one-day flexibility.',
  'charging-complete': 'The current charging target has been reached. No extra day is needed for this request.',
  'ready-by-passed': 'The binding ready-by time has passed. Edit Ready by to choose a new deadline.',
  'forecast-disabled': 'Electricity price forecasts are disabled in configuration.',
  'control-unavailable': 'Waiting for confirmed charging control before offering another day. Review the charger’s status and any pending recovery.',
  'read-only': 'Changes are available on the controlling computer.',
  'not-connected': 'Connect a vehicle before requesting one-day flexibility.',
  'already-allowed': 'One more day is already allowed for this connection. Review the active allowance before changing it.',
};

export const chargingFlexibilityReason = reason => typeof reason === 'string' && Object.hasOwn(DETAILS, reason)
  ? DETAILS[reason] : null;
