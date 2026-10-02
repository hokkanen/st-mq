import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { LEARNING_ALGORITHM, LEARNING_WINDOW_MS, learningVersion, assertCurrentLearningSample } from '../app/committed-learning.js';
import { originalSensorSample } from '../app/sensor-samples.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { recordedEnergyGroups, validEnergyQuality } from '../storage/energy-history.js';
import { Recorder, RECORDING_VERSION } from '../storage/recorder.js';
import { recordingPolicy, recordingStreamKey, RECORDING_POLICIES } from '../domain/recording-policy.js';
import { ENERGY_SIGNALS } from '../domain/history-series.js';
import { assertCurrentChargingSessionCheck } from '../app/charging-session-checks.js';

export const RECOVERY_POLICY = 'master-wins-gaps-only-v1';
const json = JSON.stringify;
const finite = Number.isFinite;
const instant = value => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const flags = value => Array.isArray(value) && value.every(flag => typeof flag === 'string');
const usable = row => {
  try { return row && finite(row.value) && flags(decode(row.quality)) && !decode(row.quality).some(flag => /missing|invalid|stale|unavailable|failed/.test(flag)); }
  catch { return false; }
};
const decode = value => value === null ? null : JSON.parse(value);
const same = (a, b) => learningVersion(a) === learningVersion(b);
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const dispositions = ['missing', 'conflicts', 'duplicates', 'skipped'];
const firstUsable = rows => { for (const row of rows) if (usable(row)) return row; return null; };
const PENDING_ENERGY = 'recorder_pending_energy';
const HOUR = 3_600_000;
const phaseSignals = row => /^(property|ev1|ev2)_energy_l[123]$/.test(row.signal)
  ? [1, 2, 3].map(phase => row.signal.replace(/l[123]$/, `l${phase}`)) : null;
const energyEquivalent = (old, row, raw) => {
  if (old.value !== row.value || old.unit !== row.unit || old.source_time !== row.source_time
    || !same(decode(old.quality), decode(row.quality))) return false;
  const previous = decode(old.raw);
  // Finalizing an already recovered open interval changes storage provenance,
  // not its measured energy. Its original basis and endpoints still must match.
  return raw?.intervalStart === previous?.intervalStart && raw?.intervalEnd === previous?.intervalEnd
    && raw?.basis === previous?.basis && raw?.timeBasis === previous?.timeBasis;
};
const ID_TABLES = ['imports', 'observations', 'recorder_coverage', 'provider_snapshot_contents',
  'provider_snapshot_fetches', 'fireplace_events', 'learning_cycles', 'learning_journal'];

export function emptyReport() {
  return { policy: RECOVERY_POLICY, counts: Object.fromEntries(dispositions.map(key => [key, 0])),
    period: { from: null, to: null }, tables: [], model: { status: 'unchanged', acceptedSamples: 0, unsupported: 0 } };
}

/** The input database is frozen. Target writes are short, restartable batches.
 * Only accepted source history is inserted; mutable controller state, recorder
 * accumulators and old adaptive checkpoints are never copied from the donor.
 * Valid frozen energy tails become immutable history with separate provenance. */
export class HistoryMerge {
  constructor({ target, donor, donorDigest, input, progress = () => {}, now = Date.now() }) {
    this.target = target; this.donor = donor; this.digest = donorDigest; this.input = input;
    this.progress = progress; this.report = emptyReport(); this.maps = Object.fromEntries(ID_TABLES.map(table => [table, new Map()]));
    this.journal = []; this.processed = 0;
    this.now = now; this.metrics = new Recorder(target);
  }
  count(table, disposition, at = null) {
    let row = this.report.tables.find(value => value.name === table);
    if (!row) { row = { name: table, ...Object.fromEntries(dispositions.map(key => [key, 0])) }; this.report.tables.push(row); }
    row[disposition]++; this.report.counts[disposition]++;
    if (disposition === 'missing' && instant(at)) {
      this.report.period.from = Math.min(this.report.period.from ?? at, at);
      this.report.period.to = Math.max(this.report.period.to ?? at, at);
    }
  }
  remember(table, id, target, disposition) {
    if (this.maps[table]) this.maps[table].set(id, { id: target, disposition });
    this.target.db.prepare(`INSERT INTO recovery_provenance(donor_digest,table_name,donor_id,target_id,disposition)
      VALUES(?,?,?,?,?) ON CONFLICT(donor_digest,table_name,donor_id) DO UPDATE SET
      target_id=excluded.target_id,disposition=excluded.disposition`)
      .run(this.digest, table, String(id), target === null ? null : String(target), disposition);
  }
  known(table, id) {
    if (this.maps[table]?.has(id)) return this.maps[table].get(id);
    const row = this.target.db.prepare('SELECT target_id,disposition FROM recovery_provenance WHERE donor_digest=? AND table_name=? AND donor_id=?')
      .get(this.digest, table, String(id));
    if (!row) return null;
    return { id: table === 'learning_cycles' ? row.target_id : row.target_id === null ? null : Number(row.target_id), disposition: row.disposition };
  }
  insert(table, row) {
    const columns = Object.keys(row);
    const result = this.target.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => row[key]));
    if (table === 'observations') this.countRecoveredObservation(row);
    return row.id ?? Number(result.lastInsertRowid);
  }
  countRecoveredObservation(row) {
    if (row.import_id !== null) return;
    const raw = decode(row.raw), policy = raw?.recorder?.policy;
    if (raw?.recorder?.version !== RECORDING_VERSION || !Object.hasOwn(RECORDING_POLICIES, policy)
      || !RECORDING_POLICIES[policy].recorded) return;
    const observation = { ...row, raw, recordingPolicy: policy };
    if (recordingPolicy(observation).id !== policy) return;
    const boundary = this.target.getState('recorder:global:v2')?.metricsPrunedBefore;
    // Older history is read from raw records by status(). Do not recreate
    // pruned metric buckets, donor poll counts, or donor adaptive state.
    if (Number.isFinite(boundary) && Math.floor(row.received_at / HOUR) * HOUR < boundary) return;
    this.metrics.count({ key: recordingStreamKey(observation) }, row.received_at,
      { saved: true, polls: 0, bytes: Buffer.byteLength(json(row)) });
  }
  async rows(table, fn, { query = `SELECT * FROM ${table} ORDER BY id`, map = true, group, prepare } = {}) {
    let batch = [], size = 0;
    const grouped = new Set();
    const flush = async () => {
      this.target.transaction(() => {
        for (const cohort of batch) {
          const forced = prepare?.(cohort);
          for (const row of cohort) {
          try {
            if (forced) {
              this.count(table, forced);
              const prior = map ? this.known(table, row.id) : null;
              if (map && prior?.disposition !== 'missing') this.remember(table, row.id, prior?.id ?? null, forced);
              // Keep the persisted deletion tombstone, but reject this run's
              // dependent coverage and journal references to every lost phase.
              if (map && this.maps[table]) this.maps[table].set(row.id, { id: null, disposition: forced });
              continue;
            }
            const prior = map ? this.known(table, row.id) : null;
            if (prior?.id !== null && prior && this.target.db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(prior.id)) {
              if (this.maps[table]) this.maps[table].set(row.id, prior);
              this.count(table, prior.disposition === 'conflicts' ? 'conflicts' : 'duplicates'); continue;
            }
            // A previously accepted source row deliberately removed on the
            // master stays removed. An interrupted/skipped record may retry.
            if (prior?.id !== null && prior?.disposition === 'missing') {
              if (this.maps[table]) this.maps[table].set(row.id, { id: null, disposition: 'conflicts' });
              this.count(table, 'conflicts'); continue;
            }
            const result = fn(row);
            this.count(table, result.disposition, result.at);
            if (map) this.remember(table, row.id, result.id ?? null, result.disposition);
          } catch (error) {
            // Invalid donor payloads are not copied. Database errors (disk
            // full, locks, malformed schema) abort instead of claiming success.
            if (!(error instanceof TypeError || error instanceof SyntaxError || error?.code === 'RECOVERY_ROW_INVALID')) throw error;
            this.count(table, 'skipped'); if (map) this.remember(table, row.id, null, 'skipped');
          }
          }
        }
      });
      this.processed += size; batch = []; size = 0;
      this.progress({ phase: 'importing', processed: this.processed });
      await yieldTurn();
    };
    for (const row of this.donor.db.prepare(query).iterate()) {
      if (grouped.delete(row.id)) continue;
      const cohort = group ? group(row) : [row];
      if (cohort.length > 1) for (const member of cohort) if (member.id !== row.id) grouped.add(member.id);
      batch.push(cohort); size += cohort.length; if (size >= 64) await flush();
    }
    if (batch.length) await flush();
  }
  require(test) { if (!test) throw Object.assign(new TypeError('Invalid donor source record'), { code: 'RECOVERY_ROW_INVALID' }); }
  async imports() {
    await this.rows('imports', row => {
      this.require(['stmq', 'easee'].includes(row.kind) && row.status === 'complete' && /^[a-f0-9]{64}$/.test(row.sha256)
        && instant(row.started_at) && instant(row.completed_at) && Number.isSafeInteger(row.row_count) && row.row_count >= 0);
      const old = this.target.db.prepare('SELECT * FROM imports WHERE kind=? AND sha256=?').get(row.kind, row.sha256);
      if (old) return { id: old.id, disposition: old.status === 'complete' ? 'duplicates' : 'conflicts' };
      const id = this.insert('imports', { ...without(row, ['id']), status: 'recovering' }); return { id, disposition: 'missing' };
    });
    await this.rows('import_rows', row => {
      const mapped = this.known('imports', row.import_id);
      this.require(mapped?.id != null && mapped.disposition !== 'conflicts' && Number.isSafeInteger(row.row_number) && row.row_number >= 0
        && (row.source_time === null || instant(row.source_time)) && typeof row.raw === 'string' && flags(decode(row.quality)));
      const old = this.target.db.prepare('SELECT * FROM import_rows WHERE import_id=? AND row_number=?').get(mapped.id, row.row_number);
      if (old) return { disposition: same(without(old, ['import_id']), without(row, ['import_id'])) ? 'duplicates' : 'conflicts' };
      this.insert('import_rows', { ...row, import_id: mapped.id }); return { disposition: 'missing', at: row.source_time };
    }, { query: 'SELECT * FROM import_rows ORDER BY import_id,row_number', map: false });
  }
  observationOverlap(row, raw) {
    const db = this.target.db;
    if (instant(raw?.intervalStart) && instant(raw?.intervalEnd) && raw.intervalEnd > raw.intervalStart) {
      // Never prorate donor totals over partially overlapping master energy.
      const hourly = raw.timeBasis === 'completed-hour';
      const physical = !hourly && ENERGY_SIGNALS.includes(row.signal);
      // Physical chart/model streams have one logical installation scope. A
      // changed native device ID or acquisition provider cannot overlap it.
      const namespace = physical ? `source${row.source === 'simulation' ? '=' : '<>'}'simulation'` : 'device=?';
      const recorded = firstUsable(db.prepare(`SELECT * FROM observations WHERE ${namespace} AND signal=? AND value IS NOT NULL
        AND json_valid(raw) AND json_extract(raw,'$.intervalStart')<?
        AND (CASE WHEN json_valid(raw) THEN json_extract(raw,'$.intervalEnd') END)>?
        AND COALESCE(json_extract(raw,'$.timeBasis')='completed-hour',0)=? ORDER BY id DESC`)
        .iterate(...(physical ? [] : [row.device]), row.signal, raw.intervalEnd, raw.intervalStart, Number(hourly)));
      if (recorded || hourly) return recorded;
      // Pending energy is already durable master history. Check it under the
      // same write transaction as the insert, including other source labels.
      return pendingEnergyObservations(this.target, { now: Math.max(this.now, Date.now()),
        ...(physical ? { input: row.source === 'simulation' ? 'simulated' : 'providers' } : { device: row.device }) })
        .find(pending => pending.signal === row.signal && validEnergyQuality(decode(pending.quality))
          && decode(pending.raw).intervalStart < raw.intervalEnd && pending.source_time > raw.intervalStart) ?? null;
    }
    const point = firstUsable(db.prepare(`SELECT * FROM observations WHERE source=? AND device=? AND signal=? AND source_time IS ?
      AND value IS NOT NULL ORDER BY id DESC`).iterate(row.source, row.device, row.signal, row.source_time));
    if (point) return point;
    if (row.source_time !== null) return firstUsable(db.prepare(`SELECT o.* FROM recorder_coverage c JOIN observations o ON o.id=c.observation_id
      WHERE c.source=? AND c.device=? AND c.signal=? AND c.start_at<=? AND c.end_at>? AND c.status='fresh'
      AND o.value IS NOT NULL ORDER BY c.id DESC`).iterate(row.source, row.device, row.signal, row.source_time, row.source_time));
    return null;
  }
  observationCohort(row) {
    const signals = phaseSignals(row);
    let raw; try { raw = decode(row.raw); } catch { return [row]; }
    if (!signals || row.import_id !== null || raw?.timeBasis === 'completed-hour'
      || !instant(raw?.intervalStart) || !instant(raw?.intervalEnd) || raw.intervalEnd !== row.source_time) return [row];
    return this.donor.db.prepare(`SELECT * FROM observations WHERE signal IN (?,?,?) AND source_time=?
      AND source=? AND device=? AND import_id IS NULL AND json_valid(raw)
      AND json_extract(raw,'$.intervalStart')=? AND json_extract(raw,'$.intervalEnd')=? ORDER BY id`)
      .all(...signals, row.source_time, row.source, row.device, raw.intervalStart, raw.intervalEnd);
  }
  prepareObservationCohort(cohort) {
    const row = cohort[0], signals = phaseSignals(row);
    let raw; try { raw = decode(row.raw); } catch { return null; }
    if (!signals || row.import_id !== null || raw?.timeBasis === 'completed-hour'
      || !instant(raw?.intervalStart) || !instant(raw?.intervalEnd)) return null;
    try {
      for (const member of cohort) {
        this.validateObservation(member);
        this.require(member.unit === 'kWh' && decode(member.raw).basis === raw.basis
          && same(decode(member.quality), decode(row.quality)));
      }
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return 'skipped';
      throw error;
    }
    // Preflight every member before inserting any phase. A partial existing
    // master cohort wins as a whole; recovery never fills its other phases
    // with energy from an overlapping donor interpretation.
    const overlaps = cohort.map(member => this.observationOverlap(member, decode(member.raw)));
    const removed = cohort.some(member => {
      const prior = this.known('observations', member.id);
      return prior?.disposition === 'missing' && prior.id !== null
        && !this.target.db.prepare('SELECT 1 FROM observations WHERE id=?').get(prior.id);
    });
    if (removed || overlaps.some(Boolean) && !overlaps.every((old, i) => old && energyEquivalent(old, cohort[i], decode(cohort[i].raw))))
      return 'conflicts';
    if (cohort.length !== 3 || new Set(cohort.map(member => member.signal)).size !== 3) return 'skipped';
    return null;
  }
  validateObservation(row) {
    const raw = decode(row.raw), quality = decode(row.quality);
    this.require([row.source, row.device, row.signal, row.unit].every(text) && (row.value === null || finite(row.value))
      && (row.source_time === null || instant(row.source_time)) && instant(row.received_at) && flags(quality)
      && (raw === null || object(raw)));
    if (row.unit === 'kWh' && raw && ('intervalStart' in raw || 'intervalEnd' in raw))
      this.require(instant(raw.intervalStart) && instant(raw.intervalEnd) && raw.intervalEnd > raw.intervalStart
        && raw.intervalEnd === row.source_time && raw.intervalEnd <= row.received_at && row.received_at <= this.now
        && (row.value === null || row.value >= 0));
  }
  async observations() {
    await this.rows('observations', row => {
      let raw = decode(row.raw); const quality = decode(row.quality);
      this.validateObservation(row);
      const old = this.observationOverlap(row, raw);
      if (old) {
        const equivalent = raw?.intervalStart != null ? energyEquivalent(old, row, raw)
          : old.value === row.value && old.unit === row.unit && old.source_time === row.source_time
          && same(decode(old.quality), quality) && same(decode(old.raw), raw);
        return { id: old.id, disposition: equivalent ? 'duplicates' : 'conflicts' };
      }
      let importId = null;
      if (row.import_id !== null) {
        const mapped = this.known('imports', row.import_id);
        this.require(mapped?.id != null && mapped.disposition !== 'conflicts'); importId = mapped.id;
        this.require(this.target.db.prepare('SELECT 1 FROM import_rows WHERE import_id=? AND row_number=?').get(importId, row.row_number));
      }
      // Recorder coverage pointers are local IDs. Persist the original record
      // interpretation; map its optional held-value provenance explicitly.
      if (raw?.recorder?.coverageId != null) {
        const coverage = this.known('recorder_coverage', raw.recorder.coverageId);
        raw.recorder = { ...raw.recorder, ...(coverage?.id ? { coverageId: coverage.id } : { coverageId: null }),
          recoverySourceCoverage: String(raw.recorder.coverageId) };
      }
      if (raw) raw = this.remap(raw);
      const id = this.insert('observations', { ...without(row, ['id']), raw: raw === null ? null : json(raw), import_id: importId });
      return { id, disposition: 'missing', at: row.source_time };
    }, { group: row => this.observationCohort(row), prepare: cohort => this.prepareObservationCohort(cohort) });
    await this.rows('recorder_coverage', row => {
      this.require([row.source, row.device, row.signal].every(text) && ['fresh', 'stale', 'failed', 'unavailable'].includes(row.status)
        && instant(row.start_at) && instant(row.end_at)
        && row.end_at >= row.start_at && Number.isSafeInteger(row.samples) && row.samples > 0);
      const mapped = row.observation_id === null ? null : this.known('observations', row.observation_id);
      this.require(row.observation_id === null || mapped?.id != null && mapped.disposition !== 'conflicts');
      const old = this.target.db.prepare(`SELECT * FROM recorder_coverage WHERE source=? AND device=? AND signal=?
        AND start_at<=? AND end_at>=? ORDER BY id DESC LIMIT 1`).get(row.source, row.device, row.signal, row.start_at, row.end_at);
      if (old) return { id: old.id, disposition: old.status === row.status && old.observation_id === mapped?.id ? 'duplicates' : 'conflicts' };
      if (this.target.db.prepare(`SELECT 1 FROM recorder_coverage WHERE source=? AND device=? AND signal=?
        AND start_at<? AND end_at>? LIMIT 1`).get(row.source, row.device, row.signal, row.end_at, row.start_at)) return { disposition: 'conflicts' };
      const id = this.insert('recorder_coverage', { ...without(row, ['id']), observation_id: mapped?.id ?? null });
      return { id, disposition: 'missing', at: row.start_at };
    });
    let completed = 0;
    for (const mapped of this.maps.imports.values()) if (mapped.id != null && mapped.disposition === 'missing') {
      // Keep incomplete CSV recovery invisible to consumers which require a
      // complete import. Row numbers, units and original source times survive.
      this.target.db.prepare("UPDATE imports SET status='complete' WHERE id=? AND status='recovering'").run(mapped.id);
      if (++completed % 64 === 0) await yieldTurn();
    }
  }
  async pendingEnergy() {
    // The donor connection is a frozen, read-only snapshot. Its bounded open
    // interval contains accepted measurements that may span days; it is source
    // history even though the adaptive writer has not closed it yet.
    for (const checkpoint of this.donor.db.prepare("SELECT key,value FROM state WHERE key LIKE 'recorder:energy:%' ORDER BY key").iterate()) {
      let identity, state, rows = [], valid = false;
      try {
        identity = decode(checkpoint.key.slice('recorder:energy:'.length)); state = decode(checkpoint.value);
        if (!state?.pending) continue;
        this.require(Array.isArray(identity) && identity.length === 3 && identity.every(text));
        const [source, device, prefix] = identity, pending = state.pending;
        this.require(instant(pending.start) && instant(pending.end) && instant(pending.receivedAt)
          && pending.end === state.lastEnd && pending.receivedAt === state.lastReceivedAt
          && pending.end <= pending.receivedAt && pending.receivedAt <= this.now && flags(pending.quality));
        rows = pendingEnergyObservations(this.donor, { now: this.now, source, device, prefix });
        this.require(rows.length > 0);
        const groups = [...recordedEnergyGroups(this.donor, { from: pending.start, to: pending.end,
          now: this.now, input: source === 'simulation' ? 'simulated' : 'providers', prefix })];
        this.require(groups.length === 1 && groups[0].pending && !groups[0].conflict
          && groups[0].source === source && groups[0].device === device
          && groups[0].start === pending.start && groups[0].end === pending.end
          && groups[0].observationIds.length === 0 && groups[0].values.every(finite));
        valid = true;
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
      }
      if (!valid) {
        this.target.transaction(() => {
          this.count(PENDING_ENERGY, 'skipped');
          this.remember(PENDING_ENERGY, digest([checkpoint.key, 'invalid']), null, 'skipped');
        });
      } else this.target.transaction(() => {
        const ids = rows.map(row => digest([checkpoint.key, row.signal]));
        const prior = ids.map(id => this.known(PENDING_ENERGY, id));
        const removed = prior.some(value => value?.disposition === 'missing' && value.id !== null
          && !this.target.db.prepare('SELECT 1 FROM observations WHERE id=?').get(value.id));
        const overlaps = rows.map(row => this.observationOverlap(row, decode(row.raw)));
        const disposition = removed ? 'conflicts' : overlaps.every((old, i) => old && energyEquivalent(old, rows[i], decode(rows[i].raw)))
          ? 'duplicates' : overlaps.some(Boolean) ? 'conflicts' : 'missing';
        for (let i = 0; i < rows.length; i++) {
          let id = overlaps[i]?.id ?? prior[i]?.id ?? null;
          if (disposition === 'missing') {
            const row = rows[i], raw = decode(row.raw);
            delete raw.pending;
            raw.recorder = { version: RECORDING_VERSION, policy: 'adaptive-energy', reason: 'recovered-open-interval', group: identity[2] };
            raw.recovery = { kind: 'frozen-recorder-energy', donorDigest: this.digest, donorState: digest(checkpoint.key) };
            id = this.insert('observations', { ...row, raw: json(raw), import_id: null, row_number: null });
          }
          this.count(PENDING_ENERGY, disposition, rows[i].source_time);
          // A deliberate master deletion remains a durable tombstone, even if
          // only one member of a previously accepted phase cohort was removed.
          if (prior[i]?.disposition !== 'missing') this.remember(PENDING_ENERGY, ids[i], id, disposition);
        }
      });
      this.processed += Math.max(rows.length, 1);
      this.progress({ phase: 'importing', processed: this.processed });
      await yieldTurn();
    }
  }
  async snapshots() {
    await this.rows('provider_snapshot_contents', row => {
      this.require(/^[a-f0-9]{64}$/.test(row.digest) && object(decode(row.payload)));
      this.require(createHash('sha256').update(row.payload).digest('hex') === row.digest);
      const old = this.target.db.prepare('SELECT id FROM provider_snapshot_contents WHERE digest=?').get(row.digest);
      if (old) return { id: old.id, disposition: 'duplicates' };
      return { id: this.insert('provider_snapshot_contents', without(row, ['id'])), disposition: 'missing' };
    });
    await this.rows('provider_snapshot_fetches', row => {
      this.require(['market', 'weather'].includes(row.kind) && text(row.source) && instant(row.fetched_at)
        && (row.issued_at === null || instant(row.issued_at)) && /^[a-f0-9]{64}$/.test(row.digest));
      const mapped = this.known('provider_snapshot_contents', row.content_id);
      this.require(mapped?.id != null && Array.isArray(decode(row.fetch_metadata)));
      const content = this.donor.db.prepare('SELECT digest FROM provider_snapshot_contents WHERE id=?').get(row.content_id);
      this.require(content && createHash('sha256').update(json([content.digest,row.issued_at,row.fetch_metadata])).digest('hex') === row.digest);
      const old = this.target.db.prepare('SELECT * FROM provider_snapshot_fetches WHERE kind=? AND source=? AND fetched_at=? ORDER BY id DESC LIMIT 1')
        .get(row.kind, row.source, row.fetched_at);
      if (old) return { id: old.id, disposition: old.digest === row.digest ? 'duplicates' : 'conflicts' };
      return { id: this.insert('provider_snapshot_fetches', { ...without(row, ['id']), content_id: mapped.id }),
        disposition: 'missing', at: row.fetched_at };
    });
  }
  async manual() {
    await this.rows('annotations', row => {
      this.require(text(row.kind) && instant(row.start_at) && (row.end_at === null || instant(row.end_at) && row.end_at > row.start_at)
        && typeof row.note === 'string' && ['exact', 'approximate', 'unknown'].includes(row.boundary_confidence)
        && [0, 1].includes(row.exclude_training) && text(row.provenance) && instant(row.created_at));
      const old = this.target.db.prepare(`SELECT * FROM annotations WHERE (unique_key IS NOT NULL AND unique_key=?)
        OR (kind=? AND start_at<COALESCE(?,8640000000000000) AND COALESCE(end_at,8640000000000000)>?) ORDER BY id DESC LIMIT 1`)
        .get(row.unique_key, row.kind, row.end_at, row.start_at);
      if (old) return { id: old.id, disposition: same(without(old, ['id']), without(row, ['id'])) ? 'duplicates' : 'conflicts' };
      return { id: this.insert('annotations', without(row, ['id'])), disposition: 'missing', at: row.start_at };
    });
    await this.rows('counters', row => {
      this.require([row.device, row.signal, row.unit, row.provenance].every(text) && finite(row.value) && row.value >= 0
        && /^\d{4}-\d{2}-\d{2}$/.test(row.observed_date) && instant(row.created_at));
      const old = this.target.db.prepare('SELECT * FROM counters WHERE device=? AND signal=? AND observed_date=? ORDER BY id DESC LIMIT 1')
        .get(row.device, row.signal, row.observed_date);
      if (old) return { id: old.id, disposition: old.value === row.value && old.unit === row.unit ? 'duplicates' : 'conflicts' };
      return { id: this.insert('counters', without(row, ['id'])), disposition: 'missing', at: row.source_time };
    });
    await this.rows('fireplace_events', row => {
      this.require(['mqtt', 'providers', 'simulated'].includes(row.input) && text(row.request_id) && instant(row.at)
        && ['load', 'remove'].includes(row.kind));
      const old = this.target.db.prepare('SELECT * FROM fireplace_events WHERE input=? AND request_id=?').get(row.input, row.request_id);
      if (old) return { id: old.id, disposition: old.kind === row.kind && old.kg === row.kg && old.at === row.at ? 'duplicates' : 'conflicts' };
      if (row.kind === 'load') {
        this.require(Number.isSafeInteger(row.kg) && row.kg >= 2 && row.kg <= 10 && row.target_id === null);
        const overlap = this.target.db.prepare("SELECT * FROM fireplace_events WHERE input=? AND kind='load' AND at=? ORDER BY id DESC LIMIT 1").get(row.input, row.at);
        if (overlap) return { id: overlap.id, disposition: overlap.kg === row.kg ? 'duplicates' : 'conflicts' };
      } else {
        const target = this.known('fireplace_events', row.target_id);
        this.require(target?.id != null && target.disposition !== 'conflicts');
        // The master's existing correction wins. Otherwise a missing removal
        // of a shared or recovered load is itself a recoverable source event;
        // absence of that event is not an explicit master correction.
        const removed = this.target.db.prepare("SELECT * FROM fireplace_events WHERE input=? AND kind='remove' AND target_id=? ORDER BY id LIMIT 1")
          .get(row.input, target.id);
        if (removed) return { id: removed.id, disposition: 'duplicates' };
        row = { ...row, target_id: target.id };
      }
      return { id: this.insert('fireplace_events', without(row, ['id'])), disposition: 'missing', at: row.at };
    });
  }
  remap(value, { strict = false } = {}) {
    const result = structuredClone(value);
    const references = new Map();
    const reference = (table, id) => {
      if (id === null || id === undefined) return id;
      const mapped = this.known(table, id);
      if (strict) this.require(mapped?.id != null && mapped.disposition !== 'conflicts' && mapped.disposition !== 'skipped');
      if (mapped?.id == null || mapped.disposition === 'conflicts')
        references.set(`${table}:${id}`, { table, id });
      return mapped?.id ?? null;
    };
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      for (const [key, item] of Object.entries(node)) {
        if (['observationId', 'sourceObservationId'].includes(key)) node[key] = reference('observations', item);
        else if (key === 'coverageId') node[key] = reference('recorder_coverage', item);
        else if (key === 'snapshotId') node[key] = reference('provider_snapshot_fetches', item);
        else if (key === 'importId') node[key] = reference('imports', item);
        else if (key === 'episodeId' || key === 'cycleId') node[key] = reference('learning_cycles', item);
        else if (key === 'observations' && Array.isArray(item)) node[key] = item.map(id => reference('observations', id));
        else if (key === 'coverage' && Array.isArray(item)) node[key] = item.map(id => reference('recorder_coverage', id));
        else if (key === 'journal' && Array.isArray(item)) node[key] = item.map(id => reference('learning_journal', id));
        else if (key === 'forecastVersion' && object(item)) {
          node[key] = { ...item, id: reference('provider_snapshot_fetches', item.id), contentId: reference('provider_snapshot_contents', item.contentId) };
        } else visit(item);
      }
    };
    visit(result);
    if (references.size && object(result)) result.recoveryReferences = { donorDigest: this.digest, entries: [...references.values()] };
    return result;
  }
  async evidence() {
    await this.rows('learning_cycles', row => {
      const payload = decode(row.payload);
      this.require(text(row.id) && text(row.input) && instant(row.started_at)
        && (row.ended_at === null || instant(row.ended_at) && row.ended_at >= row.started_at)
        && ['active', 'completed', 'incomplete'].includes(row.status) && object(payload));
      const old = this.target.db.prepare(`SELECT * FROM learning_cycles WHERE id=? OR
        (input=? AND started_at<=COALESCE(?,?) AND COALESCE(ended_at,started_at)>=?) ORDER BY started_at DESC LIMIT 1`)
        .get(row.id, row.input, row.ended_at, row.started_at, row.started_at);
      if (old) return { id: old.id, disposition: same(decode(old.payload), payload) ? 'duplicates' : 'conflicts' };
      // Source cycle IDs may collide after independent operation; scope the
      // donor ID. The frozen plan, observations and command attempts remain.
      const id = `recovered:${digest([this.digest, row.id]).slice(0, 32)}`;
      this.maps.learning_cycles.set(row.id, { id, disposition: 'missing' });
      const mapped = this.remap(payload); mapped.id = id;
      if (mapped.status === 'active') { mapped.status = 'incomplete'; mapped.incompleteReason = 'recovered-interrupted-cycle'; }
      this.insert('learning_cycles', { ...row, id, status: mapped.status, payload: json(mapped) });
      return { id, disposition: 'missing', at: row.started_at };
    }, { query: 'SELECT * FROM learning_cycles ORDER BY started_at,id' });
    await this.rows('events', row => {
      const payload = decode(row.payload);
      this.require(text(row.type) && instant(row.at) && object(payload));
      if (row.type === 'charging-session-check') assertCurrentChargingSessionCheck(payload);
      const old = this.target.db.prepare('SELECT * FROM events WHERE type=? AND at=? ORDER BY id DESC LIMIT 1').get(row.type, row.at);
      if (old) return { id: old.id, disposition: same(decode(old.payload), payload) ? 'duplicates' : 'conflicts' };
      if (row.type === 'charging-session-check') {
        this.require(instant(payload.start) && instant(payload.end) && payload.end > payload.start);
        const overlap = this.target.db.prepare(`SELECT id FROM events WHERE type=? AND json_valid(payload)
          AND json_extract(payload,'$.source')=? AND json_extract(payload,'$.start')<? AND json_extract(payload,'$.end')>? LIMIT 1`)
          .get(row.type, payload.source, payload.end, payload.start);
        if (overlap) return { id: overlap.id, disposition: 'conflicts' };
      }
      return { id: this.insert('events', { type: row.type, at: row.at, payload: json(this.remap(payload)) }), disposition: 'missing', at: row.at };
    });
    await this.rows('charging_session_keys', row => {
      const value = decode(row.value), event = this.known('events', value?.eventId);
      this.require(/^charging-session-check:[a-f0-9]{64}$/.test(row.key) && object(value)
        && /^[a-f0-9]{64}$/.test(value.fingerprint) && event?.id != null && event.disposition !== 'conflicts');
      if (this.target.getState(row.key)) return { disposition: 'duplicates' };
      this.target.setState(row.key, { ...value, eventId: event.id }); return { disposition: 'missing' };
    }, { query: "SELECT * FROM state WHERE key LIKE 'charging-session-check:%' ORDER BY key", map: false });
    await this.rows('energy_audits', row => {
      this.require(row.signal === 'property_import_energy_counter' && text(row.source) && text(row.device)
        && instant(row.source_time) && instant(row.received_at) && finite(row.value) && row.value >= 0 && flags(decode(row.quality)));
      const old = this.target.db.prepare('SELECT * FROM energy_audits WHERE source=? AND device=? AND signal=? AND source_time=? ORDER BY id DESC LIMIT 1')
        .get(row.source, row.device, row.signal, row.source_time);
      if (old) return { id: old.id, disposition: old.value === row.value ? 'duplicates' : 'conflicts' };
      return { id: this.insert('energy_audits', { ...without(row, ['id']), comparison: null }), disposition: 'missing', at: row.source_time };
    });

  }
  async scanJournal() {
    // Context identity uses timestamp + type, never the machine-local row ID.
    // Samples cover half-open windows; a donor window with any usable master
    // overlap is rejected in full, without invented prorated model inputs.
    for (const row of this.donor.db.prepare('SELECT * FROM learning_journal WHERE input=? ORDER BY at,id').iterate(this.input)) {
      let disposition = 'skipped';
      try {
        const payload = decode(row.payload), configuration = payload?.configuration;
        let value = payload?.value;
        this.require(object(payload) && object(configuration) && object(value) && instant(row.at)
          && ['sample', 'context', 'episode'].includes(row.kind));
        if (row.algorithm_version !== LEARNING_ALGORITHM) { this.report.model.unsupported++; throw new TypeError('Unsupported donor algorithm'); }
        this.require(decode(row.config_version) === learningVersion(configuration));
        if (value.sensorRevert) {
          const target = this.known('learning_journal', value.sensorRevert.id);
          this.require(row.kind === 'context' && Number.isSafeInteger(value.sensorRevert.id) && value.sensorRevert.id > 0
            && target?.id != null && ['duplicates', 'missing'].includes(target.disposition));
          this.require(this.donor.db.prepare(`SELECT 1 FROM learning_journal WHERE input=? AND id=? AND kind='context'
            AND algorithm_version=? AND json_type(payload,'$.value.sensorChange')='object'`)
            .get(this.input, value.sensorRevert.id, LEARNING_ALGORITHM));
          value = { ...value, sensorRevert: { ...value.sensorRevert, id: target.id } };
        }
        const old = this.target.db.prepare('SELECT * FROM learning_journal WHERE input=? AND kind=? AND at=? ORDER BY id DESC LIMIT 1')
          .get(this.input, row.kind, row.at);
        if (old && same(decode(old.payload).value, value) && old.config_version === row.config_version) {
          this.maps.learning_journal.set(row.id, { id: old.id, disposition: 'duplicates' }); disposition = 'duplicates';
        } else {
          if (row.kind === 'sample') {
            assertCurrentLearningSample(value);
            const start = value.windowStart, end = value.windowEnd;
            const measured = originalSensorSample(value);
            this.require(instant(start) && instant(end) && end > start && end - start <= LEARNING_WINDOW_MS && end === row.at);
            this.require(finite(measured.indoorC) && finite(measured.outdoorC) && flags(measured.quality ?? [])
              && !(measured.quality ?? []).some(flag => /missing|invalid|stale|unavailable|failed/.test(flag)));
            const overlap = this.target.db.prepare(`SELECT 1 FROM learning_journal WHERE input=? AND kind='sample'
              AND json_valid(payload) AND json_extract(payload,'$.value.sensorInputVersion')=1
              AND json_type(payload,'$.value.inputSegments')='array' AND json_type(payload,CASE
                WHEN json_type(payload,'$.value.measurementInputs')='object'
                THEN '$.value.measurementInputs.indoorC' ELSE '$.value.indoorC' END) IN ('integer','real')
              AND json_type(payload,CASE
                WHEN json_type(payload,'$.value.measurementInputs')='object'
                THEN '$.value.measurementInputs.outdoorC' ELSE '$.value.outdoorC' END) IN ('integer','real')
              AND NOT EXISTS (SELECT 1 FROM json_each(learning_journal.payload,CASE
                WHEN json_type(payload,'$.value.measurementInputs')='object'
                THEN '$.value.measurementInputs.quality' ELSE '$.value.quality' END) q
                WHERE q.value LIKE '%missing%' OR q.value LIKE '%invalid%' OR q.value LIKE '%stale%'
                  OR q.value LIKE '%unavailable%' OR q.value LIKE '%failed%')
              AND json_extract(payload,'$.value.windowStart')<?
              AND json_extract(payload,'$.value.windowEnd')>? LIMIT 1`)
              .get(this.input, end, start);
            if (overlap) { disposition = 'conflicts'; this.maps.learning_journal.set(row.id, { id: old?.id ?? null, disposition }); }
            else {
              // Master conflicts in resolved provenance cannot sneak in through
              // a donor model. Exclude such inputs rather than inventing them.
              const mapped = this.remap(value, { strict: true });
              this.journal.push({ row, payload: { ...payload, value: mapped }, replacesMissing: old?.id ?? null });
              disposition = 'missing'; this.report.model.acceptedSamples++;
            }
          } else if (old) { disposition = 'conflicts'; this.maps.learning_journal.set(row.id, { id: old.id, disposition }); }
          else if (row.kind === 'episode') {
            const cycle = this.known('learning_cycles', value.id);
            this.require(cycle?.id != null && cycle.disposition !== 'conflicts');
            this.journal.push({ row, payload: { ...payload, value: { ...this.remap(value, { strict: true }), id: cycle.id } } }); disposition = 'missing';
          } else {
            this.journal.push({ row, payload: { ...payload, value: this.remap(value) } }); disposition = 'missing';
          }
          if (disposition === 'missing') this.maps.learning_journal.set(row.id, { id: -row.id, disposition });
        }
      } catch (error) { if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error; }
      this.count('learning_journal', disposition, row.at);
      if (++this.processed % 64 === 0) { this.progress({ phase: 'importing', processed: this.processed }); await yieldTurn(); }
    }
    if (this.journal.length || this.report.tables.find(row => row.name === 'fireplace_events')?.missing)
      this.report.model.status = 'rebuild-required';
  }
  async run() {
    await this.imports(); await this.snapshots(); await this.observations(); await this.pendingEnergy();
    await this.manual(); await this.evidence(); await this.scanJournal();
    return this.report;
  }
}
