// Bounded forecast schedule refinement. The caller supplies one prepared model and its
// existing exact simulator/comparator. No source selection, runtime, commands,
// database or publication is reachable from this module.
export function refinePeriods({ model, periods, simulate, compare, maxEvaluations = 256,
  maxPasses = 4, extraSeeds = [], steps = [900_000, 300_000, 60_000, 10_000, 1000] }) {
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 4096
    || !Number.isSafeInteger(maxPasses) || maxPasses < 1 || maxPasses > 8)
    throw Error('Charging refinement requires a bounded evaluation budget');
  const ids = model.jobs.map(job => job.charger.id), cache = new Map();
  const objective = result => result.costCents + result.uncertaintyPremiumCents;
  // Improve the incumbent only after full joint simulation. Monetary plan
  // replacement policy belongs to the runtime; numerical ties use its existing
  // schedule comparator here.
  const better = (a, b) => objective(a) < objective(b) - 1e-7
    || Math.abs(objective(a) - objective(b)) <= 1e-7 && compare(a, b, model.jobs) < 0;
  let evaluations = 0, hits = 0, improvements = 0, exhausted = false;
  const practical = candidate => model.jobs.every(job => {
    const p = candidate[job.charger.id], limit = job.charger.capabilities.maxSchedulePeriods;
    if (!p?.length || Number.isInteger(limit) && limit > 0 && p.length > limit) return false;
    // Already accepted native periods retain their exact physical meaning;
    // they may have started earlier or have a finite native stop.
    if (job.fixedPeriods) return JSON.stringify(p) === JSON.stringify(job.fixedPeriods);
    if (job.committedPeriod && (p[0].startAt > model.now
      || p[0].endAt !== null && p[0].endAt < job.committedPeriod.endAt)) return false;
    return p.every((row, i) => Number.isFinite(row.startAt) && (row.startAt >= model.now
      || i === 0 && row.startAt === job.committedPeriod?.startAt)
      && (i === p.length - 1 ? row.endAt === null : Number.isFinite(row.endAt)
        && row.endAt - row.startAt >= 900_000 && p[i + 1].startAt - row.endAt
          >= (job.charger.capabilities.localClockSchedule ? 600_001 : 600_000)));
  });
  const assess = candidate => {
    const key = JSON.stringify(candidate), saved = cache.get(key);
    if (saved) { hits++; return saved; }
    if (evaluations >= maxEvaluations) { exhausted = true; return null; }
    evaluations++;
    const starts = Object.fromEntries(ids.map(id => [id, candidate[id][0].startAt]));
    const result = { ...simulate({ starts, periods: candidate, jobs: model.jobs, intervals: model.intervals, details: false }),
      starts, periods: candidate };
    cache.set(key, result);
    return result;
  };
  const initial = structuredClone(periods);
  if (!practical(initial)) return { periods: initial, result: null, skipped: 'unsupported-incumbent', evaluations, hits, improvements, exhausted };
  let best = { periods: initial, result: assess(initial) };
  if (!best.result?.feasible) return { ...best, skipped: 'infeasible-incumbent', evaluations, hits, improvements, exhausted };
  const initialObjective = best.result.costCents + best.result.uncertaintyPremiumCents;
  // Score cheap independent seeds before spending the budget on local moves.
  // Otherwise one long refinement can consume the budget before a better
  // flow-derived starting point is ever examined.
  const seeds = [best];
  for (const seed of extraSeeds.slice(0, 3)) {
    if (!practical(seed)) continue;
    const result = assess(seed);
    if (result?.feasible) seeds.push({ periods: structuredClone(seed), result });
  }
  seeds.sort((a, b) => objective(a.result) - objective(b.result));
  for (const seed of seeds) if (better(seed.result, best.result)) best = seed;
  for (const seed of seeds) {
    let current = seed;
    for (const step of steps) {
      if (!Number.isSafeInteger(step) || step < 1000) throw Error('Native schedule times use whole-second steps');
      for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;
        for (const job of model.jobs) {
          if (job.fixedPeriods) continue;
          const id = job.charger.id;
          for (let i = 0; i < current.periods[id].length; i++) for (const edge of ['startAt', 'endAt', 'both']) {
            if (edge !== 'startAt' && current.periods[id][i].endAt === null) continue;
            let selected = current;
            for (const delta of [-step, step]) {
              const candidate = structuredClone(current.periods);
              for (const field of edge === 'both' ? ['startAt', 'endAt'] : [edge]) candidate[id][i][field] += delta;
              if (!practical(candidate)) continue;
              const assessed = assess(candidate);
              if (assessed?.feasible && better(assessed, selected.result))
                selected = { periods: candidate, result: assessed };
            }
            if (selected !== current) { current = selected; changed = true; improvements++; }
          }
        }
        if (!changed || exhausted) break;
      }
      if (better(current.result, best.result)) best = current;
      if (exhausted) break;
    }
    if (exhausted) break;
  }
  return { ...best, improvementCents: initialObjective - best.result.costCents - best.result.uncertaintyPremiumCents,
    evaluations, hits, improvements, exhausted };
}
