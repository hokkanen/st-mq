import { withReportDatabase } from './helpers/report-database.js';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { normalizeScheduleState, scheduleFingerprint, delayedScheduleFor, easeeChargerTelemetry } from '../src/charging/easee.js';
import { Store } from '../src/storage/store.js';
import { Recorder } from '../src/storage/recorder.js';
import { VoltageEstimator } from '../src/storage/voltage.js';
import { createShellyController } from '../src/charging/shelly-evse.js';
import { shellyProfile } from '../src/charging/shelly-profile.js';

const HOUR = 3_600_000, initialNow = Date.parse('2026-01-15T00:00:00Z');
function fixture(charging = {}, saved = {}, automatic = {}) {
  let now = initialNow;
  const association = createHash('sha256').update(JSON.stringify(['easee', undefined, undefined])).digest('hex');
  for (const [key, value] of Object.entries(saved)) if (key === 'charging:mqtt') { value.version = 6; for (const record of Object.values(value.chargers ?? {})) record.association = association; }
  const values = new Map(Object.entries(saved)), writes = [];
  const store = {
    getState: key => structuredClone(values.get(key)),
    setState(key, value) {
      if (store.fail) throw new Error('database temporarily locked');
      writes.push(key); values.set(key, structuredClone(value));
    },
  };
  withReportDatabase(store);
  const engine = {};
  const options = { engine, store, config: { input: 'mqtt', charging }, clock: () => now, canControl: () => true };
  const create = () => {
    const runtime = new ChargingRuntime(options);
    if (!values.has('charging:mqtt')) {
      for (const [id, enabled] of Object.entries(automatic)) runtime.chargers[id].controls.enabled = enabled;
      runtime.refreshSettings();
    }
    runtime.setMqttStatus({connected:true,subscribed:true},'bmw');
    runtime.teslaCapture = { snapshot: () => ({ connected: true, pluggedIn: false, assignment: 'bmw' }) };
    return runtime;
  };
  return { store, values, writes, engine, config: options.config, create, setNow: value => { now = value; }, clock: () => now };
}
function fakeAdapter(clock) {
  let schedule = normalizeScheduleState({ enabled: 'none' });
  let voltageV = [230, 230, 230];
  const observed = { online: true, enabled: true, mode: 2, pluggedIn: true, manualStop: false, outputPhase: 30, powerKw: 0 };
  const limits = { circuitA: [16, 16, 16], chargerA: 16, cableA: 32,
    dynamicChargerA: 16, equalizerAvailableA: [16, 16, 16] };
  const calls = [];
  const snapshot = () => ({ schedule: structuredClone(schedule), fingerprint: scheduleFingerprint(schedule),
    controlFingerprint: 'unchanged-control', controlKnown: true, ...observed, reason: schedule.enabled === 'none' ? 0 : 54,
    readAt: clock(), modeAt: observed.modeAt ?? clock(), reasonAt: clock(), limits: structuredClone(limits),
    observations: { ...(observed.powerMeasuredAt === undefined ? {} : { 120: { at: observed.powerMeasuredAt } }),
      ...(observed.modeAt === undefined ? {} : { 109: { at: observed.modeAt } }) },
    supply: { availableCurrentA: [...limits.equalizerAvailableA], propertyCurrentA: [0, 0, 0],
      chargerCurrentA: [0, 0, 0], voltageV, observedAt: clock(), observationTimes: { voltage: [clock(), clock(), clock()] } } });
  return {
    calls,
    setSchedule(value) { schedule = normalizeScheduleState(value); },
    setObservation(value) { Object.assign(observed, value); },
    setLimits(value) { Object.assign(limits, value); },
    setVoltage(value) { voltageV = value; },
    async read() { calls.push({ kind: 'read' }); return snapshot(); },
    async installDelayed(input) {
      await input.beforeWrite?.(snapshot());
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
const preferences = { defaults: { capacityKwh: 20 } };
const prices = [20, 1, 1, 20].map((price, index) => ({ start: initialNow + index * HOUR, end: initialNow + (index + 1) * HOUR, price }));
const chargerView = (runtime, id = 'charger1') => runtime.status().chargers.find(item => item.id === id);
const editSession = (runtime, id, changes) => {
  const view = chargerView(runtime, id);
  return runtime.setChargerSettings(id, { scope: 'session', association: view.association,
    sessionId: view.request?.sessionId, revision: view.request?.revision, changes });
};
const packet = (soc, at, readingId = 'reading-1', extra = {}) => JSON.stringify({ provider: 'bmw-cardata', soc, measuredAt: at, readingId, ...extra });

test('Charger 2 voltage cannot fill the shared startup estimate or Charger 1 readings', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const voltage = value => ({value,available:true,measuredAt:f.clock(),source:'shelly-evse'});
  runtime.chargers.charger2.adapter = { normalize: () => ({providerConnected:true,
    voltageV:voltage(241),phaseVoltageV:voltage([241,237,229])}) };
  await runtime.tick({prices});
  assert.deepEqual(runtime.coordination.assumptions.voltage.voltageV,[null,null,null]);
  assert.equal(chargerView(runtime).values.voltageV.available,false);
  assert.equal(chargerView(runtime,'charger2').values.voltageV.value,241,'own live reading remains local');
});

test('published voltage survives restart and live voltage changes do not rewrite the waiting plan or session log', async t => {
  const f = fixture(preferences, {}, { charger1: true });
  const database = new Store(':memory:');
  let at = initialNow - HOUR;
  const recorder = new Recorder(database, { clock: () => at });
  const estimator = new VoltageEstimator(database, { recorder, input: 'mqtt', clock: () => at });
  for (; at <= initialNow; at += 60_000) [228, 230, 232].forEach((value, phase) => estimator.ingest({
    source: 'easee', device: 'synthetic-meter', signal: `property_voltage_l${phase + 1}`, value, unit: 'V',
    sourceTime: at, receivedAt: at, quality: [], raw: { voltageMapping: 'phase-neutral' },
  }));
  f.values.set('voltage:estimate:mqtt', database.getState('voltage:estimate:mqtt'));
  database.close();
  let runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const original = structuredClone(chargerView(runtime).plan.periods);
  const planCount = () => runtime.sessionDiagnostics.status().chargers.find(row => row.id === 'charger1').current.counts.plans;
  const plansBefore = planCount();
  assert.ok(plansBefore > 0);
  for (const voltage of [225, 234, 228, 239]) {
    adapter.setVoltage([voltage, voltage + 1, voltage + 2]);
    await runtime.reconcile(); runtime.tick({ prices });
    assert.deepEqual(chargerView(runtime).plan.periods, original);
    assert.equal(chargerView(runtime).values.voltageV.value, voltage + 1, 'Live status remains an actual reading');
    assert.deepEqual(runtime.coordination.assumptions.voltage.voltageV, [228, 230, 232]);
  }
  assert.equal(planCount(), plansBefore);
  runtime.close(); runtime = f.create(); adapter = fakeAdapter(f.clock); adapter.setVoltage([240, 240, 240]);
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  assert.deepEqual(chargerView(runtime).plan.periods, original);
  assert.deepEqual(runtime.coordination.assumptions.voltage.voltageV, [228, 230, 232]);
});

const priceOutlook = values => values.map((price, index) => ({ start: initialNow + index * HOUR,
  end: initialNow + (index + 1) * HOUR, price }));
async function activePriceFixture(t, values = [5, 50, 10, 50], elapsedMinutes = 30) {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices: priceOutlook(values) }); await runtime.reconcile();
  const original = structuredClone(chargerView(runtime).control.execution);
  f.setNow(initialNow + elapsedMinutes * 60_000);
  adapter.setObservation({ mode: 3 });
  runtime.readEnergy = () => ({ gridKwh: 5, coveredMs: f.clock() - initialNow,
    continuousSince: initialNow, lastMeasuredAt: f.clock() });
  await runtime.reconcile();
  return { ...f, runtime, adapter, original };
}

test('new overnight prices pause an active period and replan only the remaining recorded energy', async t => {
  const { runtime, adapter, original, clock } = await activePriceFixture(t, [5, 50, 10]);
  assert.equal(original.periods.length, 2);
  const before = chargerView(runtime);
  runtime.tick({ prices: priceOutlook([5, 50, 10, 1]) }); await runtime.reconcile();
  const after = chargerView(runtime);
  assert.equal(after.control.phase, 'pause-unconfirmed');
  assert.equal(after.control.owned.startAt, initialNow + 3 * HOUR);
  assert.equal(after.plan.deadlineAt, original.deadlineAt);
  assert.equal(after.plan.requiredGridKwh, before.requiredGridKwh);
  assert.equal(after.plan.creditedGridKwh, 5);
  assert.deepEqual(after.control.execution.periods[0], { startAt: initialNow, endAt: clock() });
  assert.notEqual(after.control.execution.planId, original.planId);
  adapter.setObservation({ mode: 2 }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'paused');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('new cheaper prices can pause the final automatic period before its target and deadline', async t => {
  const { runtime, adapter, original } = await activePriceFixture(t, [5, 5, 50, 50]);
  assert.equal(original.periods.length, 1);
  assert.equal(chargerView(runtime).control.released, true);
  runtime.tick({ prices: priceOutlook([5, 5, 50, 1]) }); await runtime.reconcile();
  const after = chargerView(runtime);
  assert.equal(after.control.released, false);
  assert.equal(after.control.phase, 'pause-unconfirmed');
  assert.equal(after.control.owned.startAt, initialNow + 3 * HOUR);
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('unchanged economics, dearer slots and missing coverage do not interrupt active charging', async t => {
  for (const change of ['metadata', 'elapsed', 'dearer', 'missing', 'infeasible']) await t.test(change, async t => {
    const { runtime, adapter, original } = await activePriceFixture(t, [5, 5, 50, 50]);
    let next = priceOutlook([5, 5, 50, 50]);
    if (change === 'metadata') next = next.flatMap(row => [
      { ...row, end: row.start + HOUR / 2, fetchedAt: 123 },
      { ...row, start: row.start + HOUR / 2, fetchedAt: 456 }]).reverse();
    if (change === 'elapsed') next[0] = { ...next[0], start: initialNow + HOUR / 2 };
    if (change === 'dearer') next[3].price = 100;
    if (change === 'tiny-saving') next[3].price = 4.9999;
    if (change === 'missing') next = [];
    if (change === 'infeasible') next = [{ start: initialNow + 3 * HOUR, end: initialNow + 3 * HOUR + 60_000, price: 1 }];
    runtime.tick({ prices: next }); await runtime.reconcile();
    assert.equal(chargerView(runtime).control.execution.planId, original.planId);
    assert.equal(chargerView(runtime).control.released, true);
    assert.equal(adapter.calls.filter(call => call.kind !== 'read').length, 0);
  });
});

test('price-driven pauses wait for a minimum running period without losing the new outlook', async t => {
  const { runtime, adapter, setNow } = await activePriceFixture(t, [5, 5, 50, 50], 5);
  runtime.tick({ prices: priceOutlook([5, 5, 50, 1]) }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.released, true);
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 0);
  assert.equal(runtime.boundaryAt, initialNow + 15 * 60_000);
  setNow(initialNow + 15 * 60_000); runtime.tick(); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'pause-unconfirmed');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
});

test('failed price pauses are discarded when prices, completion or retry time invalidate them', async t => {
  for (const reason of ['prices', 'target', 'short-gap', 'deadline']) await t.test(reason, async t => {
    const { runtime, adapter, original, setNow } = await activePriceFixture(t, [5, 5, 50, 50]);
    const install = adapter.installDelayed;
    adapter.installDelayed = async () => { throw new Error('offline'); };
    runtime.tick({ prices: priceOutlook([5, 5, 50, 1]) }); await runtime.reconcile();
    assert.equal(chargerView(runtime).control.phase, 'unconfirmed');
    assert.equal(chargerView(runtime).control.execution.planId, original.planId);
    adapter.installDelayed = install;
    if (reason === 'prices') runtime.tick({ prices: priceOutlook([5, 5, 50, 100]) });
    if (reason === 'target') runtime.readEnergy = () => ({ gridKwh: 20 });
    if (reason === 'short-gap') setNow(initialNow + 3 * HOUR - 5 * 60_000);
    if (reason === 'deadline') setNow(initialNow + 4 * HOUR);
    await runtime.reconcile();
    assert.equal(chargerView(runtime).control.released, true);
    assert.equal(chargerView(runtime).control.execution.planId, original.planId);
    assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 0);
  });
});

test('ready-by editing preserves one explicit connection deadline through price changes', async t => {
  const { runtime } = await activePriceFixture(t);
  await editSession(runtime, 'charger1', {readyBy:'07:00'});
  const request=structuredClone(chargerView(runtime).request);
  assert.equal(request.deadlineAt,initialNow+5*HOUR);
  runtime.tick({prices:priceOutlook([5,50,10,1])});await runtime.reconcile();
  assert.equal(chargerView(runtime).request.deadlineAt,request.deadlineAt);
});

test('target completion, original deadline and manual priority prevent price-driven pauses', async t => {
  for (const reason of ['target', 'deadline', 'manual']) await t.test(reason, async t => {
    const { runtime, adapter, setNow } = await activePriceFixture(t, [5, 5, 50, 50]);
    if (reason === 'target') runtime.readEnergy = () => ({ gridKwh: 20 });
    if (reason === 'deadline') setNow(initialNow + 4 * HOUR);
    if (reason === 'manual') {
      adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC', periods: [{ startTime: '00:00', stopTime: '03:00', maximumAmps: 16 }] } });
      await runtime.reconcile();
    }
    runtime.tick({ prices: priceOutlook([5, 5, 50, 1, 1, 1]) }); await runtime.reconcile();
    assert.equal(adapter.calls.filter(call => call.kind !== 'read').length, 0);
    if (reason === 'manual') assert.equal(chargerView(runtime).control.phase, 'yielded');
    else assert.equal(chargerView(runtime).control.released, true);
  });
});

test('a changed outlook after restart can revise saved active execution and unchanged prices do not rewrite it', async t => {
  const { runtime, adapter, create, original } = await activePriceFixture(t, [5, 5, 50, 50]);
  await runtime.close();
  const restarted = create(); t.after(() => restarted.close());
  restarted.readEnergy = () => ({ gridKwh: 5 });
  await restarted.setAdapter('charger1', adapter);
  restarted.tick({ prices: priceOutlook([5, 5, 50, 1]) }); await restarted.reconcile();
  const revised = chargerView(restarted);
  assert.notEqual(revised.control.execution.planId, original.planId);
  adapter.setObservation({ mode: 2 });
  restarted.tick({ prices: priceOutlook([5, 5, 50, 1]).reverse() }); await restarted.reconcile();
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(chargerView(restarted).control.owned.startAt, initialNow + 3 * HOUR);
});

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
  assert.equal(chargerView(runtime).vehicle.state, 'identifying', 'A start remains pending until stop confirmation');
  assert.equal(chargerView(runtime).vehicle.id, null);
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

test('cached disconnected polls arriving after BMW plugs in preserve its source-time connection evidence across restart', async t => {
  const f = fixture(), original = f.create(); t.after(() => original.close());
  const adapter = fakeAdapter(f.clock), topic = original.configuration.vehicles.bmw.mqttTopic;
  const disconnectedAt = initialNow - 60_000;
  adapter.setObservation({ pluggedIn: false, mode: 1, modeAt: disconnectedAt, disconnectedAt });
  f.setNow(initialNow - 5_000);
  await original.setAdapter('charger1', adapter); await original.reconcile();
  f.setNow(initialNow + 1_000);
  original.receiveSoc(topic, packet(60, initialNow, 'bmw-before-cloud', {
    atHome: true, pluggedIn: true, charging: true,
    fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt: initialNow, readingId: `${key}-before-cloud` }])),
  }));
  f.setNow(initialNow + 4_000); await original.reconcile();
  assert.equal(chargerView(original).control.session.lastDisconnectedAt, disconnectedAt);
  await original.close();
  f.setNow(initialNow + 30_000);
  const runtime = f.create(); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, disconnectedAt);
  f.setNow(initialNow + 64_000);
  adapter.setObservation({ pluggedIn: true, mode: 3, modeAt: initialNow + 3_000, disconnectedAt: null });
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.connectedAt, f.clock());
  assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [initialNow + 3_000]);
  f.setNow(initialNow + 120_000);
  const stoppedAt = initialNow + 115_000;
  adapter.setObservation({ mode: 2, modeAt: stoppedAt }); await runtime.reconcile();
  runtime.receiveSoc(topic, JSON.stringify({ provider: 'bmw-cardata', charging: false,
    fields: { charging: { measuredAt: stoppedAt, readingId: 'bmw-after-cloud-stop' } } }));
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, disconnectedAt);
  assert.equal(adapter.calls.some(call => call.kind !== 'read'), false);
});

test('disconnect boundaries fall back conservatively for unknown or future clocks and never rewind', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const adapter = fakeAdapter(f.clock);
  adapter.setObservation({ pluggedIn: false, mode: 1, disconnectedAt: initialNow + 60_000 });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, initialNow, 'A future source clock falls back to receipt');
  f.setNow(initialNow + 10_000);
  adapter.setObservation({ disconnectedAt: initialNow - 60_000 }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, initialNow, 'An older cached event cannot undo the fallback');
  f.setNow(initialNow + 20_000);
  adapter.setObservation({ disconnectedAt: null }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, f.clock(), 'A missing source clock also falls back to receipt');
});

test('BMW polling tolerance cannot borrow an earlier connection across disconnect, unknown telemetry and restart', async t => {
  for (const timestamped of [false, true]) await t.test(timestamped ? 'source clock' : 'receipt fallback', async t => {
    const f = fixture(), original = f.create(); t.after(() => original.close());
    const adapter = fakeAdapter(f.clock), topic = original.configuration.vehicles.bmw.mqttTopic;
    const disconnectedAt = initialNow + (timestamped ? 20_000 : 30_000);
    adapter.setObservation({ mode: 3, modeAt: initialNow });
    await original.setAdapter('charger1', adapter); await original.reconcile();
    original.receiveSoc(topic, packet(60, initialNow, 'previous-connection', {
      atHome: true, pluggedIn: true, charging: true,
      fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
        [key, { measuredAt: initialNow, readingId: `${key}-previous` }])),
    }));
    f.setNow(initialNow + 30_000);
    adapter.setObservation({ pluggedIn: false, mode: 1, modeAt: disconnectedAt, disconnectedAt: timestamped ? disconnectedAt : null }); await original.reconcile();
    assert.equal(chargerView(original).control.session.lastDisconnectedAt, disconnectedAt);
    await original.close();
    f.setNow(initialNow + 40_000);
    adapter.setObservation({ pluggedIn: null, mode: null, controlKnown: false });
    const runtime = f.create(); t.after(() => runtime.close());
    await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
    assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, disconnectedAt);
    f.setNow(initialNow + 60_000);
    adapter.setObservation({ pluggedIn: true, mode: 3, modeAt: initialNow, controlKnown: true }); await runtime.reconcile();
    assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [], 'Cached mode from the previous connection is excluded');
    adapter.setObservation({ modeAt: initialNow + 55_000 }); await runtime.reconcile();
    assert.deepEqual(runtime.chargers.charger1.vehicleEvidence.chargingTimes, [initialNow + 55_000]);
    f.setNow(initialNow + 90_000);
    adapter.setObservation({ mode: 2, modeAt: initialNow + 85_000 }); await runtime.reconcile();
    runtime.receiveSoc(topic, JSON.stringify({ provider: 'bmw-cardata', charging: false,
      fields: { charging: { measuredAt: initialNow + 85_000, readingId: 'later-stop' } } }));
    const current = chargerView(runtime);
    assert.equal(current.vehicle.state, 'identifying');
    assert.equal(current.vehicle.id, null, 'Unconsumed BMW events before the disconnect cannot match the new car');
    assert.equal(current.identification.connectedAt, current.control.session.connectedAt);
    assert.equal(current.identification.candidate, null, 'The previous connection supplies no active-test candidate');
    assert.equal(runtime.vehicleFeeds.bmw.consumedPlugId, null);
    assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, disconnectedAt);
  });
});

test('configuration defaults and automatic readings survive restart without a saved settings source', async t => {
  const f = fixture({ defaults: { capacityKwh: 62, readyBy: '08:00', manualSoc: 46 } }), runtime = f.create();
  t.after(() => runtime.close());
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(30, initialNow - HOUR));
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.settings.chargers.charger1.capacityKwh, 62);
  assert.equal(restarted.settings.chargers.charger2.capacityKwh, 62);
  assert.equal(chargerView(restarted).values.soc.value, 46);
  assert.equal(restarted.vehicleFeeds.bmw.reading.measuredAt, initialNow - HOUR);
  assert.equal(f.values.get('charging:mqtt').settings, undefined);
  f.config.charging.defaults.manualSoc = 51;
  const reconfigured = f.create(); t.after(() => reconfigured.close());
  assert.equal(chargerView(reconfigured).values.soc.value, 51);
  assert.equal(reconfigured.status().timezone, 'Europe/Helsinki');
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
  runtime.setMqttStatus({ connected: true, subscribed: false, reason: 'awaiting-subscription' }, 'bmw');
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.brokerConnected, true);
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.subscriptionStatus, 'pending');
  runtime.setMqttStatus({ connected: true, subscribed: true, reason: null }, 'bmw');
  const reading = packet(51, initialNow - HOUR, 'bmw-reading', { provider: 'bmw-cardata', chargeLimitSoc: 80 });
  runtime.receiveSoc(topic, reading, { retain: true });
  let mqtt = runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception;
  assert.equal(mqtt.provider, 'bmw-cardata'); assert.equal(mqtt.subscriptionStatus, 'subscribed');
  assert.equal(mqtt.lastRetainedAt, initialNow); assert.equal(mqtt.lastLiveAt, null);
  const automatic = structuredClone(runtime.vehicleFeeds.bmw.reading), writes = f.writes.length;
  f.setNow(initialNow + 60_000);
  runtime.receiveSoc(topic, reading, { dup: true });
  mqtt = runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception;
  assert.equal(mqtt.lastMessageAt, f.clock()); assert.equal(mqtt.lastLiveAt, f.clock()); assert.equal(mqtt.lastValidAt, f.clock());
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, automatic);
  assert.equal(f.writes.length, writes, 'A repeated report confirms reception without rewriting the measurement');
  f.setNow(initialNow + 120_000);
  runtime.receiveSoc(topic, '{malformed');
  mqtt = runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception;
  assert.equal(mqtt.subscribed, true); assert.equal(mqtt.reason, 'awaiting-report'); assert.equal(mqtt.invalidReason, 'malformed-json');
  assert.equal(mqtt.available, false, 'Retained and DUP packets do not establish a live bridge heartbeat');
  assert.equal(mqtt.lastLiveAt, f.clock()); assert.equal(mqtt.lastValidAt, initialNow + 60_000);
  runtime.receiveSoc(topic, reading);
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.invalidReason, null, 'A valid duplicate recovers payload health');
  runtime.setMqttStatus({ connected: false, subscribed: false, reason: 'mqtt-disconnected' });
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.subscriptionStatus, 'disconnected');
  const restarted = f.create(); t.after(() => restarted.close());
  mqtt = restarted.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception;
  assert.equal(mqtt.provider, 'bmw-cardata', 'Provider identity survives restart with its saved reading');
  assert.equal(mqtt.brokerConnected, true, 'Fixture explicitly reconnects the new runtime'); assert.equal(mqtt.lastLiveAt, null); assert.equal(mqtt.lastRetainedAt, null);
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
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.provider, 'bmw-cardata');
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.provider, 'bmw-cardata');
  runtime.receiveSoc(topic, packet(55, f.clock(), 'next-reading', { provider: 'invented-provider' }));
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.invalidReason, 'invalid-provider');
  assert.equal(runtime.status().vehicleFeeds.find(feed => feed.id === 'bmw').reception.provider, 'bmw-cardata');
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, { ...original, provider: 'bmw-cardata' });
});

test('unassigned automatic SoC never overrides configured generic defaults', async t => {
  const f = fixture({ defaults: { manualSoc: 47 } }), runtime = f.create(); t.after(() => runtime.close());
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(65, initialNow));
  assert.equal(chargerView(runtime).values.soc.value, 47);
  assert.equal(chargerView(runtime).values.soc.source, 'manual-fallback');
  await assert.rejects(editSession(runtime, 'charger1', { manualSoc: 55 }), /connection changed/);
  await assert.rejects(runtime.setChargerSettings('charger1', { manualSoc: 55 }), /configuration/);
  f.setNow(initialNow + 24 * HOUR); runtime.tick();
  assert.equal(chargerView(runtime).values.soc.value, 47);
});

test('configuration topic changes invalidate persisted vehicle readings without assigning them to a charger', async () => {
  const f = fixture({ defaults: { manualSoc: 49 } }), runtime = f.create();
  const oldTopic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(oldTopic, packet(31, initialNow));
  await runtime.close();
  f.config.charging = { ...f.config.charging, vehicles: { bmw: { mqttTopic: 'stmq/test/replacement-vehicle' } } };
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

test('failed persistence rolls session overrides and automatic readings back', async () => {
  const f = fixture(), runtime = f.create();
  await runtime.setAdapter('charger1', fakeAdapter(f.clock)); await runtime.reconcile();
  await editSession(runtime, 'charger1', { manualSoc: 43 });
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(topic, packet(31, initialNow));
  const original = structuredClone(runtime.vehicleFeeds.bmw.reading);
  f.store.fail = true;
  await assert.rejects(editSession(runtime, 'charger1', { manualSoc: 60 }), /locked/);
  assert.equal(chargerView(runtime).settings.manualSoc, 43);
  assert.equal(runtime.settings.chargers.charger1.manualSoc, 20);
  await assert.rejects(editSession(runtime, 'charger1', { capacityKwh: 63 }), /locked/);
  assert.equal(runtime.settings.chargers.charger1.capacityKwh, 74);
  assert.throws(() => runtime.receiveSoc(topic, packet(45, initialNow + 1, 'reading-new')), /locked/);
  assert.deepEqual(runtime.vehicleFeeds.bmw.reading, original);
  assert.equal(chargerView(runtime).values.soc.value, 43);
  f.store.fail = false;
  await runtime.close();
});

test('adapter startup reads ownership before an outlook and does not release a waiting session from an empty startup price array', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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

test('dashboard OFF relinquishes the owned schedule even when forecast work fails and persists after reload', async t => {
  const f = fixture(structuredClone(preferences), {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  runtime.updatePlan = () => { throw new Error('forecast history temporarily unavailable'); };
  const displayed = chargerView(runtime);
  await runtime.setControl('charger1', { association: displayed.association, revision: displayed.controls.revision, enabled: false });
  await runtime.close();
  const restarted = f.create(); t.after(() => restarted.close());
  restarted.updatePlan = () => { throw new Error('forecast history temporarily unavailable'); };
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).control.phase, 'off');
  assert.equal(chargerView(restarted).control.handoverConfirmed, true);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('forecast failure cannot block confirmed release times or independent charger readback', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const confirmed = chargerView(runtime).control.owned;
  assert.ok(confirmed?.startAt > initialNow);
  const beforeReads = adapter.calls.filter(call => call.kind === 'read').length;
  runtime.updatePlan = async () => { throw new Error('forecast unavailable'); };
  runtime.allocationContext = () => { throw new Error('second-charger forecast unavailable'); };
  f.setNow(confirmed.startAt);
  runtime.tick({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(adapter.calls.filter(call => call.kind === 'read').length > beforeReads, 'Periodic reconciliation continues after a planning failure');
  assert.equal(chargerView(runtime).control.phase, 'released');
  assert.equal(chargerView(runtime).control.errorCode, null, 'A forecast error is not an EVSE read failure');
  assert.equal(runtime.status().error, 'charging-planning-unavailable');
  adapter.setObservation({ pluggedIn: false, mode: 1 });
  runtime.tick({ force: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(chargerView(runtime).control.phase, 'disconnected');
  assert.equal(chargerView(runtime).control.owned, null);
});

test('a released connected session retains its actual plan through new SoC, deadline edits and temporary zero power', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  await editSession(runtime, 'charger1', { readyBy: '08:00' });
  const { allocations: oldAllocation, intervals: oldResources, ...installedInstruction } = installed;
  const { allocations: liveAllocation, intervals: liveResources, ...currentInstruction } = runtime.chargers.charger1.plan;
  assert.deepEqual(currentInstruction, installedInstruction, 'The released instruction is unchanged while remaining resource forecasts can refresh');
  assert.equal(chargerView(runtime).values.soc.value, 20, 'An unidentified feed cannot change this session');
  assert.equal(adapter.calls.filter(call => call.kind === 'install').length, 1);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 0);
});

test('configured control reports off or unavailable before an adapter is attached', async t => {
  const off = fixture().create(), enabled = fixture(preferences, {}, { charger1: true }).create();
  t.after(async () => { await off.close(); await enabled.close(); });
  assert.equal(chargerView(off).control.phase, 'off');
  assert.equal(chargerView(enabled).control.phase, 'unavailable');
});

test('plan identity survives pending replans and runtime restart, and changes after an explicit new deadline', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile();
  const id = runtime.chargers.charger1.plan.id;
  assert.match(id, /^[0-9a-f-]{36}$/); assert.equal(chargerView(runtime).control.owned.planId, id);
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(20, initialNow, 'new-soc'));
  await runtime.reconcile(); assert.equal(runtime.chargers.charger1.plan.id, id);
  const restarted = f.create();
  assert.equal(restarted.chargers.charger1.plan.id, id); await restarted.close();
  await editSession(runtime, 'charger1', { readyBy: '07:00' });
  assert.notEqual(runtime.chargers.charger1.plan.id, id);
});

test('manual window handback replans from newer SoC before issuing a release based on the old start', async t => {
  const settings = { ...preferences, defaults: { capacityKwh: 30, manualSoc: 0 } };
  const f = fixture(settings, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  runtime.chargers.charger1.vehicleMatch = { id: 'bmw', vehicleAssociation: runtime.vehicleFeeds.bmw.association, scope: runtime.chargers.charger1.request.scope, association: runtime.chargers.charger1.association, connectedAt: chargerView(runtime).control.session.connectedAt, matchedAt: f.clock() };
  runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, packet(85, f.clock(), 'manual-window-result'));
  assert.equal(runtime.chargers.charger1.plan.startAt, originalStart, 'The active manual session keeps its original plan context');
  f.setNow(initialNow + 2 * HOUR); adapter.setObservation({ mode: 2 });
  runtime.tick(); await runtime.reconcile();
  assert.equal(runtime.chargers.charger1.plan.startAt, initialNow + 2 * HOUR, 'Achieved target has no further price delay');
  assert.equal(chargerView(runtime).control.phase, 'released');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, 1);
});

test('adapter replacement waits for an in-flight confirmed write before loading ownership', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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

test('OFF with current association ownership reports unconfirmed handover', async () => {
  const f = fixture(), runtime = f.create();
  runtime.chargers.charger1.ownershipAdmitted=true;
  f.values.set(runtime.ownershipKey('charger1'), { version: 5, owned: { planId: 'prior-plan' } });
  assert.equal(chargerView(runtime).control.handoverConfirmed, false);
  await runtime.close();
});

test('session API rejects permanent settings, connections and efficiency', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  for (const patch of [{ enabled: false }, { mqtt: { topic: 'stmq/test/new' } }, { efficiency: .8 }, { priority: 'charger2' }]) {
    await assert.rejects(editSession(runtime, 'charger1', patch), /Invalid session field/);
    await assert.rejects(runtime.setChargerSettings('charger1', patch), /configuration/);
  }
  assert.equal(typeof runtime.setSettings, 'function');
  assert.equal(runtime.settings.chargers.charger1.enabled, true);
});

test('unconfigured connections and invalid charger identifiers cannot accept session edits', async t => {
  const f = fixture({}, {}, { charger2: true }), runtime = f.create(); t.after(() => runtime.close());
  assert.equal(chargerView(runtime,'charger2').control.phase,'unavailable');
  await assert.rejects(editSession(runtime, 'charger2', { manualSoc: 56 }), /connection changed/);
  await assert.rejects(runtime.setChargerSettings('missing', { scope: 'session', changes: {} }), /Unknown charger/);
  assert.equal(runtime.settings.chargers.charger1.enabled, false);
  assert.equal(runtime.settings.chargers.charger2.enabled, true);
  assert.throws(() => fixture({ chargers: { charger2: { mqttTopic: 'invalid/topic' } } }).create(), /Invalid Shelly EVSE configuration/);
});

test('first adapter attachment uses freshly read fixed limits when prices are already available', async t => {
  const f = fixture({ ...preferences, defaults: { capacityKwh: 20, manualSoc: 40 } }, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  const f = fixture({ defaults: { capacityKwh: 20 } }, {}, { charger1: true, charger2: true }), runtime = f.create(), firstAdapter = fakeAdapter(f.clock), secondAdapter = fakeAdapter(f.clock);
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
        state.session = { connected: true, connectedAt: initialNow };
        const plan = await getPlan();
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
  await editSession(runtime, 'charger2', { capacityKwh: 10, readyBy: '05:00' });
  f.setNow(initialNow + 3 * 60_000);
  runtime.tick({ prices }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(first.plan.state, 'waiting');
  assert.equal(second.plan.state, 'waiting');
  assert.notEqual(first.plan.id, second.plan.id);
  assert.ok(second.plan.deadlineAt < first.plan.deadlineAt);
  assert.equal(second.values.currentA.value, 14, 'Tesla requested current cannot replace a real charger adapter allowance');
  assert.equal(second.values.phases.value, 3);
  assert.equal(f.values.get(runtime.ownershipKey('charger1')).owned.planId, first.plan.id);
  assert.equal(f.values.get(runtime.ownershipKey('charger2')).owned.planId, second.plan.id);
  assert(secondDecisions.some(decision => decision.enabled && decision.planId === second.plan.id));
  assert.equal(runtime.status().coordination.currentLimitsAreProposals, true);
  assert.ok(runtime.status().coordination.currentLimits.length > 0);
  assert.ok(runtime.status().coordination.currentLimits.every(limit => limit.chargerId === 'charger2'));
  assert.deepEqual(currentCommands, [], 'Coordination proposals never become Equalizer or unsupported dynamic-current writes');
  vehicle.assignment = 'auto'; runtime.tick();
  assert.equal(chargerView(runtime, 'charger2').values.connected.value, true,
    'Uncertain vehicle attribution cannot discard a confirmed second charger connection');
  await assert.rejects(editSession(runtime, 'charger2', { enabled: false }), /Invalid session field/);
  assert.equal(runtime.settings.chargers.charger1.enabled, true);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
});

test('a second plug with unavailable current preserves BMW price scheduling and uses an unapplied maximum-current plan', async t => {
  const f = fixture({ defaults: { capacityKwh: 10, manualSoc: 20, minimumSoc: 80, readyBy: '06:00' },
    vehicles: { bmw: { defaults: { capacityKwh: 10 } } },
    chargers: { charger2: { enabled: true, deviceId: 'synthetic-unknown-current', topicPrefix: 'test/unknown-current',
      maximumCurrentA: 16, limiterEnabled: false } } }, {}, { charger1: true, charger2: true });
  const runtime = f.create(), firstAdapter = fakeAdapter(f.clock), commands = [];
  t.after(() => runtime.close());
  let connectedAt = null, currentA = null;
  const field = value => ({ value, available: value !== null, source: 'shelly-evse', measuredAt: f.clock(), receivedAt: f.clock() });
  const secondAdapter = {
    association: runtime.chargers.charger2.association,
    config: shellyProfile(runtime.configuration.chargers.charger2),
    capabilities: { scheduling: true, currentControl: false, externalLoadBalancing: false },
    snapshot: () => ({ association: secondAdapter.association, generation: 1, transport: 'shelly-evse',
      online: true, readAt: f.clock(), pluggedIn: connectedAt !== null, controlReady: false, identificationReady: false,
      error: 'evse-control-unavailable', nativeScheduleActive: false,
      session: { connected: connectedAt !== null, connectedAt, sessionId: connectedAt === null ? null : 'synthetic-second-session' },
      fields: { start_charging: field(true), work_state: field(connectedAt === null ? 'charger_free' : 'charger_wait'),
        ...(currentA === null ? {} : { current_limit: field(currentA) }) } }),
    normalize: () => ({ providerConnected: true, source: 'shelly-evse', connected: field(connectedAt !== null),
      currentA: field(currentA), maximumCurrentA: field(null), charging: field(false), powerKw: field(0),
      voltageV: field(230), capabilities: secondAdapter.capabilities }),
    refresh: async () => {},
    rpc: async (...args) => { commands.push(args); throw new Error('An unavailable charger must not receive commands'); },
    createController: options => createShellyController({ ...options, adapter: secondAdapter }),
  };
  await runtime.setAdapter('charger1', firstAdapter);
  await runtime.setAdapter('charger2', secondAdapter);
  await runtime.reconcile();
  // This regression starts after identification; its independent matcher is
  // covered elsewhere. Preserve the real connection and vehicle-feed scope.
  const firstItem = runtime.chargers.charger1;
  firstItem.vehicleMatch = { id: 'bmw', vehicleAssociation: runtime.vehicleFeeds.bmw.association,
    scope: firstItem.request.scope, association: firstItem.association,
    connectedAt: chargerView(runtime).control.session.connectedAt, matchedAt: f.clock() };
  runtime.tick({ prices }); await runtime.reconcile();
  const before = chargerView(runtime);
  assert.equal(before.vehicle.id, 'bmw');
  assert.equal(before.plan.feasible, true);
  assert.equal(before.control.phase, 'waiting');
  assert(before.plan.startAt >= initialNow + HOUR);
  const initialReleases = firstAdapter.calls.filter(call => call.kind === 'clear').length;

  f.setNow(initialNow + 60_000); connectedAt = f.clock();
  runtime.tick({ prices, force: true }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(first.vehicle.id, 'bmw');
  assert.equal(first.plan.feasible, true); assert.equal(first.plan.provisional, false);
  assert.equal(first.plan.state, 'waiting'); assert.equal(first.control.phase, 'waiting');
  assert(first.plan.startAt >= initialNow + HOUR);
  assert.equal(firstAdapter.calls.filter(call => call.kind === 'clear').length, initialReleases);
  assert.equal(second.values.currentA.available, false);
  assert.equal(second.values.maximumCurrentA.available, false, 'The configured maximum is not a reported measurement');
  assert.equal(second.plan.feasible, true); assert.equal(second.plan.provisional, false);
  assert.equal(second.plan.state, 'waiting');
  assert.deepEqual(second.plan.assumptions, [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum' }]);
  assert.equal(second.control.phase, 'unavailable'); assert.equal(second.control.execution, null);
  assert.deepEqual(commands, [], 'The production controller does not apply a forecast without readiness');

  f.setNow(initialNow + 2 * 60_000); currentA = 6;
  runtime.tick({ prices, force: true }); await runtime.reconcile();
  const observed = chargerView(runtime, 'charger2');
  assert.equal(observed.values.currentA.value, 6);
  assert.deepEqual(observed.plan.assumptions, []);
  assert(observed.plan.allocations.some(row => row.currentA === 6));
  assert(observed.plan.allocations.every(row => row.currentA <= 6));
  assert.equal(chargerView(runtime).plan.feasible, true);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.deepEqual(commands, []);
});

test('retained active Charger 2 periods refresh assumptions when current becomes known and unavailable again', async t => {
  const f = fixture({ defaults: { capacityKwh: 10, manualSoc: 20, minimumSoc: 80, readyBy: '06:00' },
    chargers: { charger2: { enabled: true, deviceId: 'synthetic-retained-current', topicPrefix: 'test/retained-current',
      maximumCurrentA: 16, limiterEnabled: false } } }, {}, { charger2: true });
  const runtime = f.create(), firstAdapter = fakeAdapter(f.clock), secondAdapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  let currentA = null;
  firstAdapter.setObservation({ pluggedIn: false, mode: 1 });
  secondAdapter.capabilities = { scheduling: true, currentControl: false, externalLoadBalancing: false };
  secondAdapter.normalize = snapshot => ({ connected: snapshot.pluggedIn, currentA, maximumCurrentA: null,
    voltageV: 230, charging: false, powerKw: 0, providerConnected: true, capabilities: secondAdapter.capabilities });
  secondAdapter.createController = ({ adapter, getPlan }) => {
    const state = { phase: 'off', released: false, execution: null, snapshot: null, session: { connected: true, connectedAt: initialNow } };
    return { status: () => structuredClone(state), close: async () => {}, async update({ enabled }) {
      state.snapshot = await adapter.read();
      const plan = await getPlan();
      if (!enabled || !plan?.periods?.length) return;
      state.execution = { planId: plan.id, periods: structuredClone(plan.periods), finalStartAt: plan.finalStartAt, deadlineAt: plan.deadlineAt };
      state.released = plan.periods.some(row => row.startAt <= f.clock() && (row.endAt === null || row.endAt > f.clock()));
      state.phase = state.released ? 'released' : 'waiting';
    } };
  };
  await runtime.setAdapter('charger1', firstAdapter);
  await runtime.setAdapter('charger2', secondAdapter);
  await runtime.reconcile(); runtime.tick({ prices }); await runtime.reconcile();
  const initial = chargerView(runtime, 'charger2');
  assert.equal(initial.plan.state, 'waiting');
  assert.equal(initial.plan.assumptions[0].maximumCurrentA, 16);
  f.setNow(initial.plan.startAt + 60_000);
  runtime.tick({ prices }); await runtime.reconcile();
  const active = chargerView(runtime, 'charger2');
  assert.equal(active.control.phase, 'released');
  const periods = structuredClone(active.plan.periods), planId = active.plan.id;
  for (const [reading, expectedAssumptions] of [[6, []], [null, [{ code: 'maximum-available-current', maximumCurrentA: 16, source: 'configured-maximum' }]]]) {
    currentA = reading; f.setNow(f.clock() + 60_000);
    runtime.tick({ prices, force: true }); await runtime.reconcile();
    const view = chargerView(runtime, 'charger2');
    assert.equal(view.control.phase, 'released');
    assert.equal(view.plan.id, planId, 'A current observation does not replace retained charging permission');
    assert.deepEqual(view.plan.periods, periods);
    assert.deepEqual(view.plan.assumptions, expectedAssumptions);
    assert.deepEqual(view.forecast.assumptions, expectedAssumptions);
  }
});

test('an uncertain second connection with no reported schedule creates no competing reservation', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.teslaCapture = { snapshot: () => ({ connected: true, assignment: 'auto', pluggedIn: null, atHome: true }) };
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  f.setNow(initialNow + 3 * 60_000);
  runtime.tick({ prices }); await runtime.reconcile();
  const first = chargerView(runtime), second = chargerView(runtime, 'charger2');
  assert.equal(second.values.connected.available, false);
  assert.equal(second.values.currentA.available, false);
  assert.equal(second.forecast.state, 'none');
  assert.equal(first.plan.state, 'waiting'); assert.equal(first.control.phase, 'waiting');
  assert.equal(first.plan.startAt, initialNow + HOUR);
});

test('disabling a configured MQTT source retains configured defaults without old vehicle data', async t => {
  const f = fixture({ defaults: { manualSoc: 53 } }), runtime = f.create(); t.after(() => runtime.close());
  const oldTopic = runtime.configuration.vehicles.bmw.mqttTopic;
  runtime.receiveSoc(oldTopic, packet(76, initialNow, 'automatic-value', { usableCapacityKwh: 66, chargeLimitSoc: 90 }));
  assert.equal(chargerView(runtime).values.soc.value, 53);
  f.config.charging = { ...f.config.charging, vehicles: { bmw: { mqttTopic: null } } };
  const restarted = f.create(); t.after(() => restarted.close());
  const view = chargerView(restarted);
  assert.equal(view.values.soc.value, 53); assert.equal(view.values.soc.source, 'manual-fallback');
  assert.equal(view.values.capacityKwh.value, 74); assert.equal(view.values.minimumSoc.value, 80);
  assert.equal(restarted.vehicleFeeds.bmw.reading, null);
  assert.deepEqual(restarted.mqttRoutes(), []); assert.equal(restarted.receiveSoc(oldTopic, packet(91, initialNow)), false);
});

test('inactive Easee schedule caches cannot move the owned delayed occurrence to tomorrow', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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

test('new installations use common 20% defaults and reject retired saved preferences', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  assert.deepEqual(runtime.status().chargers.map(charger => charger.values.soc.value), [20, 20]);
  f.values.set('charging:mqtt', { version: 5, settings: {} });
  assert.throws(() => f.create(), /Unsupported charging state/);
});

test('measured energy lowers the remaining requirement once and survives restart without crediting the outage', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  await runtime.updatePlan(); await runtime.updatePlan();
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
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  await editSession(runtime, 'charger1', { readyBy: '07:00' });
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

test('manual handback crossing ready-by preserves the original overdue connection deadline', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  assert.equal(chargerView(runtime).plan.deadlineAt, initialNow + 4 * HOUR);
  const newDeadline = chargerView(runtime).plan.deadlineAt;
  await runtime.updatePlan();
  assert.equal(chargerView(runtime).plan.deadlineAt, newDeadline, 'The consumed handback marker cannot roll the deadline twice');
});

test('a connection first seen after restart replaces the saved disconnected deadline', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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

test('vehicle timer changes during a pause revise the remaining confirmed periods without waiting for new prices or energy', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  const timer = { value: null, available: false };
  adapter.normalize = snapshot => ({ ...easeeChargerTelemetry(snapshot, { now: f.clock() }), vehicleNotBefore: { ...timer } });
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices: priceOutlook([1, 50, 2, 50]) }); await runtime.reconcile();
  const original = structuredClone(chargerView(runtime).control.execution);
  assert.equal(original.periods.length, 2);
  const runningPlan = structuredClone(chargerView(runtime).plan);
  Object.assign(timer, { value: initialNow + 2.5 * HOUR, available: true });
  await runtime.updatePlan();
  const { allocations: oldAllocation, intervals: oldResources, ...runningInstruction } = runningPlan;
  const { allocations: liveAllocation, intervals: liveResources, ...currentInstruction } = chargerView(runtime).plan;
  assert.deepEqual(currentInstruction, runningInstruction, 'A changed vehicle timer does not rewrite an already active instruction');
  assert(liveAllocation.every(row => row.start >= timer.value || row.powerKw === 0), 'The resource forecast respects the newly observed vehicle timer');
  Object.assign(timer, { value: null, available: false });
  f.setNow(initialNow + HOUR); adapter.setObservation({ mode: 2 });
  runtime.readEnergy = () => ({ gridKwh: 11.04, coveredMs: HOUR,
    continuousSince: initialNow, lastMeasuredAt: initialNow + HOUR });
  await runtime.reconcile(); await runtime.reconcile();
  const paused = structuredClone(chargerView(runtime).plan);
  assert.equal(paused.startAt, initialNow + 2 * HOUR);
  assert.equal(chargerView(runtime).control.phase, 'paused');
  Object.assign(timer, { value: initialNow + 2.5 * HOUR, available: true });
  await runtime.updatePlan();
  const revised = chargerView(runtime).plan;
  assert.notEqual(revised.id, paused.id);
  assert.ok(revised.startAt >= timer.value, 'The new car timer must constrain the remaining start even though price and energy inputs did not change');
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.owned.startAt, revised.startAt);
  const confirmed = chargerView(runtime).control.execution;
  assert.deepEqual(confirmed.periods[0], original.periods[0], 'The completed period remains in execution history');
  Object.assign(timer, { available: false });
  await runtime.updatePlan();
  assert.equal(chargerView(runtime).plan.startAt, initialNow + 2 * HOUR, 'Removing the timer allows the cheaper earlier remaining start again');
});

test('the next wakeup includes an earlier proposed start while its native update is pending', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
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

test('recovery selection invalidates ready household forecasts and fences an older in-flight result', async t => {
  const f = fixture(), runtime = f.create(), finishes = [];
  runtime.historyService = { request: () => new Promise(resolve => { finishes.push(resolve); }), close() {} };
  t.after(() => runtime.close());
  await runtime.updatePlan();
  assert.equal(finishes.length, 1);
  const oldRows = [];
  f.store.db.prepare('UPDATE history_selection SET generation=? WHERE id=1').run('synthetic-reverted');
  finishes[0](oldRows);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.planningFlight;
  assert.notEqual(runtime.household, oldRows, 'a result from before publication never becomes the current forecast');
  assert.equal(runtime.historyReady, false);
  assert.equal(finishes.length, 2, 'the completed stale request immediately schedules the selected history');
  const currentRows = [];
  finishes[1](currentRows);
  await new Promise(resolve => setImmediate(resolve));
  await runtime.planningFlight;
  assert.equal(runtime.household, currentRows);
  assert.equal(runtime.historyReady, true);
  f.store.db.prepare('UPDATE history_selection SET generation=? WHERE id=1').run('synthetic-restored');
  await runtime.updatePlan();
  assert.equal(finishes.length, 3, 'restoring refreshes history without waiting five minutes or changing the deadline');
  assert.equal(runtime.historyReady, false, 'planning waits for a reference built from the new selection');
  assert.notEqual(runtime.household, currentRows);
  finishes[2]([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.historyReady, true);
});

test('household forecast callbacks settle safely after the database closes before the runtime', async t => {
  for (const outcome of ['completed', 'failed']) await t.test(outcome, async t => {
    const store = new Store(':memory:');
    const runtime = new ChargingRuntime({ store, engine: {}, config: { input: 'mqtt', charging: {} }, clock: () => initialNow });
    let finish, fail, ticks = 0;
    runtime.historyService = { request: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }), close() {} };
    t.after(async () => { await runtime.close(); if (store.db.isOpen) store.close(); });
    await runtime.updatePlan();
    runtime.tick = () => { ticks++; };
    store.close();
    assert.equal(runtime.closed, false, 'database closure can precede runtime disposal');
    if (outcome === 'completed') finish([]);
    else fail(new Error('Synthetic forecast failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.historyReady, false, 'a closed source never publishes a forecast');
    assert.equal(runtime.historyError, null, 'a late result cannot access finalized source statements');
    assert.equal(runtime.historyFlights.size, 0);
    assert.equal(ticks, 0, 'cleanup cannot request another control tick against the closed database');
  });
});

test('restarting with a confirmed delayed start does not briefly release it while archive history warms', async t => {
  const f = fixture(preferences, {}, { charger1: true }), original = f.create(), adapter = fakeAdapter(f.clock);
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

test('a matched BMW quick unplug ends the old schedule even when every Easee poll remains connected', async t => {
  const f = fixture({ defaults: { capacityKwh: 20, manualSoc: 60, minimumSoc: 85 } }, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  const topic = runtime.configuration.vehicles.bmw.mqttTopic;
  const fact = (key, value, at) => runtime.receiveSoc(topic, JSON.stringify({ provider: 'bmw-cardata', [key]: value,
    fields: { [key]: { measuredAt: at, readingId: `${key}-${at}` } } }));
  adapter.setObservation({ mode: 3, modeAt: initialNow });
  await runtime.setAdapter('charger1', adapter);
  runtime.receiveSoc(topic, packet(60, initialNow, 'initial-bmw', { chargeLimitSoc: 85,
    atHome: true, pluggedIn: true, charging: true, fields: Object.fromEntries(['atHome', 'pluggedIn', 'charging'].map(key =>
      [key, { measuredAt: initialNow, readingId: `${key}-initial` }])) }));
  await runtime.reconcile();
  f.setNow(initialNow + 60_000); adapter.setObservation({ mode: 2, modeAt: f.clock() });
  fact('charging', false, f.clock()); await runtime.reconcile();
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  runtime.tick({ prices }); await editSession(runtime, 'charger1', { capacityKwh: 20, manualSoc: 60, minimumSoc: 85 });
  await editSession(runtime, 'charger1', { minimumSoc: 100 });
  const old = chargerView(runtime);
  assert.equal(old.control.phase, 'waiting'); assert(old.control.owned);
  const clearCount = adapter.calls.filter(call => call.kind === 'clear').length;

  const unplugAt = initialNow + 5 * 60_000;
  f.setNow(unplugAt); fact('pluggedIn', false, unplugAt);
  await runtime.reconcile();
  assert.equal(chargerView(runtime).control.snapshot.pluggedIn, true, 'Raw Easee never reports the short unplug');
  assert.equal(chargerView(runtime).control.session.connected, false, 'The known BMW unplug supplies the missing boundary');
  assert.equal(chargerView(runtime).control.session.lastDisconnectedAt, unplugAt);
  assert.equal(runtime.chargers.charger1.vehicleDisconnect.measuredAt, unplugAt);
  assert.equal(chargerView(runtime).targetSelection, null);
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, clearCount + 1);

  const replugAt = unplugAt + 16_000;
  f.setNow(replugAt); adapter.setObservation({ mode: 2, modeAt: replugAt - 7000 });
  fact('pluggedIn', true, replugAt); await runtime.reconcile();
  const replugged = chargerView(runtime);
  assert.equal(replugged.control.session.connectedAt, replugAt);
  assert.equal(replugged.control.phase, 'waiting');
  assert.equal(replugged.identification.reason, 'waiting-for-charging');
  assert.ok(replugged.control.owned, 'The probe waits for fresh physical power telemetry before releasing the economic delay');
  assert.equal(replugged.vehicle.id, null, 'A new connection must still identify its vehicle');
  assert.equal(runtime.chargers.charger1.targetState, null);

  const startAt = replugAt + 2000;
  f.setNow(startAt); adapter.setObservation({ mode: 3, modeAt: startAt, powerKw: 7, powerMeasuredAt: startAt });
  fact('charging', true, startAt); await runtime.reconcile();
  assert.equal(chargerView(runtime).vehicle.state, 'identifying');
  f.setNow(startAt + 1000); await runtime.reconcile();
  const identification = chargerView(runtime);
  assert.equal(identification.control.phase, 'identifying');
  assert.equal(identification.control.owned.purpose, 'identification');
  assert.equal(identification.control.owned.identificationConnectedAt, replugAt);
  assert(identification.control.owned.startAt <= f.clock() + 150_000, 'Identification uses a short expiring pause immediately');
  const stopAt = f.clock() + 20_000;
  f.setNow(stopAt); adapter.setObservation({ mode: 2, modeAt: stopAt, powerKw: 0, powerMeasuredAt: stopAt });
  fact('charging', false, stopAt); await runtime.reconcile();
  assert.equal(chargerView(runtime).vehicle.id, 'bmw');
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(chargerView(runtime).values.minimumSoc.value, 85);
  assert.equal(chargerView(runtime).values.minimumSoc.source, 'bmw-cardata');
  assert.equal(adapter.calls.filter(call => call.kind === 'clear').length, clearCount + 2,
    'The old session is cleared once, then the new economic delay is released for its bounded probe');
});

const requestScope = view => ({ association: view.association, sessionId: view.request.sessionId, revision: view.request.revision });
const takeoverScope = view => ({ ...requestScope(view), controlRevision: view.controls.revision,
  takeoverToken: view.control.takeover.token });

async function takeoverFixture(t) {
  const f = fixture(preferences), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  runtime.tick({ prices }); await runtime.reconcile(); runtime.tick = () => {};
  const controller = runtime.chargers.charger1.controller, status = controller.status.bind(controller), update = controller.update.bind(controller);
  const calls = [], takeover = { available: true, token: 'synthetic-native-instruction', reason: null };
  let during = async () => {}, confirmation = 'confirmed', confirmedToken = null, planningRevision = null;
  controller.status = () => ({ ...status(), takeover: structuredClone(takeover), planningRevision });
  controller.update = async input => {
    if (!input.takeover) return update(input);
    calls.push(structuredClone(input));
    await during(input);
    planningRevision = input.controlsRevision;
    Object.assign(takeover, { state: confirmation, attemptToken: confirmedToken ?? input.takeover });
    return controller.status();
  };
  return { ...f, runtime, adapter, controller, calls, takeover,
    setDuring: value => { during = value; }, setResult: (state, token = null) => { confirmation = state; confirmedToken = token; } };
}

test('Use automatic rejects stale displayed scope or native instruction before persistence and dispatch', async t => {
  const f = await takeoverFixture(t), scope = takeoverScope(chargerView(f.runtime));
  const before = structuredClone(f.values.get('charging:mqtt')), writes = f.writes.length;
  for (const changes of [{ association: 'another-charger' }, { sessionId: 'another-connection' },
    { revision: scope.revision + 1 }, { controlRevision: scope.controlRevision + 1 },
    { takeoverToken: 'fixture-newer-instruction' }, { takeoverToken: '' }, { unexpected: true }]) {
    await assert.rejects(f.runtime.useAutomatic('charger1', { ...scope, ...changes }), /changed|displayed/);
    assert.deepEqual(f.values.get('charging:mqtt'), before);
    assert.equal(f.writes.length, writes); assert.equal(f.calls.length, 0);
  }
});

test('Use automatic durably enables Automatic and clears Charge now with one scoped confirmed takeover', async t => {
  const f = await takeoverFixture(t);
  await f.runtime.chargeNow('charger1', requestScope(chargerView(f.runtime)));
  const before = chargerView(f.runtime), scope = takeoverScope(before);
  assert.equal(before.controls.enabled, false); assert.equal(before.request.chargeNow, true);
  let persisted;
  f.setDuring(() => { persisted = structuredClone(f.values.get('charging:mqtt').chargers.charger1); });
  await f.runtime.useAutomatic('charger1', scope);
  assert.equal(persisted.controls.enabled, true); assert.equal(persisted.request.chargeNow, undefined);
  assert.equal(persisted.controls.revision, scope.controlRevision + 1);
  assert.equal(persisted.request.revision, scope.revision + 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].takeover, scope.takeoverToken);
  assert.equal(f.calls[0].enabled, true); assert.equal(f.calls[0].chargeNow, null);
  assert.equal(Object.hasOwn(f.calls[0], 'resume'), false, 'explicit native takeover has its own controller path');
  assert.equal(f.runtime.chargers.charger1.takeoverAttempt, undefined);
  const saved = JSON.stringify(f.values.get('charging:mqtt').chargers);
  assert.equal(saved.includes(scope.takeoverToken), false, 'native takeover permission is never replayed from runtime state');
});

test('Use automatic persistence failure rolls back automatic permission and Charge now without dispatch', async t => {
  const f = await takeoverFixture(t);
  await f.runtime.chargeNow('charger1', requestScope(chargerView(f.runtime)));
  const before = structuredClone(chargerView(f.runtime)), scope = takeoverScope(before);
  f.store.fail = true;
  await assert.rejects(f.runtime.useAutomatic('charger1', scope), /locked/);
  f.store.fail = false;
  const after = chargerView(f.runtime);
  assert.deepEqual(after.controls, before.controls); assert.deepEqual(after.request, before.request);
  assert.equal(f.calls.length, 0); assert.equal(f.runtime.chargers.charger1.takeoverAttempt, undefined);
});

test('Use automatic plans beyond the superseded native timer without changing published native evidence', async t => {
  const f = await takeoverFixture(t);
  f.adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC',
    periods: [{ startTime: '03:00', stopTime: '04:00', maximumAmps: 16 }] } });
  f.adapter.setObservation({ manualStop: true, stopped: true });
  await f.runtime.reconcile('charger1');
  const before = chargerView(f.runtime);
  assert.equal(before.telemetry.manualStop, true);
  const published = { manual: before.control.manual, schedule: before.control.snapshot.schedule,
    start: before.values.scheduledStartAt, end: before.values.scheduledEndAt };
  let planned;
  f.setDuring(input => {
    planned = structuredClone(input.plan);
    const during = chargerView(f.runtime);
    assert.deepEqual({ manual: during.control.manual, schedule: during.control.snapshot.schedule,
      start: during.values.scheduledStartAt, end: during.values.scheduledEndAt }, published);
    assert.equal(during.telemetry.manualStop, true, 'a candidate cannot manufacture native handover evidence');
  });
  await f.runtime.useAutomatic('charger1', takeoverScope(before));
  assert.equal(planned.feasible, true);
  assert.equal(planned.startAt, initialNow + HOUR, 'candidate follows cheaper periods instead of the old 03:00 timer');
  assert.notEqual(planned.state, 'manual-stop');
});

test('Use automatic requires a fresh confirmed result for the exact displayed instruction', async t => {
  for (const [state, token] of [['pending', null], ['blocked', null], ['confirmed', 'earlier-attempt']]) {
    const f = await takeoverFixture(t); f.setResult(state, token);
    await assert.rejects(f.runtime.useAutomatic('charger1', takeoverScope(chargerView(f.runtime))), /not been confirmed/);
    assert.equal(f.runtime.chargers.charger1.takeoverAttempt, undefined);
    assert.equal(f.calls.length, 1);
  }
});

test('a newer session or automatic edit revokes an awaited Use automatic result', async t => {
  for (const change of ['request', 'automatic', 'connection']) {
    const f = await takeoverFixture(t), item = f.runtime.chargers.charger1;
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.setDuring(async () => { entered(); await gate; });
    const pending = f.runtime.useAutomatic('charger1', takeoverScope(chargerView(f.runtime)));
    const rejected = assert.rejects(pending, /changed during takeover/);
    await waiting;
    // Model the accepted newer edit at the persistence boundary while the
    // controller command is awaited; its own reconcile waits on this flight.
    if (change === 'request') item.request.revision++;
    if (change === 'automatic') { item.controls.enabled = false; item.controls.revision++; f.runtime.refreshSettings(); }
    if (change === 'connection') item.request.sessionId = 'newer-physical-connection';
    f.runtime.persist(); f.runtime.invalidateCommands(); release(); await rejected;
    assert.equal(item.takeoverAttempt, undefined);
    if (change === 'automatic') assert.equal(item.controls.enabled, false);
  }
});

test('Charge now OFF never acknowledges native manual priority or sends explicit takeover', async t => {
  for (const mode of ['stop', 'schedule']) {
    const f = await takeoverFixture(t);
    await f.runtime.setControl('charger1', automaticScope(f.runtime));
    await f.runtime.chargeNow('charger1', requestScope(chargerView(f.runtime)));
    f.setNow(initialNow + 1000);
    if (mode === 'stop') f.adapter.setObservation({ enabled: false, stopped: true, manualStop: true });
    else f.adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC',
      periods: [{ startTime: '03:00', stopTime: '04:00', maximumAmps: 16 }] } });
    await f.runtime.reconcile('charger1');
    const mutations = f.adapter.calls.filter(row => row.kind !== 'read').length;
    await f.runtime.resume('charger1', {});
    const view = chargerView(f.runtime);
    assert.equal(view.request.chargeNow, undefined);
    if (mode === 'stop') assert.equal(view.control.snapshot.stopped, true);
    else { assert.equal(view.control.snapshot.schedule.enabled, 'daily'); assert.ok(view.control.manual); }
    assert.equal(f.calls.length, 0, 'ordinary Charge now OFF has no native takeover token');
    assert.equal(f.adapter.calls.filter(row => row.kind !== 'read').length, mutations);
    assert.notEqual(view.control.phase, 'released');
  }
});

test('Charge Now removes the automatic delay immediately and automatic handover restores scheduling', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  const defaults = structuredClone(runtime.settings);
  await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
  assert.equal(chargerView(runtime).request.chargeNow, true);
  assert.equal(chargerView(runtime).control.phase, 'released');
  assert.equal(chargerView(runtime).control.snapshot.schedule.enabled, 'none');
  assert.equal(adapter.calls.filter(row => row.kind === 'clear').length, 1);
  runtime.tick({ prices: priceOutlook([100, 1, 1, 1]) }); await runtime.reconcile();
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 1, 'Cheaper prices cannot reclaim the session');
  await runtime.resume('charger1', {});
  assert.equal(chargerView(runtime).request.chargeNow, undefined);
  assert.equal(chargerView(runtime).control.phase, 'waiting');
  assert.equal(adapter.calls.filter(row => row.kind === 'install').length, 2);
  assert.deepEqual(runtime.settings, defaults);
  assert.equal(f.values.get('charging:mqtt').settings, undefined);
});

test('Charge Now and value overrides survive only the same physical connection across restart', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  await editSession(runtime, 'charger1', { capacityKwh: 31, manualSoc: 37, minimumSoc: 90, readyBy: '07:00' });
  await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
  const previous = chargerView(runtime); await runtime.close();
  const restarted = f.create(); t.after(() => restarted.close());
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).request.chargeNow, true);
  assert.equal(chargerView(restarted).settings.capacityKwh, 31);
  assert.equal(chargerView(restarted).request.sessionId, previous.request.sessionId);
  f.setNow(initialNow + 60_000); adapter.setObservation({ pluggedIn: false, mode: 1 }); await restarted.reconcile();
  assert.equal(chargerView(restarted).request, null);
  f.setNow(initialNow + 120_000); adapter.setObservation({ pluggedIn: true, mode: 2 }); await restarted.reconcile();
  assert.equal(chargerView(restarted).request.chargeNow, undefined);
  assert.deepEqual(chargerView(restarted).request.overrides, {});
  assert.equal(chargerView(restarted).settings.capacityKwh, 20);
  await assert.rejects(restarted.chargeNow('charger1', requestScope(previous)), /connection changed/);
});

test('Charge Now rejects stale edits and failed persistence before issuing a command', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  const old = requestScope(chargerView(runtime));
  await editSession(runtime, 'charger1', { minimumSoc: 81 });
  await assert.rejects(runtime.chargeNow('charger1', old), /connection changed/);
  const request = requestScope(chargerView(runtime));
  const count = adapter.calls.filter(row => row.kind !== 'read').length;
  f.store.fail = true;
  await assert.rejects(runtime.chargeNow('charger1', request), /locked/);
  f.store.fail = false;
  assert.equal(chargerView(runtime).request.chargeNow, undefined);
  assert.equal(chargerView(runtime).request.revision, request.revision);
  assert.equal(adapter.calls.filter(row => row.kind !== 'read').length, count);
});

test('Charge Now works without forecasts while preserving native stops and faults', async t => {
  for (const blocked of [null, 'stop', 'fault']) await t.test(blocked ?? 'forecast unavailable', async t => {
    const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
    t.after(() => runtime.close());
    await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
    runtime.updatePlan = () => { throw new Error('history unavailable'); };
    if (blocked === 'stop') adapter.setObservation({ enabled: false, stopped: true });
    if (blocked === 'fault') adapter.setObservation({ faulted: true, mode: 5 });
    await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
    assert.equal(adapter.calls.filter(row => row.kind === 'clear').length, blocked ? 0 : 1);
    if (blocked) assert.notEqual(chargerView(runtime).control.phase, 'released');
    else assert.equal(chargerView(runtime).control.phase, 'released');
  });
});

test('saved sessions cannot smuggle permanent settings over configuration on restart', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', fakeAdapter(f.clock)); await runtime.reconcile();
  const saved = structuredClone(f.values.get('charging:mqtt'));
  for (const overrides of [{ enabled: false }, { priority: 'charger2' }, { capacityProfile: 'tesla' }]) {
    const invalid = structuredClone(saved); invalid.chargers.charger1.request.overrides = overrides;
    f.values.set('charging:mqtt', invalid);
    assert.throws(() => f.create(), /Unsupported saved charging session/);
    assert.deepEqual(f.values.get('charging:mqtt'), invalid, 'Malformed state is rejected without rewriting it');
  }
});

test('new native manual windows use the effective session ready-by without rewriting defaults', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock);
  t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  await editSession(runtime, 'charger1', { readyBy: '08:00' });
  adapter.setObservation({ enabled: false, stopped: true }); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.manual.cycleEndsAt, initialNow + 6 * HOUR);
  assert.equal(runtime.settings.chargers.charger1.readyBy, '06:00');
});


const automaticScope = (runtime, id = 'charger1', enabled = true) => {
  const view = chargerView(runtime, id);
  return { association: view.association, revision: view.controls.revision, enabled };
};
const priorityScope = (runtime, priority = 'charger2') => ({ priority, revision: runtime.status().controls.revision,
  associations: Object.fromEntries(runtime.status().chargers.map(view => [view.id, view.association])) });

test('automatic charging and shared priority persist independently of configured four-value defaults', async t => {
  const f = fixture({ defaults: { manualSoc: 30, minimumSoc: 75, capacityKwh: 55, readyBy: '07:00' } });
  const runtime = f.create(); t.after(() => runtime.close());
  const configured = structuredClone(f.config.charging);
  await runtime.setControl('charger1', automaticScope(runtime));
  const priorities = [], observe = runtime.sessionDiagnostics.observe.bind(runtime.sessionDiagnostics);
  runtime.sessionDiagnostics.observe = (chargers, now, coordination) => {
    priorities.push([coordination?.priority, coordination?.proposed?.priority, coordination?.adopted?.priority]);
    return observe(chargers, now, coordination);
  };
  await runtime.setSettings(priorityScope(runtime));
  assert.deepEqual(priorities[0], ['charger2', 'balanced', 'balanced'], 'Observers see the new selection before its models catch up');
  assert.deepEqual(priorities.at(-1), ['charger2', 'charger2', 'charger2']);
  assert.equal(runtime.settings.chargers.charger1.enabled, true);
  assert.equal(runtime.settings.priority, 'charger2');
  assert.deepEqual(f.config.charging, configured);
  await runtime.close();
  f.config.charging.defaults.manualSoc = 45;
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.settings.chargers.charger1.enabled, true);
  assert.equal(restarted.settings.chargers.charger2.enabled, false);
  assert.equal(restarted.settings.priority, 'charger2');
  assert.equal(restarted.settings.chargers.charger1.manualSoc, 45);
  assert.deepEqual(Object.keys(f.values.get('charging:mqtt').chargers.charger1.controls).sort(), ['enabled', 'revision']);
});

test('a replacement charger inherits neither automatic enablement nor shared priority authority', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setControl('charger1', automaticScope(runtime));
  await runtime.setSettings(priorityScope(runtime));
  const oldAutomatic = automaticScope(runtime), oldPriority = priorityScope(runtime);
  await runtime.close();
  f.config.connections = { easee: { charger_id: 'different-synthetic-charger' } };
  const replaced = f.create(); t.after(() => replaced.close());
  assert.equal(replaced.settings.chargers.charger1.enabled, false);
  assert.equal(replaced.settings.priority, 'balanced');
  await assert.rejects(replaced.setControl('charger1', oldAutomatic), /controls changed/);
  await assert.rejects(replaced.setSettings(oldPriority), /controls changed/);
});

test('dashboard control changes reject stale revisions and roll back failed durable writes', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  const initial = automaticScope(runtime);
  await runtime.setControl('charger1', initial);
  await assert.rejects(runtime.setControl('charger1', initial), /controls changed/);
  const priority = priorityScope(runtime); await runtime.setSettings(priority);
  await assert.rejects(runtime.setSettings(priority), /controls changed/);
  const before = structuredClone(runtime.settings), automatic = automaticScope(runtime, 'charger1', false), shared = priorityScope(runtime, 'charger1');
  f.store.fail = true;
  await assert.rejects(runtime.setControl('charger1', automatic), /locked/);
  await assert.rejects(runtime.setSettings(shared), /locked/);
  f.store.fail = false;
  assert.deepEqual(runtime.settings, before);
  assert.equal(chargerView(runtime).controls.revision, automatic.revision);
  assert.equal(runtime.status().controls.revision, shared.revision);
  for (const input of [{ ...automatic, manualSoc: 42 }, { ...automatic, enabled: 'yes' }])
    await assert.rejects(runtime.setControl('charger1', input), /Invalid automatic/);
  await assert.rejects(runtime.setSettings({ ...shared, defaults: {} }), /Only charging priority/);
});

test('malformed current dashboard controls and retired charging state fail before mutation', async t => {
  const f = fixture(), runtime = f.create(); t.after(() => runtime.close());
  await runtime.setControl('charger1', automaticScope(runtime));
  const saved = structuredClone(f.values.get('charging:mqtt'));
  const cases = [
    { ...saved, version: 5 }, { ...saved, settings: {} }, { ...saved, mystery: true },
    { ...saved, controls: { ...saved.controls, enabled: true } },
    { ...saved, controls: { ...saved.controls, priority: 'unknown' } },
    { ...saved, controls: { ...saved.controls, revision: -1 } },
    { ...saved, chargers: { ...saved.chargers, charger1: { ...saved.chargers.charger1, controls: { enabled: true, revision: 0, minimumSoc: 100 } } } },
  ];
  for (const state of cases) {
    f.values.set('charging:mqtt', state); const writes = f.writes.length;
    assert.throws(() => f.create(), /Unsupported (saved charging controls|charging state)/);
    assert.equal(f.writes.length, writes);
  }
});

test('Charge Now works with automatic OFF across restart without enabling automatic or requiring forecast inputs', async t => {
  const f = fixture(preferences), runtime = f.create(), adapter = fakeAdapter(f.clock); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  assert.equal(chargerView(runtime).control.phase, 'off');
  runtime.updatePlan = async () => { throw new Error('forecast unavailable'); };
  await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
  assert.equal(runtime.settings.chargers.charger1.enabled, false);
  assert.equal(chargerView(runtime).control.phase, 'released');
  assert.equal(runtime.hasAutomaticControl(), true);
  await runtime.close();
  const restarted = f.create(); t.after(() => restarted.close());
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).request.chargeNow, true);
  assert.equal(chargerView(restarted).control.phase, 'released');
  assert.equal(restarted.settings.chargers.charger1.enabled, false);
  restarted.tick({ prices }); await restarted.reconcile();
  await restarted.setControl('charger1', automaticScope(restarted));
  assert.equal(chargerView(restarted).request.chargeNow, undefined);
  assert.equal(restarted.settings.chargers.charger1.enabled, true);
  assert.equal(chargerView(restarted).control.phase, 'waiting');
  assert.equal(chargerView(restarted).control.released, false);
});


test('enabling automatic replans a previous release while preserving native manual schedules', async t => {
  for (const native of [false, true]) await t.test(native ? 'native schedule' : 'previous release', async t => {
    const f = fixture(preferences), runtime = f.create(), adapter = fakeAdapter(f.clock); t.after(() => runtime.close());
    await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
    if (native) {
      adapter.setSchedule({ enabled: 'daily', daily: { timezone: 'UTC',
        periods: [{ startTime: '03:00', stopTime: '04:00', maximumAmps: 16 }] } });
      await runtime.reconcile();
    } else {
      await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
      await runtime.setControl('charger1', automaticScope(runtime, 'charger1', false));
    }
    runtime.tick({ prices }); await runtime.reconcile();
    const writes = adapter.calls.filter(row => row.kind !== 'read').length;
    await runtime.setControl('charger1', automaticScope(runtime));
    if (native) {
      assert.equal(chargerView(runtime).control.phase, 'yielded');
      assert.equal(chargerView(runtime).control.snapshot.schedule.enabled, 'daily');
      assert.equal(adapter.calls.filter(row => row.kind !== 'read').length, writes);
    } else assert.equal(chargerView(runtime).control.phase, 'waiting');
  });
});


test('accepted automatic replan survives an unavailable first read and restart', async t => {
  const f = fixture(preferences), runtime = f.create(), adapter = fakeAdapter(f.clock); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
  const read = adapter.read;
  adapter.read = async () => { throw new Error('temporarily offline'); };
  await runtime.setControl('charger1', automaticScope(runtime));
  assert.equal(runtime.settings.chargers.charger1.enabled, true);
  assert.equal(chargerView(runtime).control.released, false);
  await runtime.close(); adapter.read = read;
  const restarted = f.create(); t.after(() => restarted.close());
  restarted.tick({ prices });
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).control.phase, 'waiting');
  assert.equal(chargerView(restarted).control.released, false);
});

test('a pending durable automatic replan survives interruption before controller admission', async t => {
  const f = fixture(preferences), runtime = f.create(), adapter = fakeAdapter(f.clock); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); await runtime.reconcile();
  await runtime.chargeNow('charger1', requestScope(chargerView(runtime)));
  runtime.reconcile = async () => {};
  await runtime.setControl('charger1', automaticScope(runtime));
  assert.equal(f.values.get('charging:mqtt').chargers.charger1.replan, true);
  await runtime.close();
  const restarted = f.create(); t.after(() => restarted.close());
  restarted.tick({ prices });
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).control.phase, 'waiting');
  assert.equal(f.values.get('charging:mqtt').chargers.charger1.replan, false);
});


test('absent new controls in current state default OFF and Balanced without importing old display preferences or losing native cleanup', async t => {
  const f = fixture(preferences, {}, { charger1: true }), runtime = f.create(), adapter = fakeAdapter(f.clock); t.after(() => runtime.close());
  await runtime.setAdapter('charger1', adapter); runtime.tick({ prices }); await runtime.reconcile();
  await editSession(runtime, 'charger1', { minimumSoc: 90 });
  const original = chargerView(runtime);
  assert.equal(original.control.phase, 'waiting'); assert(original.control.owned);
  await runtime.close();
  const saved = structuredClone(f.values.get('charging:mqtt'));
  delete saved.controls;
  for (const item of Object.values(saved.chargers)) { delete item.controls; delete item.replan; }
  saved.view.settings.priority = 'charger2'; saved.view.settings.chargers.charger1.enabled = true;
  f.values.set('charging:mqtt', saved);
  const restarted = f.create(); t.after(() => restarted.close());
  assert.equal(restarted.settings.chargers.charger1.enabled, false);
  assert.equal(restarted.settings.priority, 'balanced');
  assert.equal(restarted.chargers.charger1.request.overrides.minimumSoc, 90);
  await restarted.setAdapter('charger1', adapter); await restarted.reconcile();
  assert.equal(chargerView(restarted).control.phase, 'off');
  assert.equal(chargerView(restarted).control.handoverConfirmed, true);
  assert.equal(chargerView(restarted).request.sessionId, original.request.sessionId);
  assert.equal(chargerView(restarted).settings.minimumSoc, 90);
  assert.equal(adapter.calls.filter(row => row.kind === 'clear').length, 1);
});
