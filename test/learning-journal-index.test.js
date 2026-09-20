import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, SCHEMA_VERSION } from '../src/storage/store.js';
import { initialAdaptiveModel } from '../src/control/adaptive-learning.js';
import { appendLearningRecord, LEARNING_ALGORITHM } from '../src/app/committed-learning.js';

function assertIndexedAlgorithmLookup(store) {
  // This is the first-entry query used for every journal append, and the same
  // ordered query used for replay pages. Requiring all equality constraints
  // bounds its work independently of the number of archived algorithms.
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM learning_journal
    WHERE input=? AND id>? AND algorithm_version=? ORDER BY id LIMIT ?`)
    .all('history', 0, LEARNING_ALGORITHM, 1).map(row => row.detail);
  assert.ok(plan.some(detail => /USING INDEX learning_entries_algorithm \(epoch=\? AND input=\? AND algorithm_version=\? AND id>\?\)/.test(detail)),
  `Current-algorithm lookup must seek past archived algorithms: ${plan.join('; ')}`);
  assert.ok(plan.every(detail => !/USE TEMP B-TREE/.test(detail)), 'Journal ordering must use the same index');
}

test('new databases seek directly to the requested learning algorithm', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  assertIndexedAlgorithmLookup(store);
  assert.deepEqual(store.learningJournal({ input: 'history', algorithmVersion: LEARNING_ALGORITHM }), []);
});

test('schema 11 upgrade indexes a large algorithm archive without changing journal entries or seed boundaries', t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-journal-index-'));
  const path = join(directory, 'synthetic.sqlite');
  let store = new Store(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.db.exec('DROP INDEX learning_entries_algorithm; PRAGMA user_version=11');
  const archivedCount = 50_000;
  const archivedPayload = JSON.stringify({ synthetic: true, padding: 'x'.repeat(1024) });
  const insert = store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,payload)
    VALUES('original','history',?,'sample',?,'synthetic-archived-algorithm',?)`);
  store.transaction(() => {
    for (let i = 0; i < archivedCount; i++) insert.run(`archived:${i}`, i, archivedPayload);
    store.setState('synthetic-checkpoint', { cursor: archivedCount });
  });
  store.close();
  store = new Store(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assertIndexedAlgorithmLookup(store);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM learning_journal_entries WHERE payload=?')
    .get(archivedPayload).count, archivedCount, 'Archived payloads remain unchanged');
  assert.deepEqual(store.getState('synthetic-checkpoint'), { cursor: archivedCount });

  const seed = { syntheticSeed: true, model: initialAdaptiveModel() };
  const firstId = appendLearningRecord(store, 'history', 'sample', { timestamp: archivedCount }, { seed });
  const nextId = appendLearningRecord(store, 'history', 'sample', { timestamp: archivedCount + 1 }, { seed });
  for (let i = 0; i < 256; i++) {
    const first = store.learningJournal({ input: 'history', limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
    assert.equal(first.id, firstId);
    assert.deepEqual(first.payload.seed, seed, 'An archived algorithm does not suppress the new seed');
  }
  const next = store.learningJournal({ input: 'history', after: firstId, limit: 1, algorithmVersion: LEARNING_ALGORITHM })[0];
  assert.equal(next.id, nextId);
  assert.equal(Object.hasOwn(next.payload, 'seed'), false, 'Only the first current entry carries the seed');
});
