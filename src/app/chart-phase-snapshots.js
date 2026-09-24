const PHASES = ['property','ev1'].flatMap(prefix => [1,2,3].map(phase => `${prefix}_current_l${phase}`));

/** Easee reports the latest state of each phase, with independent event clocks.
 * Combine one device/poll, retaining the newest phase's source time for display.
 * Indexed lookups include unchanged phases outside the selected history window;
 * emitting at the last source row preserves stream order with bounded memory. */
export function* alignEaseePowerSnapshots(rows, db, now) {
  const snapshot = db.prepare(`SELECT id,source,device,signal,value,unit,source_time,received_at,quality,import_id,row_number
    FROM observations WHERE source='easee' AND import_id IS NULL AND device=? AND received_at=?
    AND signal IN (?,?,?) ORDER BY id`);
  const cache = new Map();
  for (const row of rows) {
    if (row.source !== 'easee' || row.import_id !== null || !PHASES.includes(row.signal)) {
      yield row; continue;
    }
    const prefix = row.signal.startsWith('property_') ? 'property' : 'ev1';
    const key = JSON.stringify([prefix, row.device, row.received_at]);
    let group = cache.get(key);
    if (!group) {
      const phases = new Map(snapshot.all(row.device, row.received_at,
        ...[1, 2, 3].map(phase => `${prefix}_current_l${phase}`)).map(phase => [phase.signal, phase]));
      const values = [...phases.values()];
      const anchor = values.filter(phase => Number.isFinite(phase.source_time) && phase.source_time <= now)
        .sort((a, b) => b.source_time - a.source_time || b.id - a.id)[0];
      group = { rows: values, anchor };
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, group);
    }
    if (row.id !== group.anchor?.id) continue;
    for (const phase of group.rows) yield { ...phase, source_time: group.anchor.source_time,
      value: Number.isFinite(phase.source_time) && phase.source_time <= now ? phase.value : null, alignedPowerSnapshot: true };
  }
}
