// Reverse source references are maintained with the owning row's transaction.
// Recovery can inspect only affected roots and cycles instead of historical JSON.
const references = `CASE
  WHEN j.key IN ('observationId','sourceObservationId') OR j.path GLOB '*.observations' AND typeof(j.key)='integer' THEN 'observations'
  WHEN j.key='coverageId' OR j.path GLOB '*.coverage' AND typeof(j.key)='integer' THEN 'recorder_coverage'
  WHEN j.key='snapshotId' OR j.key='id' AND (j.path GLOB '*.forecastVersion' OR j.path GLOB '*.forecast_version') THEN 'provider_snapshot_fetches'
  WHEN j.key IN ('cycleId','episodeId') THEN 'learning_cycles'
  WHEN j.path GLOB '*.journal' AND typeof(j.key)='integer' OR j.key='id' AND j.path GLOB '*.sensorRevert' THEN 'learning_journal'
END`;
function triggers(table) {
  const root = table === 'learning_journal_entries' ? ' AND NEW.source_entry_id IS NULL' : '';
  const owner = table === 'learning_journal_entries' ? 'learning_journal' : table;
  const sourceReferences = table === 'learning_journal_entries' ? references.replace("WHEN j.key IN ('cycleId','episodeId')", "WHEN j.key='id' AND j.path GLOB '*.value' AND NEW.kind='episode' OR j.key IN ('cycleId','episodeId')") : references;
  const insert = `INSERT INTO recovery_dependencies(owner_table,owner_key,source_table,source_key)
    SELECT DISTINCT '${owner}',CAST(NEW.id AS TEXT),source_table,
      CASE WHEN source_table='learning_journal' THEN CAST(COALESCE((SELECT COALESCE(e.source_entry_id,e.id)
        FROM learning_journal_entries e WHERE e.id=source_key),source_key) AS TEXT) ELSE CAST(source_key AS TEXT) END
    FROM (SELECT ${sourceReferences} source_table,j.atom source_key
      FROM json_tree(NEW.payload) j
      WHERE j.type IN ('integer','text')) WHERE source_table IS NOT NULL;`;
  return `CREATE TRIGGER ${table}_recovery_insert AFTER INSERT ON ${table}
    WHEN json_valid(NEW.payload)${root} BEGIN ${insert} END;
  CREATE TRIGGER ${table}_recovery_update AFTER UPDATE OF payload ON ${table}
    BEGIN DELETE FROM recovery_dependencies WHERE owner_table='${owner}' AND owner_key=CAST(OLD.id AS TEXT);
      ${insert} END;
  CREATE TRIGGER ${table}_recovery_delete AFTER DELETE ON ${table}
    BEGIN DELETE FROM recovery_dependencies WHERE owner_table='${owner}' AND owner_key=CAST(OLD.id AS TEXT); END;`;
}
export const RECOVERY_MODEL_TIME = `COALESCE(CASE WHEN typeof(json_extract(payload,'$.plan.model.trainedAt')) IN ('integer','real') THEN json_extract(payload,'$.plan.model.trainedAt') ELSE (julianday(json_extract(payload,'$.plan.model.trainedAt'))-2440587.5)*86400000 END,started_at)`;
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
${triggers('learning_cycles')}
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
  if (db.prepare(`SELECT 1 FROM recovery_dependencies d
    LEFT JOIN learning_journal_entries e ON d.owner_table='learning_journal'
      AND e.id=CAST(d.owner_key AS INTEGER) AND d.owner_key=CAST(e.id AS TEXT)
    LEFT JOIN learning_cycles c ON d.owner_table='learning_cycles' AND c.id=d.owner_key
    WHERE e.id IS NULL AND c.id IS NULL LIMIT 1`).get()) invalid();
  const actual = db.prepare(`SELECT source_table,source_key FROM recovery_dependencies
    WHERE owner_table=? AND owner_key=? ORDER BY source_table,source_key`);
  let processed = 0;
  for (const table of ['learning_journal_entries', 'learning_cycles']) {
    const learning = table === 'learning_journal_entries', owner = learning ? 'learning_journal' : table;
    const sourceReferences = learning ? references.replace("WHEN j.key IN ('cycleId','episodeId')",
      "WHEN j.key='id' AND j.path GLOB '*.value' AND ?='episode' OR j.key IN ('cycleId','episodeId')") : references;
    const expected = db.prepare(`SELECT DISTINCT source_table,
      CASE WHEN source_table='learning_journal' THEN CAST(COALESCE((SELECT COALESCE(e.source_entry_id,e.id)
        FROM learning_journal_entries e WHERE e.id=source_key),source_key) AS TEXT) ELSE CAST(source_key AS TEXT) END source_key
      FROM (SELECT ${sourceReferences} source_table,j.atom source_key
        FROM json_tree(?) j WHERE j.type IN ('integer','text'))
      WHERE source_table IS NOT NULL ORDER BY source_table,source_key`);
    const rows = db.prepare(`SELECT id,payload${learning ? ',kind,source_entry_id' : ''} FROM ${table}`);
    for (const row of rows.iterate()) {
      const found = actual.all(owner, String(row.id));
      const wanted = expected.all(...(learning ? [row.kind] : []), row.payload);
      if (learning && row.source_entry_id !== null) {
        const allowed = new Set(wanted.map(value => JSON.stringify([value.source_table, value.source_key])));
        if (found.some(value => !allowed.has(JSON.stringify([value.source_table, value.source_key])))) invalid();
      } else if (JSON.stringify(found) !== JSON.stringify(wanted)) invalid();
      if (++processed % 256 === 0) onProgress(processed);
    }
  }
  onProgress(processed);
}
