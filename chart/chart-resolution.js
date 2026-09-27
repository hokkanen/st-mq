import { sliceSeries } from './chart-viewport.js';
import { isInterpolatedTemperature } from '../src/domain/chart-temperatures.js';
import { temperatureIntervalKnots } from './temperature-curves.js';

// The API's point count is a time-bucket target, not a count of returned
// vertices. Extrema, gaps and aligned related channels can add many vertices.
export function chartBucketWidth(source) {
  return (source.range.to - source.range.from) / (source.points ?? 800);
}

/** Keep one complete, coherent response at the finest available resolution.
 * Never mix power components, prices or activity tracks from different levels.
 * Later entries win ties so refreshed data replaces an older cached response. */
export function selectChartResolution(overview, details, view) {
  let best = overview;
  for (const source of details) {
    if (source && source.range.from <= view.from && source.range.to >= view.to
      && chartBucketWidth(source) <= chartBucketWidth(best)) best = source;
  }
  return best;
}

/** Zooming clips the already bounded API envelope without discarding detail.
 * Keep original points, duplicate step edges, missing markers and provenance. */
export function clipChartSeries(series, view) {
  return Object.fromEntries(Object.entries(series).map(([key, points]) => {
    if (!isInterpolatedTemperature(key)) return [key, sliceSeries(points, view)];
    // Remove artificial hold edges before selecting neighbours. Otherwise the
    // one point just beyond a zoom window can be a held edge instead of the next
    // actual reading, and an ostensibly cubic temperature reverts to a plateau.
    const knots = temperatureIntervalKnots(points), nearby = sliceSeries(knots, view);
    if (!nearby.length) return [key, nearby];
    // Monotone tangents need the next neighbour on both sides of a segment.
    // Retain complete timestamp groups (including nulls) around that context.
    const start = knots.indexOf(nearby[0]), end = knots.indexOf(nearby.at(-1));
    let first = Math.max(0, start - 1), last = Math.min(knots.length - 1, end + 1);
    while (first > 0 && knots[first - 1].x === knots[first].x) first--;
    while (last + 1 < knots.length && knots[last + 1].x === knots[last].x) last++;
    return [key, knots.slice(first, last + 1)];
  }));
}

/** Request finer buckets independently of drawing speed. Overlapping windows
 * avoid scanning again for every small movement; existing detail stays visible
 * while the next level loads. All queries remain inside the selected dates. */
export function chartDetailRequest(selection, bounds, view, available) {
  if (view.from <= bounds.from && view.to >= bounds.to) return null;
  const span = view.to - view.from;
  const step = Math.max(60_000, 2 ** Math.floor(Math.log2(span / 4)));
  const viewFrom = Math.max(bounds.from, Math.floor(view.from / step) * step - step);
  const viewTo = Math.min(bounds.to, Math.ceil(view.to / step) * step + step);
  const points = selection.points ?? 800;
  // A request must improve the finest cached covering response by at least
  // 20%, rather than merely repeat the overview or a level already loaded.
  if ((viewTo - viewFrom) / points >= chartBucketWidth(available) * 0.8) return null;
  return { ...selection, points, viewFrom, viewTo };
}
