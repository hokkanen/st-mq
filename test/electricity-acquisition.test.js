import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ElectricityAccumulator } from '../src/domain/electricity.js';
import { createDeviceProviders, ELECTRICITY_FIELDS } from '../src/acquisition/devices.js';
import { decodeMqttTemperature, startMqtt } from '../src/acquisition/mqtt.js';
import { H66_REGISTERS, createH66Decoder } from '../src/domain/telemetry.js';

const initial = Date.parse('2026-09-08T10:00:00Z');
function sample(now, { currents = [10, 5, 0], voltages = [240, 220, 230], power = 3.5, timestamp = now, counter } = {}) {
  const rows = [
    ...currents.map((value, index) => [`current_l${index + 1}`, value, 'A']),
    ...voltages.map((value, index) => [`voltage_l${index + 1}`, value, 'V']),
    ['active_power', power, 'kW'],
    ...(counter === undefined ? [] : [['import_energy_counter', counter, 'kWh']]),
  ];
  return rows.map(([name, value, unit]) => ({ source: 'easee', device: 'invented-meter', signal: `property_${name}`,
    value, unit, sourceTime: timestamp, receivedAt: now, quality: [], raw: { acquisitionOnly: true } }));
}
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('all acquired intervals contribute while phase sums preserve reported active power', () => {
  const accumulator = new ElectricityAccumulator();
  assert.deepEqual(accumulator.sample(sample(initial), initial).intervals, []);
  let sum = 0;
  for (let poll = 1; poll <= 20; poll++) {
    const now = initial + poll * 15_000;
    const [interval] = accumulator.sample(sample(now), now).intervals;
    near(interval.energies[0], 2.4 * 15 / 3600);
    near(interval.energies[1], 1.1 * 15 / 3600);
    near(interval.energies[2], 0);
    sum += interval.energies.reduce((a, b) => a + b);
  }
  near(sum, 3.5 * 5 / 60);
  assert.equal(Object.keys(accumulator.checkpoint().devices).length, 1);
  assert(JSON.stringify(accumulator.checkpoint()).length < 1500, 'checkpoint does not grow with polling history');
});

test('irregular polls use elapsed time and intermediate changes survive integration', () => {
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(sample(initial, { power: 0 }), initial);
  const first = accumulator.sample(sample(initial + 10_000, { power: 6 }), initial + 10_000).intervals[0];
  const second = accumulator.sample(sample(initial + 40_000, { power: 0 }), initial + 40_000).intervals[0];
  near([...first.energies, ...second.energies].reduce((a, b) => a + b), 3 * 40 / 3600);
  assert(first.force && second.force, 'zero transitions bypass numerical threshold');
});

test('freshness ages from source timestamps and stale or failed polls never fabricate zero energy', () => {
  const accumulator = new ElectricityAccumulator({ maxAgeMs: 30_000 });
  accumulator.sample(sample(initial), initial);
  const cached = accumulator.sample(sample(initial + 15_000, { timestamp: initial }), initial + 15_000);
  assert(cached.intervals[0].quality.includes('held_source_values'));
  const stale = accumulator.sample(sample(initial + 45_000, { timestamp: initial }), initial + 45_000);
  assert.equal(stale.intervals.length, 0); assert.equal(stale.gaps.length, 1);
  assert.equal(accumulator.sample(sample(initial + 60_000), initial + 60_000).intervals.length, 0, 'recovery starts a new interval');
  assert.equal(accumulator.sample(sample(initial + 75_000), initial + 75_000).intervals.length, 1);
});

test('checkpoint restart is lossless but long outages and clock rollbacks break coverage', () => {
  let accumulator = new ElectricityAccumulator();
  accumulator.sample(sample(initial), initial);
  accumulator = new ElectricityAccumulator({ checkpoint: accumulator.checkpoint() });
  assert.equal(accumulator.sample(sample(initial + 15_000), initial + 15_000).intervals.length, 1);
  const outage = accumulator.sample(sample(initial + 120_000), initial + 120_000);
  assert.equal(outage.intervals.length, 0); assert(outage.gaps[0].quality.includes('electricity_gap'));
  const rollback = accumulator.sample(sample(initial + 90_000), initial + 90_000);
  assert.equal(rollback.intervals.length, 0); assert(rollback.gaps[0].quality.includes('clock_rollback'));
});

test('missing voltage falls back to current shares, absent active power explicitly assumes unity power factor', () => {
  for (const settings of [{ voltages: [null, null, null] }, { power: null }]) {
    const accumulator = new ElectricityAccumulator();
    accumulator.sample(sample(initial, settings), initial);
    const [interval] = accumulator.sample(sample(initial + 15_000, settings), initial + 15_000).intervals;
    assert(interval);
    assert(interval.quality.includes(settings.power === null ? 'unity_power_factor_assumed' : 'current_phase_weights'));
  }
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(sample(initial), initial);
  assert.equal(accumulator.sample(sample(initial + 15_000, { currents: [0, 0, 0], power: 1 }), initial + 15_000).intervals.length, 0);
});

test('fresh single-phase active power can use explicitly estimated old zero phase shares', () => {
  const singlePhase = (now, { power = 2.4, inactiveValue = 0, inactiveQuality = [], inactiveTime = initial - 86_400_000 } = {}) =>
    sample(now, { currents: [10, inactiveValue, 0], voltages: [240, 240, 240], power }).map(row =>
      /current_l[23]$/.test(row.signal) ? { ...row, sourceTime: inactiveTime, quality: inactiveQuality } : row);
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(singlePhase(initial), initial);
  for (let poll = 1; poll <= 24; poll++) {
    const now = initial + poll * 15_000, result = accumulator.sample(singlePhase(now), now);
    assert.equal(result.gaps.length, 0);
    const [interval] = result.intervals;
    near(interval.energies[0], 2.4 * 15 / 3600);
    assert.deepEqual(interval.energies.slice(1), [0, 0]);
    assert.equal(interval.sourceTime, now, 'Old zero weights do not age the fresh active-power measurement');
    assert(interval.quality.includes('last_reported_zero_phase_weights'));
  }
  for (const options of [{ power: null }, { inactiveQuality: ['provider_error'] }, { inactiveTime: initial + 1000 }]) {
    const rejected = new ElectricityAccumulator().sample(singlePhase(initial, options), initial);
    assert.equal(rejected.gaps.length, 1, 'Failed/future zero readings and stale VI-only inputs remain unavailable');
  }
  const stalePower = singlePhase(initial).map(row => row.signal.endsWith('active_power') ? { ...row, sourceTime: initial - 600_000 } : row);
  assert.equal(new ElectricityAccumulator().sample(stalePower, initial).gaps.length, 1);
});

test('fresh total power permits older valid nonzero phase shares without changing their timestamps', () => {
  const rows = sample(initial).map(row => row.signal.includes('current_')
    ? { ...row, sourceTime: initial - 600_000, quality: ['stale'] } : row);
  const before = structuredClone(rows), accumulator = new ElectricityAccumulator();
  assert.equal(accumulator.sample(rows, initial).gaps.length, 0);
  const next = rows.map(row => ({ ...row, receivedAt: initial + 15_000,
    sourceTime: row.signal.endsWith('active_power') ? initial + 15_000 : row.sourceTime }));
  const [interval] = accumulator.sample(next, initial + 15_000).intervals;
  near(interval.energies.reduce((a, b) => a + b), 3.5 * 15 / 3600);
  near(interval.energies[0], 2.4 * 15 / 3600);
  near(interval.energies[1], 1.1 * 15 / 3600);
  assert.equal(interval.sourceTime, initial + 15_000);
  assert(interval.quality.includes('last_reported_phase_weights'));
  assert(interval.quality.includes('asynchronous_snapshot'));
  assert.deepEqual(rows, before, 'Allocation never freshens the original observations');
  for (const flag of ['provider_error', 'invalid_numeric', 'invalid_unit', 'conflicting_duplicate', 'future_source_time']) {
    const failed = rows.map(row => row.signal.endsWith('current_l1') ? { ...row, quality: [flag] } : row);
    assert.equal(new ElectricityAccumulator().sample(failed, initial).gaps.length, 1, flag);
  }
});

test('phase and voltage timestamps aging past the limit do not expire fresh reported power', () => {
  const rows = now => sample(now, { timestamp: initial - 295_000 }).map(row => row.signal.endsWith('active_power')
    ? { ...row, sourceTime: now } : row);
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(rows(initial), initial);
  const result = accumulator.sample(rows(initial + 15_000), initial + 15_000);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.intervals.length, 1);
  near(result.intervals[0].energies.reduce((a, b) => a + b), 3.5 * 15 / 3600);
});

test('power and VI freshness clocks may differ across a basis change, while same-basis rollback still breaks coverage', () => {
  const rows = (now, powerTime) => sample(now, { timestamp: initial - 15_000, power: powerTime === null ? null : 3.5 })
    .map(row => row.signal.endsWith('active_power') ? { ...row, sourceTime: powerTime } : row);
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(rows(initial, initial), initial);
  for (const [elapsed, powerTime] of [[15_000, null], [30_000, initial - 20_000]]) {
    const result = accumulator.sample(rows(initial + elapsed, powerTime), initial + elapsed);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.intervals.length, 1);
  }
  const rollback = accumulator.sample(rows(initial + 45_000, initial - 30_000), initial + 45_000);
  assert.equal(rollback.intervals.length, 0);
  assert.deepEqual(rollback.gaps[0].quality, ['source_time_rollback']);
});

const confirmedSample = (now, { telemetryAt = now, connection = { connected: true, observedAt: initial - 3_600_000 } } = {}) =>
  sample(now, { timestamp: initial - 3_600_000 }).map(row => ({ ...row,
    sourceTime: row.signal === 'property_voltage_l1' ? telemetryAt : row.sourceTime,
    raw: { ...row.raw, deviceConnection: connection },
  }));

test('device telemetry confirms unchanged power across checkpoint restart without freshening its source clock', () => {
  let accumulator = new ElectricityAccumulator();
  const rows = confirmedSample(initial), original = structuredClone(rows);
  assert.equal(accumulator.sample(rows, initial).gaps.length, 0);
  const checkpoint = accumulator.checkpoint();
  assert.equal(Object.values(checkpoint.devices)[0].sourceTime, initial - 3_600_000);
  assert.equal(Object.values(checkpoint.devices)[0].telemetryAt, initial);
  accumulator = new ElectricityAccumulator({ checkpoint });
  const result = accumulator.sample(confirmedSample(initial + 15_000), initial + 15_000);
  assert.equal(result.gaps.length, 0);
  const [interval] = result.intervals;
  assert.equal(interval.sourceTime, initial - 3_600_000);
  assert.equal(interval.telemetryAt, initial + 15_000);
  assert(interval.quality.includes('held_power_with_live_telemetry'));
  near(interval.energies.reduce((sum, value) => sum + value, 0), 3.5 * 15 / 3600);
  assert.deepEqual(rows, original);
});

test('cached online state, HTTP receipts, counters and other devices cannot confirm stale power', () => {
  const cases = [
    confirmedSample(initial, { telemetryAt: initial - 18 * 60_000 }),
    confirmedSample(initial, { connection: null }),
    confirmedSample(initial, { connection: { connected: null, observedAt: null } }),
    confirmedSample(initial, { connection: { connected: true, observedAt: initial + 1 } }),
    confirmedSample(initial, { telemetryAt: initial + 1 }),
    ...['provider_error', 'invalid_unit', 'invalid_numeric', 'conflicting_duplicate', 'future_source_time'].map(flag =>
      confirmedSample(initial).map(row => row.signal === 'property_voltage_l1' ? { ...row, quality: [flag] } : row)),
    confirmedSample(initial).map(row => row.signal === 'property_voltage_l1' ? { ...row, unit: 'kWh' } : row),
    [...confirmedSample(initial, { telemetryAt: initial - 18 * 60_000 }),
      ...sample(initial, { counter: 123 }).filter(row => row.signal.endsWith('_counter'))],
    [...confirmedSample(initial, { telemetryAt: initial - 18 * 60_000 }),
      ...sample(initial).map(row => ({ ...row, device: 'another-invented-meter' }))],
  ];
  for (const rows of cases) {
    const result = new ElectricityAccumulator().sample(rows, initial);
    assert.equal(result.intervals.length, 0);
    assert(result.gaps.some(gap => gap.device === 'invented-meter'));
  }
});

test('explicit device disconnection vetoes even recently reported power until a new online observation', () => {
  const accumulator = new ElectricityAccumulator();
  accumulator.sample(sample(initial), initial);
  const disconnected = now => sample(now).map(row => ({ ...row,
    raw: { ...row.raw, deviceConnection: { connected: false, observedAt: initial + 1000 } },
  }));
  const lost = accumulator.sample(disconnected(initial + 15_000), initial + 15_000);
  assert.equal(lost.intervals.length, 0);
  assert.equal(lost.gaps.length, 1);
  const recovered = now => sample(now).map(row => ({ ...row,
    raw: { ...row.raw, deviceConnection: { connected: true, observedAt: initial + 20_000 } },
  }));
  assert.equal(accumulator.sample(recovered(initial + 30_000), initial + 30_000).intervals.length, 0);
  assert.equal(accumulator.sample(recovered(initial + 45_000), initial + 45_000).intervals.length, 1);
});

test('counter audits are deduplicated and resets never change integrated phase energies', () => {
  const audited = new ElectricityAccumulator(), plain = new ElectricityAccumulator();
  for (let poll = 0; poll < 3; poll++) {
    const now = initial + poll * 15_000;
    const counter = poll === 2 ? 1 : 100;
    const a = audited.sample(sample(now, { counter }), now);
    const b = plain.sample(sample(now), now);
    assert.deepEqual(a.intervals, b.intervals);
    assert.equal(a.audits.length, 1);
    if (poll === 2) assert(a.audits[0].quality.includes('counter_reset'));
  }
  const now = initial + 30_000;
  assert.equal(audited.sample(sample(now, { counter: 1 }), now).audits.length, 0);
});

test('batched provider reads power, phases and audit counters once per device with no raw payload persistence', async () => {
  const calls = [];
  const provider = createDeviceProviders({ connections: { easee: { charger_id: 'invented-charger', equalizer_id: 'invented-equalizer', access_token: 'fixture-token' } },
    clock: () => initial, http: { async json(url) {
      calls.push(url);
      const prefix = url.includes('invented-charger') ? 'ev1' : 'property';
      return [
        ...ELECTRICITY_FIELDS[prefix].map(([id, , unit]) => ({ id, unit, value: 1, timestamp: new Date(initial).toISOString(), privateIgnoredField: 'discard-this' })),
        ...(prefix === 'ev1' ? [{ id: 121, unit: 'kWh', value: 0.5, timestamp: new Date(initial).toISOString() }] : []),
      ];
    } } });
  const rows = await provider.electricity({ now: initial });
  assert.equal(calls.length, 2); assert.equal(rows.length, 16);
  assert.deepEqual(new URL(calls[0]).searchParams.get('ids').split(',').map(Number), [183, 184, 185, 194, 195, 196, 120, 124, 250, 130, 132, 136, 150, 129, 223]);
  assert.deepEqual(new URL(calls[1]).searchParams.get('ids').split(',').map(Number), [31, 32, 33, 34, 35, 36, 40, 45, 250]);
  assert(rows.every(row => row.raw.acquisitionOnly));
  assert.deepEqual(rows.filter(row => row.raw.auditOnly).map(row => row.signal), ['ev1_lifetime_energy_counter', 'property_import_energy_counter']);
  assert(!rows.some(row => row.signal === 'ev1_session_energy_counter'), 'Session energy is ignored even if the API returns it unsolicited');
  assert(rows.find(row => row.signal === 'property_active_power').unit === 'kW');
  assert(!JSON.stringify(rows).includes('discard-this'));
});

test('Easee device requests share a bounded sliding rate limit', async () => {
  let calls = 0, now = initial;
  const provider = createDeviceProviders({ connections: { easee: { charger_id: 'invented-charger', equalizer_id: 'invented-equalizer', access_token: 'fixture-token' } },
    clock: () => now, http: { async json() { calls++; return []; } } });
  for (let poll = 0; poll < 45; poll++) await provider.electricity({ now });
  const blocked = await provider.electricity({ now });
  assert.equal(calls, 90); assert(blocked.every(row => row.quality.includes('http_status_429')));
  now += 300_000; await provider.electricity({ now }); assert.equal(calls, 92);
});

test('missing Easee credentials never contact the API and failed devices remain independent', async () => {
  let calls = 0;
  const absent = createDeviceProviders({ connections: { easee: { charger_id: 'invented-charger' } },
    http: { async json() { calls++; throw new Error('Unexpected request'); } } });
  const missing = await absent.electricity({ now: initial });
  assert.equal(calls, 0); assert.equal(missing.length, 8);
  assert(missing.every(row => row.value === null && row.quality.includes('provider_error') && row.quality.includes('missing_configuration') && row.raw.acquisitionOnly));
  const provider = createDeviceProviders({ connections: { easee: { charger_id: 'invented-charger', equalizer_id: 'invented-property', access_token: 'fixture-token' } },
    http: { async json(url) {
      if (url.includes('invented-charger')) throw Object.assign(new Error('Never expose provider secrets'), { status: 503 });
      return ELECTRICITY_FIELDS.property.map(([id, , unit]) => ({ id, unit, value: 1, timestamp: new Date(initial).toISOString() }));
    } } });
  const rows = await provider.electricity({ now: initial });
  assert(rows.filter(row => row.signal.startsWith('ev1_')).every(row => row.value === null && row.quality.includes('http_status_503')));
  assert(rows.filter(row => row.signal.startsWith('property_')).every(row => row.value === 1));
  assert(!JSON.stringify(rows).includes('secrets'));
});

test('the H66 dataset contains thirty registers, retaining brine pump speed only', () => {
  assert.equal(Object.keys(H66_REGISTERS).length, 30);
  assert.equal(H66_REGISTERS['3110'].signal, 'brine_pump_speed');
  assert.equal(H66_REGISTERS['0012'], undefined); assert.equal(H66_REGISTERS['1A04'], undefined);
  assert.doesNotThrow(() => createH66Decoder({ deviceId: 'invented-h66', verifiedRegisters: { '0012': { scale: 1, evidence: 'retired' } }, mqttScaleByRegister: { '1A04': 1 } }));
});

test('MQTT receives configured garage temperatures alongside H66 while excluding omitted registers', async () => {
  const client = new EventEmitter(), topics = [], observations = [];
  client.subscribe = (topic, options, callback) => { topics.push(topic); callback(); };
  client.publish = (topic, payload, options, callback) => callback();
  client.end = (force, options, callback) => callback();
  const store = { getState: () => null, setState() {}, event() {} };
  const reader = await startMqtt({ engine: { clock: () => initial, ingest: row => observations.push(row) }, store,
    config: { deviceId: 'invented-h66', connections: { mqtt: { address: 'mqtt://example.invalid',
      temperatureTopics: { garage_temperature: 'invented/garage' } } } }, connect: () => client });
  try {
    client.emit('connect');
    assert.deepEqual(topics, ['invented-h66/HP/#', 'invented/garage']);
    client.emit('message', 'invented/garage', Buffer.from('11.2'));
    client.emit('message', 'invented-h66/HP/3110', Buffer.from('70'));
    client.emit('message', 'invented-h66/HP/0012', Buffer.from('85'));
    client.emit('message', 'invented-h66/HP/1A04', Buffer.from('1'));
    assert.deepEqual(observations.map(row => row.signal), ['garage_temperature', 'brine_pump_speed']);
  } finally { await reader.close(); }
});

test('generic MQTT temperatures preserve source age and retained availability', () => {
  const basic = decodeMqttTemperature({ signal: 'garage_temperature', payload: '12.25', receivedAt: initial });
  assert.equal(basic.value, 12.25); assert.equal(basic.sourceTime, initial);
  const retained = decodeMqttTemperature({ signal: 'garage_temperature', payload: '12.25', receivedAt: initial, retained: true });
  assert.equal(retained.sourceTime, null); assert(retained.quality.includes('retained'));
  const stale = decodeMqttTemperature({ signal: 'indoor_temperature', payload: JSON.stringify({ value: 68, unit: 'F', timestamp: initial - 600_000 }), receivedAt: initial });
  assert.equal(stale.value, 20); assert(stale.quality.includes('stale'));
  assert.equal(decodeMqttTemperature({ signal: 'garage_temperature', payload: '{}', receivedAt: initial }).value, null);
});
