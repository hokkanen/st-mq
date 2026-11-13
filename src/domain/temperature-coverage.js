const finite = Number.isFinite;
export const TRIAL_TEMPERATURE_GAP_MS = 30 * 60_000;

/** Availability spans retain real gaps; they never interpolate a measurement. */
export function indoorAvailability(sample, from, to) {
  const members = Object.values(sample.indoorSensors ?? {}).filter(sensor => sensor.weight > 0);
  let spans = [{ start: from, end: to }];
  for (const sensor of members) {
    if (sensor.measurementEligible === false) return [];
    if (!Array.isArray(sensor.reportIntervals)) {
      if (!finite(sensor.value) || sensor.reportCoverageComplete === false) return [];
      continue;
    }
    spans = spans.flatMap(span => sensor.reportIntervals.map(interval => ({
      start: Math.max(span.start, interval.start), end: Math.min(span.end, interval.end),
    })).filter(interval => interval.end > interval.start));
  }
  if (!members.length && (!finite(sample.indoorC) || sample.indoorEstimated)) return [];
  return spans;
}

export function measuredIndoorEndpoint(sample) {
  if (Object.values(sample.indoorSensors ?? {}).some(sensor => sensor.weight > 0 && sensor.measurementEligible === false)) return null;
  return Object.hasOwn(sample, 'indoorEndpointC') ? sample.indoorEndpointC
    : sample.indoorEstimated ? null : sample.indoorC;
}

export function initialTemperatureCoverage(at, measured) {
  return { through: at, initialMeasured: measured, missingSince: null, missingMs: 0, maximumGapMs: 0 };
}

/** Small reconstructible summary over immutable cycle evidence. */
export function advanceTemperatureCoverage(previous, rows) {
  const next = { ...previous };
  for (const row of rows) {
    const available = row.temperatureAvailable ?? (finite(row.indoorC) && !row.indoorControlEstimate);
    if (!available) {
      next.missingSince ??= row.start;
      next.missingMs += row.end - row.start;
      next.maximumGapMs = Math.max(next.maximumGapMs, row.end - next.missingSince);
    } else next.missingSince = null;
    next.through = row.end;
  }
  return next;
}

export function temperatureCoverageUsable(coverage) {
  return coverage?.initialMeasured === true && coverage.missingSince === null
    && coverage.maximumGapMs <= TRIAL_TEMPERATURE_GAP_MS;
}
