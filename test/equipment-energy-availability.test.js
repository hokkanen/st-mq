import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';

test('generic caravan energy cannot resume through late counter reports while explicitly offline', t => {
  const store = new Store(':memory:');
  let now = Date.parse('2026-09-21T10:00:00Z');
  const settings = equipmentConfiguration({ devices: [{ id: 'caravan', kind: 'metered_switch', area: 'garage',
    connection: 'mqtt:invented/caravan/state', mqtt: { timestamp_path: 'timestamp', availability_topic: 'invented/caravan/online' } }] });
  const capture = createEquipmentCapture({ settings, store, engine: { clock: () => now, ingest: () => {} }, publish: async () => {} });
  t.after(() => { capture.close(); store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  const report = (elapsed, energy) => {
    now += elapsed;
    capture.receive('invented/caravan/state', JSON.stringify({ value: 'on', power: 1, current: 4, energy, timestamp: now }));
  };
  capture.receive('invented/caravan/online', 'online');
  report(0, 1); report(30_000, 1.01);
  const known = capture.status().devices[0].energy.dailyKwh;
  assert(Math.abs(known - 0.01) < 1e-9);
  now += 1000; capture.receive('invented/caravan/online', 'offline');
  report(1000, 1.02); report(1000, 1.03);
  assert.equal(capture.status().devices[0].energy.dailyKwh, known);
  capture.receive('invented/caravan/online', 'online');
  report(1000, 1.04);
  assert.equal(capture.status().devices[0].energy.dailyKwh, known, 'First recovered counter only establishes a fresh baseline');
  report(30_000, 1.05);
  assert(Math.abs(capture.status().devices[0].energy.dailyKwh - 0.02) < 1e-9);
  const saved = store.db.prepare("SELECT SUM(value) AS total FROM observations WHERE signal='caravan_energy'").get();
  assert(Math.abs(saved.total - 0.02) < 1e-9);
});
