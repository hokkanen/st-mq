import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/storage/store.js';
import { journalConnection, journalCommitTiming, verifyJournal } from '../src/storage/journal.js';

const block = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

test('runtime timing separates slow COMMIT and transaction work without recording diagnostics into history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const execute = store.db.exec.bind(store.db);
  store.db.exec = sql => { if (sql === 'COMMIT') block(25); return execute(sql); };
  store.transaction(() => store.setState('timing-fixture', 1));
  const commit = store.writeHealth.status().transactions;
  assert(commit.commitMs.last >= 20);
  assert(commit.totalMs.last >= commit.commitMs.last);
  store.db.exec = execute;
  store.transaction(() => { block(30); store.setState('timing-fixture', 2); });
  const body = store.writeHealth.status().transactions;
  assert(body.bodyMs.last >= 25);
  assert(body.totalMs.last >= body.bodyMs.last);
  assert.equal(body.committed, commit.committed + 1);
  const checkpoint = store.checkpoint();
  for (let n = 0; n < 100; n++) store.writeHealth.status();
  assert.deepEqual(store.checkpoint(), checkpoint, 'reading runtime timings has no durable side effects');
  assert.equal(store.getState('timing-fixture'), 2);
});

test('failed transactions and failed postcommit observers have distinct truthful timing outcomes', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.writeHealth.status().transactions;
  assert.throws(() => store.transaction(() => { store.setState('discarded', true); throw new Error('private-fixture-marker'); }));
  const failed = store.writeHealth.status().transactions;
  assert.equal(failed.count, before.count + 1); assert.equal(failed.committed, before.committed);
  assert.equal(store.getState('discarded'), null);
  assert.throws(() => store.transaction(() => {
    store.setState('committed', true); store.afterCommit(() => { throw new Error('private-fixture-marker'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  const committed = store.writeHealth.status().transactions;
  assert.equal(committed.committed, before.committed + 1);
  assert.equal(store.getState('committed'), true);
  assert.equal(JSON.stringify(store.writeHealth.status()).includes('private-fixture-marker'), false);
});

test('timing samples remain bounded and diagnostic failure cannot undo a real commit', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (let n = 0; n < 150; n++) store.transaction(() => store.setState('bounded-timing', n));
  const timing = store.writeHealth.status().transactions;
  assert.equal(timing.sampleCount, 128); assert.equal(timing.sampleLimit, 128);
  assert(timing.count >= 150); assert(timing.committed >= 150);
  assert(timing.totalMs.max >= timing.totalMs.p99);
  store.writeHealth.transaction = () => { throw new Error('synthetic diagnostic failure'); };
  store.transaction(() => store.setState('diagnostic-independent', true));
  assert.equal(store.getState('diagnostic-independent'), true);
});

test('asynchronous writer admission remains distinct from synchronous SQLite timing', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-timing-admission-'));
  const store = new Store(join(directory, 'history.sqlite')), blocker = new DatabaseSync(store.path);
  let locked = false;
  t.after(() => { if (locked) blocker.exec('ROLLBACK'); blocker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  blocker.exec('BEGIN IMMEDIATE'); locked = true;
  const before = store.writeHealth.status().transactions;
  const pending = store.runWrite(() => store.setState('after-lock', true));
  const waiting = store.writeHealth.status();
  assert.equal(waiting.queue.pending, 1); assert.notEqual(waiting.queue.waitingSince, null);
  assert.equal(waiting.transactions.committed, before.committed);
  assert.equal(waiting.failing, false, 'admission contention is not a failed attempted write');
  blocker.exec('ROLLBACK'); locked = false;
  await pending;
  const after = store.writeHealth.status();
  assert.equal(after.queue.pending, 0); assert.equal(after.queue.waitingSince, null);
  assert.equal(after.transactions.committed, before.committed + 1);
  assert.equal(store.getState('after-lock'), true);
});

test('measured seal and native COMMIT waits occupy distinct stages within the unchanged commit total', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), prepare = raw.prepare, exec = raw.exec;
  const initial = store.writeHealth.status().transactions;
  assert.equal(initial.journalSealMs.last, null, 'bootstrap precedes journal instrumentation');
  assert.equal(initial.nativeCommitMs.sampleCount, 0);
  raw.prepare = sql => {
    if (sql === 'SELECT payload FROM journal_pending ORDER BY ordinal') block(50);
    return prepare(sql);
  };
  try { store.transaction(() => store.setState('stage-fixture', 1)); }
  finally { raw.prepare = prepare; }
  const sealed = store.writeHealth.status().transactions;
  assert(sealed.journalSealMs.last >= 45, 'the injected seal wait belongs to journal sealing');
  assert(Number.isFinite(sealed.nativeCommitMs.last));
  assert(sealed.commitMs.last >= sealed.journalSealMs.last + sealed.nativeCommitMs.last);
  raw.exec = sql => { if (sql === 'COMMIT') block(50); return exec(sql); };
  try { store.transaction(() => store.setState('stage-fixture', 2)); }
  finally { raw.exec = exec; }
  const native = store.writeHealth.status().transactions;
  assert(native.nativeCommitMs.last >= 45, 'the injected native wait belongs to SQLite COMMIT');
  assert(native.commitMs.last >= native.journalSealMs.last + native.nativeCommitMs.last);
  assert(native.totalMs.last >= native.commitMs.last);
  assert.equal(native.journalSealMs.sampleCount, 2);
  assert.equal(native.nativeCommitMs.sampleCount, 2);
  assert.equal(verifyJournal(store.db).commits, 2);
  const checkpoint = store.checkpoint(), state = store.db.prepare('SELECT key,value FROM state ORDER BY key').all();
  for (let index = 0; index < 10; index++) store.writeHealth.status();
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(store.db.prepare('SELECT key,value FROM state ORDER BY key').all(), state,
    'timing collection adds no durable row or dated device evidence');
});

for (const stage of ['seal', 'native']) test(`a failed ${stage} stage reports only reached timings and retains original rollback semantics`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), prepare = raw.prepare, exec = raw.exec;
  const checkpoint = store.checkpoint(), before = store.writeHealth.status().transactions;
  const original = Object.assign(new Error('synthetic-stage-failure'), { errcode: 10 });
  const effects = [];
  if (stage === 'seal') raw.prepare = sql => {
    if (sql === 'SELECT payload FROM journal_pending ORDER BY ordinal') { block(25); throw original; }
    return prepare(sql);
  };
  else raw.exec = sql => { if (sql === 'COMMIT') { block(25); throw original; } return exec(sql); };
  try {
    assert.throws(() => store.transaction(() => {
      store.setState('stage-discarded', true);
      store.afterRollback(() => effects.push('rollback'));
      store.afterCommit(() => effects.push('commit'));
    }), error => error === original);
  } finally { raw.prepare = prepare; raw.exec = exec; }
  const failed = store.writeHealth.status();
  assert.equal(failed.transactions.count, before.count + 1);
  assert.equal(failed.transactions.committed, before.committed);
  assert.equal(failed.history.windows.day.journalSealDuration.count, 0, 'history measures successful commits');
  assert(failed.transactions.journalSealMs.last >= 0);
  if (stage === 'seal') {
    assert(failed.transactions.journalSealMs.last >= 20);
    assert.equal(failed.transactions.nativeCommitMs.last, null);
  } else assert(failed.transactions.nativeCommitMs.last >= 20);
  assert.deepEqual(effects, ['rollback']);
  assert.equal(store.db.isTransaction, false);
  assert.equal(store.getState('stage-discarded'), null);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM journal_pending').get().n, 0);
  assert.equal(verifyJournal(store.db).commits, 0);
  store.transaction(() => store.setState('stage-recovered', true));
  assert.equal(store.getState('stage-recovered'), true);
  assert.equal(failed.failing, true);
  assert.equal(JSON.stringify(failed).includes('synthetic-stage-failure'), false);
});

test('failed BEGIN and body rollback never inherit a previous COMMIT stage', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.transaction(() => store.setState('prior-commit', true));
  const raw = journalConnection(store.db), exec = raw.exec;
  const original = Object.assign(new Error('synthetic-begin-failure'), { errcode: 5 });
  raw.exec = sql => { if (sql === 'BEGIN IMMEDIATE') throw original; return exec(sql); };
  try { assert.throws(() => store.transaction(() => assert.fail('BEGIN failure cannot run the body')), error => error === original); }
  finally { raw.exec = exec; }
  let timing = store.writeHealth.status().transactions;
  assert.equal(timing.journalSealMs.last, null); assert.equal(timing.nativeCommitMs.last, null);
  assert.equal(journalCommitTiming(store.db), null);
  assert.throws(() => store.transaction(() => { store.setState('body-discarded', true); throw original; }), error => error === original);
  timing = store.writeHealth.status().transactions;
  assert.equal(timing.journalSealMs.last, null); assert.equal(timing.nativeCommitMs.last, null);
  assert.equal(store.getState('body-discarded'), null);
  assert.equal(store.db.isTransaction, false);
});

test('nested savepoints measure one outer COMMIT, while direct journal writes use the same stage boundary', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), exec = raw.exec, boundaries = [];
  raw.exec = sql => { if (/^(COMMIT|RELEASE)/.test(sql)) boundaries.push(sql); return exec(sql); };
  const before = store.writeHealth.status().transactions;
  try {
    store.transaction(() => {
      store.transaction(() => store.setState('nested-kept', true));
      assert.throws(() => store.transaction(() => { store.setState('nested-discarded', true); throw Error('nested'); }));
    });
    assert.equal(store.writeHealth.status().transactions.count, before.count + 1);
    assert.equal(boundaries.filter(sql => sql === 'COMMIT').length, 1);
    assert.equal(store.writeHealth.status().transactions.nativeCommitMs.sampleCount, 1);
    store.db.prepare('INSERT INTO state(key,value,updated_at) VALUES(?,?,?)').run('direct-write', 'true', 1);
    const direct = journalCommitTiming(store.db);
    assert(Number.isFinite(direct.journalSealMs)); assert(Number.isFinite(direct.nativeCommitMs));
    assert.equal(boundaries.filter(sql => sql === 'COMMIT').length, 2);
    assert.equal(store.writeHealth.status().transactions.count, before.count + 1,
      'raw worker/direct writes do not become main Store transaction observations');
    assert.equal(verifyJournal(store.db).commits, 2);
    assert.equal(store.getState('nested-discarded'), null);
  } finally { raw.exec = exec; }
});

test('an unreadable diagnostic stage cannot mask COMMIT or reorder its follow-up effects', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), descriptor = Object.getOwnPropertyDescriptor(raw, 'commitTiming');
  const effects = [];
  Object.defineProperty(raw, 'commitTiming', { configurable: true,
    get() { throw Error('synthetic diagnostic read failure'); }, set() {} });
  try {
    store.transaction(() => {
      store.setState('diagnostic-stage-independent', true);
      store.afterCommit(() => effects.push('first')); store.afterCommit(() => effects.push('second'));
    });
    const timing = store.writeHealth.status().transactions;
    assert.equal(timing.journalSealMs.last, null); assert.equal(timing.nativeCommitMs.last, null);
    assert.equal(store.getState('diagnostic-stage-independent'), true);
    assert.deepEqual(effects, ['first', 'second']);
    assert.equal(store.db.isTransaction, false);
    const exec = raw.exec, original = Object.assign(new Error('synthetic native failure'), { errcode: 10 });
    raw.exec = sql => { if (sql === 'COMMIT') throw original; return exec(sql); };
    try {
      assert.throws(() => store.transaction(() => {
        store.setState('diagnostic-stage-discarded', true);
        store.afterCommit(() => effects.push('discarded'));
        store.afterRollback(() => effects.push('rollback'));
      }), error => error === original, 'an unreadable timing cannot replace the native failure');
    } finally { raw.exec = exec; }
    assert.equal(store.getState('diagnostic-stage-discarded'), null);
    assert.deepEqual(effects, ['first', 'second', 'rollback']);
    assert.equal(store.db.isTransaction, false);
  } finally { Object.defineProperty(raw, 'commitTiming', descriptor); }
});

test('current-schema disk reopen resets only memory timings and preserves FULL WAL policy and the committed head', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-stage-reopen-'));
  let store = new Store(join(directory, 'history.sqlite'));
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  const settings = () => ({ synchronous: store.db.prepare('PRAGMA synchronous').get().synchronous,
    journalMode: store.db.prepare('PRAGMA journal_mode').get().journal_mode,
    autoCheckpoint: store.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint });
  assert.deepEqual(settings(), { synchronous: 2, journalMode: 'wal', autoCheckpoint: 1000 });
  store.transaction(() => store.setState('current-restart', { value: true, observedAt: 1234 }));
  const checkpoint = store.checkpoint();
  assert.equal(store.writeHealth.status().transactions.nativeCommitMs.sampleCount, 1);
  store.close(); store = null;
  store = new Store(join(directory, 'history.sqlite'));
  assert.deepEqual(settings(), { synchronous: 2, journalMode: 'wal', autoCheckpoint: 1000 });
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(store.getState('current-restart'), { value: true, observedAt: 1234 });
  const timings = store.writeHealth.status().transactions;
  assert.equal(timings.sampleCount, 0);
  assert.deepEqual(timings.nativeCommitMs, { last: null, max: null, p99: null, sampleCount: 0 });
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(verifyJournal(store.db).commits, 1);
});
