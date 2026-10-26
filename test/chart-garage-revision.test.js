import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { garageIntentRevision } from '../src/app/chart-query-context.js';
import { validateGarageIntent } from '../src/garage/intent-history.js';

const intent = (input, at) => validateGarageIntent({ version: 1, input, enabled: true,
  adapterKey: 'b'.repeat(64), targetIdentity: 'a'.repeat(64), selection: { mode: 'normal',
    normalTargetC: 10, awayTargetC: 5, selectedAt: at, basis: 'dashboard-selection' } });

const original = (store, input, at) => store.db.prepare(`SELECT MAX(id) revision FROM active_events
  WHERE type='garage-intent' AND at<=? AND json_extract(payload,'$.input')=?`).get(at, input).revision;

test('current Garage chart version probes one latest intent across growing event archives', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const insert = store.db.prepare("INSERT INTO events(type,payload,at) VALUES('garage-intent',?,?)");
  let previous = 0;
  for (const count of [1000, 30_000]) {
    for (let offset = previous; offset < count; offset += 64) store.transaction(() => {
      for (let i = offset; i < Math.min(count, offset + 64); i++) insert.run(JSON.stringify(intent('providers', i)), i);
    });
    previous = count;
    const calls = [], reader = { prepare(sql) {
      const statement = store.db.prepare(sql);
      return { get(...params) {
        calls.push(store.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => row.detail));
        return statement.get(...params);
      } };
    } };
    assert.equal(garageIntentRevision(reader, 'providers', count), original(store, 'providers', count));
    assert.equal(calls.length, 1, 'The eligible latest ID proves the exact revision without aggregating its older prefix');
    assert(calls[0].some(detail => /events_type_id.*type=/.test(detail)), calls[0].join('\n'));
    assert(!calls[0].some(detail => /TEMP B-TREE/.test(detail)), calls[0].join('\n'));
  }
});

test('Garage version retains exact selected MAX identity through old cutoffs, mixed inputs and clock rollback', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const add = (input, at) => store.event('garage-intent', intent(input, at), at);
  add('providers', 100);
  add('providers', 20);
  add('mqtt', 30);
  add('providers', 1000);
  const excluded = add('providers', 10);
  store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','events',?)").run(String(excluded));
  for (const input of ['providers', 'mqtt', 'simulated', 'offline']) {
    for (const at of [0, 10, 20, 30, 99, 100, 1000]) {
      assert.equal(garageIntentRevision(store.db, input, at), original(store, input, at), `${input} at ${at}`);
    }
  }
});
