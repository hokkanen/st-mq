import { immutableChargingValue } from './immutable.js';
import { chargingPlannerInput } from './planner-input.js';
import { chargingElectrical } from './planner.js';

export const BACKGROUND_PLAN_SETTLING_MS = 10_000;
export const BACKGROUND_PLAN_MAX_WAIT_MS = 60_000;
export const IMMINENT_PLAN_MS = 120_000;
const EPS = 1e-7;
const remaining = (rows, now, end = Infinity) => rows.filter(row => row.end > now && row.start < end)
  .map(row => ({ ...row, start: Math.max(now, row.start), end: Math.min(end, row.end) }));
const price = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const close = (a, b, tolerance) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((n, i) => Number.isFinite(n) && Number.isFinite(b[i]) ? Math.abs(n - b[i]) < tolerance : n === b[i]);

/** Economic identity has no authority. Native command preflight, telemetry
 * recording, current allocation and identification keep their own clocks. */
export function economicPlanningState(options, scope) {
  const input = chargingPlannerInput(options), supply = input.supply ?? {};
  const chargers = input.chargers.map((charger, i) => {
    const view = options.chargers[i], electric = chargingElectrical(charger, supply);
    const controlled = charger.settings.enabled && charger.capabilities.scheduling && !charger.control.manual;
    return { id: charger.id, deadlineAt: charger.deadlineAt, allocationTargetAt: charger.allocationTargetAt,
      settings: charger.settings, capabilities: charger.capabilities, request: charger.request,
      control: { manual: charger.control.manual }, connected: charger.values.connected,
      battery: ['soc', 'minimumSoc', 'vehicleCeilingSoc', 'capacityKwh'].map(key => {
        const field = view.values[key]; return [field?.value, field?.available, field?.assumed, field?.source];
      }), vehicleNotBefore: charger.values.vehicleNotBefore,
      electrical: { currentA: electric.currentA, deliveryCurrentA: electric.deliveryCurrentA,
        available: electric.available, assumptions: electric.assumptions },
      independent: controlled ? null : { released: charger.control.released,
        charging: charger.values.charging, start: charger.values.scheduledStartAt, end: charger.values.scheduledEndAt,
        endKind: charger.telemetry.scheduledEndKind, manualStop: charger.telemetry.manualStop },
      quality: view.telemetry?.providerConnected !== false };
  });
  const household = immutableChargingValue((options.household ?? []).map(row => ({ start: row.start, end: row.end,
    phaseCurrentA: row.phaseCurrentA, scenarios: row.scenarios,
    basis: row.basis, noHistory: row.reference?.noHistory === true })));
  const prices = (options.prices ?? []).map(row => ({ start: row.start, end: row.end,
    price: price(row), predicted: row.predicted === true, uncertainty: row.predicted === true ? row.uncertaintyCtPerKwh ?? 2 : 0 }));
  return { at: options.now, hard: JSON.stringify({ scope, priority: options.priority, chargers,
      budget: supply.configuredBudgetCurrentA ?? supply.estimate?.budgetCurrentA ?? supply.availableCurrentA,
      budgetQuality: supply.estimate?.quality,
      ...(!supply.configuredBudgetCurrentA && !supply.estimate?.budgetCurrentA
        ? { property: supply.propertyCurrentA, charger: supply.chargerCurrentA } : {}) }),
    voltage: options.chargers.map(charger => chargingElectrical(charger, supply).voltageV),
    household, prices, end: Math.max(options.now, ...options.chargers.map(charger => charger.deadlineAt)),
    requests: options.chargers.map(charger => ({ id: charger.id, remaining: charger.requiredGridKwh })),
    schedulable: options.chargers.some(charger => charger.settings.enabled && charger.capabilities.scheduling
      && !charger.request?.pause && !charger.request?.chargeNow && !charger.control?.manual
      && charger.values.connected?.value === true && charger.requiredGridKwh > EPS) };
}

function householdClose(before, after, now, end) {
  const a = remaining(before, now, end), b = remaining(after, now, end);
  return a.length === b.length && a.every((row, i) => {
    const other = b[i];
    return row.start === other.start && row.end === other.end && row.basis === other.basis && row.noHistory === other.noHistory
      && close(row.phaseCurrentA, other.phaseCurrentA, .25)
      && (row.scenarios ?? []).length === (other.scenarios ?? []).length
      && (row.scenarios ?? []).every((scenario, j) => Math.abs(scenario.weight - other.scenarios[j].weight) < EPS
        && close(scenario.phaseCurrentA, other.scenarios[j].phaseCurrentA, .25));
  });
}

/** Compare to the last searched model so small changes accumulate. A moved
 * horizon start or renewed receipt is not a changed future model. */
export function economicPlanningChange(previous, next, now) {
  if (!previous || now < previous.at || previous.hard !== next.hard) return 'hard';
  const before = remaining(previous.prices, now, next.end), after = remaining(next.prices, now, next.end);
  if (!same(before, after)) {
    if (!same(before.filter(row => !row.predicted), after.filter(row => !row.predicted))) return 'hard-price';
    return 'soft';
  }
  if (!close(previous.voltage, next.voltage, 1)
    || !householdClose(previous.household, next.household, now, next.end)) return 'soft';
  return null;
}

export function economicProgressChange(previous, next, plans, now) {
  if (!previous) return false;
  return next.requests.some(request => {
    const before = previous.requests.find(row => row.id === request.id), plan = plans[request.id];
    if (!before || !plan?.accounting?.length) return false;
    let expected = 0, powerKw = 0;
    for (const row of plan.accounting) {
      if (!(row.end > row.start) || !(row.energyKwh > 0)) continue;
      const power = row.energyKwh * 3_600_000 / (row.end - row.start);
      powerKw = Math.max(powerKw, power);
      expected += power * Math.max(0, Math.min(now, row.end) - Math.max(previous.at, row.start)) / 3_600_000;
    }
    const deviation = request.remaining - Math.max(0, before.remaining - expected);
    return Math.abs(deviation) > Math.max(.01, powerKw * IMMINENT_PLAN_MS / 3_600_000);
  });
}

/** Only meaningful changes move the quiet deadline. Irrelevant receipts cannot
 * postpone the fixed maximum; urgent work bypasses both limits. */
export function backgroundPlanDeadline({ now, pending, key, urgent = false }) {
  if (urgent) return { pending: null, until: null };
  const next = !pending || now < pending.firstAt ? { firstAt: now, lastAt: now, key }
    : pending.key === key ? pending : { ...pending, lastAt: now, key };
  const until = Math.min(next.lastAt + BACKGROUND_PLAN_SETTLING_MS, next.firstAt + BACKGROUND_PLAN_MAX_WAIT_MS);
  return { pending: next, until: now < until ? until : null };
}
