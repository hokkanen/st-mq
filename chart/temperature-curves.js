/** The API retains both edges of each saved interval. Drawing those artificial
 * hold edges would make even a cubic curve look like a staircase. Use one
 * original interval-start knot, retaining the final held edge and every gap.
 * This is a display view; the source intervals and tooltip provenance survive. */
export function temperatureIntervalKnots(points) {
  const result = [];
  let interval, tail;
  const sameQuality = (a, b) => a === b || Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => value === b[index]);
  const flush = () => {
    if (tail && result.at(-1) !== tail) result.push(tail);
    interval = tail = undefined;
  };
  for (const point of points) {
    if (!Number.isFinite(point.y) || !Number.isFinite(point.intervalStart) || !Number.isFinite(point.intervalEnd)) {
      flush(); result.push(point); continue;
    }
    const same = interval && point.intervalStart === interval.intervalStart && point.intervalEnd === interval.intervalEnd
      && point.y === interval.y && point.source === interval.source && sameQuality(point.quality, interval.quality);
    if (!same) {
      // Reduced envelopes may omit intermediate intervals. Only explicit null
      // markers break coverage; retained interval metadata is provenance.
      if (interval && point.intervalStart > interval.intervalEnd) flush();
      result.push(point); interval = point;
    }
    tail = point;
  }
  flush();
  return result;
}
