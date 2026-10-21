import { recordedChargingEnergy, summarizeRecordedChargingEnergy } from './energy.js';
import { recordedEnergyGroups } from '../storage/energy-history.js';
import { pendingEnergyObservations } from '../storage/pending-energy.js';
import { observationAvailableAt } from '../domain/time-evidence.js';
import { selectedHistoryPredicate } from '../storage/schema.js';

const MAX_SCOPES = 4, MAX_GROUPS = 8192, MAX_CHANGES = 256, MAX_FUTURE = 128;
const admission = "json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.timeAdmission.admittedAt')";

/** A disposable, bounded projection of immutable recorded energy. Original rows
 * and pending recorder tails remain the evidence. New rows rewind the affected
 * overlap cluster; a new history selection, rollback or clock reversal rebuilds.
 * A status read never saves a checkpoint or creates an acquisition event. */
export function createRecordedChargingEnergyReader(store) {
  const scopes = new Map();
  const changes = (query, prefix, after, through, future = false) => {
    const signals = [1, 2, 3].map(n => `${prefix}_energy_l${n}`);
    // Only intervals ending after this connection's start can affect its
    // energy. Keep all three availability clocks, but seek the session before
    // testing them; an old deferred admission must not be silently discarded.
    const source = future ? 'observations INDEXED BY observations_signal_time' : 'active_observations AS observations';
    return store.db.prepare(`SELECT id,source_time,received_at,raw FROM ${source}
      WHERE signal IN (?,?,?) AND source=? AND import_id IS NULL
      ${query.device != null ? 'AND device=?' : ''}
      AND ${future ? `source_time>? AND ${selectedHistoryPredicate('observations', 'observations')}
        AND (source_time>? OR received_at>? OR ${admission}>?)` : 'id>? AND id<=?'}
      ${future ? '' : 'ORDER BY id'} LIMIT ?`).all(...signals, prefix === 'ev1' ? 'easee' : 'shelly-evse',
      ...(query.device != null ? [query.device] : []),
      ...(future ? [query.start, query.end, query.end, query.end, MAX_FUTURE + 1] : [after, through, MAX_CHANGES + 1]));
  };
  const evidence = row => {
    let raw;
    try { raw = JSON.parse(row.raw); } catch { return null; }
    if (!Number.isSafeInteger(raw?.intervalStart) || !Number.isSafeInteger(raw?.intervalEnd)
      || raw.intervalEnd <= raw.intervalStart || raw.intervalEnd !== row.source_time
      || raw.timeBasis === 'completed-hour') return null;
    const at = observationAvailableAt({ sourceTime: row.source_time, receivedAt: row.received_at, raw });
    return at === null ? null : { at, start: raw.intervalStart };
  };
  const collect = (query, prefix, from) => {
    const groups = [];
    for (const group of recordedEnergyGroups(store, { from, to: query.end, now: query.end,
      input: 'providers', prefix, source: prefix === 'ev1' ? 'easee' : 'shelly-evse', device: query.device })) {
      if (groups.length === MAX_GROUPS) return null;
      groups.push(group);
    }
    return groups;
  };
  return query => {
    const prefix = query.id === 'charger1' ? 'ev1' : query.id === 'charger2' ? 'ev2' : null;
    if (!store?.db || store.readOnly || store.journalSource === true || !prefix || !Number.isFinite(query.start) || !Number.isFinite(query.end) || query.end <= query.start)
      return recordedChargingEnergy(store, query);
    const key = JSON.stringify([query.id, query.device ?? null, query.start]);
    // A provisional read can see IDs that SQLite will reuse after rollback.
    // Invalidating on rollback is necessary even if its later MAX(id) matches.
    if (store.transactionDepth) store.afterRollback(() => scopes.clear());
    try {
      const selection = store.db.prepare('SELECT generation FROM history_selection WHERE id=1').get().generation;
      const watermark = store.db.prepare('SELECT max(id) AS id FROM active_observations AS observations').get().id ?? 0;
      const pending = pendingEnergyObservations(store, { now: query.end, input: 'providers', prefix,
        source: prefix === 'ev1' ? 'easee' : 'shelly-evse', device: query.device });
      const pendingKey = JSON.stringify(pending);
      let cache = scopes.get(key), boundary = Infinity, future;
      if (cache && (cache.selection !== selection || watermark < cache.watermark || query.end < cache.now)) cache = null;
      if (!cache) {
        const rows = changes(query, prefix, 0, 0, true);
        if (rows.length > MAX_FUTURE) return recordedChargingEnergy(store, query);
        future = rows.map(evidence).filter(row => row && row.at > query.end);
        boundary = query.start;
      } else {
        future = [...cache.future];
        if (watermark !== cache.watermark) {
          const rows = changes(query, prefix, cache.watermark, watermark);
          if (rows.length > MAX_CHANGES) {
            scopes.delete(key);
            return recordedChargingEnergy(store, query);
          }
          for (const row of rows.map(evidence).filter(Boolean)) {
            if (row.at > query.end) future.push(row);
            else boundary = Math.min(boundary, row.start);
          }
        }
        for (const row of future) if (row.at <= query.end) boundary = Math.min(boundary, row.start);
        future = future.filter(row => row.at > query.end);
        if (pendingKey !== cache.pendingKey) {
          for (const row of [...cache.pending, ...pending]) {
            const start = JSON.parse(row.raw).intervalStart;
            boundary = Math.min(boundary, start);
          }
        }
      }
      if (future.length > MAX_FUTURE) { scopes.delete(key); return recordedChargingEnergy(store, query); }
      let groups = cache?.groups ?? [];
      if (boundary < query.end) {
        boundary = Math.max(query.start, boundary);
        // A newly arriving overlap can invalidate an entire earlier cluster.
        // Keep conflicts as well as valid cohorts in the disposable index.
        let previous;
        do {
          previous = boundary;
          for (const group of groups) if (group.start < boundary && group.end > boundary)
            boundary = Math.max(query.start, group.start);
        } while (boundary < previous);
        const tail = collect(query, prefix, boundary);
        if (!tail) { scopes.delete(key); return recordedChargingEnergy(store, query); }
        groups = [...groups.filter(group => group.end <= boundary), ...tail];
        if (groups.length > MAX_GROUPS) { scopes.delete(key); return recordedChargingEnergy(store, query); }
      }
      const result = summarizeRecordedChargingEnergy(groups, query);
      scopes.delete(key);
      scopes.set(key, { selection, watermark, now: query.end, pending, pendingKey, future, groups });
      while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
      return result;
    } catch (error) { scopes.delete(key); throw error; }
  };
}
