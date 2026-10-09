import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const initial = Date.parse('2026-10-09T10:00:00Z');
const settle = () => new Promise(resolve => setImmediate(resolve));
const teslaRows = [['geofence', 'Home'], ['plugged_in', 'true'], ['healthy', 'true'], ['state', 'online'],
  ['charging_state', 'Stopped'], ['battery_level', '62'], ['charge_limit_soc', '90'],
  ['charger_actual_current', '0'], ['charger_power', '0'], ['charger_voltage', '230'],
  ['charger_phases', '3'], ['charge_current_request', '16'], ['charge_current_request_max', '16']];

async function fixture(t, { populated = true } = {}) {
  const store = new Store(':memory:');
  let now = initial, authority = true;
  const config = { input: 'mqtt', connections: { mqtt: { address: 'mqtt://fixture.invalid' }, teslamate: { enabled: true } } };
  const engine = { clock: () => now };
  const runtime = new ChargingRuntime({ engine, store, config, clock: engine.clock });
  engine.charging = runtime;
  // This test exercises real observation persistence, without numerical worker
  // searches or native equipment. Two ordinary day horizons make its current
  // persisted projection comparable in size to a populated charging runtime.
  runtime.tick = () => {};
  const intervals = Array.from({ length: 96 }, (_, i) => ({ start: initial + i * 900_000,
    end: initial + (i + 1) * 900_000, priceCtPerKwh: 10 + i / 13, powerKw: 11,
    phaseHeadroomA: [16, 16, 16], scenarios: Array.from({ length: 40 }, (_, j) => ({
      weight: 1 / 40, phaseHeadroomA: [15 - j / 43, 14 - j / 47, 13 - j / 53] })) }));
  if (populated) for (const item of Object.values(runtime.chargers)) item.plan = { state: 'waiting', reason: 'economic-pause',
    at: initial, periods: [], intervals: structuredClone(intervals), requiredGridKwh: 20 };
  await store.runWrite(() => runtime.persist());
  const bytes = Buffer.byteLength(JSON.stringify(store.getState(runtime.key)));
  if (populated) assert(bytes > 600_000 && bytes < 2 * 1024 * 1024, `Real runtime projection size: ${bytes}`);
  const client = new EventEmitter();
  client.pending = [];
  client.subscribe = (topic, _options, done) => client.pending.push({ topic, done });
  client.publish = (_topic, _payload, _options, done) => done?.();
  client.end = (_force, _options, done) => done();
  const reader = await startMqtt({ store, engine, config, canControl: () => authority, connect: () => client });
  t.after(async () => { await reader.close({ restore: false }); await runtime.close(); store.close(); });
  const send = (topic, value, packet = {}) => { now++;
    client.emit('message', topic, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), packet);
    return now;
  };
  const ack = () => { for (const { topic, done } of client.pending.splice(0)) done(null, [{ topic, qos: 1 }]); };
  client.emit('connect');
  return { store, runtime, reader, client, send, ack, now: () => now, authority: value => { authority = value; } };
}

for (const source of ['tesla', 'bmw']) test(`${source} buffered startup admits a populated charging runtime one observation at a time`, async t => {
  const f = await fixture(t), commits = [], receipts = [];
  const originalPersist = f.runtime.persistVehicleObservation.bind(f.runtime);
  f.runtime.persistVehicleObservation = now => {
    originalPersist(now);
    f.store.afterCommit(() => commits.push({
      admission: source === 'tesla' ? f.runtime.teslaCapture.reception().admission : f.runtime.vehicleFeeds.bmw.admissionStatus(),
      ready: f.reader.status().brokers.primary.ready,
    }));
  };
  if (source === 'tesla') for (const [field, value] of teslaRows)
    receipts.push(f.send(`teslamate/cars/1/${field}`, value, { retain: field !== 'healthy' }));
  else for (let i = 0; i < 12; i++) receipts.push(f.send('stmq/vehicles/bmw', {
    provider: 'bmw-cardata', readingId: `reading-${i}`, soc: 60 + i, measuredAt: new Date(f.now()).toISOString(),
  }));
  await settle();
  f.ack(); await f.reader.ready();
  assert(commits.length >= 12, 'The complete buffered prefix reached actual runtime persistence');
  assert(commits.every(row => row.admission.pending && !row.ready), 'Partial replay cannot supply live evidence or readiness');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='mqtt-observation-rejected'").get().n, 0);
  if (source === 'tesla') {
    const state = f.runtime.teslaCapture.snapshot();
    assert.equal(state.healthy, true);
    assert.equal(state.fields.battery_level.receivedAt, receipts[5]);
    assert.equal(state.fields.battery_level.retained, true);
    assert.equal(state.fields.healthy.receivedAt, receipts[2]);
  } else {
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.soc, 71);
    assert.equal(f.runtime.vehicleFeeds.bmw.mqtt.lastValidLiveAt, receipts.at(-1));
    assert.equal(f.runtime.vehicleFeeds.bmw.admissionStatus().pending, false);
  }
});

test('a live packet received during replay follows the buffered departure without renewing its clock', async t => {
  const f = await fixture(t, { populated: false });
  const capture = f.runtime.teslaCapture, persisted = [];
  let appendedAt;
  const persist = f.runtime.persistVehicleObservation.bind(f.runtime);
  f.runtime.persistVehicleObservation = now => {
    persist(now);
    f.store.afterCommit(() => {
      persisted.push(capture.snapshot());
      appendedAt ??= f.send('teslamate/cars/1/battery_level', '70');
    });
  };
  f.send('teslamate/cars/1/healthy', 'true');
  f.send('teslamate/cars/1/plugged_in', 'true', { retain: true });
  const departureAt = f.send('teslamate/cars/1/plugged_in', 'false', { retain: true });
  f.ack(); await f.reader.ready();
  assert.equal(persisted.length, 4);
  assert(persisted.every(state => state.healthy === false));
  assert.equal(persisted[2].pluggedIn, false);
  assert.equal(persisted[2].batteryLevel, undefined);
  assert.equal(capture.snapshot().fields.plugged_in.receivedAt, departureAt);
  assert.equal(capture.snapshot().fields.battery_level.receivedAt, appendedAt);
  assert.equal(capture.snapshot().healthy, true);
});

for (const errcode of [10, 13]) test(`failed replay COMMIT (${errcode}) retains earlier observations and requires a fresh subscription`, async t => {
  const f = await fixture(t, { populated: false });
  let count = 0, failCommit = false;
  const persist = f.runtime.persistVehicleObservation.bind(f.runtime), exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => {
    if (failCommit && sql.trim() === 'COMMIT') {
      failCommit = false;
      throw Object.assign(new Error('Synthetic replay commit failure'), { code: 'ERR_SQLITE_ERROR', errcode });
    }
    return exec(sql);
  };
  f.runtime.persistVehicleObservation = now => { persist(now); if (++count === 3) failCommit = true; };
  f.send('teslamate/cars/1/healthy', 'true');
  for (const value of ['60', '61', '62']) f.send('teslamate/cars/1/battery_level', value);
  const rejected = assert.rejects(f.reader.ready(), /subscriptions unavailable/);
  f.ack(); await rejected;
  assert.equal(count, 3, 'The failed packet is not skipped to publish a later packet');
  assert.equal(f.store.getState('charging:teslamate').fields.battery_level.value, 60);
  assert.equal(f.runtime.teslaCapture.snapshot().batteryLevel, 60);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, false);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  f.client.emit('offline'); f.client.emit('connect');
  f.send('teslamate/cars/1/healthy', 'true');
  f.send('teslamate/cars/1/battery_level', '70');
  f.ack(); await f.reader.ready();
  assert.equal(f.runtime.teslaCapture.snapshot().batteryLevel, 70);
  assert.equal(f.runtime.teslaCapture.snapshot().healthy, true);
});

test('a replacement broker generation cannot finish or receive packets from the previous replay', async t => {
  const f = await fixture(t, { populated: false });
  let replaced = false;
  const persist = f.runtime.persistVehicleObservation.bind(f.runtime);
  f.runtime.persistVehicleObservation = now => {
    persist(now);
    f.store.afterCommit(() => {
      if (replaced) return;
      replaced = true;
      f.client.emit('offline'); f.client.emit('connect');
      f.send('teslamate/cars/1/healthy', 'true');
      f.send('teslamate/cars/1/battery_level', '80');
    });
  };
  f.send('teslamate/cars/1/healthy', 'true');
  f.send('teslamate/cars/1/battery_level', '60');
  f.ack();
  for (let i = 0; i < 20 && !replaced; i++) await settle();
  assert.equal(replaced, true);
  assert.equal(f.reader.status().brokers.primary.ready, false);
  assert.equal(f.runtime.teslaCapture.snapshot().batteryLevel, undefined);
  f.ack(); await f.reader.ready();
  assert.equal(f.runtime.teslaCapture.snapshot().batteryLevel, 80);
});
