/** Actual circulation is reconstructed from reported load, including explicit
 * unavailable markers. Historical requests remain labelled as such before the
 * first independent feedback sample; later missing feedback is never filled by
 * a command. Event-only feeds hold until their next report or disconnect. */
export function addDhwrFeedback({ store, shading, range, now, input }) {
  if (input === 'simulated') return Infinity;
  const scope = "signal='dhwr_active' AND source='mqtt-equipment' AND device='dhwr'";
  const first = store.db.prepare(`SELECT MIN(source_time) AS at FROM observations WHERE ${scope}`).get()?.at;
  if (!Number.isFinite(first)) return Infinity;
  const from = range.from, end = Math.min(range.to, now);
  let previous = store.db.prepare(`SELECT value,source_time,raw FROM observations WHERE ${scope}
    AND source_time<? ORDER BY source_time DESC,id DESC LIMIT 1`).get(from);
  const flush = until => {
    if (previous?.value !== 1) return;
    let maxAgeMs = 120_000, valid = false;
    try { const raw = JSON.parse(previous.raw); valid = raw?.verified === true;
      maxAgeMs = raw?.eventOnly ? Infinity : raw?.maxAgeMs ?? maxAgeMs; } catch { /* Unverified history leaves a gap. */ }
    if (valid) shading.add(Math.max(previous.source_time, from), Math.min(until, previous.source_time + maxAgeMs, end));
  };
  for (const row of store.db.prepare(`SELECT value,source_time,raw FROM observations WHERE ${scope}
    AND source_time>=? AND source_time<? ORDER BY source_time,id`).iterate(from, end)) {
    flush(row.source_time); previous = row;
  }
  flush(end);
  return first;
}
