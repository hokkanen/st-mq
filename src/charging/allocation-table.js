// Exact forecast allocation reuse. No runtime, storage, configuration or authority.
// Both supported chargers use all three phases. For two adjustable, outstanding
// balanced requests, whole-amp filling is a merge of two ordered priority lists.
// All household scenarios can use prefixes of that one merge. Identical merges
// also have identical results for this resource, even if request weights differ.
const EPS = 1e-7, HOUR = 3_600_000, SLICE = 900_000;
const tables = new WeakMap();
const compiled = new Map();
const internLayouts = true;
export const allocationTableStats = { calls: 0, eligible: 0, hits: 0, misses: 0, scenarios: 0, steps: 0, layoutsReused: 0 };
const energy = item => Math.max(item.charger.requiredGridKwh,
  Number.isFinite(item.charger.referenceGridKwh) ? item.charger.referenceGridKwh : 0,
  item.charger.requiredGridKwh + (Number.isFinite(item.charger.sessionCost?.recordedGridKwh)
    ? Math.max(0, item.charger.sessionCost.recordedGridKwh) : 0));
const ratio = item => energy(item) > EPS ? item.remaining / energy(item) : 0;
const before = (a, b, at) => Number(b.remaining > EPS && b.allocationHold?.chargerId === b.charger.id && at < b.allocationHold.end)
  - Number(a.remaining > EPS && a.allocationHold?.chargerId === a.charger.id && at < a.allocationHold.end)
  || ratio(b) - ratio(a) || a.targetAt - b.targetAt
  || (Math.floor(at / SLICE) % 2 ? b.charger.id.localeCompare(a.charger.id) : a.charger.id.localeCompare(b.charger.id));

export function allocationTable(active, resource, at, fallback) {
  allocationTableStats.calls++;
  if (active.length !== 2 || active[0].priority !== 'balanced' || !resource.scenarios?.length
    || !active.every(item => item.remaining >= 0 && Number.isFinite(item.remaining)
      && item.electric.currentA >= 6 && Number.isFinite(item.electric.currentA)
      && Number.isFinite(item.electric.deliveryCurrentA) && item.electric.voltageV >= 200 && item.electric.voltageV <= 250
      && item.electric.phases.count === 3 && item.electric.phases.mask.every(n => n === 1))) return null;
  const external = active.find(item => item.charger.capabilities.externalLoadBalancing);
  const flexible = active.find(item => !item.charger.capabilities.externalLoadBalancing
    && (item.charger.capabilities.currentControl || item.electric.currentAssumed));
  if (!external || !flexible || external === flexible || external.charger.id === flexible.charger.id) return null;
  const weights = [external, flexible].map(item => Math.max(.01, item.remaining
    / Math.max(1 / 60, (item.targetAt - Math.max(at,
      item.charger.values?.vehicleNotBefore?.available === false ? 0 : item.charger.values?.vehicleNotBefore?.value ?? 0)) / HOUR)
    * 1000 / (item.electric.voltageV * item.electric.phases.count)));
  if (!weights.every(Number.isFinite)) return null;
  allocationTableStats.eligible++;
  let byFirst = tables.get(resource);
  if (!byFirst) { byFirst = new WeakMap(); tables.set(resource, byFirst); }
  let bySecond = byFirst.get(external.electric);
  if (!bySecond) { bySecond = new WeakMap(); byFirst.set(external.electric, bySecond); }
  let table = bySecond.get(flexible.electric);
  if (!table) {
    if (resource.scenarios.some(row => row.phaseHeadroomA.length !== 3
      || row.phaseHeadroomA.some(n => !Number.isFinite(n) || n < 0) || !Number.isFinite(row.weight) || row.weight <= 0)) return null;
    const layout = internLayouts ? JSON.stringify([external.charger.id, flexible.charger.id,
      external.electric.currentA, external.electric.deliveryCurrentA,
      flexible.electric.currentA, flexible.electric.deliveryCurrentA, Boolean(flexible.charger.capabilities.currentControl),
      resource.phaseHeadroomA, resource.scenarios.map(row => [row.phaseHeadroomA, row.weight])]) : null;
    table = layout === null ? null : compiled.get(layout);
    if (table) allocationTableStats.layoutsReused++;
    else {
    const maximum = Math.max(...resource.scenarios.map(row => Math.min(...row.phaseHeadroomA.map(n => (n - 6) - 6))));
    const steps = Math.min(600, Math.max(0, Math.floor(maximum + EPS)),
      Math.floor(external.electric.currentA - 6 + EPS) + Math.floor(flexible.electric.currentA - 6 + EPS));
    // An exactly represented numeric signature, never a rounded weight bucket.
    if (steps > 52) return null;
      table = { steps, cache: new Map() };
      if (layout !== null) {
        if (compiled.size >= 128) compiled.delete(compiled.keys().next().value);
        compiled.set(layout, table);
      }
    }
    bySecond.set(flexible.electric, table);
  }
  const pending = Number(external.remaining > EPS) + Number(flexible.remaining > EPS);
  if (pending < 2) {
    // Once only one minimum remains, its weight cannot compete with another
    // outstanding request. Keep the original allocator for the first result;
    // subsequent equivalent states reuse it. Both satisfied weights are fixed
    // at the floor, with shortage alternation retaining its original clock.
    const key = pending === 1 ? external.remaining > EPS ? -1 : -2
      : weights.every(n => n === .01) ? -10 - Number(before(external, flexible, at) <= 0) * 2
        - Number((external.targetAt - flexible.targetAt || external.charger.id.localeCompare(flexible.charger.id)) <= 0) : null;
    if (key === null) return null;
    const cached = table.cache.get(key);
    if (cached) { allocationTableStats.hits++; return cached; }
    if (!fallback) return null;
    allocationTableStats.misses++;
    const result = fallback();
    if (table.cache.size >= 64) table.cache.delete(table.cache.keys().next().value);
    table.cache.set(key, result);
    return result;
  }
  let a = 6, b = 6, signature = 0;
  for (let step = 0; step < table.steps; step++) {
    const canA = a + 1 <= external.electric.currentA + EPS;
    const canB = b + 1 <= flexible.electric.currentA + EPS;
    const chooseA = !canB || canA && (a / weights[0] - b / weights[1]
      || external.targetAt - flexible.targetAt || external.charger.id.localeCompare(flexible.charger.id)) <= 0;
    signature = signature * 2 + Number(chooseA);
    if (chooseA) a++; else b++;
  }
  allocationTableStats.steps += table.steps;
  const externalFirst = before(external, flexible, at) <= 0;
  const key = signature * 2 + Number(externalFirst), cached = table.cache.get(key);
  if (cached) { allocationTableStats.hits++; return cached; }
  allocationTableStats.misses++;
  const counts = new Uint16Array(table.steps + 1);
  let encoded = signature;
  for (let n = table.steps; n > 0; n--) {
    counts[n] = encoded % 2;
    encoded = Math.floor(encoded / 2);
  }
  for (let n = 1; n <= table.steps; n++) counts[n] += counts[n - 1];
  const currents = { [external.charger.id]: 0, [flexible.charger.id]: 0 };
  const phaseCurrentA = [0, 0, 0];
  let suggestion = Infinity;
  for (const scenario of resource.scenarios) {
    allocationTableStats.scenarios++;
    const initial = scenario.phaseHeadroomA, available = Math.min(...initial);
    let ca = 0, cb = 0, headroom;
    if (available >= 12) {
      const initialRemainder = initial.map(n => (n - 6) - 6);
      const n = Math.min(table.steps, Math.max(0, Math.floor(Math.min(...initialRemainder) + EPS)));
      ca = 6 + counts[n]; cb = 6 + n - counts[n];
      headroom = initialRemainder.map(h => Math.max(0, h - n));
    } else if (available >= 6) {
      const ceiling = externalFirst ? external.electric.currentA : flexible.electric.currentA;
      const initialRemainder = initial.map(n => n - 6);
      const n = Math.min(600, Math.max(0, Math.floor(ceiling - 6 + EPS)),
        Math.max(0, Math.floor(Math.min(...initialRemainder) + EPS)));
      if (externalFirst) ca = 6 + n; else cb = 6 + n;
      headroom = initialRemainder.map(h => Math.max(0, h - n));
    } else headroom = [...initial];
    const extra = Math.min(external.electric.currentA - ca, ...headroom);
    if (ca + extra >= 6) { ca += extra; headroom = headroom.map(h => Math.max(0, h - extra)); }
    currents[external.charger.id] += (ca >= 6 ? Math.min(ca, external.electric.deliveryCurrentA) : 0) * scenario.weight;
    currents[flexible.charger.id] += (cb >= 6 ? Math.min(cb, flexible.electric.deliveryCurrentA) : 0) * scenario.weight;
    suggestion = Math.min(suggestion, Math.floor(cb));
    for (let phase = 0; phase < 3; phase++) phaseCurrentA[phase] += (initial[phase] - headroom[phase]) * scenario.weight;
  }
  const result = { currents, suggestions: flexible.charger.capabilities.currentControl
    ? { [flexible.charger.id]: suggestion < 6 ? 0 : suggestion } : {}, admissible: true, phaseCurrentA };
  if (table.cache.size >= 64) table.cache.delete(table.cache.keys().next().value);
  table.cache.set(key, result);
  return result;
}
