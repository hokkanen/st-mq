import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';

function recordedReads(store) {
  const plans = [];
  const db = { prepare(sql) {
    const statement = store.db.prepare(sql);
    return { all(...args) {
      plans.push(store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail));
      return statement.all(...args);
    } };
  } };
  return { plans, cycles: options => Store.prototype.cycles.call({ db }, options),
    summaries: options => Store.prototype.cycleSummaries.call({ db }, options) };
}

function incompletePrefix(store, count) {
  const insert = store.db.prepare(`INSERT INTO learning_cycles(id,input,started_at,ended_at,status,payload)
    VALUES(?,'providers',?,?,'incomplete',?)`);
  store.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(`incomplete-${i}`, 1000 + i, 1001 + i,
      JSON.stringify({ id: `incomplete-${i}`, status: 'incomplete', startedAt: 1000 + i, endedAt: 1001 + i }));
  });
}

function assertCompletedSeeks(plans) {
  for (const plan of plans) {
    assert(plan.some(detail => /learning_cycles_completed_start.*input=/.test(detail)), plan.join('\n'));
    assert(!plan.some(detail => /SCAN (?:r|learning_cycles)\b|USE TEMP B-TREE FOR ORDER BY/.test(detail)), plan.join('\n'));
  }
}

test('completed-cycle reads seek an empty subset despite growing incomplete archives', () => {
  for (const count of [1000, 10_000]) {
    const store = new Store(':memory:');
    try {
      incompletePrefix(store, count);
      const reads = recordedReads(store), options = { input: 'providers', completedOnly: true, limit: 30 };
      assert.deepEqual(reads.cycles(options), []);
      assert.deepEqual(reads.summaries(options), []);
      assertCompletedSeeks(reads.plans);
    } finally { store.close(); }
  }
});

test('completed-cycle seeks retain latest start ordering, recovery exclusions and assessment meaning', () => {
  const store = new Store(':memory:');
  try {
    incompletePrefix(store, 10_000);
    for (let i = 0; i < 36; i++) store.cycle('providers', { id: `completed-${i}`, status: 'completed',
      startedAt: i, endedAt: 100 - i, actual: { costCents: 80 + i, missingHours: 0 },
      assessment: { profitCents: i, uncertaintyCents: 1 } });
    store.cycle('simulated', { id: 'another-input', status: 'completed', startedAt: 20_000, endedAt: 20_001 });
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','learning_cycles','completed-35')").run();
    store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','cycle_assessments','completed-34')").run();
    const reads = recordedReads(store), options = { input: 'providers', completedOnly: true, limit: 30 };
    const expected = Array.from({ length: 30 }, (_, i) => `completed-${34 - i}`);
    assert.deepEqual(reads.cycles(options).map(row => row.id), expected);
    const summaries = reads.summaries(options);
    assert.deepEqual(summaries.map(row => row.id), expected);
    assert.equal(summaries[0].profitCents, null, 'An excluded assessment does not regain authority through the new index');
    assert.equal(summaries[0].actualCostCents, 114);
    assert.equal(summaries[1].profitCents, 33);
    assertCompletedSeeks(reads.plans);
    assert.equal(store.cycleSummaries({ input: 'providers', limit: 1 })[0].status, 'incomplete',
      'Ordinary all-cycle summaries still include incomplete attempts');
  } finally { store.close(); }
});
