import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateCurrentDatabase, validateCurrentDatabaseFormat, validateWalHeader } from './store.js';
import { readCheckpoint, verifyJournal } from './journal.js';
import { databaseErrorDetails } from './database-errors.js';
import { FULL_VERIFICATION_ALGORITHM } from './full-verifier.js';
import { snapshotDigest } from '../replication/publication.js';

const fail = code => Object.assign(new Error(code), { code });
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const sameCheckpoint = (a, b) => a?.databaseId === b?.databaseId && a?.sequence === b?.sequence && a?.hash === b?.hash;
let progressAt = 0;
function progress(value, force = false) {
  if (force || Date.now() - progressAt >= 100) {
    parentPort.postMessage({ type: 'progress', progress: value }); progressAt = Date.now();
  }
}
function pin(path) {
  validateWalHeader(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    validateCurrentDatabaseFormat(db);
    const checkpoint = readCheckpoint(db);
    return { db, checkpoint };
  } catch (error) { db.close(); throw error; }
}
function canonicalValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['integer', String(value)];
  if (typeof value === 'number') {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    return ['real', bytes.toString('hex')];
  }
  if (typeof value === 'string') return ['text', value];
  return ['blob', Buffer.from(value).toString('base64')];
}
function verify({ db, checkpoint }) {
  progress({ phase: 'checking-contracts', processed: 0, checkpoint }, true);
  validateCurrentDatabase(db, { full: true });
  progress({ phase: 'checking-journal', processed: 0, checkpoint }, true);
  const journal = verifyJournal(db);
  progress({ phase: 'checking-integrity', processed: 0, checkpoint }, true);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
    throw fail('database_integrity_failed');
  const hash = createHash('sha256');
  const add = value => { const text = JSON.stringify(value); hash.update(String(Buffer.byteLength(text))); hash.update(':'); hash.update(text); };
  add(FULL_VERIFICATION_ALGORITHM);
  add(db.prepare('PRAGMA user_version').get().user_version);
  // AUTOINCREMENT high-water marks may remain ahead after retaining a divergent
  // branch. They prevent identifier reuse, but do not change active content.
  const tables = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'journal_*' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
  let rows = 0;
  for (const { name, sql } of tables) {
    if (/\bAUTOINCREMENT\b/i.test(sql)) {
      const sequenceQuery = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?'); sequenceQuery.setReadBigInts(true);
      const maximumQuery = db.prepare(`SELECT MAX(id) AS id FROM ${identifier(name)}`); maximumQuery.setReadBigInts(true);
      const sequence = sequenceQuery.get(name)?.seq ?? 0n;
      const maximum = maximumQuery.get().id ?? 0n;
      if (sequence < maximum) throw fail('database_integrity_failed');
    }
    add([name, sql]);
    const columns = db.prepare(`PRAGMA table_info(${identifier(name)})`).all();
    const names = columns.map(column => identifier(column.name));
    const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => identifier(column.name));
    const ordered = keys.length ? keys : names;
    const statement = db.prepare(`SELECT ${names.join(',')} FROM ${identifier(name)}${name === 'state' ? " WHERE key<>'backup:metadata'" : ''} ORDER BY ${ordered.map(key => `${key} COLLATE BINARY`).join(',')}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      add(columns.map(column => canonicalValue(row[column.name]))); rows++;
      if (rows % 256 === 0) progress({ phase: 'checking', processed: rows, unit: 'records', checkpoint });
    }
  }
  return { checkpoint, digest: hash.digest('hex'), algorithm: FULL_VERIFICATION_ALGORITHM, rows,
    journal: { baseSequence: journal.base.sequence, transactions: journal.commits,
      archivedBranches: journal.branches,
      archivedPeerRows: journal.archivedPeerRows }, verifiedAt: Date.now() };
}

let left, right;
try {
  left = pin(workerData.dbPath);
  if (workerData.checkpoint && !sameCheckpoint(left.checkpoint, workerData.checkpoint)) throw fail('full_verification_checkpoint_mismatch');
  if (workerData.rightPath) {
    right = pin(workerData.rightPath);
    if (!sameCheckpoint(left.checkpoint, right.checkpoint)) throw fail('full_verification_checkpoint_mismatch');
  }
  progress({ phase: 'validating', processed: 0, checkpoint: left.checkpoint }, true);
  const result = verify(left);
  if (right && verify(right).digest !== result.digest) throw fail('full_verification_content_mismatch');
  if (workerData.snapshot) {
    progress({ phase: 'checking-transfer', processed: 0, checkpoint: result.checkpoint }, true);
    const actual = await snapshotDigest(workerData.dbPath);
    if (actual.digest !== workerData.snapshot.digest || actual.bytes !== workerData.snapshot.bytes)
      throw fail('full_verification_transport_mismatch');
  }
  progress({ phase: 'checking', processed: result.rows, total: result.rows, unit: 'records', checkpoint: result.checkpoint }, true);
  parentPort.postMessage({ ok: true, result: { ...result, comparison: Boolean(right) } });
} catch (error) {
  const details = databaseErrorDetails(error);
  const code = details?.code ?? (/^(?:journal_|database_journal_)/.test(String(error?.code ?? '')) ? 'database_integrity_failed'
    : ['full_verification_checkpoint_mismatch', 'full_verification_content_mismatch', 'full_verification_transport_mismatch'].includes(error?.code)
    ? error.code : 'full_verification_failed');
  parentPort.postMessage({ ok: false, code, ...(details ? { details } : {}) });
} finally {
  for (const source of [right, left]) if (source) { try { source.db.exec('ROLLBACK'); } finally { source.db.close(); } }
}
