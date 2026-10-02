// One current schema. Pre-production databases are never migrated.
export const SCHEMA_VERSION = 18;
export const CURRENT_SCHEMA = `
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER,
  note TEXT NOT NULL, boundary_confidence TEXT NOT NULL, exclude_training INTEGER NOT NULL,
  provenance TEXT NOT NULL, created_at INTEGER NOT NULL, unique_key TEXT UNIQUE
);
CREATE TABLE counters (
  id INTEGER PRIMARY KEY, device TEXT NOT NULL, signal TEXT NOT NULL, value REAL NOT NULL,
  unit TEXT NOT NULL, observed_date TEXT NOT NULL, source_time INTEGER,
  note TEXT NOT NULL, provenance TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(device, signal, observed_date, provenance)
);
CREATE TABLE charging_reports (
 namespace TEXT NOT NULL, charger_id TEXT NOT NULL, report_id TEXT NOT NULL,
 association TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, saved_at INTEGER,
 summary TEXT NOT NULL CHECK(json_valid(summary)), checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)),
 PRIMARY KEY(namespace,charger_id,report_id)
) WITHOUT ROWID;
CREATE TABLE charging_report_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, charger_id TEXT NOT NULL, report_id TEXT NOT NULL,
 at INTEGER NOT NULL, category TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 FOREIGN KEY(namespace,charger_id,report_id) REFERENCES charging_reports(namespace,charger_id,report_id) ON DELETE CASCADE
);
CREATE TABLE energy_audits (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
 source_time INTEGER NOT NULL, received_at INTEGER NOT NULL, value REAL NOT NULL,
 quality TEXT NOT NULL, comparison TEXT,
 UNIQUE(source,device,signal,source_time,value));
CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE fireplace_events (
          id INTEGER PRIMARY KEY, input TEXT NOT NULL, request_id TEXT NOT NULL,
          at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('load','remove')),
          kg INTEGER, target_id INTEGER REFERENCES fireplace_events(id),
          UNIQUE(input,request_id),
          CHECK((kind='load' AND kg BETWEEN 2 AND 10 AND target_id IS NULL)
            OR (kind='remove' AND kg IS NULL AND target_id IS NOT NULL)));
CREATE TABLE import_rows (
  import_id INTEGER NOT NULL REFERENCES imports(id), row_number INTEGER NOT NULL,
  source_time INTEGER, raw TEXT NOT NULL, quality TEXT NOT NULL, canonical TEXT NOT NULL CHECK(json_valid(canonical)),
  PRIMARY KEY(import_id, row_number)
) WITHOUT ROWID;
CREATE TABLE imports (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  status TEXT NOT NULL, attempt TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, completed_at INTEGER,
  row_count INTEGER NOT NULL DEFAULT 0, rejected_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(kind, sha256)
);
CREATE TABLE learning_cycles (
 id TEXT PRIMARY KEY, input TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
 status TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE learning_epochs (input TEXT PRIMARY KEY, epoch TEXT NOT NULL);
CREATE TABLE learning_journal_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL,
            input TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
            algorithm_version TEXT NOT NULL, config_version TEXT, forecast_version TEXT,
            payload TEXT, source_entry_id INTEGER REFERENCES learning_journal_entries(id),
            CHECK(payload IS NOT NULL OR source_entry_id IS NOT NULL), UNIQUE(epoch,input,key));
CREATE TABLE observations (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
  value REAL, unit TEXT NOT NULL, source_time INTEGER, received_at INTEGER NOT NULL,
  quality TEXT NOT NULL, raw TEXT, import_id INTEGER REFERENCES imports(id), row_number INTEGER
);
CREATE TABLE provider_snapshot_contents (
 id INTEGER PRIMARY KEY, digest TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE TABLE provider_snapshot_fetches (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
 issued_at INTEGER, fetched_at INTEGER NOT NULL, digest TEXT NOT NULL,
 content_id INTEGER NOT NULL REFERENCES provider_snapshot_contents(id), fetch_metadata TEXT NOT NULL,
 UNIQUE(kind,source,fetched_at,digest));
CREATE TABLE recorder_coverage (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, device TEXT NOT NULL, signal TEXT NOT NULL,
 status TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
 source_time INTEGER, observation_id INTEGER REFERENCES observations(id), samples INTEGER NOT NULL);
CREATE TABLE recorder_metrics (
 key TEXT NOT NULL,bucket INTEGER NOT NULL,polls INTEGER NOT NULL,records INTEGER NOT NULL,
 first_saved_at INTEGER,last_saved_at INTEGER,
 bytes INTEGER NOT NULL,error_squared_time REAL NOT NULL,error_time REAL NOT NULL,
 stale INTEGER NOT NULL,failed INTEGER NOT NULL,unavailable INTEGER NOT NULL,
 PRIMARY KEY(key,bucket)) WITHOUT ROWID;
CREATE TABLE recovery_provenance (donor_digest TEXT NOT NULL, table_name TEXT NOT NULL,
            donor_id TEXT NOT NULL, target_id TEXT, disposition TEXT NOT NULL,
            PRIMARY KEY(donor_digest,table_name,donor_id)) WITHOUT ROWID;
CREATE TABLE recovery_runs (id TEXT PRIMARY KEY, input TEXT NOT NULL, donor_digest TEXT NOT NULL,
            previous_epoch TEXT NOT NULL, epoch TEXT NOT NULL, status TEXT NOT NULL,
            started_at INTEGER NOT NULL, completed_at INTEGER, report TEXT,
            previous_fireplace_revision INTEGER, source_head INTEGER, fireplace_revision INTEGER);
CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX annotations_time ON annotations(start_at, end_at);
CREATE INDEX charging_reports_history ON charging_reports(namespace,charger_id,started_at DESC,report_id DESC);
CREATE INDEX charging_reports_expiry ON charging_reports(namespace,ended_at) WHERE saved_at IS NULL AND ended_at IS NOT NULL;
CREATE INDEX charging_report_events_report ON charging_report_events(namespace,charger_id,report_id,id DESC);
CREATE INDEX charging_report_events_category ON charging_report_events(namespace,charger_id,report_id,category,id DESC);
CREATE INDEX energy_audits_device_time ON energy_audits(device,source_time,id);
CREATE INDEX events_type_time ON events(type,at,id);
CREATE INDEX fireplace_events_input_time ON fireplace_events(input,at,id);
CREATE INDEX learning_cycles_input_at ON learning_cycles(input, started_at);
CREATE INDEX learning_entries_algorithm
          ON learning_journal_entries(epoch,input,algorithm_version,id);
CREATE INDEX learning_entries_epoch_input ON learning_journal_entries(epoch,input,id);
CREATE INDEX learning_entries_time ON learning_journal_entries(epoch,input,kind,at,id);
CREATE INDEX observations_easee_acquisition ON observations(device, received_at, id)
WHERE source='easee' AND import_id IS NULL;
CREATE INDEX observations_recovery_energy ON observations(device,signal,
            CASE WHEN json_valid(raw) THEN json_extract(raw,'$.intervalEnd') END);
CREATE INDEX observations_signal_id ON observations(signal, id);
CREATE INDEX observations_signal_time ON observations(signal, source_time, id);
CREATE INDEX observations_energy_geometry ON observations(
  json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.intervalStart'),
  source_time,source,device,CASE WHEN signal LIKE 'ev1_%' THEN 'ev1'
    WHEN signal LIKE 'ev2_energy_l%' THEN 'ev2'
    WHEN signal='caravan_energy' THEN 'caravan' ELSE 'property' END,id)
  WHERE signal IN ('property_energy_l1','property_energy_l2','property_energy_l3','ev1_energy_l1','ev1_energy_l2','ev1_energy_l3','ev2_energy_l1','ev2_energy_l2','ev2_energy_l3','caravan_energy') AND import_id IS NULL;
CREATE INDEX observations_time ON observations(source_time, id);
CREATE INDEX observations_receipt ON observations(received_at);
CREATE INDEX observations_stream_receipt ON observations(source,device,signal,unit,
  json_extract(CASE WHEN json_valid(raw) THEN raw ELSE '{}' END,'$.recorder.policy'),received_at,import_id);
CREATE INDEX recorder_coverage_outages ON recorder_coverage(start_at,id) WHERE status<>'fresh';
CREATE INDEX recorder_coverage_signal_time ON recorder_coverage(signal,end_at,id);
CREATE INDEX recorder_coverage_stream ON recorder_coverage(source,device,signal,id);
CREATE INDEX recorder_metrics_bucket ON recorder_metrics(bucket);
CREATE INDEX recovery_provenance_target ON recovery_provenance(table_name,target_id);
CREATE INDEX snapshots_content_fetch ON provider_snapshot_fetches(content_id,kind,source,fetched_at);
CREATE INDEX snapshots_kind_time ON "provider_snapshot_fetches"(kind, fetched_at, id);
CREATE VIEW learning_journal AS SELECT id,input,key,kind,at,algorithm_version,
            config_version,forecast_version,payload FROM learning_journal_all e
            WHERE epoch=COALESCE((SELECT epoch FROM learning_epochs WHERE input=e.input),'original');
CREATE VIEW learning_journal_all AS SELECT e.id,e.epoch,e.input,e.key,e.kind,e.at,e.algorithm_version,
            COALESCE(e.config_version,s.config_version) AS config_version,
            COALESCE(e.forecast_version,s.forecast_version) AS forecast_version,
            COALESCE(e.payload,s.payload) AS payload,e.source_entry_id
            FROM learning_journal_entries e LEFT JOIN learning_journal_entries s ON s.id=e.source_entry_id;
CREATE VIEW provider_snapshots AS SELECT f.id,f.kind,f.source,f.issued_at,f.fetched_at,
 c.payload AS payload,f.digest FROM provider_snapshot_fetches f
 JOIN provider_snapshot_contents c ON c.id=f.content_id;
`;
