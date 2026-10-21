import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const verificationWorkPath = directory => join(directory, 'temporary-verification.sqlite');
const schema = `CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE checkpoints(slot INTEGER PRIMARY KEY CHECK(slot IN (0,1)),cursor INTEGER NOT NULL,serial INTEGER NOT NULL,body BLOB NOT NULL,digest TEXT NOT NULL);
CREATE TABLE reference_models(input TEXT PRIMARY KEY,body BLOB NOT NULL,digest TEXT NOT NULL);`;
const invalid = () => Object.assign(new Error('Disposable verification progress is unusable. Discard it before starting another verification.'),
  { code: 'model_reconstruction_invalid' });
const hash = value => createHash('sha256').update(value).digest('hex');
const expected = (() => {
  const db = new DatabaseSync(':memory:');
  try { db.exec(schema); return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()); }
  finally { db.close(); }
})();

/** This database owns no household history. Only independently computed
 * verification progress, fixed comparison references and local results live
 * here. A comparison reference is never a replay seed or progress checkpoint. */
export class ModelVerificationWork {
  constructor({ path, readOnly = false }) {
    this.path = path;
    let db;
    try {
      const present = existsSync(path) && statSync(path).size > 0;
      if (!readOnly) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      db = this.db = new DatabaseSync(path, { readOnly });
      db.exec('PRAGMA busy_timeout=1000');
      if (present) {
        if (db.prepare('PRAGMA user_version').get().user_version !== 1
          || JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()) !== expected) throw invalid();
      } else {
        if (readOnly) throw invalid();
        db.exec(`BEGIN;${schema}PRAGMA user_version=1;COMMIT;`);
      }
      if (!readOnly) {
        chmodSync(path, 0o600);
        db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL');
        writeFileSync(join(dirname(path), 'README.txt'),
          'DISPOSABLE MODEL VERIFICATION DATA\n\nStop verification before deleting this directory. Deletion loses only local verification progress and results. Observations, the learning journal, the model and coefficient chart history are stored in the main database and are unaffected.\nThis directory is not an essential history backup.\n', { mode: 0o600 });
      }
    } catch (error) { db?.close(); throw invalid(); }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key) {
    try { const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
    catch { throw invalid(); }
  }
  set(key, value) { this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  start(job, references = []) {
    const rows = references.map(({ input, checkpoint }) => {
      const text = JSON.stringify(checkpoint);
      return { input, bytes: gzipSync(text, { level: 1 }), digest: hash(text) };
    });
    this.transaction(() => {
      this.db.exec('DELETE FROM checkpoints;DELETE FROM reference_models');
      for (const row of rows) this.db.prepare('INSERT INTO reference_models VALUES(?,?,?)').run(row.input, row.bytes, row.digest);
      this.set('job', job);
    });
  }
  reference(input) {
    try {
      const row = this.db.prepare('SELECT body,digest FROM reference_models WHERE input=?').get(input);
      if (!row) throw invalid();
      const text = gunzipSync(row.body, { maxOutputLength: 512 * 1024 * 1024 }).toString();
      if (hash(text) !== row.digest) throw invalid();
      return JSON.parse(text);
    } catch { throw invalid(); }
  }
  save(progress) {
    const text = JSON.stringify(progress), bytes = gzipSync(text, { level: 1 });
    this.transaction(() => {
      const serial = (this.get('serial') ?? 0) + 1;
      this.db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET cursor=excluded.cursor,serial=excluded.serial,body=excluded.body,digest=excluded.digest')
        .run(serial % 2, progress.state.cursor, serial, bytes, hash(text));
      this.set('serial', serial);
    });
  }
  progress() {
    let damaged = false;
    for (const row of this.db.prepare('SELECT * FROM checkpoints ORDER BY serial DESC').all()) {
      try {
        const text = gunzipSync(row.body, { maxOutputLength: 512 * 1024 * 1024 }).toString();
        if (hash(text) !== row.digest) throw invalid();
        const value = JSON.parse(text);
        if (!value?.state || value.state.cursor !== row.cursor) throw invalid();
        return value;
      } catch { damaged = true; }
    }
    if (damaged) throw invalid();
    return null;
  }
  bytes() { return ['', '-journal'].reduce((total, suffix) => { try { return total + statSync(this.path + suffix).size; } catch { return total; } }, 0); }
  close() { this.db.close(); }
}
