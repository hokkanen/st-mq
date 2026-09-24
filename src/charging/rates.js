const rate = row => row.priceCtPerKwh ?? row.allInCentsPerKWh ?? row.totalCtPerKwh ?? row.price;
/** Later publications own only their declared intervals; preserve uncovered rates. */
export function canonicalRates(previous = [], current = []) {
  const rows = [...previous, ...current].filter(row => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start && Number.isFinite(rate(row)));
  const events = rows.flatMap((row, index) => [{ at: row.start, index, open: true }, { at: row.end, index, open: false }]).sort((a, b) => a.at - b.at);
  const active = new Set(), heap = [], result = [];
  const push = value => { let i = heap.length; heap.push(value); while (i) { const parent = (i - 1) >> 1; if (heap[parent] >= value) break; heap[i] = heap[parent]; i = parent; } heap[i] = value; };
  const pop = () => { const tail = heap.pop(); if (!heap.length) return; let i = 0; while (i * 2 + 1 < heap.length) { let child = i * 2 + 1; if (child + 1 < heap.length && heap[child + 1] > heap[child]) child++; if (heap[child] <= tail) break; heap[i] = heap[child]; i = child; } heap[i] = tail; };
  let i = 0;
  while (i < events.length) {
    const at = events[i].at;
    while (events[i]?.at === at) { const event = events[i++]; if (event.open) { active.add(event.index); push(event.index); } else active.delete(event.index); }
    while (heap.length && !active.has(heap[0])) pop();
    const end = events[i]?.at;
    if (!heap.length || end === undefined || end <= at) continue;
    const value = rate(rows[heap[0]]), last = result.at(-1);
    if (last?.end === at && last.priceCtPerKwh === value) last.end = end;
    else result.push({ start: at, end, priceCtPerKwh: value });
  }
  return result;
}
/** Binary search plus overlaps: long idle sessions never rescan every price. */
export function priceEnergy(intervals, prices) {
  let cents = 0, pricedKwh = 0, energyKwh = 0, overlaps = 0;
  for (const interval of intervals) {
    if (!Number.isFinite(interval.energyKwh) || interval.energyKwh < 0 || !Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.end <= interval.start) continue;
    energyKwh += interval.energyKwh;
    let low = 0, high = prices.length;
    while (low < high) { const middle = (low + high) >> 1; if (prices[middle].end <= interval.start) low = middle + 1; else high = middle; }
    for (let i = low; i < prices.length && prices[i].start < interval.end; i++) {
      const price = prices[i], start = Math.max(interval.start, price.start), end = Math.min(interval.end, price.end);
      if (end <= start) continue;
      const kwh = interval.energyKwh * (end - start) / (interval.end - interval.start);
      cents += kwh * price.priceCtPerKwh; pricedKwh += kwh; overlaps++;
    }
  }
  return { cents, pricedKwh, unpricedKwh: Math.max(0, energyKwh - pricedKwh), overlaps };
}
