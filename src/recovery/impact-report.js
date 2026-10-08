import { yieldToController } from './scheduler.js';

const timeColumns = {
  imports: null, provider_snapshot_contents: null,
  observations: ["COALESCE(CASE WHEN json_valid(raw) AND json_type(raw,'$.intervalStart')='integer' THEN json_extract(raw,'$.intervalStart') END,source_time,received_at)", 'COALESCE(source_time,received_at)'],
  recorder_coverage: ['start_at', 'end_at'], provider_snapshot_fetches: ['fetched_at', 'fetched_at'],
  annotations: ['start_at', 'COALESCE(end_at,start_at)'], counters: ['source_time', 'source_time'],
  fireplace_events: ['at', 'at'], learning_cycles: ['started_at', 'COALESCE(ended_at,started_at)'],
  cycle_assessments: ['started_at', 'COALESCE(ended_at,started_at)'], events: ['at', 'at'],
  energy_audits: ['source_time', 'source_time'], import_rows: ['source_time', 'source_time'],
  learning_journal: ['at', 'at'],
};
const date = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;

/** Resolve only the records whose selection changes, with indexed point reads
 * and bounded writer yields. No values, equipment identities or paths escape. */
export async function recoveryRevisionImpact({ db, recoveryId, generation, selection, active, tables, yieldControl = yieldToController }) {
  const chosen = active ? selection : generation, previous = active ? generation : selection;
  const rows = db.prepare(`SELECT x.record_key,EXISTS(SELECT 1 FROM recovery_members m
    WHERE m.recovery_id=? AND m.table_name=x.table_name AND m.record_key=x.record_key) direct
    FROM recovery_exclusions x WHERE x.generation=? AND x.table_name=? AND x.record_key>?
    AND NOT EXISTS(SELECT 1 FROM recovery_exclusions old WHERE old.generation=?
      AND old.table_name=x.table_name AND old.record_key=x.record_key)
    ORDER BY x.record_key LIMIT 128`);
  const result = { direct: 0, dependent: 0, retained: 0, categories: [] };
  for (const { name, count } of tables) {
    const bounds = timeColumns[name], table = name === 'learning_journal' ? 'learning_journal_entries'
      : name === 'cycle_assessments' ? 'learning_cycles' : name;
    const lookup = bounds && db.prepare(`SELECT ${bounds[0]} "from",${bounds[1]} "to" FROM ${table}
      WHERE ${name === 'import_rows' ? 'import_id=? AND row_number=?' : 'id=?'}`);
    const range = { name, count, direct: 0, dependent: 0, from: null, to: null, undated: 0 };
    let after = '';
    for (;;) {
      const batch = rows.all(recoveryId, chosen, name, after, previous);
      if (!batch.length) break;
      for (const item of batch) {
        range[item.direct ? 'direct' : 'dependent']++;
        const times = lookup?.get(...(name === 'import_rows' ? item.record_key.split(':').map(Number) : [item.record_key]));
        if (date(times?.from) && date(times?.to) && times.to >= times.from) {
          range.from = Math.min(range.from ?? times.from, times.from);
          range.to = Math.max(range.to ?? times.to, times.to);
        } else range.undated++;
        after = item.record_key;
      }
      await yieldControl();
    }
    result.direct += range.direct; result.dependent += range.dependent; result.categories.push(range);
  }
  if (active) result.retained = db.prepare(`SELECT COUNT(*) count FROM recovery_members m
    WHERE m.recovery_id=? AND EXISTS(SELECT 1 FROM recovery_exclusions x
      WHERE x.generation=? AND x.table_name=m.table_name AND x.record_key=m.record_key)`)
    .get(recoveryId, generation).count;
  return result;
}

export function validRecoveryRevisionImpact(value, tables) {
  const fields = (row, keys) => row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => keys.includes(key));
  const count = number => Number.isSafeInteger(number) && number >= 0;
  return fields(value, ['direct', 'dependent', 'retained', 'categories'])
    && ['direct', 'dependent', 'retained'].every(key => count(value[key]))
    && Array.isArray(value.categories) && Array.isArray(tables) && value.categories.length === tables.length
    && new Set(value.categories.map(row => row?.name)).size === tables.length
    && value.categories.every(row => fields(row, ['name', 'count', 'direct', 'dependent', 'from', 'to', 'undated'])
      && Object.hasOwn(timeColumns, row.name) && tables.some(table => table.name === row.name && table.count === row.count)
      && ['count', 'direct', 'dependent', 'undated'].every(key => count(row[key]))
      && row.direct + row.dependent === row.count && row.undated <= row.count
      && (row.from === null && row.to === null || date(row.from) && date(row.to) && row.to >= row.from))
    && ['direct', 'dependent'].every(key => value[key] === value.categories.reduce((sum, row) => sum + row[key], 0));
}
