import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { chargingConfiguration } from '../src/charging/config.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = 1_800_000_000_000, DEVICE = 'synthetic-startup-evse', PREFIX = 'synthetic/startup/evse';
const COMPONENTS = { current_limit: ['Number', 200], start_charging: ['Boolean', 201],
  work_state: ['Enum', 202], phase_info: ['Object', 203] };

// Only the EVSE/broker and economic result are synthetic. Permission events pass
// through the real MQTT parser, persistent queue, controller and runtime matcher.
async function fixture(t, { initiallyPermitted = false, autoCharge = false, startOutcome = 'confirmed', startEcho = null } = {}) {
  let now = START, measuredCurrentA = 0, runtime, newerStartInjected = false, pendingStartEcho = null;
  const data = new Map(), writes = [], echoTrace = [], client = new EventEmitter();
  const schedules = { rev: 1, jobs: [] }, serviceStatus = { state: 'running' };
  const service = { id: 0, auto_balance: { enable: false }, auto_charge: autoCharge };
  const currentCapability = { access: 'crw' };
  const fields = { current_limit: { value: 16, at: START, source: 'rpc' },
    start_charging: { value: initiallyPermitted, at: START, source: 'rpc' },
    work_state: { value: 'charger_free', at: START } };
  const config = { input: 'mqtt', connections: {
    mqtt: { address: 'mqtt://synthetic-startup.invalid', user: 'synthetic' },
    teslamate: { enabled: true, carId: '1', namespace: 'synthetic-startup', homeGeofence: 'Home' },
  }, charging: { chargers: { charger2: { enabled: true, deviceId: DEVICE, topicPrefix: PREFIX, limiterEnabled: false } } } };
  const store = { getState: key => structuredClone(data.get(key)),
    setState: (key, value) => data.set(key, structuredClone(value)), transaction: fn => fn(), event: () => 1 };
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
    clock: () => now, brokerIdentity: 'synthetic-startup-broker' });
  capture.setConnected(true); t.after(() => capture.close());
  const publishTesla = values => {
    for (const [key, value] of Object.entries(values)) assert.equal(capture.receive(
      `teslamate/synthetic-startup/cars/1/${key}`, String(value), { retain: false }, now), true);
  };
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    const instance = runtime; t.after(() => instance.close());
    runtime.tick = () => {}; runtime.pricesInitialized = true;
    runtime.chargers.charger2.controls.enabled = true; runtime.refreshSettings();
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      runtime.chargers.charger2.plan = { id: 'synthetic-startup-plan', feasible: true,
        startAt: START, deadlineAt: START + 8 * 3600_000, periods: [{ startAt: START, endAt: null }] };
    };
    runtime.teslaCapture = capture;
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
    removeSavedStartup() {
      const key = runtime.ownershipKey('charger2'), saved = structuredClone(data.get(key));
      delete saved.startup; data.set(key, saved);
    },
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
  assert.equal(after.startup?.expiresAt, before.startup?.expiresAt);
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
  assert.notEqual(f.item().controller.status().startup?.phase, 'armed');
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

test('fresh Shelly startup preserves its confirmed 6 A identification attempt through device off/on', async t => {
  const f = await startedFixture(t);
  const before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  assert.equal(before.currentTest?.phase, 'active');
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.fields.start_charging.value, true);
  assert.deepEqual(f.writes.map(row => [row.role, row.value]), [['current_limit', 6], ['start_charging', true]]);
  assert.equal(f.item().vehicleMatch, null, 'Accepted Start and 6 A setting do not establish identity');
  f.advance(2200); f.permission(false);
  f.advance(1480); f.permission(true, 'sys', { omitSource: true });
  await f.update();
  const after = f.item().controller.status();
  assert.equal(after.manual, null, 'The bounded device startup pair does not become an external instruction');
  assert.equal(after.currentTest.phase, 'active');
  assert.equal(after.currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'Observing autonomous recovery must not send a second Start');
});

test('Shelly startup off/on across reconciles preserves the attempt without issuing another Start', async t => {
  const f = await startedFixture(t), before = f.item().controller.status(), attempt = structuredClone(f.item().identification);
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.fields.start_charging.value, false, 'The device Stop remains physically effective while awaiting its recovery');
  assert.equal(f.fields.current_limit.value, 6, 'The unexpired comparison keeps its confirmed lower pilot');
  assert.equal(f.item().controller.status().startupPending, true);
  assert.equal(f.item().controller.status().snapshot.stopped, true, 'Pending startup never falsifies raw native permission');
  assert.equal(f.item().controller.status().snapshot.manualStop, true);
  assert.equal(f.item().identification.completedAt, null, 'An intermediate startup Stop does not end the original attempt');
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().vehicleMatch, null, 'No vehicle identity is inferred from startup');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
  f.advance(1480); f.permission(true, 'sys', { omitSource: true }); await f.update();
  const after = f.item().controller.status();
  assert.equal(after.manual, null);
  assert.equal(after.startupPending, false);
  assert.equal(after.currentTest.phase, 'active');
  assert.equal(after.currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('the preserved Shelly startup attempt still needs and accepts independent vehicle current evidence', async t => {
  const f = await startedFixture(t), attempt = structuredClone(f.item().identification);
  f.advance(2200); f.permission(false); f.advance(1480); f.permission(true, 'sys', { omitSource: true }); await f.update();
  assert.equal(f.item().vehicleMatch, null);
  f.advance(6000);
  f.publishTesla({ charging_state: 'Charging', charger_actual_current: 6, charger_power: 4.14, healthy: true });
  f.runtime.telemetry(f.now);
  assert.equal(f.item().vehicleMatch, null, 'The vehicle response alone cannot replace physical charging evidence');
  f.measure(6); await f.update();
  f.advance(5000); await f.update();
  assert.equal(f.item().vehicleMatch?.id, 'tesla');
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.attempt, attempt.attempt);
  assert.equal(f.item().identification.phase, 'completed');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('read-only telemetry between a partial startup Stop and reconciliation cannot cancel the attempt', async t => {
  const f = await startedFixture(t), attempt = structuredClone(f.item().identification), writes = f.writes.length;
  f.advance(2200); f.permission(false);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1);
  assert.equal(f.item().controller.status().startupPending, true);
  f.runtime.telemetry(f.now);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.completedAt, null);
  assert.equal(f.item().identification.phase, attempt.phase);
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.adapter.snapshot().permissionEvents.length, 1, 'A read-only preview never consumes the saved native event');
  assert.equal(f.writes.length, writes);
  await f.update();
  f.advance(1480); f.permission(true, 'sys', { omitSource: true }); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  assert.equal(f.item().identification.id, attempt.id);
  assert.equal(f.item().identification.completedAt, null);
});

test('a native service fault fences a pending Shelly startup without an automatic restart', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().startupPending, true);
  f.serviceStatus.errors = ['synthetic-fault'];
  f.advance(100); await f.update();
  assert.equal(f.item().controller.status().startupPending, false);
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
  delete f.serviceStatus.errors;
  f.advance(100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable', 'Clearing a fault cannot reacquire the cancelled exception');
  assert.equal(f.item().controller.status().startup?.phase, 'cancelled');
  assert.equal(f.item().controller.status().startupPending, false);
  assert.equal(f.item().identification.phase, 'inconclusive');
});

for (const [offSource, onSource] of [['rpc', 'sys'], ['sys', 'rpc'], [null, 'sys'], ['sys', null]])
test(`Shelly startup preserves native instruction priority for ${offSource ?? 'unknown'} off and ${onSource ?? 'unknown'} on`, async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false, offSource);
  f.advance(1480); f.permission(true, onSource);
  await f.update();
  const after = f.item().controller.status();
  assert.equal(after.manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'An observed native instruction never provokes another automatic Start');
});

test('Shelly device off/on without an application Start remains a native instruction', async t => {
  const f = await startedFixture(t, { initiallyPermitted: true });
  assert.equal(f.writes.filter(row => row.role === 'start_charging').length, 0);
  f.advance(2200); f.permission(false);
  f.advance(1480); f.permission(true);
  await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.writes.filter(row => row.role === 'start_charging').length, 0);
});

test('Shelly startup Stop that does not recover expires without a Start or renewed deadline', async t => {
  const f = await startedFixture(t), before = f.item().controller.status();
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().startupPending, true);
  assert.equal(f.fields.current_limit.value, 6);
  f.advance(10_001); await f.update();
  const after = f.item().controller.status();
  assert.equal(after.startupPending, false);
  assert.equal(after.manual?.kind, 'stop');
  assert.equal(f.fields.start_charging.value, false);
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(after.currentTest.expiresAt, before.currentTest.expiresAt);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('an external RPC Stop during a Shelly startup pair immediately retains native priority', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().startupPending, true);
  f.advance(300); f.permission(false, 'rpc'); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'stop');
  assert.equal(f.item().controller.status().startupPending, false);
  assert.equal(f.fields.start_charging.value, false);
  f.advance(1180); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('a second device off/on pair does not reuse the first Shelly startup exception', async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); f.advance(1480); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual, null);
  f.advance(100); f.permission(false); f.advance(100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const boundary of ['deadline', 'native current', 'equal native current', 'source-only native current', 'schedule revision', 'broker reconnect', 'application restart', 'native Auto charge', 'Automatic OFF', 'connection older than a minute'])
test(`Shelly startup exception is fenced by ${boundary}`, async t => {
  const f = await startedFixture(t, { autoCharge: boundary === 'native Auto charge',
    startDelayMs: boundary === 'connection older than a minute' ? 60_001 : 0 });
  f.advance(2200); f.permission(false);
  if (boundary === 'deadline') f.advance(10_001);
  if (boundary === 'native current' || boundary === 'equal native current') {
    f.advance(100); f.current(boundary === 'native current' ? 8 : 6);
  }
  if (boundary === 'source-only native current') f.current(6, 'ws', { sourceOnly: true });
  if (boundary === 'schedule revision') f.schedules.rev++;
  if (boundary === 'broker reconnect') await f.reconnectBroker();
  if (boundary === 'application restart') await f.restart();
  if (boundary === 'Automatic OFF') { f.item().controls.enabled = false; f.runtime.refreshSettings(); }
  f.advance(1480); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.item().controller.status().startupPending, false);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const outcome of ['unknown readback', 'no acknowledgement'])
test(`Shelly identification Start with ${outcome} never arms a startup exception`, async t => {
  const f = await fixture(t, { startOutcome: outcome });
  await f.update(); await f.reconnect(); await f.update();
  const before = f.item().controller.status();
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'The failed confirmation follows an actual application Start request');
  assert.equal(before.startup ?? null, null);
  assert.equal(before.startupPending, false);
  f.advance(2200); f.permission(false); f.advance(1480); f.permission(true); await f.update();
  const after = f.item().controller.status();
  assert.equal(after.startup ?? null, null);
  assert.equal(after.startupPending, false);
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1,
    'Neither the startup pair nor failed confirmation retries an uncertain Start');
});

test('malformed saved Shelly startup scope is rejected before any mutation', async t => {
  const f = await startedFixture(t), before = f.writes.length;
  const saved = structuredClone(f.runtime.savedOwnership('charger2'));
  assert.equal(saved.startup.phase, 'armed');
  delete saved.startup.expiresAt;
  assert.throws(() => f.adapter.createController({ initialState: saved, clock: () => f.now,
    canControl: () => true }), /unsupported-shelly-ownership/);
  assert.equal(f.writes.length, before);
});

test('absent saved Shelly startup state does not borrow the existing Start after restart', async t => {
  const f = await startedFixture(t);
  f.removeSavedStartup(); await f.restart();
  f.advance(2200); f.permission(false); f.advance(1480); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().controller.status().startupPending, false);
  assert.equal(f.item().vehicleMatch, null);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

for (const boundary of ['service fault', 'current write capability', 'native balancing'])
test(`background polling of lost ${boundary} cannot revive the Shelly startup exception`, async t => {
  const f = await startedFixture(t);
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().startupPending, true);
  if (boundary === 'service fault') f.serviceStatus.errors = ['synthetic-fault'];
  if (boundary === 'current write capability') f.currentCapability.access = 'r';
  if (boundary === 'native balancing') f.service.auto_balance.enable = true;
  f.advance(100); await f.adapter.refresh({ force: true });
  assert.equal(f.item().controller.status().startupPending, false);
  if (boundary !== 'service fault') assert.equal(f.adapter.snapshot().identificationCurrentReady, false);
  delete f.serviceStatus.errors; f.currentCapability.access = 'crw'; f.service.auto_balance.enable = false;
  f.advance(100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().startup?.phase, 'cancelled');
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('background current source changes cannot disappear when value and native timestamp return unchanged', async t => {
  const f = await startedFixture(t), original = structuredClone(f.fields.current_limit);
  f.advance(2200); f.permission(false); await f.update();
  assert.equal(f.item().controller.status().startupPending, true);
  f.fields.current_limit.source = 'ws'; await f.adapter.refresh({ force: true });
  assert.equal(f.adapter.snapshot().fields.current_limit.commandSource, 'ws');
  assert.equal(f.item().controller.status().startupPending, false);
  f.fields.current_limit.source = 'rpc'; await f.adapter.refresh({ force: true });
  assert.deepEqual(f.fields.current_limit, original, 'Only source changed; value and native update second were held');
  f.advance(100); f.permission(true); await f.update();
  assert.equal(f.item().controller.status().startup?.phase, 'cancelled');
  assert.equal(f.item().controller.status().manual?.kind, 'enable');
  assert.equal(f.item().identification.phase, 'inconclusive');
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});

test('a newer native Start timestamp cannot arm startup as the application command', async t => {
  const f = await startedFixture(t, { startOutcome: 'newer native instruction' });
  const control = f.item().controller.status();
  assert.ok(f.fields.start_charging.at > control.permissionCommand.acceptedAt,
    'The native instruction is demonstrably newer than the acknowledged application Start');
  assert.equal(control.startup ?? null, null);
  assert.equal(control.startupPending, false);
  assert.equal(f.writes.filter(row => row.role === 'start_charging' && row.value === true).length, 1);
});
