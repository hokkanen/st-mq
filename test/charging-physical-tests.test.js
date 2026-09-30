import test from 'node:test';
import assert from 'node:assert/strict';
import { ChargingPhysicalTests } from '../src/charging/physical-tests.js';
import { chargingDiagnosticSessionId } from '../src/charging/session-diagnostics.js';
import { easeeChargerTelemetry } from '../src/charging/easee.js';
import { buildCharger, CHARGER_DEFINITIONS } from '../src/charging/model.js';

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
    soc: 40, nativeTargetSoc: 80, prepared: true, ...extra });
  const advance = (duration = MINUTE) => {
    now += duration;
    for (const charger of view.chargers) if (charger.control.snapshot) charger.control.snapshot.readAt = now;
    return now;
  };
  const plug = (charger = view.chargers[0]) => {
    advance(); charger.values.connected = value(true);
    charger.values.powerKw = value(0, { measuredAt: now, receivedAt: now });
    charger.control.session = { connected: true, connectedAt: now };
    charger.request = { sessionId: `synthetic-session-${now}`, deadlineAt: now + 10 * HOUR };
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

test('arming records private expectations without changing production inputs, telemetry or plans', () => {
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
  assert.ok(tests.status().runs[0].milestones.planningMinimum);
  assert.equal(tests.status().runs[0].milestones.completion, undefined);
  charger.progress = { estimatedSoc: 100 }; tests.update(f.view);
  charger.values.soc = value(100, { source: 'manual-fallback', assumed: true, measuredAt: f.clock() }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  charger.values.soc = value(100, { source: 'bmw-cardata', measuredAt: START - HOUR }); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing', 'old preconnection battery reading is not completion');
});

test('attaining an earlier lower minimum does not confirm a later higher minimum by ready-by', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input({ nativeTargetSoc: 100 }), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 80); tests.update(f.view);
  assert.equal(tests.status().runs[0].milestones.planningMinimum.targetSoc, 80);
  charger.values.minimumSoc = value(90, { source: 'session-request' });
  f.advance(10 * HOUR); tests.update(f.view);
  assert.equal(tests.status().runs[0].milestones.deadline.state, 'not-confirmed-by-deadline');
});

test('a higher actual vehicle limit prevents completion at the declared or planning minimum', () => {
  const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
  const charger = f.plug(); f.identify(charger, 'bmw', 80);
  charger.values.vehicleCeilingSoc = value(90, { source: 'bmw-cardata' });
  tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'observing');
  assert.ok(tests.status().runs[0].findings.some(row => row.code === 'vehicle-limit-differs-from-preparation'));
  charger.values.charging = value(true); charger.values.powerKw = value(10, { measuredAt: f.clock(), receivedAt: f.clock() }); tests.update(f.view);
  charger.values.charging = value(false); charger.values.powerKw = value(0, { measuredAt: f.clock(), receivedAt: f.clock() });
  f.advance(); f.identify(charger, 'bmw', 90); tests.update(f.view);
  assert.equal(tests.status().runs[0].phase, 'completed');
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
  assert.equal(tests.status().runs[0].expectations.vehicleStartAt, suggested);
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

test('unplug and an unseen cable swap conclude the old run without following another vehicle', () => {
  for (const swap of [false, true]) {
    const f = fixture(), tests = f.create(); tests.start(f.input(), f.view);
    const charger = f.plug(); tests.update(f.view);
    f.advance();
    if (swap) charger.request.sessionId = 'new-session'; else charger.values.connected = value(false);
    tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, 'interrupted');
    assert.equal(tests.status().runs[0].endReason, swap ? 'physical-session-changed' : 'unplugged-before-completion');
    f.plug(); tests.update(f.view);
    assert.equal(tests.status().runs[0].phase, 'interrupted');
  }
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
  for (const corrupt of [state => { state.version = 99; }, state => { state.legacy = true; }, state => { state.runs[0].command = 'start'; },
    state => { state.runs[0].expectations.manualSoc = 99; }, state => { state.runs[0].headroom.oldFixedPercent = 10; },
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
