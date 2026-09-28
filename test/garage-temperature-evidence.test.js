import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberGarageTemperature, garageTemperatureEvidence } from '../src/garage/temperature-evidence.js';
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

for (const reason of ['device-offline', 'mqtt-disconnected']) test(`${reason} preserves only the unused measurement deadline`, () => {
  const cache = {}, original = reading();
  rememberGarageTemperature(cache, original, start);
  rememberGarageTemperature(cache, unavailable(start + 30_000, reason), start + 30_000);
  const held = garageTemperatureEvidence(cache, signal, start + 119_999);
  assert.equal(held.usable, true); assert.equal(held.held, true);
  assert.strictEqual(held.observation, original);
  assert.equal(held.expiresAt, start + 120_000);
  rememberGarageTemperature(cache, unavailable(start + 119_999, reason), start + 119_999);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 120_000).usable, false);
  assert.equal(original.sourceTime, start);
});

test('silent loss expires at exactly 120 seconds and repeated cached reports cannot renew it', () => {
  const cache = {};
  rememberGarageTemperature(cache, reading(), start);
  rememberGarageTemperature(cache, reading(start, { receivedAt: start + 119_000 }), start + 119_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 119_999).usable, true);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 120_000).usable, false);
  assert.equal(cache[signal].observation.receivedAt, start);
});

test('reconnection needs a genuinely newer measurement from after the outage', () => {
  const cache = {};
  rememberGarageTemperature(cache, reading(), start);
  rememberGarageTemperature(cache, unavailable(start + 30_000), start + 30_000);
  rememberGarageTemperature(cache, reading(start, { receivedAt: start + 31_000 }), start + 31_000);
  rememberGarageTemperature(cache, reading(start + 20_000, { receivedAt: start + 32_000 }), start + 32_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 32_000).held, true);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 32_000).expiresAt, start + 120_000);
  rememberGarageTemperature(cache, reading(start + 40_000), start + 40_000);
  const recovered = garageTemperatureEvidence(cache, signal, start + 40_000);
  assert.equal(recovered.usable, true); assert.equal(recovered.held, false);
  assert.equal(recovered.expiresAt, start + 160_000);
});

for (const invalid of [
  reading(start + 30_000, { value: null, quality: ['invalid-temperature'] }),
  reading(start + 500_000, { receivedAt: start + 30_000, quality: ['future_source_time'] }),
  unavailable(start + 30_000, 'device-offline', { quality: ['device-offline', 'device-error'] }),
  unavailable(start + 30_000, 'mqtt-subscription-failed'),
  unavailable(start + 500_000, 'device-offline'),
]) test(`invalid evidence (${invalid.quality.join(', ')}) revokes holding and cannot be undone by latest replay`, () => {
  const cache = {}, original = reading();
  rememberGarageTemperature(cache, original, start);
  rememberGarageTemperature(cache, invalid, start + 30_000);
  rememberGarageTemperature(cache, original, start + 31_000);
  rememberGarageTemperature(cache, unavailable(start + 32_000), start + 32_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 32_000).usable, false);
  rememberGarageTemperature(cache, reading(start + 20_000, { receivedAt: start + 33_000 }), start + 33_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 33_000).usable, false);
  rememberGarageTemperature(cache, reading(start + 40_000), start + 40_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 40_000).usable, true);
});

test('a native identity change revokes the held source until new-source measurement arrives', () => {
  const cache = {}, changed = { temperatureRouteSignature: 'invented-replacement-route' };
  rememberGarageTemperature(cache, reading(), start);
  rememberGarageTemperature(cache, unavailable(start + 30_000), start + 30_000);
  rememberGarageTemperature(cache, unavailable(start + 31_000, 'sensor-identity-changed', {
    raw: { ...changed, timeBasis: 'availability-transition' } }), start + 31_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 31_000).usable, false);
  rememberGarageTemperature(cache, reading(start, { receivedAt: start + 32_000, raw: changed }), start + 32_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 32_000).usable, false);
  rememberGarageTemperature(cache, reading(start + 40_000, { raw: changed }), start + 40_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 40_000).usable, true);
});

test('sensor-change boundaries fence held reports even if a correction is later reverted', () => {
  const cache = {};
  rememberGarageTemperature(cache, reading(), start);
  rememberGarageTemperature(cache, unavailable(start + 30_000), start + 30_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 40_000, { notBefore: start + 35_000 }).usable, false);
  rememberGarageTemperature(cache, reading(start, { receivedAt: start + 41_000 }), start + 41_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 41_000).usable, false);
  rememberGarageTemperature(cache, reading(start + 42_000), start + 42_000);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 42_000).usable, true);
});

test('retained and unrelated-source failures cannot grant or refresh control evidence', () => {
  const cache = {};
  rememberGarageTemperature(cache, reading(start, { raw: { retained: true } }), start);
  assert.equal(garageTemperatureEvidence(cache, signal, start).usable, false);
  rememberGarageTemperature(cache, reading(), start);
  rememberGarageTemperature(cache, unavailable(start - 1, 'device-offline', { device: 'other-fixture' }), start + 1);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 1).usable, true);
  rememberGarageTemperature(cache, reading(start - 1, { value: null, quality: ['invalid-temperature'], receivedAt: start + 2 }), start + 2);
  assert.equal(garageTemperatureEvidence(cache, signal, start + 2).usable, true);
});

function engineFixture(t) {
  const store = new Store(':memory:');
  let now = start;
  const engine = new Engine({ store, clock: () => now,
    config: { input: 'mqtt', settings: { mode: 'shadow' }, connections: {} } });
  t.after(async () => {
    await engine.garage.close({ restore: false }); await engine.charging.close();
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close();
  });
  return { store, engine, now: value => { now = value; } };
}

test('the engine retains outage history and unavailable latest separately from ephemeral control evidence', async t => {
  const f = engineFixture(t);
  f.engine.ingest(reading()); f.now(start + 30_000); f.engine.ingest(unavailable(start + 30_000));
  assert.equal(f.engine.latest[signal].value, null);
  assert.equal(f.store.observations({ signal }).at(-1).value, null);
  assert.equal(garageTemperatureEvidence(f.engine.garageTemperatureEvidence, signal, start + 30_000).held, true);
  assert.equal(f.engine.providerObservations().some(row => row.signal === signal), false);
  const restarted = new Engine({ store: f.store, config: f.engine.config, clock: () => start + 30_000 });
  assert.equal(garageTemperatureEvidence(restarted.garageTemperatureEvidence, signal, start + 30_000).usable, false,
    'A new engine does not seed control evidence from stored temperatures');
  await restarted.garage.close({ restore: false }); await restarted.charging.close();
  await restarted.closeFireplace(); await restarted.executor.close({ restore: false });
  f.now(start + 31_000); f.engine.ingest(reading(start + 31_000, { value: null, quality: ['invalid-temperature'] }));
  assert.equal(garageTemperatureEvidence(f.engine.garageTemperatureEvidence, signal, start + 31_000).usable, false);
});

test('rejected Shelly notification clocks preserve bounded Garage evidence but never hide a probe fault', t => {
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
  const before = structuredClone(f.engine.garageTemperatureEvidence), count = f.store.observations().length;
  f.now(start + 10_000); notify(start + 10_004, { 'temperature:100': { tC: 10 } });
  assert.deepEqual(structuredClone(f.engine.garageTemperatureEvidence), before);
  assert.equal(f.store.observations().length, count, 'No invented source outage or new temperature report');
  for (const name of [signal, 'garage_temperature_2']) {
    const evidence = garageTemperatureEvidence(f.engine.garageTemperatureEvidence, name, start + 119_999);
    assert.equal(evidence.usable, true); assert.equal(evidence.held, false);
    assert.equal(evidence.expiresAt, start + 120_000);
    assert.equal(garageTemperatureEvidence(f.engine.garageTemperatureEvidence, name, start + 120_000).usable, false);
  }
  f.now(start + 120_010); notify(start + 120_010, { 'temperature:100': { tC: 8 }, 'temperature:101': { tC: 9 } });
  f.now(start + 120_020); notify(start + 120_024, { 'temperature:100': { tC: null } });
  assert.equal(garageTemperatureEvidence(f.engine.garageTemperatureEvidence, signal, start + 120_020).usable, false);
  const front = garageTemperatureEvidence(f.engine.garageTemperatureEvidence, 'garage_temperature_2', start + 120_020);
  assert.equal(front.usable, true); assert.equal(front.expiresAt, start + 240_010);
  assert.equal(f.engine.latest[signal].value, null);
  assert.equal(f.engine.latest.garage_temperature_2.value, 9);
  capture.close();
});

test('failed multi-component Shelly reception rolls back the control-only cache and retries cleanly', t => {
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
    assert.equal(garageTemperatureEvidence(f.engine.garageTemperatureEvidence, name, start + 30_000).observation.sourceTime, start + 30_000);
  capture.close();
});
