import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { copyChargingValue, immutableChargingValue, isImmutableChargingValue } from '../src/charging/immutable.js';

const AT = Date.parse('2026-01-15T00:00:00Z');
const calculation = label => ({ id: label, at: AT, state: 'waiting', feasible: true,
  deadlineAt: AT + 86_400_000, requiredGridKwh: 10, costCents: 50,
  periods: [{ startAt: AT + 3_600_000, endAt: AT + 7_200_000 }],
  intervals: Array.from({ length: 48 }, (_, slot) => ({ start: AT + slot * 900_000,
    end: AT + (slot + 1) * 900_000, priceCtPerKwh: 5, powerKw: 7,
    scenarios: Array.from({ length: 66 }, (_, scenario) => ({
      phaseCurrentA: [scenario / 20, scenario / 20, scenario / 20], weight: 1 / 66,
    })) })) });

async function fixture(t) {
  const store = new Store(':memory:');
  const runtime = new ChargingRuntime({ engine: {}, store, config: { input: 'simulated' }, clock: () => AT });
  t.after(async () => { await runtime.close(); store.close(); });
  for (const item of Object.values(runtime.chargers)) item.controls.enabled = false;
  runtime.refreshSettings();
  runtime.chargers.charger1.plan = calculation('accepted');
  runtime.chargers.charger1.forecast = calculation('forecast');
  runtime.coordination = { priority: 'balanced', allocations: [{ start: AT, end: AT + 900_000, amps: 16 }] };
  runtime.persistAcceptedState(AT);
  return { store, runtime, item: runtime.chargers.charger1 };
}

test('owned calculations detach their producer and remain shared only as deeply immutable snapshots', () => {
  const source = calculation('source'), owned = immutableChargingValue(source);
  assert.notStrictEqual(owned, source);
  source.intervals[0].scenarios[0].phaseCurrentA[0] = 99;
  assert.equal(owned.intervals[0].scenarios[0].phaseCurrentA[0], 0);
  assert.ok(isImmutableChargingValue(owned));
  assert.ok(isImmutableChargingValue(owned.intervals[0].scenarios[0].phaseCurrentA));
  assert.strictEqual(immutableChargingValue(owned), owned);
  const input = { plan: owned, duplicate: owned, request: { overrides: { minimumSoc: 80 } } };
  const copy = copyChargingValue(input);
  assert.strictEqual(copy.plan, owned);
  assert.strictEqual(copy.duplicate, owned);
  copy.request.overrides.minimumSoc = 50;
  assert.equal(input.request.overrides.minimumSoc, 80);
  assert.throws(() => { copy.plan.intervals[0].scenarios[0].phaseCurrentA[0] = 1; }, TypeError);
});

test('a caller shallow-freezing an object cannot grant sharing or freeze its producer descendants', () => {
  const source = Object.freeze({ nested: { value: 1 } });
  assert.equal(isImmutableChargingValue(source), false);
  const copied = copyChargingValue(source), owned = immutableChargingValue(source);
  copied.nested.value = 2; source.nested.value = 3;
  assert.equal(owned.nested.value, 1);
  assert.equal(copied.nested.value, 2);
  assert.equal(Object.isFrozen(source.nested), false);
});

test('selective snapshots preserve cycles, repeated aliases, sparse arrays and own special keys', () => {
  const shared = { value: 1 }, source = { a: shared, b: shared, list: new Array(3) };
  source.self = source; source.list[2] = shared; source.list.extra = shared;
  Object.defineProperty(source, '__proto__', { value: { synthetic: true }, enumerable: true });
  const result = copyChargingValue(source);
  assert.deepEqual(result, structuredClone(source));
  assert.strictEqual(result.a, result.b);
  assert.strictEqual(result.a, result.list.extra);
  assert.strictEqual(result.self, result);
  assert.equal(0 in result.list, false);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  const owned = immutableChargingValue(source);
  assert.strictEqual(owned.self, owned);
  assert.throws(() => { owned.list.extra.value = 2; }, TypeError);
});

test('mutable built-in graphs retain native clone aliases and cannot become owned immutable calculations', () => {
  const owned = immutableChargingValue({ periods: [1, 2] }), date = new Date(AT);
  const source = { owned, date, duplicate: date, map: new Map() };
  source.map.set('parent', source); source.map.set('plan', owned);
  const result = copyChargingValue(source);
  assert.deepEqual(result, structuredClone(source));
  assert.strictEqual(result.date, result.duplicate);
  assert.strictEqual(result.map.get('parent'), result);
  assert.strictEqual(result.map.get('plan'), result.owned);
  assert.notStrictEqual(result.owned, owned);
  assert.throws(() => immutableChargingValue({ date }), /plain immutable data/);
  assert.equal(isImmutableChargingValue(date), false);
  assert.equal(Object.isFrozen(date), false);
});

test('actual runtime views and status detach mutable fields and reuse immutable plans without changing storage', async t => {
  const { runtime, item, store } = await fixture(t), plan = item.plan, forecast = item.forecast;
  const before = store.checkpoint(), saved = readChargingRuntime(store, runtime.key);
  const first = runtime.views()[0], second = runtime.status().chargers[0];
  assert.strictEqual(first.plan, plan); assert.strictEqual(second.plan, plan);
  assert.strictEqual(first.forecast, forecast); assert.strictEqual(second.forecast, forecast);
  first.controls.enabled = true; first.settings.capacityKwh = 1; first.values.powerKw.value = 99;
  assert.equal(item.controls.enabled, false);
  assert.notEqual(runtime.settings.chargers.charger1.capacityKwh, 1);
  assert.notEqual(second.values.powerKw.value, 99);
  assert.throws(() => { first.plan.periods[0].startAt++; }, TypeError);
  assert.deepEqual(store.checkpoint(), before);
  assert.deepEqual(readChargingRuntime(store, runtime.key), saved);
});

test('nested and outer rollback retain immutable calculations but independently restore mutable state', async t => {
  const { runtime, item, store } = await fixture(t), original = item.plan;
  const coordination = runtime.coordination, originalControls = structuredClone(item.controls);
  assert.throws(() => store.transaction(() => {
    runtime.preserveWriteState();
    item.controls.enabled = true;
    item.plan = immutableChargingValue(calculation('outer'));
    const outerPlan = item.plan;
    assert.throws(() => store.transaction(() => {
      runtime.preserveWriteState();
      item.controls.enabled = false; item.plan = immutableChargingValue(calculation('inner'));
      runtime.coordination = immutableChargingValue({ priority: 'charger1' });
      throw new Error('inner rollback');
    }), /inner rollback/);
    assert.strictEqual(item.plan, outerPlan);
    assert.equal(item.controls.enabled, true);
    assert.strictEqual(runtime.coordination, coordination);
    throw new Error('outer rollback');
  }), /outer rollback/);
  assert.strictEqual(item.plan, original);
  assert.strictEqual(runtime.coordination, coordination);
  assert.deepEqual(item.controls, originalControls);
});

test('a failed outer COMMIT cannot publish a new calculation or retain its mutable controls', async t => {
  const { runtime, item, store } = await fixture(t), plan = item.plan;
  const before = readChargingRuntime(store, runtime.key), checkpoint = store.checkpoint();
  const exec = store.db.exec.bind(store.db);
  t.mock.method(store.db, 'exec', sql => {
    if (sql === 'COMMIT') throw Object.assign(new Error('Synthetic full disk'), { code: 'SQLITE_FULL' });
    return exec(sql);
  });
  assert.throws(() => store.transaction(() => {
    runtime.preserveWriteState(); item.plan = calculation('replacement'); item.controls.enabled = true;
    runtime.persistAcceptedState(AT + 1000);
  }), /Synthetic full disk/);
  assert.strictEqual(item.plan, plan);
  assert.equal(item.controls.enabled, false);
  assert.deepEqual(store.checkpoint(), checkpoint);
  assert.deepEqual(readChargingRuntime(store, runtime.key), before);
});
