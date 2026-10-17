import { immutableValue, isImmutableValue } from '../domain/immutable.js';

const snapshots = new WeakMap();

/** Persist the schedule, allocation, prices, estimates and reference provenance.
 * Scenario vectors are replaceable search inputs, retained by the live planner;
 * neither restart execution, accounting nor replica presentation consumes them.
 * Excluding them also avoids journalling an entire vector on replacement/removal.
 */
export function chargingPlanSnapshot(plan) {
  if (!plan) return plan;
  const owned = isImmutableValue(plan);
  if (owned && snapshots.has(plan)) return snapshots.get(plan);
  const { decisionPriceSnapshot, ...result } = plan;
  if (Array.isArray(result.intervals)) result.intervals = result.intervals.filter(row => row.predicted !== true)
    .map(({ scenarios, ...interval }) => interval);
  if (Array.isArray(result.accounting)) result.accounting = result.accounting.filter(row => row.predicted !== true);
  if (owned) {
    const snapshot = immutableValue(result);
    snapshots.set(plan, snapshot);
    return snapshot;
  }
  return result;
}
