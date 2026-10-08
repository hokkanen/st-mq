// Reverse source references are maintained with the owning row's transaction.
// Recovery can inspect only affected roots and cycles instead of historical JSON.
const references = `CASE
  WHEN j.key IN ('observationId','sourceObservationId') OR p.key='observations' AND p.type='array' THEN 'observations'
  WHEN j.key='coverageId' OR p.key='coverage' AND p.type='array' THEN 'recorder_coverage'
  WHEN j.key='snapshotId' OR j.key='id' AND p.key IN ('forecastVersion','forecast_version') THEN 'provider_snapshot_fetches'
  WHEN j.key IN ('cycleId','episodeId') THEN 'learning_cycles'
  WHEN p.key='journal' AND p.type='array' OR j.key='id' AND p.key='sensorRevert' THEN 'learning_journal'
END`;
function triggers(table) {
  const root = table === 'learning_journal_entries' ? ' AND NEW.source_entry_id IS NULL' : '';
  const owner = table === 'learning_journal_entries' ? 'learning_journal' : table;
  const sourceReferences = table === 'learning_journal_entries' ? references.replace("WHEN j.key IN ('cycleId','episodeId')", "WHEN j.key='id' AND p.key='value' AND NEW.kind='episode' OR j.key IN ('cycleId','episodeId')") : references;
  const insert = `INSERT OR IGNORE INTO recovery_dependencies(owner_table,owner_key,source_table,source_key)
    SELECT '${owner}',CAST(NEW.id AS TEXT),source_table,
      CASE WHEN source_table='learning_journal' THEN CAST(COALESCE((SELECT COALESCE(e.source_entry_id,e.id)
        FROM learning_journal_entries e WHERE e.id=source_key),source_key) AS TEXT) ELSE CAST(source_key AS TEXT) END
    FROM (SELECT ${sourceReferences} source_table,j.atom source_key
      FROM json_tree(NEW.payload) j LEFT JOIN json_tree(NEW.payload) p ON p.id=j.parent
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
