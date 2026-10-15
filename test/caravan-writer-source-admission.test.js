import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { startMqtt } from '../src/acquisition/mqtt.js';
import { CARAVAN_NATIVE_RESTART_DELAY_MS } from '../src/domain/caravan-power-timing.js';
import { classifySourceTime } from '../src/domain/time-evidence.js';
const START = Date.parse('2026-10-09T10:00:00Z'), IDENTITY = 'a'.repeat(64), METER = 'invented-caravan-meter';
const settle = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mqttFixture(t) {
  const store = new Store(':memory:'), client = new EventEmitter(), publications = [], commands = [];
  let now = START;
  const recorder = new Recorder(store, { clock: () => now });
  const settings = equipmentConfiguration({ devices: [
    { id: 'air', kind: 'temperature', area: 'garage', signal: 'caravan_temperature', connection: 'mqtt:fixture/air' },
    { id: 'caravan', kind: 'metered_switch', area: 'garage', connection: 'shelly:fixture/caravan', generation: 2, max_age_seconds: 120 },
    { id: 'caravan_dehumidifier', kind: 'dehumidifier', area: 'garage', connection: 'mqtt:fixture/dryer',
      dehumidifier_control: true, temperature_control: { sensor_device_id: 'air' }, max_age_seconds: 180,
      mqtt: { timestamp_path: 'timestamp', availability_topic: 'fixture/dryer/online', command_topic: 'fixture/dryer/set' } },
  ] });
  client.connected = true;
  client.subscribe = (topic, _options, done) => done(null, [{ topic, qos: 1 }]);
  client.publish = (topic, payload, _options, done) => {
    publications.push({ topic, payload });
    if (topic === 'fixture/dryer/set') commands.push(JSON.parse(payload));
    done();
  };
  client.end = (_force, _options, done) => done();
  const reader = await startMqtt({ monotonicClock: () => now - START + CARAVAN_NATIVE_RESTART_DELAY_MS, store,
    engine: { clock: () => now, recorder, ingest: row => recorder.record(row), rememberObservation() {} },
    config: { connections: { mqtt: { address: 'mqtt://synthetic.invalid' }, equipment: settings } },
    connect: () => client });
  t.after(async () => { await reader.close({ restore: false }); store.close(); });
  const flush = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await settle();
      if (store.writeQueueStatus().pending === 0) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('Actual MQTT admission queue did not settle');
  };
  const send = (topic, body) => client.emit('message', topic,
    Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), { retain: false });
  const f = { reader, store, recorder, commands, advance: ms => { now += ms; }, now: () => now, flush,
    native: () => reader.equipment.status().devices.find(row => row.id === 'caravan'),
    state: () => reader.equipment.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier.temperatureControl,
    dehumidifier: () => reader.equipment.status().devices.find(row => row.id === 'caravan_dehumidifier').dehumidifier,
    air: () => send('fixture/air', { value: 10, timestamp: now }),
    dryer: power => send('fixture/dryer', { identity: IDENTITY, power, fanSpeed: 'low', timestamp: now,
      fieldTimestamps: { power: now, fanSpeed: now }, capabilities: { power: ['off', 'on'], fanSpeed: ['low'] } }),
    meter: (watts = 51, lead = 0, partial = false, total = 1000) => send('fixture/caravan/events/rpc', {
      src: METER, method: 'NotifyStatus', params: { ts: (now + lead) / 1000,
        'switch:0': { id: 0, ...(partial ? {} : { output: true, apower: watts }), current: watts / 230, aenergy: { total } } } }),
    meterOffline: () => send('fixture/caravan/online', 'false'),
    reply: (method, result) => {
      const row = publications.findLast(row => row.topic === 'fixture/caravan/rpc' && JSON.parse(row.payload).method === method);
      assert(row, `Expected native ${method} request`);
      const request = JSON.parse(row.payload);
      send(`${request.src}/rpc`, { id: request.id, src: METER, dst: request.src, result });
    },
  };
  await reader.ready(); await flush();
  f.reply('Shelly.GetDeviceInfo', { id: METER, gen: 2 }); await flush();
  f.reply('Shelly.GetStatus', { 'switch:0': { id: 0, output: true, apower: 51, current: 51 / 230, aenergy: { total: 1000 } } });
  send('fixture/dryer/online', 'online'); f.dryer('on'); await flush();
  f.advance(1); f.air(); f.dryer('on'); await flush();
  f.advance(30_000); f.air(); f.dryer('on'); f.meter(); await flush();
  assert.deepEqual(commands.map(row => row.power), ['off']);
  f.advance(1); f.dryer('off'); f.meter(); await flush();
  for (let n = 0; n < 3; n++) { f.advance(60_000); f.air(); f.dryer('off'); f.meter(); await flush(); }
  assert.equal(f.state().locationTest.status, 'testing');
  assert.equal(f.state().locationTest.reason, 'waiting-restart');
  return f;
}


async function qualifiedManagedOn(t) {
  const f = await mqttFixture(t);
  while (f.commands.length < 2) {
    f.advance(60_000); f.air(); f.dryer('off'); f.meter(51); await f.flush();
  }
  assert.equal(f.commands.at(-1).power, 'on');
  for (const ms of [1, 5_000]) {
    f.advance(ms); f.air(); f.dryer('on'); f.meter(400); await f.flush();
  }
  assert.equal(f.commands.at(-1).power, 'off');
  for (const ms of [1, 5_000]) {
    f.advance(ms); f.air(); f.dryer('off'); f.meter(51); await f.flush();
  }
  assert.equal(f.state().locationTest.status, 'restoring');
  while (f.state().restartWaiting) {
    const edge = f.state().powerRestartNotBefore;
    f.advance(Math.min(60_000, edge - f.now()));
    f.air(); f.dryer('off'); f.meter(51); await f.flush();
  }
  assert.equal(f.commands.at(-1).power, 'on');
  for (const ms of [1, 5_000]) {
    f.advance(ms); f.air(); f.dryer('on'); f.meter(400); await f.flush();
  }
  assert.equal(f.state().qualified, true);
  assert.equal(f.state().desiredPower, 'on');
  assert.equal(f.state().recording, true);
  assert.deepEqual(f.commands.map(row => row.power), ['off', 'on', 'off', 'on']);
  return f;
}

async function deferredRequiredCurrent(f) {
  f.advance(1000);
  const before = { receipt: f.now(), commands: f.commands.length };
  f.meter(400, 801, true, 1000.05); await f.flush();
  // The normal equipment tick records the pending gap through actual admission.
  await f.store.runWrite(() => f.reader.equipment.tick(f.now())); await f.flush();
  assert.equal(f.native().available, false);
  assert.equal(f.state().desiredPower, 'on');
  return before;
}

function assertResumed(f, before) {
  const current = f.native().readings.caravan_current;
  assert.equal(current.observedAt, before.receipt + 801);
  assert.equal(current.receivedAt, before.receipt);
  assert.deepEqual(current.timeAdmission, {
    sourceTime: before.receipt + 801, receivedAt: before.receipt, admittedAt: f.now(),
  });
  assert.equal(f.native().available, true);
  assert.equal(f.state().qualified, true);
  assert.equal(f.state().desiredPower, 'on');
  assert.equal(f.commands.length, before.commands, 'Writer delay sends no new power command');
  const signal = 'caravan_dehumidifier_state';
  const recovered = f.store.observations({ signal }).findLast(row =>
    row.raw?.timeBasis === 'recording-availability-recovery');
  assert(recovered, 'Source admission must publish a prospective recovery event');
  assert.equal(recovered.receivedAt, f.now());
  assert.equal(recovered.raw.sourceTimeWait.startedAt, before.receipt);
  assert.equal(f.recorder.committedAt(signal, f.now() - 1).value, null,
    'Waiting behind the writer remains a real historical gap');
  assert.equal(f.recorder.committedAt(signal, f.now()).value, 1);
}

test('current MQTT managed qualification survives an ordinary 801 ms native clock wait', async t => {
  const f = await qualifiedManagedOn(t), before = await deferredRequiredCurrent(f);
  f.advance(801);
  await f.store.runWrite(() => f.reader.equipment.tick(f.now())); await f.flush();
  assertResumed(f, before);
});

test('a fresh 801 ms native report survives genuine writer admission delayed past five seconds', async t => {
  const f = await qualifiedManagedOn(t), before = await deferredRequiredCurrent(f);
  const startedAt = performance.now();
  let release, started = false;
  const held = new Promise(resolve => { release = resolve; });
  const publication = f.store.runPublication(async () => { started = true; await held; });
  await settle(); assert.equal(started, true);
  f.advance(5_400); await delay(5_400);
  assert.ok(f.store.writeQueueStatus().pending >= 2,
    'Existing pending source dispatcher must queue behind the real publication owner');
  assert.equal(classifySourceTime({ sourceTime: before.receipt + 801, receivedAt: before.receipt,
    now: f.now(), maxAgeMs: 120_000 }).status, 'ready');
  release(); await publication; await f.flush();
  assert.ok(performance.now() - startedAt >= 5000);
  assertResumed(f, before);
});

test('a fresh 801 ms native report survives an actual Store COMMIT-entry stall past five seconds', async t => {
  const f = await qualifiedManagedOn(t), before = await deferredRequiredCurrent(f);
  const exec = f.store.db.exec.bind(f.store.db);
  let blocked = false;
  t.mock.method(f.store.db, 'exec', sql => {
    if (sql === 'COMMIT' && !blocked) {
      blocked = true; f.advance(5_400);
      // This injects a returning native COMMIT-entry stall; it does not measure fsync.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_400);
    }
    return exec(sql);
  });
  const startedAt = performance.now();
  await f.store.runWrite(() => f.store.setState('fixture:writer-commit-delay', { value: 1 }));
  await f.flush();
  assert.equal(blocked, true);
  assert.ok(performance.now() - startedAt >= 5000);
  assertResumed(f, before);
});

test('source readiness after delay cannot renew expired required meter evidence', async t => {
  const f = await qualifiedManagedOn(t); f.advance(1000);
  const receipt = f.now();
  const power = structuredClone(f.native().readings.caravan_power);
  f.meter(400, 801, true, 1000.05); await f.flush();
  f.advance(120_001);
  await f.store.runWrite(() => f.reader.equipment.tick(f.now())); await f.flush();
  assert.equal(f.native().available, false);
  assert.equal(f.state().qualified, false);
  assert.equal(f.state().recording, false);
  assert.equal(f.state().desiredPower, 'off');
  const current = f.native().readings.caravan_current;
  assert(current.value === null || current.receivedAt === receipt,
    'Delayed admission cannot manufacture a fresh receipt');
  const heldPower = f.native().readings.caravan_power;
  assert(heldPower.value === null || heldPower.observedAt === power.observedAt
    && heldPower.receivedAt === power.receivedAt,
  'Expired required power must stay unknown or retain its original expired clocks');
  assert.equal(f.recorder.latestCommitted('caravan_dehumidifier_state').value, null);
});

test('a real meter disconnect cancels the original pending report without regaining qualification', async t => {
  const f = await qualifiedManagedOn(t); f.advance(1000);
  const receipt = f.now();
  f.meter(400, 801, true, 1000.05); await f.flush();
  f.meterOffline(); await f.flush();
  f.advance(5400);
  await f.store.runWrite(() => f.reader.equipment.tick(f.now())); await f.flush();
  assert.equal(f.native().available, false);
  assert.equal(f.state().qualified, false);
  assert.equal(f.state().recording, false);
  assert.notEqual(f.native().readings.caravan_current.observedAt, receipt + 801);
  assert.equal(f.recorder.latestCommitted('caravan_dehumidifier_state').value, null);
});
