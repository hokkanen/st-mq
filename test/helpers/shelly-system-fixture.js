import { shellyComponentReply } from './shelly-component-reply.js';
import { admitChargingObservation } from './charging-observation.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/store.js';
import { ChargingRuntime } from '../../src/charging/runtime.js';
import { createShellyEvseAdapter } from '../../src/charging/shelly-evse.js';
import { createChargingTeslaCapture } from '../../src/charging/teslamate.js';
import { chargingConfiguration } from '../../src/charging/config.js';
import { withReportDatabase } from './report-database.js';

export const START = 1_800_000_000_000, DEVICE = 'synthetic-system-evse', PREFIX = 'synthetic/system/evse';
const COMPONENTS = { current_limit: ['Number', 200], start_charging: ['Boolean', 201],
  work_state: ['Enum', 202], phase_info: ['Object', 203] };

// Only the EVSE/broker and economic result are synthetic. Permission events pass
// through the real MQTT parser, persistent queue, controller and runtime matcher.
export async function fixture(t, { initiallyPermitted = false, autoCharge = false, startOutcome = 'confirmed', startEcho = null,
  stopEcho = null, stopOutcome = 'confirmed', durableStorage = false,
  automatic = true, vehicleFeed = true, limiterEnabled = false, bmwTopic = null, nativeClockOffsetMs = null,
  ackProcessingDelayMs = 0 } = {}) {
  let now = START, measuredCurrentA = 0, runtime, newerStartInjected = false, pendingStartEcho = null,
    planStartAt = START, ownershipSaveFailure = false, delayedStart = false, roundTailDelayMs = 0;
  let bootAt = nativeClockOffsetMs === null ? null : START - 100_000;
  let commandClockAvailable = true;
  const nativeAt = at => at + (nativeClockOffsetMs ?? 0);
  const data = new Map(), writes = [], echoTrace = [], client = new EventEmitter();
  const schedules = { rev: 1, jobs: [] }, serviceStatus = { state: 'running' };
  const service = { id: 0, auto_balance: { enable: false }, auto_charge: autoCharge };
  const currentCapability = { access: 'crw' };
  const fields = { current_limit: { value: 16, at: Math.floor(nativeAt(START) / 1000) * 1000, source: 'rpc' },
    start_charging: { value: initiallyPermitted, at: Math.floor(nativeAt(START) / 1000) * 1000, source: 'rpc' },
    work_state: { value: 'charger_free', at: nativeAt(START - (nativeClockOffsetMs > 0 ? 1000 : 0)) } };
  const config = { input: 'mqtt', connections: {
    mqtt: { address: 'mqtt://synthetic-system.invalid', user: 'synthetic' },
    teslamate: { enabled: vehicleFeed, carId: '1', namespace: 'synthetic-system', homeGeofence: 'Home' },
  }, charging: { ...(bmwTopic ? { vehicles: { bmw: { mqttTopic: bmwTopic } } } : {}),
    chargers: { charger2: { enabled: true, deviceId: DEVICE, topicPrefix: PREFIX, limiterEnabled,
    mainFuseA: [25, 25, 25], marginA: [1, 1, 1], fallbackCurrentA: 12 } } } };
  const directory = durableStorage ? mkdtempSync(join(tmpdir(), 'stmq-shelly-identification-')) : null;
  const store = durableStorage ? new Store(join(directory, 'fixture.sqlite')) : { getState: key => structuredClone(data.get(key)),
    setState: (key, value) => {
      if (ownershipSaveFailure && key === runtime.ownershipKey('charger2')) throw Error('synthetic-ownership-save-failure');
      data.set(key, structuredClone(value));
    }, transaction: fn => fn(), event: () => 1 };
  if (!durableStorage) withReportDatabase(store, t);
  const writer = durableStorage ? new DatabaseSync(store.path) : null;
  if (writer) t.after(async () => {
    if (writer.isTransaction) writer.exec('ROLLBACK');
    await runtime?.close(); adapter.close(); writer.close(); await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const meter = () => ({ total_power: measuredCurrentA * .69, total_act_energy: 0,
    ...Object.fromEntries(['phase_a', 'phase_b', 'phase_c'].map(phase => [phase,
      { voltage: 230, current: measuredCurrentA, power: measuredCurrentA * .23 }])) });
  const components = () => Object.fromEntries(Object.keys(COMPONENTS).map(role => [role, { id: COMPONENTS[role][1], owner: 'service:0',
    access: role === 'current_limit' ? currentCapability.access : 'crw', min: 6, max: 16, meta: { ui: { step: 1 } },
    options: ['charger_free', 'charger_insert', 'charger_wait', 'charger_pause', 'charger_end', 'charger_charging'] }]));
  const status = role => {
      if (role === 'start_charging' && pendingStartEcho) {
        const echo = pendingStartEcho; pendingStartEcho = null;
        echo.readRequestedAt = now;
        // ACK has already arrived. During its correlated readback, the EVSE
        // publishes a value-only echo whose native clock is slightly behind
        // the application's dispatch clock. Receipt time remains independent.
        now += 140; echo.receivedAt = now;
        const notificationAt = echo.nativeAt + (echo.kind === 'late native notification' ? 2000 : 0);
        if (echo.kind === 'late native notification') { now += 2000; echo.receivedAt = now; }
        client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
          params: { ts: notificationAt / 1000, 'boolean:201': { value: echo.value,
            ...(echo.kind.startsWith('unknown source') ? { source: 'synthetic-unknown' } : {}) } } })), {});
        runtime?.telemetry(now);
        echo.event = structuredClone(adapter.snapshot().permissionEvents.at(-1));
        if (echo.kind === 'native clock boundary without current clock') commandClockAvailable = false;
        if (echo.kind === 'native clock boundary with SYS interruption') {
          for (const value of [false, true]) {
            now += 1100;
            fields.start_charging = { value, at: Math.floor(nativeAt(now) / 1000) * 1000, source: 'sys' };
            fields.work_state = { value: value ? 'charger_wait' : 'charger_pause', at: nativeAt(now) };
            client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
              params: { ts: nativeAt(now) / 1000, 'boolean:201': { value, source: 'sys' } } })), {});
          }
        }
        if (echo.kind === 'external Stop during readback' || echo.kind === 'external Enable during readback') {
          const value = echo.kind === 'external Enable during readback';
          now += 17;
          fields.start_charging = { value, at: Math.floor(now / 1000) * 1000, source: 'rpc' };
          fields.work_state = { value: value ? 'charger_wait' : 'charger_pause', at: now };
          client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
            params: { ts: now / 1000, 'boolean:201': { value, source: 'rpc' } } })), {});
          echo.externalStopAt = now;
        }
        now += 265; echo.readReceivedAt = now;
      }
      if (role === 'start_charging' && fields[role].value === true && startOutcome === 'newer native instruction' && !newerStartInjected) {
        // A different RPC client repeats Start after our acknowledgement but
        // before the first confirmation query. The returned clock tells them apart.
        newerStartInjected = true; now += 1000; fields[role].at = Math.floor(now / 1000) * 1000;
      }
      return role === 'phase_info' ? { value: meter(), last_update_ts: now / 1000 }
        : { value: role === 'start_charging' && (fields[role].value ? startOutcome : stopOutcome) === 'unknown readback'
          && writes.some(row => row.role === role && row.value === fields[role].value)
          ? null : fields[role].value, last_update_ts: fields[role].at / 1000,
          ...(fields[role].source !== undefined ? { source: fields[role].source } : {}) };
  };
  client.subscribe = (topics, _options, done) => done(null, topics.map(topic => ({ topic, qos: 0 })));
  client.publish = (_topic, payload, _options, done) => {
    const frame = JSON.parse(payload), role = frame.params.role;
    let result;
    if (frame.method === 'Sys.GetStatus') result = bootAt === null ? {} : {
      uptime: Math.floor((now - bootAt) / 1000), unixtime: Math.floor(nativeAt(now) / 1000) };
    else if (frame.method === 'Shelly.GetDeviceInfo') result = { id: DEVICE, model: 'synthetic-model', fw_id: 'synthetic-firmware' };
    else if (frame.method === 'Shelly.GetComponents') result = shellyComponentReply(frame.params.keys, { service, serviceStatus, components: components(), status });
    else if (frame.method === 'Service.GetConfig') result = structuredClone(service);
    else if (frame.method === 'Service.GetStatus') result = structuredClone(serviceStatus);
    else if (frame.method === 'Schedule.List') result = structuredClone(schedules);
    else if (frame.method.endsWith('.GetConfig')) result = components()[role];
    else if (frame.method.endsWith('.Set')) {
      writes.push({ method: frame.method, ...frame.params, at: now });
      if (role === 'start_charging' && frame.params.value === true && startOutcome === 'rejected') {
        done?.(); queueMicrotask(() => client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({
          id: frame.id, src: DEVICE, dst: frame.src, error: { code: -1, message: 'synthetic refusal' } })), {}));
        return;
      }
      const echoKind = frame.params.value ? startEcho : stopEcho;
      if (role === 'start_charging' && echoKind) {
        pendingStartEcho = { dispatchedAt: now, nativeAt: echoKind === 'unknown source inside ACK interval' ? now + 50
          : nativeClockOffsetMs === null ? now - (echoKind === 'different native second' ? 1083 : 83) : nativeAt(now),
          value: frame.params.value, kind: echoKind };
        echoTrace.push(pendingStartEcho);
      }
      now += 100;
      fields[role] = { value: frame.params.value, at: Math.floor(nativeAt(now) / 1000) * 1000, source: 'rpc' };
      if (role === 'start_charging') fields.work_state = { value: frame.params.value ? 'charger_wait' : 'charger_pause', at: fields[role].at };
      if (role === 'start_charging' && frame.params.value === true && startOutcome === 'delayed system readback') {
        delayedStart = true;
        fields.start_charging = { value: false, at: START, source: 'rpc' };
      }
      if (role === 'start_charging' && (frame.params.value ? startOutcome : stopOutcome) === 'no acknowledgement') {
        // Publication failed after the synthetic device applied the command;
        // the application cannot infer whether delivery or execution occurred.
        done?.(Error('synthetic uncertain publication')); return;
      }
      result = null;
    } else result = status(role);
    done?.(); queueMicrotask(() => {
      if (frame.method === 'Sys.GetStatus' && nativeClockOffsetMs !== null) now += 73;
      if (frame.method === 'Schedule.List' && roundTailDelayMs) { now += roundTailDelayMs; roundTailDelayMs = 0; }
      if (role === 'start_charging' && frame.method.endsWith('.Set') && pendingStartEcho)
        pendingStartEcho.acknowledgedAt = now;
      client.emit('message', `${frame.src}/rpc`, Buffer.from(JSON.stringify({ id: frame.id, src: DEVICE, dst: frame.src, result })), {});
      if (role === 'start_charging' && frame.method.endsWith('.Set')) now += ackProcessingDelayMs;
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
      admitChargingObservation(runtime, now);
      runtime.chargers.charger2.plan = { id: 'synthetic-system-plan', feasible: true,
        startAt: planStartAt, deadlineAt: START + 8 * 3600_000, periods: [{ startAt: planStartAt, endAt: null }] };
    };
    runtime.teslaCapture = vehicleFeed ? capture : null;
    await runtime.setAdapter('charger2', adapter);
  };
  const adapter = createShellyEvseAdapter({ config: chargingConfiguration(config.charging).chargers.charger2,
    broker: config.connections.mqtt, client, store, clock: () => now, monotonicClock: () => now - START, canControl: () => true,
    engine: { recorder: { recordEnergy() {}, energyGap() {}, flush() {} } } });
  t.after(() => adapter.close());
  client.emit('connect'); client.emit('message', `${PREFIX}/online`, Buffer.from('true'), {}); await adapter.refresh();
  publishTesla({ healthy: true, geofence: 'Home', plugged_in: true, charging_state: 'Stopped',
    charger_phases: 3, charger_power: 0, charger_actual_current: 0 });
  const commandClock = adapter.commandClock?.bind(adapter);
  if (commandClock) adapter.commandClock = () => commandClockAvailable ? commandClock() : null;
  await create();
  return { get now() { return now; }, get runtime() { return runtime; }, adapter, fields, writes, schedules, echoTrace, store, writer,
    service, serviceStatus, currentCapability, publishTesla,
    setCommandClockAvailable(value) { commandClockAvailable = value; },
    get delayedStart() { return delayedStart; },
    setPlanStartAt(at) { planStartAt = at; },
    delayRoundEnd(ms) { roundTailDelayMs = ms; },
    failOwnershipSave(value) { ownershipSaveFailure = value; },
    item: () => runtime.chargers.charger2,
    advance(ms) { now += ms; },
    setBootAt(at) { bootAt = at; },
    meterNotification() {
      client.emit('message', `${PREFIX}/events/rpc`, Buffer.from(JSON.stringify({ src: DEVICE, method: 'NotifyStatus',
        params: { ts: now / 1000, 'object:203': { value: meter(), last_update_ts: now / 1000 } } })), {});
    },
    measure(currentA) { measuredCurrentA = currentA; fields.work_state = {
      value: currentA > 0 ? 'charger_charging' : fields.start_charging.value ? 'charger_wait' : 'charger_pause', at: now }; },
    async update() { await runtime.reconcile('charger2'); return runtime.chargers.charger2.controller.status(); },
    async reconnect({ startDelayMs = 0 } = {}) {
      now += 1000; fields.work_state = { value: 'charger_insert', at: nativeAt(now) };
      if (nativeClockOffsetMs > 0) now += nativeClockOffsetMs + 50;
      await adapter.refresh(); now += startDelayMs; return this.update();
    },
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    permission(value, source = 'sys', { omitSource = false, eventAt = now } = {}) {
      // With an ahead-of-controller native clock, model delivery latency so
      // the observation has actually reached its source instant at admission.
      if (nativeClockOffsetMs > 0 && eventAt > now) now = eventAt + 50;
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

export async function startedFixture(t, options) {
  const f = await fixture(t, options);
  await f.update(); await f.reconnect({ startDelayMs: options?.startDelayMs ?? 0 }); await f.update();
  assert.equal(f.item().controller.status().currentTest?.phase, 'active', options?.nativeClockOffsetMs === undefined
    ? undefined : JSON.stringify({ currentTest: f.item().controller.status().currentTest,
      clock: f.adapter.commandClock?.(), field: f.adapter.snapshot().fields.current_limit }));
  assert.equal(f.fields.current_limit.value, 6);
  assert.equal(f.fields.start_charging.value, true);
  return f;
}
export async function ownedPauseFixture(t, options = {}) {
  const f = await startedFixture(t, options);
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
    savedState() { return structuredClone(saved); },
    endRequest() { request = null; } });
}

