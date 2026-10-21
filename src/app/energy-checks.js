import { propertyEnergyCheckSummary } from './property-energy-checks.js';
import { chargingSessionCheckSummaries } from './charging-session-checks.js';

/** Both summaries share one selected-history snapshot on the history worker. */
export function energyCheckSummaries(store, { now = Date.now(), range = null } = {}) {
  return [propertyEnergyCheckSummary(store, { now, range }), ...chargingSessionCheckSummaries(store, { now, range })];
}
