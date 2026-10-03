import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage/store.js';
import { ChargingPhysicalTests } from '../src/charging/physical-tests.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { sharedChargingAssessment, validSharedAssessment } from '../src/charging/shared-assessment.js';
import { chargingSharedText } from '../chart/charging-shared.js';
import { planChargers } from '../src/charging/planner.js';

const START = Date.parse('2026-10-02T18:00:00Z'), MINUTE = 60_000, HOUR = 60 * MINUTE;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  let now = START;
  const reading = (value, source = 'easee') => ({ value, available: true, source, measuredAt: now, receivedAt: now });
  const view = { vehicleFeeds: ['bmw', 'tesla'].map(id => ({ id, setup: { available: true } })),
    chargers: ['charger1', 'charger2'].map((id, index) => ({ id, label: id, association: `synthetic-${id}`,
      provider: index ? 'shelly-evse' : 'easee', controls: { enabled: true }, settings: { enabled: true },
      capabilities: { scheduling: true, currentControl: index === 1, externalLoadBalancing: index === 0 },
      control: { phase: 'active', snapshot: { online: true, readAt: now, controlReady: true, transport: index ? 'shelly-evse' : 'easee' }, session: { connected: false } },
      forecast: { powerKw: 11.04, voltageV: 230 }, telemetry: { providerConnected: true }, request: null,
      vehicle: { state: 'disconnected' }, values: { connected: reading(false), soc: reading(40), minimumSoc: reading(80),
        capacityKwh: reading(74), vehicleCeilingSoc: reading(80), powerKw: reading(0), charging: reading(false),
        currentA: reading(16), maximumCurrentA: reading(16), voltageV: reading(230) } })) };
  const createGuide = () => new ChargingPhysicalTests({ store, clock: () => now });
  const createDiagnostics = () => new ChargingSessionDiagnostics({ store, clock: () => now });
  const input = (index, program = 'immediate') => ({ chargerId: view.chargers[index].id, association: view.chargers[index].association,
    vehicleId: index ? 'tesla' : 'bmw', program, soc: 40, nativeTargetSoc: 80, capacityKwh: 74, prepared: true,
    ...(program === 'vehicle-schedule' ? { vehicleStartAt: now + HOUR } : {}) });
  const advance = () => { now += MINUTE; for (const charger of view.chargers) {
    charger.control.snapshot.readAt = now;
    for (const field of Object.values(charger.values)) if (field.available) Object.assign(field, { measuredAt: now, receivedAt: now });
  } };
  const plug = () => { advance(); for (const [index, charger] of view.chargers.entries()) {
    charger.values.connected = reading(true); charger.values.powerKw = reading(4.14); charger.values.charging = reading(true);
    charger.control.session = { connected: true, connectedAt: now };
    charger.request = { sessionId: `synthetic-session-${index}`, revision: 1, deadlineAt: now + HOUR };
    charger.deadlineAt = charger.request.deadlineAt; charger.requiredGridKwh = 2.5;
    charger.vehicle = { state: 'identified', id: index ? 'tesla' : 'bmw', sessionId: charger.request.sessionId };
    charger.values.soc = reading(76.875, index ? 'teslamate' : 'bmw-cardata');
    charger.values.vehicleCeilingSoc = reading(80, index ? 'teslamate' : 'bmw-cardata');
    charger.plan = { state: 'release', feasible: true, periods: [{ startAt: now, endAt: null }],
      deadlineAt: charger.deadlineAt, allocations: [{ start: now, end: now + HOUR, powerKw: 4.14 }] };
  } };
  const coordinate = (priority = 'balanced') => {
    const context = { at: now, priority, feasible: true,
      sessions: Object.fromEntries(view.chargers.map(charger => [charger.id, charger.request?.sessionId ?? null])),
      requests: Object.fromEntries(view.chargers.map(charger => [charger.id, { sessionId: charger.request?.sessionId,
        revision: charger.request?.revision, automatic: charger.settings.enabled }])),
      solver: { cashCostLowerBoundCents: 45, cashCostGapBoundCents: 5, globalOptimalityProven: false },
      plans: Object.fromEntries(view.chargers.map(charger => [charger.id, { feasible: true, costCents: 25 }])),
      allocations: [{ start: now, end: now + HOUR, phaseHeadroomA: [16, 16, 16],
        chargers: { charger1: { powerKw: 4.14, currentA: 6 }, charger2: { powerKw: 4.14, currentA: 6, currentLimitA: 6 } } }] };
    view.coordination = { at: now, priority, sessions: context.sessions, requests: context.requests, allocations: context.allocations,
      proposed: structuredClone(context), adopted: structuredClone(context) };
  };
  return { store, view, reading, input, advance, plug, coordinate, createGuide, createDiagnostics, now: () => now };
}

for (const selected of [[0], [1], [0, 1]]) for (const priority of ['balanced', 'charger1', 'charger2']) for (const program of ['immediate', 'vehicle-schedule']) {
  test(`${selected.map(index => index ? 'Tesla/C2' : 'BMW/C1').join(' + ')} ${program} observes its peer and selected ${priority} without changing production`, t => {
    const f = fixture(t); let guide = f.createGuide(), diagnostics = f.createDiagnostics();
    for (const index of selected) guide.start(f.input(index, program), f.view);
    f.plug(); f.coordinate(priority);
    const before = structuredClone(f.view);
    guide.update(f.view); diagnostics.observe(f.view.chargers, f.now(), f.view.coordination);
    assert.deepEqual(f.view, before);
    for (const run of guide.status().runs) {
      assert.equal(run.shared.current.selectedPriority, priority);
      assert.equal(run.shared.coverage.overlap, 'observed');
      assert.equal(run.shared.coverage.priority, 'modeled');
      assert.equal(run.shared.coverage.jointSchedule, 'modeled');
      assert.equal(run.shared.current.adopted.costCents, 50);
      assert.equal(run.shared.current.proposed.costGapBoundCents, 5);
      assert.equal(run.shared.current.adopted.chargers.length, 2);
      assert.equal(run.vehicleId, run.chargerId === 'charger1' ? 'bmw' : 'tesla');
      assert.ok(run.milestones.identification);
      if (program === 'vehicle-schedule') {
        assert.equal(run.recommendation.state, 'available');
        guide.confirmSchedule({ id: run.id, association: run.association, sessionId: run.sessionId,
          startAt: run.recommendation.startAt }, f.view);
      }
    }
    f.advance(); f.coordinate(priority === 'charger2' ? 'charger1' : 'charger2');
    guide.update(f.view); diagnostics.observe(f.view.chargers, f.now(), f.view.coordination);
    guide = f.createGuide(); diagnostics = f.createDiagnostics();
    assert.ok(guide.status().runs.every(run => run.shared.priorityChanges === 1));
    for (const slot of diagnostics.status().chargers) {
      assert.equal(slot.current.shared.priorityChanges, 1);
      const events = diagnostics.reportEvents({ chargerId: slot.id, reportId: slot.current.id, filter: 'plans' }).events;
      assert.equal(events.filter(row => row.kind === 'shared').length, 2);
    }
    // Completion is local to the selected physical session. Finish and unplug
    // the first selected vehicle while its peer continues drawing.
    const first = selected[0], charger = f.view.chargers[first];
    f.advance(); charger.values.soc = f.reading(80, first ? 'teslamate' : 'bmw-cardata');
    charger.values.powerKw = f.reading(0); guide.update(f.view);
    assert.equal(guide.status().runs.find(run => run.chargerId === charger.id).phase, 'completed');
    if (selected.length === 2) assert.notEqual(guide.status().runs.find(run => run.chargerId !== charger.id).phase, 'completed');
    charger.values.connected = f.reading(false); guide.update(f.view);
    guide = f.createGuide();
    assert.equal(guide.status().runs.find(run => run.chargerId === charger.id).phase, 'completed');
  });
}

test('peer cable replacement changes shared context without moving the focused guide to that session', t => {
  const f = fixture(t), guide = f.createGuide(); guide.start(f.input(0), f.view); f.plug(); f.coordinate(); guide.update(f.view);
  const focusedSession = guide.status().runs[0].sessionId;
  f.advance(); f.view.chargers[1].request.sessionId = 'replacement-peer'; f.view.chargers[1].control.session.connectedAt = f.now();
  guide.update(f.view);
  const run = guide.status().runs[0];
  assert.equal(run.sessionId, focusedSession); assert.equal(run.phase, 'observing');
  assert.equal(run.shared.current.adopted.state, 'unknown', 'Old allocation cannot describe a new peer connection');
  assert.notEqual(run.shared.history[0].peers[1].session, run.shared.current.peers[1].session);
});

test('natural priority propagation settles without false findings and sustained mismatch survives restart', t => {
  const f = fixture(t); let guide = f.createGuide(), diagnostics = f.createDiagnostics();
  guide.start(f.input(0), f.view); f.plug(); f.coordinate('balanced');
  const observe = () => {
    const before = structuredClone(f.view);
    guide.update(f.view); diagnostics.observe(f.view.chargers, f.now(), f.view.coordination);
    assert.deepEqual(f.view, before, 'Assessments never apply the selected priority or replace either joint context');
    return guide.status().runs[0].shared;
  };
  assert.equal(observe().current.priority, 'consistent');
  // A saved dashboard choice is visible before asynchronous planning catches up.
  f.view.coordination.priority = 'charger2';
  let shared = observe();
  assert.equal(shared.current.selectedPriority, 'charger2');
  assert.equal(shared.current.proposed.priority, 'balanced');
  assert.equal(shared.current.adopted.priority, 'balanced');
  assert.equal(shared.current.priority, 'settling');
  f.view.coordination.proposed.priority = 'charger2';
  assert.equal(observe().current.priority, 'settling', 'Updating only the proposal leaves adopted allocation settling');
  f.view.coordination.adopted.priority = 'charger2';
  shared = observe();
  assert.equal(shared.current.priority, 'consistent');
  assert.equal(shared.priorityChanges, 1, 'Context catch-up does not invent further user priority changes');
  assert.equal(guide.status().runs[0].findings.some(row => row.code === 'shared-priority-mismatch'), false);
  assert.equal(diagnostics.status().chargers[0].current.findings.some(row => row.code === 'shared-priority-mismatch'), false);
  assert.ok(shared.history.some(row => row.priority === 'settling'), 'The normal propagation interval remains recorded evidence');

  f.view.coordination.priority = 'balanced';
  assert.equal(observe().current.priority, 'settling');
  const since = guide.status().runs[0].shared.current.prioritySince;
  f.advance(); assert.equal(observe().current.priority, 'settling');
  const allocations = f.view.coordination.adopted.allocations;
  delete f.view.coordination.adopted.allocations;
  assert.equal(observe().current.priority, 'unknown');
  assert.equal(guide.status().runs[0].shared.current.prioritySince, since, 'Missing evidence does not restart an existing propagation clock');
  f.view.coordination.adopted.allocations = allocations;
  guide = f.createGuide(); diagnostics = f.createDiagnostics();
  assert.equal(guide.status().runs[0].shared.current.prioritySince, since);
  f.advance(); assert.equal(observe().current.priority, 'inconsistent');
  assert.equal(guide.status().runs[0].findings.some(row => row.code === 'shared-priority-mismatch'), true);
  const active = diagnostics.status().chargers[0].current.findings.find(row => row.code === 'shared-priority-mismatch');
  assert.ok(active); assert.equal(active.resolvedAt, null);
  delete f.view.coordination.adopted.allocations;
  assert.equal(observe().current.priority, 'unknown');
  assert.equal(diagnostics.status().chargers[0].current.findings.find(row => row.code === 'shared-priority-mismatch').resolvedAt, null,
    'Missing joint evidence cannot manufacture recovery from a sustained mismatch');
  f.view.coordination.adopted.allocations = allocations;
  f.view.coordination.proposed.priority = 'balanced'; f.view.coordination.adopted.priority = 'balanced';
  assert.equal(observe().current.priority, 'consistent');
  const finding = diagnostics.status().chargers[0].current.findings.find(row => row.code === 'shared-priority-mismatch');
  assert.ok(finding); assert.equal(finding.resolvedAt, f.now());
});

test('shared persistence is bounded and rejects unsupported, malformed or oversized state before mutation', t => {
  const f = fixture(t), guide = f.createGuide(); guide.start(f.input(0), f.view); f.plug(); f.coordinate(); guide.update(f.view);
  for (let index = 0; index < 40; index++) { f.advance(); f.coordinate(index % 2 ? 'charger1' : 'charger2'); guide.update(f.view); }
  const saved = f.store.getState('charging:physical-tests'), shared = saved.runs[0].shared;
  assert.equal(shared.history.length, 32); assert.equal(validSharedAssessment(shared), true);
  for (const mutate of [
    value => { value.current.overlap = 'passed'; },
    value => { value.current.peers[0].session = 'private-raw-session'; },
    value => { value.current.peers[0].extra = 'unsupported'; },
    value => { value.current.adopted.chargers = Array(3).fill(value.current.adopted.chargers[0]); },
    value => { value.current.execution.expectationAt = -1; },
    value => { value.history.push(value.current); },
  ]) {
    const invalid = structuredClone(saved); mutate(invalid.runs[0].shared); f.store.setState('charging:physical-tests', invalid);
    assert.throws(() => f.createGuide(), /Unsupported physical charging test state/);
    assert.deepEqual(f.store.getState('charging:physical-tests'), invalid);
  }
  const absent = structuredClone(saved); delete absent.runs[0].shared;
  f.store.setState('charging:physical-tests', absent);
  const unchanged = f.store.getState('charging:physical-tests');
  const resumed = f.createGuide();
  assert.equal(resumed.status().runs[0].shared, undefined, 'Absent new evidence is unknown, not reconstructed history');
  assert.deepEqual(f.store.getState('charging:physical-tests'), unchanged, 'Reading does not backfill optional evidence');
  resumed.update(f.view); assert.equal(resumed.status().runs[0].shared.priorityChanges, 0);
  f.store.setState('charging:physical-tests', { ...saved, version: 0 });
  assert.throws(() => f.createGuide(), /Unsupported physical charging test state/);
});

test('missing peer or joint evidence cannot verify priority, overlap or joint feasibility', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  for (const mutate of [
    () => { f.view.chargers[1].control.snapshot.readAt = START - HOUR; },
    () => { f.view.coordination.adopted.at = START - HOUR; },
    () => { delete f.view.coordination.adopted.allocations; },
    () => { f.view.chargers[1].request.revision++; },
    () => { f.view.chargers[1].settings.enabled = false; },
  ]) {
    const before = structuredClone(f.view); mutate();
    const result = sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now());
    assert.equal(result.priority, 'unknown'); assert.equal(result.adopted.state, 'unknown');
    Object.assign(f.view, before);
  }
  f.view.chargers[1].values.powerKw.retained = true;
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).overlap, 'unknown');
});

test('configured ceilings validate assumption-based joint forecasts without creating current readback evidence', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  const charger = f.view.chargers[1];
  charger.configuration = { maximumCurrentA: 16 };
  charger.capabilities.currentControl = false;
  charger.control.snapshot.controlReady = false;
  charger.values.maximumCurrentA = { value: null, available: false };
  charger.values.currentA = { value: null, available: false };
  for (const context of [f.view.coordination, f.view.coordination.proposed, f.view.coordination.adopted])
    delete context.allocations[0].chargers.charger2.currentLimitA;
  const before = structuredClone(f.view);
  const assessment = sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now());
  assert.equal(assessment.proposed.state, 'feasible');
  assert.equal(assessment.adopted.state, 'feasible');
  assert.equal(assessment.execution.state, 'unknown');
  assert.equal(assessment.execution.reportedCurrentA, null);
  assert.deepEqual(f.view, before, 'Model validation cannot manufacture a measurement or control capability');
});

test('joint model validation keeps known tighter limits and cannot invent an unconfigured ceiling', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  const charger = f.view.chargers[1];
  charger.configuration = { maximumCurrentA: 16 };
  charger.capabilities.currentControl = false;
  charger.values.maximumCurrentA = { value: null, available: false };
  charger.values.currentA = { value: null, available: false };
  for (const context of [f.view.coordination, f.view.coordination.proposed, f.view.coordination.adopted]) {
    Object.assign(context.allocations[0].chargers.charger2, { currentA: 8, powerKw: 5.52 });
    delete context.allocations[0].chargers.charger2.currentLimitA;
  }
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).proposed.state, 'feasible');
  const baseline = structuredClone(charger);
  for (const [name, restrict] of [
    ['reported ceiling', current => { current.values.maximumCurrentA = f.reading(6); }],
    ['configured ceiling', current => { current.values.maximumCurrentA = f.reading(16); current.configuration.maximumCurrentA = 6; }],
    ['native user limit', current => { current.values.nativeCurrentA = f.reading(6); }],
    ['vehicle limit', current => { current.values.vehicleCurrentA = f.reading(6); }],
    ['known basic current', current => { current.values.currentA = f.reading(6); }],
    ['no ceiling', current => { delete current.configuration.maximumCurrentA; }],
    ['invalid configured ceiling', current => { current.configuration.maximumCurrentA = -1; }],
  ]) {
    Object.assign(charger, structuredClone(baseline)); restrict(charger);
    const assessment = sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now());
    assert.equal(assessment.proposed.state, 'inconsistent', name);
    assert.equal(assessment.adopted.state, 'inconsistent', name);
  }
});

test('an existing current-format passive report lacks new shared evidence until observed, without read-time writes', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  let diagnostics = f.createDiagnostics(); diagnostics.observe(f.view.chargers, f.now(), f.view.coordination);
  const stored = f.store.db.prepare('SELECT namespace,charger_id,report_id,checkpoint FROM charging_reports WHERE charger_id=?').get('charger1');
  const record = JSON.parse(stored.checkpoint); delete record.shared;
  const text = JSON.stringify(record);
  const save = checkpoint => f.store.db.prepare('UPDATE charging_reports SET checkpoint=? WHERE namespace=? AND charger_id=? AND report_id=?')
    .run(checkpoint, stored.namespace, stored.charger_id, stored.report_id);
  const read = () => f.store.db.prepare('SELECT checkpoint FROM charging_reports WHERE namespace=? AND charger_id=? AND report_id=?')
    .get(stored.namespace, stored.charger_id, stored.report_id).checkpoint;
  save(text); diagnostics = f.createDiagnostics();
  assert.equal(diagnostics.status().chargers[0].current.shared, undefined); assert.equal(read(), text);
  save(JSON.stringify({ ...record, shared: { current: {} } }));
  const invalid = read(); assert.throws(() => f.createDiagnostics(), /Unsupported charging diagnostics/); assert.equal(read(), invalid);
  save(text); diagnostics = f.createDiagnostics(); f.advance(); f.coordinate();
  diagnostics.observe(f.view.chargers, f.now(), f.view.coordination);
  assert.equal(diagnostics.status().chargers[0].current.shared.current.at, f.now());
  assert.equal(diagnostics.status().chargers[0].current.shared.priorityChanges, 0);
});

test('independent shared checks reject over-allocation and expose a reported feasible plan with insufficient energy', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  f.view.coordination.adopted.allocations[0].phaseHeadroomA = [10, 10, 10];
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'inconsistent');
  f.coordinate(); f.view.coordination.adopted.allocations[0].end = f.now() + MINUTE;
  const result = sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now());
  assert.equal(result.adopted.state, 'shortfall');
  assert.equal(result.adopted.chargers[0].reportedFeasible, true);
  assert.equal(result.adopted.chargers[0].sufficient, false);
  f.view.coordination.adopted.priority = 'charger1';
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).priority, 'inconsistent');
  f.coordinate(); f.view.coordination.proposed.solver.cashCostLowerBoundCents = 55;
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).proposed.state, 'inconsistent');
});

test('fresh C2 readback detects a settled allocation violation independently of matching priority metadata', t => {
  const f = fixture(t), guide = f.createGuide(); guide.start(f.input(0), f.view); f.plug(); f.coordinate('charger1');
  f.view.chargers[1].values.currentA = f.reading(16, 'shelly-evse');
  guide.update(f.view);
  assert.equal(guide.status().runs[0].shared.current.execution.state, 'settling');
  f.advance(); f.advance(); f.coordinate('charger1'); guide.update(f.view);
  assert.equal(guide.status().runs[0].shared.current.priority, 'consistent');
  assert.equal(guide.status().runs[0].shared.current.execution.state, 'inconsistent');
  f.view.chargers[1].values.currentA = f.reading(6, 'shelly-evse'); guide.update(f.view);
  assert.equal(guide.status().runs[0].shared.current.execution.state, 'consistent');
  f.view.chargers[1].values.currentA.retained = true; guide.update(f.view);
  assert.equal(guide.status().runs[0].shared.current.execution.state, 'unknown');
  f.view.chargers[1].values.currentA.retained = false;
  f.view.coordination.sessions.charger2 = 'superseded-session'; guide.update(f.view);
  assert.equal(guide.status().runs[0].shared.current.execution.state, 'unknown');
});

test('averaged scenario current below six amps remains valid while executable subminimum limits do not', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  const allocated = f.view.coordination.adopted.allocations[0].chargers;
  allocated.charger1.currentA = 3; allocated.charger2.currentA = 3;
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'feasible');
  allocated.charger2.currentLimitA = 3;
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'inconsistent');
  allocated.charger2.currentLimitA = 6;
  f.view.chargers[1].values.vehicleCurrentA = f.reading(5);
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'inconsistent');
});

test('fresh metered charging supersedes a held vehicle start only while independently observed', t => {
  const f = fixture(t); f.plug(); f.coordinate();
  f.view.chargers[1].values.vehicleNotBefore = f.reading(f.now() + HOUR, 'teslamate');
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'feasible');
  f.view.chargers[1].values.powerKw = f.reading(0, 'shelly-evse');
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'inconsistent');
  f.view.chargers[1].values.charging = f.reading(true, 'shelly-evse');
  assert.equal(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()).adopted.state, 'inconsistent', 'Status alone cannot withdraw a known timer');
});

test('delayed BMW and Tesla guides integrate exact alternating allocations, never hourly peak power', t => {
  for (const index of [0, 1]) {
    const f = fixture(t), guide = f.createGuide();
    const run = guide.start(f.input(index, 'vehicle-schedule'), f.view);
    f.plug();
    const now = f.now(), result = planChargers({ now, chargers: f.view.chargers,
      prices: [{ start: now, end: now + HOUR, priceCtPerKwh: 10 }],
      supply: { configuredBudgetCurrentA: [8, 8, 8] },
      fixedPeriods: { charger1: [{ startAt: now, endAt: null }], charger2: [{ startAt: now, endAt: null }] } });
    assert.equal(result.feasible, true);
    for (const charger of f.view.chargers) { charger.plan = result.plans[charger.id]; charger.forecast = result.forecasts[charger.id]; }
    guide.update(f.view);
    const selected = f.view.chargers[index], current = guide.status().runs[0];
    if (current.recommendation.state === 'available') {
      const available = result.allocations.reduce((sum, row) => sum + Math.max(0, Math.min(row.end, selected.deadlineAt)
        - Math.max(row.start, current.recommendation.startAt)) / HOUR * (row.chargers[selected.id]?.powerKw ?? 0), 0);
      assert.ok(available >= 2.5 - 1e-6, 'A recommended timer must retain the required exact allocated energy');
    } else assert.equal(current.recommendation.readinessRisk, true);
    // C1 loses its first allocation if it waits; no later slice replaces it.
    if (index === 0) {
      assert.equal(current.recommendation.state, 'unavailable');
      assert.throws(() => guide.confirmSchedule({ id: run.id, association: run.association,
        sessionId: current.sessionId, startAt: now + 20 * MINUTE }, f.view), /real charging plan/);
    }
    delete selected.plan.allocations;
    guide.update(f.view);
    assert.equal(guide.status().runs[0].recommendation.state, 'unavailable', 'Missing allocation evidence cannot use maximum interval power');
  }
});

test('shared presentation distinguishes measured overlap, modeled priority and reported joint cost bounds', t => {
  const f = fixture(t); f.plug(); f.coordinate('charger2');
  const text = chargingSharedText(sharedChargingAssessment(f.view.chargers, f.view.coordination, f.now()), 'charger1');
  assert.match(text, /Shared priority: Charger 2/); assert.match(text, /Charger 2 draw/);
  assert.match(text, /combined cost 50 cents/); assert.match(text, /Planner-reported cost lower bound 45 cents/);
  assert.match(text, /reported limits and configured ceilings/);
  assert.match(text, /maximum available within shared property capacity as a delivery estimate/);
  assert.match(text, /do not confirm charger readiness, physical delivery or global optimality/);
});
