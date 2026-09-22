import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { chargingSettings } from '../src/charging/settings.js';
import { normalizeScheduleState, scheduleFingerprint, delayedScheduleFor } from '../src/charging/easee.js';

const HOUR = 3_600_000, initialNow = Date.parse('2026-01-15T00:00:00Z');
function fixture(saved = {}, charging = {}) {
  let now = initialNow;
  const values = new Map(Object.entries(saved)), writes = [];
  const store = {
    getState: key => structuredClone(values.get(key)),
    setState(key, value) {
      if (store.fail) throw new Error('database temporarily locked');
      writes.push(key); values.set(key, structuredClone(value));
    },
  };
  const engine = {};
  const options = { engine, store, config: { input: 'mqtt', charging }, clock: () => now, canControl: () => true };
  const create = () => {
    const runtime = new ChargingRuntime(options);
    runtime.teslaCapture = { snapshot: () => ({ connected: true, pluggedIn: false, assignment: 'bmw' }) };
    return runtime;
  };
  return { store, values, writes, engine, config: options.config, create, setNow: value => { now = value; }, clock: () => now };
}
function fakeAdapter(clock) {
  let schedule = normalizeScheduleState({ enabled: 'none' });
  const observed = { online: true, enabled: true, mode: 2, pluggedIn: true, manualStop: false, outputPhase: 30, powerKw: 0 };
  const limits = { circuitA: [16, 16, 16], chargerA: 16, cableA: 32,
    dynamicChargerA: 16, equalizerAvailableA: [16, 16, 16] };
  const calls = [];
  const snapshot = () => ({ schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule),
    controlFingerprint: 'unchanged-control', controlKnown: true, ...observed, reason: schedule.enabled === 'none' ? 0 : 54,
    readAt: clock(), limits: structuredClone(limits),
    observations: { ...(observed.powerMeasuredAt === undefined ? {} : { 120: { at: observed.powerMeasuredAt } }),
      ...(observed.modeAt === undefined ? {} : { 109: { at: observed.modeAt } }) },
    supply: { availableCurrentA: [...limits.equalizerAvailableA], propertyCurrentA: [0, 0, 0],
      chargerCurrentA: [0, 0, 0], voltageV: [230, 230, 230], observedAt: clock() } });
  return {
    calls,
    setSchedule(value) { schedule = normalizeScheduleState(value); },
    setObservation(value) { Object.assign(observed, value); },
    setLimits(value) { Object.assign(limits, value); },
    async read() { calls.push({ kind: 'read' }); return snapshot(); },
    async installDelayed(input) {
      assert.equal(input.canMutate(), true);
      assert.equal(input.startAt % 1000, 0);
      calls.push({ kind: 'install', startAt: input.startAt, maximumAmps: input.maximumAmps });
      schedule = normalizeScheduleState({ ...schedule, enabled: 'delayed', delayed: delayedScheduleFor(input, clock()) });
      return snapshot();
    },
    async clear(input) {
      assert.equal(input.canMutate(), true);
      assert.equal(input.expectedFingerprint, scheduleFingerprint(schedule));
      calls.push({ kind: 'clear' });
      schedule = normalizeScheduleState({ ...schedule, enabled: 'none' });
      return snapshot();
    },
  };
}
const preferences = chargingSettings({ chargers: { charger1: { enabled: true, capacityKwh: 20 } } });
const prices = [20, 1, 1, 20].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
const chargerView = (runtime, id = 'charger1') => runtime.status().chargers.find(item => item.id === id);
const packet = (soc, at, readingId = 'reading-1', extra = {}) => JSON.stringify({ provider: 'bmw-cardata', soc, measuredAt: at, readingId, ...extra });

test('BMW live plug and charging evidence received before the first Easee poll identifies after the matching stop', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  const measuredAt = initialNow - 5_000;
  f.setNow(initialNow - 3_000);
  runtime.receiveSoc(topic, packet(60, measuredAt, 'bmw-start', {
    atHome: true, pluggedIn: true, charging: true,
    fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt, readingId: `${key}-start` }])),
  }));
  f.setNow(initialNow);
  const adapter = fakeAdapter(f.clock);
  adapter.setObservation({ mode: 3, modeAt: measuredAt });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.connectedAt, initialNow);
  assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [measuredAt]);
  assert.equal(chargerView(runtime).vehicle.state, 'unidentified', 'A start alone still cannot identify BMW');
  f.setNow(initialNow + 60_000);
  const stoppedAt = initialNow + 55_000;
  adapter.setObservation({ mode: 2, modeAt: stoppedAt }); await runtime.reconcile();
  runtime.receiveSoc(topic, JSON.stringify({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: stoppedAt, readingId: 'bmw-stop' } } }));
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  assert.equal(chargerView(runtime).values.soc.value, 60);
  assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.stoppedTimes, [stoppedAt]);
  assert.equal(adapter.calls.some(call => call.kind !== 'read'), false);
});

test('BMW polling tolerance cannot borrow an earlier connection across disconnect, unknown telemetry and restart', async t => {
  const f = fixture(), original = f.create(); t.after(() => original.close());
  const adapter = fakeAdapter(f.clock), topic = original.configuration.vehicles.bmw.mqttTopic;
  adapter.setObservation({ mode: 3, modeAt: initialNow });
  await original.setAdapter('charger1', adapter); await original.reconcile();
  original.receiveSoc(topic, packet(60, initialNow, 'previous-connection', {
    atHome: true, pluggedIn: true, charging: true,
    fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt: initialNow, readingId: `${key}-previous` }])),
  }));
  f.setNow(initialNow + 30_000);
  adapter.setObservation({ pluggedIn: false, mode: 1, modeAt: f.clock() }); await original.reconcile();
  assert.equal(chargerView(original).control.session.lastDisconnectedAt, f.clock());
  await original.close();
  f.setNow(initialNow + 40_000);
  adapter.setObservation({ pluggedIn: null, mode: null, controlKnown: false });
  const runtime = f.create(); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, initialNow + 30_000);
  f.setNow(initialNow + 60_000);
  adapter.setObservation({ pluggedIn: true, mode: 3, modeAt: initialNow, controlKnown: true }); await runtime.reconcile();
  assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [], 'Cached mode from the previous connection is excluded');
  adapter.setObservation({ modeAt: initialNow + 55_000 }); await runtime.reconcile();
  assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [initialNow + 55_000]);
  f.setNow(initialNow + 90_000);
  adapter.setObservation({ mode: 2, modeAt: initialNow + 85_000 }); await runtime.reconcile();
  runtime.receiveSoc(topic, JSON.stringify({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: initialNow + 85_000, readingId: 'later-stop' } } }));
  assert.equal(chargerView(runtime).vehicle.state, 'unidentified', 'Unconsumed BMW events before the disconnect cannot match the new car');
  assert.equal(runtime.vehicleFeeds.bmw.consumedPlugId, null);
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, initialNow + 30_000);
});

test('runtime preferences, automatic readings and saved SoC fallbacks survive restart', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSettings({ chargers: { charger1: { capacityKwh: 62, readyBy: '08:00' }, charger2: { capacityKwh: 51 } } });
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(30, initialNow - HOUR));
  await runtime.setChargerSettings('charger1', { manualSoc: 46 });
  const restarted = f.create();
  assert.equal(restarted.settings.chargers.charger1.capacityKwh, 62);
  assert.equal(restarted.settings.chargers.charger2.capacityKwh, 51);
  assert.equal(restarted.settings.chargers.charger1.manualSoc, 46);
  assert.equal(chargerView(restarted).values.soc.source, 'manual-fallback');
  assert.equal(chargerView(restarted).values.soc.value, 46);
  assert.equal(restarted.vehicleFeeds.bmw.reading.measuredAt, initialNow - HOUR);
  assert.equal(restarted.chargers.charger1.manualSoc, undefined);
  assert.equal(restarted.settings.timezone, undefined);
  assert.equal(restarted.status().timezone, 'Europe/Helsinki');
  await runtime.close(); await restarted.close();
});

test('MQTT replay does not rewrite state and unknown-clock observations recover to known measurement times', async () => {
  const f = fixture(), runtime = f.create();
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(30, null));
  const before = f.writes.length;
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(30, null));
  assert.equal(f.writes.length, before);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(45, initialNow, 'reading-2'));
  assert.equal(runtime.vehicleFeeds.bmw.reading.soc, 45);
  assert.equal(runtime.vehicleFeeds.bmw.reading.measuredAt, initialNow);
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(90, initialNow - 1, 'reading-old'));
  assert.equal(runtime.vehicleFeeds.bmw.reading.soc, 45);
  await runtime.close();
  assert.equal(runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(80, initialNow + HOUR, 'reading-after-close')), false);
});

test('vehicle MQTT distinguishes transport reception, retained context and invalid readings without refreshing battery clocks', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.setMqttStatus({ connected: true, subscribed: false, reason: 'awaiting-subscription' }, 'charger1');
  assert.equal(chargerView(runtime).mqtt.brokerConnected, true);
  assert.equal(chargerView(runtime).mqtt.subscriptionStatus, 'pending');
  runtime.setMqttStatus({ connected: true, subscribed: true, reason: null }, 'charger1');
  const reading = packet(51, initialNow - HOUR, 'bmw-reading', { provider: 'bmw-cardata', chargeLimitSoc: 80 });
  runtime.receiveSoc(topic, reading, { retain: true });
  let mqtt = chargerView(runtime).mqtt;
  assert.equal(mqtt.provider, 'bmw-cardata'); assert.equal(mqtt.subscriptionStatus, 'subscribed');
  assert.equal(mqtt.lastRetainedAt, initialNow); assert.equal(mqtt.lastLiveAt, null);
  const automatic = structuredClone(runtime.vehicleFeeds.bmw.reading), writes = f.writes.length;
  f.setNow(initialNow + 60_000);
  runtime.receiveSoc(topic, reading, { dup: true });
  mqtt = chargerView(runtime).mqtt;
  assert.equal(mqtt.lastMessageAt, f.clock()); assert.equal(mqtt.lastLiveAt, f.clock()); assert.equal(mqtt.lastValidAt, f.clock());
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, automatic);
  assert.equal(f.writes.length, writes, 'A repeated report confirms reception without rewriting the measurement');
  f.setNow(initialNow + 120_000);
  runtime.receiveSoc(topic, '{malformed');
  mqtt = chargerView(runtime).mqtt;
  assert.equal(mqtt.subscribed, true); assert.equal(mqtt.reason, null); assert.equal(mqtt.invalidReason, 'malformed-json');
  assert.equal(mqtt.lastLiveAt, f.clock()); assert.equal(mqtt.lastValidAt, initialNow + 60_000);
  runtime.receiveSoc(topic, reading);
  assert.equal(chargerView(runtime).mqtt.invalidReason, null, 'A valid duplicate recovers payload health');
  runtime.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
  assert.equal(chargerView(runtime).mqtt.subscriptionStatus, 'disconnected');
  const restarted = f.create(); t.after(() => restarted.close());
  mqtt = chargerView(restarted).mqtt;
  assert.equal(mqtt.provider, 'bmw-cardata', 'Provider identity survives restart with its saved reading');
  assert.equal(mqtt.brokerConnected, false); assert.equal(mqtt.lastLiveAt, null); assert.equal(mqtt.lastRetainedAt, null);
  assert.equal(mqtt.lastMessageAt, null, 'Saved measurements do not imply reception in this process');
});

test('BMW duplicate publications preserve measurement clocks and invalid providers cannot replace them', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  const reading = packet(51, initialNow - HOUR, 'original-reading', { chargeLimitSoc: 80, usableCapacityKwh: 72 });
  runtime.receiveSoc(topic, reading);
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(topic, JSON.stringify({ ...JSON.parse(reading), provider: 'bmw-cardata' }));
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, { ...original, provider: 'bmw-cardata' });
  assert.equal(chargerView(runtime).mqtt.provider, 'bmw-cardata');
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(chargerView(restarted).mqtt.provider, 'bmw-cardata');
  runtime.receiveSoc(topic, packet(55, f.clock(), 'next-reading', { provider: 'invented-provider' }));
  assert.equal(chargerView(runtime).mqtt.invalidReason, 'invalid-provider');
  assert.equal(chargerView(runtime).mqtt.provider, 'bmw-cardata');
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, { ...original, provider: 'bmw-cardata' });
});

test('unassigned automatic SoC never overrides the saved manual fallback or acquires an expiry', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setChargerSettings('charger1', { manualSoc: 47 });
  assert.equal(chargerView(runtime).values.soc.value, 47);
  assert.equal(chargerView(runtime).values.soc.source, 'manual-fallback');
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(65, initialNow));
  assert.equal(chargerView(runtime).values.soc.value, 47);
  await runtime.setChargerSettings('charger1', { readyBy: '08:00', manualSoc: 55 });
  f.setNow(initialNow + 24 * HOUR); runtime.tick();
  assert.equal(chargerView(runtime).values.soc.value, 55);
  assert.equal(chargerView(runtime).values.soc.source, 'manual-fallback');
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 55);
  assert.equal(chargerView(runtime).values.soc.expiresAt, undefined);
  await runtime.close();
});

test('configuration topic changes invalidate persisted vehicle readings without assigning them to a charger', async () => {
  const f = fixture(), runtime = f.create();
  const oldTopic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(oldTopic, packet(31, initialNow));
  await runtime.setChargerSettings('charger1', { manualSoc: 49 });
  await runtime.close();
  f.config.charging = { chargers: { charger1: { mqttTopic: 'stmq/test/replacement-vehicle', efficiency: .85 } } };
  const restarted = f.create();
  assert.equal(restarted.vehicleFeeds.bmw.reading, null);
  assert.equal(chargerView(restarted).values.soc.value, 49);
  assert.equal(chargerView(restarted).values.soc.source, 'manual-fallback');
  assert.equal(restarted.receiveSoc(oldTopic, packet(95, initialNow)), false);
  assert.equal(restarted.receiveSoc(restarted.configuration.vehicles.bmw.mqttTopic, packet(54, initialNow)), true);
  assert.equal(chargerView(restarted).values.soc.value, 49);
  assert.equal(chargerView(restarted).configuration.efficiency, .925);
  assert.deepEqual(restarted.mqttRoutes().map(route => route.topic), ['stmq/test/replacement-vehicle']);
  await restarted.close();
});

test('failed persistence rolls saved fallbacks, preferences and automatic readings back', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setChargerSettings('charger1', { manualSoc: 43 });
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(topic, packet(31, initialNow));
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.store.fail = true;
  await assert.rejects(runtime.setChargerSettings('charger1', { manualSoc: 60 }), /locked/);
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 43);
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityKwh: 63 }), /locked/);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 74);
  assert.throws(() => runtime.receiveSoc(topic, packet(45, initialNow + 1, 'reading-new')), /locked/);
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original);
  assert.equal(chargerView(runtime).values.soc.value, 43);
  f.store.fail = false;
  await runtime.close();
});

test('adapter startup reads ownership before an outlook and does not release a waiting session from an empty startup price array', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter('charger1', adapter);
  await runtime.reconcile();
  assert.equal(runtime.chargers.charger1.plan, null);
  assert.equal(chargerView(runtime).control.released, false);
  assert.ok(adapter.calls.every(call => call.kind === 'read'));
  runtime.tick({ prices });
  await runtime.reconcile();
  assert.equal(runtime.chargers.charger1.plan.state, 'waiting');
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(runtime.chargers.charger1.plan.startAt, initialNow + HOUR);
});

test('OFF revokes automatic intent and relinquishes only the owned schedule even when forecast work fails', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter('charger1', adapter);
  await runtime.reconcile();
  runtime.tick({ prices });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  runtime.updatePlan = () => { throw new Error('forecast history temporarily unavailable'); };
  await runtime.setChargerSettings('charger1', { enabled: false });
  assert.equal(runtime.settings.chargers.charger1.enabled, false);
  assert.equal(chargerView(runtime).control.phase, 'off');
  assert.equal(chargerView(runtime).control.handoverConfirmed, true);
  assert.equal(runtime.status().error, 'charging-planning-unavailable');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('a released connected session retains its actual plan through new SoC, deadline edits and temporary zero power', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter('charger1', adapter);
  await runtime.reconcile();
  runtime.tick({ prices });
  await runtime.reconcile();
  const installed = structuredClone(runtime.chargers.charger1.plan);
  f.setNow(installed.startAt);
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.released, true);
  assert.equal(chargerView(runtime).values.scheduledStartAt.value, installed.startAt,
    'The owned delayed occurrence cannot roll forward to tomorrow after its release');
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(90, installed.startAt, 'reading-now'));
  await runtime.setChargerSettings('charger1', { readyBy: '08:00' });
  assert.deepEqual(runtime.chargers.charger1.plan, installed);
  assert.equal(chargerView(runtime).values.soc.value, 20, 'An unidentified feed cannot change this session');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 0);
});

test('runtime uses the same controller phase contract before an adapter is attached', async () => {
  const f = fixture(), runtime = f.create();
  assert.equal(chargerView(runtime).control.phase, 'off');
  await runtime.setChargerSettings('charger1', { enabled: true });
  assert.equal(chargerView(runtime).control.phase, 'unavailable');
  await runtime.close();
});

test('plan identity survives pending replans and runtime restart, and changes after an explicit new deadline', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const id = runtime.chargers.charger1.plan.id;
  assert.match(id, /^[0-9a-f-]{36}$/); assert.equal(chargerView(runtime).control.owned.planId, id);
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(20, initialNow, 'new-soc'));
  await runtime.reconcile(); assert.equal(runtime.chargers.charger1.plan.id, id);
  const restarted = f.create();
  assert.equal(restarted.chargers.charger1.plan.id, id); await restarted.close();
  await runtime.setChargerSettings('charger1', { readyBy: '07:00' });
  assert.notEqual(runtime.chargers.charger1.plan.id, id);
});

test('manual window handback replans from newer SoC before issuing a release based on the old start', async t => {
  const settings = chargingSettings({ ...preferences, chargers: { ...preferences.chargers,
    charger1: { ...preferences.chargers.charger1, capacityKwh: 30, manualSoc: 0 } } });
  const f = fixture({ 'charging:mqtt': { settings } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  const outlook = [20, 3, 20, 1].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
  runtime.tick({ prices: outlook }); await runtime.reconcile();
  const originalStart = runtime.chargers.charger1.plan.startAt;
  assert.ok(originalStart < initialNow + 2 * HOUR);
  adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '00:15', stopTime: '02:00', maximumAmps: 16 }] } });
  f.setNow(initialNow + HOUR / 2); await runtime.reconcile();
  adapter.setObservation({ mode: 3 }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'yielded');
  runtime.chargers.charger1.vehicleMatch = { id: 'bmw', connectedAt: chargerView(runtime).control.session.connectedAt, matchedAt: f.clock() };
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(85, f.clock(), 'manual-window-result'));
  assert.equal(runtime.chargers.charger1.plan.startAt, originalStart, 'The active manual session keeps its original plan context');
  f.setNow(initialNow + 2 * HOUR); adapter.setObservation({ mode: 2 });
  runtime.tick(); await runtime.reconcile();
  assert.equal(runtime.chargers.charger1.plan.startAt, initialNow + 3 * HOUR);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 0);
});

test('adapter replacement waits for an in-flight confirmed write before loading ownership', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const install = adapter.installDelayed;
  adapter.installDelayed = async input => {
    const result = await install(input); started();
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  runtime.tick({ prices }); const writing = runtime.reconcile(); await begun;
  const old = runtime.chargers.charger1.controller;
  const replacement = runtime.setAdapter('charger1', adapter);
  await Promise.resolve(); assert.equal(runtime.chargers.charger1.controller, old);
  release(); await writing; await replacement; await runtime.reconcile();
  assert.notEqual(runtime.chargers.charger1.controller, old);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('runtime close drains an outstanding adapter replacement without creating a new controller', async () => {
  const f = fixture(), runtime = f.create(), adapter = fakeAdapter(f.clock);
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const read = adapter.read;
  adapter.read = async () => { started(); await new Promise(resolve => { release = resolve; }); return read(); };
  await runtime.setAdapter('charger1', adapter); await begun;
  const old = runtime.chargers.charger1.controller;
  const replace = runtime.setAdapter('charger1', fakeAdapter(f.clock));
  const closing = runtime.close();
  release(); await replace; await closing;
  assert.equal(runtime.chargers.charger1.controller, old);
  const count = f.writes.length;
  await Promise.resolve(); assert.equal(f.writes.length, count);
});

test('a disconnected charger has no schedule and a later plug-in uses the new readiness deadline', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ pluggedIn: false, mode: 1 });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const parked = structuredClone(runtime.chargers.charger1.plan);
  assert.equal(chargerView(runtime).control.phase, 'disconnected');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 0);
  f.setNow(initialNow + 48 * HOUR);
  const nextPrices = prices.map(row => ({ ...row, start: row.start + 48 * HOUR, end: row.end + 48 * HOUR }));
  runtime.tick({ prices: nextPrices });
  adapter.setObservation({ pluggedIn: true, mode: 2 });
  await runtime.reconcile();
  assert.notEqual(runtime.chargers.charger1.plan.id, parked.id);
  assert.equal(runtime.chargers.charger1.plan.deadlineAt, parked.deadlineAt + 48 * HOUR);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(chargerView(runtime).control.owned.startAt, initialNow + 49 * HOUR);
});

test('OFF with unavailable Easee and saved ownership reports unconfirmed handover', async () => {
  const f = fixture({ 'charging:mqtt:charger1:ownership': { version: 1, owned: { planId: 'prior-plan' } } }), runtime = f.create();
  await runtime.setChargerSettings('charger1', { enabled: false });
  assert.equal(chargerView(runtime).control.phase, 'off');
  assert.equal(chargerView(runtime).control.handoverConfirmed, false);
  assert.match(chargerView(runtime).control.reason, /handover is unconfirmed/);
  await runtime.close();
});

test('machine connections and efficiency cannot be edited through charging preferences', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile(); runtime.tick({ prices }); await runtime.reconcile();
  for (const patch of [{ mqtt: { topic: 'stmq/test/replacement-topic' } }, { mqttTopic: 'stmq/test/replacement-topic' }, { efficiency: .8 }])
    await assert.rejects(runtime.setChargerSettings('charger1', patch), /Unknown charging charger1 setting/);
  await assert.rejects(runtime.setSettings({ installation: { mainFuseA: 25 } }), /Unknown charging setting/);
  await assert.rejects(runtime.setSettings({ readinessMarginMinutes: 15 }), /Unknown charging setting/);
  await assert.rejects(runtime.setSettings({ timezone: 'UTC' }), /Unknown charging setting/);
  runtime.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
  await runtime.setChargerSettings('charger1', { enabled: false });
  assert.equal(chargerView(runtime).control.phase, 'off'); assert.equal(chargerView(runtime).control.handoverConfirmed, true);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('independent vehicle readings cannot overwrite either charger manual defaults without identification', async t => {
  const f = fixture({}, { chargers: { charger2: { mqttTopic: 'stmq/garage/charger2/vehicle' } } }), runtime = f.create();
  t.after(() => runtime.close());
  await runtime.setChargerSettings('charger2', { readyBy: '09:00', capacityKwh: 59, minimumSoc: 75, manualSoc: 54 });
  await runtime.setChargerSettings('charger1', { manualSoc: 46 });
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(61, initialNow));
  runtime.receiveSoc(runtime.configuration.chargers.charger2.mqttTopic, packet(32, initialNow, 'second-reading'));
  assert.equal(chargerView(runtime, 'charger1').values.soc.value, 46);
  assert.equal(chargerView(runtime, 'charger2').values.soc.value, 54);
  f.setNow(initialNow + 48 * HOUR); runtime.tick();
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(chargerView(restarted, 'charger1').values.soc.value, 46);
  assert.equal(chargerView(restarted, 'charger2').values.soc.value, 54);
  assert.equal(restarted.settings.chargers.charger2.capacityKwh, 59);
  assert.equal(restarted.settings.chargers.charger2.minimumSoc, 75);
  assert.equal(restarted.settings.chargers.charger1.manualSoc, 46);
  assert.equal(restarted.settings.chargers.charger2.manualSoc, 54);
  assert.equal(f.values.get('charging:mqtt').version, 4);
  assert.deepEqual(runtime.mqttRoutes().map(route => route.id), ['bmw', 'legacy-charger2']);
});

test('a generic vehicle feed on the Tesla charger exposes its own independent reception status', async t => {
  const f = fixture({}, { chargers: { charger2: { mqttTopic: 'invented/second-vehicle' } } }), runtime = f.create();
  t.after(() => runtime.close());
  runtime.teslaCapture.reception = () => ({ brokerConnected: true, subscribed: true, lastLiveAt: initialNow });
  runtime.setMqttStatus({ connected: true, subscribed: false, reason: 'mqtt-subscription-failed' }, 'charger2');
  const second = chargerView(runtime, 'charger2');
  assert.equal(second.mqtt.subscribed, true, 'The Tesla subscription retains its existing status contract');
  assert.equal(second.vehicleMqtt.subscribed, false); assert.equal(second.vehicleMqtt.subscriptionStatus, 'failed');
  assert.equal(second.vehicleMqtt.lastLiveAt, null); assert.equal(second.vehicleMqtt.provider, null);
});

test('unsupported scheduling and invalid charger identifiers reject without affecting another charger', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await assert.rejects(runtime.setChargerSettings('charger2', { enabled: true }), /does not support/);
  await assert.rejects(runtime.resume('charger2', {}), /does not support/);
  await assert.rejects(runtime.setChargerSettings('missing', { manualSoc: 80 }), /Unknown charger/);
  assert.equal(runtime.settings.chargers.charger1.enabled, false);
  assert.equal(runtime.settings.chargers.charger2.enabled, false);
  assert.throws(() => fixture({}, { chargers: { charger2: { mqttTopic: runtime.configuration.vehicles.bmw.mqttTopic } } }).create(), /different vehicle MQTT topic/);
});

test('vehicle association routes battery values once and preserves Equalizer electrical authority', async t => {
  const f = fixture(), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  const vehicle = { connected: true, pluggedIn: true, atHome: true, assignment: 'easee', batteryLevel: 63,
    chargeLimitSoc: 85, requestedCurrentA: 13, maxCurrentA: 16, phases: 3, voltageV: 230,
    actualPowerKw: 0, charging: false, scheduledStartAt: initialNow + HOUR };
  runtime.teslaCapture = { snapshot: () => vehicle };
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile(); runtime.tick({ prices });
  assert.equal(chargerView(runtime).values.soc.value, 63);
  assert.equal(chargerView(runtime).values.minimumSoc.value, 85);
  assert.equal(chargerView(runtime).values.currentA.value, 16);
  assert.equal(chargerView(runtime, 'charger2').automatic.soc.available, false);
  assert.equal(chargerView(runtime, 'charger2').forecast.state, 'none', 'The same Tesla cannot also reserve Charger 2');
  vehicle.assignment = 'auto'; adapter.setObservation({ pluggedIn: false }); await runtime.reconcile();
  assert.equal(chargerView(runtime, 'charger2').values.connected.value, false, 'Stale Tesla plug context cannot rebound as Charger 2');
  f.setNow(initialNow + 60_000); vehicle.fields = { plugged_in: { receivedAt: f.clock(), retained: false } }; runtime.tick();
  assert.equal(chargerView(runtime).automatic.soc.available, false);
  assert.equal(chargerView(runtime, 'charger2').automatic.soc.available, true,
    'The configured Charger 2 feed never depends on a probing verdict');
  assert.equal(chargerView(runtime, 'charger2').values.soc.value, 63);
  assert.equal(chargerView(runtime, 'charger2').values.connected.value, true);
  assert.notEqual(chargerView(runtime, 'charger2').forecast.state, 'none', 'An actual reported future schedule remains a possible competing load');
});

test('initial identification waits at most three minutes and identified Tesla overrides another vehicle MQTT reading', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  let verdict = null;
  f.engine.chargerIdentification = { status: () => ({ enabled: true, phase: verdict ? 'identified' : 'idle', verdict, identifiedAt: verdict ? f.clock() : null }) };
  runtime.teslaCapture = { snapshot: () => ({ connected: true, pluggedIn: true, atHome: true, assignment: 'auto',
    batteryLevel: 70, chargeLimitSoc: 90, charging: true, actualPowerKw: 11, requestedCurrentA: 16, voltageV: 230 }) };
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic,
    packet(10, initialNow, 'other-vehicle', { usableCapacityKwh: 50, chargeLimitSoc: 80 }));
  runtime.tick({ prices });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'identifying');
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 0);
  verdict = 'easee'; f.setNow(initialNow + 60_000); await runtime.reconcile();
  const identified = chargerView(runtime);
  assert.equal(identified.values.soc.value, 70); assert.equal(identified.values.minimumSoc.value, 90);
  assert.equal(identified.values.capacityKwh.value, runtime.settings.chargers.charger2.capacityKwh);
  assert.equal(chargerView(runtime, 'charger2').values.connected.value, false);
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 1);
  verdict = null; runtime.tick();
  assert.equal(chargerView(runtime).values.soc.value, 70, 'Identified vehicle persists through planned pauses');
  adapter.setObservation({ pluggedIn: false, mode: 1 }); await runtime.reconcile();
  assert.equal(runtime.chargers.charger1.vehicleMatch, null);
});

test('inconclusive initial vehicle identification cannot postpone scheduling indefinitely', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  f.engine.chargerIdentification = { status: () => ({ enabled: true, phase: 'idle', verdict: null }) };
  runtime.teslaCapture = { snapshot: () => ({ connected: true, pluggedIn: true, atHome: true, assignment: 'auto' }) };
  runtime.tick({ prices }); await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'identifying');
  f.setNow(initialNow + 180_000); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 1);
});

test('first adapter attachment uses freshly read fixed limits when prices are already available', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setLimits({ chargerA: 14, cableA: 20, equalizerAvailableA: [6, 8, 7] });
  await runtime.setChargerSettings('charger1', { manualSoc: 40 });
  runtime.tick({ prices });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  const install = adapter.calls.find(call => call.kind === 'install');
  assert.ok(install, 'Fresh startup observations make an eligible native schedule concrete');
  assert.equal(install.maximumAmps, 14, 'Native ceiling is read from charger/cable, not a missing earlier snapshot or instantaneous Equalizer allowance');
});

test('offline Easee state cannot revive its last raw connection through a legacy alias', async t => {
  const f = fixture(), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).values.connected.value, true);
  adapter.setObservation({ online: false, controlKnown: false });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).values.connected.available, false);
  assert.equal(chargerView(runtime).values.connected.value, null);
});

test('a future second controller has independent plans and ownership while Equalizer keeps current authority', async t => {
  const f = fixture(), runtime = f.create(), firstAdapter = fakeAdapter(f.clock), secondAdapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  const currentCommands = [], secondDecisions = [];
  firstAdapter.setCurrent = async currentA => currentCommands.push({ id: 'charger1', currentA });
  secondAdapter.setCurrent = async currentA => currentCommands.push({ id: 'charger2', currentA });
  secondAdapter.capabilities = { scheduling: true, currentControl: true, externalLoadBalancing: false };
  secondAdapter.normalize = snapshot => ({
    connected: snapshot.pluggedIn ?? null, currentA: 14, maxCurrentA: 14, phases: [1, 1, 1], voltageV: 230,
    charging: false, powerKw: 0, limits: snapshot.limits ?? {},
    capabilities: secondAdapter.capabilities,
  });
  secondAdapter.createController = ({ adapter, saveState, getPlan }) => {
    let closed = false, state = { phase: 'off', released: false, snapshot: null, owned: null };
    return {
      status: () => structuredClone(state),
      async update({ enabled }) {
        if (closed) return;
        state.snapshot = await adapter.read();
        const plan = getPlan();
        state.phase = enabled ? plan?.state ?? 'unavailable' : 'off';
        state.owned = enabled && plan?.state === 'waiting' ? { planId: plan.id, startAt: plan.startAt } : null;
        secondDecisions.push({ enabled, planId: plan?.id, phase: state.phase });
        saveState({ version: 1, phase: state.phase, released: false, owned: state.owned });
      },
      async close() { closed = true; },
    };
  };
  const vehicle = { connected: true, pluggedIn: true, atHome: true, assignment: 'bmw', batteryLevel: 40,
    chargeLimitSoc: 80, requestedCurrentA: 3, maxCurrentA: 6, phases: 1, voltageV: 230, actualPowerKw: 0 };
  runtime.teslaCapture = { snapshot: () => vehicle };
  await runtime.setAdapter('charger1', firstAdapter);
  await runtime.setAdapter('charger2', secondAdapter);
  await runtime.reconcile();
  await runtime.setSettings({ chargers: { charger1: { enabled: true, capacityKwh: 20, readyBy: '06:00' },
      charger2: { enabled: true, capacityKwh: 10, readyBy: '05:00' } } });
  runtime.tick({ prices }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(first.plan.state, 'waiting');
  assert.equal(second.plan.state, 'waiting');
  assert.notEqual(first.plan.id, second.plan.id);
  assert.ok(second.plan.deadlineAt < first.plan.deadlineAt);
  assert.equal(second.values.currentA.value, 14, 'Tesla requested current cannot replace a real charger adapter allowance');
  assert.equal(second.values.phases.value, 3);
  assert.equal(f.values.get('charging:mqtt:charger1:ownership').owned.planId, first.plan.id);
  assert.equal(f.values.get('charging:mqtt:charger2:ownership').owned.planId, second.plan.id);
  assert(secondDecisions.some(decision => decision.enabled && decision.planId === second.plan.id));
  assert.equal(runtime.status().coordination.currentLimitsAreProposals, true);
  assert.ok(runtime.status().coordination.currentLimits.length > 0);
  assert.ok(runtime.status().coordination.currentLimits.every(limit => limit.chargerId === 'charger2'));
  assert.deepEqual(currentCommands, [], 'Coordination proposals never become Equalizer or unsupported dynamic-current writes');
  vehicle.assignment = 'auto'; runtime.tick();
  assert.equal(chargerView(runtime, 'charger2').values.connected.value, true,
    'Uncertain vehicle attribution cannot discard a confirmed second charger connection');
  await runtime.setChargerSettings('charger2', { enabled: false });
  assert.equal(runtime.settings.chargers.charger1.enabled, true);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(chargerView(runtime, 'charger2').control.phase, 'off');
});

test('an uncertain second connection with no reported schedule creates no competing reservation', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.teslaCapture = { snapshot: () => ({ connected: true, assignment: 'auto', pluggedIn: null, atHome: true }) };
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(second.values.connected.available, false);
  assert.equal(second.values.currentA.available, false);
  assert.equal(second.forecast.state, 'none');
  assert.equal(first.plan.state, 'waiting'); assert.equal(first.control.phase, 'waiting');
  assert.equal(first.plan.startAt, initialNow + HOUR);
});

test('disabling a configured MQTT source restores the saved fallback without retaining old vehicle data', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setChargerSettings('charger1', { manualSoc: 53 });
  const oldTopic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(oldTopic, packet(76, initialNow, 'automatic-value', { usableCapacityKwh: 66, chargeLimitSoc: 90 }));
  assert.equal(chargerView(runtime).values.soc.value, 53);
  f.config.charging = { chargers: { charger1: { mqttTopic: null } } };
  const restarted = f.create(); t.after(() => restarted.close());
  const view = chargerView(restarted);
  assert.equal(view.values.soc.value, 53); assert.equal(view.values.soc.source, 'manual-fallback');
  assert.equal(view.values.capacityKwh.value, 74); assert.equal(view.values.minimumSoc.value, 80);
  assert.equal(restarted.vehicleFeeds.bmw.reading, null);
  assert.deepEqual(restarted.mqttRoutes(), []); assert.equal(restarted.receiveSoc(oldTopic, packet(91, initialNow)), false);
});

test('inactive Easee schedule caches cannot move the owned delayed occurrence to tomorrow', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile(); runtime.tick({ prices }); await runtime.reconcile();
  const owned = structuredClone(chargerView(runtime).control.owned);
  f.setNow(owned.startAt);
  adapter.setSchedule({ ...owned.schedule, daily: { timezone: 'UTC',
    periods: [{ startTime: '03:00', stopTime: '04:00', maximumAmps: 16 }] } });
  await runtime.reconcile();
  const view = chargerView(runtime);
  assert.equal(view.control.phase, 'released'); assert.equal(view.control.manual, null);
  assert.equal(view.values.scheduledStartAt.value, owned.startAt);
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('new installations use 20% while saved SoC fallbacks remain intact', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  assert.deepEqual(runtime.status().chargers.map(charger => charger.values.soc.value), [20, 20]);
  await runtime.setChargerSettings('charger1', { manualSoc: 40 });
  const restarted = f.create(); t.after(() => restarted.close());
  assert.deepEqual(restarted.status().chargers.map(charger => charger.values.soc.value), [40, 20]);
});

test('measured energy lowers the remaining requirement once and survives restart without crediting the outage', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ powerKw: 6, powerMeasuredAt: initialNow, mode: 3 });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  const raw = chargerView(runtime).requiredGridKwh;
  runtime.readEnergy = () => ({ gridKwh: .1, coveredMs: 60_000, continuousSince: initialNow, lastMeasuredAt: initialNow + 60_000 });
  f.setNow(initialNow + 60_000); adapter.setObservation({ powerMeasuredAt: f.clock() });
  await runtime.reconcile();
  const progress = chargerView(runtime).progress;
  assert.ok(Math.abs(progress.creditedGridKwh - .1) < 1e-9);
  assert.ok(Math.abs(chargerView(runtime).requiredGridKwh - (raw - .1)) < 1e-9);
  assert.equal(chargerView(runtime).values.soc.value, 20);
  runtime.updatePlan(); runtime.updatePlan();
  assert.deepEqual(chargerView(runtime).progress, progress, 'Repeated status and planning reads cannot double-credit a sample');
  await runtime.close();
  f.setNow(initialNow + 3 * HOUR); adapter.setObservation({ powerMeasuredAt: f.clock() });
  const restarted = f.create(); t.after(() => restarted.close());
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).progress.creditedGridKwh, progress.creditedGridKwh);
  adapter.setObservation({ pluggedIn: false, mode: 1, powerKw: 0 }); await restarted.reconcile();
  assert.equal(chargerView(restarted).progress.creditedGridKwh, 0);
});

test('native periods pause at their boundary, preserve the active period through a ready-by edit and leave the final release open', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  const outlook = [1, 50, 2, 50, 50].map((price, index) => ({ start: initialNow + index * HOUR,
    end: initialNow + (index + 1) * HOUR, price }));
  runtime.tick({ prices: outlook }); await runtime.reconcile();
  const original = structuredClone(chargerView(runtime).control.execution);
  assert.equal(original.periods.length, 2);
  assert.equal(chargerView(runtime).control.phase, 'active');
  assert.equal(chargerView(runtime).control.released, false);
  assert.equal(runtime.boundaryAt, original.periods[0].endAt);
  f.setNow(initialNow + HOUR / 2);
  adapter.setObservation({ mode: 3 }); await runtime.reconcile();
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(45, f.clock(), 'first-period-progress'));
  await runtime.setChargerSettings('charger1', { readyBy: '07:00' });
  assert.deepEqual(chargerView(runtime).control.execution.periods, original.periods);
  assert.equal(chargerView(runtime).plan.deadlineAt, initialNow + 4 * HOUR);
  f.setNow(original.periods[0].endAt); adapter.setObservation({ mode: 2 });
  await runtime.reconcile();
  const paused = chargerView(runtime);
  assert.equal(paused.control.phase, 'paused');
  assert.equal(paused.control.released, false);
  assert.equal(paused.plan.deadlineAt, initialNow + 5 * HOUR);
  assert.notEqual(paused.control.execution.planId, original.planId);
  assert.equal(paused.control.owned.startAt, initialNow + 2 * HOUR);
  assert.equal(runtime.boundaryAt, paused.control.owned.startAt);
  f.setNow(initialNow + 2 * HOUR); adapter.setObservation({ mode: 3 });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'released');
  const writes = adapter.calls.filter(call => call.kind !== 'read').length;
  f.setNow(initialNow + 7 * HOUR); adapter.setObservation({ mode: 2 });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.released, true);
  assert.equal(adapter.calls.filter(call => call.kind !== 'read').length, writes);
});

test('manual handback crossing ready-by during the read starts the next cycle and does not roll ordinary overdue plans', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices: [...prices, ...prices.map(row => ({ ...row, start: row.start + 24 * HOUR, end: row.end + 24 * HOUR }))] });
  await runtime.reconcile();
  adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '01:00', stopTime: '04:00', maximumAmps: 16 }] } });
  f.setNow(initialNow + HOUR / 2); await runtime.reconcile();
  const manual = chargerView(runtime).control.manual;
  assert.equal(manual.resumeAt, initialNow + 4 * HOUR);
  assert.equal(manual.windowEndAt, manual.cycleEndsAt, 'An exact window/deadline tie also ends the cycle');
  f.setNow(manual.resumeAt - 10);
  const read = adapter.read;
  adapter.read = async () => { f.setNow(f.clock() + 25); return read(); };
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.manual, null);
  assert.equal(chargerView(runtime).plan.deadlineAt, initialNow + 28 * HOUR);
  const newDeadline = chargerView(runtime).plan.deadlineAt;
  runtime.updatePlan();
  assert.equal(chargerView(runtime).plan.deadlineAt, newDeadline, 'The consumed handback marker cannot roll the deadline twice');
});

test('a connection first seen after restart replaces the saved disconnected deadline', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ pluggedIn: false, mode: 1 });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.close();
  f.setNow(initialNow + 48 * HOUR); adapter.setObservation({ pluggedIn: true, mode: 2 });
  const restarted = f.create(); t.after(() => restarted.close());
  restarted.tick({ prices: prices.map(row => ({ ...row, start: row.start + 48 * HOUR, end: row.end + 48 * HOUR })) });
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).plan.deadlineAt, initialNow + 52 * HOUR);
  assert.equal(chargerView(restarted).control.phase, 'waiting');
});

test('a fully observed zero-power period replans remaining energy once at the gap', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ powerKw: 0, powerMeasuredAt: initialNow });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices: [1, 50, 2, 50].map((price, index) => ({ start: initialNow + index * HOUR,
    end: initialNow + (index + 1) * HOUR, price })) });
  await runtime.reconcile();
  runtime.readEnergy = () => ({ gridKwh: 0, coveredMs: f.clock() - initialNow, continuousSince: initialNow, lastMeasuredAt: f.clock() });
  const original = structuredClone(chargerView(runtime).plan);
  assert.equal(original.periods[0].endAt, initialNow + HOUR);
  for (let minute = 1; minute <= 60; minute++) {
    f.setNow(initialNow + minute * 60_000); adapter.setObservation({ powerMeasuredAt: f.clock() });
    await runtime.reconcile();
  }
  const revised = chargerView(runtime).plan;
  assert.equal(chargerView(runtime).progress.creditedGridKwh, 0);
  assert.equal(chargerView(runtime).progress.basis.continuousSince, initialNow);
  assert.notEqual(revised.id, original.id);
  assert.equal(revised.replannedGapAt, initialNow + HOUR);
  assert.equal(revised.requiredGridKwh, original.requiredGridKwh, 'The observed lack of delivery leaves the full requirement to schedule');
  await runtime.reconcile();
  assert.equal(chargerView(runtime).plan.id, revised.id, 'Repeated gap polls do not keep replacing the same plan');
});

test('the next wakeup includes an earlier proposed start while its native update is pending', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const confirmed = chargerView(runtime).control.owned.startAt;
  const proposed = initialNow + 20_000;
  runtime.chargers.charger1.plan = { ...runtime.chargers.charger1.plan,
    startAt: proposed, periods: [{ startAt: proposed, endAt: null }] };
  runtime.scheduleWakeup();
  assert.equal(runtime.boundaryAt, proposed);
  assert.ok(runtime.boundaryAt < confirmed);
});

test('archive preparation is nonblocking, permits only provisional charging and then installs the ready forecast', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  const finishes = [];
  runtime.historyService = { request: () => new Promise(resolve => { finishes.push(resolve); }), close() {} };
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'provisional');
  assert.equal(chargerView(runtime).control.released, false);
  assert.equal(chargerView(runtime).forecast.feasible, null);
  assert.equal(runtime.status().coordination.assumptions.householdReference.loading, true);
  assert.equal(runtime.status().coordination.assumptions.householdReference.noHistory, false);
  for (const finish of finishes) finish([]); await new Promise(resolve => setImmediate(resolve)); await runtime.reconcile();
  assert.equal(runtime.status().coordination.assumptions.householdReference.loading, false);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(chargerView(runtime).forecast.feasible, true);
});

test('restarting with a confirmed delayed start does not briefly release it while archive history warms', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), original = f.create(), adapter = fakeAdapter(f.clock);
  await original.setAdapter('charger1', adapter); original.tick({ prices }); await original.reconcile();
  const ownedStart = chargerView(original).control.owned.startAt;
  await original.close();
  const restarted = f.create(); t.after(() => restarted.close());
  restarted.historyService = { request: () => new Promise(() => {}), close() {} };
  restarted.tick({ prices });
  const clears = adapter.calls.filter(call => call.kind === 'clear').length;
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).control.phase, 'waiting');
  assert.equal(chargerView(restarted).control.owned.startAt, ownedStart);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, clears);
  assert.equal(chargerView(restarted).forecast.feasible, null);
});

test('BMW at home gets a bounded initial observation window without relaxing a manual schedule', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(60, initialNow, 'bmw-home', {
    atHome: true, fields: { atHome: { measuredAt: initialNow, readingId: 'home-1' } } }));
  runtime.tick({ prices }); await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'identifying');
  assert.equal(chargerView(runtime).vehicle.state, 'identifying');
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 0);
  f.setNow(initialNow + 180_000); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(chargerView(runtime).vehicle.state, 'unidentified');
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 1);

  const g = fixture({ 'charging:mqtt': { settings: preferences } }), manual = g.create(), manualAdapter = fakeAdapter(g.clock);
  t.after(() => manual.close());
  manual.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  manual.receiveSoc(manual.configuration.vehicles.bmw.mqttTopic, packet(60, initialNow, 'bmw-home', {
    atHome: true, fields: { atHome: { measuredAt: initialNow, readingId: 'home-1' } } }));
  manualAdapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '02:00', stopTime: '04:00', maximumAmps: 16 }] } });
  manual.tick({ prices }); await manual.setAdapter('charger1', manualAdapter); await manual.reconcile();
  assert.equal(chargerView(manual).control.phase, 'yielded');
  assert.equal(manualAdapter.calls.filter(row => row.kind === 'install' || row.kind === 'clear').length, 0);
});

test('temporary incomplete charger connection readings preserve the physical connection identity', async t => {
  const f = fixture(), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  const connectedAt = chargerView(runtime).control.session.connectedAt;
  f.setNow(initialNow + 60_000); adapter.setObservation({ pluggedIn: null, controlKnown: false });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.connectedAt, connectedAt);
  f.setNow(initialNow + 120_000); adapter.setObservation({ pluggedIn: true, controlKnown: true });
  await runtime.reconcile(); assert.equal(chargerView(runtime).control.session.connectedAt, connectedAt);
});
