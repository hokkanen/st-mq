import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { chargingConfiguration } from '../src/charging/config.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = 1_800_000_000_000, DEVICE = 'synthetic-system-evse', PREFIX = 'synthetic/system/evse';
const COMPONENTS = { current_limit: ['Number', 200], start_charging: ['Boolean', 201],
  work_state: ['Enum', 202], phase_info: ['Object', 203] };

// Only the EVSE/broker and economic result are synthetic. Permission events pass
// through the real MQTT parser, persistent queue, controller and runtime matcher.
async function fixture(t, { initiallyPermitted = false, autoCharge = false, startOutcome = 'confirmed', startEcho = null,
  automatic = true, vehicleFeed = true } = {}) {
  let now = START, measuredCurrentA = 0, runtime, newerStartInjected = false, pendingStartEcho = null,
    planStartAt = START, ownershipSaveFailure = false;
  const data = new Map(), writes = [], echoTrace = [], client = new EventEmitter();
  const schedules = { rev: 1, jobs: [] }, serviceStatus = { state: 'running' };
  const service = { id: 0, auto_balance: { enable: false }, auto_charge: autoCharge };
  const currentCapability = { access: 'crw' };
  const fields = { current_limit: { value: 16, at: START, source: 'rpc' },
    start_charging: { value: initiallyPermitted, at: START, source: 'rpc' },
    work_state: { value: 'charger_free', at: START } };
  const config = { input: 'mqtt', connections: {
    mqtt: { address: 'mqtt://synthetic-system.invalid', user: 'synthetic' },
    teslamate: { enabled: vehicleFeed, carId: '1', namespace: 'synthetic-system', homeGeofence: 'Home' },
  }, charging: { chargers: { charger2: { enabled: true, deviceId: DEVICE, topicPrefix: PREFIX, limiterEnabled: false } } } };
  const store = { getState: key => structuredClone(data.get(key)),
    setState: (key, value) => {
      if (ownershipSaveFailure && key === runtime.ownershipKey('charger2')) throw Error('synthetic-ownership-save-failure');
      data.set(key, structuredClone(value));
    }, transaction: fn => fn(), event: () => 1 };
  withReportDatabase(store, t);
  const meter = () => ({ total_power: measuredCurrentA * .69, total_act_energy: 0,
    ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
      { voltage: 230, current: measuredCurrentA, power: measuredCurrentA * .23 }])) });
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, done) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result;
    if (frame.method === 'Shelly.GetDeviceInfo') result = { id: DEVICE, model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Service.GetConfig') result = structuredClone(service);
    else if (frame.method === 'Service.GetStatus') result = structuredClone(serviceStatus);
    else if (frame.method === 'Schedule.List') result = structuredClone(schedules);
    else if (frame.method.endsWith('.GetConfig')) result = { id: COMPONENTS[role][1], owner: 'service:0',
      access: role === 'current_limit' ? currentCapability.access : 'crw',
      min: 6, max: 16, meta: { ui: { step: 1 } },
      options: ['charger_free', 'charger_insert', 'charger_wait', 'charger_pause', 'charger_end', 'charger_charging'] };
    else if (frame.method.endsWith('.Set')) {
      writes.push({ method: frame.method, ...frame.params, at: now });
      if (role === 'start_charging' && frame.params.value === true && startEcho) {
        pendingStartEcho = { dispatchedAt: now, nativeAt: now - (startEcho === 'different native second' ? 1083 : 83) };
        echoTrace.push(pendingStartEcho);
      }
      now += 100;
      fields[role] = { value: frame.params.value, at: Math.floor(now / 1000) * 1000, source: 'rpc' };
      if (role === 'start_charging') fields.work_state = { value: frame.params.value ? 'charger_wait' : 'charger_pause', at: fields[role].at };
      if (role === 'start_charging' && frame.params.value === true && startOutcome === 'no acknowledgement') {
        // Publication failed after the synthetic device applied the command;
        // the application cannot infer whether delivery or execution occurred.
        done?.(Error('synthetic uncertain publication')); return;
      }
      result = null;
    } else {
      if (role === 'start_charging' && pendingStartEcho) {
        const echo = pendingStartEcho; pendingStartEcho = null;
        echo.readRequestedAt = now;
        // ACK has already arrived. During its correlated readback, the EVSE
        // publishes a value-only echo whose native clock is slightly behind
        // the application's dispatch clock. Receipt time remains independent.
        now += 140; echo.receivedAt = now;
        client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
          params: { ts: echo.nativeAt / 1000, 'boolean:201': { value: true,
            ...(startEcho === 'unknown source' ? { source: 'synthetic-unknown' } : {}) } } })), {});
        echo.event = structuredClone(adapter.snapshot().permissionEvents.at(-1));
        if (startEcho === 'external Stop during readback') {
          now += 17;
          fields.start_charging = { value: false, at: Math.floor(now / 1000) * 1000, source: 'rpc' };
          fields.work_state = { value: 'charger_pause', at: now };
          client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
            params: { ts: now / 1000, 'boolean:201': { value: false, source: 'rpc' } } })), {});
          echo.externalStopAt = now;
        }
        now += 265; echo.readReceivedAt = now;
      }
      if (role === 'start_charging' && fields[role].value === true && startOutcome === 'newer native instruction' && !newerStartInjected) {
        // A different RPC client repeats Start after our acknowledgement but
        // before the first confirmation query. The returned clock tells them apart.
        newerStartInjected = true; now += 1000; fields[role].at = Math.floor(now / 1000) * 1000;
      }
      result = role === 'phase_info' ? { value: meter(), last_update_ts: now / 1000 }
        : { value: role === 'start_charging' && startOutcome === 'unknown readback' && fields[role].value === true
          ? null : fields[role].value, last_update_ts: fields[role].at / 1000,
          ...(fields[role].source !== undefined ? { source: fields[role].source } : {}) };
    }
    done?.(); queueMicrotask(() => {
      if (role === 'start_charging' && frame.method.endsWith('.Set') && pendingStartEcho)
        pendingStartEcho.acknowledgedAt = now;
      client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id, src: DEVICE, dst: frame.src, result })), {});
    });
  };
  const capture = createChargingTeslaCapture({ settings: config.connections.teslamate,
    clock: () => now, brokerIdentity: 'synthetic-system-broker' });
  capture.setConnected(true); t.after(() => capture.close());
  const publishTesla = values => {
    for (const [key, value] of Object.entries(values)) assert.equal(capture.receive(
      `teslamate/synthetic-system/cars/1/${key}`, String(value), { retain: false }, now), true);
  };
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    const instance = runtime; t.after(() => instance.close());
    runtime.tick = () => {}; runtime.pricesInitialized = true;
    runtime.chargers.charger2.controls.enabled = automatic; runtime.refreshSettings();
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      runtime.chargers.charger2.plan = { id: 'synthetic-system-plan', feasible: true,
        startAt: planStartAt, deadlineAt: START + 8 * 3600_000, periods: [{ startAt: planStartAt, endAt: null }] };
    };
    runtime.teslaCapture = vehicleFeed ? capture : null;
    await runtime.setAdapter('charger2', adapter);
  };
  const adapter = createShellyEvseAdapter({ config: chargingConfiguration(config.charging).chargers.charger2,
    broker: config.connections.mqtt, client, store, clock: () => now, canControl: () => true,
    engine: { recorder: { recordEnergy() {}, energyGap() {}, flush() {} } } });
  t.after(() => adapter.close());
  client.emit('connect'); client.emit('message', `${PREFIX}/online`, Buffer.from('true'), {}); await adapter.refresh();
  publishTesla({ healthy: true, geofence: 'Home', plugged_in: true, charging_state: 'Stopped',
    charger_phases: 3, charger_power: 0, charger_actual_current: 0 });
  await create();
  return { get now() { return now; }, get runtime() { return runtime; }, adapter, fields, writes, schedules, echoTrace,
    service, serviceStatus, currentCapability, publishTesla,
    setPlanStartAt(at) { planStartAt = at; },
    failOwnershipSave(value) { ownershipSaveFailure = value; },
    item: () => runtime.chargers.charger2,
    advance(ms) { now += ms; },
    measure(currentA) { measuredCurrentA = currentA; fields.work_state = {
      value: currentA > 0 ? 'charger_charging' : fields.start_charging.value ? 'charger_wait' : 'charger_pause', at: now }; },
    async update() { await runtime.reconcile('charger2'); return runtime.chargers.charger2.controller.status(); },
    async reconnect({ startDelayMs = 0 } = {}) {
      now += 1000; fields.work_state = { value: 'charger_insert', at: now };
      await adapter.refresh(); now += startDelayMs; return this.update();
    },
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    permission(value, source = 'sys', { omitSource = false, eventAt = now } = {}) {
      fields.start_charging = { value, at: Math.floor(eventAt / 1000) * 1000,
        source: omitSource ? fields.start_charging.source : source };
      client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
        params: { ts: eventAt / 1000, 'boolean:201': { value, ...(omitSource ? {} : { source }) } } })), {});
    },
    current(value, source = 'rpc', { sourceOnly = false } = {}) {
      fields.current_limit = sourceOnly ? { ...fields.current_limit, source }
        : { value, at: Math.floor(now / 1000) * 1000, source };
      client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
        params: { ts: now / 1000, 'number:200': { ...(sourceOnly ? {} : { value }), source } } })), {});
    },
    async reconnectBroker() {
      client.emit('offline'); client.emit('connect');
      client.emit('message', `${PREFIX}/online`, Buffer.from('true'), {});
      await adapter.refresh(); await adapter.refresh({ force: true });
    },
    disconnectBroker() { client.emit('offline'); },
  };
}

async function startedFixture(t, options) {
  const f = await fixture(t, options);
  await f.update(); await f.reconnect({ startDelayMs: options?.startDelayMs ?? 0 }); await f.update();
  assert.equal(f.item().controller.status().currentTest?.phase, 'active');
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.fields.start_charging.value, true);
  return f;
}

test('a value-only own Start echo with an earlier native clock waits for its acknowledged correlated readback', async t => {
  const f = await startedFixture(t, { startEcho: 'own Start' });
  const control = f.item().controller.status(), echo = f.echoTrace[0], attempt = structuredClone(f.item().identification);
  assert.equal(f.echoTrace.length, 1);
  assert.equal(echo.nativeAt, echo.dispatchedAt - 83);
  assert.ok(echo.receivedAt > echo.acknowledgedAt);
  assert.ok(echo.readRequestedAt >= echo.acknowledgedAt && echo.readReceivedAt > echo.receivedAt);
  assert.equal(echo.event.commandSource, 'rpc', 'No SYS off/on exception is involved');
  assert.equal(control.snapshot.fields.start_charging.measuredAt, Math.floor(echo.dispatchedAt / 1000) * 1000);
  assert.ok(control.snapshot.fields.start_charging.readback.requestedAt >= Math.max(echo.acknowledgedAt, echo.receivedAt),
    'A query sent before the notification cannot supply the required confirmation');
  assert.equal(control.manual, null, 'The confirmed own Start is not an independent native Enable');
  assert.equal(control.currentTest.phase, 'active');
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.item().vehicleMatch, null);
  f.advance(1000); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().controller.status().currentTest.expiresAt, control.currentTest.expiresAt);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('a late duplicate value-only Start echo cannot repeat the command or renew identification authority', async t => {
  const f = await startedFixture(t);
  const before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  const start = f.writes.find(row => row.role === 'start_charging' && row.value === true);
  assert.equal(before.pending, null, 'The original Start is already durably confirmed');
  f.advance(500); const receivedAt = f.now;
  f.permission(true, 'rpc', { omitSource: true, eventAt: start.at - 83 });
  assert.ok(start.at - 83 >= before.snapshot.fields.start_charging.measuredAt);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 0,
    'After confirmed true/rpc readback, a duplicate value-only notification is not another instruction');
  await f.update();
  const after = f.item().controller.status();
  assert.equal(after.manual, null);
  assert.ok(after.snapshot.fields.start_charging.readback.requestedAt >= receivedAt);
  assert.equal(after.snapshot.fields.start_charging.measuredAt, before.snapshot.fields.start_charging.measuredAt);
  assert.equal(after.currentTest.phase, 'active');
  assert.equal(after.currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const startEcho of ['unknown source', 'different native second'])
test(`a Start notification with ${startEcho} cannot borrow the command's acknowledgement`, async t => {
  const f = await fixture(t, { startEcho });
  await f.update(); await f.reconnect({ startDelayMs: 3000 }); await f.update();
  assert.equal(f.echoTrace.length, 1);
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('an external Stop during the own Start echo readback remains authoritative despite native clock skew', async t => {
  const f = await fixture(t, { startEcho: 'external Stop during readback' });
  await f.update(); await f.reconnect(); await f.update();
  const echo = f.echoTrace[0];
  assert.ok(echo.externalStopAt > echo.acknowledgedAt);
  assert.equal(f.item().controller.status().manual?.kind, 'stop');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().vehicleMatch, null);
  f.advance(1000); await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'An acknowledgement cannot justify retrying Start through an independent Stop');
});

test('a later external Stop supersedes a confirmed own Start with a clock-skewed value-only echo', async t => {
  const f = await startedFixture(t, { startEcho: 'own Start' });
  f.advance(1000); f.permission(false, 'rpc'); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'stop');
  assert.equal(f.fields.start_charging.value, false);
  await f.restart(); f.advance(1000); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'stop');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

const starts = f => f.writes.filter(row => row.role === 'start_charging' && row.value === true);
const currentWrites = f => f.writes.filter(row => row.role === 'current_limit');

function assertOriginalAttempt(f, before, attempt) {
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().controller.status().currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.item().identification.probe?.deadlineAt, attempt.probe?.deadlineAt);
  assert.equal(f.item().identification.pauseUntil, attempt.pauseUntil);
}

async function ordinaryFixture(t, options = {}) {
  const f = await fixture(t, { vehicleFeed: false, ...options });
  await f.update(); await f.reconnect(); await f.update();
  assert.equal(f.item().controller.status().currentTest ?? null, null);
  return f;
}

test('late SYS false and true preserve an existing minimum-current attempt without another Start', async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  f.advance(62_000); f.permission(false); await f.update();
  const stopped = f.item().controller.status();
  assert.equal(stopped.manual, null);
  assert.equal(stopped.devicePermissionHeld, true);
  assert.equal(stopped.snapshot.fields.start_charging.value, false);
  assert.equal(stopped.snapshot.stopped, true, 'Exemption from manual takeover never rewrites native permission');
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.item().identification.completedAt, null);
  assertOriginalAttempt(f, before, attempt);
  f.advance(1500); f.permission(true, 'sys', { omitSource: true }); await f.update();
  const recovered = f.item().controller.status();
  assert.equal(recovered.manual, null);
  assert.equal(recovered.devicePermissionHeld, false);
  assert.ok(recovered.snapshot.fields.start_charging.readback.requestedAt >= stopped.deviceHold.receivedAt);
  assertOriginalAttempt(f, before, attempt);
  assert.equal(starts(f).length, 1);
  assert.equal(f.item().vehicleMatch, null);
});

for (const delivery of ['between reconciles', 'across reconciles'])
test(`repeated SYS cycles ${delivery} preserve the original attempt and physical observations`, async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  for (let cycle = 0; cycle < 3; cycle++) {
    f.advance(2200); f.permission(false);
    if (delivery === 'across reconciles') {
      await f.update();
      assert.equal(f.item().controller.status().devicePermissionHeld, true);
      assert.equal(f.fields.start_charging.value, false);
      assert.equal(f.fields.current_limit.value, 6);
    }
    f.advance(1500); f.permission(true, 'sys', { omitSource: true }); await f.update();
    assert.equal(f.item().controller.status().manual, null);
    assert.equal(f.item().controller.status().devicePermissionHeld, false);
    assertOriginalAttempt(f, before, attempt);
  }
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.item().vehicleMatch, null, 'Native cycles do not identify a vehicle');
  assert.equal(starts(f).length, 1);
  assert.deepEqual(currentWrites(f).map(row => row.value), [6]);
});

test('read-only telemetry previews a SYS false hold without consuming its event or cancelling the attempt', async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  f.advance(22_000); f.permission(false);
  const writes = f.writes.length;
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  f.runtime.telemetry(f.now);
  assert.equal(f.item().identification.completedAt, null);
  assertOriginalAttempt(f, before, attempt);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(f.writes.length, writes);
});

test('SYS false can outlast the old startup window and current deadline without restarting or renewing identification', async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  f.advance(2200); f.permission(false); await f.update();
  f.advance(20_000); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.fields.current_limit.value, 6);
  assertOriginalAttempt(f, before, attempt);
  f.advance(before.currentTest.expiresAt - f.now + 1000); f.measure(0); await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.item().identification.id, attempt.id);
  assert.notEqual(f.item().identification.completedAt, null, 'Its original active testing budget expires normally');
  assert.equal(starts(f).length, 1);
  const terminal = structuredClone(f.item().identification);
  f.advance(1000); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().identification.id, terminal.id);
  assert.equal(f.item().identification.attempt, terminal.attempt);
  assert.equal(f.item().identification.completedAt, terminal.completedAt);
  assert.equal(starts(f).length, 1, 'A later device Enable does not grant another identification Start');
});

test('a preserved SYS-interrupted attempt still requires independent physical and vehicle current evidence', async t => {
  const f = await startedFixture(t), attempt = structuredClone(f.item().identification);
  f.advance(2200); f.permission(false); f.advance(1500); f.permission(true); await f.update();
  f.advance(6000);
  f.publishTesla({ charging_state: 'Charging', charger_actual_current: 6, charger_power: 4.14, healthy: true });
  f.runtime.telemetry(f.now);
  assert.equal(f.item().vehicleMatch, null);
  f.measure(6); await f.update(); f.advance(5000); await f.update();
  assert.equal(f.item().vehicleMatch?.id, 'tesla');
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().identification.phase, 'completed');
  assert.equal(starts(f).length, 1);
});

test('ordinary automatic charging honors a late SYS hold at native current without needing an identification Start', async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true, autoCharge: true });
  assert.equal(starts(f).length, 0);
  assert.equal(f.fields.current_limit.value, 16);
  f.advance(4 * 3600_000); f.permission(false); await f.update();
  f.advance(15 * 60_000); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(starts(f).length, 0);
  f.advance(1000); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(starts(f).length, 0);
  assert.equal(currentWrites(f).length, 0);
});

for (const chargeNow of [false, true])
test(`SYS does not acquire Start authority with Automatic OFF and Charge now ${chargeNow}`, async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true, automatic: false });
  f.item().request.chargeNow = chargeNow;
  f.advance(70_000); f.permission(false); await f.update();
  f.advance(20_000); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.item().request.chargeNow, chargeNow);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(starts(f).length, 0);
  f.advance(1000); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(starts(f).length, 0);
});

for (const source of ['rpc', null, 'synthetic-unknown'])
test(`a ${source ?? 'unknown'} native Stop retains priority through a later SYS false/true cycle`, async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true });
  f.advance(2000); f.permission(false, source); await f.update();
  const manual = structuredClone(f.item().controller.status().manual);
  assert.equal(manual.kind, 'stop');
  f.advance(1000); f.permission(false); await f.update();
  f.advance(1000); f.permission(true); await f.update();
  assert.deepEqual(f.item().controller.status().manual, manual);
  assert.equal(f.item().controller.status().snapshot.fields.start_charging.value, true,
    'Preserving prior native authority does not invent a physically stopped charger');
  assert.equal(starts(f).length, 0);
});

test('an RPC Stop arriving inside a SYS hold survives later SYS recovery and restart', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  f.advance(1100); f.permission(false, 'rpc'); await f.update();
  const manual = structuredClone(f.item().controller.status().manual);
  assert.equal(manual.kind, 'stop');
  f.advance(1100); f.permission(true); await f.update();
  await f.restart(); await f.update();
  assert.deepEqual(f.item().controller.status().manual, manual);
  assert.equal(starts(f).length, 1);
});

for (const boundary of ['application restart', 'broker reconnect'])
test(`a SYS false hold survives ${boundary} until fresh true native readback`, async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  f.advance(2200); f.permission(false); await f.update();
  const held = structuredClone(f.item().controller.status().deviceHold);
  if (boundary === 'application restart') await f.restart(); else await f.reconnectBroker();
  f.advance(1000); await f.update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.deepEqual(f.item().controller.status().deviceHold, held, 'Reading a held value cannot manufacture a new device event');
  assert.equal(f.item().controller.status().manual, null);
  assertOriginalAttempt(f, before, attempt);
  f.advance(1000); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(starts(f).length, 1);
});

test('a native fault remains a control barrier through SYS recovery', async t => {
  const f = await startedFixture(t), before = f.item().controller.status();
  f.advance(2200); f.permission(false); await f.update();
  f.serviceStatus.errors = ['synthetic-fault'];
  f.advance(1000); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().snapshot.controlReady, false);
  assert.equal(starts(f).length, 1);
  assert.equal(f.item().vehicleMatch, null);
  delete f.serviceStatus.errors;
  f.advance(1000); await f.update();
  assert.equal(f.item().controller.status().manual, null, 'The fault is not misattributed as a user instruction');
  assert.equal(f.item().controller.status().currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(starts(f).length, 1);
});

for (const [value, source] of [[8, 'rpc'], [6, 'rpc'], [8, 'sys']])
test(`a native ${source} current instruction of ${value} A supersedes restoration despite SYS permission classification`, async t => {
  const f = await startedFixture(t), before = f.item().controller.status();
  f.advance(2200); f.permission(false); await f.update();
  f.advance(1100); f.current(value, source); await f.update();
  assert.equal(f.item().controller.status().currentTest.phase, 'superseded');
  f.advance(1100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.fields.current_limit.value, value);
  assert.equal(f.item().controller.status().currentTest.expiresAt, before.currentTest.expiresAt);
  assert.deepEqual(currentWrites(f).map(row => row.value), [6]);
  assert.equal(starts(f).length, 1);
});

for (const outcome of ['unknown readback', 'no acknowledgement'])
test(`SYS recovery cannot confirm or retry a Start with ${outcome}`, async t => {
  const f = await fixture(t, { startOutcome: outcome });
  await f.update(); await f.reconnect(); await f.update();
  assert.equal(starts(f).length, 1);
  f.advance(2200); f.permission(false); await f.update();
  f.advance(1100); f.permission(true); await f.update();
  assert.equal(starts(f).length, 1);
  assert.equal(f.item().vehicleMatch, null);
  assert.notEqual(f.item().controller.status().pending, null, 'A SYS value is not the missing command acknowledgement');
});

test('failure to persist a SYS cursor and hold leaves the event queued and cannot issue a replacement Start', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false);
  const writes = f.writes.length;
  f.failOwnershipSave(true);
  await assert.rejects(f.update(), /synthetic-ownership-save-failure/);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(f.writes.length, writes);
  f.failOwnershipSave(false); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 0);
  assert.equal(starts(f).length, 1);
});

for (const startup of [null, { phase: 'armed' }])
test(`retired startup ownership ${startup === null ? 'null' : 'record'} rejects before mutation`, async t => {
  const f = await startedFixture(t), saved = structuredClone(f.runtime.savedOwnership('charger2')), before = f.writes.length;
  saved.startup = startup;
  assert.throws(() => f.adapter.createController({ initialState: saved, clock: () => f.now,
    canControl: () => true }), /unsupported-shelly-ownership/);
  assert.equal(f.writes.length, before);
});

for (const [label, edit] of [['missing receipt time', hold => { delete hold.receivedAt; }],
  ['unknown field', hold => { hold.extra = true; }], ['invalid source time', hold => { hold.eventAt = -1; }]])
test(`saved SYS hold with ${label} rejects before mutation`, async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  const saved = structuredClone(f.runtime.savedOwnership('charger2')), before = f.writes.length;
  assert.ok(saved.deviceHold);
  edit(saved.deviceHold);
  assert.throws(() => f.adapter.createController({ initialState: saved, clock: () => f.now,
    canControl: () => true }), /unsupported-shelly-ownership/);
  assert.equal(f.writes.length, before);
});

async function ownedPauseFixture(t) {
  const f = await startedFixture(t);
  f.advance(1000); f.measure(6); await f.adapter.refresh({ force: true });
  const attempt = structuredClone(f.item().identification), originalTest = f.item().controller.status().currentTest;
  let saved = structuredClone(f.runtime.savedOwnership('charger2'));
  let request = { id: attempt.id, connectedAt: attempt.connectedAt, phase: 'pausing', pauseUntil: f.now + 90_000 };
  await f.runtime.close();
  const controller = f.adapter.createController({ initialState: saved, clock: () => f.now, canControl: () => true,
    getIdentification: () => request, saveState: value => { saved = structuredClone(value); } });
  t.after(() => controller.close());
  const update = input => controller.update({ enabled: true,
    plan: { id: 'synthetic-pause-plan', startAt: START, deadlineAt: START + 3600_000,
      periods: [{ startAt: START, endAt: null }], feasible: true }, ...input });
  await update();
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.fields.current_limit.value, 6, 'Accepted Stop alone cannot restore the higher current');
  f.advance(1100); f.measure(0); await update();
  assert.equal(controller.status().pauseConfirmed, true);
  assert.equal(f.fields.current_limit.value, 16);
  return Object.assign(f, { controller, update, originalTest, pauseUntil: request.pauseUntil,
    endRequest() { request = null; } });
}

test('same-value SYS false preserves an owned pause through Charge now and resumes only at its original deadline', async t => {
  const f = await ownedPauseFixture(t), before = structuredClone(f.controller.status().owned), initialStarts = starts(f).length;
  f.advance(15_000); f.permission(false); f.measure(0);
  await f.update({ chargeNow: { connectedAt: before.identificationConnectedAt } });
  const paused = f.controller.status();
  assert.equal(paused.manual, null);
  assert.equal(paused.pauseConfirmed, true);
  assert.equal(paused.owned.startAt, before.startAt);
  assert.equal(paused.owned.requestedAt, before.requestedAt);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(starts(f).length, initialStarts);
  f.advance(f.pauseUntil - f.now + 1); f.endRequest(); await f.update({ chargeNow: { connectedAt: before.identificationConnectedAt } });
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(starts(f).length, initialStarts + 1);
  assert.equal(f.controller.status().currentTest.expiresAt, f.originalTest.expiresAt);
});

test('a SYS true-to-false batch breaks current owned-pause proof without treating either edge as manual', async t => {
  const f = await ownedPauseFixture(t), before = structuredClone(f.controller.status().owned), writes = f.writes.length;
  f.advance(2100); f.permission(true);
  f.advance(1100); f.permission(false); f.measure(0); await f.update();
  const after = f.controller.status();
  assert.equal(after.manual, null);
  assert.equal(after.devicePermissionHeld, true);
  assert.equal(after.pauseConfirmed, false, 'Final zero and SYS false do not prove continuation of the original Stop');
  assert.equal(after.snapshot.fields.start_charging.value, false);
  assert.equal(after.identification.pauseUntil, before.startAt, 'The same request keeps its original observation deadline');
  assert.equal(f.writes.length, writes, 'A system-held Stop is not relabelled by writing another Stop');
  assert.equal(after.currentTest.expiresAt, f.originalTest.expiresAt);
});

test('SYS Enable during an owned pause requires a newly confirmed Stop and zero without extending the pause', async t => {
  const f = await ownedPauseFixture(t), before = structuredClone(f.controller.status().owned), initialStarts = starts(f).length;
  f.advance(2100); f.permission(true); f.advance(1100); f.measure(6); await f.update();
  const stopping = f.controller.status();
  assert.equal(stopping.manual, null);
  assert.equal(f.fields.start_charging.value, false, 'The existing bounded pause remains the desired application action');
  assert.equal(stopping.pauseConfirmed, false, 'A Stop acknowledgement is not fresh physical zero');
  assert.equal(stopping.owned.startAt, before.startAt);
  assert.ok(stopping.owned.requestedAt > before.requestedAt);
  f.advance(1100); f.measure(0); await f.update();
  assert.equal(f.controller.status().pauseConfirmed, true);
  assert.equal(f.controller.status().owned.startAt, before.startAt);
  assert.equal(starts(f).length, initialStarts);
});

test('fresh SYS true notification cannot clear a false hold before its correlated native readback', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  const hold = structuredClone(f.item().controller.status().deviceHold), writes = f.writes.length;
  f.advance(1100); f.permission(true);
  const pending = f.item().controller.status();
  assert.equal(pending.devicePermissionHeld, true);
  assert.deepEqual(pending.deviceHold, hold);
  assert.ok(pending.snapshot.notificationPending.includes('start_charging'));
  f.runtime.telemetry(f.now);
  assert.equal(f.writes.length, writes);
  await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(starts(f).length, 1);
});

test('SYS false does not renew an extra-charging probe or discard its original economic return', async t => {
  const f = await fixture(t);
  f.setPlanStartAt(START + 3600_000);
  await f.update(); await f.reconnect(); await f.update();
  const before = f.item().controller.status(), initial = structuredClone(f.item().identification);
  assert.ok(initial.probe, 'The test must exercise an actual bounded extra-charging probe');
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(starts(f).length, 1);
  f.advance(2100); f.measure(6); await f.update();
  f.advance(1100); f.permission(false); f.measure(0); await f.update();
  f.advance(initial.probe.deadlineAt - f.now + 1000); f.measure(0); await f.update();
  const after = f.item().identification;
  assert.equal(after.id, initial.id);
  assert.equal(after.attempt, initial.attempt);
  assert.equal(after.probe.deadlineAt, initial.probe.deadlineAt);
  assert.equal(after.probe.returnStartAt, initial.probe.returnStartAt);
  assert.equal(after.probe.returnSupersededAt, undefined);
  assert.equal(f.item().controller.status().currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(starts(f).length, 1);
  f.advance(1100); f.permission(true); await f.update();
  assert.equal(starts(f).length, 1, 'Finishing the original probe never grants another Start');
  assert.equal(f.item().identification.id, initial.id);
  assert.equal(f.item().identification.probe.deadlineAt, initial.probe.deadlineAt);
});

test('a SYS hold cannot grant control through a newly enabled native charging schedule', async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true });
  f.advance(2200); f.permission(false); await f.update();
  f.schedules.rev++;
  f.schedules.jobs.push({ id: 5, enable: true, timespec: '0 0 8 * * *',
    calls: [{ method: 'Boolean.Set', params: { owner: 'service:0', role: 'start_charging', value: true } }] });
  f.advance(1100); await f.update();
  assert.equal(f.item().controller.status().snapshot.nativeScheduleActive, true);
  assert.equal(f.item().controller.status().manual?.kind, 'schedule');
  f.advance(1100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'schedule');
  assert.equal(starts(f).length, 0);
  assert.equal(f.writes.filter(row => row.method === 'Schedule.Update').length, 0);
});

test('unknown native permission cannot release a durable SYS false hold', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  f.advance(1100); f.permission(null); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.item().controller.status().snapshot.controlReady, false);
  assert.equal(starts(f).length, 1);
  assert.equal(f.item().vehicleMatch, null);
});

test('an initial already-false SYS setting is not a witnessed device hold on a new automatic connection', async t => {
  const f = await fixture(t, { vehicleFeed: false });
  f.fields.start_charging.source = 'sys';
  await f.update(); await f.reconnect(); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(f.fields.start_charging.value, true);
  assert.equal(starts(f).length, 1);
  assert.equal(currentWrites(f).length, 0);
});

test('Use automatic preserves a witnessed SYS hold instead of overriding the device Stop', async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true });
  f.advance(2200); f.permission(false); await f.update();
  const view = f.runtime.views().find(row => row.id === 'charger2');
  await f.runtime.useAutomatic('charger2', { association: view.association, sessionId: view.request.sessionId,
    revision: view.request.revision, controlRevision: view.controls.revision, takeoverToken: view.control.takeover.token });
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(starts(f).length, 0);
});

test('unconsumed SYS true-to-false history cannot preserve owned-pause proof after observation freshness expires', async t => {
  const f = await ownedPauseFixture(t), original = structuredClone(f.controller.status().owned);
  f.advance(2100); f.permission(true);
  f.advance(1100); f.permission(false);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 2);
  f.advance(30_000); f.measure(0); await f.update();
  const after = f.controller.status();
  assert.equal(after.pauseConfirmed, false, 'Fresh final zero cannot erase the witnessed interruption during the old pause');
  assert.equal(after.identification.pauseUntil, original.startAt);
  assert.equal(starts(f).length, 1);
});

test('a confirmed unplug ends the old SYS hold without granting its authority to a new physical connection', async t => {
  const f = await ordinaryFixture(t, { initiallyPermitted: true });
  const previousSession = f.item().controller.status().session.sessionId;
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().devicePermissionHeld, true);
  f.advance(1100); f.fields.work_state = { value: 'charger_free', at: f.now };
  await f.adapter.refresh({ force: true }); await f.update();
  assert.equal(f.item().controller.status().session.connected, false);
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(starts(f).length, 0);
  await f.reconnect(); await f.update();
  assert.notEqual(f.item().controller.status().session.sessionId, previousSession);
  assert.equal(f.item().controller.status().devicePermissionHeld, false);
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(starts(f).length, 1, 'Only the new confirmed connection supplies automatic takeover authority');
});

test('restart cannot clear a saved SYS hold using cached true readback before current-generation readiness', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  const held = structuredClone(f.item().controller.status().deviceHold);
  f.advance(1100); f.permission(true); await f.adapter.refresh({ force: true });
  const cached = structuredClone(f.adapter.snapshot().fields.start_charging);
  assert.equal(cached.value, true);
  assert.equal(cached.commandSource, 'sys');
  assert.ok(cached.readback.requestedAt >= held.receivedAt);
  assert.equal(f.adapter.snapshot().controlReady, true);
  // The adapter received true, but the controller has not committed hold
  // clearance. A restart may recover those same cached clocks while offline.
  f.disconnectBroker(); await f.restart();
  const unready = f.item().controller.status();
  assert.equal(unready.snapshot.controlReady, false);
  assert.equal(unready.snapshot.fields.start_charging.value, true);
  assert.deepEqual(unready.snapshot.fields.start_charging.readback, cached.readback);
  assert.deepEqual(unready.deviceHold, held);
  assert.equal(unready.devicePermissionHeld, true);
  assert.equal(starts(f).length, 1);
  f.advance(1000); const reconnectedAt = f.now;
  await f.reconnectBroker(); await f.update();
  const current = f.item().controller.status();
  assert.equal(current.snapshot.controlReady, true);
  assert.ok(current.snapshot.fields.start_charging.readback.requestedAt >= reconnectedAt);
  assert.equal(current.devicePermissionHeld, false);
  assert.equal(starts(f).length, 1);
});
