import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { decodeOpenMeteoCurrent } from '../src/acquisition/openmeteo.js';

const MINUTE = 60_000;
const beginning = Date.parse('2026-09-08T09:00:00Z');

async function setup(t, { input = 'mqtt', maxAgeMs = 5 * MINUTE } = {}) {
  const store = new Store(':memory:');
  let now = beginning;
  const config = { input, settings: { mode: 'shadow' }, deviceId: 'synthetic-h66',
    h66: { maxAgeMs, writeEnabled: false }, connections: { mqtt: { address: 'mqtt://fixture.invalid' } } };
  const engine = new Engine({ store, config, clock: () => now });
  const client = new EventEmitter();
  client.subscribe = (topic, options, done) => done();
  client.publish = (topic, payload, options, done) => {
    assert.equal(topic, 'synthetic-h66/HP/CMD');
    assert.equal(payload, 'GETALL');
    assert.equal(options.retain, false);
    done();
  };
  client.end = (force, options, done) => done();
  const reader = await startMqtt({ engine, store, config, connect: () => client });
  engine.setH66(reader);
  t.after(async () => { await reader.close(); store.close(); });
  const weather = (source, value, sourceTime = now, extra = {}) => engine.ingest({
    source, device: 'synthetic-weather', signal: 'outdoor_temperature', value, unit: 'degC',
    sourceTime, receivedAt: now, quality: [], ...extra,
  });
  const publish = (value, packet = {}, register = '0007') => client.emit('message',
    `synthetic-h66/HP/${register}`, Buffer.from(String(value)), packet);
  client.emit('connect');
  return { engine, store, config, weather, publish, client,
    setTime: value => { now = value; }, get now() { return now; } };
}

for (const input of ['mqtt', 'providers']) test(`${input} current temperature follows H66, FMI, then Open-Meteo across age and recovery`, async t => {
  const r = await setup(t, { input });
  r.weather('fmi', 4, beginning - MINUTE);
  r.weather('openmeteo', 5);
  assert.equal(r.engine.tick().observations.outdoor.source, 'fmi');
  r.publish(3);
  assert.equal(r.engine.status().observations.outdoor.source, 'husdata-h66');
  assert.equal(r.engine.tick().observations.outdoor.value, 3);
  r.setTime(beginning + MINUTE);
  r.weather('fmi', 4.1);
  r.setTime(beginning + 2 * MINUTE);
  r.weather('openmeteo', 5.1);
  assert.equal(r.engine.status().observations.outdoor.value, 3, 'newer weather cannot displace fresh H66');
  r.setTime(beginning + 5 * MINUTE);
  assert.equal(r.engine.status().observations.outdoor.source, 'husdata-h66');
  r.setTime(beginning + 5 * MINUTE + 1);
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi', 'age expiry switches without another provider download');
  assert.equal(r.engine.tick().observations.outdoor.value, 4.1);
  r.setTime(beginning + 31 * MINUTE + 1);
  assert.equal(r.engine.status().observations.outdoor.source, 'openmeteo');
  assert.equal(r.engine.tick().observations.outdoor.value, 5.1);
  r.weather('openmeteo', 5.2);
  r.weather('fmi', 4.2, beginning + 30 * MINUTE);
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi', 'recovered primary can have an older timestamp');
  r.publish(3.2);
  assert.equal(r.engine.tick().observations.outdoor.source, 'husdata-h66');
});

test('retained, invalid and disconnected H66 readings use the current weather fallback until a fresh live reading arrives', async t => {
  const r = await setup(t);
  r.weather('fmi', 4);
  for (const value of ['', 'NaN', 90]) {
    r.publish(value);
    assert.equal(r.engine.status().observations.outdoor.source, 'fmi');
  }
  r.publish(2, { retain: true });
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi');
  r.publish(2);
  assert.equal(r.engine.status().observations.outdoor.source, 'husdata-h66');
  r.publish('NaN');
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi', 'a newly reported sensor error invalidates H66 immediately');
  r.publish(2.1);
  r.client.emit('offline');
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi');
  r.client.emit('connect');
  r.publish(21, {}, '0008');
  r.publish(2.2, { retain: true });
  assert.equal(r.engine.status().observations.outdoor.source, 'fmi', 'other live registers cannot revive an old outdoor reading');
  r.publish(2.3);
  assert.equal(r.engine.status().observations.outdoor.value, 2.3);
});

test('H66 configured freshness is enforced, and explicit unusable observations cannot acquire priority', async t => {
  const r = await setup(t, { maxAgeMs: 2 * MINUTE });
  r.weather('openmeteo', 5);
  r.publish(2);
  r.setTime(beginning + 2 * MINUTE);
  assert.equal(r.engine.status().observations.outdoor.source, 'husdata-h66');
  r.setTime(beginning + 2 * MINUTE + 1);
  assert.equal(r.engine.status().observations.outdoor.source, 'openmeteo');
  r.engine.ingest({ source: 'husdata-h66', device: 'synthetic-h66', signal: 'outdoor_temperature',
    value: 1, unit: 'degC', sourceTime: r.now, receivedAt: r.now, quality: [], raw: { usableForControl: false } });
  assert.equal(r.engine.tick().observations.outdoor.source, 'openmeteo');
});

test('weather caches preserve both fallback sources under H66 and restart does not replay H66 publications', async t => {
  const r = await setup(t);
  r.weather('openmeteo', 5);
  r.weather('fmi', 4, beginning - MINUTE);
  r.publish(2);
  const cached = r.engine.providerObservations();
  assert.deepEqual(cached.map(row => row.source).sort(), ['fmi', 'openmeteo']);
  assert.equal(cached.find(row => row.source === 'fmi').sourceTime, beginning - MINUTE);
  r.store.setState('provider:observations', cached);
  const count = r.store.observations().filter(row => row.signal === 'outdoor_temperature').length;
  const restarted = new Engine({ store: r.store, config: r.config, clock: r.engine.clock });
  assert.equal(restarted.tick().observations.outdoor.source, 'fmi');
  assert.equal(r.store.observations().filter(row => row.signal === 'outdoor_temperature').length, count,
    'cache hydration does not add observation history');
  r.setTime(beginning + 29 * MINUTE + 1);
  assert.equal(restarted.status().observations.outdoor.source, 'openmeteo');
});

test('failed weather downloads retain a fresh FMI observation with its original age', async t => {
  const r = await setup(t);
  r.weather('fmi', 4, beginning - MINUTE);
  r.weather('openmeteo', 5);
  r.weather('fmi', null, null, { quality: ['provider_error', 'missing'] });
  const observation = r.engine.tick().observations.outdoor;
  assert.equal(observation.source, 'fmi');
  assert.equal(observation.value, 4);
  assert.equal(observation.observedAt, beginning - MINUTE);
  assert.equal(observation.stale, false);
});

test('decoded Open-Meteo estimates are usable current fallback and retain provenance through cache restart', async t => {
  const r = await setup(t);
  const [estimate] = decodeOpenMeteoCurrent({ latitude: 60, longitude: 25, utc_offset_seconds: 0,
    current_units: { time: 'unixtime', interval: 'seconds', temperature_2m: '°C' },
    current: { time: (r.now - 5 * MINUTE) / 1000, interval: 900, temperature_2m: -2.5 } }, { fetchedAt: r.now });
  r.engine.ingest(estimate);
  r.engine.ingest({ source: 'smartthings', device: 'synthetic-indoor', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: r.now, receivedAt: r.now, quality: [] });
  const status = r.engine.tick();
  assert.equal(status.observations.outdoor.source, 'openmeteo');
  assert.equal(status.observations.outdoor.stale, false);
  assert.equal(status.observations.outdoor.value, -2.5);
  assert.deepEqual(status.observations.outdoor.quality, ['estimated']);
  r.setTime(beginning + 15 * MINUTE);
  r.engine.tick();
  assert.equal(r.store.learningJournal({ input: 'mqtt' }).at(-1).payload.value.outdoorC, -2.5);
  r.store.setState('provider:observations', r.engine.providerObservations());
  const restarted = new Engine({ store: r.store, config: r.config, clock: r.engine.clock });
  assert.equal(restarted.tick().observations.outdoor.stale, false);
  assert.equal(restarted.status().observations.outdoor.observedAt, estimate.sourceTime);
  r.setTime(beginning + 25 * MINUTE + 1);
  assert.equal(restarted.status().observations.outdoor.stale, true);
});

test('estimated provenance is permitted only for Open-Meteo outdoor temperature and does not hide quality errors', async t => {
  const r = await setup(t);
  r.weather('openmeteo', 5, r.now, { quality: ['estimated', 'invalid_unit'] });
  assert.equal(r.engine.status().observations.outdoor.stale, true);
  r.weather('fmi', 4, r.now, { quality: ['estimated'] });
  assert.equal(r.engine.status().observations.outdoor.stale, true);
  r.engine.ingest({ source: 'openmeteo', device: 'synthetic', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: r.now, receivedAt: r.now, quality: ['estimated'] });
  assert.equal(r.engine.tick().observations.indoor.stale, true);
});

test('all current sources unavailable remains missing for learning even when a temperature forecast exists', async t => {
  const r = await setup(t);
  r.weather('openmeteo', 5, beginning - 31 * MINUTE);
  r.weather('smartthings', 6);
  r.publish(2, { retain: true });
  r.engine.ingest({ source: 'smartthings', device: 'synthetic-indoor', signal: 'indoor_temperature',
    value: 21, unit: 'degC', sourceTime: r.now, receivedAt: r.now, quality: [] });
  r.store.setState('provider:weather', { fetchedAt: r.now, forecast: [{ start: r.now, end: r.now + 60 * MINUTE,
    outdoorC: 7, solarRadiationWm2: 300, fetchedAt: r.now, issuedAt: null, issuedAtBasis: 'fetched-snapshot' }] });
  const status = r.engine.tick();
  assert.equal(status.observations.outdoor.stale, true);
  assert.ok(status.decision.reasons.includes('missing-or-stale-observations'));
  const sample = r.store.learningJournal({ input: 'mqtt' }).at(-1).payload.value;
  assert.equal(sample.outdoorC, null);
  assert.equal(sample.solarRadiationWm2, null, 'A mutable current forecast is not an archived forecast known before this completed window');
  assert.deepEqual(sample.quality, ['unavailable-controller-context', 'missing'],
    'Neither missing outdoor data nor the pre-startup control context can be invented');
});

test('archived mixed-source solar keeps its own provider in forecast versions without minute copies', async t => {
  const r = await setup(t);
  r.weather('fmi', 4);
  const row = { start: r.now, end: r.now + 60 * MINUTE, outdoorC: 4, solarRadiationWm2: 350,
    source: 'fmi', fetchedAt: r.now, issuedAt: r.now - 60 * MINUTE, issuedAtBasis: 'provider-result-time',
    solar: { source: 'openmeteo', issuedAt: null, issuedAtBasis: 'fetched-snapshot', fetchedAt: r.now - MINUTE,
      intervalBasis: 'preceding-hour-mean' } };
  const payload = { source: 'fmi', issuedAt: row.issuedAt, fetchedAt: r.now, forecast: [row] };
  const originalId = r.store.snapshot({ kind: 'weather', source: 'fmi', issuedAt: row.issuedAt, fetchedAt: r.now, payload });
  r.store.setState('provider:weather', payload);
  r.engine.tick();
  assert.equal(r.store.latestObservation('solar_radiation'), null);
  assert.deepEqual(r.store.snapshotById(originalId).payload.forecast[0].solar, row.solar);
  r.setTime(r.now + MINUTE);
  const revised = { source: 'fmi', fetchedAt: r.now,
    forecast: [{ ...row, solar: { intervalBasis: 'hourly-point-held-within-published-horizon' } }] };
  r.store.snapshot({ kind: 'weather', source: 'fmi', issuedAt: row.issuedAt, fetchedAt: r.now, payload: revised });
  r.store.setState('provider:weather', revised);
  r.engine.tick();
  r.setTime(beginning + 15 * MINUTE);
  r.engine.tick();
  const sample = r.store.learningJournal({ input: 'mqtt' }).at(-1).payload.value;
  assert.equal(sample.solarRadiationWm2, 350);
  assert.equal(sample.provenance.forecastVersion.id, originalId, 'Use the version known at the start of the window');
  assert.equal(sample.provenance.forecastVersion.solar[0].source, 'openmeteo');
  assert.equal(sample.provenance.forecastVersion.solar[0].issuedAt, null);
  assert.equal(r.store.latestObservation('solar_radiation'), null);
});

test('live restart discards retired weather runtime state before its first tick and preserves historical snapshots', async t => {
  const r = await setup(t);
  const retired = { source: 'retired-provider', fetchedAt: r.now, issuedAt: null,
    forecast: [{ start: r.now, end: r.now + 60 * MINUTE, outdoorC: 4, solarRadiationWm2: 300,
      source: 'retired-provider', fetchedAt: r.now, issuedAt: null, issuedAtBasis: 'fetched-snapshot' }] };
  r.store.setState('provider:weather', retired);
  const snapshot = r.store.snapshot({ kind: 'weather', source: retired.source, fetchedAt: r.now, issuedAt: null, payload: retired });
  const marketHealth = { source: 'elering', status: 'ok', nextAttemptAt: r.now + 60 * MINUTE };
  r.store.setState('providers:health', { market: marketHealth,
    weather: { source: retired.source, status: 'ok', nextAttemptAt: r.now + 60 * MINUTE },
    outdoor: { source: retired.source, status: 'fallback', nextAttemptAt: r.now + 10 * MINUTE } });
  r.store.setState('provider:observations', [{ source: retired.source, device: 'synthetic', signal: 'outdoor_temperature',
    value: 4, unit: 'degC', sourceTime: r.now, receivedAt: r.now, quality: [] }]);
  const restarted = new Engine({ store: r.store, config: r.config, clock: r.engine.clock });
  assert.equal(r.store.getState('provider:weather'), null);
  assert.deepEqual(r.store.getState('providers:health'), { market: marketHealth });
  const status = restarted.tick();
  assert.deepEqual(status.forecast, []);
  assert.equal(status.observations.outdoor.stale, true);
  assert.equal(r.store.snapshots().find(row => row.id === snapshot).source, retired.source);
});
