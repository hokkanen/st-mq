/** Saved intervals and periodic report coverage include artificial hold edges.
 * Curving through both edges still draws a staircase. Retain each real knot and
 * the terminal supported edge, dropping only an intermediate hold endpoint when
 * the next reading belongs to the same continuous source. Original objects and
 * explicit gaps survive; this changes display geometry, never stored evidence. */
export function temperatureIntervalKnots(points) {
  const result = [];
  const observations = new Set(points.filter(point => Number.isFinite(point.y) && !point.displayBoundary).map(point => point.x));
  let anchor, tail;
  const sameQuality = (a, b) => a === b || Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => value === b[index]);
  const sameEvidence = (a, b) => a.source === b.source && sameQuality(a.quality, b.quality);
  const periodic = point => point.periodicCoverage && point.coverageId !== undefined;
  const interval = point => Number.isFinite(point.intervalStart) && Number.isFinite(point.intervalEnd);
  const grouped = point => periodic(point) || interval(point);
  const sameGroup = (a, b) => periodic(a) && periodic(b) ? a.coverageId === b.coverageId
    : !periodic(a) && !periodic(b) && interval(a) && interval(b)
      && a.intervalStart === b.intervalStart && a.intervalEnd === b.intervalEnd;
  const flush = () => {
    if (tail && result.at(-1) !== tail) result.push(tail);
    anchor = tail = undefined;
  };
  for (const point of points) {
    // A detail response can include the genuine neighbours of an interpolated
    // viewport edge. Let those knots define the cubic rather than pinning it to
    // the API's earlier linear clip value. Never discard a terminal boundary.
    if (point.displayBoundary && point.interpolated && observations.has(point.observedAt) && observations.has(point.nextObservedAt)) continue;
    if (!Number.isFinite(point.y) || !grouped(point)) {
      flush(); result.push(point); continue;
    }
    const same = anchor && sameGroup(anchor, point) && point.y === anchor.y && sameEvidence(anchor, point)
      && (!periodic(point) || point.observedAt === anchor.observedAt);
    // Periodic endpoints are explicitly display-only. Interval projections
    // identify their duplicated final edge by its original interval boundary.
    const holdEdge = same && (periodic(point) ? point.displayBoundary === true
      : point.x >= point.intervalEnd - 1);
    if (!holdEdge) {
      // Reduced envelopes can omit whole intervening intervals. Their old end
      // metadata is not a new gap; explicit null markers delimit lost freshness.
      if (anchor && !sameEvidence(anchor, point)) flush();
      result.push(point); anchor = point;
    }
    tail = point;
  }
  flush();
  return result;
}
