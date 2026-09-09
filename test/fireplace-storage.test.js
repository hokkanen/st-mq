import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { addFireplace, removeFireplace, fireplaceEvents, fireplaceView } from '../src/app/fireplace.js';
import { appendLearningRecord } from '../src/app/committed-learning.js';

const at = Date.parse('2026-01-01T00:00:00Z');
const storeFor = t => { const store = new Store(':memory:'); t.after(() => store.close()); return store; };

test('fireplace loads use the server time, retain simultaneous loads, and deduplicate retries per source', t => {
  const store = storeFor(t);
  const first = addFireplace(store, 'mqtt', { requestId: 'invented-load-one', kg: 4 }, at);
  const retried = addFireplace(store, 'mqtt', { requestId: 'invented-load-one', kg: 4 }, at + 60_000);
  const second = addFireplace(store, 'mqtt', { requestId: 'invented-load-two', kg: 6 }, at);
  const simulated = addFireplace(store, 'simulated', { requestId: 'invented-load-one', kg: 4 }, at);
  assert.equal(retried.id, first.id);
  assert.equal(retried.at, at);
  assert.notEqual(second.id, first.id);
  assert.notEqual(simulated.id, first.id);
  assert.deepEqual(fireplaceEvents(store, 'mqtt').events.map(event => event.kg), [4, 6]);
  assert.equal(fireplaceEvents(store, 'simulated').events.length, 1);
  assert.equal(fireplaceEvents(store, 'providers').events.length, 0);
  assert.throws(() => addFireplace(store, 'mqtt', { requestId: 'invented-load-one', kg: 5 }, at), /Conflicting/);
});

test('fireplace input rejects backdated fields, noninteger amounts, bad IDs, and unavailable streams', t => {
  const store = storeFor(t);
  for (const kg of [null, '4', 1, 11, 2.5, Infinity, NaN])
    assert.throws(() => addFireplace(store, 'mqtt', { requestId: 'invented', kg }, at));
  for (const requestId of [null, '', 'a'.repeat(101), 'contains space', 'line\nbreak'])
    assert.throws(() => addFireplace(store, 'mqtt', { requestId, kg: 4 }, at));
  assert.throws(() => addFireplace(store, 'mqtt', { requestId: 'invented', kg: 4, at: at - 1 }, at));
  assert.throws(() => addFireplace(store, 'offline', { requestId: 'invented', kg: 4 }, at));
  assert.equal(fireplaceView(store, 'offline').available, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM fireplace_events').get().n, 0);
});

test('removal is append-only, effective once, source scoped, and old revisions remain reproducible', t => {
  const store = storeFor(t);
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-load', kg: 4 }, at);
  assert.throws(() => removeFireplace(store, 'simulated', { requestId: 'invented-remove', id: load.id }, at + 1));
  const removal = removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 60_000);
  const retry = removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 120_000);
  const again = removeFireplace(store, 'mqtt', { requestId: 'invented-remove-again', id: load.id }, at + 180_000);
  const againRetry = removeFireplace(store, 'mqtt', { requestId: 'invented-remove-again', id: load.id }, at + 240_000);
  assert.equal(removal.removedAt, retry.removedAt);
  assert.equal(removal.removedAt, again.removedAt);
  assert.equal(removal.removedAt, againRetry.removedAt);
  assert.equal(fireplaceEvents(store, 'mqtt').events.length, 0);
  assert.equal(fireplaceEvents(store, 'mqtt', { revision: load.revision }).events.length, 1);
  assert.equal(fireplaceEvents(store, 'mqtt', { asOf: at }).events.length, 1);
  const rows = store.db.prepare('SELECT kind,kg FROM fireplace_events ORDER BY id').all();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.kind), ['load', 'remove', 'remove']);
  assert.equal(rows[0].kg, 4);
  const view = fireplaceView(store, 'mqtt', { asOf: at + 300_000 });
  assert.equal(view.entries[0].removedAt, removal.removedAt);
  assert.equal(view.lastAt, null, 'A removed firing is not the last firing');
});

test('only journal-affected edits queue a durable rebuild and retries keep its intent', t => {
  const store = storeFor(t);
  const load = addFireplace(store, 'mqtt', { requestId: 'invented-load', kg: 4 }, at);
  assert.equal(load.requiresRebuild, false);
  appendLearningRecord(store, 'mqtt', 'sample', { timestamp: at + 900_000, indoorC: 21, outdoorC: 0 });
  assert.equal(fireplaceView(store, 'mqtt', { asOf: at + 900_000 }).entries[0].requiresRebuild, true);
  const removed = removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 900_001);
  assert.equal(removed.requiresRebuild, true);
  const saved = store.getState('fireplace:rebuild:mqtt');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.revision, removed.revision);
  removeFireplace(store, 'mqtt', { requestId: 'invented-remove', id: load.id }, at + 900_002);
  assert.deepEqual(store.getState('fireplace:rebuild:mqtt'), saved);
});
