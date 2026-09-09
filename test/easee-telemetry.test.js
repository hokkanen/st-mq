import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceProviders } from '../src/acquisition/devices.js';

const now = Date.parse('2026-09-10T12:00:00Z');
const boot = now - 86_400_000;
const connection = (value, at = boot) => ({ id: 250, value, timestamp: new Date(at).toISOString() });
const unknown = { connected: null, observedAt: null };

async function read(connectionRows, { equalizerRows = connectionRows } = {}) {
  const calls = [];
  const providers = createDeviceProviders({
    connections: { easee: { access_token: 'synthetic-access', charger_id: 'invented-charger', equalizer_id: 'invented-equalizer' } },
    clock: () => now,
    http: { async json(url, options) {
      calls.push({ url, method: options.method });
      const charger = url.includes('/invented-charger/');
      return { observations: [
        { id: charger ? 120 : 40, value: 0, timestamp: new Date(boot).toISOString() },
        ...(charger ? connectionRows : equalizerRows),
      ] };
    } },
  });
  return { rows: await providers.electricity({ now }), calls };
}

test('electricity batches cloud connection with existing reads and keeps device evidence separate', async () => {
  const { rows, calls } = await read([connection(true)], { equalizerRows: [connection(false, now - 15_000)] });
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.method === 'GET'));
  assert.deepEqual(calls.map(call => new URL(call.url).searchParams.get('ids')), [
    '183,184,185,194,195,196,120,124,250,130,132,136,150', '31,32,33,34,35,36,40,45,250',
  ]);
  assert.equal(rows.length, 16, 'Connection is metadata, not another electrical series');
  for (const row of rows) assert.deepEqual(row.raw.deviceConnection, row.signal.startsWith('ev1_')
    ? { connected: true, observedAt: boot } : { connected: false, observedAt: now - 15_000 });
  for (const row of rows.filter(row => row.signal.endsWith('_active_power'))) {
    assert.equal(row.sourceTime, boot);
    assert(row.quality.includes('stale'), 'Connection state alone never freshens old electrical data');
  }
});

test('cloud connection normalizes only explicit boolean representations', async () => {
  for (const [value, expected] of [[true, true], [false, false], [1, true], [0, false],
    ['true', true], ['false', false], ['1', true], ['0', false], [' TRUE ', true], [' FALSE ', false]]) {
    const { rows } = await read([connection(value)]);
    assert(rows.every(row => row.raw.deviceConnection.connected === expected));
    assert(rows.every(row => row.raw.deviceConnection.observedAt === boot));
  }
  for (const value of [null, undefined, '', 'yes', 'off', '2', 2, -1, [], {}, 'synthetic-private-payload']) {
    const { rows } = await read([connection(value)]);
    assert(rows.every(row => JSON.stringify(row.raw.deviceConnection) === JSON.stringify(unknown)));
    assert(!JSON.stringify(rows).includes('synthetic-private-payload'));
  }
});

test('missing, malformed, future or conflicting connection reports cannot authorize continuity', async () => {
  const invalid = [[], [{ id: 250, value: true }], [{ id: 250, value: true, timestamp: 'invalid' }],
    [{ id: 250, value: true, timestamp: '2026-09-10T11:00:00' }], [connection(true, now + 1)],
    [connection(true, -1)], [connection(true), connection(false)],
    [connection(true), { id: 250, value: true, timestamp: null }],
    [connection(true), connection(false, now + 1)],
  ];
  for (const reports of invalid) {
    const { rows } = await read(reports);
    for (const row of rows) assert.deepEqual(row.raw.deviceConnection, unknown);
  }
  const { rows } = await read([connection(true)], { equalizerRows: [] });
  assert(rows.filter(row => row.signal.startsWith('ev1_')).every(row => row.raw.deviceConnection.connected === true));
  for (const row of rows.filter(row => row.signal.startsWith('property_'))) assert.deepEqual(row.raw.deviceConnection, unknown);
});

test('connection transitions select the latest source timestamp and discard unrelated payload fields', async () => {
  const payload = [connection(false, now - 15_000),
    { ...connection(true), privateField: 'synthetic-private-payload', device: 'another-invented-device' },
    connection('false', now - 15_000),
  ];
  const before = structuredClone(payload);
  const { rows } = await read(payload);
  for (const row of rows) assert.deepEqual(row.raw.deviceConnection, { connected: false, observedAt: now - 15_000 });
  assert(!JSON.stringify(rows).includes('synthetic-private-payload'));
  assert(!JSON.stringify(rows).includes('another-invented-device'));
  assert.deepEqual(payload, before);
});

const telemetry = (id, value, at = now - 600_000, unit) => ({ id, value, timestamp: new Date(at).toISOString(), ...(unit === undefined ? {} : { unit }) });

test('charger diagnostics retain only their newest valid source time without altering cached electrical clocks', async () => {
  const payload = [connection(true, now - 3_600_000),
    telemetry(194, 230, now - 480_000, 'V'),
    telemetry(130, -80, now - 700_000, 'dBm'), telemetry(132, '-70', now - 650_000, 'dBm'),
    telemetry(136, -60, now - 600_000),
    { ...telemetry(150, 35, now - 420_000, 'C'), privateField: 'synthetic-private-diagnostics' },
  ];
  const original = structuredClone(payload);
  const { rows, calls } = await read(payload);
  assert.equal(calls.length, 2);
  assert.equal(rows.length, 16);
  for (const row of rows.filter(row => row.signal.startsWith('ev1_'))) assert.equal(row.raw.deviceTelemetryAt, now - 420_000);
  for (const row of rows.filter(row => row.signal.startsWith('property_'))) assert.equal(row.raw.deviceTelemetryAt, null,
    'Charger diagnostic IDs must not be interpreted as Equalizer telemetry');
  const power = rows.find(row => row.signal === 'ev1_active_power');
  const voltage = rows.find(row => row.signal === 'ev1_voltage_l1');
  assert.equal(power.sourceTime, boot);
  assert(power.sourceTime < power.raw.deviceConnection.observedAt, 'A cloud connection event can follow unchanged electrical values');
  assert.equal(voltage.sourceTime, now - 480_000);
  assert(voltage.quality.includes('stale'));
  assert(!JSON.stringify(rows).includes('synthetic-private-diagnostics'));
  assert(rows.every(row => ![130, 132, 136, 150].includes(row.raw.observationId)));
  assert.deepEqual(payload, original);
});

test('invalid diagnostic fields cannot supply a device timestamp, while independent valid fields remain usable', async () => {
  const invalid = [
    telemetry(132, null), telemetry(132, 'not-numeric'), telemetry(132, true), telemetry(132, -151), telemetry(132, 1),
    telemetry(132, -70, now, 'V'), telemetry(150, -61), telemetry(150, 151), telemetry(150, 80, now, 'F'),
    telemetry(150, 35, now + 1), telemetry(150, 35, -1),
    { id: 150, value: 35 }, { id: 150, value: 35, timestamp: 'invalid' },
    { id: 150, value: 35, timestamp: '2026-09-10T11:50:00' },
  ];
  for (const row of invalid) {
    const { rows } = await read([connection(true), row]);
    assert(rows.every(result => result.raw.deviceTelemetryAt === null));
  }
  const { rows } = await read([connection(true), telemetry(150, 35, now + 1), telemetry(132, -70, now - 600_000)]);
  assert(rows.filter(row => row.signal.startsWith('ev1_')).every(row => row.raw.deviceTelemetryAt === now - 600_000));
});

test('conflicting diagnostic duplicates cannot refresh a device and equivalent latest reports are accepted', async () => {
  for (const payload of [
    [telemetry(150, 35), telemetry(150, 36)],
    [telemetry(150, 35), telemetry(150, 35, now + 1)],
    [telemetry(150, 35), { id: 150, value: 35, timestamp: null }],
  ]) {
    const { rows } = await read(payload);
    assert(rows.every(row => row.raw.deviceTelemetryAt === null));
  }
  const { rows } = await read([telemetry(150, 34, now - 700_000), telemetry(150, 35), telemetry(150, '35', now - 600_000, '°C')]);
  assert(rows.filter(row => row.signal.startsWith('ev1_')).every(row => row.raw.deviceTelemetryAt === now - 600_000));
});
