import { releaseStorageLease, checkStorageRequest } from '../storage/worker-admission.js';
import { recordedEnergyGroups, recordedEnergyStart } from '../storage/energy-history.js';
import { createChartVoltageReader } from './chart-voltage-cache.js';

export function garageIntentRevision(db, input, at) {
  const latest = db.prepare(`SELECT id,at,json_extract(payload,'$.input') AS input
    FROM active_events AS events WHERE type='garage-intent' ORDER BY id DESC LIMIT 1`).get();
  // If the largest active ID itself qualifies, it is also the largest eligible
  // ID. Otherwise retain the time-bounded lookup: occurrence order and journal
  // IDs can diverge, and an old selection must not scan every later event.
  if (latest && latest.input === input && latest.at <= at) return latest.id;
  return db.prepare(`SELECT MAX(id) AS revision FROM active_events AS events
    WHERE type='garage-intent' AND at<=? AND json_extract(payload,'$.input')=?`).get(at, input).revision;
}

// Reuse source interpretation within an immutable chart request. The worker may
// retain a bounded context only while selection/import revisions, pending energy
// and receipt cutoffs still match. Dense histories retain the streaming path.
export function createChartQueryContext({ store, range, now, input, maxEnergyGroups = 65_536,
  maxEnergyBytes = 32 * 1024 * 1024 }) {
  const starts = new Map();
  let energy = null, energyStats = null, attempted = false;
  const options = { from: range.from, to: range.to, now, input };
  return {
    voltageReader: createChartVoltageReader(store, { input, now, pageRows: 192 }),
    // Energy groups are voltage-independent. A reused context starts a fresh
    // immutable voltage reader for each chart, preserving its actual as-of clock.
    resetVoltage(at) { this.voltageReader = createChartVoltageReader(store, { input, now: at, pageRows: 192 }); },
    energyStart(prefix) {
      if (!starts.has(prefix)) starts.set(prefix, recordedEnergyStart(store, prefix, input, now));
      return starts.get(prefix);
    },
    *energyGroups(stats = { rows: 0 }, prefix) {
      releaseStorageLease();
      if (energy) {
        // Drawing passes use the same full source-row accounting as the first
        // traversal. Extrema only need their selected logical prefix.
        Object.assign(stats, energyStats);
        let index = 0;
        for (const group of energy) {
          if ((index++ & 255) === 0) checkStorageRequest();
          if (prefix === undefined || group.prefix === prefix) yield group;
        }
        return;
      }
      if (attempted || prefix !== undefined) {
        yield* recordedEnergyGroups(store, { ...options, ...(prefix === undefined ? {} : { prefix }) }, stats);
        return;
      }
      attempted = true;
      let captured = [], bytes = 0;
      for (const group of recordedEnergyGroups(store, options, stats)) {
        // Supported cohort arrays are fixed at one/three phases. An unexpected
        // nested basis is not bounded metadata, so do not retain it for replay.
        if (group.basis != null && typeof group.basis !== 'string') captured = null;
        if (captured) {
          // Account for bounded arrays, object overhead and variable source
          // strings without allocating another serialized copy of every row.
          bytes += 640 + 2 * ((group.source?.length ?? 0) + (group.device?.length ?? 0)
            + (group.basis?.length ?? 0) + (group.transport?.length ?? 0));
          if (captured.length >= maxEnergyGroups || bytes > maxEnergyBytes) captured = null;
          else captured.push(group);
        }
        yield group;
      }
      if (captured) {
        energy = captured;
        energyStats = { rows: stats.rows, ...(stats.conflicts === undefined ? {} : { conflicts: stats.conflicts }) };
      }
    },
  };
}
