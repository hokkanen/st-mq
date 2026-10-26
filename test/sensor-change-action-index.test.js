import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { Store } from '../src/storage/store.js';
import { addSensorChange, revertSensorChange } from '../src/app/sensor-changes.js';
import { LEARNING_ALGORITHM } from '../src/domain/learning-contract.js';
import { SENSOR_SETTLING_MS } from '../src/domain/indoor-sensors.js';

const change = (requestId, signal = 'indoor_temperature', reason = 'replacement') => ({ requestId, signal, reason });
const put = (store, epoch, at, value, source = null, input = 'mqtt') => Number(store.db.prepare(`INSERT INTO learning_journal_entries
  (epoch,input,key,kind,at,algorithm_version,payload,source_entry_id) VALUES(?,?,?,'context',?,?,?,?)`)
  .run(epoch, input, `synthetic:${epoch}:${input}:${at}`, at, LEARNING_ALGORITHM,
    value === null ? null : JSON.stringify({ configuration: {}, value }), source).lastInsertRowid);

test('sensor actions retain inherited and remapped IDs, epoch scope and request conflicts', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = addSensorChange(store, 'mqtt', change('inherited'), 1000);
  const reversal = revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'inherited-revert' }, 2000);
  const source = addSensorChange(store, 'mqtt', change('projected', 'bedroom_temperature'), 3000);
  const excluded = addSensorChange(store, 'mqtt', change('excluded-original'), 4000);
  addSensorChange(store, 'simulated', change('projected'), 3000);
  let copied;
  store.transaction(() => {
    copied = put(store, 'projected', 3000, null, source.id);
    put(store, 'inactive', 5000, { sensorChange: { ...change('inactive'), settleUntil: 6000 } });
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('projected', 'mqtt', 'original', 0, reversal.revision);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('mqtt', 'projected');
  });
  const before = store.checkpoint();
  assert.equal(addSensorChange(store, 'mqtt', change('inherited'), 6000).id, first.id);
  assert.deepEqual(addSensorChange(store, 'mqtt', change('projected', 'bedroom_temperature'), 6000),
    { id: copied, at: 3000, ...change('projected', 'bedroom_temperature'), settleUntil: source.settleUntil, repeated: true });
  assert.equal(revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'inherited-revert' }, 6000).revision, reversal.revision);
  assert.throws(() => addSensorChange(store, 'mqtt', change('projected'), 6000), { statusCode: 409 });
  assert.throws(() => revertSensorChange(store, 'mqtt', { id: copied, requestId: 'inherited-revert' }, 6000), { statusCode: 409 });
  assert.throws(() => revertSensorChange(store, 'mqtt', { id: excluded.id, requestId: 'not-selected' }, 6000), /not found/);
  assert.throws(() => revertSensorChange(store, 'mqtt', { id: source.id, requestId: 'source-not-selected' }, 6000), /not found/);
  assert.deepEqual(store.checkpoint(), before, 'Reads, repeats and rejected actions leave the journal unchanged');
  const reverted = revertSensorChange(store, 'mqtt', { id: copied, requestId: 'projected-revert' }, 7000);
  assert.equal(reverted.id, copied); assert.equal(reverted.repeated, false);
  const repeated = revertSensorChange(store, 'mqtt', { id: copied, requestId: 'another-revert-request' }, 8000);
  assert.equal(repeated.revision, reverted.revision); assert.equal(repeated.revertedAt, 7000); assert.equal(repeated.repeated, true);
  assert.equal(addSensorChange(store, 'mqtt', change('excluded-original'), 9000).repeated, false);
  assert.equal(addSensorChange(store, 'mqtt', change('inactive'), 10000).repeated, false);
});

test('sensor action request collisions prefer direct epoch and rollback leaves no cached source', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const inherited = addSensorChange(store, 'mqtt', change('duplicate'), 1000);
  let direct;
  store.transaction(() => {
    direct = put(store, 'projected', 2000, { timestamp: 2000, sensorChange: { ...change('duplicate', 'bedroom_temperature'), settleUntil: 3000 } });
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('projected', 'mqtt', 'original', 0, inherited.id);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('mqtt', 'projected');
  });
  assert.equal(addSensorChange(store, 'mqtt', change('duplicate', 'bedroom_temperature'), 4000).id, direct);
  assert.throws(() => addSensorChange(store, 'mqtt', change('duplicate'), 4000), { statusCode: 409 });
  const before = store.checkpoint(); let rejected;
  assert.throws(() => store.transaction(() => {
    rejected = addSensorChange(store, 'mqtt', change('rolled-back'), 5000);
    revertSensorChange(store, 'mqtt', { id: rejected.id, requestId: 'rolled-back-revert' }, 6000);
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.deepEqual(store.checkpoint(), before);
  assert.equal(store.getState('fireplace:rebuild:mqtt'), null);
  const accepted = addSensorChange(store, 'mqtt', change('rolled-back', 'outdoor_temperature'), 7000);
  assert.equal(accepted.repeated, false); assert.equal(accepted.signal, 'outdoor_temperature');
  assert.equal(revertSensorChange(store, 'mqtt', { id: accepted.id, requestId: 'rolled-back-revert' }, 8000).repeated, false);
});

test('reversal request collisions retain direct precedence and earliest selected target reversal', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const first = addSensorChange(store, 'mqtt', change('first'), 1000);
  const second = addSensorChange(store, 'mqtt', change('second'), 2000);
  const inherited = revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'duplicate-revert' }, 3000);
  let direct;
  store.transaction(() => {
    direct = put(store, 'projected', 4000, { timestamp: 4000, sensorRevert: { id: second.id, requestId: 'duplicate-revert' } });
    store.db.prepare('INSERT INTO learning_epoch_segments VALUES(?,?,?,?,?)').run('projected', 'mqtt', 'original', 0, inherited.revision);
    store.db.prepare('INSERT INTO learning_epochs VALUES(?,?)').run('mqtt', 'projected');
  });
  const before = store.checkpoint();
  assert.throws(() => revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'duplicate-revert' }, 5000), { statusCode: 409 });
  assert.equal(revertSensorChange(store, 'mqtt', { id: second.id, requestId: 'duplicate-revert' }, 5000).revision, direct);
  assert.equal(revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'different-revert-request' }, 5000).revision, inherited.revision);
  assert.deepEqual(store.checkpoint(), before);
});

test('real writer sensor actions seek sparse sources despite growing ordinary context prefixes', async t => {
  const sizes = [];
  for (const prefix of [1000, 20000]) {
    const directory = mkdtempSync(join(tmpdir(), 'st-mq-sensor-actions-'));
    const store = new Store(join(directory, 'recording.sqlite'));
    try {
      const first = addSensorChange(store, 'mqtt', change('selected'), 1000);
      const ordinarySource = put(store, 'original', 1500, { timestamp: 1500, controlContext: { phase: 'normal' } });
      const insert = store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload,source_entry_id)
        VALUES(?,'mqtt',?,'context',?,?,?,?)`);
      for (let from = 0; from < prefix; from += 128) store.transaction(() => {
        for (let i = from; i < Math.min(prefix, from + 128); i++) insert.run(i % 2 ? 'inactive-projection' : 'original',
          `ordinary:${i}`, 2000 + i, LEARNING_ALGORITHM, i % 2 ? null
            : JSON.stringify({ configuration: {}, value: { timestamp: 2000 + i, controlContext: { phase: 'normal' } } }), i % 2 ? ordinarySource : null);
      });
      await store.startWriter();
      const call = store.writer.call.bind(store.writer), transfers = [], plans = [];
      store.writer.call = (method, parameters) => {
        const result = call(method, parameters);
        if (method === 'statement' && parameters.sql.includes('WITH sensor_sources AS MATERIALIZED')) {
          transfers.push({ rows: result ? 1 : 0, bytes: serialize(result).byteLength });
          plans.push(call('statement', { ...parameters, method: 'all', sql: `EXPLAIN QUERY PLAN ${parameters.sql}` }).map(row => row.detail));
        }
        return result;
      };
      assert.equal((await store.runWrite(() => addSensorChange(store, 'mqtt', change('selected'), 50000))).id, first.id);
      const added = await store.runWrite(() => addSensorChange(store, 'mqtt', change('new'), 50001));
      const reverted = await store.runWrite(() => revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'revert' }, 50002));
      assert.equal(added.repeated, false); assert.equal(reverted.id, first.id);
      assert.equal((await store.runWrite(() => revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'revert' }, 50003))).repeated, true);
      assert.equal(transfers.length, 7);
      assert(transfers.every(row => row.rows <= 1 && row.bytes < 32 * 1024), JSON.stringify(transfers));
      for (const plan of plans) {
        assert(plan.some(row => /USING INDEX learning_sensor_contexts \(input=\?\)/.test(row)), plan.join('; '));
        assert(plan.some(row => /USING INDEX recovery_learning_source \(source_entry_id=\?/.test(row)), plan.join('; '));
        assert(!plan.some(row => /SCAN (?:learning_journal_entries|e)\b/.test(row)), plan.join('; '));
      }
      sizes.push(transfers.map(row => row.rows));
    } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  assert.deepEqual(sizes[1], sizes[0], 'Unrelated ordinary contexts never enter action lookup responses');
});

test('sensor action responses remain single candidates as current manual source history grows', async () => {
  const responses = [];
  for (const count of [1000, 5000]) {
    const directory = mkdtempSync(join(tmpdir(), 'st-mq-sensor-manual-'));
    const store = new Store(join(directory, 'recording.sqlite'));
    try {
      const first = addSensorChange(store, 'mqtt', change('selected'), 1000);
      const templateSource = addSensorChange(store, 'mqtt', change('manual-template'), 2000);
      const template = JSON.parse(store.db.prepare('SELECT payload FROM learning_journal_entries WHERE id=?').get(templateSource.id).payload);
      const insert = store.db.prepare(`INSERT INTO learning_journal_entries(epoch,input,key,kind,at,algorithm_version,payload)
        VALUES('original','mqtt',?,'context',?,?,?)`);
      for (let from = 2; from < count; from += 64) store.transaction(() => {
        for (let i = from; i < Math.min(count, from + 64); i++) {
          const payload = { ...template, value: { ...template.value, timestamp: 2000 + i,
            sensorChange: { ...template.value.sensorChange, requestId: `manual-${i}`, settleUntil: 2000 + i + SENSOR_SETTLING_MS } } };
          insert.run(`manual:${i}`, 2000 + i, LEARNING_ALGORITHM, JSON.stringify(payload));
        }
      });
      await store.startWriter();
      const call = store.writer.call.bind(store.writer), reads = [];
      store.writer.call = (operation, parameters) => {
        const result = call(operation, parameters);
        if (operation === 'statement' && parameters.sql.includes('WITH sensor_sources AS MATERIALIZED')) {
          assert.equal(parameters.method, 'get');
          reads.push({ rows: result ? 1 : 0, bytes: serialize(result).byteLength });
        }
        return result;
      };
      assert.equal((await store.runWrite(() => addSensorChange(store, 'mqtt', change('selected'), 50000))).id, first.id);
      await assert.rejects(store.runWrite(() => addSensorChange(store, 'mqtt', change('selected', 'bedroom_temperature'), 50000)), { statusCode: 409 });
      const reverted = await store.runWrite(() => revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'revert' }, 50001));
      assert.equal(reverted.repeated, false);
      assert.equal((await store.runWrite(() => revertSensorChange(store, 'mqtt', { id: first.id, requestId: 'revert' }, 50002))).revision, reverted.revision);
      assert(reads.every(row => row.rows <= 1 && row.bytes < 32 * 1024), JSON.stringify(reads));
      responses.push(reads.map(row => row.rows));
    } finally { await store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
  assert.deepEqual(responses[1], responses[0]);
});
