import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createEquipmentTests } from '../src/app/equipment-tests.js';
import { Store } from '../src/storage/store.js';

const KEY = 'equipment-tests:v1', INITIAL = Date.parse('2026-09-13T10:00:00Z');
const digest = 'a'.repeat(64);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { saved = new Map(), command, on = false, storage } = {}) {
  let now = INITIAL, allowed = true, route = digest;
  const calls = [], reports = [];
  const device = { id: 'caravan', label: 'Caravan plug', area: 'Outside', kind: 'plug', available: true,
    controls: { switch: true, tariff: false }, readings: { active: { value: Number(on), unit: 'state', stale: false, observedAt: now } } };
  const store = storage ?? { getState: key => structuredClone(saved.get(key) ?? null),
    setState: (key, value) => saved.set(key, structuredClone(value)), runWrite: async operation => operation() };
  const equipment = { status: () => ({ devices: [device] }), signature: id => id === device.id ? route : null,
    async setSwitch(id, nextOn) {
      const persisted = store.getState(KEY), active = persisted.active;
      if (active) {
        assert.equal(active.deviceId, id, 'The device route is saved before a command');
        assert.equal(active.signature, digest, 'Restoration stays bound to the original connection');
      } else assert.equal(persisted.lastManual.deviceId, id, 'The manual request is saved before a command');
      calls.push({ id, on: nextOn, at: now });
      if (command) return command({ id, on: nextOn, calls, device, now });
      device.readings.active = { value: Number(nextOn), unit: 'state', stale: false, observedAt: now };
      return { confirmed: true, sent: true };
    } };
  let availableAdapter = equipment;
  const options = { store, clock: () => now, getEquipment: () => availableAdapter, canControl: () => allowed,
    report: value => reports.push(value) };
  const manager = createEquipmentTests(options);
  t.after(() => manager.close({ restore: false }));
  return { manager, options, store, device, equipment, calls, reports, saved,
    advance(ms) { now += ms; }, setAuthority(value) { allowed = value; }, setRoute(value) { route = value; },
    setAdapter(value) { availableAdapter = value; }, get now() { return now; } };
}
const request = (on = true, durationMinutes = 1) => ({ deviceId: 'caravan', on, durationMinutes });

function storageFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-equipment-contention-'));
  const storage = new Store(join(directory, 'fixture.sqlite')), writer = new DatabaseSync(storage.path);
  const f = fixture(t, { storage });
  t.after(async () => {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    await f.manager.close({ restore: false });
    writer.close(); storage.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { ...f, writer };
}

test('direct manual switches have live confirmation and no timer, shutdown reversal or restart replay', async t => {
  const f = fixture(t);
  const result = await f.manager.setSwitch({ deviceId: 'caravan', on: true });
  assert.equal(result.status, 'confirmed'); assert.equal(result.confirmed, true);
  assert.equal(result.previousOn, false); assert.equal(result.on, true); assert.equal(result.sent, true);
  assert.equal(f.manager.status().active, null); assert.equal('until' in result, false);
  f.advance(24 * 60 * 60_000); await f.manager.tick(); await f.manager.close();
  const restarted = createEquipmentTests(f.options);
  t.after(() => restarted.close());
  await restarted.tick();
  assert.deepEqual(f.calls.map(row => row.on), [true]);
  assert.equal(restarted.manualStatus().lastResult.confirmed, true);
});

test('direct manual switches reject unsafe inputs, stale states, tariff outputs and missing authority', async t => {
  const f = fixture(t);
  for (const input of [null, [], {}, { deviceId: 'caravan', on: 'ON' }, request(),
    { deviceId: 'caravan', on: true, topic: 'synthetic/arbitrary' }])
    await assert.rejects(f.manager.setSwitch(input), { code: 'EQUIPMENT_SWITCH_INPUT' });
  f.setAuthority(false);
  await assert.rejects(f.manager.setSwitch({ deviceId: 'caravan', on: true }), { code: 'EQUIPMENT_TEST_AUTHORITY' });
  f.setAuthority(true); f.device.controls.tariff = true;
  await assert.rejects(f.manager.setSwitch({ deviceId: 'caravan', on: true }), { code: 'EQUIPMENT_TEST_TARIFF' });
  f.device.controls.tariff = false; f.device.readings.active.stale = true;
  await assert.rejects(f.manager.setSwitch({ deviceId: 'caravan', on: true }), { code: 'EQUIPMENT_TEST_STATE' });
  assert.deepEqual(f.calls, []);
});

test('direct switches share serialization with legacy restoration and never turn publish acknowledgements into live confirmation', async t => {
  let finish;
  const f = fixture(t, { command: () => new Promise(resolve => { finish = resolve; }) });
  const command = f.manager.setSwitch({ deviceId: 'caravan', on: true });
  await Promise.resolve();
  assert.equal(f.manager.manualStatus().busy, true);
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_BUSY' });
  await assert.rejects(f.manager.setSwitch({ deviceId: 'caravan', on: false }), { code: 'EQUIPMENT_TEST_BUSY' });
  finish({ sent: true });
  await assert.rejects(command, { code: 'EQUIPMENT_SWITCH_UNCONFIRMED' });
  assert.equal(f.manager.manualStatus().lastResult.sent, true);
  assert.equal(f.manager.manualStatus().lastResult.confirmed, false);
  assert.equal(f.manager.status().active, null);
  await f.manager.close();
  assert.deepEqual(f.calls.map(row => row.on), [true]);
});

test('a manual test saves its route, confirms the requested state, and restores at its bounded deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  assert.equal(f.manager.status().available, true);
  await f.manager.start(request(true, 3));
  assert.deepEqual(f.calls.map(row => row.on), [true]);
  assert.deepEqual(f.manager.status().active, { deviceId: 'caravan', on: true, previousOn: false,
    until: INITIAL + 180_000, status: 'active' });
  assert(!JSON.stringify(f.manager.status()).includes(digest));
  f.advance(180_000); t.mock.timers.tick(180_000); await flush();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  assert.equal(f.manager.status().active, null);
  assert.equal(f.manager.status().lastResult.status, 'restored');
});

test('OFF tests restore an originally ON switch and do not retrigger on unrelated ticks', async t => {
  const f = fixture(t, { on: true });
  await f.manager.start(request(false));
  await f.manager.tick(); await f.manager.tick();
  assert.deepEqual(f.calls.map(row => row.on), [false]);
  await f.manager.restore();
  assert.deepEqual(f.calls.map(row => row.on), [false, true]);
  await f.manager.tick(); assert.equal(f.calls.length, 2);
});

test('invalid requests, tariffs and stale state never dispatch a test', async t => {
  const f = fixture(t);
  for (const input of [null, {}, request(true, 0), request(true, 16), request(true, 1.5),
    { ...request(), topic: 'invented/command' }, { ...request(), on: 1 }, { ...request(), deviceId: 'unknown' }])
    await assert.rejects(f.manager.start(input));
  f.device.controls.tariff = true;
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_TARIFF' });
  f.device.controls.tariff = false; f.device.readings.active.stale = true;
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_STATE' });
  f.device.readings.active.stale = false; f.device.readings.active.observedAt = INITIAL + 1;
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_STATE' });
  assert.equal(f.calls.length, 0); assert.equal(f.saved.has(KEY), false);
});

test('unconfirmed ON persists restoration and cannot be cleared by the cached pre-command state', async t => {
  let fail = true;
  const f = fixture(t, { command: ({ device, on, now }) => {
    if (fail) throw new Error('invented-private-device-response');
    device.readings.active = { value: Number(on), unit: 'state', stale: false, observedAt: now };
    return { confirmed: true };
  } });
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_UNCONFIRMED' });
  assert.equal(f.manager.status().active.status, 'restoration-pending');
  assert(!JSON.stringify(f.manager.status()).includes('invented-private-device-response'));
  assert(!JSON.stringify(f.reports).includes('invented-private-device-response'));
  fail = false;
  await f.manager.restore();
  assert.deepEqual(f.calls.map(row => row.on), [true, false], 'An old OFF observation is not proof that an uncertain ON failed');
});

test('a plain broker acknowledgement is insufficient for either test or restoration', async t => {
  const f = fixture(t, { command: () => ({ sent: true, status: 'mqtt' }) });
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_UNCONFIRMED' });
  await assert.rejects(f.manager.restore(), { code: 'EQUIPMENT_TEST_RESTORE' });
  assert.equal(f.saved.get(KEY).active.status, 'restoration-pending');
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
});

test('an old-state report during an unconfirmed ON cannot erase the restoration obligation', async t => {
  const f = fixture(t, { command: ({ on, device, now }) => {
    if (on) {
      // A periodic report can arrive after dispatch, before the device applies
      // ON. Its newer receive time does not prove the uncertain command failed.
      f.advance(1000);
      device.readings.active = { value: 0, unit: 'state', stale: false, observedAt: f.now };
      f.advance(1000);
      throw new Error('synthetic command response lost');
    }
    device.readings.active = { value: 0, unit: 'state', stale: false, observedAt: now };
    return { confirmed: true };
  } });
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_UNCONFIRMED' });
  await f.manager.restore();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  assert.equal(f.manager.status().active, null);
});

test('a failed restoration retries without repeating ON even when tick runs every second', async t => {
  let stops = 0;
  const f = fixture(t, { command: ({ on, device, now }) => {
    if (!on && ++stops === 1) throw new Error('synthetic failed restoration');
    device.readings.active = { value: Number(on), unit: 'state', stale: false, observedAt: now };
    return { confirmed: true };
  } });
  await f.manager.start(request());
  f.advance(60_000); await f.manager.tick();
  assert.equal(f.manager.status().active.status, 'restoration-pending');
  for (let i = 0; i < 5; i++) { f.advance(1000); await f.manager.tick(); }
  assert.deepEqual(f.calls.map(row => row.on), [true, false, false]);
  assert.equal(f.manager.status().active, null);
});

test('restart construction sends nothing and its first tick restores the saved route without a new ON', async t => {
  const f = fixture(t);
  await f.manager.start(request()); await f.manager.close({ restore: false });
  const restarted = createEquipmentTests(f.options);
  t.after(() => restarted.close({ restore: false }));
  assert.equal(f.calls.length, 1);
  await restarted.tick();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  assert.equal(restarted.status().active, null);
});

test('changed connection signatures block restoration until the original physical route returns', async t => {
  const f = fixture(t);
  await f.manager.start(request());
  f.setRoute('b'.repeat(64));
  await assert.rejects(f.manager.restore(), { code: 'EQUIPMENT_TEST_ROUTE' });
  assert.equal(f.calls.length, 1); assert.equal(f.saved.get(KEY).active.signature, digest);
  f.setRoute(digest); await f.manager.restore();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
});

test('authority loss permits no writes and leaves a durable obligation for a later authorized restoration', async t => {
  const f = fixture(t);
  f.setAuthority(false);
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_AUTHORITY' });
  f.setAuthority(true); await f.manager.start(request());
  f.setAuthority(false); f.advance(60_000); await f.manager.tick();
  await assert.rejects(f.manager.restore(), { code: 'EQUIPMENT_TEST_AUTHORITY' });
  assert.equal(f.calls.length, 1); assert(f.saved.get(KEY).active);
  f.setAuthority(true); await f.manager.restore();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
});

test('an omitted authority guard never enables equipment writes', async t => {
  const f = fixture(t);
  const manager = createEquipmentTests({ ...f.options, canControl: undefined });
  t.after(() => manager.close({ restore: false }));
  assert.equal(manager.status().available, false);
  await assert.rejects(manager.start(request()), { code: 'EQUIPMENT_TEST_AUTHORITY' });
  assert.equal(f.calls.length, 0);
});

test('switch tests remain unavailable until the adapter can identify its restoration route', async t => {
  const f = fixture(t);
  f.setRoute(null);
  assert.equal(f.manager.status().available, false);
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_ROUTE' });
  assert.equal(f.calls.length, 0);
  f.setRoute(digest);
  assert.equal(f.manager.status().available, true);
});

test('a concurrent test or restore cannot duplicate an in-flight switch command', async t => {
  let confirm;
  const f = fixture(t, { command: () => new Promise(resolve => { confirm = resolve; }) });
  const pending = f.manager.start(request());
  await Promise.resolve();
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_BUSY' });
  await assert.rejects(f.manager.restore(), { code: 'EQUIPMENT_TEST_BUSY' });
  await f.manager.tick(); assert.equal(f.calls.length, 1);
  confirm({ confirmed: true }); await pending;
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_ACTIVE' });
});

test('the duration begins after confirmation and shutdown waits for an in-flight command before restoring', async t => {
  let confirm;
  const f = fixture(t, { command: ({ on, device, now }) => {
    if (on) return new Promise(resolve => { confirm = resolve; });
    device.readings.active = { value: 0, unit: 'state', stale: false, observedAt: now };
    return { confirmed: true };
  } });
  const start = f.manager.start(request(true, 15));
  while (!confirm) await flush();
  f.advance(7000);
  const closing = f.manager.close();
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_CLOSED' });
  assert.equal(f.calls.length, 1);
  confirm({ confirmed: true });
  const started = await start;
  assert.equal(started.until, INITIAL + 7000 + 15 * 60_000);
  await closing;
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  assert.equal(f.manager.status().active, null);
});

test('authority or route changes during an in-flight command retain the original restoration obligation', async t => {
  for (const change of ['authority', 'route']) {
    let confirm;
    const f = fixture(t, { command: () => new Promise(resolve => { confirm = resolve; }) });
    const start = f.manager.start(request());
    while (!confirm) await new Promise(resolve => setImmediate(resolve));
    if (change === 'authority') f.setAuthority(false);
    else f.setRoute('b'.repeat(64));
    confirm({ confirmed: true });
    await assert.rejects(start, { code: change === 'authority' ? 'EQUIPMENT_TEST_AUTHORITY' : 'EQUIPMENT_TEST_ROUTE' });
    assert.equal(f.saved.get(KEY).active.signature, digest);
    assert.equal(f.saved.get(KEY).active.status, 'restoration-pending');
    await f.manager.tick();
    assert.equal(f.calls.length, 1);
  }
});

test('a storage failure after dispatch preserves the pre-command obligation across restart', async t => {
  const f = fixture(t);
  const write = f.store.setState;
  let writes = 0;
  f.store.setState = (key, value) => {
    if (++writes > 1) throw new Error('synthetic storage failure after dispatch');
    return write(key, value);
  };
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_UNCONFIRMED' });
  assert.equal(f.saved.get(KEY).active.status, 'starting');
  assert.equal(f.manager.status().active.status, 'restoration-pending');
  await f.manager.close({ restore: false });
  f.store.setState = write;
  const restarted = createEquipmentTests(f.options);
  t.after(() => restarted.close({ restore: false }));
  await restarted.tick();
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  assert.equal(restarted.status().active, null);
});

test('queued tests recheck native state, authority and deadline before saving an obligation', async t => {
  for (const changed of ['native-state', 'authority', 'deadline']) {
    const f = storageFixture(t);
    f.writer.exec('BEGIN IMMEDIATE');
    const outcome = f.manager.start(request()).catch(error => error);
    await delay(35);
    assert.equal(f.store.writeQueueStatus().pending, 1);
    assert.equal(f.store.getState(KEY), null);
    if (changed === 'native-state') f.device.readings.active.value = 1;
    if (changed === 'authority') f.setAuthority(false);
    if (changed === 'deadline') f.advance(60_001);
    f.writer.exec('ROLLBACK');
    assert.equal((await outcome).code, changed === 'authority' ? 'EQUIPMENT_TEST_AUTHORITY' : 'EQUIPMENT_TEST_STATE');
    assert.equal(f.store.getState(KEY), null);
    assert.equal(f.manager.status().active, null);
    f.setAuthority(true); await f.manager.tick();
    assert.deepEqual(f.calls, []);
  }
});

test('a native change after intent commit but before dispatch clears the unissued test without restoration', async t => {
  const f = fixture(t), runWrite = f.store.runWrite;
  let writes = 0;
  f.store.runWrite = async operation => {
    const result = await runWrite(operation);
    if (++writes === 1) f.device.readings.active.value = 1;
    return result;
  };
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_NOT_STARTED' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.saved.get(KEY).active, null);
  assert.equal(f.manager.status().lastResult.sent, false);
  assert.equal(f.manager.status().lastResult.status, 'not-started');
  const restarted = createEquipmentTests(f.options);
  t.after(() => restarted.close({ restore: false }));
  await restarted.tick();
  assert.equal(f.device.readings.active.value, 1);
  assert.deepEqual(f.calls, []);
});

test('failed unissued-intent cleanup retries storage without overwriting the new native switch state', async t => {
  const f = fixture(t), runWrite = f.store.runWrite;
  let writes = 0;
  f.store.runWrite = async operation => {
    if (++writes === 2) throw new Error('synthetic cleanup failure');
    const result = await runWrite(operation);
    if (writes === 1) f.device.readings.active.value = 1;
    return result;
  };
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_STORAGE' });
  assert.notEqual(f.saved.get(KEY).active, null);
  assert.deepEqual(f.calls, []);
  f.advance(5000); await f.manager.tick();
  assert.equal(f.saved.get(KEY).active, null);
  assert.equal(f.device.readings.active.value, 1);
  assert.deepEqual(f.calls, []);
});

test('outer commit failure rolls back the in-memory equipment obligation and cannot dispatch restoration', async t => {
  const f = storageFixture(t), exec = f.store.db.exec.bind(f.store.db);
  f.store.db.exec = sql => {
    if (sql === 'COMMIT') throw new Error('synthetic commit failure');
    return exec(sql);
  };
  try { await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_STORAGE' }); }
  finally { f.store.db.exec = exec; }
  assert.equal(f.store.getState(KEY), null);
  assert.equal(f.manager.status().active, null);
  await f.manager.tick();
  assert.deepEqual(f.calls, []);
  await f.manager.start(request());
  assert.deepEqual(f.calls.map(row => row.on), [true]);
});

test('shutdown fences both queued temporary tests and direct switch commands before dispatch', async t => {
  for (const operation of ['test', 'switch']) {
    const f = storageFixture(t);
    f.writer.exec('BEGIN IMMEDIATE');
    const outcome = (operation === 'test' ? f.manager.start(request())
      : f.manager.setSwitch({ deviceId: 'caravan', on: true })).catch(error => error);
    await delay(35);
    const closing = f.manager.close();
    f.writer.exec('ROLLBACK');
    assert.equal((await outcome).code, 'EQUIPMENT_TEST_CLOSED');
    await closing;
    assert.deepEqual(f.calls, []);
    assert.equal(f.manager.status().active, null);
  }
});

test('demotion cancels equipment writes under a permanent external lock without closing the shared Store', { timeout: 2000 }, async t => {
  for (const operation of ['test', 'switch']) {
    const f = storageFixture(t);
    f.writer.exec('BEGIN IMMEDIATE');
    const outcome = (operation === 'test' ? f.manager.start(request())
      : f.manager.setSwitch({ deviceId: 'caravan', on: true })).catch(error => error);
    await delay(35);
    assert.equal(f.store.writeQueueStatus().pending, 1);
    f.manager.beginShutdown({ restore: false });
    await f.manager.close({ restore: false });
    assert.equal((await outcome).code, 'EQUIPMENT_TEST_CLOSED');
    assert.equal(f.writer.isTransaction, true);
    assert.equal(f.store.writeQueueStatus().pending, 0);
    assert.equal(f.store.getState(KEY), null);
    assert.deepEqual(f.calls, []);
    f.writer.exec('ROLLBACK');
    await f.store.runWrite(() => f.store.setState('next-runtime', true));
    assert.equal(f.store.getState('next-runtime'), true);
  }
});

test('demotion cancels post-command bookkeeping while retaining its committed restoration obligation', { timeout: 2000 }, async t => {
  const f = storageFixture(t), setSwitch = f.equipment.setSwitch;
  f.equipment.setSwitch = async (...args) => {
    const result = await setSwitch(...args);
    f.writer.exec('BEGIN IMMEDIATE');
    return result;
  };
  const outcome = f.manager.start(request()).catch(error => error);
  await delay(35);
  assert.equal(f.store.writeQueueStatus().pending, 1);
  await f.manager.close({ restore: false });
  assert.equal((await outcome).code, 'EQUIPMENT_TEST_UNCONFIRMED');
  assert.equal(f.writer.isTransaction, true);
  assert.equal(f.store.writeQueueStatus().pending, 0);
  assert.equal(f.store.getState(KEY).active.status, 'starting');
  assert.deepEqual(f.calls.map(row => row.on), [true]);
});

test('restorative shutdown bounds a held-lock save and preserves the duty without closing shared storage', { timeout: 8000 }, async t => {
  const f = storageFixture(t);
  await f.manager.start(request());
  f.writer.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  await assert.rejects(f.manager.close(), { code: 'EQUIPMENT_TEST_RESTORE' });
  assert.ok(performance.now() - started < 6500);
  assert.equal(f.writer.isTransaction, true);
  assert.equal(f.store.writeQueueStatus().pending, 0);
  assert.notEqual(f.store.getState(KEY).active, null);
  assert.deepEqual(f.calls.map(row => row.on), [true, false]);
  await f.manager.close({ restore: false });
  f.writer.exec('ROLLBACK');
  await f.store.runWrite(() => f.store.setState('next-runtime', true));
  assert.equal(f.store.getState('next-runtime'), true);
});

test('shutdown restores and closes, while a failed close remains retryable for configuration reload', async t => {
  let fail = true;
  const f = fixture(t, { command: ({ on, device, now }) => {
    if (!on && fail) throw new Error('synthetic unavailable');
    device.readings.active = { value: Number(on), unit: 'state', stale: false, observedAt: now };
    return { confirmed: true };
  } });
  await f.manager.start(request());
  await assert.rejects(f.manager.close(), { code: 'EQUIPMENT_TEST_RESTORE' });
  assert.equal(f.manager.status().active.status, 'restoration-pending');
  fail = false; await f.manager.close();
  assert.equal(f.manager.status().active, null);
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_CLOSED' });
});

test('fresh independent restoration and independent changes to a no-op test are not overwritten', async t => {
  for (const originalOn of [false, true]) {
    const f = fixture(t, { on: originalOn });
    await f.manager.start(request(true));
    f.advance(1000);
    f.device.readings.active = { value: 0, unit: 'state', stale: false, observedAt: f.now };
    const result = await f.manager.restore();
    assert.equal(f.calls.length, 1);
    assert.equal(result.status, originalOn ? 'superseded' : 'restored');
  }
});

test('a failed obligation write prevents dispatch and public persisted results stay sanitized', async t => {
  const f = fixture(t);
  f.store.setState = () => { throw new Error('synthetic storage error'); };
  await assert.rejects(f.manager.start(request()), { code: 'EQUIPMENT_TEST_STORAGE' });
  assert.equal(f.calls.length, 0);
  const saved = new Map([[KEY, { version: 1, active: null, lastResult: {
    deviceId: 'caravan', status: 'restored', at: INITIAL, reason: 'synthetic-private-reason', signature: digest,
    secret: 'synthetic-private-payload', confirmed: true,
  } }]]);
  const clean = fixture(t, { saved }).manager.status();
  assert(!JSON.stringify(clean).includes('synthetic-private'));
  assert(!JSON.stringify(clean).includes(digest));
});
