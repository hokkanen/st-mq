import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { verifyJournal, resolveChange } from '../src/storage/journal.js';
import { MAIN_JOURNAL_ROW_BYTES, encodeChange } from '../src/storage/journal-codec.js';
import { journalSchema } from '../src/storage/journal-schema.js';
import { enrollJournalPeer, preparePeerTransfer, peerTransferRows, applyPeerTransfer, acknowledgePeer } from '../src/storage/journal-peer.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'stmq-journal-precision-'));
  const store = new Store(join(directory, 'source.sqlite'));
  t.after(async () => { try { store.close(); } catch {} await rm(directory, { recursive: true, force: true }); });
  return { store, directory };
}
const insertObservation = store => store.db.prepare(`INSERT INTO observations
  (source,device,signal,value,unit,source_time,received_at,quality,raw)
  VALUES('synthetic','fixture','scalar',?,'test',1,1,'good',?)`);
const observation = (store, id) => ({ ...store.db.prepare('SELECT * FROM observations WHERE id=?').get(id) });
const changesAfter = (store, checkpoint) => store.exportChanges({ after: checkpoint }).commits.flatMap(commit => commit.changes);

test('typed capture preserves exact stored REALs across inserts, updates, deletes and restart', async t => {
  const { store } = await fixture(t), insert = insertObservation(store);
  // Several of these round under SQLite 3.51 json_object even though its REAL
  // column retains the complete double. Include neighboring doubles, extremes
  // and SQL expressions independently of JSON text or recorder rounding.
  const values = [1 / 3, 0.1 + 0.2, 1 + Number.EPSILON, 1 - Number.EPSILON,
    Math.PI, 20.123456789012344, Number.MIN_VALUE, Number.MAX_VALUE,
    -Number.MIN_VALUE, -Number.MAX_VALUE, 0, -0, null];
  for (const value of values) {
    const before = store.checkpoint();
    const { lastInsertRowid: id } = insert.run(value, null);
    const saved = observation(store, id), [change] = changesAfter(store, before);
    assert.equal(saved.value, value === 0 ? 0 : value, 'Use SQLite readback as the stored-value oracle');
    assert.deepEqual(change.after, saved);
    assert.deepEqual(resolveChange(change, null), saved);
    verifyJournal(store.db);
    const next = saved.value === 1 / 3 ? 1 + Number.EPSILON : 1 / 3;
    const updateBefore = store.checkpoint();
    store.db.prepare('UPDATE observations SET value=? WHERE id=?').run(next, id);
    const updated = observation(store, id), [update] = changesAfter(store, updateBefore);
    assert.deepEqual(resolveChange(update, saved), updated);
    assert.deepEqual(resolveChange(update, updated, { reverse: true }), saved);
    verifyJournal(store.db);
    const deleteBefore = store.checkpoint();
    store.db.prepare('DELETE FROM observations WHERE id=?').run(id);
    const [deletion] = changesAfter(store, deleteBefore);
    assert.deepEqual(deletion.before, updated);
    assert.equal(resolveChange(deletion, updated), null);
    verifyJournal(store.db);
  }
  store.db.exec(`INSERT INTO observations(source,device,signal,value,unit,received_at,quality)
    VALUES('synthetic','fixture','sql-expression',1.0/3.0,'test',2,'good')`);
  verifyJournal(store.db);
  const checkpoint = store.checkpoint();
  store.close();
  const reopened = new Store(store.path);
  try {
    assert.deepEqual(reopened.checkpoint(), checkpoint);
    assert.equal(reopened.db.prepare('SELECT value FROM observations').get().value, 1 / 3);
    verifyJournal(reopened.db);
  } finally { reopened.close(); }
});

test('typed capture retains TEXT spelling, JSON subtypes, SQL NULL and stable composite keys', async t => {
  const { store } = await fixture(t), before = store.checkpoint();
  store.db.exec(`INSERT INTO events(type,payload,at) VALUES('synthetic',json_object('value',1.0/3.0),1)`);
  const event = { ...store.db.prepare('SELECT * FROM events').get() };
  assert.equal(typeof changesAfter(store, before)[0].after.payload, 'string');
  assert.deepEqual(changesAfter(store, before)[0].after, event,
    'JSON-producing SQL still stores literal TEXT, including its original number spelling');
  const text = 'quoted " and slash \\; newline\n; control\u0001; café; 🏠; 0.3333333333333333';
  const { lastInsertRowid: id } = insertObservation(store).run(null, text);
  assert.equal(observation(store, id).raw, text);
  assert.equal(observation(store, id).value, null);
  const baseline = store.checkpoint();
  store.db.prepare(`INSERT INTO recorder_metrics
    (key,bucket,polls,records,first_saved_at,last_saved_at,bytes,error_squared_time,error_time,stale,failed,unavailable)
    VALUES(?,2,1,1,NULL,NULL,10,?,?,0,0,0)`).run('fixture "🧪"', 1 / 3, 1 + Number.EPSILON);
  const metrics = { ...store.db.prepare('SELECT * FROM recorder_metrics').get() };
  const [change] = changesAfter(store, baseline);
  assert.deepEqual(change.key, ['fixture "🧪"', 2]);
  assert.deepEqual(change.after, metrics);
  assert.deepEqual(Object.keys(change.after), Object.keys(metrics));
  verifyJournal(store.db);
});

test('unsupported nonfinite, blob and unsafe integer input rolls back without a false JSON null fingerprint', async t => {
  const { store } = await fixture(t), insert = insertObservation(store);
  for (const value of [Infinity, -Infinity, Buffer.from('unsupported binary')]) {
    const before = store.checkpoint();
    assert.throws(() => insert.run(value, null), { code: 'journal_value_invalid' });
    assert.deepEqual(store.checkpoint(), before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM observations').get().n, 0);
  }
  assert.throws(() => store.db.exec(`INSERT INTO events(id,type,payload,at)
    VALUES(9007199254740993,'synthetic','{}',1)`), { code: 'ERR_OUT_OF_RANGE' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  // SQLite itself maps a bound NaN to SQL NULL; retain that actual stored value.
  insert.run(NaN, null);
  assert.equal(store.db.prepare('SELECT value FROM observations').get().value, null);
  verifyJournal(store.db);
});

test('embedded NUL TEXT rejects atomically before Node 22 can truncate its fingerprint', async t => {
  const { store } = await fixture(t), insert = insertObservation(store);
  const { lastInsertRowid: id } = insert.run(1 / 3, 'original');
  const before = store.checkpoint();
  const update = store.db.prepare('UPDATE observations SET raw=? WHERE id=?');
  for (const value of ['before\u0000after', '\u0000', '\u0000suffix', 'prefix\u0000']) {
    assert.throws(() => update.run(value, id), { code: 'journal_value_invalid' });
    assert.deepEqual(store.checkpoint(), before);
    assert.equal(store.db.prepare('SELECT hex(raw) hex FROM observations WHERE id=?').get(id).hex, '6F726967696E616C');
  }
  assert.throws(() => store.db.exec("UPDATE observations SET raw='before'||char(0)||'after'"), { code: 'journal_value_invalid' });
  assert.deepEqual(store.checkpoint(), before);
  assert.equal(observation(store, id).raw, 'original');
  verifyJournal(store.db);
});

test('decoded rows and patches cannot inject values outside the current scalar contract', async t => {
  const { store } = await fixture(t);
  const { lastInsertRowid: id } = insertObservation(store).run(1 / 3, 'prefix');
  const before = observation(store, id);
  for (const raw of ['prefix\u0000suffix', Buffer.from('binary'), Infinity]) {
    const change = encodeChange('observations', [id], before, { ...before, raw });
    assert.throws(() => resolveChange(change, before), { code: 'database_journal_invalid' });
  }
  const change = encodeChange('observations', [id], before, { ...before, raw: 'prefix\u0000suffix' });
  change.before = { raw: { $text: [6, 0, ''] } };
  change.after = { raw: { $text: [6, 0, '\u0000suffix'] } };
  assert.throws(() => resolveChange(change, before), { code: 'database_journal_invalid' });
  assert.throws(() => store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(NULL,?,1)').run('{}'),
    { code: 'database_journal_invalid' });
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM state').get().n, 0);
});

test('full verification detects NUL suffix corruption even when Node 22 readback matches the old prefix', async t => {
  const { store } = await fixture(t);
  const { lastInsertRowid: id } = insertObservation(store).run(1 / 3, 'prefix');
  for (let i = 0; i < 3; i++) store.setState('later', i);
  store.compactJournal({ maxCommits: 1 });
  verifyJournal(store.db);
  const raw = new DatabaseSync(store.path);
  raw.function('journal_capture_enabled', () => 0);
  raw.function('journal_capture', { varargs: true }, () => null);
  raw.prepare("UPDATE observations SET raw=raw||char(0)||'suffix' WHERE id=?").run(id);
  raw.close();
  assert.equal(store.db.prepare('SELECT hex(raw) hex FROM observations WHERE id=?').get(id).hex, '70726566697800737566666978');
  assert.throws(() => verifyJournal(store.db), { code: 'database_journal_invalid' });
});

test('escaped text cannot evade the pre-encoding row admission limit', async t => {
  const { store } = await fixture(t), before = store.checkpoint();
  const text = '\u0001'.repeat(Math.ceil(MAIN_JOURNAL_ROW_BYTES / 6));
  assert(Buffer.byteLength(text) < MAIN_JOURNAL_ROW_BYTES);
  assert.throws(() => store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)')
    .run('synthetic', text, 1), { code: 'journal_main_thread_transaction_too_large' });
  assert.deepEqual(store.checkpoint(), before);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  store.event('after-rejection', { retained: true }, 2);
  verifyJournal(store.db);
});

test('catching a capture admission failure cannot grant another budget inside the transaction', async t => {
  const { store } = await fixture(t), before = store.checkpoint();
  const insert = store.db.prepare('INSERT INTO events(type,payload,at) VALUES(?,?,?)');
  const oversized = '\u0001'.repeat(Math.ceil(MAIN_JOURNAL_ROW_BYTES / 6));
  assert.throws(() => store.transaction(() => {
    assert.throws(() => store.transaction(() => insert.run('synthetic', oversized, 1)),
      { code: 'journal_main_thread_transaction_too_large' });
    insert.run('synthetic', 'small following write', 2);
  }), { code: 'journal_main_thread_transaction_too_large' });
  assert.deepEqual(store.checkpoint(), before);
  insert.run('synthetic', 'fresh transaction', 3);
  verifyJournal(store.db);
});

test('typed capture uses the portable SQLite argument limit and rejects incompatible schema before mutation', async t => {
  const table = columns => `CREATE TABLE fixture(id INTEGER PRIMARY KEY,${Array.from({ length: columns - 1 }, (_, i) => `c${i} REAL`).join(',')});`;
  assert.doesNotThrow(() => journalSchema(table(62)));
  assert.throws(() => journalSchema(table(63)), /argument limit/);
  const { store } = await fixture(t);
  assert.equal(SCHEMA_VERSION, 27);
  store.close();
  const raw = new DatabaseSync(store.path);
  raw.exec('PRAGMA user_version=25');
  raw.close();
  const bytes = await readFile(store.path);
  for (const readOnly of [false, true]) {
    assert.throws(() => new Store(store.path, { readOnly }), { code: 'database_schema_mismatch' });
    assert.deepEqual(await readFile(store.path), bytes);
  }
});

test('offline peer catch-up after compaction preserves exact floats and strict materialized verification', async t => {
  const { store: source, directory } = await fixture(t);
  const { lastInsertRowid: id } = insertObservation(source).run(1 / 3, 'synthetic original');
  enrollJournalPeer(source.db);
  const targetPath = join(directory, 'target.sqlite');
  await source.backup(targetPath);
  const target = new Store(targetPath);
  t.after(() => target.close());
  const anchor = target.checkpoint();
  for (let i = 0; i < 12; i++) {
    source.db.prepare('UPDATE observations SET value=? WHERE id=?').run(1 + (i + 1) * Number.EPSILON, id);
    source.compactJournal({ maxCommits: 1 });
  }
  assert(source.journalBase().sequence > anchor.sequence);
  const transfer = preparePeerTransfer(source.db, { after: anchor });
  const changes = peerTransferRows(source.db, { id: transfer.id, afterOrdinal: -1, limit: 16 }).map(row => row.change);
  applyPeerTransfer(target.db, { ...transfer, changes });
  acknowledgePeer(source.db, { checkpoint: target.checkpoint() });
  assert.deepEqual(observation(target, id), observation(source, id));
  assert.deepEqual(target.checkpoint(), source.checkpoint());
  verifyJournal(source.db);
  verifyJournal(target.db);
  // Full verification must still compare the actual complete stored value.
  // Corrupt one row without changing the captured checkpoint or peer baseline.
  const raw = new DatabaseSync(target.path);
  raw.function('journal_capture_enabled', () => 0);
  raw.function('journal_capture', { varargs: true }, () => null);
  raw.prepare('UPDATE observations SET value=? WHERE id=?').run(1 / 3, id);
  raw.close();
  assert.throws(() => verifyJournal(target.db), { code: 'journal_row_conflict' });
});
