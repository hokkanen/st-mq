import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/app/engine.js';
import { createAppServer } from '../src/app/server.js';
import { Store } from '../src/storage/store.js';

function fixture() {
  const physical = { online: true, controlReady: false, fields: { phase_info: {} },
    commissioning: { profileSupported: false, controlReady: false }, error: 'evse-profile-unsupported' };
  const readings = { ev2_import_energy_counter: { value: 10, available: true } };
  const config = { maxAgeMs: 15000 };
  const adapter = { snapshot: () => physical, readings: () => readings, config };
  const charger = { enabled: true };
  const engine = { config: { input: 'offline' }, store: { getState: () => null },
    charging: { chargers: { charger2: { adapter } }, configuration: { chargers: { charger2: charger } } } };
  return { physical, readings, config, charger, status: () => Engine.prototype.providerStatus.call(engine)['shelly-evse'] };
}

test('Shelly meter acquisition remains available independently of control commissioning', () => {
  const f = fixture(), status = f.status();
  assert.equal(status.status, 'ok');
  assert.equal(status.reason, 'physical-meter');
  assert.equal(status.recording, true);
  assert.equal(status.controlReady, false);
  assert(!Object.hasOwn(status, 'sessionEnergyVerified'));
  assert(!Object.hasOwn(status, 'sessionReference'));
  assert.deepEqual(status.commissioning, f.physical.commissioning);
  assert.deepEqual(status.readings, f.readings);
  f.physical.error = 'evse-native-restriction';
  assert.equal(f.status().status, 'ok', 'Native charge restrictions do not invalidate live electrical measurements');

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

test('energy checks API only includes Property and Charger 1 and needs no Shelly snapshot', async t => {
  const store = new Store(':memory:');
  const engine = { clock: () => 100000,
    charging: { chargers: { charger2: { adapter: {
      snapshot: () => { throw new Error('Energy checks must not request Shelly session evidence'); },
    } } } } };
  const server = createAppServer({ engine, store, chartService: { overview() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/energy-audits`);
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.deepEqual(rows.map(row => row.signal), ['property_import_energy_counter', 'ev1_session_energy_check']);
  assert.equal(rows[1].summary.recordedSessions, 0);
  assert.equal(store.events().length, 0);
});
