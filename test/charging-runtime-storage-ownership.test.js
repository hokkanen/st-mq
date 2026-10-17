import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/storage/store.js';
import { immutableValue } from '../src/domain/immutable.js';
import { readChargingRuntime, writeChargingRuntime } from '../src/charging/runtime-storage.js';

const key = 'charging:simulated', at = 1_800_000_000_000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plan = () => ({ id: 'synthetic-owned-plan', at, periods: [{ startAt: at + 3600_000, endAt: at + 7200_000 }],
  intervals: Array.from({ length: 60 }, (_, i) => ({ start: at + i * 900_000, end: at + (i + 1) * 900_000,
    priceCtPerKwh: i % 10, powerKw: 11, scenarios: Array.from({ length: 24 }, (_, j) => ({
      source: `synthetic-scenario-${j}`, phaseCurrentA: [j / 3, j / 4, j / 5], weight: 1 / 24,
      receivedAt: at, context: { evaluatedAt: at, label: 'synthetic-owned-context' },
    })), reference: { method: 'synthetic-reference', receivedAt: at, oldestAt: at - 86_400_000 } })) });
function fixture(accepted = plan()) {
  return { version: 7, revision: 1,
    chargers: { charger1: { association: 'synthetic-charger', plan: accepted },
      charger2: { association: 'synthetic-peer', plan: null } },
    view: { chargers: [{ id: 'charger1', plan: accepted, forecast: accepted, telemetry: { readAt: at } },
      { id: 'charger2', plan: null, telemetry: { readAt: at } }] } };
}
const rows = store => store.db.prepare('SELECT key,value,updated_at FROM state ORDER BY key').all();
const changes = store => store.db.prepare('SELECT sequence,ordinal,table_name,record_key,payload FROM journal_changes ORDER BY sequence,ordinal').all();
function expectedContent(accepted) {
  // Reference the pre-optimization representation independently, including its
  // property ordering, complete context and original evidence clocks.
  const compact = structuredClone(accepted), context = [];
  compact.intervals = compact.intervals.map((row, index) => {
    const { scenarios, reference, ...value } = row;
    if (scenarios !== undefined || reference !== undefined) context.push({ index,
      ...(scenarios !== undefined ? { scenarios } : {}), ...(reference !== undefined ? { reference } : {}) });
    return value;
  });
  const contextId = digest(context), record = { value: compact, context: contextId };
  return { contextId, context, id: digest(record), record };
}

test('owned plans reuse preparation across aliases and receipts without cloning or rehashing their large graph', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const accepted = immutableValue(plan()), saved = fixture(accepted);
  const nativeClone = structuredClone, stringify = JSON.stringify;
  const calls = { clones: 0, context: 0, plan: 0, meaning: 0 };
  t.mock.method(globalThis, 'structuredClone', (...args) => {
    if (args[0]?.id === accepted.id) calls.clones++;
    return nativeClone(...args);
  });
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (Array.isArray(value) && value[0]?.scenarios) calls.context++;
    if (value?.value?.id === accepted.id) calls.plan++;
    if (value?.id === accepted.id && value.intervals?.[0]?.scenarios) calls.meaning++;
    return stringify(value, ...args);
  });
  writeChargingRuntime(store, key, saved, { at });
  assert.equal(calls.clones, 0);
  assert.equal(calls.meaning, 1, 'One normalized comparison, shared by all aliases');
  const first = { ...calls };
  for (let tick = 1; tick <= 20; tick++) {
    saved.view.chargers[0].telemetry.readAt = at + tick * 1000;
    writeChargingRuntime(store, key, saved, { at: at + tick * 1000, forceView: tick % 5 === 0 });
  }
  assert.deepEqual(calls, first, 'Even a forced view needs no new plan/context cloning or serialization');
  t.mock.restoreAll();
  assert.deepEqual(readChargingRuntime(store, key), { ...saved, view: { ...saved.view, recordedAt: at + 20_000 } });
});

test('owned and mutable plans produce exact prior content IDs, state bytes and journal effects', t => {
  t.mock.method(Date, 'now', () => at);
  const mutable = new Store(':memory:'), owned = new Store(':memory:');
  t.after(() => { mutable.close(); owned.close(); });
  let accepted = plan(), saved = fixture(accepted), frozen = fixture(immutableValue(accepted));
  for (let tick = 0; tick < 4; tick++) {
    if (tick === 2) {
      accepted = structuredClone(accepted); accepted.intervals[0].scenarios[0].weight = .5;
      saved = fixture(accepted); frozen = fixture(immutableValue(accepted));
    }
    saved.view.chargers[0].telemetry.readAt = frozen.view.chargers[0].telemetry.readAt = at + tick * 1000;
    writeChargingRuntime(mutable, key, saved, { at: at + tick * 1000 });
    writeChargingRuntime(owned, key, frozen, { at: at + tick * 1000 });
    assert.deepEqual(rows(owned), rows(mutable));
    assert.deepEqual(changes(owned), changes(mutable));
    const expected = expectedContent(accepted), manifest = owned.getState(key);
    assert.deepEqual(manifest.plans, [expected.id]); assert.deepEqual(manifest.contexts, [expected.contextId]);
    assert.equal(owned.db.prepare('SELECT value FROM state WHERE key=?').get(`${key}:runtime:plan/${expected.id}`).value,
      JSON.stringify(expected.record));
    assert.equal(owned.db.prepare('SELECT value FROM state WHERE key=?').get(`${key}:runtime:context/${expected.contextId}`).value,
      JSON.stringify(expected.context));
  }
});

for (const immutable of [false, true]) {
  test(`nested plan receipt clocks preserve the view fence; substantive changes publish (${immutable ? 'owned' : 'mutable'})`, () => {
    const store = new Store(':memory:');
    try {
      let accepted = plan();
      const candidate = () => fixture(immutable ? immutableValue(accepted) : accepted);
      writeChargingRuntime(store, key, candidate(), { at });
      accepted = structuredClone(accepted);
      accepted.intervals[0].scenarios[0].receivedAt += 1000;
      accepted.intervals[0].scenarios[0].context.evaluatedAt += 1000;
      accepted.intervals[0].reference.receivedAt += 1000;
      writeChargingRuntime(store, key, candidate(), { at: at + 1000 });
      assert.equal(readChargingRuntime(store, key).view.recordedAt, at, 'Recursive receipt stripping is unchanged');
      assert.deepEqual(readChargingRuntime(store, key).chargers.charger1.plan, accepted, 'Durable plan keeps every changed clock');
      accepted.intervals[0].scenarios[0].weight = .25;
      writeChargingRuntime(store, key, candidate(), { at: at + 2000 });
      assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 2000);
      accepted.periods[0].startAt += 60_000;
      writeChargingRuntime(store, key, candidate(), { at: at + 3000 });
      assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 3000);
      assert.deepEqual(readChargingRuntime(store, key).view.chargers[0].plan, accepted);
    } finally { store.close(); }
  });
}

test('changing only ownership cannot publish a view; missing, undefined and null retain their prior distinction', () => {
  const store = new Store(':memory:');
  try {
    const accepted = plan(), saved = fixture(accepted);
    writeChargingRuntime(store, key, saved, { at });
    writeChargingRuntime(store, key, fixture(immutableValue(accepted)), { at: at + 1000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at);
    const absent = fixture(accepted); delete absent.view.chargers[0].forecast;
    writeChargingRuntime(store, key, absent, { at: at + 2000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 2000);
    absent.view.chargers[0].forecast = undefined;
    writeChargingRuntime(store, key, absent, { at: at + 3000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 2000);
    absent.view.chargers[0].forecast = null;
    writeChargingRuntime(store, key, absent, { at: at + 4000 });
    assert.equal(readChargingRuntime(store, key).view.recordedAt, at + 4000);
    assert.equal(readChargingRuntime(store, key).view.chargers[0].forecast, null);
  } finally { store.close(); }
});

test('cached owned preparation survives rollback, collection and reuse in another Store without hiding missing content', t => {
  const store = new Store(':memory:'), other = new Store(':memory:');
  t.after(() => { store.close(); other.close(); });
  const first = fixture(immutableValue(plan()));
  const changed = plan(); changed.intervals[0].scenarios[0].weight = .5;
  const next = fixture(immutableValue(changed));
  writeChargingRuntime(store, key, first, { at });
  const original = rows(store), checkpoint = store.checkpoint();
  assert.throws(() => store.transaction(() => {
    writeChargingRuntime(store, key, next, { at: at + 1000 });
    throw new Error('synthetic rollback');
  }), /synthetic rollback/);
  assert.deepEqual(rows(store), original); assert.deepEqual(store.checkpoint(), checkpoint);
  writeChargingRuntime(store, key, next, { at: at + 2000 });
  const replacement = store.getState(key);
  assert.equal(replacement.plans.length, 1); assert.equal(replacement.contexts.length, 1);
  assert.notEqual(replacement.plans[0], JSON.parse(original.find(row => row.key === key).value).plans[0]);
  writeChargingRuntime(store, key, first, { at: at + 3000 });
  assert.deepEqual(readChargingRuntime(store, key), { ...first, view: { ...first.view, recordedAt: at + 3000 } });
  assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:plan/*'").get().n, 1);
  assert.equal(store.db.prepare("SELECT count(*) n FROM state WHERE key GLOB 'charging:*:runtime:context/*'").get().n, 1);
  writeChargingRuntime(other, key, first, { at: at + 4000 });
  assert.deepEqual(readChargingRuntime(other, key), { ...first, view: { ...first.view, recordedAt: at + 4000 } });
});
