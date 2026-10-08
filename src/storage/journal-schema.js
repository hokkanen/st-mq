import { DatabaseSync } from 'node:sqlite';

export const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`;
export const journalTextNulExpression = (columns, alias) => columns.map(column => {
  const value = `${alias ? `${quoteIdentifier(alias)}.` : ''}${quoteIdentifier(column)}`;
  return `(typeof(${value})='text' AND instr(${value},char(0))>0)`;
}).join(' OR ');
/** Build the capture contract from the one current schema, never a live database. */
export function journalSchema(dataSchema) {
  const reference = new DatabaseSync(':memory:');
  let tables;
  try {
    reference.exec(dataSchema);
    tables = reference.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name<>'recovery_dependencies' ORDER BY name").all()
      .map(({ name }) => {
        const columns = reference.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all();
        return { name, columns: columns.map(c => c.name),
          keys: columns.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name) };
      });
  } finally { reference.close(); }
  if (tables.some(table => !table.keys.length)) throw new Error('Journal tables require explicit primary keys');
  // Older supported SQLite builds permit 127 UDF arguments. Leave a fixed
  // operation/table/validity prefix plus both typed rows within that bound.
  if (tables.some(table => 3 + 2 * table.columns.length > 127)) throw new Error('Journal table exceeds the typed capture argument limit');
  const structure = `
CREATE TABLE journal_meta(id INTEGER PRIMARY KEY CHECK(id=1),database_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,hash TEXT NOT NULL,genesis_hash TEXT NOT NULL,algorithm_version TEXT NOT NULL,
 base_sequence INTEGER NOT NULL,base_hash TEXT NOT NULL,content_hash TEXT NOT NULL,base_content_hash TEXT NOT NULL,
 retained_bytes INTEGER NOT NULL,retained_commits INTEGER NOT NULL);
CREATE TABLE journal_commits(sequence INTEGER PRIMARY KEY,previous_hash TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,
 at INTEGER NOT NULL,change_count INTEGER NOT NULL,bytes INTEGER NOT NULL,content_hash TEXT NOT NULL);
CREATE TABLE journal_changes(sequence INTEGER NOT NULL REFERENCES journal_commits(sequence) DEFERRABLE INITIALLY DEFERRED,
 ordinal INTEGER NOT NULL,table_name TEXT NOT NULL,record_key TEXT NOT NULL,payload TEXT NOT NULL,
 PRIMARY KEY(sequence,ordinal));
CREATE INDEX journal_changes_record ON journal_changes(table_name,record_key,sequence);
CREATE TABLE journal_pending(ordinal INTEGER PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE journal_peer(id INTEGER PRIMARY KEY CHECK(id=1),anchor TEXT NOT NULL,content_hash TEXT NOT NULL,
 pending TEXT,rebase_cursor INTEGER,completed_source TEXT);
CREATE TABLE journal_peer_changes(table_name TEXT NOT NULL,record_key TEXT NOT NULL,before_hash TEXT,
 after_hash TEXT,last_sequence INTEGER NOT NULL,PRIMARY KEY(table_name,record_key)) WITHOUT ROWID;
CREATE TABLE journal_peer_before(table_name TEXT NOT NULL,record_key TEXT NOT NULL,row TEXT,
 PRIMARY KEY(table_name,record_key),FOREIGN KEY(table_name,record_key) REFERENCES journal_peer_changes(table_name,record_key) ON DELETE CASCADE) WITHOUT ROWID;
CREATE TABLE journal_peer_branches(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL,
 base_content_hash TEXT NOT NULL,content_hash TEXT NOT NULL,rows INTEGER NOT NULL,digest TEXT NOT NULL);
CREATE TABLE journal_peer_branch_rows(branch_id TEXT NOT NULL REFERENCES journal_peer_branches(id),ordinal INTEGER NOT NULL,
 table_name TEXT NOT NULL,record_key TEXT NOT NULL,before_row TEXT,after_row TEXT,
 PRIMARY KEY(branch_id,ordinal)) WITHOUT ROWID;
`;
  const capture = tables.flatMap(table => ['INSERT','UPDATE','DELETE'].map(operation => {
    const row = alias => table.columns.map(column => `${alias}.${quoteIdentifier(column)}`).join(',');
    const values = operation === 'INSERT' ? row('NEW') : operation === 'DELETE' ? row('OLD') : `${row('OLD')},${row('NEW')}`;
    // Node 22's SQLite TEXT reader/UDF truncates at an embedded NUL. Detect it
    // inside SQLite so unsupported bytes cannot acquire a truncated fingerprint.
    const aliases = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'INSERT' ? 'NEW' : 'OLD'];
    const hasNul = aliases.map(alias => `(${journalTextNulExpression(table.columns, alias)})`).join(' OR ');
    const alias = operation === 'DELETE' ? 'OLD' : 'NEW';
    const conditions = ['journal_capture_enabled()',...(table.name === 'state' ? [`${alias}.key IS NOT 'backup:metadata'`] : [])];
    if (operation === 'UPDATE') conditions.push(`(${table.columns.map(column => `OLD.${quoteIdentifier(column)} IS NOT NEW.${quoteIdentifier(column)}`).join(' OR ')})`);
    const condition = conditions.length ? ` WHEN ${conditions.join(' AND ')}` : '';
    return `CREATE TRIGGER journal_${table.name}_${operation.toLowerCase()} AFTER ${operation} ON ${quoteIdentifier(table.name)}${condition}
 BEGIN INSERT INTO journal_pending(payload) VALUES(journal_capture('${table.name}','${operation}',${hasNul},${values})); END;`;
  })).join('\n');
  return { tables, sql: structure + capture };
}
