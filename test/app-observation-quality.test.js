import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { goodQuality } from '../src/control/learning.js';

const MINUTE = 60_000;
const beginning = Date.parse('2026-09-06T09:00:00Z');

function setup(t, { input = 'offline', cached = null } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  if (cached) store.setState('provider:observations', cached);
  let now = beginning;
  const config = { input, settings: { mode: 'shadow', comfort: { maxDropC: 1 } } };
  const engine = new Engine({ store, config, clock: () => now });
  return { store, engine, config, setTime: value => { now = value; } };
}

function reading({ signal = 'indoor_temperature', value = 21, sourceTime = beginning,
  receivedAt = beginning, quality = [], source = 'smartthings' } = {}) {
  return { source, device: 'fixture-house', signal, value, unit: 'degC', sourceTime, receivedAt, quality };
}

test('status and decision use the same 30-minute observation freshness boundary', t => {
  const { engine, setTime } = setup(t);
  engine.ingest(reading());
  engine.ingest(reading({ signal: 'outdoor_temperature', value: 4 }));
  setTime(beginning + 30 * MINUTE);
  const boundary = engine.tick();
  assert.equal(boundary.observations.indoor.stale, false);
  assert.equal(boundary.decision.reasons.includes('missing-or-stale-observations'), false);
  setTime(beginning + 30 * MINUTE + 1);
  assert.equal(engine.status().observations.indoor.stale, true);
  const stale = engine.tick();
  assert.equal(stale.observations.indoor.stale, true);
  assert.ok(stale.decision.reasons.includes('missing-or-stale-observations'));
});

test('a future timestamp cannot pin the current observation against valid recovery', t => {
  const { engine, store, setTime } = setup(t);
  engine.ingest(reading({ value: 27, sourceTime: beginning + 86_400_000, quality: ['future_source_time'] }));
  assert.equal(engine.tick().observations.indoor.stale, true);
  setTime(beginning + MINUTE);
  engine.ingest(reading({ value: 21.2, sourceTime: beginning + MINUTE, receivedAt: beginning + MINUTE }));
  const status = engine.status();
  assert.equal(status.observations.indoor.value, 21.2);
  assert.equal(status.observations.indoor.observedAt, beginning + MINUTE);
  assert.equal(status.observations.indoor.stale, false);
  assert.equal(store.observations().length, 2);
});

test('future-dated readings cannot replace an established valid current value even without a quality flag', t => {
  const { engine } = setup(t);
  engine.ingest(reading());
  engine.ingest(reading({ value: 27, sourceTime: beginning + 86_400_000 }));
  assert.equal(engine.tick().observations.indoor.value, 21);
  assert.equal(engine.status().observations.indoor.stale, false);
});

test('null provider outages retain the last valid value and original age, with separate provider health', t => {
  const { engine, store, setTime } = setup(t);
  engine.ingest(reading());
  setTime(beginning + 5 * MINUTE);
  engine.ingest(reading({ value: null, sourceTime: null, receivedAt: beginning + 5 * MINUTE,
    quality: ['provider_error', 'missing', 'source_time_unknown'] }));
  store.setState('providers:health', { smartthings: { status: 'error' } });
  const recent = engine.tick();
  assert.equal(recent.observations.indoor.value, 21);
  assert.equal(recent.observations.indoor.observedAt, beginning);
  assert.equal(recent.observations.indoor.stale, false);
  assert.equal(recent.providers.smartthings.status, 'error');
  setTime(beginning + 31 * MINUTE);
  assert.equal(engine.status().observations.indoor.value, 21);
  assert.equal(engine.status().observations.indoor.stale, true);
  assert.equal(store.observations().at(-1).value, null);
});

test('late deliveries and invalid quality do not displace the latest trustworthy observation', t => {
  const { engine, setTime } = setup(t);
  setTime(beginning + 10 * MINUTE);
  engine.ingest(reading({ value: 21.4, sourceTime: beginning + 10 * MINUTE }));
  engine.ingest(reading({ value: 20, sourceTime: beginning, receivedAt: beginning + 10 * MINUTE }));
  engine.ingest(reading({ value: 99, sourceTime: beginning + 10 * MINUTE, quality: ['implausible_temperature'] }));
  assert.equal(engine.tick().observations.indoor.value, 21.4);
});

test('fresh timestamps alone cannot make suspect or implausible temperatures appear valid', t => {
  for (const observation of [reading({ quality: ['invalid_unit'] }), reading({ value: 0 }),
    reading({ signal: 'outdoor_temperature', value: 65 })]) {
    const { engine } = setup(t);
    engine.ingest(observation);
    const key = observation.signal === 'indoor_temperature' ? 'indoor' : 'outdoor';
    assert.equal(engine.tick().observations[key].stale, true);
  }
});

test('verified Fahrenheit conversion is a benign provenance flag, with other errors still excluded', t => {
  assert.equal(goodQuality(['converted_fahrenheit']), true);
  assert.equal(goodQuality(['converted_fahrenheit', 'stale']), false);
  const { engine } = setup(t);
  engine.ingest(reading({ value: 21, quality: ['converted_fahrenheit'] }));
  engine.ingest(reading({ signal: 'outdoor_temperature', value: 4 }));
  const status = engine.tick();
  assert.equal(status.observations.indoor.stale, false);
  assert.equal(status.decision.reasons.includes('missing-or-stale-observations'), false);
});

test('provider restart hydrates bounded cached observations without freshening or duplicating history', t => {
  const cached = [reading({ sourceTime: beginning - 20 * MINUTE, receivedAt: beginning - 19 * MINUTE }),
    reading({ signal: 'outdoor_temperature', value: 4, sourceTime: beginning - 40 * MINUTE }),
    reading({ value: 28, sourceTime: beginning + 86_400_000, quality: ['future_source_time'] }),
    reading({ value: null, sourceTime: null, quality: ['provider_error', 'missing'] })];
  const { engine, store, config, setTime } = setup(t, { input: 'providers', cached });
  const status = engine.tick();
  assert.equal(status.observations.indoor.value, 21);
  assert.equal(status.observations.indoor.observedAt, beginning - 20 * MINUTE);
  assert.equal(status.observations.indoor.stale, false);
  assert.equal(status.observations.outdoor.stale, true);
  assert.equal(store.observations().filter(o=>['smartthings','fmi','openmeteo','easee'].includes(o.source)).length, 0);
  assert.deepEqual(store.getState('provider:observations'), cached);
  setTime(beginning + 11 * MINUTE);
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.tick().observations.indoor.stale, true);
  assert.equal(restarted.status().observations.indoor.observedAt, beginning - 20 * MINUTE);
});

test('a corrupt provider observation cache cannot prevent conservative startup', t => {
  const { store, config, engine } = setup(t, { input: 'providers' });
  store.db.prepare('INSERT INTO state (key,value,updated_at) VALUES (?,?,?)').run('provider:observations', '{broken', beginning);
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.tick().decision.action, 'normal');
  assert.equal(restarted.status().observations.indoor.stale, true);
});

test('current-not-energy provenance does not discard a valid current snapshot during an outage', t => {
  const { engine } = setup(t);
  engine.ingest({ ...reading({ source: 'easee', signal: 'ev1_current_l1', value: 12,
    quality: ['current_snapshot_not_energy'] }), unit: 'A' });
  engine.ingest({ ...reading({ source: 'easee', signal: 'ev1_current_l1', value: null,
    sourceTime: null, receivedAt: beginning + MINUTE, quality: ['current_snapshot_not_energy', 'provider_error', 'missing'] }), unit: 'A' });
  assert.equal(engine.latest.ev1_current_l1.value, 12);
  assert.equal(engine.latest.ev1_current_l1.sourceTime, beginning);
  assert.deepEqual(engine.latest.ev1_current_l1.quality, ['current_snapshot_not_energy']);
});
