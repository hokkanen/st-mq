/**
 * Bounded, ordered backend intervals become exact step edges. Null points break
 * the line across unavailable periods and at the final known interval end.
 * Durations are never inferred from the next start or extended to the plot edge.
 */
export function intervalPoints(intervals, valueKey, { limit = 192 } = {}) {
  if (!Array.isArray(intervals)) throw new TypeError('Expected an array of intervals');
  if (!Number.isInteger(limit) || limit < 0 || limit > 512) throw new RangeError('Interval limit must be 0–512');
  if (typeof valueKey !== 'string' || !valueKey) throw new TypeError('An interval value field is required');
  const points = [];
  let previousEnd = null;
  for (let index = 0; index < Math.min(intervals.length, limit); index++) {
    const interval = intervals[index];
    const { start, end } = interval ?? {};
    const value = interval?.[valueKey];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new RangeError('Intervals require valid explicit start and end timestamps');
    if (previousEnd !== null && start < previousEnd) throw new RangeError('Intervals must be sorted and non-overlapping');
    if (value !== null && !Number.isFinite(value)) throw new TypeError('Interval values must be finite or null');
    if (previousEnd !== null && start > previousEnd) points.push({ x: previousEnd, y: null });
    points.push({ x: start, y: value }, { x: end, y: value });
    previousEnd = end;
  }
  if (previousEnd !== null) points.push({ x: previousEnd, y: null });
  return points;
}
