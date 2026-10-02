import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { Store } from '../src/storage/store.js';

function fixture() {
  const physical = { online: true, controlReady: false, fields: { phase_info: {} },
    commissioning: { verified: false, sessionEnergyVerified: false, controlReady: false }, error: 'evse-commissioning-required' };
  const readings = { ev2_import_energy_counter: { value: 10, available: true },
    ev2_session_energy: { value: null, available: false } };
  const config = { maxAgeMs: 15000, sessionEnergyVerified: false };
  const adapter = { snapshot: () => physical, readings: () => readings, config };
  const charger = { enabled: true };
  const engine = { config: { input: 'offline' }, store: { getState: () => null },
    charging: { chargers: { charger2: { adapter } }, configuration: { chargers: { charger2: charger } } } };
  return { physical, readings, config, charger, status: () => Engine.prototype.providerStatus.call(engine)['shelly-evse'] };
}

test('Shelly meter acquisition remains available independently of control and session commissioning', () => {
  const f = fixture(), status = f.status();
  assert.equal(status.status, 'ok');
  assert.equal(status.reason, 'physical-meter');
  assert.equal(status.recording, true);
  assert.equal(status.controlReady, false);
  assert.equal(status.sessionEnergyVerified, false);
  assert.deepEqual(status.commissioning, f.physical.commissioning);
  assert.deepEqual(status.readings, f.readings);
  assert.equal(status.sessionReference, null);
  f.physical.sessionReference = { kind: 'plug-period-native-runs', observedKwh: 3, runCount: 2,
    complete: false, quality: ['missing-final-reference'], phase: 'active', start: 1000, observedAt: 10000 };
  assert.deepEqual(f.status().sessionReference, f.physical.sessionReference);
  f.physical.error = 'evse-native-restriction';
  assert.equal(f.status().status, 'ok', 'Native charge restrictions do not invalidate live electrical measurements');
  f.config.sessionEnergyVerified = true;
  assert.equal(f.status().sessionEnergyVerified, false, 'Configured verification does not override an actual firmware mismatch');
  f.physical.commissioning.sessionEnergyVerified = true;
  assert.equal(f.status().sessionEnergyVerified, true);
});

test('Shelly acquisition status follows usable measurements and transport, not a cached meter field', () => {
  const f = fixture();
  f.readings.ev2_import_energy_counter.available = false;
  f.readings.ev2_import_energy_counter.quality = ['stale'];
  f.physical.controlReady = true;
  assert.equal(f.status().status, 'degraded');
  assert.equal(f.status().reason, 'telemetry-unavailable');
  assert.equal(f.status().recording, false);
  f.physical.fields = {};
  assert.equal(f.status().status, 'waiting');
  f.physical.online = false;
  f.readings.ev2_import_energy_counter.available = true;
  assert.equal(f.status().status, 'waiting');
  assert.equal(f.status().reason, 'awaiting-mqtt');
  assert.equal(f.status().recording, false);
  f.charger.enabled = false;
  assert.equal(f.status().status, 'disabled');
  assert.equal(f.status().reason, 'not-enabled');
});

test('energy checks API exposes current native reference verification independently of historical totals', async t => {
  const store = new Store(':memory:');
  let verified = false;
  const sessionReference = { kind: 'plug-period-native-runs', observedKwh: 3, runCount: 2,
    complete: false, quality: ['missing-final-reference'], phase: 'active', start: 1000, observedAt: 10000 };
  const engine = { clock: () => 100000,
    charging: { chargers: { charger2: { adapter: {
      snapshot: () => ({ commissioning: { sessionEnergyVerified: verified }, sessionReference, privateDeviceId: 'synthetic-private-device' }),
    } } } } };
  const server = createAppServer({ engine, store, chartService: { overview() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const read = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/energy-audits`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await read();
  assert.equal(before[2].sessionEnergyVerified, false);
  assert.equal(before[2].summary.recordedSessions, 0);
  assert.deepEqual(before[2].sessionReference, sessionReference);
  assert(!JSON.stringify(before).includes('synthetic-private-device'));
  verified = true;
  const after = await read();
  assert.equal(after[2].sessionEnergyVerified, true);
  assert.deepEqual(after[2].summary, before[2].summary);
  assert.equal(store.events().length, 0);
});
