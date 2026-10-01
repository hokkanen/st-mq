import {Engine} from '../src/app/engine.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { startProviders } from '../src/acquisition/providers.js';
import { Store } from '../src/storage/store.js';

const START = Date.parse('2026-09-22T12:00:00Z'), MINUTE = 60_000;
const CHARGER = 'synthetic-stream-charger', EQUALIZER = 'synthetic-stream-equalizer';
const connections = () => ({ easee: { charger_id: CHARGER, equalizer_id: EQUALIZER,
  access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function observations(deviceId, at = START, power) {
  const charger = deviceId === CHARGER;
  const row = (id, value, unit) => ({ id, value, timestamp: new Date(at).toISOString(), ...(unit ? { unit } : {}) });
  if (!charger) return [
    ...[31, 32, 33].map(id => row(id, 10, 'A')), ...[34, 35, 36].map(id => row(id, 230, 'V')),
    row(40, power ?? 6.9, 'kW'), row(45, 100, 'kWh'), row(250, true),
  ];
  return [
    ...[183, 184, 185].map(id => row(id, 3, 'A')), ...[194, 195, 196].map(id => row(id, 230, 'V')),
    row(120, power ?? 2.07, 'kW'), row(250, true), row(130, -70, 'dBm'), row(150, 35, 'C'),
    ...[22, 23, 24].map(id => row(id, 20, 'A')), row(31, true), row(47, 16, 'A'), row(48, 32, 'A'),
    row(96, 0), row(100, 'C'), row(104, 32, 'A'), row(109, 3), row(110, 3), row(114, 16, 'A'),
    ...[111, 112, 113].map(id => row(id, 20, 'A')), ...[230, 231, 232].map(id => row(id, 12, 'A')),
  ];
}

function fakeStream() {
  const f = { options: null, builds: 0, starts: 0, closes: 0, ready: new Set(), cache: new Map(),
    conflicts: new Map(), reconciled: [] };
  f.put = (deviceId, payload) => {
    const cache = f.cache.get(deviceId) ?? new Map();
    for (const row of Array.isArray(payload) ? payload : payload.observations) {
      const prior = cache.get(row.id);
      const conflicts = f.conflicts.get(deviceId) ?? new Set();
      if (prior && Date.parse(prior.timestamp) === Date.parse(row.timestamp)
        && (String(prior.value) !== String(row.value) || prior.unit != null && row.unit != null && prior.unit !== row.unit))
        conflicts.add(row.id);
      if (!prior || Date.parse(prior.timestamp) < Date.parse(row.timestamp)) {
        cache.set(row.id, structuredClone(row)); conflicts.delete(row.id);
      }
      f.conflicts.set(deviceId, conflicts);
    }
    f.cache.set(deviceId, cache);
  };
  f.publish = (deviceId, payload = observations(deviceId)) => { f.put(deviceId, payload); f.ready.add(deviceId); };
  f.disconnect = (deviceIds = [CHARGER, EQUALIZER]) => {
    for (const deviceId of deviceIds) f.ready.delete(deviceId);
    f.options.onDisconnect(deviceIds);
  };
  f.factory = options => {
    f.builds++; f.options = options;
    return {
      async start() { f.starts++; },
      snapshot(deviceId, ids, { requiredIds = [] } = {}) {
        const cache = f.cache.get(deviceId);
        if (!f.ready.has(deviceId) || !cache || requiredIds.some(id => !cache.has(id))) return null;
        if (ids.some(id => f.conflicts.get(deviceId)?.has(id))) return null;
        return ids.flatMap(id => cache.has(id) ? [structuredClone(cache.get(id))] : []);
      },
      reconcile(deviceId, payload) { f.reconciled.push(deviceId); f.put(deviceId, payload); },
      status() { return { state: f.ready.size ? 'connected' : 'connecting', products: options.products.length }; },
      async close() { f.closes++; },
    };
  };
  return f;
}

function deviceFixture(t, extra = {}) {
  const stream = fakeStream(), calls = [], disconnects = [];
  const f = { now: START, stream, calls, disconnects, handler: null };
  f.http = { async json(url, options) {
    calls.push({ url, options });
    if (f.handler) return f.handler(url, options);
    if (url.endsWith('/schedules')) return { enabled: 'none' };
    if (url.endsWith('/config')) return { maxAllocatedCurrent: 20 };
    const target = new URL(url);
    return observations(decodeURIComponent(target.pathname.split('/')[2]), f.now)
      .filter(row => target.searchParams.get('ids').split(',').map(Number).includes(row.id));
  }, close() {} };
  f.devices = createDeviceProviders({ connections: connections(), http: f.http, clock: () => f.now,
    streamFactory: stream.factory, onStreamDisconnect: ids => disconnects.push(ids), ...extra });
  f.stateCalls = () => calls.filter(row => new URL(row.url).pathname.startsWith('/state/'));
  t.after(async () => { await f.devices.close(); });
  return f;
}

test('device streaming is explicit, shares configured products, and closes once', async t => {
  const f = deviceFixture(t);
  assert.equal(f.stream.builds, 0);
  assert.equal(f.devices.streamStatus(), null);
  await f.devices.electricity({ now: f.now });
  assert.equal(f.stream.builds, 0, 'Read-only consumers retain finite REST behavior until streaming starts');
  await f.devices.startStreaming();
  await f.devices.startStreaming();
  assert.equal(f.stream.builds, 1);
  assert.equal(f.stream.starts, 1);
  assert.deepEqual(f.stream.options.products.map(row => row.id).sort(), [CHARGER, EQUALIZER].sort());
  assert(f.stream.options.products.find(row => row.id === CHARGER).ids.includes(129));
  assert(f.stream.options.products.find(row => row.id === CHARGER).ids.includes(96));
  assert(f.stream.options.products.find(row => row.id === EQUALIZER).ids.includes(45));
  await f.devices.close();
  await f.devices.close();
  assert.equal(f.stream.closes, 1);
});

test('ready streams replace electrical and charging observation GETs while preserving source timestamps', async t => {
  const f = deviceFixture(t);
  await f.devices.startStreaming();
  await f.devices.electricity({ now: f.now });
  assert.equal(f.stateCalls().length, 2);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  assert.equal(f.devices.canSampleStream(), true);
  f.now += 15_000;
  const rows = await f.devices.electricity({ now: f.now });
  assert.equal(f.stateCalls().length, 2);
  assert.equal(f.devices.acquisitionTransport(), 'stream');
  assert.equal(rows.find(row => row.signal === 'ev1_active_power').value, 2.07);
  assert.equal(rows.find(row => row.signal === 'property_active_power').value, 6.9);
  assert(rows.every(row => row.sourceTime === START && row.receivedAt === f.now));
  assert.equal(rows.find(row => row.signal === 'ev1_active_power').raw.deviceTelemetryAt, START);
  const snapshot = await f.devices.chargerScheduleControl().read();
  assert.equal(snapshot.powerKw, 2.07);
  assert.deepEqual(snapshot.supply.propertyCurrentA, [10, 10, 10]);
  assert.equal(f.stateCalls().length, 2, 'Charging consumes the same device observation cache');
  assert.equal(f.calls.filter(row => row.url.endsWith('/schedules')).length, 1);
  assert.equal(f.calls.filter(row => row.url.endsWith('/config')).length, 1);
});

test('missing stream device falls back independently and healthy streams reconcile periodically', async t => {
  const f = deviceFixture(t);
  await f.devices.startStreaming();
  await f.devices.electricity({ now: f.now });
  f.stream.publish(CHARGER);
  f.now += 15_000;
  await f.devices.electricity({ now: f.now });
  assert.equal(f.stateCalls().length, 3);
  assert(f.stateCalls().at(-1).url.includes(EQUALIZER));
  assert.equal(f.devices.acquisitionTransport(), 'mixed');
  assert.equal(f.devices.canSampleStream(), true, 'One ready device keeps its own normal sampling cadence');
  f.stream.publish(EQUALIZER);
  f.now = START + 16 * MINUTE;
  await f.devices.electricity({ now: f.now });
  assert.equal(f.stateCalls().length, 5, 'Each healthy device still receives bounded REST reconciliation');
  assert.deepEqual(f.stream.reconciled.slice(-2).sort(), [CHARGER, EQUALIZER].sort());
});

test('stream sessions retain finalized comparison fields without retaining authorization payloads', async t => {
  const f = deviceFixture(t);
  await f.devices.startStreaming();
  await f.devices.electricity({ now: f.now });
  const start = START - 3600_000, end = START - 1000;
  f.stream.publish(CHARGER, [...observations(CHARGER), { id: 129, timestamp: new Date(START).toISOString(),
    value: JSON.stringify({ Id: 123, Start: new Date(start).toISOString(), Stop: new Date(end).toISOString(),
      EnergyKwh: 2.07, MeterValueStart: 100, MeterValueStop: 102.07, AuthorizationToken: 'synthetic-private-session-token' }) },
  { id: 223, timestamp: new Date(start).toISOString(), value: JSON.stringify({ Id: 123, Start: new Date(start).toISOString() }) }]);
  f.stream.publish(EQUALIZER);
  f.now += 15_000;
  const rows = await f.devices.electricity({ now: f.now });
  const power = rows.find(row => row.signal === 'ev1_active_power');
  assert.equal(power.raw.chargingSession.referenceKwh, 2.07);
  assert.equal(power.raw.chargingSession.start, start);
  assert.equal(power.raw.chargingSession.end, end);
  assert.equal(power.raw.chargingSession.sessionKey, power.raw.chargingSessionStart.sessionKey);
  assert.match(power.raw.chargingSession.sessionKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rows).includes('synthetic-private-session-token'), false);
  assert.equal(f.stateCalls().length, 2);
});

test('stream token rejection and simultaneous REST 401 share one refresh and durable token rotation', async t => {
  const saved = [], refreshing = deferred();
  let refreshes = 0;
  const f = deviceFixture(t, { tokenStore: { async load() { return null; }, async save(pair) { saved.push(pair); } } });
  await f.devices.startStreaming();
  assert.equal(await f.stream.options.getAccessToken({}), 'synthetic-old-access');
  f.handler = async (url, options) => {
    if (url.endsWith('/refresh_token')) {
      refreshes++; await refreshing.promise;
      return { accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh' };
    }
    if (options.headers.Authorization === 'Bearer synthetic-old-access') throw Object.assign(new Error('Expired'), { status: 401 });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-rotated-access');
    return observations(url.includes(CHARGER) ? CHARGER : EQUALIZER);
  };
  const reading = f.devices.electricity({ now: f.now });
  const token = f.stream.options.getAccessToken({ rejectedToken: 'synthetic-old-access' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1);
  refreshing.resolve();
  const [rows, access] = await Promise.all([reading, token]);
  assert.equal(access, 'synthetic-rotated-access');
  assert(rows.every(row => !row.quality.includes('provider_error')));
  assert.equal(refreshes, 1);
  assert.deepEqual(saved, [{ accessToken: 'synthetic-rotated-access', refreshToken: 'synthetic-rotated-refresh' }]);
  assert.equal(await f.stream.options.getAccessToken({ rejectedToken: 'synthetic-old-access' }), access);
  assert.equal(refreshes, 1, 'An old rejected token cannot rotate the already renewed pair again');
});

function providerFixture(t, easee = connections().easee, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-stream-integration-'));
  const store = new Store(':memory:'), stream = fakeStream(), intervals = [], gaps = [], calls = [];
  const f = { now: START, stream, store, intervals, gaps, calls, fail: null, hold: null, payload: null };
  const engine = { ingestionCheckpoint:Engine.prototype.ingestionCheckpoint, restoreIngestionCheckpoint:Engine.prototype.restoreIngestionCheckpoint, latest: {}, outdoorCandidates: {}, ingest() {}, providerObservations() { return []; },
    ingestEnergy(row) { intervals.push(row); },
    recorder: { energyGap(row) { gaps.push(row); }, flush() {}, reload() {} } };
  f.engine = engine;
  const config = { dataDir: directory, connections: { easee } };
  const http = { async json(url) {
    calls.push(url);
    if (f.hold) await f.hold.promise;
    const failure = typeof f.fail === 'function' ? f.fail(url) : f.fail;
    if (failure) throw Object.assign(new Error('Synthetic outage'), failure);
    const target = new URL(url), deviceId = decodeURIComponent(target.pathname.split('/')[2]);
    if (f.payload) return f.payload(deviceId);
    return observations(deviceId, f.now).filter(row => target.searchParams.get('ids').split(',').map(Number).includes(row.id));
  }, close() {} };
  const options = { engine, store, config, http, streamFactory: stream.factory, automatic: false, clock: () => f.now, ...extra };
  f.providers = startProviders(options);
  f.health = () => store.getState('providers:health').easee;
  f.poll = async at => { f.now = at; await f.providers.runDue(); };
  f.restart = async checkpoint => {
    await f.providers.close();
    if (checkpoint) store.setState('electricity:acquisition', checkpoint);
    f.providers = startProviders(options);
  };
  t.after(async () => { f.hold?.resolve(); await f.providers.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test('provider disconnect records a gap and cannot integrate across rapid stream recovery', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 15_000);
  assert.equal(f.intervals.length, 2);
  f.now = START + 20_000;
  f.stream.disconnect();
  assert.equal(f.gaps.length, 2, 'Each configured device records the loss boundary immediately');
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, START + 25_000));
  await f.poll(START + 30_000);
  assert.equal(f.intervals.length, 2, 'Recovery establishes a new baseline instead of bridging the outage');
  await f.poll(START + 45_000);
  assert.equal(f.intervals.length, 4);
  assert(f.intervals.slice(2).every(row => row.start === START + 30_000 && row.end === START + 45_000));
});

test('cloud voltage stream loss leaves independent OCPP integration and voltage provenance intact', async t => {
  let localOptions;
  const localRows = observations(CHARGER);
  const f = providerFixture(t, { ...connections().easee, charger_voltage_ids: [194, 195, 196] }, {
    ocppFactory: options => { localOptions = options; return {
      start() {}, close() {}, status: () => ({ configured: true }), snapshot: () => localRows,
    }; },
  });
  const interruptions = [], voltages = [];
  f.engine.voltage = { ingest(row) { voltages.push(row); }, interrupt(row) { interruptions.push(row); } };
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 15_000);
  assert(voltages.some(row => row.device === CHARGER && row.raw.transport === 'cloud' && row.raw.voltageOnly));
  assert(voltages.some(row => row.device === CHARGER && row.raw.transport === 'ocpp' && !row.raw.voltageOnly));
  f.now = START + 20_000; f.stream.disconnect();
  assert(f.gaps.every(row => row.device !== CHARGER), 'Cloud interruption cannot close an OCPP energy head');
  assert.equal(f.engine.electricitySnapshot.charger.transport, 'ocpp');
  assert(interruptions.every(row => row.transport === 'cloud'));
  voltages.length = 0;
  await f.poll(START + 30_000);
  assert(!voltages.some(row => row.device === CHARGER && row.raw.transport === 'cloud'),
    'Disconnected cloud cache cannot silently regain voltage availability');
  localOptions.onDisconnect();
  assert(f.gaps.some(row => row.device === CHARGER && row.transport === 'ocpp'));
  assert.equal(interruptions.at(-1).transport, 'ocpp');
});

test('healthy stream recovery resumes at normal cadence despite a REST rate-limit cooldown', async t => {
  const f = providerFixture(t);
  f.fail = { status: 429, retryAfterMs: 5 * MINUTE };
  await f.poll(START);
  const failedCalls = f.calls.length;
  assert(f.health().nextAttemptAt >= START + 5 * MINUTE);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 14_999);
  assert.equal(f.health().lastSuccessAt, null);
  await f.poll(START + 15_000);
  assert.equal(f.health().lastSuccessAt, START + 15_000);
  assert.equal(f.health().error, null);
  assert.equal(f.calls.length, failedCalls, 'Ready stream state does not bypass the REST transport cooldown');
});

test('an observation batch crossing a stream-loss epoch cannot publish energy', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 15_000);
  f.stream.ready.clear();
  f.hold = deferred();
  const pending = f.poll(START + 30_000);
  await new Promise(resolve => setImmediate(resolve));
  f.stream.disconnect();
  f.hold.resolve(); await pending;
  assert.equal(f.intervals.length, 2);
  assert.deepEqual(f.store.getState('electricity:acquisition').devices, {});
});

test('quick process recovery discards a saved stream head but retains counter audit progress', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 15_000);
  const checkpoint = f.store.getState('electricity:acquisition');
  assert.equal(Object.keys(checkpoint.devices).length, 2);
  assert(Object.keys(checkpoint.auditHeads).length > 0);
  f.now = START + 20_000;
  // Restore the pre-shutdown checkpoint to represent abrupt process loss.
  await f.restart(checkpoint);
  const restarted = f.store.getState('electricity:acquisition');
  assert.deepEqual(restarted.devices, {});
  assert.deepEqual(restarted.auditHeads, checkpoint.auditHeads);
  await f.poll(START + 30_000);
  assert.equal(f.intervals.length, 2, 'A restart within maxGapMs must still establish a new baseline');
  await f.poll(START + 45_000);
  assert.equal(f.intervals.length, 4);
  assert(f.intervals.slice(2).every(row => row.start === START + 30_000));
});

test('a healthy charger stream continues while missing Equalizer delivery is rate limited', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  f.stream.publish(CHARGER);
  f.fail = url => url.includes(EQUALIZER) ? { status: 429, retryAfterMs: 5 * MINUTE } : null;
  await f.poll(START + 15_000);
  assert.equal(f.health().currentReadings.property.error, 'HTTP-429');
  assert.equal(f.health().currentReadings.charger.error, null);
  const calls = f.calls.length;
  for (const offset of [30_000, 45_000, 60_000]) await f.poll(START + offset);
  assert.equal(f.calls.length, calls, 'The healthy stream does not cause extra HTTP calls during the shared cooldown');
  const charger = f.intervals.filter(row => row.prefix === 'ev1');
  assert.deepEqual(charger.map(row => [row.start, row.end]), [
    [START, START + 15_000], [START + 15_000, START + 30_000],
    [START + 30_000, START + 45_000], [START + 45_000, START + 60_000],
  ]);
  assert.equal(f.intervals.filter(row => row.prefix === 'property').length, 0);
});

test('malformed successful reconciliation cannot replace valid stream measurements or add gaps', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, START + 14 * MINUTE + 45_000));
  await f.poll(START + 14 * MINUTE + 45_000);
  const gaps = f.gaps.length, reconciliations = f.stream.reconciled.length;
  f.payload = () => ({ unexpected: 'synthetic-malformed-success' });
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, START + 15 * MINUTE));
  await f.poll(START + 15 * MINUTE);
  assert.equal(f.health().error, null);
  assert.equal(f.stream.reconciled.length, reconciliations, 'Malformed reconciliation must never enter the shared cache');
  assert.equal(f.gaps.length, gaps);
  assert.equal(f.intervals.length, 2);
  assert(f.intervals.every(row => row.start === START + 14 * MINUTE + 45_000 && row.end === START + 15 * MINUTE));
});

test('failed disconnect persistence clears live state and retries the gap before integrating again', async t => {
  const f = providerFixture(t);
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId);
  await f.poll(START + 15_000);
  assert(f.engine.electricitySnapshot.charger);
  const transaction = f.store.transaction.bind(f.store);
  let failTransaction = true;
  f.store.transaction = operation => {
    if (failTransaction) throw new Error('Synthetic storage failure');
    return transaction(operation);
  };
  t.after(() => { f.store.transaction = transaction; });
  f.now = START + 20_000;
  assert.doesNotThrow(() => f.stream.disconnect());
  assert.deepEqual(f.engine.electricitySnapshot, { charger: null, property: null });
  assert.equal(f.intervals.length, 2);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, START + 25_000));
  await f.poll(START + 30_000);
  assert.equal(f.intervals.length, 2, 'An unsaved interruption cannot silently become an ordinary integration interval');
  assert.deepEqual(f.engine.electricitySnapshot, { charger: null, property: null });
  failTransaction = false;
  await f.poll(START + 45_000);
  assert.equal(f.gaps.length, 2);
  assert.equal(f.intervals.length, 2, 'The recovered persistence path establishes a new baseline');
  await f.poll(START + 60_000);
  assert.equal(f.intervals.length, 4);
  assert(f.intervals.slice(2).every(row => row.start === START + 45_000));
});

test('failed stream authentication shares a cooldown before refreshing credentials again', async t => {
  const f = deviceFixture(t, { connections: { easee: { ...connections().easee,
    user: 'synthetic-user', pw: 'synthetic-password' } } });
  f.handler = async () => { throw Object.assign(new Error('Synthetic credentials rejected'), { status: 401 }); };
  await f.devices.startStreaming();
  const token = () => f.stream.options.getAccessToken({ rejectedToken: 'synthetic-old-access' });
  await assert.rejects(token(), { status: 401 });
  assert.equal(f.calls.length, 2, 'A refresh rejection permits one configured password login');
  f.now = START + 15_000;
  await assert.rejects(token());
  f.now = START + 30 * MINUTE - 1;
  await assert.rejects(token());
  assert.equal(f.calls.length, 2);
  f.now = START + 30 * MINUTE;
  await assert.rejects(token(), { status: 401 });
  assert.equal(f.calls.length, 4);
});

test('saved authentication cooldown prevents fresh stream login until the saved retry deadline', async t => {
  const f = deviceFixture(t, { connections: { easee: { charger_id: CHARGER,
    user: 'synthetic-user', pw: 'synthetic-password' } },
  retryState: { error: 'HTTP-401', nextAttemptAt: START + 30 * MINUTE } });
  f.handler = async () => ({ accessToken: 'synthetic-new-access', refreshToken: 'synthetic-new-refresh' });
  await f.devices.startStreaming();
  await assert.rejects(f.stream.options.getAccessToken({}));
  f.now = START + 30 * MINUTE - 1;
  await assert.rejects(f.stream.options.getAccessToken({}));
  assert.equal(f.calls.length, 0);
  f.now = START + 30 * MINUTE;
  assert.equal(await f.stream.options.getAccessToken({}), 'synthetic-new-access');
  assert.equal(f.calls.length, 1);
  assert(f.calls[0].url.endsWith('/login'));
});

test('provider restart transfers failed authentication health into the new stream token provider', async t => {
  const f = providerFixture(t, { charger_id: CHARGER, user: 'synthetic-user', pw: 'synthetic-password' });
  f.fail = { status: 401 };
  await f.poll(START);
  assert.equal(f.health().error, 'HTTP-401');
  assert(f.health().nextAttemptAt >= START + 30 * MINUTE);
  const calls = f.calls.length;
  f.now = START + 15_000;
  await f.restart();
  await assert.rejects(f.stream.options.getAccessToken({}));
  assert.equal(f.calls.length, calls, 'Restart must retain the failed-login cooldown before the new hub authenticates');
});

test('lagging REST reconciliation keeps newer stream measurements and subsequent loss invalidation', async t => {
  const f = providerFixture(t), before = START + 14 * MINUTE + 45_000, latest = START + 15 * MINUTE;
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, before));
  await f.poll(before);
  const gaps = f.gaps.length;
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId,
    observations(deviceId, latest, deviceId === CHARGER ? 3 : 7.8));
  f.payload = deviceId => observations(deviceId, latest - 60_000, 1);
  await f.poll(latest);
  assert.equal(f.engine.electricitySnapshot.charger.sourceTime, latest);
  assert.equal(f.engine.electricitySnapshot.charger.powerKw, 3);
  assert.equal(f.engine.electricitySnapshot.property.sourceTime, latest);
  assert(Math.abs(f.engine.electricitySnapshot.property.powerKw - 7.8) < 1e-12);
  assert.equal(f.health().error, null);
  assert.equal(f.gaps.length, gaps, 'A lagging REST response cannot create a source-time rollback gap');
  assert.equal(f.intervals.length, 2);
  f.now = latest + 5000;
  f.stream.disconnect();
  assert.equal(f.gaps.length, gaps + 2, 'Merged snapshots still depend on the stream despite REST reconciliation succeeding');
  assert.deepEqual(f.engine.electricitySnapshot, { charger: null, property: null });
});

for (const invalidTime of ['missing', 'future']) test(`reconciliation with ${invalidTime} timestamps cannot replace usable stream data`, async t => {
  const f = providerFixture(t), before = START + 14 * MINUTE + 45_000, latest = START + 15 * MINUTE;
  await f.poll(START);
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, before));
  await f.poll(before);
  const gaps = f.gaps.length, reconciliations = f.stream.reconciled.length;
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, latest));
  f.payload = deviceId => observations(deviceId, latest, 1).map(row => invalidTime === 'future'
    ? { ...row, timestamp: new Date(latest + 1000).toISOString() }
    : Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'timestamp')));
  await f.poll(latest);
  assert.equal(f.health().error, null);
  assert.equal(f.stream.reconciled.length, reconciliations);
  assert.equal(f.engine.electricitySnapshot.charger.sourceTime, latest);
  assert.equal(f.engine.electricitySnapshot.charger.powerKw, 2.07);
  assert.equal(f.gaps.length, gaps);
  assert.equal(f.intervals.length, 2);
});

test('same-time REST and stream disagreement remains unusable until a newer measurement', async t => {
  const f = deviceFixture(t), latest = START + 15 * MINUTE;
  await f.devices.startStreaming();
  await f.devices.electricity({ now: f.now });
  f.now = latest;
  for (const deviceId of [CHARGER, EQUALIZER]) f.stream.publish(deviceId, observations(deviceId, latest));
  f.handler = async url => observations(url.includes(CHARGER) ? CHARGER : EQUALIZER, latest)
    .map(row => row.id === 120 ? { ...row, value: 3 } : row);
  const rows = await f.devices.electricity({ now: f.now });
  const power = rows.find(row => row.signal === 'ev1_active_power');
  assert.equal(power.value, null);
  assert(power.quality.includes('conflicting_duplicate'));
  assert.equal(rows.find(row => row.signal === 'property_active_power').value, 6.9);
  f.now += 15_000;
  f.stream.publish(CHARGER, observations(CHARGER, f.now, 3));
  const recovered = await f.devices.electricity({ now: f.now });
  const nextPower = recovered.find(row => row.signal === 'ev1_active_power');
  assert.equal(nextPower.value, 3);
  assert.equal(nextPower.sourceTime, f.now);
  assert(!nextPower.quality.includes('conflicting_duplicate'));
});

test('only meaningful charger transitions reach charging runtime, without private device routing data', async t => {
  const received = [];
  let allowed = true;
  const f = deviceFixture(t, { onChargerObservation: event => received.push(event), canControl: () => allowed });
  f.devices.startStreaming();
  const event = (id, value) => ({ id, value, measuredAt: START + 1000, receivedAt: START + 1100,
    previousValue: 3, previousMeasuredAt: START });
  for (const id of [31, 96, 100, 109, 250]) f.stream.options.onObservation(CHARGER, event(id, 1));
  assert.deepEqual(received.map(row => row.id), [31, 96, 100, 109, 250]);
  assert(received.every(row => !Object.hasOwn(row, 'deviceId') && !Object.hasOwn(row, 'mid')));
  for (const id of [31, 32, 33, 250]) f.stream.options.onObservation(EQUALIZER, event(id, 10));
  for (const id of [120, 183, 194]) f.stream.options.onObservation(CHARGER, event(id, 10));
  assert.equal(received.length, 5);
  allowed = false;
  f.stream.options.onObservation(CHARGER, event(109, 1));
  allowed = true;
  await f.devices.close();
  f.stream.options.onObservation(CHARGER, event(109, 1));
  assert.equal(received.length, 5);
});

test('provider routes live charger state into charging runtime', async t => {
  const f = providerFixture(t), received = [];
  f.engine.charging = { receiveEaseeObservation: event => received.push(event) };
  const event = { id: 109, value: 1, measuredAt: START + 1000, receivedAt: START + 1000,
    previousValue: 3, previousMeasuredAt: START };
  f.stream.options.onObservation(CHARGER, event);
  assert.deepEqual(received, [event]);
  f.stream.options.onObservation(EQUALIZER, { ...event, id: 31 });
  assert.equal(received.length, 1);
});
