import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { replicaReadModel } from '../src/app/replica-read-model.js';
import { recordingPolicy } from '../src/domain/recording-policy.js';

const T = Date.UTC(2026, 8, 1), MINUTE = 60_000;
const config = devices => ({ settings: {}, recording: { annualBudgetBytes: 2e9 },
  connections: { equipment: { devices } } });
const caravan = { id: 'caravan', kind: 'metered_switch', label: 'Caravan', protocol: 'mqtt', enabled: true, readings: [] };
const room = { id: 'configured-room', kind: 'temperature', label: 'Room', protocol: 'mqtt', enabled: true,
  temperatureSignal: 'indoor_temperature', readings: [] };
const snapshot = store => ({ store, input: 'mqtt', publication: { sourceAt: T } });

function energy(store, source, end) {
  const observation = { source, device: 'caravan', signal: 'caravan_energy', value: .01, unit: 'kWh',
    sourceTime: end, receivedAt: end, quality: [], raw: { intervalStart: end - MINUTE, intervalEnd: end,
      durationMs: MINUTE, basis: 'meter-counter-delta' } };
  assert.equal(recordingPolicy(observation).recorded, true, 'The growth fixture uses a currently recorded interval');
  return store.observation(observation);
}

function traced(store) {
  const plans = [], rows = [], genericQueries = [];
  const db = new Proxy(store.db, { get(target, key) {
    if (key !== 'prepare') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
    return sql => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(native, method) {
        if (method === 'get') return (...args) => {
          const row = native.get(...args);
          if (sql.includes('AND (? IS NULL OR o.source=?)')) genericQueries.push(args);
          if (sql.includes('FROM observations candidate INDEXED BY observations_equipment_time')) {
            plans.push(target.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => row.detail));
            if (row) rows.push(row);
          }
          return row;
        };
        const value = Reflect.get(native, method); return typeof value === 'function' ? value.bind(native) : value;
      } });
    };
  } });
  const proxy = new Proxy(store, { get(target, key) {
    if (key === 'db') return db;
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { store: proxy, plans, rows, genericQueries };
}

test('replica missing and inactive configured equipment streams skip another recorded protocol archive', t => {
  for (const hasOldStream of [false, true]) {
    const store = new Store(':memory:'); t.after(() => store.close());
    if (hasOldStream) energy(store, 'mqtt-equipment', T - 40_000 * MINUTE);
    let previous = 0;
    for (const count of [1000, 30_000]) {
      for (let offset = previous; offset < count; offset += 64) store.transaction(() => {
        for (let i = offset; i < Math.min(count, offset + 64); i++) energy(store, 'shelly-mqtt', T - (30_001 - i) * MINUTE);
      });
      previous = count;
      const before = store.checkpoint(), reader = traced(store);
      const device = replicaReadModel(snapshot(reader.store), config([caravan])).equipment.devices[0];
      if (hasOldStream) {
        assert.equal(device.readings.caravan_power.value, .6);
        assert.equal(device.readings.caravan_power.source, 'mqtt-equipment');
        assert.equal(device.readings.caravan_power.observedAt, T - 40_000 * MINUTE);
      } else assert.equal(device.readings.caravan_power, undefined);
      assert.equal(reader.rows.filter(row => row.signal === 'caravan_energy').length, hasOldStream ? 1 : 0);
      for (const plan of reader.plans) {
        assert(plan.some(detail => /observations_equipment_time.*source=.*device=.*signal=.*source_time</.test(detail)), plan.join('\n'));
        assert(!plan.some(detail => /SCAN |TEMP B-TREE/.test(detail)), plan.join('\n'));
      }
      assert.deepEqual(store.checkpoint(), before);
    }
  }
});

test('source-only equipment temperatures merge actual device candidates with original clocks and selected membership', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const put = (source, device, value, sourceTime, receivedAt = sourceTime) => store.observation({ source, device,
    signal: 'indoor_temperature', value, unit: 'degC', sourceTime, receivedAt, quality: [], raw: {} });
  put('mqtt-temperature', 'physical-a', 20, T - 4 * MINUTE);
  put('mqtt-temperature', 'physical-b', 21, T - 2 * MINUTE);
  put('mqtt-temperature', 'physical-a', 22, T - 2 * MINUTE);
  put('mqtt-temperature', 'physical-c', 23, T - MINUTE, T + MINUTE);
  put('mqtt-temperature', 'physical-d', 24, T + MINUTE, T - MINUTE);
  put('shelly-mqtt', 'another-protocol', 25, T);
  const excluded = put('mqtt-temperature', 'physical-e', 26, T);
  store.db.prepare("INSERT INTO recovery_exclusions(generation,table_name,record_key) VALUES('original','observations',?)").run(String(excluded));
  const before = store.checkpoint(), reader = traced(store);
  const value = replicaReadModel(snapshot(reader.store), config([room])).equipment.devices[0].readings.indoor_temperature;
  assert.equal(value.value, 22, 'Equal source clocks retain the last admitted row ID across physical devices');
  assert.equal(value.source, 'mqtt-temperature');
  assert.equal(value.observedAt, T - 2 * MINUTE);
  assert.equal(value.snapshotAt, T);
  assert.equal(value.usableForControl, false);
  assert.equal(value.available, false);
  assert(reader.rows.some(row => row.device === 'physical-a' && row.value === 22));
  assert.deepEqual(store.checkpoint(), before);
});

test('absent native provider signals use physical prefixes before another source history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.observation({ source: 'husdata-h66', device: 'heat-pump', signal: 'heating_curve', value: 40,
    unit: '°C', sourceTime: T, receivedAt: T, quality: [], raw: {} });
  let previous = 0;
  for (const count of [1000, 30_000]) {
    for (let offset = previous; offset < count; offset += 64) store.transaction(() => {
      for (let i = offset; i < Math.min(count, offset + 64); i++) store.observation({ source: 'mqtt-temperature',
        device: 'indoor_temperature', signal: 'indoor_temperature', value: 20 + i % 10 / 10, unit: 'degC',
        sourceTime: T - (30_001 - i) * MINUTE, receivedAt: T - (30_001 - i) * MINUTE, quality: [], raw: {} });
    });
    previous = count;
    const before = store.checkpoint(), reader = traced(store);
    replicaReadModel(snapshot(reader.store), config([]));
    assert(!reader.genericQueries.some(args => args[0] === 'indoor_temperature' && args[3] === 'husdata-h66'),
      'An absent native provider stream never starts the residual global source-time scan');
    assert.deepEqual(store.checkpoint(), before);
  }
});
