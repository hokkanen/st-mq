// Continuous forecast relaxation: continuous expected amp-hours may move freely between
// cars and slots. Native periods, 6 A admission and the sharing policy are
// deliberately relaxed. This is a model bound/seed, never an executable plan.
const HOUR = 3_600_000, EPS = 1e-9;

export function minimumCostFlow({ slots, demands, maxAugmentations = 4096, maxRelaxations = 2_000_000 }) {
  if (!Array.isArray(slots) || !slots.length || slots.length > 512
    || !Array.isArray(demands) || !demands.length || demands.length > 2
    || demands.some(n => !Number.isFinite(n) || n < 0)
    || slots.some(row => !Number.isFinite(row.capacity) || row.capacity < 0
      || row.limits?.length !== demands.length || row.costs?.length !== demands.length
      || row.limits.some(n => !Number.isFinite(n) || n < 0) || !row.costs.every(Number.isFinite))
    || !Number.isSafeInteger(maxAugmentations) || maxAugmentations < 1 || maxAugmentations > 4096
    || !Number.isSafeInteger(maxRelaxations) || maxRelaxations < 1 || maxRelaxations > 2_000_000)
    throw Error('Expected a bounded finite flow model');
  const source = 0, carBase = slots.length + 1, sink = carBase + demands.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const add = (from, to, capacity, cost) => {
    const edge = { to, reverse: graph[to].length, capacity, cost, initial: capacity };
    graph[from].push(edge);
    graph[to].push({ to: from, reverse: graph[from].length - 1, capacity: 0, cost: -cost, initial: 0 });
    return edge;
  };
  const references = slots.map((row, t) => {
    add(source, t + 1, row.capacity, 0);
    return demands.map((_, j) => add(t + 1, carBase + j, row.limits[j], row.costs[j]));
  });
  demands.forEach((demand, j) => add(carBase + j, sink, demand, 0));
  const needed = demands.reduce((a, b) => a + b, 0);
  let flow = 0, augmentations = 0, relaxations = 0, reason = null;
  const distance = new Float64Array(graph.length), previousNode = new Int32Array(graph.length), previousEdge = new Int32Array(graph.length);
  while (flow < needed - EPS) {
    if (augmentations >= maxAugmentations) { reason = 'budget'; break; }
    distance.fill(Infinity); previousNode.fill(-1); distance[source] = 0;
    // Bellman-Ford also handles negative prices and reverse reassignment edges.
    // An unfinished solve publishes no lower bound: partial flow cost would
    // be misleading, particularly when undelivered energy has negative cost.
    for (let pass = 0; pass < graph.length - 1; pass++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        if (!Number.isFinite(distance[from])) continue;
        for (let e = 0; e < graph[from].length; e++) {
          if (++relaxations > maxRelaxations) { reason = 'budget'; break; }
          const edge = graph[from][e], next = distance[from] + edge.cost;
          if (edge.capacity > EPS && next < distance[edge.to] - 1e-12) {
            distance[edge.to] = next; previousNode[edge.to] = from; previousEdge[edge.to] = e; changed = true;
          }
        }
        if (reason) break;
      }
      if (!changed || reason) break;
    }
    if (reason) break;
    if (!Number.isFinite(distance[sink])) { reason = 'infeasible'; break; }
    let amount = needed - flow, node = sink, hops = 0;
    while (node !== source && ++hops <= graph.length) {
      const from = previousNode[node];
      if (from < 0) break;
      amount = Math.min(amount, graph[from][previousEdge[node]].capacity); node = from;
    }
    if (node !== source || amount <= EPS) { reason = 'numerical'; break; }
    for (let to = sink; to !== source; to = previousNode[to]) {
      const edge = graph[previousNode[to]][previousEdge[to]];
      edge.capacity -= amount; graph[to][edge.reverse].capacity += amount;
    }
    flow += amount; augmentations++;
  }
  const solved = reason === null && flow >= needed - EPS;
  const allocation = references.map(row => row.map(edge => edge.initial - edge.capacity));
  const costCents = solved ? allocation.reduce((sum, row, t) => sum + row.reduce((n, amount, j) => n + amount * slots[t].costs[j], 0), 0) : null;
  return { solved, reason, costCents, allocation, augmentations, relaxations };
}

export function relaxedChargingFlow(model, budget = {}) {
  const { jobs, intervals, now } = model;
  if (!jobs.length || jobs.length > 2 || !intervals.length || intervals.length > 512
    || intervals[0].start !== now || intervals.at(-1).end < Math.max(...jobs.map(job => job.targetAt))
    || intervals.some((row, i) => i > 0 && row.start !== intervals[i - 1].end)
    || jobs.some(job => job.electric.phases.count !== 3 || job.electric.phases.mask.some(n => n !== 1)))
    return { solved: false, reason: 'unsupported-horizon', costCents: null };
  const factors = jobs.map(job => 3 * job.electric.voltageV / 1000);
  const slots = intervals.map(row => {
    const scenarios = row.scenarios?.length ? row.scenarios : [{ phaseHeadroomA: row.phaseHeadroomA, weight: 1 }];
    const mean = cap => scenarios.reduce((sum, scenario) => sum + scenario.weight * Math.min(cap, ...scenario.phaseHeadroomA), 0);
    return { capacity: (row.end - row.start) / HOUR * mean(Infinity),
      limits: jobs.map(job => {
        const notBefore = job.charger.values?.vehicleNotBefore;
        const earliest = Math.max(now, notBefore?.available === false ? now : notBefore?.value ?? now);
        return Math.max(0, Math.min(row.end, job.targetAt) - Math.max(row.start, earliest)) / HOUR * mean(job.electric.deliveryCurrentA);
      }), costs: factors.map(factor => factor * row.priceCtPerKwh) };
  });
  const result = minimumCostFlow({ slots, demands: jobs.map((job, j) => job.charger.requiredGridKwh / factors[j]), ...budget });
  // This seed can violate minimum native period/gap rules. Its consumer must
  // reject those violations and replay the complete original sharing policy.
  const periods = Object.fromEntries(jobs.map((job, j) => {
    const rows = [];
    intervals.forEach((row, t) => {
      if ((result.allocation[t]?.[j] ?? 0) <= EPS) return;
      if (rows.at(-1)?.endAt === row.start) rows.at(-1).endAt = row.end;
      else rows.push({ startAt: row.start, endAt: row.end });
    });
    if (rows.length) rows.at(-1).endAt = null;
    return [job.charger.id, rows];
  }));
  return { ...result, periods };
}
