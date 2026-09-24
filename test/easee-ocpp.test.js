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
const config = { host: '127.0.0.1', password: 'fixture-local-ocpp-password', authorization_tags: ['fixture-tag'] };

test('OCPP accepts only measured charger fields with source times, units and explicit phase meaning', () => {
  const rows = ocppMeterReadings(meter(), at);
  assert.equal(rows.find(row => row.id === 120).value, 6.9);
  assert.deepEqual(rows.filter(row => row.unit === 'V').map(row => row.value), [230, 230, 230]);
  assert.deepEqual(ocppMeterReadings({ ...meter(), connectorId: 0 }, at), [], 'Do not invent Equalizer observations');
  assert.deepEqual(ocppMeterReadings(meter(samples, at + 1), at), []);
  assert.deepEqual(ocppMeterReadings(meter([{ measurand: 'Voltage', phase: 'L1-L2', value: '400' },
    { measurand: 'Current.Import', phase: 'L1', value: '-2' }, { measurand: 'Power.Active.Import', value: 'NaN' }]), at), []);
  assert.throws(() => localOcppConfiguration({ secret: 'fixture-unsupported' }), /Invalid/);
  assert.throws(() => localOcppConfiguration({ password: 'short' }), /Invalid/);
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
  assert.equal((await call('1', 'BootNotification', { chargePointVendor: 'Easee', chargePointModel: 'fixture', firmwareVersion: '344' }))[2].status, 'Accepted');
  assert.equal((await call('2', 'Authorize', { idTag: 'unknown-tag' }))[2].idTagInfo.status, 'Invalid');
  assert.equal((await call('3', 'Authorize', { idTag: 'fixture-tag' }))[2].idTagInfo.status, 'Accepted');
  await call('4', 'MeterValues', meter());
  assert.equal(local.snapshot().find(row => row.id === 120).value, 6.9);
  now += 61_000;
  await call('5', 'Heartbeat', {});
  assert.equal(local.snapshot(), null);
  await call('6', 'MeterValues', meter(samples, now));
  assert(local.snapshot());
  permitted = false;
  assert.equal(local.snapshot(), null);
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


test('local OCPP requires tags and durable storage, and rejects a different charger association without mutation', async () => {
  const missingTags = createEaseeOcpp({ config: { ...config, authorization_tags: [] }, chargerId: 'fixture', state: { get: () => null, set() {} } });
  await missingTags.start(); assert.equal(missingTags.status().configured, false); await missingTags.close();
  const missingStorage = createEaseeOcpp({ config, chargerId: 'fixture' });
  await missingStorage.start(); assert.equal(missingStorage.status().error, 'transaction-state-unavailable'); await missingStorage.close();
  let writes = 0;
  const mismatch = createEaseeOcpp({ config, chargerId: 'fixture', state: { get: () => ({ version: 1, scope: 'different' }), set() { writes++; } } });
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
    await call('Heartbeat', {});
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
