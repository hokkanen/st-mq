// Reverse source references are maintained with the owning row's transaction.
// Recovery can inspect only affected roots and cycles instead of historical JSON.
const references = `CASE
  WHEN j.key IN ('observationId','sourceObservationId') OR j.path GLOB '*.observations' AND typeof(j.key)='integer' THEN 'observations'
  WHEN j.key='coverageId' OR j.path GLOB '*.coverage' AND typeof(j.key)='integer' THEN 'recorder_coverage'
  WHEN j.key='snapshotId' OR j.key='id' AND (j.path GLOB '*.forecastVersion' OR j.path GLOB '*.forecast_version' OR j.path GLOB '*.lastForecastVersion') THEN 'provider_snapshot_fetches'
  WHEN j.key IN ('cycleId','episodeId') THEN 'learning_cycles'
  WHEN j.path GLOB '*.journal' AND typeof(j.key)='integer' OR j.key='id' AND j.path GLOB '*.sensorRevert' THEN 'learning_journal'
END`;
const cycleTables = ['learning_cycles','learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations'];
const columns = table => table === 'learning_cycle_samples' ? ['provenance','context'] : ['payload'];
const structural = table => table === 'learning_cycles' ? `
  SELECT 'learning_cycle_definitions' source_table,id source_key FROM learning_cycle_definitions WHERE id=?
  UNION SELECT 'learning_cycle_samples',CAST(id AS TEXT) FROM learning_cycle_samples WHERE cycle_id=?`
  : table === 'learning_cycle_samples' ? `SELECT 'learning_cycle_observations' source_table,CAST(id AS TEXT) source_key FROM learning_cycle_observations WHERE sample_id=?` : null;
function ownershipTriggers(table, parent, field) {
  return `CREATE TRIGGER ${table}_recovery_owner_insert AFTER INSERT ON ${table} BEGIN
    INSERT INTO recovery_dependencies VALUES('${parent}',CAST(NEW.${field} AS TEXT),'${table}',CAST(NEW.id AS TEXT)); END;
  CREATE TRIGGER ${table}_recovery_owner_delete AFTER DELETE ON ${table} BEGIN
    DELETE FROM recovery_dependencies WHERE owner_table='${parent}' AND owner_key=CAST(OLD.${field} AS TEXT)
      AND source_table='${table}' AND source_key=CAST(OLD.id AS TEXT); END;`;
}
function triggers(table) {
  const root = table === 'learning_journal_entries' ? ' AND NEW.source_entry_id IS NULL' : '';
  const owner = table === 'learning_journal_entries' ? 'learning_journal' : table;
  const sourceReferences = table === 'learning_journal_entries' ? references.replace("WHEN j.key IN ('cycleId','episodeId')", "WHEN j.key='id' AND j.path GLOB '*.value' AND NEW.kind='episode' OR j.key IN ('cycleId','episodeId')") : references;
  const insert = `INSERT INTO recovery_dependencies(owner_table,owner_key,source_table,source_key)
    SELECT DISTINCT '${owner}',CAST(NEW.id AS TEXT),source_table,
      CASE WHEN source_table='learning_journal' THEN CAST(COALESCE((SELECT COALESCE(e.source_entry_id,e.id)
        FROM learning_journal_entries e WHERE e.id=source_key),source_key) AS TEXT) ELSE CAST(source_key AS TEXT) END
    FROM (SELECT ${sourceReferences} source_table,j.atom source_key
      FROM (${columns(table).map(column => `SELECT * FROM json_tree(NEW.${column})`).join(' UNION ALL ')}) j
      WHERE j.type IN ('integer','text')) WHERE source_table IS NOT NULL;`;
  return `CREATE TRIGGER ${table}_recovery_insert AFTER INSERT ON ${table}
    WHEN ${columns(table).map(column => `json_valid(NEW.${column})`).join(' AND ')}${root} BEGIN ${insert} END;
  CREATE TRIGGER ${table}_recovery_update AFTER UPDATE OF ${columns(table).join(',')} ON ${table}
    BEGIN DELETE FROM recovery_dependencies WHERE owner_table='${owner}' AND owner_key=CAST(OLD.id AS TEXT) AND source_table NOT IN ('learning_cycle_definitions','learning_cycle_samples','learning_cycle_observations');
      ${insert} END;
  CREATE TRIGGER ${table}_recovery_delete AFTER DELETE ON ${table}
    BEGIN DELETE FROM recovery_dependencies WHERE owner_table='${owner}' AND owner_key=CAST(OLD.id AS TEXT); END;`;
}
export const RECOVERY_MODEL_TIME = 'model_at';
export const RECOVERY_DEPENDENCY_SCHEMA = `
CREATE TABLE recovery_dependencies (
  owner_table TEXT NOT NULL,owner_key TEXT NOT NULL,source_table TEXT NOT NULL,source_key TEXT NOT NULL,
  PRIMARY KEY(owner_table,owner_key,source_table,source_key)) WITHOUT ROWID;
CREATE INDEX recovery_dependencies_source ON recovery_dependencies(source_table,source_key,owner_table,owner_key);
CREATE INDEX recovery_coverage_parent ON recorder_coverage(observation_id,id);
CREATE INDEX recovery_fireplace_parent ON fireplace_events(target_id,id);
CREATE INDEX recovery_cycles_model_time ON learning_cycles(input,${RECOVERY_MODEL_TIME},id);
CREATE INDEX recovery_learning_source ON learning_journal_entries(source_entry_id,epoch,input);
${triggers('learning_journal_entries')}
${cycleTables.map(triggers).join('\n')}
${ownershipTriggers('learning_cycle_definitions','learning_cycles','id')}
${ownershipTriggers('learning_cycle_samples','learning_cycles','cycle_id')}
${ownershipTriggers('learning_cycle_observations','learning_cycle_samples','sample_id')}
`;

/** Read-only semantic check for the derived reverse-reference index. SQLite
 * and the mutation journal cannot detect missing edges in this unjournaled
 * table. Recompute one owner's references at a time, never all history in RAM.
 * Projection inserts intentionally omit edges; a later sensor-reference remap
 * may populate them. Such optional edges must still be justified by the current
 * projection payload. Authoritative roots and cycles require the complete set. */
export function validateRecoveryDependencies(db, onProgress = () => {}) {
  const invalid = () => { throw Object.assign(new Error('Recovery source references failed verification. Preserve the database and use an intact current-version backup.'),
    { code: 'database_integrity_failed' }); };
  if (db.prepare(`SELECT 1 FROM recovery_dependencies d WHERE NOT (
    d.owner_table='learning_journal' AND EXISTS(SELECT 1 FROM learning_journal_entries e WHERE e.id=CAST(d.owner_key AS INTEGER) AND CAST(e.id AS TEXT)=d.owner_key)
    ${cycleTables.map(table => `OR d.owner_table='${table}' AND EXISTS(SELECT 1 FROM ${table} c WHERE c.id=d.owner_key AND CAST(c.id AS TEXT)=d.owner_key)`).join('\n')}) LIMIT 1`).get()) invalid();
  let processed = 0;
  for (const table of ['learning_journal_entries', ...cycleTables]) {
    const learning = table === 'learning_journal_entries', owner = learning ? 'learning_journal' : table;
    const sourceReferences = learning ? references.replace("WHEN j.key IN ('cycleId','episodeId')",
      "WHEN j.key='id' AND j.path GLOB '*.value' AND ?='episode' OR j.key IN ('cycleId','episodeId')") : references;
    const jsonReferences = columns(table).map(() => `SELECT source_table,
      CASE WHEN source_table='learning_journal' THEN CAST(COALESCE((SELECT COALESCE(e.source_entry_id,e.id)
        FROM learning_journal_entries e WHERE e.id=source_key),source_key) AS TEXT) ELSE CAST(source_key AS TEXT) END source_key
      FROM (SELECT ${sourceReferences} source_table,j.atom source_key
        FROM json_tree(?) j WHERE j.type IN ('integer','text')) WHERE source_table IS NOT NULL`).join(' UNION ');
    const expected = `${jsonReferences}${structural(table) ? ` UNION ${structural(table)}` : ''}`;
    const compare = optional => db.prepare(`WITH wanted AS (${expected}),found AS (
      SELECT source_table,source_key FROM recovery_dependencies WHERE owner_table=? AND owner_key=?)
      SELECT 1 FROM (SELECT * FROM found EXCEPT SELECT * FROM wanted)
      ${optional ? '' : 'UNION ALL SELECT 1 FROM (SELECT * FROM wanted EXCEPT SELECT * FROM found)'} LIMIT 1`);
    const required = compare(false), optional = learning && compare(true);
    for (const row of db.prepare(`SELECT id,${columns(table).join(',')}${learning ? ',kind,source_entry_id' : ''} FROM ${table}`).iterate()) {
      const args = columns(table).flatMap(column => [...(learning ? [row.kind] : []),row[column]]);
      if (structural(table)) args.push(...(table === 'learning_cycles' ? [row.id,row.id] : [row.id]));
      if ((learning && row.source_entry_id !== null ? optional : required).get(...args,owner,String(row.id))) invalid();
      if (++processed % 256 === 0) onProgress(processed);
    }
  }
  onProgress(processed);
}
