import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { chargingSettings } from '../src/charging/settings.js';
import { normalizeScheduleState, scheduleFingerprint, delayedScheduleFor } from '../src/charging/easee.js';

const HOUR = 3_600_000, initialNow = Date.parse('2026-01-15T00:00:00Z');
function fixture(saved = {}) {
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
  const options = { engine, store, config: { input: 'mqtt' }, clock: () => now, canControl: () => true };
  const create = () => {
    const runtime = new ChargingRuntime(options);
    runtime.teslaCapture = { snapshot: () => ({ connected: true, pluggedIn: false, assignment: 'bmw' }) };
    return runtime;
  };
  return { store, values, writes, engine, create, setNow: value => { now = value; }, clock: () => now };
}
function fakeAdapter(clock) {
  let schedule = normalizeScheduleState({ enabled: 'none' });
  const observed = { online: true, enabled: true, mode: 2, pluggedIn: true, manualStop: false, outputPhase: 30, powerKw: 0 };
  const limits = { mainFuseA: 25, circuitA: [16, 16, 16], chargerA: 16, cableA: 32,
    dynamicChargerA: 16, equalizerAvailableA: [16, 16, 16] };
  const calls = [];
  const snapshot = () => ({ schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule),
    controlFingerprint: 'unchanged-control', controlKnown: true, ...observed, reason: schedule.enabled === 'none' ? 0 : 54,
    readAt: clock(), limits: structuredClone(limits) });
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
const preferences = chargingSettings({ chargers: { charger1: { enabled: true, capacityKwh: 20 } }, readinessMarginMinutes: 0,
  installation: { mainFuseA: 25, reserveA: 0, otherLoadA: 0 } });
const prices = [20, 1, 1, 20].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
const chargerView = (runtime, id = 'charger1') => runtime.status().chargers.find(item => item.id === id);
const packet = (soc, at, readingId = 'reading-1', extra = {}) => JSON.stringify({ vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', soc, measuredAt: at, readingId, ...extra });

test('runtime preferences and separate automatic/manual SoC survive a new runtime', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSettings({ chargers: { charger1: { capacityKwh: 62, readyBy: '08:00' }, charger2: { capacityKwh: 51 } }, installation: { mainFuseA: 35 } });
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(30, initialNow - HOUR));
  await runtime.setSoc('charger1', { soc: 46 });
  const restarted = f.create();
  assert.equal(restarted.settings.chargers.charger1.capacityKwh, 62);
  assert.equal(restarted.settings.chargers.charger2.capacityKwh, 51);
  assert.equal(restarted.settings.installation.mainFuseA, 35);
  assert.equal(restarted.settings.chargers.charger1.manualSoc, 46);
  assert.equal(chargerView(restarted).values.soc.source, 'manual');
  assert.equal(restarted.chargers.charger1.automaticSoc.soc, 30);
  assert.equal(restarted.chargers.charger1.automaticSoc.measuredAt, initialNow - HOUR);
  assert.equal(restarted.chargers.charger1.manualSoc.expiresAt, initialNow + 6 * HOUR);
  await runtime.close(); await restarted.close();
});

test('MQTT replay does not rewrite state and unknown-clock observations recover to known measurement times', async () => {
  const f = fixture(), runtime = f.create();
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(30, null));
  const before = f.writes.length;
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(30, null));
  assert.equal(f.writes.length, before);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(45, initialNow, 'reading-2'));
  assert.equal(runtime.chargers.charger1.automaticSoc.soc, 45);
  assert.equal(runtime.chargers.charger1.automaticSoc.measuredAt, initialNow);
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(90, initialNow - 1, 'reading-old'));
  assert.equal(runtime.chargers.charger1.automaticSoc.soc, 45);
  await runtime.close();
  assert.equal(runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(80, initialNow + HOUR, 'reading-after-close')), false);
});

test('manual expiration is absolute despite a ready-by edit, and newer MQTT restores at expiration', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSoc('charger1', { soc: 40 });
  const expiry = runtime.chargers.charger1.manualSoc.expiresAt;
  await runtime.setChargerSettings('charger1', { readyBy: '08:00' });
  assert.equal(runtime.chargers.charger1.manualSoc.expiresAt, expiry);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(65, initialNow + HOUR));
  assert.equal(chargerView(runtime).values.soc.value, 40);
  f.setNow(expiry);
  runtime.tick();
  assert.equal(chargerView(runtime).values.soc.value, 65);
  assert.equal(chargerView(runtime).values.soc.source, 'mqtt');
  assert.equal(f.values.get('charging:mqtt').chargers.charger1.manualSoc, null);
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 40);
  await runtime.close();
});

test('returning to MQTT keeps the last manual number; vehicle association clears prior vehicle readings', async () => {
  const f = fixture(), runtime = f.create();
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(31, initialNow));
  await runtime.setSoc('charger1', { soc: 49 });
  await runtime.setSoc('charger1', { action: 'automatic' });
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 49);
  assert.equal(chargerView(runtime).values.soc.value, 31);
  await runtime.setSoc('charger1', { soc: 52 });
  await runtime.setChargerSettings('charger1', { mqtt: { vehicleId: 'replacement-vehicle' } });
  assert.equal(runtime.chargers.charger1.manualSoc, null);
  assert.equal(runtime.chargers.charger1.automaticSoc, null);
  assert.equal(chargerView(runtime).values.soc.assumed, true);
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(95, initialNow, 'wrong-vehicle'));
  assert.equal(runtime.chargers.charger1.automaticSoc, null);
  await runtime.close();
});

test('failed persistence rolls settings/SoC back and does not lose an expired override in memory', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSoc('charger1', { soc: 43 });
  const original = structuredClone(runtime.chargers.charger1.manualSoc);
  f.store.fail = true;
  await assert.rejects(runtime.setSoc('charger1', { soc: 60 }), /locked/);
  assert.deepEqual(runtime.chargers.charger1.manualSoc, original);
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 43);
  await assert.rejects(runtime.setChargerSettings('charger1', { capacityKwh: 63 }), /locked/);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 74);
  f.setNow(original.expiresAt);
  runtime.tick();
  assert.deepEqual(runtime.chargers.charger1.manualSoc, original);
  assert.equal(chargerView(runtime).values.soc.source, 'manual-fallback', 'Expired record is unusable even when cleanup persistence fails');
  f.store.fail = false;
  runtime.tick();
  assert.equal(runtime.chargers.charger1.manualSoc, null);
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
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(90, installed.startAt, 'reading-now'));
  await runtime.setChargerSettings('charger1', { readyBy: '08:00' });
  assert.deepEqual(runtime.chargers.charger1.plan, installed);
  assert.equal(chargerView(runtime).values.soc.value, 90);
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
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(20, initialNow, 'new-soc'));
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
  assert.equal(chargerView(runtime).control.released, true);
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(85, f.clock(), 'manual-window-result'));
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

test('a later replug refreshes an overdue parked preview before installing the new deadline plan', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ pluggedIn: false, mode: 1 });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const parked = structuredClone(runtime.chargers.charger1.plan);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
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

test('an MQTT subscription callback failure cannot prevent a combined OFF setting from relinquishing control', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile(); runtime.tick({ prices }); await runtime.reconcile();
  runtime.onMqttTopicChange = () => { throw new Error('connection closed'); };
  await runtime.setChargerSettings('charger1', { enabled: false, mqtt: { topic: 'stmq/test/replacement-topic' } });
  assert.equal(chargerView(runtime).control.phase, 'off'); assert.equal(chargerView(runtime).control.handoverConfirmed, true);
  assert.equal(chargerView(runtime).mqtt.reason, 'mqtt-subscription-unavailable');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('both chargers retain independent MQTT readings, manual overrides and preferences across restart', async t => {
  const f = fixture(), runtime = f.create();
  t.after(() => runtime.close());
  await runtime.setChargerSettings('charger2', { readyBy: '09:00', capacityKwh: 59, minimumSoc: 75,
    mqtt: { topic: 'stmq/garage/charger2/vehicle' } });
  runtime.receiveSoc(runtime.settings.chargers.charger1.mqtt.topic, packet(61, initialNow));
  runtime.receiveSoc(runtime.settings.chargers.charger2.mqtt.topic,
    packet(32, initialNow, 'second-reading', { vehicleId: 'charger2-vehicle' }));
  await runtime.setSoc('charger1', { soc: 46 });
  await runtime.setSoc('charger2', { soc: 54 });
  const firstExpiry = runtime.chargers.charger1.manualSoc.expiresAt;
  const secondExpiry = runtime.chargers.charger2.manualSoc.expiresAt;
  assert.ok(secondExpiry > firstExpiry);
  assert.equal(chargerView(runtime, 'charger1').values.soc.value, 46);
  assert.equal(chargerView(runtime, 'charger2').values.soc.value, 54);
  f.setNow(firstExpiry); runtime.tick();
  assert.equal(chargerView(runtime, 'charger1').values.soc.value, 61);
  assert.equal(chargerView(runtime, 'charger2').values.soc.value, 54);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.settings.chargers.charger2.capacityKwh, 59);
  assert.equal(restarted.settings.chargers.charger2.minimumSoc, 75);
  assert.equal(restarted.settings.chargers.charger2.manualSoc, 54);
  assert.equal(restarted.chargers.charger2.manualSoc.expiresAt, secondExpiry);
  f.setNow(secondExpiry); restarted.tick();
  assert.equal(chargerView(restarted, 'charger2').values.soc.value, 32);
  assert.equal(restarted.settings.chargers.charger1.manualSoc, 46);
  assert.equal(f.values.get('charging:mqtt').version, 2);
});

test('unsupported scheduling and invalid charger identifiers reject without affecting another charger', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await assert.rejects(runtime.setChargerSettings('charger2', { enabled: true }), /does not support/);
  await assert.rejects(runtime.resume('charger2', {}), /does not support/);
  await assert.rejects(runtime.setSoc('missing', { soc: 80 }), /Unknown charger/);
  assert.equal(runtime.settings.chargers.charger1.enabled, false);
  assert.equal(runtime.settings.chargers.charger2.enabled, false);
  await assert.rejects(runtime.setChargerSettings('charger2', {
    mqtt: { topic: runtime.settings.chargers.charger1.mqtt.topic },
  }), /separate vehicle MQTT topic/);
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
  vehicle.assignment = 'auto'; runtime.tick();
  assert.equal(chargerView(runtime).automatic.soc.available, false);
  assert.equal(chargerView(runtime, 'charger2').automatic.soc.available, false,
    'Uncertain attribution cannot attach the Tesla battery to an unidentified charger');
  assert.equal(chargerView(runtime, 'charger2').values.connected.available, false);
  assert.notEqual(chargerView(runtime, 'charger2').forecast.state, 'none', 'Possible external load stays reserved');
});

test('first adapter attachment uses freshly read fixed limits when prices are already available', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setLimits({ chargerA: 14, cableA: 20, equalizerAvailableA: [6, 8, 7] });
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
  await runtime.setSettings({ readinessMarginMinutes: 0, installation: { mainFuseA: 25, reserveA: 0, otherLoadA: 0 },
    chargers: { charger1: { enabled: true, capacityKwh: 20, readyBy: '06:00' },
      charger2: { enabled: true, capacityKwh: 10, readyBy: '05:00' } } });
  runtime.tick({ prices }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(first.plan.state, 'waiting');
  assert.equal(second.plan.state, 'waiting');
  assert.notEqual(first.plan.id, second.plan.id);
  assert.ok(second.plan.deadlineAt < first.plan.deadlineAt);
  assert.equal(second.values.currentA.value, 14, 'Tesla requested current cannot replace a real charger adapter allowance');
  assert.deepEqual(second.values.phases.value, [1, 1, 1]);
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
