import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ownedPauseFixture } from './helpers/shelly-system-fixture.js';

test('an unknown command source inside the acknowledgement interval cannot borrow our Start', async t => {
  const f = await fixture(t, { startEcho: 'unknown source inside ACK interval', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().controller.status().ownsInstruction, false);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('clock evidence cannot replace a missing Start acknowledgement or authorize replay', async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563, startEcho: 'native clock boundary',
    startOutcome: 'no acknowledgement', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  const control = f.item().controller.status();
  assert.equal(control.pending?.stage, 'dispatched');
  assert.equal(control.ownsInstruction, false);
  assert.notEqual(control.manual?.origin, 'external-command', 'an unresolved own RPC cannot identify an external actor');
  await f.update();
  assert.notEqual(f.item().controller.status().manual?.origin, 'external-command');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('an own echo awaiting a post-ACK query remains pending instead of becoming manual priority', async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563, startEcho: 'native clock boundary', vehicleFeed: false });
  const snapshot = f.adapter.snapshot.bind(f.adapter);
  let premature = true;
  f.adapter.snapshot = () => {
    const value = snapshot(), ack = f.echoTrace[0]?.acknowledgedAt, field = value.fields.start_charging;
    if (premature && Number.isSafeInteger(ack) && field?.readback)
      field.readback.requestedAt = Math.min(field.readback.requestedAt, ack - 1);
    return value;
  };
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().pending.stage, 'accepted');
  assert(f.adapter.snapshot().permissionEvents.length > 0);
  premature = false; await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().pending, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const nativeClockOffsetMs of [-563, -980, 200])
test(`a scheduled Start crossing native seconds retains automatic ownership with observed clock offset ${nativeClockOffsetMs}`, async t => {
  const f = await fixture(t, { nativeClockOffsetMs, startEcho: 'native clock boundary', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  const control = f.item().controller.status(), echo = f.echoTrace[0];
  assert(echo, 'the real controller published a scheduled Start');
  assert.equal(echo.nativeAt, echo.dispatchedAt + nativeClockOffsetMs);
  assert.equal(control.manual, null, 'an acknowledged Start uses its observed native clock domain');
  assert.equal(control.pending, null);
  assert(control.permissionCommand.nativeClock, 'restart retains the original clock observation');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
  assert.equal(control.snapshot.fields.start_charging.measuredAt, Math.floor((echo.dispatchedAt + 100 + nativeClockOffsetMs) / 1000) * 1000);
  f.advance(2000);
  f.permission(false, 'rpc', { eventAt: f.now + nativeClockOffsetMs });
  await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'stop', 'a later independent Stop still takes priority');
  f.advance(500); f.permission(true, 'rpc', { eventAt: f.now + nativeClockOffsetMs });
  await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable', 'a later independent Enable also retains priority');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('a clock-boundary own Start followed by SYS off/on retains automatic recovery across restart', async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563,
    startEcho: 'native clock boundary with SYS interruption', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update(); await f.update();
  let control = f.item().controller.status();
  assert.equal(control.manual, null);
  assert.equal(control.pending, null);
  assert.notEqual(control.compatibility?.incident?.status, 'cancelled', 'an own echo cannot cancel SYS recovery as a manual override');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
  const proof = structuredClone(control.permissionCommand.nativeClock);
  await f.restart(); await f.update();
  control = f.item().controller.status();
  assert.equal(control.manual, null);
  assert.deepEqual(control.permissionCommand.nativeClock, proof);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'restart reconciles the acknowledged Start without replay');
});

test('queued acknowledgement processing preserves actual transport receipt and native command bounds', async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563, startEcho: 'native clock boundary',
    vehicleFeed: false, ackProcessingDelayMs: 2000 });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  const control = f.item().controller.status(), echo = f.echoTrace[0];
  assert.equal(control.manual, null);
  assert.equal(control.pending, null);
  assert.equal(control.permissionCommand.dispatchedAt, echo.dispatchedAt);
  assert.equal(control.permissionCommand.acceptedAt, echo.acknowledgedAt);
  assert(f.now - control.permissionCommand.acceptedAt >= 2000,
    'processing delay does not become a later ACK or a broader ownership window');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const nativeClockOffsetMs of [null, -563])
test(`a late notification clock does not become a new instruction when its queried setting clock still confirms our Start; offset ${nativeClockOffsetMs}`, async t => {
  const f = await fixture(t, { nativeClockOffsetMs, startEcho: 'late native notification', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  const control = f.item().controller.status(), echo = f.echoTrace[0];
  assert.equal(control.manual, null);
  assert.equal(control.pending, null);
  assert(echo.event.eventAt > echo.acknowledgedAt, 'the notification has a genuinely later publication clock');
  assert(control.snapshot.fields.start_charging.readback.requestedAt >= echo.receivedAt);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('SYS permission recovery can retry a scheduled clock-boundary Start without creating a manual Enable', async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563, startEcho: 'native clock boundary', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  f.advance(2000); f.permission(false, 'sys', { eventAt: f.now - 563 });
  await f.update();
  let control = f.item().controller.status();
  assert.equal(control.manual, null);
  assert.equal(control.compatibility.incident.status, 'waiting');
  f.advance(Math.max(0, control.compatibility.incident.nextAt - f.now));
  await f.update(); await f.update();
  control = f.item().controller.status();
  assert.equal(control.manual, null);
  assert.equal(control.pending, null);
  assert.equal(control.compatibility.incident.attempts, 1);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 2);
});

for (const externalStop of [false, true])
test(`a temporarily unavailable native clock retains the own echo ${externalStop ? 'without losing an independent Stop' : 'without inventing a manual instruction'}`, async t => {
  const f = await fixture(t, { nativeClockOffsetMs: -563,
    startEcho: 'native clock boundary without current clock', vehicleFeed: false });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().pending.stage, 'accepted');
  assert(f.adapter.snapshot().permissionEvents.length > 0, 'the unresolved event remains durable');
  if (externalStop) {
    f.advance(2000); f.permission(false, 'rpc', { eventAt: f.now - 563 });
    await f.update();
    assert.equal(f.item().controller.status().manual?.kind, 'stop');
  }
  f.setCommandClockAvailable(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind ?? null, externalStop ? 'stop' : null);
  if (!externalStop) assert.equal(f.item().controller.status().pending, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('a native-clock identification Stop retains its original source clock, confirmed duty and restart proof', async t => {
  const f = await ownedPauseFixture(t, { nativeClockOffsetMs: -563,
    startEcho: 'native clock boundary', stopEcho: 'native clock boundary' });
  const control = f.controller.status(), saved = f.savedState();
  assert.equal(control.manual, null);
  assert.equal(control.pauseConfirmed, true);
  assert(control.permissionCommand.nativeClock);
  const restored = f.adapter.createController({ initialState: saved, clock: () => f.now });
  t.after(() => restored.close());
  assert.equal(restored.status().owned.permissionAt, control.owned.permissionAt);
  assert.throws(() => f.adapter.createController({ initialState: { ...saved,
    owned: { ...saved.owned, permissionAt: saved.owned.permissionAt - 10_000 } } }), /unsupported-shelly-ownership/);
});

