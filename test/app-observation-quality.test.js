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
  receivedAt = beginning, quality = [], source = signal === 'outdoor_temperature' ? 'fmi' : 'mqtt-temperature' } = {}) {
  return { source, device: 'fixture-house', signal, value, unit: 'degC', sourceTime, receivedAt, quality };
}

test('offline startup restores all three indoor readings for the configured average without freshening history', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const rows = [['upstairs', 'indoor_temperature', 24], ['downstairs', 'downstairs_temperature', 20],
    ['bedroom', 'bedroom_temperature', 19], ['garage', 'garage_temperature', 12],
    ['outdoor', 'outdoor_temperature', 4]];
  for (const [, signal, value] of rows) store.observation(reading({ signal, value,
    sourceTime: beginning - MINUTE, receivedAt: beginning - MINUTE }));
  let now = beginning;
  const engine = new Engine({ store, config: { input: 'offline', control: {
    indoorSensorWeights: { indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1 },
  } }, clock: () => now });
  const observations = engine.status().observations;
  for (const [key, , value] of rows) {
    assert.equal(observations[key].value, value);
    assert.equal(observations[key].observedAt, beginning - MINUTE);
    assert.equal(observations[key].stale, false);
  }
  assert.equal(observations.indoor.value, 21);
  assert.equal(observations.indoor.source, 'indoor-average');
  assert.equal(observations.indoor.stale, false);
  now += 30 * MINUTE;
  const stale = engine.status().observations;
  assert.equal(stale.indoor.stale, false);
  assert.equal(stale.indoor.observedAt, beginning - MINUTE);
  for (const [key] of rows) assert.equal(stale[key].stale, key === 'outdoor');
  now = beginning + 2 * 60 * MINUTE;
  const attention = engine.status().observations;
  assert.equal(attention.indoor.value, 21);
  assert.equal(attention.indoor.stale, false);
  assert.equal(attention.indoor.needsAttention, true);
  assert.equal(attention.indoor.attentionSensors.length, 3);
  assert.equal(store.observations().length, rows.length);
});

test('garage status projects the existing reading and source without exposing device data or creating history', t => {
  const { engine, store, setTime } = setup(t, { input: 'mqtt' });
  assert.deepEqual(engine.tick().observations.garage, { value: null, stale: true });
  const observation = reading({ signal: 'garage_temperature', value: 16, source: 'mqtt-temperature' });
  engine.ingest(observation);
  const recorded = store.observations().length;
  const expected = { value: 16, observedAt: beginning, quality: [], source: 'mqtt-temperature', stale: false };
  assert.deepEqual(engine.status().observations.garage, expected);
  assert.deepEqual(engine.tick().observations.garage, expected);
  assert.equal(store.observations().length, recorded);
  setTime(beginning + 31 * MINUTE);
  assert.deepEqual(engine.status().observations.garage, expected);
  setTime(beginning + 2 * 60 * MINUTE);
  assert.deepEqual(engine.status().observations.garage, expected);
  setTime(beginning + 2 * 60 * MINUTE + 1);
  assert.deepEqual(engine.status().observations.garage, { ...expected, needsAttention: true,
    attentionReasons: ['old-reading'], held: true });
});

test('outdoor retains its 30-minute expiry while indoor readings remain usable', t => {
  const { engine, setTime } = setup(t);
  engine.ingest(reading());
  engine.ingest(reading({ signal: 'outdoor_temperature', value: 4 }));
  setTime(beginning + 30 * MINUTE);
  const boundary = engine.tick();
  assert.equal(boundary.observations.indoor.stale, false);
  assert.equal(boundary.decision.reasons.includes('missing-or-stale-observations'), false);
  setTime(beginning + 30 * MINUTE + 1);
  assert.equal(engine.status().observations.indoor.stale, false);
  const stale = engine.tick();
  assert.equal(stale.observations.indoor.stale, false);
  assert.equal(stale.observations.outdoor.stale, true);
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
  store.setState('providers:health', { fmi: { status: 'error' } });
  const recent = engine.tick();
  assert.equal(recent.observations.indoor.value, 21);
  assert.equal(recent.observations.indoor.observedAt, beginning);
  assert.equal(recent.observations.indoor.stale, false);
  assert.equal(recent.providers.fmi.status, 'error');
  setTime(beginning + 31 * MINUTE);
  assert.equal(engine.status().observations.indoor.value, 21);
  assert.equal(engine.status().observations.indoor.stale, false);
  assert.equal(engine.status().observations.indoor.needsAttention, true);
  assert.equal(store.observations().at(-1).value, null);
});

test('late deliveries and invalid quality do not displace the latest trustworthy observation', t => {
  const { engine, setTime } = setup(t);
  setTime(beginning + 10 * MINUTE);
  engine.ingest(reading({ value: 21.4, sourceTime: beginning + 10 * MINUTE, receivedAt: beginning + 10 * MINUTE }));
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

test('provider restart hydrates bounded weather observations without freshening or duplicating history', t => {
  const cached = [reading({ signal: 'outdoor_temperature', value: 4, sourceTime: beginning - 20 * MINUTE, receivedAt: beginning - 19 * MINUTE }),
    reading({ signal: 'outdoor_temperature', source: 'openmeteo', value: 3, sourceTime: beginning - 40 * MINUTE }),
    reading({ signal: 'outdoor_temperature', value: 28, sourceTime: beginning + 86_400_000, quality: ['future_source_time'] }),
    reading({ signal: 'outdoor_temperature', value: null, sourceTime: null, quality: ['provider_error', 'missing'] }),
    reading()];
  const { engine, store, config, setTime } = setup(t, { input: 'providers', cached });
  const status = engine.tick();
  assert.equal(status.observations.outdoor.value, 4);
  assert.equal(status.observations.outdoor.observedAt, beginning - 20 * MINUTE);
  assert.equal(status.observations.outdoor.stale, false);
  assert.equal(status.observations.indoor.value, null, 'Cached MQTT packets cannot establish availability in a new broker session');
  assert.equal(store.observations().filter(o=>['mqtt-temperature','fmi','openmeteo','easee'].includes(o.source)).length, 0);
  assert.deepEqual(store.getState('provider:observations'), cached);
  setTime(beginning + 11 * MINUTE);
  const restarted = new Engine({ store, config, clock: engine.clock });
  assert.equal(restarted.tick().observations.outdoor.stale, true);
  assert.equal(restarted.status().observations.outdoor.observedAt, beginning - 20 * MINUTE);
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

for (const source of ['mqtt-temperature', 'husdata-h66']) test(`${source} outages retain genuine indoor and garage values with a warning until recovery`, t => {
  const { engine, setTime } = setup(t, { input: 'mqtt' });
  engine.ingest(reading({ signal: 'outdoor_temperature', value: 4 }));
  const disconnectedAt = beginning + MINUTE;
  for (const signal of ['indoor_temperature', 'garage_temperature']) {
    const device = source === 'mqtt-temperature' ? signal : 'invented-gateway';
    engine.ingest({ ...reading({ source, signal }), device, raw: { usableForControl: true } });
    setTime(disconnectedAt);
    engine.rememberObservation({ ...reading({ source, signal, value: null, sourceTime: null,
      receivedAt: disconnectedAt, quality: ['mqtt-disconnected'] }), device,
      raw: { usableForControl: false, timeBasis: 'availability-transition' } }, disconnectedAt);
    assert.equal(engine.latest[signal].value, null);
    const retained = engine.status().observations[signal === 'indoor_temperature' ? 'indoor' : 'garage'];
    assert.equal(retained.stale, false);
    assert.equal(retained.value, 21);
    assert.equal(retained.observedAt, beginning);
    assert.equal(retained.needsAttention, true);
    if (signal === 'indoor_temperature') {
      assert.equal(engine.status().observations.indoor.stale, false);
      assert.equal(engine.tick().decision.reasons.includes('missing-or-stale-observations'), false);
    }
    // A late pre-outage publication and retained reconnect data cannot revive it.
    for (const [sourceTime, raw, quality] of [[beginning, {}, []], [disconnectedAt, { retained: true }, ['retained']]])
      engine.ingest({ ...reading({ source, signal, sourceTime, receivedAt: disconnectedAt, quality }), device, raw });
    assert.equal(engine.latest[signal].value, null);
    setTime(disconnectedAt + MINUTE);
    engine.ingest({ ...reading({ source, signal, value: 21.3, sourceTime: disconnectedAt + MINUTE,
      receivedAt: disconnectedAt + MINUTE }), device, raw: { usableForControl: true } });
    assert.equal(engine.latest[signal].value, 21.3);
    assert.equal(engine.status().observations[signal === 'indoor_temperature' ? 'indoor' : 'garage'].stale, false);
    setTime(beginning);
  }
});

test('delayed and unrelated availability failures cannot invalidate the current temperature source', t => {
  const { engine, setTime } = setup(t, { input: 'mqtt' });
  const at = beginning + 2 * MINUTE;
  setTime(at);
  engine.ingest({ ...reading({ source: 'mqtt-temperature', sourceTime: at, receivedAt: at }), device: 'selected-room' });
  const failure = (extra = {}) => ({ ...reading({ source: 'mqtt-temperature', value: null, sourceTime: null,
    receivedAt: at, quality: ['mqtt-subscription-failed'] }), device: 'selected-room',
    raw: { usableForControl: false, timeBasis: 'availability-transition' }, ...extra });
  for (const extra of [{ source: 'husdata-h66' }, { device: 'other-room' }, { receivedAt: beginning + MINUTE }, { receivedAt: at + MINUTE }]) {
    engine.rememberObservation(failure(extra), at);
    assert.equal(engine.latest.indoor_temperature.value, 21);
  }
  engine.rememberObservation(failure(), at);
  assert.equal(engine.status().observations.indoor.stale, false);
  assert.equal(engine.status().observations.indoor.needsAttention, true);
});


test('explicit H66 outdoor outage falls back to FMI without accepting delayed failure or recovery', t => {
  const { engine, setTime } = setup(t, { input: 'mqtt' });
  const at = beginning + MINUTE;
  engine.ingest(reading({ source: 'fmi', signal: 'outdoor_temperature', value: 4 }));
  const h66 = { ...reading({ source: 'husdata-h66', signal: 'outdoor_temperature', value: 2 }),
    raw: { usableForControl: true } };
  engine.ingest(h66);
  setTime(at);
  const failure = { ...h66, value: null, sourceTime: null, receivedAt: at, quality: ['mqtt-disconnected'],
    raw: { timeBasis: 'availability-transition', usableForControl: false } };
  engine.rememberObservation({ ...failure, device: 'other-gateway' }, at);
  assert.equal(engine.status().observations.outdoor.source, 'husdata-h66');
  engine.rememberObservation(failure, at);
  assert.equal(engine.status().observations.outdoor.source, 'fmi');
  engine.ingest({ ...h66, receivedAt: at });
  assert.equal(engine.status().observations.outdoor.source, 'fmi');
  engine.ingest({ ...h66, sourceTime: at, receivedAt: at });
  assert.equal(engine.status().observations.outdoor.source, 'husdata-h66');
  engine.rememberObservation({ ...failure, receivedAt: beginning }, at);
  assert.equal(engine.status().observations.outdoor.source, 'husdata-h66');
});

test('restart retains recorded room contributions through an outage without extending their observation times', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = beginning;
  const config = { input: 'mqtt', control: { indoorSensorWeights: {
    indoor_temperature: 1, downstairs_temperature: 1, bedroom_temperature: 1,
  } } };
  const engine = new Engine({ store, config, clock: () => now });
  for (const [signal, value] of [['indoor_temperature', 24], ['downstairs_temperature', 20], ['bedroom_temperature', 19]])
    engine.ingest({ ...reading({ signal, value }), device: signal });
  now += 5 * MINUTE;
  engine.recorder.recordFailure({ source: 'mqtt-temperature', device: 'bedroom_temperature',
    signal: 'bedroom_temperature', unit: 'degC', at: now, quality: ['mqtt-disconnected'] });
  const temperatureCount = () => store.observations().filter(row => row.source === 'mqtt-temperature').length;
  const recorded = temperatureCount();
  const restarted = new Engine({ store, config, clock: () => now });
  const check = () => {
    const observations = restarted.status().observations;
    assert.equal(observations.indoor.value, 21);
    assert.equal(observations.indoor.stale, false);
    assert.equal(observations.bedroom.observedAt, beginning);
    assert(observations.bedroom.attentionReasons.includes('disconnected'));
  };
  check(); now += 3 * 24 * 60 * MINUTE; check();
  assert.equal(temperatureCount(), recorded, 'Status never turns held values into new telemetry');
  restarted.ingest({ ...reading({ signal: 'bedroom_temperature', value: 22, sourceTime: now, receivedAt: now }), device: 'bedroom_temperature' });
  assert.equal(restarted.status().observations.indoor.value, 22);
  assert.equal(restarted.status().observations.bedroom.needsAttention, undefined);
});

test('old room values cannot return after a sensor measurement boundary has settled', async t => {
  const store = new Store(':memory:');
  let now = beginning;
  const engine = new Engine({ store, config: { input: 'mqtt' }, clock: () => now });
  t.after(async () => { await engine.closeFireplace(); store.close(); });
  engine.ingest(reading());
  now += MINUTE;
  engine.changeSensor({ signal: 'indoor_temperature', reason: 'replacement', requestId: 'invented-new-room-sensor' });
  now += 3 * 60 * MINUTE;
  const unknown = engine.status().observations.indoor;
  assert.equal(unknown.value, null);
  assert.equal(unknown.stale, true);
  engine.ingest(reading({ sourceTime: now, receivedAt: now, value: 22 }));
  assert.equal(engine.status().observations.indoor.value, 22);
  assert.equal(engine.status().observations.indoor.stale, false);
});

test('post-restart delayed packets cannot replace a more recently confirmed recorded temperature', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = beginning;
  const config = { input: 'mqtt' }, engine = new Engine({ store, config, clock: () => now });
  engine.ingest(reading({ value: 20 }));
  now += MINUTE;
  assert.equal(engine.ingest(reading({ value: 20, sourceTime: now, receivedAt: now })).saved, false);
  const restarted = new Engine({ store, config, clock: () => now });
  for (let i = 0; i < 2; i++) {
    now += MINUTE;
    const result = restarted.ingest(reading({ value: 25, sourceTime: beginning + MINUTE / 2, receivedAt: now }));
    assert.equal(result.rejectedSourceTime, true);
    const indoor = restarted.status().observations.indoor;
    assert.equal(indoor.value, 20);
    assert.equal(indoor.observedAt, beginning);
    assert.equal(indoor.stale, false);
    assert(indoor.attentionSensors[0].reasons.includes('invalid-reading'));
  }
});
