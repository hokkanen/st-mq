import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { reverseChanges, resolveChange } from '../src/storage/journal.js';
import { LEARNING_RECORD_INDEX_PREDICATE } from '../src/storage/journal-schema.js';

test('learning reversal uses a partial index while other journal records remain reversibly accessible', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const before = store.checkpoint();
  const checkpoint = value => ({ version: 1, samples: [], model: { version: 4 }, state: { indoorC: value } });
  for (const value of [20, 21]) store.setState('adaptive:fixture', checkpoint(value));
  for (const value of [1, 2]) store.setState('charging:fixture', { value });
  for (const epoch of ['one', 'two']) store.db.prepare('INSERT INTO learning_epochs VALUES(?,?) ON CONFLICT(input) DO UPDATE SET epoch=excluded.epoch')
    .run('fixture', epoch);
  const indexed = store.db.prepare(`SELECT table_name,record_key FROM journal_changes INDEXED BY journal_changes_record
    WHERE ${LEARNING_RECORD_INDEX_PREDICATE}`).all();
  assert.ok(indexed.some(row => row.table_name === 'learning_epochs'));
  assert.ok(indexed.some(row => row.record_key === JSON.stringify(['adaptive:fixture'])));
  assert.ok(indexed.every(row => !row.record_key.includes('charging:fixture')));
  const query = `SELECT * FROM journal_changes WHERE sequence>? AND table_name=? AND record_key=?
    AND (${LEARNING_RECORD_INDEX_PREDICATE}) ORDER BY sequence DESC,ordinal DESC`;
  assert.ok(store.db.prepare('EXPLAIN QUERY PLAN ' + query).all(before.sequence, 'state', '["adaptive:fixture"]')
    .some(row => row.detail.includes('journal_changes_record')));
  for (const key of ['adaptive:fixture', 'charging:fixture']) {
    const changes = [...reverseChanges(store.db, { after: before, table: 'state', key: [key] })];
    const expected = store.db.prepare('SELECT payload FROM journal_changes NOT INDEXED WHERE table_name=? AND record_key=? ORDER BY sequence DESC,ordinal DESC')
      .all('state', JSON.stringify([key])).map(row => JSON.parse(row.payload));
    assert.deepEqual(changes.map(({ sequence, ordinal, ...change }) => change), expected);
    let current = store.db.prepare('SELECT * FROM state WHERE key=?').get(key);
    for (const change of changes) current = resolveChange(change, current, { reverse: true });
    assert.equal(current, null, 'Every indexed and unindexed row reverses to its genuine absent origin');
  }
});

test('energy recovery range seeks exclude scalar rows without changing interval results', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.transaction(() => {
    for (let index = 0; index < 20; index++) store.observation({ source: 'synthetic', device: 'fixture', signal: 'supply_temperature',
      value: 20, unit: 'degC', sourceTime: index * 1000, receivedAt: index * 1000, quality: [] });
    for (let index = 1; index <= 6; index++) store.observation({ source: 'synthetic', device: 'fixture', signal: 'ev1_energy_l1',
      value: .1, unit: 'kWh', sourceTime: index * 1000, receivedAt: index * 1000, quality: [],
      raw: { intervalStart: (index - 1) * 1000, intervalEnd: index * 1000 } });
  });
  const end = "CASE WHEN json_valid(raw) THEN json_extract(raw,'$.intervalEnd') END";
  const sql = index => `SELECT id FROM observations ${index} WHERE device=? AND signal=? AND (${end})>? ORDER BY id`;
  const args = ['fixture', 'ev1_energy_l1', 2000];
  assert.deepEqual(store.db.prepare(sql('INDEXED BY observations_recovery_energy')).all(...args),
    store.db.prepare(sql('NOT INDEXED')).all(...args));
  assert.equal(store.db.prepare(`SELECT count(*) n FROM observations INDEXED BY observations_recovery_energy WHERE (${end}) IS NOT NULL`).get().n, 6);
  assert.ok(store.db.prepare('EXPLAIN QUERY PLAN ' + sql('')).all(...args)
    .some(row => row.detail.includes('observations_recovery_energy')));
});
