import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { LEARNING_ALGORITHM} from '../src/app/committed-learning.js';
import { appendLearningRecord } from './helpers/home-learning-fixture.js';

function assertIndexedInputLookup(store, { after = 0, limit = 1 } = {}) {
  // This is the first-entry query used for every journal append, and the same
  // ordered query used for replay pages. Requiring all equality constraints
  // bounds its work independently of the number of unrelated inputs.
  const prepare = store.db.prepare, queries = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (/FROM learning_journal_entries e LEFT JOIN/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...params) => { queries.push({ sql, params }); return all(...params); };
    }
    return statement;
  };
  let rows;
  try { rows = store.learningJournal({ input: 'history', after, limit, algorithmVersion: LEARNING_ALGORITHM }); }
  finally { store.db.prepare = prepare; }
  assert(queries.length > 0, 'Exercise the actual current journal reader');
  for (const { sql, params } of queries) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail);
    assert(plan.some(detail => /USING INDEX learning_entries_epoch_input \(epoch=\? AND input=\? AND id>\?/.test(detail)),
      `Each direct or retained range must seek to its requested cursor: ${plan.join('; ')}`);
    assert(plan.every(detail => !/USE TEMP B-TREE/.test(detail)), 'Each range must yield a bounded page without sorting history');
    assert.equal(params.at(-1), limit, 'Each source range supplies at most the requested page');
    assert(params[2] >= after, 'Every range skips the already read journal prefix');
    assert.doesNotMatch(sql, /algorithm_version\s*=/, 'Unsupported algorithms must be read and rejected, never filtered out');
  }
  return rows;
}

test('new databases seek directly to the requested input without hiding unsupported algorithms', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assertIndexedInputLookup(store);
  assert.deepEqual(store.learningJournal({ input: 'history', algorithmVersion: LEARNING_ALGORITHM }), []);
});

test('current journal pages seek within retained prefixes and merge only bounded source pages', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const insert = store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload)
    VALUES('original','history',?,'context',?,?,?)`);
  store.transaction(() => { for (let i = 1; i <= 2048; i++) insert.run(`synthetic:${i}`, i, LEARNING_ALGORITHM, '{}'); });
  const prefixEnd = store.learningJournalHead('history');
  store.transaction(() => {
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('selected', 'history', 'original', 0, prefixEnd);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('history', 'selected');
    store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload)
      VALUES('selected','history','synthetic-tail','context',?,?,?)`).run(2049, LEARNING_ALGORITHM, '{}');
  });
  assert.deepEqual(assertIndexedInputLookup(store).map(row => row.id), [1]);
  assert.deepEqual(assertIndexedInputLookup(store, { after: prefixEnd - 1, limit: 2 }).map(row => row.id), [prefixEnd, prefixEnd + 1]);
});

test('current journal index skips unrelated inputs without changing seed boundaries', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-journal-index-'));
  const path = join(directory, 'synthetic.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const archivedCount = 50_000;
  const archivedPayload = JSON.stringify({ synthetic: true, padding: 'x'.repeat(1024) });
  const insert = store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,payload)
    VALUES('original','unrelated',?,'sample',?,?,?)`);
  for (let offset = 0; offset < archivedCount; offset += 1000) store.transaction(() => {
    for (let i = offset; i < Math.min(archivedCount, offset + 1000); i++) insert.run(`archived:${i}`, i, LEARNING_ALGORITHM, archivedPayload);
  });
  store.setState('synthetic-checkpoint', { cursor: archivedCount });
  store.close();
  store = new Store(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assertIndexedInputLookup(store);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM learning_journal_entries WHERE payload=?')
    .get(archivedPayload).count, archivedCount, 'Unrelated payloads remain unchanged');
  assert.deepEqual(store.getState('synthetic-checkpoint'), { cursor: archivedCount });

  const seed = { syntheticSeed: true, model: initialAdaptiveModel() };
  const firstId = appendLearningRecord(store, 'history', 'sample', { timestamp: archivedCount }, { seed });
  const nextId = appendLearningRecord(store, 'history', 'sample', { timestamp: archivedCount + 1 }, { seed });
  for (let i = 0; i < 256; i++) {
    const first = store.learningJournal({ input: 'history', limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
    assert.equal(first.id, firstId);
    assert.deepEqual(first.payload.seed, seed, 'An unrelated input does not suppress the new seed');
  }
  const next = store.learningJournal({ input: 'history', after: firstId, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
  assert.equal(next.id, nextId);
  assert.equal(Object.hasOwn(next.payload, 'seed'), false, 'Only the first current entry carries the seed');
});
