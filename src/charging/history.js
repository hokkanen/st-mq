import moment from 'moment-timezone';
import { TIME_ZONE } from '../domain/prices.js';

const HOUR = 3_600_000;
const SIGNALS = ['property_energy_l1', 'property_energy_l2', 'property_energy_l3',
  'ev1_energy_l1', 'ev1_energy_l2', 'ev1_energy_l3', 'ev2_energy'];
const BAD = new Set(['missing', 'invalid_numeric', 'invalid_unit', 'provider_error', 'integration_gap', 'unknown_phase_share']);

/** Intersect actual energy intervals before subtracting both chargers. Charger 2
 * aggregate energy is divided equally over the supported three-phase supply.
 * Keep the remaining household demand on its measured phase. */
export function householdProfile(rows, { timezone = TIME_ZONE, voltageV } = {}) {
  const voltage = Array.isArray(voltageV) && voltageV.length === 3 ? voltageV : [voltageV, voltageV, voltageV];
  if (!voltage.every(value => Number.isFinite(value) && value >= 200 && value <= 250)) return Array(24).fill(null);
  const events = [];
  for (const row of rows) {
    const index = SIGNALS.indexOf(row.signal), start = row.raw?.intervalStart, end = row.raw?.intervalEnd;
    if (index < 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start
      || row.unit !== 'kWh' || !Number.isFinite(row.value) || row.value < 0 || (row.quality ?? []).some(x => BAD.has(x))) continue;
    const power = row.value * HOUR / (end - start), key = events.length;
    events.push({ at: start, index, power, key, start: true }, { at: end, index, key, start: false });
  }
  events.sort((a, b) => a.at - b.at);
  const active = SIGNALS.map(() => new Map()), samples = Array.from({ length: 24 }, () => []);
  let previous = null;
  for (const event of events) {
    if (previous !== null && event.at > previous && active.every(group => group.size === 1)) {
      const values = active.map(group => [...group.values()][0]);
      const residual = values.slice(0, 3).map((power, phase) => power - values[phase + 3] - values[6] / 3);
      // Incompatible clocks or attribution must not become extra headroom.
      if (residual.every(value => value >= -0.05)) for (let at = previous; at < event.at;) {
        const end = Math.min(event.at, Math.floor(at / HOUR) * HOUR + HOUR);
        samples[moment.tz(at, timezone).hour()].push({ phaseCurrentA: residual.map((power, phase) => Math.max(0, power) * 1000 / voltage[phase]), duration: end - at });
        at = end;
      }
    }
    if (event.start) active[event.index].set(event.key, event.power);
    else active[event.index].delete(event.key);
    previous = event.at;
  }
  return samples.map(group => {
    const duration = group.reduce((sum, x) => sum + x.duration, 0);
    if (duration < 15 * 60_000) return null;
    // Expected demand, weighted by actual coverage duration. Uneven sampling
    // must not turn a brief high reading into a hidden planning reserve.
    const phaseCurrentA = [0, 1, 2].map(phase => group.reduce((sum, item) =>
      sum + item.phaseCurrentA[phase] * item.duration, 0) / duration);
    return { phaseCurrentA, coverageMs: duration, method: 'duration-weighted-mean' };
  });
}

export function forecastHousehold(store, { now, deadlineAt, input, voltageV, timezone = TIME_ZONE }) {
  if (!store.db) return [];
  const rows = store.db.prepare(`SELECT signal,value,unit,raw,quality FROM observations
    WHERE signal IN (${SIGNALS.map(() => '?').join(',')}) AND source_time>? AND source_time<=?
      AND ${input === 'simulated' ? "source='simulation'" : "source<>'simulation'"}
      AND (import_id IS NULL OR import_id IN (SELECT id FROM imports WHERE status='complete'))
    ORDER BY source_time DESC,id DESC LIMIT 30000`).all(...SIGNALS, now - 7 * 24 * HOUR, now);
  const decoded = [];
  for (const row of rows) {
    try { decoded.push({ ...row, raw: JSON.parse(row.raw), quality: JSON.parse(row.quality) }); } catch { /* Broken metadata is unavailable. */ }
  }
  const profile = householdProfile(decoded, { timezone, voltageV });
  const result = [];
  for (let start = now; start < deadlineAt;) {
    const end = Math.min(deadlineAt, Math.floor(start / HOUR) * HOUR + HOUR), value = profile[moment.tz(start, timezone).hour()];
    if (value) result.push({ start, end, phaseCurrentA: value.phaseCurrentA,
      basis: 'history-duration-weighted-mean', coverageMs: value.coverageMs });
    start = end;
  }
  return result;
}
