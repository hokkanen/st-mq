import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage/store.js';
import { fixture, HOUR } from './helpers/charging-joint-fixture.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';
import { webRequestAllowed } from '../chart/web-access.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const automaticScope = view => ({ association: view.association, sessionId: view.request.sessionId,
  revision: view.request.revision, controlRevision: view.controls.revision });

test('Shelly Pause is admitted while an unchanged native reply waits behind its intent', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'stmq-pause-input-admission-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  const f = await fixture(t, { store });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await f.connect('charger2');
  await f.runtime.chargeNow('charger2', f.scope('charger2')); await f.settle();
  const item = f.runtime.chargers.charger2, adapter = item.adapter, scope = f.scope('charger2');
  await store.runWrite(() => {}); await store.startWriter();
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const request = store.writer.request.bind(store.writer);
  let intercepted = false, nativeRead, pause;
  store.writer.request = async (operation, args) => {
    if (operation === 'begin' && !intercepted) { intercepted = true; entered(); await gate; }
    return request(operation, args);
  };
  const barrier = store.runWrite(() => {});
  let intentSavedDuringHold = false, prematureStop = false, originalReadAdmitted = false;
  const commandsBefore = f.commands.length;
  const remove = store.onWriteSettled(() => {
    if (!originalReadAdmitted && item.request.pause
      && adapter.snapshot().commandBlockReason === 'evse-input-persistence-pending') {
      intentSavedDuringHold = true;
      prematureStop ||= f.commands.slice(commandsBefore).some(command => command.chargerId === 'charger2'
        && command.role === 'start_charging' && command.value === false);
    }
  });
  try {
    await began;
    nativeRead = adapter.rpc('Service.GetStatus', { id: 0 });
    void nativeRead.then(() => { originalReadAdmitted = true; }, () => {});
    void nativeRead.catch(() => {});
    for (let attempt = 0; adapter.snapshot().commandBlockReason !== 'evse-input-persistence-pending' && attempt < 50; attempt++)
      await new Promise(resolve => setImmediate(resolve));
    assert.equal(adapter.snapshot().commandBlockReason, 'evse-input-persistence-pending');
    assert.equal(adapter.snapshot().observationReady, true, 'Committed session observations remain healthy');
    assert.equal(adapter.snapshot().controlReady, false, 'Native command publication is still held');
    pause = f.runtime.pause('charger2', scope); void pause.catch(() => {});
    release();
    await pause; await nativeRead; await barrier; await f.settle();
    assert.equal(intentSavedDuringHold, true, 'The control turn can save intent before the waiting reply is admitted');
    assert.equal(prematureStop, false, 'Saved intent cannot bypass native input admission');
    assert.equal(f.view('charger2').control.sessionPause.confirmed, true);
    assert.equal(f.view('charger2').values.powerKw.value, 0);
  } finally {
    release(); remove();
    await Promise.allSettled([barrier, nativeRead, pause].filter(Boolean));
  }
});

for (const id of ['charger1', 'charger2']) {
  test(`${id}: Pause persists independently of Automatic, Charge now and ready-by`, async t => {
    const f = await fixture(t);
    await f.connect(id);
    await f.runtime.chargeNow(id, f.scope(id)); await f.settle();
    const before = f.view(id), stale = f.scope(id);
    assert.equal(before.request.chargeNow, true);
    assert.equal(before.control.sessionPause.available, true);
    await f.runtime.pause(id, stale); await f.settle();
    const paused = f.view(id), requestedAt = paused.request.pause.requestedAt;
    assert.equal(paused.controls.enabled, before.controls.enabled);
    assert.equal(paused.request.chargeNow, undefined);
    assert.equal(paused.request.chargeNowAt, undefined);
    assert.equal(paused.control.sessionPause.active, true);
    assert.equal(paused.control.sessionPause.confirmed, true);
    assert.equal(paused.values.powerKw.value, 0);
    assert.deepEqual(paused.request.overrides, before.request.overrides);
    assert.equal(paused.request.deadlineAt, before.request.deadlineAt);
    assert.equal(paused.identification.available, false);
    await assert.rejects(f.runtime.chargeNow(id, stale), /connection changed/);
    for (const enabled of [true, false]) {
      await f.automatic(id, enabled); await f.settle();
      assert.equal(f.view(id).request.pause.requestedAt, requestedAt);
      assert.equal(f.view(id).control.sessionPause.confirmed, true);
    }
    f.advance(49 * HOUR); await f.settle();
    assert.equal(f.view(id).request.pause.requestedAt, requestedAt, 'No deadline or finite economic expiry releases the hold');
    assert.equal(f.view(id).values.powerKw.value, 0);
    await f.restart();
    assert.equal(f.view(id).request.pause.requestedAt, requestedAt);
    assert.equal(f.view(id).control.sessionPause.confirmed, true);
    await f.runtime.chargeNow(id, f.scope(id)); await f.settle();
    assert.equal(f.view(id).request.pause, undefined);
    assert.equal(f.view(id).request.chargeNow, true);
    assert.equal(f.view(id).controls.enabled, false);
    assert.ok(f.view(id).values.powerKw.value > 0);
  });

  test(`${id}: Use automatic ends only the current app pause and preserves a waiting price plan`, async t => {
    const f = await fixture(t);
    await f.connect(id); await f.edit(id, { capacityKwh: 10, readyBy: '05:00' });
    await f.automatic(id, true); await f.plan();
    const before = f.view(id);
    assert.ok(before.plan.periods[0].startAt > f.now, 'The Helsinki ready-by includes the later cheap UTC hours');
    await f.runtime.pause(id, f.scope(id)); await f.settle();
    assert.equal(f.view(id).control.sessionPause.confirmed, true);
    const commands = f.commands.length;
    await f.runtime.useAutomatic(id, automaticScope(f.view(id))); await f.settle();
    assert.equal(f.view(id).request.pause, undefined);
    assert.equal(f.view(id).controls.enabled, true);
    assert.equal(f.view(id).request.chargeNow, undefined);
    assert.equal(f.view(id).values.powerKw.value, 0);
    const sent = f.commands.slice(commands).filter(command => command.chargerId === id);
    assert.equal(sent.some(command => command.method === 'ClearChargingProfile'
      || command.role === 'start_charging' && command.value === true), false, 'Returning to a future period must never briefly Start');
  });

  test(`${id}: confirmed unplug ends pause without turning Automatic on`, async t => {
    const f = await fixture(t);
    await f.connect(id); await f.runtime.pause(id, f.scope(id)); await f.settle();
    const old = f.scope(id);
    await f.disconnect(id); await f.connect(id);
    assert.equal(f.view(id).request.pause, undefined);
    assert.equal(f.view(id).controls.enabled, false);
    assert.notEqual(f.view(id).request.sessionId, old.sessionId);
    await assert.rejects(f.runtime.pause(id, old), /connection changed/);
  });

  test(`${id}: failed pause persistence restores intent and dispatches nothing`, async t => {
    const f = await fixture(t);
    await f.connect(id); await f.runtime.chargeNow(id, f.scope(id)); await f.settle();
    const before = structuredClone(f.view(id).request), commands = f.commands.length;
    const persist = f.runtime.persist;
    f.runtime.persist = () => { throw new Error('Synthetic write rejection'); };
    await assert.rejects(f.runtime.pause(id, f.scope(id)), /Synthetic write rejection/);
    f.runtime.persist = persist;
    assert.deepEqual(f.view(id).request, before);
    assert.equal(f.commands.length, commands);
    assert.deepEqual(readChargingRuntime(f.store, f.runtime.key).chargers[id].request, before);
  });
}

test('paused request frees planned service while the other charger continues', async t => {
  const f = await fixture(t, { budgetA: 16 });
  await f.connect('charger1'); await f.connect('charger2');
  await f.runtime.chargeNow('charger1', f.scope('charger1'));
  await f.runtime.chargeNow('charger2', f.scope('charger2')); await f.settle();
  await f.runtime.pause('charger1', f.scope('charger1')); await f.plan();
  assert.equal(f.view('charger1').plan.reason, 'session-pause');
  assert.deepEqual(f.view('charger1').plan.periods, []);
  assert.equal(f.view('charger1').values.powerKw.value, 0);
  assert.equal(f.view('charger2').request.chargeNow, true);
  assert.ok(f.view('charger2').values.powerKw.value > 0);
});

test('family pause uses the shared supported route without granting arbitrary charging actions', () => {
  const path = '/api/charging/chargers/charger1/pause';
  assert.equal(familyRouteAllowed('POST', path), true);
  assert.equal(webRequestAllowed({ role: 'family' }, path, {}), true);
  assert.equal(familyRouteAllowed('POST', `${path}-forever`), false);
});

test('only a later original Stop or the exact OCPP same-second receipt clears Charge now', () => {
  const chosenAt = 10_500, connectedAt = 1000, now = 20_000;
  for (const [stop, clears] of [
    [{ at: 9000, receivedAt: 19_000 }, false],
    [{ at: 10_000, receivedAt: 10_400 }, false],
    [{ at: 10_000, receivedAt: 10_600 }, true],
    [{ at: 11_000, receivedAt: 11_500 }, true],
    [{ at: 10_000, receivedAt: 21_000 }, false],
  ]) {
    const runtime = { revision: 3 }, item = { request: { scope: `synthetic:${connectedAt}`,
      revision: 2, chargeNow: true, chargeNowAt: chosenAt }, plan: { state: 'charging-now' } };
    const control = { session: { connectedAt }, externalStopAt: stop.at,
      externalStop: { transactionId: 1, reason: 'Remote', ...stop } };
    ChargingRuntime.prototype.admitSessionSupersession.call(runtime, item, control, now);
    assert.equal(item.request.chargeNow === undefined, clears, JSON.stringify(stop));
    assert.equal(item.request.chargeNowAt === undefined, clears);
    assert.equal(item.request.revision, clears ? 3 : 2);
  }
  const runtime = { revision: 3 }, item = { request: { scope: `synthetic:${connectedAt}`,
    revision: 2, chargeNow: true, chargeNowAt: chosenAt } };
  ChargingRuntime.prototype.admitSessionSupersession.call(runtime, item,
    { session: { connectedAt }, externalStopAt: 10_000 }, now);
  assert.equal(item.request.chargeNow, true, 'Cloud source clocks cannot borrow the OCPP receipt tie-break');
});
