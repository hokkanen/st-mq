import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { shellyProfile } from '../src/charging/shelly-profile.js';
import { createShellyController } from '../src/charging/shelly-evse.js';

const NOW = 1_800_000_000_000;
function fixture(t, overrides = {}) {
  const config = shellyProfile(chargingConfiguration({ chargers: { charger2: { enabled: true, limiterEnabled: true,
    deviceId: 'synthetic-shelly', topicPrefix: 'synthetic/shelly', ...overrides } } }).chargers.charger2);
  const f = { now: NOW, permitted: true, online: true, controlReady: true, nativeScheduleActive: false,
    request: { id: 'synthetic-identification', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 },
    session: { sessionId: 'synthetic-session', connected: true, connectedAt: NOW, lastDisconnectedAt: null },
    fields: {}, saved: null, writes: [], saveHook: null, beforePublish: null, afterPublish: null, failRead: false,
    physicalPause: true };
  const field = value => ({ value, measuredAt: NOW, receivedAt: NOW, retained: false });
  f.fields = { start_charging: field(true), current_limit: field(12), work_state: field('charger_charging'),
    phase_info: field({ total_power: 8.28, phase_a: { current: 12 }, phase_b: { current: 12 }, phase_c: { current: 12 } }) };
  f.change = (role, value) => { f.fields[role] = { ...field(structuredClone(value)), measuredAt: f.now, receivedAt: f.now }; };
  f.snapshot = () => ({ association: 'synthetic-shelly', transport: 'shelly-evse', online: f.online,
    controlReady: f.controlReady, currentControlReady: f.controlReady, identificationCurrentReady: f.identificationCurrentReady !== false && f.controlReady, nativeScheduleFingerprint: f.nativeScheduleActive ? 'synthetic-schedule' : null, identificationReady: f.online && f.controlReady, nativeScheduleActive: f.nativeScheduleActive,
    fields: structuredClone(f.fields), session: structuredClone(f.session), readAt: f.now,
    pluggedIn: f.session.connected, charging: f.fields.work_state.value === 'charger_charging',
    statusAt: f.fields.work_state.measuredAt, powerKw: f.fields.phase_info.value.total_power,
    powerAt: f.fields.phase_info.measuredAt });
  f.adapter = { association: 'synthetic-shelly', config, snapshot: f.snapshot,
    async refresh() {
      if (f.failRead) { f.failRead = false; throw Error('synthetic read failure'); }
      for (const value of Object.values(f.fields)) value.receivedAt = f.now;
      f.fields.phase_info.measuredAt = f.now;
    },
    liveCurrents: () => ({ healthy: f.online, currents: [0, 1, 2].map(index => f.fields.phase_info.value[`phase_${'abc'[index]}`].current),
      times: Array(3).fill(f.fields.phase_info.measuredAt) }),
    async rpc(method, params, options) {
      if (!f.permitted || !options.guard()) throw Object.assign(Error('revoked'), { code: 'evse-command-revoked' });
      await f.beforePublish?.(method, params);
      await options.beforePublish?.();
      if (!f.permitted || !options.guard()) throw Object.assign(Error('revoked'), { code: 'evse-command-revoked' });
      if (f.saved?.pending?.owned) {
        assert.equal(f.saved.pending.stage, 'dispatched');
        assert.equal(typeof f.saved.pending.owned.witnessedCharging, 'boolean');
      }
      f.writes.push({ method, ...params }); f.now++;
      f.change(params.role, params.value);
      if (params.role === 'start_charging' && f.physicalPause) {
        f.change('work_state', params.value ? 'charger_charging' : 'charger_pause');
        f.change('phase_info', { total_power: params.value ? 8.28 : 0,
          ...Object.fromEntries(['a', 'b', 'c'].map(key => [`phase_${key}`, { current: params.value ? 12 : 0 }])) });
      }
      await f.afterPublish?.(method, params);
    } };
  f.restart = () => {
    f.controller?.close();
    f.controller = createShellyController({ adapter: f.adapter, initialState: f.saved, clock: () => f.now,
      canControl: () => f.permitted, getIdentification: () => f.request,
      saveState: async value => { await f.saveHook?.(value); f.saved = structuredClone(value); } });
  };
  f.restart(); t.after(() => f.controller.close());
  f.update = input => f.controller.update({ enabled: false, allocation: {}, ...input });
  return f;
}

test('Shelly identification persists witnessed pause ownership before dispatch and requires physical zero readback', async t => {
  const f = fixture(t); f.physicalPause = false;
  f.beforePublish = () => {
    assert.equal(f.saved.pending.owned.purpose, 'identification');
    assert.equal(f.saved.pending.stage, 'proposed');
    assert.equal(f.saved.owned, undefined);
  };
  let view = await f.update();
  assert.equal(view.owned.witnessedCharging, true); assert.equal(view.ownsInstruction, true);
  assert.equal(view.pauseConfirmed, false); assert.equal(view.nativeExpiry, false);
  f.now += 1000; f.change('work_state', 'charger_pause');
  f.change('phase_info', { total_power: 0, phase_a: { current: 0 }, phase_b: { current: 0 }, phase_c: { current: 0 } });
  view = await f.update();
  assert.equal(view.pauseConfirmed, true); assert.equal(f.writes.length, 1);
  assert.equal(view.owned.permissionAt, NOW + 1);
});

test('Shelly witnessed-pause persistence failure prevents publication and leaves no claimed ownership', async t => {
  const f = fixture(t);
  f.saveHook = state => { if (state.pending?.owned?.witnessedCharging) throw Error('synthetic storage failure'); };
  const view = await f.update();
  assert.equal(f.writes.length, 0); assert.equal(view.owned, null);
  assert.equal(f.saved.pending.owned.witnessedCharging, false);
  assert.equal(f.saved.pending.stage, 'proposed');
  f.saveHook = null; f.restart();
  const recovered = await f.update();
  assert.equal(f.writes.length, 1); assert.equal(recovered.owned.witnessedCharging, true);
  assert.equal(recovered.manual, null, 'An unsent proposal recovers without explicit Resume');
});

test('Shelly identification rejects a natural stop or stale power while the command is queued', async t => {
  for (const condition of ['stopped', 'stale-power']) {
    const f = fixture(t);
    f.beforePublish = () => {
      if (condition === 'stopped') { f.now++; f.change('work_state', 'charger_pause'); }
      else f.fields.phase_info.measuredAt = NOW - f.adapter.config.maxAgeMs - 1;
    };
    const view = await f.update();
    assert.equal(f.writes.length, 0); assert.equal(view.owned, null);
    assert.equal(view.pending.stage, 'proposed', 'An unsent stop is never recovered as a dispatched command');
  }
});

test('Shelly same-value native Stop preserves priority across identification timeout and restart', async t => {
  const f = fixture(t); await f.update();
  f.now += 2000; f.change('start_charging', false);
  f.request = null; f.restart();
  const view = await f.update();
  assert.equal(view.manual.kind, 'stop'); assert.equal(view.ownsInstruction, false);
  assert.equal(view.pauseConfirmed, false); assert.equal(f.writes.length, 1);
  assert.equal(view.owned.purpose, 'identification', 'The outstanding obligation remains visible');
});

test('Shelly a native Stop arriving during resume persistence revokes the queued start', async t => {
  const f = fixture(t); await f.update(); f.request = null;
  f.saveHook = state => {
    if (state.pending?.role === 'start_charging' && state.pending.value === true && state.pending.stage === 'dispatched') {
      f.now++; f.change('start_charging', false);
    }
  };
  const view = await f.update();
  assert.equal(f.writes.length, 1); assert.equal(f.fields.start_charging.value, false);
  assert.equal(view.owned.purpose, 'identification');
});

test('Shelly expired identification restoration bypasses economic dwell but preserves limiter and vehicle restrictions', async t => {
  for (const block of [null, 'fuse', 'vehicle']) {
    const f = fixture(t); await f.update(); f.request = null;
    const input = block === 'fuse' ? { allocation: { allocationA: 0 }, enabled: true,
      plan: { periods: [{ startAt: NOW, endAt: null }] } }
      : block === 'vehicle' ? { allocation: { notBefore: NOW + 3600_000 } } : {};
    const view = await f.update(input);
    assert.equal(f.fields.start_charging.value, block === null);
    assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, block === null ? 1 : 0);
    assert.equal(view.owned !== null, block === 'vehicle', 'A limiter can adopt the pause, while a vehicle timer defers recovery');
  }
});

test('Shelly accepted-but-unread pause recovers after restart without replaying the stop', async t => {
  const f = fixture(t); f.afterPublish = () => { f.failRead = true; };
  let view = await f.update();
  assert.equal(view.pending.stage, 'accepted'); assert.equal(view.pending.owned.witnessedCharging, true);
  f.afterPublish = null; f.restart();
  view = await f.update();
  assert.equal(view.ownsInstruction, true); assert.equal(view.pauseConfirmed, true); assert.equal(f.writes.length, 1);
  f.now = NOW + 100_000; f.request = null;
  view = await f.update();
  assert.equal(view.owned, null); assert.equal(f.writes.length, 2);
});

test('Shelly a lost stop reply stays paused until an explicit automatic takeover', async t => {
  const f = fixture(t);
  f.afterPublish = () => { throw Object.assign(Error('lost reply'), { code: 'evse-command-unconfirmed' }); };
  let view = await f.update(); assert.equal(view.pending.stage, 'dispatched');
  f.afterPublish = null; f.request = null; f.now = NOW + 100_000; f.restart();
  view = await f.update();
  assert.equal(view.reason, 'identification-resume-required'); assert.equal(view.manual.kind, 'stop');
  assert.equal(view.owned.purpose, 'identification'); assert.equal(f.writes.length, 1);
  view = await f.update({ enabled: true });
  assert.equal(f.fields.start_charging.value, false); assert.equal(f.writes.length, 1);
  f.now++;
  view = await f.update({ enabled: true, takeover: f.controller.status().takeover.token,
    plan: { periods: [{ startAt: f.now + 3600_000, endAt: null }] } });
  assert.equal(view.takeover.state, 'confirmed');
  assert.equal(f.fields.start_charging.value, false); assert.equal(view.owned, null); assert.equal(view.manual, null);
  assert.equal(f.writes.length, 1);
});

test('Shelly identification never grants old-session restoration permission to a newly connected vehicle', async t => {
  const f = fixture(t); await f.update(); f.request = null;
  f.now += 2000; f.session = { ...f.session, sessionId: 'new-synthetic-session', connectedAt: f.now, lastDisconnectedAt: f.now - 1 };
  const view = await f.update();
  assert.equal(view.manual.kind, 'stop'); assert.equal(view.ownsInstruction, false); assert.equal(f.writes.length, 1);
  assert.equal(view.owned.sessionId, 'synthetic-session', 'The old obligation is inert and visible');
});

test('Shelly identification recovery validates its current ownership schema before mutation', async t => {
  const f = fixture(t); await f.update();
  for (const patch of [{ purpose: 'retired-purpose' }, { identificationConnectedAt: NOW + 100 }, { permissionAt: null },
    { witnessedCharging: 'yes' }, { obsolete: true }, { startAt: NOW + 10 * 60_000 }]) {
    const initialState = structuredClone(f.saved); Object.assign(initialState.owned, patch);
    assert.throws(() => createShellyController({ adapter: f.adapter, initialState }), /unsupported-shelly-ownership/);
  }
  assert.equal(f.writes.length, 1);
});

test('Shelly ignores its economic zero allocation during identification while fuse and vehicle ceilings remain binding', async t => {
  for (const blocked of [false, true]) {
    const f = fixture(t); f.request = null;
    await f.update({ enabled: true, plan: { periods: [{ startAt: NOW + 3600_000, endAt: null }] } });
    assert.equal(f.fields.start_charging.value, false);
    f.request = { id: 'synthetic-identification', connectedAt: NOW, phase: 'waiting' };
    const view = await f.update({ allocation: { allocationA: 0, ...(blocked ? { vehicleCurrentA: 0 } : {}) } });
    assert.equal(view.phase, 'identifying');
    assert.equal(f.fields.start_charging.value, !blocked);
    assert.equal(view.limiter.currentA > 0, !blocked);
  }
});

test('Shelly a manual Stop between acknowledgement and readback is not attributed to the application', async t => {
  const f = fixture(t), refresh = f.adapter.refresh;
  f.adapter.refresh = async () => {
    if (f.saved?.pending?.stage === 'accepted' && f.saved.pending.owned) {
      f.now++; f.change('start_charging', false);
    }
    return refresh();
  };
  const view = await f.update();
  assert.equal(view.reason, 'identification-resume-required'); assert.equal(view.manual.kind, 'stop');
  assert.equal(view.ownsInstruction, false); assert.equal(view.pauseConfirmed, false);
  assert.equal(view.pending.stage, 'accepted'); assert.equal(view.owned.confirmedAt, null);
  assert.equal(f.writes.length, 1);
});

test('Shelly identification dispatch and restoration remain fenced by controller authority', async t => {
  const f = fixture(t); await f.update(); f.request = null; f.permitted = false;
  let view = await f.update();
  assert.equal(f.writes.length, 1); assert.equal(view.owned.purpose, 'identification');
  f.permitted = true;
  view = await f.update();
  assert.equal(f.writes.length, 2); assert.equal(view.owned, null);
});

const probe = (phase = 'charging') => ({ id: 'synthetic-identification', connectedAt: NOW, phase, mode: 'probe',
  probeUntil: NOW + 120_000, returnStartAt: NOW + 3600_000,
  ...(phase === 'pausing' ? { pauseUntil: NOW + 90_000 } : {}) });

test('Shelly economic probe uses the existing current limit and returns to economic waiting', async t => {
  const f = fixture(t); f.request = null;
  const economic = { enabled: true, plan: { periods: [{ startAt: NOW + 3600_000, endAt: null }] } };
  await f.update(economic);
  assert.equal(f.fields.start_charging.value, false);
  f.writes.length = 0; f.request = probe();
  let view = await f.update(economic);
  assert.equal(view.phase, 'identifying'); assert.equal(view.nativeExpiry, false);
  assert.equal(f.fields.current_limit.value, 12);
  assert.deepEqual(f.writes.map(call => [call.role, call.value]), [['start_charging', true]]);
  f.request = probe('pausing');
  view = await f.update(economic);
  assert.equal(view.pauseConfirmed, true); assert.equal(view.owned.witnessedCharging, true);
  const starts = f.writes.filter(call => call.role === 'start_charging' && call.value === true).length;
  f.request = null;
  view = await f.update(economic);
  assert.equal(view.phase, 'waiting'); assert.equal(view.owned, null);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.filter(call => call.role === 'start_charging' && call.value === true).length, starts);
});

test('Shelly probe retains tighter fuse, native and vehicle restrictions', async t => {
  for (const block of ['vehicle', 'native', 'manual']) {
    const f = fixture(t); f.request = probe();
    if (block === 'native') f.nativeScheduleActive = true;
    if (block === 'manual') f.change('start_charging', false);
    const view = await f.update(block === 'vehicle' ? { allocation: { vehicleCurrentA: 0 } } : {});
    assert.equal(f.writes.some(call => call.role === 'start_charging' && call.value === true), false);
    if (block === 'vehicle') assert.equal(f.fields.start_charging.value, false);
    else assert.equal(view.identification, null);
  }
});

test('Shelly budget stop revokes charging permission even without a physical charging baseline', async t => {
  for (const situation of ['never-started', 'stale-power']) {
    const f = fixture(t); f.request = probe('pausing');
    if (situation === 'never-started') {
      f.change('work_state', 'charger_pause');
      f.change('phase_info', { total_power: 0, phase_a: { current: 0 }, phase_b: { current: 0 }, phase_c: { current: 0 } });
    } else f.beforePublish = () => { f.fields.phase_info.measuredAt = NOW - f.adapter.config.maxAgeMs - 1; };
    const view = await f.update();
    assert.equal(f.fields.start_charging.value, false);
    assert.equal(view.owned.witnessedCharging, false); assert.equal(view.pauseConfirmed, false);
    assert.equal(f.writes.filter(call => call.role === 'start_charging' && call.value === false).length, 1);
  }
});

test('Shelly restored or queued probes never start after the fixed deadline', async t => {
  const f = fixture(t); f.request = null;
  await f.update({ enabled: true, plan: { periods: [{ startAt: NOW + 3600_000, endAt: null }] } });
  f.request = probe();
  f.beforePublish = (_method, params) => { if (params.role === 'start_charging') f.now = NOW + 120_000; };
  let view = await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.some(call => call.role === 'start_charging' && call.value === true), false);
  f.beforePublish = null; f.restart();
  view = await f.update();
  assert.equal(view.nativeExpiry, false); assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.some(call => call.role === 'start_charging' && call.value === true), false);
});

test('Shelly stops an already drawing probe when a current RPC crosses its deadline', async t => {
  const f = fixture(t); f.request = probe(); f.change('current_limit', 32);
  f.afterPublish = (_method, params) => { if (params.role === 'current_limit') f.now = NOW + 120_000; };
  await f.update();
  assert.deepEqual(f.writes.map(call => [call.role, call.value]), [['current_limit', f.fields.current_limit.value], ['start_charging', false]]);
  assert.equal(f.fields.start_charging.value, false);
});


test('Shelly minimum-current identification has a fixed saved deadline independent of the economic limiter', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'minimum-current-test', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  f.beforePublish = (_method, params) => {
    if (params.role !== 'current_limit') return;
    assert.equal(f.saved.currentTest.pending.value, params.value);
    assert.equal(f.saved.currentTest.originalCurrentA, 12);
    assert.equal(f.saved.currentTest.expiresAt, NOW + 90_000);
  };
  let view = await f.update();
  assert.equal(view.currentTest.phase, 'active'); assert.equal(f.fields.current_limit.value, 6);
  assert.equal(view.currentTest.confirmedAt, NOW + 1);
  assert.equal(f.adapter.config.limiterEnabled, false);
  f.now += 20_000; f.restart(); view = await f.update();
  assert.equal(view.currentTest.phase, 'active'); assert.equal(view.currentTest.expiresAt, NOW + 90_000);
  assert.equal(f.writes.length, 1);
  f.now = NOW + 90_001; view = await f.update();
  assert.equal(view.currentTest.phase, 'restored'); assert.equal(f.fields.current_limit.value, 12);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['current_limit', 12]]);
  f.now += 10_000; f.restart(); view = await f.update();
  assert.equal(view.currentTest.phase, 'restored'); assert.equal(f.writes.length, 2, 'The same id cannot renew the test');
});

test('Shelly minimum-current test permits positive vehicle demand below the pilot minimum but preserves zero', async t => {
  for (const vehicleCurrentA of [0, 1, 5]) await t.test(`${vehicleCurrentA} A vehicle setting`, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'low-vehicle-demand', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    const view = await f.update({ allocation: { vehicleCurrentA } });
    const currentWrites = f.writes.filter(row => row.role === 'current_limit');
    if (vehicleCurrentA === 0) {
      assert.equal(currentWrites.length, 0, 'A known zero vehicle restriction cannot authorize the test');
      assert.equal(f.fields.start_charging.value, false);
    } else {
      assert.equal(view.currentTest.phase, 'active');
      assert.deepEqual(currentWrites.map(row => row.value), [6], 'The offered pilot remains a supported native value');
      assert.equal(view.currentTest.expiresAt, NOW + 90_000, 'Lower accepted draw does not expand the test budget');
    }
  });
});

test('Shelly a verified minimum already in place needs no numeric write and ends before the BMW pause', async t => {
  const f = fixture(t, { limiterEnabled: false }); f.change('current_limit', 6);
  f.request = { id: 'already-minimum', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  let view = await f.update();
  assert.equal(view.currentTest.phase, 'active'); assert.equal(view.currentTest.confirmedAt, NOW);
  assert.equal(f.writes.length, 0);
  f.now += 15_000; f.request = { ...f.request, phase: 'pausing', pauseUntil: f.now + 90_000 };
  view = await f.update();
  assert.equal(view.currentTest.phase, 'restored');
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['start_charging', false]]);
});

test('Shelly BMW pause holds the reduced current through stop latency and restart before restoring and resuming', async t => {
  for (const choice of ['automatic', 'charge-now', 'automatic-off']) await t.test(choice, async t => {
    const f = fixture(t, { limiterEnabled: false });
    const input = { enabled: choice !== 'automatic-off',
      ...(choice === 'charge-now' ? { chargeNow: { connectedAt: NOW } } : {}) };
    f.request = { id: 'minimum-to-bmw-pause', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    await f.update(input);
    const expiresAt = f.saved.currentTest.expiresAt;
    f.now += 20_000;
    const pauseUntil = f.now + 90_000;
    f.request = { ...f.request, phase: 'pausing', pauseUntil };
    f.physicalPause = false;
    let view = await f.update(input);
    assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['start_charging', false]],
      'The correlation stop must precede restoration of the higher current');
    assert.equal(view.currentTest.phase, 'active');
    assert.equal(f.fields.current_limit.value, 6);
    assert.equal(view.pauseConfirmed, false);
    f.now = expiresAt + 1; f.restart(); view = await f.update(input);
    assert.equal(f.fields.current_limit.value, 6, 'Expiry cannot raise the pilot while the stopped car still draws power');
    assert.equal(view.currentTest.expiresAt, expiresAt);
    assert.equal(view.owned.startAt, pauseUntil);
    assert.equal(f.writes.length, 2);
    f.now += 1000; f.change('work_state', 'charger_pause');
    f.change('phase_info', { total_power: 0, phase_a: { current: 0 }, phase_b: { current: 0 }, phase_c: { current: 0 } });
    view = await f.update(input);
    assert.equal(view.currentTest.phase, 'restored');
    assert.equal(f.fields.current_limit.value, 12);
    assert.equal(f.fields.start_charging.value, false, 'Current restoration must preserve the owned BMW pause');
    assert.equal(view.pauseConfirmed, true);
    assert.equal(view.owned.startAt, pauseUntil);
    f.request = null; f.physicalPause = true; view = await f.update(input);
    assert.equal(view.owned, null);
    assert.deepEqual(f.writes.map(row => [row.role, row.value]),
      [['current_limit', 6], ['start_charging', false], ['current_limit', 12], ['start_charging', true]]);
  });
});

test('Shelly an unsent BMW pause preserves reduced current across a restart at current-test expiry', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'pending-bmw-pause', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  await f.update(); const expiresAt = f.saved.currentTest.expiresAt;
  f.now += 20_000; f.request = { ...f.request, phase: 'pausing', pauseUntil: f.now + 90_000 };
  f.saveHook = state => { if (state.pending?.owned?.witnessedCharging) throw Error('synthetic pause persistence failure'); };
  await f.update();
  assert.equal(f.saved.pending.stage, 'proposed');
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6]]);
  f.saveHook = null; f.physicalPause = false; f.now = expiresAt + 1; f.restart();
  const view = await f.update();
  assert.equal(view.currentTest.expiresAt, expiresAt);
  assert.equal(f.fields.current_limit.value, 6);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['start_charging', false]]);
});

test('Shelly native Stop during the reduced-current BMW pause retains priority through both deadlines', async t => {
  const f = fixture(t, { limiterEnabled: false });
  const input = { enabled: true, chargeNow: { connectedAt: NOW } };
  f.request = { id: 'native-stop-during-bmw-pause', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  await f.update(input);
  const expiresAt = f.saved.currentTest.expiresAt;
  f.now += 20_000; const pauseUntil = f.now + 90_000;
  f.request = { ...f.request, phase: 'pausing', pauseUntil }; f.physicalPause = false;
  await f.update(input);
  f.now += 1000; f.change('start_charging', false); f.fields.start_charging.commandSource = 'rpc'; f.request = null;
  let view = await f.update(input);
  assert.equal(view.manual.kind, 'stop'); assert.equal(f.fields.current_limit.value, 6);
  f.now = expiresAt + 1; f.restart(); view = await f.update(input);
  assert.equal(view.manual.kind, 'stop'); assert.equal(f.fields.current_limit.value, 6);
  f.now += 1000; f.change('work_state', 'charger_pause');
  f.change('phase_info', { total_power: 0, phase_a: { current: 0 }, phase_b: { current: 0 }, phase_c: { current: 0 } });
  view = await f.update(input);
  assert.equal(view.currentTest.phase, 'restored'); assert.equal(f.fields.current_limit.value, 12);
  f.now = pauseUntil + 1; view = await f.update(input);
  assert.equal(view.manual.kind, 'stop'); assert.equal(f.fields.start_charging.value, false);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]),
    [['current_limit', 6], ['start_charging', false], ['current_limit', 12]]);
});

test('Shelly BMW pause current guard preserves native Enable, current selection and uncertain Stop fences', async t => {
  for (const change of ['enable', 'current', 'lost-stop-reply']) await t.test(change, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'bmw-pause-fences', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    await f.update(); f.now += 20_000;
    f.request = { ...f.request, phase: 'pausing', pauseUntil: f.now + 90_000 }; f.physicalPause = false;
    if (change === 'lost-stop-reply') f.afterPublish = () => {
      throw Object.assign(Error('synthetic lost Stop reply'), { code: 'evse-command-unconfirmed' });
    };
    await f.update(); f.afterPublish = null; f.now += 1000; f.request = null;
    if (change === 'enable') { f.change('start_charging', true); f.fields.start_charging.commandSource = 'rpc'; }
    if (change === 'current') { f.change('current_limit', 8); f.fields.current_limit.commandSource = 'rpc'; }
    let view = await f.update();
    if (change === 'enable') {
      assert.equal(view.manual.kind, 'enable'); assert.equal(view.currentTest.phase, 'restored');
      assert.equal(f.fields.current_limit.value, 12); assert.equal(f.fields.start_charging.value, true);
    } else if (change === 'current') {
      assert.equal(view.currentTest.phase, 'superseded'); assert.equal(f.fields.current_limit.value, 8);
      assert.deepEqual(f.writes.filter(row => row.role === 'current_limit').map(row => row.value), [6]);
    } else {
      f.now = NOW + 95_000; f.restart(); view = await f.update();
      assert.equal(view.phase, 'uncertain'); assert.equal(f.fields.current_limit.value, 6);
      assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['start_charging', false]],
        'An uncertain Stop must not be replayed or raise the pilot');
    }
  });
});

test('Shelly identification current restoration survives cancellation, unplug and a new session without granting start', async t => {
  for (const ending of ['cancel', 'unplug', 'new-session']) await t.test(ending, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'current-scope', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    await f.update(); f.now += 1000; f.request = null;
    if (ending === 'unplug') { f.session.connected = false; f.session.sessionId = null; f.change('work_state', 'charger_free'); }
    if (ending === 'new-session') { f.session.sessionId = 'new-current-session'; f.session.connectedAt = f.now; }
    f.restart(); const view = await f.update();
    assert.equal(view.currentTest.phase, 'restored'); assert.equal(f.fields.current_limit.value, 12);
    assert.deepEqual(f.writes.map(row => row.role), ['current_limit', 'current_limit']);
  });
});

test('Shelly a new native current selection supersedes minimum-current restoration including equal values', async t => {
  for (const value of [6, 8]) await t.test(`${value} A`, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'current-native-change', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    await f.update(); f.now += 1000; f.change('current_limit', value);
    f.fields.current_limit.commandSource = 'rpc'; f.request = null;
    const view = await f.update();
    assert.equal(view.currentTest.phase, 'superseded'); assert.equal(f.fields.current_limit.value, value);
    assert.equal(f.writes.length, 1);
  });
});

test('Shelly system refresh preserves current-test ownership and automatic pause ownership', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'system-refresh', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  await f.update(); f.now += 1000;
  for (const role of ['current_limit', 'start_charging']) {
    f.change(role, f.fields[role].value); f.fields[role].commandSource = 'sys';
  }
  let view = await f.update();
  assert.equal(view.manual, null); assert.equal(view.currentTest.phase, 'active'); assert.equal(f.writes.length, 1);
  f.request = { ...f.request, phase: 'pausing', pauseUntil: f.now + 90_000 };
  await f.update(); f.now += 1000; f.change('start_charging', false); f.fields.start_charging.commandSource = 'sys';
  view = await f.update(); assert.equal(view.manual, null); assert.equal(view.ownsInstruction, true);
  f.restart(); view = await f.update(); assert.equal(view.manual, null); assert.equal(view.ownsInstruction, true);
});

test('Shelly minimum-current writes require verified capability and preserve native limits', async t => {
  for (const block of ['capability', 'below-minimum', 'authority', 'manual-stop', 'native-schedule']) await t.test(block, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'blocked-current-test', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    if (block === 'capability') f.identificationCurrentReady = false;
    if (block === 'below-minimum') f.change('current_limit', 0);
    if (block === 'authority') f.permitted = false;
    if (block === 'manual-stop') f.change('start_charging', false);
    if (block === 'native-schedule') f.nativeScheduleActive = true;
    await f.update(); assert.equal(f.writes.filter(row => row.role === 'current_limit').length, 0);
  });
});

test('Shelly a lost minimum-current reply remains uncertain across restart without repeating or restoring it', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'lost-current-reply', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  f.afterPublish = () => { throw Object.assign(Error('lost reply'), { code: 'evse-command-unconfirmed' }); };
  let view = await f.update(); assert.equal(view.currentTest.phase, 'uncertain'); assert.equal(f.writes.length, 1);
  f.afterPublish = null; f.request = null; f.now += 100_000; f.restart();
  view = await f.update(); assert.equal(view.currentTest.phase, 'uncertain'); assert.equal(f.writes.length, 1);
  f.now++; f.change('current_limit', 10); view = await f.update();
  assert.equal(view.currentTest.phase, 'superseded'); assert.equal(f.writes.length, 1);
});

test('Shelly accepted minimum-current readback recovers across restart and restores once', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'current-read-failure', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  f.afterPublish = () => { f.failRead = true; };
  let view = await f.update(); assert.equal(view.currentTest.phase, 'uncertain');
  assert.equal(f.saved.currentTest.pending.acceptedAt, NOW + 1);
  f.afterPublish = null; f.restart(); view = await f.update();
  assert.equal(view.currentTest.phase, 'active'); assert.equal(f.writes.length, 1);
  f.request = null; view = await f.update();
  assert.equal(view.currentTest.phase, 'restored'); assert.equal(f.writes.length, 2);
});

test('Shelly invalid current-test state is rejected without a device write', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'validate-current', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  await f.update(); const good = structuredClone(f.saved);
  for (const patch of [{ expiresAt: NOW + 91_000 }, { originalCurrentA: 5 }, { appliedCurrentA: 7 },
    { probeDeadlineAt: NOW }, { probeDeadlineAt: NOW + 80_001 }, { probeDeadlineAt: null }, { unknown: true }]) {
    const invalid = { ...good, currentTest: { ...good.currentTest, ...patch } };
    assert.throws(() => createShellyController({ adapter: f.adapter, initialState: invalid }), /unsupported-shelly-ownership/);
  }
  assert.equal(f.writes.length, 1);
});


test('Shelly current-test publication is revoked by expiry, external Stop, or changed native current', async t => {
  for (const change of ['deadline', 'stop', 'current', 'authority']) await t.test(change, async t => {
    const f = fixture(t, { limiterEnabled: false });
    f.request = { id: 'racing-current', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
    f.beforePublish = () => {
      if (change === 'deadline') f.now = NOW + 90_000;
      if (change === 'stop') { f.now++; f.change('start_charging', false); }
      if (change === 'current') { f.now++; f.change('current_limit', 8); }
      if (change === 'authority') f.permitted = false;
    };
    const view = await f.update();
    assert.equal(f.writes.length, 0);
    if (change === 'stop') { assert.equal(f.fields.start_charging.value, false); assert.equal(view.manual.kind, 'stop'); }
  });
});

test('Shelly minimum-current persistence failure sends no command', async t => {
  const f = fixture(t, { limiterEnabled: false });
  f.request = { id: 'unsaved-current', connectedAt: NOW, phase: 'charging', minimumCurrent: true };
  f.saveHook = state => { if (state.currentTest) throw Error('synthetic persistence failure'); };
  await assert.rejects(f.update(), /synthetic persistence failure/);
  assert.equal(f.writes.length, 0);
});
