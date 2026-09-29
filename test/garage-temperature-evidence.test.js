import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { Store } from '../src/storage/store.js';
import { createShellyCapture } from '../src/acquisition/shelly.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';

const start = 1_800_000_000_000, signal = 'garage_temperature';
const reading = (at = start, extra = {}) => ({ source: 'shelly-mqtt', device: 'garage', signal,
  value: 8, unit: 'degC', sourceTime: at, receivedAt: at, quality: [],
  raw: { temperatureRouteSignature: 'invented-original-route' }, ...extra });
const unavailable = (at, reason = 'device-offline', extra = {}) => reading(null, { value: null,
  receivedAt: at, quality: [reason, 'missing', 'unavailable'],
  raw: { timeBasis: 'availability-transition', temperatureRouteSignature: 'invented-original-route' }, ...extra });

function engineFixture(t) {
  const store = new Store(':memory:');
  let now = start;
  const engine = new Engine({ store, clock: () => now,
    config: { input: 'mqtt', automationEnabled: () => false, connections: {} } });
  t.after(async () => {
    await engine.garage.close({ restore: false }); await engine.charging.close();
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  return { store, engine, now: value => { now = value; } };
}

test('the engine retains outage history and cannot turn saved probe history into current protection', async t => {
  const f = engineFixture(t);
  f.engine.ingest(reading()); f.now(start + 30_000); f.engine.ingest(unavailable(start + 30_000));
  assert.equal(f.engine.latest[signal].value, null);
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
  assert.equal(f.engine.garage.status().protection.available, false);
  assert.equal(f.engine.providerObservations().some(row => row.signal === signal), false);
  const restarted = new Engine({ store: f.store, config: f.engine.config, clock: () => start + 30_000 });
  assert.equal(restarted.garage.status().protection.available, false);
  await restarted.garage.close({ restore: false }); await restarted.charging.close();
  await restarted.closeFireplace(); await restarted.executor.close({ restore: false });
  f.now(start + 31_000); f.engine.ingest(reading(start + 31_000, { value: null, quality: ['invalid-temperature'] }));
  assert.equal(f.engine.latest[signal].value, null);
});

test('rejected Shelly notification clocks preserve original Garage reports but never hide a probe fault', t => {
  const f = engineFixture(t), publications = [];
  const settings = equipmentConfiguration({ devices: [{ id: 'garage', kind: 'temperature', connection: 'shelly:invented-garage',
    signal, temperature_id: 100, readings: [{ key: 'front', signal: 'garage_temperature_2',
      component: 'temperature:101', unit: 'degC', required: true }] }] });
  const capture = createShellyCapture({ engine: f.engine, store: f.store, settings,
    publish: async (topic, payload) => { publications.push({ topic, payload: JSON.parse(payload) }); }, readbackTimeoutMs: 100 });
  t.after(() => capture.close());
  capture.setConnected(true);
  const request = publications.find(row => row.payload.method === 'Shelly.GetDeviceInfo').payload;
  capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, src: 'invented-gateway',
    result: { id: 'invented-gateway', gen: 2 } }));
  const notify = (at, components) => capture.receive('invented-garage/events/rpc', JSON.stringify({
    src: 'invented-gateway', method: 'NotifyStatus', params: { ts: at / 1000, ...components } }));
  notify(start, { 'temperature:100': { tC: 8 }, 'temperature:101': { tC: 9 } });
  const before = structuredClone(f.engine.latest), count = f.store.observations().length;
  f.now(start + 10_000); notify(start + 10_004, { 'temperature:100': { tC: 10 } });
  assert.deepEqual(structuredClone(f.engine.latest), before);
  assert.equal(f.store.observations().length, count, 'No invented source outage or new temperature report');
  assert.equal(f.engine.garage.status(start + 119_999).observations.rear.stale, false);
  assert.equal(f.engine.garage.status(start + 120_000).observations.rear.stale, true, 'The original report deadline remains authoritative.');
  f.now(start + 120_010); notify(start + 120_010, { 'temperature:100': { tC: 8 }, 'temperature:101': { tC: 9 } });
  f.now(start + 120_020); notify(start + 120_024, { 'temperature:100': { tC: null } });
  assert.equal(f.engine.latest.garage_temperature_2.sourceTime, start + 120_010);
  assert.equal(f.engine.latest[signal].value, null);
  assert.equal(f.engine.latest.garage_temperature_2.value, 9);
  capture.close();
});

test('failed multi-component Shelly reception rolls back observed state and retries cleanly', t => {
  const f = engineFixture(t), publications = [];
  const settings = equipmentConfiguration({ devices: [{ id: 'garage', kind: 'temperature', connection: 'shelly:invented-garage',
    signal, temperature_id: 100, readings: [{ key: 'front', signal: 'garage_temperature_2',
      component: 'temperature:101', unit: 'degC', required: true }] }] });
  const capture = createShellyCapture({ engine: f.engine, store: f.store, settings,
    publish: async (topic, payload) => { publications.push({ topic, payload: JSON.parse(payload) }); }, readbackTimeoutMs: 100 });
  t.after(() => capture.close());
  capture.setConnected(true);
  const request = publications.find(row => row.payload.method === 'Shelly.GetDeviceInfo').payload;
  capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, src: 'invented-gateway',
    result: { id: 'invented-gateway', gen: 2 } }));
  const notification = at => JSON.stringify({ src: 'invented-gateway', method: 'NotifyStatus',
    params: { ts: at / 1000, 'temperature:100': { id: 100, tC: 8 }, 'temperature:101': { id: 101, tC: 9 } } });
  capture.receive('invented-garage/events/rpc', notification(start));
  const before = f.engine.ingestionCheckpoint(), count = f.store.observations().length;
  const record = f.engine.recorder.record.bind(f.engine.recorder);
  let fail = true;
  t.mock.method(f.engine.recorder, 'record', (observation, options) => {
    if (fail && observation.signal === 'garage_temperature_2') throw new Error('synthetic recorder failure');
    return record(observation, options);
  });
  f.now(start + 30_000);
  assert.throws(() => capture.receive('invented-garage/events/rpc', notification(start + 30_000)), /synthetic recorder failure/);
  assert.deepEqual(f.engine.ingestionCheckpoint(), before);
  assert.equal(f.store.observations().length, count);
  fail = false;
  capture.receive('invented-garage/events/rpc', notification(start + 30_000));
  for (const name of [signal, 'garage_temperature_2'])
    assert.equal(f.engine.latest[name].sourceTime, start + 30_000);
  capture.close();
});
