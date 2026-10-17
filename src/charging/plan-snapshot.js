import { immutableValue, isImmutableValue } from '../domain/immutable.js';

const snapshots = new WeakMap();
const views = new WeakMap();

/** Presentation needs the proposed periods and forecast prices, not the large
 * candidate vectors used only by the search. Keep predicted intervals here. */
export function chargingPlanView(plan) {
  if (!plan) return plan;
  const owned = isImmutableValue(plan);
  if (owned && views.has(plan)) return views.get(plan);
  const { decisionPriceSnapshot, ...result } = plan;
  if (Array.isArray(result.intervals)) result.intervals = result.intervals.map(({ scenarios, ...row }) => row);
  if (owned) {
    const view = immutableValue(result);
    views.set(plan, view);
    return view;
  }
  return result;
}

/** Persist the schedule, allocation, prices, estimates and reference provenance.
 * Scenario vectors are replaceable search inputs, retained by the live planner;
 * neither restart execution, accounting nor replica presentation consumes them.
 * Excluding them also avoids journalling an entire vector on replacement/removal.
 */
export function chargingPlanSnapshot(plan) {
  if (!plan) return plan;
  const owned = isImmutableValue(plan);
  if (owned && snapshots.has(plan)) return snapshots.get(plan);
  const result = { ...chargingPlanView(plan) };
  if (Array.isArray(result.intervals)) result.intervals = result.intervals.filter(row => row.predicted !== true);
  if (Array.isArray(result.accounting)) result.accounting = result.accounting.filter(row => row.predicted !== true);
  if (owned) {
    const snapshot = immutableValue(result);
    snapshots.set(plan, snapshot);
    return snapshot;
  }
  return result;
}
