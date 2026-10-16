// Exact forecast allocation reuse. A preferred-charger allocation reserves whole
// required amps, then fills remaining capacity in priority order. Fractional
// request pressure cannot affect that result: any remaining whole-amp filling
// has at most one eligible recipient. Memoize only the exact reservation tiers,
// pending set, resource identity and electrical objects, never rounded energy.
const caches = new WeakMap(), EPS = 1e-7;
const compiled = new Map();
const internLayouts = true;
export const priorityCacheStats = { calls: 0, eligible: 0, hits: 0, misses: 0, layoutsReused: 0 };
export function priorityCache(active, resource, at, fallback) {
  priorityCacheStats.calls++;
  const priority = active[0]?.priority ?? 'balanced';
  if (active.length !== 2 || priority === 'balanced' || !resource.scenarios?.length
    || !active.every(item => item.remaining >= 0 && Number.isFinite(item.remaining)
      && item.electric.currentA >= 6 && Number.isFinite(item.electric.currentA)
      && item.electric.phases.count === 3 && item.electric.phases.mask.every(n => n === 1))) return null;
  const external = active.find(item => item.charger.capabilities.externalLoadBalancing);
  const flexible = active.find(item => !item.charger.capabilities.externalLoadBalancing
    && (item.charger.capabilities.currentControl || item.electric.currentAssumed));
  if (!external || !flexible || external === flexible || ![external.charger.id, flexible.charger.id].includes(priority)) return null;
  const required = [external, flexible].map(item => item.requiredCurrentNow > EPS
    ? Math.min(item.charger.capabilities.externalLoadBalancing ? item.electric.currentA : Math.floor(item.electric.currentA),
      Math.max(6, Math.ceil(item.requiredCurrentNow - EPS))) : 0);
  if (!required.every(Number.isFinite)) return null;
  priorityCacheStats.eligible++;
  let first = caches.get(resource);
  if (!first) { first = new WeakMap(); caches.set(resource, first); }
  let second = first.get(external.electric);
  if (!second) { second = new WeakMap(); first.set(external.electric, second); }
  let cache = second.get(flexible.electric);
  if (!cache) {
    if (resource.scenarios.some(row => row.phaseHeadroomA.length !== 3
      || row.phaseHeadroomA.some(n => !Number.isFinite(n) || n < 0) || !Number.isFinite(row.weight) || row.weight <= 0)) return null;
    const layout = internLayouts ? JSON.stringify([external.charger.id, flexible.charger.id,
      external.electric.currentA, external.electric.deliveryCurrentA,
      flexible.electric.currentA, flexible.electric.deliveryCurrentA, Boolean(flexible.charger.capabilities.currentControl),
      resource.phaseHeadroomA, resource.scenarios.map(row => [row.phaseHeadroomA, row.weight])]) : null;
    cache = layout === null ? null : compiled.get(layout);
    if (cache) priorityCacheStats.layoutsReused++;
    else {
      cache = new Map();
      if (layout !== null) {
        if (compiled.size >= 128) compiled.delete(compiled.keys().next().value);
        compiled.set(layout, cache);
      }
    }
    second.set(flexible.electric, cache);
  }
  const pending = Number(external.remaining > EPS) + Number(flexible.remaining > EPS) * 2;
  const key = `${priority}:${pending}:${required[0]}:${required[1]}`;
  const result = cache.get(key);
  if (result) { priorityCacheStats.hits++; return result; }
  priorityCacheStats.misses++;
  const calculated = fallback();
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, calculated);
  return calculated;
}
