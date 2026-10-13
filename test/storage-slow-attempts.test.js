import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createWriteHealth } from '../src/storage/write-health.js';
import { journalConnection, journalCommitTiming, verifyJournal } from '../src/storage/journal.js';

const start = Date.parse('2026-10-13T18:00:00Z');
const sample = (totalMs = 1000, extra = {}) => ({ committed: true, startedAt: start,
  beginMs: 1, bodyMs: 2, commitMs: totalMs - 3, totalMs,
  journalSealMs: 4, nativeCommitMs: totalMs - 7, ...extra });
const prepared = { at: start + 2, sequence: 1, changeCount: 2, bytes: 400, tables: ['state'] };
const noEffects = { at: null, sequence: null, changeCount: 0, bytes: 0, tables: [] };
const block = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

test('slow attempts retain original dates and stages independently of later fast samples and wall-clock reversal', () => {
  let wall = start + 1000, mono = 1000;
  const health = createWriteHealth(() => wall, null, { monotonic: () => mono });
  health.transaction(sample(1000, { journal: prepared }));
  wall -= 2000; mono += 1000;
  health.transaction(sample(1000, { committed: false, startedAt: start + 1000,
    journalSealMs: null, nativeCommitMs: null, journal: null }));
  for (let index = 0; index < 140; index++) health.transaction(sample(10, { nativeCommitMs: 3 }));
  const timing = health.status().transactions;
  assert.equal(timing.sampleCount, 128);
  assert.equal(timing.nativeCommitMs.max, 3);
  assert.deepEqual(timing.slowAttempts, { thresholdMs: 1000, sampleLimit: 16, count: 2, samples: [
    { ...sample(), finishedAt: start + 1000, journal: prepared },
    { ...sample(1000, { committed: false, startedAt: start + 1000,
      journalSealMs: null, nativeCommitMs: null }), finishedAt: start - 1000, journal: null },
  ] });
  assert.equal(health.status().history.clockChanged, true);
  assert.equal(timing.slowAttempts.samples[0].totalMs, 1000, 'monotonic duration is not reconstructed from wall dates');
});

test('only slow valid attempts enter the bounded ring and returned metadata cannot mutate its evidence', () => {
  let wall = start;
  const health = createWriteHealth(() => wall, null, { monotonic: () => wall - start });
  health.transaction(sample(999));
  health.transaction(sample(1000, { nativeCommitMs: undefined }));
  for (let index = 0; index < 24; index++) {
    wall += 1000;
    health.transaction(sample(1000, { startedAt: wall - 1000, journal: { ...prepared, sequence: index + 1 } }));
  }
  const ring = health.status().transactions.slowAttempts;
  assert.equal(ring.count, 24); assert.equal(ring.samples.length, 16);
  assert.equal(ring.samples[0].journal.sequence, 9); assert.equal(ring.samples.at(-1).journal.sequence, 24);
  ring.samples[0].startedAt = 1; ring.samples[0].journal.tables.push('private-fixture-marker');
  ring.samples[0].journal.bytes = 1; ring.samples.pop();
  const original = health.status().transactions.slowAttempts;
  assert.equal(original.samples.length, 16);
  assert.equal(original.samples[0].startedAt, start + 8000);
  assert.equal(original.samples[0].journal.bytes, 400);
  assert.deepEqual(original.samples[0].journal.tables, ['state']);
});

test('missing and malformed journal diagnostics stay unknown without retaining private input or discarding measured attempts', () => {
  const health = createWriteHealth(() => start + 1000);
  const marker = 'private-fixture-marker';
  const malformed = [undefined, null, false, [], { ...prepared, privateKey: marker },
    { ...prepared, tables: [marker] }, { ...prepared, tables: ['state', 'state'] },
    { ...prepared, sequence: 0 }, { ...prepared, at: Infinity }, { ...prepared, changeCount: -1 },
    { ...prepared, bytes: 0 }, { ...noEffects, at: start }, { ...noEffects, tables: ['state'] },
    { ...noEffects, sequence: 1 }, { ...noEffects, bytes: 100 },
    { get tables() { throw Error(marker); } }];
  for (const journal of malformed) health.transaction(sample(1000, { startedAt: undefined, journal, privatePayload: marker }));
  const status = health.status();
  assert.equal(status.transactions.slowAttempts.count, malformed.length);
  assert(status.transactions.slowAttempts.samples.every(row => row.journal === null && row.startedAt === null));
  assert.equal(JSON.stringify(status).includes(marker), false);
  health.transaction(sample(1000, { journal: noEffects }));
  assert.deepEqual(health.status().transactions.slowAttempts.samples.at(-1).journal, noEffects);
});

test('real slow native COMMIT records prepared row counts and bytes without identities or extra diagnostic queries', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), exec = raw.exec, prepare = raw.prepare;
  const queries = [];
  raw.prepare = sql => { queries.push(sql); return prepare(sql); };
  store.transaction(() => store.setState('private-fixture-marker', { secret: 'before' }));
  const fastQueries = queries.splice(0);
  raw.exec = sql => { if (sql === 'COMMIT') block(1005); return exec(sql); };
  const before = Date.now();
  try { store.transaction(() => store.setState('private-fixture-marker', { secret: 'private-fixture-marker' })); }
  finally { raw.exec = exec; raw.prepare = prepare; }
  const after = Date.now(), ring = store.writeHealth.status().transactions.slowAttempts;
  assert.equal(ring.count, 1);
  const row = ring.samples[0], commit = store.db.prepare('SELECT sequence,at,change_count,bytes FROM journal_commits ORDER BY sequence DESC LIMIT 1').get();
  assert(row.startedAt >= before && row.startedAt <= after);
  assert(row.finishedAt >= row.startedAt && row.finishedAt <= after);
  assert.equal(row.committed, true); assert(row.nativeCommitMs >= 1000);
  assert.deepEqual(row.journal, { at: commit.at, sequence: commit.sequence,
    changeCount: commit.change_count, bytes: commit.bytes, tables: ['state'] });
  assert.equal(JSON.stringify(ring).includes('private-fixture-marker'), false);
  assert.deepEqual(queries, fastQueries, 'retaining a slow attempt performs the same SQL as the corresponding fast write');
  const checkpoint = store.checkpoint();
  for (let index = 0; index < 30; index++) store.writeHealth.status();
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.equal(verifyJournal(store.db).commits, 2);
});

for (const stage of ['begin', 'body', 'seal']) test(`slow failed ${stage} cannot reuse earlier prepared effects or claim an unreached COMMIT`, t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.transaction(() => store.setState('earlier-real-commit', true));
  const checkpoint = store.checkpoint(), raw = journalConnection(store.db), exec = raw.exec, prepare = raw.prepare;
  const original = Object.assign(Error('private-failure-marker'), { errcode: 10 });
  if (stage === 'begin') raw.exec = sql => { if (sql === 'BEGIN IMMEDIATE') { block(1005); throw original; } return exec(sql); };
  if (stage === 'seal') raw.prepare = sql => {
    if (sql === 'SELECT payload FROM journal_pending ORDER BY ordinal') { block(1005); throw original; }
    return prepare(sql);
  };
  try { assert.throws(() => store.transaction(() => {
    assert.notEqual(stage, 'begin', 'unopened transaction cannot run its body');
    store.setState('discarded-private-marker', true);
    if (stage === 'body') { block(1005); throw original; }
  }), error => error === original); }
  finally { raw.exec = exec; raw.prepare = prepare; }
  const row = store.writeHealth.status().transactions.slowAttempts.samples.at(-1);
  assert.equal(row.committed, false); assert.equal(row.journal, null);
  assert.equal(row.nativeCommitMs, null);
  if (stage === 'seal') assert(row.journalSealMs >= 1000);
  else assert.equal(row.journalSealMs, null);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.equal(store.getState('discarded-private-marker'), null);
  assert.equal(store.db.isTransaction, false);
  assert.equal(JSON.stringify(row).includes('private-'), false);
});

test('slow nested savepoints and a failed follow-up remain one committed outer attempt', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.writeHealth.status().transactions.count;
  assert.throws(() => store.transaction(() => {
    store.transaction(() => { block(1005); store.setState('nested-kept-private-marker', true); });
    assert.throws(() => store.transaction(() => { store.setState('nested-discarded', true); throw Error('rollback'); }));
    store.afterCommit(() => { throw Error('private-failure-marker'); });
  }), { code: 'STORAGE_COMMIT_EFFECT_FAILED', committed: true });
  const timing = store.writeHealth.status().transactions;
  assert.equal(timing.count, before + 1); assert.equal(timing.slowAttempts.count, 1);
  const row = timing.slowAttempts.samples[0];
  assert.equal(row.committed, true); assert.equal(row.journal.changeCount, 1);
  assert.deepEqual(row.journal.tables, ['state']);
  assert.equal(store.getState('nested-kept-private-marker'), true);
  assert.equal(store.getState('nested-discarded'), null);
  assert.equal(JSON.stringify(row).includes('private-'), false);
});

test('no-effect and cancelled row effects are distinct from unmeasured or failed sealing', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), exec = raw.exec, prepare = raw.prepare;
  const checkpoint = store.checkpoint();
  store.transaction(() => {});
  assert.deepEqual(journalCommitTiming(store.db).journal, noEffects);
  store.transaction(() => {
    store.setState('cancelled-private-marker', true);
    store.db.prepare('DELETE FROM state WHERE key=?').run('cancelled-private-marker');
  });
  assert.deepEqual(journalCommitTiming(store.db).journal, noEffects);
  assert.deepEqual(store.checkpoint(), checkpoint);
  // Slow body with no journal effects still belongs to the attempt ring. Net
  // zero row changes make no claim about SQLite pages or filesystem writes.
  store.transaction(() => block(1005));
  assert.deepEqual(store.writeHealth.status().transactions.slowAttempts.samples.at(-1).journal, noEffects);
  const original = Object.assign(Error('private-failure-marker'), { errcode: 10 });
  raw.prepare = sql => { if (sql === 'SELECT payload FROM journal_pending ORDER BY ordinal') throw original; return prepare(sql); };
  try { assert.throws(() => store.transaction(() => store.setState('discarded', true)), error => error === original); }
  finally { raw.prepare = prepare; }
  assert.equal(store.getState('discarded'), null);
  assert.equal(journalCommitTiming(store.db), null, 'rollback clears the failed attempt on the raw connection');
  raw.exec = exec;
  assert.equal(verifyJournal(store.db).commits, 0);
});

test('failed native COMMIT preserves only prepared journal evidence and never reports that sequence as committed', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const raw = journalConnection(store.db), exec = raw.exec;
  const original = Object.assign(Error('private-failure-marker'), { errcode: 10 });
  raw.exec = sql => { if (sql === 'COMMIT') { block(1005); throw original; } return exec(sql); };
  const effects = [], checkpoint = store.checkpoint();
  try { assert.throws(() => store.transaction(() => {
    store.setState('discarded-private-marker', true);
    store.afterCommit(() => effects.push('commit')); store.afterRollback(() => effects.push('rollback'));
  }), error => error === original); }
  finally { raw.exec = exec; }
  const ring = store.writeHealth.status().transactions.slowAttempts, row = ring.samples.at(-1);
  assert.equal(ring.count, 1); assert.equal(row.committed, false); assert(row.nativeCommitMs >= 1000);
  assert.equal(row.journal.sequence, checkpoint.sequence + 1);
  assert.equal(row.journal.changeCount, 1); assert.deepEqual(row.journal.tables, ['state']);
  assert.deepEqual(store.checkpoint(), checkpoint); assert.equal(store.getState('discarded-private-marker'), null);
  assert.deepEqual(effects, ['rollback']); assert.equal(store.db.isTransaction, false);
  assert.equal(store.writeHealth.status().history.windows.day.nativeCommitDuration.count, 0);
  assert.equal(JSON.stringify(ring).includes('private-'), false);
});

test('bootstrap evidence stays unknown and current read-only reopen starts an empty local ring', t => {
  const health = createWriteHealth(() => start + 1000);
  health.transaction(sample(1000, { journalSealMs: null, nativeCommitMs: null }));
  assert.equal(health.status().transactions.slowAttempts.samples[0].journal, null);
  const directory = mkdtempSync(join(tmpdir(), 'stmq-slow-attempt-reopen-'));
  const path = join(directory, 'history.sqlite');
  let store = new Store(path);
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  store.transaction(() => { block(1005); store.setState('current-evidence', true); });
  assert.equal(store.writeHealth.status().transactions.slowAttempts.count, 1);
  const checkpoint = store.checkpoint(); store.close();
  store = new Store(path, { readOnly: true });
  assert.deepEqual(store.writeHealth.status().transactions.slowAttempts,
    { thresholdMs: 1000, sampleLimit: 16, count: 0, samples: [] });
  assert.deepEqual(store.checkpoint(), checkpoint); assert.equal(store.getState('current-evidence'), true);
  assert.equal(store.db.prepare('PRAGMA query_only').get().query_only, 1);
});
