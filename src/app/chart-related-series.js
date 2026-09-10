/** Re-project an original step stream at shared display times. Related channels
 * must use these same times, rather than independently holding their extrema.
 * Memory is bounded by the selected display times, not the source row count. */
export class RelatedStepSampler {
  constructor(from, to, times) {
    this.from = from; this.to = to; this.times = times;
    this.exact = new Map(); this.buckets = new Map(); this.count = 0;
    this.firstX = Infinity; this.lastX = -Infinity;
  }
  add(x, y, metadata) {
    if (!Number.isFinite(x) || x < this.from || x > this.to) return;
    if (this.mask?.length) {
      let low = 0, high = this.mask.length;
      while (low < high) { const mid = (low + high) >>> 1; if (this.mask[mid].end <= x) low = mid + 1; else high = mid; }
      if (this.mask[low]?.start <= x) return;
    }
    const point = { ...metadata, x, y: Number.isFinite(y) ? y : null };
    this.count++;
    this.firstX = Math.min(this.firstX, x); this.lastX = Math.max(this.lastX, x);
    let low = 0, high = this.times.length;
    while (low < high) { const mid = (low + high) >>> 1; if (this.times[mid] < x) low = mid + 1; else high = mid; }
    if (this.times[low] === x) {
      const previous = this.exact.get(low)?.[0];
      if (!previous || previous.y !== null || point.y === null) this.exact.set(low, [point]);
      return;
    }
    // Interval projections can overlap or arrive in end-time order. Retain
    // bracketing source groups by their own timestamps, not insertion order.
    let bucket = this.buckets.get(low);
    if (!bucket) { bucket = { first: [point], last: [point], missing: null }; this.buckets.set(low, bucket); }
    else {
      if (x < bucket.first[0].x || x === bucket.first[0].x && (bucket.first[0].y !== null || point.y === null)) bucket.first = [point];
      if (x > bucket.last[0].x || x === bucket.last[0].x && (bucket.last[0].y !== null || point.y === null)) bucket.last = [point];
    }
    if (point.y === null && (!bucket.missing || x < bucket.missing.x)) bucket.missing = point;
  }
  values() {
    if (!this.count) return [];
    const following = new Array(this.times.length); let next = null;
    for (let index = this.times.length - 1; index >= 0; index--) {
      next = this.buckets.get(index + 1)?.first?.[0] ?? next;
      following[index] = next;
      next = this.exact.get(index)?.[0] ?? next;
    }
    const result = []; let previous = null;
    for (let index = 0; index < this.times.length; index++) {
      const bucket = this.buckets.get(index), exact = this.exact.get(index), x = this.times[index];
      if (bucket?.missing) result.push(bucket.missing);
      previous = bucket?.last.at(-1) ?? previous;
      if (x < this.firstX || x > this.lastX) continue;
      if (exact) { result.push(...exact); previous = exact.at(-1); continue; }
      const known = Number.isFinite(previous?.y) && Number.isFinite(following[index]?.y);
      result.push(known ? { ...previous, x, displayBoundary: true, interpolated: false,
        observedAt: previous.observedAt ?? previous.x } : { x, y: null });
    }
    return result;
  }
}

/** Missing markers discovered during projection also join the shared timeline.
 * Preserve every side of a same-time edge; other channels hold their preceding
 * displayed value at that edge rather than jumping to its later value early. */
export function alignRelatedSamples(series) {
  const sources = Object.fromEntries(Object.entries(series).map(([name, points]) => {
    const groups = [];
    for (const point of points) {
      if (groups.at(-1)?.x !== point.x) groups.push({ x: point.x, points: [] });
      groups.at(-1).points.push(point);
    }
    return [name, { groups, index: 0, result: [] }];
  }));
  const times = [...new Set(Object.values(sources).flatMap(source => source.groups.map(group => group.x)))].sort((a, b) => a - b);
  for (const x of times) {
    for (const source of Object.values(sources)) while (source.groups[source.index]?.x < x) source.index++;
    const count = Math.max(...Object.values(sources).map(source => source.groups[source.index]?.x === x
      ? source.groups[source.index].points.length : 0));
    for (let edge = 0; edge < count; edge++) for (const source of Object.values(sources)) {
      // Padding past a source endpoint would look like an explicit missing
      // observation and suppress the browser's separate live carry-forward.
      if (!source.groups.length || x < source.groups[0].x || !source.groups[source.index]) continue;
      const next = source.groups[source.index], exact = next?.x === x ? next.points : [];
      const index = edge - (count - exact.length);
      if (index >= 0) { source.result.push(exact[index]); continue; }
      const previous = source.groups[source.index - 1]?.points.at(-1);
      const known = Number.isFinite(previous?.y) && Number.isFinite(next?.points[0]?.y);
      source.result.push(known ? { ...previous, x, displayBoundary: true, interpolated: false,
        observedAt: previous.observedAt ?? previous.x } : { x, y: null });
    }
  }
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, source.result]));
}
