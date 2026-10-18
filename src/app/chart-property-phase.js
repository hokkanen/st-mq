import { ActivityEnvelope } from './chart-activity.js';

/** Select from one complete original phase group, before chart reduction. The
 * tiny tolerance only absorbs arithmetic round-off in energy/voltage conversion. */
export function propertyMaximum(currents) {
  if (currents?.length !== 3 || !currents.every(Number.isFinite)) return { currentA: null, phases: [] };
  const currentA = Math.max(...currents), tolerance = Number.EPSILON * Math.max(1, Math.abs(currentA)) * 8;
  const phases = currents.flatMap((value, index) => currentA - value <= tolerance ? [index + 1] : []);
  return { currentA, phases };
}

/** Preserve the complete period, summarizing dense phase changes by occupancy. */
export class PropertyHighestPhaseHistory extends ActivityEnvelope {
  constructor(range, now, points) { super(range, points, now); }
  add(start, end, phases) {
    if (phases?.length) super.add(start, end, phases[0], { phases: [...phases] });
  }
}
