import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { loadConfig, teslamateConfiguration } from '../src/app/config.js';
import { createAppServer } from '../src/app/server.js';
import { startProviders } from '../src/acquisition/providers.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';
import { start } from '../src/main.js';

const INITIAL = Date.parse('2026-01-01T12:00:00Z');
const drain = () => new Promise(resolve => setImmediate(resolve));
function mqttClient() {
  const client = new EventEmitter(), subscriptions = [], publications = [];
  client.subscribe = (topic, _options, done) => { subscriptions.push(topic); done(); };
  client.publish = (topic, _payload, _options, done) => { publications.push(topic); done?.(); };
  client.end = (_force, _options, done) => done();
  return { client, subscriptions, publications };
}

async function fixture(t, { enabled = true, read, assignment = 'auto' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-identification-runtime-'));
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory), input: 'providers',
    acquisition: { easeeIntervalMs: 5000 },
    connections: { mqtt: { address: 'mqtt://invented.invalid' }, easee: { charger_id: 'invented-charger' },
      teslamate: teslamateConfiguration({ enabled: true, charger_identification: enabled, charger_assignment: assignment }) } };
  const store = new Store(':memory:');
  let now = INITIAL, amps = 16, power = 11.04, energy = 2, factoryCalls = 0, providerPolls = 0;
  const commands = [], clock = () => now, engine = new Engine({ store, config, clock });
  const mock = mqttClient();
  const mqtt = await startMqtt({ engine, store, config, connect: () => mock.client });
  const control = {
    read: args => read ? read({ ...args, now }) : Promise.resolve({ safeToProbe: true, connected: true,
      receivedAt: now, powerKw: amps * 0.69, currents: [amps, amps, amps], minCurrentA: 7 }),
    limit: async ({ amps: requested, minutes }) => {
      commands.push({ amps: requested, minutes });
      return { accepted: true, requestedAt: now, expiresAfterMs: 60_000 };
    },
  };
  const devices = {
    chargerIdentificationControl() { factoryCalls++; return control; },
    electricity: async () => {
      providerPolls++;
      return ELECTRICITY_FIELDS.ev1.map(([id, name, unit]) => ({ source: 'easee', device: 'invented-charger',
        signal: `ev1_${name}`, unit, value: unit === 'A' ? amps : unit === 'V' ? 230 : amps * 0.69,
        sourceTime: now, receivedAt: now, quality: [],
        raw: { observationId: id, chargingSessionStart: { start: INITIAL } } }));
    },
  };
  const providerOptions = { engine, store, config, clock, devices, automatic: false,
    http: { json() { throw new Error('Unexpected external request'); }, close() {} } };
  let providers = startProviders(providerOptions);
  const server = createAppServer({ engine, store, chartService: { overview: async () => ({}) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await providers.close(); await mqtt.close();
    await new Promise(resolve => server.close(resolve));
    await engine.closeFireplace(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  mock.client.emit('connect');
  const send = (field, value) => mock.client.emit('message', `teslamate/cars/1/${field}`, Buffer.from(String(value)), { retain: false });
  send('charging_state', 'Disconnected'); send('geofence', 'Home'); send('plugged_in', true);
  send('since', new Date(now).toISOString()); send('charge_energy_added', energy);
  send('healthy', true); send('charging_state', 'Charging'); send('charger_power', power); send('charger_actual_current', amps);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (payload, headers = {}) => {
    const response = await fetch(`${base}/api/charger-identification`, payload === undefined ? { headers }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  async function sample(seconds = 5, changes = {}) {
    energy += power * seconds / 3600 * 0.9; now += seconds * 1000;
    if (changes.amps !== undefined) amps = changes.amps;
    if (changes.power !== undefined && changes.power !== power) { power = changes.power; send('charger_power', power); }
    if (changes.teslaAmps !== undefined) send('charger_actual_current', changes.teslaAmps);
    send('healthy', true); send('charge_energy_added', energy);
    await providers.runDue(); await providers.runIdentification(); await drain();
  }
  return { config, store, engine, control, commands, mock, call, base, sample,
    get factoryCalls() { return factoryCalls; }, get providerPolls() { return providerPolls; },
    get providers() { return providers; },
    baseline: async () => { await sample(0); for (let i = 0; i < 5; i++) await sample(); },
    restartProviders: async () => { await providers.close(); providers = startProviders(providerOptions); },
  };
}

test('provider and MQTT runtime share the opted-in control while heat-pump control remains in shadow mode', async t => {
  const f = await fixture(t);
  assert.equal(f.factoryCalls, 1);
  assert.deepEqual(f.mock.subscriptions, ['teslamate/cars/1/#']);
  assert.equal(f.engine.settings.mode, 'shadow');
  await f.baseline();
  assert.deepEqual(f.commands, [{ amps: 10, minutes: 1 }]);
  assert(f.providerPolls >= 3);
  assert.equal(f.engine.electricitySnapshot.charger.currentA, 16);
  assert.equal(f.engine.teslamate.identificationSnapshot().currentA, 16);
  f.engine.tick();
  const status = f.engine.status();
  assert.equal(status.liveWrites, false, 'The independent EV opt-in must not enable heat-pump writes');
  assert.equal(status.chargerIdentification.active, true);
  assert.equal((await f.call()).body.phase, 'holding');
  assert.deepEqual(f.mock.publications, []);
  for (let i = 0; i < 11; i++) await f.sample(5, { amps: 10, power: 6.9, teslaAmps: 10 });
  await f.sample(5, { amps: 16, power: 11.04, teslaAmps: 16 }); await f.sample();
  assert.equal((await f.call()).body.verdict, 'easee');
  await f.restartProviders();
  assert.equal(f.factoryCalls, 2);
  assert.equal((await f.call()).body.verdict, null, 'Identification cannot survive a new runtime');
  assert.equal((await f.call()).body.phase, 'idle');
  const durable = JSON.stringify(f.store.db.prepare('SELECT key,value FROM state').all());
  assert(!durable.includes('matched-charging-response'));
  assert(!durable.includes('applying-temporary-limit'));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type LIKE '%identification%' OR type LIKE '%probe%'").get().n, 0);
});

test('disabled identification and explicit charger assignments do not acquire a command capability', async t => {
  assert.equal(teslamateConfiguration().chargerIdentification, false);
  assert.throws(() => teslamateConfiguration({ charger_identification: 'true' }), /boolean/);
  for (const options of [{ enabled: false }, { assignment: 'easee' }, { assignment: 'bmw' }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await fixture(t, options); await f.baseline();
      assert.equal(f.factoryCalls, 0); assert.deepEqual(f.commands, []);
      assert.deepEqual((await f.call()).body, { enabled: false, active: false, verdict: null });
      assert.equal((await f.call({ strategy: 'pause' })).status, 409);
    });
  }
});

test('identification API accepts bounded strategies and rejects invalid or cross-origin control requests', async t => {
  const f = await fixture(t);
  for (const strategy of ['auto', 'reduce', 'pause']) {
    const response = await f.call({ strategy });
    assert.equal(response.status, 202);
    assert.equal(response.body.strategy, strategy);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const invalid of [null, [], {}, { strategy: 'increase' }, { strategy: 'pause', minutes: 0 },
    { strategy: 'reduce', amps: 32 }]) assert.equal((await f.call(invalid)).status, 400);
  assert.equal((await f.call({ strategy: 'pause' }, { Origin: 'https://untrusted.example' })).status, 403);
  const otherHost = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.base}/api/charger-identification`, { headers: { Host: 'untrusted.example' } },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(otherHost, 403);
  assert.deepEqual(f.commands, [], 'A request cannot bypass live preflight or stable baseline requirements');
  await f.baseline();
  assert.deepEqual(f.commands, [{ amps: 0, minutes: 1 }]);
  assert.equal((await f.call()).body.pauseExpected, true);
  const duplicate = await f.call({ strategy: 'reduce' });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /already running|unavailable/);
  assert.equal((await f.call()).body.strategy, 'pause');
  assert.deepEqual(f.commands, [{ amps: 0, minutes: 1 }], 'A rejected request cannot replace the active command');
});

test('provider shutdown aborts pending preflight and ignores its late completion', async t => {
  let resolveRead, signal;
  const f = await fixture(t, { read: args => { signal = args.signal;
    return new Promise(resolve => { resolveRead = resolve; }); } });
  await f.baseline();
  assert(signal); assert.equal(signal.aborted, false);
  const previous = f.engine.chargerIdentification;
  await f.providers.close();
  assert.equal(signal.aborted, true);
  assert.equal(f.engine.chargerIdentification, null);
  resolveRead({ safeToProbe: true, connected: true, receivedAt: INITIAL + 25_000,
    powerKw: 11.04, currents: [16, 16, 16], minCurrentA: 7 });
  await drain(); await drain();
  assert.deepEqual(f.commands, []);
  assert.equal(previous.status().phase, 'stopped');
  assert.equal((await f.call()).body.enabled, false);
});

test('application startup installs Tesla MQTT before the enabled identification provider', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-identification-main-'));
  const mock = mqttClient(); let factoryCalls = 0;
  const config = { ...loadConfig({ XDG_CONFIG_HOME: directory, STMQ_DATA_DIR: directory, STMQ_PORT: '0' }, directory), input: 'mqtt',
    connections: { mqtt: { address: 'mqtt://invented.invalid' },
      teslamate: teslamateConfiguration({ enabled: true, charger_identification: true }) } };
  const app = await start({ config, clock: () => INITIAL, mqttOptions: { connect: () => mock.client },
    providerOptions: { automatic: false,
      http: { json() { throw new Error('Unexpected external request'); }, close() {} },
      devices: { chargerIdentificationControl() { factoryCalls++; return {
        read: async () => { throw new Error('No baseline should be available'); },
        limit: async () => { throw new Error('No command should be issued'); },
      }; } } } });
  try {
    assert(app.engine.teslamate);
    assert.equal(factoryCalls, 1);
    assert.equal(app.engine.chargerIdentification.status().enabled, true);
    assert.equal(app.engine.status().chargerIdentification.enabled, true);
    assert.deepEqual(mock.publications, []);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
