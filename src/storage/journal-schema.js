import { DatabaseSync } from 'node:sqlite';

export const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
/** Build the capture contract from the one current schema, never a live database. */
export function journalSchema(dataSchema) {
  const reference = new DatabaseSync(':memory:');
  let tables;
  try {
    reference.exec(dataSchema);
    tables = reference.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>'recovery_dependencies' ORDER BY name").all()
      .map(({ name }) => {
        const columns = reference.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all();
        return { name, columns: columns.map(c => c.name), keys: columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name) };
      });
  } finally { reference.close(); }
  if (tables.some(table => !table.keys.length)) throw new Error('Journal tables require explicit primary keys');
  const structure = `
CREATE TABLE journal_meta(id INTEGER PRIMARY KEY CHECK(id=1),database_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,hash TEXT NOT NULL,genesis_hash TEXT NOT NULL,algorithm_version TEXT NOT NULL);
CREATE TABLE journal_commits(sequence INTEGER PRIMARY KEY,previous_hash TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,
 at INTEGER NOT NULL,change_count INTEGER NOT NULL,bytes INTEGER NOT NULL);
CREATE TABLE journal_changes(sequence INTEGER NOT NULL REFERENCES journal_commits(sequence) DEFERRABLE INITIALLY DEFERRED,
 ordinal INTEGER NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,before_row TEXT,after_row TEXT,
 PRIMARY KEY(sequence,ordinal)) WITHOUT ROWID;
CREATE INDEX journal_changes_record ON journal_changes(table_name,record_key,sequence);
CREATE TABLE journal_pending(ordinal INTEGER PRIMARY KEY,table_name TEXT NOT NULL,record_key TEXT NOT NULL,before_row TEXT,after_row TEXT);
CREATE TABLE journal_branches(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL);
CREATE TABLE journal_branch_commits(branch_id TEXT NOT NULL REFERENCES journal_branches(id),sequence INTEGER NOT NULL,
 payload TEXT NOT NULL,PRIMARY KEY(branch_id,sequence)) WITHOUT ROWID;
`;
  const capture = tables.flatMap(table => ['INSERT','UPDATE','DELETE'].map(operation => {
    const row = alias => `json_object(${table.columns.map(column => `'${column}',${alias}.${quoteIdentifier(column)}`).join(',')})`;
    const before = operation === 'INSERT' ? 'NULL' : row('OLD'), after = operation === 'DELETE' ? 'NULL' : row('NEW');
    const alias = operation === 'DELETE' ? 'OLD' : 'NEW';
    const key = `json_array(${table.keys.map(column => `${alias}.${quoteIdentifier(column)}`).join(',')})`;
    const condition = table.name === 'state' ? ` WHEN ${alias}.key<>'backup:metadata'` : '';
    return `CREATE TRIGGER journal_${table.name}_${operation.toLowerCase()} AFTER ${operation} ON ${quoteIdentifier(table.name)}${condition}
 BEGIN INSERT INTO journal_pending(table_name,record_key,before_row,after_row) VALUES('${table.name}',${key},${before},${after}); END;`;
  })).join('\n');
  return { tables, sql: structure + capture };
}
