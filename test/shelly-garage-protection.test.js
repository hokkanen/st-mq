import test from 'node:test';
import assert from 'node:assert/strict';
import { createShellyCapture } from '../src/acquisition/shelly.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';

const start = Date.parse('2026-09-15T12:00:00Z');
function fixture(t, pollIntervalMs) {
  let now = start;
  const observations = [], publications = [];
  const temperature = (id, signal) => ({ id, kind: 'temperature', connection: `shelly:invented/${id}`, signal, temperature_id: 100 });
  const settings = equipmentConfiguration({ poll_seconds: pollIntervalMs / 1000, max_age_seconds: 900, devices: [
    temperature('rear', 'garage_temperature'),
    { id: 'front', kind: 'switch', connection: 'shelly:invented/front', readings: [{ key: 'front_probe', signal: 'garage_temperature_2', label: 'Front probe', unit: 'degC', component: 'temperature:101' }] },
    temperature('home', 'indoor_temperature'),
  ] });
  const capture = createShellyCapture({ settings, store: {}, engine: {
    clock: () => now, ingest: row => observations.push(row),
  }, publish: async (topic, payload) => publications.push({ topic, payload: JSON.parse(payload), at: now }) });
  t.after(() => capture.close());
  const status = (id, result) => {
    const identity = publications.findLast(row => row.topic === `invented/${id}/rpc` && row.payload.method === 'Shelly.GetDeviceInfo')?.payload;
    if (identity) capture.receive(`${identity.src}/rpc`, JSON.stringify({ id: identity.id, dst: identity.src, src: `fixture-${id}`, result: { id: `fixture-${id}`, gen: 2 } }), {}, now);
    const request = publications.findLast(row => row.topic === `invented/${id}/rpc` && row.payload.method === 'Shelly.GetStatus').payload;
    const current = structuredClone(result);
    for (const [key, value] of Object.entries(current)) if (/^[a-z]+:\d+$/.test(key)) value.id ??= Number(key.split(':')[1]);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, src: `fixture-${id}`, result: current }), {}, now);
  };
  return { capture, observations, publications, status,
    advance: elapsed => { now = start + elapsed; capture.tick(now); } };
}

test('garage primary and custom probe mappings keep a fixed cadence without retiming other Shellys', async t => {
  for (const configured of [5_000, 120_000]) await t.test(`other devices use ${configured / 1000} seconds`, t => {
    const f = fixture(t, configured); f.capture.setConnected(true);
    f.status('rear', { 'temperature:100': { tC: 6 } });
    f.status('front', { 'switch:0': { output: false }, 'temperature:101': { tC: 6 } });
    f.status('home', { 'temperature:100': { tC: 20 } });
    for (let elapsed = 5_000; elapsed <= 120_000; elapsed += 5_000) f.advance(elapsed);
    const polls = id => f.publications.filter(row => row.topic === `invented/${id}/rpc` && row.payload.method === 'Shelly.GetStatus')
      .map(row => row.at - start);
    assert.deepEqual(polls('rear'), [0, 0, 30_000, 60_000, 90_000, 120_000]);
    assert.deepEqual(polls('front'), polls('rear'));
    assert.deepEqual(polls('home'), [0, ...Array.from({ length: 120_000 / configured + 1 }, (_, i) => i * configured)]);
    for (const signal of ['garage_temperature', 'garage_temperature_2']) {
      const row = f.observations.find(row => row.signal === signal && row.value !== null);
      assert.equal(row.raw.reportIntervalMs, 30_000);
      assert.equal(row.raw.reportGraceMs, 90_000);
    }
    assert.equal(f.observations.find(row => row.signal === 'indoor_temperature').raw.reportIntervalMs, configured);
    assert.equal(f.capture.status().devices.find(row => row.id === 'rear').readings.garage_temperature.stale, true);
    assert.equal(f.capture.status().devices.find(row => row.id === 'home').readings.indoor_temperature.stale, false);
  });
});

test('unchanged valid status replies refresh each probe while omitted or errored components cannot', t => {
  const f = fixture(t, 120_000); f.capture.setConnected(true);
  const rear = { 'temperature:100': { tC: 6 } };
  const front = { 'switch:0': { output: false }, 'temperature:101': { tC: 6 } };
  f.status('rear', rear); f.status('front', front);
  f.advance(30_000); f.status('rear', rear); f.status('front', front);
  for (const signal of ['garage_temperature', 'garage_temperature_2'])
    assert.deepEqual(f.observations.filter(row => row.signal === signal && row.value === 6).map(row => row.sourceTime), [start, start + 30_000]);

  f.advance(60_000); f.status('rear', rear); f.status('front', { 'switch:0': { output: false } });
  let reading = f.capture.status().devices.find(row => row.id === 'front').readings.garage_temperature_2;
  assert.equal(reading.value, null); assert.equal(reading.stale, true);
  f.advance(90_000);
  f.capture.receive('invented/front/status/switch:0', '{"id":0,"output":false}');
  reading = f.capture.status().devices.find(row => row.id === 'front').readings.garage_temperature_2;
  assert.equal(reading.value, null); assert.equal(reading.observedAt, start + 60_000);
  f.status('front', { ...front, 'temperature:101': { tC: 6, errors: ['read'] } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature_2').value, null);
  f.status('rear', { 'temperature:100': { tC: 6, errors: ['read'] } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, null);
  assert.equal(f.observations.filter(row => row.signal === 'garage_temperature_2' && row.value === 6).at(-1).sourceTime, start + 30_000);
});
