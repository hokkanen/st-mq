import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { createMqttAdmission } from '../src/acquisition/mqtt-admission.js';
import { createMqttReception } from '../src/acquisition/mqtt-reception.js';
import { retainStorageWithdrawal } from '../src/acquisition/storage-withdrawal.js';

for (const outcome of ['commit', 'rollback']) test(`transport withdrawal survives an older worker ${outcome}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-acquisition-settlement-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  await store.startWriter();
  const device = { connected: true, available: true, state: true, readings: {}, waiters: new Set(), checks: new Set() };
  const engine = { latest: { value: 1, receivedAt: 10 }, ingestionCheckpoint() { return structuredClone(this.latest); },
    restoreIngestionCheckpoint(value) { this.latest = value; } };
  const request = { device, retired: false }, requests = new Map([[1, request]]);
  const reception = createMqttReception({ store, engine, admission: createMqttAdmission(), devices: [device], meters: new Map(), requests });
  let entered, release;
  const held = new Promise(resolve => { entered = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const send = store.writer.request.bind(store.writer);
  store.writer.request = async (operation, args) => {
    if (operation === 'commit') {
      entered(); await resumed;
      if (outcome === 'rollback') throw Object.assign(new Error('synthetic commit failure'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    }
    return send(operation, args);
  };
  let calls = 0;
  const saved = store.runWrite(() => reception.run(() => {
    calls++; device.state = false; device.readings.power = 2;
    engine.latest = { value: 2, receivedAt: 20 }; requests.delete(1);
    requests.set(3, { device, retired: false });
    store.setState('received', true);
  }));
  const result = saved.then(() => null, error => error);
  await held;
  assert.equal(store.transactionDepth, 0);
  assert.equal(store.canDispatch(), false);
  reception.invalidate(device);
  device.connected = false; request.retired = true;
  const newerRequest = { device, retired: false }; requests.set(2, newerRequest);
  retainStorageWithdrawal(store, device, () => {
    device.available = false; device.state = null;
    engine.latest = { value: null, receivedAt: 30 };
  });
  // Keep the latest withdrawal and its original clock for this owner.
  retainStorageWithdrawal(store, device, () => {
    device.available = false; device.state = null;
    engine.latest = { value: null, receivedAt: 40 };
  });
  release();
  const error = await result;
  assert.equal(Boolean(error), outcome === 'rollback');
  assert.equal(calls, 1);
  assert.equal(device.connected, false);
  assert.equal(device.available, false);
  assert.equal(device.state, null);
  assert.deepEqual(engine.latest, { value: null, receivedAt: 40 });
  assert.equal(requests.has(1), false, 'A completed native request cannot be revived by rollback');
  assert.equal(requests.get(2), newerRequest, 'A newer independent request remains owned by its caller');
  assert.equal(requests.has(3), outcome === 'commit', 'A request created by failed receipt processing is discarded');
  assert.equal(store.getState('received'), outcome === 'commit' ? true : null);
  assert.equal(store.canDispatch(), true);
});
