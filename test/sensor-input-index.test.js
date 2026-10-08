import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { sensorBoundaries, sensorChangeEvents, sensorLearningContext, sensorRevision } from '../src/app/sensor-inputs.js';
import { projectedSensorContext } from '../src/recovery/state.js';

test('sparse sensor reads retain selected prefix and projected IDs without scanning ordinary contexts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const put = (epoch, at, value, source = null, input = 'mqtt') => Number(store.db.prepare(`INSERT INTO learning_journal_entries
    (epoch,input,key,kind,at,algorithm_version,payload,source_entry_id) VALUES(?,?,?,'context',?,?,?,?)`)
    .run(epoch, input, `synthetic:${epoch}:${at}`, at, LEARNING_ALGORITHM,
      value === null ? null : JSON.stringify({ configuration: {}, value }), source).lastInsertRowid);
  let first, firstRevert, second, copied, copiedRevert;
  store.transaction(() => {
    first = put('original', 1000, { sensorChange: { signal: 'indoor_temperature' } });
    firstRevert = put('original', 2000, { sensorRevert: { id: first } });
    second = put('original', 3000, { sensorChange: { signal: 'outdoor_temperature' } });
    for (let i = 0; i < 2048; i++) put('original', 10000 + i, { controlContext: { phase: 'normal' } });
    put('inactive', 4000, { sensorChange: { signal: 'bedroom_temperature' } });
    put('original', 5000, { sensorRevert: { id: second } }, null, 'history');
    copied = put('projection', 3000, null, second);
    copiedRevert = put('projection', 6000, { sensorRevert: { id: copied } }, firstRevert);
    put('inactive', 7000, null, second);
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('projection', 'mqtt', 'original', 0, firstRevert);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('mqtt', 'projection');
  });
  const prepare = store.db.prepare, plans = [];
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes('WITH sensor_sources AS MATERIALIZED')) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail));
        return all(...args);
      };
    }
    return statement;
  };
  try {
    assert.equal(sensorRevision(store, 'mqtt'), copiedRevert);
    assert.deepEqual(sensorLearningContext(store, 'mqtt'), { sensorRevision: copiedRevert, revertedSensorChanges: [first, copied] });
    assert.deepEqual(sensorLearningContext(store, 'mqtt', firstRevert), { sensorRevision: firstRevert, revertedSensorChanges: [first] });
    assert.deepEqual(sensorBoundaries(store, 'mqtt', 8000), {});
    assert.deepEqual(sensorBoundaries(store, 'mqtt', 8000, { revision: firstRevert }), { outdoor_temperature: 3000 });
    assert.deepEqual(sensorChangeEvents(store, 'mqtt').map(row => [row.id, row.revertedAt]), [[copied, 6000], [first, 2000]]);
    assert.equal(sensorChangeEvents(store, 'mqtt', { at: 2500, limit: 1 })[0].id, first);
    store.transaction(() => {
      store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('next-projection', 'mqtt', 'original', 0, firstRevert);
      store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('next-projection', 'mqtt', 'projection', 0, copiedRevert);
    });
    assert.deepEqual(projectedSensorContext(store, 'mqtt', 'next-projection'), sensorLearningContext(store, 'mqtt'));
  } finally { store.db.prepare = prepare; }
  assert(plans.length > 0);
  for (const plan of plans) {
    assert(plan.some(row => /USING INDEX learning_sensor_contexts \(input=\?\)/.test(row)), plan.join('; '));
    assert(plan.some(row => /SEARCH e USING INDEX recovery_learning_source \(source_entry_id=\?/.test(row)), plan.join('; '));
    assert(!plan.some(row => /SCAN (?:learning_journal_entries|e)\b/.test(row)), 'Only sparse sensor entries and their indexed references may be scanned');
  }
});
