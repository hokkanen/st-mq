import test from 'node:test';
import assert from 'node:assert/strict';
import { chargingConfiguration } from '../src/charging/config.js';
import { createShellyController } from '../src/charging/shelly-evse.js';

const NOW = 1_800_000_000_000;
function fixture(t) {
  const config = chargingConfiguration({ chargers: { charger2: { enabled: true, verified: true,
    deviceId: 'synthetic-shelly', topicPrefix: 'synthetic/shelly', model: 'synthetic-model', firmware: 'synthetic-firmware',
    connectedStates: ['connected', 'paused'], chargingStates: ['charging'], disconnectedStates: ['free'] } } }).chargers.charger2;
  const f = { now: NOW, permitted: true, online: true, controlReady: true, nativeScheduleActive: false,
    request: { id: 'synthetic-identification', connectedAt: NOW, phase: 'pausing', pauseUntil: NOW + 90_000 },
    session: { sessionId: 'synthetic-session', connected: true, connectedAt: NOW, lastDisconnectedAt: null },
    fields: {}, saved: null, writes: [], saveHook: null, beforePublish: null, afterPublish: null, failRead: false,
    physicalPause: true };
  const field = value => ({ value, measuredAt: NOW, receivedAt: NOW, retained: false });
  f.fields = { start_charging: field(true), current_limit: field(12), work_state: field('charging'),
    phase_info: field({ total_power: 8280, phase_a: { current: 12 }, phase_b: { current: 12 }, phase_c: { current: 12 } }) };
  f.change = (role, value) => { f.fields[role] = { ...field(structuredClone(value)), measuredAt: f.now, receivedAt: f.now }; };
  f.snapshot = () => ({ association: 'synthetic-shelly', transport: 'shelly-evse', online: f.online,
    controlReady: f.controlReady, identificationReady: f.online && f.controlReady, nativeScheduleActive: f.nativeScheduleActive,
    fields: structuredClone(f.fields), session: structuredClone(f.session), readAt: f.now,
    pluggedIn: f.session.connected, charging: f.fields.work_state.value === 'charging',
    statusAt: f.fields.work_state.measuredAt, powerKw: f.fields.phase_info.value.total_power / 1000,
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
        assert.equal(f.saved.pending.owned.witnessedCharging, true);
      }
      f.writes.push({ method, ...params }); f.now++;
      f.change(params.role, params.value);
      if (params.role === 'start_charging' && f.physicalPause) {
        f.change('work_state', params.value ? 'charging' : 'paused');
        f.change('phase_info', { total_power: params.value ? 8280 : 0,
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
  f.now += 1000; f.change('work_state', 'paused');
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
      if (condition === 'stopped') { f.now++; f.change('work_state', 'paused'); }
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

test('Shelly a lost stop reply requires explicit Resume instead of undoing an ambiguous manual stop', async t => {
  const f = fixture(t);
  f.afterPublish = () => { throw Object.assign(Error('lost reply'), { code: 'evse-command-unconfirmed' }); };
  let view = await f.update(); assert.equal(view.pending.stage, 'dispatched');
  f.afterPublish = null; f.request = null; f.now = NOW + 100_000; f.restart();
  view = await f.update();
  assert.equal(view.reason, 'identification-resume-required'); assert.equal(view.manual.kind, 'stop');
  assert.equal(view.owned.purpose, 'identification'); assert.equal(f.writes.length, 1);
  view = await f.update({ resume: true });
  assert.equal(f.fields.start_charging.value, true); assert.equal(view.owned, null); assert.equal(f.writes.length, 2);
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
