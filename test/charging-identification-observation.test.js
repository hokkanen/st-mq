import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { delayedScheduleFor, easeeChargerTelemetry, normalizeScheduleState, scheduleFingerprint } from '../src/charging/easee.js';

const START = Date.parse('2026-09-25T09:00:00Z'), MINUTE = 60_000, FUTURE = START + 60 * MINUTE;

// Real runtime planning callback, vehicle ingestion, normalization and native
// controllers. Only device IO and the already-computed economic plan are fake;
// all command counts include every request the real controllers dispatch.
async function fixture(t, transport, vehicle = 'bmw', { retainedOnly = false, healthyTesla = true, charging = true } = {}) {
  let now = START, runtime, failPersistence = false;
  const states = new Map(), writes = [], profiles = new Map();
  const store = { getState: key => structuredClone(states.get(key)),
    setState: (key, value) => {
      if (failPersistence && key === runtime.key) throw new Error('synthetic storage unavailable');
      states.set(key, structuredClone(value));
    } };
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-observation-charger', equalizer_id: 'synthetic-observation-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-observation' } },
  charging: { vehicles: { bmw: { mqttTopic: 'synthetic/observation/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const physical = { pluggedIn: true, enabled: true, charging, at: START,
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
      if (!retainedOnly) publish({ charging }, START);
    }
    await runtime.setAdapter('charger1', transport === 'cloud' ? cloud : native);
  };
  await create();
  return { get runtime() { return runtime; }, get now() { return now; }, writes, profiles, physical, tesla, publish, states,
    failPersistence: value => { failPersistence = value; },
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
  const attempt = f => f.runtime.chargers.charger1.identification;
  const card = f => f.runtime.status().chargers.find(row => row.id === 'charger1');
  const installs = f => f.writes.filter(row => ['install', 'SetChargingProfile'].includes(row.action));
  const sessionInput = f => {
    const view = card(f);
    return { association: view.association, sessionId: view.request.sessionId, revision: view.request.revision };
  };

  test(`${transport}: immediately requests a bounded identification pause and then applies the economic plan`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000);
    const control = await f.update();
    assert.equal(control.phase, 'identifying');
    assert.equal(installs(f).length, 1);
    assert.equal(control.owned.purpose, 'identification');
    assert.ok(control.owned.startAt <= START + 150_000);
    assert.equal(f.view().id, null, 'An acknowledged charger pause alone is not vehicle identity');
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
    await f.update();
    assert.equal(f.view().id, 'bmw');
    assert.equal(attempt(f).phase, 'completed');
    assert.equal(f.runtime.chargers.charger1.controller.status().owned.startAt, FUTURE);
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn.positiveEvent.retained, true);
  });

  test(`${transport}: a vehicle timer waits beyond ten minutes and testing begins when charging starts`, async t => {
    const f = await fixture(t, transport, 'bmw', { charging: false });
    await f.update(); assert.equal(attempt(f).phase, 'waiting');
    f.setNow(START + 30 * MINUTE); await f.update();
    assert.equal(attempt(f).phase, 'waiting'); assert.equal(attempt(f).attempt, 1);
    assert.equal(f.view().state, 'identifying'); assert.equal(f.writes.length, 0);
    Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now); f.setNow(f.now + 1000);
    await f.update();
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(installs(f).length, 1);
  });

  test(`${transport}: live BMW confirmation immediately hands control back without waiting for the next minute`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const stopAt = f.physical.at;
    const item = f.runtime.chargers.charger1;
    item.lastReconcileAt = f.now;
    f.runtime.tick = options => ChargingRuntime.prototype.tick.call(f.runtime, options);
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
    assert.ok(item.reconcileFlight, 'Confirmation starts a reconciliation immediately');
    await item.reconcileFlight;
    assert.equal(attempt(f).phase, 'completed'); assert.equal(f.view().id, 'bmw');
    assert.equal(item.controller.status().owned.startAt, FUTURE);
    assert.notEqual(item.controller.status().owned.purpose, 'identification');
  });

  test(`${transport}: a live BMW charging start immediately refreshes a waiting charger snapshot`, async t => {
    const f = await fixture(t, transport, 'bmw', { charging: false });
    await f.update(); assert.equal(attempt(f).phase, 'waiting');
    const item = f.runtime.chargers.charger1;
    item.lastReconcileAt = f.now;
    f.runtime.tick = options => ChargingRuntime.prototype.tick.call(f.runtime, options);
    f.setNow(START + 4000); Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now - 1000);
    assert.ok(item.reconcileFlight, 'The start report requests a fresh physical reading immediately');
    await item.reconcileFlight;
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(installs(f).length, 1);
  });

  test(`${transport}: automatic OFF and Charge now still perform identification, then release`, async t => {
    for (const choice of ['off', 'now']) {
      const f = await fixture(t, transport); f.setNow(START + 1000);
      f.runtime.chargers.charger1.controls.enabled = choice !== 'off'; f.runtime.refreshSettings();
      const input = { enabled: choice !== 'off', ...(choice === 'now'
        ? { chargeNow: { connectedAt: transport === 'cloud' ? f.now : START } } : {}) };
      const control = await f.update(input);
      assert.equal(control.owned.purpose, 'identification');
      const stopAt = f.physical.at;
      f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
      const finished = await f.update(input);
      assert.equal(f.view().id, 'bmw'); assert.equal(finished.owned, null);
      assert.equal(finished.phase, choice === 'off' ? 'off' : 'released');
    }
  });

  test(`${transport}: manual stop before testing wins without consuming the waiting attempt`, async t => {
    const f = await fixture(t, transport, 'bmw', { charging: false });
    await f.update(); const before = f.writes.length;
    const stopped = await f.manualStop();
    assert.equal(stopped.phase, 'yielded'); assert.equal(f.writes.length, before);
    assert.equal(attempt(f).phase, 'waiting'); assert.equal(card(f).identification.available, false);
  });

  test(`${transport}: retained-only charging exhausts the short charge budget without inventing identity`, async t => {
    const f = await fixture(t, transport, 'bmw', { retainedOnly: true });
    await f.update(); assert.equal(attempt(f).phase, 'charging'); assert.equal(installs(f).length, 0);
    f.setNow(START + MINUTE); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(f.view().id, null);
    assert.equal(attempt(f).attempt, 1); assert.equal(installs(f).length, 1);
    f.setNow(START + 5 * MINUTE); await f.update();
    assert.equal(attempt(f).attempt, 1);
  });

  test(`${transport}: restart preserves a pending pause and cannot start a second automatic attempt`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const initial = structuredClone(attempt(f)), written = installs(f).length;
    f.setNow(f.now + 5000); await f.restart(); await f.update();
    assert.equal(attempt(f).id, initial.id); assert.equal(attempt(f).pauseUntil, initial.pauseUntil);
    assert.equal(installs(f).length, written);
    f.setNow(initial.pauseUntil + 1000); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive');
    await f.restart(); await f.update(); assert.equal(attempt(f).id, initial.id);
  });

  test(`${transport}: unplug cancels the attempt and a new connection starts a fresh attempt`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const old = attempt(f).id; await f.disconnect(); assert.equal(attempt(f), null);
    f.reconnect(); const connectedAt = f.now; await f.update();
    assert.equal(attempt(f).connectedAt, connectedAt); assert.notEqual(attempt(f).id, old);
    assert.equal(attempt(f).attempt, 1);
  });

  test(`${transport}: manual Identify can test an already identified connection with a fresh response`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    let stoppedAt = f.physical.at;
    f.setNow(stoppedAt + 4000); f.publish({ charging: false }, stoppedAt + 2000); await f.update();
    assert.equal(f.view().id, 'bmw');
    const staleInput = sessionInput(f); f.setNow(f.now + 1000);
    await f.runtime.identifyVehicle('charger1', staleInput);
    assert.equal(attempt(f).attempt, 2); assert.equal(attempt(f).phase, 'waiting');
    assert.equal(f.view().id, 'bmw', 'A recheck preserves the already confirmed association');
    await assert.rejects(f.runtime.identifyVehicle('charger1', staleInput), /changed|progress/);
    f.setNow(f.now + 1000); Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now); f.setNow(f.now + 1000); await f.update();
    stoppedAt = f.physical.at;
    f.setNow(stoppedAt + 4000); f.publish({ charging: false }, stoppedAt + 2000); await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(attempt(f).phase, 'completed');
  });

  test(`${transport}: fresh Tesla evidence avoids an unnecessary identification pause`, async t => {
    const f = await fixture(t, transport, 'tesla'); await f.update();
    f.setNow(START + 10_000);
    f.tesla.fields = { charger_power: { value: 7, receivedAt: f.now, retained: false },
      plugged_in: { value: true, receivedAt: START, retained: false },
      charging_state: { value: 'Charging', receivedAt: START, retained: false } };
    const control = await f.update();
    assert.equal(f.view().id, 'tesla'); assert.equal(attempt(f).phase, 'completed');
    assert.equal(control.owned.startAt, FUTURE); assert.notEqual(control.owned.purpose, 'identification');
  });

  test(`${transport}: foreign native restrictions are preserved`, async t => {
    const f = await fixture(t, transport); f.foreignRestriction(); await f.update();
    assert.equal(f.writes.some(row => ['clear', 'ClearChargingProfile', 'RemoteStartTransaction'].includes(row.action)), false);
    if (transport === 'cloud') assert.equal(f.writes.length, 0);
    else assert.equal(f.profiles.has(999999999), true);
  });

  test(`${transport}: an already charging vehicle with no saved start is identified from a live baseline and new pause`, async t => {
    const f = await fixture(t, transport, 'bmw', { retainedOnly: true });
    f.physical.at = START - 5 * MINUTE;
    await f.update(); assert.equal(attempt(f).phase, 'charging');
    f.setNow(START + 1000); f.publish({ charging: true }, START + 500);
    await f.update();
    assert.equal(attempt(f).candidate.kind, 'ongoing');
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000); await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(f.view().reason, 'matched-identification-pause');
    assert.equal(f.runtime.vehicleFeeds.bmw.consumedChargingId, attempt(f).candidate.readingId);
  });

  test(`${transport}: a late BMW stop can use saved physical proof after the identification pause expired`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const stopAt = f.physical.at;
    f.setNow(stopAt + 1000); await f.update();
    assert.ok(attempt(f).pause);
    f.setNow(attempt(f).pauseUntil + 1000); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(f.view().id, null);
    f.publish({ charging: false }, stopAt + 2000); await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(attempt(f).phase, 'completed');
  });

  test(`${transport}: failed attempt persistence cannot issue an identification command`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); f.failPersistence(true);
    await f.update(); assert.equal(f.writes.length, 0);
    f.failPersistence(false); await f.update();
    assert.equal(installs(f).length, 1); assert.equal(attempt(f).attempt, 1);
  });

  test(`${transport}: a failed manual retry save preserves identity, attempt and session revision`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000); await f.update();
    const input = sessionInput(f), before = structuredClone(attempt(f)), count = f.writes.length;
    f.failPersistence(true);
    await assert.rejects(f.runtime.identifyVehicle('charger1', input), /storage/);
    assert.deepEqual(attempt(f), before); assert.equal(f.view().id, 'bmw');
    assert.equal(card(f).request.revision, input.revision); assert.equal(f.writes.length, count);
  });

  test(`${transport}: an inconclusive recheck cannot declare success from the previous confirmed identity`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000); await f.update();
    await f.runtime.identifyVehicle('charger1', sessionInput(f));
    f.setNow(f.now + 1000); Object.assign(f.physical, { charging: true, at: f.now });
    await f.update();
    f.setNow(attempt(f).chargeDeadlineAt + 1000); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(f.view().id, 'bmw');
    await f.update(); assert.equal(attempt(f).phase, 'inconclusive');
    assert.equal(card(f).identification.available, true);
    await f.restart(); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(f.view().id, 'bmw');
  });
}

test('two-second identification polls never cancel a slow in-flight reconciliation', async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { retainedOnly: true });
  await f.update();
  let finish, calls = 0;
  f.runtime.reconcileCharger = async () => { calls++; await new Promise(resolve => { finish = resolve; }); };
  const flight = f.runtime.reconcile('charger1');
  await Promise.resolve();
  f.setNow(START + 4000);
  ChargingRuntime.prototype.tick.call(f.runtime);
  assert.equal(calls, 1);
  finish(); await flight;
  assert.equal(f.runtime.chargers.charger1.reconcileFlight, null);
});

test('a forced update during a slow reconciliation runs as soon as the request finishes', async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { retainedOnly: true }); await f.update();
  const finish = [];
  f.runtime.reconcileCharger = async () => { await new Promise(resolve => finish.push(resolve)); };
  const flight = f.runtime.reconcile('charger1');
  ChargingRuntime.prototype.tick.call(f.runtime, { force: true });
  assert.equal(finish.length, 1);
  finish[0](); await flight;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finish.length, 2);
  const next = f.runtime.chargers.charger1.reconcileFlight;
  finish[1](); await next;
});

test('repeated identification wakeups cannot starve an explicit queued resume', async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { retainedOnly: true }); await f.update();
  const finish = [], calls = [];
  f.runtime.reconcileCharger = async (id, options) => {
    calls.push(options); await new Promise(resolve => finish.push(resolve));
  };
  const flight = f.runtime.reconcile('charger1');
  const resume = f.runtime.reconcile('charger1', { resume: true });
  ChargingRuntime.prototype.tick.call(f.runtime, { force: true });
  ChargingRuntime.prototype.tick.call(f.runtime, { force: true });
  finish[0](); await flight;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2); assert.equal(calls[1].resume, true);
  finish[1](); await resume;
  assert.equal(f.runtime.chargers.charger1.reconcileFlight, null);
});

test('simultaneous supported charging points choose one active test without consuming the queued budget', async t => {
  const f = await fixture(t, 'cloud'); f.setNow(START + 1000); await f.update();
  const first = f.runtime.chargers.charger1, second = f.runtime.chargers.charger2;
  const control = structuredClone(first.controller.status());
  Object.assign(control.snapshot, { mode: 3, modeAt: f.now, powerKw: 7, powerAt: f.now,
    schedule: normalizeScheduleState({ enabled: 'none' }) });
  control.owned = null; control.identification = null;
  second.controller = { supportsIdentification: true, status: () => control, close() {} };
  second.adapter = { normalize: easeeChargerTelemetry };
  f.runtime.telemetry(f.now);
  assert.equal(first.identification.phase, 'pausing');
  assert.equal(second.identification.phase, 'waiting');
  assert.equal(second.identification.chargeDeadlineAt, null);
  assert.equal(f.runtime.identificationTurn(first), true);
  assert.equal(f.runtime.identificationTurn(second), false);
  f.setNow(first.identification.pauseUntil + 1000);
  control.snapshot.readAt = f.now; control.snapshot.powerAt = f.now;
  f.runtime.telemetry(f.now);
  assert.equal(first.identification.phase, 'inconclusive');
  assert.equal(second.identification.phase, 'charging');
  assert.equal(second.identification.chargeDeadlineAt, f.now + MINUTE);
});
