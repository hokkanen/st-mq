const finite = Number.isFinite;

/** Read the same completed energy intervals as the chart, including the
 * recorder's durable, not-yet-flushed tail. Never extrapolate across a gap.
 * This is a connection-window query, not another power integrator. */
export function recordedChargingEnergy(store, { id, start, end, device = null }) {
  if (!store?.db || !finite(start) || !finite(end) || end <= start) return null;
  const prefix = id === 'charger1' ? 'ev1' : id === 'charger2' ? 'ev2' : null;
  if (!prefix) return null;
  const source = prefix === 'ev1' ? 'easee' : 'shelly-evse';
  const intervals = recordedEnergyGroups(store, { from: start, to: end, now: end,
    input: 'providers', prefix, source, device });
  const recordedIntervals = [];
  let gridKwh = 0, coveredMs = 0, cursor = start, continuousSince = null, lastMeasuredAt = null, incomplete = false;
  for (const row of intervals) {
    if (row.conflict || !row.values.every(finite)) continue;
    const a = Math.max(start, row.start), b = Math.min(end, row.end);
    if (b <= a || a < cursor) continue;
    if (a > cursor) { incomplete = true; continuousSince = a; }
    continuousSince ??= a;
    const energyKwh = row.values.reduce((total, value) => total + value, 0) * (b - a) / (row.end - row.start);
    gridKwh += energyKwh;
    recordedIntervals.push({ start: a, end: b, energyKwh });
    coveredMs += b - a; cursor = b; lastMeasuredAt = b;
  }
  return { gridKwh, coveredMs, lastMeasuredAt, continuousSince, intervals: recordedIntervals,
    incomplete: incomplete || end - cursor > 120_000, source: 'recorded-charger-energy' };
}
import { recordedEnergyGroups } from '../storage/energy-history.js';
