import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingRuntime } from '../src/charging/runtime.js';
import { createChargingTeslaCapture } from '../src/charging/teslamate.js';
import { chargingTestReadings } from '../chart/charging-tests.js';

const START = Date.parse('2026-09-30T17:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE;

function fixture(t, vehicleId) {
  let now = START, deviceUpdates = 0;
  const physical = { connected: false, charging: false, connectedAt: null, lastDisconnectedAt: START, powerKw: 0 };
  const store = new Store(':memory:');
  const runtime = new ChargingRuntime({ engine: {}, store, clock: () => now,
    config: { input: 'mqtt', connections: { easee: { charger_id: 'synthetic-guided-charger' } },
      charging: { defaults: { manualSoc: 20, minimumSoc: 80, capacityKwh: 50, readyBy: '06:00' } } } });
  const item = runtime.chargers.charger1;
  const signal = value => ({ value, available: true, measuredAt: now, receivedAt: now, source: 'easee' });
  item.adapter = { normalize: () => ({ connected: signal(physical.connected), charging: signal(physical.charging),
    powerKw: signal(physical.powerKw), voltageV: signal(230), maximumCurrentA: signal(16), currentA: signal(physical.charging ? 10 : 0),
    supply: { availableCurrentA: [16, 16, 16], voltageV: [230, 230, 230], observedAt: now } }) };
  // This synthetic device has no transport or command implementation. Count
  // ordinary reconciliation calls so guide actions cannot secretly invoke one.
  item.controller = { status: () => ({ phase: 'off',
    session: { connected: physical.connected, connectedAt: physical.connectedAt, lastDisconnectedAt: physical.lastDisconnectedAt },
    snapshot: { online: true, controlReady: true, readAt: now, schedule: { enabled: 'none' } } }),
  update: async () => { deviceUpdates++; }, close() {} };
  item.controls.enabled = true; runtime.refreshSettings();
  const capture = createChargingTeslaCapture({ clock: () => now, brokerIdentity: 'synthetic-guided-broker' });
  if (vehicleId === 'tesla') { capture.setConnected(true); runtime.teslaCapture = capture; }
  else runtime.setMqttStatus({ connected: true, subscribed: true }, 'bmw');
  function publish({ soc = 60, target = 85, capacity = 72 } = {}) {
    if (vehicleId === 'bmw') {
      const values = { soc, chargeLimitSoc: target, usableCapacityKwh: capacity,
        pluggedIn: physical.connected, charging: physical.charging, atHome: true };
      runtime.receiveSoc(runtime.configuration.vehicles.bmw.mqttTopic, JSON.stringify({ provider: 'bmw-cardata', ...values,
        measuredAt: now, readingId: `soc-${now}`, fields: Object.fromEntries(Object.keys(values).filter(key => key !== 'soc')
          .map(key => [key, { measuredAt: now, readingId: `${key}-${now}` }])) }), {});
    } else {
      for (const [key, value] of Object.entries({ healthy: true, geofence: 'Home', battery_level: soc, charge_limit_soc: target,
        plugged_in: physical.connected, charging_state: physical.charging ? 'Charging' : 'Stopped', charger_power: physical.powerKw })) {
        capture.receive(capture.topic.replace('#', key), String(value), {});
      }
      runtime.persist();
    }
  }
  const view = () => runtime.status().chargers.find(row => row.id === 'charger1');
  const run = () => runtime.physicalTests.status().runs[0];
  const settle = async () => {
    await runtime.planningFlight;
    for (const charger of Object.values(runtime.chargers)) await charger.reconcileFlight;
    await new Promise(resolve => setImmediate(resolve));
    await runtime.planningFlight;
    for (const charger of Object.values(runtime.chargers)) await charger.reconcileFlight;
  };
  const production = () => {
    const current = view();
    return structuredClone({ revision: runtime.revision, settings: runtime.settings, request: current.request,
      values: current.values, vehicle: current.vehicle, plan: current.plan, controls: current.controls,
      matching: item.vehicleMatch, evidence: item.vehicleEvidence, targetState: item.targetState,
      progress: item.progress, deviceUpdates });
  };
  function guide(action, input) {
    const before = production();
    try { return runtime.chargingTestAction(action, input); }
    finally { assert.deepEqual(production(), before, `${vehicleId}: ${action} must change only assessment state`); }
  }
  t.after(async () => { await runtime.close(); capture.close(); store.close(); });
  return { runtime, item, physical, publish, view, run, settle, production, guide, capture,
    advance(ms) { now += ms; }, get now() { return now; } };
}

for (const vehicleId of ['bmw', 'tesla']) test(`${vehicleId}: guide readings and every guide action stay separate from normal identification, target and planning`, async t => {
  const f = fixture(t, vehicleId);
  f.publish(); await f.settle();
  const disconnected = f.view();
  assert.equal(disconnected.vehicle.state, 'disconnected');
  assert.equal(disconnected.values.minimumSoc.value, 80, 'An unplugged charger retains its independent default target');
  const loaded = chargingTestReadings({ now: f.now, charging: f.runtime.status() }, vehicleId);
  assert.equal(loaded.nativeTargetSoc.value, 85, 'The guide reads the real car target directly, independently of charger identity');
  assert.equal(loaded.soc.value, 60);
  assert.equal(loaded.capacityKwh.value, vehicleId === 'bmw' ? 72 : 57);
  const input = { chargerId: 'charger1', vehicleId, association: disconnected.association, program: 'vehicle-schedule',
    // Deliberately different guide declarations must never become production inputs.
    soc: 55, capacityKwh: 35, nativeTargetSoc: loaded.nativeTargetSoc.value,
    vehicleStartAt: f.now + HOUR, prepared: true };
  const preview = f.guide('preview', input);
  assert.equal(preview.eligible, true, JSON.stringify(preview.gates));
  assert.equal(preview.headroom.capacityKwh, 35);
  f.guide('start', input);
  assert.equal(f.run().expectations.nativeTargetSoc, 85);
  assert.equal(f.view().request, null, 'Arming cannot create a physical session');

  f.advance(MINUTE);
  Object.assign(f.physical, { connected: true, connectedAt: f.now });
  f.runtime.persist(); await f.settle();
  let current = f.view();
  assert.ok(current.request.sessionId);
  assert.equal(f.run().sessionId, current.request.sessionId);
  assert.notEqual(current.vehicle.state, 'identified', 'Selecting a vehicle in the guide supplies no matching evidence');
  assert.equal(current.values.soc.value, 20);
  assert.equal(current.values.minimumSoc.value, 80);
  assert.equal(current.values.capacityKwh.value, 50);
  assert.deepEqual(current.request.overrides, {}, 'Guide declarations must never be copied into a session request');

  f.advance(MINUTE);
  Object.assign(f.physical, { charging: true, powerKw: 7 });
  f.runtime.persist();
  f.publish(); await f.settle();
  if (vehicleId === 'bmw') {
    assert.notEqual(f.view().vehicle.state, 'identified', 'BMW needs its corresponding physical and vehicle stop evidence');
    f.advance(MINUTE);
    Object.assign(f.physical, { charging: false, powerKw: 0 });
    f.runtime.persist();
    f.publish(); await f.settle();
  }
  current = f.view();
  assert.equal(current.vehicle.state, 'identified');
  assert.equal(current.vehicle.id, vehicleId);
  assert.equal(current.values.soc.value, 60);
  assert.equal(current.values.minimumSoc.value, 85, 'Normal matching acquires the same real vehicle target from its own feed');
  assert.equal(current.values.vehicleCeilingSoc.value, 85);
  assert.equal(current.values.minimumSoc.source, vehicleId === 'bmw' ? 'bmw-cardata' : 'teslamate');
  assert.equal(current.values.capacityKwh.value, vehicleId === 'bmw' ? 72 : 57);
  assert.deepEqual(current.request.overrides, {});
  assert.equal(f.run().expectations.soc, 55);
  assert.equal(f.run().expectations.capacityKwh, 35);

  f.runtime.prices = Array.from({ length: 12 }, (_, index) => ({ start: START + index * HOUR,
    end: START + (index + 1) * HOUR, price: 10 + index }));
  f.runtime.pricesInitialized = true;
  await f.runtime.updatePlan(f.now); await f.settle();
  assert.ok(f.view().plan.periods.length, 'The ordinary production planner supplies actual periods');
  assert.equal(f.view().values.minimumSoc.value, 85);
  assert.equal(f.run().recommendation.state, 'available', f.run().recommendation.message);
  let run = f.run();
  f.guide('schedule', { id: run.id, association: run.association, sessionId: run.sessionId,
    startAt: run.recommendation.startAt });
  assert.equal(f.run().schedule.startAt, run.recommendation.startAt);

  // Re-verification and a changed assessment expectation must both leave the
  // native 85% target and independently built normal plan untouched.
  for (const nativeTargetSoc of [85, 90, 85]) {
    run = f.run();
    f.guide('target', { id: run.id, association: run.association, sessionId: run.sessionId,
      targetRevision: run.target.revision, nativeTargetSoc });
    assert.equal(f.run().expectations.nativeTargetSoc, nativeTargetSoc);
    assert.equal(f.run().target.reportedSoc, 85);
    assert.equal(f.run().target.requiresConfirmation, nativeTargetSoc !== 85,
      'Only the assessment flags a declared target that differs from independently observed vehicle settings');
    assert.equal(f.view().values.minimumSoc.value, 85);
    assert.equal(f.view().values.vehicleCeilingSoc.value, 85);
    assert.deepEqual(f.view().request.overrides, {});
  }
  assert.throws(() => f.guide('target', { id: run.id, association: run.association, sessionId: run.sessionId,
    targetRevision: run.target.revision, nativeTargetSoc: 90 }), /assessment target.*changed/,
  'A stale assessment revision cannot replace the newer expectation or influence actual charging');
  assert.equal(f.run().expectations.nativeTargetSoc, 85);
  run = f.run();
  f.guide('cancel', { id: run.id, association: run.association });
  assert.equal(f.run().phase, 'cancelled');
  assert.equal(f.view().vehicle.id, vehicleId);
  assert.equal(f.view().values.minimumSoc.value, 85);
});

for (const vehicleId of ['bmw', 'tesla']) test(`${vehicleId}: verified car target survives fluctuating reports without entering normal charging knowledge`, async t => {
  const f = fixture(t, vehicleId);
  f.publish({ target: 100, capacity: 72.43 }); await f.settle();
  const loaded = chargingTestReadings({ now: f.now, charging: f.runtime.status() }, vehicleId);
  assert.equal(loaded.nativeTargetSoc.value, 100);
  if (vehicleId === 'bmw') assert.equal(loaded.capacityKwh.value, 72.43);
  const input = { chargerId: 'charger1', vehicleId, association: f.view().association, program: 'immediate',
    soc: 52.36, capacityKwh: 71.29, nativeTargetSoc: 85, prepared: true };
  assert.equal(f.guide('preview', input).eligible, true);
  f.guide('start', input);
  assert.equal(f.run().expectations.capacityKwh, 71.29);

  f.advance(MINUTE);
  Object.assign(f.physical, { connected: true, connectedAt: f.now });
  f.runtime.persist(); await f.settle();
  f.advance(MINUTE);
  Object.assign(f.physical, { charging: true, powerKw: 7 });
  f.runtime.persist(); f.publish({ target: 100 }); await f.settle();
  if (vehicleId === 'bmw') {
    f.advance(MINUTE);
    Object.assign(f.physical, { charging: false, powerKw: 0 });
    f.runtime.persist(); f.publish({ target: 100 }); await f.settle();
  }
  assert.equal(f.view().vehicle.state, 'identified');
  assert.equal(f.view().values.minimumSoc.value, 100);
  assert.equal(f.run().target.requiresConfirmation, true);
  let run = f.run();
  f.guide('target', { id: run.id, association: run.association, sessionId: run.sessionId,
    targetRevision: run.target.revision, nativeTargetSoc: 85,
    verification: { reportedSoc: 100, source: vehicleId === 'bmw' ? 'bmw-cardata' : 'teslamate' } });
  assert.equal(f.run().target.requiresConfirmation, false);
  assert.equal(f.run().expectations.nativeTargetSoc, 85);
  assert.equal(f.view().values.minimumSoc.value, 100, 'The actual controller keeps its independently acquired target');
  assert.equal(f.run().milestones.vehicleTarget, undefined, 'Manual verification is not observed battery charge');
  assert.equal(f.run().milestones.completion, undefined);

  for (const target of [100, 85, 100, 85, 100]) {
    f.advance(MINUTE);
    f.publish({ target }); await f.settle();
    assert.equal(f.run().target.reportedSoc, target, 'The guide preserves the original car report');
    assert.equal(f.view().values.vehicleCeilingSoc.value, target, 'The production raw reading is never rewritten');
    assert.equal(f.run().target.requiresConfirmation, false, 'A repeated reviewed report does not invalidate explicit verification');
    assert.deepEqual(f.view().request.overrides, {});
  }
  assert.equal(f.run().expectations.soc, 52.36);
  assert.equal(f.run().expectations.capacityKwh, 71.29);
  assert.equal(f.view().values.soc.value, 60);
  assert.equal(f.view().values.capacityKwh.value, vehicleId === 'bmw' ? 72 : 57);

  // A different unseen setting needs review, but never edits normal control.
  f.advance(MINUTE); f.publish({ target: 90 }); await f.settle();
  assert.equal(f.run().target.requiresConfirmation, true);
  run = f.run();
  assert.throws(() => f.guide('target', { id: run.id, association: run.association, sessionId: run.sessionId,
    targetRevision: run.target.revision, nativeTargetSoc: 85,
    verification: { reportedSoc: 100, source: vehicleId === 'bmw' ? 'bmw-cardata' : 'teslamate' } }), /report.*changed|changed.*report/i);
  assert.equal(f.run().target.requiresConfirmation, true);

  f.advance(MINUTE); f.publish({ target: 100 }); await f.settle();
  assert.equal(f.run().target.requiresConfirmation, false);
  f.advance(MINUTE); Object.assign(f.physical, { charging: false, powerKw: 0 });
  f.runtime.persist(); f.publish({ soc: 85, target: 100 }); await f.settle();
  assert.equal(f.run().phase, 'completed', 'Observed battery target and physical stop can complete an explicitly verified target');
  assert.equal(f.run().target.reportedSoc, 100);
  assert.equal(f.run().milestones.vehicleTarget.targetSoc, 85);
  assert.deepEqual(f.view().request.overrides, {});
});
