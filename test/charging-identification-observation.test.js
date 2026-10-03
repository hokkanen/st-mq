import { withReportDatabase } from './helpers/report-database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createOcppScheduleAdapter } from '../src/charging/ocpp.js';
import { delayedScheduleFor, easeeChargerTelemetry, normalizeScheduleState, scheduleFingerprint } from '../src/charging/easee.js';

const START = Date.parse('2026-09-25T09:00:00Z'), MINUTE = 60_000, FUTURE = START + 60 * MINUTE;

// Real runtime planning callback, vehicle ingestion, normalization and native
// controllers. Only device IO and the already-computed economic plan are fake;
// all command counts include every request the real controllers dispatch.
async function fixture(t, transport, vehicle = 'bmw', { retainedOnly = false, healthyTesla = true, charging = true,
  atHome = true, normalCharging = false, autoCharge = false, freshPlug = false } = {}) {
  let now = START, runtime, failPersistence = false;
  const states = new Map(), writes = [], profiles = new Map();
  const store = { getState: key => structuredClone(states.get(key)),
    setState: (key, value) => {
      if (failPersistence && key === runtime.key) throw new Error('synthetic storage unavailable');
      states.set(key, structuredClone(value));
    } };
  withReportDatabase(store, t);
  const config = { input: 'mqtt', connections: {
    easee: { charger_id: 'synthetic-observation-charger', equalizer_id: 'synthetic-observation-equalizer' },
    mqtt: { address: 'mqtt://synthetic.invalid', user: 'synthetic-observation' } },
  charging: { vehicles: { bmw: { mqttTopic: 'synthetic/observation/bmw' } }, chargers: { charger2: { enabled: false } } } };
  const physical = { pluggedIn: true, enabled: true, charging, powerKw: 7, at: START,
    transactionId: 23, transactionStartedAt: START, enabledAt: START };
  let schedule = normalizeScheduleState({ enabled: 'none' });
  const tesla = { association: 'synthetic-observation-tesla', connected: vehicle === 'tesla', healthy: vehicle === 'tesla' && healthyTesla,
    pluggedIn: true, atHome: true, charging: true, actualPowerKw: 7, fields: {} };
  const scope = 'e'.repeat(64), connectionId = 'synthetic-observation-socket';
  const changePhysical = (charging, at = now) => { physical.charging = charging; physical.at = at; };
  const effectiveLimit = at => Math.min(16, ...[...profiles.values()].filter(row => row.transactionId === physical.transactionId
    && Date.parse(row.validFrom) <= at && Date.parse(row.validTo) > at).map(row => {
    const schedule = row.chargingSchedule;
    return schedule ? schedule.chargingSchedulePeriod.filter(period => Date.parse(schedule.startSchedule) + period.startPeriod * 1000 <= at).at(-1)?.limit ?? 16 : 0;
  }));
  let previousLimit = 16;
  const syncNative = () => {
    const limit = effectiveLimit(now);
    if (limit !== previousLimit) {
      if (limit === 0 && !physical.pauseBlocked) changePhysical(false);
      else if (autoCharge || physical.charging) { physical.powerKw = Math.min(7, 3 * 230 * limit / 1000); changePhysical(true); }
      previousLimit = limit;
    }
    if (autoCharge && limit > 0 && physical.pluggedIn && !physical.charging) changePhysical(true);
  };
  const cloudSnapshot = () => {
    if (autoCharge && physical.enabled && physical.pluggedIn && schedule.enabled === 'none' && !physical.charging) changePhysical(true);
    const mode = !physical.pluggedIn ? 1 : physical.charging ? 3 : 2;
    const reason = !physical.enabled ? 53 : schedule.enabled === 'none' ? 0 : 54;
    return { schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule), readAt: now,
      controlFingerprint: `synthetic-${physical.enabled}-${physical.pluggedIn}`, controlKnown: true,
      online: true, enabled: physical.enabled, pluggedIn: physical.pluggedIn, mode, modeAt: physical.at,
      reason, reasonAt: physical.at, manualStop: !physical.enabled, stopped: !physical.enabled,
      faulted: false, authorizationBlocked: false, powerKw: physical.charging ? physical.powerKw : 0, powerAt: now,
      disconnectedAt: physical.pluggedIn ? null : physical.at,
      limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] },
      observations: { 109: { value: mode, at: physical.at }, 120: { value: physical.charging ? physical.powerKw : 0, at: now } } };
  };
  const cloud = {
    normalize: easeeChargerTelemetry, read: async () => cloudSnapshot(),
    async installDelayed(input) {
      assert.equal(input.canMutate(), true);
      await input.beforeWrite(cloudSnapshot());
      writes.push({ action: 'install', startAt: input.startAt, requestedAt: now });
      schedule = normalizeScheduleState({ ...schedule, enabled: 'delayed', delayed: delayedScheduleFor(input, now) });
      now += 1000; if (!physical.pauseBlocked) changePhysical(false);
      return cloudSnapshot();
    },
    async clear(input) {
      assert.equal(input.canMutate(), true);
      writes.push({ action: 'clear' }); schedule = normalizeScheduleState({ ...schedule, enabled: 'none' });
      if (autoCharge) changePhysical(true);
      return cloudSnapshot();
    },
  };
  const native = createOcppScheduleAdapter({ scope, clock: () => now, canControl: () => true,
    isCurrent: (snapshot, { requireTransaction = true, unchangedStatus = false } = {}) => snapshot.connectionId === connectionId
      && (!requireTransaction || snapshot.transactionId === physical.transactionId)
      && (!unchangedStatus || snapshot.statusAt === physical.at
        && snapshot.connectorStatus === (!physical.pluggedIn ? 'Available' : physical.charging ? 'Charging' : 'SuspendedEVSE')),
    readSnapshot: async () => { syncNative(); return ({ transport: 'ocpp', scope, connectionId, online: true, readAt: now,
      pluggedIn: physical.pluggedIn, connectorStatus: !physical.pluggedIn ? 'Available'
        : physical.charging ? 'Charging' : 'SuspendedEVSE', statusAt: physical.at,
      transactionId: physical.pluggedIn ? physical.transactionId : null,
      transactionStartedAt: physical.pluggedIn ? physical.transactionStartedAt : null,
      transactionConfirmed: physical.pluggedIn,
      limits: { chargerA: 16, cableA: 16, circuitA: [16, 16, 16] },
      powerKw: physical.charging ? physical.powerKw : 0, powerAt: now, appControl: { readAt: now, enabled: physical.enabled, enabledAt: physical.enabledAt,
        stopped: !physical.enabled, stopAt: physical.enabledAt, controlKnown: true, faulted: false, authorizationBlocked: false, schedule: null } }); },
    request: async (action, payload, options) => {
      assert.equal(options.guard(), true);
      if (action === 'SetChargingProfile') {
        assert.equal(options.beforeSend(), true);
        writes.push({ action, payload: structuredClone(payload), requestedAt: now });
        profiles.set(payload.csChargingProfiles.chargingProfileId, structuredClone(payload.csChargingProfiles));
        now += 1000; syncNative();
        if (autoCharge && effectiveLimit(now) > 0) changePhysical(true);
        return { status: 'Accepted' };
      }
      if (action === 'ClearChargingProfile') {
        writes.push({ action, payload: structuredClone(payload) });
        return { status: profiles.delete(payload.id) ? 'Accepted' : 'Unknown' };
      }
      assert.equal(action, 'GetCompositeSchedule');
      const boundaries = [...new Set([now, ...[...profiles.values()].flatMap(row => [Date.parse(row.validTo),
        ...(row.chargingSchedule?.chargingSchedulePeriod ?? []).map(period => Date.parse(row.chargingSchedule.startSchedule) + period.startPeriod * 1000)])])]
        .filter(at => at >= now && at < now + payload.duration * 1000).sort((a, b) => a - b);
      return { status: 'Accepted', connectorId: 1, scheduleStart: new Date(now).toISOString(),
        chargingSchedule: { chargingRateUnit: 'A', duration: payload.duration,
          chargingSchedulePeriod: boundaries.map(at => ({ startPeriod: (at - now) / 1000, limit: effectiveLimit(at), numberPhases: 3 })) } };
    },
  });
  const publish = (values, at, retained = false) => {
    assert.equal(runtime.receiveSoc('synthetic/observation/bmw', JSON.stringify({ provider: 'bmw-cardata', ...values,
      ...(Object.hasOwn(values, 'soc') ? { measuredAt: at, readingId: `synthetic-soc-${values.soc}-${at}` } : {}),
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
    const plan = () => ({ id: 'synthetic-economic-plan', feasible: true, startAt: normalCharging ? START : FUTURE,
      periods: [{ startAt: normalCharging ? START : FUTURE, endAt: null }] });
    runtime.chargers.charger1.plan = plan();
    runtime.updatePlan = async () => { runtime.telemetry(now); runtime.chargers.charger1.plan = plan(); };
    runtime.teslaCapture = { snapshot: () => structuredClone(tesla) };
    runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
    if (vehicle === 'bmw') {
      if (!runtime.vehicleFeeds.bmw.reading)
        publish({ atHome, pluggedIn: !freshPlug, charging: retainedOnly }, retainedOnly ? START : START - 60 * MINUTE, true);
      if (freshPlug) publish({ pluggedIn: true }, START);
      if (!retainedOnly) publish({ charging }, START);
      else publish({ soc: 45 }, now); // Live feed health does not turn retained charging into a transition.
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
      physical.enabled = false; physical.enabledAt = now;
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

for (const vehicle of ['bmw', 'tesla']) for (const retained of [false, true])
test(`${vehicle}: a ${retained ? 'retained' : 'live'} unplug from before this physical connection permits observation but cannot identify it`, async t => {
  const f = await fixture(t, 'ocpp', vehicle, { normalCharging: true });
  if (vehicle === 'bmw') f.publish({ pluggedIn: false }, START - 1000, retained);
  else {
    f.tesla.pluggedIn = false;
    f.tesla.fields.plugged_in = { value: false, receivedAt: START - 1000, measuredAt: null,
      retained, timeBasis: 'receipt-only', sequence: 1 };
  }
  const reading = () => vehicle === 'bmw' ? f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn : f.tesla.fields.plugged_in;
  const original = structuredClone(reading());
  f.setNow(START + 1000); await f.update();
  const item = f.runtime.chargers.charger1;
  assert.equal(item.identification.phase, 'charging'); assert.equal(item.identification.action, 'allow');
  assert.equal(f.runtime.identificationFeedReady(item, f.now), true);
  assert.equal(f.view().id, null); assert.equal(f.writes.length, 0);
  assert.deepEqual(reading(), original, 'Permission to observe must not manufacture positive plug evidence or a fresh source clock');
  assert.equal(vehicle === 'bmw' ? f.runtime.vehicleFeeds.bmw.reading.pluggedIn : f.tesla.pluggedIn, false);
  const earlierSession = { controller: { status: () => ({ session: { connected: true, connectedAt: START - 2000 } }) } };
  assert.equal(f.runtime.identificationFeedReady(earlierSession, f.now), false,
    'The same false observation belongs to the older connection and must block its test');

  f.setNow(START + 2000);
  if (vehicle === 'bmw') f.publish({ pluggedIn: false }, f.now);
  else f.tesla.fields.plugged_in = { ...original, receivedAt: f.now, retained: false, sequence: 2 };
  await f.update();
  assert.equal(f.runtime.identificationFeedReady(item, f.now), false);
  assert.equal(item.identification.action, null, 'A current-session negative observation cannot authorize further testing');
  assert.equal(f.view().id, null);
});

for (const vehicle of ['bmw', 'tesla']) test(`${vehicle}: prior-unplug readiness retains home, health and valid-clock requirements`, async t => {
  const f = await fixture(t, 'ocpp', vehicle, { normalCharging: true });
  if (vehicle === 'bmw') f.publish({ pluggedIn: false }, START - 1000);
  else {
    f.tesla.pluggedIn = false;
    f.tesla.fields.plugged_in = { value: false, receivedAt: START - 1000, measuredAt: null,
      retained: false, timeBasis: 'receipt-only', sequence: 1 };
  }
  await f.update();
  const item = f.runtime.chargers.charger1;
  const field = vehicle === 'bmw' ? f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn : f.tesla.fields.plugged_in;
  const original = structuredClone(field), clockKey = vehicle === 'bmw' ? 'measuredAt' : 'receivedAt';
  for (const patch of [{ [clockKey]: null }, { [clockKey]: START }, { [clockKey]: f.now + 1000 },
    { receivedAt: f.now + 1000 }, { retained: undefined }, ...(vehicle === 'bmw' ? [{ readingId: '' }] : [{ timeBasis: undefined }])]) {
    Object.assign(field, original, patch);
    assert.equal(f.runtime.identificationFeedReady(item, f.now), false, JSON.stringify(patch));
  }
  Object.assign(field, original);
  assert.equal(f.runtime.identificationFeedReady(item, f.now), true);
  if (vehicle === 'bmw') {
    f.runtime.vehicleFeeds.bmw.reading.atHome = false;
    assert.equal(f.runtime.identificationFeedReady(item, f.now), false);
    f.runtime.vehicleFeeds.bmw.reading.atHome = true;
    f.runtime.vehicleFeeds.bmw.mqtt.connected = false;
  } else {
    f.tesla.atHome = false;
    assert.equal(f.runtime.identificationFeedReady(item, f.now), false);
    f.tesla.atHome = true; f.tesla.healthy = false;
  }
  assert.equal(f.runtime.identificationFeedReady(item, f.now), false);
});

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
    assert.ok(attempt(f).pauseUntil <= START + 150_000);
    if (transport === 'ocpp') assert.equal(control.owned.startAt, FUTURE,
      'An economic-period test must retain its installed scheduled return');
    assert.equal(f.view().id, null, 'An acknowledged charger pause alone is not vehicle identity');
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000);
    await f.update();
    assert.equal(f.view().id, 'bmw');
    assert.equal(attempt(f).phase, 'completed');
    assert.equal(f.runtime.chargers.charger1.controller.status().owned.startAt, FUTURE);
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.pluggedIn.positiveEvent.retained, true);
  });

  test(`${transport}: unknown GPS uses recent confirmed home context with a live charging response`, async t => {
    const f = await fixture(t, transport);
    f.publish({ atHome: true }, START - 35 * MINUTE);
    const knownHome = structuredClone(f.runtime.vehicleFeeds.bmw.reading.fields.atHome);
    f.publish({ atHome: null }, null);
    const unavailableHome = structuredClone(f.runtime.vehicleFeeds.bmw.reading.fields.atHome);
    assert.equal(unavailableHome.measuredAt, null);
    assert.equal(unavailableHome.lastKnown.measuredAt, knownHome.measuredAt);
    assert.equal(unavailableHome.lastKnown.receivedAt, knownHome.receivedAt);
    f.setNow(START + 1000); await f.update();
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(installs(f).length, 1);
    assert.equal(f.view().id, null, 'Recent home context and a pause acknowledgement do not identify a vehicle');
    const stoppedAt = f.physical.at;
    f.setNow(stoppedAt + 4000); f.publish({ charging: false }, stoppedAt + 2000); await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(attempt(f).phase, 'completed');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.atHome, null);
    assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading.fields.atHome, unavailableHome,
      'Using home context must preserve the unavailable reading and its original observation clocks');
  });

  test(`${transport}: missing home context waits without spending the identification budget`, async t => {
    const f = await fixture(t, transport, 'bmw', { atHome: null });
    f.runtime.chargers.charger1.controls.enabled = false; f.runtime.refreshSettings();
    Object.assign(f.physical, { charging: true, at: f.now });
    f.setNow(f.now + 1000); f.publish({ charging: true }, f.now - 500);
    await f.update({ enabled: false });
    assert.equal(attempt(f).phase, 'waiting');
    const initial = structuredClone(attempt(f));
    f.setNow(f.now + 5 * MINUTE);
    Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now - 500); await f.update({ enabled: false });
    assert.equal(attempt(f).phase, 'waiting'); assert.equal(attempt(f).id, initial.id);
    assert.equal(attempt(f).chargeDeadlineAt, null); assert.equal(attempt(f).chargingStartedAt, null);
    assert.equal(attempt(f).chargeUsedKwh, 0); assert.equal(f.writes.length, 0);
    f.publish({ atHome: true }, f.now - 500); await f.update({ enabled: false });
    assert.equal(attempt(f).id, initial.id); assert.equal(attempt(f).attempt, 1);
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(installs(f).length, 1);
    assert.equal(attempt(f).chargeDeadlineAt, null, 'Normal charging has no short identification deadline');
  });

  test(`${transport}: restart preserves two-week-old home context with its original source timestamp`, async t => {
    const f = await fixture(t, transport, 'bmw', { charging: false, normalCharging: true });
    f.publish({ atHome: true }, START - 35 * MINUTE); f.publish({ atHome: null }, null);
    await f.update();
    const home = structuredClone(f.runtime.vehicleFeeds.bmw.reading.fields.atHome);
    const initial = structuredClone(attempt(f));
    f.setNow(START + 14 * 24 * 60 * MINUTE); await f.restart();
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.atHome, null);
    assert.deepEqual(f.runtime.vehicleFeeds.bmw.reading.fields.atHome, home);
    Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now - 500); await f.update();
    assert.equal(attempt(f).id, initial.id); assert.equal(attempt(f).phase, 'pausing');
    assert.equal(attempt(f).chargeDeadlineAt, null); assert.equal(installs(f).length, 1);
    assert.equal(f.view().id, null);
  });

  test(`${transport}: an explicit away report invalidates home context during the identification pause`, async t => {
    const f = await fixture(t, transport);
    f.runtime.chargers.charger1.controls.enabled = false; f.runtime.refreshSettings();
    f.publish({ atHome: true }, START - 35 * MINUTE); f.publish({ atHome: null }, null);
    f.setNow(START + 1000); await f.update({ enabled: false });
    assert.equal(attempt(f).phase, 'pausing');
    const stoppedAt = f.physical.at;
    f.setNow(stoppedAt + 4000);
    f.publish({ atHome: false }, stoppedAt + 1000); f.publish({ atHome: null }, null);
    f.publish({ charging: false }, stoppedAt + 2000); await f.update({ enabled: false });
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.atHome.lastKnown.value, false);
    assert.equal(f.view().id, null); assert.notEqual(attempt(f).phase, 'completed');
    assert.equal(installs(f).length, 1);
  });

  test(`${transport}: a vehicle timer waits beyond ten minutes and testing begins when charging starts`, async t => {
    const f = await fixture(t, transport, 'bmw', { charging: false, normalCharging: true });
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
    const f = await fixture(t, transport, 'bmw', { charging: false, normalCharging: true });
    await f.update(); assert.equal(attempt(f).phase, 'waiting');
    const item = f.runtime.chargers.charger1;
    item.lastReconcileAt = f.now;
    f.runtime.tick = options => ChargingRuntime.prototype.tick.call(f.runtime, options);
    f.setNow(START + 4000); Object.assign(f.physical, { charging: true, at: f.now });
    f.publish({ charging: true }, f.now - 1000);
    assert.ok(item.reconcileFlight, 'The start report requests a fresh physical reading immediately');
    await item.reconcileFlight;
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(installs(f).length, 1);
    assert.ok(attempt(f).pause, 'Fresh physical proof retains the bounded pause while BMW observes the stop');
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
    const f = await fixture(t, transport, 'bmw', { charging: false, normalCharging: true });
    await f.update(); const before = f.writes.length;
    const stopped = await f.manualStop();
    assert.equal(stopped.phase, 'yielded'); assert.equal(f.writes.length, before);
    assert.equal(attempt(f).phase, 'waiting'); assert.equal(card(f).identification.available, false);
  });

  test(`${transport}: normal charging with retained-only BMW state continues without spending an extra probe budget`, async t => {
    const f = await fixture(t, transport, 'bmw', { retainedOnly: true, normalCharging: true });
    await f.update(); assert.equal(attempt(f).phase, 'charging'); assert.equal(installs(f).length, 0);
    f.setNow(START + MINUTE); await f.update();
    assert.equal(attempt(f).phase, 'charging'); assert.equal(f.view().id, null);
    assert.equal(attempt(f).attempt, 1); assert.equal(installs(f).length, 0);
    f.setNow(START + 78 * MINUTE); f.publish({ soc: 46 }, f.now); await f.update();
    assert.equal(attempt(f).attempt, 1); assert.equal(attempt(f).phase, 'charging');
    assert.equal(attempt(f).chargeDeadlineAt, null); assert.equal(attempt(f).chargeUsedKwh, 0);
  });

  test(`${transport}: restart preserves a pending pause and cannot start a second automatic attempt`, async t => {
    const f = await fixture(t, transport); f.setNow(START + 1000); await f.update();
    const initial = structuredClone(attempt(f)), written = installs(f).length;
    f.setNow(f.now + 5000); await f.restart(); await f.update();
    assert.equal(attempt(f).id, initial.id); assert.equal(attempt(f).pauseUntil, initial.pauseUntil);
    assert.equal(installs(f).length, written,
      'Restart retains the existing bounded pause and any installed economic return');
    assert.equal(attempt(f).phase, 'pausing');
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
    const f = await fixture(t, transport, 'tesla', { normalCharging: true }); await f.update();
    f.setNow(START + 10_000);
    f.tesla.fields = { charger_power: { value: 7, receivedAt: f.now, retained: false },
      plugged_in: { value: true, receivedAt: START, retained: false },
      charging_state: { value: 'Charging', receivedAt: START, retained: false } };
    const control = await f.update();
    assert.equal(f.view().id, 'tesla'); assert.equal(attempt(f).phase, 'completed');
    assert.equal(control.owned, null); assert.equal(installs(f).length, 0);
  });

  test(`${transport}: foreign native restrictions are preserved`, async t => {
    const f = await fixture(t, transport); f.foreignRestriction(); await f.update();
    assert.equal(f.writes.some(row => ['clear', 'ClearChargingProfile', 'RemoteStartTransaction'].includes(row.action)), false);
    if (transport === 'cloud') assert.equal(f.writes.length, 0);
    else assert.equal(f.profiles.has(999999999), true);
  });

  test(`${transport}: an already charging vehicle with no saved start is identified from a live baseline and new pause`, async t => {
    const f = await fixture(t, transport, 'bmw', { retainedOnly: true, normalCharging: true });
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

  test(`${transport}: confirmed physical stop stays paused for a delayed BMW response and then restores ordinary charging`, async t => {
    const f = await fixture(t, transport, 'bmw', { normalCharging: true, autoCharge: true });
    f.setNow(START + 1000); await f.update();
    const initial = structuredClone(attempt(f)), stopAt = f.physical.at;
    f.setNow(stopAt + 30_000); await f.update();
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(attempt(f).action, 'pause');
    assert.equal(attempt(f).pauseUntil, initial.pauseUntil);
    assert.equal(f.physical.charging, false); assert.equal(f.view().id, null);
    assert.equal(installs(f).length, 1);
    f.setNow(stopAt + 60_000); f.publish({ charging: false }, stopAt + 2000);
    const completed = await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(attempt(f).phase, 'completed');
    assert.equal(f.runtime.vehicleFeeds.bmw.reading.fields.charging.negativeEvent.measuredAt, stopAt + 2000);
    assert.equal(completed.owned, null);
    await f.update(); assert.equal(f.physical.charging, true);
    assert.ok(f.now < initial.pauseUntil, 'Positive identity releases the pause before its deadline');
  });

  test(`${transport}: BMW silence expires the confirmed pause without renewing it across restart`, async t => {
    const f = await fixture(t, transport, 'bmw', { normalCharging: true, autoCharge: true });
    f.setNow(START + 1000); await f.update();
    const initial = structuredClone(attempt(f));
    f.setNow(START + 30_000); await f.update();
    assert.equal(f.physical.charging, false); assert.ok(attempt(f).pause);
    f.setNow(START + 60_000); await f.restart(); await f.update();
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(f.physical.charging, false);
    assert.equal(attempt(f).pauseUntil, initial.pauseUntil); assert.equal(installs(f).length, 1);
    f.setNow(initial.pauseUntil + 1000); await f.update(); await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(attempt(f).action, null);
    assert.equal(f.physical.charging, true); assert.equal(f.view().id, null);
    assert.equal(attempt(f).attempt, 1); assert.equal(installs(f).length, 1);
  });

  test(`${transport}: a held identification pause returns to economic waiting when BMW remains silent`, async t => {
    const f = await fixture(t, transport, 'bmw', { autoCharge: true });
    f.setNow(START + 1000); await f.update();
    const initial = structuredClone(attempt(f));
    f.setNow(START + 30_000); await f.update();
    assert.equal(attempt(f).phase, 'pausing'); assert.equal(f.physical.charging, false);
    assert.equal(installs(f).length, 1);
    f.setNow(initial.pauseUntil + 1000); const control = await f.update();
    assert.equal(attempt(f).phase, 'inconclusive'); assert.equal(attempt(f).action, null);
    assert.equal(control.owned.startAt, FUTURE); assert.notEqual(control.owned.purpose, 'identification');
    assert.equal(f.physical.charging, false); assert.equal(f.view().id, null);
    assert.equal(installs(f).length, transport === 'cloud' ? 2 : 1);
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

  test(`${transport}: a pending normal-charge recheck cannot declare success from the previous confirmed identity`, async t => {
    const f = await fixture(t, transport, 'bmw', { normalCharging: true }); f.setNow(START + 1000); await f.update();
    const stopAt = f.physical.at;
    f.setNow(stopAt + 4000); f.publish({ charging: false }, stopAt + 2000); await f.update();
    await f.runtime.identifyVehicle('charger1', sessionInput(f));
    f.setNow(f.now + 1000); Object.assign(f.physical, { charging: true, at: f.now });
    await f.update();
    f.setNow(f.now + 78 * MINUTE); f.publish({ soc: 46 }, f.now); await f.update();
    assert.equal(attempt(f).phase, 'charging'); assert.equal(attempt(f).chargeDeadlineAt, null);
    assert.equal(f.view().id, 'bmw'); assert.equal(attempt(f).attempt, 2);
    await f.update(); assert.equal(attempt(f).phase, 'charging');
    await f.restart(); await f.update();
    assert.equal(attempt(f).phase, 'charging'); assert.equal(f.view().id, 'bmw');
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

for (const { freshPlug, retry } of [{ freshPlug: true }, { freshPlug: false }, { freshPlug: false, retry: true }])
test(`an economic OCPP probe uses normal current, stops on its fixed deadline and identifies from late reordered reports with ${freshPlug ? 'fresh' : 'unchanged'} BMW plug state${retry ? ' during an explicit retry' : ''}`, async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { charging: false, autoCharge: true, freshPlug });
  await f.update();
  const item = f.runtime.chargers.charger1;
  if (retry) {
    const firstStart = f.physical.at;
    f.setNow(firstStart + 30_000); f.publish({ charging: true }, firstStart + 1000); await f.update();
    const firstStop = f.physical.at;
    f.setNow(firstStop + 4000); f.publish({ charging: false }, firstStop + 2000); await f.update();
    assert.equal(f.view().id, 'bmw'); assert.equal(item.identification.phase, 'completed');
    const card = f.runtime.status().chargers.find(row => row.id === 'charger1');
    f.setNow(f.now + 1000);
    await f.runtime.identifyVehicle('charger1', { association: card.association,
      sessionId: card.request.sessionId, revision: card.request.revision });
    await f.update();
    assert.equal(item.identification.attempt, 2);
    assert.notEqual(item.identification.phase, 'completed', 'The prior matched episode cannot complete an explicit retry');
  }
  assert.equal(f.physical.charging, true); assert.equal(f.physical.powerKw, 7);
  const startedAt = f.physical.at, probe = structuredClone(item.identification.probe);
  assert.equal(probe.currentA, undefined, 'Identification does not add a positive current limit');
  assert.ok(probe.deadlineAt - probe.startedAt <= 34_000, 'Native stop is bounded by the conservative energy allowance');
  f.setNow(startedAt + 30_000); await f.update();
  assert.equal(item.identification.phase, 'charging'); assert.equal(f.view().id, retry ? 'bmw' : null);
  f.setNow(probe.deadlineAt); await f.update();
  assert.equal(f.physical.charging, false, 'The bounded probe deadline requests the native zero-current stop');
  const stopProfile = f.writes.findLast(row => row.action === 'SetChargingProfile');
  assert.ok(stopProfile.payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod.every(row => row.limit === 0));
  assert.equal(Date.parse(stopProfile.payload.csChargingProfiles.validTo), FUTURE);
  const stoppedAt = f.physical.at;
  f.setNow(f.now + 1000); await f.update();
  assert.equal(item.identification.phase, 'inconclusive'); assert.equal(item.identification.probe.deadlineAt, probe.deadlineAt);
  assert.ok(item.identification.chargeUsedKwh <= .15);
  const count = f.writes.filter(row => row.action === 'SetChargingProfile').length;
  f.setNow(f.now + 5 * MINUTE); f.publish({ soc: 45 }, f.now); await f.update();
  assert.equal(item.identification.attempt, retry ? 2 : 1);
  assert.equal(f.writes.filter(row => row.action === 'SetChargingProfile').length, count, 'Waiting cannot replenish the probe allowance');
  f.setNow(START + 78 * MINUTE);
  f.publish({ charging: false }, stoppedAt + 1000);
  assert.notEqual(item.identification.phase, 'completed', 'A late stop alone is insufficient to complete this attempt');
  f.publish({ charging: true }, startedAt + 1000); await f.update();
  assert.equal(f.runtime.vehicleFeeds.bmw.reading.charging, false, 'Historical start never rolls current state backward');
  assert.equal(f.view().id, 'bmw'); assert.equal(item.identification.phase, 'completed');
});

test('cloud scheduling runs a bounded normal-current probe and returns to the economic plan', async t => {
  const f = await fixture(t, 'cloud', 'bmw', { charging: false, autoCharge: true });
  await f.update();
  const initial = structuredClone(f.runtime.chargers.charger1.identification);
  assert.ok(initial.probe); assert.equal(initial.probe.currentA, undefined);
  assert.equal(f.physical.charging, true); assert.equal(f.physical.powerKw, 7);
  assert.ok(initial.probe.deadlineAt - initial.probe.startedAt <= 34_000);
  f.setNow(initial.probe.deadlineAt); await f.update();
  f.setNow(f.now + 1000); await f.update();
  const stopped = f.runtime.chargers.charger1.identification;
  assert.equal(stopped.phase, 'inconclusive'); assert.equal(f.physical.charging, false);
  assert.ok(stopped.chargeUsedKwh > 0 && stopped.chargeUsedKwh <= .15);
  const count = f.writes.length;
  f.setNow(f.now + MINUTE); await f.restart(); await f.update();
  assert.equal(f.runtime.chargers.charger1.identification.probe.startedAt, initial.probe.startedAt);
  assert.equal(f.writes.length, count, 'Restart cannot grant another normal-current allowance');
});

test('normal-current economic probe retains its energy-bound deadline through restart', async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { charging: false, autoCharge: true });
  await f.update();
  const initial = structuredClone(f.runtime.chargers.charger1.identification);
  const durationSeconds = (initial.probe.deadlineAt - initial.probe.startedAt) / 1000;
  assert.equal(durationSeconds, 34);
  assert.ok((durationSeconds + 10) * 12.144 / 3600 <= .15,
    'Full three-phase draw at the native 16 A limit and 253 V, including ten seconds of stop latency, fits the energy allowance');
  f.setNow(START + 10_000); f.physical.powerKw = 12.144;
  await f.restart(); await f.update();
  const resumed = f.runtime.chargers.charger1.identification;
  assert.equal(resumed.id, initial.id); assert.deepEqual(resumed.probe, initial.probe);
  assert.equal(resumed.phase, 'charging');
  f.setNow(initial.probe.deadlineAt); await f.update();
  assert.equal(f.physical.charging, false);
  f.setNow(f.now + 1000); await f.update();
  const ended = f.runtime.chargers.charger1.identification;
  assert.equal(ended.phase, 'inconclusive'); assert.ok(ended.chargeUsedKwh <= .15);
  assert.ok(f.writes.filter(row => row.action === 'SetChargingProfile').every(row =>
    row.payload.csChargingProfiles.chargingSchedule.chargingSchedulePeriod.every(period => period.limit === 0)),
  'No positive current profile is installed');
});

for (const transport of ['cloud', 'ocpp']) test(`${transport}: unassigned Tesla uses the same unbounded normal-charging observation lifecycle`, async t => {
  const f = await fixture(t, transport, 'tesla', { normalCharging: true });
  await f.update();
  const initial = structuredClone(f.runtime.chargers.charger1.identification);
  assert.equal(initial.phase, 'charging'); assert.equal(f.view().id, null);
  f.setNow(START + 78 * MINUTE); await f.update();
  const pending = f.runtime.chargers.charger1.identification;
  assert.equal(pending.id, initial.id); assert.equal(pending.phase, 'charging');
  assert.equal(pending.probe, null); assert.equal(pending.chargeDeadlineAt, null); assert.equal(pending.chargeUsedKwh, 0);
  assert.equal(f.physical.charging, true); assert.equal(f.writes.length, 0);
  f.tesla.fields = { charger_power: { value: 7, receivedAt: f.now, retained: false },
    plugged_in: { value: true, receivedAt: START, retained: false },
    charging_state: { value: 'Charging', receivedAt: START, retained: false } };
  await f.update();
  assert.equal(f.view().id, 'tesla'); assert.equal(f.runtime.chargers.charger1.identification.phase, 'completed');
  assert.equal(f.writes.length, 0, 'Fresh Tesla power identifies the current connection without an unnecessary pause');
});

test('unassigned Tesla receives the same economic OCPP probe allowance and restoration without matching power', async t => {
  const f = await fixture(t, 'ocpp', 'tesla', { charging: false, autoCharge: true });
  await f.update();
  assert.equal(f.writes.length, 0, 'The ordinary native current is allowed without installing a positive profile');
  const initial = structuredClone(f.runtime.chargers.charger1.identification), probe = initial.probe;
  assert.ok(probe.deadlineAt - probe.startedAt <= 34_000);
  f.setNow(f.now + 30_000); await f.update();
  assert.equal(f.runtime.chargers.charger1.identification.phase, 'charging'); assert.equal(f.view().id, null);
  assert.equal(f.physical.powerKw, 7);
  f.setNow(probe.deadlineAt); await f.update();
  f.setNow(f.now + 1000); await f.update();
  const stopped = f.runtime.chargers.charger1.identification;
  assert.equal(stopped.phase, 'inconclusive'); assert.equal(stopped.candidate, null); assert.equal(f.physical.charging, false);
  assert.ok(stopped.chargeUsedKwh > 0 && stopped.chargeUsedKwh <= .15);
  const count = f.writes.filter(row => row.action === 'SetChargingProfile').length;
  f.setNow(f.now + 5 * MINUTE); await f.restart(); await f.update();
  assert.equal(f.runtime.chargers.charger1.identification.id, initial.id);
  assert.deepEqual(f.runtime.chargers.charger1.identification.probe, stopped.probe);
  assert.equal(f.physical.charging, false);
  assert.equal(f.writes.filter(row => row.action === 'SetChargingProfile').length, count,
    'Missing Tesla power and restart cannot grant another automatic energy allowance');
  f.setNow(FUTURE + 1000); await f.update();
  assert.equal(f.physical.charging, true, 'Ordinary scheduled charging proceeds after the exhausted probe');
  f.tesla.actualPowerKw = f.physical.powerKw;
  f.tesla.fields = { charger_power: { value: f.physical.powerKw, receivedAt: f.now, retained: false },
    plugged_in: { value: true, receivedAt: START, retained: false },
    charging_state: { value: 'Charging', receivedAt: f.now, retained: false } };
  await f.update();
  assert.equal(f.view().id, 'tesla'); assert.equal(f.runtime.chargers.charger1.identification.phase, 'completed');
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

test('repeated identification wakeups cannot starve an explicit queued takeover', async t => {
  const f = await fixture(t, 'ocpp', 'bmw', { retainedOnly: true }); await f.update();
  const finish = [], calls = [];
  f.runtime.reconcileCharger = async (id, options) => {
    calls.push(options); await new Promise(resolve => finish.push(resolve));
  };
  const flight = f.runtime.reconcile('charger1');
  const takeover = f.runtime.reconcile('charger1', { takeover: 'fixture-takeover-token' });
  ChargingRuntime.prototype.tick.call(f.runtime, { force: true });
  ChargingRuntime.prototype.tick.call(f.runtime, { force: true });
  finish[0](); await flight;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2); assert.equal(calls[1].takeover, 'fixture-takeover-token');
  finish[1](); await takeover;
  assert.equal(f.runtime.chargers.charger1.reconcileFlight, null);
});

test('serialized BMW pauses wait for a quiet peer after the first attempt is exhausted', async t => {
  const f = await fixture(t, 'cloud'); f.physical.pauseBlocked = true; f.setNow(START + 1000); await f.update();
  const first = f.runtime.chargers.charger1, second = f.runtime.chargers.charger2;
  const control = structuredClone(first.controller.status());
  Object.assign(control.snapshot, { mode: 3, modeAt: f.now, powerKw: 7, powerAt: f.now,
    schedule: normalizeScheduleState({ enabled: 'none' }),
    observations: { 109: { value: 3, at: f.now }, 120: { value: 7, at: f.now } } });
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
  control.snapshot.observations[120].at = f.now;
  f.runtime.telemetry(f.now);
  assert.equal(first.identification.phase, 'inconclusive');
  assert.equal(second.identification.phase, 'charging', 'An expired attempt cannot immediately hand off another pause with stale peer evidence');
  assert.equal(second.identification.chargeDeadlineAt, null);
  assert.equal(second.identification.pauseUntil, null);
  const exhausted = structuredClone(first.identification);
  f.physical.pauseBlocked = false;
  await f.update();
  assert.equal(f.physical.charging, false, 'The first charger resumes its ordinary economic waiting plan');
  f.setNow(f.now + MINUTE + 1000);
  await f.update();
  control.snapshot.readAt = f.now; control.snapshot.powerAt = f.now;
  control.snapshot.observations[120].at = f.now;
  f.runtime.telemetry(f.now);
  assert.equal(second.identification.phase, 'pausing', 'A fresh stable peer permits the queued BMW pause after the quiet window');
  const secondDeadline = second.identification.pauseUntil;
  f.setNow(f.now + 1000); f.runtime.telemetry(f.now);
  assert.equal(second.identification.pauseUntil, secondDeadline);
  assert.equal(first.identification.id, exhausted.id); assert.equal(first.identification.phase, 'inconclusive');
  assert.equal(first.identification.pauseUntil, exhausted.pauseUntil);
  assert.equal(first.identification.probe.endedAt, exhausted.probe.endedAt);
});
