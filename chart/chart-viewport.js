const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' });
const localHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', hour: '2-digit', hourCycle: 'h23' });
const finite = Number.isFinite;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Keep an interval inside the dates explicitly selected by the user. */
export function clampView(view, bounds, minSpan = minute) {
  if (!finite(bounds?.from) || !finite(bounds?.to) || bounds.to <= bounds.from) throw new RangeError('A finite, increasing chart range is required.');
  if (!finite(view?.from) || !finite(view?.to) || view.to <= view.from) return { from: bounds.from, to: bounds.to };
  const span = clamp(view.to - view.from, finite(minSpan) ? Math.max(1, minSpan) : minute, bounds.to - bounds.from);
  // The entire selection may itself be shorter than the minimum zoom span.
  if (span >= bounds.to - bounds.from) return { from: bounds.from, to: bounds.to };
  const center = view.from + (view.to - view.from) / 2;
  const from = clamp(center - span / 2, bounds.from, bounds.to - span);
  return { from, to: from + span };
}

export function zoomView(view, bounds, factor, anchor = 0.5, minSpan = minute) {
  const current = clampView(view, bounds, minSpan);
  if (!finite(factor) || factor <= 0) return current;
  const fraction = finite(anchor) ? clamp(anchor, 0, 1) : 0.5;
  const span = Math.min(bounds.to - bounds.from, Math.max(finite(minSpan) ? Math.max(1, minSpan) : minute, (current.to - current.from) / factor));
  const from = current.from + (current.to - current.from) * fraction - span * fraction;
  return clampView({ from, to: from + span }, bounds, minSpan);
}

export function panView(view, bounds, fraction) {
  const current = clampView(view, bounds, 1);
  const shift = finite(fraction) ? (current.to - current.from) * fraction : 0;
  return clampView({ from: current.from + shift, to: current.to + shift }, bounds, 1);
}

function localDate(at) {
  const parts = Object.fromEntries(calendar.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function midnight(date) {
  const at = Date.parse(`${date}T00:00:00Z`);
  // In Finland a daylight-saving transition occurs after local midnight.
  return at - Number(localHour.format(at)) * hour;
}

function alignedTicks(view, unit, step, limit) {
  const result = [];
  function append(at) { if (at > view.from && at < view.to) result.push(at); }
  if (unit === 'minute') {
    for (let at = Math.floor(view.from / (step * minute)) * step * minute; at < view.to; at += step * minute) {
      append(at); if (result.length > limit) break;
    }
  } else if (unit === 'hour') {
    for (let at = Math.floor(view.from / hour) * hour; at < view.to; at += hour) {
      if (Number(localHour.format(at)) % step === 0) append(at);
      if (result.length > limit) break;
    }
  } else {
    const date = new Date(`${localDate(view.from)}T00:00:00Z`);
    if (unit === 'day') {
      for (let epochDay = Math.floor(date.getTime() / day / step) * step; ; epochDay += step) {
        const at = midnight(new Date(epochDay * day).toISOString().slice(0, 10));
        if (at >= view.to) break;
        append(at); if (result.length > limit) break;
      }
    } else if (unit === 'month') {
      for (let month = Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / step) * step; ; month += step) {
        const at = midnight(new Date(Date.UTC(Math.floor(month / 12), month % 12, 1)).toISOString().slice(0, 10));
        if (at >= view.to) break;
        append(at); if (result.length > limit) break;
      }
    } else {
      for (let year = Math.floor(date.getUTCFullYear() / step) * step; ; year += step) {
        const at = midnight(`${String(year).padStart(4, '0')}-01-01`);
        if (at >= view.to) break;
        append(at); if (result.length > limit) break;
      }
    }
  }
  return result;
}

/** Calendar-aligned Finnish ticks, including the exact visible endpoints.
 * Interior ticks progress from minutes to years as the visible span increases. */
export function viewportTicks(view, maxTicks = 9) {
  if (!finite(view?.from) || !finite(view?.to) || view.to <= view.from) return [];
  const count = finite(maxTicks) ? Math.max(2, Math.floor(maxTicks)) : 9;
  const wanted = (view.to - view.from) / (count - 1);
  const steps = [
    ...[1, 2, 5, 10, 15, 30].map(step => ['minute', step, step * minute]),
    ...[1, 2, 3, 6, 12].map(step => ['hour', step, step * hour]),
    ...[1, 2, 7, 14].map(step => ['day', step, step * day]),
    ...[1, 2, 3, 6].map(step => ['month', step, step * 28 * day]),
    ...[1, 2, 5, 10, 20, 50, 100].map(step => ['year', step, step * 365 * day]),
  ];
  for (const [unit, step, duration] of steps) {
    if (duration < wanted) continue;
    const interior = alignedTicks(view, unit, step, count - 2);
    if (interior.length <= count - 2) return [view.from, ...interior, view.to].map(value => ({ value }));
  }
  return [{ value: view.from }, { value: view.to }];
}

function lowerBound(series, at, after = false) {
  let low = 0, high = series.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (series[middle].x < at || after && series[middle].x === at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Sorted series are clipped with both neighboring timestamp groups intact.
 * Duplicate step edges and the original tooltip metadata remain available. */
export function sliceSeries(series = [], view) {
  if (!series.length || !finite(view?.from) || !finite(view?.to) || view.to < view.from) return [];
  let start = lowerBound(series, view.from), end = lowerBound(series, view.to, true);
  if (start > 0) start = lowerBound(series, series[start - 1].x);
  if (end < series.length) end = lowerBound(series, series[end].x, true);
  return series.slice(start, end);
}

function envelope(points, start, end) {
  let minimum = start, maximum = start;
  for (let index = start; index < end; index++) {
    if (!finite(points[index].y)) continue;
    if (!finite(points[minimum].y) || points[index].y < points[minimum].y) minimum = index;
    if (!finite(points[maximum].y) || points[index].y > points[maximum].y) maximum = index;
  }
  const selected = [...new Set([start, minimum, maximum, end - 1])].sort((a, b) => a - b);
  const result = [];
  for (let choice = 0; choice < selected.length; choice++) {
    const index = selected[choice], previous = selected[choice - 1];
    if (choice && finite(points[previous].y) && finite(points[index].y)) {
      // Every omitted outage still breaks the line. One original null suffices
      // even if several outages were below the available screen resolution.
      for (let gap = previous + 1; gap < index; gap++) {
        if (!finite(points[gap].y)) { result.push(points[gap]); break; }
      }
    }
    result.push(points[index]);
  }
  return result;
}

/** A bounded display envelope, not a new measurement or an aggregate value.
 * At most budget points are returned, retaining original objects and gaps.
 * Do not reduce cumulative power-stack components independently: all components
 * must retain shared indices, or be left together at their existing resolution. */
export function reduceSeries(series = [], view, budget = 500) {
  const points = sliceSeries(series, view);
  const limit = finite(budget) ? Math.max(0, Math.floor(budget)) : 500;
  if (points.length <= limit) return points;
  if (!limit) return [];
  if (limit < 7) {
    const gap = points.find(point => !finite(point.y));
    if (limit === 1) return [gap ?? points[0]];
    if (gap && limit === 2) return [gap, points.at(-1)];
    return gap ? [points[0], gap, points.at(-1)] : [points[0], points.at(-1)];
  }
  // Four original envelope points plus at most three gap markers per bucket.
  const buckets = Math.floor(limit / 7);
  const result = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    result.push(...envelope(points, Math.floor(bucket * points.length / buckets), Math.floor((bucket + 1) * points.length / buckets)));
  }
  return result;
}

function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Debounced refinement with one request in flight and one latest pending view.
 * Panning never aborts running work. Only invalidate/close cancel a request.
 * query(selection) supplies the API path; callbacks receive original selections.
 * request(null) ends interest in detail while retaining running work and cache.
 * Cache keys include the entire selection and path, including dates and points. */
export function createDetailLoader({ api, query, onData = () => {}, onStatus = () => {}, delay = 180, maxEntries = 8, ttl = 30_000, now = Date.now }) {
  const cache = new Map();
  let active, pending, wanted, timer, generation = 0, closed = false, state = 'idle';
  function status(next, error) {
    if (closed || state === next && !error) return;
    state = next; onStatus(next, error);
  }
  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function cached(entry) {
    const item = cache.get(entry.key);
    if (!item) return;
    cache.delete(entry.key);
    if (now() - item.at >= ttl) return;
    cache.set(entry.key, item);
    return item;
  }
  function remember(entry, data) {
    if (maxEntries <= 0) return;
    cache.delete(entry.key); cache.set(entry.key, { data, at: now() });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }
  async function pump() {
    if (closed || active || !pending?.ready) return;
    const entry = pending; pending = undefined;
    const request = { entry, generation, controller: new AbortController() };
    active = request;
    try {
      const data = await api(entry.path, { signal: request.controller.signal });
      if (closed || request.generation !== generation) return;
      remember(entry, data);
      if (wanted?.key === entry.key) { onData(data, wanted.selection); status('idle'); }
    } catch (error) {
      if (!closed && request.generation === generation && wanted?.key === entry.key) status('error', error);
    } finally {
      if (active === request) { active = undefined; void pump(); }
    }
  }
  function request(selection) {
    if (closed) return;
    // Returning to the overview ends interest in detail without wasting work
    // already running. Its eventual result can still warm the bounded cache.
    if (selection === null) {
      clearTimer(); pending = wanted = undefined; status('idle'); return;
    }
    const snapshot = structuredClone(selection);
    const path = query(snapshot);
    const entry = { selection: snapshot, path, key: stableKey([snapshot, path]), ready: false };
    wanted = entry;
    const hit = cached(entry);
    if (hit) {
      clearTimer(); pending = undefined;
      onData(hit.data, snapshot); status('idle'); return;
    }
    status('loading');
    if (active?.entry.key === entry.key) { clearTimer(); pending = undefined; return; }
    if (pending?.key === entry.key) return;
    clearTimer(); pending = entry;
    timer = setTimeout(() => { timer = undefined; entry.ready = true; void pump(); }, Math.max(0, delay));
  }
  function invalidate() {
    if (closed) return;
    generation++; clearTimer(); cache.clear(); pending = wanted = undefined;
    const previous = active; active = undefined; previous?.controller.abort(); status('idle');
  }
  function close() {
    if (closed) return;
    invalidate(); closed = true;
  }
  return { request, invalidate, close };
}
