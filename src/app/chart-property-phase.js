/** Select from one complete original phase group, before chart reduction. The
 * tiny tolerance only absorbs arithmetic round-off in energy/voltage conversion. */
export function propertyMaximum(currents) {
  if (currents?.length !== 3 || !currents.every(Number.isFinite)) return { currentA: null, phases: [] };
  const currentA = Math.max(...currents), tolerance = Number.EPSILON * Math.max(1, Math.abs(currentA)) * 8;
  const phases = currents.flatMap((value, index) => currentA - value <= tolerance ? [index + 1] : []);
  return { currentA, phases };
}

/** Exact chronological phase spans with bounded memory. Dense history drops
 * older detail rather than assigning a majority phase across changes or gaps. */
export class PropertyHighestPhaseHistory {
  constructor(range, now, maxSpans) {
    this.from = range.from; this.to = Math.min(range.to, now); this.maxSpans = maxSpans;
    this.rows = new Array(maxSpans); this.offset = 0; this.count = 0; this.truncated = false;
  }
  add(start, end, phases) {
    start = Math.max(this.from, start); end = Math.min(this.to, end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !phases?.length) return;
    const previous = this.count ? this.rows[(this.offset + this.count - 1) % this.maxSpans] : null;
    if (previous?.end === start && previous.phases.length === phases.length
      && previous.phases.every((phase, index) => phase === phases[index])) {
      previous.end = end; return;
    }
    const row = { start, end, value: phases[0], phases: [...phases] };
    if (this.count === this.maxSpans) {
      this.rows[this.offset] = row; this.offset = (this.offset + 1) % this.maxSpans; this.truncated = true;
    } else this.rows[(this.offset + this.count++) % this.maxSpans] = row;
  }
  values() { return Array.from({ length: this.count }, (_, index) => this.rows[(this.offset + index) % this.maxSpans]); }
}
