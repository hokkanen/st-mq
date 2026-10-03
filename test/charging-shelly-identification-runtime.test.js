import { withReportDatabase } from './helpers/report-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';

const START = 1_800_000_000_000, MINUTE = 60_000, FUTURE = START + 60 * MINUTE;

// Exercise the real MQTT RPC adapter, controller, vehicle ingestion and runtime.
// Only the broker/device and economic price result are synthetic.
async function fixture(t, { charging = true, retainedOnly = false, enabled = true } = {}) {
  let now = START, runtime, failSave = false, vehicleAllows = charging;
  const data = new Map(), writes = [], client = new EventEmitter();
  const config = { input: 'mqtt', connections: { mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-user' } },
    charging: { vehicles: { bmw: { mqttTopic: 'synthetic/identification/bmw' } }, chargers: { charger2: {
      enabled: true, deviceId: 'synthetic-evse', topicPrefix: 'synthetic/evse',
      limiterEnabled: false,
    } } } };
  const store = { getState: key => structuredClone(data.get(key)), setState: (key, value) => {
    if (failSave && key.startsWith('charging:')) throw Error('synthetic storage unavailable');
    data.set(key, structuredClone(value));
  }, transaction: fn => fn(), event: () => 1 };
  withReportDatabase(store, t);
  const roles = { current_limit: 'Number', start_charging: 'Boolean', work_state: 'Enum', phase_info: 'Object' };
  const ids = Object.fromEntries(Object.keys(roles).map((role, i) => [role, i + 200]));
  const fields = Object.fromEntries(Object.entries({ current_limit: 12, start_charging: true,
    work_state: charging ? 'charger_charging' : 'charger_wait',
    phase_info: {} }).map(([role, value]) => [role, { value, at: START }]));
  const physical = running => {
    fields.work_state = { value: running ? 'charger_charging' : 'charger_pause', at: now };
    fields.phase_info = { at: now, value: { total_power: running ? 6.9 : 0, total_act_energy: 0,
      ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
        { voltage: 230, current: running ? 10 : 0, power: running ? 2.3 : 0 }])) } };
  };
  physical(charging);
  const schedules = { rev: 1, jobs: [] }, serviceStatus = { state: 'running' };
  client.subscribe = (topics, options, cb) => cb(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (topic, payload, options, cb) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: 'synthetic-evse', model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Service.GetConfig') result = { id: 0, auto_balance: { enable: false }, auto_charge: true };
    else if (frame.method === 'Service.GetStatus') result = serviceStatus;
    else if (frame.method === 'Schedule.List') result = schedules;
    else if (frame.method === 'Schedule.Update') {
      writes.push({ ...frame, at: now });
      const job = schedules.jobs.find(job => job.id === frame.params.id);
      assert.ok(job); assert.equal(frame.params.enable, false); job.enable = false; result = { rev: ++schedules.rev };
    }
    else if (frame.method.endsWith('.GetConfig')) result = { id: ids[role], owner: 'service:0', access: 'crw', options: ['charger_free', 'charger_charging', 'charger_pause', 'charger_wait', 'charger_end'], min: 6, max: 16, meta: { ui: { step: 1 } } };
    else if (frame.method.endsWith('.Set')) {
      writes.push({ ...frame, at: now });
      now += 1000; fields[role] = { value: frame.params.value, at: now };
      if (role === 'start_charging') physical(frame.params.value && vehicleAllows);
      result = null;
    } else {
      // Meter readings refresh naturally; settings and work-state retain the
      // actual source transition time independently from RPC receipt time.
      result = { value: structuredClone(fields[role].value),
        last_update_ts: (role === 'phase_info' ? now : fields[role].at) / 1000 };
    }
    cb?.(); queueMicrotask(() => client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
      id: frame.id, src: 'synthetic-evse', dst: frame.src, result })), {}));
  };
  let adapter;
  const engine = { recorder: { recordEnergy() {}, energyGap() {}, flush() {} } };
  const publish = (values, at, retained = false) => runtime.receiveSoc('synthetic/identification/bmw', JSON.stringify({
    provider: 'bmw-cardata', ...values, fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      { measuredAt: at, readingId: `synthetic-${key}-${value}-${at}` }])) }), { retain: retained }, now);
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    const current = runtime; t.after(() => current.close());
    runtime.tick = () => {};
    runtime.pricesInitialized = true;
    runtime.chargers.charger2.controls.enabled = enabled; runtime.refreshSettings();
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      runtime.chargers.charger2.plan = { id: 'synthetic-economic-plan', feasible: true, startAt: FUTURE,
        periods: [{ startAt: FUTURE, endAt: null }] };
    };
    runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    if (!runtime.vehicleFeeds.bmw.reading) {
      publish({ atHome: true, pluggedIn: true, charging: retainedOnly }, START - 60 * MINUTE, true);
      if (!retainedOnly) publish({ charging }, START);
    }
    if (!adapter) {
      adapter = createShellyEvseAdapter({ config: runtime.configuration.chargers.charger2,
        broker: config.connections.mqtt, client, store, engine, clock: () => now, canControl: () => true });
      t.after(() => adapter.close());
      client.emit('connect'); client.emit('message', 'synthetic/evse/online', Buffer.from('true'), { retain: true });
      await adapter.refresh();
    }
    await runtime.setAdapter('charger2', adapter);
  };
  await create();
  const item = () => runtime.chargers.charger2;
  const card = () => runtime.status().chargers.find(row => row.id === 'charger2');
  return { get runtime() { return runtime; }, get now() { return now; }, adapter, fields, writes, schedules, serviceStatus,
    item, card, publish, setNow: value => { now = value; }, setFail: value => { failSave = value; },
    async update() { await runtime.reconcile('charger2'); return item().controller.status(); },
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    async offline() { client.emit('offline'); },
    async online() { client.emit('connect'); client.emit('message', 'synthetic/evse/online', Buffer.from('true'), { retain: true }); await adapter.refresh(); },
    start() { now += 1000; vehicleAllows = true; physical(true); publish({ charging: true }, now); },
    manualStop() { now += 1000; fields.start_charging = { value: false, at: now }; physical(false); },
    disconnect() { now += 1000; physical(false); fields.work_state = { value: 'charger_free', at: now }; },
    connect() { now += 1000; fields.start_charging = { value: true, at: now }; physical(vehicleAllows); },
    async confirm() { const stopAt = fields.work_state.at; now = stopAt + 4000; publish({ charging: false }, stopAt + 2000); return this.update(); },
    input() { const view = card(); return { association: view.association, sessionId: view.request.sessionId, revision: view.request.revision }; },
  };
}

const stops = f => f.writes.filter(row => row.params.role === 'start_charging' && row.params.value === false);
const starts = f => f.writes.filter(row => row.params.role === 'start_charging' && row.params.value === true);

test('Shelly identifies BMW through real RPC pause evidence and adopts the economic hold', async t => {
  const f = await fixture(t); f.setNow(START + 1000); await f.update();
  assert.equal(f.item().identification.phase, 'pausing'); assert.equal(stops(f).length, 1);
  assert.equal(f.card().vehicle.id, null);
  assert.equal(f.card().identification.pauseRecovery, 'controller');
  assert.equal(f.card().identification.pauseOutstanding, true);
  await f.confirm();
  assert.equal(f.card().vehicle.id, 'bmw'); assert.equal(f.item().identification.phase, 'completed');
  assert.equal(f.item().controller.status().reason, 'economic-wait');
  assert.equal(starts(f).length, 0, 'An economic hold needs no release/reinstall blip');
  assert.equal(f.card().identification.pauseOutstanding, false);
});

test('Shelly waiting survives a vehicle timer and starts testing when charging begins', async t => {
  const f = await fixture(t, { charging: false, enabled: false }); await f.update();
  assert.equal(f.item().identification.phase, 'waiting'); assert.equal(stops(f).length, 0);
  f.setNow(START + 30 * MINUTE); await f.update();
  assert.equal(f.item().identification.phase, 'waiting'); assert.equal(f.card().vehicle.state, 'identifying');
  f.start(); f.setNow(f.now + 1000); await f.update();
  assert.equal(f.item().identification.phase, 'pausing'); assert.equal(stops(f).length, 1);
});

test('Shelly economic zero allocation cannot block the short identification observation', async t => {
  const f = await fixture(t, { retainedOnly: true });
  f.runtime.coordination = { allocations: [{ start: START, end: FUTURE,
    chargers: { charger2: { currentLimitA: 0 }, charger1: { currentA: 0 } } }] };
  f.publish({ atHome: true }, f.now);
  await f.update();
  await f.update();
  assert.equal(f.item().identification.phase, 'charging');
  assert.equal(f.fields.start_charging.value, true, 'The probe may release the initial economic hold');
  assert.equal(f.fields.current_limit.value, 12, 'The identification probe uses the existing normal limiter allowance');
  assert.ok(f.item().identification.probe.deadlineAt > f.now);
});

test('Shelly identifies with Automatic OFF and promptly resumes its own pause', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update();
  assert.equal(stops(f).length, 1); await f.confirm();
  assert.equal(f.card().vehicle.id, 'bmw'); assert.equal(starts(f).length, 1);
  assert.equal(f.card().identification.pauseOutstanding, false);
});

test('Shelly holds the confirmed stop long enough for delayed BMW delivery and promptly restores its start permission', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update();
  const stopAt = f.fields.work_state.at, deadline = f.item().identification.pauseUntil;
  f.setNow(stopAt + 30_000); await f.update();
  assert.equal(f.item().identification.phase, 'pausing'); assert.equal(starts(f).length, 0);
  assert.equal(f.fields.start_charging.value, false); assert.equal(f.card().vehicle.id, null);
  f.setNow(stopAt + 60_000); f.publish({ charging: false }, stopAt + 2000); await f.update();
  assert.equal(f.card().vehicle.id, 'bmw'); assert.equal(f.item().identification.phase, 'completed');
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.charging.negativeEvent.measuredAt, stopAt + 2000);
  assert.equal(f.fields.start_charging.value, true); assert.equal(starts(f).length, 1);
  assert.ok(f.now < deadline);
});

test('Shelly bounded BMW pause returns to economic waiting without releasing charging on silence', async t => {
  const f = await fixture(t); f.setNow(START + 1000); await f.update();
  const deadline = f.item().identification.pauseUntil;
  f.setNow(START + 60_000); await f.update();
  assert.equal(f.item().identification.phase, 'pausing'); assert.equal(f.fields.start_charging.value, false);
  f.setNow(deadline + 1000); await f.update();
  assert.equal(f.item().identification.phase, 'observing'); assert.equal(f.item().controller.status().reason, 'economic-wait');
  assert.equal(f.fields.start_charging.value, false); assert.equal(starts(f).length, 0);
  assert.equal(f.card().vehicle.id, null); assert.equal(f.item().identification.attempt, 1);
});

test('Shelly Charge now includes identification and then releases without an economic delay', async t => {
  const f = await fixture(t); f.setNow(START + 1000);
  f.runtime.telemetry(f.now); f.item().request.chargeNow = true;
  await f.update(); assert.equal(stops(f).length, 1); await f.confirm();
  assert.equal(f.card().vehicle.id, 'bmw'); assert.equal(starts(f).length, 1);
});

test('Shelly restart resumes the same absolute pause and timeout never retries automatically', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update();
  const before = structuredClone(f.item().identification);
  f.setNow(f.now + 5000); await f.restart(); await f.update();
  assert.equal(f.item().identification.id, before.id); assert.equal(stops(f).length, 1);
  assert.equal(f.item().identification.phase, 'pausing');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().identification.pauseUntil, before.pauseUntil);
  f.setNow(before.pauseUntil + 1000); await f.update();
  assert.equal(f.item().identification.phase, 'observing'); assert.equal(starts(f).length, 1);
  await f.restart(); await f.update(); assert.equal(f.item().identification.id, before.id);
  assert.equal(stops(f).length, 1);
});

test('Shelly outage can extend a pause and recovery releases it without renewing the test', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update();
  const before = structuredClone(f.item().identification), input = f.input();
  await f.offline(); f.setNow(before.pauseUntil + MINUTE); await f.update();
  assert.equal(f.card().identification.pauseOutstanding, true); assert.equal(starts(f).length, 0);
  assert.equal(f.card().identification.available, false);
  await assert.rejects(f.runtime.identifyVehicle('charger2', input), /unavailable|connection/);
  await f.restart(); await f.online(); await f.update();
  assert.equal(f.item().identification.phase, 'observing');
  assert.equal(f.item().identification.id, before.id); assert.equal(starts(f).length, 1);
  assert.equal(f.card().identification.pauseOutstanding, false);
});

test('Shelly explicit manual Stop during its identification pause wins across timeout and restart', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update();
  const deadline = f.item().identification.pauseUntil;
  f.manualStop(); await f.update(); f.setNow(deadline + 1000); await f.restart(); await f.update();
  assert.equal(starts(f).length, 0); assert.equal(f.card().identification.available, false);
  assert.equal(f.item().controller.status().manual.kind, 'stop');
});

test('Use automatic returns a stopped Shelly to economic waiting through the real runtime and RPC controller', async t => {
  const f = await fixture(t, { charging: false, retainedOnly: true });
  await f.update(); f.manualStop(); await f.update();
  const before = f.card();
  assert.equal(before.control.manual.kind, 'stop');
  const input = { ...f.input(), controlRevision: before.controls.revision, takeoverToken: before.control.takeover.token };
  await f.runtime.useAutomatic('charger2', input);
  const after = f.card();
  assert.equal(after.controls.enabled, true); assert.equal(after.control.manual, null);
  assert.equal(after.control.takeover.state, 'confirmed');
  assert.equal(after.control.takeover.attemptToken, input.takeoverToken);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(starts(f).length, 0, 'Use automatic does not force charging during the economic wait');
  await f.restart(); await f.update();
  assert.equal(f.card().control.manual, null); assert.equal(f.fields.start_charging.value, false);
  f.manualStop(); await f.update();
  assert.equal(f.card().control.manual.kind, 'stop', 'the next external Stop takes priority again');
});

test('Use automatic disables Shelly charging timers permanently without restoring them on runtime restart', async t => {
  const f = await fixture(t, { charging: false });
  f.schedules.jobs = [{ id: 1, enable: true, timespec: '0 0 22 * * *', calls: [
    { method: 'Boolean.Set', params: { owner: 'service:0', role: 'start_charging', value: true } }] }];
  f.schedules.rev++; f.manualStop(); await f.update();
  const before = f.card();
  await f.runtime.useAutomatic('charger2', { ...f.input(), controlRevision: before.controls.revision,
    takeoverToken: before.control.takeover.token });
  assert.equal(f.schedules.jobs[0].enable, false);
  assert.equal(f.card().control.takeover.state, 'confirmed');
  await f.restart(); await f.update();
  assert.equal(f.schedules.jobs[0].enable, false);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1);
  f.schedules.jobs[0].enable = true; f.schedules.rev++; await f.update();
  assert.equal(f.card().control.manual.kind, 'schedule');
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 1);
});

test('Shelly native schedules and faults withhold active identification commands', async t => {
  for (const cause of ['native-schedule', 'fault']) {
    const f = await fixture(t);
    if (cause === 'native-schedule') f.schedules.jobs.push({ enable: true });
    else f.serviceStatus.errors = ['synthetic-fault'];
    f.setNow(START + 1000); await f.update();
    assert.equal(f.writes.length, 0, cause); assert.equal(f.card().identification.available, false, cause);
  }
});

test('Shelly retained-only BMW evidence does not authorize an extra charging probe', async t => {
  const f = await fixture(t, { retainedOnly: true }); await f.update();
  assert.equal(f.item().identification.phase, 'waiting'); assert.equal(f.item().identification.probe, null);
  assert.equal(stops(f).length, 1, 'Normal economic scheduling still stops charging');
  f.setNow(f.now + 30 * MINUTE); await f.update();
  assert.equal(f.item().identification.phase, 'waiting'); assert.equal(f.card().vehicle.id, null);
  assert.equal(starts(f).length, 0);
});

test('Shelly manual Identify can recheck an identified vehicle without dropping its existing label', async t => {
  const f = await fixture(t, { enabled: false }); f.setNow(START + 1000); await f.update(); await f.confirm();
  f.setNow(f.now + 1000); await f.runtime.identifyVehicle('charger2', f.input());
  assert.equal(f.card().vehicle.id, 'bmw'); assert.equal(f.item().identification.attempt, 2);
  f.setNow(f.now + 1000); f.publish({ charging: true }, f.now - 500); await f.update();
  assert.equal(f.item().identification.phase, 'pausing'); await f.confirm();
  assert.equal(f.item().identification.phase, 'completed'); assert.equal(stops(f).length, 2);
});

test('Shelly unplug cancels its scope and the next connection gets one fresh attempt', async t => {
  const f = await fixture(t); f.setNow(START + 1000); await f.update();
  const before = f.item().identification.id;
  f.disconnect(); await f.update(); assert.equal(f.item().identification, null);
  f.connect(); await f.update();
  assert.notEqual(f.item().identification.id, before); assert.equal(f.item().identification.attempt, 1);
});

test('Shelly failed persistence cannot dispatch the identification stop', async t => {
  const f = await fixture(t); f.setNow(START + 1000); f.setFail(true);
  await assert.rejects(f.update(), /storage/); assert.equal(f.writes.length, 0);
});
