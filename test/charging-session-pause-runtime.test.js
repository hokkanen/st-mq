import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, HOUR } from './helpers/charging-joint-fixture.js';
import { readChargingRuntime } from '../src/charging/runtime-storage.js';
import { familyRouteAllowed } from '../src/app/web-permissions.js';
import { webRequestAllowed } from '../chart/web-access.js';
import { ChargingRuntime } from '../src/charging/runtime.js';

const automaticScope = view => ({ association: view.association, sessionId: view.request.sessionId,
  revision: view.request.revision, controlRevision: view.controls.revision });

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
