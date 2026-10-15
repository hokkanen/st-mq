const pending = () => Object.assign(new Error('A save is still settling. Submit changes through writer admission.'),
  { code: 'STORAGE_WRITE_PENDING' });
const connections = new WeakSet();
export const isWriterDatabase = db => connections.has(db);

/** Dependent statements in a synchronous callback use the reserved writer.
 * Other readers see only committed WAL state through their own connection. */
export function writerDatabase(store, reader, writer) {
  let synchronousTransaction = false;
  const writing = () => store.writerBodyActive || synchronousTransaction;
  const writable = () => {
    if (store.writerFailed) throw Object.assign(new Error('The storage writer is unavailable.'), { code: 'STORAGE_WRITER_FAILED' });
    if (store.writePending && !store.writerBodyActive) throw pending();
  };
  const database = {
    get isTransaction() { return writing() || reader.isTransaction; },
    get isOpen() { return reader.isOpen; },
    prepare(sql) {
      const settings = {};
      let local;
      const statement = {};
      for (const method of ['get', 'all', 'run', 'iterate', 'columns']) statement[method] = (...params) => {
        if (writing() || method === 'run') {
          writable();
          const result = writer.call('statement', { sql, method, params, settings });
          return method === 'iterate' ? result[Symbol.iterator]() : result;
        }
        local ??= reader.prepare(sql);
        for (const [key, value] of Object.entries(settings)) local[key](value);
        return local[method](...params);
      };
      for (const name of ['setReadBigInts', 'setAllowBareNamedParameters', 'setAllowUnknownNamedParameters', 'setReturnArrays']) {
        statement[name] = value => { settings[name] = value; return statement; };
      }
      return statement;
    },
    exec(sql) {
      const normalized = sql.trim().replace(/;$/, '').trim().toUpperCase();
      // Read snapshots have their own connection and cannot expose a pending
      // writer's rows or accidentally finish its transaction.
      if (!writing() && (normalized === 'BEGIN' || normalized === 'BEGIN DEFERRED'
        || reader.isTransaction && ['COMMIT', 'ROLLBACK', 'END'].includes(normalized))) return reader.exec(sql);
      writable();
      const result = writer.call('exec', { sql });
      if (normalized === 'BEGIN IMMEDIATE') synchronousTransaction = true;
      if (['COMMIT', 'ROLLBACK', 'END'].includes(normalized)) synchronousTransaction = false;
      return result;
    },
  };
  connections.add(database);
  return database;
}
