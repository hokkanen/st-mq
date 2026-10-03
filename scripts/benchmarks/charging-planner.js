import { performance } from 'node:perf_hooks';
import { planChargers, forecastFixedPlans } from '../../src/charging/planner.js';
import { chargingPlannerWorkload } from '../../test/support/charging-planner-workload.js';

// Offline only: no configuration, database, provider or equipment is opened.
const measure = operation => {
  const started = performance.now();
  const result = operation();
  return { result, elapsedMs: performance.now() - started };
};
const rounded = value => Math.round(value * 100) / 100;
const results = [];
for (const priority of ['balanced', 'charger1', 'charger2']) {
  const input = chargingPlannerWorkload({ priority });
  const cold = measure(() => planChargers(input));
  const warm = measure(() => planChargers(input));
  const periodsByCharger = Object.fromEntries(Object.entries(warm.result.plans).map(([id, plan]) => [id, plan.periods]));
  const fixed = Array.from({ length: 10 }, () => measure(() => forecastFixedPlans({ ...input, periodsByCharger })));
  results.push({ priority, feasible: warm.result.feasible,
    coldSearchMs: rounded(cold.elapsedMs), warmSearchMs: rounded(warm.elapsedMs),
    fixedForecastMeanMs: rounded(fixed.reduce((sum, item) => sum + item.elapsedMs, 0) / fixed.length),
    fixedForecastMaxMs: rounded(Math.max(...fixed.map(item => item.elapsedMs))),
    costCents: warm.result.solver.cashCostCandidateCents,
    candidateLimitPerJob: warm.result.solver.candidateLimitPerJob,
  });
}
console.log(JSON.stringify({ host: `${process.platform}/${process.arch}`, node: process.version,
  fixture: { hours: 24, chargers: 2, priceIntervals: 96, householdScenariosPerInterval: 6 }, results,
  note: 'Synthetic synchronous planner throughput. Worker responsiveness is tested separately; this does not qualify native Raspberry Pi or household hardware.',
}, null, 2));
