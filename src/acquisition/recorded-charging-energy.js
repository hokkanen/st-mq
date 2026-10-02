import { recordedEnergyGroups } from '../storage/energy-history.js';

const instant = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;

/** Compare the same complete physical phase groups used by history/accounting.
 * Source, equipment identity and receipt cutoff are explicit: another charger,
 * overlapping groups or a missing phase cannot supply a session's coverage.
 */
export function compareRecordedChargingEnergy(store, { source, device, prefix, start, end, now }) {
  if (!['easee', 'shelly-evse'].includes(source) || typeof device !== 'string'
    || prefix !== (source === 'easee' ? 'ev1' : 'ev2')
    || !instant(start) || !instant(end) || end <= start || !instant(now) || now < end) return null;
  let cursor = start, estimatedKwh = 0, edgeEstimated = false;
  for (const group of recordedEnergyGroups(store, { source, device, prefix, from: start, to: end, now })) {
    if (group.conflict || group.values.some(value => !Number.isFinite(value) || value < 0)
      || group.start > cursor || group.start < cursor && cursor !== start || group.end <= cursor) return null;
    const until = Math.min(end, group.end);
    edgeEstimated ||= cursor !== group.start || until !== group.end;
    estimatedKwh += group.values.reduce((sum, value) => sum + value, 0)
      * (until - cursor) / (group.end - group.start);
    cursor = until;
  }
  return cursor === end ? { estimatedKwh, edgeEstimated } : null;
}
