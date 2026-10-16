import test from 'node:test';
import assert from 'node:assert/strict';
import { createEaseeScheduleAdapter } from '../src/charging/easee.js';
import { shellyCurrentLimit } from '../src/charging/shelly-limit.js';
import { fixture, MINUTE, HOUR } from './helpers/charging-joint-fixture.js';

// Real cloud schedule adapter/controller, runtime views/current allocation and
// Shelly limiter. Only native observations and supported HTTP replies are
// synthetic; a failed schedule dispatch never changes native permission.
async function sharingFixture(t, { budgetA = 24, gapMinutes = 16, initialWaitMinutes = 0, confirmPause = true } = {}) {
  const f = await fixture(t, { budgetA });
  await f.connect('charger1'); await f.connect('charger2');
  const source = f.runtime.chargers.charger1.adapter;
  let schedule = { enabled: 'none' }, paused = false, rejectDelay = false, nativeAt = f.now, futureSources = false;
  const native = { online: true, enabled: true, mode: 3, reason: 0 };
  const writes = [], installFailures = [], readDelays = [];
  let delayedNativeRead = null, installAttempts = 0;
  const supply = () => source.readCurrentSupply().supply;
  const adapter = createEaseeScheduleAdapter({ chargerId: 'synthetic-sharing-cloud', equalizerId: 'synthetic-sharing-equalizer',
    clock: () => f.now, canControl: () => true,
    request: async (url, options) => {
      const path = new URL(url).pathname;
      if (options.method === 'GET' && path.endsWith('/schedules')) return structuredClone(schedule);
      if (options.method === 'GET' && path.endsWith('/config')) return { maxAllocatedCurrent: budgetA };
      assert.equal(options.method, 'POST'); writes.push({ path, at: f.now });
      if (rejectDelay) throw Error('Synthetic uncertain transport failure');
      if (path.endsWith('/delayed')) {
        const { enabled, ...delayed } = JSON.parse(options.body);
        schedule = { enabled: enabled ? 'delayed' : 'none', delayed };
        paused = confirmPause; nativeAt = f.now;
        if (paused) f.cars.charger1.allows = false;
      } else { schedule = { enabled: 'none' }; paused = false; f.cars.charger1.allows = true; }
      return '';
    },
    readObservations: async id => {
      if (id === 'synthetic-sharing-cloud' && delayedNativeRead && --delayedNativeRead.remainingReads === 0) {
        const startedAt = f.now, delayMs = delayedNativeRead.delayMs;
        delayedNativeRead = null; f.advance(delayMs);
        readDelays.push({ startedAt, completedAt: f.now, delayMs });
      }
      const current = supply(), at = new Date(futureSources ? f.now + MINUTE : nativeAt).toISOString();
      const rows = id === 'synthetic-sharing-equalizer'
        ? [...current.propertyCurrentA.map((value, i) => [31 + i, value]), ...[34, 35, 36].map(id => [id, 230])]
        : [[250, native.online], [31, native.enabled], [109, paused ? 2 : native.mode], [96, paused ? 54 : native.reason], [100, paused ? 'B' : 'C'],
          [120, current.chargerCurrentA[0] * .69], [110, 30], [22, 16], [23, 16], [24, 16], [47, 16], [48, 16], [104, 16],
          ...current.chargerCurrentA.map((value, i) => [183 + i, value]), ...[230, 231, 232].map(id => [id, budgetA])];
      return rows.map(([id, value]) => ({ id, value, timestamp: at }));
    } });
  const installDelayed = adapter.installDelayed;
  adapter.installDelayed = async input => {
    installAttempts++;
    try { return await installDelayed(input); }
    catch (cause) { installFailures.push({ code: cause.code, notDispatched: cause.notDispatched === true }); throw cause; }
  };
  adapter.readCurrentSupply = source.readCurrentSupply;
  await f.runtime.setAdapter('charger1', adapter);
  await f.settle();
  const controller = f.runtime.chargers.charger1.controller, beginning = f.now + initialWaitMinutes * MINUTE;
  const plan = { id: 'synthetic-sharing-periods', feasible: true, deadlineAt: beginning + 2 * HOUR,
    startAt: beginning, periods: [{ startAt: beginning, endAt: beginning + 15 * MINUTE },
      { startAt: beginning + (15 + gapMinutes) * MINUTE, endAt: null }] };
  f.runtime.pricesInitialized = true;
  f.runtime.chargers.charger1.plan = plan;
  f.runtime.updatePlanForControl = async () => {};
  await controller.update({ enabled: true, plan, maximumAmps: 16, timezone: 'Europe/Helsinki' });
  const limit = () => {
    const context = f.runtime.allocationContext(), physical = f.runtime.chargers.charger2.adapter.snapshot().fields.phase_info;
    return shellyCurrentLimit({ config: f.runtime.chargers.charger2.adapter.config,
      ...context, now: f.now, nativeCurrentA: 16,
      shelly: { healthy: true, currents: ['phase_a', 'phase_b', 'phase_c'].map(key => physical.value[key].current),
        times: [physical.measuredAt, physical.measuredAt, physical.measuredAt] } });
  };
  return { f, controller, plan, limit, writes, installFailures, readDelays, get installAttempts() { return installAttempts; },
    rejectDelay(value) { rejectDelay = value; },
    delayPreflight(delayMs) { delayedNativeRead = { remainingReads: 2, delayMs }; },
    setNative(value) { Object.assign(native, value); nativeAt = f.now; },
    futureSources(value) { futureSources = value; },
    async update() {
      await controller.update({ enabled: true, plan, maximumAmps: 16, timezone: 'Europe/Helsinki' });
      await f.runtime.chargers.charger2.adapter.refresh();
    },
    async adjust() { await f.runtime.chargers.charger2.controller.update({ enabled: false }); },
  };
}

test('a planned cloud pause cannot release current entitlement before native pause confirmation', async t => {
  const x = await sharingFixture(t, {gapMinutes:11}), { f } = x;
  assert.equal(x.controller.status().phase, 'active');
  assert.equal(f.view('charger1').telemetry.currentSharingActive, true);
  const before = x.limit(); assert.equal(before.currentA, 12);
  await x.adjust(); assert.equal(f.fields.current_limit.value, 12);
  const request = structuredClone(f.view('charger1').request), execution = structuredClone(x.controller.status().execution);
  const nativeClocks = Object.fromEntries([31, 96, 100, 109, 120].map(id => [id, x.controller.status().snapshot.observations[id].at]));
  assert.equal(execution.periods[1].startAt - execution.periods[0].endAt, 11 * MINUTE,
    'The newly accepted synthetic program is representable before latency');
  f.advance(15 * MINUTE + 1000);
  x.delayPreflight(2 * MINUTE);
  await x.update();
  const state = x.controller.status();
  assert.deepEqual(x.installFailures, [{ code: 'start-passed', notDispatched: true }],
    'The actual adapter preflight, rather than a fictional invalid initial plan, reaches the known-unsent guard');
  assert.equal(x.readDelays.length, 1); assert.equal(x.readDelays[0].delayMs, 2 * MINUTE);
  assert.equal(x.installAttempts, 1, 'The known-unsent preparation is not replayed during the fresh reconciliation');
  assert.equal(state.pending, null, 'Only the positively unsent preparation is cleared');
  assert.equal(state.errorCode, 'invalid-plan', 'The single fresh reconciliation truthfully reports the now-short proposal');
  assert.equal(x.writes.length, 0, 'The too-short pause never reached the native scheduling endpoint');
  assert.equal(state.snapshot.mode, 3); assert.equal(state.snapshot.enabled, true); assert.equal(state.snapshot.stopped, false);
  assert.ok(state.snapshot.powerKw > 0);
  assert.deepEqual(Object.fromEntries(Object.keys(nativeClocks).map(id => [id, state.snapshot.observations[id].at])), nativeClocks,
    'Preflight latency does not renew the unchanged native instruction, mode or power clocks');
  assert.equal(f.view('charger1').telemetry.currentSharingActive, true,
    'An ended planned period does not prove that native charging permission was withdrawn');
  assert.equal(x.limit().currentA, before.currentA, 'The peer entitlement survives the unconfirmed pause');
  const commands = f.commands.length;
  await x.adjust(); assert.equal(f.fields.current_limit.value, 12);
  assert.equal(f.commands.slice(commands).some(row => row.role === 'start_charging'), false,
    'Maintaining current entitlement grants no new Start or Stop');
  assert.deepEqual(f.view('charger1').request, request); assert.deepEqual(state.execution, execution);
});

test('an unconfirmed cloud pause keeps entitlement through an Equalizer zero draw', async t => {
  const x = await sharingFixture(t, {confirmPause:false}), { f } = x;
  f.advance(16 * MINUTE + 1000);
  for (const draw of [0, 8, 16]) {
    f.cars.charger1.demandA = draw;
    x.setNative({ mode: draw === 0 ? 2 : 3, reason: draw === 0 ? 76 : 0 });
    await x.update();
    assert.equal(f.view('charger1').telemetry.currentSharingActive, true);
    assert.equal(x.limit().currentA, 12, 'Measured C1 draw never reallocates its pending request');
  }
});

test('an uncertain cloud dispatch keeps the current native entitlement', async t => {
  const x = await sharingFixture(t, { gapMinutes: 30 });
  x.f.advance(15 * MINUTE + 1000); x.rejectDelay(true); await x.update();
  assert.equal(x.writes.length, 1); assert.ok(x.controller.status().pending);
  assert.equal(x.controller.status().errorCode, 'command-failed');
  assert.equal(x.f.view('charger1').telemetry.currentSharingActive, true);
  assert.equal(x.limit().currentA, 12);
});

for (const confirmPause of [false, true]) test(`a cloud schedule readback ${confirmPause ? 'with' : 'without'} native waiting controls pause participation`, async t => {
  const x = await sharingFixture(t, { gapMinutes: 30, confirmPause });
  x.f.advance(15 * MINUTE + 1000); await x.update();
  assert.equal(x.writes.length, 1); assert.equal(x.controller.status().pending, null);
  assert.equal(x.controller.status().phase, confirmPause ? 'paused' : 'pause-unconfirmed');
  assert.equal(x.f.view('charger1').telemetry.currentSharingActive, !confirmPause);
  assert.equal(x.limit().currentA, confirmPause ? 16 : 12);
});

test('a confirmed initial future cloud wait does not acquire a current entitlement', async t => {
  const x = await sharingFixture(t, { initialWaitMinutes: 20 });
  assert.equal(x.controller.status().phase, 'waiting');
  assert.equal(x.controller.status().snapshot.reason, 54);
  assert.equal(x.f.view('charger1').telemetry.currentSharingActive, false);
  assert.equal(x.limit().currentA, 16);
});

for (const boundary of [
  { name: 'Stop', value: { enabled: false, reason: 53 } },
  { name: 'offline', value: { online: false } },
  { name: 'fault', value: { mode: 5, reason: 56 } },
  { name: 'authorization', value: { mode: 7, reason: 55 } },
  { name: 'unknown permission', value: { enabled: null } },
  { name: 'future source', value: null },
]) test(`native ${boundary.name} does not gain entitlement from an unconfirmed cloud pause`, async t => {
  const x = await sharingFixture(t);
  x.f.advance(15 * MINUTE + 1000);
  if (boundary.value) x.setNative(boundary.value); else x.futureSources(true);
  await x.update();
  assert.equal(x.f.view('charger1').telemetry.currentSharingActive, false);
});
