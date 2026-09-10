/** Align visible power components from bottom to top, preserving both sides of
 * duplicate step edges, explicit gaps and each component's tooltip provenance.
 *
 * Callers omit hidden components before stacking. An unavailable lower component
 * leaves the cumulative position of every component above it unknown; it never
 * changes the independently known components beneath it. A caller can display a
 * component separately if its whole range has no supported cumulative position.
 */
export function stackPowerSeries(components = []) {
  const aligned = alignStepSeries(components);
  return aligned.map((points, component) => points.map((point, index) => {
    if (!component) return point;
    let total = 0;
    for (let lower = 0; lower <= component; lower++) {
      const value = aligned[lower][index].y;
      if (!Number.isFinite(value)) { total = null; break; }
      total += value;
    }
    return { ...point, componentValue: point.y, y: total };
  }));
}

/** Sample step curves on one timeline before selecting display points. Both
 * sides of coincident edges and gaps stay aligned, including unstacked totals. */
export function alignStepSeries(components = []) {
  const first = components[0] ?? [];
  if (first.every((point, index) => Number.isFinite(point.x) && (!index || point.x >= first[index - 1].x))
    && components.every(points => points.length === first.length && points.every((point, index) => point.x === first[index].x))) {
    return components.map(points => points.slice());
  }
  const sources = components.map(groupPoints);
  const times = [...new Set(sources.flatMap(source => source.groups.map(group => group.x)))].sort((a, b) => a - b);
  const result = components.map(() => []);
  for (const x of times) {
    for (const source of sources) while (source.groups[source.index]?.x < x) source.index++;
    const count = Math.max(1, ...sources.map(source => source.groups[source.index]?.x === x ? source.groups[source.index].points.length : 0));
    for (let edge = 0; edge < count; edge++) {
      for (const [index, source] of sources.entries()) {
        const point = pointAt(source, x, edge, count);
        result[index].push(point);
      }
    }
  }
  return result;
}

function groupPoints(points = []) {
  const groups = [];
  for (const point of points.filter(point => Number.isFinite(point.x)).sort((a, b) => a.x - b.x)) {
    if (groups.at(-1)?.x !== point.x) groups.push({ x: point.x, points: [] });
    groups.at(-1).points.push(point);
  }
  return { groups, index: 0 };
}

function pointAt(source, x, edge, count) {
  const next = source.groups[source.index];
  const exact = next?.x === x ? next.points : [];
  const exactIndex = edge - (count - exact.length);
  if (exactIndex >= 0) return { ...exact[exactIndex], x };
  const previous = source.groups[source.index - 1]?.points.at(-1);
  const following = next?.points[0];
  // Missing samples and final timestamps delimit supported display segments.
  // An unavailable baseline cannot become zero, even for an upper valid load.
  if (!Number.isFinite(previous?.y) || !Number.isFinite(following?.y)) return { x, y: null };
  const held = following.carriedForward && previous.y === following.y ? following : previous;
  // API envelopes may omit intermediate energy intervals. Keep their tooltip
  // metadata, while using display endpoints and null markers to delimit gaps.
  return { ...held, x, y: previous.y, displayBoundary: true, observedAt: held.observedAt ?? held.x, interpolated: false };
}
