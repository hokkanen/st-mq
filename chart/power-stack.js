/** Align visible power components from bottom to top, preserving both sides of
 * duplicate step edges, explicit gaps and each component's tooltip provenance.
 *
 * Callers omit hidden components before stacking. An unavailable lower component
 * leaves the cumulative position of every component above it unknown; it never
 * changes the independently known components beneath it. A caller can display a
 * component separately if its whole range has no supported cumulative position.
 */
export function stackPowerSeries(components = []) {
  const sources = components.map(groupPoints);
  const times = [...new Set(sources.flatMap(source => source.groups.map(group => group.x)))].sort((a, b) => a - b);
  const result = components.map(() => []);
  for (const x of times) {
    for (const source of sources) while (source.groups[source.index]?.x < x) source.index++;
    const count = Math.max(1, ...sources.map(source => source.groups[source.index]?.x === x ? source.groups[source.index].points.length : 0));
    for (let edge = 0; edge < count; edge++) {
      let total = 0;
      for (const [index, source] of sources.entries()) {
        const point = pointAt(source, x, edge, count);
        total = Number.isFinite(total) && Number.isFinite(point.y) ? total + point.y : null;
        result[index].push(index === 0 ? point : { ...point, componentValue: point.y, y: total });
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
  return { ...held, x, y: previous.y };
}
