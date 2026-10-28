import test from 'node:test';
import assert from 'node:assert/strict';
import { testLatencyLimit } from '../scripts/lib/offline-test-profile.js';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createEaseeOcpp } from '../src/acquisition/easee-ocpp.js';
import { createDeviceProviders } from '../src/acquisition/devices.js';
import { ElectricityAccumulator } from '../src/domain/electricity.js';

const START = Date.parse('2026-10-18T12:00:00Z');
const password = 'fixture-ocpp-pass';
const fields = power => [{ measurand: 'Power.Active.Import', unit: 'W', value: String(power) },
  ...[1, 2, 3].flatMap(phase => [{ measurand: 'Current.Import', phase: `L${phase}`, unit: 'A', value: power ? '10' : '0.01' },
    { measurand: 'Voltage', phase: `L${phase}-N`, unit: 'V', value: '230' }])];
const meter = (at, power = 6900, context = 'Sample.Periodic', transactionId) => ({ connectorId: 1,
  ...(transactionId ? { transactionId } : {}), meterValue: [{ timestamp: new Date(at).toISOString(),
    sampledValue: fields(power).map(row => ({ ...row, context })) }] });

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-ocpp-recording-'));
  const store = new Store(join(directory, 'fixture.sqlite')); await store.startWriter();
  let now = START, permitted = true, sequence = 0, turns = 0, settlement;
  const clients = [];
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const state = { get: () => store.getState('fixture:ocpp'), set: value => store.setState('fixture:ocpp', value),
    runWrite: (action, options) => {
      turns++; const held = settlement; settlement = null;
      const pending = store.runWrite(action, options);
      return held ? pending.then(async value => { held.enter(); await held.gate; return value; }) : pending;
    },
    afterCommit: effect => store.afterCommit(effect), afterRollback: effect => store.afterRollback(effect) };
  const local = createEaseeOcpp({ config: { host: '127.0.0.1', port, password, authorization_tags: ['fixture-tag'] },
    chargerId: 'fixture-charger', clock: () => now, canControl: () => permitted, state });
  const releases = [];
  t.after(async () => { releases.forEach(fn => fn()); clients.forEach(ws => ws.terminate());
    await local.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await local.start();
  const f = { local, store, get turns() { return turns; }, get now() { return now; }, set now(value) { now = value; },
    revoke() { permitted = false; },
    holdSettlement() {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; }); releases.push(release);
      settlement = { enter, gate };
      return { entered, release };
    },
    holdCommit({ fail = false } = {}) {
      const request = store.writer.request.bind(store.writer);
      let enter, release, held = false;
      const entered = new Promise(resolve => { enter = resolve; });
      const gate = new Promise(resolve => { release = resolve; }); releases.push(release);
      store.writer.request = async (operation, ...args) => {
        if (operation === 'commit' && !held) { held = true; enter(); await gate;
          if (fail) throw Object.assign(new Error('Synthetic failed commit'), { code: 'SQLITE_IOERR' }); }
        return request(operation, ...args);
      };
      return { entered, release };
    },
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ocpp/fixture-charger`, 'ocpp1.6', {
        headers: { Authorization: `Basic ${Buffer.from(`fixture-charger:${password}`).toString('base64')}` } });
      clients.push(ws); ws.on('error', () => {});
      const pending = new Map();
      ws.on('message', raw => { const frame = JSON.parse(raw);
        if (frame[0] === 2) ws.send(JSON.stringify([3, frame[1], { status: 'Accepted' }]));
        else pending.get(frame[1])?.(frame);
      });
      await once(ws, 'open');
      return { ws, call(action, payload) { return new Promise((resolve, reject) => {
        const id = `fixture-${++sequence}`;
        const timer = setTimeout(() => reject(new Error('Synthetic OCPP reply timeout')), 2000);
        pending.set(id, frame => { clearTimeout(timer); pending.delete(id); resolve(frame); });
        ws.send(JSON.stringify([2, id, action, payload]));
      }); } };
    } };
  f.client = await f.connect();
  return f;
}

for (const power of [0, 6900]) for (const context of ['Sample.Periodic', 'Sample.Clock']) {
  test(`recording stays on OCPP through admitted ${context} at ${power} W`, async t => {
    const f = await fixture(t), accumulator = new ElectricityAccumulator(), recorder = new Recorder(f.store, { clock: () => f.now });
    let cloudRequests = 0;
    const providers = createDeviceProviders({ connections: { easee: { charger_id: 'fixture-charger', access_token: 'fixture-token',
      charger_voltage_ids: [194, 195, 196] } }, clock: () => f.now, ocppFactory: () => f.local,
      http: { json: async () => { cloudRequests++; throw new Error('Unexpected cloud fallback'); } } });
    t.after(() => providers.close());
    const sample = async () => {
      const rows = await providers.electricity({ now: f.now }), result = accumulator.sample(rows, f.now);
      assert(rows.every(row => row.raw.transport === 'ocpp'));
      assert.deepEqual(result.gaps, []);
      await f.store.runWrite(() => { for (const interval of result.intervals) recorder.recordEnergy(interval); });
      return { rows, result };
    };
    await f.client.call('MeterValues', meter(f.now, power)); await sample();
    f.now += 15_000; await sample();
    f.now = START + 29_880;
    await f.client.call('MeterValues', meter(START + 30_000, power, context));
    assert(f.local.snapshot(), 'The preceding measured sample is still fresh');
    f.now = START + 31_000;
    const gate = f.holdCommit();
    let pollingSettled = false;
    const polling = sample().then(result => { pollingSettled = true; return result; }); await gate.entered;
    assert.equal(cloudRequests, 0);
    // Require actual timer progress while COMMIT stays held. CPU throttling can
    // coalesce a short interval and its observation timer into the same turn.
    const timerDeadline = AbortSignal.timeout(testLatencyLimit(1000));
    for (let beat = 0; beat < 3; beat++) await delay(2, undefined, { signal: timerDeadline });
    assert.equal(pollingSettled, false, 'Timer progress cannot release pending admission');
    gate.release(); const { rows, result } = await polling;
    const powerRow = rows.find(row => row.signal === 'ev1_active_power');
    assert.equal(powerRow.sourceTime, START + (context === 'Sample.Periodic' ? 30_000 : 0));
    assert(result.intervals.length === 1);
    f.now += 15_000; await sample();
    assert.equal(cloudRequests, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM observations WHERE signal='ev1_energy_l1' AND value IS NULL").get().n, 0);
    const phaseEnergy = f.store.db.prepare("SELECT sum(value) kwh FROM observations WHERE signal='ev1_energy_l1'").get().kwh ?? 0;
    assert(phaseEnergy >= 0);
    if (power) assert(phaseEnergy > 0, 'Nonzero delivery is retained');
  });
}

test('ordinary acquisition reads add no writer turns and preserve source/receipt clocks', async t => {
  const f = await fixture(t); await f.client.call('MeterValues', meter(START));
  const before = f.turns;
  for (let i = 0; i < 200; i++) {
    const rows = await f.local.readSnapshot();
    const power = rows.find(row => row.id === 120);
    assert.equal(power.timestamp, new Date(START).toISOString()); assert.equal(power.receivedAt, START);
  }
  assert.equal(f.turns, before);
});

test('concurrent readers join one admission through COMMIT without loosening synchronous control reads', async t => {
  const f = await fixture(t);
  await f.client.call('StatusNotification', { connectorId: 1, status: 'Charging', errorCode: 'NoError', timestamp: new Date(START).toISOString() });
  await f.client.call('MeterValues', meter(START));
  f.now += 29_880; await f.client.call('MeterValues', meter(START + 30_000)); f.now = START + 31_000;
  const gate = f.holdCommit(), before = f.turns;
  const first = f.local.readSnapshot();
  assert.equal(f.local.controlSnapshot(), null, 'A synchronous control read cannot bypass pending admission');
  await gate.entered;
  let complete = 0;
  const others = Array.from({ length: 8 }, () => f.local.readSnapshot().then(rows => { complete++; return rows; }));
  await delay(15); assert.equal(complete, 0); assert.equal(f.turns, before + 1);
  gate.release();
  const rows = await Promise.all([first, ...others]);
  assert(rows.every(value => value.find(row => row.id === 120).receivedAt === START + 29_880));
});

for (const boundary of ['abort', 'close', 'authority', 'reconnect', 'boot', 'expiry', 'commit-failure']) {
  test(`snapshot admission respects ${boundary}`, async t => {
    const f = await fixture(t);
    await f.client.call('MeterValues', meter(START));
    f.now += 29_880; await f.client.call('MeterValues', meter(START + 30_000)); f.now = START + 31_000;
    const gate = ['boot', 'reconnect'].includes(boundary) ? f.holdSettlement() : f.holdCommit({ fail: boundary === 'commit-failure' });
    const abort = new AbortController();
    const reading = f.local.readSnapshot({ signal: abort.signal }).then(value => ({ value }), error => ({ error }));
    await gate.entered;
    if (boundary === 'abort') abort.abort();
    if (boundary === 'close') { const closing = f.local.close(); gate.release(); await closing; }
    if (boundary === 'authority') f.revoke();
    if (boundary === 'expiry') f.now = START + 100_000;
    if (boundary === 'reconnect') await f.connect();
    if (boundary === 'boot') { const boot = f.client.call('BootNotification', { chargePointVendor: 'Fixture', chargePointModel: 'Fixture' });
      await boot; }
    gate.release();
    const result = await reading;
    if (['abort', 'close'].includes(boundary)) assert(result.error, 'Cancelled acquisition rejects promptly');
    else assert.equal(result.value, null, 'Old, uncommitted or replaced evidence cannot survive the wait');
  });
}

test('a stalled admission has one bounded wait and cancellation does not cancel another reader', async t => {
  const f = await fixture(t);
  await f.client.call('MeterValues', meter(START));
  f.now += 29_880; await f.client.call('MeterValues', meter(START + 30_000)); f.now = START + 31_000;
  const gate = f.holdCommit(), abort = new AbortController();
  const cancelled = f.local.readSnapshot({ signal: abort.signal }).catch(error => error);
  const continuing = f.local.readSnapshot();
  await gate.entered; abort.abort(); assert.equal((await cancelled).name, 'AbortError');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bounded = f.local.readSnapshot(); t.mock.timers.tick(1001);
  assert.equal(await bounded, null);
  t.mock.timers.reset(); gate.release(); assert(await continuing);
});

test('future samples remain quarantined without a wait or save before their source time', async t => {
  const f = await fixture(t);
  await f.client.call('MeterValues', meter(START));
  f.now = START + 29_880; await f.client.call('MeterValues', meter(START + 30_000));
  const before = f.turns, rows = await f.local.readSnapshot();
  assert.equal(rows.find(row => row.id === 120).timestamp, new Date(START).toISOString());
  assert.equal(f.turns, before);
});

test('admitting contradictory instantaneous power still withdraws electricity evidence', async t => {
  const f = await fixture(t);
  await f.client.call('MeterValues', meter(START));
  f.now = START + 29_880;
  const conflicting = meter(START + 30_000);
  conflicting.meterValue[0].sampledValue.push({ measurand: 'Power.Active.Import', unit: 'W', value: '7000' });
  await f.client.call('MeterValues', conflicting);
  f.now = START + 31_000;
  assert.equal(await f.local.readSnapshot(), null);
  assert.equal(f.local.snapshot(), null, 'A completed admission cannot hide a genuine conflict');
});

test('same-second phase conflicts retain only earlier recording weights and never current-control evidence', async t => {
  const f = await fixture(t), accumulator = new ElectricityAccumulator();
  let cloudRequests = 0;
  const providers = createDeviceProviders({ connections: { easee: { charger_id: 'fixture-charger', access_token: 'fixture-token',
    charger_voltage_ids: [194, 195, 196] } }, clock: () => f.now, ocppFactory: () => f.local,
    http: { json: async () => { cloudRequests++; throw new Error('Unexpected cloud fallback'); } } });
  t.after(() => providers.close());
  await f.client.call('MeterValues', meter(START));
  accumulator.sample(await providers.electricity({ now: f.now }), f.now);
  f.now = START + 30_000;
  await f.client.call('MeterValues', meter(f.now));
  const trigger = meter(f.now, 6900, 'Trigger');
  trigger.meterValue[0].sampledValue.find(row => row.measurand === 'Current.Import' && row.phase === 'L3').value = '9.999';
  await f.client.call('MeterValues', trigger);
  assert.equal(f.local.snapshot(), null, 'The strict snapshot still rejects the current conflict');
  assert.equal(f.local.currentSupplySnapshot().readings.find(row => row.id === 185).value, null);
  const recording = await f.local.readSnapshot(), weight = recording.find(row => row.id === 185);
  assert.equal(weight.phaseWeightOnly, true); assert.equal(weight.value, 10);
  assert.equal(weight.timestamp, new Date(START).toISOString()); assert.equal(weight.receivedAt, START);
  const rows = await providers.electricity({ now: f.now });
  const current = rows.find(row => row.signal === 'ev1_current_l3');
  assert.equal(current.raw.phaseWeightOnly, true); assert.equal(current.sourceTime, START); assert.equal(current.receivedAt, START);
  const integrated = accumulator.sample(rows, f.now);
  assert.equal(cloudRequests, 0); assert.deepEqual(integrated.gaps, []);
  assert.equal(integrated.intervals[0].transport, 'ocpp');
  assert(integrated.intervals[0].quality.includes('last_reported_phase_weights'));
  assert(Math.abs(integrated.intervals[0].energies.reduce((a, b) => a + b) - 6.9 / 120) < 1e-12);
});

for (const boundary of ['no-earlier-sample', 'expired', 'reconnect', 'boot', 'unplug', 'authority']) {
  test(`recording phase weights cannot cross ${boundary}`, async t => {
    const f = await fixture(t);
    if (boundary !== 'no-earlier-sample') await f.client.call('MeterValues', meter(START));
    f.now = START + 30_000; await f.client.call('MeterValues', meter(f.now));
    const trigger = meter(f.now, 6900, 'Trigger');
    trigger.meterValue[0].sampledValue.find(row => row.measurand === 'Current.Import' && row.phase === 'L3').value = '9.999';
    await f.client.call('MeterValues', trigger);
    if (boundary === 'expired') { f.now = START + 61_000;
      await f.client.call('MeterValues', { connectorId: 1, meterValue: [{ timestamp: new Date(f.now).toISOString(),
        sampledValue: [{ measurand: 'Power.Active.Import', unit: 'W', value: '6900' }] }] }); }
    if (boundary === 'reconnect') await f.connect();
    if (boundary === 'boot') await f.client.call('BootNotification', { chargePointVendor: 'Fixture', chargePointModel: 'Fixture' });
    if (boundary === 'unplug') await f.client.call('StatusNotification', { connectorId: 1, status: 'Available', errorCode: 'NoError', timestamp: new Date(f.now).toISOString() });
    if (boundary === 'authority') f.revoke();
    assert.equal(await f.local.readSnapshot(), null);
  });
}
