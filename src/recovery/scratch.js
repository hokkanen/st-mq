import { randomUUID } from 'node:crypto';

export function initializeScratch(db) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS recovery_scratch_map(namespace TEXT,key TEXT,value TEXT NOT NULL,PRIMARY KEY(namespace,key)) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS recovery_scratch_list(namespace TEXT,position INTEGER,value TEXT NOT NULL,PRIMARY KEY(namespace,position)) WITHOUT ROWID;`);
}

// Recovery's source IDs and accepted journal payloads can outgrow the model
// itself. Keep them in SQLite's disposable TEMP storage instead of JS heaps.
// Initialization is lazy: read-only conflict checks never need a scratch map.
export class ScratchMap {
  constructor(db, name = 'map') { this.db = db; this.namespace = `${name}:${randomUUID()}`; this.ready = false; }
  initialize() {
    if (this.ready) return;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS recovery_scratch_map(namespace TEXT,key TEXT,value TEXT NOT NULL,PRIMARY KEY(namespace,key)) WITHOUT ROWID');
    this.ready = true;
  }
  set(key, value) {
    this.initialize();
    this.db.prepare(`INSERT INTO recovery_scratch_map(namespace,key,value) VALUES(?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`).run(this.namespace, JSON.stringify(key), JSON.stringify(value));
    return this;
  }
  get(key) {
    if (!this.ready || key === undefined) return undefined;
    const row = this.db.prepare('SELECT value FROM recovery_scratch_map WHERE namespace=? AND key=?').get(this.namespace, JSON.stringify(key));
    return row ? JSON.parse(row.value) : undefined;
  }
  has(key) { return this.get(key) !== undefined; }
  delete(key) {
    return key !== undefined && this.ready && this.db.prepare('DELETE FROM recovery_scratch_map WHERE namespace=? AND key=?').run(this.namespace, JSON.stringify(key)).changes > 0;
  }
  get size() { return this.ready ? this.db.prepare('SELECT COUNT(*) n FROM recovery_scratch_map WHERE namespace=?').get(this.namespace).n : 0; }
  *entries() {
    if (!this.ready) return;
    let after = '';
    for (;;) {
      // An open TEMP iterator can keep the connection's implicit transaction
      // alive when its caller also reads MAIN. Close each bounded page before
      // yielding, so later writes can start against a fresh live snapshot.
      const rows = this.db.prepare('SELECT key,value FROM recovery_scratch_map WHERE namespace=? AND key>? ORDER BY key LIMIT 64')
        .all(this.namespace, after);
      if (!rows.length) return;
      for (const row of rows) { after = row.key; yield [JSON.parse(row.key), JSON.parse(row.value)]; }
    }
  }
  *keys() { for (const [key] of this.entries()) yield key; }
  *values() { for (const [, value] of this.entries()) yield value; }
  [Symbol.iterator]() { return this.entries(); }
}

export class ScratchList {
  constructor(db, name = 'list') { this.db = db; this.namespace = `${name}:${randomUUID()}`; this.length = 0; }
  push(value) {
    if (!this.length) this.db.exec('CREATE TEMP TABLE IF NOT EXISTS recovery_scratch_list(namespace TEXT,position INTEGER,value TEXT NOT NULL,PRIMARY KEY(namespace,position)) WITHOUT ROWID');
    this.db.prepare('INSERT INTO recovery_scratch_list(namespace,position,value) VALUES(?,?,?)')
      .run(this.namespace, this.length, JSON.stringify(value));
    return ++this.length;
  }
  *[Symbol.iterator]() {
    if (!this.length) return;
    let after = -1;
    for (;;) {
      const rows = this.db.prepare('SELECT position,value FROM recovery_scratch_list WHERE namespace=? AND position>? ORDER BY position LIMIT 64')
        .all(this.namespace, after);
      if (!rows.length) return;
      for (const row of rows) { after = row.position; yield JSON.parse(row.value); }
    }
  }
}
