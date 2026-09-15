const finite = Number.isFinite;
const BAD = new Set(['missing', 'provider_error', 'invalid_numeric', 'invalid_unit', 'conflicting_duplicate']);

/** Read the same completed energy intervals as the chart, including the
 * recorder's durable, not-yet-flushed tail. Never extrapolate across a gap.
 * This is a connection-window query, not another power integrator. */
export function recordedChargingEnergy(store, { id, start, end }) {
  if (!store?.db || !finite(start) || !finite(end) || end <= start) return null;
  const prefix = id === 'charger1' ? 'ev1' : id === 'charger2' ? 'ev2' : null;
  if (!prefix) return null;
  const signals = prefix === 'ev2' ? ['ev2_energy'] : [1, 2, 3].map(n => `ev1_energy_l${n}`);
  const source = prefix === 'ev1' ? 'easee' : 'teslamate', groups = new Map();
  for (const signal of signals) for (const row of store.db.prepare(`SELECT device,signal,value,quality,raw FROM observations
    WHERE signal=? AND source=? AND source_time>? AND source_time<=? AND import_id IS NULL ORDER BY source_time,id`).all(signal, source, start, end)) {
    const raw = JSON.parse(row.raw ?? '{}'), quality = JSON.parse(row.quality ?? '[]');
    if (!finite(row.value) || row.value < 0 || quality.some(flag => BAD.has(flag))) continue;
    const a = raw.intervalStart, b = raw.intervalEnd;
    if (!finite(a) || !finite(b) || b <= a || b > end) continue;
    const key = JSON.stringify([row.device, a, b]);
    if (!groups.has(key)) groups.set(key, { start: a, end: b, values: {} });
    groups.get(key).values[row.signal] = row.value;
  }
  for (const row of store.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%'").all()) {
    const [s, , p] = JSON.parse(row.key.slice('recorder:energy:'.length));
    if (s !== source || p !== prefix) continue;
    const pending = JSON.parse(row.value)?.pending;
    if (!pending || pending.end > end || pending.end <= start || (pending.quality ?? []).some(flag => BAD.has(flag))) continue;
    groups.set(row.key, { ...pending, values: Object.fromEntries(signals.map((signal, i) => [signal, pending.energies[i]])) });
  }
  const intervals = [...groups.values()].filter(row => signals.every(signal => finite(row.values[signal]) && row.values[signal] >= 0))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let gridKwh = 0, coveredMs = 0, cursor = start, continuousSince = null, lastMeasuredAt = null, incomplete = false;
  for (const row of intervals) {
    const a = Math.max(start, row.start), b = Math.min(end, row.end);
    if (b <= a || a < cursor) continue;
    if (a > cursor) { incomplete = true; continuousSince = a; }
    continuousSince ??= a;
    gridKwh += signals.reduce((total, signal) => total + row.values[signal], 0) * (b - a) / (row.end - row.start);
    coveredMs += b - a; cursor = b; lastMeasuredAt = b;
  }
  return { gridKwh, coveredMs, lastMeasuredAt, continuousSince,
    incomplete: incomplete || end - cursor > 120_000, source: 'recorded-charger-energy' };
}
