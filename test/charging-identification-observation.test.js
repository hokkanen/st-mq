import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { delayedScheduleFor, easeeChargerTelemetry, normalizeScheduleState, scheduleFingerprint } from '../src/charging/easee.js';

const START = Date.parse('2026-09-25T09:00:00Z'), MINUTE = 60_000, FUTURE = START + 60 * MINUTE;

// Real runtime planning callback, vehicle ingestion, normalization and native
// controllers. Only device IO and the already-computed economic plan are fake;
// all command counts include every request the real controllers dispatch.
async function fixture(t, transport, vehicle = 'bmw', { retainedOnly = false, healthyTesla = true } = {}) {
  let now = START, runtime;
  const states = new Map(), writes = [], profiles = new Map();
  const store = { getState: key => structuredClone(states.get(key)),
    setState: (key, value) => states.set(key, structuredClone(value)) };
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-observation-charger', equalizer_id: 'synthetic-observation-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-observation' } },
  charging: { vehicles: { bmw: { mqttTopic: 'synthetic/observation/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const physical = { pluggedIn: true, enabled: true, charging: true, at: START,
    transactionId: 23, transactionStartedAt: START, manualEvent: null };
  let schedule = normalizeScheduleState({ enabled: 'none' });
  const tesla = { association: 'synthetic-observation-tesla', connected: vehicle === 'tesla', healthy: vehicle === 'tesla' && healthyTesla,
    pluggedIn: true, atHome: true, charging: true, actualPowerKw: 7, fields: {} };
  const scope = 'e'.repeat(64), connectionId = 'synthetic-observation-socket';
  const changePhysical = (charging, at = now) => { physical.charging = charging; physical.at = at; };
  const cloudSnapshot = () => {
    const mode = !physical.pluggedIn ? 1 : physical.charging ? 3 : 2;
    const reason = !physical.enabled ? 53 : schedule.enabled === 'none' ? 0 : 54;
    return { schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule), readAt: now,
      controlFingerprint: `synthetic-${physical.enabled}-${physical.pluggedIn}`, controlKnown: true,
      online: true, enabled: physical.enabled, pluggedIn: physical.pluggedIn, mode, modeAt: physical.at,
      reason, reasonAt: physical.at, manualStop: !physical.enabled, stopped: !physical.enabled,
      faulted: false, authorizationBlocked: false, powerKw: physical.charging ? 7 : 0, powerAt: now,
      disconnectedAt: physical.pluggedIn ? null : physical.at,
      limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] },
      observations: { 109: { value: mode, at: physical.at }, 120: { value: physical.charging ? 7 : 0, at: now } } };
  };
  const cloud = {
    normalize: easeeChargerTelemetry, read: async () => cloudSnapshot(),
    async installDelayed(input) {
      assert.equal(input.canMutate(), true);
      await input.beforeWrite(cloudSnapshot());
      writes.push({ action: 'install', startAt: input.startAt, requestedAt: now });
      schedule = normalizeScheduleState({ ...schedule, enabled: 'delayed', delayed: delayedScheduleFor(input, now) });
      now += 1000; changePhysical(false);
      return cloudSnapshot();
    },
    async clear(input) {
      assert.equal(input.canMutate(), true);
      writes.push({ action: 'clear' }); schedule = normalizeScheduleState({ ...schedule, enabled: 'none' });
      return cloudSnapshot();
    },
  };
  const native = createOcppScheduleAdapter({ scope, clock: () => now, canControl: () => true,
    isCurrent: (snapshot, { requireTransaction = true, unchangedStatus = false } = {}) => snapshot.connectionId === connectionId
      && (!requireTransaction || snapshot.transactionId === physical.transactionId)
      && (!unchangedStatus || snapshot.statusAt === physical.at
        && snapshot.connectorStatus === (!physical.pluggedIn ? 'Available' : physical.charging ? 'Charging' : 'SuspendedEVSE')),
    readSnapshot: async () => ({ transport: 'ocpp', scope, connectionId, online: true, readAt: now,
      pluggedIn: physical.pluggedIn, connectorStatus: !physical.pluggedIn ? 'Available'
        : physical.charging ? 'Charging' : 'SuspendedEVSE', statusAt: physical.at,
      transactionId: physical.pluggedIn ? physical.transactionId : null,
      transactionStartedAt: physical.pluggedIn ? physical.transactionStartedAt : null,
      transactionConfirmed: physical.pluggedIn,
      powerKw: physical.charging ? 7 : 0, powerAt: now, manualEvent: physical.manualEvent }),
    request: async (action, payload, options) => {
      assert.equal(options.guard(), true);
      if (action === 'SetChargingProfile') {
        assert.equal(options.beforeSend(), true);
        writes.push({ action, payload: structuredClone(payload), requestedAt: now });
        profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles));
        now += 1000; changePhysical(false);
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') {
        writes.push({ action, payload: structuredClone(payload) });
        return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      }
      assert.equal(action, 'GetCompositeSchedule');
      const current = [...profiles.values()].filter(row => row.transactionId === physical.transactionId
        && Date.parse(row.validFrom) <= now && Date.parse(row.validTo) > now);
      const releaseAt = Math.max(...current.map(row => Date.parse(row.validTo)));
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(),
        chargingSchedule: { chargingRateUnit: 'A', duration: payload.duration,
          chargingSchedulePeriod: [{ startPeriod: 0, limit: current.length ? 0 : 16 },
            ...(current.length && releaseAt < now + payload.duration * 1000
              ? [{ startPeriod: (releaseAt - now) / 1000, limit: 16 }] : [])] } };
    },
  });
  const publish = (values, at, retained = false) => {
    assert.equal(runtime.receiveSoc('synthetic/observation/bmw', JSON.stringify({ provider: 'bmw-cardata', ...values,
      fields: Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
        { measuredAt: at, readingId: `synthetic-${key}-${value}-${at}` }])) }), { retain: retained }, now), true);
  };
  const create = async () => {
    runtime = new ChargingRuntime({ engine: {}, store, config, clock: () => now });
    const current = runtime; t.after(() => current.close());
    // Drive reconciles explicitly so a test cannot pass due to timer ordering.
    runtime.tick = () => {};
    runtime.chargers.charger1.controls.enabled = true; runtime.refreshSettings();
    runtime.pricesInitialized = true;
    runtime.updatePlan = () => {
      runtime.telemetry(now);
      runtime.chargers.charger1.plan = { id: 'synthetic-economic-plan', feasible: true, startAt: FUTURE,
        periods: [{ startAt: FUTURE, endAt: null }] };
    };
    runtime.teslaCapture = { snapshot: () => structuredClone(tesla) };
    runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    if (vehicle === 'bmw') {
      if (!runtime.vehicleFeeds.bmw.reading)
        publish({ atHome: true, pluggedIn: true, charging: retainedOnly }, retainedOnly ? START : START - 60 * MINUTE, true);
      if (!retainedOnly) publish({ charging: true }, START);
    }
    await runtime.setAdapter('charger1', transport === 'cloud' ? cloud : native);
  };
  await create();
  return { get runtime() { return runtime; }, get now() { return now; }, writes, profiles, physical, tesla, publish,
    setNow: value => { now = value; },
    update: input => runtime.chargers.charger1.controller.update({ enabled: true, ...input }),
    view: () => runtime.telemetry(now).charger1.vehicle,
    async restart() { runtime.persist(); await runtime.close(); await create(); },
    async disconnect() { now += 1000; physical.pluggedIn = false; changePhysical(false); return this.update(); },
    reconnect() { now += 1000; physical.pluggedIn = true; physical.transactionId++;
      physical.transactionStartedAt = now; changePhysical(true); },
    async manualStop() {
      now += 1000; changePhysical(false);
      if (transport === 'cloud') physical.enabled = false;
      else physical.manualEvent = { id: 'synthetic-manual-stop', kind: 'stop', at: now, transactionId: physical.transactionId };
      return this.update();
    },
    foreignRestriction() {
      changePhysical(false);
      if (transport === 'cloud') schedule = normalizeScheduleState({ enabled: 'delayed',
        delayed: delayedScheduleFor({ startAt: FUTURE, maximumAmps: 16, timezone: 'UTC' }, now) });
      else profiles.set(999999999, { transactionId: physical.transactionId,
        validFrom: new Date(now).toISOString(), validTo: new Date(FUTURE + 60 * MINUTE).toISOString() });
    },
  };
}

for (const transport of ['cloud', 'ocpp']) {
  test(`${transport}: retained BMW inlet gets a bounded observation then identifies from the ordinary economic pause`, async t => {
    const f = await fixture(t, transport);
    assert.equal((await f.update()).phase, 'identifying');
    assert.equal(f.view().id, null);
    assert.equal(f.writes.length, 0);
    f.setNow(START + 3 * MINUTE - 1);
    assert.equal((await f.update()).phase, 'identifying');
    assert.equal(f.writes.length, 0);
    f.setNow(START + 3 * MINUTE);
    const control = await f.update();
    assert.equal(f.writes.length, 1, 'Only the precomputed economic restriction is written');
    assert.equal(control.owned.startAt, FUTURE);
    assert.equal(control.owned.requestedAt, START + 3 * MINUTE);
    if (transport === 'ocpp') assert.equal(control.owned.pauseRequestedAt, START + 3 * MINUTE);
    assert.equal(f.view().id, null, 'A charger stop alone cannot identify BMW');
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
    assert.equal(f.view().id, 'bmw');
    assert.equal(f.view().reason, 'matched-controlled-pause');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn.positiveEvent.retained, true);
    await f.update();
    assert.equal(f.writes.length, 1, 'Identity confirmation sends no separate identification command');
  });

  test(`${transport}: healthy Tesla candidate has the same three-minute timeout without identity evidence`, async t => {
    const f = await fixture(t, transport, 'tesla');
    assert.equal((await f.update()).phase, 'identifying');
    f.setNow(START + 3 * MINUTE - 1);
    assert.equal((await f.update()).phase, 'identifying');
    assert.equal(f.writes.length, 0);
    f.setNow(START + 3 * MINUTE);
    const control = await f.update();
    assert.equal(f.writes.length, 1); assert.equal(control.owned.startAt, FUTURE);
    assert.equal(f.view().id, null, 'A healthy home candidate alone grants no identity');
  });

  test(`${transport}: retained BMW context before the first live heartbeat permits observation but never identity`, async t => {
    const f = await fixture(t, transport, 'bmw', { retainedOnly: true });
    assert.equal(f.runtime.vehicleFeeds.bmw.mqtt.lastValidLiveAt, null);
    assert.equal((await f.update()).phase, 'identifying');
    assert.equal(f.writes.length, 0); assert.equal(f.view().id, null);
    f.setNow(START + 3 * MINUTE); await f.update();
    assert.equal(f.writes.length, 1);
    const stopAt = f.physical.at; f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
    assert.equal(f.view().id, null, 'A later live stop cannot promote the retained charging start');
  });

  test(`${transport}: connected Tesla context before a healthy heartbeat permits observation without identity`, async t => {
    const f = await fixture(t, transport, 'tesla', { healthyTesla: false });
    assert.equal((await f.update()).phase, 'identifying');
    assert.equal(f.writes.length, 0); assert.equal(f.view().id, null);
    f.setNow(START + 3 * MINUTE); await f.update();
    assert.equal(f.writes.length, 1); assert.equal(f.view().id, null);
  });

  test(`${transport}: fresh matching Tesla power exits the observation before its timeout`, async t => {
    const f = await fixture(t, transport, 'tesla');
    assert.equal((await f.update()).phase, 'identifying');
    f.setNow(START + 10_000);
    f.tesla.fields = { charger_power: { value: 7, receivedAt: f.now, retained: false },
      plugged_in: { value: true, receivedAt: START, retained: false },
      charging_state: { value: 'Charging', receivedAt: START, retained: false } };
    const control = await f.update();
    assert.equal(f.view().id, 'tesla');
    assert.notEqual(control.phase, 'identifying');
    assert.equal(f.writes.length, 1); assert.equal(control.owned.startAt, FUTURE);
  });

  test(`${transport}: restarting the same session preserves the original observation deadline`, async t => {
    const f = await fixture(t, transport);
    assert.equal((await f.update()).phase, 'identifying');
    f.setNow(START + 2 * MINUTE); await f.restart();
    const restored = await f.update();
    assert.equal(restored.session.connectedAt, START);
    assert.equal(restored.phase, 'identifying'); assert.equal(f.writes.length, 0);
    f.setNow(START + 3 * MINUTE);
    assert.equal((await f.update()).owned.startAt, FUTURE);
    assert.equal(f.writes.length, 1);
  });

  test(`${transport}: unplug/replug starts one new observation with no inherited restriction`, async t => {
    const f = await fixture(t, transport); await f.update();
    f.setNow(START + 3 * MINUTE); await f.update();
    assert.equal(f.writes.length, 1);
    assert.equal((await f.disconnect()).session.connected, false);
    const beforeReconnect = f.writes.length;
    f.reconnect(); const connectedAt = f.now;
    const reconnected = await f.update();
    assert.equal(reconnected.session.connectedAt, connectedAt);
    assert.equal(reconnected.phase, 'identifying'); assert.equal(reconnected.owned, null);
    f.setNow(connectedAt + 3 * MINUTE - 1); await f.update();
    assert.equal(f.writes.length, beforeReconnect);
    f.setNow(connectedAt + 3 * MINUTE); await f.update();
    assert.equal(f.writes.length, beforeReconnect + 1);
  });

  test(`${transport}: disabled automatic control, Charge Now and manual stop keep priority`, async t => {
    const disabled = await fixture(t, transport);
    assert.equal((await disabled.update({ enabled: false })).phase, 'off');
    assert.equal(disabled.writes.length, 0);
    const immediate = await fixture(t, transport); const first = await immediate.update();
    assert.equal(first.phase, 'identifying');
    assert.equal((await immediate.update({ chargeNow: { connectedAt: first.session.connectedAt } })).phase, 'released');
    assert.equal(immediate.writes.length, 0);
    const manual = await fixture(t, transport); await manual.update();
    assert.equal((await manual.manualStop()).phase, 'yielded');
    assert.equal(manual.writes.length, 0);
  });

  test(`${transport}: a foreign native restriction is never released for identification`, async t => {
    const f = await fixture(t, transport); f.foreignRestriction();
    const control = await f.update();
    assert.notEqual(control.phase, 'identifying');
    assert.equal(f.runtime.observeIdentification(f.runtime.chargers.charger1, control.snapshot), false);
    assert.equal(f.writes.some(row => ['clear', 'ClearChargingProfile', 'RemoteStartTransaction'].includes(row.action)), false);
    if (transport === 'cloud') { assert.equal(control.phase, 'yielded'); assert.equal(f.writes.length, 0); }
    else { assert.equal(f.profiles.has(999999999), true); assert.equal(control.owned.startAt, FUTURE); }
  });
}
