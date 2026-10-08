import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Engine } from '../src/app/engine.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { decodeMqttTemperature } from '../src/acquisition/mqtt-temperature.js';
import { createH66Decoder } from '../src/domain/telemetry.js';
import { createMqttAdmission } from '../src/acquisition/mqtt-admission.js';
const START = Date.parse('2026-01-01T00:00:00Z');
test('delivery admission can roll back a failed durable acceptance without losing earlier duplicates', () => {
  const admission = createMqttAdmission({ limit: 2 });
  const packet = { dup: true, messageId: 7 }, options = { timestamped: true };
  assert.equal(admission.admit('fixture', 'old', packet, START, options), true);
  const checkpoint = admission.checkpoint();
  assert.equal(admission.admit('fixture', 'new', packet, START + 1, options), true);
  admission.restore(checkpoint);
  assert.equal(admission.admit('fixture', 'old', packet, START + 2, options), false);
  assert.equal(admission.admit('fixture', 'new', packet, START + 2, options), true);
  assert.equal(checkpoint.length, 1, 'checkpoint owns its copied delivery entries');
  admission.admit('fixture', 'third', packet, START + 3, options);
  assert.equal(admission.checkpoint().length, 2, 'bounded even after restore');
});
function fixture(t, { signal = 'indoor_temperature', mapping, clockRequired = true } = {}) {
  let now = START;
  const equipment = equipmentConfiguration({ devices: [{ id: 'test_probe', kind: 'temperature', signal,
    connection: 'mqtt:invented/temperature', mqtt: clockRequired ? { timestamp_path: 'measured_at' } : {},
    readings: mapping ? [{ key: 'temperature', signal, unit: 'degC', required: true, ...mapping }] : [] }] });
  const store = new Store(':memory:');
  const engine = new Engine({ store, config: { input: 'mqtt', connections: { equipment }, settings: {  } }, clock: () => now });
  const capture = createEquipmentCapture({ store, engine, settings: equipment, publish: async () => {} });
  capture.setConnected(true);
  t.after(async () => { capture.close(); await engine.garage.close({ restore: false }); await engine.charging.close();
    await engine.closeFireplace(); await engine.executor.close({ restore: false }); store.close(); });
  return { store, engine, capture, at(value) { now = value; }, now: () => now,
    send(body, packet = {}) { capture.receive('invented/temperature', JSON.stringify(body), packet, now); },
    view() { return engine.temperatureObservations({}, now); } };
}

test('mandatory clocks never fall back on receipt after absent, null, malformed or future reports', async t => {
  for (const time of [undefined, null, 'invalid', START + 1001]) await t.test(String(time), t => {
    const f = fixture(t);
    for (let minute = 0; minute <= 80; minute += 5) {
      f.at(START + minute * 60_000);
      f.send({ value: 21, ...(time === undefined ? {} : { measured_at: typeof time === 'number' ? f.now() + 1001 : time }) });
      assert.equal(f.view().upstairs.stale, true);
      assert.equal(f.engine.lastKnownTemperatures.indoor_temperature, undefined);
    }
  });
});

test('primary path and Celsius-then-affine calibration agree in persisted and held readings', async t => {
  for (const [mapping, body, expected] of [
    [{ path: 'sensor.celsius', offset: 2 }, { value: 20, sensor: { celsius: 22 } }, 24],
    [{ path: 'sensor.celsius' }, { value: 20, sensor: { celsius: -3 } }, -3],
    [{ offset: 2 }, { value: 20 }, 22], [{ scale: 0 }, { value: 20 }, 0],
    [{ scale: 2, offset: 1 }, { value: 50, unit: 'F' }, 21],
  ]) await t.test(JSON.stringify(mapping), t => {
    const f = fixture(t, { signal: 'garage_temperature_2', mapping });
    f.send({ ...body, measured_at: START });
    assert.equal(f.engine.latest.garage_temperature_2.value, expected);
    assert.equal(f.store.observations({ signal: 'garage_temperature_2' }).at(-1).value, expected);
    assert.equal(f.view().garageFront.value, expected);
  });
  for (const mapping of [{ path: 'missing.path' }, { scale: 1e6 }]) await t.test(`invalid ${JSON.stringify(mapping)}`, t => {
    const f = fixture(t, { mapping }); f.send({ value: 20, measured_at: START });
    assert.equal(f.view().upstairs.stale, true);
  });
});

test('explicit receipt-only publishers remain usable and null clocks are never receipt-only', t => {
  const f = fixture(t, { clockRequired: false }); f.send(21);
  assert.equal(f.view().upstairs.stale, false);
  assert.equal(f.engine.latest.indoor_temperature.raw.timeBasis, 'mqtt-received');
  const invalid = decodeMqttTemperature({ signal: 'indoor_temperature', payload: '{"value":21,"timestamp":null}', receivedAt: START });
  assert.equal(invalid.sourceTime, null); assert.ok(invalid.quality.includes('source_time_unknown'));
});

test('front and rear cached reports expire at the same original source deadline', async t => {
  for (const signal of ['garage_temperature', 'garage_temperature_2']) await t.test(signal, t => {
    const f = fixture(t, { signal }), key = signal.endsWith('_2') ? 'garageFront' : 'garage';
    f.send({ value: 8, measured_at: START });
    for (let second = 30; second <= 180; second += 30) {
      f.at(START + second * 1000); f.send({ value: 8, measured_at: START });
      if (second >= 120) {
        assert.equal(f.capture.status().devices[0].available, false);
        assert.equal(f.view()[key].stale, true);
      }
    }
    f.send({ value: 8, measured_at: f.now() });
    assert.equal(f.view()[key].stale, false);
  });
});

test('first-seen timestamped DUP is admitted once while retransmission never renews source age', t => {
  const f = fixture(t);
  const packet = { dup: true, qos: 1, messageId: 37 };
  f.send({ value: 21, measured_at: START }, packet);
  assert.equal(f.view().upstairs.stale, false);
  const count = f.store.observations().length;
  f.at(START + 30_000); f.send({ value: 21, measured_at: START }, packet);
  assert.equal(f.store.observations().length, count);
  assert.equal(f.engine.latest.indoor_temperature.receivedAt, START);
  f.send({ value: 22, measured_at: f.now() }, { qos: 1, messageId: 37 });
  assert.equal(f.engine.latest.indoor_temperature.value, 22);
  f.capture.setConnected(false); f.capture.setConnected(true);
  f.at(START + 60_000); f.send({ value: 22, measured_at: f.now() }, packet);
  assert.equal(f.view().upstairs.stale, false);
});

test('first-seen receipt-only DUP cannot manufacture a new physical clock', t => {
  const f = fixture(t, { clockRequired: false }); f.send(21, { dup: true, qos: 1, messageId: 37 });
  assert.equal(f.engine.latest.indoor_temperature, undefined);
});

test('retired H66 configuration metadata rejects every removed register', () => {
  for (const register of ['0008', '0012', '1A04']) {
    assert.throws(() => createH66Decoder({ deviceId: 'invented', mqttScaleByRegister: { [register]: 1 } }), /Invalid/);
    assert.throws(() => createH66Decoder({ deviceId: 'invented', verifiedRegisters: { [register]: { scale: 1, evidence: 'fixture' } } }), /Invalid/);
  }
});

test('failed equipment commit restores held sensor clocks and admits identical broker retransmission', t => {
  const f = fixture(t); f.send({ value: 21, measured_at: START });
  const before = f.engine.ingestionCheckpoint(), count = f.store.observations().length;
  const transaction = f.store.transaction.bind(f.store); let fail = true;
  f.store.transaction = action => fail ? transaction(() => { fail = false; action(); throw new Error('synthetic commit failure'); }) : transaction(action);
  f.at(START + 1000);
  const body = { value: 22, measured_at: START + 1000 }, packet = { qos: 1, messageId: 41, dup: true };
  assert.throws(() => f.send(body, packet), /synthetic commit failure/);
  assert.deepEqual(f.engine.ingestionCheckpoint(), before);
  assert.equal(f.store.observations().length, count);
  assert.equal(f.capture.status().devices[0].readings.indoor_temperature.value, 21);
  f.send(body, packet);
  assert.equal(f.engine.latest.indoor_temperature.value, 22);
  assert.equal(f.engine.latest.indoor_temperature.sourceTime, START + 1000);
  assert.equal(f.capture.status().devices[0].readings.indoor_temperature.value, 22);
});
