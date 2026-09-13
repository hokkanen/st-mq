/** Hourly measured totals are interval quantities, never cumulative daily values.
 * Render one bounded interval per completed hour, with explicit partial coverage. */
export function addShellyEnergy({ store, range, now, input, envelopes }) {
  if (input === 'simulated') return;
  const signal = 'caravan_energy', envelope = envelopes[signal];
  if (envelope) addMeterIntervals({ store, range, now, envelope, signal });
}

function addMeterIntervals({ store, range, now, envelope, signal }) {
  let lastEnd = null;
  for (const row of store.db.prepare(`SELECT value,source_time,quality,raw FROM observations
    WHERE source IN ('shelly-mqtt','mqtt-equipment') AND signal=? AND source_time>? AND source_time<=?
    ORDER BY source_time,id`).iterate(signal, range.from, Math.min(range.to + 3_600_000, now))) {
    let raw, quality;
    try { raw = JSON.parse(row.raw); quality = JSON.parse(row.quality); } catch { continue; }
    if (!Number.isFinite(raw?.intervalStart) || !Number.isFinite(raw?.intervalEnd) || raw.intervalEnd <= raw.intervalStart) continue;
    const start = Math.max(range.from, raw.intervalStart), end = Math.min(range.to, raw.intervalEnd);
    if (end <= start) continue;
    const metadata = { intervalStart: raw.intervalStart, intervalEnd: raw.intervalEnd,
      coveredMs: raw.coveredMs, basis: 'meter-counter-delta', quality, learningRole: 'history-only',
      partialCoverage: quality.includes('partial-coverage'), timeAllocated: quality.includes('time-allocated') };
    if (lastEnd !== null && start > lastEnd) { envelope.add(lastEnd, null); envelope.add(start - 1, null); }
    envelope.add(start, row.value, metadata);
    envelope.add(end - 1, row.value, metadata);
    lastEnd = Math.max(lastEnd ?? -Infinity, end);
  }
  // Adjacent hours share an edge. A missing marker at that timestamp would
  // override the following hour's value in the chart envelope.
  if (lastEnd !== null) envelope.add(lastEnd, null);
}
