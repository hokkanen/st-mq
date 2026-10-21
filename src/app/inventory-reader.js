import { databaseOverviewQueries } from './database-overview.js';

const quote = value => `"${value.replaceAll('"', '""')}"`;
const sqliteOrder = (a, b) => a === b ? 0 : a == null ? -1 : b == null ? 1
  : typeof a === 'number' && typeof b === 'number' ? a < b ? -1 : 1
    : typeof a === 'number' ? -1 : typeof b === 'number' ? 1
      : Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
const checkMetadataSize = size => {
  if (size > 50_000) throw Object.assign(new Error('Inventory metadata limit exceeded.'), { code: 'INVENTORY_TOO_COMPLEX' });
};

// This parser handles the inventory's own small SELECT statements, never user
// SQL. Keeping aggregation in the shared assembler gives the paged reader and
// direct offline oracle one set of definitions and selection rules.
function selectParts(sql) {
  let depth = 0, string = null, from = -1;
  const columns = []; let start = sql.search(/SELECT\s+/i) + 7;
  for (let i = start; i < sql.length; i++) {
    const c = sql[i];
    if (string) { if (c === string && sql[i + 1] === string) i++; else if (c === string) string = null; continue; }
    if (c === "'" || c === '"') { string = c; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (!depth && c === ',') { columns.push(sql.slice(start, i).trim()); start = i + 1; }
    if (!depth && /^\sFROM\s/i.test(sql.slice(i))) { from = i; columns.push(sql.slice(start, i).trim()); break; }
  }
  if (from < 0) return null;
  const source = /^\sFROM\s+(?:"((?:[^"]|"")+)"|([a-z_]+))(?=\s|$)(?:\s+(?!(?:WHERE|GROUP|ORDER|LEFT|JOIN|INNER|RIGHT|CROSS|LIMIT)\b)([a-z_]+))?/i.exec(sql.slice(from));
  if (!source) return null;
  const table = source[1]?.replaceAll('""', '"') ?? source[2];
  const fields = columns.map(column => {
    const aggregate = /^(COUNT|SUM|MIN|MAX)\s*\(/i.exec(column)?.[1]?.toLowerCase();
    const name = /\s+(?:AS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(column)?.[1] ?? column.split('.').at(-1);
    return { aggregate, name };
  });
  return { table, alias: source[3] ?? table, fields,
    replace: replacement => sql.slice(0, from) + ` FROM ${replacement} ${source[3] ?? quote(table)}` + sql.slice(from + source[0].length) };
}

/** A job holds one read-only SQLite snapshot, but native history work is
 * keyset-paged. Only grouped metadata remains in memory; source payloads never
 * accumulate. Each page releases storage admission before the next page. */
export function readDatabaseInventory({ store, now, batchRows = 128, step = fn => fn(), release = () => {},
  checkCancelled = () => {}, onProgress = () => {} }) {
  const db = store.db, definitions = new Map(); let processed = 0, stage = 'catalogue';
  const run = (sql, params = [], mode = 'all') => step(() => db.prepare(sql)[mode](...params));
  const progress = (count = 0) => { processed += count; checkCancelled(); onProgress({ stage, processed }); release(); };
  function* batches(table) {
    const source = table === 'learning_journal' ? 'learning_journal_entries' : table;
    let keys = definitions.get(source);
    if (!keys) {
      const columns = run(`PRAGMA table_info(${quote(source)})`);
      const withoutRowid = /WITHOUT\s+ROWID/i.test(run('SELECT sql FROM sqlite_schema WHERE name=?', [source], 'get')?.sql ?? '');
      keys = withoutRowid ? columns.filter(row => row.pk).sort((a,b) => a.pk-b.pk).map(row => row.name) : ['_rowid_'];
      definitions.set(source, keys);
    }
    if (!keys.length) throw new Error('Inventory source has no bounded key.');
    // Views use their underlying journal entry ID, not SQLite's absent view rowid.
    const sourceKeys = table === 'learning_journal' ? ['id'] : keys;
    const expression = sourceKeys.length === 1 ? quote(sourceKeys[0]) : `(${sourceKeys.map(quote).join(',')})`;
    const placeholders = sourceKeys.length === 1 ? '?' : `(${sourceKeys.map(() => '?').join(',')})`;
    let after = null;
    while (true) {
      checkCancelled();
      const rows = run(`SELECT ${sourceKeys.map((key, i) => `${quote(key)} AS k${i}`).join(',')} FROM ${quote(source)}
        ${after ? `WHERE ${expression}>${placeholders}` : ''} ORDER BY ${sourceKeys.map(quote).join(',')} LIMIT ?`, [...(after ?? []), batchRows]);
      release();
      if (!rows.length) break;
      const through = sourceKeys.map((_, i) => rows.at(-1)[`k${i}`]);
      const where = `${after ? `${expression}>${placeholders} AND ` : ''}${expression}<=${placeholders}`;
      yield { where, params: [...(after ?? []), ...through], rows: rows.length };
      after = through;
    }
  }
  const merge = (target, row, fields) => {
    for (const { aggregate, name } of fields) {
      const value = row[name];
      if (!aggregate) { target[name] = value; continue; }
      if (aggregate === 'count' || aggregate === 'sum') target[name] = value == null ? target[name] ?? null : (target[name] ?? 0) + value;
      else if (value != null) {
        const previous = target[name];
        // SQLite orders numeric values before TEXT and compares TEXT without
        // numeric coercion. Preserve a malformed retained value's original
        // interpretation instead of turning a string timestamp into NaN.
        const order = sqliteOrder(value, previous);
        if (previous == null || (aggregate === 'min' ? order < 0 : order > 0)) target[name] = value;
      }
      else target[name] ??= null;
    }
  };
  function paged(request, sql = request.sql) {
    if (/\b(?:COUNT|SUM|MIN|MAX)\s*\(\s*DISTINCT/i.test(sql))
      throw new Error('Distinct inventory aggregation requires an explicit bounded plan.');
    const parsed = selectParts(sql);
    if (!parsed) throw new Error('Inventory query has no bounded source.');
    stage = parsed.table; progress();
    const aggregates = parsed.fields.some(field => field.aggregate), results = new Map(), output = [];
    const keys = parsed.fields.filter(field => !field.aggregate).map(field => field.name);
    for (const batch of batches(parsed.table)) {
      // LIMIT -1 prevents SQLite from flattening the source and choosing an
      // all-history grouping index scan instead of the bounded primary-key seek.
      const rows = run(parsed.replace(`(SELECT * FROM ${quote(parsed.table)} WHERE ${batch.where} LIMIT -1)`), [...batch.params, ...request.params]);
      if (aggregates) for (const row of rows) {
        const key = JSON.stringify(keys.map(name => row[name]));
        if (!results.has(key)) { results.set(key, {}); checkMetadataSize(results.size); }
        merge(results.get(key), row, parsed.fields);
      } else { output.push(...rows); checkMetadataSize(output.length); }
      progress(batch.rows);
    }
    let rows = aggregates ? [...results.values()] : output;
    if (!rows.length && request.mode === 'get') rows = run(parsed.replace(`(SELECT * FROM ${quote(parsed.table)} WHERE 0)`), request.params);
    if (aggregates && keys.length) rows.sort((a,b) => {
      for (const key of keys) { const order = sqliteOrder(a[key], b[key]); if (order) return order; }
      return 0;
    });
    if (/ORDER BY type\s*$/i.test(sql)) rows.sort((a,b) => a.type < b.type ? -1 : a.type > b.type ? 1 : 0);
    if (/ORDER BY key\s*$/i.test(sql)) rows.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return request.mode === 'get' ? rows[0] : rows;
  }
  function execute(request) {
    const { sql, params, mode } = request;
    checkCancelled();
    if (/^PRAGMA /i.test(sql) || sql.includes('FROM sqlite_schema') || /^SELECT base_sequence,/.test(sql)) {
      const result = run(sql, params, mode); progress(); return result;
    }
    if (sql.includes('FROM dbstat')) {
      stage = 'allocation'; progress();
      const types = new Map(run('SELECT name,type FROM sqlite_schema').map(row => [row.name, row.type]));
      const cursor = step(() => db.prepare('SELECT name,pgsize FROM dbstat').iterate()), objects = new Map();
      let done = false;
      try {
        while (!done) {
          let count = 0;
          step(() => {
            const started = performance.now();
            while (count < batchRows && performance.now() - started < 8) {
              const next = cursor.next(); if (next.done) { done = true; break; }
              const { name, pgsize } = next.value;
              const entry = objects.get(name) ?? { name, type: types.get(name) ?? null, bytes: 0 };
              entry.bytes += pgsize; objects.set(name, entry); count++;
            }
          });
          progress(count);
        }
      } finally { if (!done) step(() => cursor.return?.()); release(); }
      return [...objects.values()];
    }
    if (sql.includes('COUNT(DISTINCT c.id)')) {
      const count = paged({ sql: 'SELECT COUNT(*) count FROM provider_snapshot_contents', params: [], mode: 'get' }).count;
      const dates = paged({ sql: `SELECT MIN(f.fetched_at) firstAt,MAX(f.fetched_at) lastAt FROM provider_snapshot_fetches f
        JOIN provider_snapshot_contents c ON c.id=f.content_id`, params: [], mode: 'get' });
      return { count, ...dates };
    }
    if (sql.includes('COUNT(DISTINCT content_id)')) {
      const rows = paged(request, sql.replace('COUNT(DISTINCT content_id) versions,', ''));
      const values = new Map(rows.map(row => [row.category, { ...row, versions: 0 }]));
      stage = 'provider-content'; progress();
      for (const batch of batches('provider_snapshot_contents')) {
        const rows = run(`SELECT c.id,
          EXISTS(SELECT 1 FROM provider_snapshot_fetches f WHERE f.content_id=c.id AND f.kind='weather') weather,
          EXISTS(SELECT 1 FROM provider_snapshot_fetches f WHERE f.content_id=c.id AND f.kind='market') market,
          EXISTS(SELECT 1 FROM provider_snapshot_fetches f WHERE f.content_id=c.id AND f.kind NOT IN ('weather','market')) other
          FROM (SELECT * FROM provider_snapshot_contents WHERE ${batch.where}) c`, batch.params);
        for (const row of rows) for (const kind of ['weather','market','other']) if (row[kind]) values.get(kind).versions++;
        progress(batch.rows);
      }
      return [...values.values()];
    }
    if (sql.includes('FROM fireplace_events loads JOIN')) {
      // Corrections are compact references. Resolve each target by its primary
      // key; do not rerun an all-history grouped subquery for every load batch.
      stage = 'fireplace-corrections'; progress();
      const targets = new Set();
      for (const batch of batches('fireplace_events')) {
        const rows = run(`SELECT DISTINCT loads.id FROM (SELECT * FROM fireplace_events WHERE ${batch.where}) corrections
          JOIN fireplace_events loads ON loads.id=corrections.target_id AND loads.input=corrections.input
          WHERE corrections.kind='remove' AND loads.kind='load'`, batch.params);
        for (const row of rows) targets.add(row.id);
        checkMetadataSize(targets.size);
        progress(batch.rows);
      }
      return { count: targets.size };
    }
    return paged(request);
  }
  const steps = databaseOverviewQueries({ store, now }); let next = steps.next();
  while (!next.done) {
    let result;
    try { result = execute(next.value); }
    catch (error) { next = steps.throw(error); continue; }
    next = steps.next(result);
  }
  stage = 'complete'; progress(); return next.value;
}
