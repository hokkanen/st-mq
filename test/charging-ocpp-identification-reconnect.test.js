import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { normalizeScheduleState } from '../src/charging/easee.js';
import { withReportDatabase } from './helpers/report-database.js';

const START = Date.parse('2026-10-05T12:00:00Z'), MINUTE = 60_000;
const SCOPE = 'd'.repeat(64), TOPIC = 'synthetic/reconnect/bmw';
const RELEASE_AT = START + 60 * MINUTE;

// Production runtime, BMW ingress, OCPP adapter and controller. Only the wire,
// clock and economic plan are synthetic; transaction confirmation is supplied
// only after asserting the controller has actually authorized the initial start.
async function fixture(t) {
  let now = START, runtime, permission = null, authority = true;
  let connected = true, online = true, status = 'Preparing', statusAt = START;
  let transactionId = null, transactionStartedAt = null, powerKw = 0, powerAt = START;
  let connectionId = 'synthetic-reconnect-socket';
  let app = { enabled: true, enabledAt: START, stopped: false, stopAt: START,
    controlKnown: true, faulted: false, authorizationBlocked: false,
    schedule: normalizeScheduleState({ enabled: 'none' }) };
  const data = new Map(), profiles = new Map(), commands = [];
  const store = withReportDatabase({
    getState: key => structuredClone(data.get(key)),
    setState: (key, value) => data.set(key, structuredClone(value)),
  }, t);
  const config = { input: 'mqtt', connections: {
    mqtt: { address: 'mqtt://reconnect.invalid', user: 'synthetic' },
    easee: { charger_id: 'synthetic-reconnect-charger', equalizer_id: 'synthetic-reconnect-meter' },
    teslamate: { enabled: false },
  }, charging: { vehicles: { bmw: { mqttTopic: TOPIC } }, chargers: { charger2: { enabled: false } } } };
  const activeProfiles = () => [...profiles.values()].filter(profile => profile.transactionId === transactionId
    && Date.parse(profile.validFrom) <= now && Date.parse(profile.validTo) > now);
  const snapshot = () => ({ transport: 'ocpp', scope: SCOPE, connectionId, readAt: now, online,
    connectorStatus: status, statusAt, transactionId, transactionStartedAt,
    transactionConfirmed: transactionId !== null, pluggedIn: connected, powerKw, powerAt,
    appControl: app && { ...structuredClone(app), readAt: now },
    limits: { chargerA: 16, cableA: 32, circuitA: [16, 16, 16] },
    supply: { voltageV: [230, 230, 230], observationTimes: { voltage: [powerAt, powerAt, powerAt] } } });
  const adapter = createOcppScheduleAdapter({ scope: SCOPE, clock: () => now,
    canControl: () => authority, readSnapshot: async () => snapshot(),
    takeoverNative: async () => assert.fail('Clean native instructions do not need a takeover write'),
    isCurrent: (value, { requireTransaction = true, unchangedStatus = false } = {}) => online
      && value.connectionId === connectionId && (!requireTransaction || value.transactionId === transactionId)
      && (!unchangedStatus || value.statusAt === statusAt && value.connectorStatus === status),
    setStartPermission: (value, options) => { permission = value ? { snapshot: structuredClone(value), ...options } : null; },
    request: async (action, payload, options) => {
      assert.equal(options.guard(), true, 'Every wire operation retains current authority');
      assert.equal(options.beforeSend?.() ?? true, true);
      commands.push({ action, payload: structuredClone(payload), at: now });
      if (action === 'SetChargingProfile') {
        assert.notEqual(transactionId, null, 'No profile may precede transaction confirmation');
        assert.equal(payload.csChargingProfiles.transactionId, transactionId);
        profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles));
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      assert.equal(action, 'GetCompositeSchedule');
      const expiry = Math.max(0, ...activeProfiles().map(profile => Date.parse(profile.validTo)));
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(), chargingSchedule: {
        chargingRateUnit: 'A', duration: payload.duration,
        chargingSchedulePeriod: [{ startPeriod: 0, limit: activeProfiles().length ? 0 : 16 },
          ...(expiry > now && expiry < now + payload.duration * 1000
            ? [{ startPeriod: (expiry - now) / 1000, limit: 16 }] : [])] } };
    } });
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, config, store, clock: () => now, canControl: () => authority });
    const instance = runtime; t.after(() => instance.close());
    runtime.tick = () => {};
    runtime.scheduleStreamReconcile = () => {};
    runtime.pricesInitialized = true;
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      runtime.chargers.charger1.plan = { id: 'synthetic-reconnect-economic-wait', feasible: true,
        startAt: RELEASE_AT, deadlineAt: START + 8 * 60 * MINUTE,
        periods: [{ startAt: RELEASE_AT, endAt: null }] };
    };
    if (!data.has('charging:mqtt')) {
      runtime.chargers.charger1.controls.enabled = true;
      runtime.refreshSettings();
    }
    await runtime.setAdapter('charger1', adapter);
    runtime.updatePlan();
  };
  const update = async () => {
    await runtime.reconcile('charger1');
    runtime.telemetry(now);
    return runtime.chargers.charger1.controller.status();
  };
  await create();
  const f = { get runtime() { return runtime; }, get now() { return now; },
    get item() { return runtime.chargers.charger1; }, get permission() { return permission; },
    get startAllowed() { return Boolean(permission && permission.until > now && permission.guard()); },
    commands, data, profiles, update,
    advance(ms) { now += ms; powerAt = now; },
    native(value) { app = value === null ? null : { ...app, ...value }; },
    source(value) {
      if ('online' in value) online = value.online;
      if ('connected' in value) connected = value.connected;
      if ('status' in value) status = value.status;
      if ('statusAt' in value) statusAt = value.statusAt;
      if ('powerKw' in value) powerKw = value.powerKw;
      if ('powerAt' in value) powerAt = value.powerAt;
    },
    authority(value) { authority = value; },
    publishBmw(values, measuredAt = now) {
      runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
      assert.equal(runtime.receiveSoc(TOPIC, JSON.stringify({ provider: 'bmw-cardata', ...values,
        measuredAt, readingId: `synthetic-reconnect-report-${measuredAt}`,
        fields: Object.fromEntries(Object.keys(values).map(key => [key,
          { measuredAt, readingId: `synthetic-reconnect-${key}-${measuredAt}` }])) }), {}, now), true);
    },
    async disconnect() {
      const oldConnectedAt = runtime.chargers.charger1.controller.status().session.connectedAt;
      now += 1000; connected = false; status = 'Available'; statusAt = powerAt = now; powerKw = 0;
      transactionId = transactionStartedAt = null;
      assert.equal(runtime.receiveEaseeObservation({ id: 109, value: 1, previousValue: 2,
        previousMeasuredAt: oldConnectedAt, measuredAt: now, receivedAt: now }), true);
      await update();
      assert.equal(f.item.controller.status().vehicleDisconnect.awaitingConnection, true);
      assert.equal(f.startAllowed, false);
    },
    reconnect() { now += 1000; connected = true; status = 'Preparing'; statusAt = powerAt = now; },
    beginTransaction() {
      assert.equal(f.startAllowed, true, 'A charger cannot invent the transaction needed to obtain initial start permission');
      now += 1000; transactionId = 8; transactionStartedAt = now;
      status = 'Charging'; statusAt = powerAt = now; powerKw = 7;
    },
    confirmStop() {
      assert.ok(activeProfiles().length, 'Physical stop follows a sent, accepted zero-current profile');
      now += 1000; status = 'SuspendedEVSE'; statusAt = powerAt = now; powerKw = 0;
    },
    async restart({ savedDisconnectPending = false } = {}) {
      const ownershipKey = runtime.ownershipKey('charger1');
      runtime.persist(); await runtime.close();
      assert.equal(permission, null, 'Shutdown revokes the old authorization');
      if (savedDisconnectPending) {
        // The previous implementation persisted the new physical session while
        // retaining this flag until a transaction that its own probe could not start.
        const saved = structuredClone(data.get(ownershipKey));
        saved.vehicleDisconnect.awaitingConnection = true;
        data.set(ownershipKey, saved);
      }
      connectionId += '-restart';
      await create();
    },
  };
  await update();
  await f.disconnect();
  return f;
}

test('BMW reconnect starts a bounded probe before a transaction, identifies from its stop, and returns to the economic wait', async t => {
  const f = await fixture(t);
  f.reconnect();
  f.publishBmw({ atHome: true, pluggedIn: true, charging: false, soc: 78 });
  const initial = await f.update();
  assert.equal(initial.session.transactionId, null);
  assert.equal(initial.session.connectedAt, f.now);
  assert.equal(f.item.identification?.phase, 'waiting');
  assert.equal(f.item.identification?.action, 'allow');
  assert.ok(f.item.identification?.probe);
  assert.equal(f.startAllowed, true, 'The bounded identification action authorizes startup during the future price wait');
  assert.equal(f.commands.length, 0, 'Startup permission does not fabricate transaction-specific control');
  assert.equal(f.permission.snapshot.transactionId, null);
  assert.ok(f.permission.until <= f.item.identification.probe.deadlineAt);
  const sessionId = f.item.request.sessionId, attempt = structuredClone(f.item.identification);

  f.beginTransaction();
  await f.update();
  assert.equal(f.item.controller.status().session.transactionId, 8);
  assert.equal(f.item.request.sessionId, sessionId);
  assert.equal(f.item.vehicleMatch, null, 'A charging start alone does not identify BMW');
  f.publishBmw({ charging: true });
  f.advance(1000);
  await f.update();
  assert.equal(f.item.identification.phase, 'pausing');
  assert.equal(f.startAllowed, false);
  const pause = f.commands.find(command => command.action === 'SetChargingProfile');
  assert.ok(pause);
  assert.equal(pause.payload.csChargingProfiles.transactionId, 8);
  assert.deepEqual(pause.payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod, [{ startPeriod: 0, limit: 0 }]);
  assert.equal(f.item.vehicleMatch, null, 'Accepted restriction alone does not prove a BMW response');

  f.confirmStop(); await f.update();
  assert.equal(f.item.controller.status().pauseConfirmed, true);
  f.publishBmw({ charging: false });
  f.advance(1000); await f.update();
  assert.equal(f.item.vehicleMatch?.id, 'bmw');
  assert.equal(f.item.identification.phase, 'completed');
  assert.equal(f.item.identification.id, attempt.id);
  assert.equal(f.item.request.sessionId, sessionId);
  assert.equal(f.item.controller.status().owned.startAt, RELEASE_AT);
  assert.equal(f.startAllowed, false, 'Identifying BMW returns to the original economic wait');
});

test('same physical connection restart preserves the one probe and its original startup deadline', async t => {
  const f = await fixture(t);
  f.reconnect(); f.publishBmw({ atHome: true, pluggedIn: true, charging: false });
  await f.update();
  assert.equal(f.startAllowed, true);
  const attempt = structuredClone(f.item.identification), sessionId = f.item.request.sessionId;
  f.advance(1000); await f.restart();
  f.publishBmw({ soc: 78 });
  await f.update();
  assert.equal(f.item.identification.id, attempt.id);
  assert.deepEqual(f.item.identification.probe, attempt.probe);
  assert.equal(f.item.request.sessionId, sessionId);
  assert.equal(f.startAllowed, true);
  assert.ok(f.permission.until <= attempt.probe.deadlineAt);
  f.advance(attempt.probe.deadlineAt - f.now);
  await f.update();
  assert.equal(f.startAllowed, false, 'No transaction or physical draw can renew the original safety allowance');
  f.advance(2 * MINUTE); await f.restart(); f.publishBmw({ soc: 77 }); await f.update();
  assert.equal(f.item.identification.id, attempt.id);
  assert.equal(f.item.identification.probe.deadlineAt, attempt.probe.deadlineAt);
  assert.equal(f.startAllowed, false);
  assert.equal(f.commands.length, 0);
});

test('an already observed stalled physical connection recovers after restart without another unplug or a new session', async t => {
  const f = await fixture(t);
  f.reconnect(); await f.update();
  const connectedAt = f.item.controller.status().session.connectedAt;
  const request = structuredClone(f.item.request), attempt = structuredClone(f.item.identification);
  assert.equal(attempt.probe, null);
  assert.equal(f.startAllowed, false);
  f.advance(1000); await f.restart({ savedDisconnectPending: true });
  f.publishBmw({ atHome: true, pluggedIn: true, charging: false });
  const recovered = await f.update();
  assert.equal(recovered.session.connectedAt, connectedAt);
  assert.equal(recovered.session.transactionId, null);
  assert.equal(recovered.vehicleDisconnect.awaitingConnection, false);
  assert.deepEqual(f.item.request, request);
  assert.equal(f.item.identification.attempt, 1, 'The stalled state had never spent a probing allowance');
  assert.equal(f.item.identification.probe.startedAt, f.now);
  assert.equal(f.startAllowed, true);
  assert.equal(f.commands.length, 0);
});

test('reconnect probe still requires new physical status, current native instructions and control authority', async t => {
  for (const restriction of ['old-status', 'offline', 'unknown-connection', 'fault', 'authorization',
    'unknown-native', 'read-only', 'manual-stop', 'native-schedule', 'no-feed']) {
    await t.test(restriction, async t => {
      const f = await fixture(t), disconnectedAt = f.now;
      f.reconnect();
      if (restriction === 'old-status') f.source({ statusAt: disconnectedAt });
      if (restriction === 'offline') f.source({ online: false });
      if (restriction === 'unknown-connection') f.source({ connected: null, status: 'Unavailable' });
      if (restriction === 'fault') f.native({ faulted: true });
      if (restriction === 'authorization') f.native({ authorizationBlocked: true });
      if (restriction === 'unknown-native') f.native(null);
      if (restriction === 'read-only') f.authority(false);
      if (['manual-stop', 'native-schedule'].includes(restriction)) {
        await f.update(); f.advance(1000);
        if (restriction === 'manual-stop') f.native({ stopped: true, stopAt: f.now });
        else f.native({ schedule: normalizeScheduleState({ enabled: 'daily', daily: { timezone: 'UTC',
          periods: [{ startTime: '01:00:00', stopTime: '03:00:00', maximumAmps: 16 }] } }) });
      }
      if (restriction !== 'no-feed') f.publishBmw({ atHome: true, pluggedIn: true, charging: false });
      await f.update();
      assert.equal(f.startAllowed, false);
      assert.equal(f.commands.length, 0);
      assert.equal(f.item.vehicleMatch, null);
    });
  }
});
