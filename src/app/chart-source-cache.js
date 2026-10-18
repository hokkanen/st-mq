import { DEFAULT_CHART_CACHE } from '../domain/chart-cache.js';
import { selectedHistoryPredicate } from '../storage/schema.js';
import moment from 'moment-timezone';
import { releaseStorageLease, checkStorageRequest } from '../storage/worker-admission.js';
import { ENERGY_SIGNALS } from '../domain/history-series.js';
import { NATIVE_CHART_RAW_SIGNALS } from './chart-observations.js';
import { VOLTAGE_SIGNALS } from '../storage/voltage.js';

// Match the native chart reader's raw provenance needs. Ordinary scalar charts
// need report timing/status, not the complete acquisition/device payload. Energy
// and evidence retain their full interpretation and source-clock admission.
const fullRaw = [...ENERGY_SIGNALS, ...VOLTAGE_SIGNALS, ...NATIVE_CHART_RAW_SIGNALS];

const DAY = 86_400_000;
const CONTEXT = 3 * 3_600_000;
const compare = (a, b) => a.source_time - b.source_time || a.id - b.id;
// Include row dictionaries, decoded evidence, sets and variable source strings.
// This is deliberately an estimate, not a promise about V8 heap or process RSS.
const sizeOf = row => 1024 + 6 * (row.raw?.length ?? 0) + 2 * (row.quality?.length ?? 0)
  + 2 * [row.source, row.device, row.signal, row.unit].reduce((sum, value) => sum + (value?.length ?? 0), 0);

/** A replaceable, process-local window of committed chart inputs.
 * Each maintenance call reads one bounded batch and owns no transaction after
 * returning. A reader uses the cache only after its committed head is caught up.
 * Imports and history selection have separate revisions; neither old rows nor a
 * partially warmed replacement may masquerade as the current selected history. */
export class ChartSourceCache {
  constructor(db, { days = DEFAULT_CHART_CACHE.cacheDays, maxBytes = Math.floor(DEFAULT_CHART_CACHE.cacheBytes * 0.45), onChange = () => {} } = {}) {
    Object.assign(this, { db, days, maxBytes, onChange });
    this.chunks = new Map(); this.ids = new Set(); this.bytes = 0; this.rows = 0; this.sequence = 0;
    this.head = null; this.revision = null; this.ready = false; this.loading = null;
    this.metadata = new WeakMap();
    this.headQuery = db.prepare(`SELECT (SELECT MAX(id) FROM observations) AS head,
      (SELECT generation FROM history_selection WHERE id=1) AS selection,
      (SELECT COUNT(*) FROM active_imports WHERE status='complete') AS imports`);
    const columns = `o.id,o.source,o.device,o.signal,o.value,o.unit,o.source_time,o.received_at,o.quality,o.import_id,o.row_number,
      CASE WHEN o.signal IN (${fullRaw.map(signal => `'${signal}'`).join(',')})
        OR json_type(o.raw,'$.timeAdmission') IS NOT NULL THEN o.raw
      ELSE json_object('recorder',json_object('status',COALESCE(json_extract(o.raw,'$.recorder.status'),'fresh')),
        'reportIntervalMs',json_extract(o.raw,'$.reportIntervalMs')) END AS raw,
      i.status AS chart_import_status,i.completed_at AS chart_import_completed_at`;
    const selected = selectedHistoryPredicate('observations', 'o');
    this.initialQuery = db.prepare(`SELECT ${columns} FROM observations o INDEXED BY observations_time
      LEFT JOIN active_imports i ON i.id=o.import_id
      WHERE (o.source_time,o.id)>(?,?) AND o.source_time<? AND o.id<=?
      AND ${selected} ORDER BY o.source_time,o.id LIMIT ?`);
    this.changesQuery = db.prepare(`SELECT ${columns} FROM observations o
      LEFT JOIN active_imports i ON i.id=o.import_id
      WHERE o.id>? AND o.id<=? AND ${selected} ORDER BY o.id LIMIT ?`);
  }

  clear() {
    this.chunks.clear(); this.ids.clear(); this.bytes = 0; this.rows = 0;
    this.ready = false; this.loading = null; this.head = null; this.sequence++;
    this.metadata = new WeakMap();
  }

  configure({ days, maxBytes }) {
    if (days === this.days && maxBytes === this.maxBytes) return;
    this.days = days; this.maxBytes = maxBytes; this.revision = null; this.clear();
  }

  /** Called inside the worker's own short read transaction, never the writer. */
  maintain(now, limit = 256) {
    if (!this.days) return { complete: true, changed: false };
    const current = this.headQuery.get();
    const revision = JSON.stringify([current.selection, current.imports]);
    const from = moment.tz(now, 'Europe/Helsinki').startOf('day').subtract(this.days, 'days').valueOf() - CONTEXT;
    const through = Math.floor(now / DAY + 1) * DAY;
    if (revision !== this.revision || this.requestedFrom > from) {
      this.clear(); this.revision = revision; this.from = from;
      this.loading = { time: from - 1, id: 0, head: current.head ?? 0, through };
      this.onChange({ reset: true, selection: current.selection });
    }
    this.requestedFrom = from;
    if (!this.loading && this.through < through)
      this.loading = { time: Math.max(this.through, from) - 1, id: Number.MAX_SAFE_INTEGER,
        head: current.head ?? 0, through, extension: true };
    let changed = false;
    if (this.loading) {
      const loading = this.loading;
      const rows = this.initialQuery.all(loading.time, loading.id, loading.through, loading.head, limit);
      for (const row of rows) { this.insert(row); loading.time = row.source_time; loading.id = row.id; }
      changed = rows.length > 0;
      if (rows.length < limit) {
        if (!loading.extension) this.head = loading.head;
        this.through = loading.through; this.loading = null; this.ready = true;
      }
    } else if ((current.head ?? 0) > this.head) {
      const rows = this.changesQuery.all(this.head, current.head, limit);
      for (const row of rows) {
        if (row.source_time >= this.from && row.source_time < through) this.insert(row);
      }
      this.head = rows.length === limit ? rows.at(-1).id : current.head;
      if (rows.length) this.onChange({ rows, head: this.head, selection: current.selection });
      changed = rows.length > 0;
    }
    this.trim(from);
    if (changed) this.sequence++;
    return { complete: this.ready && this.head === (current.head ?? 0), changed };
  }

  insert(row) {
    if (this.ids.has(row.id)) return;
    this.ids.add(row.id);
    const day = Math.floor(row.source_time / DAY);
    let chunk = this.chunks.get(day);
    if (!chunk) { chunk = { rows: [], bytes: 0, sorted: true }; this.chunks.set(day, chunk); }
    if (chunk.rows.length && compare(chunk.rows.at(-1), row) > 0) chunk.sorted = false;
    const bytes = sizeOf(row);
    chunk.rows.push(row); chunk.bytes += bytes; this.bytes += bytes; this.rows++;
  }

  trim(from) {
    const remove = day => {
      const chunk = this.chunks.get(day);
      for (const row of chunk.rows) this.ids.delete(row.id);
      this.chunks.delete(day); this.bytes -= chunk.bytes; this.rows -= chunk.rows.length;
      this.sequence++;
    };
    for (const day of this.chunks.keys()) if ((day + 1) * DAY <= from) remove(day);
    while (this.bytes > this.maxBytes && this.chunks.size) {
      const oldest = Math.min(...this.chunks.keys());
      remove(oldest); this.from = Math.max(this.from, (oldest + 1) * DAY);
    }
    this.from = Math.max(this.from, from);
  }

  covers(from, to, now, head = this.head, revision = this.revision) {
    return this.days > 0 && this.ready && from >= this.from
      && to <= this.through && head === this.head && revision === this.revision && !this.loading;
  }

  raw(row) {
    if (!this.metadata.has(row)) this.metadata.set(row, typeof row.raw === 'string' ? JSON.parse(row.raw) : row.raw);
    return this.metadata.get(row);
  }

  *iterate({ from, to, now, signals, input, scope = 'chart' }) {
    releaseStorageLease();
    const wanted = signals && new Set(signals);
    // UTC day partitions are disjoint: concatenate selected days rather than
    // merging every retained row on every request. A single-day view never
    // traverses the other thirteen resident days.
    const chunks = [...this.chunks.entries()].filter(([day, chunk]) => chunk.rows.length
      && day * DAY < to && (day + 1) * DAY > from).sort(([a], [b]) => a - b);
    for (const [, chunk] of chunks) {
      if (!chunk.sorted) { chunk.rows.sort(compare); chunk.sorted = true; }
      let low = 0, high = chunk.rows.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (chunk.rows[middle].source_time < from) low = middle + 1; else high = middle;
      }
      for (let index = low; index < chunk.rows.length; index++) {
        if ((index & 255) === 0) checkStorageRequest();
        const row = chunk.rows[index];
        if (row.source_time >= to) break;
        if (row.received_at > now || wanted && !wanted.has(row.signal)) continue;
        const simulated = row.source === 'simulation' || scope === 'chart'
          && ['controller-learning', 'controller-estimate', 'controller'].includes(row.source) && row.device === 'simulated';
        if ((input === 'simulated') !== simulated) continue;
        if (row.import_id !== null && (row.chart_import_status !== 'complete' || row.chart_import_completed_at > now)) continue;
        yield row;
      }
    }
  }

  status() {
    return { days: this.days, maxBytes: this.maxBytes, bytes: this.bytes, rows: this.rows,
      ready: this.ready, from: this.from ?? null, head: this.head, sequence: this.sequence };
  }
}
