import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticStore, diagnosticRows, readCompleteReport } from './support/charging-report-fixture.js';
import { ChargingSessionDiagnostics, chargingDiagnosticSessionId } from '../src/charging/session-diagnostics.js';
import { chargingReportSummary } from '../chart/charging-diagnostics.js';

const MINUTE = 60_000, now = Date.parse('2026-09-28T18:00:00Z');
const reading = (value, source = 'easee', at = now) => ({ value, source, available: true, measuredAt: at, receivedAt: at });
function charger() {
  return { id: 'charger1', association: 'synthetic-private-equipment', provider: 'easee',
    request: { sessionId: 'synthetic-private-session', revision: 1 }, settings: { enabled: true },
    control: { phase: 'released', released: true, session: { connectedAt: now, connected: true }, snapshot: { online: true, readAt: now } },
    values: { connected: reading(true), charging: reading(true), powerKw: reading(10.8),
      soc: reading(50, 'teslamate'), minimumSoc: reading(80, 'teslamate'), vehicleCeilingSoc: reading(90, 'teslamate'),
      capacityKwh: { ...reading(57, 'manual-fallback'), assumed: true }, availableCurrentA: reading(16) },
    telemetry: { providerConnected: true }, vehicle: { id: 'tesla', state: 'identified' },
    identification: { phase: 'completed', active: false }, deadlineAt: now + 8 * 60 * MINUTE,
    plan: { periods: [{ startAt: now, endAt: null }], finalStartAt: now, feasible: true },
    progress: { remainingGridKwh: 18, deliveredGridKwh: 0, connectionAt: now,
      basis: { energyCoverageIncomplete: false, lastMeasuredAt: now } } };
}
function refresh(view, at) {
  view.control.snapshot.readAt = at;
  for (const key of ['connected', 'charging', 'powerKw', 'availableCurrentA']) Object.assign(view.values[key], { measuredAt: at, receivedAt: at });
  return view;
}
function fixture() {
  const store = diagnosticStore(), data = { values: () => diagnosticRows(store) };
  const observer = new ChargingSessionDiagnostics({ store, clock: () => now });
  return { store, observer, data,
    observe: (view, at = now) => readCompleteReport(observer, observer.observe([view], at).chargers[0].current) };
}

test('draw following a degraded price-plan release does not certify scheduling as expected', () => {
  const { observe } = fixture(), view = charger();
  Object.assign(view.plan, { state: 'release', reason: 'electrical-telemetry-unavailable', feasible: false, provisional: true });
  const report = observe(view);
  assert.equal(report.coverage.initialRelease.state, 'verified', 'physical response remains independently observed');
  assert.equal(report.planning.state, 'degraded');
  assert.equal(report.behavior, 'explained');
  const summary = chargingReportSummary(report);
  assert.equal(summary.label, 'Scheduling limited');
  assert.notEqual(summary.state, 'good');
  assert.match(summary.behavior, /Observed draw checks do not establish/);
  Object.assign(view.plan, { reason: 'cheapest-feasible-start', feasible: true, provisional: false });
  assert.equal(observe(refresh(view, now + MINUTE), now + MINUTE).planning.state, 'available');
});

test('observes independently of controls, persists bounded normalized evidence and never stores raw identity', () => {
  const { observe, data } = fixture(), view = charger();
  view.values.soc.vin = 'private-vin'; view.control.snapshot.credentials = 'private-secret';
  view.settings.enabled = false; view.control.phase = 'off';
  const report = observe(view);
  assert.equal(report.coverage.identification.state, 'verified');
  assert.equal(report.coverage.initialRelease.state, 'not-exercised');
  assert.equal(report.current.expectation, 'observe');
  assert.equal(report.outcome.state, 'in-progress');
  assert.equal(report.id, chargingDiagnosticSessionId(view));
  const serialized = JSON.stringify([...data.values()]);
  for (const privateValue of ['private-vin', 'private-secret', 'synthetic-private-equipment', 'synthetic-private-session']) assert(!serialized.includes(privateValue));
});

test('a proposed plan or command acceptance does not prove release, pause or completion', () => {
  const { observe } = fixture(), view = charger();
  view.control.phase = 'unconfirmed'; view.control.pending = { acknowledged: true }; view.control.released = false;
  view.values.charging.value = false; view.values.powerKw.value = 0;
  view.plan = { periods: [{ startAt: now + 60 * MINUTE, endAt: null }], finalStartAt: now + 60 * MINUTE };
  const report = observe(view);
  for (const key of ['initialRelease', 'pause', 'resume', 'targetAttainment', 'completion']) assert.equal(report.coverage[key].state, 'not-exercised');
  assert.equal(report.current.pauseConfirmed, false);
  assert.equal(report.plans.length, 1);
});

test('records executed intermediate pause and resume while leaving one-period coverage unexercised', () => {
  const { observe } = fixture(), view = charger();
  let report = observe(view);
  assert.equal(report.coverage.initialRelease.state, 'verified');
  assert.equal(report.coverage.pause.state, 'not-exercised');
  view.control.released = false; view.control.phase = 'paused';
  view.control.execution = { periods: [{ startAt: now, endAt: now + 2 * MINUTE }, { startAt: now + 10 * MINUTE, endAt: null }], finalStartAt: now + 10 * MINUTE };
  view.values.charging.value = false; view.values.powerKw.value = 0;
  report = observe(refresh(view, now + 3 * MINUTE), now + 3 * MINUTE);
  assert.equal(report.coverage.pause.state, 'verified');
  assert.equal(report.coverage.resume.state, 'not-exercised');
  view.control.phase = 'released'; view.control.released = true; view.values.charging.value = true; view.values.powerKw.value = 10.8;
  report = observe(refresh(view, now + 10 * MINUTE), now + 10 * MINUTE);
  assert.equal(report.coverage.resume.state, 'verified');
  assert(report.timeline.some(row => row.code === 'observation-gap'));
});

test('delayed physical pause flags after settling, retains recovery and original plan after replanning', () => {
  const { observe } = fixture(), view = charger();
  view.control.released = false; view.control.phase = 'pause-unconfirmed';
  view.plan = { periods: [{ startAt: now + 60 * MINUTE, endAt: null }], finalStartAt: now + 60 * MINUTE };
  observe(view);
  assert.equal(observe(refresh(view, now + 2 * MINUTE), now + 2 * MINUTE).attentionCount, 0);
  let report = observe(refresh(view, now + 4 * MINUTE), now + 4 * MINUTE);
  assert(report.findings.some(row => row.code === 'charging-during-hold' && row.resolvedAt === null));
  view.control.released = true; view.control.phase = 'released'; view.plan = { periods: [{ startAt: now + 5 * MINUTE, endAt: null }], finalStartAt: now + 5 * MINUTE };
  report = observe(refresh(view, now + 5 * MINUTE), now + 5 * MINUTE);
  assert(report.findings.some(row => row.code === 'charging-during-hold' && row.resolvedAt === now + 5 * MINUTE));
  assert.equal(report.plans[0].periods[0].startAt, now + 60 * MINUTE);
  assert.equal(report.recoveredCount, 2);
  assert.equal(report.behavior, 'explained');
});

test('stale, future, manual and preconnection SoC cannot confirm target or native completion', () => {
  for (const scenario of ['stale-physical', 'future-soc', 'manual-soc', 'preconnection-soc', 'unavailable-soc']) {
    const { observe } = fixture(), view = charger();
    view.values.charging.value = false; view.values.powerKw.value = 0; view.values.soc.value = 95;
    if (scenario === 'stale-physical') view.control.snapshot.readAt = now - 3 * MINUTE;
    if (scenario === 'future-soc') view.values.soc.measuredAt = now + MINUTE;
    if (scenario === 'manual-soc') view.values.soc.source = 'session-anchor';
    if (scenario === 'preconnection-soc') view.values.soc.measuredAt = now - 1;
    if (scenario === 'unavailable-soc') view.values.soc.available = false;
    const report = observe(view);
    assert.equal(report.coverage.targetAttainment.state, 'not-exercised', scenario);
    assert.equal(report.coverage.completion.state, 'not-exercised', scenario);
    assert.notEqual(report.outcome.state, 'target-confirmed', scenario);
  }
});

test('requested minimum, energy estimate and native vehicle completion remain distinct', () => {
  const { observe } = fixture(), view = charger();
  view.progress.remainingGridKwh = 0;
  let report = observe(view);
  assert.equal(report.outcome.state, 'target-estimated');
  assert.equal(report.coverage.targetAttainment.state, 'not-exercised');
  view.values.soc = reading(80, 'teslamate', now + MINUTE);
  report = observe(refresh(view, now + MINUTE), now + MINUTE);
  assert.equal(report.outcome.state, 'target-confirmed');
  assert.equal(report.coverage.targetAttainment.state, 'verified');
  assert.equal(report.coverage.completion.state, 'not-exercised');
  view.values.soc = reading(90, 'teslamate', now + 2 * MINUTE);
  view.values.charging.value = false; view.values.powerKw.value = 0;
  report = observe(refresh(view, now + 2 * MINUTE), now + 2 * MINUTE);
  assert.equal(report.coverage.completion.state, 'verified');
});

test('deadline miss needs an applicable postdeadline reading and remains visible after recovery', () => {
  const { observe } = fixture(), view = charger(); view.deadlineAt = now + MINUTE;
  observe(view);
  assert.equal(observe(refresh(view, now + MINUTE), now + MINUTE).outcome.state, 'in-progress');
  view.values.soc = reading(79, 'teslamate', now + 2 * MINUTE);
  let report = observe(refresh(view, now + 2 * MINUTE), now + 2 * MINUTE);
  assert.equal(report.outcome.state, 'deadline-missed');
  view.values.soc = reading(80, 'teslamate', now + 3 * MINUTE);
  report = observe(refresh(view, now + 3 * MINUTE), now + 3 * MINUTE);
  assert.equal(report.outcome.state, 'target-confirmed');
  assert(report.findings.some(row => row.code === 'deadline-missed' && row.resolvedAt === now + 3 * MINUTE));
});

test('permitted zero draw is not falsely attributed to a vehicle timer', () => {
  const { observe } = fixture(), view = charger(); view.values.charging.value = false; view.values.powerKw.value = 0;
  let report;
  for (let i = 0; i <= 13; i++) report = observe(refresh(view, now + i * MINUTE), now + i * MINUTE);
  assert(report.findings.some(row => row.code === 'permitted-without-draw'));
  assert(!report.findings.some(row => row.code === 'vehicle-timer'));
  assert.equal(report.outcome.state, 'in-progress');
});

test('known timer and zero supply have separate evidence and suppress unexplained no-draw warning', () => {
  for (const type of ['vehicle-timer', 'supply-unavailable']) {
    const { observe } = fixture(), view = charger(); view.values.charging.value = false; view.values.powerKw.value = 0;
    if (type === 'vehicle-timer') view.values.vehicleNotBefore = reading(now + 60 * MINUTE, 'teslamate');
    else view.values.availableCurrentA.value = 0;
    let report;
    for (let i = 0; i <= 13; i++) report = observe(refresh(view, now + i * MINUTE), now + i * MINUTE);
    assert(report.findings.some(row => row.code === type));
    assert(!report.findings.some(row => row.code === 'permitted-without-draw'));
  }
});

test('late identification retains physical session and captures planning assumptions before and after', () => {
  const { observe } = fixture(), view = charger(); view.vehicle = { state: 'unidentified' }; view.values.soc.source = 'manual-fallback';
  const initial = observe(view);
  view.vehicle = { id: 'tesla', state: 'identified' }; view.values.soc = reading(60, 'teslamate', now + MINUTE);
  const identified = observe(refresh(view, now + MINUTE), now + MINUTE);
  assert.equal(identified.id, initial.id);
  assert.equal(identified.plans[0].vehicleId, null);
  assert.equal(identified.plans.at(-1).vehicleId, 'tesla');
  assert.equal(identified.plans.at(-1).reason, 'vehicle-identification');
  assert.equal(identified.coverage.lateReplan.state, 'verified');
});

test('unavailable connection does not end the session; fresh unplug does and restart retains report', () => {
  const { observer, observe, store } = fixture(), view = charger(); const initial = observe(view);
  view.values.connected.available = false; view.control.snapshot.online = false;
  assert.equal(observe(view, now + MINUTE).id, initial.id);
  view.control.snapshot.online = true; view.values.connected.available = true; view.values.connected.value = false;
  const status = observer.observe([refresh(view, now + 2 * MINUTE)], now + 2 * MINUTE);
  assert.equal(status.chargers[0].current, null);
  assert.equal(status.chargers[0].recent[0].endReason, 'unplugged');
  assert.equal(status.chargers[0].recent[0].outcome.state, 'completion-unknown');
  const restored = new ChargingSessionDiagnostics({ store });
  assert.equal(restored.status(now + 3 * MINUTE).chargers[0].recent[0].id, initial.id);
});

test('replacement connection and changed equipment cannot inherit the prior report', () => {
  const { observe, observer } = fixture(), view = charger(), initial = observe(view);
  view.request.sessionId = 'second-session'; view.control.session.connectedAt = now + MINUTE;
  const next = observe(refresh(view, now + MINUTE), now + MINUTE);
  assert.notEqual(next.id, initial.id);
  assert.equal(observer.status(now + MINUTE).chargers[0].recent[0].endReason, 'connection-replaced');
  view.association = 'replacement-equipment';
  observe(refresh(view, now + 2 * MINUTE), now + 2 * MINUTE);
  assert.equal(observer.status(now + 2 * MINUTE).chargers[0].recent.length, 2);
  assert.equal(observer.status(now + 2 * MINUTE).chargers[0].recent[0].endReason, 'equipment-replaced');
});

test('restart and stale reads do not count an observation gap toward a settled failure', () => {
  const { observer, observe, store } = fixture(), view = charger();
  view.values.charging.value = false; view.values.powerKw.value = 0;
  for (let i = 0; i <= 5; i++) observe(refresh(view, now + i * MINUTE), now + i * MINUTE);
  assert.equal(observer.status(now + 10 * MINUTE).chargers[0].current.evidenceStale, true);
  const restarted = new ChargingSessionDiagnostics({ store });
  const report = readCompleteReport(restarted, restarted.observe([refresh(view, now + 30 * MINUTE)], now + 30 * MINUTE).chargers[0].current);
  assert(report.timeline.some(row => row.code === 'observation-gap'));
  assert(!report.findings.some(row => row.code === 'permitted-without-draw'));
});

test('complete evidence survives beyond former caps while dashboard and runtime remain bounded', () => {
  const { observer, observe } = fixture(), view = charger();
  for (let i = 0; i < 100; i++) {
    view.values.minimumSoc.value = i % 2 ? 80 : 85; view.values.charging.value = i % 2 === 0;
    view.control.phase = i % 2 ? 'released' : 'unconfirmed';
    observe(refresh(view, now + i * MINUTE), now + i * MINUTE);
  }
  let report = observer.status(now + 100 * MINUTE).chargers[0].current;
  assert.equal(report.counts.plans, 100);
  assert.equal(report.timeline, undefined); assert.equal(report.plans, undefined);
  const complete = readCompleteReport(observer, report);
  assert.equal(complete.plans.length, 100); assert.equal(complete.plans[0].at, now);
  assert(complete.timeline.length > 120); assert.equal(complete.timeline[0].code, 'connected');
  assert(observer.state.chargers.charger1.current.planContext.length <= 8);
  assert.equal(observer.state.chargers.charger1.current.events.length, 0);
  for (let i = 100; i < 110; i++) {
    view.request.sessionId = `session-${i}`; view.control.session.connectedAt = now + i * MINUTE;
    observe(refresh(view, now + i * MINUTE), now + i * MINUTE);
  }
  assert.equal(observer.status(now + 110 * MINUTE).chargers[0].recent.length, 4);
  assert.equal(observer.listReports({chargerId:'charger1'}).reports.length, 11);
});

test('failed persistence remains dirty and retries a quiet next observation', () => {
  const { observer, observe, store } = fixture(), view = charger(); observe(view);
  const original = store.setState; let failures = 0;
  store.setState = () => { failures++; throw new Error('Synthetic save failure'); };
  view.values.minimumSoc.value = 85;
  assert.throws(() => observe(refresh(view, now + MINUTE), now + MINUTE), /Synthetic save failure/);
  assert.throws(() => observe(refresh(view, now + MINUTE + 1), now + MINUTE + 1), /Synthetic save failure/);
  assert.equal(failures, 2);
  store.setState = original; observe(refresh(view, now + MINUTE + 2), now + MINUTE + 2);
  const restored = new ChargingSessionDiagnostics({ store });
  assert.equal(restored.status(now + MINUTE + 2).chargers[0].current.counts.plans, 2);
  assert.equal(observer.state.chargers.charger1.current.events.length, 0);
});

test('unsupported persisted contract fails before mutation', () => {
  let mutated = false;
  for (const saved of [{ version: 2, chargers: {} }, { version: 0, chargers: {} }, { version: 1, chargers: {}, retired: true },
    { version: 1, chargers: { unknown: {} } }]) {
    assert.throws(() => new ChargingSessionDiagnostics({ store: { getState: () => saved, setState: () => { mutated = true; } } }), /fresh development database/);
  }
  assert.equal(mutated, false);
});

test('compact report status never paints missing evidence or mere plans as passed', () => {
  assert.equal(chargingReportSummary(null).label, 'Session report');
  assert.equal(chargingReportSummary({ behavior: 'observing', outcome: { state: 'in-progress' } }).state, 'quiet');
  assert.equal(chargingReportSummary({ behavior: 'expected', evidenceStale: true }).state, 'unknown');
  assert.equal(chargingReportSummary({ behavior: 'expected', recoveredCount: 1 }).label, 'Recovered issue');
  assert.equal(chargingReportSummary({ attentionCount: 2 }).label, '2 issues');
  assert.equal(chargingReportSummary({ behavior: 'expected' }, false).state, 'unknown');
});
