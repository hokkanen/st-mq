import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-charging-contention-'));
  const store = new Store(join(directory, 'fixture.sqlite')), writer = new DatabaseSync(store.path);
  let authority = true;
  const runtime = new ChargingRuntime({ store, engine: {}, config: { input: 'mqtt',
    connections: { easee: { charger_id: 'synthetic-contention' } },
    charging: { vehicles: { bmw: { mqttTopic: '' } } } }, canControl: () => authority });
  // These tests isolate durable permission from numerical forecast throughput.
  runtime.chargers.charger1.controls.enabled = false;
  runtime.refreshSettings();
  let dispatches = 0;
  runtime.updatePlan = async () => {};
  runtime.reconcile = async () => {
    assert.equal(store.getState(runtime.key).chargers.charger1.controls.enabled, true);
    dispatches++;
  };
  t.after(async () => {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    await runtime.close(); writer.close(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const input = () => ({ association: runtime.chargers.charger1.association,
    revision: runtime.chargers.charger1.controls.revision, enabled: true });
  return { store, writer, runtime, input, dispatches: () => dispatches, revoke: () => { authority = false; } };
}

test('charging permission waits through contention and publishes only after committed ownership', async t => {
  const f = fixture(t);
  f.writer.exec('BEGIN IMMEDIATE');
  const pending = f.runtime.setControl('charger1', f.input());
  let beats = 0;
  const timer = setInterval(() => beats++, 10);
  t.after(() => clearInterval(timer));
  await delay(350);
  assert.equal(f.runtime.chargers.charger1.controls.enabled, false);
  assert.equal(f.store.getState(f.runtime.key), null);
  assert.equal(f.dispatches(), 0);
  assert.ok(beats > 10);
  f.writer.exec('ROLLBACK'); await pending;
  assert.equal(f.runtime.chargers.charger1.controls.enabled, true);
  assert.equal(f.dispatches(), 1);
  const reopened = new Store(f.store.path, { readOnly: true });
  try { assert.equal(reopened.getState(f.runtime.key).chargers.charger1.controls.enabled, true); }
  finally { reopened.close(); }
});

test('authority loss while waiting rejects charging permission without mutating or dispatching', async t => {
  const f = fixture(t);
  f.writer.exec('BEGIN IMMEDIATE');
  const pending = f.runtime.setControl('charger1', f.input());
  f.revoke(); f.writer.exec('ROLLBACK');
  await assert.rejects(pending, { code: 'STORAGE_WRITE_STALE' });
  assert.equal(f.runtime.chargers.charger1.controls.enabled, false);
  assert.equal(f.store.getState(f.runtime.key), null);
  assert.equal(f.dispatches(), 0);
});

test('outer commit failure restores charging RAM as well as SQLite and never dispatches the rejected choice', async t => {
  const f = fixture(t), exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => {
    if (sql === 'COMMIT') throw Object.assign(new Error('synthetic commit failure'), { errcode: 10 });
    return exec(sql);
  };
  try { await assert.rejects(f.runtime.setControl('charger1', f.input()), { errcode: 10 }); }
  finally { f.store.db.exec = exec; }
  assert.equal(f.runtime.chargers.charger1.controls.enabled, false);
  assert.equal(f.runtime.chargers.charger1.controls.revision, 0);
  assert.equal(f.store.getState(f.runtime.key), null);
  assert.equal(f.dispatches(), 0);
  await f.runtime.setControl('charger1', f.input());
  assert.equal(f.dispatches(), 1);
});

test('closing charging aborts queued permission without waiting for an external writer', async t => {
  const f = fixture(t);
  f.writer.exec('BEGIN IMMEDIATE');
  const pending = f.runtime.setControl('charger1', f.input()).catch(error => error);
  await f.runtime.close();
  assert.equal((await pending).code, 'STORAGE_WRITE_CANCELLED');
  assert.equal(f.dispatches(), 0);
  assert.equal(f.store.getState(f.runtime.key), null);
});

test('charging shutdown fences admission immediately before slower shared-runtime cleanup', { timeout: 2000 }, async t => {
  const f = fixture(t);
  f.writer.exec('BEGIN IMMEDIATE');
  const pending = f.runtime.setControl('charger1', f.input()).catch(error => error);
  f.runtime.beginShutdown(); f.runtime.beginShutdown();
  assert.equal((await pending).code, 'STORAGE_WRITE_CANCELLED');
  assert.equal(f.store.writeQueueStatus().pending, 0);
  assert.equal(f.writer.isTransaction, true);
  assert.equal(f.dispatches(), 0);
  f.writer.exec('ROLLBACK');
  await f.store.runWrite(() => f.store.setState('next-runtime', true));
  assert.equal(f.store.getState('next-runtime'), true);
});
