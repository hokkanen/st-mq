import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createShellyCapture } from '../src/acquisition/shelly.js';
import { shellyConfiguration } from '../src/acquisition/shelly-config.js';
import { createCaravanEnergy } from '../src/acquisition/shelly-energy.js';
import { Envelope } from '../src/app/chart-data.js';
import { addShellyEnergy } from '../src/app/chart-shelly.js';

const HOUR = 3_600_000, initial = Date.parse('2026-09-10T12:00:00Z');
function fixture(t, options = {}, initialAt = initial) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-'));
  const store = new Store(join(directory, 'test.sqlite'));
  let now = initialAt, authority = true;
  const observations = [], publications = [];
  const engine = { clock: () => now, ingest: row => { observations.push(row); store.observation(row); } };
  const settings = shellyConfiguration(options);
  const capture = createShellyCapture({ engine, store, settings,
    publish: async (topic, payload, options) => { publications.push({ topic, payload, options }); },
    canControl: () => authority, readbackTimeoutMs: 100 });
  t.after(() => { capture.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const reply = (publication, result, extra = {}) => {
    const request = JSON.parse(publication.payload);
    capture.receive(`${request.src}/rpc`, JSON.stringify({ id: request.id, dst: request.src, result, ...extra }), {}, now);
  };
  const status = result => reply(publications.findLast(row => JSON.parse(row.payload).method === 'Shelly.GetStatus'), result);
  return { capture, store, observations, publications, settings, status, reply,
    now: value => { now = value; }, authority: value => { authority = value; } };
}
const caravan = { enabled: true, generation: 2, topic_prefix: 'invented-caravan' };

test('Shelly rejects malformed exact topics, ambiguous device roles and unsafe numeric settings', () => {
  assert.deepEqual(shellyConfiguration().devices, []);
  for (const topic_prefix of ['', 'with/+', 'with/#', ' trailing', 'foo/'])
    assert.throws(() => shellyConfiguration({ caravan: { ...caravan, topic_prefix } }));
  assert.throws(() => shellyConfiguration({ caravan: { ...caravan, controls_heat: true } }));
  assert.throws(() => shellyConfiguration({ caravan, garage: { ...caravan } }));
  assert.throws(() => shellyConfiguration({ poll_seconds: 100, max_age_seconds: 120 }));
  assert.throws(() => shellyConfiguration({ caravan: { ...caravan, generation: 5 } }));
});

test('Gen2 status reads actual plug values, ignores retained/replayed payloads and expires individual readings', t => {
  const f = fixture(t, { caravan }); f.capture.setConnected(true);
  assert(f.publications.every(row => row.options.retain === false));
  f.status({ 'switch:0': { output: true, apower: 575, current: 2.5, aenergy: { total: 12000 } } });
  const values = Object.fromEntries(f.observations.map(row => [row.signal, row.value]));
  assert.equal(values.caravan_active, 1); assert.equal(values.caravan_power, 0.575); assert.equal(values.caravan_current, 2.5);
  const count = f.observations.length;
  f.capture.receive('invented-caravan/status/switch:0', '{"output":false,"apower":0,"current":0}', { retain: true });
  f.capture.receive('invented-caravan/status/switch:0', '{"output":false}', { dup: true });
  assert.equal(f.observations.length, count);
  f.now(initial + 121_000); f.capture.tick(initial + 121_000);
  assert.equal(f.capture.status(initial + 121_000).devices[0].available, false);
  assert.equal(f.observations.at(-1).value, null);
  f.capture.setConnected(false); f.capture.setConnected(true);
  assert.equal(f.capture.status(initial + 121_000).devices[0].available, false, 'A broker reconnect is not a device reading');
});

test('Garage add-on uses external temperature component, never the relay CPU temperature', t => {
  const f = fixture(t, { garage: { enabled: true, topic_prefix: 'invented-garage', temperature_id: 100 } });
  f.capture.setConnected(true);
  f.status({ 'switch:0': { output: false, temperature: { tC: 55 } }, 'temperature:100': { tC: 12.5 } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, 12.5);
  f.now(initial + 30_000); f.capture.tick(initial + 30_000);
  f.status({ 'switch:0': { output: false, temperature: { tC: 55 } } });
  assert.equal(f.observations.findLast(row => row.signal === 'garage_temperature').value, null);
});

test('Direct heating requires a post-command Switch.GetStatus response and preserves configurable polarity', async t => {
  const f = fixture(t, { heat_savings: { enabled: true, topic_prefix: 'invented-mini', reduction_on: false } });
  f.capture.setConnected(true);
  const pending = f.capture.publishHeating(['heatoff']);
  await Promise.resolve();
  const set = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.Set');
  assert.deepEqual(JSON.parse(set.payload).params, { id: 0, on: false });
  let settled = false; pending.then(() => { settled = true; });
  f.status({ 'switch:0': { output: false } });
  await Promise.resolve(); assert.equal(settled, false, 'Preexisting snapshot cannot verify a command');
  f.reply(set, { was_on: true });
  const get = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  assert(get); f.reply(get, { output: false });
  const result = await pending; assert.equal(result.acknowledgement, 'shelly-live-relay-readback');
  f.authority(false);
  await assert.rejects(f.capture.publishHeating(['heaton15']), /unavailable/);
});

test('Readback timeout and device disconnect never claim delivery', async t => {
  const f = fixture(t, { heat_savings: { enabled: true, topic_prefix: 'invented-mini' } });
  f.capture.setConnected(true);
  await assert.rejects(f.capture.publishHeating(['heatoff']), /readback timed out/);
  const pending = f.capture.publishHeating(['heatoff']);
  f.capture.receive('invented-mini/online', 'false');
  await assert.rejects(pending, /unavailable/);
});

test('Gen1 plug watt-minute counter converts to kWh and labels current as an estimate', t => {
  const f = fixture(t, { caravan: { ...caravan, generation: 1, topic_prefix: 'shellies/invented-plug' } });
  f.capture.setConnected(true);
  f.capture.receive('shellies/invented-plug/relay/0', 'on');
  f.capture.receive('shellies/invented-plug/relay/0/power', '460');
  f.capture.receive('shellies/invented-plug/relay/0/energy', '60000');
  const current = f.observations.find(row => row.signal === 'caravan_current');
  assert.equal(current.value, 2); assert(current.quality.includes('estimated'));
  assert.equal(f.store.getState('shelly:caravan-energy:v1').previous.counterKwh, 1);
});

test('Hourly counter deltas survive restart, conserve energy across hour boundaries and retain partial coverage', t => {
  const f = fixture(t, {}), energy = createCaravanEnergy({ store: f.store, device: 'fixture-caravan', maxGapMs: 120_000 });
  energy.receive(20, initial - 30_000);
  energy.tick(initial); // A maintenance tick cannot finalize before the boundary-straddling report.
  energy.receive(20.01, initial + 30_000);
  const rows = f.store.db.prepare("SELECT * FROM observations WHERE signal='caravan_energy'").all();
  assert.equal(rows.length, 1); assert(Math.abs(rows[0].value - 0.005) < 1e-10);
  assert(JSON.parse(rows[0].quality).includes('partial-coverage'));
  assert.equal(JSON.parse(rows[0].raw).intervalEnd, initial);
  const resumed = createCaravanEnergy({ store: f.store, device: 'fixture-caravan', maxGapMs: 120_000 });
  resumed.receive(20.02, initial + 60_000);
  assert(Math.abs(resumed.status(initial + 60_000).dailyKwh - 0.02) < 1e-10);
  resumed.receive(0.001, initial + 90_000); // Reset creates a baseline, never a negative interval.
  assert.equal(resumed.status(initial + 90_000).counterReset, true);
  resumed.receive(0.003, initial + 120_000);
  resumed.tick(initial + HOUR + 120_000);
  const completed = f.store.db.prepare("SELECT * FROM observations WHERE signal='caravan_energy' ORDER BY source_time").all();
  assert.equal(completed.length, 2); assert(completed.every(row => row.value >= 0));
  assert(Math.abs(completed.reduce((sum, row) => sum + row.value, 0) - 0.022) < 1e-10);
  const range = { from: initial - HOUR, to: initial + HOUR };
  const envelope = new Envelope(range.from, range.to, 200);
  addShellyEnergy({ store: f.store, range, now: initial + 2 * HOUR, input: 'mqtt', envelopes: { caravan_energy: envelope } });
  assert(envelope.values().some(row => row.partialCoverage && row.intervalEnd === initial));
});

test('Midnight in Helsinki resets the daily display; long offline gaps and implausible counter jumps are not allocated', t => {
  const f = fixture(t, {}), energy = createCaravanEnergy({ store: f.store, device: 'fixture-caravan', maxGapMs: 120_000 });
  const midnight = Date.parse('2026-09-10T21:00:00Z');
  energy.receive(1, midnight - 30_000); energy.receive(1.01, midnight + 30_000);
  assert(Math.abs(energy.status(midnight + 30_000).dailyKwh - 0.005) < 1e-10);
  energy.receive(10, midnight + HOUR); // Distribution during an outage is unknown.
  energy.receive(1e9, midnight + HOUR + 30_000); // Not physically possible for a plug.
  assert(Math.abs(energy.status(midnight + HOUR + 30_000).dailyKwh - 0.005) < 1e-10);
  assert.equal(energy.status(midnight + HOUR + 30_000).partial, true);
});

test('Full invalid switch status and unrelated partial changes cannot restore component availability', t => {
  const f = fixture(t, { garage: { enabled: true, topic_prefix: 'invented-garage' } });
  f.capture.setConnected(true);
  f.status({ 'switch:0': { output: true }, 'temperature:100': { tC: 12 } });
  assert.equal(f.capture.status(initial).devices[0].available, true);
  f.now(initial + 30_000); f.capture.tick(initial + 30_000);
  f.status({ 'switch:0': { errors: ['overtemp'] }, 'temperature:100': { tC: 12 } });
  assert.equal(f.capture.status(initial + 30_000).devices[0].available, false);
  assert.equal(f.capture.status(initial + 30_000).devices[0].readings.garage_relay_active.value, null);
  f.now(initial + 151_000);
  f.capture.receive('invented-garage/events/rpc', JSON.stringify({ method: 'NotifyStatus', params: { 'switch:0': { output: false } } }));
  assert.equal(f.capture.status(initial + 151_000).devices[0].available, false, 'The external temperature still expired');
});

test('Native garage and existing Home Assistant MQTT feed stay separate in Engine recording and fail independently', async t => {
  const { EventEmitter } = await import('node:events');
  const { startMqtt } = await import('../src/acquisition/mqtt.js');
  const { Engine } = await import('../src/app/engine.js');
  const { loadConfig } = await import('../src/app/config.js');
  const directory = mkdtempSync(join(tmpdir(), 'stmq-shelly-integration-'));
  const store = new Store(join(directory, 'test.sqlite'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory }, directory), input: 'mqtt',
    connections: { mqtt: { address: 'mqtt://example.invalid', temperatureTopics: { garage_temperature: 'invented-ha/garage' } },
      shelly: shellyConfiguration({ garage: { enabled: true, topic_prefix: 'invented-direct-garage' }, caravan }) } };
  let now = initial;
  store.observation({ source: 'mqtt-temperature', device: 'garage_temperature', signal: 'garage_temperature',
    value: 18, unit: 'degC', sourceTime: initial - 60_000, receivedAt: initial - 60_000 });
  const engine = new Engine({ store, config, clock: () => now });
  assert.equal(engine.status().observations.garage?.value ?? null, null, 'Enabling direct acquisition cannot reuse an old HA reading');
  const client = new EventEmitter();
  client.subscribe = (topic, options, done) => done();
  client.publish = (topic, payload, options, done) => done();
  client.end = (force, options, done) => done();
  const acquisition = await startMqtt({ engine, store, config, connect: () => client });
  t.after(async () => { await acquisition.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  client.emit('connect');
  client.emit('message', 'invented-direct-garage/status/temperature:100', Buffer.from('{"tC":11}'));
  client.emit('message', 'invented-ha/garage', Buffer.from('18.5'));
  assert.equal(engine.latest.garage_temperature.value, 11);
  assert.equal(engine.latest.garage_temperature_ha.value, 18.5);
  assert.equal(engine.latest.garage_temperature_ha.source, 'mqtt-temperature-ha');
  assert.equal(engine.status().shelly.devices.length, 2);
  now += 30_000;
  client.emit('message', 'invented-ha/garage', Buffer.from('invalid-json'));
  assert.equal(engine.latest.garage_temperature.value, 11);
  assert.equal(engine.latest.garage_temperature_ha.value, null);
  assert.equal(engine.latest.garage_temperature_ha.source, 'mqtt-temperature-ha');
  client.emit('offline');
  assert.equal(engine.latest.garage_temperature.value, null);
});

test('A late readback from a timed-out command cannot confirm a newer command with the same output', async t => {
  const f = fixture(t, { heat_savings: { enabled: true, topic_prefix: 'invented-mini' } });
  f.capture.setConnected(true);
  const first = f.capture.publishHeating(['heatoff']);
  const firstSet = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.Set');
  f.now(initial + 50); f.reply(firstSet, { was_on: false });
  const staleRead = f.publications.find(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  await assert.rejects(first, /readback timed out/);
  f.now(initial + 100);
  const second = f.capture.publishHeating(['heatoff']);
  let completed = false; second.then(() => { completed = true; });
  f.now(initial + 110); f.reply(staleRead, { output: true });
  await Promise.resolve(); assert.equal(completed, false);
  const secondSet = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.Set');
  f.reply(secondSet, { was_on: true });
  const currentRead = f.publications.findLast(row => JSON.parse(row.payload).method === 'Switch.GetStatus');
  f.reply(currentRead, { output: true });
  await second;
});
