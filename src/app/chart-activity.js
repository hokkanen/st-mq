// Display-only reduction of chronological state intervals. The original journal,
// observations and scalar envelopes are never changed by this projection.
const same = (a, b) => a.value === b.value && a.reason === b.reason && a.allowanceA === b.allowanceA
  && a.scopeRevision === b.scopeRevision && a.selectedAt === b.selectedAt
  && a.sampled === b.sampled && a.mixed === b.mixed
  && (a.phases === b.phases || a.phases?.length === b.phases?.length
    && a.phases?.every((phase, index) => phase === b.phases[index]));

export class ActivityEnvelope {
  constructor(range, points, now = range.to) {
    this.from = range.from; this.to = Math.min(range.to, now);
    this.points = points; this.width = (range.to - range.from) / points;
    this.rows = []; this.buckets = null; this.states = new Map(); this.lastEnd = -Infinity;
  }

  raster(start, end, detail) {
    // Numeric allowance and reason changes are exact-detail metadata, not new
    // categories. Phase ties retain their identity even in a dense summary.
    let key = `${detail.value ?? ''}:${detail.phases?.join(',') ?? ''}`;
    let state = this.states.get(key);
    if (!state) {
      // Alarm codes are open-ended. Bound their display cardinality without
      // averaging codes or mislabelling omitted codes as missing evidence.
      if (this.states.size >= 32) key = 'mixed';
      state = this.states.get(key);
      if (!state) {
        state = { detail: key === 'mixed' ? { mixed: true }
          : { ...(detail.value === undefined ? {} : { value: detail.value }),
            ...(detail.phases ? { phases: detail.phases } : {}) }, amounts: new Float64Array(this.points) };
        this.states.set(key, state);
      }
    }
    const first = Math.max(0, Math.floor((start - this.from) / this.width));
    const last = Math.min(this.points - 1, Math.ceil((end - this.from) / this.width) - 1);
    for (let bucket = first; bucket <= last; bucket++) {
      const from = this.from + bucket * this.width;
      state.amounts[bucket] += Math.max(0, Math.min(end, from + this.width) - Math.max(start, from));
    }
  }

  add(start, end, value, metadata) {
    start = Math.max(this.from, start); end = Math.min(this.to, end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || value !== undefined && !Number.isFinite(value)) return;
    const detail = { ...(value === undefined ? {} : { value }), ...metadata };
    // Producers resolve state precedence before this projection. Repeated
    // confirmations and shared endpoints must not double-count known time.
    start = Math.max(start, this.lastEnd);
    if (end <= start) return;
    this.lastEnd = end;
    if (this.buckets) { this.raster(start, end, detail); return; }
    const previous = this.rows.at(-1);
    if (previous?.pointOnly && previous.start >= start && previous.start < end) this.rows.pop();
    const last = this.rows.at(-1);
    if (last && !last.pointOnly && last.end === start && same(last, detail)) last.end = end;
    else this.rows.push({ start, end, ...detail });
    if (this.rows.length > this.points * 2) this.compact();
  }

  compact() {
    this.buckets = true;
    for (const row of this.rows) {
      if (row.pointOnly) this.rememberPoint(row);
      else this.raster(row.start, row.end, row);
    }
    this.rows = [];
  }

  rememberPoint(row) {
    const bucket = Math.min(this.points - 1, Math.floor((row.start - this.from) / this.width));
    this.pointBuckets ??= new Map(); this.pointBuckets.set(bucket, row);
  }

  point(at, value, metadata) {
    if (!Number.isFinite(at) || !Number.isFinite(value) || at < this.from || at > this.to || at < this.lastEnd) return;
    const previous = this.rows.at(-1);
    if (previous?.pointOnly && previous.start === at) this.rows.pop();
    // Isolated reports never acquire a duration, including when densely packed.
    const row = { start: at, end: at, value, pointOnly: true, ...metadata };
    if (this.buckets) this.rememberPoint(row);
    else {
      this.rows.push(row);
      if (this.rows.length > this.points * 2) this.compact();
    }
  }

  values() {
    if (!this.buckets) return this.rows;
    const rows = [];
    for (let bucket = 0; bucket < this.points; bucket++) {
      const start = this.from + bucket * this.width, end = Math.min(this.to, start + this.width);
      if (end <= start) break;
      for (const { detail, amounts } of this.states.values()) if (amounts[bucket] > 0)
        rows.push({ start, end, ...detail, aggregated: true, fraction: Math.min(1, amounts[bucket] / (end - start)) });
    }
    rows.push(...this.rows, ...this.pointBuckets?.values() ?? []);
    return rows.sort((a, b) => a.start - b.start || (a.value ?? 0) - (b.value ?? 0));
  }
}
