import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { createEquipmentCapture } from '../src/acquisition/equipment.js';
import { equipmentConfiguration } from '../src/acquisition/equipment-config.js';
import { merossMessage } from '../src/acquisition/meross.js';
import { observationTimeAdmitted } from '../src/domain/time-evidence.js';
import { getChartData } from '../src/app/chart-data.js';

const START = Date.parse('2026-10-30T10:00:00Z');
const uuid = '0123456789abcdef0123456789abcdef', key = 'abcdef0123456789abcdef0123456789';
const signal = 'garage_door1_open', topic = `/appliance/${uuid}/publish`;
async function fixture(t) {
  const store = new Store(':memory:'); let now = START;
  const recorder = new Recorder(store, { clock: () => now });
  const capture = createEquipmentCapture({ store, engine: { clock: () => now, ingest: row => recorder.record(row) },
    settings: equipmentConfiguration({ devices: [{ id: 'garage_door1', area: 'garage', kind: 'door',
      connection: `mqtt:${topic}`, meross: { uuid, key, channel: 1 } }] }), canControl: () => true, publish: async () => {} });
  t.after(async () => { capture.close(); await store.close(); });
  capture.setConnected(true); capture.confirmSubscriptions(capture.topics);
  const settle = () => store.writeQueue.idle(); await settle();
  return { store, recorder, capture, settle, now: () => now, advance: ms => now += ms,
    report(value, source = now) { capture.receiveDoors(topic, JSON.stringify(merossMessage(key, topic, 'PUSH',
      { state: [{ channel: 1, open: value }] }, source)), {}, now, 'primary'); },
    rows: () => store.db.prepare('SELECT * FROM observations WHERE signal=? ORDER BY id').all(signal),
    chart(at = now) { return getChartData({ store, input: 'providers', startDate: '2026-10-30', now: at, left: signal }).series[signal]; } };
}

test('delayed native contacts retain consistent original clocks in stored observations and chart coverage', async t => {
  const f = await fixture(t); f.advance(500); f.report(0, f.now() + 1000); await f.settle();
  assert.equal(f.rows().length, 0, 'Future contact evidence is not recorded early');
  f.advance(500); f.capture.tickDoors(); await f.settle();
  const row = f.rows().find(row => row.value === 0), raw = JSON.parse(row.raw);
  assert.equal(row.source_time, START + 1000);
  assert.equal(row.received_at, START + 500);
  assert.equal(observationTimeAdmitted({ sourceTime: row.source_time, receivedAt: row.received_at, raw }, f.now()), true);
  assert.equal(raw.recorder.status, 'fresh');
  const chart = f.chart(f.now() + 1000);
  assert(chart.some(p => p.y === 0 && p.x === START + 1000));
  assert(!chart.some(p => p.y !== null && p.x < START + 1000), 'A delayed contact cannot backdate chart availability');
});

test('native door history expires at the configured report deadline without needing a disconnect event', async t => {
  const f = await fixture(t); f.report(0); await f.settle();
  const chart = f.chart(START + 120000);
  assert(chart.some(p => p.y === null && p.x === START + 90000));
  assert(!chart.some(p => p.y !== null && p.x >= START + 90000));
});

test('a native route replaces event-only freshness prospectively while retaining earlier contact history', async t => {
  const f = await fixture(t);
  f.recorder.record({ source: 'mqtt-equipment', device: 'garage_door1', signal, value: 1, unit: 'state',
    sourceTime: START - 3600000, receivedAt: START - 3600000, quality: [], raw: { eventOnly: true } });
  f.report(0); await f.settle();
  const chart = f.chart(START + 120000);
  assert(chart.some(p => p.y === 1 && p.x < START), 'Earlier recorded open contact remains present');
  assert(chart.some(p => p.y === 0 && p.x >= START));
  assert(chart.some(p => p.y === null && p.x === START + 90000), 'The new route cannot inherit event-only lifetime');
  assert.equal(JSON.parse(f.rows()[0].raw).eventOnly, true, 'Earlier raw evidence is unchanged');
});

test('inconsistent stored timing evidence remains a gap rather than being repaired or displayed as a contact', async t => {
  const f = await fixture(t); f.advance(1000);
  f.recorder.record({ source: 'mqtt-equipment', device: 'garage_door1', signal, value: 0, unit: 'state',
    sourceTime: f.now(), receivedAt: f.now(), quality: [], raw: { timeBasis: 'mqtt-live-status',
      timeAdmission: { sourceTime: f.now(), receivedAt: f.now() - 500, admittedAt: f.now() } } });
  const before = f.rows();
  assert(!f.chart(f.now() + 1000).some(p => p.y !== null), 'Malformed timing cannot establish historical contact state');
  assert.deepEqual(f.rows(), before, 'Chart reads preserve the original malformed evidence');
});

test('distinct native contact reports within one source-clock second retain both states in receipt order', async t => {
  const f = await fixture(t); f.advance(100); f.report(0); await f.settle();
  f.advance(500); f.report(1); await f.settle();
  const rows = f.rows().filter(row => row.value !== null);
  assert.deepEqual(rows.map(row => row.value), [0, 1]);
  assert(rows.every(row => JSON.parse(row.raw).recorder.status === 'fresh'));
  assert.deepEqual(rows.map(row => row.source_time), [START, START]);
  assert.deepEqual(rows.map(row => row.received_at), [START + 100, START + 600]);
  const chart = f.chart(START + 1000);
  assert(chart.some(p => p.y === 0 && p.x === START + 100));
  assert(chart.some(p => p.y === 1 && p.x === START + 600));
});
