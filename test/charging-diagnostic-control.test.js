import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticStore, diagnosticRows, readCompleteReport } from './support/charging-report-fixture.js';
import { ChargingSessionDiagnostics } from '../src/charging/session-diagnostics.js';
import { chargingControlLabel } from '../chart/charging-status.js';

const MINUTE = 60_000, START = Date.parse('2026-10-01T18:00:00Z');
const reading = (value, at = START, extra = {}) => ({ value, available: true, source: 'easee-ocpp', measuredAt: at, receivedAt: at, ...extra });

function fixture() {
  let now = START;
  const store = diagnosticStore(), states = { values: () => diagnosticRows(store) };
  let observer = new ChargingSessionDiagnostics({ store, clock: () => now });
  const view = { id: 'charger1', association: 'synthetic-physical-equipment',
    request: { sessionId: 'synthetic-current-session', revision: 1 }, settings: { enabled: true },
    control: { phase: 'off', errorCode: null, handoverConfirmed: true, snapshot: { online: true, readAt: START },
      session: { connected: true, connectedAt: START } },
    values: { connected: reading(true), charging: reading(false), powerKw: reading(0),
      soc: reading(70, START, { source: 'bmw-cardata' }), minimumSoc: reading(80, START, { source: 'bmw-cardata' }),
      vehicleCeilingSoc: reading(90, START, { source: 'bmw-cardata' }), capacityKwh: reading(74) },
    vehicle: { id: 'bmw', state: 'identified', sessionId: 'synthetic-current-session' }, vehicleMqtt: { available: true },
    telemetry: { providerConnected: true }, deadlineAt: START + MINUTE,
    identification: { phase: 'completed', active: false },
    progress: { remainingGridKwh: 8, deliveredGridKwh: 0, connectionAt: START, basis: { energyCoverageIncomplete: true } } };
  const observe = (at = now) => {
    now = at; view.control.snapshot.readAt = at;
    return readCompleteReport(observer, observer.observe([view], at).chargers[0].current);
  };
  const sample = (at, soc = 70, powerKw = 0) => {
    view.values.soc = reading(soc, at, { source: 'bmw-cardata' }); view.values.powerKw = reading(powerKw, at);
  };
  return { view, states, observe, sample, restart: () => { observer = new ChargingSessionDiagnostics({ store, clock: () => now }); } };
}
const controls = report => report.timeline.filter(row => row.kind === 'control');

test('waiting identification records its exact blocker initially and on change, without storing arbitrary provider text', () => {
  const f = fixture(); f.view.vehicle = { state: 'identifying', id: null };
  f.view.identification = { phase: 'waiting', active: true, reason: 'bmw-home-unknown' };
  let report = f.observe();
  assert.equal(report.current.identificationReason, 'bmw-home-unknown');
  assert.deepEqual(report.timeline.filter(row => row.kind === 'identification').map(row => [row.code, row.reasonCode]),
    [['waiting', 'bmw-home-unknown']]);
  f.observe(START + 10_000);
  f.view.identification.reason = 'bmw-away'; report = f.observe(START + 20_000);
  assert.equal(report.timeline.filter(row => row.kind === 'identification').length, 2);
  assert.equal(report.timeline.at(-1).reasonCode, 'bmw-away');
  f.restart(); report = f.observe(START + 30_000);
  assert.equal(report.current.identificationReason, 'bmw-away');
  assert.equal(report.timeline.filter(row => row.kind === 'identification').length, 2);
  f.view.identification.reason = 'private-vehicle-location-and-account'; report = f.observe(START + 40_000);
  assert.equal(report.current.identificationReason, null);
  assert.doesNotMatch(JSON.stringify([...f.states.values()]), /private-vehicle/);
});

test('probe exhaustion records an inconclusive attempt while ordinary scheduling determines expected behavior', () => {
  const f = fixture(); f.view.vehicle = { state: 'identifying', id: null };
  f.view.identification = { phase: 'inconclusive', active: false, reason: 'probe-energy-limit' };
  f.view.plan = { state: 'waiting', periods: [{ startAt: START + 60 * MINUTE, endAt: null }] };
  f.view.control.phase = 'paused'; f.view.control.pauseConfirmed = true;
  const report = f.observe();
  assert.equal(report.current.expectation, 'hold');
  assert.equal(report.current.identification, 'inconclusive');
  assert.equal(report.current.identificationReason, 'probe-energy-limit');
  assert.equal(report.current.identificationActive, false);
  assert.equal(report.findings.some(row => row.code === 'identification-inconclusive'), true);
  assert.equal(report.timeline.find(row => row.kind === 'identification').reasonCode, 'probe-energy-limit');
});

test('an interrupted attempt records its bounded outcome while passive matching remains possible', () => {
  const f = fixture(); f.view.vehicle = { state: 'unidentified', id: null };
  f.view.identification = { phase: 'inconclusive', active: false, reason: 'interrupted' };
  const report = f.observe();
  assert.equal(report.current.identificationReason, 'interrupted');
  assert.equal(report.current.identificationActive, false);
  assert.equal(report.timeline.find(row => row.kind === 'identification').reasonCode, 'interrupted');
  assert.equal(report.findings.some(row => row.code === 'identification-inconclusive'), true);
});

test('off phase records Automatic permission separately from unavailable control and native handover error', () => {
  const f = fixture();
  f.view.control.errorCode = 'read-failed'; f.view.control.handoverConfirmed = false;
  f.view.control.reason = 'Native read failed for a private account identifier';
  const originalView = structuredClone(f.view);
  const event = controls(f.observe()).at(-1);
  assert.deepEqual(f.view, originalView, 'Report observation cannot change production control or planning inputs');
  assert.equal(event.code, 'off'); assert.equal(event.automaticEnabled, true); assert.equal(event.chargeNow, false);
  assert.equal(event.availability, 'unavailable'); assert.equal(event.physicalKnown, true);
  assert.equal(event.errorCode, 'read-failed'); assert.equal(event.reasonCode, 'read-failed');
  assert.equal(event.handoverConfirmed, false);
  assert.ok(!JSON.stringify([...f.states.values()]).includes('private account'));
});

test('control context changes are recorded without phase changes and ordinary rereads add no transitions', () => {
  const f = fixture(); let report = f.observe();
  assert.equal(controls(report).length, 1);
  f.view.control.errorCode = 'read-failed'; report = f.observe(START + 10_000);
  assert.equal(controls(report).length, 2);
  report = f.observe(START + 20_000); assert.equal(controls(report).length, 2);
  f.view.control.errorCode = null; report = f.observe(START + 30_000);
  assert.equal(controls(report).length, 3); assert.equal(controls(report).at(-1).availability, 'available');
  f.view.settings.enabled = false; report = f.observe(START + 40_000);
  assert.equal(controls(report).length, 4); assert.equal(controls(report).at(-1).automaticEnabled, false);
  assert.equal(controls(report).at(-1).availability, 'available');
});

test('native handover diagnostics retain exact transport failures and distinct steps across restart', () => {
  const f = fixture(); f.view.control.phase = 'unconfirmed'; f.view.control.handoverConfirmed = false;
  f.view.control.reason = 'private upstream response';
  const expected = [];
  let report, at = START;
  for (const code of ['ocpp-request-timeout', 'ocpp-request-aborted', 'ocpp-request-failed']) {
    for (const step of ['takeover-pause-install', 'takeover-pause-confirm']) {
      f.view.control.errorCode = code; f.view.control.reasonCode = step;
      expected.push([code, step]); report = f.observe(at); at += 1000;
      assert.deepEqual(controls(report).map(row => [row.errorCode, row.reasonCode]), expected);
      assert.equal(report.current.errorCode, code); assert.equal(report.current.reasonCode, step);
      assert.notEqual(chargingControlLabel(code), 'Charger needs attention');
      assert.match(chargingControlLabel(step), /Handover step:/);
    }
  }
  f.restart(); report = f.observe(at);
  assert.deepEqual(controls(report).map(row => [row.errorCode, row.reasonCode]), expected);
  assert.doesNotMatch(JSON.stringify([...f.states.values()]), /private upstream response/);
});

test('a changed handover step updates the recorded cause within the same unresolved finding', () => {
  const f = fixture(); Object.assign(f.view.control, { phase: 'unconfirmed', errorCode: 'ocpp-request-timeout', reasonCode: 'takeover-pause-install' });
  f.observe(); f.sample(START + 2 * MINUTE); f.observe(START + 2 * MINUTE);
  f.sample(START + 3 * MINUTE); let report = f.observe(START + 3 * MINUTE);
  assert.equal(report.findings.find(row => row.code === 'control-unconfirmed').context.reasonCode, 'takeover-pause-install');
  f.view.control.reasonCode = 'takeover-pause-confirm';
  f.sample(START + 4 * MINUTE); report = f.observe(START + 4 * MINUTE);
  const finding = report.findings.find(row => row.code === 'control-unconfirmed');
  assert.equal(finding.context.reasonCode, 'takeover-pause-confirm'); assert.equal(finding.count, 1);
  const changed = report.timeline.find(row => row.kind === 'finding-update' && row.code === 'control-unconfirmed');
  assert.equal(changed.context.errorCode, 'ocpp-request-timeout'); assert.equal(changed.context.reasonCode, 'takeover-pause-confirm');
});

test('charge-now and unavailable commissioning are independent of automatic permission', () => {
  const f = fixture(); f.view.settings.enabled = false; f.view.request.chargeNow = true;
  f.view.control.snapshot.controlReady = false; f.view.control.reason = 'evse-profile-unsupported';
  const event = controls(f.observe()).at(-1);
  assert.equal(event.automaticEnabled, false); assert.equal(event.chargeNow, true);
  assert.equal(event.availability, 'unavailable'); assert.equal(event.reasonCode, 'evse-profile-unsupported');
});

test('native app priority and native current policy retain their supported diagnostic reasons', () => {
  for (const reason of ['manual-enable', 'manual-charge-now', 'manual-schedule', 'native-current-limit']) {
    const f = fixture(); f.view.control.reason = reason;
    assert.equal(controls(f.observe()).at(-1).reasonCode, reason);
  }
});

test('unrecognized provider error and reason text never enter stored report evidence', () => {
  const f = fixture(); f.view.control.errorCode = 'https://private.example.invalid/device/private-serial?token=private-token';
  f.view.control.reason = 'private-message'; f.view.control.reasonCode = 'private-operation'; f.view.error = 'private-runtime-detail';
  const event = controls(f.observe()).at(-1);
  assert.equal(event.errorCode, 'control-error'); assert.equal(event.reasonCode, 'control-error');
  const saved = JSON.stringify([...f.states.values()]);
  for (const privateValue of ['private.example', 'private-serial', 'private-token', 'private-message', 'private-operation', 'private-runtime-detail']) assert.ok(!saved.includes(privateValue));
});

test('unavailable runtime or adapter control cannot confirm release or pause from a saved phase', () => {
  for (const cause of ['runtime', 'adapter', 'not-ready']) {
    const f = fixture(); f.view.control.phase = 'released'; f.view.control.released = true;
    f.sample(START, 70, 7);
    if (cause === 'runtime') f.view.error = 'private runtime error';
    if (cause === 'adapter') f.view.control.reason = 'evse-command-unconfirmed';
    if (cause === 'not-ready') f.view.control.snapshot.controlReady = false;
    let report = f.observe();
    assert.equal(report.current.controlAvailability, 'unavailable', cause);
    assert.equal(report.current.releaseConfirmed, false, cause);
    assert.equal(report.coverage.initialRelease.state, 'not-exercised', cause);
    f.view.control.phase = 'paused'; f.view.control.released = false;
    f.view.plan = { periods: [{ startAt: START + 60 * MINUTE, endAt: null }] };
    f.sample(START + 10_000, 70, 0); report = f.observe(START + 10_000);
    assert.equal(report.current.pauseConfirmed, false, cause);
    assert.equal(report.coverage.pause.state, 'not-exercised', cause);
  }
});

test('working transport with missing power remains physically unknown even when control phase is off', () => {
  const f = fixture(); f.view.values.powerKw.available = false;
  const report = f.observe(), control = controls(report).at(-1);
  assert.equal(control.availability, 'available'); assert.equal(control.physicalKnown, false);
  assert.equal(control.automaticEnabled, true); assert.equal(control.code, 'off');
  assert.equal(report.current.physicalUnknownSince, START);
  const lost = report.timeline.find(row => row.code === 'physical-evidence-lost');
  assert.equal(lost.physicalKnown, false); assert.equal(lost.source, 'unavailable');
  assert.equal(lost.lastKnownAt, null); assert.equal(lost.measuredAt, null); assert.equal(lost.receivedAt, null);
});

test('physical loss and restoration retain observed boundaries across restart without renewing source clocks', () => {
  const f = fixture(); f.observe();
  f.view.values.powerKw.available = false;
  let report = f.observe(START + 10_000), lost = report.timeline.find(row => row.code === 'physical-evidence-lost');
  assert.equal(lost.fromAt, START + 10_000); assert.equal(lost.lastKnownAt, START); assert.equal(lost.toAt, null);
  assert.equal(lost.source, 'easee-ocpp');
  assert.equal(lost.measuredAt, START); assert.equal(lost.receivedAt, START);
  f.restart(); report = f.observe(START + 30_000);
  assert.equal(report.timeline.filter(row => row.code === 'physical-evidence-lost').length, 1);
  f.view.values.powerKw = reading(0, START + 35_000, { receivedAt: START + 37_000 });
  report = f.observe(START + 40_000);
  const restored = report.timeline.find(row => row.code === 'physical-evidence-restored');
  assert.equal(restored.fromAt, START + 10_000); assert.equal(restored.toAt, START + 40_000);
  assert.equal(restored.source, 'easee-ocpp');
  assert.equal(restored.measuredAt, START + 35_000); assert.equal(restored.receivedAt, START + 37_000);
  assert.equal(restored.physicalKnown, true); assert.equal(report.current.physicalUnknownSince, null);
});

test('an observation gap describes its actual recording interval without inventing physical outage start', () => {
  const f = fixture(); f.observe(); f.sample(START + 5 * MINUTE);
  const report = f.observe(START + 5 * MINUTE), gap = report.timeline.find(row => row.code === 'observation-gap');
  assert.equal(gap.fromAt, START); assert.equal(gap.toAt, START + 5 * MINUTE);
  assert.ok(!report.timeline.some(row => row.code === 'physical-evidence-lost'));
  assert.equal(report.timeline.filter(row => row.kind === 'physical').at(-1).code, 'not-charging-observed');
});

test('a proven deadline miss remains historical fact while vehicle and request evidence are unavailable', () => {
  const f = fixture(); f.observe(); f.sample(START + 2 * MINUTE);
  let report = f.observe(START + 2 * MINUTE);
  assert.equal(report.outcome.state, 'deadline-missed'); assert.equal(report.outcome.target, 80);
  assert.equal(report.outcome.deadlineAt, START + MINUTE);
  f.restart(); f.view.vehicleMqtt.available = false; f.view.request = null; f.view.vehicle.id = null;
  f.view.values.soc = reading(20, START + 3 * MINUTE, { source: 'manual-fallback', assumed: true });
  f.view.values.minimumSoc = reading(50, START + 3 * MINUTE, { source: 'manual-fallback', assumed: true });
  f.view.deadlineAt = START + 24 * 60 * MINUTE;
  report = f.observe(START + 3 * MINUTE);
  assert.equal(report.outcome.state, 'deadline-missed'); assert.equal(report.outcome.target, 80);
  assert.equal(report.outcome.deadlineAt, START + MINUTE);
  assert.ok(report.findings.some(row => row.code === 'deadline-missed' && row.resolvedAt === null));
});

test('a real readiness edit reassesses the new deadline while retaining the earlier missed occurrence', () => {
  const f = fixture(); f.observe(); f.sample(START + 2 * MINUTE); f.observe(START + 2 * MINUTE);
  f.view.deadlineAt = START + 60 * MINUTE; f.view.request.revision++;
  f.sample(START + 3 * MINUTE); const report = f.observe(START + 3 * MINUTE);
  assert.equal(report.outcome.state, 'in-progress');
  assert.ok(report.timeline.some(row => row.kind === 'outcome' && row.code === 'deadline-missed' && row.deadlineAt === START + MINUTE));
  assert.ok(report.findings.some(row => row.code === 'deadline-missed' && row.resolvedAt === START + 3 * MINUTE));
  assert.equal(report.findings.find(row => row.code === 'deadline-missed').resolution, 'request-changed');
  assert.equal(report.timeline.find(row => row.kind === 'recovery' && row.code === 'deadline-missed').resolution, 'request-changed');
});

test('missing deadline or target evidence cannot erase a proven readiness miss', () => {
  for (const cause of ['deadline', 'target', 'fallback-target', 'higher-fallback-target']) {
    const f = fixture(); f.observe(); f.sample(START + 2 * MINUTE); f.observe(START + 2 * MINUTE);
    f.sample(START + 3 * MINUTE);
    if (cause === 'deadline') f.view.deadlineAt = null;
    if (cause === 'target') f.view.values.minimumSoc = reading(null, START + 3 * MINUTE, { source: 'bmw-cardata' });
    if (cause === 'fallback-target') f.view.values.minimumSoc = reading(50, START + 3 * MINUTE, { source: 'manual-fallback', assumed: true });
    if (cause === 'higher-fallback-target') f.view.values.minimumSoc = reading(90, START + 3 * MINUTE, { source: 'manual-fallback', assumed: true });
    const report = f.observe(START + 3 * MINUTE);
    assert.equal(report.outcome.state, 'deadline-missed', cause);
    assert.equal(report.outcome.target, 80, cause);
    assert.equal(report.coverage.targetAttainment.state, 'not-exercised', cause);
    assert.ok(report.findings.some(row => row.code === 'deadline-missed' && row.resolvedAt === null), cause);
  }
});

test('a battery measurement before this physical session cannot prove its ready-by miss', () => {
  const f = fixture(); f.view.deadlineAt = START - 10_000;
  f.view.values.soc = reading(70, START - 5000, { source: 'bmw-cardata' });
  const report = f.observe();
  assert.notEqual(report.outcome.state, 'deadline-missed');
  assert.ok(report.findings.some(row => row.code === 'deadline-unverified'));
});
