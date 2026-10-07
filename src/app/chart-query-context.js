import { recordedEnergyGroups, recordedEnergyStart } from '../storage/energy-history.js';
import { createVoltageReader } from '../storage/voltage.js';

// Reuse source interpretation within one immutable chart request. This is not
// a cross-request cache: recovery revisions, pending energy and receipt cutoffs
// are read again for every request. Dense histories retain the streaming path.
export function createChartQueryContext({ store, range, now, input, maxEnergyGroups = 16_384,
  maxEnergyBytes = 8 * 1024 * 1024 }) {
  const starts = new Map();
  let energy = null, energyStats = null, attempted = false;
  const options = { from: range.from, to: range.to, now, input };
  return {
    voltageReader: createVoltageReader(store, { input, now }),
    energyStart(prefix) {
      if (!starts.has(prefix)) starts.set(prefix, recordedEnergyStart(store, prefix, input, now));
      return starts.get(prefix);
    },
    *energyGroups(stats = { rows: 0 }, prefix) {
      if (energy) {
        // Drawing passes use the same full source-row accounting as the first
        // traversal. Extrema only need their selected logical prefix.
        Object.assign(stats, energyStats);
        for (const group of energy) if (prefix === undefined || group.prefix === prefix) yield group;
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
