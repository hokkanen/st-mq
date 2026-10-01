import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingPhysicalTests } from '../src/charging/physical-tests.js';
import { chargingDiagnosticSessionId } from '../src/charging/session-diagnostics.js';
import { easeeChargerTelemetry } from '../src/charging/easee.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';
import { updateChargingProgress } from '../src/charging/progress.js';
import { CHARGING_EFFICIENCY } from '../src/domain/charging-energy.js';

const MINUTE = 60_000, HOUR = 60 * MINUTE, START = Date.parse('2026-09-30T18:00:00Z');
const value = (input, extra = {}) => ({ value: input, available: true, source: 'charger', ...extra });

function fixture() {
  let now = START;
  const saved = new Map(), writes = [], store = {
    getState: key => saved.get(key),
    setState(key, state) { saved.set(key, structuredClone(state)); writes.push(key); },
  };
  const create = () => new ChargingPhysicalTests({ store, key: 'physical-tests', clock: () => now });
  const view = {
    settings: { vehicles: { bmw: { capacityKwh: 74 }, tesla: { capacityKwh: 57 } } },
    vehicleFeeds: ['bmw', 'tesla'].map(id => ({ id, reception: { available: true }, usedByChargerId: null })),
    chargers: ['charger1', 'charger2'].map((id, index) => ({ id, association: `synthetic-equipment-${index}`, provider: index ? 'shelly-evse' : 'easee',
      controls: { enabled: true }, capabilities: { scheduling: true }, settings: { manualSoc: 20, minimumSoc: 80 },
      control: { snapshot: { transport: index ? 'shelly-evse' : 'easee', online: true, readAt: now, controlReady: true }, session: { connected: false } },
      request: null, vehicle: { state: 'disconnected', id: null }, identification: { phase: 'waiting' }, plan: null,
      values: { connected: value(false), soc: value(20, { source: 'manual-fallback', assumed: true }), minimumSoc: value(80, { source: 'manual-fallback' }),
        vehicleCeilingSoc: { available: false, value: null }, capacityKwh: value(74), maximumCurrentA: value(16), voltageV: value(230),
        charging: value(false), powerKw: value(0) },
    })),
  };
  const input = (extra = {}) => ({ chargerId: 'charger1', vehicleId: 'bmw', program: 'immediate', association: view.chargers[0].association,
    soc: 40, nativeTargetSoc: 80, capacityKwh: extra.vehicleId === 'tesla' ? 57 : 74, prepared: true, ...extra });
  const advance = (duration = MINUTE) => {
    now += duration;
    for (const charger of view.chargers) if (charger.control.snapshot) charger.control.snapshot.readAt = now;
    return now;
  };
  const plug = (charger = view.chargers[0]) => {
    advance(); charger.values.connected = value(true);
    charger.values.powerKw = value(0, { measuredAt: now, receivedAt: now });
    charger.control.session = { connected: true, connectedAt: now };
    charger.request = { sessionId: `synthetic-session-${now}`, revision: 1, deadlineAt: now + 10 * HOUR };
    charger.vehicle = { state: 'unidentified', id: null, sessionId: charger.request.sessionId };
    return charger;
  };
  const identify = (charger = view.chargers[0], id = 'bmw', soc = 40) => {
    charger.vehicle = { state: 'identified', id, sessionId: charger.request.sessionId };
    charger.values.soc = value(soc, { source: id === 'bmw' ? 'bmw-cardata' : 'teslamate', measuredAt: now, receivedAt: now });
  };
  const plan = (charger = view.chargers[0], start = now + HOUR) => {
    charger.plan = { reason: 'cheapest-feasible-start', deadlineAt: charger.request.deadlineAt, feasible: true,
      periods: [{ startAt: start, endAt: null }] };
  };
  return { saved, writes, store, create, view, input, advance, plug, identify, plan, clock: () => now };
}

test('preparation gates use live readiness and duration instead of one fixed battery threshold', () => {
  const f = fixture(), tests = f.create();
  const bmw = tests.preview(f.input({ soc: 70 }), f.view);
  const tesla = tests.preview(f.input({ vehicleId: 'tesla', soc: 70 }), f.view);
  assert.equal(bmw.eligible, true); assert.equal(tesla.eligible, true);
  assert.ok(bmw.headroom.minutes > tesla.headroom.minutes);
  assert.ok(bmw.headroom.minutes > 40 && bmw.headroom.minutes < 45);
  assert.equal(tests.preview(f.input({ program: 'vehicle-schedule', soc: 70, vehicleStartAt: START + HOUR }), f.view).eligible, false);
  const unknown = tests.preview(f.input({ soc: null, nativeTargetSoc: null }), f.view);
  assert.equal(unknown.headroom.minutes, null); assert.equal(unknown.eligible, false);
  assert.equal(f.writes.length, 0);
});

test('guided duration uses published planning voltage even before a vehicle draws power', () => {
  const f = fixture(), tests = f.create();
  const charger = f.view.chargers[0];
  charger.forecast = { powerKw: 0, voltageV: 240 };
  charger.values.voltageV = { value: 210, available: true };
  const first = tests.preview(f.input(), f.view).headroom;
  charger.values.voltageV.value = 245;
  const changed = tests.preview(f.input(), f.view).headroom;
  assert.equal(first.powerKw, 11.52);
  assert.equal(changed.minutes, first.minutes);
});

test('accepted usable capacity drives preparation without rewriting configuration and is required to arm', () => {
  const f = fixture(), tests = f.create(), original = structuredClone(f.view.settings);
  const smaller = tests.preview(f.input({ capacityKwh: 35 }), f.view);
  const larger = tests.preview(f.input({ capacityKwh: 70 }), f.view);
  assert.equal(larger.headroom.minutes, smaller.headroom.minutes * 2);
  assert.equal(smaller.headroom.basis, 'accepted-capacity-and-expected-power');
  assert.equal(tests.preview(f.input({ capacityKwh: null }), f.view).eligible, false);
  for (const capacityKwh of [null, undefined, 0, -1, 301, '74'])
    assert.throws(() => tests.start(f.input({ capacityKwh }), f.view), /capacity/);
  const run = tests.start(f.input({ capacityKwh: 70 }), f.view);
  assert.equal(run.expectations.capacityKwh, 70);
  assert.deepEqual(f.view.settings, original);
});

test('real Easee normalization supplies unplugged headroom from fixed limits, independent of zero idle draw', () => {
  const f = fixture(), tests = f.create(), original = f.view.chargers[0];
  const snapshot = { readAt: START, online: true, mode: 1, modeAt: START, pluggedIn: false, enabled: true,
    powerKw: 0, manualStop: false, schedule: { enabled: 'none' },
    limits: { chargerA: 16, cableA: 32, circuitA: [16, 16, 16], dynamicChargerA: 0, equalizerAvailableA: [0, 0, 0] },
    supply: { voltageV: [230, 230, 230], observedAt: START }, observations: {} };
  const control = { snapshot, session: { connected: false }, manualCurrentA: 0 };
  const telemetry = easeeChargerTelemetry(snapshot, { now: START });
  f.view.chargers[0] = { ...buildCharger({ definition: CHARGER_DEFINITIONS[0], settings: { enabled: true, readyBy: '06:00',
    manualSoc: 20, minimumSoc: 80, capacityKwh: 74 }, telemetry, control, now: START }),
  association: original.association, controls: { enabled: true } };
  const preview = tests.preview(f.input(), f.view);
  assert.equal(preview.eligible, true, JSON.stringify(preview.gates));
  assert.equal(preview.headroom.powerKw, 11.04);
  assert.ok(preview.headroom.minutes > 170);
});

test('assessment observer records accepted inputs without itself changing session requests, telemetry or plans', () => {
  const f = fixture(), tests = f.create(), before = structuredClone(f.view);
  const run = tests.start(f.input({ soc: 37, nativeTargetSoc: 89 }), f.view);
  assert.equal(run.phase, 'armed'); assert.equal(run.expectations.soc, 37);
  assert.deepEqual(f.view, before);
  assert.equal(f.writes.length, 1);
  run.expectations.soc = 99;
  assert.equal(tests.status().runs[0].expectations.soc, 37);
  assert.throws(() => tests.start(f.input(), f.view), /existing guided test/);
  assert.throws(() => tests.start(f.input({ chargerId: 'charger2', association: f.view.chargers[1].association }), f.view), /existing guided test/);
});

test('arming refuses connected, stale, uncommissioned, stopped, unprepared and unhealthy setups', () => {
  for (const mutate of [
    f => { f.view.chargers[0].values.connected = value(true); },
    f => { f.view.chargers[0].control.snapshot.readAt = START - 2 * MINUTE; },
    f => { f.view.chargers[0].control.snapshot.controlReady = false; },
    f => { f.view.chargers[0].control.snapshot.manualStop = true; },
    f => { f.view.chargers[0].control.snapshot.nativeScheduleActive = true; },
    f => { f.view.chargers[0].controls.enabled = false; },
    f => { f.view.vehicleFeeds[0].reception.available = false; },
  ]) {
    const f = fixture(), tests = f.create(); mutate(f);
    assert.throws(() => tests.start(f.input(), f.view)); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), tests = f.create();
  assert.throws(() => tests.start(f.input({ prepared: false }), f.view));
  assert.throws(() => tests.start(f.input({ association: 'replaced-charger' }), f.view));
  assert.throws(() => tests.start(f.input({ program: 'vehicle-schedule' }), f.view));
});

test('normal test follows a fresh physical connection, real plan and native completion across browser/server restart', () => {
  const f = fixture(); let tests = f.create();
  const run = tests.start(f.input(), f.view), charger = f.plug();
  f.identify(); f.plan(); tests.update(f.view);
  const attached = tests.status().runs[0];
  assert.equal(attached.id, run.id); assert.equal(attached.phase, 'observing');
  assert.equal(attached.sessionId, charger.request.sessionId);
  assert.ok(attached.milestones.identification); assert.ok(attached.initialPlan);
  assert.ok(attached.milestones.identifiedPlanningInputs);
  tests = f.create(); f.advance();
  charger.values.charging = value(true); charger.values.powerKw = value(10, { measuredAt: f.clock(), receivedAt: f.clock() });
  f.identify(charger, 'bmw', 70); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  f.advance(); f.identify(charger, 'bmw', 80); tests.update(f.view);
  assert.ok(tests.status().runs[0].milestones.vehicleTarget);
  assert.equal(tests.status().runs[0].phase, 'observing', 'target is not a stop instruction');
  f.advance(); charger.values.charging = value(false); charger.values.powerKw = value(0, { measuredAt: f.clock(), receivedAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'completed');
  assert.equal(tests.status().runs[0].endReason, 'vehicle-target-and-stop-observed');
  charger.values.connected = value(false); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'completed', 'unplug retains the completed report');
});

test('planning target, estimated battery and zero power cannot finish a test', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input({ nativeTargetSoc: 90 }), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 80); f.plan(); tests.update(f.view);
  assert.equal(tests.status().runs[0].milestones.vehicleTarget, undefined);
  assert.equal(tests.status().runs[0].milestones.completion, undefined);
  charger.progress = { estimatedSoc: 100 }; tests.update(f.view);
  charger.values.soc = value(100, { source: 'manual-fallback', assumed: true, measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  charger.values.soc = value(100, { source: 'bmw-cardata', measuredAt: START - HOUR }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing', 'old preconnection battery reading is not completion');
});

test('an earlier attained target does not confirm a later accepted higher target by ready-by', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input(), f.view), charger = f.plug();
  f.identify(charger, 'bmw', 80); charger.values.powerKw = value(7, { measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].milestones.vehicleTarget.targetSoc, 80);
  f.advance();
  tests.confirmTarget({ id: run.id, association: run.association, sessionId: charger.request.sessionId,
    targetRevision: tests.status().runs[0].target.revision, nativeTargetSoc: 90 }, f.view);
  charger.values.minimumSoc = value(90, { source: 'session-request' });
  f.advance(10 * HOUR); tests.update(f.view);
  assert.equal(tests.status().runs[0].milestones.deadline.state, 'not-confirmed-by-deadline');
  assert.equal(tests.status().runs[0].milestones.deadline.targetSoc, 90);
});

test('guide target confirmation remains isolated even when an explicit ordinary session override differs from the car', () => {
  for (const vehicleId of ['bmw', 'tesla']) {
    const f = fixture(); let tests = f.create();
    const run = tests.start(f.input({ vehicleId }), f.view), charger = f.plug();
    // An unrelated user action may explicitly override the ordinary request.
    // Confirming a guide assumption must not overwrite that independent action.
    charger.request.overrides = { minimumSoc: 80 };
    charger.values.minimumSoc = value(80, { source: 'session-request' });
    f.identify(charger, vehicleId, 70);
    charger.values.vehicleCeilingSoc = value(90, { source: vehicleId === 'bmw' ? 'bmw-cardata' : 'teslamate', receivedAt: START });
    charger.values.powerKw = value(7, { measuredAt: f.clock() }); tests.update(f.view);
    f.advance(); f.identify(charger, vehicleId, 90);
    charger.values.powerKw = value(0, { measuredAt: f.clock() }); tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, 'observing');
    assert.equal(tests.status().runs[0].expectations.nativeTargetSoc, 80);
    assert.equal(tests.status().runs[0].target.reportedSoc, 90);
    assert.equal(tests.status().runs[0].target.requiresConfirmation, true);
    assert.ok(tests.status().runs[0].findings.some(row => row.code === 'vehicle-limit-differs-from-preparation'));
    const action = { id: run.id, association: run.association, sessionId: charger.request.sessionId,
      targetRevision: tests.status().runs[0].target.revision, nativeTargetSoc: 90 };
    assert.throws(() => tests.confirmTarget({ ...action, targetRevision: 99 }, f.view), /session changed/);
    assert.throws(() => tests.confirmTarget({ ...action, revision: charger.request.revision }, f.view), /Invalid physical charging test action/);
    charger.request.revision += 5;
    const before = structuredClone(f.view);
    tests.confirmTarget(action, f.view);
    assert.deepEqual(f.view, before, 'assessment confirmation neither depends on nor modifies ordinary session request revisions');
    assert.equal(tests.status().runs[0].target.requiresConfirmation, false, 'actual vehicle report and assessment assumption now agree');
    assert.equal(charger.values.minimumSoc.value, 80, 'the explicit ordinary session override is untouched');
    tests = f.create(); tests.update(f.view);
    assert.equal(tests.status().runs[0].target.requiresConfirmation, false);
    assert.equal(tests.status().runs[0].phase, 'completed');
    assert.deepEqual(tests.status().runs[0].target.history.map(row => row.targetSoc), [80, 90]);
    assert.equal(tests.status().runs[0].target.revision, 2);
    assert.throws(() => tests.confirmTarget(action, f.view), /changed/);
  }
});

test('an entered guide assumption of 67 cannot pass against an independently reported car target of 85', () => {
  for (const vehicleId of ['bmw', 'tesla']) {
    const f = fixture(), tests = f.create();
    const run = tests.start(f.input({ vehicleId, nativeTargetSoc: 67 }), f.view), charger = f.plug();
    const source = vehicleId === 'bmw' ? 'bmw-cardata' : 'teslamate';
    f.identify(charger, vehicleId, 40);
    // These values arrive through the normal independently identified car feed;
    // no guide declaration is used to set either production field.
    charger.values.vehicleCeilingSoc = value(85, { source, receivedAt: f.clock() });
    charger.values.minimumSoc = value(85, { source });
    charger.values.powerKw = value(7, { measuredAt: f.clock() }); tests.update(f.view);
    f.advance(); f.identify(charger, vehicleId, 67);
    charger.values.powerKw = value(0, { measuredAt: f.clock() });
    const at67 = structuredClone(f.view); tests.update(f.view);
    const mismatch = tests.status().runs[0];
    assert.deepEqual(f.view, at67);
    assert.equal(mismatch.phase, 'observing');
    assert.equal(mismatch.expectations.nativeTargetSoc, 67);
    assert.equal(mismatch.target.reportedSoc, 85);
    assert.equal(mismatch.target.requiresConfirmation, true);
    assert.equal(mismatch.milestones.vehicleTarget, undefined);
    assert.equal(mismatch.milestones.completion, undefined);
    tests.confirmTarget({ id: run.id, association: run.association, sessionId: charger.request.sessionId,
      targetRevision: mismatch.target.revision, nativeTargetSoc: 85 }, f.view);
    tests.update(f.view);
    assert.deepEqual(f.view, at67, 'recording the verified car target changes only the assessment');
    assert.equal(tests.status().runs[0].phase, 'observing', '67 is still below the car target');
    assert.equal(tests.status().runs[0].milestones.vehicleTarget, undefined);
    f.advance(); f.identify(charger, vehicleId, 85);
    charger.values.powerKw = value(0, { measuredAt: f.clock() });
    const at85 = structuredClone(f.view); tests.update(f.view);
    assert.deepEqual(f.view, at85);
    assert.equal(tests.status().runs[0].phase, 'completed');
    assert.equal(tests.status().runs[0].milestones.vehicleTarget.targetSoc, 85);
    assert.equal(charger.values.minimumSoc.value, 85);
  }
});

test('an ordinary session-request field cannot masquerade as independently reported car target evidence', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); f.identify(charger);
  charger.values.vehicleCeilingSoc = value(67, { source: 'session-request', receivedAt: f.clock() });
  const before = structuredClone(f.view); tests.update(f.view);
  assert.deepEqual(f.view, before);
  assert.equal(tests.status().runs[0].target.reportedSoc, null);
  assert.equal(tests.status().runs[0].expectations.nativeTargetSoc, 80);
});

test('actual reported target conflicts remain explicit while ordinary planner settings are independent', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input({ nativeTargetSoc: 90 }), f.view), charger = f.plug();
  f.identify(charger, 'bmw', 70);
  charger.values.powerKw = value(7, { measuredAt: f.clock() }); tests.update(f.view);
  f.advance(); f.identify(charger, 'bmw', 80);
  charger.values.vehicleCeilingSoc = value(80, { source: 'bmw-cardata', receivedAt: f.clock() });
  charger.values.powerKw = value(0, { measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.equal(tests.status().runs[0].target.requiresConfirmation, true);
  tests.confirmTarget({ id: run.id, association: run.association, sessionId: charger.request.sessionId,
    targetRevision: tests.status().runs[0].target.revision, nativeTargetSoc: 90 }, f.view);
  assert.equal(tests.status().runs[0].target.requiresConfirmation, true, 'reaffirming an assumption cannot erase contradictory evidence');
  f.advance(); charger.values.vehicleCeilingSoc = value(90, { source: 'bmw-cardata', receivedAt: f.clock() });
  charger.values.minimumSoc = value(95, { source: 'session-request' });
  f.identify(charger, 'bmw', 90); charger.values.powerKw = value(0, { measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].target.reportedSoc, 90);
  assert.equal(tests.status().runs[0].target.requiresConfirmation, false);
  assert.equal(tests.status().runs[0].phase, 'completed');
  assert.equal(charger.values.minimumSoc.value, 95, 'assessment observation leaves ordinary settings alone');
});

test('delayed test obtains a suggestion only from the real plan and retains early identification as uncovered timing', () => {
  const f = fixture(), tests = f.create(), input = f.input({ program: 'vehicle-schedule', vehicleStartAt: START + 3 * HOUR });
  const run = tests.start(input, f.view), charger = f.plug(); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'awaiting-vehicle-schedule');
  assert.equal(tests.status().runs[0].recommendation.state, 'waiting-for-plan');
  assert.throws(() => tests.confirmSchedule({ id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt: START + 3 * HOUR }, f.view), /real charging plan/);
  f.plan(charger, START + HOUR); f.identify(); tests.update(f.view);
  const suggested = tests.status().runs[0].recommendation;
  assert.equal(suggested.baselineStartAt, START + HOUR);
  assert.equal(suggested.startAt, START + HOUR + 15 * MINUTE);
  const before = structuredClone(f.view);
  tests.confirmSchedule({ id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt: suggested.startAt }, f.view);
  assert.deepEqual(f.view, before);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'identified-before-vehicle-start'));
  assert.match(tests.status().runs[0].restorationReminder, /Restore or remove/);
});

test('delayed recommendations preserve a real pause and resume and refuse intentionally insufficient opportunity', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input({ program: 'vehicle-schedule', vehicleStartAt: START + HOUR }), f.view), charger = f.plug();
  f.plan(charger, START + HOUR); charger.plan.periods = [{ startAt: START + HOUR, endAt: START + 2 * HOUR }, { startAt: START + 4 * HOUR, endAt: null }];
  tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.startAt, START + HOUR + 15 * MINUTE);
  assert.ok(tests.status().runs[0].recommendation.coverageOpportunities.includes('pause-and-resume'));
  const action = { id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt: START + 12 * HOUR };
  assert.throws(() => tests.confirmSchedule(action, f.view), /insufficient charging opportunity/);
  assert.throws(() => tests.confirmSchedule({ ...action, acknowledgeRisk: true }, f.view), /Invalid physical charging test action/);
  charger.request.deadlineAt = START + 90 * MINUTE; charger.plan.deadlineAt = charger.request.deadlineAt;
  tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.state, 'unavailable');
});

test('a Tesla timer incorporated into the real plan before confirmation does not demand another delay', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input({ vehicleId: 'tesla', program: 'vehicle-schedule', vehicleStartAt: START + 3 * HOUR }), f.view);
  const charger = f.plug(); f.plan(charger, START + HOUR); tests.update(f.view);
  const suggested = tests.status().runs[0].recommendation.startAt;
  f.advance(); f.identify(charger, 'tesla');
  charger.values.vehicleNotBefore = value(suggested, { source: 'teslamate', receivedAt: f.clock() });
  f.plan(charger, suggested); tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.startAt, suggested);
  assert.match(tests.status().runs[0].recommendation.message, /already includes/);
  tests.confirmSchedule({ id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt: suggested }, f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.equal(tests.status().runs[0].expectations.vehicleStartAt, START + 3 * HOUR);
  assert.equal(tests.status().runs[0].schedule.startAt, suggested);
});

test('an initially identified Tesla can keep its suitable existing native timer without manufacturing a delay', () => {
  const f = fixture(), tests = f.create(), startAt = START + 3 * HOUR;
  const run = tests.start(f.input({ vehicleId: 'tesla', program: 'vehicle-schedule', vehicleStartAt: startAt }), f.view);
  const charger = f.plug(); f.identify(charger, 'tesla'); f.plan(charger, startAt);
  charger.values.vehicleNotBefore = value(startAt, { source: 'teslamate', receivedAt: f.clock() });
  tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.startAt, startAt);
  tests.confirmSchedule({ id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt }, f.view);
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'identified-before-vehicle-start'));
});

test('repeated schedule adjustments retain original, latest saved value and receipts across restart for both vehicles', () => {
  for (const vehicleId of ['bmw', 'tesla']) {
    const f = fixture(); let tests = f.create();
    const initialStartAt = START + 3 * HOUR;
    const run = tests.start(f.input({ vehicleId, program: 'vehicle-schedule', vehicleStartAt: initialStartAt }), f.view);
    const charger = f.plug(); f.plan(charger, START + HOUR); f.identify(charger, vehicleId); tests.update(f.view);
    const first = START + 2 * HOUR, second = START + 4 * HOUR;
    const action = { id: run.id, association: run.association, sessionId: charger.request.sessionId };
    tests.confirmSchedule({ ...action, startAt: first }, f.view);
    const firstReceipt = f.clock();
    tests = f.create(); f.advance();
    tests.confirmSchedule({ ...action, startAt: second }, f.view);
    const secondReceipt = f.clock();
    tests = f.create(); f.advance(); f.plan(charger, START + 90 * MINUTE); tests.update(f.view);
    const restored = tests.status().runs[0];
    assert.equal(restored.expectations.vehicleStartAt, initialStartAt);
    assert.equal(restored.schedule.startAt, second);
    assert.equal(restored.schedule.confirmedAt, secondReceipt);
    assert.deepEqual(restored.schedule.history, [
      { startAt: first, confirmedAt: firstReceipt, source: 'user-confirmed' },
      { startAt: second, confirmedAt: secondReceipt, source: 'user-confirmed' },
    ]);
    assert.equal(restored.milestones.vehicleSchedule.startAt, second);
    assert.equal(restored.milestones.vehicleSchedule.at, secondReceipt);
    assert.notEqual(restored.recommendation.startAt, second, 'updated recommendations stay separate from confirmed values');
  }
});

test('later timer adjustments cannot retroactively turn an observed on-time identity into early identification', () => {
  for (const vehicleId of ['bmw', 'tesla']) {
    const f = fixture(); let tests = f.create();
    const initialStartAt = START + HOUR;
    const run = tests.start(f.input({ vehicleId, program: 'vehicle-schedule', vehicleStartAt: initialStartAt }), f.view);
    const charger = f.plug(); f.plan(charger, START + 30 * MINUTE); tests.update(f.view);
    f.advance(HOUR); f.identify(charger, vehicleId); tests.update(f.view);
    const identity = tests.status().runs[0].milestones.identification;
    assert.ok(identity.at > initialStartAt);
    assert.equal(identity.startAt, initialStartAt);
    assert.equal(tests.status().runs[0].findings.some(row => row.code === 'identified-before-vehicle-start'), false);
    const adjustedStartAt = START + 3 * HOUR;
    tests.confirmSchedule({ id: run.id, association: run.association, sessionId: charger.request.sessionId,
      startAt: adjustedStartAt }, f.view);
    tests.update(f.view);
    tests = f.create(); f.advance(); tests.update(f.view);
    const restored = tests.status().runs[0];
    assert.equal(restored.schedule.startAt, adjustedStartAt);
    assert.deepEqual(restored.milestones.identification, identity);
    assert.equal(restored.findings.some(row => row.code === 'identified-before-vehicle-start'), false);
  }
});

test('later schedule suggestions and confirmation use ordinary remaining energy after charging and a revised target', () => {
  for (const vehicleId of ['bmw', 'tesla']) for (const basis of ['vehicle-reading', 'recorded-energy']) {
    const f = fixture(), tests = f.create();
    const run = tests.start(f.input({ vehicleId, capacityKwh: 74, program: 'vehicle-schedule', vehicleStartAt: START + 3 * HOUR }), f.view);
    const charger = f.plug(); f.identify(charger, vehicleId); f.plan(charger, START + HOUR);
    charger.telemetry = { vehicle: charger.vehicle };
    let progressState;
    const creditKwh = 74 * 35 / 100 / CHARGING_EFFICIENCY;
    const progress = (credit = 0) => {
      charger.requiredGridKwh = 74 * Math.max(0, charger.values.minimumSoc.value - charger.values.soc.value) / 100 / CHARGING_EFFICIENCY;
      const next = updateChargingProgress(progressState, charger, f.clock(), () => ({ gridKwh: credit, coveredMs: credit > 0 ? HOUR : 0 }));
      progressState = next.state;
      charger.progress = { ...next, state: undefined };
      charger.requiredGridKwh = next.remainingGridKwh;
    };
    progress(); tests.update(f.view);
    f.advance(6 * HOUR);
    if (basis === 'vehicle-reading') f.identify(charger, vehicleId, 75);
    progress(basis === 'recorded-energy' ? creditKwh : 0);
    f.plan(charger, START + 9 * HOUR); tests.update(f.view);
    const suggested = tests.status().runs[0].recommendation;
    assert.equal(suggested.state, 'available', `${vehicleId} ${basis}: ${suggested.message}`);
    assert.match(suggested.message, /current session/);
    assert.equal(suggested.startAt, START + 9 * HOUR + 15 * MINUTE);
    const action = { id: run.id, association: run.association, sessionId: charger.request.sessionId };
    tests.confirmSchedule({ ...action, startAt: suggested.startAt }, f.view);
    assert.equal(tests.status().runs[0].schedule.startAt, suggested.startAt);

    tests.confirmTarget({ ...action, targetRevision: tests.status().runs[0].target.revision, nativeTargetSoc: 85 }, f.view);
    charger.values.minimumSoc = value(85, { source: 'session-request' });
    progress(basis === 'recorded-energy' ? creditKwh : 0); tests.update(f.view);
    const revised = tests.status().runs[0];
    assert.deepEqual(revised.headroom, run.headroom, 'preparation remains an unchanged historical estimate');
    assert.equal(revised.recommendation.state, 'available');
    assert.ok(revised.recommendation.estimatedFinishAt > suggested.estimatedFinishAt);
    tests.confirmSchedule({ ...action, startAt: revised.recommendation.startAt }, f.view);
    assert.equal(tests.status().runs[0].schedule.history.length, 2);
  }
});

test('remaining-energy recommendations conservatively reject mismatched, stale or missing production evidence', () => {
  for (const mismatch of ['capacity', 'target', 'connection', 'energy', 'missing']) {
    const f = fixture(), tests = f.create();
    tests.start(f.input({ program: 'vehicle-schedule', vehicleStartAt: START + 3 * HOUR }), f.view);
    const charger = f.plug(); f.identify(charger); tests.update(f.view);
    f.advance(6 * HOUR); f.plan(charger, START + 9 * HOUR);
    const remaining = 74 * 5 / 100 / CHARGING_EFFICIENCY;
    charger.requiredGridKwh = remaining;
    charger.progress = { connectionAt: charger.control.session.connectedAt, anchorAt: charger.control.session.connectedAt,
      estimatedSoc: 75, remainingGridKwh: remaining, basis: { source: 'recorded-charger-energy', status: 'tracking' } };
    if (mismatch === 'capacity') charger.values.capacityKwh.value = 57;
    if (mismatch === 'target') charger.values.minimumSoc.value = 90;
    if (mismatch === 'connection') charger.progress.connectionAt = START;
    if (mismatch === 'energy') charger.progress.remainingGridKwh = 1;
    if (mismatch === 'missing') { delete charger.progress; delete charger.requiredGridKwh; }
    tests.update(f.view);
    assert.equal(tests.status().runs[0].recommendation.state, 'unavailable', mismatch);
  }
});

test('applicable production required energy works without a progress object and modeled completion is never physical completion', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input({ program: 'vehicle-schedule', vehicleStartAt: START + 3 * HOUR }), f.view);
  const charger = f.plug(); f.identify(charger); tests.update(f.view);
  f.advance(6 * HOUR); f.identify(charger, 'bmw', 75); f.plan(charger, START + 9 * HOUR);
  charger.requiredGridKwh = 74 * 5 / 100 / CHARGING_EFFICIENCY;
  tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.state, 'available');
  charger.progress = { connectionAt: charger.control.session.connectedAt, anchorAt: f.clock(), estimatedSoc: 80,
    remainingGridKwh: 0, basis: { source: 'recorded-charger-energy', status: 'tracking' } };
  charger.requiredGridKwh = 0; tests.update(f.view);
  assert.equal(tests.status().runs[0].recommendation.readinessRisk, false);
  assert.match(tests.status().runs[0].recommendation.message, /estimates no charging remains/);
  assert.equal(tests.status().runs[0].milestones.completion, undefined);
  assert.throws(() => tests.confirmSchedule({ id: run.id, association: run.association,
    sessionId: charger.request.sessionId, startAt: START + 9 * HOUR + 15 * MINUTE }, f.view), /Wait for observed vehicle completion/);
});

test('test actions are fenced to current equipment and physical connection', () => {
  const f = fixture(), tests = f.create();
  const run = tests.start(f.input({ program: 'vehicle-schedule', vehicleStartAt: START + HOUR }), f.view), charger = f.plug();
  f.plan(); tests.update(f.view);
  const action = { id: run.id, association: run.association, sessionId: charger.request.sessionId, startAt: START + 3 * HOUR };
  assert.throws(() => tests.confirmSchedule({ ...action, sessionId: 'next-connection' }, f.view), /same charger/);
  assert.throws(() => tests.cancel({ id: run.id, association: 'changed' }, f.view), /changed/);
  charger.association = 'replacement'; tests.update(f.view);
  assert.equal(tests.status().runs[0].endReason, 'equipment-changed');
  assert.throws(() => tests.confirmSchedule(action, f.view), /changed/);
});

test('a future physical connection timestamp cannot attach prepared values to an assessment', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); charger.control.session.connectedAt = f.clock() + HOUR;
  tests.update(f.view);
  const run = tests.status().runs[0];
  assert.equal(run.sessionId, null);
  assert.equal(run.phase, 'interrupted');
  assert.equal(run.endReason, 'fresh-connection-not-observed');
});

test('unplug and an unseen cable swap conclude the old run without following another vehicle', () => {
  for (const swap of [false, true]) {
    const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
    const charger = f.plug(); tests.update(f.view);
    f.advance();
    if (swap) charger.request.sessionId = 'new-session'; else charger.values.connected = value(false);
    tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, swap ? 'interrupted' : 'finished');
    assert.equal(tests.status().runs[0].endReason, swap ? 'physical-session-changed' : 'unplugged-before-completion');
    f.plug(); tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, swap ? 'interrupted' : 'finished');
    assert.equal(tests.status().runs[0].milestones.completion, undefined);
  }
});

test('preparation intent expires after one day and never follows a later connection', () => {
  for (const connect of [false, true]) {
    const f = fixture(); let tests = f.create();
    const run = tests.start(f.input(), f.view);
    assert.equal(run.expiresAt, START + 24 * HOUR);
    tests = f.create(); f.advance(24 * HOUR + MINUTE);
    if (connect) f.plug();
    tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, 'finished');
    assert.equal(tests.status().runs[0].endReason, 'preparation-expired');
    assert.equal(tests.status().runs[0].sessionId, null);
  }
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  f.plug(); tests.update(f.view); f.advance(24 * HOUR); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing', 'expiry belongs to preparation, never an attached physical session');
});

test('an armed assessment observes a physical connection without modifying it during a control-authority change', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input({ nativeTargetSoc: 90 }), f.view);
  const charger = f.plug(); f.view.physicalTests = { canManage: false };
  const before = structuredClone(f.view); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.equal(tests.status().runs[0].sessionId, charger.request.sessionId);
  assert.deepEqual(f.view, before);
  assert.equal(charger.values.minimumSoc.value, 80);
  charger.values.connected = value(false); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'finished');
});

test('missing restart evidence preserves a run; fresh evidence after a gap reports the gap', () => {
  const f = fixture(); let tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); tests.update(f.view); tests = f.create();
  const control = charger.control; charger.control = { phase: 'unavailable' }; charger.request = null;
  f.advance(10 * MINUTE); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  charger.control = control; control.snapshot.readAt = f.clock();
  charger.request = { sessionId: tests.status().runs[0].sessionId, deadlineAt: START + 10 * HOUR };
  tests.update(f.view);
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'observation-gap'));
});

test('wrong identity never supplies completion evidence and inconclusive identification remains recorded after recovery', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); f.identify(charger, 'tesla', 100); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'wrong-vehicle-identified'));
  charger.identification.phase = 'inconclusive'; tests.update(f.view);
  f.advance(); charger.identification.phase = 'completed'; f.identify(); tests.update(f.view);
  assert.ok(tests.status().runs[0].milestones.identification);
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'identification-inconclusive'));
});

test('shared diagnostics link only to this connection and never substitute their planning outcome for native completion', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input({ nativeTargetSoc: 90 }), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 80); tests.update(f.view);
  const current = { id: 'other-session', behavior: 'expected', outcome: { state: 'target-confirmed' }, coverage: { completion: { state: 'verified' } } };
  f.view.diagnostics = { chargers: [{ id: charger.id, current, recent: [] }] };
  tests.update(f.view); assert.equal(tests.status().runs[0].report, null);
  current.id = chargingDiagnosticSessionId(charger); tests.update(f.view);
  assert.equal(tests.status().runs[0].report.id, current.id);
  assert.equal(tests.status().runs[0].phase, 'observing');
});

test('cancellation preserves reports and reminder without changing charger settings; retention is bounded', () => {
  const f = fixture(), tests = f.create(), before = structuredClone(f.view);
  for (let index = 0; index < 30; index++) {
    const run = tests.start(f.input({ program: 'vehicle-schedule', vehicleStartAt: START + HOUR }), f.view);
    tests.cancel({ id: run.id, association: run.association }, f.view);
  }
  assert.deepEqual(f.view, before); assert.equal(tests.status().runs.length, 24);
  assert.equal(tests.status().runs[0].phase, 'cancelled');
  assert.match(tests.status().runs[0].restorationReminder, /yourself/);
});

test('history pruning retains an older active test while the other charger completes many tests', () => {
  const f = fixture(), tests = f.create(), retained = tests.start(f.input(), f.view);
  for (let index = 0; index < 30; index++) {
    const run = tests.start(f.input({ vehicleId: 'tesla', chargerId: 'charger2', association: f.view.chargers[1].association }), f.view);
    tests.cancel({ id: run.id, association: run.association }, f.view);
  }
  assert.equal(tests.status().runs.length, 24);
  assert.equal(tests.status().runs.find(row => row.id === retained.id)?.phase, 'armed');
});

test('completion rejects an unhealthy feed, an old source timestamp and an unsupported automatic source', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 80);
  f.view.vehicleFeeds[0].reception.available = false; tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  f.view.vehicleFeeds[0].reception.available = true; f.advance(11 * MINUTE); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  charger.values.soc = value(100, { source: 'manual', measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
});

test('guided charging milestones need fresh current-session measured power, never charger status pulses', () => {
  for (const scenario of ['zero-power', 'missing-power', 'stale-power', 'retained-power', 'assumed-power', 'preconnection-power']) {
    const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
    const charger = f.plug(); charger.values.charging = value(true);
    charger.values.powerKw = value(7, { measuredAt: f.clock(), receivedAt: f.clock() });
    if (scenario === 'zero-power') charger.values.powerKw.value = 0;
    if (scenario === 'missing-power') charger.values.powerKw.available = false;
    if (scenario === 'stale-power') f.advance(3 * MINUTE);
    if (scenario === 'retained-power') charger.values.powerKw.retained = true;
    if (scenario === 'assumed-power') charger.values.powerKw.assumed = true;
    if (scenario === 'preconnection-power') charger.values.powerKw.measuredAt = START;
    tests.update(f.view);
    assert.equal(tests.status().runs[0].milestones.chargingStarted, undefined, scenario);
  }
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); charger.values.charging = value(false);
  charger.values.powerKw = value(.12, { measuredAt: f.clock(), receivedAt: f.clock() }); tests.update(f.view);
  assert.ok(tests.status().runs[0].milestones.chargingStarted, 'Even a small real measured pulse is observed');
});

test('guided native completion needs fresh near-zero power after measured charging and vehicle-target evidence', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 70);
  charger.values.powerKw = value(7, { measuredAt: f.clock(), receivedAt: f.clock() }); tests.update(f.view);
  f.advance(); f.identify(charger, 'bmw', 80);
  charger.values.powerKw = value(0, { measuredAt: START, receivedAt: f.clock() });
  charger.values.charging = value(false); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing', 'A stale zero cannot prove physical completion');
  charger.values.powerKw = value(.02, { measuredAt: f.clock(), receivedAt: f.clock() });
  charger.values.charging = value(true); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'completed', 'A lingering charger status cannot override measured near-zero draw and vehicle target evidence');
});

test('unsupported saved state and retired action fields fail before storage mutation', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const saved = structuredClone(f.saved.get('physical-tests'));
  for (const corrupt of [state => { state.version = 1; }, state => { state.version = 99; }, state => { state.legacy = true; }, state => { state.runs[0].command = 'start'; },
    state => { state.runs[0].expectations.manualSoc = 99; }, state => { state.runs[0].headroom.oldFixedPercent = 10; },
    state => { delete state.runs[0].expectations.capacityKwh; }, state => { state.runs[0].scheduleConfirmedAt = START; },
    state => { state.runs[0].schedule.startAt = START; }, state => { state.runs[0].target.history[0].targetSoc = 90; },
    state => { state.runs[0].expiresAt = START; }, state => { state.runs[0].target.planningSoc = 90; },
    state => { state.runs[0].target.revision = 0; },
    state => { state.runs.push(structuredClone(state.runs[0])); }]) {
    const next = structuredClone(saved); corrupt(next); f.saved.set('physical-tests', next); const writes = f.writes.length;
    assert.throws(() => f.create(), /Unsupported physical charging test state/); assert.equal(f.writes.length, writes);
  }
  f.saved.set('physical-tests', saved);
  assert.throws(() => f.create().start(f.input({ setManualSoc: true }), f.view));
  assert.throws(() => f.create().preview(f.input({ vehicleStartAt: START + HOUR }), f.view));
});

test('a failed durable write rolls back the in-memory test action', () => {
  const f = fixture(), tests = f.create();
  f.store.setState = () => { throw new Error('disk unavailable'); };
  assert.throws(() => tests.start(f.input(), f.view), /disk unavailable/);
  assert.equal(tests.status().runs.length, 0);
});
