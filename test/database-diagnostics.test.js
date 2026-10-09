import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION, validateCurrentDatabase } from '../src/storage/store.js';
import { createDatabaseBackup } from '../src/storage/backup.js';
import { readBackupMetadata, validBackupMetadata } from '../src/storage/backup-metadata.js';
import { databaseErrorDetails, databaseErrorGuidance } from '../src/storage/database-errors.js';
import { createSourceSnapshot, publicReplicationError } from '../src/replication/transport.js';
import { verifySnapshot } from '../src/pairing/snapshots.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { verifyDatabase } from '../src/storage/full-verifier.js';
import { registerJournalFunctions } from '../src/storage/journal-codec.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-database-diagnostics-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'source.sqlite');
  new Store(path).close();
  return { directory, path };
}

test('unjournaled external history fails fast startup and worker validation without mutating the donor', async t => {
  const { directory, path } = fixture(t);
  const db = new DatabaseSync(path);
  registerJournalFunctions(db);
  db.prepare('INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload) VALUES(?,?,?,?,?,?,?)')
    .run('fixture-epoch', 'home', 'fixture-key', 'observation', 1000, 'unsupported-fixture-algorithm', '{}');
  db.exec('PRAGMA journal_mode=DELETE');
  db.close();
  const bytes = readFileSync(path), destination = join(directory, 'copy.sqlite');
  assert.throws(() => new Store(path), { code: 'database_journal_invalid' });
  await assert.rejects(createSourceSnapshot({ dbPath: path, destination }), { code: 'database_journal_invalid' });
  await assert.rejects(verifySnapshot(path, {}), { code: 'database_journal_invalid' });
  await assert.rejects(createDatabaseBackup({ sourcePath: path, destination }), { code: 'backup_source_invalid' });
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(existsSync(destination), false);
  assert.deepEqual(readdirSync(directory), ['source.sqlite']);
});

test('historical algorithm checks remain available through explicit full verification', async t => {
  const { path } = fixture(t);
  const source = new Store(path);
  source.db.prepare('INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload) VALUES(?,?,?,?,?,?,?)')
    .run('fixture-epoch', 'home', 'fixture-key', 'observation', 1000, LEARNING_ALGORITHM, '{}');
  source.close();
  const raw = new DatabaseSync(path);
  registerJournalFunctions(raw);
  // Simulate latent historical damage outside the writer, including damaged
  // capture evidence. Routine startup does not scan all historical algorithms.
  raw.prepare('UPDATE learning_journal_entries SET algorithm_version=?').run('unsupported-fixture-algorithm');
  raw.exec('DELETE FROM journal_pending'); raw.close();
  const before = readFileSync(path), check = new DatabaseSync(path, { readOnly: true });
  try { assert.throws(() => validateCurrentDatabase(check, { full: true }), { code: 'database_algorithm_mismatch' }); }
  finally { check.close(); }
  await assert.rejects(verifyDatabase({ dbPath: path }), { code: 'database_algorithm_mismatch' });
  assert.deepEqual(readFileSync(path), before);
});

test('unsupported learning algorithms fail admission without creating a historical record', t => {
  const { path } = fixture(t), source = new Store(path), checkpoint = source.checkpoint();
  try {
    assert.throws(() => source.db.prepare('INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload) VALUES(?,?,?,?,?,?,?)')
      .run('fixture-epoch', 'home', 'fixture-key', 'observation', 1000, 'unsupported-fixture-algorithm', '{}'),
    { code: 'database_algorithm_mismatch' });
    assert.deepEqual(source.checkpoint(), checkpoint);
    assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM learning_journal_entries').get().n, 0);
    assert.equal(source.db.prepare('SELECT COUNT(*) AS n FROM journal_pending').get().n, 0);
  } finally { source.close(); }
});

test('unreadable control state is diagnosed separately from physical corruption through workers', async t => {
  const { directory, path } = fixture(t);
  const store = new Store(path);
  store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('executor:home', '{private fixture', 1000);
  store.close();
  const before = readFileSync(path);
  await assert.rejects(createSourceSnapshot({ dbPath: path, destination: join(directory, 'copy.sqlite') }), { code: 'database_state_incompatible' });
  await assert.rejects(verifySnapshot(path, {}), { code: 'database_state_incompatible' });
  assert.deepEqual(readFileSync(path), before);
  const corrupt = join(directory, 'corrupt.sqlite');
  writeFileSync(corrupt, Buffer.alloc(1024, 120));
  await assert.rejects(createSourceSnapshot({ dbPath: corrupt, destination: join(directory, 'corrupt-copy.sqlite') }), { code: 'database_integrity_failed' });
  assert.deepEqual(readFileSync(corrupt), Buffer.alloc(1024, 120));
});

test('snapshot failure never deletes a destination owned by someone else', async t => {
  const { directory, path } = fixture(t);
  const destination = join(directory, 'occupied.sqlite'), bytes = Buffer.from('unrelated preserved file');
  writeFileSync(destination, bytes);
  await assert.rejects(createSourceSnapshot({ dbPath: path, destination }));
  assert.deepEqual(readFileSync(destination), bytes);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const copy = join(directory, `companion${suffix}.sqlite`);
    writeFileSync(`${copy}${suffix}`, bytes);
    await assert.rejects(createSourceSnapshot({ dbPath: path, destination: copy }));
    assert.deepEqual(readFileSync(`${copy}${suffix}`), bytes);
    assert.equal(existsSync(copy), false);
  }
});

test('database diagnostics expose only fixed codes and numeric schema fields', () => {
  for (const code of ['database_algorithm_mismatch', 'database_state_incompatible', 'database_integrity_failed', 'database_journal_invalid']) {
    assert.deepEqual(databaseErrorDetails({ code, message: 'private fixture', path: '/private/fixture', actualAlgorithm: 'private' }), { code });
    assert.equal(publicReplicationError({ code }), code);
    assert.equal(typeof databaseErrorGuidance({ code }), 'string');
  }
  for (const code of ['journal_hash_mismatch', 'journal_row_conflict']) {
    assert.deepEqual(databaseErrorDetails({ code, message: 'private fixture', path: '/private/fixture', row: { private: true } }), { code: 'database_journal_invalid' });
    assert.equal(publicReplicationError({ code }), 'database_journal_invalid');
    assert.match(databaseErrorGuidance({ code }), /Preserve the database/);
  }
  assert.equal(databaseErrorDetails({ code: 'journal_checkpoint_mismatch' }), null, 'different peer checkpoints do not establish journal damage');
  for (const code of ['HEATING_CONTROL_STATE_UNREADABLE', 'H66_STATE_UNSUPPORTED', 'EXECUTOR_STATE_UNSUPPORTED',
    'EQUIPMENT_TEST_STATE_UNREADABLE', 'EQUIPMENT_TEST_STATE_UNSUPPORTED',
    'ADAPTIVE_RECORDING_BUDGET_UNSUPPORTED', 'RECORDING_STORAGE_METRICS_UNSUPPORTED'])
    assert.equal(databaseErrorDetails({ code }).code, 'database_state_incompatible');
  assert.equal(databaseErrorDetails({ code: 'ERR_SQLITE_ERROR', errcode: 11 }).code, 'database_integrity_failed');
  assert.equal(databaseErrorDetails({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), null, 'locking is not corruption');
  assert.equal(databaseErrorDetails({ code: '__proto__' }), null);
});

test('restore preserves existing SQLite companions including a concurrently created rollback journal', async t => {
  const { directory, path } = fixture(t);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const destination = join(directory, `restore${suffix}.sqlite`);
    writeFileSync(`${destination}${suffix}`, 'preserved companion');
    await assert.rejects(Store.restore(path, destination), /new database path/);
    assert.equal(readFileSync(`${destination}${suffix}`, 'utf8'), 'preserved companion');
    assert.equal(existsSync(destination), false);
    const linked = join(directory, `linked${suffix}.sqlite`);
    symlinkSync(join(directory, 'missing-target'), `${linked}${suffix}`);
    await assert.rejects(Store.restore(path, linked), /new database path/);
    assert.equal(lstatSync(`${linked}${suffix}`).isSymbolicLink(), true);
    assert.equal(existsSync(linked), false);
  }
  const destination = join(directory, 'concurrent-restore.sqlite');
  const restoring = Store.restore(path, destination);
  writeFileSync(`${destination}-journal`, 'concurrent companion');
  await assert.rejects(restoring, /new database path/);
  assert.equal(readFileSync(`${destination}-journal`, 'utf8'), 'concurrent companion');
  assert.equal(existsSync(destination), false);
  assert.equal(readdirSync(directory).some(name => name.includes('.restore-')), false);
});

test('portable backups carry exporter metadata without changing source state or observations', async t => {
  const { directory, path } = fixture(t);
  const source = new Store(path);
  source.event('fixture', { recorded: true }, 1234);
  const stateBefore = source.db.prepare('SELECT * FROM state').all();
  const destination = join(directory, 'backup.sqlite');
  await source.backup(destination);
  assert.deepEqual(source.db.prepare('SELECT * FROM state').all(), stateBefore);
  source.close();
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const metadata = readBackupMetadata(copy);
    assert.equal(validBackupMetadata(metadata), true);
    assert.equal(metadata.applicationVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
    assert.equal(metadata.schemaVersion, SCHEMA_VERSION);
    assert.equal(metadata.learningAlgorithm, LEARNING_ALGORITHM);
    assert.equal(copy.prepare('SELECT count(*) AS n FROM events').get().n, 1);
    assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { copy.close(); }
  for (const value of [null, {}, { format: 999 }, { format: 1, applicationVersion: '<script>private</script>' }])
    assert.equal(validBackupMetadata(value), false);
});
