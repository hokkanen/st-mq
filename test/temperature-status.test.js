import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { Engine } from '../src/app/engine.js';
import { lastIndoorReading } from '../src/app/indoor-readings.js';
import { indoorStatusMetadata, recordedOutdoorObservation, outdoorReadingStatus } from '../src/app/temperature-status.js';
import { temperatureReadingStatus } from '../chart/temperature-status.js';

const MINUTE = 60_000, at = Date.parse('2026-09-09T10:00:00Z');
const report = (minute, extra = {}) => ({ source: 'mqtt-temperature', device: 'invented-room',
  signal: 'indoor_temperature', value: 21, unit: 'degC', sourceTime: at + minute * MINUTE,
  receivedAt: at + minute * MINUTE, quality: [], raw: { reportIntervalMs: 15 * MINUTE, reportGraceMs: 2 * MINUTE }, ...extra });
const formatTime = time => new Date(time).toISOString();
const fixture = t => { const store = new Store(':memory:'); t.after(() => store.close()); return store; };

test('report diagnostics use the last compact report independently of the unchanged saved temperature', t => {
  const store = fixture(t), recorder = new Recorder(store);
  for (const minute of [0, 15, 30]) recorder.record(report(minute));
  const now = at + 48 * MINUTE;
  const reading = lastIndoorReading(store, { signal: 'indoor_temperature', at: now, input: 'mqtt' });
  const metadata = indoorStatusMetadata(reading, now, { store, stale: true });
  assert.equal(reading.sourceTime, at);
  assert.equal(metadata.lastReportAt, at + 30 * MINUTE);
  assert.equal(metadata.reportExpiresAt, at + 47 * MINUTE);
  assert.equal(metadata.reportMaxAgeMs, 17 * MINUTE);
  assert.deepEqual(metadata.availabilityReasons, ['missing-report']);
});

test('a snapshot inside an extended periodic span keeps its causal availability boundary', t => {
  const store = fixture(t), recorder = new Recorder(store);
  for (const minute of [0, 15, 30]) recorder.record(report(minute));
  const now = at + 20 * MINUTE;
  const reading = lastIndoorReading(store, { signal: 'indoor_temperature', at: now, input: 'mqtt' });
  const metadata = indoorStatusMetadata(reading, now, { store, knownAt: now, stale: reading.stale });
  assert.equal(reading.reportExpiresAt, now);
  assert.equal(metadata.lastReportAt, null, 'The later span endpoint cannot reveal an earlier report time');
  assert.equal(metadata.reportExpiresAt, now);
  const status = temperatureReadingStatus({ ...reading, observedAt: reading.sourceTime, ...metadata }, { now, formatTime });
  assert.equal(status.usable, true);
  assert.doesNotMatch(status.detail, /overdue|missing/i);
});

test('invalid periodic publication explains immediate rejection and the missing average member', t => {
  const store = fixture(t); let now = at;
  const engine = new Engine({ store, config: { input: 'mqtt' }, clock: () => now });
  engine.ingest(report(0)); now += MINUTE;
  engine.ingest(report(1, { value: 50, quality: ['implausible_temperature', 'invented-private-diagnostic'] }));
  const { upstairs, indoor } = engine.status().observations;
  assert.equal(upstairs.value, 21);
  assert.equal(upstairs.stale, true);
  assert(upstairs.lastAttemptReasons.includes('out-of-range'));
  assert(upstairs.lastAttemptReasons.includes('invalid-quality'));
  assert(!JSON.stringify(upstairs.lastAttemptReasons).includes('invented-private-diagnostic'));
  assert.equal(upstairs.lastAttemptAt, now);
  assert.equal(indoor.value, null);
  assert.deepEqual(indoor.missingMembers.map(member => member.signal), ['indoor_temperature']);
  assert(indoor.missingMembers[0].reasons.includes('out-of-range'));
});

test('replica outdoor selection matches live source priority, retained packets, failed downloads and expiry', t => {
  const store = fixture(t); let now = at;
  const engine = new Engine({ store, config: { input: 'mqtt' }, clock: () => now });
  const publish = (source, value, extra = {}) => engine.ingest({ source, device: `invented-${source}`,
    signal: 'outdoor_temperature', value, unit: 'degC', sourceTime: now, receivedAt: now,
    quality: [], raw: source === 'husdata-h66' ? { usableForControl: true } : {}, ...extra });
  const compare = source => {
    const primary = engine.outdoorObservation(now), replica = recordedOutdoorObservation(store, now, { input: 'mqtt' });
    assert.equal(primary.source, source);
    for (const field of ['source', 'value', 'observedAt', 'stale', 'maxAgeMs']) assert.equal(replica[field], primary[field], field);
  };
  publish('fmi', 4); publish('openmeteo', 5); publish('husdata-h66', 2); compare('husdata-h66');
  now += MINUTE;
  publish('husdata-h66', 9, { quality: ['retained'], raw: { retained: true, usableForControl: false } });
  compare('husdata-h66');
  publish('fmi', null, { sourceTime: null, quality: ['missing', 'provider_error'] });
  now = at + 5 * MINUTE; compare('husdata-h66');
  now++; compare('fmi');
  publish('husdata-h66', 2.1); compare('husdata-h66');
  publish('husdata-h66', null, { quality: ['invalid-value'], raw: { usableForControl: false } });
  compare('fmi');
  publish('fmi', 7, { sourceTime: now + 10 * MINUTE, quality: ['future_source_time'] });
  compare('fmi');
});

test('replica uses compact outdoor report coverage and cannot read future source publications', t => {
  const store = fixture(t), recorder = new Recorder(store);
  const weather = minute => ({ source: 'husdata-h66', device: 'invented-pump', signal: 'outdoor_temperature',
    value: 3, unit: 'degC', sourceTime: at + minute * MINUTE, receivedAt: at + minute * MINUTE,
    quality: [], raw: { usableForControl: true } });
  recorder.record(weather(0));
  assert.equal(recorder.record(weather(4)).saved, false);
  store.observation({ ...weather(8), value: 7 });
  const reading = recordedOutdoorObservation(store, at + 6 * MINUTE, { knownAt: at + 5 * MINUTE, input: 'mqtt' });
  assert.equal(reading.value, 3);
  assert.equal(reading.observedAt, at + 4 * MINUTE);
  assert.equal(reading.stale, false);
});

test('H66 expiry, broker disconnection and post-reconnect reports have distinct reasons', () => {
  const observation = { source: 'husdata-h66', signal: 'outdoor_temperature', value: 3,
    sourceTime: at, receivedAt: at, quality: [], raw: { usableForControl: true, timeBasis: 'mqtt-received' } };
  const h66 = { connected: false, brokerConnected: true, readings: { '0007': { available: false } } };
  assert.deepEqual(outdoorReadingStatus(observation, at + 6 * MINUTE, { h66 }).availabilityReasons, ['out-of-date']);
  assert.equal(outdoorReadingStatus(observation, at, { h66 }).sourceTimeBasis, 'received-at');
  h66.readings['0007'].unavailableReasons = ['awaiting-live-report'];
  assert.deepEqual(outdoorReadingStatus(observation, at, { h66 }).availabilityReasons, ['awaiting-live-report']);
  h66.brokerConnected = false;
  assert.deepEqual(outdoorReadingStatus(observation, at, { h66 }).availabilityReasons, ['disconnected']);
});
