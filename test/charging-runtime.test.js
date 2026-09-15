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
    runtime.teslaCapture = { snapshot: () => ({ pluggedIn: false }) };
    return runtime;
  };
  return { store, values, writes, create, setNow: value => { now = value; }, clock: () => now };
}
function fakeAdapter(clock) {
  let schedule = normalizeScheduleState({ enabled: 'none' });
  const observed = { mode: 2, pluggedIn: true, manualStop: false };
  const calls = [];
  const snapshot = () => ({ schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule),
    controlFingerprint: 'unchanged-control', controlKnown: true, ...observed, reason: schedule.enabled === 'none' ? 0 : 54,
    readAt: clock(), limits: { mainFuseA: 25, circuitA: [16, 16, 16], chargerA: 16, cableA: 32 } });
  return {
    calls,
    setSchedule(value) { schedule = normalizeScheduleState(value); },
    setObservation(value) { Object.assign(observed, value); },
    async read() { calls.push({ kind: 'read' }); return snapshot(); },
    async installDelayed(input) {
      assert.equal(input.canMutate(), true);
      assert.equal(input.startAt % 1000, 0);
      calls.push({ kind: 'install', startAt: input.startAt });
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
const preferences = chargingSettings({ enabled: true, capacity1Kwh: 20, readinessMarginMinutes: 0,
  installation: { mainFuseA: 25, reserveA: 0, otherLoadA: 0 } });
const prices = [20, 1, 1, 20].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
const packet = (soc, at, readingId = 'reading-1', extra = {}) => JSON.stringify({ vehicleId: 'charger1-vehicle', sourceId: 'vehicle-telemetry', soc, measuredAt: at, readingId, ...extra });

test('runtime preferences and separate automatic/manual SoC survive a new runtime', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSettings({ capacity1Kwh: 62, capacity2Kwh: 51, readyBy: '08:00', installation: { mainFuseA: 35 } });
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(30, initialNow - HOUR));
  await runtime.setSoc({ soc: 46 });
  const restarted = f.create();
  assert.equal(restarted.settings.capacity1Kwh, 62);
  assert.equal(restarted.settings.capacity2Kwh, 51);
  assert.equal(restarted.settings.installation.mainFuseA, 35);
  assert.equal(restarted.settings.manualSoc, 46);
  assert.equal(restarted.status().soc.source, 'manual');
  assert.equal(restarted.automaticSoc.soc, 30);
  assert.equal(restarted.automaticSoc.measuredAt, initialNow - HOUR);
  assert.equal(restarted.manualSoc.expiresAt, initialNow + 6 * HOUR);
  await runtime.close(); await restarted.close();
});

test('MQTT replay does not rewrite state and unknown-clock observations recover to known measurement times', async () => {
  const f = fixture(), runtime = f.create();
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(30, null));
  const before = f.writes.length;
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(30, null));
  assert.equal(f.writes.length, before);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(45, initialNow, 'reading-2'));
  assert.equal(runtime.automaticSoc.soc, 45);
  assert.equal(runtime.automaticSoc.measuredAt, initialNow);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(90, initialNow - 1, 'reading-old'));
  assert.equal(runtime.automaticSoc.soc, 45);
  await runtime.close();
  assert.equal(runtime.receiveSoc(runtime.settings.mqttTopic, packet(80, initialNow + HOUR, 'reading-after-close')), false);
});

test('manual expiration is absolute despite a ready-by edit, and newer MQTT restores at expiration', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSoc({ soc: 40 });
  const expiry = runtime.manualSoc.expiresAt;
  await runtime.setSettings({ readyBy: '08:00' });
  assert.equal(runtime.manualSoc.expiresAt, expiry);
  f.setNow(initialNow + HOUR);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(65, initialNow + HOUR));
  assert.equal(runtime.status().soc.soc, 40);
  f.setNow(expiry);
  runtime.tick();
  assert.equal(runtime.status().soc.soc, 65);
  assert.equal(runtime.status().soc.source, 'mqtt');
  assert.equal(f.values.get('charging:mqtt').manualSoc, null);
  assert.equal(runtime.settings.manualSoc, 40);
  await runtime.close();
});

test('returning to MQTT keeps the last manual number; vehicle association clears prior vehicle readings', async () => {
  const f = fixture(), runtime = f.create();
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(31, initialNow));
  await runtime.setSoc({ soc: 49 });
  await runtime.setSoc({ action: 'automatic' });
  assert.equal(runtime.settings.manualSoc, 49);
  assert.equal(runtime.status().soc.soc, 31);
  await runtime.setSoc({ soc: 52 });
  await runtime.setSettings({ vehicleId: 'replacement-vehicle' });
  assert.equal(runtime.manualSoc, null);
  assert.equal(runtime.automaticSoc, null);
  assert.equal(runtime.status().soc.assumed, true);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(95, initialNow, 'wrong-vehicle'));
  assert.equal(runtime.automaticSoc, null);
  await runtime.close();
});

test('failed persistence rolls settings/SoC back and does not lose an expired override in memory', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setSoc({ soc: 43 });
  const original = structuredClone(runtime.manualSoc);
  f.store.fail = true;
  await assert.rejects(runtime.setSoc({ soc: 60 }), /locked/);
  assert.deepEqual(runtime.manualSoc, original);
  assert.equal(runtime.settings.manualSoc, 43);
  await assert.rejects(runtime.setSettings({ capacity1Kwh: 63 }), /locked/);
  assert.equal(runtime.settings.capacity1Kwh, 74);
  f.setNow(original.expiresAt);
  runtime.tick();
  assert.deepEqual(runtime.manualSoc, original);
  assert.equal(runtime.status().soc.source, 'assumed', 'Expired record is unusable even when cleanup persistence fails');
  f.store.fail = false;
  runtime.tick();
  assert.equal(runtime.manualSoc, null);
  await runtime.close();
});

test('adapter startup reads ownership before an outlook and does not release a waiting session from an empty startup price array', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter(adapter);
  await runtime.reconcile();
  assert.equal(runtime.plan, null);
  assert.equal(runtime.status().control.released, false);
  assert.ok(adapter.calls.every(call => call.kind === 'read'));
  runtime.tick({ prices });
  await runtime.reconcile();
  assert.equal(runtime.plan.state, 'waiting');
  assert.equal(runtime.status().control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(runtime.plan.startAt, initialNow + HOUR);
});

test('OFF revokes automatic intent and relinquishes only the owned schedule even when forecast work fails', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter(adapter);
  await runtime.reconcile();
  runtime.tick({ prices });
  await runtime.reconcile();
  assert.equal(runtime.status().control.phase, 'waiting');
  runtime.updatePlan = () => { throw new Error('forecast history temporarily unavailable'); };
  await runtime.setSettings({ enabled: false });
  assert.equal(runtime.settings.enabled, false);
  assert.equal(runtime.status().control.phase, 'off');
  assert.equal(runtime.status().control.handoverConfirmed, true);
  assert.equal(runtime.status().error, 'charging-planning-unavailable');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('a released connected session retains its actual plan through new SoC, deadline edits and temporary zero power', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setAdapter(adapter);
  await runtime.reconcile();
  runtime.tick({ prices });
  await runtime.reconcile();
  const installed = structuredClone(runtime.plan);
  f.setNow(installed.startAt);
  await runtime.reconcile();
  assert.equal(runtime.status().control.released, true);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(90, installed.startAt, 'reading-now'));
  await runtime.setSettings({ readyBy: '08:00' });
  assert.deepEqual(runtime.plan, installed);
  assert.equal(runtime.status().soc.soc, 90);
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 0);
});

test('runtime uses the same controller phase contract before an adapter is attached', async () => {
  const f = fixture(), runtime = f.create();
  assert.equal(runtime.status().control.phase, 'off');
  await runtime.setSettings({ enabled: true });
  assert.equal(runtime.status().control.phase, 'unavailable');
  await runtime.close();
});

test('plan identity survives pending replans and runtime restart, and changes after an explicit new deadline', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter(adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const id = runtime.plan.id;
  assert.match(id, /^[0-9a-f-]{36}$/); assert.equal(runtime.status().control.owned.planId, id);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(20, initialNow, 'new-soc'));
  await runtime.reconcile(); assert.equal(runtime.plan.id, id);
  const restarted = f.create();
  assert.equal(restarted.plan.id, id); await restarted.close();
  await runtime.setSettings({ readyBy: '07:00' });
  assert.notEqual(runtime.plan.id, id);
});

test('manual window handback replans from newer SoC before issuing a release based on the old start', async t => {
  const settings = chargingSettings({ ...preferences, capacity1Kwh: 30 });
  const f = fixture({ 'charging:mqtt': { settings } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter(adapter); await runtime.reconcile();
  const outlook = [20, 3, 20, 1].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
  runtime.tick({ prices: outlook }); await runtime.reconcile();
  const originalStart = runtime.plan.startAt;
  assert.ok(originalStart < initialNow + 2 * HOUR);
  adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '00:15', stopTime: '02:00', maximumAmps: 16 }] } });
  f.setNow(initialNow + HOUR / 2); await runtime.reconcile();
  adapter.setObservation({ mode: 3 }); await runtime.reconcile();
  assert.equal(runtime.status().control.released, true);
  runtime.receiveSoc(runtime.settings.mqttTopic, packet(85, f.clock(), 'manual-window-result'));
  assert.equal(runtime.plan.startAt, originalStart, 'The active manual session keeps its original plan context');
  f.setNow(initialNow + 2 * HOUR); adapter.setObservation({ mode: 2 });
  runtime.tick(); await runtime.reconcile();
  assert.equal(runtime.plan.startAt, initialNow + 3 * HOUR);
  assert.equal(runtime.status().control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 0);
});

test('adapter replacement waits for an in-flight confirmed write before loading ownership', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter(adapter); await runtime.reconcile();
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const install = adapter.installDelayed;
  adapter.installDelayed = async input => {
    const result = await install(input); started();
    await new Promise(resolve => { release = resolve; });
    return result;
  };
  runtime.tick({ prices }); const writing = runtime.reconcile(); await begun;
  const old = runtime.controller;
  const replacement = runtime.setAdapter(adapter);
  await Promise.resolve(); assert.equal(runtime.controller, old);
  release(); await writing; await replacement; await runtime.reconcile();
  assert.notEqual(runtime.controller, old);
  assert.equal(runtime.status().control.phase, 'waiting');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('runtime close drains an outstanding adapter replacement without creating a new controller', async () => {
  const f = fixture(), runtime = f.create(), adapter = fakeAdapter(f.clock);
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const read = adapter.read;
  adapter.read = async () => { started(); await new Promise(resolve => { release = resolve; }); return read(); };
  await runtime.setAdapter(adapter); await begun;
  const old = runtime.controller;
  const replace = runtime.setAdapter(fakeAdapter(f.clock));
  const closing = runtime.close();
  release(); await replace; await closing;
  assert.equal(runtime.controller, old);
  const count = f.writes.length;
  await Promise.resolve(); assert.equal(f.writes.length, count);
});

test('a later replug refreshes an overdue parked preview before installing the new deadline plan', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  adapter.setObservation({ pluggedIn: false, mode: 1 });
  await runtime.setAdapter(adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const parked = structuredClone(runtime.plan);
  assert.equal(runtime.status().control.phase, 'waiting');
  f.setNow(initialNow + 48 * HOUR);
  const nextPrices = prices.map(row => ({ ...row, start: row.start + 48 * HOUR, end: row.end + 48 * HOUR }));
  runtime.tick({ prices: nextPrices });
  adapter.setObservation({ pluggedIn: true, mode: 2 });
  await runtime.reconcile();
  assert.notEqual(runtime.plan.id, parked.id);
  assert.equal(runtime.plan.deadlineAt, parked.deadlineAt + 48 * HOUR);
  assert.equal(runtime.status().control.phase, 'waiting');
  assert.equal(runtime.status().control.owned.startAt, initialNow + 49 * HOUR);
});

test('OFF with unavailable Easee and saved ownership reports unconfirmed handover', async () => {
  const f = fixture({ 'charging:mqtt:ownership': { version: 1, owned: { planId: 'prior-plan' } } }), runtime = f.create();
  await runtime.setSettings({ enabled: false });
  assert.equal(runtime.status().control.phase, 'off');
  assert.equal(runtime.status().control.handoverConfirmed, false);
  assert.match(runtime.status().control.reason, /handover is unconfirmed/);
  await runtime.close();
});

test('an MQTT subscription callback failure cannot prevent a combined OFF setting from relinquishing control', async t => {
  const f = fixture({ 'charging:mqtt': { settings: preferences } }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter(adapter); await runtime.reconcile(); runtime.tick({ prices }); await runtime.reconcile();
  runtime.onMqttTopicChange = () => { throw new Error('connection closed'); };
  await runtime.setSettings({ enabled: false, mqttTopic: 'stmq/test/replacement-topic' });
  assert.equal(runtime.status().control.phase, 'off'); assert.equal(runtime.status().control.handoverConfirmed, true);
  assert.equal(runtime.status().mqtt.reason, 'mqtt-subscription-unavailable');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});
