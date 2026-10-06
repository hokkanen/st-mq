import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createEaseeOcpp, localOcppConfiguration, ocppMeterReadings } from '../src/acquisition/easee-ocpp.js';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { ElectricityAccumulator } from '../src/domain/electricity.js';
import { providerSeries } from '../chart/provider-status.js';

const at = Date.parse('2026-09-24T12:00:00Z');
const samples = [
  { measurand: 'Power.Active.Import', unit: 'W', value: '6900' },
  ...[1, 2, 3].flatMap(phase => [
    { measurand: 'Current.Import', phase: `L${phase}`, unit: 'A', value: '10' },
    { measurand: 'Voltage', phase: `L${phase}-N`, unit: 'V', value: '230' },
  ]),
];
const meter = (sampledValue = samples, time = at) => ({ connectorId: 1, meterValue: [{ timestamp: new Date(time).toISOString(), sampledValue }] });
const config = { host: '127.0.0.1', password: 'fixture-ocpp-pass', authorization_tags: ['fixture-tag'] };

async function freePort() {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); return port;
}

async function fixture(t, overrides = {}, virtualTag = '', initialState) {
  const port = await freePort();
  let saved = structuredClone(initialState), now = at, permitted = true, startPermitted = true, broken = false, writes = 0, sequence = 0;
  const clients = [];
  const local = createEaseeOcpp({ config: { ...config, port, ...overrides }, chargerId: 'fixture-charger',
    clock: () => now, canControl: () => permitted, canStart: () => startPermitted, virtualTag,
    state: { get: () => saved, set: value => { if (broken) throw new Error('Synthetic storage failure'); saved = structuredClone(value); writes++; } } });
  t.after(async () => { for (const client of clients) client.terminate(); await local.close(); });
  await local.start();
  return { local, port, get saved() { return structuredClone(saved); }, get writes() { return writes; }, set now(value) { now = value; }, set permitted(value) { permitted = value; }, set startPermitted(value) { startPermitted = value; }, set broken(value) { broken = value; },
    async connect({ autoReply = true } = {}) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
        headers: { Authorization: `Basic ${Buffer.from(`fixture-charger:${config.password}`).toString('base64')}` },
      });
      clients.push(ws); ws.on('error', () => {});
      const pending = new Map(), calls = [];
      ws.on('message', raw => {
        const frame = JSON.parse(raw);
        if (frame[0] === 2) {
          calls.push(frame);
          const status = typeof autoReply === 'function' ? autoReply(frame) : autoReply ? 'Accepted' : null;
          if (status !== null) ws.send(JSON.stringify([3, frame[1], { status }]));
        } else { const resolve = pending.get(frame[1]); pending.delete(frame[1]); resolve?.(frame); }
      });
      await once(ws, 'open');
      return { ws, calls, call(action, payload, id = `fixture-${++sequence}`) {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic OCPP reply timeout')); }, 2000);
          pending.set(id, reply => { clearTimeout(timeout); resolve(reply); }); ws.send(JSON.stringify([2, id, action, payload]));
        });
      } };
    },
  };
}

test('OCPP accepts only measured charger fields with source times, units and explicit phase meaning', () => {
  const rows = ocppMeterReadings(meter(), at);
  assert.equal(rows.find(row => row.id === 120).value, 6.9);
  assert.deepEqual(rows.filter(row => row.unit === 'V').map(row => row.value), [230, 230, 230]);
  assert.deepEqual(ocppMeterReadings(meter(samples.map(sample => ({ ...sample, location: 'Inlet' }))), at), rows,
    'Native Easee connector 1 inlet readings retain charger phase and source meanings');
  assert.deepEqual(ocppMeterReadings(meter(samples.map(sample => ({ ...sample, location: 'Body' }))), at), []);
  assert.deepEqual(ocppMeterReadings({ ...meter(), connectorId: 0 }, at), [], 'Do not invent Equalizer observations');
  assert.deepEqual(ocppMeterReadings(meter(samples, at + 1), at), []);
  assert.deepEqual(ocppMeterReadings(meter([{ measurand: 'Voltage', phase: 'L1-L2', value: '400' },
    { measurand: 'Current.Import', phase: 'L1', value: '-2' }, { measurand: 'Power.Active.Import', value: 'NaN' }]), at), []);
  assert.throws(() => localOcppConfiguration({ secret: 'fixture-unsupported' }), /Invalid/);
  assert.throws(() => localOcppConfiguration({ password: 'short' }), /Invalid/);
  assert.equal(localOcppConfiguration().authorization_mode, 'rfid');
  assert.throws(() => localOcppConfiguration({ authorization_mode: 'accept-any-tag' }), /Invalid/);
  for (const server_url of ['http://fixture.example/ocpp', 'ws://user:secret@fixture.example/ocpp',
    'ws://fixture.example/ocpp/charger', 'ws://fixture.example/ocpp?token=fixture']) {
    assert.throws(() => localOcppConfiguration({ server_url }), /server_url/);
  }
  assert.throws(() => localOcppConfiguration({ server_url: 'wss://fixture.example/ocpp' }), /certificate/);
  assert.equal(localOcppConfiguration({ server_url: 'ws://fixture.example:9001/ocpp' }).server_url, 'ws://fixture.example:9001/ocpp');
});

test('advertised charger URLs must be reachable from another device and certificates match secure endpoints', () => {
  for (const host of ['localhost', 'fixture.localhost', 'localhost.', '0.0.0.0', '127.0.0.1', '127.0.0.2',
    '224.0.0.1', '239.1.2.3', '255.255.255.255', '[::]', '[::1]', '[ff02::1]', '[::ffff:7f00:1]']) {
    assert.throws(() => localOcppConfiguration({ server_url: `ws://${host}:9001/ocpp` }), /server_url/);
  }
  for (const host of ['192.0.2.10', '[2001:db8::1]', 'fixture.example'])
    assert.equal(localOcppConfiguration({ server_url: `ws://${host}:9001/ocpp` }).server_url, `ws://${host}:9001/ocpp`);
  const secure = { server_url: 'wss://fixture.example/ocpp', ca_certificate_domain: 'fixture.example',
    ca_certificate: '-----BEGIN CERTIFICATE-----\nSYNTHETIC FIXTURE\n-----END CERTIFICATE-----' };
  assert.deepEqual(Object.fromEntries(Object.keys(secure).map(key => [key, localOcppConfiguration(secure)[key]])), secure);
  for (const overrides of [{ ca_certificate: 'fixture-non-pem' }, { ca_certificate_domain: 'different.example' },
    { server_url: 'ws://fixture.example/ocpp' }, { server_url: '' }, { password: 'x'.repeat(21) },
    { server_url: `wss://${'a'.repeat(2050)}.example/ocpp` }, { ca_certificate: secure.ca_certificate + 'x'.repeat(16384) },
    { ca_certificate_domain: 'x'.repeat(254) }]) assert.throws(() => localOcppConfiguration({ ...secure, ...overrides }), /easee.local_ocpp/);
  assert.equal(localOcppConfiguration({ password: 'x'.repeat(16) }).password.length, 16);
  assert.equal(localOcppConfiguration({ password: 'x'.repeat(20) }).password.length, 20);
  assert.throws(() => localOcppConfiguration({ password: 'x'.repeat(15) }), /16 to 20/);
});

test('authenticated OCPP boots, enforces tag authorization and expires readings without refreshing from heartbeats', async t => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let now = at, permitted = true, saved;
  const state = { get: () => saved, set: value => { saved = value; } };
  const local = createEaseeOcpp({ config: { ...config, port }, chargerId: 'fixture-charger', clock: () => now, canControl: () => permitted, state });
  await local.start();
  t.after(() => local.close());
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6');
  await once(bad, 'error');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
    headers: { Authorization: `Basic ${Buffer.from(`fixture-charger:${config.password}`).toString('base64')}` },
  });
  ws.on('error', () => {}); await once(ws, 'open');
  const call = (id, action, payload) => new Promise(resolve => {
    const received = raw => { const message = JSON.parse(raw); if (message[1] === id) { ws.off('message', received); resolve(message); } };
    ws.on('message', received); ws.send(JSON.stringify([2, id, action, payload]));
  });
  assert.equal(local.deviceInfo(), null);
  assert.equal((await call('1', 'BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture', firmwareVersion: '344',
    chargePointSerialNumber: 'fixture-serial' }))[2].status, 'Accepted');
  const device = { model: 'fixture', firmware: '344', source: 'ocpp-boot', receivedAt: at, available: true };
  assert.deepEqual(local.deviceInfo(), device);
  assert.equal((await call('2', 'Authorize', { idTag: 'unknown-tag' }))[2].idTagInfo.status, 'Invalid');
  assert.equal((await call('3', 'Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
  await call('4', 'MeterValues', meter());
  assert.equal(local.snapshot().find(row => row.id === 120).value, 6.9);
  now += 61_000;
  await call('5', 'Heartbeat', {});
  assert.equal(local.snapshot(), null);
  assert.deepEqual(local.deviceInfo(), device, 'Heartbeat does not rewrite the boot report receipt time');
  await call('6', 'MeterValues', meter(samples, now));
  assert(local.snapshot());
  permitted = false;
  assert.equal(local.snapshot(), null);
  assert.deepEqual(local.deviceInfo(), { ...device, available: false });
  ws.terminate();
});

test('charger electricity prefers local OCPP and falls back to cloud without attributing property data to OCPP', async () => {
  let direct = true, requests = 0;
  const localRows = [...ocppMeterReadings(meter(), at), { id: 250, value: true, timestamp: new Date(at).toISOString() }];
  const local = { start() {}, close() {}, snapshot: () => direct ? localRows : null, status: () => ({ configured: true, available: direct }) };
  const providers = createDeviceProviders({ connections: { easee: { charger_id: 'fixture-charger', access_token: 'fixture-token' } },
    clock: () => at, ocppFactory: () => local, http: { json: async () => { requests++; return localRows; } } });
  const rows = await providers.electricity({ now: at });
  assert.equal(requests, 0);
  assert(rows.every(row => row.raw.transport === 'ocpp'));
  assert(rows.filter(row => row.unit === 'V').every(row => row.raw.voltageMapping === 'phase-neutral'));
  assert.deepEqual(providers.deviceTransports(), { charger: 'ocpp' });
  direct = false;
  const cloud = await providers.electricity({ now: at });
  assert.equal(requests, 1);
  assert(cloud.every(row => row.raw.transport === 'cloud'));
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(rows, at);
  assert.equal(accumulator.sample(cloud, at + 10_000).intervals.length, 0, 'Transport handoff leaves a gap instead of integrating unrelated heads');
  await providers.close();
  const series = providerSeries('easee', { deviceTransports: { charger: 'ocpp', property: 'stream' } });
  assert.equal(series.find(row => row.signals.includes('ev1_active_power')).source, 'Easee local OCPP');
  assert.equal(series.find(row => row.signals.includes('property_active_power')).source, 'Easee cloud');
});

test('native voltage can feed forecasts before power/current readiness without widening electrical readiness', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  await client.call('MeterValues', meter(samples.filter(row => row.measurand === 'Voltage')));
  assert.equal(f.local.snapshot(), null);
  assert.equal(f.local.status().available, false);
  assert.deepEqual(f.local.voltageSnapshot().filter(row => row.unit === 'V').map(row => row.id), [194, 195, 196]);
  f.now = at + 61_000;
  await client.call('Heartbeat', {});
  assert.equal(f.local.voltageSnapshot(), null, 'Heartbeat cannot renew actual voltage clocks');
});

test('missing native voltage phases use bounded cloud-only supplements without changing energy inputs', async t => {
  let now = at, requests = 0, complete = false;
  const payload = voltage => [...ocppMeterReadings(meter(samples.map(row => row.measurand === 'Voltage'
    ? { ...row, value: String(voltage) } : row), now), now), { id: 250, value: true, timestamp: new Date(now).toISOString() }];
  const local = { start() {}, close() {}, status: () => ({ configured: true }),
    snapshot: () => payload(240).filter(row => complete || row.id !== 195) };
  const devices = createDeviceProviders({ connections: { easee: { charger_id: 'fixture-charger', access_token: 'fixture-token',
    charger_voltage_ids: [194, 195, 196] } }, clock: () => now, ocppFactory: () => local,
    http: { json: async () => { requests++; return payload(220); } } });
  t.after(() => devices.close());
  const first = await devices.electricity({ now });
  assert.equal(requests, 1);
  const cloud = first.filter(row => row.raw.voltageOnly);
  assert.equal(cloud.length, 3); assert(cloud.every(row => row.raw.transport === 'cloud' && row.value === 220));
  assert(first.filter(row => !row.raw.voltageOnly).every(row => row.raw.transport === 'ocpp'));
  const accumulator = new ElectricityAccumulator(); accumulator.sample(first, now);
  now += 15_000;
  const next = await devices.electricity({ now });
  assert.equal(requests, 1, 'Optional cloud fallback is cached between bounded reads');
  const [interval] = accumulator.sample(next, now).intervals;
  assert.equal(interval.transport, 'ocpp');
  assert(interval.quality.includes('current_phase_weights'), 'Cloud voltage cannot fill native integration phase evidence');
  assert(Math.abs(interval.energies.reduce((sum, value) => sum + value, 0) - 6.9 * 15 / 3600) < 1e-12);
  complete = true; now += 60_000;
  await devices.electricity({ now });
  assert.equal(requests, 1, 'Complete local voltage never triggers another cloud request');
});

test('voltage-only native observations coexist with cloud electrical readings', async t => {
  const cloudRows = [...ocppMeterReadings(meter(), at), { id: 250, value: true, timestamp: new Date(at).toISOString() }];
  const local = { start() {}, close() {}, status: () => ({ configured: true }), snapshot: () => null,
    voltageSnapshot: () => cloudRows.filter(row => row.unit === 'V' || row.id === 250) };
  const devices = createDeviceProviders({ connections: { easee: { charger_id: 'fixture-charger', access_token: 'fixture-token' } },
    clock: () => at, ocppFactory: () => local, http: { json: async () => cloudRows } });
  t.after(() => devices.close());
  const rows = await devices.electricity({ now: at });
  assert.equal(rows.filter(row => row.raw.voltageOnly && row.raw.transport === 'ocpp').length, 3);
  const accumulator = new ElectricityAccumulator(); accumulator.sample(rows, at);
  const [interval] = accumulator.sample(rows, at + 15_000).intervals;
  assert.equal(interval.transport, 'cloud');
  assert(!interval.quality.includes('local_ocpp'));
});


test('local OCPP requires durable storage, and rejects a different charger association without mutation', async () => {
  const missingStorage = createEaseeOcpp({ config, chargerId: 'fixture', canControl: () => true });
  await missingStorage.start(); assert.equal(missingStorage.status().error, 'transaction-state-unavailable'); await missingStorage.close();
  let writes = 0;
  const mismatch = createEaseeOcpp({ config, chargerId: 'fixture', canControl: () => true,
    state: { get: () => ({ version: 1, scope: 'different' }), set() { writes++; } } });
  await mismatch.start(); assert.equal(mismatch.status().error, 'incompatible-transaction-state'); assert.equal(writes, 0); await mismatch.close();
});

test('transaction replies survive reconnect and restart, deduplicate content and fail closed on storage loss', async t => {
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  let saved, broken = false, now = at, local, ws;
  const state = { get: () => structuredClone(saved), set: value => { if (broken) throw new Error('synthetic storage failure'); saved = structuredClone(value); } };
  t.after(async () => { ws?.terminate(); await local?.close(); });
  const pending = new Map(), settings = [];
  let sequence = 0;
  const call = (action, payload, id = String(++sequence)) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic OCPP reply timeout')); }, 2000);
    pending.set(id, reply => { clearTimeout(timer); resolve(reply); }); ws.send(JSON.stringify([2, id, action, payload]));
  });
  const connect = async () => {
    local = createEaseeOcpp({ config: { ...config, port }, chargerId: 'fixture-charger', state, clock: () => now, canControl: () => true });
    await local.start();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
      headers: { Authorization: `Basic ${Buffer.from(`fixture-charger:${config.password}`).toString('base64')}` },
    });
    ws.on('error', () => {}); await once(ws, 'open');
    ws.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame[0] === 2) {
        if (frame[2] === 'ChangeConfiguration') settings.push(frame[3]);
        ws.send(JSON.stringify([3, frame[1], { status: frame[3]?.key === 'MeterValuesAlignedData' ? 'Rejected' : 'Accepted' }]));
      } else { const resolve = pending.get(frame[1]); pending.delete(frame[1]); resolve?.(frame); }
    });
    await call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
    // The server serializes CALLs; finish all configuration replies before
    // asserting the resulting health rather than racing the next frame.
    for (let index = 0; index < 8 && local.status().pendingConfiguration.length; index++) await call('Heartbeat', {});
  };
  await connect();
  assert(settings.some(row => row.key === 'MeterValuesSampledData' && row.value === 'Power.Active.Import,Current.Import,Voltage'));
  assert(settings.some(row => row.key === 'MeterValuesAlignedData'));
  assert.deepEqual(local.status().configurationFailures, ['MeterValuesAlignedData']);
  const start = { connectorId: 1, idTag: 'fixture-tag', timestamp: new Date(now).toISOString(), meterStart: 1000 };
  const first = await call('StartTransaction', start), id = first[2].transactionId;
  assert.equal(first[2].idTagInfo.status, 'Accepted');
  assert.equal(saved.activeId, id);
  assert(!JSON.stringify(saved).includes('fixture-tag'));
  assert.equal((await call('StartTransaction', start))[2].transactionId, id);
  assert.equal((await call('StartTransaction', { ...start, meterStart: 1001 }))[0], 4);
  await call('Authorize', { idTag: 'fixture-tag' }, 'duplicate');
  assert.equal((await call('Authorize', { idTag: 'unknown' }, 'duplicate'))[0], 4);
  // The durable transaction fingerprint survives both reply-cache eviction and restart.
  for (let index = 0; index < 130; index++) await call('Heartbeat', {});
  assert.equal((await call('StartTransaction', start))[2].transactionId, id);
  ws.terminate(); await local.close(); await connect();
  assert.equal((await call('StartTransaction', start))[2].transactionId, id);
  now += 60_000;
  const stop = { transactionId: id, timestamp: new Date(now).toISOString(), meterStop: 900 };
  assert.equal((await call('StopTransaction', { ...stop, transactionId: id + 1 }))[0], 4);
  assert.equal((await call('StopTransaction', stop))[0], 3);
  assert.equal(saved.activeId, null);
  assert.equal(saved.transactions.at(-1).meterStart, 1000);
  assert.equal(saved.transactions.at(-1).meterStop, 900, 'A reset meter ends the protocol transaction without fabricating energy');
  assert.equal((await call('StopTransaction', stop))[0], 3);
  assert.equal((await call('StopTransaction', { ...stop, meterStop: 1101 }))[0], 4);
  now += 1000;
  const next = await call('StartTransaction', { ...start, timestamp: new Date(now).toISOString(), meterStart: 0 });
  assert.equal(next[2].idTagInfo.status, 'Accepted');
  assert.equal(saved.activeId, next[2].transactionId);
  assert.notEqual(saved.activeId, id);
  broken = true;
  assert.equal((await call('Authorize', { idTag: 'fixture-tag' }))[0], 4);
  assert.equal((await call('StartTransaction', { ...start, timestamp: new Date(now).toISOString() }))[0], 4);
  assert.equal(local.status().error, 'transaction-state-unavailable');
});

test('listener readiness is separate from live evidence and empty tags never enroll an observed identifier', async t => {
  const f = await fixture(t, { authorization_tags: [] });
  assert.deepEqual(Object.fromEntries(['configured', 'listening', 'ready', 'connected', 'available'].map(key => [key, f.local.status()[key]])),
    { configured: true, listening: true, ready: true, connected: false, available: false });
  assert.equal(f.local.status().controlTransport, 'ocpp');
  const client = await f.connect();
  assert.equal((await client.call('Authorize', { idTag: 'unregistered-fixture' }))[2].idTagInfo.status, 'Invalid');
  assert.equal((await client.call('Authorize', { idTag: 'unregistered-fixture' }))[2].idTagInfo.status, 'Invalid');
  const start = await client.call('StartTransaction', { connectorId: 1, idTag: 'unregistered-fixture',
    timestamp: new Date(at).toISOString(), meterStart: 0 });
  assert.equal(start[2].idTagInfo.status, 'Invalid');
  await client.call('MeterValues', meter());
  assert.equal(f.local.status().available, true, 'Authenticated telemetry does not imply permission to charge');
  assert.equal(f.local.status().hasBootReported, false, 'A reconnect does not fabricate a boot report');
});

test('an authenticated reconnect replaces a half-open socket and never reuses its telemetry or boot evidence', async t => {
  const f = await fixture(t), first = await f.connect();
  await first.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  await first.call('MeterValues', meter());
  assert.equal(f.local.status().available, true);
  const rejected = new WebSocket(`ws://127.0.0.1:${f.port}/ocpp/fixture-charger`, 'ocpp1.6');
  await once(rejected, 'error');
  assert.equal(f.local.status().available, true, 'A failed unauthenticated upgrade cannot disconnect the real charger');
  const closed = once(first.ws, 'close'), second = await f.connect(); await closed;
  assert.equal(f.local.status().available, false);
  assert.equal(f.local.status().hasBootReported, false);
  await second.call('Heartbeat', {});
  assert.equal(f.local.status().connected, true);
  assert.equal(f.local.status().available, false);
  await second.call('MeterValues', meter());
  assert.equal(f.local.status().available, true);
  const oldWrites = f.writes, disconnected = once(second.ws, 'close');
  f.permitted = false; f.local.refreshAuthority(); await disconnected;
  assert.equal(f.local.status().ready, false);
  assert.equal(f.local.status().connected, false);
  assert.equal(f.local.snapshot(), null);
  assert.equal(f.writes, oldWrites, 'Losing authority must not mutate the transaction ledger');
});

test('listener bind failures are retryable, concurrent starts join, and close drains startup', async t => {
  const port = await freePort(), blocker = createServer();
  blocker.listen(port, '127.0.0.1'); await once(blocker, 'listening');
  let saved;
  const local = createEaseeOcpp({ config: { ...config, port }, chargerId: 'fixture', canControl: () => true,
    state: { get: () => saved, set: value => { saved = value; } } });
  t.after(async () => { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); await local.close(); });
  await Promise.all([local.start(), local.start()]);
  assert.equal(local.status().listening, false);
  assert.equal(local.status().ready, false);
  assert.equal(local.status().error, 'listener-unavailable');
  await new Promise(resolve => blocker.close(resolve));
  await Promise.all([local.start(), local.start()]);
  assert.equal(local.status().ready, true);
  assert.equal(local.status().error, null);
  await local.close(); assert.equal(local.status().listening, false);
  const closing = createEaseeOcpp({ config: { ...config, port }, chargerId: 'fixture', canControl: () => true,
    state: { get: () => saved, set: value => { saved = value; } } });
  const starting = closing.start(); await closing.close(); await starting;
  assert.equal(closing.status().listening, false);
  // Binding the same fixture port verifies close did not leave a listener behind.
  blocker.listen(port, '127.0.0.1'); await once(blocker, 'listening');
});

test('passive listeners neither initialize nor rewrite transaction state', async t => {
  const port = await freePort(); let writes = 0;
  const local = createEaseeOcpp({ config: { ...config, port }, chargerId: 'fixture', canControl: () => false,
    state: { get: () => null, set() { writes++; } } });
  t.after(() => local.close()); await local.start();
  assert.equal(local.status().listening, true); assert.equal(local.status().ready, false);
  assert.equal(writes, 0);
});

test('telemetry configuration calls are serialized and timeout becomes visible instead of pending forever', async t => {
  const f = await fixture(t), client = await f.connect({ autoReply: false });
  await client.call('Heartbeat', {});
  assert.equal(client.calls.length, 1);
  assert.equal(f.local.status().pendingConfiguration.length, 4);
  const next = once(client.ws, 'message'); f.now = at + 15_000; await next;
  assert.equal(client.calls.length, 2);
  assert.deepEqual(f.local.status().configurationFailures, ['MeterValuesSampledData']);
  assert.equal(f.local.status().pendingConfiguration.length, 3);
  const disconnected = once(client.ws, 'close');
  client.ws.send(JSON.stringify([3, client.calls[1][1], { status: 'Accepted' }, 'extra']));
  assert.equal((await disconnected)[0], 1002, 'Malformed acknowledgement cannot prove configuration applied');
});

test('authenticated connections that send no OCPP messages expire and release the socket', async t => {
  const f = await fixture(t), client = await f.connect(), disconnected = once(client.ws, 'close');
  f.now = at + 31_000; await disconnected;
  assert.equal(f.local.status().connected, false);
  const next = await f.connect(); await next.call('Heartbeat', {});
  assert.equal(f.local.status().connected, true);
});

const preparing = { connectorId: 1, status: 'Preparing', errorCode: 'NoError' };
const remoteStarts = client => client.calls.filter(call => call[2] === 'RemoteStartTransaction');
const connector = (status, time = at) => ({ connectorId: 1, status, errorCode: 'NoError', timestamp: new Date(time).toISOString() });
async function flushCalls(client) {
  for (let index = 0; index < 8; index++) await client.call('Heartbeat', {});
}

test('remote start waits for an explicit control permission and rechecks it before sending', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag');
  f.startPermitted = false;
  const client = await f.connect({ autoReply: false });
  await client.call('StatusNotification', preparing);
  assert.equal(f.local.status().remoteStartStatus, 'idle');
  f.startPermitted = true;
  await client.call('StatusNotification', preparing);
  assert.equal(f.local.status().remoteStartStatus, 'queued');
  f.startPermitted = false;
  for (let index = 0; index < 6; index++) {
    const call = client.calls[index];
    if (call) client.ws.send(JSON.stringify([3, call[1], { status: 'Accepted' }]));
    await client.call('Heartbeat', {});
  }
  assert.equal(remoteStarts(client).length, 0);
  f.startPermitted = true;
  await client.call('StatusNotification', preparing);
  assert.equal(remoteStarts(client).length, 1, 'A revoked queued permission does not consume the later scheduled start');
});

test('automatic virtual-tag authorization follows present permission without leaving a reusable authorization cache entry', async t => {
  const tag = 'fixture-virtual-tag', f = await fixture(t, { authorization_mode: 'plug-and-charge' }, tag), client = await f.connect();
  f.startPermitted = false;
  assert.deepEqual((await client.call('Authorize', { idTag: tag }, 'authorization-retry'))[2].idTagInfo,
    { status: 'Blocked', expiryDate: new Date(at).toISOString() });
  assert.equal((await client.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted',
    'A configured physical RFID remains an explicit external authorization');
  f.startPermitted = true;
  assert.deepEqual((await client.call('Authorize', { idTag: tag }, 'authorization-retry'))[2].idTagInfo,
    { status: 'Accepted', expiryDate: new Date(at).toISOString() });
  f.startPermitted = false;
  assert.equal((await client.call('Authorize', { idTag: tag }, 'authorization-retry'))[2].idTagInfo.status, 'Blocked',
    'A cached successful Authorize response cannot bypass a revoked automatic permission');
  assert.equal((await client.call('Authorize', { idTag: 'fixture-tag' }, 'authorization-retry'))[2], 'ProtocolError');
  assert.equal(remoteStarts(client).length, 0);
});

test('unsolicited virtual StartTransaction cannot bypass waiting and its later genuine start preserves historical replies', async t => {
  const tag = 'fixture-virtual-tag', f = await fixture(t, { authorization_mode: 'plug-and-charge' }, tag), client = await f.connect();
  const start = { connectorId: 1, idTag: tag, meterStart: 10, timestamp: new Date(at).toISOString() };
  f.startPermitted = false;
  const blocked = await client.call('StartTransaction', start);
  assert.equal(blocked[0], 3);
  assert.deepEqual(blocked[2].idTagInfo, { status: 'Blocked', expiryDate: start.timestamp });
  assert.equal(f.saved.activeId, null);
  assert.equal(f.saved.transactions[0].status, 'Blocked');
  f.now = at + 1000; f.startPermitted = true;
  const accepted = await client.call('StartTransaction', { ...start, timestamp: new Date(at + 1000).toISOString() });
  assert.equal(accepted[2].idTagInfo.status, 'Accepted');
  assert.notEqual(accepted[2].transactionId, blocked[2].transactionId);
  assert.deepEqual((await client.call('StartTransaction', start))[2], blocked[2]);
  f.startPermitted = false;
  assert.deepEqual((await client.call('StartTransaction', { ...start, timestamp: new Date(at + 1000).toISOString() }))[2], accepted[2],
    'A replay acknowledges an existing accepted transaction rather than authorizing a new one');
  f.now = at + 2000;
  assert.equal((await client.call('StartTransaction', { ...start, timestamp: new Date(at + 2000).toISOString() }))[2],
    'OccurrenceConstraintViolation');
  assert.equal(f.saved.activeId, accepted[2].transactionId, 'A refused additional start cannot replace the accepted physical transaction');
  assert.equal((await client.call('StopTransaction', { transactionId: blocked[2].transactionId,
    timestamp: start.timestamp, meterStop: 10 }))[0], 3);
  assert.equal(f.saved.activeId, accepted[2].transactionId);
  const restarted = await fixture(t, { authorization_mode: 'plug-and-charge' }, tag, f.saved);
  assert.equal(restarted.local.status().ready, true);
});

test('configured RFID StartTransaction remains available while automatic virtual starts are withheld', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  f.startPermitted = false;
  assert.equal((await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 10,
    timestamp: new Date(at).toISOString() }))[2].idTagInfo.status, 'Accepted');
});

test('repeated current transaction measurements recover a profile target without inventing authorization or start history', async t => {
  const f = await fixture(t), client = await f.connect();
  const paused = samples.map(row => ({ ...row, value: row.measurand === 'Voltage' ? row.value : '0' }));
  await client.call('StatusNotification', connector('SuspendedEVSE'));
  await client.call('MeterValues', { ...meter(paused), transactionId: 711 });
  assert.equal(f.local.controlSnapshot().transaction, null);
  await client.call('MeterValues', { ...meter(paused), transactionId: 711 });
  assert.equal(f.local.controlSnapshot().transaction, null, 'Repeated cached source time is not independent evidence');
  f.now = at + 30_000;
  await client.call('MeterValues', { ...meter(paused, at + 30_000), transactionId: 711 });
  assert.deepEqual(f.local.controlSnapshot().transaction, {
    id: 711, startedAt: null, tagHash: null, confirmed: true, provenance: 'meter-values', confirmedAt: at + 30_000,
  });
  assert.deepEqual(f.saved.transactions, []);
  assert.equal(f.saved.latestStartAt, 0);
  assert.deepEqual(f.saved.recovered, { activeId: 711, transactions: [{ id: 711, observedAt: at, confirmedAt: at + 30_000, lastEvidenceAt: at + 30_000 }] });
  assert.equal((await client.call('Authorize', { idTag: 'unknown-fixture-tag' }))[2].idTagInfo.status, 'Invalid');
  f.now = at + 91_000; await client.call('Heartbeat', {});
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false, 'Heartbeats cannot refresh transaction evidence');
});

test('recovered transactions require fresh repeated confirmation after reconnect, boot and same-version restart', async t => {
  const f = await fixture(t), first = await f.connect();
  await first.call('StatusNotification', connector('Charging'));
  await first.call('MeterValues', { ...meter(), transactionId: 712 });
  f.now = at + 1000;
  await first.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 712 });
  const next = await f.connect();
  await next.call('StatusNotification', connector('SuspendedEVSE', at + 1000));
  await next.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 712 });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false);
  f.now = at + 2000;
  await next.call('MeterValues', { ...meter(samples, at + 2000), transactionId: 712 });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true);
  await next.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  await next.call('StatusNotification', connector('SuspendedEVSE', at + 2000));
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false);
  const restarted = await fixture(t, {}, '', f.saved); restarted.now = at + 3000;
  const client = await restarted.connect();
  await client.call('StatusNotification', connector('SuspendedEVSE', at + 3000));
  await client.call('MeterValues', { ...meter(samples, at + 2000), transactionId: 712 });
  assert.equal(restarted.local.controlSnapshot().transaction.confirmed, false, 'Pre-connection replay cannot grant control');
  await client.call('MeterValues', { ...meter(samples, at + 3000), transactionId: 712 });
  restarted.now = at + 4000;
  await client.call('MeterValues', { ...meter(samples, at + 4000), transactionId: 712 });
  assert.equal(restarted.local.controlSnapshot().transaction.confirmed, true);
  assert.equal(restarted.local.controlSnapshot().transaction.startedAt, null);
});

test('conflicting transaction identities revoke recovery and cannot be voted away by repeated readings', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 713 });
  f.now = at + 1000;
  await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 714 });
  for (let offset = 2000; offset <= 4000; offset += 1000) {
    f.now = at + offset;
    await client.call('MeterValues', { ...meter(samples, at + offset), transactionId: 713 });
  }
  assert.equal(f.local.controlSnapshot().transaction, null);
  assert.equal(f.saved.recovered, undefined);
});

test('current measurements maintain recovered confirmation and an explicit later end allows a new authorized session', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  await client.call('StatusNotification', connector('SuspendedEVSE'));
  for (let offset = 0; offset <= 120_000; offset += 30_000) {
    f.now = at + offset;
    await client.call('MeterValues', { ...meter(samples, at + offset), transactionId: 719 });
  }
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true, 'An unchanged suspended status does not invalidate fresh transaction measurements');
  f.now = at + 121_000;
  await client.call('StatusNotification', connector('Available', at + 121_000));
  assert.equal(f.local.controlSnapshot().transaction, null);
  assert.deepEqual(f.saved.recovered.transactions[0].endedByStatus,
    { status: 'Available', at: at + 121_000, receivedAt: at + 121_000 });
  assert.equal(f.saved.recovered.transactions[0].stoppedAt, undefined);
  f.now = at + 122_000;
  await client.call('StatusNotification', connector('Preparing', at + 122_000)); await flushCalls(client);
  assert.equal(remoteStarts(client).length, 1);
  const restarted = await fixture(t, {}, '', f.saved);
  assert.equal(restarted.local.status().ready, true);
});

test('a new conflicting current ID revokes confirmed recovery while older out-of-order reports cannot replace it', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 720 });
  f.now = at + 2000; await client.call('MeterValues', { ...meter(samples, at + 2000), transactionId: 720 });
  await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 721 });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true);
  f.now = at + 3000; await client.call('MeterValues', { ...meter(samples, at + 3000), transactionId: 721 });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false);
  f.now = at + 4000; await client.call('MeterValues', { ...meter(samples, at + 4000), transactionId: 720 });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false);
  assert.equal(f.saved.recovered.activeId, 720, 'The conflicting ID never becomes a replacement control target');
});

test('recovery rejects stale, future, connector-zero, non-power and invalid transaction evidence', async t => {
  for (const kind of ['stale', 'future', 'connector-zero', 'voltage-only', 'invalid-id', 'implicit-status', 'preparing']) {
    const f = await fixture(t), client = await f.connect();
    await client.call('StatusNotification', kind === 'implicit-status' ? { ...preparing, status: 'SuspendedEVSE' }
      : connector(kind === 'preparing' ? 'Preparing' : 'SuspendedEVSE'));
    for (let offset = 0; offset <= 1000; offset += 1000) {
      f.now = at + offset;
      const payload = { ...meter(kind === 'voltage-only' ? samples.filter(row => row.measurand === 'Voltage') : samples,
        at + offset + (kind === 'stale' ? -61_000 : kind === 'future' ? 500 : 0)),
      transactionId: kind === 'invalid-id' ? 2147483648 : 715,
      connectorId: kind === 'connector-zero' ? 0 : 1 };
      await client.call('MeterValues', payload);
    }
    assert.equal(f.local.controlSnapshot().transaction, null, kind);
    assert.equal(f.saved.recovered, undefined, kind);
  }
});

test('a real StopTransaction closes an observed transaction and cannot resurrect it from later meter reports', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 716 });
  f.now = at + 1000; await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 716 });
  const stopped = { transactionId: 716, timestamp: new Date(at + 1000).toISOString(), meterStop: 42 };
  assert.equal((await client.call('StopTransaction', stopped))[0], 3);
  assert.equal(f.local.controlSnapshot().transaction, null);
  assert.equal(f.saved.recovered.transactions[0].meterStop, 42);
  assert.equal(f.saved.recovered.transactions[0].startedAt, undefined);
  assert.equal((await client.call('StopTransaction', stopped))[0], 3);
  for (let offset = 2000; offset <= 3000; offset += 1000) {
    f.now = at + offset; await client.call('MeterValues', { ...meter(samples, at + offset), transactionId: 716 });
  }
  assert.equal(f.local.controlSnapshot().transaction, null);
});

test('explicit local transaction stop reasons survive receiver restart with their original source clock', async t => {
  for (const reason of ['Remote', 'Local', 'DeAuthorized']) {
    const f = await fixture(t), client = await f.connect();
    await client.call('StatusNotification', connector('Preparing'));
    const started = await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0,
      timestamp: new Date(at).toISOString() });
    const transactionId = started[2].transactionId;
    f.now = at + 1100;
    const stopped = { transactionId, timestamp: new Date(at + 1000).toISOString(), meterStop: 1, reason };
    assert.equal((await client.call('StopTransaction', stopped))[0], 3);
    const expected = { transactionId, at: at + 1000, receivedAt: at + 1100, reason };
    assert.deepEqual(f.local.controlSnapshot().nativeStop, expected);
    f.now = at + 1800;
    assert.equal((await client.call('StopTransaction', stopped))[0], 3, 'Identical stops remain idempotent');
    assert.deepEqual(f.local.controlSnapshot().nativeStop, expected, 'Retries cannot renew the first receipt clock');
    assert.equal((await client.call('StopTransaction', { ...stopped, reason: reason === 'Local' ? 'Remote' : 'Local' }))[0], 4,
      'A conflicting stop reason cannot rewrite recorded instruction evidence');
    const restarted = await fixture(t, {}, '', f.saved); restarted.now = at + 2000;
    const current = await restarted.connect();
    await current.call('StatusNotification', connector('Preparing', at + 2000));
    assert.deepEqual(restarted.local.controlSnapshot().nativeStop, expected);
  }
});

test('small future Start and Stop calls wait once for source time and retain their first receipt clocks', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Preparing'));
  const start = client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0,
    timestamp: new Date(at + 80).toISOString() });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.saved.transactions.length, 0, 'A future transaction cannot authorize control before its source time');
  f.now = at + 80;
  const started = await start, transactionId = started[2].transactionId;
  assert.equal(started[2].idTagInfo.status, 'Accepted');
  assert.equal(f.saved.transactions[0].startedAt, at + 80);
  assert.equal(f.saved.transactions[0].startReceivedAt, at);
  const body = { transactionId, meterStop: 1, reason: 'Remote', timestamp: new Date(at + 160).toISOString() };
  const stop = client.call('StopTransaction', body, 'deferred-stop');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.saved.transactions[0].stoppedAt, undefined);
  f.now = at + 130;
  client.ws.send(JSON.stringify([2, 'deferred-stop', 'StopTransaction', body]));
  await new Promise(resolve => setTimeout(resolve, 10));
  f.now = at + 160;
  assert.equal((await stop)[0], 3);
  assert.deepEqual(f.local.controlSnapshot().nativeStop,
    { transactionId, at: at + 160, receivedAt: at + 80, reason: 'Remote' });
  assert.equal(f.local.status().lastMessageAt, at + 130, 'Releasing a quarantined frame cannot renew transport activity');
  const restarted = await fixture(t, {}, '', f.saved); restarted.now = at + 200;
  const again = await restarted.connect(); await again.call('StatusNotification', connector('Preparing', at + 200));
  assert.equal(restarted.local.controlSnapshot().nativeStop.receivedAt, at + 80);
});

test('future transaction waiting preserves payload, connection and current authorization fences', async t => {
  const malformed = await fixture(t), client = await malformed.connect();
  await client.call('StatusNotification', connector('Preparing'));
  for (const body of [{ meterStart: 0, timestamp: new Date(at + 1001).toISOString() },
    { meterStart: 1.5, timestamp: new Date(at + 80).toISOString() }]) {
    const reply = await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', ...body });
    assert.equal(reply[0], 4); assert.equal(reply[2], 'FormationViolation');
  }
  assert.equal(malformed.saved.transactions.length, 0);
  for (const change of ['permission', 'reconnect', 'boot', 'authority']) {
    const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), current = await f.connect();
    await current.call('StatusNotification', connector('Preparing'));
    const body = { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0, timestamp: new Date(at + 80).toISOString() };
    const replies = [];
    current.ws.on('message', data => { const frame = JSON.parse(data); if (frame[1] === 'future-start') replies.push(frame); });
    current.ws.send(JSON.stringify([2, 'future-start', 'StartTransaction', body]));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.saved.transactions.length, 0);
    if (change === 'permission') f.startPermitted = false;
    if (change === 'reconnect') await f.connect();
    if (change === 'boot') await current.call('BootNotification', { chargePointVendor: 'Fixture', chargePointModel: 'Fixture' });
    if (change === 'authority') { f.permitted = false; f.local.refreshAuthority(); }
    f.now = at + 80;
    await new Promise(resolve => setTimeout(resolve, 90));
    if (change === 'permission') {
      assert.equal(f.saved.transactions[0].status, 'Blocked');
      assert.equal(replies[0][2].idTagInfo.status, 'Blocked');
    } else {
      assert.equal(f.saved.transactions.length, 0, change);
      assert.deepEqual(replies, [], change);
    }
  }
});

test('quarantined native meter evidence can recover a transaction only after both source times arrive', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(samples, at + 80), transactionId: 777 });
  assert.equal(f.local.controlSnapshot().transaction, null);
  f.now = at + 80; assert.equal(f.local.controlSnapshot().transaction, null);
  f.now = at + 1000;
  await client.call('MeterValues', { ...meter(samples, at + 1080), transactionId: 777 });
  assert.equal(f.local.controlSnapshot().transaction, null);
  f.now = at + 1080;
  assert.equal(f.local.controlSnapshot().transaction.id, 777);
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true);
  assert.equal(f.local.controlSnapshot().readings.find(row => row.id === 120).receivedAt, at + 1000);
});

test('suspension and unrelated transaction endings never invent external stop instructions', async t => {
  for (const reason of [undefined, 'EVDisconnected', 'PowerLoss', 'Other']) {
    const f = await fixture(t), client = await f.connect();
    await client.call('StatusNotification', connector('SuspendedEVSE'));
    assert.equal(f.local.controlSnapshot().nativeStop, null);
    await client.call('MeterValues', { ...meter(), transactionId: 716 });
    f.now = at + 1000; await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 716 });
    const stopped = { transactionId: 716, timestamp: new Date(at + 1000).toISOString(), meterStop: 42,
      ...(reason ? { reason } : {}) };
    assert.equal((await client.call('StopTransaction', stopped))[0], 3);
    assert.equal(f.local.controlSnapshot().nativeStop, null);
    assert.equal(f.saved.recovered.transactions[0].stopReason, undefined);
  }
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 716 });
  f.now = at + 1000; await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 716 });
  await client.call('StopTransaction', { transactionId: 716, timestamp: new Date(at + 1000).toISOString(), meterStop: 42, reason: 'Remote' });
  assert.deepEqual(f.local.controlSnapshot().nativeStop, { transactionId: 716, at: at + 1000, receivedAt: at + 1000, reason: 'Remote' });
  const invalid = f.saved; invalid.recovered.transactions[0].stopReason = 'Unknown';
  const rejected = await fixture(t, {}, '', invalid);
  assert.equal(rejected.local.status().error, 'incompatible-transaction-state');
  assert.equal(rejected.writes, 0);
});

test('a later authorized StartTransaction supersedes observed identity without fabricating its missing stop', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 717 });
  f.now = at + 1000; await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 717 });
  f.now = at + 2000;
  const response = await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 44,
    timestamp: new Date(at + 2000).toISOString() });
  assert.equal(response[0], 3);
  assert.equal(f.saved.recovered.activeId, null);
  assert.deepEqual(f.saved.recovered.transactions[0].endedByNewStart, { transactionId: response[2].transactionId, startedAt: at + 2000 });
  assert.equal(f.saved.recovered.transactions[0].stoppedAt, undefined);
  const restarted = await fixture(t, {}, '', f.saved);
  assert.equal(restarted.local.status().ready, true);
});

test('explicit native handback retains mode-disable intent for an observed transaction and bounds its later recovery attempt', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  await client.call('StatusNotification', connector('SuspendedEVSE'));
  await client.call('MeterValues', { ...meter(), transactionId: 722 });
  f.now = at + 1000; await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 722 });
  f.local.noteModeDisableRequested();
  const next = await f.connect(); f.now = at + 2000;
  await next.call('StatusNotification', connector('Preparing', at + 2000)); await flushCalls(next);
  assert.equal(remoteStarts(next).length, 1);
  assert.equal(f.saved.recovered.transactions[0].modeDisableIntent.attemptedAt, at + 2000);
  const restarted = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag', f.saved);
  restarted.now = at + 3000; const replacement = await restarted.connect();
  await replacement.call('StatusNotification', connector('Preparing', at + 3000)); await flushCalls(replacement);
  assert.equal(remoteStarts(replacement).length, 0, 'Restart cannot replenish a used explicit mode recovery attempt');
});

test('malformed recovery state and failed evidence persistence never grant control', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', connector('Charging'));
  await client.call('MeterValues', { ...meter(), transactionId: 718 });
  const before = f.saved; f.broken = true; f.now = at + 1000;
  assert.equal((await client.call('MeterValues', { ...meter(samples, at + 1000), transactionId: 718 }))[0], 4);
  assert.deepEqual(f.saved, before); assert.equal(f.local.controlSnapshot(), null);
  const bad = await fixture(t, {}, '', { ...before, recovered: { activeId: 718,
    transactions: [{ id: 718, observedAt: at, lastEvidenceAt: at + 1000, tagHash: 'invented' }] } });
  assert.equal(bad.local.status().error, 'incompatible-transaction-state'); assert.equal(bad.writes, 0);
});

test('plug-and-charge uses only the known private tag and starts once per current Preparing transition', async t => {
  const virtualTag = 'fixture-virtual-tag';
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, virtualTag), client = await f.connect();
  assert.equal((await client.call('Authorize', { idTag: virtualTag }))[2].idTagInfo.status, 'Accepted');
  assert.equal((await client.call('Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
  assert.equal((await client.call('Authorize', { idTag: 'unknown-tag' }))[2].idTagInfo.status, 'Invalid');
  await client.call('StatusNotification', { ...preparing, connectorId: 0 });
  await client.call('StatusNotification', { ...preparing, timestamp: 'invalid' });
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 1001).toISOString() });
  await flushCalls(client); assert.equal(remoteStarts(client).length, 0);
  await client.call('StatusNotification', preparing, 'preparing-1'); await flushCalls(client);
  assert.equal(remoteStarts(client).length, 1);
  assert.deepEqual(remoteStarts(client)[0][3], { connectorId: 1, idTag: virtualTag });
  assert.equal(f.local.status().remoteStartStatus, 'accepted');
  assert.equal(JSON.stringify(f.local.status()).includes(virtualTag), false, 'The private tag is absent from public status');
  await client.call('StatusNotification', preparing, 'preparing-1');
  await client.call('StatusNotification', preparing); await flushCalls(client);
  assert.equal(remoteStarts(client).length, 1, 'A repeated Preparing report cannot restart a session');
  await client.call('StatusNotification', { ...preparing, status: 'Available' });
  await client.call('StatusNotification', preparing); await flushCalls(client);
  assert.equal(remoteStarts(client).length, 2);
  const next = await f.connect(); await next.call('Heartbeat', {}); await flushCalls(next);
  assert.equal(remoteStarts(next).length, 0, 'Reconnect requires a fresh Preparing report');
  await next.call('StatusNotification', preparing); await flushCalls(next);
  assert.equal(remoteStarts(next).length, 1);
  const started = await next.call('StartTransaction', { connectorId: 1, idTag: virtualTag,
    timestamp: new Date(at).toISOString(), meterStart: 0 });
  assert.equal(started[2].idTagInfo.status, 'Accepted');
  await next.call('StatusNotification', { ...preparing, status: 'Available' });
  await next.call('StatusNotification', preparing); await flushCalls(next);
  assert.equal(remoteStarts(next).length, 1, 'An unresolved durable transaction prevents a second start');
});

test('RFID mode and missing plug-and-charge private identity never invent a remote-start tag', async t => {
  for (const [mode, tag] of [['rfid', 'fixture-virtual-tag'], ['plug-and-charge', '']]) {
    const f = await fixture(t, { authorization_mode: mode, authorization_tags: [] }, tag), client = await f.connect();
    await client.call('StatusNotification', preparing); await flushCalls(client);
    assert.equal(remoteStarts(client).length, 0);
    assert.equal((await client.call('Authorize', { idTag: 'fixture-virtual-tag' }))[2].idTagInfo.status, 'Invalid');
    if (mode === 'plug-and-charge') {
      assert.equal(f.local.status().ready, false);
      assert.equal(f.local.status().error, 'authorization-unavailable');
    }
  }
});

test('remote start rejection and timeout do not loop, and obsolete queued starts are cancelled', async t => {
  const options = { authorization_mode: 'plug-and-charge', authorization_tags: [] };
  const f = await fixture(t, options, 'fixture-virtual-tag');
  const rejected = await f.connect({ autoReply: frame => frame[2] === 'RemoteStartTransaction' ? 'Rejected' : 'Accepted' });
  await rejected.call('StatusNotification', preparing); await flushCalls(rejected);
  assert.equal(f.local.status().remoteStartStatus, 'rejected');
  await rejected.call('StatusNotification', preparing); await flushCalls(rejected);
  assert.equal(remoteStarts(rejected).length, 1);
  const client = await f.connect({ autoReply: false });
  await client.call('StatusNotification', preparing);
  assert.equal(f.local.status().remoteStartStatus, 'queued');
  await client.call('StatusNotification', { ...preparing, status: 'Available' });
  client.ws.send(JSON.stringify([3, client.calls[0][1], { status: 'Accepted' }]));
  await client.call('Heartbeat', {});
  assert.equal(remoteStarts(client).length, 0, 'A delayed configuration reply cannot start an unplugged car');
  await client.call('StatusNotification', preparing);
  client.ws.send(JSON.stringify([3, client.calls.at(-1)[1], { status: 'Accepted' }]));
  await client.call('Heartbeat', {});
  assert.equal(remoteStarts(client).length, 1);
  assert.equal(f.local.status().remoteStartStatus, 'pending');
  const nextCall = once(client.ws, 'message'); f.now = at + 15_000; await nextCall;
  assert.equal(f.local.status().remoteStartStatus, 'timed-out');
  await client.call('StatusNotification', preparing);
  assert.equal(remoteStarts(client).length, 1);
  const closed = once(client.ws, 'close'); f.permitted = false; f.local.refreshAuthority(); await closed;
  assert.equal(f.local.status().ready, false);
});

test('plug-and-charge cannot start after durable storage failure or queued authority loss', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  await client.call('Heartbeat', {}); await flushCalls(client);
  f.broken = true;
  await client.call('StatusNotification', preparing); await flushCalls(client);
  assert.equal(remoteStarts(client).length, 0);
  assert.equal(f.local.status().remoteStartStatus, 'unavailable');
  assert.equal(f.local.status().ready, false);
  assert.equal((await client.call('Authorize', { idTag: 'fixture-virtual-tag' }))[0], 4);
  const other = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag');
  const queued = await other.connect({ autoReply: false });
  await queued.call('StatusNotification', preparing);
  assert.equal(other.local.status().remoteStartStatus, 'queued');
  const disconnected = once(queued.ws, 'close'); other.permitted = false;
  queued.ws.send(JSON.stringify([3, queued.calls[0][1], { status: 'Accepted' }])); await disconnected;
  assert.equal(remoteStarts(queued).length, 0);
});

const telemetryOnly = frame => ['ChangeConfiguration', 'TriggerMessage'].includes(frame[2]) ? 'Accepted' : null;
const resultOf = promise => promise.then(value => ({ value }), error => ({ code: error.code }));
const respond = (client, call, payload) => client.ws.send(JSON.stringify([3, call[1], payload]));
async function readyRequests(t) {
  const f = await fixture(t), client = await f.connect({ autoReply: telemetryOnly });
  await client.call('Heartbeat', {}); await flushCalls(client);
  return { f, client };
}

test('native request allowlist serializes calls, snapshots payloads and checks the final scheduler guard', async t => {
  const { f, client } = await readyRequests(t);
  await assert.rejects(f.local.request('RemoteStartTransaction', { idTag: 'untrusted' }), { code: 'ocpp-action-not-allowed' });
  await assert.rejects(f.local.request('SetChargingProfile', null), { code: 'ocpp-invalid-payload' });
  for (const payload of [{ connectorId: 1, type: 'Operative' }, { connectorId: 0, type: 'Inoperative' },
    { connectorId: 0, type: 'Operative', extra: true }])
    await assert.rejects(f.local.request('ChangeAvailability', payload), { code: 'ocpp-invalid-payload' });
  const input = { connectorId: 1, csChargingProfiles: { chargingProfileId: 3 } };
  let next = once(client.ws, 'message');
  const first = f.local.request('SetChargingProfile', input); await next;
  const sent = client.calls.at(-1); input.csChargingProfiles.chargingProfileId = 99;
  assert.equal(sent[3].csChargingProfiles.chargingProfileId, 3);
  let allowed = true;
  const revoked = resultOf(f.local.request('ClearChargingProfile', { id: 3 }, { guard: () => allowed }));
  const second = f.local.request('GetCompositeSchedule', { connectorId: 1, duration: 3600 });
  allowed = false; next = once(client.ws, 'message'); respond(client, sent, { status: 'Accepted' });
  assert.deepEqual(await first, { status: 'Accepted' });
  assert.deepEqual(await revoked, { code: 'ocpp-request-revoked' }); await next;
  assert.equal(client.calls.at(-1)[2], 'GetCompositeSchedule');
  assert.equal(client.calls.filter(call => call[2] === 'ClearChargingProfile').length, 0);
  const schedule = { status: 'Accepted', connectorId: 1, scheduleStart: new Date(at).toISOString(),
    chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 6 }] } };
  respond(client, client.calls.at(-1), schedule); assert.deepEqual(await second, schedule);
  next = once(client.ws, 'message');
  const enabled = f.local.request('ChangeAvailability', { connectorId: 0, type: 'Operative' }); await next;
  assert.deepEqual(client.calls.at(-1).slice(2), ['ChangeAvailability', { connectorId: 0, type: 'Operative' }]);
  respond(client, client.calls.at(-1), { status: 'Accepted' }); assert.deepEqual(await enabled, { status: 'Accepted' });
});

test('native send-only guard rejects a queued natural stop but accepts a stop after the command was sent', async t => {
  const { f, client } = await readyRequests(t);
  await assert.rejects(f.local.request('SetChargingProfile', {}, { beforeSend: true }), { code: 'ocpp-invalid-request' });
  await client.call('StatusNotification', { ...preparing, status: 'Charging' });
  const chargingAt = f.local.controlSnapshot().timestamp;
  const stillCharging = () => f.local.controlSnapshot()?.connectorStatus === 'Charging'
    && f.local.controlSnapshot().timestamp === chargingAt;
  let next = once(client.ws, 'message');
  const first = f.local.request('GetConfiguration', {}); await next;
  const occupied = client.calls.at(-1);
  const queued = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }, { beforeSend: stillCharging }));
  f.now = at + 1000;
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 1000).toISOString() });
  respond(client, occupied, { configurationKey: [] }); await first;
  assert.deepEqual(await queued, { code: 'ocpp-request-revoked' });
  assert.equal(client.calls.some(call => call[2] === 'SetChargingProfile'), false);

  f.now = at + 2000;
  await client.call('StatusNotification', { ...preparing, status: 'Charging', timestamp: new Date(at + 2000).toISOString() });
  let sendChecks = 0;
  next = once(client.ws, 'message');
  const sent = f.local.request('SetChargingProfile', { connectorId: 1 }, { beforeSend: () => {
    sendChecks++; return f.local.controlSnapshot()?.connectorStatus === 'Charging';
  } });
  await next; const instruction = client.calls.at(-1);
  f.now = at + 3000;
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 3000).toISOString() });
  respond(client, instruction, { status: 'Accepted' });
  assert.deepEqual(await sent, { status: 'Accepted' });
  assert.equal(sendChecks, 1, 'Status proof is checked at wire send, never after its expected physical effect');
});

test('an admitted future stop status defers the received native acknowledgement without replay', async t => {
  const { f, client } = await readyRequests(t);
  await client.call('StatusNotification', { ...preparing, status: 'Charging' });
  const connection = f.local.controlSnapshot().connectionId;
  const current = () => f.local.controlSnapshot()?.connectionId === connection;
  let settled = false;
  const next = once(client.ws, 'message'), request = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }, { guard: current }))
    .then(value => { settled = true; return value; });
  await next; const command = client.calls.at(-1);
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 138).toISOString() });
  respond(client, command, { status: 'Accepted' });
  respond(client, command, { status: 'Rejected' });
  await client.call('Heartbeat', {});
  assert.equal(settled, false, 'The first received acknowledgement awaits present-time status, without accepting a duplicate');
  assert.equal(f.local.controlSnapshot(), null);
  f.now = at + 138;
  assert.deepEqual(await request, { value: { status: 'Accepted' } });
  assert.equal(f.local.controlSnapshot().timestamp, at + 138);
  assert.equal(client.calls.filter(call => call[2] === 'SetChargingProfile').length, 1);
});

test('native acknowledgement clock wait retains external instruction, reconnect and abort fences', async t => {
  for (const change of ['native-stop', 'reconnect', 'abort']) {
    const { f, client } = await readyRequests(t), signal = new AbortController();
    await client.call('StatusNotification', { ...preparing, status: 'Charging' });
    const connection = f.local.controlSnapshot().connectionId; let nativeStop = false;
    const next = once(client.ws, 'message');
    const request = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }, {
      signal: signal.signal, guard: () => !nativeStop && f.local.controlSnapshot()?.connectionId === connection,
    }));
    await next; const command = client.calls.at(-1);
    await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 138).toISOString() });
    respond(client, command, { status: 'Accepted' }); await client.call('Heartbeat', {});
    if (change === 'native-stop') nativeStop = true;
    if (change === 'reconnect') await f.connect({ autoReply: telemetryOnly });
    if (change === 'abort') signal.abort();
    f.now = at + 138;
    assert.deepEqual(await request, { code: change === 'native-stop' ? 'ocpp-request-revoked'
      : change === 'reconnect' ? 'ocpp-disconnected' : 'ocpp-request-aborted' }, change);
    assert.equal(client.calls.filter(call => call[2] === 'SetChargingProfile').length, 1);
  }
});

test('native acknowledgement clock wait never renews for another future status or an expired original request', async t => {
  for (const change of ['later-future-status', 'original-deadline']) {
    const { f, client } = await readyRequests(t);
    await client.call('StatusNotification', { ...preparing, status: 'Charging' });
    const connection = f.local.controlSnapshot().connectionId;
    const next = once(client.ws, 'message'), request = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }, {
      guard: () => f.local.controlSnapshot()?.connectionId === connection,
    }));
    await next; const command = client.calls.at(-1);
    await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 138).toISOString() });
    respond(client, command, { status: 'Accepted' }); await client.call('Heartbeat', {});
    f.now = at + 138;
    if (change === 'later-future-status')
      await client.call('StatusNotification', { ...preparing, status: 'Charging', timestamp: new Date(at + 500).toISOString() });
    else f.now = at + 15_000;
    assert.deepEqual(await request, { code: change === 'later-future-status' ? 'ocpp-request-revoked' : 'ocpp-request-timeout' });
    assert.equal(client.calls.filter(call => call[2] === 'SetChargingProfile').length, 1);
  }
});

test('aborting a quarantined acknowledgement releases the received reply and never stalls the next native read', async t => {
  const { f, client } = await readyRequests(t), signal = new AbortController();
  await client.call('StatusNotification', { ...preparing, status: 'Charging' });
  let next = once(client.ws, 'message');
  const request = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }, { signal: signal.signal }));
  await next; const command = client.calls.at(-1);
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 138).toISOString() });
  respond(client, command, { status: 'Accepted' }); await client.call('Heartbeat', {});
  const count = client.calls.length, queued = f.local.request('GetConfiguration', {});
  await client.call('Heartbeat', {}); assert.equal(client.calls.length, count, 'The reply wait retains wire serialization');
  next = once(client.ws, 'message'); signal.abort();
  assert.deepEqual(await request, { code: 'ocpp-request-aborted' }); await next;
  assert.equal(client.calls.at(-1)[2], 'GetConfiguration');
  f.now = at + 138; respond(client, client.calls.at(-1), { configurationKey: [] });
  assert.deepEqual(await queued, { configurationKey: [] });
  assert.equal(client.calls.filter(call => call[2] === 'SetChargingProfile').length, 1);
});

test('closing the native adapter cancels a quarantined acknowledgement without a late completion', async t => {
  const { f, client } = await readyRequests(t);
  await client.call('StatusNotification', { ...preparing, status: 'Charging' });
  const next = once(client.ws, 'message'), request = resultOf(f.local.request('SetChargingProfile', { connectorId: 1 }));
  await next; const command = client.calls.at(-1);
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 138).toISOString() });
  respond(client, command, { status: 'Accepted' }); await client.call('Heartbeat', {});
  await f.local.close();
  assert.deepEqual(await request, { code: 'ocpp-disconnected' });
  f.now = at + 138; assert.equal(f.local.controlSnapshot(), null);
});

test('aborting an in-flight native request rejects the caller but retains wire serialization until its reply', async t => {
  const { f, client } = await readyRequests(t), controller = new AbortController();
  let next = once(client.ws, 'message');
  const first = resultOf(f.local.request('GetConfiguration', {}, { signal: controller.signal })); await next;
  const sent = client.calls.at(-1), count = client.calls.length;
  const queuedController = new AbortController();
  const queued = resultOf(f.local.request('ClearChargingProfile', { id: 3 }, { signal: queuedController.signal }));
  queuedController.abort(); assert.deepEqual(await queued, { code: 'ocpp-request-aborted' });
  const second = f.local.request('GetConfiguration', { key: ['SupportedFeatureProfiles'] });
  controller.abort(); assert.deepEqual(await first, { code: 'ocpp-request-aborted' });
  await client.call('Heartbeat', {}); assert.equal(client.calls.length, count);
  next = once(client.ws, 'message'); respond(client, sent, { configurationKey: [] }); await next;
  assert.deepEqual(client.calls.at(-1)[3], { key: ['SupportedFeatureProfiles'] });
  respond(client, client.calls.at(-1), { configurationKey: [{ key: 'SupportedFeatureProfiles', readonly: true, value: 'Core,SmartCharging' }] });
  assert.equal((await second).configurationKey[0].value, 'Core,SmartCharging');
});

test('native requests reject old-connection replies, revocation, CALLERROR and bounded timeouts', async t => {
  const { f, client } = await readyRequests(t);
  let next = once(client.ws, 'message'); const pending = resultOf(f.local.request('GetConfiguration', {})); await next;
  const queued = resultOf(f.local.request('ClearChargingProfile', { id: 3 }));
  const replacement = await f.connect({ autoReply: telemetryOnly });
  assert.deepEqual(await pending, { code: 'ocpp-disconnected' });
  assert.deepEqual(await queued, { code: 'ocpp-disconnected' });
  await assert.rejects(f.local.request('GetConfiguration', {}), { code: 'ocpp-unavailable' });
  await replacement.call('Heartbeat', {}); await flushCalls(replacement);
  next = once(replacement.ws, 'message');
  const failed = resultOf(f.local.request('GetConfiguration', {})); await next;
  replacement.ws.send(JSON.stringify([4, replacement.calls.at(-1)[1], 'NotSupported', 'private fixture detail', { secret: 'fixture' }]));
  assert.deepEqual(await failed, { code: 'ocpp-request-failed' });
  next = once(replacement.ws, 'message');
  const timeout = resultOf(f.local.request('GetConfiguration', {})); await next;
  f.now = at + 15_000;
  assert.deepEqual(await timeout, { code: 'ocpp-request-timeout' });
  next = once(replacement.ws, 'message');
  const lostAuthority = resultOf(f.local.request('GetConfiguration', {})); await next;
  f.permitted = false; f.local.refreshAuthority();
  assert.deepEqual(await lostAuthority, { code: 'ocpp-disconnected' });
});

test('admitted status clock skew exposes only a bounded wait and retains original evidence clocks', async t => {
  const f = await fixture(t), client = await f.connect();
  assert.equal(f.local.controlClockDelayMs(), 0);
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 138).toISOString() });
  assert.equal(f.local.controlSnapshot(), null);
  assert.equal(f.local.controlClockDelayMs(), 138);
  f.now = at + 137;
  assert.equal(f.local.controlClockDelayMs(), 1); assert.equal(f.local.controlSnapshot(), null);
  f.now = at + 138;
  assert.equal(f.local.controlClockDelayMs(), 0);
  assert.equal(f.local.controlSnapshot().timestamp, at + 138);
  assert.equal(f.local.controlSnapshot().receivedAt, at);
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 1139).toISOString() });
  assert.equal(f.local.controlClockDelayMs(), 0, 'A timestamp beyond the admitted skew cannot create a wait');
  assert.equal(f.local.controlSnapshot().timestamp, at + 138);
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 1138).toISOString() });
  assert.equal(f.local.controlClockDelayMs(), 1000);
  f.permitted = false;
  assert.equal(f.local.controlClockDelayMs(), 0); assert.equal(f.local.controlSnapshot(), null);
});

test('native control snapshots require fresh connector evidence and reconfirm saved transactions on each connection', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('Heartbeat', {}); assert.equal(f.local.controlSnapshot(), null);
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at).toISOString() });
  const empty = f.local.controlSnapshot();
  assert.equal(empty.connectorStatus, 'Preparing'); assert.equal(empty.timestamp, at); assert.equal(empty.receivedAt, at);
  assert.equal(empty.transaction, null);
  const started = await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0, timestamp: new Date(at).toISOString() });
  const id = started[2].transactionId;
  const active = f.local.controlSnapshot();
  assert.equal(active.transaction.id, id); assert.equal(active.transaction.confirmed, true);
  assert.match(active.transaction.tagHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(active).includes('fixture-tag'), false);
  const replacement = await f.connect();
  assert.equal(f.local.controlSnapshot(), null);
  await replacement.call('StatusNotification', { ...preparing, status: 'Charging' });
  const unconfirmed = f.local.controlSnapshot();
  assert.notEqual(unconfirmed.connectionId, active.connectionId);
  assert.equal(unconfirmed.transaction.id, id); assert.equal(unconfirmed.transaction.confirmed, false);
  await replacement.call('MeterValues', { ...meter(), transactionId: id });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true);
  const power = f.local.controlSnapshot().readings.find(row => row.id === 120); power.value = 0;
  assert.equal(f.local.controlSnapshot().readings.find(row => row.id === 120).value, 6.9, 'Snapshots cannot rewrite accepted measurement state');
  f.now = at + 61_000; await replacement.call('Heartbeat', {});
  const unchanged = f.local.controlSnapshot();
  assert.equal(unchanged.connectorStatus, 'Charging', 'A change-reported native status remains current on the same live connection');
  assert.equal(unchanged.timestamp, at, 'The original status time is preserved');
  assert.deepEqual(unchanged.readings, [], 'Heartbeats do not refresh measurements');
  assert.equal(unchanged.transaction.confirmed, false, 'Heartbeats do not reconfirm a transaction');
  f.now = at + 122_000;
  assert.equal(f.local.controlSnapshot(), null, 'A silent connection cannot preserve current control evidence');
});

test('live current supply retains the latest OCPP values while healthy without extending command or physical evidence', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', preparing);
  await client.call('MeterValues', meter());
  const initial = f.local.currentSupplySnapshot();
  assert.deepEqual(initial.readings.map(row => row.id), [183, 184, 185]);
  assert.deepEqual(initial.readings.map(row => row.value), [10, 10, 10]);
  for (const elapsed of [30_000, 60_000, 90_000, 120_000]) {
    f.now = at + elapsed;
    await client.call('Heartbeat', {});
    assert.deepEqual(f.local.currentSupplySnapshot(), initial, 'Health keeps source and receipt clocks unchanged');
  }
  assert.deepEqual(f.local.controlSnapshot().readings, [], 'Held load evidence cannot grant command or identification freshness');
  assert.equal(f.local.snapshot(), null, 'Ordinary measured electricity still expires');
  initial.readings[0].value = 0;
  assert.equal(f.local.currentSupplySnapshot().readings[0].value, 10, 'Returned snapshots cannot overwrite source evidence');
  await client.call('MeterValues', meter(samples.map(sample => sample.measurand === 'Current.Import'
    ? { ...sample, value: '6' } : sample), at + 120_000));
  assert.deepEqual(f.local.currentSupplySnapshot().readings.map(row => row.value), [6, 6, 6]);
  assert.deepEqual(f.local.currentSupplySnapshot().readings.map(row => row.receivedAt), [at + 120_000, at + 120_000, at + 120_000]);
});

test('current supply cannot revive cached readings after a transport outage, reconnect or native reboot', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', preparing);
  await client.call('MeterValues', meter());
  const first = f.local.currentSupplySnapshot();
  f.now = at + 61_000;
  assert.equal(f.local.currentSupplySnapshot(), null);
  await client.call('Heartbeat', {});
  const afterGap = f.local.currentSupplySnapshot();
  assert.notEqual(afterGap.epoch, first.epoch);
  assert.deepEqual(afterGap.readings, [], 'A later healthy heartbeat cannot revive pre-outage current');
  await client.call('MeterValues', meter());
  assert.deepEqual(f.local.currentSupplySnapshot().readings, [], 'Replayed old measurements do not cross the feed boundary');
  await client.call('MeterValues', meter(samples, at + 61_000));
  assert.equal(f.local.currentSupplySnapshot().readings.length, 3);
  f.now = at + 62_000;
  const replacement = await f.connect();
  assert.equal(f.local.currentSupplySnapshot(), null);
  await replacement.call('Heartbeat', {});
  await replacement.call('MeterValues', meter(samples, at + 61_000));
  assert.deepEqual(f.local.currentSupplySnapshot().readings, [], 'Old source evidence cannot cross a new socket');
  await replacement.call('MeterValues', meter(samples, at + 62_000));
  assert.equal(f.local.currentSupplySnapshot().readings.length, 3);
  assert.notEqual(f.local.currentSupplySnapshot().connectionId, first.connectionId);
  await replacement.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  assert.deepEqual(f.local.currentSupplySnapshot().readings, []);
  f.permitted = false;
  assert.equal(f.local.currentSupplySnapshot(), null, 'Authority loss clears the source connection');
});

test('current supply keeps conflicting phase evidence invalid and quarantines future source clocks', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('MeterValues', meter(samples, at + 74));
  assert.deepEqual(f.local.currentSupplySnapshot().readings, []);
  f.now = at + 74;
  assert.equal(f.local.currentSupplySnapshot().readings.length, 3);
  assert.equal(f.local.currentSupplySnapshot().readings[0].receivedAt, at);
  await client.call('MeterValues', meter([{ measurand: 'Current.Import', phase: 'L1', unit: 'A', value: '9' }], at + 74));
  const invalid = f.local.currentSupplySnapshot().readings;
  assert.equal(invalid.length, 3);
  assert.equal(invalid.find(row => row.id === 183).value, null, 'Preserve an invalid phase so another source cannot silently replace it');
});

test('old transaction ledgers are rejected before mutation and native reboot revokes prior control evidence', async t => {
  const f = await fixture(t), client = await f.connect();
  assert.equal(f.saved.version, 4);
  const old = { ...f.saved, version: 3 }; let writes = 0;
  const stale = createEaseeOcpp({ config: { ...config, port: await freePort() }, chargerId: 'fixture-charger', canControl: () => true,
    state: { get: () => old, set() { writes++; } } });
  await stale.start(); t.after(() => stale.close());
  assert.equal(stale.status().error, 'incompatible-transaction-state'); assert.equal(writes, 0);
  await client.call('StatusNotification', preparing);
  await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0, timestamp: new Date(at).toISOString() });
  const before = f.local.controlSnapshot(); assert.equal(before.transaction.confirmed, true);
  await client.call('StatusNotification', { ...preparing, status: 'Available' });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false, 'Available invalidates current session evidence without erasing the durable transaction');
  await client.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  assert.equal(f.local.controlSnapshot(), null);
  await client.call('StatusNotification', preparing);
  assert.notEqual(f.local.controlSnapshot().connectionId, before.connectionId);
  assert.equal(f.local.controlSnapshot().transaction.confirmed, false);
});

test('small future status timestamps wait for source time, preserve receipt time, and cannot cross a reconnect', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 74).toISOString() });
  await flushCalls(client);
  assert.equal(f.local.controlSnapshot(), null);
  assert.equal(remoteStarts(client).length, 0);
  f.now = at + 73; assert.equal(f.local.controlSnapshot(), null);
  const sent = once(client.ws, 'message'); f.now = at + 74;
  const current = f.local.controlSnapshot();
  assert.equal(current.timestamp, at + 74); assert.equal(current.receivedAt, at);
  await sent; await flushCalls(client);
  assert.equal(remoteStarts(client).length, 1, 'Clock catch-up releases exactly one deferred start without needing another status report');
  await client.call('StatusNotification', { ...preparing, status: 'Available' });
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 148).toISOString() });
  const replacement = await f.connect(); f.now = at + 148;
  await replacement.call('Heartbeat', {}); await flushCalls(replacement);
  assert.equal(f.local.controlSnapshot(), null);
  assert.equal(remoteStarts(replacement).length, 0, 'A future status from the previous connection cannot authorize the replacement');
  assert(replacement.calls.some(call => call[2] === 'TriggerMessage' && call[3].requestedMessage === 'StatusNotification'),
    'Reconnect explicitly requests native connector status');
});

test('future meter values become usable only at their true source time and retain their original receipt', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StatusNotification', preparing);
  const ahead = meter(samples, at + 74);
  assert.deepEqual(ocppMeterReadings(ahead, at), [], 'The pure parser still rejects future data');
  await client.call('MeterValues', ahead);
  assert.equal(f.local.snapshot(), null); assert.deepEqual(f.local.controlSnapshot().readings, []);
  f.now = at + 73; assert.equal(f.local.snapshot(), null);
  f.now = at + 74;
  const power = f.local.snapshot().find(row => row.id === 120);
  assert.equal(power.value, 6.9); assert.equal(power.timestamp, new Date(at + 74).toISOString()); assert.equal(power.receivedAt, at);
  await client.call('MeterValues', meter([{ measurand: 'Power.Active.Import', unit: 'W', value: '8000' }], at + 2000));
  f.now = at + 2000;
  assert.equal(f.local.snapshot().find(row => row.id === 120).value, 6.9, 'Excessive clock skew is discarded, not deferred');
  await client.call('MeterValues', meter(samples, at + 2100));
  const replacement = await f.connect(); f.now = at + 2100;
  await replacement.call('Heartbeat', {});
  assert.equal(f.local.snapshot(), null, 'Buffered measurements never survive reconnect');
});

test('native restart retires a missing Stop only from later explicit no-transaction status and preserves a delayed real Stop', async t => {
  const mode = { authorization_mode: 'plug-and-charge' }, virtualTag = 'fixture-virtual-tag';
  const f = await fixture(t, mode, virtualTag), before = await f.connect();
  const start = { connectorId: 1, idTag: virtualTag, meterStart: 100, timestamp: new Date(at).toISOString() };
  const firstId = (await before.call('StartTransaction', start))[2].transactionId;
  f.now = at + 1000;
  await before.call('MeterValues', { ...meter(samples, at + 1000), transactionId: firstId });
  assert.equal(f.saved.transactions[0].lastEvidenceAt, at + 1000);
  await f.local.close();

  // Native mode was disabled while this endpoint was gone. Neither closing the
  // endpoint nor recreating it is evidence that the physical transaction ended.
  const resumed = await fixture(t, mode, virtualTag, f.saved), client = await resumed.connect();
  resumed.now = at + 2000;
  await client.call('StatusNotification', { ...preparing, status: 'Charging', timestamp: new Date(at + 2000).toISOString() });
  assert.equal(resumed.saved.activeId, firstId);
  assert.equal(resumed.local.controlSnapshot().transaction.confirmed, false);
  resumed.now = at + 3000;
  await client.call('StatusNotification', { ...preparing, status: 'Available', timestamp: new Date(at + 3000).toISOString() });
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 3000).toISOString() });
  await flushCalls(client);
  assert.equal(resumed.saved.activeId, null);
  const unresolved = resumed.saved.transactions[0];
  assert.deepEqual(unresolved.endedByStatus, { status: 'Available', at: at + 3000, receivedAt: at + 3000 });
  assert.equal(unresolved.stoppedAt, undefined); assert.equal(unresolved.meterStop, undefined);
  assert.equal(resumed.local.controlSnapshot().transaction, null);
  assert.equal(remoteStarts(client).length, 1, 'A still-plugged vehicle can authorize one new native transaction');
  assert.equal((await client.call('StartTransaction', { ...start, timestamp: new Date(at + 2000).toISOString() }))[0], 4,
    'Historical starts before the explicit no-transaction report cannot become a new active session');
  const next = { ...start, timestamp: new Date(at + 3000).toISOString(), meterStart: 200 };
  const secondId = (await client.call('StartTransaction', next))[2].transactionId;
  assert.notEqual(secondId, firstId); assert.equal(resumed.saved.activeId, secondId);
  assert.equal((await client.call('StartTransaction', start))[2].transactionId, firstId, 'An old retry keeps its original response identity');
  assert.equal(resumed.saved.activeId, secondId);
  const stop = { transactionId: firstId, timestamp: new Date(at + 2500).toISOString(), meterStop: 175 };
  assert.equal((await client.call('StopTransaction', stop))[0], 3);
  assert.equal(resumed.saved.activeId, secondId, 'Late StopTransaction cannot clear the newer transaction');
  assert.equal(resumed.saved.transactions[0].meterStop, 175);
  assert.deepEqual(resumed.saved.transactions[0].endedByStatus, unresolved.endedByStatus);
  await resumed.local.close();
  const again = await fixture(t, mode, virtualTag, resumed.saved);
  assert.equal(again.local.status().ready, true, 'Current-format restart validates both real Stop and discontinuity evidence');
  assert.equal(again.saved.activeId, secondId);
});

test('explicit Available and Finishing preserve the missing transaction end without inventing energy', async t => {
  for (const status of ['Available', 'Finishing']) {
    const f = await fixture(t), client = await f.connect();
    const firstId = (await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 100,
      timestamp: new Date(at).toISOString() }))[2].transactionId;
    f.now = at + 1000;
    await client.call('StatusNotification', { ...preparing, status, timestamp: new Date(at + 1000).toISOString() });
    assert.equal(f.saved.activeId, null);
    assert.equal(f.saved.transactions[0].id, firstId);
    assert.equal(f.saved.transactions[0].endedByStatus.status, status);
    assert.equal(f.saved.transactions[0].stopFingerprint, undefined);
    assert.equal(f.saved.transactions[0].stoppedAt, undefined);
    assert.equal(f.saved.transactions[0].meterStop, undefined);
  }
});

test('Easee native Preparing reported after StartTransaction cannot retire or reauthorize the accepted session', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at).toISOString() });
  await flushCalls(client);
  assert.equal(remoteStarts(client).length, 1);
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  f.now = at + 1502;
  await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 1000).toISOString() });
  await flushCalls(client);
  assert.equal(f.saved.activeId, id); assert.equal(f.saved.transactions[0].endedByStatus, undefined);
  assert.equal(f.local.controlSnapshot().transaction.id, id);
  assert.equal(remoteStarts(client).length, 1);
  f.now = at + 2000;
  await client.call('StatusNotification', { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 2000).toISOString() });
  await client.call('MeterValues', { ...meter(samples, at + 2000), transactionId: id });
  assert.equal(f.local.controlSnapshot().transaction.confirmed, true);
  assert.equal(f.saved.activeId, id);
});

test('older, missing, stale, unrelated and suspended status cannot end a transaction across restart', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), first = await f.connect();
  const id = (await first.call('StartTransaction', { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  f.now = at + 1000; await first.call('MeterValues', { ...meter(samples, at + 1000), transactionId: id });
  await f.local.close();
  const resumed = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag', f.saved);
  resumed.now = at + 121_000;
  for (const status of [
    preparing,
    { ...preparing, timestamp: new Date(at).toISOString() },
    { ...preparing, timestamp: new Date(at + 1000).toISOString() },
    { ...preparing, timestamp: new Date(at + 2000).toISOString() },
    { ...preparing, timestamp: new Date(at + 121_000).toISOString(), connectorId: 0 },
    { ...preparing, timestamp: new Date(at + 121_000).toISOString(), errorCode: 'OtherError' },
    ...['Preparing', 'SuspendedEV', 'SuspendedEVSE', 'Unavailable', 'Reserved', 'Faulted'].map(status => ({ ...preparing, status,
      timestamp: new Date(at + 121_000).toISOString() })),
  ]) {
    const client = await resumed.connect(); await client.call('StatusNotification', status); await flushCalls(client);
    assert.equal(resumed.saved.activeId, id, JSON.stringify(status));
    assert.equal(remoteStarts(client).length, 0);
    assert.equal(resumed.saved.transactions[0].endedByStatus, undefined);
  }
});

test('future no-transaction evidence waits for source time and newer buffered transaction evidence prevents retirement', async t => {
  const mode = { authorization_mode: 'plug-and-charge' }, virtualTag = 'fixture-virtual-tag';
  const f = await fixture(t, mode, virtualTag), client = await f.connect();
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: virtualTag, meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  f.now = at + 1000;
  await client.call('StatusNotification', { ...preparing, status: 'Available', timestamp: new Date(at + 1074).toISOString() });
  await flushCalls(client); assert.equal(f.saved.activeId, id); assert.equal(remoteStarts(client).length, 0);
  f.now = at + 1074; assert.equal(f.local.controlSnapshot().transaction, null);
  assert.deepEqual(f.saved.transactions[0].endedByStatus, { status: 'Available', at: at + 1074, receivedAt: at + 1000 });

  const g = await fixture(t, mode, virtualTag), other = await g.connect();
  const otherId = (await other.call('StartTransaction', { connectorId: 1, idTag: virtualTag, meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  g.now = at + 1000;
  await other.call('MeterValues', { ...meter(samples, at + 1074), transactionId: otherId });
  await other.call('StatusNotification', { ...preparing, status: 'Available', timestamp: new Date(at + 1050).toISOString() });
  g.now = at + 1050; g.local.controlSnapshot(); assert.equal(g.saved.activeId, otherId);
  g.now = at + 1074; g.local.controlSnapshot(); await flushCalls(other);
  assert.equal(g.saved.activeId, otherId); assert.equal(g.saved.transactions[0].lastEvidenceAt, at + 1074);
  assert.equal(remoteStarts(other).length, 0, 'A known newer transaction report fences out an older Available report');
});

test('failed durable status retirement cannot authorize a new transaction', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  f.now = at + 1000; f.broken = true;
  await client.call('StatusNotification', { ...preparing, status: 'Available', timestamp: new Date(at + 1000).toISOString() });
  assert.equal(f.saved.activeId, id); assert.equal(f.saved.transactions[0].endedByStatus, undefined);
  assert.equal(f.local.controlSnapshot(), null); assert.equal(f.local.status().ready, false);
  assert.equal(remoteStarts(client).length, 0);
});

test('deferred transaction measurements fail closed if durable evidence cannot be saved', async t => {
  const f = await fixture(t), client = await f.connect();
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  await client.call('MeterValues', { ...meter(), transactionId: id });
  assert(f.local.snapshot());
  await client.call('MeterValues', { ...meter(samples, at + 74), transactionId: id });
  f.broken = true; f.now = at + 74;
  assert.equal(f.local.snapshot(), null);
  assert.equal(f.local.controlSnapshot(), null);
  assert.equal(f.local.status().ready, false);
  assert.equal(f.saved.transactions[0].lastEvidenceAt, at);
});

test('malformed current transaction evidence is rejected without rewriting durable state', async t => {
  const f = await fixture(t), client = await f.connect();
  await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() });
  f.now = at + 1000;
  await client.call('StatusNotification', { ...preparing, status: 'Available', timestamp: new Date(at + 1000).toISOString() });
  for (const corrupt of [
    row => { delete row.lastEvidenceAt; },
    row => { row.lastEvidenceAt = at - 1; },
    row => { row.endedByStatus.at = at; },
    row => { row.endedByStatus.status = 'Preparing'; },
    row => { row.endedByStatus.status = 'SuspendedEV'; },
    row => { row.endedByStatus.receivedAt = at + 100_000; },
    row => { row.endedByStatus.unknown = true; },
  ]) {
    const invalid = f.saved; corrupt(invalid.transactions[0]); let writes = 0;
    const local = createEaseeOcpp({ config: { ...config, port: await freePort() }, chargerId: 'fixture-charger', canControl: () => true,
      state: { get: () => invalid, set: () => { writes++; } } });
    await local.start(); t.after(() => local.close());
    assert.equal(local.status().error, 'incompatible-transaction-state');
    assert.equal(writes, 0);
  }
});

test('owned native Off intent permits one later connection recovery and only a new authorized Start supersedes the unresolved transaction', async t => {
  const mode = { authorization_mode: 'plug-and-charge' }, virtualTag = 'fixture-virtual-tag';
  const f = await fixture(t, mode, virtualTag), client = await f.connect();
  const start = { connectorId: 1, idTag: virtualTag, meterStart: 100, timestamp: new Date(at).toISOString() };
  const oldId = (await client.call('StartTransaction', start))[2].transactionId;
  f.now = at + 1000; f.local.noteModeDisableRequested();
  const intent = f.saved.transactions[0].modeDisableIntent;
  assert.equal(intent.requestedAt, at + 1000); assert.equal(typeof intent.connectionId, 'string');
  assert.equal(f.saved.activeId, oldId); assert.equal(f.saved.transactions[0].stoppedAt, undefined);
  await f.local.close();

  const next = await fixture(t, mode, virtualTag, f.saved), reconnected = await next.connect();
  next.now = at + 2000;
  await reconnected.call('StatusNotification', { ...preparing, timestamp: new Date(at + 2000).toISOString() });
  await flushCalls(reconnected);
  assert.equal(remoteStarts(reconnected).length, 1);
  assert.equal(next.saved.activeId, oldId, 'A remote-start request and acknowledgement do not prove the old transaction ended');
  assert.equal(next.saved.transactions[0].modeDisableIntent.attemptedAt, at + 2000);
  assert.equal(next.saved.transactions[0].endedByNewStart, undefined);
  assert.equal((await reconnected.call('StartTransaction', { ...start, timestamp: new Date(at + 2000).toISOString(), idTag: 'unknown' }))[0], 4);
  assert.equal(next.saved.activeId, oldId, 'An unauthorized new start cannot consume the mode boundary');
  assert.equal((await reconnected.call('StartTransaction', start))[2].transactionId, oldId);
  next.now = at + 3000;
  const newId = (await reconnected.call('StartTransaction', { ...start, meterStart: 200,
    timestamp: new Date(at + 3000).toISOString() }))[2].transactionId;
  assert.notEqual(newId, oldId); assert.equal(next.saved.activeId, newId);
  assert.deepEqual(next.saved.transactions[0].endedByNewStart, { transactionId: newId, startedAt: at + 3000 });
  assert.equal(next.saved.transactions[0].stoppedAt, undefined); assert.equal(next.saved.transactions[0].meterStop, undefined);
  assert.equal(next.saved.transactions[1].modeDisableIntent, undefined, 'The old boundary grants no authority to supersede the new transaction');
  next.now = at + 4000;
  await reconnected.call('StatusNotification', { ...preparing, timestamp: new Date(at + 4000).toISOString() });
  await flushCalls(reconnected); assert.equal(remoteStarts(reconnected).length, 1);
  assert.equal((await reconnected.call('StartTransaction', { ...start, meterStart: 300,
    timestamp: new Date(at + 4000).toISOString() }))[0], 4);
  assert.equal((await reconnected.call('StopTransaction', { transactionId: oldId, meterStop: 195,
    timestamp: new Date(at + 4000).toISOString() }))[0], 3, 'The delayed actual stop remains valid even when its source time follows the replacement start');
  assert.equal(next.saved.activeId, newId);
  await next.local.close();
  const restored = await fixture(t, mode, virtualTag, next.saved);
  assert.equal(restored.local.status().ready, true); assert.equal(restored.saved.activeId, newId);
});

test('recovery remote-start attempt stays consumed across reconnect, repeated Off apply and process restart', async t => {
  const mode = { authorization_mode: 'plug-and-charge' }, virtualTag = 'fixture-virtual-tag';
  const f = await fixture(t, mode, virtualTag), client = await f.connect();
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: virtualTag, meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  f.now = at + 1000; f.local.noteModeDisableRequested();
  const other = await f.connect({ autoReply: frame => frame[2] === 'RemoteStartTransaction' ? 'Rejected' : 'Accepted' });
  f.now = at + 2000;
  await other.call('StatusNotification', { ...preparing, timestamp: new Date(at + 2000).toISOString() });
  await flushCalls(other); assert.equal(remoteStarts(other).length, 1);
  const marker = f.saved.transactions[0].modeDisableIntent;
  f.now = at + 3000; f.local.noteModeDisableRequested();
  assert.deepEqual(f.saved.transactions[0].modeDisableIntent, marker);
  await f.local.close();
  const restored = await fixture(t, mode, virtualTag, f.saved), again = await restored.connect(); restored.now = at + 4000;
  await again.call('StatusNotification', { ...preparing, timestamp: new Date(at + 4000).toISOString() });
  await flushCalls(again);
  assert.equal(remoteStarts(again).length, 0); assert.equal(restored.saved.activeId, id);
});

test('an Off request cannot bypass current-connection authority, freshness, or positive transaction evidence', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), first = await f.connect();
  const start = { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0, timestamp: new Date(at).toISOString() };
  const id = (await first.call('StartTransaction', start))[2].transactionId;
  f.now = at + 1000; f.local.noteModeDisableRequested();
  f.now = at + 2000;
  await first.call('BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture' });
  await first.call('StatusNotification', { ...preparing, timestamp: new Date(at + 2000).toISOString() });
  await flushCalls(first); assert.equal(remoteStarts(first).length, 0, 'Boot on the same authenticated socket is not a mode transition');
  assert.equal((await first.call('StartTransaction', { ...start, timestamp: new Date(at + 2000).toISOString() }))[0], 4);
  for (const transactionId of [id, id + 100]) {
    const client = await f.connect();
    await client.call('MeterValues', { ...meter(samples, at + 2000), transactionId });
    await client.call('StatusNotification', { ...preparing, timestamp: new Date(at + 2000).toISOString() });
    await flushCalls(client);
    assert.equal(remoteStarts(client).length, 0, 'A matching or unknown transaction report blocks recovery authorization');
    assert.equal(f.saved.activeId, id);
  }
  const future = await f.connect();
  await future.call('MeterValues', { ...meter(samples, at + 2074), transactionId: id });
  await future.call('StatusNotification', { ...preparing, timestamp: new Date(at + 2000).toISOString() });
  await flushCalls(future); assert.equal(remoteStarts(future).length, 0);
  for (const payload of [preparing, { ...preparing, timestamp: new Date(at + 500).toISOString() },
    { ...preparing, status: 'SuspendedEVSE', timestamp: new Date(at + 2000).toISOString() }]) {
    const client = await f.connect(); await client.call('StatusNotification', payload); await flushCalls(client);
    assert.equal(remoteStarts(client).length, 0);
  }
  assert.equal(f.saved.transactions[0].modeDisableIntent.attemptedAt, undefined);
});

test('an ordinary pair reconnect never permits superseding a durable transaction, and Off-intent storage is required', async t => {
  const f = await fixture(t, { authorization_mode: 'plug-and-charge' }, 'fixture-virtual-tag'), client = await f.connect();
  const start = { connectorId: 1, idTag: 'fixture-virtual-tag', meterStart: 0, timestamp: new Date(at).toISOString() };
  const id = (await client.call('StartTransaction', start))[2].transactionId;
  const replacement = await f.connect(); f.now = at + 1000;
  await replacement.call('StatusNotification', { ...preparing, timestamp: new Date(at + 1000).toISOString() });
  await flushCalls(replacement);
  assert.equal(remoteStarts(replacement).length, 0);
  assert.equal((await replacement.call('StartTransaction', { ...start, timestamp: new Date(at + 1000).toISOString() }))[0], 4);
  f.broken = true; assert.throws(() => f.local.noteModeDisableRequested(), /unavailable/);
  assert.equal(f.saved.transactions[0].modeDisableIntent, undefined); assert.equal(f.saved.activeId, id);
  assert.equal(f.local.status().ready, false);
});

test('Off-intent bookkeeping remains available for authoritative cloud handback without local listener credentials', async t => {
  const f = await fixture(t), client = await f.connect();
  const id = (await client.call('StartTransaction', { connectorId: 1, idTag: 'fixture-tag', meterStart: 0,
    timestamp: new Date(at).toISOString() }))[2].transactionId;
  await f.local.close();
  let saved = f.saved, permitted = true, writes = 0;
  const local = createEaseeOcpp({ config: { ...config, password: '', enabled: false }, chargerId: 'fixture-charger',
    clock: () => at + 1000, canControl: () => permitted,
    state: { get: () => structuredClone(saved), set: value => { saved = structuredClone(value); writes++; } } });
  t.after(() => local.close());
  await local.start(); assert.equal(local.status().listening, false);
  local.noteModeDisableRequested();
  assert.equal(saved.activeId, id);
  assert.deepEqual(saved.transactions[0].modeDisableIntent, { requestedAt: at + 1000, connectionId: null });
  const before = writes; permitted = false;
  assert.throws(() => local.noteModeDisableRequested(), { code: 'ocpp-unavailable' });
  assert.equal(writes, before);
});

test('a new authorized Start cannot supersede newer buffered evidence for the unresolved transaction', async t => {
  const f = await fixture(t), client = await f.connect();
  const start = { connectorId: 1, idTag: 'fixture-tag', meterStart: 0, timestamp: new Date(at).toISOString() };
  const id = (await client.call('StartTransaction', start))[2].transactionId;
  f.now = at + 1000; f.local.noteModeDisableRequested();
  const replacement = await f.connect(); f.now = at + 2000;
  await replacement.call('MeterValues', { ...meter(samples, at + 2074), transactionId: id });
  f.now = at + 2050;
  const reply = await replacement.call('StartTransaction', { ...start, timestamp: new Date(at + 2050).toISOString() });
  assert.equal(reply[0], 4); assert.equal(f.saved.activeId, id);
  assert.equal(f.saved.transactions[0].endedByNewStart, undefined);
});
